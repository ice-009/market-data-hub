import path from "node:path";
import { backupDb } from "./backup.js";
import { gb, shortOfSpace } from "./disk.js";
import { createKey, listKeys, parseScopes, revokeKey } from "./auth/keys.js";
import { calendarStatus, calendarWarnings, hhmm, parseHours } from "./calendar/calendar.js";
import { removeOverride, setOverride, syncCalendar } from "./calendar/store.js";
import { brokerConfigured, loadConfig, secretValues } from "./config.js";
import { openDb, type Db } from "./db.js";
import { checkAdjustments, REASONS } from "./history/adjustCheck.js";
import { checkSeams } from "./history/seamCheck.js";
import { factorStats, lastAdjustmentRun, listingFactors, rederiveAll } from "./history/adjustments.js";
import { BACKFILL_TFS, BASE, finalBefore, type BaseTf } from "./history/timeframes.js";
import { hubHealth } from "./health.js";
import { createHub } from "./hub.js";
import { ImportError, formatImportReport, importTradexLocked } from "./import/tradex.js";
import { DEFAULT_INDICES, cancelJob, enqueueBackfill, enqueueJob, listJobs, maxYears, recoverJobs, runBackfill, validateBackfill, type Job, type NseHistoryParams } from "./jobs/backfill.js";
import { HISTORY_DATASETS, HISTORY_LABEL, lastHistoryDay, runNseHistory, validateNseHistory } from "./jobs/nseHistory.js";
import { createLogger } from "./log.js";
import { acquireOwner, ownerPid } from "./owner.js";
import { listingOf, loadRenames, storedListing } from "./reference/renames.js";
import { getUniverse } from "./reference/universe.js";
import { brokerStatus, dataFreshness, dataMode, diskStatus } from "./status.js";
import { ARCHIVE_FROM, refreshSymbolChanges } from "./nse/datasets.js";
import { checkDerivedLots, deriveStoredLots, lotHistory, lotSources } from "./nse/lotHistory.js";
import { readRuns } from "./nse/store.js";
import { logFindings, runQuality } from "./quality/run.js";
import { CHECKS, readFindings, type CheckName } from "./quality/store.js";
import { qualitySummary } from "./quality/summary.js";
import { DAY_MS, isoDay, istParts, parseIsoDay } from "./time.js";

// Admin CLI, run on the machine that hosts the hub (it opens the database
// directly; there is no remote admin API).
//   npm run hub -- keys create tradex --scopes history,live,fo
//   npm run hub -- keys list
//   npm run hub -- keys revoke key_1a2b3c4d5e6f
//   npm run hub -- data backfill --tf 1d --years 5 [--symbols SBIN,INFY]
//   npm run hub -- data nse-history [--from 1994-11-03] [--to 2024-07-05] [--only cash|fo|pr|indices|ban|options]
//   npm run hub -- data lots [SBIN …] [--derive] [--check]
//   npm run hub -- data status
//   npm run hub -- data quality [--full] [--check price_outlier] [--all]
//   npm run hub -- data calendar [--from 2026-01-01] [--to 2026-12-31]
//   npm run hub -- data calendar holiday 2027-01-26 "Republic Day"
//   npm run hub -- data calendar session 2027-02-01 "Union Budget" [--hours 09:15-15:30]
//   npm run hub -- data calendar remove 2027-01-26
//   npm run hub -- data symbols [INFY TMPV …] [--date 2005-01-03] [--refresh]
//   npm run hub -- data adjustments [INFY …] [--rebuild] [--check [--symbols A,B] [--tolerance 0.005] [--json]]
//   npm run hub -- data history --check [--symbols A,B] [--tolerance 0.01] [--json]
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
  hub data nse-history [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--only cash|fo|pr|indices|ban|options]
  hub data lots [SYMBOL …] [--derive] [--check]
  hub data status
  hub data symbols [SYMBOL …] [--date YYYY-MM-DD] [--refresh]
  hub data adjustments [SYMBOL …] [--rebuild] [--check [--symbols A,B,…] [--tolerance 0.005] [--json]]
  hub data history --check [--symbols A,B,…] [--tolerance 0.01] [--json]
  hub data cancel <job id>
  hub data backup [--to <dir>] [--keep N]
  hub data import-tradex --db <market.db> [--screener <dir>] [--dry-run]
  hub data quality [--full] [--check <name>] [--all] [--resolved] [--limit N]
  hub data calendar [--from YYYY-MM-DD] [--to YYYY-MM-DD]
  hub data calendar holiday|session YYYY-MM-DD "name" [--hours HH:MM-HH:MM]
  hub data calendar remove YYYY-MM-DD`;

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

/**
 * `data quality`: run the data-quality checks on what's stored (they only read
 * and write the database, so this works while the server runs too), then list
 * the open problems and warnings. `--full` checks every stored day again.
 */
function quality(db: Db, rest: string[]): number {
  const check = flag(rest, "--check");
  if (check !== undefined && !CHECKS.includes(check as CheckName)) {
    console.error(`--check must be one of ${CHECKS.join(", ")}.`);
    return 1;
  }
  const limitRaw = flag(rest, "--limit");
  const limit = limitRaw === undefined ? 40 : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1) {
    console.error("--limit must be a whole number of at least 1.");
    return 1;
  }
  const full = rest.includes("--full");
  if (full) console.log("Checking every stored day again (the whole archive takes a minute or two)…");
  const result = runQuality(db, { full });
  console.log(`Checked ${result.checkedDays} day(s) in ${(result.ms / 1000).toFixed(1)} s; ${result.fresh.length} new finding(s).${result.waitingDays ? ` ${result.waitingDays} stored day(s) wait for the sessions before them (an NSE history download in progress).` : ""}`);
  const summary = qualitySummary(db);
  console.log(`Open findings: ${summary.open.problem} problem(s), ${summary.open.warning} warning(s), ${summary.open.info} info.`);
  for (const row of summary.checks) console.log(`  ${row.check.padEnd(18)} ${row.severity.padEnd(8)} ${String(row.count).padStart(6)}   newest ${row.newestDate}`);
  const findings = readFindings(db, { check: check as CheckName | undefined, severity: rest.includes("--all") ? "info" : "warning", status: rest.includes("--resolved") ? "resolved" : "open", limit });
  console.log(findings.length ? "" : "\nNothing to list.");
  const mark = { problem: "✗", warning: "!", info: "·" } as const;
  for (const finding of findings) console.log(`${mark[finding.severity]} ${isoDay(finding.day)} ${finding.check}: ${finding.message}`);
  return 0;
}

/**
 * `data calendar`: list the trading calendar's holidays and special sessions
 * (a year by default), or add / remove a day by hand. The running server picks
 * a change up within a minute.
 */
function calendarCommand(db: Db, rest: string[]): number {
  const [verb, date, ...more] = rest;
  if (verb === "holiday" || verb === "session" || verb === "remove") {
    const day = parseIsoDay(date ?? "");
    if (day === null) {
      console.error(`hub data calendar ${verb} needs a date like 2027-01-26.`);
      return 1;
    }
    if (verb === "remove") {
      const removed = removeOverride(db, day);
      console.log(removed ? `Removed the calendar entry for ${isoDay(day)}; it follows NSE's list and archive again.` : `No calendar entry for ${isoDay(day)} was added by hand.`);
      return removed ? 0 : 1;
    }
    const name = more.find((arg, i) => !arg.startsWith("--") && more[i - 1] !== "--hours")?.trim() || null;
    const hoursRaw = flag(more, "--hours");
    const hours = hoursRaw === undefined ? null : parseHours(hoursRaw);
    if (hoursRaw !== undefined && (verb !== "session" || !hours)) {
      console.error("--hours goes with a session, as 14:20-15:30 (IST).");
      return 1;
    }
    setOverride(db, { day, kind: verb, name, hours });
    const info = syncCalendar(db).info(day);
    console.log(verb === "holiday" ? `${isoDay(day)} is now an exchange holiday${name ? ` (${name})` : ""}: the evening run won't ask NSE for its files, and live prices make no bars that day.` : `${isoDay(day)} now has a session${name ? ` (${name})` : ""}, ${hhmm(info.hours!.open)}–${hhmm(info.hours!.close)} IST: the evening run asks NSE for its files.`);
    console.log("A running hub server picks this up within a minute.");
    return 0;
  }
  if (verb !== undefined && !verb.startsWith("--")) {
    console.log(USAGE);
    return 1;
  }
  const cal = syncCalendar(db);
  const now = Date.now();
  const status = calendarStatus(now, cal);
  const year = Number(status.today.slice(0, 4));
  const from = parseIsoDay(flag(rest, "--from") ?? `${year}-01-01`);
  const to = parseIsoDay(flag(rest, "--to") ?? `${year}-12-31`);
  if (from === null || to === null || from > to) {
    console.error("--from and --to must be dates like 2026-01-01, --from first.");
    return 1;
  }
  console.log(`Today ${status.today}: ${status.tradingDay ? `a trading day (${status.session?.open}–${status.session?.close} IST)` : status.holiday ? `an exchange holiday${status.holiday.name ? ` (${status.holiday.name})` : ""}` : "no session"}; next trading day ${status.nextTradingDay}.`);
  console.log(`NSE holiday lists: ${status.listedYears.length ? status.listedYears.join(", ") : "none"} (other years: holidays from NSE's archive).`);
  for (const warning of calendarWarnings(now, cal)) console.log(`  ! ${warning}`);
  let trading = 0;
  const lines: string[] = [];
  for (let day = from; day <= to; day += DAY_MS) {
    const info = cal.info(day);
    if (info.trading) trading += 1;
    if (info.kind === "holiday" || (info.kind === "weekend" && info.name)) lines.push(`  ${isoDay(day)}  holiday   ${(info.name ?? "—").padEnd(44)} ${info.source}${info.kind === "weekend" ? " (weekend)" : ""}`);
    else if (info.kind === "special") lines.push(`  ${isoDay(day)}  session   ${(info.name ?? "—").padEnd(44)} ${info.source}, ${hhmm(info.hours!.open)}–${hhmm(info.hours!.close)} IST`);
  }
  console.log(`\n${isoDay(from)} – ${isoDay(to)}: ${trading} trading days.`);
  for (const line of lines) console.log(line);
  return 0;
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
    if (!brokerConfigured(config.secrets)) {
      console.error("No broker is configured: this hub runs in end-of-day mode, and backfills download from the broker. Daily candles come from NSE's files instead — `hub data nse-history` downloads more of them.");
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
    const ONLY: Record<string, NseHistoryParams["datasets"]> = { cash: ["cash_bhav"], fo: ["fo_bhav"], pr: ["pr"], indices: ["index_close"], ban: ["fo_ban"], options: ["options"] };
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
      // The server checks each new day itself; here no server is running, so check the downloaded days now.
      const quality = runQuality(db);
      logFindings(log, quality.fresh);
      console.log(`Data quality: checked ${quality.checkedDays} day(s), ${quality.fresh.length} new finding(s)${quality.pendingDays ? `, ${quality.pendingDays} day(s) waiting for earlier sessions` : ""}. See \`hub data quality\`.`);
      return final.state === "error" ? 1 : 0;
    } finally {
      process.off("SIGINT", stop);
      release();
    }
  }

  if (action === "quality") return quality(db, rest);
  if (action === "calendar") return calendarCommand(db, rest);

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
    const checks = qualitySummary(db);
    console.log(`Data quality: ${checks.open.problem} problem(s), ${checks.open.warning} warning(s), ${checks.open.info} info open${checks.pendingDays ? `; ${checks.pendingDays} day(s) not checked yet` : ""} (\`hub data quality\` lists them)`);
    console.log("");
    const mode = dataMode(hub);
    console.log(`Mode: ${mode.modeLabel}${mode.modeNote ? ` — ${mode.modeNote}` : ""}`);
    console.log(`Owner process: ${pid ? `pid ${pid}` : "none (no hub server running)"}`);
    const today = calendarStatus(Date.now());
    console.log(`Calendar: today ${today.today} ${today.tradingDay ? "is a trading day" : today.holiday ? `is an exchange holiday${today.holiday.name ? ` (${today.holiday.name})` : ""}` : "has no session"}; next trading day ${today.nextTradingDay}; NSE holiday lists for ${today.listedYears.join(", ") || "no year"} (\`hub data calendar\`)`);
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
    console.log(`  option summaries  last session ${fresh.options.lastSession ?? "—"}   ${fresh.options.sessions} sessions, from ${fresh.options.firstSession ?? "—"} (\`hub data nse-history --only options\`)`);
    console.log(`  lot sizes       ${fresh.lots.count} (${fresh.lots.source ?? "—"})   fetched ${fmt(fresh.lots.lastSuccessAt)}`);
    console.log(`  F&O ban         for ${fresh.foBan.tradeDate ?? "—"}   fetched ${fmt(fresh.foBan.lastSuccessAt)}`);
    console.log(`                  ${fresh.foBan.sessions} trade dates stored, from ${fresh.foBan.firstSession ?? "—"}`);
    console.log(`  results (PR)    last session ${fresh.resultsCalendar.lastSession ?? "—"}   checked ${fmt(fresh.resultsCalendar.lastAttemptAt)}${fresh.resultsCalendar.lastError ? `   error: ${fresh.resultsCalendar.lastError}` : ""}`);
    console.log(`                  ${fresh.resultsCalendar.upcoming} upcoming events; ${fresh.resultsCalendar.sessions} sessions stored, from ${fresh.resultsCalendar.firstSession ?? "—"}`);
    console.log(`  symbol changes  ${fresh.symbolChanges.count} renames   fetched ${fmt(fresh.symbolChanges.lastSuccessAt)}   ISINs read for ${fresh.symbolChanges.isins.days} days`);
    const adjustments = factorStats(db);
    console.log(`  adjustments     ${adjustments.factors} split/bonus factors for ${adjustments.symbols} tickers   derived ${fmt(lastAdjustmentRun(db)?.derivedAt ?? null)}   ${adjustments.corporateActions} corporate actions from ${adjustments.corporateActionDays} PR days`);
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

  if (action === "symbols") {
    if (rest.includes("--refresh")) {
      const release = acquireOwner(config.dataDir);
      if (!release) console.log(`The running hub (pid ${ownerPid(config.dataDir) ?? "?"}) owns the NSE connection and refreshes NSE's list each evening; showing what is stored.`);
      else {
        try {
          const hub = createHub({ config, db, log, owner: true });
          const ok = await refreshSymbolChanges(hub.nse);
          const run = readRuns(db).get("symbol_changes");
          console.log(ok ? `Downloaded NSE's symbol changes: ${String(run?.info?.count ?? 0)} renames.` : `Couldn't download NSE's symbol changes: ${run?.lastError ?? "unknown error"}`);
          if (!ok) return 1;
        } finally {
          release();
        }
      }
    }
    if (!readRuns(db).get("symbol_changes")?.lastSuccessAt) {
      console.error("NSE's list of ticker changes isn't stored yet: run `hub data symbols --refresh` (or start the hub, which fetches it).");
      return 1;
    }
    const dateRaw = flag(rest, "--date");
    const day = dateRaw === undefined ? istParts().day : parseIsoDay(dateRaw);
    if (day === null) {
      console.error("--date must be a date like 2005-01-03.");
      return 1;
    }
    const named = rest.filter((arg, i) => !arg.startsWith("--") && rest[i - 1] !== "--date").map((arg) => arg.trim().toUpperCase());
    const renames = loadRenames(db);
    const describe = (symbol: string) => {
      const listing = listingOf(db, symbol, day, renames);
      const stored = storedListing(db, listing);
      const names = stored.names.map((name) => `${name.symbol} (${name.from === null ? "…" : isoDay(name.from)} → ${name.until === null ? "…" : isoDay(name.until - DAY_MS)}; ${name.stored ? `stored ${isoDay(name.stored.first)}–${isoDay(name.stored.last)}, ${name.stored.sessions} sessions` : "nothing stored"})`);
      const joins = stored.continuous.map((continuous, i) => `${listing.changes[i].oldSymbol} → ${listing.changes[i].newSymbol} ${isoDay(listing.changes[i].day)} [${listing.changes[i].source}]: ${continuous === null ? "not stored on both sides" : continuous ? "continuous" : "GAP"}`);
      return { listing, stored, lines: [`${symbol}${listing.match === "exact" ? "" : ` (${listing.match})`} → ${listing.current}`, ...names.map((line) => `    ${line}`), ...joins.map((line) => `    ${line}`)] };
    };
    if (named.length) {
      for (const symbol of named) for (const line of describe(symbol).lines) console.log(line);
      return 0;
    }
    // No tickers given: every current F&O stock's history across its renames (ice-009/tradex-public#16).
    const members = getUniverse(db, "fno").members.map((member) => member.symbol);
    const renamed = members.map(describe).filter((entry) => entry.listing.changes.length);
    const gaps = renamed.filter((entry) => entry.stored.continuous.includes(false));
    const unknown = renamed.filter((entry) => entry.stored.continuous.includes(null));
    console.log(`F&O stocks: ${members.length}; ${renamed.length} renamed at least once (${renames.changes.length} renames known). Continuous across every rename: ${renamed.length - gaps.length - unknown.length}; with a gap: ${gaps.length}; not stored on both sides: ${unknown.length}.`);
    for (const entry of renamed) for (const line of entry.lines) console.log(line);
    return gaps.length ? 1 : 0;
  }

  if (action === "history") {
    // What /v1/candles serves before the broker's window, joined to it (#22): the seam, jumps and gaps across renames.
    if (!rest.includes("--check")) {
      console.error("Usage: hub data history --check [--symbols A,B,…] [--tolerance 0.01] [--json]");
      return 1;
    }
    const symbolsRaw = flag(rest, "--symbols");
    const toleranceRaw = flag(rest, "--tolerance");
    const tolerance = toleranceRaw === undefined ? undefined : Number(toleranceRaw);
    if (tolerance !== undefined && !(tolerance > 0 && tolerance < 0.5)) {
      console.error("--tolerance must be a fraction like 0.01 (1%).");
      return 1;
    }
    if (!brokerConfigured(config.secrets)) console.log("Note: no broker is configured, so stored daily series were built from the archive itself; the check is meaningful against a broker's series.");
    const report = checkSeams(db, Date.now(), { symbols: symbolsRaw ? symbolsRaw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean) : undefined, tolerance });
    const failed = report.problems.seam + report.problems.jump + report.problems.gap;
    if (rest.includes("--json")) {
      console.log(JSON.stringify(report, null, 2));
      return failed ? 1 : 0;
    }
    console.log(`Seam ${report.seam} (the broker's window starts). Stocks: ${report.symbols}; with archive history before it: ${report.checked}; joined across a rename: ${report.renamed}.`);
    console.log(`Archive scaled to the broker's level: ${report.scaled} (median |gap| ${report.medianAbsGapPct ?? "—"}%). Problems — seam ${report.problems.seam}, jump ${report.problems.jump}, gap ${report.problems.gap}.`);
    for (const row of report.rows) {
      if (!row.problems.length && row.scale === 1 && row.names.length < 2) continue;
      console.log(`  ${row.symbol.padEnd(12)} ${row.names.join(" → ").padEnd(26)} from ${row.archiveFrom} to ${row.handover}  scale ×${row.scale} (gap ${row.gapPct ?? "—"}%)  after: ${row.compared} sessions, max ${row.maxDiffPct ?? "—"}%  jump ${row.jumpPct ?? "—"}%${row.missing.length ? `  missing ${row.missing.join(", ")}` : ""}${row.problems.length ? `  [${row.problems.join(", ")}]` : ""}`);
    }
    return failed ? 1 : 0;
  }

  if (action === "adjustments") {
    if (rest.includes("--rebuild")) {
      const started = Date.now();
      const derived = rederiveAll(db, { endOfDay: !brokerConfigured(config.secrets), now: started });
      console.log(`Derived ${derived.factors} split/bonus factors in ${((Date.now() - started) / 1000).toFixed(1)} s (${Object.entries(derived.bySource).map(([source, n]) => `${source} ${n}`).join(", ")}); ${derived.changed.length} tickers changed${derived.reset.length ? `, ${derived.reset.length} stored daily series dropped (end-of-day mode)` : ""}.`);
    }
    if (rest.includes("--check")) {
      const symbolsRaw = flag(rest, "--symbols");
      const toleranceRaw = flag(rest, "--tolerance");
      const tolerance = toleranceRaw === undefined ? undefined : Number(toleranceRaw);
      if (tolerance !== undefined && !(tolerance > 0 && tolerance < 0.5)) {
        console.error("--tolerance must be a fraction like 0.005 (0.5%).");
        return 1;
      }
      if (!brokerConfigured(config.secrets)) console.log("Note: no broker is configured, so stored daily series were built from these same factors; the check is meaningful against a broker's series.");
      const report = checkAdjustments(db, { symbols: symbolsRaw ? symbolsRaw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean) : undefined, tolerance });
      if (rest.includes("--json")) {
        console.log(JSON.stringify(report, null, 2));
        return report.byReason.unexplained ? 1 : 0;
      }
      const pct = (part: number, whole: number) => (whole ? `${((100 * part) / whole).toFixed(2)}%` : "—");
      console.log(`Broker daily series: ${report.symbols} stocks, ${report.overlapping} overlapping NSE's stored files (${report.overlapBars} sessions).`);
      console.log(`Adjusted closes matching the broker within ${(report.tolerance * 100).toFixed(2)}%: ${report.matchingBars}/${report.overlapBars} (${pct(report.matchingBars, report.overlapBars)}).`);
      console.log(`Ex-dates in the overlap (ours or the broker's): ${report.events}; agreeing: ${report.agreed} (${pct(report.agreed, report.events)}). Our factors there: ${Object.entries(report.derived).map(([source, n]) => `${source} ${n}`).join(", ")}.`);
      console.log(`Disagreements: ${report.disagreements.length}${report.disagreements.length ? ` — ${REASONS.filter((reason) => report.byReason[reason]).map((reason) => `${reason} ${report.byReason[reason]}`).join(", ")}` : ""}.`);
      for (const item of report.disagreements) {
        console.log(`  ${item.symbol.padEnd(12)} ${item.prevDate} → ${item.date}  broker ×${item.broker}  ours ×${item.derived}${item.source ? ` (${item.source})` : ""}  [${item.reason}] ${item.note}${item.actions.length ? `; NSE: ${item.actions.join(" · ")}` : ""}`);
      }
      return report.byReason.unexplained ? 1 : 0;
    }
    const named = rest.filter((arg, i) => !arg.startsWith("--") && rest[i - 1] !== "--symbols" && rest[i - 1] !== "--tolerance").map((arg) => arg.trim().toUpperCase());
    if (named.length) {
      const renames = loadRenames(db);
      for (const symbol of named) {
        const { listing, factors } = listingFactors(db, symbol, istParts().day, renames);
        console.log(`${symbol}${listing.current !== symbol ? ` → ${listing.current}` : ""}: ${factors.length} factor(s)${listing.names.length > 1 ? ` across ${listing.names.map((name) => name.symbol).join(" → ")}` : ""}`);
        for (const factor of factors) console.log(`  ${isoDay(factor.day)} ${factor.symbol.padEnd(12)} ×${factor.factor.toFixed(4)}  ${factor.source.padEnd(16)} close ${factor.prevC} (${isoDay(factor.prevDay)}) → open ${factor.o}, PREV_CLOSE ${factor.prevClose}${factor.renamedFrom ? `, renamed from ${factor.renamedFrom}` : ""}${factor.action ? `; NSE: ${factor.action}` : ""}`);
      }
      return 0;
    }
    const stats = factorStats(db);
    const run = lastAdjustmentRun(db);
    console.log(`Split/bonus factors: ${stats.factors} for ${stats.symbols} tickers${stats.first === null ? "" : `, ex-dates ${isoDay(stats.first)} – ${isoDay(stats.last!)}`} (${Object.entries(stats.bySource).map(([source, n]) => `${source} ${n}`).join(", ")}); last derived ${fmt(run?.derivedAt ?? null)}.`);
    console.log(`Corporate actions: ${stats.corporateActions} from ${stats.corporateActionDays} PR days' bc files.`);
    return 0;
  }

  if (action === "lots") {
    // Lots before NSE's files carried them (#49): derived from the stored open interest.
    if (rest.includes("--derive")) {
      const started = Date.now();
      const derived = deriveStoredLots(db);
      console.log(`Derived the lot of ${derived.days} old-format stock-days for ${derived.symbols} stocks${derived.first === null ? "" : ` (${isoDay(derived.first)} – ${isoDay(derived.last!)})`} in ${((Date.now() - started) / 1000).toFixed(1)} s; ${derived.low} with low confidence.`);
    }
    if (rest.includes("--check")) {
      const check = checkDerivedLots(db);
      const pct = (part: number, whole: number) => (whole ? `${((100 * part) / whole).toFixed(2)}%` : "—");
      console.log(`Derived against NSE's own lot column (${check.days} stock-days from 8 Jul 2024): high confidence ${check.highRight}/${check.high} right (${pct(check.highRight, check.high)}), low ${check.lowRight}/${check.low} right.`);
      for (const wrong of check.wrong) console.log(`  ${wrong.symbol.padEnd(12)} ${isoDay(wrong.day)}  derived ${wrong.derived}, NSE ${wrong.lot}`);
      if (check.wrong.length) return 1;
    }
    const named = rest.filter((arg) => !arg.startsWith("--")).map((arg) => arg.trim().toUpperCase());
    for (const symbol of named) {
      const changes = lotHistory(db, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, symbol)[symbol] ?? [];
      console.log(`${symbol}: ${changes.length ? `${changes.length} change point(s)` : "no lots stored"}`);
      for (const change of changes) console.log(`  ${isoDay(change.day)}  ${String(change.lot).padStart(7)}  ${change.source}${change.confidence === "low" ? " (low confidence)" : ""}`);
    }
    if (!named.length && !rest.includes("--derive") && !rest.includes("--check")) {
      const sources = lotSources(db);
      const span = (value: { from: number; to: number } | null) => (value ? `${isoDay(value.from)} – ${isoDay(value.to)}` : "none");
      console.log(`Lot history: NSE's lot column ${span(sources.bhavcopy)}; derived from open interest ${span(sources.derived)} (\`hub data lots --derive\` rebuilds it, \`--check\` compares it with NSE's column).`);
    }
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
