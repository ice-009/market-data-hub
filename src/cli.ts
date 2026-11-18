import path from "node:path";
import { backupDb } from "./backup.js";
import { gb, shortOfSpace } from "./disk.js";
import { createKey, listKeys, parseScopes, revokeKey } from "./auth/keys.js";
import { loadConfig, secretValues } from "./config.js";
import { openDb, type Db } from "./db.js";
import { BACKFILL_TFS, BASE, finalBefore, type BaseTf } from "./history/timeframes.js";
import { hubHealth } from "./health.js";
import { createHub } from "./hub.js";
import { ImportError, formatImportReport, importTradexLocked } from "./import/tradex.js";
import { DEFAULT_INDICES, cancelJob, enqueueBackfill, enqueueJob, listJobs, maxYears, recoverJobs, runBackfill, validateBackfill, type Job, type NseHistoryParams } from "./jobs/backfill.js";
import { HISTORY_DATASETS, HISTORY_LABEL, lastHistoryDay, runNseHistory, validateNseHistory } from "./jobs/nseHistory.js";
import { createLogger } from "./log.js";
import { acquireOwner, ownerPid } from "./owner.js";
import { getUniverse } from "./reference/universe.js";
import { brokerStatus, dataFreshness, diskStatus } from "./status.js";
import { ARCHIVE_FROM } from "./nse/datasets.js";
import { DAY_MS, isoDay, istParts } from "./time.js";

// Admin CLI, run on the machine that hosts the hub (it opens the database
// directly; there is no remote admin API).
//   npm run hub -- keys create tradex --scopes history,live,fo
//   npm run hub -- keys list
//   npm run hub -- keys revoke key_1a2b3c4d5e6f
//   npm run hub -- data backfill --tf 1d --years 5 [--symbols SBIN,INFY]
//   npm run hub -- data nse-history [--from 1994-11-03] [--to 2024-07-05] [--only cash|fo|pr]
//   npm run hub -- data status
//   npm run hub -- data cancel <job id>
//   npm run hub -- data backup [--to ./backups] [--keep 7]
//   npm run hub -- data import-tradex --db ../tradex/.cache/market.db [--screener ../tradex/.cache/screener] [--dry-run]
//
// A backfill or NSE history download runs in this process when no hub server
// is running; otherwise it is queued and the server (which owns the broker and
// NSE connections) runs it.

const USAGE = `Usage:
  hub keys create <name> --scopes history,live,fo[,admin]
  hub keys list
  hub keys revoke <id>
  hub data backfill --tf 1d|15m|5m [--years N] [--symbols SBIN,INFY,…]
  hub data nse-history [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--only cash|fo|pr]
  hub data status
  hub data cancel <job id>
  hub data backup [--to <dir>] [--keep N]
  hub data import-tradex --db <market.db> [--screener <dir>] [--dry-run]`;

const fmt = (ms: number | null) => (ms ? `${new Date(ms).toISOString().replace("T", " ").slice(0, 19)} UTC` : "—");

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function keys(db: Db, action: string, rest: string[]): number {
  if (action === "create") {
    const name = rest.find((arg) => !arg.startsWith("--")) ?? "";
    const scopes = parseScopes(flag(rest, "--scopes") ?? "");
    const { key, record } = createKey(db, name, scopes);
    console.log(`Created ${record.id} "${record.name}" with scopes ${record.scopes.join(", ")}.`);
    console.log("\nAPI key (shown once — store it in the client's .env):\n");
    console.log(`  ${key}\n`);
    return 0;
  }
  if (action === "list") {
    const all = listKeys(db);
    if (!all.length) console.log("No keys yet.");
    for (const key of all) console.log(`${key.id}  ${key.name.padEnd(16)} ${key.scopes.join(",").padEnd(22)} created ${fmt(key.createdAt)}  last used ${fmt(key.lastUsedAt)}${key.revokedAt ? `  REVOKED ${fmt(key.revokedAt)}` : ""}`);
    return 0;
  }
  if (action === "revoke") {
    const ok = revokeKey(db, rest[0] ?? "");
    console.log(ok ? `Revoked ${rest[0]}.` : `No active key with id "${rest[0] ?? ""}".`);
    return ok ? 0 : 1;
  }
  console.log(USAGE);
  return 1;
}

const jobTitle = (job: Job) =>
  job.kind === "nse_history"
    ? `NSE history ${job.params.from} → ${job.params.to} (${job.params.datasets.map((dataset) => HISTORY_LABEL[dataset]).join(", ")})`
    : `${job.params.tf} ${job.params.years}y ${job.params.symbols ? `${job.params.symbols.length} symbols` : "F&O + indices"}`;
const jobLine = (job: Job) => `#${job.id} ${jobTitle(job)}: ${job.state} ${job.done}/${job.total}${job.failed ? ` (${job.failed} failed)` : ""} — ${job.message}${job.resumeAfter && job.state === "paused" ? ` (resumes ${fmt(job.resumeAfter)})` : ""}`;

async function data(db: Db, action: string, rest: string[]): Promise<number> {
  const config = loadConfig();
  // Hub internals log to stderr at warn level so the CLI's own output stays readable.
  const log = createLogger({ level: "warn", secrets: secretValues(config.secrets), write: (line) => process.stderr.write(`${line}\n`) });

  if (action === "backfill") {
    const tf = (flag(rest, "--tf") ?? "1d") as BaseTf;
    const yearsRaw = flag(rest, "--years");
    const years = yearsRaw === undefined ? (tf in BASE ? maxYears(tf) : 1) : Number(yearsRaw);
    const symbolsRaw = flag(rest, "--symbols");
    const symbols = symbolsRaw ? [...new Set(symbolsRaw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean))] : null;
    const params = { tf, years, symbols };
    const invalid = validateBackfill(params);
    if (invalid) {
      console.error(invalid);
      return 1;
    }
    const release = acquireOwner(config.dataDir);
    if (!release) {
      const queued = enqueueBackfill(db, params);
      console.log(`Queued backfill #${queued.id}. The running hub (pid ${ownerPid(config.dataDir) ?? "?"}) owns the broker connection and will run it; follow it with \`hub data status\`.`);
      return 0;
    }
    // We own the connection, so a job marked running belongs to a process that died.
    recoverJobs(db);
    const job = enqueueBackfill(db, params);
    const hub = createHub({ config, db, log, owner: true });
    if (!hub.auth) {
      release();
      cancelJob(db, job.id);
      console.error("No broker credentials are configured (FYERS_* in .env).");
      return 1;
    }
    console.log(`Running backfill #${job.id} here (no hub server is running). Ctrl-C stops it; run the same command again to resume.`);
    const stop = () => {
      cancelJob(db, job.id);
      console.log("\nStopping after the current requests…");
    };
    process.once("SIGINT", stop);
    let last = "";
    try {
      const final = await runBackfill({ db, history: hub.history, log }, job.id, (progress) => {
        const line = jobLine(progress);
        if (line !== last) console.log(line);
        last = line;
      });
      return final.state === "error" ? 1 : 0;
    } finally {
      process.off("SIGINT", stop);
      hub.gate?.flush();
      release();
    }
  }

  if (action === "nse-history") {
    const only = flag(rest, "--only");
    const ONLY: Record<string, NseHistoryParams["datasets"]> = { cash: ["cash_bhav"], fo: ["fo_bhav"], pr: ["pr"] };
    const datasets: NseHistoryParams["datasets"] = only === undefined ? [...HISTORY_DATASETS] : (ONLY[only] ?? []);
    const params: NseHistoryParams = { from: flag(rest, "--from") ?? isoDay(ARCHIVE_FROM.cash_bhav), to: flag(rest, "--to") ?? isoDay(lastHistoryDay(Date.now())), datasets };
    const invalid = validateNseHistory(params, istParts().day);
    if (invalid) {
      console.error(invalid);
      return 1;
    }
    // The whole archive adds about 1.5 GB to hub.db (docs/api.md#disk-space); it pauses at the floor anyway.
    const short = shortOfSpace({ dir: config.dataDir, minFreeBytes: config.diskMinBytes });
    if (short) {
      console.error(`Not starting NSE history: ${short.message}. Free some space and run it again.`);
      return 1;
    }
    const release = acquireOwner(config.dataDir);
    if (!release) {
      const queued = enqueueJob(db, "nse_history", params);
      console.log(`Queued NSE history #${queued.id}. The running hub (pid ${ownerPid(config.dataDir) ?? "?"}) owns the NSE connection and will run it (pausing in market hours); follow it with \`hub data status\`.`);
      return 0;
    }
    recoverJobs(db);
    const job = enqueueJob(db, "nse_history", params);
    const hub = createHub({ config, db, log, owner: true });
    console.log(`Running NSE history #${job.id} here (no hub server is running): about 1.1 s per file. Ctrl-C stops it; run the same command again to resume.`);
    const stop = () => {
      cancelJob(db, job.id);
      console.log("\nStopping after the current file…");
    };
    process.once("SIGINT", stop);
    let lastPrinted = 0;
    try {
      const final = await runNseHistory(hub.nse, job.id, (progress) => {
        // A line every ~25 days is enough to follow a run of thousands.
        if (progress.state !== "running" || progress.done - lastPrinted >= 25 || progress.done === 0) {
          console.log(jobLine(progress));
          lastPrinted = progress.done;
        }
      });
      return final.state === "error" ? 1 : 0;
    } finally {
      process.off("SIGINT", stop);
      release();
    }
  }

  if (action === "status") {
    const hub = createHub({ config, db, log, owner: false });
    const fresh = dataFreshness(db);
    const broker = brokerStatus(hub);
    const pid = ownerPid(config.dataDir);
    // The live feed runs in the server process and can't be seen from here (see /v1/status for it).
    const health = hubHealth({ ...hub, owner: pid !== null }, null);
    console.log(health.healthy ? "Health: OK" : `Health: ${health.problems.length} problem(s)`);
    for (const problem of health.problems) console.log(`  ✗ ${problem}`);
    for (const warning of health.warnings) console.log(`  ! ${warning}`);
    console.log("");
    console.log(`Owner process: ${pid ? `pid ${pid}` : "none (no hub server running)"}`);
    const disk = diskStatus(config);
    for (const volume of disk.volumes) console.log(`Disk: ${volume.freeBytes === null ? "free space unknown" : `${gb(volume.freeBytes)} free`} for ${volume.holds} (warning under ${gb(disk.warnBelowBytes)}; NSE history and backups stop under ${gb(disk.minFreeBytes)})`);
    if (disk.backups) console.log(`Backups: ${disk.backups.count}, ${gb(disk.backups.bytes)} in all${disk.backups.newestBytes === null ? "" : `, newest ${gb(disk.backups.newestBytes)}`}`);
    console.log(`Broker: ${broker.configured ? "configured" : "not configured"}, ${broker.connected ? "token valid" : "no valid token"}, last login ${fmt(broker.lastLoginAt)}${broker.lastLoginError ? `, last error: ${broker.lastLoginError}` : ""}`);
    if (broker.budget) console.log(`Budget today: ${broker.budget.usedToday} calls (user ${broker.budget.byPriority.user}, background ${broker.budget.byPriority.background}), strikes ${broker.budget.strikes}`);
    console.log("\nNSE datasets:");
    console.log(`  cash bhavcopy   last session ${fresh.cashBhav.lastSession ?? "—"}   checked ${fmt(fresh.cashBhav.lastAttemptAt)}${fresh.cashBhav.lastError ? `   error: ${fresh.cashBhav.lastError}` : ""}`);
    console.log(`                  ${fresh.cashBhav.sessions} sessions stored, from ${fresh.cashBhav.firstSession ?? "—"}`);
    console.log(`  F&O bhavcopy    last session ${fresh.foBhav.lastSession ?? "—"}   checked ${fmt(fresh.foBhav.lastAttemptAt)}${fresh.foBhav.lastError ? `   error: ${fresh.foBhav.lastError}` : ""}`);
    console.log(`                  ${fresh.foBhav.sessions} sessions stored, from ${fresh.foBhav.firstSession ?? "—"}`);
    console.log(`  lot sizes       ${fresh.lots.count} (${fresh.lots.source ?? "—"})   fetched ${fmt(fresh.lots.lastSuccessAt)}`);
    console.log(`  F&O ban         for ${fresh.foBan.tradeDate ?? "—"}   fetched ${fmt(fresh.foBan.lastSuccessAt)}`);
    console.log(`  results (PR)    last session ${fresh.resultsCalendar.lastSession ?? "—"}   checked ${fmt(fresh.resultsCalendar.lastAttemptAt)}${fresh.resultsCalendar.lastError ? `   error: ${fresh.resultsCalendar.lastError}` : ""}`);
    console.log(`                  ${fresh.resultsCalendar.upcoming} upcoming events; ${fresh.resultsCalendar.sessions} sessions stored, from ${fresh.resultsCalendar.firstSession ?? "—"}`);
    console.log("\nCandles:");
    if (!fresh.candles.length) console.log("  none stored yet");
    for (const row of fresh.candles) console.log(`  ${row.tf.padEnd(4)} ${String(row.series).padStart(5)} series ${String(row.candles).padStart(9)} candles   newest ${row.lastSession ?? "—"}`);
    const now = Date.now();
    const symbols = [...DEFAULT_INDICES, ...getUniverse(db, "fno", now).members.map((m) => m.symbol).filter((s) => !DEFAULT_INDICES.includes(s))];
    console.log(`\nCoverage of the F&O universe + indices (${symbols.length} symbols):`);
    for (const tf of BACKFILL_TFS) {
      const years = maxYears(tf);
      const want = { from: now - years * 365 * DAY_MS, to: finalBefore(tf, now) };
      const stored = symbols.filter((symbol) => hub.history.isStored(symbol, tf, want)).length;
      console.log(`  ${tf.padEnd(4)} ${years}y: ${stored}/${symbols.length} stored`);
    }
    const live = hub.live.status();
    const recovery = live.recovery?.last;
    console.log(`\nLive prices: ${live.enabled ? "on" : "off"}; persistent ${live.persistent.map((entry) => entry.symbol).join(", ") || "none"}`);
    console.log(`  last tick ${fmt(live.store.previousRun.lastTickAt)}   recovery: ${live.recovery ? `${live.recovery.pending} task(s) queued, last run ${recovery ? `${fmt(recovery.startedAt)} (${recovery.calls} calls, ${recovery.bars} bars${recovery.error ? `, stopped: ${recovery.error}` : ""})` : "never"}` : "—"}`);
    const jobs = listJobs(db, 5);
    console.log("\nRecent jobs:");
    if (!jobs.length) console.log("  none");
    for (const job of jobs) console.log(`  ${jobLine(job)}`);
    return 0;
  }

  if (action === "backup") {
    // Safe while the server runs: SQLite's online backup copies a consistent snapshot.
    const dir = path.resolve(flag(rest, "--to") ?? config.backupDir ?? "backups");
    const keepRaw = flag(rest, "--keep");
    const keep = keepRaw === undefined ? config.backupKeep : Number(keepRaw);
    if (!Number.isInteger(keep) || keep < 1) {
      console.error("--keep must be a whole number of at least 1.");
      return 1;
    }
    const result = await backupDb(db, dir, keep, Date.now(), { minFreeBytes: config.diskMinBytes });
    console.log(`Backed up to ${result.file} (${(result.bytes / 1e6).toFixed(1)} MB gzipped from ${(result.dbBytes / 1e6).toFixed(1)} MB, checked).${result.removed.length ? ` Removed ${result.removed.length} older backup(s); keeping ${keep}.` : ""}`);
    console.log(`Restore: stop the hub, \`gunzip -c ${result.file} > ${path.join(config.dataDir, "hub.db")}\`, delete hub.db-wal and hub.db-shm next to it, start the hub.`);
    return 0;
  }

  if (action === "import-tradex") {
    const file = flag(rest, "--db");
    if (!file) {
      console.error("--db <path to Tradex's .cache/market.db> is required.");
      return 1;
    }
    const dryRun = rest.includes("--dry-run");
    try {
      const report = importTradexLocked(config.dataDir, {
        db,
        tradexDb: path.resolve(file),
        screenerDir: flag(rest, "--screener") ? path.resolve(flag(rest, "--screener")!) : null,
        dryRun,
        progress: (line) => process.stderr.write(`\r${line}   `),
      });
      process.stderr.write("\r");
      for (const line of formatImportReport(report)) console.log(line);
      if (dryRun) console.log("\nRun again without --dry-run to import (with the hub server stopped).");
      return 0;
    } catch (error) {
      if (error instanceof ImportError) {
        console.error(error.message);
        return 1;
      }
      throw error;
    }
  }

  if (action === "cancel") {
    const ok = cancelJob(db, Number(rest[0]));
    console.log(ok ? `Cancelled job #${rest[0]}.` : `No queued, paused or running job #${rest[0] ?? ""}.`);
    return ok ? 0 : 1;
  }
  console.log(USAGE);
  return 1;
}

async function run(args: string[]): Promise<number> {
  const [group, action, ...rest] = args;
  if ((group !== "keys" && group !== "data") || !action) {
    console.log(USAGE);
    return group ? 1 : 0;
  }
  const db = openDb(loadConfig().dataDir);
  try {
    return group === "keys" ? keys(db, action, rest) : await data(db, action, rest);
  } catch (error) {
    console.error((error as Error).message);
    return 1;
  } finally {
    db.close();
  }
}

run(process.argv.slice(2)).then((code) => process.exit(code));
