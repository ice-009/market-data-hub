import type { Priority } from "../broker/budget.js";
import { BrokerError } from "../broker/errors.js";
import { isFuture } from "../broker/symbols.js";
import type { Bar, HistoryResult, Resolution } from "../broker/fyers.js";
import type { Db } from "../db.js";
import type { Logger } from "../log.js";
import { DAY_MS, MINUTE_MS, istDayKey, weekdayOnOrBefore } from "../time.js";
import { covers, extendCoverage, missingRanges, wasAdjusted, type Missing, type Range } from "./plan.js";
import { hourStart, resample, weekStart } from "./resample.js";
import { deliveryPct, pruneBefore, readBars, readSeries, resetSymbol, writeBars } from "./store.js";
import { BASE, dayOf, dayStartT, finalBefore, formingNow, windowStart, type BaseTf, type Tf } from "./timeframes.js";

// Candles for the API and for backfills. Everything is served from the store;
// only ranges the store doesn't cover are fetched from the broker (at the
// caller's priority — background for API requests and backfills), and only
// once per series at a time: concurrent requests for one series queue behind
// the fetch and then find the data stored.
//
// When a fresh download changes the close of a bar that was already final, the
// broker has adjusted history for a split or bonus: every stored series of the
// symbol is dropped and the requested range is downloaded again (stocks and
// indices only, not futures contracts).
//
// 1-minute series keep only the broker's short window (BASE["1m"].prune): older
// minutes are deleted after each download.

export interface HistoryBroker {
  history(symbol: string, resolution: Resolution, fromDay: number, toDay: number, priority: Priority): Promise<HistoryResult>;
}

export interface CandleRow extends Bar {
  /** Delivery % from NSE's bhavcopy (daily bars only; null when unknown). */
  dp?: number | null;
}

export interface CandleAnswer {
  /** ok: served; unavailable: the broker was needed but couldn't help; pending: still fetching; unknown_symbol: the broker doesn't know it. */
  status: "ok" | "unavailable" | "pending" | "unknown_symbol";
  base: BaseTf;
  candles: CandleRow[];
  /** Every final bar of the range (inside the broker's window) is stored. */
  complete: boolean;
  coverage: Range | null;
  error?: BrokerError;
}

export interface HistoryDeps {
  db: Db;
  /** Null when no broker is configured. */
  broker: HistoryBroker | null;
  /** Non-null when the broker may not be used right now (e.g. another process owns it). */
  blocked?: () => BrokerError | null;
  log: Logger;
  fetchWaitMs: number;
  clock?: () => number;
}

class Adjusted extends Error {}

export class HistoryService {
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly clock: () => number;

  constructor(private readonly deps: HistoryDeps) {
    this.clock = deps.clock ?? Date.now;
  }

  /** Bars of `tf` from the one containing `from` through the one starting at or before `to`. */
  async candles(symbol: string, tf: Tf, from: number, to: number): Promise<CandleAnswer> {
    const { base, want } = this.plan(symbol, tf, from, to);

    let status: CandleAnswer["status"] = "ok";
    let error: BrokerError | undefined;
    const outcome = await withTimeout(this.sync(symbol, base, want, "background"), this.deps.fetchWaitMs);
    if (outcome === "timeout") status = "pending";
    else if (outcome instanceof BrokerError) {
      error = outcome;
      status = outcome.kind === "bad_symbol" ? "unknown_symbol" : "unavailable";
    } else if (outcome instanceof Error) throw outcome;

    const stored = this.stored(symbol, tf, from, to);
    if (status === "unknown_symbol" && stored.candles.length) status = "unavailable";
    return { status, ...stored, ...(error ? { error } : {}) };
  }

  /**
   * What the store holds for a request, without any broker call (the batch
   * endpoint answers from this and fetches the rest in the background). `want`
   * is the base-series range a fetch would need, already clamped to the broker's window.
   */
  stored(symbol: string, tf: Tf, from: number, to: number): Omit<CandleAnswer, "status" | "error"> & { want: Range } {
    const { range, base, want } = this.plan(symbol, tf, from, to);
    const meta = readSeries(this.deps.db, symbol, base);
    let bars: CandleRow[] = readBars(this.deps.db, symbol, base, range.from, range.to);
    if (tf === "1w") bars = resample(bars, weekStart);
    else if (tf === "1h") bars = resample(bars, hourStart);
    else if (tf === "1d") {
      const dp = deliveryPct(this.deps.db, symbol, range.from, range.to);
      bars = bars.map((bar) => ({ ...bar, dp: dp.get(bar.t) ?? null }));
    }
    // A week (hour) is included when it contains `from`.
    bars = bars.filter((bar) => bar.t >= range.from && bar.t <= to);
    const complete = covers(meta?.coverage ?? null, { from: want.from, to: Math.min(want.to, finalBefore(base, this.clock())) });
    return { base, candles: bars, complete, coverage: meta?.coverage ?? null, want };
  }

  private plan(symbol: string, tf: Tf, from: number, to: number) {
    const now = this.clock();
    const range = baseRange(tf, from, to);
    const base = this.baseFor(symbol, tf, range, now);
    return { range, base, want: { from: Math.max(range.from, windowStart(base, now)), to: range.to } };
  }

  /** Make sure `want` of a base series is stored (backfills). Throws BrokerError. */
  ensure(symbol: string, base: BaseTf, want: Range, priority: Priority): Promise<void> {
    const now = this.clock();
    return this.sync(symbol, base, { from: Math.max(want.from, windowStart(base, now)), to: want.to }, priority);
  }

  /** Is `want` of a base series already stored (nothing to fetch)? */
  isStored(symbol: string, base: BaseTf, want: Range): boolean {
    const now = this.clock();
    const meta = readSeries(this.deps.db, symbol, base);
    const clamped = { from: Math.max(want.from, windowStart(base, now)), to: Math.min(want.to, finalBefore(base, now)) };
    return clamped.from >= clamped.to || covers(meta?.coverage ?? null, clamped);
  }

  /** 1h comes from 5m when 5m already covers the range and 15m doesn't; otherwise from 15m. */
  private baseFor(symbol: string, tf: Tf, range: Range, now: number): BaseTf {
    if (tf === "1d" || tf === "1w") return "1d";
    if (tf !== "1h") return tf;
    const stored = (base: BaseTf) => covers(readSeries(this.deps.db, symbol, base)?.coverage ?? null, { from: Math.max(range.from, windowStart(base, now)), to: Math.min(range.to, finalBefore(base, now)) });
    return !stored("15m") && stored("5m") ? "5m" : "15m";
  }

  /** One fetch per series at a time; a later caller waits and then re-plans against the store. */
  private sync(symbol: string, base: BaseTf, want: Range, priority: Priority): Promise<void> {
    const key = `${symbol}|${base}`;
    const previous = this.inflight.get(key) ?? Promise.resolve();
    const job = previous.catch(() => undefined).then(() => this.syncNow(symbol, base, want, priority));
    this.inflight.set(key, job);
    job
      .finally(() => {
        if (this.inflight.get(key) === job) this.inflight.delete(key);
      })
      .catch(() => undefined);
    return job;
  }

  private async syncNow(symbol: string, base: BaseTf, want: Range, priority: Priority): Promise<void> {
    for (let pass = 0; ; pass += 1) {
      const now = this.clock();
      const meta = readSeries(this.deps.db, symbol, base);
      const stale = formingNow(base, now) && now - (meta?.syncedAt ?? 0) > BASE[base].freshMs;
      const missing = missingRanges(meta?.coverage ?? null, want, finalBefore(base, now), stale);
      if (!missing.length) return;
      if (!this.deps.broker) throw new BrokerError("No broker is configured, and these candles aren't stored.", "not_configured");
      const blocked = this.deps.blocked?.();
      if (blocked) throw blocked;
      try {
        // Newest first: recent bars matter most if the budget runs out part-way.
        for (const range of [...missing].sort((a, b) => Number(b.part === "tail") - Number(a.part === "tail"))) await this.fetchRange(this.deps.broker, symbol, base, range, priority);
        return;
      } catch (error) {
        if (error instanceof Adjusted && pass === 0) continue;
        throw error;
      }
    }
  }

  private async fetchRange(broker: HistoryBroker, symbol: string, base: BaseTf, range: Missing, priority: Priority) {
    const spec = BASE[base];
    const today = istDayKey(this.clock());
    const meta = readSeries(this.deps.db, symbol, base);
    let fromDay = dayOf(base, range.from);
    const toDay = Math.min(dayOf(base, range.to - 1), today);
    // A tail re-reads the last final daily bar, to notice a split adjustment.
    if (range.part === "tail" && spec.daily) fromDay = weekdayOnOrBefore(fromDay - DAY_MS);
    if (fromDay > toDay) return;

    const result = await broker.history(symbol, spec.resolution, fromDay, toDay, priority);
    // Futures contracts are left alone: one lives a few months, NSE adjusts it in
    // place on a corporate action, and dropping it would not touch the stock's series.
    if (range.part === "tail" && meta?.coverage && !isFuture(symbol)) {
      const stored = readBars(this.deps.db, symbol, base, dayStartT(base, fromDay), meta.coverage.to);
      if (wasAdjusted(stored, result.bars, meta.coverage.to)) {
        this.deps.log.info("broker history was adjusted (split/bonus?); downloading again", { symbol, tf: base });
        resetSymbol(this.deps.db, symbol);
        throw new Adjusted();
      }
    }
    const now = this.clock();
    const claimed = { from: dayStartT(base, result.coveredFromDay), to: Math.min(dayStartT(base, toDay + DAY_MS), finalBefore(base, now)) };
    const current = readSeries(this.deps.db, symbol, base)?.coverage ?? null;
    writeBars(this.deps.db, symbol, base, result.bars, extendCoverage(current, claimed), now);
    if (spec.prune) pruneBefore(this.deps.db, symbol, base, windowStart(base, now));
  }
}

/** The base-series range a request needs: whole weeks for 1w, whole session hours for 1h. Half-open. */
export function baseRange(tf: Tf, from: number, to: number): Range {
  if (tf === "1w") return { from: weekStart(from), to: weekStart(to) + 7 * DAY_MS };
  if (tf === "1h") return { from: hourStart(from), to: hourStart(to) + 60 * MINUTE_MS };
  return { from, to: to + 1 };
}

async function withTimeout(promise: Promise<void>, ms: number): Promise<"done" | "timeout" | Error> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  try {
    return await Promise.race([promise.then(() => "done" as const), timeout]);
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  } finally {
    clearTimeout(timer);
  }
}
