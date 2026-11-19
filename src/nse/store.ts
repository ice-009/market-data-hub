import type { Db } from "../db.js";
import type { CashBhavRow } from "./parsers/cashBhav.js";
import type { FoDayRecord, FoLeg } from "./parsers/foBhav.js";
import type { ResultsEvent } from "./parsers/results.js";
import type { SymbolChangeRow } from "./parsers/symbolChange.js";

// Storage for NSE's daily files (migration 2). Day-by-day datasets (cash and
// F&O bhavcopy, the PR zip) record every weekday checked in `nse_days`:
//   ok        file read and stored
//   holiday   NSE has no file for that day
//   mismatch  NSE served a file for another date (treated as no data, re-checked
//             by the evening run in case NSE fixes it)
// so backfills and catch-up never ask NSE for the same day twice. Point-in-time
// F&O membership is "has a fo_futures row that day". (F&O tables ported from
// Tradex's foBhavStore, MIT.)

/** `pr` is the daily PR zip (its board meetings fill the results calendar). */
export type DayDataset = "cash_bhav" | "fo_bhav" | "pr";
export type DayStatus = "ok" | "holiday" | "mismatch";
export type DatasetName = DayDataset | "lots" | "fo_ban" | "symbol_changes";

export function checkedDays(db: Db, dataset: DayDataset, from = Number.MIN_SAFE_INTEGER): Map<number, DayStatus> {
  const rows = db.prepare("select day, status from nse_days where dataset = ? and day >= ?").all(dataset, from) as Array<{ day: number; status: DayStatus }>;
  return new Map(rows.map((row) => [row.day, row.status]));
}

/**
 * Day statuses with one correction: on an exchange holiday NSE can serve the
 * previous session's cash file (recorded as `mismatch`) while the F&O file is
 * simply missing (`holiday`). A cash (or PR zip) mismatch on a day the F&O file
 * confirms as a holiday is a holiday — otherwise the day is re-asked all evening
 * and daily candles can't be extended across it (seen on Diwali, 10 Nov 2026).
 */
export function dayStatuses(db: Db, dataset: DayDataset, from = Number.MIN_SAFE_INTEGER): Map<number, DayStatus> {
  const days = checkedDays(db, dataset, from);
  if (dataset === "fo_bhav") return days;
  const fo = checkedDays(db, "fo_bhav", from);
  for (const [day, status] of days) if (status === "mismatch" && fo.get(day) === "holiday") days.set(day, "holiday");
  return days;
}

export function markDay(db: Db, dataset: DayDataset, day: number, status: DayStatus, rows: number, checkedAt: number, note: string | null = null) {
  db.prepare(
    `insert into nse_days (dataset, day, status, rows, checked_at, note) values (?, ?, ?, ?, ?, ?)
     on conflict(dataset, day) do update set status = excluded.status, rows = excluded.rows, checked_at = excluded.checked_at, note = excluded.note`,
  ).run(dataset, day, status, rows, checkedAt, note);
}

/** Newest day stored ("ok") for a dataset, optionally before `before`. */
export function lastOkDay(db: Db, dataset: DayDataset, before = Number.MAX_SAFE_INTEGER): number | null {
  const row = db.prepare("select max(day) as day from nse_days where dataset = ? and status = 'ok' and day < ?").get(dataset, before) as { day: number | null };
  return row.day;
}

/** Sessions stored ("ok") for a dataset, and the oldest one. */
export function storedDays(db: Db, dataset: DayDataset): { sessions: number; first: number | null } {
  const row = db.prepare("select count(*) as sessions, min(day) as first from nse_days where dataset = ? and status = 'ok'").get(dataset) as { sessions: number; first: number | null };
  return row;
}

// ------------------------------------------------------------------ cash bhavcopy

export function writeCashDay(db: Db, day: number, rows: CashBhavRow[], checkedAt: number) {
  const insert = db.prepare("insert or replace into cash_bhav (symbol, day, series, prev_close, o, h, l, c, v, deliv_pct) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  db.transaction(() => {
    db.prepare("delete from cash_bhav where day = ?").run(day);
    for (const row of rows) insert.run(row.symbol, day, row.series, row.prevClose, row.open, row.high, row.low, row.close, row.volume, row.deliveryPct);
    markDay(db, "cash_bhav", day, "ok", rows.length, checkedAt);
  })();
}

/** Closes per symbol from the cash bhavcopy, for days from <= day <= to. */
export function cashCloses(db: Db, symbols: string[], from: number, to: number): Map<string, Map<number, number>> {
  const out = new Map<string, Map<number, number>>();
  const statement = db.prepare("select day, c from cash_bhav where symbol = ? and day between ? and ? order by day");
  for (const symbol of symbols) {
    const rows = statement.all(symbol, from, to) as Array<{ day: number; c: number }>;
    out.set(symbol, new Map(rows.map((row) => [row.day, row.c])));
  }
  return out;
}

// ------------------------------------------------------------------ F&O bhavcopy

interface FoRow {
  day: number;
  symbol: string;
  nse_symbol: string;
  expiries: number;
  lot: number | null;
  underlying: number | null;
  near_expiry: number;
  near_close: number;
  near_settle: number;
  near_prev_close: number;
  near_volume: number;
  near_oi: number;
  near_chg_oi: number;
  next_expiry: number | null;
  next_close: number | null;
  next_settle: number | null;
  next_prev_close: number | null;
  next_volume: number | null;
  next_oi: number | null;
  next_chg_oi: number | null;
  oi: number;
  chg_oi: number;
}

const toRecord = (row: FoRow): FoDayRecord => ({
  day: row.day,
  symbol: row.symbol,
  nseSymbol: row.nse_symbol,
  expiries: row.expiries,
  lot: row.lot,
  underlying: row.underlying,
  near: { expiry: row.near_expiry, close: row.near_close, settle: row.near_settle, prevClose: row.near_prev_close, volume: row.near_volume, oi: row.near_oi, chgOi: row.near_chg_oi },
  next:
    row.next_expiry === null
      ? null
      : { expiry: row.next_expiry, close: row.next_close ?? 0, settle: row.next_settle ?? 0, prevClose: row.next_prev_close ?? 0, volume: row.next_volume ?? 0, oi: row.next_oi ?? 0, chgOi: row.next_chg_oi ?? 0 },
  oi: row.oi,
  chgOi: row.chg_oi,
});

const legParams = (prefix: "near" | "next", leg: FoLeg | null) => ({
  [`${prefix}_expiry`]: leg?.expiry ?? null,
  [`${prefix}_close`]: leg?.close ?? null,
  [`${prefix}_settle`]: leg?.settle ?? null,
  [`${prefix}_prev_close`]: leg?.prevClose ?? null,
  [`${prefix}_volume`]: leg?.volume ?? null,
  [`${prefix}_oi`]: leg?.oi ?? null,
  [`${prefix}_chg_oi`]: leg?.chgOi ?? null,
});

/** Replace one trade day's F&O records and mark the day "ok". */
export function writeFoDay(db: Db, day: number, records: FoDayRecord[], checkedAt: number) {
  const insert = db.prepare(
    `insert into fo_futures (day, symbol, nse_symbol, expiries, lot, underlying,
       near_expiry, near_close, near_settle, near_prev_close, near_volume, near_oi, near_chg_oi,
       next_expiry, next_close, next_settle, next_prev_close, next_volume, next_oi, next_chg_oi, oi, chg_oi)
     values (@day, @symbol, @nse_symbol, @expiries, @lot, @underlying,
       @near_expiry, @near_close, @near_settle, @near_prev_close, @near_volume, @near_oi, @near_chg_oi,
       @next_expiry, @next_close, @next_settle, @next_prev_close, @next_volume, @next_oi, @next_chg_oi, @oi, @chg_oi)`,
  );
  db.transaction(() => {
    db.prepare("delete from fo_futures where day = ?").run(day);
    for (const record of records) {
      insert.run({
        day,
        symbol: record.symbol,
        nse_symbol: record.nseSymbol,
        expiries: record.expiries,
        lot: record.lot,
        underlying: record.underlying,
        ...legParams("near", record.near),
        ...legParams("next", record.next),
        oi: record.oi,
        chg_oi: record.chgOi,
      });
    }
    markDay(db, "fo_bhav", day, "ok", records.length, checkedAt);
  })();
}

/** One underlying's stored days with from <= day <= to, oldest first. */
export function readFoSymbol(db: Db, symbol: string, from: number, to: number): FoDayRecord[] {
  return (db.prepare("select * from fo_futures where symbol = ? and day between ? and ? order by day").all(symbol, from, to) as FoRow[]).map(toRecord);
}

/** Every underlying's record on one stored trade day, by symbol. */
export function readFoDay(db: Db, day: number): FoDayRecord[] {
  return (db.prepare("select * from fo_futures where day = ? order by symbol").all(day) as FoRow[]).map(toRecord);
}

/** One underlying's record on the newest stored F&O day (null when it had no futures that day, or nothing is stored). */
export function latestFoRecord(db: Db, symbol: string): { day: number; record: FoDayRecord | null } | null {
  const day = lastOkDay(db, "fo_bhav");
  if (day === null) return null;
  const row = db.prepare("select * from fo_futures where day = ? and symbol = ?").get(day, symbol) as FoRow | undefined;
  return { day, record: row ? toRecord(row) : null };
}

/** The F&O list on every stored trade day with from <= day <= to, oldest first. */
export function foMembersBetween(db: Db, from: number, to: number): Array<{ day: number; symbols: string[] }> {
  const rows = db
    .prepare(
      `select f.day, f.symbol from fo_futures f
       join nse_days d on d.dataset = 'fo_bhav' and d.day = f.day and d.status = 'ok'
       where f.day between ? and ? order by f.day, f.symbol`,
    )
    .all(from, to) as Array<{ day: number; symbol: string }>;
  const out: Array<{ day: number; symbols: string[] }> = [];
  for (const row of rows) {
    const last = out[out.length - 1];
    if (last?.day === row.day) last.symbols.push(row.symbol);
    else out.push({ day: row.day, symbols: [row.symbol] });
  }
  return out;
}

/** The newest stored F&O trade day on or before `day`, with its underlyings. */
export function foMembersOn(db: Db, day: number): { day: number; symbols: string[] } | null {
  const row = db.prepare("select max(day) as day from nse_days where dataset = 'fo_bhav' and status = 'ok' and day <= ?").get(day) as { day: number | null };
  if (row.day === null) return null;
  const symbols = (db.prepare("select symbol from fo_futures where day = ? order by symbol").all(row.day) as Array<{ symbol: string }>).map((r) => r.symbol);
  return { day: row.day, symbols };
}

/** Lot per underlying on the newest stored F&O day (fallback when NSE's lot file is unavailable). */
export function lotsFromFoBhav(db: Db): Record<string, number> {
  const last = lastOkDay(db, "fo_bhav");
  if (last === null) return {};
  const rows = db.prepare("select symbol, lot from fo_futures where day = ? and lot > 0").all(last) as Array<{ symbol: string; lot: number }>;
  return Object.fromEntries(rows.map((row) => [row.symbol, row.lot]));
}

// ------------------------------------------------------------------ lots, ban, results

export function writeLots(db: Db, lots: Record<string, number>) {
  const insert = db.prepare("insert into lot_sizes (symbol, lot) values (?, ?)");
  db.transaction(() => {
    db.prepare("delete from lot_sizes").run();
    for (const [symbol, lot] of Object.entries(lots)) insert.run(symbol, lot);
  })();
}

export function readLots(db: Db): Record<string, number> {
  const rows = db.prepare("select symbol, lot from lot_sizes order by symbol").all() as Array<{ symbol: string; lot: number }>;
  return Object.fromEntries(rows.map((row) => [row.symbol, row.lot]));
}

export function writeBan(db: Db, tradeDate: number, symbols: string[], fetchedAt: number) {
  db.prepare("insert into fo_ban (trade_date, symbols, fetched_at) values (?, ?, ?) on conflict(trade_date) do update set symbols = excluded.symbols, fetched_at = excluded.fetched_at").run(tradeDate, JSON.stringify(symbols), fetchedAt);
}

export function latestBan(db: Db): { tradeDate: number; symbols: string[]; fetchedAt: number } | null {
  const row = db.prepare("select trade_date, symbols, fetched_at from fo_ban order by trade_date desc limit 1").get() as { trade_date: number; symbols: string; fetched_at: number } | undefined;
  return row ? { tradeDate: row.trade_date, symbols: JSON.parse(row.symbols) as string[], fetchedAt: row.fetched_at } : null;
}

/**
 * Add or update results events. Each PR zip lists only the meetings announced
 * that day, so nothing is deleted: a meeting announced again (a new purpose, say)
 * replaces its earlier row.
 */
export function writeResults(db: Db, events: ResultsEvent[]) {
  const insert = db.prepare("insert or replace into results_events (symbol, date, company, purpose) values (?, ?, ?, ?)");
  db.transaction(() => {
    for (const event of events) insert.run(event.symbol, event.date, event.company, event.purpose);
  })();
}

/** Store one PR zip's results events and mark its day "ok". */
export function writePrDay(db: Db, day: number, events: ResultsEvent[], checkedAt: number) {
  db.transaction(() => {
    writeResults(db, events);
    markDay(db, "pr", day, "ok", events.length, checkedAt);
  })();
}

/** Results events dated on or after `from`. */
export function countResults(db: Db, from: number): number {
  return (db.prepare("select count(*) as n from results_events where date >= ?").get(from) as { n: number }).n;
}

export function readResults(db: Db, from: number, to: number, symbol?: string): ResultsEvent[] {
  const rows = symbol
    ? db.prepare("select * from results_events where date between ? and ? and symbol = ? order by date, symbol").all(from, to, symbol)
    : db.prepare("select * from results_events where date between ? and ? order by date, symbol").all(from, to);
  return rows as ResultsEvent[];
}

// ------------------------------------------------------------------ ticker renames (migration 5)

/** Replace the stored list with NSE's symbolchange.csv as just downloaded. */
export function writeSymbolChanges(db: Db, rows: SymbolChangeRow[]) {
  const insert = db.prepare("insert or ignore into symbol_changes (old_symbol, new_symbol, day, company) values (?, ?, ?, ?)");
  db.transaction(() => {
    db.prepare("delete from symbol_changes").run();
    for (const row of rows) insert.run(row.oldSymbol, row.newSymbol, row.day, row.company);
  })();
}

export function readSymbolChanges(db: Db): SymbolChangeRow[] {
  const rows = db.prepare("select old_symbol, new_symbol, day, company from symbol_changes order by day, old_symbol").all() as Array<{ old_symbol: string; new_symbol: string; day: number; company: string }>;
  return rows.map((row) => ({ oldSymbol: row.old_symbol, newSymbol: row.new_symbol, day: row.day, company: row.company }));
}

/**
 * Record which ticker each ISIN traded under on `day` (an old-format cash day),
 * widening each (ISIN, ticker) pair's first/last day, and mark the day read.
 * Idempotent: reading a day twice changes nothing.
 */
export function writeIsins(db: Db, day: number, rows: ReadonlyArray<{ symbol: string; isin?: string }>) {
  const upsert = db.prepare(
    `insert into isin_symbols (isin, symbol, first_day, last_day) values (?, ?, ?, ?)
     on conflict(isin, symbol) do update set first_day = min(first_day, excluded.first_day), last_day = max(last_day, excluded.last_day)`,
  );
  let isins = 0;
  db.transaction(() => {
    for (const row of rows) {
      if (!row.isin) continue;
      upsert.run(row.isin, row.symbol, day, day);
      isins += 1;
    }
    db.prepare("insert or replace into isin_days (day, isins) values (?, ?)").run(day, isins);
  })();
}

/** Old-format cash days whose ISINs have been read, from `from` on. */
export function isinDaysRead(db: Db, from = Number.MIN_SAFE_INTEGER): Set<number> {
  return new Set((db.prepare("select day from isin_days where day >= ?").all(from) as Array<{ day: number }>).map((row) => row.day));
}

export interface IsinUse {
  isin: string;
  symbol: string;
  firstDay: number;
  lastDay: number;
}

/** Every ISIN seen under more than one ticker, with each ticker's first and last stored day; by ISIN, oldest use first. */
export function sharedIsins(db: Db): IsinUse[] {
  const rows = db
    .prepare(
      `select isin, symbol, first_day, last_day from isin_symbols
       where isin in (select isin from isin_symbols group by isin having count(*) > 1)
       order by isin, first_day, symbol`,
    )
    .all() as Array<{ isin: string; symbol: string; first_day: number; last_day: number }>;
  return rows.map((row) => ({ isin: row.isin, symbol: row.symbol, firstDay: row.first_day, lastDay: row.last_day }));
}

export function isinStats(db: Db): { pairs: number; days: number } {
  const pairs = (db.prepare("select count(*) as n from isin_symbols").get() as { n: number }).n;
  const days = (db.prepare("select count(*) as n from isin_days where isins > 0").get() as { n: number }).n;
  return { pairs, days };
}

/** A ticker's stored cash-bhavcopy sessions with from <= day < until (null = open-ended). */
export function cashSpan(db: Db, symbol: string, from: number | null, until: number | null): { first: number; last: number; sessions: number } | null {
  const row = db.prepare("select min(day) as first, max(day) as last, count(*) as sessions from cash_bhav where symbol = ? and day >= ? and day < ?").get(symbol, from ?? Number.MIN_SAFE_INTEGER, until ?? Number.MAX_SAFE_INTEGER) as { first: number | null; last: number | null; sessions: number };
  return row.first === null || row.last === null ? null : { first: row.first, last: row.last, sessions: row.sessions };
}

/** Stored cash sessions strictly between two days. */
export function cashSessionsBetween(db: Db, after: number, before: number): number {
  return (db.prepare("select count(*) as n from nse_days where dataset = 'cash_bhav' and status = 'ok' and day > ? and day < ?").get(after, before) as { n: number }).n;
}

// ------------------------------------------------------------------ run bookkeeping

export interface DatasetRun {
  name: DatasetName;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  info: Record<string, unknown> | null;
}

export function recordRun(db: Db, name: DatasetName, outcome: { at: number; ok: boolean; error?: string | null; info?: Record<string, unknown> }) {
  db.prepare(
    `insert into datasets (name, last_attempt_at, last_success_at, last_error, info) values (@name, @at, @success, @error, @info)
     on conflict(name) do update set last_attempt_at = excluded.last_attempt_at,
       last_success_at = coalesce(excluded.last_success_at, datasets.last_success_at),
       last_error = excluded.last_error, info = coalesce(excluded.info, datasets.info)`,
  ).run({ name, at: outcome.at, success: outcome.ok ? outcome.at : null, error: outcome.ok ? null : (outcome.error ?? "failed"), info: outcome.info ? JSON.stringify(outcome.info) : null });
}

export function readRuns(db: Db): Map<DatasetName, DatasetRun> {
  const rows = db.prepare("select * from datasets").all() as Array<{ name: DatasetName; last_attempt_at: number | null; last_success_at: number | null; last_error: string | null; info: string | null }>;
  return new Map(rows.map((row) => [row.name, { name: row.name, lastAttemptAt: row.last_attempt_at, lastSuccessAt: row.last_success_at, lastError: row.last_error, info: row.info ? (JSON.parse(row.info) as Record<string, unknown>) : null }]));
}
