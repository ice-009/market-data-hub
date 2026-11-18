import type { Db } from "../db.js";
import { shortOfSpace } from "../disk.js";
import { ARCHIVE_FROM, daysToCheck, syncDays, type DayOutcome, type NseContext } from "../nse/datasets.js";
import { checkedDays, type DayDataset } from "../nse/store.js";
import { DAY_MS, isMarketOpen, isWeekday, isoDay, istParts, parseIsoDay } from "../time.js";
import { getJob, resumeTime, updateJob, type Job, type NseHistoryParams } from "./backfill.js";

// NSE history (`hub data nse-history`): NSE's archive files for every session
// in a range — the cash bhavcopy back to the first session (3 Nov 1994), with
// delivery % from 2002, and the F&O bhavcopy back to the first stock futures
// (9 Nov 2001) — into the tables the evening run fills (cash_bhav,
// fo_futures). That's the raw record of every stock NSE listed, delisted ones
// included: prices as traded, not adjusted for splits or bonuses. No broker calls.
//
// Like backfills, these jobs live in the `jobs` table and:
//   - are resumable: every day asked for is recorded in nse_days, so a paused
//     or interrupted job only asks NSE for days it hasn't seen;
//   - pause in market hours, for a quarter of an hour after NSE refuses
//     several days in a row, and while free disk is under HUB_DISK_MIN_GB
//     (checked before every file; they don't start below it); the server
//     resumes them afterwards.
// Years go newest first (each year oldest first), so recent history lands
// first. In the cash market every weekend day is asked for too — NSE has held
// Budget-day and Muhurat sessions on weekends, and a missing session would make
// the next day's PREVCLOSE look like a corporate action. F&O is then asked for
// the weekend days the cash market traded. The whole archive is ~24,000
// requests at NSE's pace of one per 1.1 s: seven to eight hours.

export const HISTORY_DATASETS: readonly DayDataset[] = ["cash_bhav", "fo_bhav"];

/** A message for invalid parameters, or null. `today` is the IST day key (the evening run owns it). */
export function validateNseHistory(params: NseHistoryParams, today: number): string | null {
  const from = parseIsoDay(params.from);
  const to = parseIsoDay(params.to);
  if (from === null || to === null) return "--from and --to must be dates like 1994-11-03.";
  if (from > to) return "--from must be on or before --to.";
  if (to >= today) return "--to must be before today (the evening run fetches today's files).";
  if (!params.datasets.length || params.datasets.some((dataset) => !HISTORY_DATASETS.includes(dataset))) return "--only must be cash or fo.";
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

const LABEL: Record<DayDataset, string> = { cash_bhav: "cash", fo_bhav: "F&O" };
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const tally = (counts: Record<"ok" | "holiday" | "mismatch", number>) =>
  `${plural(counts.ok, "session", "sessions")} stored, ${plural(counts.holiday, "day", "days")} without a file${counts.mismatch ? `, ${plural(counts.mismatch, "file", "files")} for another date` : ""}`;

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
  const total = datasets.reduce((sum, dataset) => sum + historyDays(ctx.db, dataset, from, to).length, 0);
  let done = 0;
  let failed = 0;
  const counts: Record<"ok" | "holiday" | "mismatch", number> = { ok: 0, holiday: 0, mismatch: 0 };
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

  outer: for (let year = new Date(to).getUTCFullYear(); year >= new Date(from).getUTCFullYear(); year -= 1) {
    for (const dataset of datasets) {
      const days = historyDays(ctx.db, dataset, Math.max(from, Date.UTC(year, 0, 1)), Math.min(to, Date.UTC(year, 11, 31)));
      if (!days.length) continue;
      const onDay = (day: number, outcome: DayOutcome | "failed") => {
        done += 1;
        if (outcome === "failed") failed += 1;
        else if (outcome !== "not_yet") counts[outcome] += 1;
        updateJob(ctx.db, id, { done, failed, message: `${LABEL[dataset]} ${isoDay(day)}: ${tally(counts)}${failed ? `, ${failed} failed` : ""}…` }, ctx.clock());
        onProgress?.(getJob(ctx.db, id)!);
      };
      const result = await syncDays(ctx, dataset, days, shouldStop, onDay, { record: false, extend: false });
      if (halt) break outer;
      if (result.stopped) {
        refused = result.stopped;
        break outer;
      }
    }
  }

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
