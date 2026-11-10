import type { Bar } from "../broker/fyers.js";

// What to fetch from the broker, given what's stored (pure). A series' coverage
// is one contiguous half-open range [from, to) of bar start times in which
// every final bar is stored. A request only ever fetches the part before the
// coverage ("head") and the part after it ("tail"), so coverage stays one
// range however requests jump around: a request far older than what's stored
// fetches everything in between too. (Adapted from Tradex's history planning.)

export interface Range {
  from: number;
  to: number;
}

export type Missing = Range & { part: "head" | "tail" | "all" };

/**
 * Ranges of `want` that must come from the broker. `final` is the exclusive end
 * of bars that have closed; `formingStale` says a stored copy of the forming bar
 * is too old to serve (only matters when `want` reaches past `final`).
 */
export function missingRanges(coverage: Range | null, want: Range, final: number, formingStale: boolean): Missing[] {
  if (want.from >= want.to) return [];
  if (!coverage) return [{ ...want, part: "all" }];
  const out: Missing[] = [];
  if (want.from < coverage.from) out.push({ from: want.from, to: coverage.from, part: "head" });
  const needFinalTo = Math.min(want.to, final);
  if (coverage.to < needFinalTo || (want.to > coverage.to && formingStale)) out.push({ from: coverage.to, to: want.to, part: "tail" });
  return out;
}

/** Is `range` inside the coverage? */
export const covers = (coverage: Range | null, range: Range) => Boolean(coverage && coverage.from <= range.from && coverage.to >= range.to);

/**
 * Coverage after a fetch claimed `claimed`: the union when they touch, else
 * unchanged (a gap must not be papered over). A first claim may be empty (only a
 * forming bar was fetched): it still records where the series stands.
 */
export function extendCoverage(coverage: Range | null, claimed: Range): Range | null {
  if (!coverage) return claimed.from <= claimed.to ? claimed : null;
  if (claimed.from >= claimed.to) return coverage;
  if (claimed.from > coverage.to || claimed.to < coverage.from) return coverage;
  return { from: Math.min(coverage.from, claimed.from), to: Math.max(coverage.to, claimed.to) };
}

/**
 * Does a daily range need the broker when the newest final session (`latestFinal`,
 * a day key) may still arrive from NSE's cash bhavcopy that evening? Only when
 * something other than that one session is missing.
 */
export function needsBrokerBeyond(coverage: Range | null, want: Range, latestFinal: number): boolean {
  const required = { from: want.from, to: Math.min(want.to, latestFinal) };
  return required.from < required.to && !covers(coverage, required);
}

/** A past close moving this much means the broker adjusted history (split, bonus). */
export const ADJUSTMENT_TOLERANCE = 0.01;

/**
 * Did the broker adjust history? Compares closes of bars that were already final
 * when stored (start before `finalWhenStored`) with a fresh download of the same bars.
 */
export function wasAdjusted(stored: Bar[], fetched: Bar[], finalWhenStored: number): boolean {
  const byT = new Map(stored.filter((bar) => bar.t < finalWhenStored).map((bar) => [bar.t, bar]));
  return fetched.some((bar) => {
    const old = byT.get(bar.t);
    return old !== undefined && old.c > 0 && Math.abs(bar.c / old.c - 1) > ADJUSTMENT_TOLERANCE;
  });
}
