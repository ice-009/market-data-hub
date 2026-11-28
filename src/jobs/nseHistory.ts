import type { Db } from "../db.js";
import { shortOfSpace } from "../disk.js";
import { rederiveAll } from "../history/adjustments.js";
import { refreshBaskets } from "../history/baskets.js";
import { fillSessionGaps } from "../history/fromBhav.js";
import { syncIndexSeries } from "../history/fromIndices.js";
import { ARCHIVE_FROM, ISIN_FROM, LEGACY_LAST_DAY, WEEKEND_SESSIONS, daysToCheck, syncDays, type DayOutcome, type NseContext } from "../nse/datasets.js";
import { checkedDays, corporateActionDaysRead, isinDaysRead, type DayDataset } from "../nse/store.js";
import { importOptions, optionDays } from "../nse/optionImport.js";
import { isMarketOpen } from "../calendar/calendar.js";
import { syncCalendar } from "../calendar/store.js";
import { DAY_MS, isWeekday, isoDay, istParts, parseIsoDay } from "../time.js";
import { getJob, resumeTime, updateJob, type HistoryDataset, type Job, type NseHistoryParams } from "./backfill.js";

// NSE history (`hub data nse-history`): NSE's archive files for every session
// in a range — the cash bhavcopy back to the first session (3 Nov 1994), with
// delivery % from 2002, the F&O bhavcopy back to the first stock futures
// (9 Nov 2001) and the PR zip's board meetings (results dates) back to 2010 —
// into the tables the evening run fills (cash_bhav, fo_futures,
// results_events). That's the raw record of every stock NSE listed, delisted
// ones included: prices as traded, not adjusted for splits or bonuses. No broker calls.
//
// Like backfills, these jobs live in the `jobs` table and:
//   - are resumable: every day asked for is recorded in nse_days, so a paused
//     or interrupted job only asks NSE for days it hasn't seen (and days the
//     calendar lists as exchange holidays are recorded without asking);
//   - pause in market hours, for a quarter of an hour after NSE refuses
//     several days in a row, and while free disk is under HUB_DISK_MIN_GB
//     (checked before every file; they don't start below it); the server
//     resumes them afterwards.
// Years go newest first (each year oldest first), so recent history lands
// first. In the cash market every weekend day is asked for too — NSE has held
// Budget-day and Muhurat sessions on weekends, and a missing session would make
// the next day's PREVCLOSE look like a corporate action. F&O, the PR zip and
// NSE's index file (every index's OHLC, from Feb 2012, which becomes index
// candles back to 2012) are then asked for the weekend days the cash market
// traded. When a run stops, the index candles and the synthetic baskets
// (src/history/baskets.ts) are rebuilt from what is stored. The whole archive
// is ~32,000 requests at NSE's pace of one per 1.1 s: nine to ten hours.
//
// Old-format cash files carry ISINs from 2011, which join renamed tickers
// (src/reference/renames.ts). A day downloaded here records them as it's
// stored; stored days whose ISINs weren't read (downloaded before the hub kept
// them) have just their cash file read again, once — about 3,400 requests
// for 2011 to 5 Jul 2024. Likewise the PR zip's corporate-actions file: stored
// PR days whose bc file wasn't read (downloaded before the hub kept it) have
// their zip read again, once — about 4,200 requests for 2010 on. When a run
// stops, every split and bonus factor is derived again from what is stored
// (src/history/adjustments.ts).
//
// Option summaries (market-data-hub#30, src/nse/optionImport.ts): an F&O day
// downloaded here stores them with its futures. Stored F&O days whose options
// weren't read (downloaded before the hub kept them), and the options-only
// months from 4 Jun 2001, have their F&O file read again, once — the
// "options" dataset, after each year's F&O files: about 6,300 requests for
// 2001 → 2026 (~2 hours).

export const HISTORY_DATASETS: readonly HistoryDataset[] = ["cash_bhav", "fo_bhav", "pr", "index_close", "options"];

/** A message for invalid parameters, or null. `today` is the IST day key (the evening run owns it). */
export function validateNseHistory(params: NseHistoryParams, today: number): string | null {
  const from = parseIsoDay(params.from);
  const to = parseIsoDay(params.to);
  if (from === null || to === null) return "--from and --to must be dates like 1994-11-03.";
  if (from > to) return "--from must be on or before --to.";
  if (to >= today) return "--to must be before today (the evening run fetches today's files).";
  if (!params.datasets.length || params.datasets.some((dataset) => !HISTORY_DATASETS.includes(dataset))) return "--only must be cash, fo, pr, indices or options.";
  return null;
}

/** Days of one dataset still to ask NSE for, from..to (day keys), oldest first. */
export function historyDays(db: Db, dataset: DayDataset, from: number, to: number): number[] {
  const start = Math.max(from, ARCHIVE_FROM[dataset]);
  if (start > to) return [];
  const checked = checkedDays(db, dataset, start);
  const ask = { today: to, minutes: 24 * 60, from: start, publishMin: 0, checked };
  if (dataset === "cash_bhav") return daysToCheck({ ...ask, weekends: true }).reverse();
  const weekendSessions = [...checkedDays(db, "cash_bhav", start)].filter(([day, status]) => status === "ok" && day <= to && !isWeekday(day) && !checked.has(day)).map(([day]) => day);
  return [...new Set([...daysToCheck(ask), ...weekendSessions])].sort((a, b) => a - b);
}

/** Stored old-format cash days from..to whose ISINs haven't been read, oldest first. */
export function isinDays(db: Db, from: number, to: number): number[] {
  const start = Math.max(from, ISIN_FROM);
  const end = Math.min(to, LEGACY_LAST_DAY);
  if (start > end) return [];
  const read = isinDaysRead(db, start);
  return [...checkedDays(db, "cash_bhav", start)]
    .filter(([day, status]) => status === "ok" && day <= end && !read.has(day))
    .map(([day]) => day)
    .sort((a, b) => a - b);
}

/** Stored PR days from..to whose corporate-actions file hasn't been read, oldest first. */
export function corporateActionDays(db: Db, from: number, to: number): number[] {
  const read = corporateActionDaysRead(db, from);
  return [...checkedDays(db, "pr", from)]
    .filter(([day, status]) => status === "ok" && day <= to && !read.has(day))
    .map(([day]) => day)
    .sort((a, b) => a - b);
}

export const HISTORY_LABEL: Record<HistoryDataset, string> = { cash_bhav: "cash", fo_bhav: "F&O", pr: "PR", index_close: "indices", options: "options" };
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
type Tally = Record<"ok" | "holiday" | "mismatch" | "isins" | "actions" | "options", number>;
const tally = (counts: Tally) =>
  `${plural(counts.ok, "session", "sessions")} stored, ${plural(counts.holiday, "day", "days")} without a file${counts.mismatch ? `, ${plural(counts.mismatch, "file", "files")} for another date` : ""}${counts.isins ? `, ISINs read for ${plural(counts.isins, "stored day", "stored days")}` : ""}${counts.actions ? `, corporate actions read for ${plural(counts.actions, "stored day", "stored days")}` : ""}${counts.options ? `, options read for ${plural(counts.options, "day", "days")}` : ""}`;

/**
 * Run one NSE history job to its end, a pause, or a cancel. Returns the job's
 * final state. `onProgress` is called after each day (the CLI prints it).
 */
export async function runNseHistory(ctx: NseContext, id: number, onProgress?: (job: Job) => void): Promise<Job> {
  const job = getJob(ctx.db, id);
  if (!job || job.kind !== "nse_history") throw new Error(`No NSE history job ${id}.`);
  const from = parseIsoDay(job.params.from)!;
  const to = parseIsoDay(job.params.to)!;
  const datasets = job.params.datasets;
  const now = ctx.clock();

  const lowDisk = (reason: string, after?: string) => `Paused${after ? ` after ${after}` : ""}: ${reason}. Free some space; the hub server retries every 30 minutes (or run the command again).`;
  const short = ctx.disk ? shortOfSpace(ctx.disk) : null;
  if (short) {
    updateJob(ctx.db, id, { state: "paused", resumeAfter: resumeTime("disk", now), message: lowDisk(short.message) }, now);
    const paused = getJob(ctx.db, id)!;
    onProgress?.(paused);
    ctx.log.warn("NSE history job not started: low disk space", { id, freeBytes: short.free, needBytes: short.need });
    return paused;
  }

  // F&O weekend sessions are found as the cash market's years are fetched, so they aren't in the starting count.
  const isins = datasets.includes("cash_bhav");
  const actions = datasets.includes("pr");
  const days = (dataset: HistoryDataset, dayFrom: number, dayTo: number) => (dataset === "options" ? optionDays(ctx.db, dayFrom, dayTo) : historyDays(ctx.db, dataset, dayFrom, dayTo));
  const total = datasets.reduce((sum, dataset) => sum + days(dataset, from, to).length, 0) + (isins ? isinDays(ctx.db, from, to).length : 0) + (actions ? corporateActionDays(ctx.db, from, to).length : 0);
  let done = 0;
  let failed = 0;
  const counts: Tally = { ok: 0, holiday: 0, mismatch: 0, isins: 0, actions: 0, options: 0 };
  updateJob(ctx.db, id, { state: "running", total, done: 0, failed: 0, startedAt: job.startedAt ?? now, resumeAfter: null, message: total ? `Asking NSE for ${total} days…` : "Everything is already stored." }, now);
  onProgress?.(getJob(ctx.db, id)!);

  let halt: "market" | "cancelled" | "disk" | null = null;
  let diskReason = "";
  const shouldStop = () => {
    if (getJob(ctx.db, id)?.state === "cancelled") halt = "cancelled";
    else if (isMarketOpen(ctx.clock())) halt = "market";
    else {
      const low = ctx.disk ? shortOfSpace(ctx.disk) : null;
      if (low) {
        halt = "disk";
        diskReason = low.message;
      }
    }
    return halt !== null;
  };
  let refused: string | null = null;

  const onDay = (label: string, only: "isins" | "actions" | "options" | null) => (day: number, outcome: DayOutcome | "failed") => {
    done += 1;
    if (outcome === "failed") failed += 1;
    else if (only) counts[only] += outcome === "ok" ? 1 : 0;
    else if (outcome !== "not_yet") counts[outcome] += 1;
    updateJob(ctx.db, id, { done, failed, message: `${label} ${isoDay(day)}: ${tally(counts)}${failed ? `, ${failed} failed` : ""}…` }, ctx.clock());
    onProgress?.(getJob(ctx.db, id)!);
  };

  outer: for (let year = new Date(to).getUTCFullYear(); year >= new Date(from).getUTCFullYear(); year -= 1) {
    const yearFrom = Math.max(from, Date.UTC(year, 0, 1));
    const yearTo = Math.min(to, Date.UTC(year, 11, 31));
    for (const dataset of datasets) {
      if (dataset === "options") {
        // Stored F&O days whose options weren't read yet (those just downloaded were).
        const optionPass = optionDays(ctx.db, yearFrom, yearTo);
        if (!optionPass.length) continue;
        const result = await syncDays(ctx, "fo_bhav", optionPass, shouldStop, onDay("Options", "options"), { record: false, importer: importOptions });
        if (halt) break outer;
        if (result.stopped) {
          refused = result.stopped;
          break outer;
        }
        continue;
      }
      const passes: Array<{ label: string; only: "isins" | "actions" | null; days: () => number[] }> = [{ label: HISTORY_LABEL[dataset], only: null, days: () => historyDays(ctx.db, dataset, yearFrom, yearTo) }];
      // After the year's cash files: stored days whose ISINs weren't read yet (those just downloaded were).
      if (dataset === "cash_bhav") passes.push({ label: "ISINs", only: "isins", days: () => isinDays(ctx.db, yearFrom, yearTo) });
      // After the year's PR zips: stored days whose corporate actions weren't read yet.
      if (dataset === "pr") passes.push({ label: "Corporate actions", only: "actions", days: () => corporateActionDays(ctx.db, yearFrom, yearTo) });
      for (const pass of passes) {
        const days = pass.days();
        if (!days.length) continue;
        const result = await syncDays(ctx, dataset, days, shouldStop, onDay(pass.label, pass.only), { record: false, extend: false, isinsOnly: pass.only === "isins", actionsOnly: pass.only === "actions" });
        if (halt) break outer;
        if (result.stopped) {
          refused = result.stopped;
          break outer;
        }
      }
    }
  }

  if (datasets.includes("cash_bhav")) {
    try {
      // Weekend sessions the stored daily series skipped (cheap: a few queries per listed session).
      fillSessionGaps(ctx.db, WEEKEND_SESSIONS, ctx.log);
    } catch (error) {
      ctx.log.error("filling weekend-session bars after NSE history failed", { error });
    }
  }
  if (counts.ok) {
    try {
      if (datasets.includes("index_close")) syncIndexSeries(ctx.db, ctx.clock());
      if (datasets.includes("cash_bhav")) refreshBaskets(ctx.db, ctx.clock());
    } catch (error) {
      ctx.log.error("rebuilding index candles or baskets after NSE history failed", { error });
    }
  }
  if (counts.ok || counts.holiday || counts.actions) {
    try {
      const derived = rederiveAll(ctx.db, { endOfDay: ctx.endOfDay ?? false, now: ctx.clock() });
      ctx.log.info("split and bonus factors derived again", { factors: derived.factors, ...derived.bySource, changed: derived.changed.length, seriesDropped: derived.reset.length });
    } catch (error) {
      ctx.log.error("deriving split and bonus factors after NSE history failed", { error });
    }
  }

  // Days just downloaded may confirm holidays and sessions.
  syncCalendar(ctx.db);
  const end = ctx.clock();
  const summary = tally(counts);
  // `halt` is assigned inside shouldStop, which TypeScript's narrowing can't see.
  const stoppedFor = halt as "market" | "cancelled" | "disk" | null;
  if (stoppedFor === "cancelled") {
    // leave as cancelled
  } else if (stoppedFor === "disk") updateJob(ctx.db, id, { state: "paused", done, failed, message: lowDisk(diskReason, summary), resumeAfter: resumeTime("disk", end) }, end);
  else if (stoppedFor === "market") updateJob(ctx.db, id, { state: "paused", done, failed, message: `Paused for market hours (09:15–15:30 IST) after ${summary}; resumes after the close.`, resumeAfter: resumeTime("market", end) }, end);
  else if (refused) updateJob(ctx.db, id, { state: "paused", done, failed, message: `Paused: ${refused}`, resumeAfter: resumeTime("failures", end) }, end);
  else updateJob(ctx.db, id, { state: "done", done, failed, finishedAt: end, message: failed ? `Done — ${summary}; ${failed} day(s) failed: run it again to retry them.` : `Done — ${summary}.` }, end);
  const final = getJob(ctx.db, id)!;
  onProgress?.(final);
  ctx.log.info("NSE history job finished a run", { id, state: final.state, done, failed, ...counts });
  return final;
}

/** Yesterday in IST: the newest day a history job may ask for. */
export const lastHistoryDay = (now: number) => istParts(now).day - DAY_MS;
