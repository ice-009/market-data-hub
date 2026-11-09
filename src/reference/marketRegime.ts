import type { Db } from "../db.js";
import type { HistoryService } from "../history/service.js";
import { readBars } from "../history/store.js";
import { cashCloses } from "../nse/store.js";
import { DAY_MS, isoDay, istDayKey } from "../time.js";
import { marketRegime, sma, type MarketRegime } from "./regime.js";
import { getUniverse, type UniverseName } from "./universe.js";

// GET /v1/market/regime: NIFTY against its 50- and 200-day averages (daily
// candles, fetched from the broker if missing) and breadth — the share of a
// universe closing above its own 50-day average — computed from what is
// already stored (NSE cash bhavcopy closes, which win, plus stored daily
// candles), never by downloading hundreds of series.

const NIFTY_LOOKBACK_DAYS = 420; // ≥ 200 sessions
const BREADTH_LOOKBACK_DAYS = 120; // ≥ 50 sessions

export interface RegimeAnswer {
  status: "ok" | "unavailable" | "pending";
  regime: (MarketRegime & { day: string | null; nifty: { close: number | null; sma50: number | null; sma200: number | null; bars: number }; breadth: { universe: UniverseName; above50: number; counted: number; members: number } }) | null;
  error?: string;
}

const finite = (value: number) => (Number.isFinite(value) ? Math.round(value * 100) / 100 : null);

export async function computeRegime(db: Db, history: HistoryService, universe: UniverseName, now = Date.now()): Promise<RegimeAnswer> {
  const today = istDayKey(now);
  const nifty = await history.candles("NIFTY", "1d", today - NIFTY_LOOKBACK_DAYS * DAY_MS, today);
  const closes = nifty.candles.map((bar) => bar.c);
  if (!closes.length) return { status: nifty.status === "pending" ? "pending" : "unavailable", regime: null, error: nifty.error?.message ?? "No NIFTY daily candles are stored yet." };

  const members = getUniverse(db, universe, now).members.map((member) => member.symbol);
  const from = today - BREADTH_LOOKBACK_DAYS * DAY_MS;
  const bhav = cashCloses(db, members, from, today);
  let above = 0;
  let counted = 0;
  for (const symbol of members) {
    const byDay = new Map(readBars(db, symbol, "1d", from, today + DAY_MS).map((bar) => [bar.t, bar.c]));
    for (const [day, close] of bhav.get(symbol) ?? []) byDay.set(day, close);
    const series = [...byDay.entries()].sort((a, b) => a[0] - b[0]).map(([, close]) => close);
    const average = sma(series, 50);
    if (!Number.isFinite(average)) continue;
    counted += 1;
    if (series[series.length - 1] > average) above += 1;
  }

  const sma50 = sma(closes, 50);
  const sma200 = sma(closes, 200);
  const close = closes[closes.length - 1];
  const regime = marketRegime({ niftyClose: close, niftySma50: sma50, niftySma200: sma200, aboveSma50: above, counted });
  return {
    status: nifty.status === "ok" ? "ok" : nifty.status === "pending" ? "pending" : "unavailable",
    regime: {
      ...regime,
      day: isoDay(nifty.candles[nifty.candles.length - 1].t),
      nifty: { close: finite(close), sma50: finite(sma50), sma200: finite(sma200), bars: closes.length },
      breadth: { universe, above50: above, counted, members: members.length },
    },
    ...(nifty.error ? { error: nifty.error.message } : {}),
  };
}
