import { backupDb, backupDue, listBackups } from "../backup.js";
import type { Db } from "../db.js";
import type { Logger } from "../log.js";
import { recentDays, refreshBan, refreshLots, refreshSymbolChanges, syncDays, type NseContext } from "../nse/datasets.js";
import { latestBan, readRuns, type DatasetName, type DatasetRun, type DayDataset } from "../nse/store.js";
import { DAY_MS, MINUTE_MS, istDayStart, istParts, isWeekday } from "../time.js";
import { nextRunnableJob, recoverJobs, runBackfill, type BackfillDeps } from "./backfill.js";
import { runNseHistory } from "./nseHistory.js";

// Background work inside the server process (the owner of NSE and broker
// connections):
//   - NSE daily files in the evening IST. The cash and F&O bhavcopies are
//     fetched for any of the last RECENT_DAYS trading days not stored yet — on
//     start that's the catch-up, in the evening it's normally just today's file
//     once NSE has published it. The PR zip, whose board meetings make the
//     results calendar, likewise for the last RESULTS_LOOKBACK_DAYS (meetings
//     are announced up to weeks ahead, one day's announcements per file). Lots,
//     the F&O ban list and NSE's ticker renames (symbolchange.csv) are refreshed
//     once each evening (and on start when stale).
//   - queued jobs, one at a time: broker backfills (`hub data backfill`) and
//     NSE history downloads (`hub data nse-history`).
//   - a nightly database backup when HUB_BACKUP_DIR is set (src/backup.ts).
// Every attempt is spaced at least RETRY_MS from the last one per dataset, so a
// file NSE hasn't published yet costs one request every half hour.

export const RECENT_DAYS = 10;
/** PR zips read back this far, so the results calendar holds every meeting announced for the weeks ahead. */
export const RESULTS_LOOKBACK_DAYS = 60;
export const RETRY_MS = 30 * MINUTE_MS;
export const TICK_MS = MINUTE_MS;
/** The evening window for once-a-day refreshes (minutes after IST midnight). */
export const EVENING_FROM_MIN = 18 * 60 + 30;
export const EVENING_TO_MIN = 23 * 60 + 30;
/** The ban list for the next session appears in the evening; it's worth asking for from here on. */
const BAN_NEXT_DAY_FROM_MIN = 18 * 60;

export type Task = DatasetName;

export interface ScheduleInput {
  now: number;
  runs: ReadonlyMap<DatasetName, Pick<DatasetRun, "lastAttemptAt" | "lastSuccessAt">>;
  /** Days each day-dataset still lacks among the recent ones. */
  missing: Record<DayDataset, number>;
  /** Trade date of the newest stored ban list. */
  banTradeDate: number | null;
}

/** The session the ban list should be for at `now`: today until the evening, then the next weekday. */
export function banTarget(now: number): number {
  const { day, minutes } = istParts(now);
  if (isWeekday(day) && minutes < BAN_NEXT_DAY_FROM_MIN) return day;
  let next = day + DAY_MS;
  while (!isWeekday(next)) next += DAY_MS;
  return next;
}

/** Which datasets to refresh now. Pure. */
export function dueTasks(input: ScheduleInput): Task[] {
  const { now, runs } = input;
  const { minutes } = istParts(now);
  const evening = minutes >= EVENING_FROM_MIN && minutes < EVENING_TO_MIN;
  const rested = (task: Task) => {
    const at = runs.get(task)?.lastAttemptAt;
    return !at || now - at >= RETRY_MS;
  };
  /** Once each evening; any time when never fetched or over two days old. */
  const eveningStart = istDayStart(istParts(now).day) + EVENING_FROM_MIN * MINUTE_MS;
  const daily = (task: Task) => {
    const success = runs.get(task)?.lastSuccessAt;
    if (!success || now - success > 2 * DAY_MS) return true;
    return evening && success < eveningStart;
  };
  const due: Task[] = [];
  if (input.missing.cash_bhav > 0 && rested("cash_bhav")) due.push("cash_bhav");
  if (input.missing.fo_bhav > 0 && rested("fo_bhav")) due.push("fo_bhav");
  if (daily("lots") && rested("lots")) due.push("lots");
  if ((input.banTradeDate === null || input.banTradeDate < banTarget(now)) && minutes >= 7 * 60 && minutes < EVENING_TO_MIN && rested("fo_ban")) due.push("fo_ban");
  if (input.missing.pr > 0 && rested("pr")) due.push("pr");
  if (daily("symbol_changes") && rested("symbol_changes")) due.push("symbol_changes");
  return due;
}

export interface SchedulerDeps {
  nse: NseContext;
  backfill: BackfillDeps;
  log: Logger;
  /** Nightly backups; absent when HUB_BACKUP_DIR isn't set. */
  backup?: { db: Db; dir: string; keep: number };
}

export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private nseBusy = false;
  private jobBusy = false;
  private backupBusy = false;
  private stopping = false;

  constructor(private readonly deps: SchedulerDeps) {}

  start() {
    recoverJobs(this.deps.nse.db, this.deps.nse.clock());
    void this.tick();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  stop() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
  }

  /** One round: start NSE refreshes and a queued job if due (each runs in the background). */
  async tick() {
    await Promise.all([this.nseRound(), this.jobRound(), this.backupRound()]);
  }

  private async backupRound() {
    const backup = this.deps.backup;
    if (!backup || this.backupBusy || this.stopping) return;
    const now = this.deps.nse.clock();
    if (!backupDue(now, listBackups(backup.dir)[0]?.at ?? null)) return;
    this.backupBusy = true;
    try {
      const result = await backupDb(backup.db, backup.dir, backup.keep, now);
      this.deps.log.info("database backed up", { file: result.file, bytes: result.bytes, removed: result.removed.length });
    } catch (error) {
      this.deps.log.error("database backup failed", { error });
    } finally {
      this.backupBusy = false;
    }
  }

  private async nseRound() {
    if (this.nseBusy || this.stopping) return;
    this.nseBusy = true;
    const ctx = this.deps.nse;
    try {
      const cash = recentDays(ctx, "cash_bhav", RECENT_DAYS);
      const fo = recentDays(ctx, "fo_bhav", RECENT_DAYS);
      const pr = recentDays(ctx, "pr", RESULTS_LOOKBACK_DAYS, RECENT_DAYS);
      const tasks = dueTasks({ now: ctx.clock(), runs: readRuns(ctx.db), missing: { cash_bhav: cash.length, fo_bhav: fo.length, pr: pr.length }, banTradeDate: latestBan(ctx.db)?.tradeDate ?? null });
      for (const task of tasks) {
        if (this.stopping) break;
        if (task === "cash_bhav") await syncDays(ctx, "cash_bhav", cash, () => this.stopping);
        else if (task === "fo_bhav") await syncDays(ctx, "fo_bhav", fo, () => this.stopping);
        else if (task === "lots") await refreshLots(ctx);
        else if (task === "fo_ban") await refreshBan(ctx);
        else if (task === "pr") await syncDays(ctx, "pr", pr, () => this.stopping);
        else await refreshSymbolChanges(ctx);
      }
    } catch (error) {
      this.deps.log.error("scheduled NSE refresh failed", { error });
    } finally {
      this.nseBusy = false;
    }
  }

  private async jobRound() {
    if (this.jobBusy || this.stopping) return;
    const job = nextRunnableJob(this.deps.backfill.db, this.deps.nse.clock());
    if (!job) return;
    this.jobBusy = true;
    try {
      if (job.kind === "nse_history") await runNseHistory(this.deps.nse, job.id);
      else await runBackfill(this.deps.backfill, job.id);
    } catch (error) {
      this.deps.log.error("job failed", { id: job.id, kind: job.kind, error });
    } finally {
      this.jobBusy = false;
    }
  }
}
