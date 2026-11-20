import { readKv, writeKv, type Db } from "../db.js";
import { WEEKEND_SESSIONS } from "../nse/datasets.js";
import { rightsTerms } from "../nse/parsers/corporateActions.js";
import { dayStatuses, readCorporateActions, type StoredCorporateAction } from "../nse/store.js";
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
//   price_gap         no bc file was read for the week before the ex-date
//                     (before 2010, or PR zips not downloaded): an opening gap
//                     near a standard ratio (STANDARD_RATIOS; inferRatio) — a
//                     move a price band or a normal day doesn't make — is taken
//                     for that ratio. Where a bc file was read and lists
//                     nothing, a gap is just a gap.
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
const INFER_MAX_GAP_MS = 15 * DAY_MS;
const CONFIRM = Math.log(1.25);
const SMALL_FACTOR = Math.log(1.15);
/** A bc file this many days before an ex-date (or on it) lists the action. */
export const BC_LOOKBACK_DAYS = 7;

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
  prev_close: number;
  o: number;
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

/** The ratio an action list implies: one bonus, one split and one consolidation at most (NSE sometimes words one twice). */
function actionRatio(actions: readonly StoredCorporateAction[]): number | null {
  const byKind = new Map<string, number>();
  for (const action of actions) {
    if (action.ratio === null) continue;
    const kind = action.kinds.find((k) => k === "bonus" || k === "split" || k === "consolidation") ?? "other";
    if (!byKind.has(kind)) byKind.set(kind, action.ratio);
  }
  return byKind.size ? [...byKind.values()].reduce((product, ratio) => product * ratio, 1) : null;
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

/** The standard ratio a gap is, or null. Pure. */
export function inferRatio(openGap: number, closeGap: number): number | null {
  if (!(openGap > 0) || !(closeGap > 0)) return null;
  // The nearest ratio to the open, then whether open and close are near enough.
  let ratio = STANDARD_RATIOS[0];
  for (const candidate of STANDARD_RATIOS) if (Math.abs(Math.log(openGap / candidate)) < Math.abs(Math.log(openGap / ratio))) ratio = candidate;
  const window = ratio <= 0.5 || ratio >= 2 ? WIDE : NARROW;
  return Math.abs(Math.log(openGap / ratio)) < window.open && Math.abs(Math.log(closeGap / ratio)) < window.close ? ratio : null;
}

export interface PairContext {
  /** The corporate-actions file's rows for this ticker (and, across a rename, the old one) with this ex-date. */
  actions: readonly StoredCorporateAction[];
  /** Was a bc file read for the days before the ex-date? */
  bcCovered: boolean;
  /** Across a rename: only NSE's own word (PREV_CLOSE, the bc file) counts. */
  acrossRename: boolean;
}

/** The factor for one pair of consecutive sessions, or null. Pure. */
export function decideFactor(prev: { day: number; c: number }, row: { symbol: string; day: number; prev_close: number; o: number; c: number }, context: PairContext): Factor | null {
  if (!(prev.c > 0) || !(row.c > 0)) return null;
  const purposes = [...new Set(context.actions.map((action) => action.purpose))];
  const base = { symbol: row.symbol, day: row.day, prevDay: prev.day, prevC: prev.c, prevClose: row.prev_close, o: row.o, c: row.c, action: purposes.length ? purposes.join(" · ") : null, renamedFrom: null };
  const gap = (row.o > 0 ? row.o : row.c) / prev.c;
  // Borne out by the opening price: within ±25% of it, and nearer to it than to no change at all —
  // except for a factor within 15% of 1 (a 1:10 bonus), which a normal day's move can hide.
  const confirmed = (factor: number) => {
    const off = Math.abs(Math.log(gap / factor));
    return off < CONFIRM && (off <= Math.abs(Math.log(gap)) || Math.abs(Math.log(factor)) < SMALL_FACTOR);
  };
  const nse = row.prev_close > 0 ? row.prev_close / prev.c : 1;
  // An adjusted PREV_CLOSE the opening price doesn't bear out is a slip in the file (seen: VERTOZ, 11 Jul 2025, a 1→10 consolidation printed 9.81 for 9.17).
  // Only between sessions close together: after weeks without a row (FORCEMOT, Oct 2023 – Feb 2024) PREV_CLOSE is a close the store doesn't have.
  if (Math.abs(nse - 1) > SPLIT_TOLERANCE && confirmed(nse) && row.day - prev.day <= INFER_MAX_GAP_MS) return { ...base, factor: nse, source: "prev_close" };
  const ratio = actionRatio(context.actions);
  if (ratio !== null) return confirmed(ratio) ? { ...base, factor: ratio, source: "corporate_action" } : null;
  if (context.actions.some((action) => action.kinds.includes("demerger")) && gap < 1 - SPLIT_TOLERANCE) return { ...base, factor: gap, source: "corporate_action" };
  const rights = rightsFactor(context.actions, prev.c);
  if (rights !== null) return { ...base, factor: rights, source: "corporate_action" };
  if (context.acrossRename || context.bcCovered || row.day - prev.day > INFER_MAX_GAP_MS || !inferable(row.symbol, prev.c)) return null;
  const inferred = inferRatio(gap, row.c / prev.c);
  return inferred === null ? null : { ...base, factor: inferred, source: "price_gap" };
}

/**
 * Rights entitlements (SICAL-RE, BTML-RE1) live a few weeks and decay to
 * nothing, and under a couple of rupees a tick is a big part of the price:
 * neither has gaps worth reading as splits.
 */
const inferable = (symbol: string, price: number) => price >= MIN_INFER_PRICE && !/-RE\d*$/.test(symbol);
const MIN_INFER_PRICE = 2;

/** What deriving needs to know besides the two rows: checked days, bc coverage, actions, renames. */
class Derivation {
  private readonly unchecked: number[];
  private readonly bcDays: number[];
  private readonly actions = new Map<string, StoredCorporateAction[]>();
  private readonly renameDays = new Map<string, number[]>();

  constructor(
    db: Db,
    readonly renames: Renames,
    from: number,
    to: number,
  ) {
    // Trading days NSE wasn't asked about (or served another date for): a pair can't span one.
    const statuses = dayStatuses(db, "cash_bhav");
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
    for (const action of readCorporateActions(db, from, to)) {
      const key = `${action.symbol}|${action.exDay}`;
      this.actions.set(key, [...(this.actions.get(key) ?? []), action]);
    }
    for (const change of renames.changes) {
      for (const symbol of [change.oldSymbol, change.newSymbol]) this.renameDays.set(symbol, [...(this.renameDays.get(symbol) ?? []), change.day]);
    }
    for (const list of this.renameDays.values()) list.sort((a, b) => a - b);
  }

  /** Every trading day strictly between a and b checked? */
  private consecutive(a: number, b: number) {
    return !anyBetween(this.unchecked, a + DAY_MS, b - DAY_MS);
  }

  pair(prev: CashRow, row: CashRow, renamedFrom: string | null): Factor | null {
    if (!this.consecutive(prev.day, row.day)) return null;
    // A rename of this ticker between the two sessions: they may not even be one company.
    if (renamedFrom === null && anyBetween(this.renameDays.get(row.symbol) ?? [], prev.day + 1, row.day)) return null;
    const actions = [...(this.actions.get(`${row.symbol}|${row.day}`) ?? []), ...(renamedFrom ? (this.actions.get(`${renamedFrom}|${row.day}`) ?? []) : [])];
    const bcCovered = anyBetween(this.bcDays, row.day - BC_LOOKBACK_DAYS * DAY_MS, row.day);
    const factor = decideFactor(prev, row, { actions, bcCovered, acrossRename: renamedFrom !== null });
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
  const rowsOf = db.prepare("select symbol, day, prev_close, o, c from cash_bhav where symbol = ? and day between ? and ? order by day");
  const before = db.prepare("select symbol, day, prev_close, o, c from cash_bhav where symbol = ? and day < ? order by day desc limit 1");
  const firstFrom = db.prepare("select symbol, day, prev_close, o, c from cash_bhav where symbol = ? and day >= ? order by day limit 1");

  const factors: Factor[] = [];
  for (const symbol of symbols) {
    const rows = rowsOf.all(symbol, from, to) as CashRow[];
    if (!rows.length) continue;
    let prev = (before.get(symbol, rows[0].day) as CashRow | undefined) ?? null;
    for (const row of rows) {
      if (prev) {
        const factor = derivation.pair(prev, row, null);
        if (factor) factors.push(factor);
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
export const ADJUSTMENT_VERSION = 1;
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
