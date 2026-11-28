import type { Db } from "../db.js";
import { DAY_MS } from "../time.js";
import type { ExpirySummary, OptionSummary } from "./optionSummary.js";
import type { OptionKind } from "./parsers/foOptions.js";
import type { DayStatus } from "./store.js";

// Storage for daily option summaries (migration 13; market-data-hub#30).
// option_summaries: one row per underlying per F&O day. option_days: the days
// whose option rows were read — "ok" (stored), "holiday" (NSE has no F&O file),
// "mismatch" (NSE served another day's) — so neither the evening run nor
// `hub data nse-history --only options` reads a day twice.
//
// Size: ~265 bytes a row on disk with its day index (measured on real 2001,
// 2010, 2020 and 2025 days), and about as many rows as fo_futures (~1.0
// million for Nov 2001 → Nov 2026, ~30 underlyings a day in 2001, ~200 since
// 2010) plus a few index rows a day: ≈ 275 MB for the whole archive, ~14 MB a
// year now. Every option row instead would be ~150 million rows, 10 GB or more.

const LEG_COLUMNS = ["expiry", "forward", "atm_strike", "straddle", "atm_iv", "call_iv", "put_iv", "cp_spread", "iv25_put", "iv25_call", "max_pain", "call_wall", "call_wall_oi", "put_wall", "put_wall_oi", "call_oi", "put_oi", "strikes", "liquid", "flags"] as const;
type LegColumn = (typeof LEG_COLUMNS)[number];

const LEG_FIELDS: Record<LegColumn, keyof ExpirySummary> = {
  expiry: "expiry",
  forward: "forward",
  atm_strike: "atmStrike",
  straddle: "straddle",
  atm_iv: "atmIv",
  call_iv: "callIv",
  put_iv: "putIv",
  cp_spread: "cpSpread",
  iv25_put: "iv25Put",
  iv25_call: "iv25Call",
  max_pain: "maxPain",
  call_wall: "callWall",
  call_wall_oi: "callWallOi",
  put_wall: "putWall",
  put_wall_oi: "putWallOi",
  call_oi: "callOi",
  put_oi: "putOi",
  strikes: "strikes",
  liquid: "liquid",
  flags: "flags",
};

const BASE_COLUMNS = ["symbol", "day", "nse_symbol", "kind", "spot", "lot", "expiries", "call_oi", "put_oi", "call_chg_oi", "put_chg_oi", "call_volume", "put_volume", "iv30", "flags"] as const;
const ALL_COLUMNS = [...BASE_COLUMNS, ...LEG_COLUMNS.map((c) => `near_${c}`), ...LEG_COLUMNS.map((c) => `next_${c}`)];

/** A stored row as SQLite returns it. */
export type OptionSummaryRow = Record<string, number | string | null>;

function legParams(prefix: "near" | "next", leg: ExpirySummary | null): Record<string, number | null> {
  return Object.fromEntries(LEG_COLUMNS.map((column) => [`${prefix}_${column}`, leg ? (leg[LEG_FIELDS[column]] as number | null) : null]));
}

function legFrom(row: OptionSummaryRow, prefix: "near" | "next"): ExpirySummary | null {
  if (row[`${prefix}_expiry`] === null) return null;
  const leg = Object.fromEntries(LEG_COLUMNS.map((column) => [LEG_FIELDS[column], row[`${prefix}_${column}`]]));
  return { ...(leg as unknown as ExpirySummary), days: 0 };
}



/** A stored row back as a summary (days to expiry recomputed from the day). */
export function toSummary(row: OptionSummaryRow): OptionSummary {
  const day = row.day as number;
  const withDays = (leg: ExpirySummary | null) => (leg ? { ...leg, days: Math.round((leg.expiry - day) / DAY_MS) } : null);
  return {
    day,
    symbol: row.symbol as string,
    nseSymbol: row.nse_symbol as string,
    kind: row.kind as OptionKind,
    spot: row.spot as number | null,
    lot: row.lot as number | null,
    expiries: row.expiries as number,
    callOi: row.call_oi as number,
    putOi: row.put_oi as number,
    callChgOi: row.call_chg_oi as number,
    putChgOi: row.put_chg_oi as number,
    callVolume: row.call_volume as number,
    putVolume: row.put_volume as number,
    iv30: row.iv30 as number | null,
    flags: row.flags as number,
    near: withDays(legFrom(row, "near")),
    next: withDays(legFrom(row, "next")),
  };
}

export function markOptionDay(db: Db, day: number, status: DayStatus, rows: number, checkedAt: number, note: string | null = null) {
  db.prepare(
    `insert into option_days (day, status, rows, checked_at, note) values (?, ?, ?, ?, ?)
     on conflict(day) do update set status = excluded.status, rows = excluded.rows, checked_at = excluded.checked_at, note = excluded.note`,
  ).run(day, status, rows, checkedAt, note);
}

/** Replace one trade day's summaries and mark the day read. */
export function writeOptionDay(db: Db, day: number, summaries: readonly OptionSummary[], checkedAt: number) {
  const insert = db.prepare(`insert into option_summaries (${ALL_COLUMNS.join(", ")}) values (${ALL_COLUMNS.map((c) => `@${c}`).join(", ")})`);
  db.transaction(() => {
    db.prepare("delete from option_summaries where day = ?").run(day);
    for (const s of summaries) {
      insert.run({
        symbol: s.symbol,
        day,
        nse_symbol: s.nseSymbol,
        kind: s.kind,
        spot: s.spot,
        lot: s.lot,
        expiries: s.expiries,
        call_oi: s.callOi,
        put_oi: s.putOi,
        call_chg_oi: s.callChgOi,
        put_chg_oi: s.putChgOi,
        call_volume: s.callVolume,
        put_volume: s.putVolume,
        iv30: s.iv30,
        flags: s.flags,
        ...legParams("near", s.near),
        ...legParams("next", s.next),
      });
    }
    markOptionDay(db, day, "ok", summaries.length, checkedAt);
  })();
}

/** Days whose option rows were read (any status), from `from` on. */
export function optionDaysRead(db: Db, from = Number.MIN_SAFE_INTEGER): Map<number, DayStatus> {
  const rows = db.prepare("select day, status from option_days where day >= ?").all(from) as Array<{ day: number; status: DayStatus }>;
  return new Map(rows.map((row) => [row.day, row.status]));
}

/** First and newest stored option days. */
export function optionSpan(db: Db): { first: number | null; last: number | null; days: number } {
  return db.prepare("select min(day) as first, max(day) as last, count(*) as days from option_days where status = 'ok'").get() as { first: number | null; last: number | null; days: number };
}

/** One symbol's stored rows with from <= day <= to, oldest first. */
export function readOptionSymbol(db: Db, symbol: string, from: number, to: number): OptionSummaryRow[] {
  return db.prepare("select * from option_summaries where symbol = ? and day between ? and ? order by day").all(symbol, from, to) as OptionSummaryRow[];
}

/** The newest stored option day on or before `day`. */
export function optionDayOnOrBefore(db: Db, day: number): number | null {
  return (db.prepare("select max(day) as day from option_days where status = 'ok' and day <= ?").get(day) as { day: number | null }).day;
}

/** Every underlying's row on one stored day, by symbol. */
export function readOptionDay(db: Db, day: number): OptionSummaryRow[] {
  return db.prepare("select * from option_summaries where day = ? order by symbol").all(day) as OptionSummaryRow[];
}

/** iv30 of every symbol with from <= day <= to, for percentiles. */
export function readIv30(db: Db, from: number, to: number): Array<{ symbol: string; day: number; iv30: number }> {
  return db.prepare("select symbol, day, iv30 from option_summaries where day between ? and ? and iv30 is not null").all(from, to) as Array<{ symbol: string; day: number; iv30: number }>;
}

/** Cash-market volume (shares) per symbol on a day range, for option-to-stock volume. */
export function stockVolumes(db: Db, symbols: readonly string[], from: number, to: number): Map<string, number> {
  const out = new Map<string, number>();
  if (!symbols.length) return out;
  const rows = db.prepare(`select symbol, day, v from cash_bhav where day between ? and ? and symbol in (${symbols.map(() => "?").join(",")})`).all(from, to, ...symbols) as Array<{ symbol: string; day: number; v: number }>;
  for (const row of rows) out.set(`${row.symbol}:${row.day}`, row.v);
  return out;
}
