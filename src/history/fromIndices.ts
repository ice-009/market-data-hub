import type { Db } from "../db.js";
import { NSE_INDICES } from "../reference/indices.js";
import { checkedDays, readIndexCloses, remapIndexNames, type DayStatus } from "../nse/store.js";
import { DAY_MS, isWeekday } from "../time.js";
import { extendCoverage, type Range } from "./plan.js";
import { readSeries, writeBars } from "./store.js";

// Index daily series from NSE's index file (ind_close_all, stored in
// index_closes): NIFTY, NIFTY 500, the sector indices… get daily candles back
// to early 2012 with no broker calls, and move forward each evening like stock
// series do from the cash bhavcopy.
//
// A series' coverage is the unbroken run of sessions ending at its newest
// stored day: walking back, every weekday must be a stored file with a row for
// the index, or a known holiday. Days NSE's file has no row for it (before the
// index launched, or under a name the hub doesn't know) end the run. Broker
// coverage of the same series (NIFTY, BANKNIFTY…) is kept and joined when the
// two touch. NSE's figures replace the broker's bars on the same days (they
// are the official closes; the broker's agree).

/**
 * Earliest day of the unbroken run ending at `newest`: walking back, a weekday
 * must be `ok` with `has(day)`, or a holiday; a weekend day counts only when it
 * was a session (`ok` with `has`). Pure.
 */
export function runStart(newest: number, statuses: ReadonlyMap<number, DayStatus>, has: (day: number) => boolean, floor: number): number {
  let start = newest;
  for (let day = newest - DAY_MS; day >= floor; day -= DAY_MS) {
    const status = statuses.get(day);
    if (status === "ok" && has(day)) start = day;
    else if (!isWeekday(day)) continue;
    else if (status !== "holiday") break;
  }
  return start;
}

export interface IndexSyncResult {
  /** Symbols whose candles were written. */
  symbols: number;
  bars: number;
}

/**
 * Write NSE's index rows from `from` on into the daily candles of every index
 * the hub serves, and set each series' coverage. `from` omitted rewrites
 * everything (after a history download, or when an alias was added).
 */
export function syncIndexSeries(db: Db, now: number, from?: number): IndexSyncResult {
  if (from === undefined) remapIndexNames(db);
  const statuses = checkedDays(db, "index_close");
  const floor = Math.min(...statuses.keys());
  const result: IndexSyncResult = { symbols: 0, bars: 0 };
  for (const { symbol } of NSE_INDICES) {
    const all = readIndexCloses(db, symbol);
    if (!all.length) continue;
    const days = new Set(all.map((row) => row.day));
    const newest = all[all.length - 1].day;
    const archive: Range = { from: runStart(newest, statuses, (day) => days.has(day), floor), to: newest + DAY_MS };
    const rows = from === undefined ? all : all.filter((row) => row.day >= from);
    const bars = rows.map((row) => {
      const o = row.o ?? row.c;
      return { t: row.day, o, h: Math.max(row.h ?? row.c, o, row.c), l: Math.min(row.l ?? row.c, o, row.c), c: row.c, v: row.volume ?? 0 };
    });
    const meta = readSeries(db, symbol, "1d");
    writeBars(db, symbol, "1d", bars, extendCoverage(meta?.coverage ?? null, archive), meta?.syncedAt ?? now);
    result.symbols += 1;
    result.bars += bars.length;
  }
  return result;
}
