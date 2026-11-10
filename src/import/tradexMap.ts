import type { Bar } from "../broker/fyers.js";
import { INDEX_SYMBOLS, normalizeSymbol } from "../broker/symbols.js";
import { ADJUSTMENT_TOLERANCE, covers, extendCoverage, type Range } from "../history/plan.js";
import { BASE, finalBefore, type BaseTf } from "../history/timeframes.js";
import { istDayKey } from "../time.js";

// How Tradex's stored data maps onto the hub's (pure; the I/O is in ./tradex.ts).
//
// Tradex keeps candles per series key "NSE:SBIN-EQ:D" (Fyers symbol + Fyers
// resolution) with coverage "complete from covered_from up to the newest stored
// bar, as of synced_at". The hub keys series by (ticker, base timeframe) with a
// half-open coverage [from, to) of final bars. So an imported series claims:
//   from  the first bar start at or after covered_from
//   to    the end of the newest stored bar, but never past the bars that were
//         final when Tradex synced (a bar stored mid-session was still forming:
//         it is left out and the hub fetches it like any other tail)
// Daily bars use the same day key in both (UTC midnight of the IST trade
// date); anything else is moved onto its IST date.

/** Tradex (Fyers) resolution → hub base timeframe. Other resolutions aren't stored by the hub. */
/** Timeframes Tradex stores that the hub keeps too. */
export type ImportTf = Extract<BaseTf, "1d" | "15m" | "5m">;

export const TRADEX_TF: Readonly<Record<string, ImportTf>> = { D: "1d", "15": "15m", "5": "5m" };

const INDEX_BY_FYERS: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(INDEX_SYMBOLS).map(([hub, fyers]) => [fyers, hub]));

export type KeyMapping = { ok: true; symbol: string; tf: ImportTf } | { ok: false; reason: string };

/** "NSE:SBIN-EQ:D" → SBIN 1d; "NSE:NIFTY50-INDEX:15" → NIFTY 15m. */
export function mapSeriesKey(key: string): KeyMapping {
  const cut = key.lastIndexOf(":");
  if (cut <= 0) return { ok: false, reason: "not a Fyers series key" };
  const fyers = key.slice(0, cut);
  const resolution = key.slice(cut + 1);
  const tf = TRADEX_TF[resolution];
  if (!tf) return { ok: false, reason: `timeframe "${resolution}" isn't stored by the hub (only D, 15 and 5)` };
  if (fyers.endsWith("-INDEX")) {
    const index = INDEX_BY_FYERS[fyers];
    return index ? { ok: true, symbol: index, tf } : { ok: false, reason: `index ${fyers} isn't one the hub knows` };
  }
  const match = /^NSE:(.+)-EQ$/.exec(fyers);
  const symbol = match ? normalizeSymbol(match[1]) : null;
  if (!symbol || symbol !== match![1]) return { ok: false, reason: "not an NSE equity (-EQ) or a known index" };
  return { ok: true, symbol, tf };
}

export interface TradexSeries {
  coveredFrom: number;
  syncedAt: number;
}

export type Prepared = { ok: true; bars: Bar[]; claimed: Range; dropped: number } | { ok: false; reason: string };

const isPrice = (n: number) => Number.isFinite(n) && n > 0;

/**
 * Bars and the coverage they prove, from one Tradex series (bars oldest first).
 * Refuses a series with a malformed bar rather than claiming coverage across it.
 */
export function prepareSeries(tf: BaseTf, series: TradexSeries, rows: readonly Bar[]): Prepared {
  const barMs = BASE[tf].barMs;
  const daily = BASE[tf].daily;
  const bars: Bar[] = [];
  for (const row of rows) {
    const t = daily ? istDayKey(row.t) : row.t;
    if (!Number.isInteger(t) || (!daily && t % barMs !== 0)) return { ok: false, reason: `bar at ${new Date(row.t).toISOString()} isn't on the ${tf} grid` };
    if (![row.o, row.h, row.l, row.c].every(isPrice) || !Number.isFinite(row.v) || row.v < 0) return { ok: false, reason: `malformed bar at ${new Date(row.t).toISOString()}` };
    if (bars.length && t <= bars[bars.length - 1].t) return { ok: false, reason: `two bars on ${new Date(t).toISOString()} (mixed time conventions?)` };
    bars.push({ t, o: row.o, h: row.h, l: row.l, c: row.c, v: row.v });
  }
  if (!bars.length) return { ok: false, reason: "no bars" };
  const from = Math.ceil(series.coveredFrom / barMs) * barMs;
  const to = Math.min(bars[bars.length - 1].t + barMs, finalBefore(tf, series.syncedAt));
  const kept = bars.filter((bar) => bar.t >= from && bar.t < to);
  if (!kept.length || from >= to) return { ok: false, reason: "no final bars inside the covered range" };
  return { ok: true, bars: kept, claimed: { from, to }, dropped: bars.length - kept.length };
}

export type MergeDecision =
  | { action: "write"; bars: Bar[]; coverage: Range }
  | { action: "unchanged"; reason: string }
  | { action: "skip"; reason: string };

/**
 * How an imported series meets what the hub already stores. The hub's own bars
 * win where both have them; the import only adds bars outside the hub's
 * coverage, and only when the two ranges touch (as extendCoverage does for a
 * fetch) — a gap between them stays a gap. Overlapping closes that disagree mean
 * one side was adjusted for a split or bonus and the other wasn't: skipped.
 */
export function planMerge(hubCoverage: Range | null, hubOverlap: readonly Bar[], claimed: Range, bars: readonly Bar[]): MergeDecision {
  if (!hubCoverage) return { action: "write", bars: [...bars], coverage: claimed };
  if (covers(hubCoverage, claimed)) return { action: "unchanged", reason: "already stored" };
  if (claimed.from > hubCoverage.to || claimed.to < hubCoverage.from) return { action: "skip", reason: "a gap separates it from what the hub stores" };
  const ours = new Map(bars.map((bar) => [bar.t, bar]));
  const moved = hubOverlap.find((bar) => {
    const other = ours.get(bar.t);
    return other !== undefined && bar.c > 0 && Math.abs(other.c / bar.c - 1) > ADJUSTMENT_TOLERANCE;
  });
  if (moved) return { action: "skip", reason: `closes differ from the hub's on ${new Date(moved.t).toISOString().slice(0, 10)} (split/bonus adjustment?)` };
  return {
    action: "write",
    bars: bars.filter((bar) => bar.t < hubCoverage.from || bar.t >= hubCoverage.to),
    coverage: extendCoverage(hubCoverage, claimed)!,
  };
}

// ------------------------------------------------------------------ cash bhavcopy

/** A row of Tradex's bhav cache (.cache/screener/bhav/DDMMYYYY.json, keyed by symbol). */
export interface TradexBhavRow {
  prevClose: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  deliveryPct: number | null;
}

/** "01102026.json" → day key of 1 Oct 2026, or null. */
export function bhavFileDay(name: string): number | null {
  const match = /^(\d{2})(\d{2})(\d{4})\.json$/.exec(name);
  if (!match) return null;
  const [day, month, year] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const t = Date.UTC(year, month - 1, day);
  const date = new Date(t);
  return date.getUTCDate() === day && date.getUTCMonth() === month - 1 ? t : null;
}

export interface CleanBhavRow extends TradexBhavRow {
  symbol: string;
}

/** Rows the hub's cash_bhav can hold; the rest are counted. */
export function cleanBhav(rows: Record<string, unknown>): { rows: CleanBhavRow[]; bad: number } {
  const out: CleanBhavRow[] = [];
  let bad = 0;
  for (const [raw, value] of Object.entries(rows)) {
    const row = value as Partial<TradexBhavRow> | null;
    const symbol = normalizeSymbol(raw);
    const numbers = row ? [row.prevClose, row.open, row.high, row.low, row.close, row.volume] : [];
    if (!symbol || symbol !== raw || !row || !numbers.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0) || !(row.close! > 0)) {
      bad += 1;
      continue;
    }
    const dp = typeof row.deliveryPct === "number" && Number.isFinite(row.deliveryPct) ? row.deliveryPct : null;
    out.push({ symbol, prevClose: row.prevClose!, open: row.open!, high: row.high!, low: row.low!, close: row.close!, volume: row.volume!, deliveryPct: dp });
  }
  return { rows: out, bad };
}

/** Same closes and volumes for every symbol: one file is a copy of the other. */
export function sameBhav(a: readonly CleanBhavRow[], b: readonly CleanBhavRow[]): boolean {
  if (a.length !== b.length || !a.length) return false;
  const byB = new Map(b.map((row) => [row.symbol, row]));
  return a.every((row) => {
    const other = byB.get(row.symbol);
    return other !== undefined && other.close === row.close && other.volume === row.volume && other.open === row.open;
  });
}

/** A day's closes must agree with stored daily candles this closely… */
export const BHAV_CLOSE_TOLERANCE = 0.005;
/** …for this share of the symbols both have… */
export const BHAV_MATCH_SHARE = 0.9;
/** …when at least this many can be compared. */
export const BHAV_MIN_COMPARED = 5;

export type BhavCheck = { ok: true; compared: number } | { ok: false; reason: string };

/**
 * Is a cached bhavcopy really for its day? Tradex didn't check the date inside
 * NSE's file, and NSE has served another day's file for a holiday. Checked
 * against daily candle closes for that day: `closes` holds them for the day
 * (null when no stored daily series covers the day, so nothing can be said).
 */
export function checkBhavDay(rows: readonly CleanBhavRow[], closes: ReadonlyMap<string, number> | null): BhavCheck {
  if (!rows.length) return { ok: false, reason: "no rows" };
  if (closes === null) return { ok: true, compared: 0 };
  if (!closes.size) return { ok: false, reason: "no session that day in the stored daily candles (a holiday served with another day's file?)" };
  let compared = 0;
  let matched = 0;
  for (const row of rows) {
    const close = closes.get(row.symbol);
    if (close === undefined) continue;
    compared += 1;
    if (Math.abs(row.close / close - 1) <= BHAV_CLOSE_TOLERANCE) matched += 1;
  }
  if (compared < BHAV_MIN_COMPARED) return { ok: true, compared };
  if (matched / compared < BHAV_MATCH_SHARE) return { ok: false, reason: `closes match the daily candles for only ${matched} of ${compared} symbols (a file for another day?)` };
  return { ok: true, compared };
}
