import { BrokerError } from "../broker/errors.js";
import type { Bar } from "../broker/fyers.js";
import { isBasket } from "../reference/indices.js";
import { isIndex, isNseOnly } from "../broker/symbols.js";
import type { Db } from "../db.js";
import type { HubMode } from "../hub.js";
import { DAY_MS } from "../time.js";
import { archiveDaily, type ArchiveContext } from "./fromArchive.js";
import type { Range } from "./plan.js";
import type { CandleRow } from "./service.js";
import { readBars } from "./store.js";
import { windowStart } from "./timeframes.js";

// Daily history older than the broker's window (#22). The broker serves about
// five years of daily bars; NSE's cash bhavcopies (stored back to Nov 1994 by
// `hub data nse-history`) and its index file (Feb 2012 on) hold the rest.
// /v1/candles and /v1/candles/batch answer a daily or weekly request reaching
// before the window in two parts, joined by day:
//
//   [from, seam)   the archive: a stock's cash bhavcopy rows, its renamed
//                  tickers joined (INFY reads INFOSYSTCH before June 2011;
//                  src/history/fromArchive.ts), adjusted with the hub's factors
//                  (adjust=split) or as traded (adjust=none); an index's bars
//                  from NSE's index file (already in the stored series:
//                  src/history/fromIndices.ts).
//   [seam, to]     what the hub serves inside the window, as before: the
//                  broker's adjusted bars (end-of-day mode: the archive again).
//
// The seam is the window's first day, or the broker series' first bar when it
// starts later (a stock the broker knows only under its new ticker). Bars on
// either side must line up: the broker adjusts its history its own way (splits
// and bonuses, and dividends too — see src/history/adjustCheck.ts), so the
// adjusted archive is scaled to the broker's level, measured as the median
// ratio of their closes over the first SEAM_SESSIONS sessions both have at or
// after the seam. Within SEAM_TOLERANCE the hub's factors are kept as they are
// (the archive then equals adjust=none × the factors exactly). Each answer says
// where every stretch came from (`sources`), and the scale used.

export type CandleSource = "broker" | "archive" | "index_file" | "basket";

export interface SourceSpan {
  source: CandleSource;
  /** First and last bar of the stretch (bar times). */
  from: number;
  to: number;
  /** Archive stretches: the tickers read, oldest first (more than one across a rename). */
  names?: string[];
  /** Archive stretches lined up with the broker's level: what the hub-adjusted bars were multiplied by. */
  scale?: number;
}

/** Overlapping sessions compared at the seam. */
export const SEAM_SESSIONS = 5;
/** A median ratio within this of 1 keeps the archive as the hub's factors make it. */
export const SEAM_TOLERANCE = 0.005;
/** How far past the seam the archive is read to find the overlap. */
const SEAM_READ_DAYS = 30;

const round2 = (value: number) => Math.round(value * 100) / 100;

/** The first day the broker's window serves at `now` (a day key). */
export const brokerSeam = (now: number) => windowStart("1d", now);

export interface SeamFit {
  /** What the archive's adjusted bars are multiplied by (1 within tolerance or without an overlap). */
  scale: number;
  /** Sessions compared. */
  sessions: number;
  /** Median ratio − 1 before rounding to 1 (null: no overlap). */
  gap: number | null;
}

/**
 * How the archive lines up with the reference (the broker's bars) on the first
 * `sessions` sessions both have, `reference` oldest first. Pure.
 */
export function seamFit(archive: readonly Bar[], reference: readonly Bar[], sessions = SEAM_SESSIONS): SeamFit {
  const byT = new Map(archive.map((bar) => [bar.t, bar]));
  const ratios: number[] = [];
  for (const bar of reference) {
    const match = byT.get(bar.t);
    if (match && match.c > 0 && bar.c > 0) ratios.push(bar.c / match.c);
    if (ratios.length >= sessions) break;
  }
  if (!ratios.length) return { scale: 1, sessions: 0, gap: null };
  const sorted = [...ratios].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return { scale: Math.abs(median - 1) <= SEAM_TOLERANCE ? 1 : median, sessions: ratios.length, gap: median - 1 };
}

/** Bars × scale (volumes ÷), prices to the paisa. Pure. */
export function scaleBars<T extends Bar>(bars: readonly T[], scale: number): T[] {
  if (scale === 1) return [...bars];
  return bars.map((bar) => ({ ...bar, o: round2(bar.o * scale), h: round2(bar.h * scale), l: round2(bar.l * scale), c: round2(bar.c * scale), v: Math.round(bar.v / scale) }));
}

/** Join spans of one source that touch or follow each other (end-of-day mode: archive + archive). Pure. */
export function joinSpans(spans: readonly SourceSpan[]): SourceSpan[] {
  const out: SourceSpan[] = [];
  for (const span of spans) {
    const last = out[out.length - 1];
    if (last && last.source === span.source && (last.scale ?? 1) === (span.scale ?? 1)) {
      last.to = Math.max(last.to, span.to);
      const names = [...(last.names ?? []), ...(span.names ?? []).filter((name) => !(last.names ?? []).includes(name))];
      if (names.length) last.names = names;
    } else out.push({ ...span });
  }
  return out;
}

/** What a stretch of a stored series served inside the window is, by symbol and mode. */
export function storedSource(symbol: string, mode: HubMode): CandleSource {
  if (isBasket(symbol)) return "basket";
  if (isNseOnly(symbol)) return "index_file";
  if (mode === "end_of_day") return isIndex(symbol) ? "index_file" : "archive";
  return "broker";
}

export interface ArchivePart {
  /** Daily bars before `until` (with delivery %), lined up with the reference. */
  bars: CandleRow[];
  /** Every session from the request's first day to `until` is stored or a holiday. */
  complete: boolean;
  /** The checked stretch the bars come from (half-open day range), or null when nothing is stored. */
  coverage: Range | null;
  span: SourceSpan | null;
  fit: SeamFit;
}

/**
 * A stock's archive bars from `fromDay` to the day before `until` (the seam),
 * adjusted (`adjusted`) and lined up with `reference` — the bars served from
 * `until` on, oldest first (only the first few are used). Throws BrokerError
 * `bad_symbol` when no stored file lists the stock.
 */
export function archivePart(db: Db, symbol: string, fromDay: number, until: number, reference: readonly Bar[], options: { adjusted: boolean; today: number; context?: ArchiveContext }): ArchivePart {
  const lastDay = until - DAY_MS;
  // Read past the seam too: those bars are what is compared with the reference.
  // The listing is today's holder of the ticker, the company the broker part is.
  const read = archiveDaily(db, symbol, fromDay, lastDay + (reference.length && options.adjusted ? SEAM_READ_DAYS * DAY_MS : 0), { adjusted: options.adjusted, context: options.context, listingDay: options.today });
  const fit = options.adjusted ? seamFit(read.bars.filter((bar) => bar.t >= until), reference) : { scale: 1, sessions: 0, gap: null };
  const before = read.bars.filter((bar) => bar.t >= fromDay && bar.t < until);
  const bars: CandleRow[] = scaleBars(before, fit.scale).map((bar) => ({ ...bar, dp: read.dp.get(bar.t) ?? null }));
  const coverage = read.bars.length || read.coveredFromDay <= read.coveredToDay ? { from: read.coveredFromDay, to: Math.min(read.coveredToDay + DAY_MS, until) } : null;
  const complete = Boolean(coverage && coverage.from <= fromDay && read.coveredToDay >= lastDay);
  const names = read.names.filter((name) => name.to >= fromDay && name.from < until).map((name) => name.symbol);
  const span: SourceSpan | null = bars.length ? { source: "archive", from: bars[0].t, to: bars[bars.length - 1].t, ...(names.length ? { names } : {}), ...(fit.scale !== 1 ? { scale: Math.round(fit.scale * 1e6) / 1e6 } : {}) } : null;
  return { bars, complete, coverage, span, fit };
}

/** The archive part, or null for a ticker no stored file lists (left to the broker part alone). */
export function archivePartOrNull(...args: Parameters<typeof archivePart>): ArchivePart | null {
  try {
    return archivePart(...args);
  } catch (error) {
    if (error instanceof BrokerError) return null;
    throw error;
  }
}

/** The stored series' first daily bars at or after `day`, as the reference for the seam. */
export function storedReference(db: Db, symbol: string, day: number): Bar[] {
  return readBars(db, symbol, "1d", day, day + SEAM_READ_DAYS * DAY_MS).slice(0, SEAM_SESSIONS);
}

/**
 * Where the archive hands over to the stored series: the stored daily series'
 * first bar on or after the seam (the seam when there is none). The broker's
 * series may start after the seam — it knows some renamed stocks only from
 * their new ticker's first day, and real series have holes at their start
 * (ANGELONE's from Fyers begins 29 Nov 2021, the seam being 24 Nov) — and the
 * archive covers the days before, so nothing is left out between the two.
 */
export function handover(db: Db, symbol: string, seam: number): number {
  const row = db.prepare("select min(t) as t from candles where symbol = ? and tf = '1d' and t >= ?").get(symbol, seam) as { t: number | null };
  return row.t ?? seam;
}

/** The union of two coverages when they touch; else the later one (a gap isn't papered over). Pure. */
export function joinCoverage(older: Range | null, newer: Range | null): Range | null {
  if (!older) return newer;
  if (!newer) return older;
  if (older.to < newer.from || newer.to < older.from) return newer;
  return { from: Math.min(older.from, newer.from), to: Math.max(older.to, newer.to) };
}

/** Where each stretch of a series served from the store came from (indices: NSE's index file before the seam). Pure. */
export function storedSpans(symbol: string, mode: HubMode, candles: readonly Bar[], seam: number): SourceSpan[] {
  if (!candles.length) return [];
  const source = storedSource(symbol, mode);
  const first = candles[0].t;
  const last = candles[candles.length - 1].t;
  if (source !== "broker" || !isIndex(symbol) || first >= seam) return [{ source, from: first, to: last }];
  const before = candles.filter((bar) => bar.t < seam);
  const after = candles.filter((bar) => bar.t >= seam);
  return [{ source: "index_file" as const, from: first, to: before[before.length - 1].t }, ...(after.length ? [{ source, from: after[0].t, to: last }] : [])];
}
