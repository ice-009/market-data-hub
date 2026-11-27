import type { Statement } from "better-sqlite3";
import { readKv, writeKv, type Db } from "../db.js";
import { WEEKEND_SESSIONS } from "../nse/datasets.js";
import { rightsTerms, type PricePart } from "../nse/parsers/corporateActions.js";
import { coverageStatuses, readCorporateActions, refreshCorporateActions, type StoredCorporateAction } from "../nse/store.js";
import { listingOf, loadRenames, type Listing, type Renames } from "../reference/renames.js";
import { DAY_MS, isWeekday } from "../time.js";
import { resetSymbol } from "./store.js";

// Split and bonus adjustment factors (migration 7), derived from what the hub
// stores of NSE's own files, kept apart from the raw prices: cash_bhav holds
// prices as traded; adjustment_factors holds one row per ex-date — prices
// before `day` × `factor` (volumes ÷ `factor`) are comparable with prices from
// `day` on. Everything that serves adjusted daily history reads this table
// (src/history/fromArchive.ts, /v1/adjustments, the bhavcopy's reset of stored
// series in src/history/fromBhav.ts); nothing computes factors elsewhere.
//
// Each pair of consecutive sessions of a ticker (prev, row) — consecutive only
// when every trading day between them was checked (stored or a known holiday)
// — gets at most one factor, from the first of these that applies:
//
//   prev_close        the file's PREV_CLOSE on `row` isn't prev's close (and the
//                     opening price bears it out, within ±25%): NSE adjusted its
//                     base price, and PREV_CLOSE / close(prev) is the factor.
//                     NSE does this for some actions only (some rights issues,
//                     a consolidation after a suspension). For ordinary splits
//                     and bonuses PREV_CLOSE is just the previous close, not
//                     adjusted: checked on TATASTEEL's 1:10 split, 28 Jul 2022,
//                     in the old cash file; ANGELONE's, 26 Feb 2026, in the new
//                     one and in the UDiFF bhavcopy; CUB's bonus, 12 Jun 2026.
//                     Taken only when
//                       both sessions are in the same series: each series has
//                         its own PREVCLOSE, and cash_bhav keeps one row a day
//                         (EQ, else BE) — in 2000–02 many stocks traded in both,
//                         so the stored row switched series from day to day
//                         (SRTRANSFIN 11 Oct 2001: EQ 7.4 stored, BE 7.2; on
//                         12 Oct only BE, PREVCLOSE 7.2) (#53);
//                       and the bc file lists an action for the ticker that
//                         day, or the factor is a standard ratio
//                         (PREV_CLOSE_RATIOS) on a day whose file isn't off
//                         for many tickers at once (NOISY_DAY_MIN: on 1 Mar
//                         1997 PREVCLOSE is off for 814 — RELIANCE 272.2
//                         against a 293.75 close — and on a dozen more days of
//                         the 1995–2002 files).
//   corporate_action  NSE's corporate-actions file (the PR zip's bc file, from
//                     2010; src/nse/parsers/corporateActions.ts) for this ticker
//                     and ex-date has
//                       a bonus, split or consolidation: its ratio (BONUS 1:1 →
//                         0.5), when the opening gap bears it out (within ±25%,
//                         and nearer to it than to 1, unless it's within 15% of
//                         1); otherwise the file's date is wrong for this ticker;
//                       a DEMERGER: the opening gap itself (NSE prices what is
//                         left in a special pre-open session);
//                       a rights issue with its price: the theoretical
//                         ex-rights price over the last close.
//   price_gap         the bc file lists nothing for this ticker within
//                     BC_NEAR_DAYS of the ex-date (before 2010 there is no bc
//                     file; after, NSE's files still miss some: SHRIRAMFIN's
//                     1:5 split, 10 Jan 2025, is in none of them) (#54): an
//                     opening gap near a standard ratio (STANDARD_RATIOS;
//                     inferRatio) — a move a price band or a normal day doesn't
//                     make — far outside the stock's own daily moves
//                     (GAP_SIGMAS × the stdev of its last VOL_WINDOW daily log
//                     returns: in 1998–2001 a 25–50% move in one trade was an
//                     ordinary day for many penny stocks) is taken for that
//                     ratio. Where the bc file lists something else for the
//                     ticker near the date, a gap is just a gap.
//
// Renamed tickers (src/reference/renames.ts): a pair is never formed across a
// rename of its ticker (the ticker may have passed to another company), and the
// last session under the old name and the first under the new one form a pair
// of their own (stored under the new ticker, `renamed_from` the old) that only
// prev_close and corporate_action can turn into a factor — the change of name
// itself is not an action. Factors are read per listing, so they follow the
// company across its names.

/** PREV_CLOSE differing from the previous close by more than this means NSE adjusted it. */
export const SPLIT_TOLERANCE = 0.015;

/**
 * Ratios a price gap is taken for when no corporate-actions file covers the
 * day: bonuses 1:1, 2:1, 3:1, 4:1, 1:2, 3:2, 1:3 and face-value splits 2→1,
 * 5→1, 10→1, 5→2, 10→2…, and consolidations 1→2, 1→5, 1→10.
 */
export const STANDARD_RATIOS: readonly number[] = [1 / 10, 1 / 6, 1 / 5, 1 / 4, 1 / 3, 2 / 5, 1 / 2, 2 / 3, 3 / 4, 2, 5, 10];
/**
 * How near the open and the close must be to the ratio. A halving or more (or a
 * doubling) is no market move, so the stock may trade well away from its new
 * base that day (MOTILALOFS opened 8% above a 3:1 bonus's quarter, 10 Jun 2024;
 * COCHINSHIP closed 19% above a 1:1 bonus's half, 10 Jan 2024); 2/3 and 3/4 are
 * moves a bad day can make, so they must be close.
 */
const WIDE = { open: Math.log(1.12), close: Math.log(1.25) };
const NARROW = { open: Math.log(1.06), close: Math.log(1.2) };
/** inferLooseRatio's windows, and how many sessions after (STAY_SESSIONS, at least STAY_MIN_SESSIONS) must stay within STAY of the ex-date's close. */
const LOOSE = { open: Math.log(1.2), close: Math.log(1.12) };
const STAY = Math.log(1.25);
export const STAY_SESSIONS = 5;
const STAY_MIN_SESSIONS = 3;
const INFER_MAX_GAP_MS = 15 * DAY_MS;
const CONFIRM = Math.log(1.25);
const SMALL_FACTOR = Math.log(1.15);
/** A bc row for a ticker this many days either side of a gap: the bc file speaks for it, so the gap isn't read as a ratio. */
export const BC_NEAR_DAYS = 7;
/**
 * The ratios an adjusted PREV_CLOSE is taken for without a bc row: the
 * standard ones and the bonuses 1:4, 1:5 and 1:10 (NSE's PREV_CLOSE is exact,
 * so they must match within PREV_CLOSE_MATCH).
 */
export const PREV_CLOSE_RATIOS: readonly number[] = [...STANDARD_RATIOS, 4 / 5, 5 / 6, 10 / 11];
const PREV_CLOSE_MATCH = Math.log(1.01);
/** A day on which at least this many tickers' PREV_CLOSE differs from their previous close (same series, within INFER_MAX_GAP_MS): a glitch in the file. */
export const NOISY_DAY_MIN = 5;
/** A gap is taken for a ratio only beyond this many times the stock's daily volatility … */
export const GAP_SIGMAS = 6;
/** … the stdev of its last VOL_WINDOW daily log returns (at least VOL_MIN_RETURNS of them; fewer: only a halving or more), floored. */
export const VOL_WINDOW = 20;
const VOL_MIN_RETURNS = 5;
const SIGMA_FLOOR = 0.01;

export type FactorSource = "prev_close" | "corporate_action" | "price_gap";
export const FACTOR_SOURCES: readonly FactorSource[] = ["prev_close", "corporate_action", "price_gap"];

export interface Factor {
  /** The ticker on the ex-date. */
  symbol: string;
  /** Ex-date (day key): prices before it × factor. */
  day: number;
  factor: number;
  source: FactorSource;
  /** The session before (day key), its close, and the ex-date's PREV_CLOSE, open and close — raw, as NSE printed them. */
  prevDay: number;
  prevC: number;
  prevClose: number;
  o: number;
  c: number;
  /** The corporate-actions file's purposes for this ticker and ex-date (" · "-joined), or null. */
  action: string | null;
  /** For the pair across a rename: the old ticker. */
  renamedFrom: string | null;
}

interface CashRow {
  symbol: string;
  day: number;
  series: string;
  prev_close: number;
  o: number;
  h: number;
  c: number;
}

export const isSessionDay = (day: number) => isWeekday(day) || WEEKEND_SESSIONS.includes(day);
const sorted = (values: Iterable<number>) => [...values].sort((a, b) => a - b);

/** Index of the first value >= x in a sorted array. */
function lowerBound(values: readonly number[], x: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Is there a value in [from, to]? */
const anyBetween = (values: readonly number[], from: number, to: number) => {
  const i = lowerBound(values, from);
  return i < values.length && values[i] <= to;
};

/**
 * What an action list does to the price: one bonus, one split and one
 * consolidation at most (NSE sometimes words one twice, or lists a bonus and a
 * split on one ex-date as two rows), multiplied; `unknown` are those named
 * without their terms. Null when it names none.
 */
function actionTerms(actions: readonly StoredCorporateAction[]): { known: number; unknown: PricePart[] } | null {
  const byKind = new Map<string, PricePart>();
  for (const action of actions) {
    for (const part of action.parts) {
      const had = byKind.get(part.kind);
      if (!had || (had.ratio === null && part.ratio !== null)) byKind.set(part.kind, part);
    }
  }
  if (!byKind.size) return null;
  let known = 1;
  const unknown: PricePart[] = [];
  for (const part of byKind.values()) {
    if (part.ratio === null) unknown.push(part);
    else known *= part.ratio;
  }
  return { known, unknown };
}

/** Bonuses 1:1, 2:1, 3:1, 4:1, 5:1, 1:2, 3:2, 1:3, 1:4, 1:5. */
const BONUS_RATIOS: readonly number[] = [1 / 2, 1 / 3, 1 / 4, 1 / 5, 1 / 6, 2 / 3, 2 / 5, 3 / 4, 4 / 5, 5 / 6];

/** What a bonus, split or consolidation named without its terms may be: the usual ratios (a split to ₹5, ₹2 or ₹1 when the old face value is known). */
function partCandidates(part: PricePart): number[] {
  if (part.kind === "bonus") return [...BONUS_RATIOS];
  if (part.kind === "consolidation") return [2, 5, 10];
  const out = new Set([1 / 2, 1 / 4, 1 / 5, 1 / 10]);
  if (part.from) for (const to of [5, 2, 1]) if (to < part.from) out.add(to / part.from);
  return [...out];
}

/** How far a factor is from the open and the close (the worse of the two, as a log distance). */
const misfit = (factor: number, openGap: number, closeGap: number) => Math.max(Math.abs(Math.log(openGap / factor)), Math.abs(Math.log(closeGap / factor)));

/**
 * The factor for a listed action whose terms are (partly) missing: the known
 * part × the candidates for the rest that the open and the close fit best —
 * both within ±25% and each nearer to it than to no change at all. Pure.
 */
export function inferPartial(known: number, unknown: readonly PricePart[], openGap: number, closeGap: number): number | null {
  if (!(openGap > 0) || !(closeGap > 0)) return null;
  let factors = [known];
  for (const part of unknown) factors = factors.flatMap((factor) => partCandidates(part).map((candidate) => factor * candidate));
  let best: number | null = null;
  for (const factor of factors) if (best === null || misfit(factor, openGap, closeGap) < misfit(best, openGap, closeGap)) best = factor;
  if (best === null || misfit(best, openGap, closeGap) >= CONFIRM) return null;
  const nearer = (gap: number) => Math.abs(Math.log(gap / best!)) < Math.abs(Math.log(gap));
  return nearer(openGap) && nearer(closeGap) ? best : null;
}

/**
 * A rights issue's factor, the theoretical ex-rights price over the last
 * cum-rights close: (held × close + offered × price) / ((held + offered) × close).
 * Null when no rights issue with a price is listed, or the price isn't below the close (nothing to adjust).
 */
function rightsFactor(actions: readonly StoredCorporateAction[], close: number): number | null {
  for (const action of actions) {
    if (!action.kinds.includes("rights")) continue;
    const terms = rightsTerms(action.purpose);
    if (!terms || terms.price === null || !(terms.price < close)) continue;
    return (terms.held * close + terms.offered * terms.price) / ((terms.held + terms.offered) * close);
  }
  return null;
}

/** A halving or more, or a doubling: no market move. */
const wide = (ratio: number) => ratio <= 0.5 || ratio >= 2;

/**
 * The standard ratio a gap is, or null. Pure. Of the ratios the open and the
 * close are both near enough to, the one they fit best — not just the one
 * nearest the open (SUZLON's 1:5 split, 21 Jan 2008, opened at 0.224, a shade
 * nearer 1/4, and closed at 0.193, far from it).
 */
export function inferRatio(openGap: number, closeGap: number): number | null {
  if (!(openGap > 0) || !(closeGap > 0)) return null;
  let best: number | null = null;
  for (const ratio of STANDARD_RATIOS) {
    const window = wide(ratio) ? WIDE : NARROW;
    if (Math.abs(Math.log(openGap / ratio)) >= window.open || Math.abs(Math.log(closeGap / ratio)) >= window.close) continue;
    if (best === null || misfit(ratio, openGap, closeGap) < misfit(best, openGap, closeGap)) best = ratio;
  }
  return best;
}

/**
 * Before 2002 or so NSE's first trade on an ex-date was often well off the new
 * base (DIVISLAB's 1:1 bonus, 30 Jul 2009, opened at 0.563 and closed at 0.495;
 * ICICI's, CENTURYTEX's, VIMTALABS' splits alike). A halving or more (or a
 * doubling) is also taken when the open is within LOOSE.open of it, the close
 * within LOOSE.close, and the next sessions stay there (the median of their
 * closes within STAY of the ex-date's): a crash opens near the last close
 * (SATYAMCOMP, 7 Jan 2009: 1.0, then 0.225) and rarely sits still after. Pure.
 */
export function inferLooseRatio(openGap: number, closeGap: number, after: readonly number[], close: number, highGap?: number): number | null {
  if (!(openGap > 0) || !(closeGap > 0) || !(close > 0) || after.length < STAY_MIN_SESSIONS) return null;
  let ratio = STANDARD_RATIOS[0];
  for (const candidate of STANDARD_RATIOS) if (Math.abs(Math.log(closeGap / candidate)) < Math.abs(Math.log(closeGap / ratio))) ratio = candidate;
  if (!wide(ratio) || Math.abs(Math.log(openGap / ratio)) >= LOOSE.open || Math.abs(Math.log(closeGap / ratio)) >= LOOSE.close) return null;
  // The whole day near the new base: no trade back up at the old price (PASUPATFAB, 9 May 2000: 7 → open 4, high 9.9, close 3.5).
  if (highGap !== undefined && highGap > 0 && Math.log(highGap / ratio) >= LOOSE.open) return null;
  // The open at least twice as far (in log terms) from the last close as from the new base.
  if (Math.abs(Math.log(openGap)) < 2 * Math.abs(Math.log(openGap / ratio))) return null;
  const sorted = [...after].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return median > 0 && Math.abs(Math.log(median / close)) < STAY ? ratio : null;
}

/** The standard ratio an adjusted PREV_CLOSE is, or null. Pure. */
export function prevCloseRatio(nse: number): number | null {
  if (!(nse > 0)) return null;
  for (const ratio of PREV_CLOSE_RATIOS) if (Math.abs(Math.log(nse / ratio)) < PREV_CLOSE_MATCH) return ratio;
  return null;
}

/** Stdev of daily log returns, or null when there are too few. Pure. */
export function volatility(returns: readonly number[]): number | null {
  if (returns.length < VOL_MIN_RETURNS) return null;
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  return Math.sqrt(returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1));
}

/** Is a move to `ratio` beyond a normal day for a stock with this volatility? Unknown (undefined): yes; too little history (null): only a halving or more (or a doubling). */
function beyondNormal(ratio: number, sigma: number | null | undefined): boolean {
  if (sigma === undefined) return true;
  if (sigma === null) return wide(ratio);
  return Math.abs(Math.log(ratio)) >= GAP_SIGMAS * Math.max(sigma, SIGMA_FLOOR);
}

export interface PairContext {
  /** The corporate-actions file's rows for this ticker (and, across a rename, the old one) with this ex-date. */
  actions: readonly StoredCorporateAction[];
  /** Does the bc file list anything for this ticker within BC_NEAR_DAYS of the ex-date? */
  listedNear: boolean;
  /** Was a bc file read for the days before the ex-date (BC_NEAR_DAYS)? Silent for this ticker, it leaves only a halving or more to infer. */
  bcCovered: boolean;
  /** Across a rename: only NSE's own word (PREV_CLOSE, the bc file) counts. */
  acrossRename: boolean;
  /** Is the day's file's PREV_CLOSE off for many tickers at once (NOISY_DAY_MIN)? */
  noisyDay?: boolean;
  /** The stock's daily volatility before the pair (volatility()); null: too little history; undefined: not measured. */
  sigma?: number | null;
  /**
   * `actions` are listed for a nearby ex-date, not one within the pair (NSE's
   * date is off for this ticker: KRITIKA's split is listed for 29 Aug 2022 and
   * traded at the old price that day, at a fifth the next): only a gap that
   * fits their ratio closely counts.
   */
  offDate?: boolean;
  /** The closes of the next sessions (up to STAY_SESSIONS), for inferLooseRatio. */
  after?: readonly number[];
}

type PairRow = { day: number; c: number; series?: string };

/** The factor for one pair of consecutive sessions, or null. Pure. */
export function decideFactor(prev: PairRow, row: PairRow & { symbol: string; prev_close: number; o: number; h?: number }, context: PairContext): Factor | null {
  if (!(prev.c > 0) || !(row.c > 0)) return null;
  const purposes = [...new Set(context.actions.map((action) => action.purpose))];
  const base = { symbol: row.symbol, day: row.day, prevDay: prev.day, prevC: prev.c, prevClose: row.prev_close, o: row.o, c: row.c, action: purposes.length ? purposes.join(" · ") : null, renamedFrom: null };
  const gap = (row.o > 0 ? row.o : row.c) / prev.c;
  const closeGap = row.c / prev.c;
  // Borne out by the opening price: within ±25% of it, and nearer to it than to no change at all —
  // except for a factor within 15% of 1 (a 1:10 bonus), which a normal day's move can hide.
  // Or by the close, when the open isn't far off either (AXITA's 1:3 bonus, 20 Sep 2024: opened at 0.866, closed at 0.802).
  const borneOut = (factor: number, by: number) => {
    const off = Math.abs(Math.log(by / factor));
    return off < CONFIRM && (off <= Math.abs(Math.log(by)) || Math.abs(Math.log(factor)) < SMALL_FACTOR);
  };
  const confirmed = (factor: number) => borneOut(factor, gap) || (borneOut(factor, closeGap) && Math.abs(Math.log(gap / factor)) < 2 * CONFIRM);
  const terms = actionTerms(context.actions);
  if (context.offDate) {
    // Listed for another day: the gap must be the action's, closely (inferRatio's windows) — or, terms missing, fit them as below.
    if (!terms) return null;
    const factor = terms.unknown.length ? inferPartial(terms.known, terms.unknown, gap, closeGap) : terms.known;
    // A move a normal day can make (a 1:10 bonus's 0.91) says nothing about which day it was.
    if (factor === null || !(wide(factor) || (typeof context.sigma === "number" && beyondNormal(factor, context.sigma)))) return null;
    const window = wide(factor) ? WIDE : NARROW;
    return Math.abs(Math.log(gap / factor)) < window.open && Math.abs(Math.log(closeGap / factor)) < window.close ? { ...base, factor, source: "corporate_action" } : null;
  }
  const nse = row.prev_close > 0 ? row.prev_close / prev.c : 1;
  // An adjusted PREV_CLOSE the opening price doesn't bear out is a slip in the file (seen: VERTOZ, 11 Jul 2025, a 1→10 consolidation printed 9.81 for 9.17).
  // Only between sessions close together: after weeks without a row (FORCEMOT, Oct 2023 – Feb 2024) PREV_CLOSE is a close the store doesn't have.
  // Only within one series (BE's PREVCLOSE is BE's last close), and only what the bc file lists or a standard ratio on a day the file is otherwise right.
  const sameSeries = prev.series === undefined || row.series === undefined || prev.series === row.series;
  const nseAction = context.actions.length > 0 || (prevCloseRatio(nse) !== null && !context.noisyDay);
  if (sameSeries && Math.abs(nse - 1) > SPLIT_TOLERANCE && confirmed(nse) && row.day - prev.day <= INFER_MAX_GAP_MS && nseAction) return { ...base, factor: nse, source: "prev_close" };
  if (terms && !terms.unknown.length) return confirmed(terms.known) ? { ...base, factor: terms.known, source: "corporate_action" } : null;
  // Named without its terms ("AGM/DIV-RS 29.50/BONUS"; "FV SPLT FRM RS 10/- TO RS", cut off): the usual ratio the gap fits.
  if (terms) {
    const factor = inferPartial(terms.known, terms.unknown, gap, closeGap);
    return factor === null ? null : { ...base, factor, source: "corporate_action" };
  }
  if (context.actions.some((action) => action.kinds.includes("demerger")) && gap < 1 - SPLIT_TOLERANCE) return { ...base, factor: gap, source: "corporate_action" };
  const rights = rightsFactor(context.actions, prev.c);
  if (rights !== null) return { ...base, factor: rights, source: "corporate_action" };
  if (context.acrossRename || context.listedNear || row.day - prev.day > INFER_MAX_GAP_MS || !inferable(row.symbol, prev.c)) return null;
  const inferred = inferRatio(gap, closeGap) ?? (prev.series === row.series ? inferLooseRatio(gap, closeGap, context.after ?? [], row.c, row.h === undefined ? undefined : row.h / prev.c) : null);
  if (inferred !== null && context.bcCovered && !wide(inferred)) return null;
  return inferred === null || !beyondNormal(inferred, context.sigma) ? null : { ...base, factor: inferred, source: "price_gap" };
}

/**
 * Rights entitlements (SICAL-RE, BTML-RE1) live a few weeks and decay to
 * nothing, and under a couple of rupees a tick is a big part of the price:
 * neither has gaps worth reading as splits.
 */
const inferable = (symbol: string, price: number) => price >= MIN_INFER_PRICE && !/-RE\d*$/.test(symbol);
const MIN_INFER_PRICE = 2;

/** What deriving needs to know besides the two rows: checked days, the bc file's rows, renames, days PREV_CLOSE is off. */
class Derivation {
  private readonly unchecked: number[];
  private readonly bcDays: number[];
  /** Each ticker's bc rows, by ex-date. */
  private readonly actions = new Map<string, StoredCorporateAction[]>();
  /** Ticker|ex-date of listed actions a factor was already taken for: one ex-date, one factor. */
  private readonly used = new Set<string>();
  /** Each ticker's ex-dates in the bc file (any action), sorted. */
  private readonly listed = new Map<string, number[]>();
  private readonly renameDays = new Map<string, number[]>();
  private readonly noisy = new Map<number, boolean>();
  private readonly mismatches: Statement;

  constructor(
    db: Db,
    readonly renames: Renames,
    from: number,
    to: number,
  ) {
    // Trading days NSE wasn't asked about (or served another date for): a pair can't span one.
    const statuses = coverageStatuses(db, "cash_bhav");
    const days = sorted(statuses.keys());
    const unchecked: number[] = [];
    if (days.length) {
      for (let day = days[0]; day <= days[days.length - 1]; day += DAY_MS) {
        const status = statuses.get(day);
        if (isSessionDay(day) && status !== "ok" && status !== "holiday") unchecked.push(day);
      }
    }
    this.unchecked = unchecked;
    this.bcDays = sorted((db.prepare("select day from corporate_action_days").all() as Array<{ day: number }>).map((row) => row.day));
    const near = BC_NEAR_DAYS * DAY_MS;
    // Wide enough for a pair spanning weeks without a session.
    const span = INFER_MAX_GAP_MS + near;
    for (const action of readCorporateActions(db, Math.max(MIN_DAY, from - span), Math.min(MAX_DAY, to + near))) {
      this.actions.set(action.symbol, [...(this.actions.get(action.symbol) ?? []), action]);
      this.listed.set(action.symbol, [...(this.listed.get(action.symbol) ?? []), action.exDay]);
    }
    for (const list of this.listed.values()) list.sort((a, b) => a - b);
    for (const change of renames.changes) {
      for (const symbol of [change.oldSymbol, change.newSymbol]) this.renameDays.set(symbol, [...(this.renameDays.get(symbol) ?? []), change.day]);
    }
    for (const list of this.renameDays.values()) list.sort((a, b) => a - b);
    // Tickers whose PREV_CLOSE on a day isn't their previous close in the same series, within INFER_MAX_GAP_MS.
    this.mismatches = db.prepare(
      `select count(*) from cash_bhav r
       join cash_bhav p on p.symbol = r.symbol and p.day = (select max(q.day) from cash_bhav q where q.symbol = r.symbol and q.day < r.day)
       where r.day = ? and p.series = r.series and r.day - p.day <= ? and p.c > 0 and r.prev_close > 0 and abs(r.prev_close / p.c - 1) > ?`,
    ).pluck();
  }

  /** Every trading day strictly between a and b checked? */
  private consecutive(a: number, b: number) {
    return !anyBetween(this.unchecked, a + DAY_MS, b - DAY_MS);
  }

  /** Is the day's PREV_CLOSE off for many tickers at once? Asked only for days with a candidate, and remembered. */
  private noisyDay(day: number): boolean {
    let noisy = this.noisy.get(day);
    if (noisy === undefined) {
      noisy = (this.mismatches.get(day, INFER_MAX_GAP_MS, SPLIT_TOLERANCE) as number) >= NOISY_DAY_MIN;
      this.noisy.set(day, noisy);
    }
    return noisy;
  }

  /** The bc rows of these tickers with from <= ex-date <= to, not yet used for a factor, grouped by ex-date (nearest `around` first). */
  private listedBetween(symbols: readonly string[], from: number, to: number, around: number): StoredCorporateAction[][] {
    const groups = new Map<number, StoredCorporateAction[]>();
    for (const symbol of symbols) {
      for (const action of this.actions.get(symbol) ?? []) {
        if (action.exDay < from || action.exDay > to || this.used.has(`${symbol}|${action.exDay}`)) continue;
        groups.set(action.exDay, [...(groups.get(action.exDay) ?? []), action]);
      }
    }
    return [...groups.entries()].sort((a, b) => Math.abs(a[0] - around) - Math.abs(b[0] - around)).map(([, actions]) => actions);
  }

  pair(prev: CashRow, row: CashRow, renamedFrom: string | null, sigma?: number | null, after?: readonly number[]): Factor | null {
    if (!this.consecutive(prev.day, row.day)) return null;
    // A rename of this ticker between the two sessions: they may not even be one company.
    if (renamedFrom === null && anyBetween(this.renameDays.get(row.symbol) ?? [], prev.day + 1, row.day)) return null;
    const symbols = [row.symbol, ...(renamedFrom ? [renamedFrom] : [])];
    // The bc rows with an ex-date within the pair: on `row`'s day, or on a day the ticker didn't trade (ABMINTLTD's 5:1 bonus, ex 15 Mar 2017, first traded on the 16th) —
    // not across weeks without a session (a suspension), where the price says little about one action.
    const close = row.day - prev.day <= INFER_MAX_GAP_MS;
    const actions = this.listedBetween(symbols, close ? prev.day + DAY_MS : row.day, row.day, row.day).flat();
    const near = BC_NEAR_DAYS * DAY_MS;
    const listedNear = symbols.some((symbol) => anyBetween(this.listed.get(symbol) ?? [], row.day - near, row.day + near));
    const candidate = !actions.length && prev.series === row.series && prev.c > 0 && row.prev_close > 0 && Math.abs(row.prev_close / prev.c - 1) > SPLIT_TOLERANCE;
    const context: PairContext = { actions, listedNear, bcCovered: anyBetween(this.bcDays, row.day - near, row.day), acrossRename: renamedFrom !== null, noisyDay: candidate && this.noisyDay(row.day), sigma, after };
    let factor = decideFactor(prev, row, context);
    let usedActions = actions;
    // Nothing within the pair: a split or bonus listed a few days off whose ratio the gap fits closely.
    if (!factor && close && !actions.some((action) => action.parts.length)) {
      for (const group of this.listedBetween(symbols, row.day - near, row.day + near, row.day)) {
        if (!group.some((action) => action.parts.length)) continue;
        factor = decideFactor(prev, row, { ...context, actions: group, offDate: true });
        if (factor) {
          usedActions = group;
          break;
        }
      }
    }
    if (factor?.source === "corporate_action") for (const action of usedActions) this.used.add(`${action.symbol}|${action.exDay}`);
    return factor && renamedFrom ? { ...factor, renamedFrom } : factor;
  }
}

export interface DeriveOptions {
  /** Ex-dates to (re)derive, inclusive day keys; default: all. */
  from?: number;
  to?: number;
  /** Only these tickers (and renames into them); default: every ticker with a row in the range. */
  symbols?: readonly string[];
}

export interface DeriveResult {
  factors: number;
  bySource: Record<FactorSource, number>;
  /** Tickers whose factors in the range changed (added, removed or a different value). */
  changed: string[];
}

const MIN_DAY = Number.MIN_SAFE_INTEGER;
const MAX_DAY = Number.MAX_SAFE_INTEGER;

/** Derive the factors for ex-dates from..to and replace the stored ones there. */
export function deriveFactors(db: Db, options: DeriveOptions = {}): DeriveResult {
  const from = options.from ?? MIN_DAY;
  const to = options.to ?? MAX_DAY;
  const renames = loadRenames(db);
  const derivation = new Derivation(db, renames, from, to);
  const wanted = options.symbols ? new Set(options.symbols) : null;
  const symbols = options.symbols ?? (db.prepare("select distinct symbol from cash_bhav where day between ? and ?").pluck().all(from, to) as string[]);
  const columns = "symbol, day, series, prev_close, o, h, c";
  const rowsOf = db.prepare(`select ${columns} from cash_bhav where symbol = ? and day between ? and ? order by day`);
  const before = db.prepare(`select ${columns} from cash_bhav where symbol = ? and day < ? order by day desc limit 1`);
  const firstFrom = db.prepare(`select ${columns} from cash_bhav where symbol = ? and day >= ? order by day limit 1`);
  // The sessions before the range, to measure the stock's volatility from: their stored factors' days left out.
  const warmUp = db.prepare(`select day, c from cash_bhav where symbol = ? and day < ? order by day desc limit ${VOL_WINDOW + 1}`);
  const storedDays = db.prepare("select day from adjustment_factors where symbol = ? and day between ? and ?").pluck();

  const factors: Factor[] = [];
  for (const symbol of symbols) {
    const rows = rowsOf.all(symbol, from, to) as CashRow[];
    if (!rows.length) continue;
    let prev = (before.get(symbol, rows[0].day) as CashRow | undefined) ?? null;
    const returns: number[] = [];
    if (prev) {
      const earlier = (warmUp.all(symbol, rows[0].day) as Array<{ day: number; c: number }>).reverse();
      const skip = new Set(earlier.length ? (storedDays.all(symbol, earlier[0].day, earlier[earlier.length - 1].day) as number[]) : []);
      for (let i = 1; i < earlier.length; i += 1) if (!skip.has(earlier[i].day) && earlier[i].c > 0 && earlier[i - 1].c > 0) returns.push(Math.log(earlier[i].c / earlier[i - 1].c));
    }
    for (const [i, row] of rows.entries()) {
      if (prev) {
        const after = rows.slice(i + 1, i + 1 + STAY_SESSIONS).filter((next) => next.day - row.day <= INFER_MAX_GAP_MS).map((next) => next.c);
        const factor = derivation.pair(prev, row, null, volatility(returns), after);
        if (factor) factors.push(factor);
        // A factor's own move stays out of the volatility, like a move across weeks without a session.
        else if (prev.c > 0 && row.c > 0 && row.day - prev.day <= INFER_MAX_GAP_MS) {
          returns.push(Math.log(row.c / prev.c));
          if (returns.length > VOL_WINDOW) returns.shift();
        }
      }
      prev = row;
    }
  }
  for (const change of renames.changes) {
    if (wanted && !wanted.has(change.newSymbol)) continue;
    const row = firstFrom.get(change.newSymbol, change.day) as CashRow | undefined;
    const prev = before.get(change.oldSymbol, change.day) as CashRow | undefined;
    if (!row || !prev || row.day < from || row.day > to) continue;
    // The new ticker traded after the old one's last session already: that pair was taken above.
    const own = before.get(change.newSymbol, row.day) as CashRow | undefined;
    if (own && own.day >= prev.day) continue;
    const factor = derivation.pair(prev, row, change.oldSymbol);
    if (factor) factors.push(factor);
  }
  return { ...writeFactors(db, factors, from, to, options.symbols), factors: factors.length, bySource: countBySource(factors) };
}

const countBySource = (factors: readonly Factor[]) => {
  const out = Object.fromEntries(FACTOR_SOURCES.map((source) => [source, 0])) as Record<FactorSource, number>;
  for (const factor of factors) out[factor.source] += 1;
  return out;
};

function writeFactors(db: Db, factors: readonly Factor[], from: number, to: number, symbols?: readonly string[]): { changed: string[] } {
  const scope = symbols ? ` and symbol in (${symbols.map(() => "?").join(",")})` : "";
  const args = [from, to, ...(symbols ?? [])];
  const insert = db.prepare(
    `insert or replace into adjustment_factors (symbol, day, factor, source, prev_day, prev_c, prev_close, o, c, action, renamed_from)
     values (@symbol, @day, @factor, @source, @prevDay, @prevC, @prevClose, @o, @c, @action, @renamedFrom)`,
  );
  let changed: string[] = [];
  db.transaction(() => {
    const old = new Map((db.prepare(`select symbol, day, factor from adjustment_factors where day between ? and ?${scope}`).all(...args) as Array<{ symbol: string; day: number; factor: number }>).map((row) => [`${row.symbol}|${row.day}`, row]));
    const touched = new Set<string>();
    for (const factor of factors) {
      const key = `${factor.symbol}|${factor.day}`;
      const before = old.get(key);
      if (!before || Math.abs(before.factor - factor.factor) > 1e-9) touched.add(factor.symbol);
      old.delete(key);
    }
    for (const gone of old.values()) touched.add(gone.symbol);
    db.prepare(`delete from adjustment_factors where day between ? and ?${scope}`).run(...args);
    for (const factor of factors) insert.run(factor);
    changed = [...touched].sort();
  })();
  return { changed };
}

interface FactorRow {
  symbol: string;
  day: number;
  factor: number;
  source: FactorSource;
  prev_day: number;
  prev_c: number;
  prev_close: number;
  o: number;
  c: number;
  action: string | null;
  renamed_from: string | null;
}

const toFactor = (row: FactorRow): Factor => ({ symbol: row.symbol, day: row.day, factor: row.factor, source: row.source, prevDay: row.prev_day, prevC: row.prev_c, prevClose: row.prev_close, o: row.o, c: row.c, action: row.action, renamedFrom: row.renamed_from });

/** Stored factors of one ticker with from <= day < until (null = open-ended), oldest first. */
export function readFactors(db: Db, symbol: string, from: number | null = null, until: number | null = null): Factor[] {
  return (db.prepare("select * from adjustment_factors where symbol = ? and day >= ? and day < ? order by day").all(symbol, from ?? MIN_DAY, until ?? MAX_DAY) as FactorRow[]).map(toFactor);
}

/** Every stored factor of a listing: each of its names' factors while it had that name, oldest first. */
export function readListingFactors(db: Db, listing: Listing): Factor[] {
  return listing.names.flatMap((name) => readFactors(db, name.symbol, name.from, name.until)).sort((a, b) => a.day - b.day);
}

/** The listing that had `symbol` on `day`, and its factors. */
export function listingFactors(db: Db, symbol: string, day: number, renames?: Renames): { listing: Listing; factors: Factor[] } {
  const listing = listingOf(db, symbol, day, renames);
  return { listing, factors: readListingFactors(db, listing) };
}

/**
 * The cumulative factor for a bar at `t`: the product of the factors with an
 * ex-date after t. `factors` oldest first; call with t ascending or not — it's a
 * binary search over suffix products.
 */
export function cumulative(factors: readonly Factor[]): (t: number) => number {
  const days = factors.map((factor) => factor.day);
  const suffix = new Array<number>(factors.length + 1).fill(1);
  for (let i = factors.length - 1; i >= 0; i -= 1) suffix[i] = suffix[i + 1] * factors[i].factor;
  return (t: number) => suffix[lowerBound(days, t + 1)];
}

export interface FactorStats {
  factors: number;
  symbols: number;
  bySource: Record<FactorSource, number>;
  first: number | null;
  last: number | null;
  corporateActions: number;
  corporateActionDays: number;
}

export function factorStats(db: Db): FactorStats {
  const totals = db.prepare("select count(*) as factors, count(distinct symbol) as symbols, min(day) as first, max(day) as last from adjustment_factors").get() as { factors: number; symbols: number; first: number | null; last: number | null };
  const bySource = Object.fromEntries(FACTOR_SOURCES.map((source) => [source, 0])) as Record<FactorSource, number>;
  for (const row of db.prepare("select source, count(*) as n from adjustment_factors group by source").all() as Array<{ source: FactorSource; n: number }>) bySource[row.source] = row.n;
  const corporateActions = (db.prepare("select count(*) as n from corporate_actions").get() as { n: number }).n;
  const corporateActionDays = (db.prepare("select count(*) as n from corporate_action_days").get() as { n: number }).n;
  return { ...totals, bySource, corporateActions, corporateActionDays };
}

/** Bump when the derivation changes: the server derives every factor again on its next start. */
export const ADJUSTMENT_VERSION = 3;
const KV_KEY = "adjustments";

export interface AdjustmentRun {
  version: number;
  derivedAt: number;
  factors: number;
}

export function lastAdjustmentRun(db: Db): AdjustmentRun | null {
  return readKv<AdjustmentRun>(db, KV_KEY);
}

/**
 * Derive every factor again (after NSE history lands, a bc re-read, or a new
 * version of the derivation). `endOfDay`: the stored daily series were built
 * from the archive with the old factors, so those of the tickers whose factors
 * changed — and of the other names of their listings — are dropped (the next
 * request rebuilds them). A broker's series don't depend on these factors.
 */
export function rederiveAll(db: Db, options: { endOfDay: boolean; now: number }): DeriveResult & { reset: string[] } {
  // The stored kinds and ratios, as today's parser reads the purposes (the derivation reads them afresh anyway).
  refreshCorporateActions(db);
  const result = deriveFactors(db);
  const reset = new Set<string>();
  if (options.endOfDay && result.changed.length) {
    const changes = loadRenames(db).changes;
    const queue = [...result.changed];
    while (queue.length) {
      const symbol = queue.pop()!;
      if (reset.has(symbol)) continue;
      reset.add(symbol);
      for (const change of changes) {
        if (change.oldSymbol === symbol && !reset.has(change.newSymbol)) queue.push(change.newSymbol);
        if (change.newSymbol === symbol && !reset.has(change.oldSymbol)) queue.push(change.oldSymbol);
      }
    }
    for (const symbol of reset) resetSymbol(db, symbol);
  }
  writeKv(db, KV_KEY, { version: ADJUSTMENT_VERSION, derivedAt: options.now, factors: result.factors } satisfies AdjustmentRun, options.now);
  return { ...result, reset: [...reset].sort() };
}

/** On start: derive everything when it has never been done, or was done by an older version. Returns null when nothing was needed. */
export function ensureFactors(db: Db, options: { endOfDay: boolean; now: number }): (DeriveResult & { reset: string[] }) | null {
  if (lastAdjustmentRun(db)?.version === ADJUSTMENT_VERSION) return null;
  return rederiveAll(db, options);
}
