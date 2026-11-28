import type { Db } from "../db.js";
import { deriveLots, type DerivedLot } from "./lotDerive.js";

// Lot per stock per stored F&O day (migration 12), from two sources:
//   bhavcopy  the lot column of NSE's current F&O files (8 Jul 2024 on), in fo_futures.lot
//   derived   older days, worked out from the open interest (src/nse/lotDerive.ts), in lot_derived
// lot_derived is rebuilt whole by deriveStoredLots: after `hub data nse-history`
// stores F&O days, and by `hub data lots --derive`. Point-in-time readers get
// both through lotHistory and lotsOn, each day marked with its source.

export type LotSource = "bhavcopy" | "derived";

export interface LotDay {
  symbol: string;
  day: number;
  lot: number;
  source: LotSource;
  confidence: "high" | "low";
}

interface OiRow {
  day: number;
  nearExpiry: number;
  nearOi: number;
  close: number;
  lot: number | null;
}

const readOiDays = (db: Db, symbol: string) =>
  db.prepare("select day, near_expiry as nearExpiry, near_oi as nearOi, near_close as close, lot from fo_futures where symbol = ? order by day").all(symbol) as OiRow[];

const futuresSymbols = (db: Db) => (db.prepare("select distinct symbol from fo_futures order by symbol").all() as Array<{ symbol: string }>).map((row) => row.symbol);

export interface DeriveSummary {
  symbols: number;
  days: number;
  low: number;
  first: number | null;
  last: number | null;
}

/** Derive the lot of every stored F&O day without one (the old-format days) and replace lot_derived. */
export function deriveStoredLots(db: Db): DeriveSummary {
  const insert = db.prepare("insert into lot_derived (symbol, day, lot, confidence) values (?, ?, ?, ?)");
  const summary: DeriveSummary = { symbols: 0, days: 0, low: 0, first: null, last: null };
  const derived = futuresSymbols(db).map((symbol) => {
    const rows = readOiDays(db, symbol);
    const missing = new Set(rows.filter((row) => row.lot === null).map((row) => row.day));
    return { symbol, lots: missing.size ? deriveLots(rows).filter((lot) => missing.has(lot.day)) : [] };
  });
  db.transaction(() => {
    db.prepare("delete from lot_derived").run();
    for (const { symbol, lots } of derived) {
      if (!lots.length) continue;
      summary.symbols += 1;
      for (const lot of lots) {
        insert.run(symbol, lot.day, lot.lot, lot.confidence);
        summary.days += 1;
        if (lot.confidence === "low") summary.low += 1;
        summary.first = Math.min(summary.first ?? lot.day, lot.day);
        summary.last = Math.max(summary.last ?? lot.day, lot.day);
      }
    }
  })();
  return summary;
}

export interface DeriveCheck {
  /** Current-format stock-days compared (they carry NSE's own lot). */
  days: number;
  high: number;
  highRight: number;
  low: number;
  lowRight: number;
  /** The first "high" days that disagree (should be none). */
  wrong: Array<{ symbol: string; day: number; derived: number; lot: number }>;
}

/** Derive lots for the days that carry NSE's own lot column too, and compare: how far the derivation can be trusted. */
export function checkDerivedLots(db: Db, symbols?: readonly string[]): DeriveCheck {
  const out: DeriveCheck = { days: 0, high: 0, highRight: 0, low: 0, lowRight: 0, wrong: [] };
  for (const symbol of symbols ?? futuresSymbols(db)) {
    const rows = readOiDays(db, symbol);
    const known = new Map(rows.filter((row) => row.lot !== null).map((row) => [row.day, row.lot!]));
    if (!known.size) continue;
    for (const lot of deriveLots(rows) as DerivedLot[]) {
      const truth = known.get(lot.day);
      if (truth === undefined) continue;
      out.days += 1;
      if (lot.confidence === "low") {
        out.low += 1;
        if (lot.lot === truth) out.lowRight += 1;
        continue;
      }
      out.high += 1;
      if (lot.lot === truth) out.highRight += 1;
      else if (out.wrong.length < 50) out.wrong.push({ symbol, day: lot.day, derived: lot.lot, lot: truth });
    }
  }
  return out;
}

const UNION = `select symbol, day, cast(lot as integer) as lot, 'bhavcopy' as source, 'high' as confidence from fo_futures where lot > 0 and day between @from and @to and (@symbol is null or symbol = @symbol)
  union all
  select symbol, day, lot, 'derived' as source, confidence from lot_derived where day between @from and @to and (@symbol is null or symbol = @symbol)`;

/** The first and last day each source covers (null when it has none). */
export function lotSources(db: Db): Record<LotSource, { from: number; to: number } | null> {
  const span = (sql: string) => {
    const row = db.prepare(sql).get() as { from: number | null; to: number | null };
    return row.from === null || row.to === null ? null : { from: row.from, to: row.to };
  };
  return {
    derived: span("select min(day) as \"from\", max(day) as \"to\" from lot_derived"),
    bhavcopy: span("select min(day) as \"from\", max(day) as \"to\" from fo_futures where lot is not null"),
  };
}

/** First F&O day with a lot from either source. */
export function lotsKnownFrom(db: Db): number | null {
  const sources = lotSources(db);
  const days = [sources.derived?.from, sources.bhavcopy?.from].filter((day): day is number => day !== undefined);
  return days.length ? Math.min(...days) : null;
}

export interface LotChange {
  day: number;
  lot: number;
  source: LotSource;
  confidence: "high" | "low";
}

/**
 * Lot per stock between `from` and `to` as change points: each stock's first
 * stored day in the range, then every day its lot, source or confidence
 * differs from the day before.
 */
export function lotHistory(db: Db, from: number, to: number, symbol?: string): Record<string, LotChange[]> {
  const rows = db.prepare(`${UNION} order by symbol, day`).all({ from, to, symbol: symbol ?? null }) as LotDay[];
  const out: Record<string, LotChange[]> = {};
  for (const row of rows) {
    const list = (out[row.symbol] ??= []);
    const last = list.at(-1);
    if (!last || last.lot !== row.lot || last.source !== row.source || last.confidence !== row.confidence) list.push({ day: row.day, lot: row.lot, source: row.source, confidence: row.confidence });
  }
  return out;
}

/** Every stock's lot on the newest stored F&O day on or before `day` (null before the first). */
export function lotsOn(db: Db, day: number): { day: number; lots: LotDay[] } | null {
  const row = db.prepare("select max(day) as day from nse_days where dataset = 'fo_bhav' and status = 'ok' and day <= ?").get(day) as { day: number | null };
  if (row.day === null) return null;
  const lots = db.prepare(`${UNION} order by symbol`).all({ from: row.day, to: row.day, symbol: null }) as LotDay[];
  return lots.length ? { day: row.day, lots } : null;
}
