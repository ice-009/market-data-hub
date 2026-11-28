import { listBackups } from "./backup.js";
import type { Db } from "./db.js";
import { gb, hubVolumes, type Volume } from "./disk.js";
import type { Hub } from "./hub.js";
import type { FeedStatus } from "./live/types.js";
import { checkedDays, lastOkDay, readRuns, type DatasetName, type DayDataset, type DayStatus } from "./nse/store.js";
import { HEALTH_FINDING_DAYS, recentProblems } from "./quality/summary.js";
import { calendar, calendarWarnings, type Calendar } from "./calendar/calendar.js";
import { syncCalendar } from "./calendar/store.js";
import { DAY_MS, isoDay, istDayStart, istParts } from "./time.js";

// Is the hub healthy? `healthy`, `problems` and `warnings` at the top of
// /v1/status (and `hub data status`), for a person and for an uptime checker
// (`/v1/status?strict=1` answers 503 when unhealthy). A problem means data is
// going stale, a feed is down or the disk is nearly full; a warning is worth knowing but not an alert.
// The messages name datasets and dates only — never configuration or secrets.

/** After this (minutes after IST midnight) a trading day's NSE files should be stored. */
export const NSE_DUE_MIN = 20 * 60;
/** Lots and the ban list are refreshed daily; older than this is stale. */
export const DAILY_STALE_MS = 4 * DAY_MS;
/** A dataset whose last this many refresh attempts failed is a warning (market-data-hub#14)… */
export const FAILING_WARN_ATTEMPTS = 3;
/** …and a problem once it has been failing this long. */
export const FAILING_PROBLEM_MS = DAY_MS;
/** With HUB_BACKUP_DIR set, the newest backup should be younger than this. */
export const BACKUP_STALE_MS = 2 * DAY_MS;

/**
 * Trading days (src/calendar: no weekends, no exchange holidays, plus special
 * sessions) whose file should be stored by `now` but isn't — after the last
 * stored one, skipping days known to have no file (holiday, or NSE served another
 * day's). Today counts from NSE_DUE_MIN. Newest first. Pure, given the calendar.
 */
export function missingSessions(now: number, lastOk: number, checked: ReadonlyMap<number, DayStatus>, cal: Calendar = calendar()): number[] {
  const { day: today, minutes } = istParts(now);
  const out: number[] = [];
  for (let day = minutes >= NSE_DUE_MIN ? today : today - DAY_MS; day > lastOk; day -= DAY_MS) {
    const status = checked.get(day);
    if (cal.isTradingDay(day) && status !== "holiday" && status !== "mismatch") out.push(day);
  }
  return out;
}

export interface NseDayState {
  lastOk: number | null;
  checked: ReadonlyMap<number, DayStatus>;
}

export interface HealthInput {
  now: number;
  /** The trading calendar (default: the hub's current one). */
  calendar?: Calendar;
  /** Evidence that today was a trading day (live minutes or a stored daily bar for today). */
  sessionToday: boolean;
  jobsEnabled: boolean;
  nse: Record<"cash_bhav" | "fo_bhav" | "pr", NseDayState> & { index_close?: NseDayState };
  /** Last successful refresh of the daily reference files. */
  refreshed: { lots: number | null; fo_ban: number | null };
  broker: { configured: boolean; owner: boolean; loginFailing: string | null; stoppedForToday: boolean; coolingDown: boolean };
  live: { enabled: boolean; running: boolean; feed: Pick<FeedStatus, "mode" | "socket"> };
  /** Null when HUB_BACKUP_DIR isn't set. */
  backup: { lastAt: number | null } | null;
  /** Free space where the database and backups live; `warnBytes` HUB_DISK_WARN_GB, `minBytes` HUB_DISK_MIN_GB. */
  disk: { volumes: Volume[]; warnBytes: number; minBytes: number };
  /** Datasets whose refreshes are failing: attempts failed in a row, since when, the last error. */
  failing?: Array<{ name: DatasetName; failures: number; failingSince: number | null; lastError: string | null }>;
  /** Open data-quality problems about the last HEALTH_FINDING_DAYS days' data (src/quality), newest first. */
  quality?: { problems: Array<{ message: string }> };
}

export interface Health {
  healthy: boolean;
  problems: string[];
  warnings: string[];
}

const LABEL: Record<DayDataset, string> = { cash_bhav: "Cash bhavcopy", fo_bhav: "F&O bhavcopy", pr: "PR zip (results calendar)", index_close: "Index file", fo_ban: "F&O ban list" };
const REFRESHED_LABEL = { lots: "Lot sizes", fo_ban: "F&O ban list" } as const;
const RUN_LABEL: Record<DatasetName, string> = { ...LABEL, ...REFRESHED_LABEL, symbol_changes: "Ticker renames (symbolchange.csv)" };
const age = (ms: number) => (ms >= 2 * DAY_MS ? `${Math.floor(ms / DAY_MS)} days` : `${Math.max(1, Math.round(ms / 3_600_000))} hours`);

/** Problems and warnings from the hub's state. Pure. */
export function assessHealth(input: HealthInput): Health {
  const { now } = input;
  const cal = input.calendar ?? calendar();
  const problems: string[] = [];
  const warnings: string[] = [];
  const today = istParts(now).day;

  for (const dataset of ["cash_bhav", "fo_bhav", "pr", "index_close"] as const) {
    const state = input.nse[dataset];
    // The index file is newer to the hub: a hub that has never stored one only gets a warning.
    if (!state) continue;
    if (state.lastOk === null) {
      if (dataset === "index_close") warnings.push(`${LABEL[dataset]}: nothing stored yet (index candles come from the broker only).`);
      else problems.push(`${LABEL[dataset]}: nothing stored yet.`);
      continue;
    }
    const missing = missingSessions(now, state.lastOk, state.checked, cal);
    // Today's file missing with no sign of a session today may just be an exchange holiday
    // the calendar doesn't list (the hub learns that from NSE's 404 the next day).
    const onlyToday = missing.length === 1 && missing[0] === today;
    if (!missing.length) continue;
    const message = `${LABEL[dataset]} is stale: last session stored ${isoDay(state.lastOk)}, missing ${missing.slice(0, 3).map(isoDay).join(", ")}${missing.length > 3 ? ` and ${missing.length - 3} more` : ""}.`;
    if (onlyToday && !input.sessionToday) warnings.push(`${message} (Fine if today was an exchange holiday.)`);
    else problems.push(message);
  }

  for (const name of ["lots", "fo_ban"] as const) {
    const at = input.refreshed[name];
    if (at === null) problems.push(`${REFRESHED_LABEL[name]}: never fetched.`);
    else if (now - at > DAILY_STALE_MS) problems.push(`${REFRESHED_LABEL[name]}: last fetched ${age(now - at)} ago.`);
  }

  // A refresh that keeps failing, before (or while) its data goes stale.
  for (const run of input.failing ?? []) {
    if (run.failures < FAILING_WARN_ATTEMPTS || !(run.name in RUN_LABEL)) continue;
    const text = `${RUN_LABEL[run.name]}: the last ${run.failures} refresh attempts failed${run.failingSince === null ? "" : ` (failing for ${age(now - run.failingSince)})`}; last error: ${run.lastError ?? "unknown"}`;
    if (run.failingSince !== null && now - run.failingSince >= FAILING_PROBLEM_MS) problems.push(text);
    else warnings.push(text);
  }

  warnings.push(...calendarWarnings(now, cal));

  const quality = input.quality?.problems ?? [];
  if (quality.length) warnings.push(`Data quality: ${quality.length} problem${quality.length === 1 ? "" : "s"} in the last ${HEALTH_FINDING_DAYS} days' data (see /v1/quality). ${quality[0].message}`);

  if (!input.jobsEnabled) warnings.push("Background jobs are off (HUB_JOBS=off): NSE files aren't refreshed and nightly backups don't run.");

  const broker = input.broker;
  if (broker.configured) {
    if (!broker.owner) warnings.push("Another hub process owns the broker connection; this one serves stored data only.");
    if (broker.loginFailing) problems.push(`Broker login is failing: ${broker.loginFailing}`);
    if (broker.stoppedForToday) problems.push("Broker calls are stopped for today (request budget spent or rate-limit strikes).");
    else if (broker.coolingDown) warnings.push("Broker calls are cooling down after a rate-limit warning.");
  }

  // Live prices matter only while the market is open (never on an exchange holiday).
  if (input.live.enabled && broker.owner && cal.isOpen(now)) {
    if (!input.live.running) problems.push("The live feed isn't running during market hours.");
    else if (input.live.feed.mode === "down") problems.push("The live feed is down during market hours (no socket and no polling).");
    else if (input.live.feed.socket !== "connected" && input.live.feed.mode !== "idle") warnings.push(`The live socket is ${input.live.feed.socket}; prices come from polling.`);
  }

  if (input.backup) {
    if (input.backup.lastAt === null) problems.push("Backups: none yet in HUB_BACKUP_DIR.");
    else if (now - input.backup.lastAt > BACKUP_STALE_MS) problems.push(`Backups: the newest is ${age(now - input.backup.lastAt)} old.`);
  }

  // Under the floor, NSE history and backups have already stopped, and SQLite writes are next.
  for (const volume of input.disk.volumes) {
    if (volume.freeBytes === null) continue;
    if (volume.freeBytes < input.disk.minBytes) problems.push(`Disk: only ${gb(volume.freeBytes)} free for ${volume.holds} (under ${gb(input.disk.minBytes)}): NSE history downloads and backups won't run, and database writes may soon fail.`);
    else if (volume.freeBytes < input.disk.warnBytes) warnings.push(`Disk: ${gb(volume.freeBytes)} free for ${volume.holds} (under ${gb(input.disk.warnBytes)}).`);
  }

  return { healthy: problems.length === 0, problems, warnings };
}

/** Did today have a session, judging by what the hub stored today (live minutes or a daily bar)? */
function sessionToday(db: Db, now: number): boolean {
  const day = istParts(now).day;
  const minute = db.prepare("select 1 from live_bars_1m where t >= ? and t < ? limit 1").get(istDayStart(day), istDayStart(day) + DAY_MS);
  return Boolean(minute) || Boolean(db.prepare("select 1 from candles where tf = '1d' and t = ? limit 1").get(day));
}

/**
 * The hub's health now. `feed` is the live feed's status as the server sees it;
 * null from another process (the CLI), which can't see the server's feed.
 */
export function hubHealth(hub: Pick<Hub, "db" | "config" | "owner" | "auth" | "gate" | "live">, feed: Pick<FeedStatus, "mode" | "socket"> | null, now = Date.now()): Health {
  const { db } = hub;
  const cal = syncCalendar(db);
  const runs = readRuns(db);
  const success = (name: "lots" | "fo_ban") => runs.get(name)?.lastSuccessAt ?? null;
  const nse = (dataset: DayDataset): NseDayState => {
    const lastOk = lastOkDay(db, dataset);
    return { lastOk, checked: lastOk === null ? new Map() : checkedDays(db, dataset, lastOk) };
  };
  const auth = hub.auth?.status();
  const budget = hub.gate?.snapshot();
  const live = hub.live.status();
  return assessHealth({
    now,
    calendar: cal,
    sessionToday: sessionToday(db, now),
    jobsEnabled: hub.config.jobsEnabled,
    nse: { cash_bhav: nse("cash_bhav"), fo_bhav: nse("fo_bhav"), pr: nse("pr"), index_close: nse("index_close") },
    refreshed: { lots: success("lots"), fo_ban: success("fo_ban") },
    broker: {
      configured: auth?.configured ?? false,
      owner: hub.owner,
      loginFailing: auth?.retryAfter ? (auth.lastLoginError ?? "unknown error") : null,
      stoppedForToday: budget?.stoppedForToday ?? false,
      coolingDown: budget?.coolingDown ?? false,
    },
    live: feed ? { enabled: live.enabled, running: live.running, feed } : { enabled: false, running: false, feed: { mode: "idle", socket: "disabled" } },
    backup: hub.config.backupDir ? { lastAt: listBackups(hub.config.backupDir)[0]?.at ?? null } : null,
    disk: { volumes: hubVolumes(hub.config.dataDir, hub.config.backupDir), warnBytes: hub.config.diskWarnBytes, minBytes: hub.config.diskMinBytes },
    failing: [...runs.values()].filter((run) => run.failures > 0).map((run) => ({ name: run.name, failures: run.failures, failingSince: run.failingSince, lastError: run.lastError })),
    quality: { problems: recentProblems(db, now) },
  });
}
