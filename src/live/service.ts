import path from "node:path";
import { FYERS_PLANS } from "../broker/budget.js";
import { BrokerError } from "../broker/errors.js";
import type { FyersClient } from "../broker/fyers.js";
import type { FyersAuth } from "../broker/fyersAuth.js";
import { createFyersSocketFactory, type DataSocketFactory } from "../broker/fyersSocket.js";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import type { LiveDeps, LiveRoutes } from "../http/routes/live.js";
import type { Logger } from "../log.js";
import { FyersLiveFeed, type FeedStatusDetail, type FeedTimers, type FeedTuning } from "./feed.js";
import { LiveRecovery, minuteFetcher } from "./recovery.js";
import { SqliteLiveStore } from "./store.js";
import type { LiveFeed, QuoteFetcher, Tick } from "./types.js";

// Live prices for one hub process: the store, the feed, gap repair and the
// state the HTTP routes share, wired together (milestone H2).
//
// Building a LiveService has no side effects — no timers, sockets, broker calls
// or database writes — because every process builds one, CLI commands
// included. Only the process holding the owner lock calls start(); before that
// (a non-owner server waiting for a CLI backfill to finish, or no broker
// configured) the store still answers from the database: last quotes, minute
// bars, the persistent set. The feed then reports "down" and quotes come back
// from the store marked stale.
//
// start() is what makes a restart carry on where the last run stopped:
//   1. the persistent set (HUB_LIVE_SYMBOLS + API pins, kept in the database)
//      is subscribed upstream before any client connects;
//   2. the store's flush timer starts (quotes and minute bars, batched);
//   3. recovery plans the minutes missed since the previous run's last tick
//      (the store captured it when it opened) and fetches them from broker
//      1-minute history, in the background, through the request budget;
//   4. later socket reconnects repair their silent window the same way.
// It is idempotent, so the server can call it again when it takes the owner
// lock over later.
//
// stop() shuts down in dependency order: streams → feed → recovery → store
// (final flush, unless `flush: false`, which tests use to simulate a crash).

/** How often an unfinished recovery (stopped by the budget or a strike) is retried. */
const RECOVERY_RETRY_MS = 5 * 60_000;

export interface LiveTestHooks {
  /** Stand-in for the Fyers socket (tests); default: the official SDK when a broker is configured. */
  socket?: DataSocketFactory | null;
  feedTimers?: FeedTimers;
  feedTuning?: Partial<FeedTuning>;
  marketOpen?: (time: number) => boolean;
  /** Recovery's wait between calls (tests advance a fake clock instead of waiting). */
  sleep?: (ms: number) => Promise<void>;
  /** Run the store's 1-second flush timer (default true; tests call store.flushDue() themselves). */
  flushTimer?: boolean;
}

export interface LiveServiceOptions {
  config: Config;
  db: Db;
  log: Logger;
  clock: () => number;
  /** Null when no broker is configured. */
  client: FyersClient | null;
  auth: FyersAuth | null;
  test?: LiveTestHooks;
}

/**
 * The feed the routes see. Until the real feed starts it keeps subscriptions
 * (handing them to the real feed, which holds them while stopped) and reports
 * itself down; without a broker there is no real feed at all.
 */
export class StandbyFeed implements LiveFeed {
  private running = false;
  private readonly owners = new Map<string, Set<string>>();

  constructor(
    private readonly inner: FyersLiveFeed | null,
    private readonly capacity: number,
  ) {}

  get started() {
    return this.running;
  }

  subscribe(owner: string, symbols: string[]) {
    if (this.inner) return this.inner.subscribe(owner, symbols);
    const mine = this.owners.get(owner) ?? new Set<string>();
    symbols.forEach((symbol) => mine.add(symbol));
    if (mine.size) this.owners.set(owner, mine);
  }

  unsubscribe(owner: string, symbols?: string[]) {
    if (this.inner) return this.inner.unsubscribe(owner, symbols);
    if (!symbols) this.owners.delete(owner);
    else symbols.forEach((symbol) => this.owners.get(owner)?.delete(symbol));
  }

  symbols() {
    return this.inner ? this.inner.symbols() : [...new Set([...this.owners.values()].flatMap((set) => [...set]))];
  }

  onTick(listener: (tick: Tick) => void) {
    return this.inner ? this.inner.onTick(listener) : () => {};
  }

  onReconnect(listener: (downtime: { from: number; to: number }) => void) {
    return this.inner ? this.inner.onReconnect(listener) : () => {};
  }

  status(): FeedStatusDetail {
    if (this.running && this.inner) return this.inner.status();
    return { mode: "down", socket: this.inner ? "disconnected" : "disabled", socketSymbols: 0, polledSymbols: 0, capacity: this.capacity, lastTickAt: null, reconnects: 0, pollingStopped: null };
  }

  start() {
    if (this.running || !this.inner) return;
    this.running = true;
    this.inner.start();
  }

  async stop() {
    if (!this.running || !this.inner) return;
    this.running = false;
    await this.inner.stop();
  }
}

export class LiveService {
  readonly store: SqliteLiveStore;
  readonly feed: StandbyFeed;
  /** Gap repair from broker history; null without a broker or with HUB_LIVE=off. */
  readonly recovery: LiveRecovery | null;
  /** Shared by the routes and /v1/status (the routes key their state on this object). */
  readonly deps: LiveDeps;
  private readonly routes = new Set<LiveRoutes>();
  private readonly timers: ReturnType<typeof setInterval>[] = [];
  private readonly sleeps = new Set<() => void>();
  private state: "idle" | "running" | "stopped" = "idle";

  constructor(private readonly options: LiveServiceOptions) {
    const { config, db, log, clock, client, auth, test } = options;
    const plan = FYERS_PLANS[config.fyers.plan];
    // The store's own timer stays off: this service runs the flush only in the owner.
    this.store = new SqliteLiveStore({ db, retentionDays: config.liveRetentionDays, log, clock, timer: false });

    let inner: FyersLiveFeed | null = null;
    let recovery: LiveRecovery | null = null;
    if (config.liveEnabled && client) {
      const socket =
        test?.socket !== undefined ? test.socket : auth ? createFyersSocketFactory({ auth, clientId: config.secrets.fyersClientId, logDir: path.join(config.dataDir, "fyers-sdk"), log, clock }) : null;
      inner = new FyersLiveFeed({ plan, socket, quotes: client, log, clock, timers: test?.feedTimers, marketOpen: test?.marketOpen, tuning: test?.feedTuning });
      const feed = inner;
      recovery = new LiveRecovery({
        db,
        store: this.store,
        fetch: minuteFetcher((...args) => client.history(...args)),
        symbols: () => feed.symbols(),
        log,
        clock,
        sleep: test?.sleep ?? ((ms) => this.sleep(ms)),
      });
      inner.onTick((tick) => this.store.record([tick]));
      inner.onReconnect((gap) => void recovery?.recoverGap(gap));
    }
    this.feed = new StandbyFeed(inner, plan.socketSymbols);
    this.recovery = recovery;
    // The stored persistent set is known (and shown) before the feed runs.
    this.feed.subscribe("persistent", this.store.persistentSymbols());

    // REST quotes only from the running owner: a waiting process answers from the store.
    const quotes: QuoteFetcher | null = inner && client
      ? { quotes: (symbols, priority) => (this.state === "running" ? client.quotes(symbols, priority) : Promise.reject(new BrokerError("Another hub process owns the broker connection.", "not_owner"))) }
      : null;
    this.deps = {
      feed: this.feed,
      store: this.store,
      quotes,
      clock,
      log,
      onPinned: (symbols) => {
        if (this.state === "running") void this.recovery?.recoverSymbols(symbols);
      },
    };
  }

  /** Is the feed running in this process? */
  get running() {
    return this.state === "running";
  }

  /** Start streaming (owner process only). Idempotent; a no-op without a broker or with HUB_LIVE=off. */
  start(): void {
    if (this.state !== "idle" || !this.recovery) return;
    this.state = "running";
    const { config, log, test } = this.options;
    const { store, recovery } = this;
    // HUB_LIVE_SYMBOLS may have changed since the last run: the config set is replaced, pins are kept.
    store.setPersistentSymbols(config.liveSymbols, "config");
    const persistent = store.persistentSymbols();
    this.feed.unsubscribe("persistent");
    this.feed.subscribe("persistent", persistent);
    if (test?.flushTimer !== false) this.every(1_000, () => store.flushDue());
    this.every(RECOVERY_RETRY_MS, () => {
      const status = recovery.status();
      if (!status.running && status.pending > 0) void recovery.resume();
    });
    this.feed.start();
    log.info("live feed started", { persistent: persistent.length, previousTickAt: store.previousRun().lastTickAt });
    void recovery.recoverOnStart(persistent);
  }

  /** Mount-time registration by the HTTP app, so stop() can end its streams first. */
  attach(routes: LiveRoutes): void {
    this.routes.add(routes);
  }

  /** Shut down: streams, feed, recovery, then the store's final flush. Safe to call more than once. */
  async stop(options: { flush?: boolean } = {}): Promise<void> {
    if (this.state === "stopped") return;
    const wasRunning = this.state === "running";
    this.state = "stopped";
    for (const routes of this.routes) routes.close();
    this.routes.clear();
    await this.feed.stop();
    this.recovery?.stop();
    for (const wake of this.sleeps) wake();
    for (const timer of this.timers.splice(0)) clearInterval(timer);
    if (wasRunning && options.flush !== false) {
      try {
        this.store.close();
      } catch (error) {
        this.options.log.warn("live store: final flush failed", { error });
      }
    }
  }

  /** For /v1/status (the app adds the routes' part: feed, streams, cached quotes). */
  status() {
    return {
      enabled: this.options.config.liveEnabled && this.recovery !== null,
      running: this.running,
      persistent: this.store.persistentEntries(),
      recovery: this.recovery?.status() ?? null,
      store: this.store.stats(),
    };
  }

  private every(ms: number, callback: () => void) {
    const timer = setInterval(() => {
      try {
        callback();
      } catch (error) {
        this.options.log.warn("live timer failed", { error });
      }
    }, ms);
    timer.unref?.();
    this.timers.push(timer);
  }

  /** Recovery's pacing: a timer that doesn't hold the process open and ends at stop(). */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        this.sleeps.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      timer.unref?.();
      this.sleeps.add(wake);
    });
  }
}
