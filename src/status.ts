import { savedBudget } from "./broker/gate.js";
import type { Db } from "./db.js";
import { candleStats } from "./history/store.js";
import type { Hub } from "./hub.js";
import { listJobs } from "./jobs/backfill.js";
import { lastOkDay, latestBan, readRuns } from "./nse/store.js";
import { isoDay } from "./time.js";

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
  const ban = latestBan(db);
  const lots = runs.get("lots")?.info;
  const results = runs.get("results")?.info;
  return {
    cashBhav: { lastSession: day(lastOkDay(db, "cash_bhav")), ...run("cash_bhav") },
    foBhav: { lastSession: day(lastOkDay(db, "fo_bhav")), ...run("fo_bhav") },
    lots: { count: (lots?.count as number | undefined) ?? 0, source: (lots?.source as string | undefined) ?? null, ...run("lots") },
    foBan: { tradeDate: ban ? isoDay(ban.tradeDate) : null, ...run("fo_ban") },
    resultsCalendar: { events: (results?.count as number | undefined) ?? 0, ...run("results") },
    candles: candleStats(db).map((row) => ({ tf: row.tf, series: row.series, candles: row.candles, lastSession: row.lastT === null ? null : row.tf === "1d" ? isoDay(row.lastT) : new Date(row.lastT).toISOString() })),
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

export const recentJobs = (db: Db) => listJobs(db, 5).map((job) => ({ id: job.id, kind: job.kind, params: job.params, state: job.state, done: job.done, total: job.total, failed: job.failed, message: job.message, resumeAfter: job.resumeAfter, updatedAt: job.updatedAt }));
