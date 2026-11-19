import { isFuture, isIndex } from "../broker/symbols.js";
import type { Db } from "../db.js";
import { readCorporateActions } from "../nse/store.js";
import { loadRenames, namesBetween, storedTraded, type Listing } from "../reference/renames.js";
import { DAY_MS, isoDay } from "../time.js";
import { readListingFactors, type Factor } from "./adjustments.js";
import { listSeries, readBars } from "./store.js";

// `hub data adjustments --check`: the derived factors against the broker's
// adjusted daily history (Fyers adjusts its ~5 years for splits and bonuses),
// stock by stock, over the days both are stored.
//
// For two consecutive overlapping sessions t1 < t2 the broker's own factor is
// (B(t1) / R(t1)) / (B(t2) / R(t2)) — B the broker's close, R NSE's raw close —
// and ours is the product of the derived factors with t1 < ex-date <= t2. They
// should agree (both are 1 on almost every day). Each disagreement beyond the
// tolerance gets a reason:
//   data_error    one bar differs and the next puts it back (a bad bar on one side)
//   broker_stale  the stored broker series was downloaded before the ex-date and
//                 extended from the bhavcopy since, so it was never adjusted
//   dividend      only a dividend that day (the broker adjusted for it; NSE doesn't)
//   rights        a rights issue (NSE adjusts its base price for some; brokers differ)
//   demerger      a demerger or scheme of arrangement (the factor is a price, not a ratio)
//   unexplained   none of these
// The corporate-actions file (the PR zip's bc file) within 5 days of the pair
// gives the reasons, so they're only as good as what of it is stored.
// "Matching bars" compares levels too: NSE's raw close × our cumulative factor
// against the broker's close, both relative to the newest overlapping session.

export type Reason = "data_error" | "broker_stale" | "dividend" | "rights" | "demerger" | "unexplained";
export const REASONS: readonly Reason[] = ["data_error", "broker_stale", "dividend", "rights", "demerger", "unexplained"];

export interface Disagreement {
  symbol: string;
  /** The session before and the ex-date (or the odd bar, for data_error), YYYY-MM-DD. */
  prevDate: string;
  date: string;
  /** The broker's factor and ours for that step (1 = none). */
  broker: number;
  derived: number;
  /** Where ours came from, when we have one. */
  source: Factor["source"] | null;
  reason: Reason;
  /** The corporate-actions file's purposes near the date, and a word on the reason. */
  actions: string[];
  note: string;
}

export interface SymbolCheck {
  symbol: string;
  overlap: number;
  from: string | null;
  to: string | null;
  /** Ex-dates (ours or the broker's) in the overlap, and how many agree. */
  events: number;
  agreed: number;
  /** Overlapping sessions whose adjusted close matches the broker's within the tolerance. */
  matchingBars: number;
}

export interface CheckReport {
  tolerance: number;
  /** Stocks with a stored daily broker series, and those of them overlapping NSE's stored files. */
  symbols: number;
  overlapping: number;
  overlapBars: number;
  matchingBars: number;
  events: number;
  agreed: number;
  /** Derived factors inside the overlap, by source. */
  derived: Record<Factor["source"], number>;
  byReason: Record<Reason, number>;
  disagreements: Disagreement[];
  perSymbol: SymbolCheck[];
}

interface Joined {
  day: number;
  broker: number;
  raw: number;
}

const ACTION_WINDOW_MS = 5 * DAY_MS;
const round = (value: number) => Math.round(value * 1e4) / 1e4;

/** Pure: the step-by-step comparison for one stock. Exported for tests. */
export function compareSeries(symbol: string, joined: readonly Joined[], factors: readonly Factor[], tolerance: number, context: { syncedAt: number; actionsNear: (from: number, to: number) => Array<{ purpose: string; kinds: string[] }> }): { check: SymbolCheck; disagreements: Disagreement[]; derived: Factor[] } {
  const tol = Math.log(1 + tolerance);
  const inOverlap = factors.filter((factor) => joined.length > 1 && factor.day > joined[0].day && factor.day <= joined[joined.length - 1].day);
  const steps: Array<{ prev: Joined; next: Joined; broker: number; derived: number; factor: Factor | null; error: number }> = [];
  let k = 0;
  for (let i = 1; i < joined.length; i += 1) {
    const [prev, next] = [joined[i - 1], joined[i]];
    let derived = 1;
    let factor: Factor | null = null;
    while (k < inOverlap.length && inOverlap[k].day <= next.day) {
      if (inOverlap[k].day > prev.day) {
        derived *= inOverlap[k].factor;
        factor = inOverlap[k];
      }
      k += 1;
    }
    const broker = prev.broker / prev.raw / (next.broker / next.raw);
    steps.push({ prev, next, broker, derived, factor, error: Math.log(broker / derived) });
  }

  const disagreements: Disagreement[] = [];
  let events = 0;
  let agreed = 0;
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    const event = Math.abs(Math.log(step.broker)) > tol || Math.abs(Math.log(step.derived)) > tol;
    if (event) events += 1;
    if (Math.abs(step.error) <= tol) {
      if (event) agreed += 1;
      continue;
    }
    const near = context.actionsNear(step.prev.day - ACTION_WINDOW_MS, step.next.day + ACTION_WINDOW_MS);
    const actions = [...new Set(near.map((action) => action.purpose))];
    const base = { symbol, prevDate: isoDay(step.prev.day), date: isoDay(step.next.day), broker: round(step.broker), derived: round(step.derived), source: step.factor?.source ?? null, actions };
    // A bar off on one side and back the next session: one bad bar, not an action.
    const after = steps[i + 1];
    if (after && Math.abs(after.error) > tol && Math.abs(step.error + after.error) <= tol && Math.abs(Math.log(step.derived)) <= tol && Math.abs(Math.log(after.derived)) <= tol) {
      disagreements.push({ ...base, reason: "data_error", note: `the ${isoDay(step.next.day)} close differs by ${(100 * (Math.exp(-step.error) - 1)).toFixed(2)}% between NSE (${step.next.raw}) and the broker (${step.next.broker}) and agrees again the next session` });
      i += 1;
      continue;
    }
    const kinds = new Set(near.flatMap((action) => action.kinds));
    const brokerMoved = Math.abs(Math.log(step.broker)) > tol;
    const oursMoved = Math.abs(Math.log(step.derived)) > tol;
    let reason: Reason = "unexplained";
    let note: string;
    if (oursMoved && !brokerMoved && context.syncedAt < step.next.day) {
      reason = "broker_stale";
      note = "the stored broker series was downloaded before this ex-date and extended from NSE's bhavcopy since: it was never adjusted (fixed going forward: the bhavcopy now resets it)";
    } else if (kinds.has("demerger") || kinds.has("arrangement")) {
      reason = "demerger";
      note = "a demerger's factor comes from the price discovered on the ex-date; broker and NSE take it differently";
    } else if (kinds.has("rights")) {
      reason = "rights";
      note = oursMoved && step.factor?.source === "prev_close" ? "NSE adjusted its PREV_CLOSE for the rights issue; the broker didn't" : "a rights issue: adjusted on one side only";
    } else if (kinds.has("dividend") && !kinds.has("bonus") && !kinds.has("split") && !kinds.has("consolidation")) {
      reason = "dividend";
      note = brokerMoved ? "the broker adjusted for the dividend; split/bonus factors don't" : "only a dividend near this date";
    } else if (!near.length) {
      note = step.factor?.source === "price_gap" ? "our factor is a price-gap inference; no corporate-actions file is stored for these days" : "no corporate-actions file is stored for these days, or it lists nothing for this ticker";
    } else note = "the corporate-actions file doesn't explain the difference";
    disagreements.push({ ...base, reason, note });
  }

  // Levels: raw × our cumulative factor vs the broker, both relative to the newest overlapping session.
  let matchingBars = 0;
  if (joined.length) {
    const last = joined[joined.length - 1];
    const scale = last.broker / last.raw;
    let cumulative = 1;
    let j = inOverlap.length - 1;
    for (let i = joined.length - 1; i >= 0; i -= 1) {
      while (j >= 0 && inOverlap[j].day > joined[i].day) {
        cumulative *= inOverlap[j].factor;
        j -= 1;
      }
      if (Math.abs(Math.log((joined[i].raw * cumulative * scale) / joined[i].broker)) <= tol) matchingBars += 1;
    }
  }
  return {
    check: { symbol, overlap: joined.length, from: joined.length ? isoDay(joined[0].day) : null, to: joined.length ? isoDay(joined[joined.length - 1].day) : null, events, agreed, matchingBars },
    disagreements,
    derived: inOverlap,
  };
}

export interface CheckOptions {
  /** Only these stocks (default: every stock with a stored daily series). */
  symbols?: readonly string[];
  /** Relative tolerance (default 0.005 = 0.5%). */
  tolerance?: number;
}

/**
 * Compare every stored daily series with NSE's raw closes and the factors.
 * Meaningful only when the series came from a broker: in end-of-day mode they
 * are built from the very same factors.
 */
export function checkAdjustments(db: Db, options: CheckOptions = {}): CheckReport {
  const tolerance = options.tolerance ?? 0.005;
  const wanted = options.symbols ? new Set(options.symbols) : null;
  const renames = loadRenames(db);
  const traded = storedTraded(db);
  const rawOf = db.prepare("select day, c from cash_bhav where symbol = ? and day between ? and ? order by day");
  const report: CheckReport = {
    tolerance,
    symbols: 0,
    overlapping: 0,
    overlapBars: 0,
    matchingBars: 0,
    events: 0,
    agreed: 0,
    derived: { prev_close: 0, corporate_action: 0, price_gap: 0 },
    byReason: Object.fromEntries(REASONS.map((reason) => [reason, 0])) as Record<Reason, number>,
    disagreements: [],
    perSymbol: [],
  };
  for (const meta of listSeries(db, "1d").sort((a, b) => (a.symbol < b.symbol ? -1 : 1))) {
    const symbol = meta.symbol;
    if (isIndex(symbol) || isFuture(symbol) || (wanted && !wanted.has(symbol)) || meta.firstT === null || meta.lastT === null) continue;
    report.symbols += 1;
    const bars = readBars(db, symbol, "1d", meta.firstT, meta.lastT + 1);
    const listing: Listing = renames.listing(symbol, meta.lastT, traded);
    const raw = new Map<number, number>();
    for (const name of namesBetween(listing, meta.firstT, meta.lastT)) for (const row of rawOf.all(name.symbol, name.from, name.to) as Array<{ day: number; c: number }>) raw.set(row.day, row.c);
    const joined: Joined[] = [];
    for (const bar of bars) {
      const c = raw.get(bar.t);
      if (c !== undefined && c > 0 && bar.c > 0) joined.push({ day: bar.t, broker: bar.c, raw: c });
    }
    if (joined.length < 2) continue;
    report.overlapping += 1;
    const names = listing.names.map((name) => name.symbol);
    const { check, disagreements, derived } = compareSeries(symbol, joined, readListingFactors(db, listing), tolerance, {
      syncedAt: meta.syncedAt,
      actionsNear: (from, to) => readCorporateActions(db, from, to, names),
    });
    report.perSymbol.push(check);
    report.overlapBars += check.overlap;
    report.matchingBars += check.matchingBars;
    report.events += check.events;
    report.agreed += check.agreed;
    for (const factor of derived) report.derived[factor.source] += 1;
    for (const disagreement of disagreements) report.byReason[disagreement.reason] += 1;
    report.disagreements.push(...disagreements);
  }
  return report;
}
