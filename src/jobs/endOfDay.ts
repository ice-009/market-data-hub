import type { Db } from "../db.js";
import { DAY_MS, isoDay, parseIsoDay } from "../time.js";
import { enqueueJob, type Job, type NseHistoryParams } from "./backfill.js";
import { historyDays, lastHistoryDay } from "./nseHistory.js";

/** What daily candles and F&O history need (the PR zip's past results dates aren't). */
// The index file gives NIFTY and the sector indices (the market regime) without a broker.
const EOD_DATASETS: NseHistoryParams["datasets"] = ["cash_bhav", "fo_bhav", "index_close"];

// End-of-day mode (no broker configured) has only NSE's files to build daily
// candles from, and the evening job keeps just the last couple of weeks. So
// the server queues an NSE history job (src/jobs/nseHistory.ts) for the last
// HUB_EOD_HISTORY_YEARS years on start: a fresh install has a year or two of
// daily bars for every stock within half an hour or so (one file per 1.1 s,
// paused in market hours), with no command to run.
//
// Idempotent: nothing is queued while an NSE history job is open, or when every
// day of the window has already been asked for (each day asked is recorded,
// holidays included), so a restart costs nothing once the window is filled.

/** Queue the end-of-day history download if any day of the window is still unasked. Returns the job, or null. */
export function queueEndOfDayHistory(db: Db, years: number, now = Date.now()): Job | null {
  if (years <= 0) return null;
  if (db.prepare("select 1 from jobs where kind = 'nse_history' and state in ('queued', 'paused', 'running') limit 1").get()) return null;
  const to = lastHistoryDay(now);
  const from = to - Math.round(years * 365.25) * DAY_MS;
  const params: NseHistoryParams = { from: isoDay(from), to: isoDay(to), datasets: [...EOD_DATASETS] };
  const pending = EOD_DATASETS.some((dataset) => historyDays(db, dataset, parseIsoDay(params.from)!, to).length > 0);
  return pending ? enqueueJob(db, "nse_history", params, now) : null;
}
