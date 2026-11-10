import type { Bar } from "../broker/fyers.js";
import type { Db } from "../db.js";
import type { Range } from "./plan.js";
import type { BaseTf } from "./timeframes.js";

// Candle storage in the hub database (migration 1):
//   series   (symbol, tf) → coverage [covered_from, covered_to), synced_at, count, first/last bar
//   candles  (symbol, tf, t) → o h l c v
// Only base timeframes are stored (1d, 15m, 5m, 1m); 1w and 1h are resampled on read.
// (Adapted from Tradex's candleDb, MIT.)

export interface SeriesMeta {
  symbol: string;
  tf: BaseTf;
  coverage: Range | null;
  syncedAt: number;
  count: number;
  firstT: number | null;
  lastT: number | null;
}

interface SeriesRow {
  symbol: string;
  tf: BaseTf;
  covered_from: number | null;
  covered_to: number | null;
  synced_at: number;
  count: number;
  first_t: number | null;
  last_t: number | null;
}

const toMeta = (row: SeriesRow): SeriesMeta => ({
  symbol: row.symbol,
  tf: row.tf,
  coverage: row.covered_from !== null && row.covered_to !== null ? { from: row.covered_from, to: row.covered_to } : null,
  syncedAt: row.synced_at,
  count: row.count,
  firstT: row.first_t,
  lastT: row.last_t,
});

export function readSeries(db: Db, symbol: string, tf: BaseTf): SeriesMeta | null {
  const row = db.prepare("select * from series where symbol = ? and tf = ?").get(symbol, tf) as SeriesRow | undefined;
  return row ? toMeta(row) : null;
}

export function listSeries(db: Db, tf?: BaseTf): SeriesMeta[] {
  const rows = (tf ? db.prepare("select * from series where tf = ?").all(tf) : db.prepare("select * from series").all()) as SeriesRow[];
  return rows.map(toMeta);
}

/** Stored bars with from <= t < to, oldest first. */
export function readBars(db: Db, symbol: string, tf: BaseTf, from: number, to: number): Bar[] {
  return db.prepare("select t, o, h, l, c, v from candles where symbol = ? and tf = ? and t >= ? and t < ? order by t").all(symbol, tf, from, to) as Bar[];
}

/** Insert or replace bars and set the series' coverage, in one transaction. */
export function writeBars(db: Db, symbol: string, tf: BaseTf, bars: Bar[], coverage: Range | null, syncedAt: number) {
  const insert = db.prepare("insert or replace into candles (symbol, tf, t, o, h, l, c, v) values (?, ?, ?, ?, ?, ?, ?, ?)");
  db.transaction(() => {
    for (const bar of bars) insert.run(symbol, tf, bar.t, bar.o, bar.h, bar.l, bar.c, bar.v);
    const summary = db.prepare("select count(*) as count, min(t) as first_t, max(t) as last_t from candles where symbol = ? and tf = ?").get(symbol, tf) as { count: number; first_t: number | null; last_t: number | null };
    db.prepare(
      `insert into series (symbol, tf, covered_from, covered_to, synced_at, count, first_t, last_t) values (?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(symbol, tf) do update set covered_from = excluded.covered_from, covered_to = excluded.covered_to,
         synced_at = excluded.synced_at, count = excluded.count, first_t = excluded.first_t, last_t = excluded.last_t`,
    ).run(symbol, tf, coverage?.from ?? null, coverage?.to ?? null, syncedAt, summary.count, summary.first_t, summary.last_t);
  })();
}

/**
 * Delete a series' bars starting before `t` and move its coverage start up to
 * `t` (none left when the coverage ended before it). For series kept only for a
 * short window (1m).
 */
export function pruneBefore(db: Db, symbol: string, tf: BaseTf, t: number) {
  const meta = readSeries(db, symbol, tf);
  if (!meta || ((meta.firstT === null || meta.firstT >= t) && (meta.coverage === null || meta.coverage.from >= t))) return;
  db.transaction(() => {
    db.prepare("delete from candles where symbol = ? and tf = ? and t < ?").run(symbol, tf, t);
    const coverage = meta.coverage && meta.coverage.to > t ? { from: Math.max(meta.coverage.from, t), to: meta.coverage.to } : null;
    const summary = db.prepare("select count(*) as count, min(t) as first_t, max(t) as last_t from candles where symbol = ? and tf = ?").get(symbol, tf) as { count: number; first_t: number | null; last_t: number | null };
    db.prepare("update series set covered_from = ?, covered_to = ?, count = ?, first_t = ?, last_t = ? where symbol = ? and tf = ?").run(coverage?.from ?? null, coverage?.to ?? null, summary.count, summary.first_t, summary.last_t, symbol, tf);
  })();
}

/** Forget every stored series of a symbol (its history was adjusted for a split or bonus). */
export function resetSymbol(db: Db, symbol: string) {
  db.transaction(() => {
    db.prepare("delete from candles where symbol = ?").run(symbol);
    db.prepare("delete from series where symbol = ?").run(symbol);
  })();
}

/** Delivery % per day from the NSE cash bhavcopy, for a symbol's daily bars. */
export function deliveryPct(db: Db, symbol: string, fromDay: number, toDay: number): Map<number, number | null> {
  const rows = db.prepare("select day, deliv_pct from cash_bhav where symbol = ? and day >= ? and day < ?").all(symbol, fromDay, toDay) as Array<{ day: number; deliv_pct: number | null }>;
  return new Map(rows.map((row) => [row.day, row.deliv_pct]));
}

export function candleStats(db: Db): Array<{ tf: BaseTf; series: number; candles: number; lastT: number | null }> {
  return db.prepare("select tf, count(*) as series, coalesce(sum(count), 0) as candles, max(last_t) as lastT from series group by tf order by tf").all() as Array<{ tf: BaseTf; series: number; candles: number; lastT: number | null }>;
}
