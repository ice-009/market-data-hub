import type { PlanLimits } from "../broker/budget.js";
import { BrokerError } from "../broker/errors.js";
import type { DataSocket, DataSocketFactory } from "../broker/fyersSocket.js";
import { BudgetExhaustedError } from "../broker/gate.js";
import { normalizeSymbol } from "../broker/symbols.js";
import type { Logger } from "../log.js";
import { isMarketOpen, istDayKey } from "../time.js";
import type { FeedStatus, LiveFeed, QuoteFetcher, Tick } from "./types.js";

// The live feed: one upstream broker socket shared by every client, with REST
// polling as the fallback. It only emits ticks and reconnect windows; the store
// (src/live/store.ts) persists them and repairs gaps.
//
//   subscriptions  Per owner (a client id, or "persistent" for the pinned set).
//                  An owner either wants a symbol or not; a symbol stays upstream
//                  while at least one owner wants it.
//   socket         The first `plan.socketSymbols` wanted symbols (100 on Fyers
//                  Standard), in the order they were first wanted. Fyers refuses
//                  a connection past the plan's symbol count, so the rest are
//                  polled. Subscription changes are batched for a moment, because
//                  every SDK subscribe costs an HTTPS symbol lookup.
//   polling        Every 15 s, at "refresh" priority through the broker gate, in
//                  plan-sized batches, one round at a time. Polled: symbols beyond
//                  socket capacity; every socket symbol while the socket is down
//                  (after a short grace) or silent; a socket symbol silent for
//                  3 minutes. A symbol stops being polled once its socket ticks
//                  resume. A spent budget stops polling until the next IST day —
//                  polling can never push the account into rate-limit strikes.
//   watchdog       In market hours (09:15–15:30 IST, weekdays): opens the socket,
//                  restarts it after 60 s of silence. Outside them: socket closed,
//                  no polling (quotes then come from the store).
//   reconnects     Exponential backoff from 1 s, capped at 1 minute; the failure
//                  count resets on the first tick after a connect, so a socket
//                  that connects but never delivers backs off too. Each reconnect
//                  emits onReconnect({ from: last time the socket was heard from,
//                  to: now }); start() emits one for the previous run's downtime
//                  when `resumeFrom` is given.
//
// Everything that decides (which symbols go where, backoff) is in small pure
// functions below; the class only holds state and timers. Clock, timers, socket
// factory and quote fetcher are injected, so tests run on fake time with a fake
// socket and never reach the broker.

export const FEED_TUNING = {
  pollEveryMs: 15_000,
  watchdogEveryMs: 5_000,
  /** The connected socket is restarted after this long without a tick. */
  socketSilentMs: 60_000,
  /** A socket symbol without a tick for this long is polled too. */
  symbolSilentMs: 3 * 60_000,
  /** A socket that hasn't connected after this long is given up and retried. */
  connectTimeoutMs: 15_000,
  /** Socket symbols are polled once the socket has been down this long. */
  downGraceMs: 10_000,
  backoffBaseMs: 1_000,
  backoffMaxMs: 60_000,
  /** Subscription changes within this window go upstream together. */
  syncDelayMs: 200,
};

export type FeedTuning = typeof FEED_TUNING;

export interface FeedTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: FeedTimers = {
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface FeedOptions {
  /** Socket capacity and quote batch size (FYERS_PLANS[config.fyers.plan]). */
  plan: Pick<PlanLimits, "socketSymbols" | "quoteBatch">;
  /** Opens upstream sockets (createFyersSocketFactory); null: no socket, poll everything. */
  socket: DataSocketFactory | null;
  /** Batched REST quotes (FyersClient); null: no polling fallback. */
  quotes: QuoteFetcher | null;
  log: Logger;
  clock?: () => number;
  timers?: FeedTimers;
  /** Market-hours test (default: the regular NSE session, src/time.ts). */
  marketOpen?: (time: number) => boolean;
  /** When the previous run last received a tick: start() emits onReconnect({ from: resumeFrom, to: now }). */
  resumeFrom?: number | null;
  tuning?: Partial<FeedTuning>;
}

/** FeedStatus plus why polling is off, if it is. */
export interface FeedStatusDetail extends FeedStatus {
  /** "budget": today's broker budget is spent (or calls stopped after strikes); polling resumes tomorrow. */
  pollingStopped: "budget" | null;
}

// --- pure decisions ---------------------------------------------------------------

/** Symbols served by the socket: the first `capacity` wanted (in the order first wanted). Pure. */
export function socketShare(wanted: readonly string[], capacity: number, socketAvailable: boolean): string[] {
  return socketAvailable ? wanted.slice(0, Math.max(0, capacity)) : [];
}

export interface PollInput {
  wanted: readonly string[];
  onSocket: ReadonlySet<string>;
  /** The socket is connected and ticking, or only briefly down. */
  socketHealthy: boolean;
  /** Last socket tick per symbol (or when it went on the socket / the socket connected, if later). */
  heard: ReadonlyMap<string, number>;
  now: number;
  symbolSilentMs: number;
}

/** Symbols to poll this round (market hours are checked by the caller). Pure. */
export function pollList(input: PollInput): string[] {
  const overflow = input.wanted.filter((symbol) => !input.onSocket.has(symbol));
  const socket = [...input.onSocket].filter((symbol) => !input.socketHealthy || input.now - (input.heard.get(symbol) ?? input.now) >= input.symbolSilentMs);
  return [...socket, ...overflow];
}

/** Delay before reconnect attempt number `failures` (1, 2, …). Pure. */
export function backoffMs(failures: number, baseMs: number, maxMs: number): number {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, Math.min(failures - 1, 30)));
}

// --- the feed -------------------------------------------------------------------

type SocketState = "connected" | "connecting" | "disconnected";
type TimerName = "watchdog" | "poll" | "reconnect" | "connectTimeout" | "sync";

export class FyersLiveFeed implements LiveFeed {
  private readonly tuning: FeedTuning;
  private readonly clock: () => number;
  private readonly timers: FeedTimers;
  private readonly marketOpen: (time: number) => boolean;
  private readonly log: Logger;

  /** owner → symbols it wants. */
  private readonly owners = new Map<string, Set<string>>();
  /** symbol → owners wanting it; insertion order is the order symbols were first wanted. */
  private readonly wanted = new Map<string, Set<string>>();
  private onSocket = new Set<string>();
  /** What the current socket has been asked to carry. */
  private upstream = new Set<string>();
  private readonly heard = new Map<string, number>();

  private socket: DataSocket | null = null;
  private state: SocketState = "disconnected";
  /** Bumped whenever a socket is dropped, so its late events are ignored. */
  private generation = 0;
  private everConnected = false;
  /** Last socket tick, or the connect time if later (the start of a gap). */
  private lastHeardAt = 0;
  /** Since when the socket has been unavailable while wanted (null: fine). */
  private degradedSince: number | null = null;
  private failures = 0;
  private reconnects = 0;
  private lastTickAt: number | null = null;
  private pollStoppedDay: number | null = null;
  private polling: Promise<void> | null = null;
  private running = false;
  private readonly handles = new Map<TimerName, unknown>();
  private readonly tickListeners = new Set<(tick: Tick) => void>();
  private readonly reconnectListeners = new Set<(downtime: { from: number; to: number }) => void>();

  constructor(private readonly options: FeedOptions) {
    this.tuning = { ...FEED_TUNING, ...options.tuning };
    this.clock = options.clock ?? (() => Date.now());
    this.timers = options.timers ?? realTimers;
    this.marketOpen = options.marketOpen ?? isMarketOpen;
    this.log = options.log;
  }

  // --- LiveFeed ---

  subscribe(owner: string, symbols: string[]) {
    let mine = this.owners.get(owner);
    if (!mine) this.owners.set(owner, (mine = new Set()));
    for (const raw of symbols) {
      const symbol = normalizeSymbol(raw);
      if (!symbol || mine.has(symbol)) continue;
      mine.add(symbol);
      let wantedBy = this.wanted.get(symbol);
      if (!wantedBy) this.wanted.set(symbol, (wantedBy = new Set()));
      wantedBy.add(owner);
    }
    if (!mine.size) this.owners.delete(owner);
    this.reassign();
  }

  unsubscribe(owner: string, symbols?: string[]) {
    const mine = this.owners.get(owner);
    if (!mine) return;
    const drop = symbols ? symbols.flatMap((raw) => normalizeSymbol(raw) ?? []) : [...mine];
    for (const symbol of drop) {
      if (!mine.delete(symbol)) continue;
      const wantedBy = this.wanted.get(symbol);
      wantedBy?.delete(owner);
      if (wantedBy && !wantedBy.size) {
        this.wanted.delete(symbol);
        this.heard.delete(symbol);
      }
    }
    if (!mine.size) this.owners.delete(owner);
    this.reassign();
  }

  symbols() {
    return [...this.wanted.keys()];
  }

  onTick(listener: (tick: Tick) => void) {
    this.tickListeners.add(listener);
    return () => void this.tickListeners.delete(listener);
  }

  onReconnect(listener: (downtime: { from: number; to: number }) => void) {
    this.reconnectListeners.add(listener);
    return () => void this.reconnectListeners.delete(listener);
  }

  status(): FeedStatusDetail {
    const now = this.clock();
    const open = this.marketOpen(now);
    const pollingStopped = this.pollingStopped(now) ? "budget" : null;
    const polled = open && this.options.quotes && !pollingStopped ? this.polledSymbols(now) : [];
    const polledSet = new Set(polled);
    const socketSymbols = this.state === "connected" ? [...this.onSocket].filter((symbol) => !polledSet.has(symbol)).length : 0;
    let mode: FeedStatus["mode"];
    if (!this.wanted.size || !open) mode = "idle";
    else if (socketSymbols && polled.length) mode = "mixed";
    else if (socketSymbols) mode = "socket";
    else if (polled.length) mode = "polling";
    else mode = "down";
    return {
      mode,
      socket: this.options.socket ? this.state : "disabled",
      socketSymbols,
      polledSymbols: polled.length,
      capacity: this.options.plan.socketSymbols,
      lastTickAt: this.lastTickAt,
      reconnects: this.reconnects,
      pollingStopped,
    };
  }

  /** Begin. Register onReconnect listeners first: the startup recovery window (resumeFrom) is emitted here. */
  start() {
    if (this.running) return;
    this.running = true;
    const now = this.clock();
    const resumeFrom = this.options.resumeFrom;
    if (typeof resumeFrom === "number" && resumeFrom < now) this.emitReconnect({ from: resumeFrom, to: now });
    this.reassign();
    this.every("watchdog", this.tuning.watchdogEveryMs, () => this.watchdog());
    this.every("poll", this.tuning.pollEveryMs, () => void this.pollRound());
    this.watchdog();
  }

  /** Close the socket and timers. Waits briefly (≤ 2 s) for a poll in flight; nothing is emitted after this. */
  async stop() {
    this.running = false;
    for (const name of [...this.handles.keys()]) this.clear(name);
    this.dropSocket();
    const polling = this.polling;
    if (!polling) return;
    let handle: unknown;
    await Promise.race([polling.catch(() => {}), new Promise<void>((resolve) => (handle = this.timers.setTimeout(resolve, 2_000)))]);
    this.timers.clearTimeout(handle);
  }

  // --- socket ---

  /** Recompute which symbols the socket carries and push the change upstream. */
  private reassign() {
    const now = this.clock();
    const next = new Set(socketShare([...this.wanted.keys()], this.options.plan.socketSymbols, this.options.socket !== null));
    for (const symbol of next) if (!this.onSocket.has(symbol)) this.heard.set(symbol, now);
    this.onSocket = next;
    if (!this.running) return;
    if (this.socket && !this.handles.has("sync")) this.after("sync", this.tuning.syncDelayMs, () => this.syncUpstream());
    this.ensureSocket();
  }

  private syncUpstream() {
    const socket = this.socket;
    if (!socket) return;
    const remove = [...this.upstream].filter((symbol) => !this.onSocket.has(symbol));
    const add = [...this.onSocket].filter((symbol) => !this.upstream.has(symbol));
    this.upstream = new Set(this.onSocket);
    // Unsubscribe first: Fyers refuses a connection that goes over the plan's symbol count.
    if (remove.length) socket.unsubscribe(remove);
    if (add.length) socket.subscribe(add);
  }

  /** Open the socket if it should be open and isn't (or isn't already being opened or retried). */
  private ensureSocket(): boolean {
    if (!this.running || !this.options.socket || this.state !== "disconnected" || this.handles.has("reconnect")) return false;
    if (!this.onSocket.size || !this.marketOpen(this.clock())) return false;
    this.open(this.options.socket);
    return true;
  }

  private open(factory: DataSocketFactory) {
    const generation = ++this.generation;
    const current = () => generation === this.generation && this.running;
    this.state = "connecting";
    this.degradedSince ??= this.clock();
    this.after("connectTimeout", this.tuning.connectTimeoutMs, () => {
      if (current() && this.state !== "connected") this.fail("the socket didn't connect in time");
    });
    Promise.resolve().then(factory).then(
      (socket) => {
        if (!current()) {
          socket.close();
          return;
        }
        this.socket = socket;
        socket.on("connect", () => current() && this.connected());
        socket.on("message", (tick) => current() && this.socketTick(tick));
        socket.on("error", (error) => current() && this.socketError(error));
        socket.on("close", () => current() && this.fail("the socket closed"));
        this.upstream = new Set(this.onSocket);
        socket.subscribe([...this.onSocket]);
        try {
          socket.connect();
        } catch (error) {
          this.fail(`couldn't connect the socket: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
      (error: unknown) => {
        if (current()) this.fail(`couldn't open the socket: ${error instanceof Error ? error.message : String(error)}`);
      },
    );
  }

  private connected() {
    const now = this.clock();
    this.clear("connectTimeout");
    this.state = "connected";
    this.degradedSince = null;
    // Silence is measured from now: symbols get a fresh 3 minutes after a reconnect.
    for (const symbol of this.onSocket) this.heard.set(symbol, Math.max(this.heard.get(symbol) ?? 0, now));
    const gapFrom = this.lastHeardAt;
    this.lastHeardAt = now;
    this.log.info("live socket connected", { symbols: this.onSocket.size, reconnects: this.reconnects });
    if (this.everConnected && gapFrom > 0 && gapFrom < now) this.emitReconnect({ from: gapFrom, to: now });
    this.everConnected = true;
  }

  private socketTick(tick: Tick) {
    if (!this.wanted.has(tick.symbol)) return; // unsubscribed while in flight
    const now = this.clock();
    this.lastHeardAt = now;
    this.heard.set(tick.symbol, now);
    this.failures = 0;
    this.emit(tick);
  }

  private socketError(error: { message: string; auth: boolean }) {
    this.log.warn("live socket error", { error: error.message, auth: error.auth });
    // While connected, most SDK errors are about one request (an unknown symbol); a token error or a failed connect is fatal.
    if (error.auth || this.state !== "connected") this.fail(error.auth ? "the broker rejected the token" : "the socket failed to connect");
  }

  /** The socket failed: drop it and retry after a backoff. */
  private fail(reason: string) {
    if (!this.running) return;
    this.dropSocket();
    this.degradedSince ??= this.clock();
    this.failures += 1;
    const delay = backoffMs(this.failures, this.tuning.backoffBaseMs, this.tuning.backoffMaxMs);
    this.log.warn("live socket down; reconnecting", { reason, inMs: delay, failures: this.failures });
    if (this.handles.has("reconnect")) return;
    this.after("reconnect", delay, () => {
      if (this.ensureSocket()) this.reconnects += 1;
    });
  }

  private dropSocket() {
    this.generation += 1;
    this.clear("connectTimeout");
    this.clear("sync");
    const socket = this.socket;
    this.socket = null;
    this.upstream = new Set();
    this.state = "disconnected";
    try {
      socket?.close();
    } catch {
      // already closed
    }
  }

  private watchdog() {
    if (!this.running) return;
    const now = this.clock();
    if (!this.marketOpen(now)) {
      if (this.socket || this.state !== "disconnected" || this.handles.has("reconnect")) {
        this.clear("reconnect");
        this.dropSocket();
        this.failures = 0;
        this.log.info("market closed: live socket closed");
      }
      this.degradedSince = null;
      return;
    }
    if (this.state === "connected" && this.onSocket.size && now - this.lastHeardAt >= this.tuning.socketSilentMs) {
      const silentSince = this.lastHeardAt;
      this.fail(`no ticks for ${Math.round((now - silentSince) / 1000)} s`);
      this.degradedSince = silentSince; // poll its symbols right away
      return;
    }
    this.ensureSocket();
  }

  private socketHealthy(now: number) {
    if (!this.options.socket) return false;
    if (this.state === "connected") return now - this.lastHeardAt < this.tuning.socketSilentMs;
    return this.degradedSince !== null && now - this.degradedSince < this.tuning.downGraceMs;
  }

  // --- polling ---

  private polledSymbols(now: number) {
    return pollList({
      wanted: [...this.wanted.keys()],
      onSocket: this.onSocket,
      socketHealthy: this.socketHealthy(now),
      heard: this.heard,
      now,
      symbolSilentMs: this.tuning.symbolSilentMs,
    });
  }

  private pollingStopped(now: number) {
    if (this.pollStoppedDay === null) return false;
    if (istDayKey(now) === this.pollStoppedDay) return true;
    this.pollStoppedDay = null;
    return false;
  }

  /** One polling round (no-op if one is still running). Resolves when it's done. */
  pollRound(): Promise<void> {
    const fetcher = this.options.quotes;
    if (this.polling) return this.polling;
    const now = this.clock();
    if (!this.running || !fetcher || !this.marketOpen(now) || this.pollingStopped(now)) return Promise.resolve();
    const symbols = this.polledSymbols(now);
    if (!symbols.length) return Promise.resolve();
    const batch = Math.max(1, this.options.plan.quoteBatch);
    this.polling = (async () => {
      for (let start = 0; start < symbols.length && this.running; start += batch) {
        let ticks: Tick[];
        try {
          ticks = await fetcher.quotes(symbols.slice(start, start + batch), "refresh");
        } catch (error) {
          if (error instanceof BudgetExhaustedError || (error instanceof BrokerError && error.kind === "budget")) {
            this.pollStoppedDay = istDayKey(this.clock());
            this.log.warn("live polling stopped for today: broker budget spent", { error });
          } else {
            this.log.warn("live poll failed", { error, kind: error instanceof BrokerError ? error.kind : undefined });
          }
          return; // the rest of the round would fail the same way
        }
        if (!this.running) return;
        for (const tick of ticks) if (this.wanted.has(tick.symbol)) this.emit(tick);
      }
    })().finally(() => {
      this.polling = null;
    });
    return this.polling;
  }

  // --- plumbing ---

  private emit(tick: Tick) {
    this.lastTickAt = Math.max(this.lastTickAt ?? 0, tick.ts);
    for (const listener of this.tickListeners) {
      try {
        listener(tick);
      } catch (error) {
        this.log.error("live tick listener failed", { error });
      }
    }
  }

  private emitReconnect(downtime: { from: number; to: number }) {
    for (const listener of this.reconnectListeners) {
      try {
        listener(downtime);
      } catch (error) {
        this.log.error("live reconnect listener failed", { error });
      }
    }
  }

  private after(name: TimerName, ms: number, callback: () => void) {
    this.clear(name);
    this.handles.set(
      name,
      this.timers.setTimeout(() => {
        this.handles.delete(name);
        callback();
      }, ms),
    );
  }

  private every(name: TimerName, ms: number, callback: () => void) {
    const loop = () =>
      this.after(name, ms, () => {
        if (!this.running) return;
        loop();
        callback();
      });
    loop();
  }

  private clear(name: TimerName) {
    const handle = this.handles.get(name);
    if (handle === undefined) return;
    this.timers.clearTimeout(handle);
    this.handles.delete(name);
  }
}
