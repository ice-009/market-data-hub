import { BrokerError } from "../broker/errors.js";
import type { Bar, HistoryResult, Resolution } from "../broker/fyers.js";
import { isFuture, isIndex } from "../broker/symbols.js";
import type { Db } from "../db.js";
import { WEEKEND_SESSIONS } from "../nse/datasets.js";
import { dayStatuses, lastOkDay } from "../nse/store.js";
import { DAY_MS, isWeekday } from "../time.js";
import { SPLIT_TOLERANCE } from "./fromBhav.js";
import type { HistoryBroker } from "./service.js";

// End-of-day mode (no broker configured): daily candles for stocks come from
// NSE's cash bhavcopies the hub has stored — the evening files plus whatever
// `hub data nse-history` downloaded from the archive. This stands in for the
// broker behind HistoryService, so the store, coverage, resampling (1w), the
// batch endpoint and the evening bhavcopy extension all work unchanged.
//
// Coverage is honest: a result claims only the stretch of days, ending at the
// newest stored session, in which every trading day was checked (stored, or a
// known holiday). Older days the archive doesn't hold yet are left uncovered,
// so a later nse-history run fills them on the next request.
//
// Prices are adjusted for splits and bonuses the way NSE itself does it: on an
// ex-date the file's PREV_CLOSE is already adjusted, so
// prev_close(d) / close(d−1) is the factor for every bar before d (volumes get
// the inverse). It's the same signal src/history/fromBhav.ts uses to notice a
// corporate action; a new ex-date makes that code drop the stored series and
// the next request rebuilds it here, adjusted again. (Store and serve raw and
// adjusted prices separately: market-data-hub#20.)
//
// Indices and futures contracts aren't in the cash file, and intraday bars
// don't exist in end-of-day data: those answer `not_configured`.

export const EOD_INTRADAY_MESSAGE = "Intraday candles need a broker: this hub has none configured and serves NSE end-of-day data only.";
export const EOD_INDEX_MESSAGE = "Index candles need a broker: NSE's end-of-day files this hub reads have stock prices only.";
export const EOD_FUTURE_MESSAGE = "Futures-contract candles need a broker: this hub has none configured and serves NSE end-of-day data only.";

interface CashRow {
  day: number;
  prev_close: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

const isSessionDay = (day: number) => isWeekday(day) || WEEKEND_SESSIONS.includes(day);
const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * Daily bars of one stock from the stored cash bhavcopies, fromDay..toDay
 * (day keys), adjusted for splits and bonuses. Throws BrokerError: `bad_symbol`
 * for a ticker no stored file has ever listed, `upstream` before any file is stored.
 */
export function archiveDaily(db: Db, symbol: string, fromDay: number, toDay: number): HistoryResult & { coveredToDay: number } {
  const newest = lastOkDay(db, "cash_bhav", toDay + 1);
  if (newest === null) {
    if (lastOkDay(db, "cash_bhav") === null) throw new BrokerError("No NSE end-of-day files are stored yet; the hub downloads them on start and every evening.", "upstream");
    // Everything stored is newer than the request: nothing to serve, nothing to claim.
    return { bars: [], coveredFromDay: toDay + DAY_MS, coveredToDay: toDay, complete: true };
  }
  if (!db.prepare("select 1 from cash_bhav where symbol = ? limit 1").get(symbol)) throw new BrokerError(`${symbol} isn't in any NSE cash bhavcopy the hub has stored.`, "bad_symbol");

  // The checked stretch around the newest stored session: stop at the first
  // trading day either side that is neither stored nor a known holiday.
  const statuses = dayStatuses(db, "cash_bhav", Math.min(fromDay, newest));
  const checked = (day: number) => !isSessionDay(day) || statuses.get(day) === "ok" || statuses.get(day) === "holiday";
  let coveredFrom = newest;
  for (let day = newest - DAY_MS; day >= fromDay && checked(day); day -= DAY_MS) coveredFrom = day;
  let coveredTo = newest;
  for (let day = newest + DAY_MS; day <= toDay && checked(day) && statuses.get(day) !== "ok"; day += DAY_MS) coveredTo = day;
  // Rows after toDay are read too: their ex-dates adjust the bars served.
  const rows = db.prepare("select day, prev_close, o, h, l, c, v from cash_bhav where symbol = ? and day >= ? order by day").all(symbol, coveredFrom) as CashRow[];

  // Walk newest → oldest, carrying the product of the factors of the ex-dates passed.
  const bars: Bar[] = [];
  let factor = 1;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row.day <= toDay && row.c > 0) {
      bars.push({ t: row.day, o: round2(row.o * factor), h: round2(row.h * factor), l: round2(row.l * factor), c: round2(row.c * factor), v: Math.round(row.v / factor) });
    }
    const previous = rows[index - 1];
    if (previous && previous.c > 0 && row.prev_close > 0) {
      const ratio = row.prev_close / previous.c;
      if (Math.abs(ratio - 1) > SPLIT_TOLERANCE) factor *= ratio;
    }
  }
  bars.reverse();
  return { bars, coveredFromDay: coveredFrom, coveredToDay: coveredTo, complete: true };
}

/** The HistoryBroker the hub uses when no broker is configured. */
export class ArchiveHistory implements HistoryBroker {
  constructor(private readonly db: Db) {}

  async history(symbol: string, resolution: Resolution, fromDay: number, toDay: number): Promise<HistoryResult> {
    if (resolution !== "D") throw new BrokerError(EOD_INTRADAY_MESSAGE, "not_configured");
    if (isIndex(symbol)) throw new BrokerError(EOD_INDEX_MESSAGE, "not_configured");
    if (isFuture(symbol)) throw new BrokerError(EOD_FUTURE_MESSAGE, "not_configured");
    return archiveDaily(this.db, symbol, fromDay, toDay);
  }
}
