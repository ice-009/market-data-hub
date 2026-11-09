import type { FeedStatus, LiveFeed, Tick } from "./types.js";

// Fan-out of the one live feed to many stream clients (GET /v1/stream).
//
// Each client connection gets a small buffer that holds at most one tick per
// symbol it watches, plus the latest feed status and a heartbeat flag. A fast
// client drains it as ticks arrive; a slow one (its socket isn't draining, so
// the HTTP layer stops pulling) has newer ticks *replace* older ones for the
// same symbol instead of queueing behind them. Nothing is lost that matters:
// a tick carries the day's open/high/low and cumulative volume, so the latest
// one is a complete picture — and memory per connection stays bounded by its
// symbol cap no matter how slow the client is.
//
// The fan-out also remembers the latest tick per symbol (for GET /v1/quotes),
// owns the feed subscriptions of stream clients (subscribe on open, always
// unsubscribe on release) and runs two shared timers while anyone is
// connected: heartbeats, and a check that notices feed mode changes.

/** What a connection has waiting, taken in one go. */
export interface FanoutDrain {
  /** Set when the feed's mode or socket state changed since the last drain. */
  status: FeedStatus | null;
  /** Latest tick per symbol, oldest arrival first. */
  ticks: Tick[];
  /** A heartbeat is due (only when nothing else is being sent). */
  heartbeat: boolean;
}

export class FanoutConnection {
  private ticks = new Map<string, Tick>();
  private status: FeedStatus | null = null;
  private beat = false;
  private wake: (() => void) | null = null;
  private done = false;
  /** Ticks replaced before the client read them (it was slower than the feed). */
  coalesced = 0;
  delivered = 0;

  constructor(
    readonly id: string,
    /** Who opened it (the API key id) — used for the per-key connection cap. */
    readonly owner: string,
    readonly symbols: ReadonlySet<string>,
  ) {}

  get closed() {
    return this.done;
  }

  /** Items waiting to be read (ticks + status + heartbeat). */
  get pending() {
    return this.ticks.size + (this.status ? 1 : 0) + (this.beat ? 1 : 0);
  }

  push(tick: Tick) {
    if (this.done || !this.symbols.has(tick.symbol)) return;
    if (this.ticks.delete(tick.symbol)) this.coalesced += 1;
    this.ticks.set(tick.symbol, tick);
    this.notify();
  }

  pushStatus(status: FeedStatus) {
    if (this.done) return;
    this.status = status;
    this.notify();
  }

  heartbeat() {
    if (this.done) return;
    this.beat = true;
    this.notify();
  }

  /** Wait until something is waiting, then take all of it; null once closed. */
  async next(): Promise<FanoutDrain | null> {
    while (!this.done && this.pending === 0) await new Promise<void>((resolve) => (this.wake = resolve));
    if (this.done) return null;
    const drain: FanoutDrain = { status: this.status, ticks: [...this.ticks.values()], heartbeat: this.beat && this.ticks.size === 0 && !this.status };
    this.ticks.clear();
    this.status = null;
    this.beat = false;
    this.delivered += drain.ticks.length;
    return drain;
  }

  /** Stop: drop what is buffered and end any pending next(). Idempotent. */
  close() {
    this.done = true;
    this.ticks.clear();
    this.status = null;
    this.notify();
  }

  private notify() {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }
}

export interface FanoutOptions {
  /** Heartbeat interval (ms). */
  heartbeatMs: number;
  /** How often to check the feed's status for a mode change (ms). */
  statusCheckMs: number;
}

const statusKey = (status: FeedStatus) => `${status.mode}|${status.socket}`;

export class Fanout {
  private latestTicks = new Map<string, Tick>();
  private bySymbol = new Map<string, Set<FanoutConnection>>();
  private connections = new Set<FanoutConnection>();
  private offTick: () => void;
  private timers: ReturnType<typeof setInterval>[] = [];
  private lastStatus = "";

  constructor(
    private feed: LiveFeed,
    private options: FanoutOptions,
  ) {
    this.offTick = feed.onTick((tick) => this.dispatch(tick));
  }

  /** The latest tick the feed delivered for `symbol` since this process started. */
  latest(symbol: string): Tick | undefined {
    return this.latestTicks.get(symbol);
  }

  /** Open connections. */
  get size() {
    return this.connections.size;
  }

  /** Open connections for one owner (API key). */
  countFor(owner: string): number {
    let count = 0;
    for (const connection of this.connections) if (connection.owner === owner) count += 1;
    return count;
  }

  /** Register a connection and subscribe its symbols upstream (as owner `id`). */
  open(id: string, owner: string, symbols: string[]): FanoutConnection {
    const connection = new FanoutConnection(id, owner, new Set(symbols));
    this.connections.add(connection);
    for (const symbol of connection.symbols) {
      let set = this.bySymbol.get(symbol);
      if (!set) this.bySymbol.set(symbol, (set = new Set()));
      set.add(connection);
    }
    if (this.connections.size === 1) this.startTimers();
    this.feed.subscribe(id, [...connection.symbols]);
    return connection;
  }

  /** Close a connection and drop its feed subscription. Safe to call more than once. */
  release(connection: FanoutConnection) {
    connection.close();
    if (!this.connections.delete(connection)) return;
    for (const symbol of connection.symbols) {
      const set = this.bySymbol.get(symbol);
      set?.delete(connection);
      if (set && !set.size) this.bySymbol.delete(symbol);
    }
    this.feed.unsubscribe(connection.id);
    if (!this.connections.size) this.stopTimers();
  }

  /** Release every connection and stop listening to the feed (shutdown). */
  close() {
    for (const connection of [...this.connections]) this.release(connection);
    this.offTick();
    this.stopTimers();
  }

  private dispatch(tick: Tick) {
    this.latestTicks.set(tick.symbol, tick);
    const set = this.bySymbol.get(tick.symbol);
    if (set) for (const connection of set) connection.push(tick);
  }

  private startTimers() {
    this.lastStatus = statusKey(this.feed.status());
    const heartbeat = setInterval(() => {
      for (const connection of this.connections) connection.heartbeat();
    }, this.options.heartbeatMs);
    const status = setInterval(() => {
      const current = this.feed.status();
      const key = statusKey(current);
      if (key === this.lastStatus) return;
      this.lastStatus = key;
      for (const connection of this.connections) connection.pushStatus(current);
    }, this.options.statusCheckMs);
    heartbeat.unref?.();
    status.unref?.();
    this.timers = [heartbeat, status];
  }

  private stopTimers() {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }
}
