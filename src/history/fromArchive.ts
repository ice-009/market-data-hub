import { BrokerError } from "../broker/errors.js";
import type { Bar, HistoryResult, Resolution } from "../broker/fyers.js";
import { isFuture, isIndex } from "../broker/symbols.js";
import type { Db } from "../db.js";
import { dayStatuses, lastOkDay, type DayStatus } from "../nse/store.js";
import { listingOf, loadRenames, namesBetween, type Renames } from "../reference/renames.js";
import { DAY_MS } from "../time.js";
import { cumulative, isSessionDay, readListingFactors } from "./adjustments.js";
import type { HistoryBroker } from "./service.js";

// Daily candles for stocks from NSE's cash bhavcopies the hub has stored — the
// evening files plus whatever `hub data nse-history` downloaded from the
// archive (back to Nov 1994). Two users:
//   - end-of-day mode (no broker configured): this stands in for the broker
//     behind HistoryService, so the store, coverage, resampling (1w), the batch
//     endpoint and the evening bhavcopy extension all work unchanged;
//   - /v1/candles before the broker's window, in either mode (#22,
//     src/history/longDaily.ts), and `adjust=none` (as traded).
//
// Coverage is honest: a result claims only the stretch of days, ending at the
// newest stored session, in which every trading day was checked (stored, or a
// known holiday). Older days the archive doesn't hold yet are left uncovered,
// so a later nse-history run fills them on the next request.
//
// Renamed tickers are joined (src/reference/renames.ts): the listing is read
// name by name over the days each name was in use, so INFY's history includes
// INFOSYSTCH's before June 2011 — point in time: INFOSYSTCH asked for 2005 is
// the 2005 ticker, and a ticker that later passed to another company is read
// only for its own listing's days.
//
// Prices are adjusted for splits and bonuses with the factors in
// adjustment_factors (src/history/adjustments.ts: NSE's PREV_CLOSE where NSE
// adjusted it, the PR zip's corporate actions, or a standard-ratio price gap):
// each bar × the product of the factors with a later ex-date, volumes ÷ it —
// the listing's factors, so they follow the company across renames. Raw prices
// stay in cash_bhav (served with /v1/candles?adjust=none). A new ex-date makes
// src/history/fromBhav.ts drop the stored series, and the next request rebuilds
// it here, adjusted again.
//
// Indices and futures contracts aren't in the cash file, and intraday bars
// don't exist in end-of-day data: those answer `not_configured`.

export const EOD_INTRADAY_MESSAGE = "Intraday candles need a broker: this hub has none configured and serves NSE end-of-day data only.";
export const EOD_INDEX_MESSAGE = "Index candles beyond NSE's index file (stored daily from Feb 2012) need a broker.";
export const EOD_FUTURE_MESSAGE = "Futures-contract candles need a broker: this hub has none configured and serves NSE end-of-day data only.";

export interface CashRow {
  day: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * What an archive read needs from the store besides the rows, loaded once and
 * shared by every symbol of a request (the batch endpoint reads up to 300):
 * the cash days' statuses and the known renames.
 */
export interface ArchiveContext {
  statuses: ReadonlyMap<number, DayStatus>;
  renames: Renames;
}

export function archiveContext(db: Db, from = Number.MIN_SAFE_INTEGER): ArchiveContext {
  return { statuses: dayStatuses(db, "cash_bhav", from), renames: loadRenames(db) };
}

export interface ArchiveDaily extends HistoryResult {
  coveredToDay: number;
  /** The tickers the bars were read under, oldest first, each with its first and last bar (day keys). */
  names: Array<{ symbol: string; from: number; to: number }>;
  /** Delivery % by day (null: not in the file). */
  dp: Map<number, number | null>;
}

/**
 * Daily bars of one stock (its listing, names joined) from the stored cash
 * bhavcopies, fromDay..toDay (day keys), adjusted for splits and bonuses
 * (`adjusted: false`: as traded). The listing is the one that had `symbol` on
 * `listingDay` (default: the newest stored session up to `toDay`; when none
 * did, the one that took the ticker later or last had it). `context` must
 * cover `fromDay` when given.
 * Throws BrokerError: `bad_symbol` for a ticker no stored file has ever listed
 * (under any of its listing's names), `upstream` before any file is stored.
 */
export function archiveDaily(db: Db, symbol: string, fromDay: number, toDay: number, options: { adjusted?: boolean; context?: ArchiveContext; listingDay?: number } = {}): ArchiveDaily {
  const newest = lastOkDay(db, "cash_bhav", toDay + 1);
  if (newest === null) {
    if (lastOkDay(db, "cash_bhav") === null) throw new BrokerError("No NSE end-of-day files are stored yet; the hub downloads them on start and every evening.", "upstream");
    // Everything stored is newer than the request: nothing to serve, nothing to claim.
    return { bars: [], coveredFromDay: toDay + DAY_MS, coveredToDay: toDay, complete: true, names: [], dp: new Map() };
  }
  const context = options.context ?? archiveContext(db, Math.min(fromDay, newest));
  const listing = listingOf(db, symbol, options.listingDay ?? newest, context.renames);
  const listed = db.prepare("select 1 from cash_bhav where symbol = ? limit 1");
  if (!listing.names.some((name) => listed.get(name.symbol))) throw new BrokerError(`${symbol} isn't in any NSE cash bhavcopy the hub has stored.`, "bad_symbol");

  // The checked stretch around the newest stored session: stop at the first
  // trading day either side that is neither stored nor a known holiday.
  const { statuses } = context;
  const checked = (day: number) => !isSessionDay(day) || statuses.get(day) === "ok" || statuses.get(day) === "holiday";
  let coveredFrom = newest;
  for (let day = newest - DAY_MS; day >= fromDay && checked(day); day -= DAY_MS) coveredFrom = day;
  let coveredTo = newest;
  for (let day = newest + DAY_MS; day <= toDay && checked(day) && statuses.get(day) !== "ok"; day += DAY_MS) coveredTo = day;

  const read = db.prepare("select day, o, h, l, c, v, deliv_pct from cash_bhav where symbol = ? and day between ? and ? order by day");
  const rows: Array<CashRow & { deliv_pct: number | null }> = [];
  const names: ArchiveDaily["names"] = [];
  for (const name of namesBetween(listing, coveredFrom, toDay)) {
    const part = read.all(name.symbol, name.from, name.to) as Array<CashRow & { deliv_pct: number | null }>;
    if (!part.length) continue;
    rows.push(...part);
    names.push({ symbol: name.symbol, from: part[0].day, to: part[part.length - 1].day });
  }
  const factorAt = options.adjusted === false ? () => 1 : cumulative(readListingFactors(db, listing));
  return { bars: adjustRows(rows, factorAt), coveredFromDay: coveredFrom, coveredToDay: coveredTo, complete: true, names, dp: new Map(rows.map((row) => [row.day, row.deliv_pct])) };
}

/** Raw rows → bars, each × factorAt(its day) (volumes ÷). Pure. */
export function adjustRows(rows: readonly CashRow[], factorAt: (day: number) => number): Bar[] {
  const bars: Bar[] = [];
  for (const row of rows) {
    if (!(row.c > 0)) continue;
    const factor = factorAt(row.day);
    bars.push(factor === 1 ? { t: row.day, o: row.o, h: row.h, l: row.l, c: row.c, v: row.v } : { t: row.day, o: round2(row.o * factor), h: round2(row.h * factor), l: round2(row.l * factor), c: round2(row.c * factor), v: Math.round(row.v / factor) });
  }
  return bars;
}

/** The HistoryBroker the hub uses when no broker is configured. */
export class ArchiveHistory implements HistoryBroker {
  constructor(private readonly db: Db) {}

  async history(symbol: string, resolution: Resolution, fromDay: number, toDay: number): Promise<HistoryResult> {
    if (resolution !== "D") throw new BrokerError(EOD_INTRADAY_MESSAGE, "not_configured");
    if (isIndex(symbol)) throw new BrokerError(EOD_INDEX_MESSAGE, "not_configured");
    if (isFuture(symbol)) throw new BrokerError(EOD_FUTURE_MESSAGE, "not_configured");
    const { bars, coveredFromDay, coveredToDay, complete } = archiveDaily(this.db, symbol, fromDay, toDay);
    return { bars, coveredFromDay, coveredToDay, complete };
  }
}
