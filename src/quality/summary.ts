import type { Db } from "../db.js";
import { DAY_MS, isoDay, istParts } from "../time.js";
import { readQualityState } from "./run.js";
import { CHECKS, countOpenFindings, readFindings, type Severity, type StoredFinding } from "./store.js";

// How the data-quality findings are served: GET /v1/quality lists them, and
// /v1/status (`quality`) sums them up with the last month's open ones, which is
// what a client's health page and alerts need.

/** /v1/status lists open findings about trade days this recent. */
export const RECENT_FINDING_DAYS = 30;
/** …at most this many. */
export const RECENT_FINDING_LIMIT = 50;
/** Open problems about the last two weeks' data are a warning in the hub's health. */
export const HEALTH_FINDING_DAYS = 14;

/** What each check looks for, for people reading /v1/quality. */
export const CHECK_HELP: Record<(typeof CHECKS)[number], string> = {
  missing_session: "A session (another NSE file of that day is stored) whose file NSE answered with 404 or with another day's file (info for a known gap in NSE's archive).",
  unlisted_session: "A weekend session the hub's calendar (reference/holidays, `hub data calendar`) doesn't list, so the evening run won't ask for its files.",
  calendar_mismatch: "NSE's archive disagrees with the holiday list: files for a day the list calls a holiday, or no files (404) for a weekday of a listed year that the list doesn't name.",
  wrong_date: "NSE served another day's file for a weekday, and nothing confirms the day was a holiday.",
  repeated_file: "A cash bhavcopy whose prices repeat the previous session's: the previous file under a new date.",
  candle_gap: "Stored daily candles lack a session the stock traded (it has a bhavcopy row).",
  price_outlier: "A close-to-close move over 10× the stock's recent volatility (and over 10%) that no corporate action explains; a warning beyond NSE's 20% price band, info within it.",
  broker_mismatch: "Stored (broker) daily closes that differ from NSE's bhavcopy; info when the difference is a corporate action the broker adjusted its history for.",
  lot_change: "Lot sizes that changed between two F&O sessions.",
  fo_list_change: "Stocks that joined or left the F&O list (a problem when a tenth or more leave at once other than after their last expiry: a cut-off file).",
  lot_file_mismatch: "NSE's lot file (fo_mktlots.csv) disagrees with the newest F&O bhavcopy.",
};

export function findingJson(finding: StoredFinding) {
  return {
    check: finding.check,
    date: isoDay(finding.day),
    day: finding.day,
    subject: finding.subject,
    severity: finding.severity,
    message: finding.message,
    detail: finding.detail ?? null,
    firstSeenAt: finding.firstSeenAt,
    lastSeenAt: finding.lastSeenAt,
    resolvedAt: finding.resolvedAt,
  };
}

/** The `quality` block of /v1/status. */
export function qualitySummary(db: Db, now = Date.now()) {
  const state = readQualityState(db);
  const counts = countOpenFindings(db);
  const open: Record<Severity, number> = { problem: 0, warning: 0, info: 0 };
  for (const row of counts) open[row.severity] += row.count;
  const today = istParts(now).day;
  return {
    lastRunAt: state.lastRunAt ?? null,
    /** Stored days not checked yet, and of those the ones waiting for earlier sessions (an archive download). */
    pendingDays: state.pendingDays ?? 0,
    waitingDays: state.waitingDays ?? 0,
    open,
    checks: counts.map((row) => ({ check: row.check, severity: row.severity, count: row.count, newestDate: isoDay(row.newestDay) })),
    recent: readFindings(db, { from: today - RECENT_FINDING_DAYS * DAY_MS, limit: RECENT_FINDING_LIMIT }).map(findingJson),
  };
}

/** Open problems about the last HEALTH_FINDING_DAYS days' data, worst first (for the hub's health warnings). */
export function recentProblems(db: Db, now = Date.now()): StoredFinding[] {
  return readFindings(db, { severity: "problem", from: istParts(now).day - HEALTH_FINDING_DAYS * DAY_MS, limit: 20 });
}
