// Market regime: is it a good time to take long setups at all? Momentum and
// breakout strategies lose most when the broad market is weak — and worst in
// sharp rebounds after a fall (Daniel & Moskowitz, "Momentum crashes"). Two
// plain, observable inputs:
//   - NIFTY against its 50- and 200-day averages (trend);
//   - breadth: the share of the universe above its own 50-day average.
// Thresholds follow common practitioner use (strong above ~55–65%, weak below
// ~33–35%); they're a checklist, not a fitted model — the backtester is the place
// to test them. Pure. (Ported from Tradex, MIT.)

export type RegimeState = "healthy" | "caution" | "risk-off";

export interface MarketRegime {
  state: RegimeState;
  label: string;
  /** Plain-language reasons, for the tooltip. */
  reasons: string[];
  niftyAbove200: boolean | null;
  niftyAbove50: boolean | null;
  /** Share (0–1) of the universe above its 50-day average. */
  breadth50: number | null;
  /** NIFTY's close (live in market hours) and its 200-day average: the daily plan's market gate. */
  niftyClose?: number;
  niftySma200?: number | null;
}

export function marketRegime(input: { niftyClose: number; niftySma50: number; niftySma200: number; aboveSma50: number; counted: number }): MarketRegime {
  const above200 = Number.isFinite(input.niftySma200) && input.niftySma200 > 0 ? input.niftyClose > input.niftySma200 : null;
  const above50 = Number.isFinite(input.niftySma50) && input.niftySma50 > 0 ? input.niftyClose > input.niftySma50 : null;
  const breadth = input.counted > 0 ? input.aboveSma50 / input.counted : null;
  const pct = breadth === null ? "—" : `${Math.round(breadth * 100)}%`;
  const reasons = [
    above200 === null ? "NIFTY 200-day average unavailable" : `NIFTY ${above200 ? "above" : "below"} its 200-day average`,
    above50 === null ? "NIFTY 50-day average unavailable" : `NIFTY ${above50 ? "above" : "below"} its 50-day average`,
    `${pct} of stocks above their 50-day average`,
  ];
  let state: RegimeState = "caution";
  if (above200 === false && breadth !== null && breadth < 0.35) state = "risk-off";
  else if (above200 !== false && above50 !== false && breadth !== null && breadth >= 0.55) state = "healthy";
  const label = state === "healthy" ? "Healthy" : state === "caution" ? "Caution" : "Risk-off";
  return {
    state,
    label,
    reasons,
    niftyAbove200: above200,
    niftyAbove50: above50,
    breadth50: breadth,
    niftyClose: input.niftyClose,
    niftySma200: Number.isFinite(input.niftySma200) ? input.niftySma200 : null,
  };
}

/** Simple moving average of the last `period` values, or NaN when there aren't enough. */
export function sma(values: number[], period: number): number {
  if (values.length < period || period <= 0) return Number.NaN;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i += 1) sum += values[i];
  return sum / period;
}
