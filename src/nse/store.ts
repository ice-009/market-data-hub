import { calendar, type Calendar } from "../calendar/calendar.js";
import { isListedHoliday } from "../calendar/store.js";
import type { Db } from "../db.js";
import type { CashBhavRow } from "./parsers/cashBhav.js";
import { indexSymbolForName } from "../reference/indices.js";
import type { FoDayRecord, FoLeg } from "./parsers/foBhav.js";
import type { IndexCloseRow } from "./parsers/indexClose.js";
import { classifyPurpose, type ActionKind, type CorporateActionRow, type PricePart } from "./parsers/corporateActions.js";
import type { ResultsEvent } from "./parsers/results.js";
import type { SymbolChangeRow } from "./parsers/symbolChange.js";

// Storage for NSE's daily files (migrations 2 and 5). Day-by-day datasets (cash
// and F&O bhavcopy, the PR zip, the index file) record every weekday checked in `nse_days`:
//   ok        file read and stored
//   holiday   NSE has no file for that day
//   mismatch  NSE served a file for another date (treated as no data, re-checked
//             by the evening run in case NSE fixes it)
// so backfills and catch-up never ask NSE for the same day twice. Point-in-time
// F&O membership is "has a fo_futures row that day". (F&O tables ported from
// Tradex's foBhavStore, MIT.)

/**
 * `pr` is the daily PR zip (its board meetings fill the results calendar);
 * `index_close` NSE's index file; `fo_ban` the F&O ban list of each trade date
 * (the evening run stores the next session's, `hub data nse-history --only ban`
 * the archive's).
 */
export type DayDataset = "cash_bhav" | "fo_bhav" | "pr" | "index_close" | "fo_ban";
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

/**
 * What archive coverage and the adjustment factors count as checked: the day
 * statuses, plus every day the trading calendar names a holiday on the word of
 * NSE's list or a person (`hub data calendar holiday`; src/calendar/store.ts),
 * stored or not — a weekday NSE's archive can't settle is settled by hand, and
 * daily candles and pairs of sessions run across it (#59). Not for deciding
 * what to ask NSE: importDay records a listed holiday itself.
 */
export function coverageStatuses(db: Db, dataset: DayDataset, from = Number.MIN_SAFE_INTEGER, cal: Calendar = calendar()): Map<number, DayStatus> {
  const days = dayStatuses(db, dataset, from);
  for (const day of new Set([...cal.overrides.keys(), ...cal.listedHolidays.keys()])) {
    if (day >= from && days.get(day) !== "ok" && isListedHoliday(cal, day)) days.set(day, "holiday");
  }
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

// ------------------------------------------------------------------ index closes

/** Replace one trade day's index rows and mark the day "ok" (`note`: where they came from, when not the index file). */
export function writeIndexDay(db: Db, day: number, rows: IndexCloseRow[], checkedAt: number, note: string | null = null) {
  const insert = db.prepare(
    `insert or replace into index_closes (day, name, symbol, o, h, l, c, points_change, change_pct, volume, turnover_cr, pe, pb, div_yield)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  db.transaction(() => {
    db.prepare("delete from index_closes where day = ?").run(day);
    for (const row of rows) insert.run(day, row.name, indexSymbolForName(row.name), row.open, row.high, row.low, row.close, row.pointsChange, row.changePct, row.volume, row.turnoverCr, row.pe, row.pb, row.divYield);
    markDay(db, "index_close", day, "ok", rows.length, checkedAt, note);
  })();
}

/** Re-map stored names to hub symbols (after src/reference/indices.ts gains an alias). Returns the rows changed. */
export function remapIndexNames(db: Db): number {
  const stale = (db.prepare("select distinct name, symbol from index_closes").all() as Array<{ name: string; symbol: string | null }>).filter((row) => indexSymbolForName(row.name) !== row.symbol);
  const update = db.prepare("update index_closes set symbol = ? where name = ?");
  let changed = 0;
  db.transaction(() => {
    for (const row of stale) changed += update.run(indexSymbolForName(row.name), row.name).changes;
  })();
  return changed;
}

export interface IndexCloseDay {
  day: number;
  name: string;
  o: number | null;
  h: number | null;
  l: number | null;
  c: number;
  volume: number | null;
}

/** One hub symbol's stored rows with day >= from, oldest first (one per day). */
export function readIndexCloses(db: Db, symbol: string, from = Number.MIN_SAFE_INTEGER): IndexCloseDay[] {
  return db.prepare("select day, min(name) as name, o, h, l, c, volume from index_closes where symbol = ? and day >= ? group by day order by day").all(symbol, from) as IndexCloseDay[];
}

/** Names in the newest stored index file that the hub doesn't map to a symbol. */
export function unmappedIndexNames(db: Db): string[] {
  const last = lastOkDay(db, "index_close");
  if (last === null) return [];
  return (db.prepare("select name from index_closes where day = ? and symbol is null order by name").all(last) as Array<{ name: string }>).map((row) => row.name);
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

/** Store one trade date's ban list ([] = nobody in the ban) and record the day as stored. */
export function writeBan(db: Db, tradeDate: number, symbols: string[], fetchedAt: number) {
  db.transaction(() => {
    db.prepare("insert into fo_ban (trade_date, symbols, fetched_at) values (?, ?, ?) on conflict(trade_date) do update set symbols = excluded.symbols, fetched_at = excluded.fetched_at").run(tradeDate, JSON.stringify(symbols), fetchedAt);
    markDay(db, "fo_ban", tradeDate, "ok", symbols.length, fetchedAt);
  })();
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

// ------------------------------------------------------------------ corporate actions (migration 7)

/**
 * Add one PR zip's corporate actions (its bc file) and mark the day read. Each
 * file lists the actions near their ex-date, so the same action comes in on
 * several days: it is kept once, with the first and last PR day that listed it.
 * Nothing is deleted. Idempotent.
 */
export function writeCorporateActions(db: Db, day: number, rows: readonly CorporateActionRow[]) {
  const upsert = db.prepare(
    `insert into corporate_actions (symbol, ex_day, purpose, series, company, record_day, kinds, ratio, first_day, last_day)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(symbol, ex_day, purpose) do update set
       record_day = coalesce(excluded.record_day, corporate_actions.record_day),
       first_day = min(corporate_actions.first_day, excluded.first_day),
       last_day = max(corporate_actions.last_day, excluded.last_day)`,
  );
  db.transaction(() => {
    for (const row of rows) {
      const meaning = classifyPurpose(row.purpose);
      upsert.run(row.symbol, row.exDay, row.purpose, row.series, row.company, row.recordDay, meaning.kinds.join(","), meaning.ratio, day, day);
    }
    db.prepare("insert or replace into corporate_action_days (day, rows) values (?, ?)").run(day, rows.length);
  })();
}

/** PR days whose corporate-actions file has been read, from `from` on. */
export function corporateActionDaysRead(db: Db, from = Number.MIN_SAFE_INTEGER): Set<number> {
  return new Set((db.prepare("select day from corporate_action_days where day >= ?").all(from) as Array<{ day: number }>).map((row) => row.day));
}

export interface StoredCorporateAction {
  symbol: string;
  exDay: number;
  purpose: string;
  series: string;
  company: string;
  recordDay: number | null;
  kinds: ActionKind[];
  ratio: number | null;
  /** The bonus, split and consolidation the purpose names (classifyPurpose). */
  parts: PricePart[];
  /** One of them without its terms: the ratio comes from the price gap. */
  partial: boolean;
  firstDay: number;
  lastDay: number;
}

interface CorporateActionDbRow {
  symbol: string;
  ex_day: number;
  purpose: string;
  series: string;
  company: string;
  record_day: number | null;
  kinds: string;
  ratio: number | null;
  first_day: number;
  last_day: number;
}

// The purpose is read again on every read, so what the stored kinds and ratio
// say never lags the parser (refreshCorporateActions rewrites them for SQL readers).
const toAction = (row: CorporateActionDbRow): StoredCorporateAction => {
  const meaning = classifyPurpose(row.purpose);
  return {
    symbol: row.symbol,
    exDay: row.ex_day,
    purpose: row.purpose,
    series: row.series,
    company: row.company,
    recordDay: row.record_day,
    kinds: meaning.kinds,
    ratio: meaning.ratio,
    parts: meaning.parts,
    partial: meaning.partial,
    firstDay: row.first_day,
    lastDay: row.last_day,
  };
};

/**
 * Classify every stored purpose again with today's parser and rewrite the
 * stored kinds and ratio where they changed (after a parser fix: "BON
 * 1:1/SPLIT RS.10TORS.2" was stored as 0.5, is 0.1). Returns how many rows changed.
 */
export function refreshCorporateActions(db: Db): number {
  const rows = db.prepare("select symbol, ex_day, purpose, kinds, ratio from corporate_actions").all() as Array<Pick<CorporateActionDbRow, "symbol" | "ex_day" | "purpose" | "kinds" | "ratio">>;
  const update = db.prepare("update corporate_actions set kinds = ?, ratio = ? where symbol = ? and ex_day = ? and purpose = ?");
  let changed = 0;
  db.transaction(() => {
    for (const row of rows) {
      const meaning = classifyPurpose(row.purpose);
      const kinds = meaning.kinds.join(",");
      const same = kinds === row.kinds && (meaning.ratio === null ? row.ratio === null : row.ratio !== null && Math.abs(meaning.ratio - row.ratio) < 1e-12);
      if (same) continue;
      update.run(kinds, meaning.ratio, row.symbol, row.ex_day, row.purpose);
      changed += 1;
    }
  })();
  return changed;
}

/** Stored corporate actions with from <= ex-date <= to, for `symbols` (all when absent); by ex-date. */
export function readCorporateActions(db: Db, from: number, to: number, symbols?: readonly string[]): StoredCorporateAction[] {
  if (symbols && !symbols.length) return [];
  const rows = symbols
    ? (db.prepare(`select * from corporate_actions where ex_day between ? and ? and symbol in (${symbols.map(() => "?").join(",")}) order by ex_day, symbol, purpose`).all(from, to, ...symbols) as CorporateActionDbRow[])
    : (db.prepare("select * from corporate_actions where ex_day between ? and ? order by ex_day, symbol, purpose").all(from, to) as CorporateActionDbRow[]);
  return rows.map(toAction);
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
  /** Attempts that failed in a row (0 after a success). */
  failures: number;
  /** When the current run of failures began (null while the last attempt succeeded). */
  failingSince: number | null;
}

export function recordRun(db: Db, name: DatasetName, outcome: { at: number; ok: boolean; error?: string | null; info?: Record<string, unknown> }) {
  db.prepare(
    `insert into datasets (name, last_attempt_at, last_success_at, last_error, info, failures, failing_since)
     values (@name, @at, @success, @error, @info, @failed, case when @failed = 1 then @at end)
     on conflict(name) do update set last_attempt_at = excluded.last_attempt_at,
       last_success_at = coalesce(excluded.last_success_at, datasets.last_success_at),
       last_error = excluded.last_error, info = coalesce(excluded.info, datasets.info),
       failures = case when @failed = 1 then datasets.failures + 1 else 0 end,
       failing_since = case when @failed = 1 then coalesce(datasets.failing_since, @at) end`,
  ).run({ name, at: outcome.at, success: outcome.ok ? outcome.at : null, error: outcome.ok ? null : (outcome.error ?? "failed"), info: outcome.info ? JSON.stringify(outcome.info) : null, failed: outcome.ok ? 0 : 1 });
}

export function readRuns(db: Db): Map<DatasetName, DatasetRun> {
  const rows = db.prepare("select * from datasets").all() as Array<{ name: DatasetName; last_attempt_at: number | null; last_success_at: number | null; last_error: string | null; info: string | null; failures: number; failing_since: number | null }>;
  return new Map(
    rows.map((row) => [
      row.name,
      { name: row.name, lastAttemptAt: row.last_attempt_at, lastSuccessAt: row.last_success_at, lastError: row.last_error, info: row.info ? (JSON.parse(row.info) as Record<string, unknown>) : null, failures: row.failures, failingSince: row.failing_since },
    ]),
  );
}
