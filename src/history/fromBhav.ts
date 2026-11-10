import { isFuture } from "../broker/symbols.js";
import type { Db } from "../db.js";
import type { Logger } from "../log.js";
import type { CashBhavRow } from "../nse/parsers/cashBhav.js";
import { checkedDays, lastOkDay } from "../nse/store.js";
import { DAY_MS, isWeekday } from "../time.js";
import { readBars, readSeries, listSeries, resetSymbol, writeBars } from "./store.js";

// Stored daily series move forward from NSE's free cash bhavcopy instead of the
// broker: one file a day covers every stock, so the daily tail costs no broker
// calls at all (index series still come from the broker). (The approach is
// Tradex's screener store, MIT.)
//
// A day is appended only to a series that is complete through the previous
// trading session, and only when every weekday in between is a known holiday —
// never across a gap. NSE's PREV_CLOSE is adjusted on ex-dates, so when it
// doesn't match our stored close the stored history predates a split or bonus:
// the symbol's series are dropped and the next request downloads them adjusted.
// Futures contracts (SBIN26NOVFUT) are never extended or reset here.

/** PREV_CLOSE differing from our close by more than this means a corporate action. */
export const SPLIT_TOLERANCE = 0.015;

export interface BhavApplyResult {
  extended: number;
  reset: string[];
}

export function applyCashBhav(db: Db, day: number, rows: CashBhavRow[], log: Logger): BhavApplyResult {
  const result: BhavApplyResult = { extended: 0, reset: [] };
  const prevDay = lastOkDay(db, "cash_bhav", day);
  if (prevDay === null) return result;
  // Every weekday between the previous stored session and this one must be a known holiday.
  const checked = checkedDays(db, "cash_bhav", prevDay);
  for (let d = prevDay + DAY_MS; d < day; d += DAY_MS) if (isWeekday(d) && checked.get(d) !== "holiday") return result;

  const bySymbol = new Map(rows.map((row) => [row.symbol, row]));
  for (const meta of listSeries(db, "1d")) {
    // A futures contract's daily bars come from the broker; the cash file has no row for it anyway.
    if (isFuture(meta.symbol)) continue;
    const row = bySymbol.get(meta.symbol);
    if (!row || !meta.coverage || row.open <= 0) continue;
    if (meta.coverage.to >= day + DAY_MS || meta.coverage.to < prevDay + DAY_MS) continue;
    const [previous] = readBars(db, meta.symbol, "1d", prevDay, prevDay + 1);
    if (previous && previous.c > 0 && Math.abs(row.prevClose / previous.c - 1) > SPLIT_TOLERANCE) {
      resetSymbol(db, meta.symbol);
      result.reset.push(meta.symbol);
      continue;
    }
    const current = readSeries(db, meta.symbol, "1d")!;
    writeBars(db, meta.symbol, "1d", [{ t: day, o: row.open, h: row.high, l: row.low, c: row.close, v: row.volume }], { from: meta.coverage.from, to: day + DAY_MS }, current.syncedAt);
    result.extended += 1;
  }
  if (result.reset.length) log.info("bhavcopy PREV_CLOSE shows corporate actions; dropped stored history", { symbols: result.reset.slice(0, 20), count: result.reset.length });
  return result;
}
