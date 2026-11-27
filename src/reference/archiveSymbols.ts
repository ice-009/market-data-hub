import type { Db } from "../db.js";
import { DAY_MS } from "../time.js";
import { loadRenames, storedTraded, type NameSpan } from "./renames.js";

// Every ticker in the stored cash bhavcopies (#60): a survivorship-free
// universe — delisted, suspended and renamed tickers included — without
// reading the files. One row per ticker as NSE printed it (INFOSYSTCH and INFY
// are two rows), with its first and last stored session and the series it
// traded in within the range, and, for a ticker of a renamed listing, the
// listing's names (src/reference/renames.ts) so callers can join them.
//
// The whole archive is one GROUP BY over cash_bhav (~11 M rows: about a
// second), so a range's list is kept until the store changes (another day
// stored, or the renames), and pages are cut from it.

export interface ArchiveSymbol {
  symbol: string;
  /** First and last stored session within the range, and how many (day keys). */
  first: number;
  last: number;
  sessions: number;
  /** The series its stored rows are in (cash_bhav keeps EQ, else BE, per day; "EQ/BE" on days imported from Tradex, whose series isn't known), sorted. */
  series: string[];
  /** The listing it belongs to, when that has more than one name; null for a ticker never renamed. */
  listing: { current: string; names: NameSpan[] } | null;
}

interface Cached {
  signature: string;
  rows: ArchiveSymbol[];
}

const cache = new WeakMap<Db, Map<string, Cached>>();
/** Ranges kept per database. */
const CACHE_RANGES = 8;
/** Ranges up to this long are read through the day index. */
const INDEX_SPAN_MS = 180 * DAY_MS;

/** Changes when a cash day is stored, NSE's list of renames is downloaded again, or ISINs are read (the renames' two sources). */
function storeSignature(db: Db): string {
  const row = db
    .prepare(
      `select (select count(*) from nse_days where dataset = 'cash_bhav') as days,
              (select max(checked_at) from nse_days where dataset = 'cash_bhav') as checked,
              (select last_success_at from datasets where name = 'symbol_changes') as renames,
              (select count(*) from symbol_changes) as changes,
              (select count(*) from isin_days) as isins`,
    )
    .get() as Record<string, number | null>;
  return [row.days, row.checked, row.renames, row.changes, row.isins].map((value) => value ?? 0).join("|");
}

/** Every ticker with a stored cash row with from <= day <= to (day keys), by ticker. */
export function archiveSymbols(db: Db, from: number, to: number): ArchiveSymbol[] {
  const key = `${from}|${to}`;
  const signature = storeSignature(db);
  const ranges = cache.get(db) ?? new Map<string, Cached>();
  cache.set(db, ranges);
  const hit = ranges.get(key);
  if (hit?.signature === signature) return hit.rows;

  // A few months: the day index. Longer: one pass over the table in key order (symbol, day) — through the
  // index, the whole archive takes 20 s; read in order, about a second.
  const day = to - from > INDEX_SPAN_MS ? "+day" : "day";
  const grouped = db
    .prepare(
      `select symbol, min(day) as first, max(day) as last, count(*) as sessions, group_concat(distinct series) as series
       from cash_bhav where ${day} between ? and ? group by symbol order by symbol`,
    )
    .all(from, to) as Array<{ symbol: string; first: number; last: number; sessions: number; series: string }>;
  const renames = loadRenames(db);
  const traded = storedTraded(db);
  const renamed = new Set(renames.changes.flatMap((change) => [change.oldSymbol, change.newSymbol]));
  const rows = grouped.map((row): ArchiveSymbol => {
    // The listing that had the ticker on its last stored session in the range: a ticker reused by another company resolves by date.
    const listing = renamed.has(row.symbol) ? renames.listing(row.symbol, row.last, traded) : null;
    return {
      symbol: row.symbol,
      first: row.first,
      last: row.last,
      sessions: row.sessions,
      series: row.series.split(",").sort(),
      listing: listing && listing.names.length > 1 ? { current: listing.current, names: listing.names } : null,
    };
  });
  ranges.delete(key);
  ranges.set(key, { signature, rows });
  while (ranges.size > CACHE_RANGES) ranges.delete(ranges.keys().next().value!);
  return rows;
}
