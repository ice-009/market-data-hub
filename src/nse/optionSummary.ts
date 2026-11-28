import { DAY_MS } from "../time.js";
import { black76, forwardDelta, impliedVol, riskFree, type OptionType } from "./optionMath.js";
import { optionSymbol, type FoFutureRow, type FoOptionRow, type OptionKind } from "./parsers/foOptions.js";

// One underlying's options on one trade day, boiled down to a row
// (market-data-hub#30): every strike of every expiry is read, a few dozen
// numbers are kept. Pure.
//
// Across every listed expiry: call and put open interest (shares), its change
// (each contract's own change summed, as for futures: an expired series isn't
// "unwound" the day after), and contracts traded — so put–call ratios of OI and
// volume. Then for the near and next expiry (the first two AFTER the trade
// day: a series on its last day has no time value left to read):
//
//   prices    a contract's settlement price is used when it TRADED that day and
//             its settlement agrees with its close (within 2%). NSE's settlement
//             price of an untraded option is a theoretical value, and on thin
//             contracts in the current files it can be far off the trades
//             (BANKNIFTY 56100 CE on 1 Oct 2025: 35 traded, close 820.50,
//             settlement 1,384.80), so neither is read as a market price.
//   forward   the same-expiry future's settlement price; without one (weekly
//             index expiries), put–call parity at the strike where usable call
//             and put prices are closest, F = K + (C − P)/DF (FORWARD_PARITY);
//             else another expiry's forward, or the file's underlying price,
//             carried at r (FORWARD_CARRY); else none (NO_FORWARD).
//   ATM       the listed strike nearest the forward.
//   straddle  its call + put: usable prices, a missing leg from the other by
//             put–call parity, both from Black-76 at the ATM IV when neither
//             traded (ATM_UNTRADED). ≈ the move priced to expiry; straddle /
//             forward is that in %.
//   IV        Black-76 (src/nse/optionMath.ts) on usable prices. ATM IV: the
//             mean of the ATM strike's call and put IVs; without either,
//             interpolated at the forward between the nearest usable strikes on
//             either side (within 10%; each strike's out-of-the-money leg
//             first), else the nearest one within 5%, else from the ATM
//             settlement prices if their call and put IVs agree within 20%
//             (ATM_THEORETICAL). Outside 2%–300% it's dropped (IV_OUT_OF_RANGE).
//   callIv, putIv   the ATM strike's own call and put IV.
//   cpSpread  call IV − put IV over strikes where both legs are usable, weighted
//             by their OI (Cremers & Weinbaum 2010); only with a futures forward —
//             a parity forward makes it ~0 by construction.
//   iv25Put, iv25Call   IV at 25 delta (forward delta), interpolated in delta
//             between usable out-of-the-money strikes; null without strikes on
//             both sides of 25Δ. skew = put − call.
//   maxPain   the strike at which option holders' payout at expiry, on today's
//             OI, is smallest.
//   walls     the strikes with the most call and put OI (resistance, support).
// iv30: ATM IV at a constant 30 calendar days, interpolating total variance
// (σ²T) between the listed expiries either side of 30 days — for indices with
// weekly expiries that's usually the monthly ones, as India VIX uses — skipping
// expiries under MIN_IV_DAYS out; flat beyond the last.
//
// Lots: the new files carry one; for the old ones it's estimated from
// notional turnover ÷ (contracts × (strike + premium)), the volume-weighted
// median over traded contracts whose premium is under 5% of the strike (where
// the unknown average premium matters least): flag LOT_ESTIMATED, within ~1%
// of the lots NSE published on the days checked.

export const FLAGS = {
  /** No same-expiry future: forward from put–call parity. */
  FORWARD_PARITY: 1,
  /** Forward carried at the risk-free rate from another expiry's, or from the underlying's price. */
  FORWARD_CARRY: 2,
  /** No forward could be found: no IV, straddle or delta. */
  NO_FORWARD: 4,
  /** No usable strike near the money: ATM IV from NSE's theoretical settlement prices. */
  ATM_THEORETICAL: 8,
  /** Fewer than MIN_LIQUID_STRIKES strikes with a usable price. */
  FEW_STRIKES: 16,
  /** American-style contracts (old CA/PA rows): read as European, so puts' IV is a little high. */
  AMERICAN: 32,
  /** Lot estimated from turnover (old-format files). */
  LOT_ESTIMATED: 64,
  /** ATM IV outside MIN_SANE_IV..MAX_SANE_IV: dropped. */
  IV_OUT_OF_RANGE: 128,
  /** An ATM leg has no usable price: the straddle is partly or wholly modelled. */
  ATM_UNTRADED: 256,
} as const;

export type FlagName = keyof typeof FLAGS;

export const flagNames = (mask: number): FlagName[] => (Object.keys(FLAGS) as FlagName[]).filter((name) => (mask & FLAGS[name]) !== 0);

export const MIN_LIQUID_STRIKES = 3;
export const MIN_SANE_IV = 0.02;
export const MAX_SANE_IV = 3;
export const MIN_IV_DAYS = 3;
export const IV30_DAYS = 30;
/** A traded contract's settlement price is used when within this share of its close. */
export const SETTLE_CLOSE_TOLERANCE = 0.02;

export interface ExpirySummary {
  expiry: number;
  /** Calendar days to expiry. */
  days: number;
  forward: number | null;
  atmStrike: number | null;
  straddle: number | null;
  atmIv: number | null;
  callIv: number | null;
  putIv: number | null;
  cpSpread: number | null;
  iv25Put: number | null;
  iv25Call: number | null;
  maxPain: number | null;
  callWall: number | null;
  callWallOi: number | null;
  putWall: number | null;
  putWallOi: number | null;
  callOi: number;
  putOi: number;
  /** Strikes listed, and strikes with a usable price on either leg. */
  strikes: number;
  liquid: number;
  flags: number;
}

export interface OptionSummary {
  day: number;
  symbol: string;
  nseSymbol: string;
  kind: OptionKind;
  spot: number | null;
  lot: number | null;
  /** Option expiries listed (on or after the trade day). */
  expiries: number;
  callOi: number;
  putOi: number;
  callChgOi: number;
  putChgOi: number;
  callVolume: number;
  putVolume: number;
  iv30: number | null;
  near: ExpirySummary | null;
  next: ExpirySummary | null;
  /** Flags that apply to the whole row (LOT_ESTIMATED, AMERICAN). */
  flags: number;
}

interface Strike {
  strike: number;
  call?: FoOptionRow;
  put?: FoOptionRow;
}

/** Traded, with a settlement price its close confirms. */
export const usable = (row: FoOptionRow | undefined): row is FoOptionRow =>
  !!row && row.volume > 0 && row.settle > 0 && Math.abs(row.settle - row.close) <= Math.max(0.05, SETTLE_CLOSE_TOLERANCE * row.close);

/** Linear interpolation of y at x between (x0, y0) and (x1, y1). */
const lerp = (x: number, x0: number, y0: number, x1: number, y1: number) => (x1 === x0 ? (y0 + y1) / 2 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0));

const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);

function chain(rows: readonly FoOptionRow[]): Strike[] {
  const byStrike = new Map<number, Strike>();
  for (const row of rows) {
    const strike = byStrike.get(row.strike) ?? { strike: row.strike };
    if (row.type === "C") strike.call = row;
    else strike.put = row;
    byStrike.set(row.strike, strike);
  }
  return [...byStrike.values()].sort((a, b) => a.strike - b.strike);
}

/** Forward from put–call parity at the strike where usable call and put prices are closest. */
function parityForward(strikes: readonly Strike[], df: number): number | null {
  let best: { gap: number; forward: number } | null = null;
  for (const s of strikes) {
    if (!usable(s.call) || !usable(s.put)) continue;
    const gap = Math.abs(s.call.settle - s.put.settle);
    if (!best || gap < best.gap) best = { gap, forward: s.strike + (s.call.settle - s.put.settle) / df };
  }
  return best && best.forward > 0 ? best.forward : null;
}

interface Timing {
  days: number;
  t: number;
  r: number;
  df: number;
}

const timing = (day: number, expiry: number): Timing => {
  const days = Math.round((expiry - day) / DAY_MS);
  const t = days / 365;
  const r = riskFree(day);
  return { days, t, r, df: Math.exp(-r * t) };
};

function summarizeExpiry(expiry: number, time: Timing, strikes: readonly Strike[], forward: number | null, forwardFlags: number): ExpirySummary {
  const { days, t, df } = time;
  let callOi = 0;
  let putOi = 0;
  let callWall: Strike | null = null;
  let putWall: Strike | null = null;
  for (const s of strikes) {
    callOi += s.call?.oi ?? 0;
    putOi += s.put?.oi ?? 0;
    if ((s.call?.oi ?? 0) > 0 && (!callWall || s.call!.oi > callWall.call!.oi)) callWall = s;
    if ((s.put?.oi ?? 0) > 0 && (!putWall || s.put!.oi > putWall.put!.oi)) putWall = s;
  }
  const liquid = strikes.filter((s) => usable(s.call) || usable(s.put)).length;

  // Max pain: holders' payout at expiry on today's OI, at each listed strike.
  let maxPain: number | null = null;
  if (callOi + putOi > 0) {
    let least = Infinity;
    for (const at of strikes) {
      let pain = 0;
      for (const s of strikes) {
        if (s.strike < at.strike) pain += (s.call?.oi ?? 0) * (at.strike - s.strike);
        else if (s.strike > at.strike) pain += (s.put?.oi ?? 0) * (s.strike - at.strike);
      }
      // Ties go to the strike nearer the forward.
      if (pain < least || (pain === least && forward !== null && maxPain !== null && Math.abs(at.strike - forward) < Math.abs(maxPain - forward))) {
        least = pain;
        maxPain = at.strike;
      }
    }
  }

  const out: ExpirySummary = {
    expiry,
    days,
    forward,
    atmStrike: null,
    straddle: null,
    atmIv: null,
    callIv: null,
    putIv: null,
    cpSpread: null,
    iv25Put: null,
    iv25Call: null,
    maxPain,
    callWall: callWall?.strike ?? null,
    callWallOi: callWall?.call?.oi ?? null,
    putWall: putWall?.strike ?? null,
    putWallOi: putWall?.put?.oi ?? null,
    callOi,
    putOi,
    strikes: strikes.length,
    liquid,
    flags: forwardFlags | (liquid < MIN_LIQUID_STRIKES ? FLAGS.FEW_STRIKES : 0),
  };
  if (forward === null || !strikes.length || t <= 0) return out;
  const F = forward;

  let atm = strikes[0];
  for (const s of strikes) if (Math.abs(s.strike - F) < Math.abs(atm.strike - F)) atm = s;
  out.atmStrike = atm.strike;

  const iv = (row: FoOptionRow) => impliedVol(row.type, row.settle, F, row.strike, t, df);
  // Each usable strike's IV (out-of-the-money leg first), and call/put pairs.
  const smile: Array<{ strike: number; iv: number; type: OptionType }> = [];
  const pairs: Array<{ spread: number; weight: number }> = [];
  for (const s of strikes) {
    const callIv = usable(s.call) ? iv(s.call) : null;
    const putIv = usable(s.put) ? iv(s.put) : null;
    if (s === atm) {
      out.callIv = callIv;
      out.putIv = putIv;
    }
    if (callIv !== null && putIv !== null) pairs.push({ spread: callIv - putIv, weight: s.call!.oi + s.put!.oi });
    const below = s.strike < F;
    const otm = below ? putIv : callIv;
    const itm = below ? callIv : putIv;
    if (otm !== null) smile.push({ strike: s.strike, iv: otm, type: below ? "P" : "C" });
    else if (itm !== null) smile.push({ strike: s.strike, iv: itm, type: below ? "C" : "P" });
  }

  // ATM IV.
  let atmIv = mean([out.callIv, out.putIv].filter((v): v is number => v !== null));
  if (atmIv === null) {
    const lo = [...smile].reverse().find((p) => p.strike <= F && p.strike >= F * 0.9);
    const hi = smile.find((p) => p.strike >= F && p.strike <= F * 1.1);
    if (lo && hi) atmIv = lerp(F, lo.strike, lo.iv, hi.strike, hi.iv);
    else {
      const nearest = smile.reduce<(typeof smile)[number] | null>((best, p) => (!best || Math.abs(p.strike - F) < Math.abs(best.strike - F) ? p : best), null);
      if (nearest && Math.abs(nearest.strike - F) <= F * 0.05) atmIv = nearest.iv;
      else if (atm.call && atm.put) {
        const c = impliedVol("C", atm.call.settle, F, atm.strike, t, df);
        const p = impliedVol("P", atm.put.settle, F, atm.strike, t, df);
        if (c !== null && p !== null && Math.abs(c - p) <= 0.2 * Math.max(c, p)) {
          atmIv = (c + p) / 2;
          out.flags |= FLAGS.ATM_THEORETICAL;
        }
      }
    }
  }
  if (atmIv !== null && (atmIv < MIN_SANE_IV || atmIv > MAX_SANE_IV)) {
    atmIv = null;
    out.flags |= FLAGS.IV_OUT_OF_RANGE;
  }
  out.atmIv = atmIv;

  // Straddle: usable prices, a missing leg by parity, or both from the ATM IV.
  const carry = df * (F - atm.strike);
  const call = usable(atm.call) ? atm.call.settle : null;
  const put = usable(atm.put) ? atm.put.settle : null;
  if (call === null || put === null) out.flags |= FLAGS.ATM_UNTRADED;
  if (call !== null && put !== null) out.straddle = call + put;
  else if (call !== null && call - carry > 0) out.straddle = call + (call - carry);
  else if (put !== null && put + carry > 0) out.straddle = put + (put + carry);
  else if (atmIv !== null) out.straddle = black76("C", F, atm.strike, t, atmIv, df) + black76("P", F, atm.strike, t, atmIv, df);

  if (!(out.flags & FLAGS.FORWARD_PARITY) && pairs.length) {
    const weight = pairs.reduce((sum, p) => sum + p.weight, 0);
    out.cpSpread = weight > 0 ? pairs.reduce((sum, p) => sum + p.spread * p.weight, 0) / weight : mean(pairs.map((p) => p.spread));
  }

  // 25-delta wings: usable out-of-the-money strikes only.
  const wing = (type: OptionType) => {
    const points = smile
      .filter((p) => p.type === type && (type === "P" ? p.strike < F : p.strike > F))
      .map((p) => ({ delta: Math.abs(forwardDelta(type, F, p.strike, t, p.iv)), iv: p.iv }))
      .sort((a, b) => a.delta - b.delta);
    const lo = [...points].reverse().find((p) => p.delta <= 0.25);
    const hi = points.find((p) => p.delta >= 0.25);
    return lo && hi ? lerp(0.25, lo.delta, lo.iv, hi.delta, hi.iv) : null;
  };
  out.iv25Put = wing("P");
  out.iv25Call = wing("C");
  return out;
}

/** Flags that keep an expiry out of iv30. */
const IV30_UNFIT = FLAGS.FORWARD_CARRY | FLAGS.NO_FORWARD | FLAGS.ATM_THEORETICAL | FLAGS.FEW_STRIKES | FLAGS.IV_OUT_OF_RANGE;

/** ATM IV at a constant IV30_DAYS, interpolating total variance; null without a usable leg. */
export function constantMaturityIv(legs: ReadonlyArray<ExpirySummary | null>): number | null {
  const usableLegs = legs.filter((leg): leg is ExpirySummary => !!leg && leg.atmIv !== null && leg.days >= MIN_IV_DAYS).sort((a, b) => a.days - b.days);
  if (!usableLegs.length) return null;
  const lo = [...usableLegs].reverse().find((leg) => leg.days <= IV30_DAYS);
  const hi = usableLegs.find((leg) => leg.days >= IV30_DAYS);
  if (!lo) return hi!.atmIv;
  if (!hi || lo === hi) return lo.atmIv;
  const v0 = lo.atmIv! * lo.atmIv! * lo.days;
  const v1 = hi.atmIv! * hi.atmIv! * hi.days;
  const v = lerp(IV30_DAYS, lo.days, v0, hi.days, v1);
  return v > 0 ? Math.sqrt(v / IV30_DAYS) : null;
}

/** A lot estimated from notional turnover over traded contracts (old files), or null. */
export function estimateLot(options: readonly FoOptionRow[], futures: readonly FoFutureRow[]): number | null {
  const estimates: Array<{ lot: number; weight: number }> = [];
  for (const row of options) {
    if (row.volume <= 0 || row.turnover === null || row.turnover <= 0 || row.settle <= 0 || row.settle > 0.05 * row.strike) continue;
    estimates.push({ lot: row.turnover / (row.volume * (row.strike + row.settle)), weight: row.volume });
  }
  if (!estimates.length) {
    const rows = [...options.map((row) => ({ ...row, price: row.strike + row.settle })), ...futures.map((row) => ({ ...row, price: row.settle }))];
    for (const row of rows) {
      if (row.volume <= 0 || row.turnover === null || row.turnover <= 0 || row.settle <= 0) continue;
      estimates.push({ lot: row.turnover / (row.volume * row.price), weight: row.volume });
    }
  }
  if (!estimates.length) return null;
  estimates.sort((a, b) => a.lot - b.lot);
  const half = estimates.reduce((sum, e) => sum + e.weight, 0) / 2;
  let seen = 0;
  for (const e of estimates) {
    seen += e.weight;
    if (seen >= half) return Math.max(1, Math.round(e.lot));
  }
  return Math.max(1, Math.round(estimates.at(-1)!.lot));
}

/** Summaries of the expiries after `day`: near and next, plus those iv30 needs. */
function summarizeExpiries(day: number, options: readonly FoOptionRow[], futures: readonly FoFutureRow[], spot: number | null): { near: ExpirySummary | null; next: ExpirySummary | null; iv30: number | null } {
  const ahead = [...new Set(options.map((row) => row.expiry))].filter((expiry) => expiry > day).sort((a, b) => a - b);
  if (!ahead.length) return { near: null, next: null, iv30: null };
  const chains = new Map(ahead.map((expiry) => [expiry, chain(options.filter((row) => row.expiry === expiry))]));
  const times = new Map(ahead.map((expiry) => [expiry, timing(day, expiry)]));

  // Forwards: the future, else parity; then the rest carried from the nearest found, else from the spot.
  const forwards = new Map<number, { forward: number | null; flags: number }>();
  for (const expiry of ahead) {
    const future = futures.find((row) => row.expiry === expiry && row.settle > 0);
    if (future) forwards.set(expiry, { forward: future.settle, flags: 0 });
    else {
      const parity = parityForward(chains.get(expiry)!, times.get(expiry)!.df);
      if (parity !== null) forwards.set(expiry, { forward: parity, flags: FLAGS.FORWARD_PARITY });
    }
  }
  const found = [...forwards.entries()];
  for (const expiry of ahead) {
    if (forwards.has(expiry)) continue;
    const { t, r } = times.get(expiry)!;
    const ref = found.reduce<(typeof found)[number] | null>((best, entry) => (!best || Math.abs(entry[0] - expiry) < Math.abs(best[0] - expiry) ? entry : best), null);
    if (ref && ref[1].forward !== null) forwards.set(expiry, { forward: ref[1].forward * Math.exp(r * (t - times.get(ref[0])!.t)), flags: FLAGS.FORWARD_CARRY });
    else if (spot !== null) forwards.set(expiry, { forward: spot * Math.exp(r * t), flags: FLAGS.FORWARD_CARRY });
    else forwards.set(expiry, { forward: null, flags: FLAGS.NO_FORWARD });
  }

  const cache = new Map<number, ExpirySummary>();
  const summary = (expiry: number) => {
    let found = cache.get(expiry);
    if (!found) {
      const forward = forwards.get(expiry)!;
      found = summarizeExpiry(expiry, times.get(expiry)!, chains.get(expiry)!, forward.forward, forward.flags);
      cache.set(expiry, found);
    }
    return found;
  };
  const near = summary(ahead[0]);
  const next = ahead[1] !== undefined ? summary(ahead[1]) : null;

  // iv30 from the nearest clean expiries either side of 30 days (at least MIN_IV_DAYS out): an ATM IV read
  // from traded prices on its own forward. A thin weekly whose forward was carried (6 Aug 2020's NIFTY, 24 days
  // out, nothing usable traded) is skipped for the monthly beyond it, as India VIX would.
  const clean = (expiry: number) => {
    const leg = summary(expiry);
    return leg.atmIv !== null && !(leg.flags & IV30_UNFIT);
  };
  const candidates = ahead.filter((expiry) => times.get(expiry)!.days >= MIN_IV_DAYS);
  const lo = [...candidates].reverse().find((expiry) => times.get(expiry)!.days <= IV30_DAYS && clean(expiry));
  const hi = candidates.find((expiry) => times.get(expiry)!.days >= IV30_DAYS && clean(expiry));
  const iv30 = constantMaturityIv([lo, hi].filter((expiry): expiry is number => expiry !== undefined).map(summary));
  return { near, next, iv30 };
}

/**
 * Every underlying's summary on `day`, by symbol. Contracts past expiry are
 * ignored; renamed tickers are filed under their new name (a file listing both
 * keeps the new ticker's own rows).
 */
export function summarizeOptions(day: number, options: readonly FoOptionRow[], futures: readonly FoFutureRow[]): OptionSummary[] {
  const groups = new Map<string, { kind: OptionKind; nseSymbol: string; options: FoOptionRow[]; futures: FoFutureRow[] }>();
  for (const row of options) {
    if (row.expiry < day) continue;
    const key = `${row.kind}:${row.nseSymbol}`;
    let group = groups.get(key);
    if (!group) groups.set(key, (group = { kind: row.kind, nseSymbol: row.nseSymbol, options: [], futures: [] }));
    group.options.push(row);
  }
  for (const row of futures) if (row.expiry >= day) groups.get(`${row.kind}:${row.nseSymbol}`)?.futures.push(row);

  const out = new Map<string, OptionSummary>();
  for (const group of groups.values()) {
    const symbol = optionSymbol(group.kind, group.nseSymbol);
    if (symbol !== group.nseSymbol && groups.has(`${group.kind}:${symbol}`)) continue;
    const spot = group.options.find((row) => row.underlying !== null)?.underlying ?? null;
    const fileLot = group.options.find((row) => row.lot !== null)?.lot ?? null;
    const lot = fileLot ?? estimateLot(group.options, group.futures);
    let flags = fileLot === null && lot !== null ? FLAGS.LOT_ESTIMATED : 0;
    if (group.options.some((row) => row.american)) flags |= FLAGS.AMERICAN;
    const totals = { callOi: 0, putOi: 0, callChgOi: 0, putChgOi: 0, callVolume: 0, putVolume: 0 };
    for (const row of group.options) {
      if (row.type === "C") {
        totals.callOi += row.oi;
        totals.callChgOi += row.chgOi;
        totals.callVolume += row.volume;
      } else {
        totals.putOi += row.oi;
        totals.putChgOi += row.chgOi;
        totals.putVolume += row.volume;
      }
    }
    const legs = summarizeExpiries(day, group.options, group.futures, spot);
    out.set(symbol, {
      day,
      symbol,
      nseSymbol: group.nseSymbol,
      kind: group.kind,
      spot,
      lot,
      expiries: new Set(group.options.map((row) => row.expiry)).size,
      ...totals,
      iv30: legs.iv30,
      near: legs.near,
      next: legs.next,
      flags,
    });
  }
  return [...out.values()].sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
}
