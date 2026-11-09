import { listBackups } from "./backup.js";
import type { Db } from "./db.js";
import type { Hub } from "./hub.js";
import type { FeedStatus } from "./live/types.js";
import { WEEKEND_SESSIONS } from "./nse/datasets.js";
import { checkedDays, lastOkDay, readRuns, type DayDataset, type DayStatus } from "./nse/store.js";
import { DAY_MS, isMarketOpen, isoDay, istDayStart, istParts, isWeekday } from "./time.js";

// Is the hub healthy? `healthy`, `problems` and `warnings` at the top of
// /v1/status (and `hub data status`), for a person and for an uptime checker
// (`/v1/status?strict=1` answers 503 when unhealthy). A problem means data is
// going stale or a feed is down; a warning is worth knowing but not an alert.
// The messages name datasets and dates only — never configuration or secrets.

/** After this (minutes after IST midnight) a trading day's NSE files should be stored. */
export const NSE_DUE_MIN = 20 * 60;
/** Lots, the ban list and the results calendar are refreshed daily; older than this is stale. */
export const DAILY_STALE_MS = 4 * DAY_MS;
/** With HUB_BACKUP_DIR set, the newest backup should be younger than this. */
export const BACKUP_STALE_MS = 2 * DAY_MS;

const isSessionDay = (day: number) => isWeekday(day) || WEEKEND_SESSIONS.includes(day);

/**
 * Trading days whose file should be stored by `now` but isn't — after the last
 * stored one, skipping days known to have no file (holiday, or NSE served another
 * day's). Today counts from NSE_DUE_MIN. Newest first. Pure.
 */
export function missingSessions(now: number, lastOk: number, checked: ReadonlyMap<number, DayStatus>): number[] {
  const { day: today, minutes } = istParts(now);
  const out: number[] = [];
  for (let day = minutes >= NSE_DUE_MIN ? today : today - DAY_MS; day > lastOk; day -= DAY_MS) {
    const status = checked.get(day);
    if (isSessionDay(day) && status !== "holiday" && status !== "mismatch") out.push(day);
  }
  return out;
}

export interface NseDayState {
  lastOk: number | null;
  checked: ReadonlyMap<number, DayStatus>;
}

export interface HealthInput {
  now: number;
  /** Evidence that today was a trading day (live minutes or a stored daily bar for today). */
  sessionToday: boolean;
  jobsEnabled: boolean;
  nse: Record<DayDataset, NseDayState>;
  /** Last successful refresh of the daily reference files. */
  refreshed: { lots: number | null; fo_ban: number | null; results: number | null };
  broker: { configured: boolean; owner: boolean; loginFailing: string | null; stoppedForToday: boolean; coolingDown: boolean };
  live: { enabled: boolean; running: boolean; feed: Pick<FeedStatus, "mode" | "socket"> };
  /** Null when HUB_BACKUP_DIR isn't set. */
  backup: { lastAt: number | null } | null;
}

export interface Health {
  healthy: boolean;
  problems: string[];
  warnings: string[];
}

const LABEL: Record<DayDataset, string> = { cash_bhav: "Cash bhavcopy", fo_bhav: "F&O bhavcopy" };
const REFRESHED_LABEL = { lots: "Lot sizes", fo_ban: "F&O ban list", results: "Results calendar" } as const;
const age = (ms: number) => (ms >= 2 * DAY_MS ? `${Math.floor(ms / DAY_MS)} days` : `${Math.max(1, Math.round(ms / 3_600_000))} hours`);

/** Problems and warnings from the hub's state. Pure. */
export function assessHealth(input: HealthInput): Health {
  const { now } = input;
  const problems: string[] = [];
  const warnings: string[] = [];
  const today = istParts(now).day;

  for (const dataset of ["cash_bhav", "fo_bhav"] as const) {
    const state = input.nse[dataset];
    if (state.lastOk === null) {
      problems.push(`${LABEL[dataset]}: nothing stored yet.`);
      continue;
    }
    const missing = missingSessions(now, state.lastOk, state.checked);
    // Today's file missing with no sign of a session today may just be an exchange holiday
    // (the hub learns that from NSE's 404 the next day).
    const onlyToday = missing.length === 1 && missing[0] === today;
    if (!missing.length) continue;
    const message = `${LABEL[dataset]} is stale: last session stored ${isoDay(state.lastOk)}, missing ${missing.slice(0, 3).map(isoDay).join(", ")}${missing.length > 3 ? ` and ${missing.length - 3} more` : ""}.`;
    if (onlyToday && !input.sessionToday) warnings.push(`${message} (Fine if today was an exchange holiday.)`);
    else problems.push(message);
  }

  for (const name of ["lots", "fo_ban", "results"] as const) {
    const at = input.refreshed[name];
    if (at === null) problems.push(`${REFRESHED_LABEL[name]}: never fetched.`);
    else if (now - at > DAILY_STALE_MS) problems.push(`${REFRESHED_LABEL[name]}: last fetched ${age(now - at)} ago.`);
  }

  if (!input.jobsEnabled) warnings.push("Background jobs are off (HUB_JOBS=off): NSE files aren't refreshed and nightly backups don't run.");

  const broker = input.broker;
  if (broker.configured) {
    if (!broker.owner) warnings.push("Another hub process owns the broker connection; this one serves stored data only.");
    if (broker.loginFailing) problems.push(`Broker login is failing: ${broker.loginFailing}`);
    if (broker.stoppedForToday) problems.push("Broker calls are stopped for today (request budget spent or rate-limit strikes).");
    else if (broker.coolingDown) warnings.push("Broker calls are cooling down after a rate-limit warning.");
  }

  // Live prices matter only while the market is open.
  if (input.live.enabled && broker.owner && isMarketOpen(now)) {
    if (!input.live.running) problems.push("The live feed isn't running during market hours.");
    else if (input.live.feed.mode === "down") problems.push("The live feed is down during market hours (no socket and no polling).");
    else if (input.live.feed.socket !== "connected" && input.live.feed.mode !== "idle") warnings.push(`The live socket is ${input.live.feed.socket}; prices come from polling.`);
  }

  if (input.backup) {
    if (input.backup.lastAt === null) problems.push("Backups: none yet in HUB_BACKUP_DIR.");
    else if (now - input.backup.lastAt > BACKUP_STALE_MS) problems.push(`Backups: the newest is ${age(now - input.backup.lastAt)} old.`);
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
  const runs = readRuns(db);
  const success = (name: "lots" | "fo_ban" | "results") => runs.get(name)?.lastSuccessAt ?? null;
  const nse = (dataset: DayDataset): NseDayState => {
    const lastOk = lastOkDay(db, dataset);
    return { lastOk, checked: lastOk === null ? new Map() : checkedDays(db, dataset, lastOk) };
  };
  const auth = hub.auth?.status();
  const budget = hub.gate?.snapshot();
  const live = hub.live.status();
  return assessHealth({
    now,
    sessionToday: sessionToday(db, now),
    jobsEnabled: hub.config.jobsEnabled,
    nse: { cash_bhav: nse("cash_bhav"), fo_bhav: nse("fo_bhav") },
    refreshed: { lots: success("lots"), fo_ban: success("fo_ban"), results: success("results") },
    broker: {
      configured: auth?.configured ?? false,
      owner: hub.owner,
      loginFailing: auth?.retryAfter ? (auth.lastLoginError ?? "unknown error") : null,
      stoppedForToday: budget?.stoppedForToday ?? false,
      coolingDown: budget?.coolingDown ?? false,
    },
    live: feed ? { enabled: live.enabled, running: live.running, feed } : { enabled: false, running: false, feed: { mode: "idle", socket: "disabled" } },
    backup: hub.config.backupDir ? { lastAt: listBackups(hub.config.backupDir)[0]?.at ?? null } : null,
  });
}
