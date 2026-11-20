import { isFuture } from "../broker/symbols.js";
import type { Db } from "../db.js";
import type { Logger } from "../log.js";
import type { CashBhavRow } from "../nse/parsers/cashBhav.js";
import { checkedDays, dayStatuses, lastOkDay } from "../nse/store.js";
import { DAY_MS, isWeekday, isoDay } from "../time.js";
import { SPLIT_TOLERANCE } from "./adjustments.js";
import { readBars, readSeries, listSeries, resetSymbol, writeBars } from "./store.js";

// Stored daily series move forward from NSE's free cash bhavcopy instead of the
// broker: one file a day covers every stock, so the daily tail costs no broker
// calls at all (index series come from NSE's index file: src/history/fromIndices.ts). (The approach is
// Tradex's screener store, MIT.)
//
// A day is appended only to a series that is complete through the previous
// trading session, and only when every weekday in between is a known holiday —
// never across a gap. When the day is an ex-date — it has a row in
// adjustment_factors (src/history/adjustments.ts, derived from this very file
// before it gets here), or its PREV_CLOSE doesn't match our stored close — the
// stored history predates a split or bonus: the symbol's series are dropped and
// the next request downloads them adjusted. (NSE's PREV_CLOSE alone misses most
// ex-dates: it is usually just the previous close, unadjusted.) Futures
// contracts (SBIN26NOVFUT) are never extended or reset here.

export { SPLIT_TOLERANCE };

export interface BhavApplyResult {
  extended: number;
  reset: string[];
}

export function applyCashBhav(db: Db, day: number, rows: CashBhavRow[], log: Logger): BhavApplyResult {
  const result: BhavApplyResult = { extended: 0, reset: [] };
  const prevDay = lastOkDay(db, "cash_bhav", day);
  if (prevDay === null) return result;
  // Every weekday between the previous stored session and this one must be a known holiday.
  const checked = dayStatuses(db, "cash_bhav", prevDay);
  for (let d = prevDay + DAY_MS; d < day; d += DAY_MS) if (isWeekday(d) && checked.get(d) !== "holiday") return result;

  const bySymbol = new Map(rows.map((row) => [row.symbol, row]));
  const exDates = new Set(db.prepare("select symbol from adjustment_factors where day = ?").pluck().all(day) as string[]);
  for (const meta of listSeries(db, "1d")) {
    // A futures contract's daily bars come from the broker; the cash file has no row for it anyway.
    if (isFuture(meta.symbol)) continue;
    const row = bySymbol.get(meta.symbol);
    if (!row || !meta.coverage || row.open <= 0) continue;
    if (meta.coverage.to >= day + DAY_MS || meta.coverage.to < prevDay + DAY_MS) continue;
    const [previous] = readBars(db, meta.symbol, "1d", prevDay, prevDay + 1);
    if (exDates.has(meta.symbol) || (previous && previous.c > 0 && Math.abs(row.prevClose / previous.c - 1) > SPLIT_TOLERANCE)) {
      resetSymbol(db, meta.symbol);
      result.reset.push(meta.symbol);
      continue;
    }
    const current = readSeries(db, meta.symbol, "1d")!;
    writeBars(db, meta.symbol, "1d", [{ t: day, o: row.open, h: row.high, l: row.low, c: row.close, v: row.volume }], { from: meta.coverage.from, to: day + DAY_MS }, current.syncedAt);
    result.extended += 1;
  }
  if (result.reset.length) log.info("ex-dates (split/bonus) in the bhavcopy; dropped stored history", { symbols: result.reset.slice(0, 20), count: result.reset.length });
  return result;
}

/**
 * Bars a weekend session left out of stored daily series: a session missing
 * from WEEKEND_SESSIONS isn't asked for by the evening run, so the next
 * session's cash file extended the series straight past it (Sun 8 Nov 2026,
 * Muhurat). Each such bar is written from the session's stored cash bhavcopy,
 * where the bar before it is on the same price basis (the session's PREV_CLOSE
 * matches its close, so no split or bonus lies between); the rest are left for
 * the candle_gap check to report. `days`: the weekend sessions (WEEKEND_SESSIONS,
 * passed in to keep this module free of the NSE downloader). Returns the bars written.
 */
export function fillSessionGaps(db: Db, days: readonly number[], log: Logger): number {
  const stored = checkedDays(db, "cash_bhav");
  const previousClose = db.prepare("select c from candles where symbol = ? and tf = '1d' and t < ? order by t desc limit 1").pluck();
  let filled = 0;
  const skipped: string[] = [];
  for (const day of days) {
    if (stored.get(day) !== "ok") continue;
    const rows = db.prepare("select symbol, prev_close, o, h, l, c, v from cash_bhav where day = ?").all(day) as Array<{ symbol: string; prev_close: number; o: number; h: number; l: number; c: number; v: number }>;
    const bySymbol = new Map(rows.map((row) => [row.symbol, row]));
    for (const meta of listSeries(db, "1d")) {
      if (isFuture(meta.symbol) || !meta.coverage || meta.coverage.from > day || meta.coverage.to <= day) continue;
      const row = bySymbol.get(meta.symbol);
      if (!row || row.o <= 0 || readBars(db, meta.symbol, "1d", day, day + 1).length) continue;
      const previous = previousClose.get(meta.symbol, day) as number | undefined;
      if (!previous || previous <= 0 || Math.abs(row.prev_close / previous - 1) > SPLIT_TOLERANCE) {
        skipped.push(`${meta.symbol} ${isoDay(day)}`);
        continue;
      }
      writeBars(db, meta.symbol, "1d", [{ t: day, o: row.o, h: row.h, l: row.l, c: row.c, v: row.v }], meta.coverage, meta.syncedAt);
      filled += 1;
    }
  }
  if (filled || skipped.length) log.info("weekend-session bars filled in from the cash bhavcopy", { filled, skipped: skipped.slice(0, 20), skippedCount: skipped.length });
  return filled;
}
