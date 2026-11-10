import { BrokerError } from "../broker/errors.js";
import type { Logger } from "../log.js";
import { DAY_MS, MINUTE_MS } from "../time.js";
import type { Range } from "./plan.js";
import type { BaseTf } from "./timeframes.js";

// Background downloads for requests that answer from the store at once (the
// batch candles endpoint): instead of making a client wait for 300 symbols,
// the missing series are queued here and fetched one by one through
// HistoryService.ensure at background priority, so they are stored by the
// client's next request.
//
//   - Deduplicated: one entry per (symbol, base timeframe); asking again while
//     it waits widens its range instead of adding a second fetch. (HistoryService
//     also re-plans against the store, so a range that got stored meanwhile costs
//     no call.)
//   - Bounded: at most `maxQueued` entries; beyond that nothing more is queued
//     until it drains (the caller reports those symbols as not queued).
//   - A broker problem that affects every symbol (budget spent, rate-limited,
//     login failing, another process owning the connection, network) pauses the
//     queue for `retryMs` with its entries kept; a symbol the broker doesn't know
//     is remembered for a day (reported as unknown, not fetched again); any other
//     failure drops that one entry.
//   - In memory only: a restart forgets it, and the next request queues again.

export interface QueueHistory {
  ensure(symbol: string, base: BaseTf, want: Range, priority: "background"): Promise<void>;
}

export interface HistoryQueueDeps {
  history: QueueHistory;
  log: Logger;
  clock?: () => number;
  /** Fetches running at once (the gate paces the calls themselves). */
  concurrency?: number;
  maxQueued?: number;
  /** Pause after a broker-wide problem (ms). */
  retryMs?: number;
  /** How long a symbol the broker doesn't know is remembered (ms). */
  unknownMs?: number;
}

interface Entry {
  symbol: string;
  base: BaseTf;
  want: Range;
}

const PAUSING_KINDS = new Set(["budget", "rate_limited", "auth", "not_owner", "not_configured", "network"]);

export class HistoryQueue {
  private pending = new Map<string, Entry>();
  private readonly active = new Map<string, Entry>();
  private readonly unknown = new Map<string, number>();
  private readonly clock: () => number;
  private readonly concurrency: number;
  private readonly maxQueued: number;
  private readonly retryMs: number;
  private readonly unknownMs: number;
  private workers = 0;
  private pausedUntil = 0;
  private resumeTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private lastError: string | null = null;
  private idleWaiters: Array<() => void> = [];

  constructor(private readonly deps: HistoryQueueDeps) {
    this.clock = deps.clock ?? Date.now;
    this.concurrency = deps.concurrency ?? 2;
    this.maxQueued = deps.maxQueued ?? 2_000;
    this.retryMs = deps.retryMs ?? 5 * MINUTE_MS;
    this.unknownMs = deps.unknownMs ?? DAY_MS;
  }

  /** Queue a fetch of `want` for a base series. True when it is queued or already being fetched. */
  enqueue(symbol: string, base: BaseTf, want: Range): boolean {
    if (this.stopped || want.from >= want.to || this.isUnknown(symbol)) return false;
    const key = `${symbol}|${base}`;
    const running = this.active.get(key);
    if (running && running.want.from <= want.from && running.want.to >= want.to) return true;
    const waiting = this.pending.get(key);
    if (waiting) {
      waiting.want = { from: Math.min(waiting.want.from, want.from), to: Math.max(waiting.want.to, want.to) };
    } else {
      if (this.pending.size >= this.maxQueued) return false;
      this.pending.set(key, { symbol, base, want: { ...want } });
    }
    this.drain();
    return true;
  }

  /** The broker said it doesn't know this symbol (within the last `unknownMs`). */
  isUnknown(symbol: string): boolean {
    const until = this.unknown.get(symbol);
    if (until === undefined) return false;
    if (until > this.clock()) return true;
    this.unknown.delete(symbol);
    return false;
  }

  status() {
    return { pending: this.pending.size, running: this.active.size, pausedUntil: this.pausedUntil > this.clock() ? this.pausedUntil : null, lastError: this.lastError };
  }

  /** Resolves once nothing is pending or running (or the queue is paused or stopped). For tests and shutdown. */
  idle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /** Stop starting fetches; ones in flight finish on their own. */
  stop(): void {
    this.stopped = true;
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = null;
    this.pending.clear();
    this.wakeIdle();
  }

  private isIdle() {
    return this.workers === 0 && (this.pending.size === 0 || this.stopped || this.pausedUntil > this.clock());
  }

  private wakeIdle() {
    if (!this.isIdle()) return;
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }

  private drain() {
    if (this.stopped || this.pausedUntil > this.clock()) return;
    const startable = [...this.pending.keys()].filter((key) => !this.active.has(key)).length;
    for (let i = Math.min(this.concurrency - this.workers, startable); i > 0; i -= 1) {
      this.workers += 1;
      void this.work().finally(() => {
        this.workers -= 1;
        this.wakeIdle();
      });
    }
  }

  private async work() {
    for (;;) {
      if (this.stopped || this.pausedUntil > this.clock()) return;
      const next = this.takeNext();
      if (!next) return;
      const [key, entry] = next;
      this.active.set(key, entry);
      try {
        await this.deps.history.ensure(entry.symbol, entry.base, entry.want, "background");
      } catch (error) {
        const kind = error instanceof BrokerError ? error.kind : "upstream";
        const message = error instanceof Error ? error.message : String(error);
        if (kind === "bad_symbol") {
          this.unknown.set(entry.symbol, this.clock() + this.unknownMs);
        } else if (PAUSING_KINDS.has(kind)) {
          // Keep the entry (merged with anything queued for it meanwhile) and pause.
          const queued = this.pending.get(key);
          this.pending.delete(key);
          const want = queued ? { from: Math.min(queued.want.from, entry.want.from), to: Math.max(queued.want.to, entry.want.to) } : entry.want;
          this.pending = new Map([[key, { ...entry, want }], ...this.pending]);
          this.pause(message);
        } else {
          this.deps.log.warn("background history fetch failed", { symbol: entry.symbol, tf: entry.base, error: message });
        }
        this.lastError = message;
      } finally {
        this.active.delete(key);
      }
    }
  }

  /** The oldest pending entry whose series isn't being fetched right now. */
  private takeNext(): [string, Entry] | null {
    for (const [key, entry] of this.pending) {
      if (this.active.has(key)) continue;
      this.pending.delete(key);
      return [key, entry];
    }
    return null;
  }

  private pause(message: string) {
    if (this.pausedUntil > this.clock()) return;
    this.pausedUntil = this.clock() + this.retryMs;
    this.deps.log.info("background history fetches paused", { error: message, retryInMs: this.retryMs, pending: this.pending.size });
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = null;
      this.drain();
    }, this.retryMs);
    this.resumeTimer.unref?.();
  }
}
