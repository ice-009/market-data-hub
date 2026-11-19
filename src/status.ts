import { listBackups } from "./backup.js";
import { savedBudget } from "./broker/gate.js";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { hubVolumes } from "./disk.js";
import { candleStats } from "./history/store.js";
import type { Hub } from "./hub.js";
import { listJobs } from "./jobs/backfill.js";
import { countResults, isinStats, lastOkDay, latestBan, readRuns, storedDays, unmappedIndexNames, type DayDataset } from "./nse/store.js";
import { isoDay, istParts } from "./time.js";

// What /v1/status and `hub data status` report: data freshness per dataset,
// the broker connection and today's budget. Never anything secret: no tokens,
// no credentials, and error texts are the hub's own (already scrubbed).

export function dataFreshness(db: Db) {
  const runs = readRuns(db);
  const run = (name: Parameters<typeof runs.get>[0]) => {
    const r = runs.get(name);
    return { lastSuccessAt: r?.lastSuccessAt ?? null, lastAttemptAt: r?.lastAttemptAt ?? null, lastError: r?.lastError ?? null };
  };
  const day = (value: number | null) => (value === null ? null : isoDay(value));
  /** How far back the stored files reach (`hub data nse-history` fills it in). */
  const archive = (dataset: DayDataset) => {
    const stored = storedDays(db, dataset);
    return { firstSession: day(stored.first), sessions: stored.sessions };
  };
  const ban = latestBan(db);
  const lots = runs.get("lots")?.info;
  const renames = runs.get("symbol_changes")?.info;
  return {
    cashBhav: { lastSession: day(lastOkDay(db, "cash_bhav")), ...archive("cash_bhav"), ...run("cash_bhav") },
    foBhav: { lastSession: day(lastOkDay(db, "fo_bhav")), ...archive("fo_bhav"), ...run("fo_bhav") },
    indexFile: { lastSession: day(lastOkDay(db, "index_close")), ...archive("index_close"), unmappedNames: unmappedIndexNames(db).length, ...run("index_close") },
    lots: { count: (lots?.count as number | undefined) ?? 0, source: (lots?.source as string | undefined) ?? null, ...run("lots") },
    foBan: { tradeDate: ban ? isoDay(ban.tradeDate) : null, ...run("fo_ban") },
    // From the PR zip's board meetings: `upcoming` counts events dated today or later.
    resultsCalendar: { upcoming: countResults(db, istParts().day), lastSession: day(lastOkDay(db, "pr")), ...archive("pr"), ...run("pr") },
    symbolChanges: { count: (renames?.count as number | undefined) ?? 0, isins: isinStats(db), ...run("symbol_changes") },
    candles: candleStats(db).map((row) => ({ tf: row.tf, series: row.series, candles: row.candles, lastSession: row.lastT === null ? null : row.tf === "1d" ? isoDay(row.lastT) : new Date(row.lastT).toISOString() })),
  };
}

/**
 * Free disk and what backups take: `volumes` (one per disk — the database's, and
 * the backups' when on another disk), the thresholds, and the backups' count and bytes.
 */
export function diskStatus(config: Pick<Config, "dataDir" | "backupDir" | "diskWarnBytes" | "diskMinBytes">) {
  const backups = config.backupDir ? listBackups(config.backupDir) : null;
  return {
    volumes: hubVolumes(config.dataDir, config.backupDir),
    warnBelowBytes: config.diskWarnBytes,
    minFreeBytes: config.diskMinBytes,
    backups: backups && { count: backups.length, bytes: backups.reduce((sum, backup) => sum + backup.bytes, 0), newestBytes: backups[0]?.bytes ?? null },
  };
}

export function brokerStatus(hub: Pick<Hub, "auth" | "gate" | "owner" | "db">) {
  const auth = hub.auth?.status() ?? { configured: false, connected: false, lastLoginAt: null, lastLoginError: null, retryAfter: null };
  const live = hub.gate?.snapshot();
  const saved = live ? null : savedBudget(hub.db);
  return {
    configured: auth.configured,
    connected: auth.connected,
    ownsConnection: hub.owner,
    lastLoginAt: auth.lastLoginAt,
    lastLoginError: auth.lastLoginError,
    loginRetryAfter: auth.retryAfter,
    budget: live
      ? { plan: live.plan, usedToday: live.usedToday, dayCap: live.dayCap, usedThisMinute: live.usedThisMinute, minuteCap: live.minuteCap, byPriority: live.byPriority, strikes: live.strikes, slowed: live.slowed, coolingDown: live.coolingDown, stoppedForToday: live.stoppedForToday }
      : saved
        ? { usedToday: saved.usedToday, byPriority: saved.byPriority, strikes: saved.strikes }
        : null,
  };
}

/** What this hub can serve, given its mode (top of /v1/status, and `hub data status`). */
export function dataMode(hub: Pick<Hub, "mode">) {
  if (hub.mode === "end_of_day") {
    return {
      mode: "end_of_day" as const,
      modeLabel: "End-of-day only",
      modeNote: "No broker is configured: daily candles, F&O data, lot sizes, the ban list and results dates come from NSE's end-of-day files and archive. Live quotes, the price stream and intraday candles answer not_configured.",
      features: { dailyCandles: true, indexCandles: false, intradayCandles: false, liveQuotes: false, stream: false, fo: true },
    };
  }
  return {
    mode: "broker" as const,
    modeLabel: "Live (broker connected)",
    modeNote: null,
    features: { dailyCandles: true, indexCandles: true, intradayCandles: true, liveQuotes: true, stream: true, fo: true },
  };
}

export const recentJobs = (db: Db) => listJobs(db, 5).map((job) => ({ id: job.id, kind: job.kind, params: job.params, state: job.state, done: job.done, total: job.total, failed: job.failed, message: job.message, resumeAfter: job.resumeAfter, updatedAt: job.updatedAt }));
