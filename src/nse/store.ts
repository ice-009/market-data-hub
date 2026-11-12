import type { Db } from "../db.js";
import type { CashBhavRow } from "./parsers/cashBhav.js";
import type { FoDayRecord, FoLeg } from "./parsers/foBhav.js";
import type { ResultsEvent } from "./parsers/results.js";

// Storage for NSE's daily files (migration 2). Day-by-day datasets (cash and
// F&O bhavcopy) record every weekday checked in `nse_days`:
//   ok        file read and stored
//   holiday   NSE has no file for that day
//   mismatch  NSE served a file for another date (treated as no data, re-checked
//             by the evening run in case NSE fixes it)
// so backfills and catch-up never ask NSE for the same day twice. Point-in-time
// F&O membership is "has a fo_futures row that day". (F&O tables ported from
// Tradex's foBhavStore, MIT.)

export type DayDataset = "cash_bhav" | "fo_bhav";
export type DayStatus = "ok" | "holiday" | "mismatch";
export type DatasetName = DayDataset | "lots" | "fo_ban" | "results";

export function checkedDays(db: Db, dataset: DayDataset, from = Number.MIN_SAFE_INTEGER): Map<number, DayStatus> {
  const rows = db.prepare("select day, status from nse_days where dataset = ? and day >= ?").all(dataset, from) as Array<{ day: number; status: DayStatus }>;
  return new Map(rows.map((row) => [row.day, row.status]));
}

/**
 * Cash-bhavcopy day statuses with one correction: on an exchange holiday NSE can
 * serve the previous session's cash file (recorded as `mismatch`) while the F&O
 * file is simply missing (`holiday`). A cash mismatch on a day the F&O file
 * confirms as a holiday is a holiday — otherwise the day is re-asked all evening
 * and daily candles can't be extended across it (seen on Diwali, 10 Nov 2026).
 */
export function cashDayStatuses(db: Db, from = Number.MIN_SAFE_INTEGER): Map<number, DayStatus> {
  const cash = checkedDays(db, "cash_bhav", from);
  const fo = checkedDays(db, "fo_bhav", from);
  for (const [day, status] of cash) if (status === "mismatch" && fo.get(day) === "holiday") cash.set(day, "holiday");
  return cash;
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

/** Replace the events in the window the download covered (from its earliest date on). */
export function writeResults(db: Db, events: ResultsEvent[]) {
  if (!events.length) return;
  const from = Math.min(...events.map((event) => event.date));
  const insert = db.prepare("insert or replace into results_events (symbol, date, company, purpose) values (?, ?, ?, ?)");
  db.transaction(() => {
    db.prepare("delete from results_events where date >= ?").run(from);
    for (const event of events) insert.run(event.symbol, event.date, event.company, event.purpose);
  })();
}

export function readResults(db: Db, from: number, to: number, symbol?: string): ResultsEvent[] {
  const rows = symbol
    ? db.prepare("select * from results_events where date between ? and ? and symbol = ? order by date, symbol").all(from, to, symbol)
    : db.prepare("select * from results_events where date between ? and ? order by date, symbol").all(from, to);
  return rows as ResultsEvent[];
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
