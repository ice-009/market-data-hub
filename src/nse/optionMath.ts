// Black-76 for NSE options: prices, implied volatility, delta. Pure.
//
// An option is priced on its forward F (the same-expiry future's settlement
// price, or put–call parity; src/nse/optionSummary.ts) with a discount factor
// DF = e^(−rT):
//   call = DF·(F·N(d1) − K·N(d2)),  put = DF·(K·N(−d2) − F·N(−d1)),
//   d1 = (ln(F/K) + σ²T/2) / (σ√T),  d2 = d1 − σ√T.
// Time is ACT/365 in calendar days from the trade day's close to the expiry
// day's close: T = (expiry − day) / 365 days.
//
// The rate only discounts (the forward already carries interest and
// dividends), so it barely matters: at T = 1 month a whole percentage point
// moves an at-the-money IV by under 0.1% of itself. RISK_FREE is a step
// function of year (approximate averages of India's 91-day T-bill yield,
// rounded to ¼ point), not a daily yield curve.

/** Approximate 91-day T-bill yield by calendar year (decimal). Years after the last use the last. */
export const RISK_FREE: Readonly<Record<number, number>> = {
  2000: 0.09, 2001: 0.07, 2002: 0.0575, 2003: 0.05, 2004: 0.0475, 2005: 0.055, 2006: 0.065, 2007: 0.0725, 2008: 0.075, 2009: 0.04,
  2010: 0.0575, 2011: 0.08, 2012: 0.0825, 2013: 0.085, 2014: 0.0875, 2015: 0.075, 2016: 0.0675, 2017: 0.0625, 2018: 0.065, 2019: 0.0625,
  2020: 0.035, 2021: 0.035, 2022: 0.055, 2023: 0.0675, 2024: 0.0675, 2025: 0.0575, 2026: 0.055,
};

const RATE_YEARS = Object.keys(RISK_FREE).map(Number).sort((a, b) => a - b);

/** The rate used on a trade day (day key). */
export function riskFree(day: number): number {
  const year = new Date(day).getUTCFullYear();
  const clamped = Math.min(Math.max(year, RATE_YEARS[0]), RATE_YEARS.at(-1)!);
  return RISK_FREE[clamped];
}

/** Standard normal CDF (erfc from Numerical Recipes' Chebyshev fit: relative error < 1.2e-7). */
export function normCdf(x: number): number {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.5 * z);
  const erfc =
    t *
    Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? 1 - erfc / 2 : erfc / 2;
}

export type OptionType = "C" | "P";

/** Black-76 price. */
export function black76(type: OptionType, forward: number, strike: number, t: number, vol: number, df: number): number {
  if (t <= 0 || vol <= 0) return df * Math.max(type === "C" ? forward - strike : strike - forward, 0);
  const s = vol * Math.sqrt(t);
  const d1 = (Math.log(forward / strike) + (s * s) / 2) / s;
  const d2 = d1 - s;
  return type === "C" ? df * (forward * normCdf(d1) - strike * normCdf(d2)) : df * (strike * normCdf(-d2) - forward * normCdf(-d1));
}

/** Forward delta (undiscounted): N(d1) for a call, N(d1) − 1 for a put. */
export function forwardDelta(type: OptionType, forward: number, strike: number, t: number, vol: number): number {
  const s = vol * Math.sqrt(t);
  const d1 = (Math.log(forward / strike) + (s * s) / 2) / s;
  return type === "C" ? normCdf(d1) : normCdf(d1) - 1;
}

export const MIN_VOL = 0.005;
export const MAX_VOL = 5;

/**
 * The volatility at which Black-76 gives `price`, or null when no volatility
 * does: a price at or under the discounted intrinsic value (no time value
 * left — common for deep in-the-money settlements), or over the discounted
 * forward/strike. Bisection on [MIN_VOL, MAX_VOL] — the price rises with
 * volatility, so it always converges; to 1e-6 in volatility.
 */
export function impliedVol(type: OptionType, price: number, forward: number, strike: number, t: number, df: number): number | null {
  if (!(price > 0) || !(forward > 0) || !(strike > 0) || !(t > 0) || !(df > 0)) return null;
  const intrinsic = df * Math.max(type === "C" ? forward - strike : strike - forward, 0);
  const cap = df * (type === "C" ? forward : strike);
  if (price <= intrinsic || price >= cap) return null;
  let lo = MIN_VOL;
  let hi = MAX_VOL;
  if (black76(type, forward, strike, t, lo, df) > price || black76(type, forward, strike, t, hi, df) < price) return null;
  for (let i = 0; i < 60 && hi - lo > 1e-6; i += 1) {
    const mid = (lo + hi) / 2;
    if (black76(type, forward, strike, t, mid, df) < price) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}
