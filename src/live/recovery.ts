import type { Priority } from "../broker/budget.js";
import { BrokerError } from "../broker/errors.js";
import type { HistoryResult, Resolution } from "../broker/fyers.js";
import { readKv, writeKv, type Db } from "../db.js";
import type { Logger } from "../log.js";
import { DAY_MS, MINUTE_MS, SESSION_OPEN_MIN, istDayKey, istParts, isWeekday, sleep as realSleep, weekdayOnOrBefore } from "../time.js";
import { minuteOf, sessionOf } from "./aggregate.js";
import type { PreviousRun, SqliteLiveStore } from "./store.js";
import type { MinuteBar, MinuteHistoryFetcher } from "./types.js";

// Repairing the minutes the hub missed, from the broker's 1-minute history.
//
// When: at start (the hub was down: from the last tick the previous run saw to
// now) and when the feed reconnects (the socket was silent: the feed reports
// {from, to}). Only session minutes count, and only within the last
// `sessions` sessions (today's and the one before, by default) — older minutes
// are what the candle history is for.
//
// Cost: the broker serves 1-minute history by whole days, so a repair costs one
// call per (symbol, session day) however small the gap. Calls go one at a time,
// newest day first, at background priority, spaced `minIntervalMs` apart
// (4 s → 15 a minute, inside the ~20/minute background share of the budget even
// before the gate's own checks): 100 symbols after a restart take ~7 minutes.
// A weekday that turns out to be a holiday (the first few long fetches all
// come back empty) is dropped instead of being asked for every symbol.
//
// Resumable and idempotent: planned work is kept in kv ("live.recovery") and a
// task is removed only once its bars are written, so a crash part-way just
// leaves the remainder for the next start; a task whose minutes are already all
// broker bars costs no call; writing the same broker bars twice changes nothing.
// A budget or rate-limit error stops the run with the work kept (call resume()
// later); an unknown symbol drops that symbol's task.
//
// The minute the gap ends in is still forming when it's planned, so a task is
// fetched only once its last minute has closed (plus `settleMs` for the broker
// to finish it) — the first fetch after a start waits up to ~a minute.

export const RECOVERY_KEY = "live.recovery";

/** Part of one session day of one symbol to download. Minute-aligned, half-open. */
export interface RecoveryTask {
  symbol: string;
  /** IST day key. */
  day: number;
  from: number;
  to: number;
}

export interface RecoveryReport {
  reason: "start" | "gap" | "symbols" | "resume";
  startedAt: number;
  finishedAt: number | null;
  /** Tasks known when the run began (including ones left by an earlier run). */
  planned: number;
  calls: number;
  bars: number;
  /** Tasks needing no call (already repaired, or a holiday). */
  skipped: number;
  /** Tasks dropped because the broker didn't know the symbol. */
  failed: number;
  /** Tasks still to do when the run ended (non-zero after an error). */
  pending: number;
  error?: string;
}

interface Saved {
  pending: RecoveryTask[];
  last: RecoveryReport | null;
}

// ── Planning (pure) ─────────────────────────────────────────────────────────

/** The latest session that has started by `now` (IST day key). Exchange holidays aren't known. */
export function latestSessionDay(now: number): number {
  const { day, minutes } = istParts(now);
  return isWeekday(day) && minutes >= SESSION_OPEN_MIN ? day : weekdayOnOrBefore(day - DAY_MS);
}

/** Open of the oldest of the latest `sessions` sessions: recovery reaches back no further. */
export function recoveryWindowStart(now: number, sessions: number): number {
  let day = latestSessionDay(now);
  for (let i = 1; i < sessions; i += 1) day = weekdayOnOrBefore(day - DAY_MS);
  return sessionOf(day).from;
}

/**
 * When the previous run stopped seeing the market: the minute of its last tick
 * (that minute may be partial). If that was the session's last minute and the
 * hub was still alive at the close, nothing of that session was missed.
 */
export function downtimeStart(previous: PreviousRun): number | null {
  const { lastTickAt, aliveAt } = previous;
  if (lastTickAt === null) return null;
  const close = sessionOf(istDayKey(lastTickAt)).to;
  if (lastTickAt >= close - MINUTE_MS && lastTickAt < close && aliveAt !== null && aliveAt >= close) return close;
  return minuteOf(lastTickAt);
}

/** [from, to) cut into per-day session slices (weekdays 09:15–15:30 IST), minute-aligned, newest first. */
export function sessionSlices(from: number, to: number): Array<{ day: number; from: number; to: number }> {
  const start = minuteOf(from);
  const end = Math.ceil(to / MINUTE_MS) * MINUTE_MS;
  const out: Array<{ day: number; from: number; to: number }> = [];
  if (start >= end) return out;
  for (let day = istDayKey(end - 1); day >= istDayKey(start); day -= DAY_MS) {
    if (!isWeekday(day)) continue;
    const session = sessionOf(day);
    const slice = { day, from: Math.max(start, session.from), to: Math.min(end, session.to) };
    if (slice.from < slice.to) out.push(slice);
  }
  return out;
}

export interface PlanInput {
  symbols: string[];
  now: number;
  /** Where each symbol's missing minutes begin (null: nothing stored — its latest session is fetched). */
  from: (symbol: string) => number | null;
  /** Where the missing minutes end (default: through the minute `now` is in). */
  to?: number;
  /** How many recent sessions may be repaired. */
  sessions: number;
  /** True when [from, to) of a symbol is already all broker bars (nothing to fetch). */
  repaired?: (symbol: string, from: number, to: number) => boolean;
}

/** Tasks for a gap, newest day first, symbols in the order given. Pure (given `repaired`). */
export function planRecovery(input: PlanInput): RecoveryTask[] {
  const windowStart = recoveryWindowStart(input.now, input.sessions);
  const end = input.to ?? minuteOf(input.now) + MINUTE_MS;
  const tasks: RecoveryTask[] = [];
  for (const symbol of input.symbols) {
    const start = input.from(symbol) ?? sessionOf(latestSessionDay(input.now)).from;
    for (const slice of sessionSlices(Math.max(start, windowStart), end)) {
      if (input.repaired?.(symbol, slice.from, slice.to)) continue;
      tasks.push({ symbol, ...slice });
    }
  }
  return sortTasks(tasks);
}

/** Newest day first; within a day, the order tasks were added. */
export const sortTasks = (tasks: RecoveryTask[]) => tasks.map((task, i) => ({ task, i })).sort((a, b) => b.task.day - a.task.day || a.i - b.i).map(({ task }) => task);

/** Add tasks to a queue: one per (symbol, day), ranges widened to cover both. */
export function mergeTasks(queue: RecoveryTask[], add: RecoveryTask[]): RecoveryTask[] {
  const byKey = new Map<string, RecoveryTask>();
  for (const task of [...queue, ...add]) {
    const key = `${task.symbol}|${task.day}`;
    const known = byKey.get(key);
    byKey.set(key, known ? { ...known, from: Math.min(known.from, task.from), to: Math.max(known.to, task.to) } : { ...task });
  }
  return sortTasks([...byKey.values()]);
}

// ── Fetching through FyersClient.history ────────────────────────────────────

export type HistoryFn = (symbol: string, resolution: Resolution, fromDay: number, toDay: number, priority: Priority) => Promise<HistoryResult>;

/**
 * A MinuteHistoryFetcher on a function shaped like FyersClient.history:
 * `minuteFetcher((...args) => client.history(...args))`. Asks for whole IST
 * days at resolution "1" and keeps the minutes in [fromMs, toMs).
 */
export function minuteFetcher(history: HistoryFn, priority: Priority = "background"): MinuteHistoryFetcher {
  return async (symbol, fromMs, toMs) => {
    if (fromMs >= toMs) return [];
    const result = await history(symbol, "1", istDayKey(fromMs), istDayKey(toMs - 1), priority);
    return result.bars.filter((bar) => bar.t >= fromMs && bar.t < toMs).map((bar) => ({ symbol, t: bar.t, o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v, source: "broker" as const }));
  };
}

// ── Running ─────────────────────────────────────────────────────────────────

export interface RecoveryOptions {
  db: Db;
  store: SqliteLiveStore;
  fetch: MinuteHistoryFetcher;
  /** Symbols the feed currently follows (recoverGap repairs these). */
  symbols: () => string[];
  log?: Logger;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Least time between two broker calls (ms). */
  minIntervalMs?: number;
  /** Wait this long after a minute closes before asking the broker for it (ms). */
  settleMs?: number;
  /** How many recent sessions may be repaired. */
  sessions?: number;
}

/** Long tasks (an hour or more) that come back empty before a day counts as a holiday. */
const HOLIDAY_EMPTY_FETCHES = 3;

export class LiveRecovery {
  private readonly clock: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly minIntervalMs: number;
  private readonly settleMs: number;
  private readonly sessions: number;
  private running: Promise<RecoveryReport> | null = null;
  private lastCallAt = -Infinity;
  private stopped = false;

  constructor(private readonly options: RecoveryOptions) {
    this.clock = options.clock ?? Date.now;
    this.sleep = options.sleep ?? realSleep;
    this.minIntervalMs = options.minIntervalMs ?? 4_000;
    this.settleMs = options.settleMs ?? 5_000;
    this.sessions = options.sessions ?? 2;
  }

  /**
   * At start: plan the downtime since the previous run's last tick (plus each
   * symbol's own last tick, and the latest session for symbols never seen), add
   * any work a crashed run left, and work through it. It plans from what the
   * store found when it opened, so it's safe after the feed has started.
   */
  recoverOnStart(symbols: string[]): Promise<RecoveryReport> {
    const now = this.clock();
    const previous = this.options.store.previousRun();
    const down = downtimeStart(previous);
    const last = this.options.store.previousTickTimes(symbols);
    const tasks = planRecovery({
      symbols,
      now,
      sessions: this.sessions,
      from: (symbol) => {
        const own = last.get(symbol);
        if (own === undefined) return null;
        // A symbol that went quiet before the hub stopped is repaired from its own last tick.
        const ownStart = downtimeStart({ lastTickAt: own, aliveAt: previous.aliveAt }) as number;
        return Math.min(down ?? ownStart, ownStart);
      },
      repaired: this.repaired,
    });
    return this.enqueue(tasks, "start");
  }

  /** The feed was silent over {from, to}: repair those minutes for every followed symbol. */
  recoverGap(gap: { from: number; to: number }): Promise<RecoveryReport> {
    const now = this.clock();
    const tasks = planRecovery({ symbols: this.options.symbols(), now, sessions: this.sessions, from: () => gap.from, to: Math.min(minuteOf(gap.to) + MINUTE_MS, minuteOf(now) + MINUTE_MS), repaired: this.repaired });
    return this.enqueue(tasks, "gap");
  }

  /** Newly followed symbols (e.g. just pinned): fetch their latest session so far. */
  recoverSymbols(symbols: string[]): Promise<RecoveryReport> {
    const now = this.clock();
    const tasks = planRecovery({ symbols, now, sessions: 1, from: () => null, repaired: this.repaired });
    return this.enqueue(tasks, "symbols");
  }

  /** Carry on with work left by an earlier run (after a budget or rate-limit stop). */
  resume(): Promise<RecoveryReport> {
    return this.enqueue([], "resume");
  }

  /**
   * Shutdown: no new call is started and nothing more is written; a run in
   * progress ends after its current wait or call. Queued work stays for the next start.
   */
  stop(): void {
    this.stopped = true;
  }

  /** Queued tasks, newest first. */
  pending(): RecoveryTask[] {
    return this.load().pending;
  }

  /** For /v1/status. */
  status(): { running: boolean; pending: number; last: RecoveryReport | null } {
    const saved = this.load();
    return { running: this.running !== null, pending: saved.pending.length, last: saved.last };
  }

  private readonly repaired = (symbol: string, from: number, to: number) => this.options.store.brokerMinutes(symbol, from, to) >= (to - from) / MINUTE_MS;

  private enqueue(tasks: RecoveryTask[], reason: RecoveryReport["reason"]): Promise<RecoveryReport> {
    if (this.stopped) {
      const now = this.clock();
      return Promise.resolve({ reason, startedAt: now, finishedAt: now, planned: 0, calls: 0, bars: 0, skipped: 0, failed: 0, pending: 0 });
    }
    const saved = this.load();
    this.save({ ...saved, pending: mergeTasks(saved.pending, tasks) });
    // A run in progress picks the new tasks up from the queue.
    if (this.running) return this.running;
    const run = this.run(reason).finally(() => {
      if (this.running === run) this.running = null;
    });
    this.running = run;
    return run;
  }

  private async run(reason: RecoveryReport["reason"]): Promise<RecoveryReport> {
    const { store, log } = this.options;
    const report: RecoveryReport = { reason, startedAt: this.clock(), finishedAt: null, planned: this.load().pending.length, calls: 0, bars: 0, skipped: 0, failed: 0, pending: 0 };
    if (report.planned) log?.info("live recovery started", { reason, tasks: report.planned });
    const empty = new Map<number, { empty: number; full: number }>();
    const holidays = new Set<number>();

    for (;;) {
      if (this.stopped) break;
      const task = this.load().pending[0];
      if (!task) break;
      if (holidays.has(task.day) || this.repaired(task.symbol, task.from, task.to)) {
        report.skipped += 1;
        this.done(task);
        continue;
      }
      // Wait for the task's last minute to close at the broker, and keep the pace.
      const ready = Math.max(task.to + this.settleMs, this.lastCallAt + this.minIntervalMs);
      const wait = ready - this.clock();
      if (wait > 0) await this.sleep(wait);
      if (this.stopped) break;

      let bars: MinuteBar[];
      try {
        this.lastCallAt = this.clock();
        report.calls += 1;
        bars = await this.options.fetch(task.symbol, task.from, task.to);
      } catch (error) {
        if (this.stopped) break;
        if (error instanceof BrokerError && error.kind === "bad_symbol") {
          report.failed += 1;
          this.done(task);
          continue;
        }
        report.error = error instanceof Error ? error.message : String(error);
        log?.warn("live recovery stopped; the rest is kept for later", { symbol: task.symbol, error });
        break;
      }

      if (this.stopped) break; // the database may be closing; the task stays queued
      const closedBefore = minuteOf(this.clock());
      const keep = bars
        .filter((bar) => bar.t >= task.from && bar.t < task.to && bar.t < closedBefore && Number.isFinite(bar.c))
        .map((bar) => ({ ...bar, symbol: task.symbol, source: "broker" as const }));
      store.writeBrokerBars(keep);
      report.bars += keep.length;
      this.done(task);

      if (task.to - task.from >= 60 * MINUTE_MS) {
        const seen = empty.get(task.day) ?? { empty: 0, full: 0 };
        if (keep.length) seen.full += 1;
        else seen.empty += 1;
        empty.set(task.day, seen);
        if (seen.full === 0 && seen.empty >= HOLIDAY_EMPTY_FETCHES) {
          holidays.add(task.day);
          log?.info("live recovery: no minutes for the day, treating it as a holiday", { day: new Date(task.day).toISOString().slice(0, 10) });
        }
      }
    }

    report.finishedAt = this.clock();
    if (this.stopped) return report;
    report.pending = this.load().pending.length;
    this.save({ ...this.load(), last: report });
    if (report.planned) log?.info("live recovery finished", { ...report });
    return report;
  }

  private done(task: RecoveryTask) {
    const saved = this.load();
    this.save({ ...saved, pending: saved.pending.filter((other) => !(other.symbol === task.symbol && other.day === task.day && other.from === task.from && other.to === task.to)) });
  }

  private load(): Saved {
    const saved = readKv<Saved>(this.options.db, RECOVERY_KEY);
    return { pending: Array.isArray(saved?.pending) ? saved.pending : [], last: saved?.last ?? null };
  }

  private save(saved: Saved) {
    writeKv(this.options.db, RECOVERY_KEY, saved, this.clock());
  }
}
