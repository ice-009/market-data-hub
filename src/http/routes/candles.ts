import type { Hono } from "hono";
import type { Bar } from "../../broker/fyers.js";
import { normalizeSymbol } from "../../broker/symbols.js";
import { readSeries } from "../../history/store.js";
import type { BaseTf } from "../../history/timeframes.js";
import { isTf, TIMEFRAMES, type Tf } from "../../history/timeframes.js";
import type { Hub } from "../../hub.js";
import { bucketOf, mergeMinutes } from "../../live/merge.js";
import { errorBody, requireScope, type HubEnv } from "../common.js";
import { ParamError, parseRange } from "../params.js";

// GET /v1/candles?symbol=SBIN&tf=1d&from=2025-01-01&to=2025-12-31   (scope: history)
//
// Served from the store; ranges it doesn't hold are fetched from the broker at
// background priority (waiting up to HUB_FETCH_WAIT_MS). When the broker is
// needed but can't help, the answer is 503 with whatever is stored, never a
// hang. Times: epoch ms — daily/weekly bars at UTC midnight of the IST trade
// date, intraday bars at their start instant.
//
// Live minutes (src/live) are folded in so the answer is current to the minute:
// the newest stored candle is brought up to date and later buckets (today's
// daily bar, the hours since the last sync) are built from the hub's 1-minute
// bars — ticks, or broker minutes where a gap was repaired. `liveThrough` says
// up to which minute (null when no live minute was used).

/** Default span when `from` is left out (days). */
const DEFAULT_SPAN_DAYS: Record<Tf, number> = { "1d": 365, "1w": 5 * 365, "1h": 90, "15m": 30, "5m": 7 };

export function candleRoutes(app: Hono<HubEnv>, hub: Hub) {
  app.get("/v1/candles", requireScope("history"), async (c) => {
    const symbol = normalizeSymbol(c.req.query("symbol") ?? "");
    if (!symbol) return c.json(errorBody("symbol is required: a plain NSE ticker such as SBIN, M&M (send & as %26) or NIFTY.", "bad_request"), 400);
    const tf = c.req.query("tf") ?? "1d";
    if (!isTf(tf)) return c.json(errorBody(`tf must be one of ${TIMEFRAMES.join(", ")}.`, "bad_request"), 400);
    let range: { from: number; to: number };
    try {
      range = parseRange({ from: c.req.query("from"), to: c.req.query("to") }, tf === "1d" || tf === "1w", DEFAULT_SPAN_DAYS[tf], Date.now());
    } catch (error) {
      if (error instanceof ParamError) return c.json(errorBody(error.message, "bad_request"), 400);
      throw error;
    }

    const answer = await hub.history.candles(symbol, tf, range.from, range.to);
    const live = withLiveMinutes(hub, symbol, tf, range, answer.candles, answer.base);
    const body = { symbol, tf, from: range.from, to: range.to, complete: answer.complete, coverage: answer.coverage, liveThrough: live.through, candles: live.candles };
    if (answer.status === "ok") return c.json(body);
    if (answer.status === "unknown_symbol") return c.json(errorBody(`Unknown symbol ${symbol}.`, "unknown_symbol"), 404);
    if (answer.status === "pending") return c.json({ ...errorBody("Still fetching from the broker; showing what is stored. Try again shortly.", "fetch_pending"), ...body }, 503, { "Retry-After": "10" });
    return c.json({ ...errorBody(`The broker is unavailable (${answer.error?.message ?? "unknown reason"}); showing what is stored.`, "broker_unavailable"), reason: answer.error?.kind ?? null, ...body }, 503, { "Retry-After": "60" });
  });
}

/** Stored candles with the live minutes since the newest one folded in, kept inside the requested range. */
function withLiveMinutes<T extends Bar>(hub: Hub, symbol: string, tf: Tf, range: { from: number; to: number }, candles: T[], base: BaseTf) {
  const now = hub.clock();
  const last = candles.length ? candles[candles.length - 1] : null;
  const from = last ? last.t : range.from;
  // Only minutes whose bucket the range includes (a week or hour that starts by `to` runs past it).
  const minutes = hub.live.store.minuteBars(symbol, from, now + 1).filter((bar) => bucketOf(tf, bar.t) <= range.to);
  const quote = tf === "1d" ? hub.live.store.lastQuotes([symbol]).get(symbol) : undefined;
  if (!minutes.length && !quote) return { candles: candles as Array<T | Bar>, through: null };
  const merged = mergeMinutes(tf, candles, minutes, { storedAt: readSeries(hub.db, symbol, base)?.syncedAt, quote }).filter((bar) => bar.t <= range.to);
  return { candles: merged, through: minutes.length ? minutes[minutes.length - 1].t : null };
}
