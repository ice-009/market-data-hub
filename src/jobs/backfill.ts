import { BrokerError } from "../broker/errors.js";
import type { Db } from "../db.js";
import type { HistoryService } from "../history/service.js";
import { BACKFILL_TFS, BASE, finalBefore, type BaseTf } from "../history/timeframes.js";
import type { Logger } from "../log.js";
import { getUniverse } from "../reference/universe.js";
import { DAY_MS, MINUTE_MS, SESSION_CLOSE_MIN, istDayStart, istParts, isMarketOpen } from "../time.js";

// History backfills (`hub data backfill`): fill the store with N years of a
// base timeframe for a list of symbols (default: the F&O stocks plus the main
// indices), at background priority. Jobs live in the `jobs` table, so:
//   - the CLI can queue one for the running server to pick up (only the
//     process holding the owner lock calls the broker);
//   - they are resumable: a symbol already covered is skipped, so a paused or
//     interrupted job continues where it stopped;
//   - like Tradex's "Download F&O history", a job pauses during market hours
//     (09:15–15:30 IST) and when the day's background budget is spent, and the
//     server resumes it automatically afterwards.
// (Adapted from Tradex's historyPrefetch, MIT.)

export const DEFAULT_INDICES = ["NIFTY", "BANKNIFTY", "FINNIFTY"];
const CONCURRENCY = 2;
const MAX_CONSECUTIVE_FAILURES = 5;

export type JobState = "queued" | "running" | "paused" | "done" | "error" | "cancelled";

export interface BackfillParams {
  tf: BaseTf;
  years: number;
  /** null: the F&O universe plus DEFAULT_INDICES, resolved when the job runs. */
  symbols: string[] | null;
}

export interface Job {
  id: number;
  kind: "backfill";
  params: BackfillParams;
  state: JobState;
  done: number;
  total: number;
  failed: number;
  message: string;
  resumeAfter: number | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  updatedAt: number;
}

interface JobRow {
  id: number;
  kind: "backfill";
  params: string;
  state: JobState;
  done: number;
  total: number;
  failed: number;
  message: string;
  resume_after: number | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  updated_at: number;
}

const toJob = (row: JobRow): Job => ({
  id: row.id,
  kind: row.kind,
  params: JSON.parse(row.params) as BackfillParams,
  state: row.state,
  done: row.done,
  total: row.total,
  failed: row.failed,
  message: row.message,
  resumeAfter: row.resume_after,
  createdAt: row.created_at,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  updatedAt: row.updated_at,
});

/** Largest `years` each timeframe can use (the broker's window). */
export const maxYears = (tf: BaseTf) => Math.max(1, Math.floor(BASE[tf].windowDays / 365) + (BASE[tf].daily ? 1 : 0));

export function validateBackfill(params: BackfillParams): string | null {
  if (!BACKFILL_TFS.includes(params.tf)) return `--tf must be one of ${BACKFILL_TFS.join(", ")}.`;
  if (!Number.isFinite(params.years) || params.years <= 0) return "--years must be a positive number.";
  if (params.years > maxYears(params.tf)) return `The broker serves at most ${maxYears(params.tf)} year(s) of ${params.tf}.`;
  return null;
}

/** Queue a backfill, or return the open (queued/paused/running) job with the same parameters. */
export function enqueueBackfill(db: Db, params: BackfillParams, now = Date.now()): Job {
  const open = (db.prepare("select * from jobs where kind = 'backfill' and state in ('queued', 'paused', 'running') and params = ?").get(JSON.stringify(params)) as JobRow | undefined) ?? null;
  if (open) return toJob(open);
  const id = Number(db.prepare("insert into jobs (kind, params, state, message, created_at, updated_at) values ('backfill', ?, 'queued', 'Queued.', ?, ?)").run(JSON.stringify(params), now, now).lastInsertRowid);
  return getJob(db, id)!;
}

export function getJob(db: Db, id: number): Job | null {
  const row = db.prepare("select * from jobs where id = ?").get(id) as JobRow | undefined;
  return row ? toJob(row) : null;
}

export function listJobs(db: Db, limit = 10): Job[] {
  return (db.prepare("select * from jobs order by id desc limit ?").all(limit) as JobRow[]).map(toJob);
}

/** The next job that may run now: queued, or paused with its resume time passed. */
export function nextRunnableJob(db: Db, now: number): Job | null {
  const row = db.prepare("select * from jobs where state = 'queued' or (state = 'paused' and resume_after is not null and resume_after <= ?) order by id limit 1").get(now) as JobRow | undefined;
  return row ? toJob(row) : null;
}

/** Jobs left "running" by a process that died are queued again (they're resumable). */
export function recoverJobs(db: Db, now = Date.now()) {
  db.prepare("update jobs set state = 'queued', message = 'Interrupted; will resume.', updated_at = ? where state = 'running'").run(now);
}

export function cancelJob(db: Db, id: number, now = Date.now()): boolean {
  return db.prepare("update jobs set state = 'cancelled', message = 'Cancelled.', finished_at = ?, updated_at = ? where id = ? and state in ('queued', 'paused', 'running')").run(now, now, id).changes > 0;
}

function update(db: Db, id: number, fields: Partial<Pick<Job, "state" | "done" | "total" | "failed" | "message" | "resumeAfter" | "startedAt" | "finishedAt">>, now: number) {
  const columns: Record<string, unknown> = { state: fields.state, done: fields.done, total: fields.total, failed: fields.failed, message: fields.message, resume_after: fields.resumeAfter, started_at: fields.startedAt, finished_at: fields.finishedAt };
  const set = Object.entries(columns).filter(([, value]) => value !== undefined);
  db.prepare(`update jobs set ${[...set.map(([key]) => `${key} = ?`), "updated_at = ?"].join(", ")} where id = ?`).run(...set.map(([, value]) => value), now, id);
}

/** When a paused job may continue: after today's close in market hours; after the IST day rolls over when the budget is spent. */
export function resumeTime(reason: "market" | "budget" | "rate_limited" | "auth" | "failures", now: number): number {
  const { day } = istParts(now);
  if (reason === "market") return istDayStart(day) + (SESSION_CLOSE_MIN + 5) * MINUTE_MS;
  if (reason === "budget") return istDayStart(day + DAY_MS) + 5 * MINUTE_MS;
  if (reason === "rate_limited") return now + 2 * MINUTE_MS;
  return now + 15 * MINUTE_MS;
}

export interface BackfillDeps {
  db: Db;
  history: HistoryService;
  log: Logger;
  clock?: () => number;
}

/**
 * Run one job to its end, a pause, or a cancel. Returns the job's final state.
 * `onProgress` is called after each symbol (the CLI prints it).
 */
export async function runBackfill(deps: BackfillDeps, id: number, onProgress?: (job: Job) => void): Promise<Job> {
  const clock = deps.clock ?? Date.now;
  const job = getJob(deps.db, id);
  if (!job) throw new Error(`No job ${id}.`);
  const { tf, years } = job.params;
  const now = clock();
  const symbols = job.params.symbols ?? [...DEFAULT_INDICES, ...getUniverse(deps.db, "fno", now).members.map((member) => member.symbol).filter((symbol) => !DEFAULT_INDICES.includes(symbol))];
  const want = { from: now - years * 365 * DAY_MS, to: finalBefore(tf, now) };
  const todo = symbols.filter((symbol) => !deps.history.isStored(symbol, tf, want));
  let done = symbols.length - todo.length;
  let failed = 0;
  update(deps.db, id, { state: "running", total: symbols.length, done, failed: 0, startedAt: job.startedAt ?? now, resumeAfter: null, message: todo.length ? `Fetching ${todo.length} series of ${tf} (${years}y) at background priority…` : "Everything is already stored." }, now);
  onProgress?.(getJob(deps.db, id)!);

  let pause: { reason: Parameters<typeof resumeTime>[0]; message: string } | null = null;
  let fatal: string | null = null;
  let consecutive = 0;
  const queue = [...todo];
  const worker = async () => {
    for (let symbol = queue.shift(); symbol; symbol = queue.shift()) {
      if (pause || fatal || getJob(deps.db, id)?.state === "cancelled") return;
      if (isMarketOpen(clock())) {
        pause = { reason: "market", message: "Paused for market hours (09:15–15:30 IST); resumes after the close." };
        return;
      }
      try {
        await deps.history.ensure(symbol, tf, want, "background");
        done += 1;
        consecutive = 0;
      } catch (error) {
        const kind = error instanceof BrokerError ? error.kind : "upstream";
        const message = error instanceof Error ? error.message : String(error);
        if (kind === "budget") pause ??= { reason: "budget", message: `Paused: ${message} Resumes tomorrow.` };
        else if (kind === "rate_limited") pause ??= { reason: "rate_limited", message: `Paused: ${message}` };
        else if (kind === "auth") pause ??= { reason: "auth", message: `Paused: ${message}` };
        else if (kind === "not_configured" || kind === "not_owner") fatal ??= message;
        else {
          failed += 1;
          consecutive += 1;
          deps.log.warn("backfill: symbol failed", { symbol, tf, error: message });
          if (consecutive >= MAX_CONSECUTIVE_FAILURES) pause ??= { reason: "failures", message: `Paused after ${consecutive} failures in a row (${message}).` };
        }
        if (pause || fatal) return;
      }
      update(deps.db, id, { done, failed, message: `${done}/${symbols.length} stored${failed ? `, ${failed} failed` : ""}…` }, clock());
      onProgress?.(getJob(deps.db, id)!);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const end = clock();
  const state = getJob(deps.db, id)!.state;
  const finalPause = pause as { reason: Parameters<typeof resumeTime>[0]; message: string } | null;
  if (state === "cancelled") {
    // leave as cancelled
  } else if (fatal) update(deps.db, id, { state: "error", done, failed, message: fatal, finishedAt: end }, end);
  else if (finalPause) update(deps.db, id, { state: "paused", done, failed, message: finalPause.message, resumeAfter: resumeTime(finalPause.reason, end) }, end);
  else update(deps.db, id, { state: "done", done, failed, finishedAt: end, message: failed ? `Done — ${failed} symbol(s) failed; run it again to retry them.` : "Done — everything is stored." }, end);
  const final = getJob(deps.db, id)!;
  onProgress?.(final);
  deps.log.info("backfill finished a run", { id, state: final.state, done: final.done, total: final.total, failed: final.failed });
  return final;
}
