import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { Bar } from "../broker/fyers.js";
import type { Db } from "../db.js";
import { readBars, readSeries, writeBars } from "../history/store.js";
import { finalBefore, type BaseTf } from "../history/timeframes.js";
import { checkedDays, markDay, type DayStatus } from "../nse/store.js";
import { acquireOwner, ownerPid } from "../owner.js";
import { DAY_MS, isoDay, istDayKey } from "../time.js";
import { bhavFileDay, checkBhavDay, cleanBhav, mapSeriesKey, planMerge, prepareSeries, sameBhav, type CleanBhavRow, type ImportTf } from "./tradexMap.js";

// `hub data import-tradex`: bring the data a Tradex install already downloaded
// into the hub, so moving Tradex onto the hub costs no broker calls:
//   candles      Tradex's market.db `series` + `candles` (Fyers history: D, 15, 5)
//   cash_bhav    Tradex's cached NSE cash bhavcopies (.cache/screener/bhav/*.json),
//                each checked against daily candles first (Tradex never checked
//                the date inside NSE's file, and NSE serves another day's file
//                for some holidays)
//   F&O          Tradex's `fo_bhav_days` + `fo_futures` (same parser, same
//                columns as the hub's — a straight copy)
// Tradex's files are opened read-only. Each series and each day is written in
// its own transaction, and anything the hub already has wins, so an import can
// be stopped and run again: a second run changes nothing. The mapping rules
// are in ./tradexMap.ts.

export const IMPORT_NOTE = "imported from Tradex";
/** Tradex's bhav cache kept EQ rows (BE when a stock had no EQ row) without saying which. */
export const IMPORTED_SERIES = "EQ/BE";

export interface ImportOptions {
  /** The hub database to write into. */
  db: Db;
  /** Path to Tradex's market.db (opened read-only). */
  tradexDb: string;
  /** Tradex's .cache/screener directory (bhav/ and daily/), optional. */
  screenerDir?: string | null;
  dryRun: boolean;
  now?: number;
  /** Called every few series with a progress line. */
  progress?: (line: string) => void;
}

export interface TfTotals {
  series: number;
  bars: number;
  from: number | null;
  to: number | null;
}

export interface Skipped {
  item: string;
  reason: string;
}

export interface ImportReport {
  dryRun: boolean;
  candles: {
    /** Tradex series seen. */
    seen: number;
    /** Written (or, in a dry run, would be): per hub timeframe, range = coverage claimed. */
    imported: Record<ImportTf, TfTotals>;
    /** Series the hub already had in full. */
    unchanged: number;
    /** Bars left out: still forming when Tradex stored them, or outside the covered range. */
    droppedBars: number;
    skipped: Skipped[];
  };
  cashBhav: {
    files: number;
    imported: { days: number; holidays: number; rows: number; from: number | null; to: number | null };
    unchanged: number;
    badRows: number;
    skipped: Skipped[];
  } | null;
  /** What the screener's per-symbol daily files hold that isn't imported (they carry no coverage record). */
  screenerDaily: { files: number; withoutDbSeries: number; deliveryOutsideBhav: number } | null;
  fo: {
    days: number;
    imported: { ok: number; holiday: number; mismatch: number; rows: number; from: number | null; to: number | null };
    unchanged: number;
    skipped: Skipped[];
  } | null;
  notes: string[];
}

export class ImportError extends Error {
  constructor(
    message: string,
    readonly code: "owner_busy" | "bad_source",
  ) {
    super(message);
  }
}

const emptyTotals = (): TfTotals => ({ series: 0, bars: 0, from: null, to: null });
const widen = (totals: { from: number | null; to: number | null }, from: number, to: number) => {
  totals.from = totals.from === null ? from : Math.min(totals.from, from);
  totals.to = totals.to === null ? to : Math.max(totals.to, to);
};

function openTradex(file: string): Database.Database {
  if (!existsSync(file)) throw new ImportError(`No Tradex database at ${file}.`, "bad_source");
  let source: Database.Database;
  try {
    source = new Database(file, { readonly: true, fileMustExist: true });
    source.prepare("select count(*) from sqlite_master").get();
  } catch (error) {
    throw new ImportError(`Couldn't open ${file} read-only (${(error as Error).message}). Stop Tradex, or import from a copy (copy market.db together with its -wal and -shm files).`, "bad_source");
  }
  return source;
}

const hasTable = (source: Database.Database, name: string) => Boolean(source.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(name));

/**
 * Import, refusing while another process (a running hub server) owns the data
 * directory: the import writes, and the owner is the only writer. A dry run
 * only reads, so it may run alongside the server.
 */
export function importTradexLocked(dataDir: string, options: ImportOptions): ImportReport {
  if (options.dryRun) return importTradex(options);
  const release = acquireOwner(dataDir);
  if (!release) throw new ImportError(`A hub process (pid ${ownerPid(dataDir) ?? "?"}) owns ${dataDir}. Stop the hub, run the import, then start it again.`, "owner_busy");
  try {
    return importTradex(options);
  } finally {
    release();
  }
}

export function importTradex(options: ImportOptions): ImportReport {
  const source = openTradex(options.tradexDb);
  try {
    const report: ImportReport = {
      dryRun: options.dryRun,
      candles: { seen: 0, imported: { "1d": emptyTotals(), "15m": emptyTotals(), "5m": emptyTotals() }, unchanged: 0, droppedBars: 0, skipped: [] },
      cashBhav: null,
      screenerDaily: null,
      fo: null,
      notes: [],
    };
    if (hasTable(source, "series") && hasTable(source, "candles")) importCandles(source, options, report);
    else report.notes.push("No candle tables in the Tradex database.");
    if (options.screenerDir) importScreener(source, options, report);
    if (hasTable(source, "fo_bhav_days") && hasTable(source, "fo_futures")) importFo(source, options, report);
    else report.notes.push("No F&O bhavcopy tables in the Tradex database (Tradex's F&O history import was never run).");
    return report;
  } finally {
    source.close();
  }
}

// ------------------------------------------------------------------ candles

interface TradexSeriesRow {
  key: string;
  covered_from: number;
  synced_at: number;
  count: number;
}

function importCandles(source: Database.Database, options: ImportOptions, report: ImportReport) {
  const { db, dryRun } = options;
  const rows = source.prepare("select key, covered_from, synced_at, count from series order by key").all() as TradexSeriesRow[];
  const readTradex = source.prepare("select t, o, h, l, c, v from candles where key = ? order by t");
  const totals = report.candles;
  totals.seen = rows.length;
  rows.forEach((row, index) => {
    if (index % 25 === 0) options.progress?.(`candles: ${index}/${rows.length} series`);
    const mapped = mapSeriesKey(row.key);
    if (!mapped.ok) return void totals.skipped.push({ item: row.key, reason: mapped.reason });
    const prepared = prepareSeries(mapped.tf, { coveredFrom: row.covered_from, syncedAt: row.synced_at }, readTradex.all(row.key) as Bar[]);
    if (!prepared.ok) return void totals.skipped.push({ item: row.key, reason: prepared.reason });
    // Read the hub's side and write in one transaction, so nothing changes in between.
    const decision = db.transaction(() => {
      const meta = readSeries(db, mapped.symbol, mapped.tf);
      const coverage = meta?.coverage ?? null;
      const overlap = coverage ? readBars(db, mapped.symbol, mapped.tf, Math.max(coverage.from, prepared.claimed.from), Math.min(coverage.to, prepared.claimed.to)) : [];
      const plan = planMerge(coverage, overlap, prepared.claimed, prepared.bars);
      if (plan.action === "write" && !dryRun) writeBars(db, mapped.symbol, mapped.tf, plan.bars, plan.coverage, Math.max(meta?.syncedAt ?? 0, row.synced_at));
      return plan;
    })();
    if (decision.action === "skip") return void totals.skipped.push({ item: row.key, reason: decision.reason });
    if (decision.action === "unchanged") return void (totals.unchanged += 1);
    const tf = totals.imported[mapped.tf];
    tf.series += 1;
    tf.bars += decision.bars.length;
    totals.droppedBars += prepared.dropped;
    widen(tf, prepared.claimed.from, prepared.claimed.to);
  });
}

// ------------------------------------------------------------------ cash bhavcopy (screener cache)

interface BhavFile {
  day: number;
  holiday: boolean;
  rows: CleanBhavRow[];
  bad: number;
}

function readBhavFiles(dir: string, skipped: Skipped[]): BhavFile[] {
  const files: BhavFile[] = [];
  for (const name of readdirSync(dir).sort()) {
    const day = bhavFileDay(name);
    if (day === null) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path.join(dir, name), "utf8"));
    } catch {
      skipped.push({ item: isoDay(day), reason: `${name} isn't valid JSON` });
      continue;
    }
    if (parsed === null) files.push({ day, holiday: true, rows: [], bad: 0 });
    else if (typeof parsed === "object" && !Array.isArray(parsed)) files.push({ day, holiday: false, ...cleanBhav(parsed as Record<string, unknown>) });
    else skipped.push({ item: isoDay(day), reason: `${name} isn't a bhavcopy` });
  }
  return files.sort((a, b) => a.day - b.day);
}

/**
 * Daily closes per day from stored daily candles (Tradex's and the hub's), for
 * checking bhav files. A day maps to null when no stored equity series covers it.
 */
function dailyCloses(source: Database.Database, db: Db, days: number[]): Map<number, Map<string, number> | null> {
  const out = new Map<number, Map<string, number> | null>();
  if (!days.length) return out;
  // Tradex's equity daily series with the range of final bars each proves (a bar stored mid-session is no reference).
  const tradex = new Map<string, { symbol: string; from: number; to: number }>();
  if (hasTable(source, "series") && hasTable(source, "candles")) {
    for (const row of source.prepare("select key, covered_from, synced_at, last_t from series where key like 'NSE:%-EQ:D'").all() as Array<{ key: string; covered_from: number; synced_at: number; last_t: number | null }>) {
      const mapped = mapSeriesKey(row.key);
      if (mapped.ok && row.last_t !== null) tradex.set(row.key, { symbol: mapped.symbol, from: row.covered_from, to: Math.min(istDayKey(row.last_t) + DAY_MS, finalBefore("1d", row.synced_at)) });
    }
  }
  const tradexCloses = tradex.size ? source.prepare("select key, c from candles where key like 'NSE:%-EQ:D' and t = ?") : null;
  const hubCovers = db.prepare("select count(*) as n from series where tf = '1d' and covered_from <= ? and covered_to > ?");
  const hubCloses = db.prepare("select c.symbol, c.c from candles c join series s on s.symbol = c.symbol and s.tf = c.tf where c.tf = '1d' and c.t = ? and s.covered_to > c.t");
  for (const day of days) {
    const covered = [...tradex.values()].some((range) => range.from <= day && day < range.to) || (hubCovers.get(day, day) as { n: number }).n > 0;
    if (!covered) {
      out.set(day, null);
      continue;
    }
    const closes = new Map<string, number>();
    for (const row of (tradexCloses?.all(day) ?? []) as Array<{ key: string; c: number }>) {
      const range = tradex.get(row.key);
      if (range && day < range.to) closes.set(range.symbol, row.c);
    }
    for (const row of hubCloses.all(day) as Array<{ symbol: string; c: number }>) closes.set(row.symbol, row.c);
    out.set(day, closes);
  }
  return out;
}

function importScreener(source: Database.Database, options: ImportOptions, report: ImportReport) {
  const { db, dryRun } = options;
  const dir = options.screenerDir!;
  const bhavDir = path.join(dir, "bhav");
  const cash: NonNullable<ImportReport["cashBhav"]> = { files: 0, imported: { days: 0, holidays: 0, rows: 0, from: null, to: null }, unchanged: 0, badRows: 0, skipped: [] };
  report.cashBhav = cash;
  if (!existsSync(bhavDir)) report.notes.push(`No bhav/ folder in ${dir}: no cash bhavcopy to import.`);
  const files = existsSync(bhavDir) ? readBhavFiles(bhavDir, cash.skipped) : [];
  cash.files = files.length;
  const closes = dailyCloses(source, db, files.map((file) => file.day));
  const hub = checkedDays(db, "cash_bhav");
  const valid = new Set<number>();
  const insert = db.prepare("insert or replace into cash_bhav (symbol, day, series, prev_close, o, h, l, c, v, deliv_pct) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const now = options.now ?? Date.now();

  // First pass: which files are what they say they are.
  for (const file of files) {
    const dayCloses = closes.get(file.day) ?? null;
    if (file.holiday) {
      if (dayCloses?.size) cash.skipped.push({ item: isoDay(file.day), reason: "Tradex recorded no file, but daily candles have a session that day" });
      else valid.add(file.day);
      continue;
    }
    const check = checkBhavDay(file.rows, dayCloses);
    if (!check.ok) cash.skipped.push({ item: isoDay(file.day), reason: check.reason });
    else valid.add(file.day);
  }
  // A file identical to another day's that the candles can't tell apart: NSE served one for both.
  const trading = files.filter((file) => !file.holiday);
  trading.forEach((file, index) => {
    for (const other of [trading[index - 1], trading[index + 1]]) {
      if (!other || !valid.has(file.day) || !valid.has(other.day) || !sameBhav(file.rows, other.rows)) continue;
      cash.skipped.push({ item: isoDay(file.day), reason: `same rows as ${isoDay(other.day)}; the stored candles can't tell which day it is` });
      cash.skipped.push({ item: isoDay(other.day), reason: `same rows as ${isoDay(file.day)}; the stored candles can't tell which day it is` });
      valid.delete(file.day);
      valid.delete(other.day);
    }
  });

  for (const file of files) {
    if (!valid.has(file.day)) continue;
    if (hub.has(file.day)) {
      cash.unchanged += 1;
      continue;
    }
    if (!dryRun) {
      db.transaction(() => {
        if (file.holiday) return markDay(db, "cash_bhav", file.day, "holiday", 0, now, IMPORT_NOTE);
        for (const row of file.rows) insert.run(row.symbol, file.day, IMPORTED_SERIES, row.prevClose, row.open, row.high, row.low, row.close, row.volume, row.deliveryPct);
        markDay(db, "cash_bhav", file.day, "ok", file.rows.length, now, IMPORT_NOTE);
      })();
    }
    if (file.holiday) cash.imported.holidays += 1;
    else {
      cash.imported.days += 1;
      cash.imported.rows += file.rows.length;
      cash.badRows += file.bad;
      widen(cash.imported, file.day, file.day);
    }
  }
  report.screenerDaily = screenerDaily(source, dir, files.filter((file) => valid.has(file.day) && !file.holiday).map((file) => file.day));
}

/** Count what the per-symbol daily files hold beyond the database and the bhav files (reported, not imported). */
function screenerDaily(source: Database.Database, dir: string, bhavDays: number[]): ImportReport["screenerDaily"] {
  const dailyDir = path.join(dir, "daily");
  if (!existsSync(dailyDir)) return null;
  const withSeries = new Set<string>();
  if (hasTable(source, "series")) {
    for (const row of source.prepare("select key from series where key like '%:D'").all() as Array<{ key: string }>) {
      const mapped = mapSeriesKey(row.key);
      if (mapped.ok) withSeries.add(mapped.symbol);
    }
  }
  const bhav = new Set(bhavDays);
  const result = { files: 0, withoutDbSeries: 0, deliveryOutsideBhav: 0 };
  for (const name of readdirSync(dailyDir)) {
    if (!name.endsWith(".json")) continue;
    result.files += 1;
    const symbol = decodeURIComponent(name.slice(0, -5));
    if (!withSeries.has(symbol)) result.withoutDbSeries += 1;
    try {
      const rows = JSON.parse(readFileSync(path.join(dailyDir, name), "utf8")) as unknown[];
      for (const row of Array.isArray(rows) ? rows : []) if (Array.isArray(row) && typeof row[6] === "number" && !bhav.has(row[0] as number)) result.deliveryOutsideBhav += 1;
    } catch {
      // unreadable file: nothing to count
    }
  }
  return result;
}

// ------------------------------------------------------------------ F&O bhavcopy

interface TradexFoDay {
  day: number;
  status: DayStatus;
  underlyings: number;
  checked_at: number;
  note: string | null;
}

const FO_COLUMNS = [
  "day", "symbol", "nse_symbol", "expiries", "lot", "underlying",
  "near_expiry", "near_close", "near_settle", "near_prev_close", "near_volume", "near_oi", "near_chg_oi",
  "next_expiry", "next_close", "next_settle", "next_prev_close", "next_volume", "next_oi", "next_chg_oi", "oi", "chg_oi",
] as const;

function importFo(source: Database.Database, options: ImportOptions, report: ImportReport) {
  const { db, dryRun } = options;
  const days = source.prepare("select day, status, underlyings, checked_at, note from fo_bhav_days order by day").all() as TradexFoDay[];
  const fo: NonNullable<ImportReport["fo"]> = { days: days.length, imported: { ok: 0, holiday: 0, mismatch: 0, rows: 0, from: null, to: null }, unchanged: 0, skipped: [] };
  report.fo = fo;
  const hub = checkedDays(db, "fo_bhav");
  const readDay = source.prepare(`select ${FO_COLUMNS.join(", ")} from fo_futures where day = ? order by symbol`);
  const insert = db.prepare(`insert into fo_futures (${FO_COLUMNS.join(", ")}) values (${FO_COLUMNS.map((name) => `@${name}`).join(", ")})`);
  for (const day of days) {
    const label = isoDay(day.day);
    if (!["ok", "holiday", "mismatch"].includes(day.status)) {
      fo.skipped.push({ item: label, reason: `unknown status "${day.status}"` });
      continue;
    }
    const existing = hub.get(day.day);
    // The hub's own record stands, except that a stored file beats "no file".
    if (existing === "ok" || (existing !== undefined && day.status !== "ok")) {
      fo.unchanged += 1;
      continue;
    }
    const rows = day.status === "ok" ? (readDay.all(day.day) as Array<Record<string, unknown>>) : [];
    if (day.status === "ok" && (!rows.length || rows.length !== day.underlyings)) {
      fo.skipped.push({ item: label, reason: `${rows.length} rows stored but the day record says ${day.underlyings}` });
      continue;
    }
    if (!dryRun) {
      db.transaction(() => {
        db.prepare("delete from fo_futures where day = ?").run(day.day);
        for (const row of rows) insert.run(row);
        markDay(db, "fo_bhav", day.day, day.status, rows.length, day.checked_at, day.note ? `${IMPORT_NOTE}: ${day.note}` : IMPORT_NOTE);
      })();
    }
    fo.imported[day.status] += 1;
    if (day.status === "ok") {
      fo.imported.rows += rows.length;
      widen(fo.imported, day.day, day.day);
    }
  }
}

// ------------------------------------------------------------------ report

const day = (t: number | null) => (t === null ? "—" : isoDay(t));
const instant = (tf: BaseTf, t: number | null) => (t === null ? "—" : tf === "1d" ? isoDay(t) : `${new Date(t).toISOString().slice(0, 16).replace("T", " ")} UTC`);

/** Group skips by reason, so 200 identical lines read as one. */
function skippedLines(skipped: Skipped[], indent: string): string[] {
  const byReason = new Map<string, string[]>();
  for (const skip of skipped) byReason.set(skip.reason, [...(byReason.get(skip.reason) ?? []), skip.item]);
  return [...byReason].map(([reason, items]) => `${indent}${items.length} × ${reason}: ${items.slice(0, 6).join(", ")}${items.length > 6 ? ", …" : ""}`);
}

/** The import report as terminal lines (`hub data import-tradex`). */
export function formatImportReport(report: ImportReport): string[] {
  const verb = report.dryRun ? "would import" : "imported";
  const lines: string[] = [report.dryRun ? "DRY RUN — nothing was written." : "Import finished.", ""];
  const c = report.candles;
  lines.push(`Candles: ${c.seen} Tradex series`);
  for (const tf of ["1d", "15m", "5m"] as const) {
    const t = c.imported[tf];
    lines.push(`  ${tf.padEnd(4)} ${verb} ${t.series} series, ${t.bars} bars${t.series ? `, coverage ${instant(tf, t.from)} → ${instant(tf, t.to)} (exclusive)` : ""}`);
  }
  lines.push(`  already stored in the hub: ${c.unchanged} series`);
  lines.push(`  bars left out (still forming when Tradex stored them): ${c.droppedBars}`);
  if (c.skipped.length) lines.push(`  skipped ${c.skipped.length} series:`, ...skippedLines(c.skipped, "    "));
  if (report.cashBhav) {
    const b = report.cashBhav;
    lines.push("", `Cash bhavcopy (delivery %): ${b.files} cached files`);
    lines.push(`  ${verb} ${b.imported.days} trading days (${b.imported.rows} rows, ${day(b.imported.from)} → ${day(b.imported.to)}) and ${b.imported.holidays} holidays`);
    lines.push(`  already in the hub: ${b.unchanged} days${b.badRows ? `; unreadable rows left out: ${b.badRows}` : ""}`);
    if (b.skipped.length) lines.push(`  skipped ${b.skipped.length} days:`, ...skippedLines(b.skipped, "    "));
  }
  if (report.screenerDaily) {
    const s = report.screenerDaily;
    lines.push(`  screener daily files: ${s.files} (not imported — no coverage record; their bars come from the same broker history and bhav files)`);
    lines.push(`    symbols with no daily series in market.db: ${s.withoutDbSeries} (the hub downloads them on first request or with \`hub data backfill\`)`);
    lines.push(`    delivery % values on days without an importable bhav file: ${s.deliveryOutsideBhav}`);
  }
  if (report.fo) {
    const f = report.fo;
    lines.push("", `F&O bhavcopy: ${f.days} checked days in Tradex`);
    lines.push(`  ${verb} ${f.imported.ok} trading days (${f.imported.rows} rows, ${day(f.imported.from)} → ${day(f.imported.to)}), ${f.imported.holiday} holidays, ${f.imported.mismatch} mismatched files`);
    lines.push(`  already in the hub: ${f.unchanged} days`);
    if (f.skipped.length) lines.push(`  skipped ${f.skipped.length} days:`, ...skippedLines(f.skipped, "    "));
  }
  if (report.notes.length) lines.push("", ...report.notes.map((note) => `Note: ${note}`));
  return lines;
}
