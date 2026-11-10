import type { Hono } from "hono";
import type { Bar } from "../../broker/fyers.js";
import { isFuture, isIndex, normalizeSymbol } from "../../broker/symbols.js";
import { needsBrokerBeyond } from "../../history/plan.js";
import { readSeries } from "../../history/store.js";
import type { BaseTf } from "../../history/timeframes.js";
import { finalBefore, isTf, TIMEFRAMES, type Tf } from "../../history/timeframes.js";
import type { Hub } from "../../hub.js";
import { bucketOf, mergeMinutes } from "../../live/merge.js";
import { lastOkDay } from "../../nse/store.js";
import { DAY_MS, weekdayOnOrBefore } from "../../time.js";
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
const DEFAULT_SPAN_DAYS: Record<Tf, number> = { "1d": 365, "1w": 5 * 365, "1h": 90, "15m": 30, "5m": 7, "1m": 5 };

// GET /v1/candles/batch?symbols=A,B,…&tf=1d|1w&from&to   (scope: history)
//
// Many symbols' daily (or weekly) candles in one request, for screeners. Never
// waits for the broker: each symbol is answered from the store, and a symbol
// whose range isn't fully stored is queued for a background download
// (src/history/queue.ts, deduplicated across requests), so asking again a
// little later finds it stored. `queued` lists those symbols; `unknown` lists
// symbols that aren't valid tickers or that the broker said it doesn't know.
//
// One exception keeps the evening cheap: between a session's close and NSE's
// cash bhavcopy (16:00 → ~18:00 IST) every stored stock is missing just that
// session, which the bhavcopy job adds for free (src/history/fromBhav.ts). A
// stock missing only that is not queued — otherwise one screen would cost a
// broker call per symbol an hour before the free file. Indices and futures
// aren't in the cash file and are queued as usual.

const BATCH_TFS = ["1d", "1w"] as const;
const BATCH_SPAN_DAYS: Record<(typeof BATCH_TFS)[number], number> = { "1d": 400, "1w": 5 * 365 };
export const MAX_BATCH_SYMBOLS = 300;

export function candleRoutes(app: Hono<HubEnv>, hub: Hub) {
  app.get("/v1/candles", requireScope("history"), async (c) => {
    const symbol = normalizeSymbol(c.req.query("symbol") ?? "");
    if (!symbol) return c.json(errorBody("symbol is required: a plain NSE ticker such as SBIN, M&M (send & as %26), NIFTY, or a futures contract such as SBIN26NOVFUT.", "bad_request"), 400);
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

  app.get("/v1/candles/batch", requireScope("history"), (c) => {
    const parts = [...new Set((c.req.query("symbols") ?? "").split(",").map((part) => part.trim()).filter(Boolean))];
    if (!parts.length) return c.json(errorBody("symbols is required: comma-separated NSE tickers such as SBIN,INFY,NIFTY (send & as %26).", "bad_request"), 400);
    if (parts.length > MAX_BATCH_SYMBOLS) return c.json(errorBody(`At most ${MAX_BATCH_SYMBOLS} symbols per request (got ${parts.length}).`, "too_many_symbols"), 400);
    const tf = c.req.query("tf") ?? "1d";
    if (!(BATCH_TFS as readonly string[]).includes(tf)) return c.json(errorBody(`tf must be one of ${BATCH_TFS.join(", ")}.`, "bad_request"), 400);
    const batchTf = tf as (typeof BATCH_TFS)[number];
    let range: { from: number; to: number };
    try {
      range = parseRange({ from: c.req.query("from"), to: c.req.query("to") }, true, BATCH_SPAN_DAYS[batchTf], Date.now());
    } catch (error) {
      if (error instanceof ParamError) return c.json(errorBody(error.message, "bad_request"), 400);
      throw error;
    }

    // A malformed ticker shouldn't sink a 300-symbol screen: it is reported as unknown.
    const unknown: string[] = [];
    const symbols: string[] = [];
    for (const part of parts) {
      const symbol = normalizeSymbol(part);
      if (!symbol || hub.historyQueue.isUnknown(symbol)) unknown.push(symbol ?? part);
      else if (!symbols.includes(symbol)) symbols.push(symbol);
    }

    const unavailable = hub.brokerUnavailable();
    const now = hub.clock();
    const latestFinal = weekdayOnOrBefore(finalBefore("1d", now) - DAY_MS);
    const bhavPending = hub.config.jobsEnabled && (lastOkDay(hub.db, "cash_bhav") ?? -Infinity) < latestFinal;
    const series: Record<string, { complete: boolean; coverage: { from: number; to: number } | null; candles: Bar[] }> = {};
    const queued: string[] = [];
    for (const symbol of symbols) {
      const stored = hub.history.stored(symbol, batchTf, range.from, range.to);
      const fromBhav = bhavPending && !isIndex(symbol) && !isFuture(symbol);
      const needed = !stored.complete && (!fromBhav || needsBrokerBeyond(stored.coverage, stored.want, latestFinal));
      if (needed && !unavailable && hub.historyQueue.enqueue(symbol, stored.base, stored.want)) queued.push(symbol);
      const live = withLiveMinutes(hub, symbol, batchTf, range, stored.candles, stored.base);
      series[symbol] = { complete: stored.complete, coverage: stored.coverage, candles: live.candles };
    }
    const incomplete = symbols.some((symbol) => !series[symbol].complete);
    // Like /v1/quotes: a broker problem doesn't turn the answer into an error; it says why nothing was queued.
    const warning = incomplete && unavailable ? { warning: `The broker is unavailable (${unavailable.message}); showing what is stored.`, reason: unavailable.kind } : {};
    return c.json({ tf: batchTf, from: range.from, to: range.to, series, queued, unknown, ...warning });
  });
}

/** Stored candles with the live minutes since the newest one folded in, kept inside the requested range. */
export function withLiveMinutes<T extends Bar>(hub: Hub, symbol: string, tf: Tf, range: { from: number; to: number }, candles: T[], base: BaseTf) {
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
