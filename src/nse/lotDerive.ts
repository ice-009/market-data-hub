// Lot sizes before NSE's F&O bhavcopy carried them (market-data-hub#49). The
// old-format files (9 Nov 2001 to 5 Jul 2024) have no lot column, but their
// open interest is in shares and every open contract is a whole number of
// lots, so each day's near-month OI is a multiple of the lot. The greatest
// common divisor of a dozen different OI figures is the lot itself (a larger
// shared factor by chance: under 1 in 4,000). Pure: no I/O.
//
// Per stock, over its near-month OI day by day (a stretch out of the F&O list
// longer than RELISTING_GAP_DAYS starts afresh):
//   1. each day takes two runs, back from it and on from it, each until it has
//      MIN_VALUES different figures; where both give the same gcd (or, at
//      either end, the only long one equals the short one's), that is the lot;
//   2. days between two such days with lots A and B get A, B, or A then B
//      changing on the day the close moves by A/B (a split or bonus resizes
//      open contracts), else on a roll to a new near month (NSE's revisions
//      apply to new contracts), else where every day's OI fits — and two
//      changes close together (a split, then a revision at the next roll)
//      give A, C, B;
//   3. a day is "low" confidence when that was ambiguous, when no run was long
//      enough, or when lot × close is under MIN_NOTIONAL.
// Checked against the lot column of the current files (8 Jul 2024 to 27 Nov
// 2026, 123,648 stock-days): every "high" day right, 136 "low" (113 of them right).

export interface FoOiDay {
  day: number;
  /** The near month's expiry and open interest (shares). */
  nearExpiry: number;
  nearOi: number;
  /** The near month's close (a split or bonus moves it as far as it moves the lot). */
  close: number;
}

export interface DerivedLot {
  day: number;
  lot: number;
  confidence: "high" | "low";
}

/** Different OI figures a run collects before its gcd is trusted. */
export const MIN_VALUES = 12;
/** Longest run of sessions looked at either way. */
export const MAX_RUN = 40;
/** A close that moves by the lot's ratio within this (log) says the lot changed that day (a split or bonus). */
const PRICE_MATCH = 0.08;
/** A contract worth less than this (lot × close, rupees) is implausible: NSE's minimum has been ₹2 lakh or more since 2001. */
export const MIN_NOTIONAL = 10_000;
/** A close-to-close move this large (log) is a split or bonus, not trading. */
const SPLIT_MOVE = 0.3;

const gcd = (a: number, b: number): number => {
  while (b) [a, b] = [b, a % b];
  return a;
};

const whole = (value: number | null) => (value !== null && Number.isFinite(value) && value > 0 ? Math.round(value) : 0);

/** A stock out of the F&O list longer than this (calendar days) came back as a new listing: runs don't cross it. */
export const RELISTING_GAP_DAYS = 20;
const DAY_MS = 86_400_000;

/**
 * Derived lot per stored day of one stock. Days without open interest in the
 * near month have none.
 */
export function deriveLots(days: readonly FoOiDay[]): DerivedLot[] {
  const sorted = [...days].filter((day) => whole(day.nearOi) > 0).sort((a, b) => a.day - b.day);
  const out: DerivedLot[] = [];
  let start = 0;
  for (let i = 1; i <= sorted.length; i += 1) {
    if (i < sorted.length && sorted[i].day - sorted[i - 1].day <= RELISTING_GAP_DAYS * DAY_MS) continue;
    out.push(...deriveListing(sorted.slice(start, i)));
    start = i;
  }
  return out;
}

/** One stretch of F&O days without a long break, in day order. */
function deriveListing(sorted: readonly FoOiDay[]): DerivedLot[] {
  const oi = sorted.map((day) => whole(day.nearOi));
  const n = sorted.length;

  /** gcd of a run from `start` stepping by `step`, and how many different figures it saw. */
  const run = (start: number, step: 1 | -1) => {
    let g = 0;
    const seen = new Set<number>();
    for (let i = start, k = 0; i >= 0 && i < n && k < MAX_RUN && seen.size < MIN_VALUES; i += step, k += 1) {
      g = gcd(g, oi[i]);
      seen.add(oi[i]);
    }
    return { g, full: seen.size >= MIN_VALUES };
  };

  // 1. Days both runs agree on: the runs either side give the same gcd, or
  //    only one is long enough and the other (at the start or end of the
  //    stored days) is a multiple of it.
  const lots: Array<number | null> = new Array<number | null>(n).fill(null);
  const fallback: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const back = run(i, -1);
    const forward = run(i, 1);
    fallback.push(gcd(back.g, forward.g));
    if (back.full && forward.full) lots[i] = back.g === forward.g ? back.g : null;
    else if (back.full || forward.full) {
      // At the first or last stored days only one run is long enough. Its gcd
      // is the lot only if the short run agrees exactly: a short run that is a
      // strict multiple of it means the long run may reach across a lot change
      // (1250 then 1000 gives 250), so the day is left to step 2.
      const [long, short] = back.full ? [back, forward] : [forward, back];
      lots[i] = short.g === long.g ? long.g : null;
    }
  }

  // 2. Between two agreed days: one lot, or a change from A to B on the day
  //    the close moves by A/B (a split or bonus), else at the first day the
  //    near month rolls over (NSE's revisions apply from a new contract), else
  //    the change that fits every day's OI — the earliest when the lot grew to
  //    a multiple (earlier days fit A anyway), the latest when it shrank.
  const out: DerivedLot[] = sorted.map((day, i) => ({ day: day.day, lot: lots[i] ?? fallback[i], confidence: lots[i] === null ? "low" : "high" }));
  let i = 0;
  while (i < n) {
    if (lots[i] !== null) {
      i += 1;
      continue;
    }
    const from = i;
    while (i < n && lots[i] === null) i += 1;
    const to = i; // first agreed day after the gap (or n)
    const a = from > 0 ? lots[from - 1]! : null;
    const b = to < n ? lots[to]! : null;
    const fits = (k: number, lot: number) => oi[k] % lot === 0;
    if (a !== null && a === b) {
      for (let k = from; k < to; k += 1) if (fits(k, a)) out[k] = { day: sorted[k].day, lot: a, confidence: "high" };
      continue;
    }
    if (a === null || b === null) {
      // At the newest (or oldest) stored days there is no agreed lot on the far
      // side: the known one holds only while every day fits it, from the agreed
      // day outward. From the first day that doesn't, the lot changed: those days
      // get the gcd of their own figures, at low confidence (a later day that
      // fits the old lot by chance doesn't bring it back).
      const lot = (a ?? b)!;
      const edge = (lo: number, hi: number) => {
        let g = 0;
        for (let k = lo; k < hi; k += 1) g = gcd(g, oi[k]);
        for (let k = lo; k < hi; k += 1) out[k] = { day: sorted[k].day, lot: g, confidence: "low" };
      };
      // Days that fit the known lot keep it. One limit: seen from its oldest
      // days, a lot that later halved fits the smaller lot too, so a revision
      // in a listing's first sessions isn't seen (both lots fit every figure).
      const keep = (lo: number, hi: number) => {
        for (let k = lo; k < hi; k += 1) out[k] = { day: sorted[k].day, lot, confidence: "high" };
      };
      if (a !== null) {
        let k = from;
        while (k < to && fits(k, lot)) k += 1;
        keep(from, k);
        if (k < to) edge(k, to);
      } else {
        let k = to - 1;
        while (k >= from && fits(k, lot)) k -= 1;
        keep(k + 1, to);
        if (k >= from) edge(from, k + 1);
      }
      continue;
    }
    const ratio = (x: number, y: number) => Math.log(x / y);
    /** The close moves by x/y from the day before c: the lot changed on c with a split or bonus. */
    const priceSays = (c: number, x: number, y: number) => c > 0 && sorted[c - 1].close > 0 && sorted[c].close > 0 && Math.abs(Math.log(sorted[c].close / sorted[c - 1].close) - ratio(x, y)) < PRICE_MATCH;
    const rolls = (c: number) => c > 0 && sorted[c].nearExpiry !== sorted[c - 1].nearExpiry;
    const fitsAll = (lo: number, hi: number, lot: number) => {
      for (let k = lo; k < hi; k += 1) if (!fits(k, lot)) return false;
      return true;
    };
    // Two changes close together (a split, then NSE's revision at the next roll): A, then C, then B,
    // each change on a day the close or the contract month says so.
    const twoChanges = (): boolean => {
      for (let c1 = from; c1 < to; c1 += 1) {
        if (!fitsAll(from, c1, a)) return false;
        for (let c2 = c1 + 1; c2 <= to; c2 += 1) {
          if (!fitsAll(c2, to, b)) continue;
          let mid = 0;
          for (let k = c1; k < c2; k += 1) mid = gcd(mid, oi[k]);
          if (new Set(oi.slice(c1, c2)).size < 3 || mid === a || mid === b) continue;
          if (!(priceSays(c1, a, mid) || rolls(c1)) || !(priceSays(c2, mid, b) || rolls(c2))) continue;
          for (let k = from; k < to; k += 1) out[k] = { day: sorted[k].day, lot: k < c1 ? a : k < c2 ? mid : b, confidence: "low" };
          return true;
        }
      }
      return false;
    };
    // One change, A to B, on day c (the first day of B): c in [from, to].
    const valid: number[] = [];
    for (let c = from; c <= to; c += 1) if (fitsAll(from, c, a) && fitsAll(c, to, b)) valid.push(c);
    if (!valid.length) {
      twoChanges();
      continue;
    }
    const byPrice = valid.filter((c) => priceSays(c, a, b));
    const byRoll = valid.filter(rolls);
    const pick = byPrice[0] ?? byRoll[0] ?? (b % a === 0 ? valid[0] : valid[valid.length - 1]);
    // A split or bonus elsewhere in the gap that this change doesn't explain: there were two.
    const unexplained = !byPrice.length && sorted.slice(from, to + 1).some((day, k) => from + k > 0 && from + k !== pick && sorted[from + k - 1].close > 0 && Math.abs(Math.log(day.close / sorted[from + k - 1].close)) > SPLIT_MOVE);
    if (unexplained && twoChanges()) continue;
    const sure = !unexplained && (valid.length === 1 || byPrice.length === 1 || (!byPrice.length && byRoll.length === 1));
    for (let k = from; k < to; k += 1) out[k] = { day: sorted[k].day, lot: k < pick ? a : b, confidence: sure ? "high" : "low" };
  }
  for (const [k, lot] of out.entries()) if (lot.lot * sorted[k].close < MIN_NOTIONAL) lot.confidence = "low";
  return out;
}
