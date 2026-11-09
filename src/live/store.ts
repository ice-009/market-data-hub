import type { Statement } from "better-sqlite3";
import { readKv, writeKv, type Db } from "../db.js";
import type { Logger } from "../log.js";
import { DAY_MS, MINUTE_MS, isMarketOpen } from "../time.js";
import { foldTick, minuteOf, seedAgg, tradeTime, type MinuteAcc, type SymbolAgg } from "./aggregate.js";
import type { LiveStore, MinuteBar, Quote, Tick } from "./types.js";

// Live persistence (migration 4): the last quote per symbol, 1-minute bars and
// the persistent subscription set — everything a restart needs to carry on.
//
// Writes are batched. record() only touches memory (folds ticks into minute
// bars, keeps the newest quote per symbol); a timer writes in one transaction:
//   every flushMs (1 s)         changed quotes and minutes that have closed
//   every formingFlushMs (5 s)  the forming minute, rewritten in place
// so 100 symbols ticking several times a second cost about one transaction a
// second of ~100 small upserts. Quotes live in a few pages; closed minutes are
// written once (plus a rewrite if a late tick lands in them); rewriting the
// forming minute touches one page per symbol, which is why it runs less often.
// A crash loses at most the last flush interval — recovery refetches the minute
// the hub stopped in from broker history anyway.
//
// Broker bars (recovery) are authoritative: a live write never replaces one
// (the upsert is guarded on source), and reads prefer them.
//
// A heartbeat in kv records that the process was alive, so the next start can
// tell how long the hub was down (see previousRun and src/live/recovery.ts).
// Old minute bars are deleted after retentionDays, checked at most hourly.

export const HEARTBEAT_KEY = "live.heartbeat";
const HEARTBEAT_MS = 30_000;
const PRUNE_EVERY_MS = 60 * MINUTE_MS;

export interface LiveStoreOptions {
  db: Db;
  clock?: () => number;
  /** Quotes and closed minutes are written this often (ms). */
  flushMs?: number;
  /** The forming minute is rewritten this often (ms). */
  formingFlushMs?: number;
  /** 1-minute bars older than this are deleted. */
  retentionDays?: number;
  /** Run the flush timer (tests call flushDue()/flush() themselves). */
  timer?: boolean;
  log?: Logger;
}

export type SubscriptionOrigin = "config" | "pin";

export interface PersistentEntry {
  symbol: string;
  origin: SubscriptionOrigin;
  addedAt: number;
}

/** What the previous process left behind, read once when the store opens. */
export interface PreviousRun {
  /** Newest tick the previous run received (ms), or null if none was ever stored. */
  lastTickAt: number | null;
  /** Last time the previous run was known alive (heartbeat or tick), or null. */
  aliveAt: number | null;
}

interface QuoteRow {
  symbol: string;
  ltp: number;
  ch: number;
  chp: number;
  open: number;
  high: number;
  low: number;
  prev_close: number;
  volume: number;
  ltt: number;
  ts: number;
  source: string;
}

const rowToQuote = (row: QuoteRow): Quote => ({
  symbol: row.symbol,
  ltp: row.ltp,
  ch: row.ch,
  chp: row.chp,
  open: row.open,
  high: row.high,
  low: row.low,
  prevClose: row.prev_close,
  volume: row.volume,
  ltt: row.ltt,
  ts: row.ts,
  source: "store",
});

const toBar = (acc: MinuteAcc): MinuteBar => ({ symbol: acc.symbol, t: acc.t, o: acc.o, h: acc.h, l: acc.l, c: acc.c, v: acc.v, source: acc.source });

/** Brokers sometimes omit a field: store 0 rather than fail the batch. */
const num = (value: number) => (Number.isFinite(value) ? value : 0);

/** Is `a` a newer quote than `b`? Trade time first, then receipt time. */
const newer = (a: Tick, b: Tick) => tradeTime(a) > tradeTime(b) || (tradeTime(a) === tradeTime(b) && a.ts >= b.ts);

export class SqliteLiveStore implements LiveStore {
  private readonly db: Db;
  private readonly clock: () => number;
  private readonly flushMs: number;
  private readonly formingFlushMs: number;
  private readonly retentionMs: number;
  private readonly log?: Logger;
  private readonly timer: ReturnType<typeof setInterval> | null = null;

  /** Per-symbol aggregation state (seeded from the database on first sight). */
  private readonly aggs = new Map<string, SymbolAgg>();
  /** Newest quote per symbol received by this process. */
  private readonly quotes = new Map<string, Tick>();
  /** Quotes and minutes changed since they were last written. */
  private readonly dirtyQuotes = new Set<string>();
  private readonly dirtyBars = new Set<MinuteAcc>();
  private lastFormingFlush = 0;
  private lastHeartbeat = 0;
  private lastPrune = 0;
  private lastTickAt: number | null = null;
  private readonly previous: PreviousRun;
  private readonly previousTicks: Map<string, number>;

  private readonly stmt: {
    upsertQuote: Statement;
    upsertLiveBar: Statement;
    upsertBrokerBar: Statement;
    quote: Statement;
    bar: Statement;
    bars: Statement;
  };

  constructor(options: LiveStoreOptions) {
    this.db = options.db;
    this.clock = options.clock ?? Date.now;
    this.flushMs = options.flushMs ?? 1_000;
    this.formingFlushMs = options.formingFlushMs ?? 5_000;
    this.retentionMs = (options.retentionDays ?? 30) * DAY_MS;
    this.log = options.log;
    const db = this.db;
    this.stmt = {
      upsertQuote: db.prepare(
        `insert into live_quotes (symbol, ltp, ch, chp, open, high, low, prev_close, volume, ltt, ts, source, updated_at)
         values (@symbol, @ltp, @ch, @chp, @open, @high, @low, @prevClose, @volume, @ltt, @ts, @source, @updatedAt)
         on conflict(symbol) do update set ltp = excluded.ltp, ch = excluded.ch, chp = excluded.chp, open = excluded.open,
           high = excluded.high, low = excluded.low, prev_close = excluded.prev_close, volume = excluded.volume,
           ltt = excluded.ltt, ts = excluded.ts, source = excluded.source, updated_at = excluded.updated_at`,
      ),
      // A live minute never replaces a broker one.
      upsertLiveBar: db.prepare(
        `insert into live_bars_1m (symbol, t, o, h, l, c, v, source) values (?, ?, ?, ?, ?, ?, ?, 'live')
         on conflict(symbol, t) do update set o = excluded.o, h = excluded.h, l = excluded.l, c = excluded.c, v = excluded.v
         where live_bars_1m.source = 'live'`,
      ),
      upsertBrokerBar: db.prepare("insert or replace into live_bars_1m (symbol, t, o, h, l, c, v, source) values (?, ?, ?, ?, ?, ?, ?, 'broker')"),
      quote: db.prepare("select * from live_quotes where symbol = ?"),
      bar: db.prepare("select symbol, t, o, h, l, c, v, source from live_bars_1m where symbol = ? and t = ?"),
      bars: db.prepare("select symbol, t, o, h, l, c, v, source from live_bars_1m where symbol = ? and t >= ? and t < ? order by t"),
    };

    // One row per symbol ever quoted: small enough to snapshot whole.
    const last = db.prepare("select symbol, ts from live_quotes").all() as Array<{ symbol: string; ts: number }>;
    this.previousTicks = new Map(last.map((row) => [row.symbol, row.ts]));
    const newest = last.length ? Math.max(...last.map((row) => row.ts)) : null;
    const heartbeat = readKv<{ at: number }>(db, HEARTBEAT_KEY);
    const aliveAt = Math.max(newest ?? -Infinity, heartbeat?.at ?? -Infinity);
    this.previous = { lastTickAt: newest, aliveAt: Number.isFinite(aliveAt) ? aliveAt : null };

    if (options.timer !== false) {
      this.timer = setInterval(() => this.flushDue(), this.flushMs);
      this.timer.unref?.();
    }
  }

  /** What the previous run left (captured when the store opened, before any new tick). */
  previousRun(): PreviousRun {
    return { ...this.previous };
  }

  record(ticks: Tick[]): void {
    for (const tick of ticks) {
      if (!tick || typeof tick.symbol !== "string" || !tick.symbol || !Number.isFinite(tick.ltp) || tick.source === "store") continue;
      const known = this.quotes.get(tick.symbol);
      if (!known || newer(tick, known)) {
        this.quotes.set(tick.symbol, tick);
        this.dirtyQuotes.add(tick.symbol);
      }
      if (Number.isFinite(tick.ts)) this.lastTickAt = Math.max(this.lastTickAt ?? tick.ts, tick.ts);
      const acc = foldTick(this.agg(tick.symbol), tick);
      if (acc) this.dirtyBars.add(acc);
    }
  }

  lastQuotes(symbols: string[]): Map<string, Quote> {
    const out = new Map<string, Quote>();
    for (const symbol of symbols) {
      const live = this.quotes.get(symbol);
      if (live) {
        out.set(symbol, { ...live });
        continue;
      }
      const row = this.stmt.quote.get(symbol) as QuoteRow | undefined;
      if (row) out.set(symbol, rowToQuote(row));
    }
    return out;
  }

  minuteBars(symbol: string, from: number, to: number): MinuteBar[] {
    const stored = this.stmt.bars.all(symbol, from, to) as MinuteBar[];
    const open = this.aggs.get(symbol)?.open.filter((acc) => acc.t >= from && acc.t < to) ?? [];
    if (!open.length) return stored;
    // Minutes still in memory are newer than their stored copy, unless the broker's is stored.
    const byT = new Map(stored.map((bar) => [bar.t, bar]));
    for (const acc of open) if (byT.get(acc.t)?.source !== "broker") byT.set(acc.t, toBar(acc));
    return [...byT.values()].sort((a, b) => a.t - b.t);
  }

  /** Write broker bars (gap repair); they replace live bars of the same minutes. */
  writeBrokerBars(bars: MinuteBar[]): void {
    if (!bars.length) return;
    this.db.transaction(() => {
      for (const bar of bars) this.stmt.upsertBrokerBar.run(bar.symbol, bar.t, bar.o, bar.h, bar.l, bar.c, bar.v);
    })();
  }

  /** Broker-sourced minutes stored for a symbol in [from, to). */
  brokerMinutes(symbol: string, from: number, to: number): number {
    const row = this.db.prepare("select count(*) as n from live_bars_1m where symbol = ? and t >= ? and t < ? and source = 'broker'").get(symbol, from, to) as { n: number };
    return row.n;
  }

  /** When the previous run last received a tick for each symbol (snapshot taken when the store opened). */
  previousTickTimes(symbols: string[]): Map<string, number> {
    const out = new Map<string, number>();
    for (const symbol of symbols) {
      const ts = this.previousTicks.get(symbol);
      if (ts !== undefined) out.set(symbol, ts);
    }
    return out;
  }

  // ── Persistent subscriptions ──────────────────────────────────────────────

  persistentSymbols(): string[] {
    return this.persistentEntries().map((entry) => entry.symbol);
  }

  persistentEntries(): PersistentEntry[] {
    const rows = this.db.prepare("select symbol, origin, added_at from live_subscriptions order by added_at, symbol").all() as Array<{ symbol: string; origin: SubscriptionOrigin; added_at: number }>;
    return rows.map((row) => ({ symbol: row.symbol, origin: row.origin, addedAt: row.added_at }));
  }

  /**
   * Replace the set of one origin (default "pin", the API's). "config" is
   * HUB_LIVE_SYMBOLS at start: config symbols take over a pin of the same symbol;
   * a pin never takes over a config symbol.
   */
  setPersistentSymbols(symbols: string[], origin: SubscriptionOrigin = "pin"): void {
    const wanted = new Set(symbols.filter(Boolean));
    const now = this.clock();
    this.db.transaction(() => {
      const current = this.db.prepare("select symbol from live_subscriptions where origin = ?").all(origin) as Array<{ symbol: string }>;
      const remove = this.db.prepare("delete from live_subscriptions where symbol = ? and origin = ?");
      for (const row of current) if (!wanted.has(row.symbol)) remove.run(row.symbol, origin);
      this.addPersistent([...wanted], origin, now);
    })();
  }

  /** Add symbols (a pin by default). */
  pin(symbols: string[], origin: SubscriptionOrigin = "pin"): void {
    this.db.transaction(() => this.addPersistent(symbols.filter(Boolean), origin, this.clock()))();
  }

  /** Remove pinned symbols. Returns those that stay because the config lists them. */
  unpin(symbols: string[]): string[] {
    const kept: string[] = [];
    this.db.transaction(() => {
      const origin = this.db.prepare("select origin from live_subscriptions where symbol = ?");
      const remove = this.db.prepare("delete from live_subscriptions where symbol = ? and origin = 'pin'");
      for (const symbol of symbols) {
        if ((origin.get(symbol) as { origin: string } | undefined)?.origin === "config") kept.push(symbol);
        else remove.run(symbol);
      }
    })();
    return kept;
  }

  private addPersistent(symbols: string[], origin: SubscriptionOrigin, now: number) {
    const insert = this.db.prepare(
      origin === "config"
        ? "insert into live_subscriptions (symbol, added_at, origin) values (?, ?, 'config') on conflict(symbol) do update set origin = 'config'"
        : "insert into live_subscriptions (symbol, added_at, origin) values (?, ?, 'pin') on conflict(symbol) do nothing",
    );
    for (const symbol of symbols) insert.run(symbol, now);
  }

  // ── Writing ───────────────────────────────────────────────────────────────

  /** Write everything buffered, the forming minutes included (shutdown). */
  flush(): void {
    this.write(this.clock(), true, true);
  }

  /** The timer's step: quotes and closed minutes, the forming minute when due, heartbeat, retention. */
  flushDue(): void {
    const now = this.clock();
    try {
      this.write(now, now - this.lastFormingFlush >= this.formingFlushMs);
      if (now - this.lastPrune >= PRUNE_EVERY_MS) this.prune(now);
    } catch (error) {
      // Kept in memory; the next step tries again (e.g. the database was busy).
      this.log?.warn("live store write failed", { error });
    }
  }

  /** Stop the timer and write what's buffered. */
  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.flush();
  }

  /** Delete 1-minute bars older than the retention. Returns how many went. */
  prune(now = this.clock()): number {
    this.lastPrune = now;
    const cutoff = minuteOf(now - this.retentionMs);
    const result = this.db.prepare("delete from live_bars_1m where t < ?").run(cutoff);
    if (result.changes) this.log?.info("live bars pruned", { rows: result.changes, before: cutoff });
    return result.changes;
  }

  /** Buffered work and timings, for /v1/status. */
  stats() {
    return {
      bufferedQuotes: this.dirtyQuotes.size,
      bufferedBars: this.dirtyBars.size,
      symbolsSeen: this.quotes.size,
      lastTickAt: this.lastTickAt,
      lastPruneAt: this.lastPrune || null,
      previousRun: this.previousRun(),
    };
  }

  private write(now: number, includeForming: boolean, final = false) {
    const quotes = [...this.dirtyQuotes];
    const bars = [...this.dirtyBars].filter((acc) => includeForming || acc.t + MINUTE_MS <= now);
    const heartbeat = now - this.lastHeartbeat >= HEARTBEAT_MS || final;
    if (!quotes.length && !bars.length && !heartbeat) return;
    this.db.transaction(() => {
      for (const symbol of quotes) {
        const q = this.quotes.get(symbol) as Tick;
        this.stmt.upsertQuote.run({ symbol, ltp: q.ltp, ch: num(q.ch), chp: num(q.chp), open: num(q.open), high: num(q.high), low: num(q.low), prevClose: num(q.prevClose), volume: num(q.volume), ltt: num(q.ltt), ts: num(q.ts), source: q.source, updatedAt: now });
      }
      for (const acc of bars) this.stmt.upsertLiveBar.run(acc.symbol, acc.t, acc.o, acc.h, acc.l, acc.c, acc.v);
      if (heartbeat) writeKv(this.db, HEARTBEAT_KEY, { at: now, lastTickAt: this.lastTickAt }, now);
    })();
    for (const symbol of quotes) this.dirtyQuotes.delete(symbol);
    for (const acc of bars) this.dirtyBars.delete(acc);
    if (includeForming) this.lastFormingFlush = now;
    if (heartbeat) this.lastHeartbeat = now;
  }

  /** Aggregation state for a symbol, seeded from the database the first time it's seen. */
  private agg(symbol: string): SymbolAgg {
    let agg = this.aggs.get(symbol);
    if (!agg) {
      const row = this.stmt.quote.get(symbol) as QuoteRow | undefined;
      const last = row ? { ltt: row.ltt > 0 ? row.ltt : row.ts, volume: row.volume } : null;
      const bar = last && isMarketOpen(last.ltt) ? ((this.stmt.bar.get(symbol, minuteOf(last.ltt)) as MinuteBar | undefined) ?? null) : null;
      agg = seedAgg(symbol, last, bar);
      this.aggs.set(symbol, agg);
    }
    return agg;
  }
}
