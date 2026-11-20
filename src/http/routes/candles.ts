import type { Hono } from "hono";
import { BrokerError } from "../../broker/errors.js";
import type { Bar } from "../../broker/fyers.js";
import { isFuture, isIndex, isNseOnly, normalizeSymbol } from "../../broker/symbols.js";
import { EOD_INTRADAY_MESSAGE, archiveDaily } from "../../history/fromArchive.js";
import { needsBrokerBeyond } from "../../history/plan.js";
import { resample, weekStart } from "../../history/resample.js";
import { baseRange, type CandleRow } from "../../history/service.js";
import { deliveryPct, readSeries } from "../../history/store.js";
import type { BaseTf } from "../../history/timeframes.js";
import { finalBefore, isTf, TIMEFRAMES, type Tf } from "../../history/timeframes.js";
import type { Hub } from "../../hub.js";
import { bucketOf, mergeMinutes } from "../../live/merge.js";
import { lastOkDay } from "../../nse/store.js";
import { isBasket } from "../../reference/indices.js";
import { DAY_MS, istDayKey, weekdayOnOrBefore } from "../../time.js";
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
//
// `adjust`: `split` (default) — stock prices adjusted for splits, bonuses and
// the like (the broker's adjusted history, or in end-of-day mode NSE's files ×
// the hub's factors: src/history/adjustments.ts); `none` — a stock's daily
// (weekly) bars as traded, straight from NSE's stored cash bhavcopies, whatever
// the mode. Index and futures prices are never adjusted: both values give the
// same bars. Every answer says which it is (`adjust`).

/** Timeframes built from daily bars: the only ones end-of-day mode serves. */
const BASE_DAILY = new Set<Tf>(["1d", "1w"]);

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

export type Adjust = "split" | "none";
const ADJUST_MESSAGE = "adjust must be split (default: prices adjusted for splits and bonuses) or none (as traded, from NSE's bhavcopies).";
export const parseAdjust = (value: string | undefined): Adjust | null => (value === undefined || value === "" || value === "split" ? "split" : value === "none" ? "none" : null);
/** Does adjust=none change anything here? Only for a stock (not an index or futures contract). */
const rawStock = (adjust: Adjust, symbol: string) => adjust === "none" && !isIndex(symbol) && !isFuture(symbol);

/**
 * A stock's daily (weekly) candles as traded, from the stored cash bhavcopies,
 * with delivery % on daily bars. Null when no stored file has ever listed it.
 */
export function rawCandles(hub: Hub, symbol: string, tf: "1d" | "1w", range: { from: number; to: number }): { candles: CandleRow[]; complete: boolean; coverage: { from: number; to: number } | null } | null {
  const want = baseRange(tf, range.from, range.to);
  let result: ReturnType<typeof archiveDaily>;
  try {
    result = archiveDaily(hub.db, symbol, want.from, tf === "1d" ? range.to : want.to - DAY_MS, { adjusted: false });
  } catch (error) {
    if (error instanceof BrokerError && error.kind === "bad_symbol") return null;
    if (error instanceof BrokerError) return { candles: [], complete: false, coverage: null };
    throw error;
  }
  let candles: CandleRow[] = result.bars;
  if (tf === "1d") {
    const dp = deliveryPct(hub.db, symbol, want.from, want.to);
    candles = candles.map((bar) => ({ ...bar, dp: dp.get(bar.t) ?? null }));
  } else candles = resample(candles, weekStart);
  candles = candles.filter((bar) => bar.t >= want.from && bar.t <= range.to);
  // Complete: every session of the range up to the newest one NSE could have published is stored or a holiday.
  const newestFinal = weekdayOnOrBefore(istDayKey(hub.clock()) - DAY_MS);
  const lastDay = tf === "1d" ? range.to : want.to - DAY_MS;
  const complete = result.coveredFromDay <= want.from && result.coveredToDay >= Math.min(lastDay, newestFinal);
  return { candles, complete, coverage: result.bars.length ? { from: result.coveredFromDay, to: result.coveredToDay + DAY_MS } : null };
}
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

    const adjust = parseAdjust(c.req.query("adjust"));
    if (!adjust) return c.json(errorBody(ADJUST_MESSAGE, "bad_request"), 400);
    if (rawStock(adjust, symbol)) {
      if (!BASE_DAILY.has(tf)) return c.json(errorBody("adjust=none is for daily and weekly candles (NSE's bhavcopy has no intraday bars); intraday prices are as traded since the last ex-date anyway.", "bad_request"), 400);
      const raw = rawCandles(hub, symbol, tf as "1d" | "1w", range);
      if (!raw) return c.json(errorBody(`${symbol} isn't in any NSE cash bhavcopy the hub has stored.`, "unknown_symbol"), 404);
      const live = withLiveMinutes(hub, symbol, tf, range, raw.candles, "1d");
      return c.json({ symbol, tf, adjust, from: range.from, to: range.to, complete: raw.complete, coverage: raw.coverage, liveThrough: live.through, candles: live.candles });
    }

    // End-of-day mode: no intraday bars exist to serve or fetch (no Retry-After: asking again won't help).
    // NSE-file-only indices and baskets have no intraday bars with a broker either: they answer 404 below.
    if (hub.mode === "end_of_day" && !BASE_DAILY.has(tf) && !isNseOnly(symbol)) return c.json({ ...errorBody(EOD_INTRADAY_MESSAGE, "not_configured"), mode: "end_of_day" }, 503);

    const answer = await hub.history.candles(symbol, tf, range.from, range.to);
    const live = withLiveMinutes(hub, symbol, tf, range, answer.candles, answer.base);
    const body = { symbol, tf, adjust, from: range.from, to: range.to, complete: answer.complete, coverage: answer.coverage, liveThrough: live.through, ...indexLabel(symbol), candles: live.candles };
    if (answer.status === "ok") return c.json(body);
    if (answer.status === "unknown_symbol") return c.json(errorBody(`Unknown symbol ${symbol}.`, "unknown_symbol"), 404);
    if (answer.error?.kind === "not_configured") return c.json({ ...errorBody(answer.error.message, "not_configured"), mode: hub.mode, ...body }, 503);
    if (answer.status === "pending") return c.json({ ...errorBody("Still fetching from the broker; showing what is stored. Try again shortly.", "fetch_pending"), ...body }, 503, { "Retry-After": "10" });
    return c.json({ ...errorBody(`The broker is unavailable (${answer.error?.message ?? "unknown reason"}); showing what is stored.`, "broker_unavailable"), reason: answer.error?.kind ?? null, ...body }, 503, { "Retry-After": "60" });
  });

  app.get("/v1/candles/batch", requireScope("history"), async (c) => {
    const parts = [...new Set((c.req.query("symbols") ?? "").split(",").map((part) => part.trim()).filter(Boolean))];
    if (!parts.length) return c.json(errorBody("symbols is required: comma-separated NSE tickers such as SBIN,INFY,NIFTY (send & as %26).", "bad_request"), 400);
    if (parts.length > MAX_BATCH_SYMBOLS) return c.json(errorBody(`At most ${MAX_BATCH_SYMBOLS} symbols per request (got ${parts.length}).`, "too_many_symbols"), 400);
    const tf = c.req.query("tf") ?? "1d";
    if (!(BATCH_TFS as readonly string[]).includes(tf)) return c.json(errorBody(`tf must be one of ${BATCH_TFS.join(", ")}.`, "bad_request"), 400);
    const batchTf = tf as (typeof BATCH_TFS)[number];
    const adjust = parseAdjust(c.req.query("adjust"));
    if (!adjust) return c.json(errorBody(ADJUST_MESSAGE, "bad_request"), 400);
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
    // Likewise index series, once the hub stores NSE's index file (which comes out in the evening too).
    const lastIndexDay = lastOkDay(hub.db, "index_close");
    const indexFilePending = hub.config.jobsEnabled && lastIndexDay !== null && lastIndexDay < latestFinal;
    const series: Record<string, { complete: boolean; coverage: { from: number; to: number } | null; candles: Bar[]; synthetic?: boolean }> = {};
    const queued: string[] = [];
    const eod = hub.mode === "end_of_day";
    const eodUnknown: string[] = [];
    for (const symbol of symbols) {
      // As traded: NSE's stored bhavcopies, never queued (the broker has only adjusted history).
      if (rawStock(adjust, symbol)) {
        const raw = rawCandles(hub, symbol, batchTf, range);
        if (!raw) {
          eodUnknown.push(symbol);
          continue;
        }
        const live = withLiveMinutes(hub, symbol, batchTf, range, raw.candles, "1d");
        series[symbol] = { complete: raw.complete, coverage: raw.coverage, candles: live.candles };
        continue;
      }
      let stored = hub.history.stored(symbol, batchTf, range.from, range.to);
      // End-of-day mode reads the hub's own bhavcopy store, not a broker: fill a stock in place, no queue.
      if (eod && !stored.complete && !isIndex(symbol) && !isFuture(symbol)) {
        const error = await hub.history.ensure(symbol, stored.base, stored.want, "background").then(
          () => null,
          (caught: unknown) => caught,
        );
        if (error instanceof BrokerError && error.kind === "bad_symbol") {
          eodUnknown.push(symbol);
          continue;
        }
        if (error && !(error instanceof BrokerError)) throw error;
        stored = hub.history.stored(symbol, batchTf, range.from, range.to);
      }
      const fromNse = isIndex(symbol) ? indexFilePending : bhavPending && !isFuture(symbol);
      // NSE-file-only series (other indices, baskets) are never queued: the broker can't add to them.
      const needed = !isNseOnly(symbol) && !stored.complete && (!fromNse || needsBrokerBeyond(stored.coverage, stored.want, latestFinal));
      if (needed && !unavailable && hub.historyQueue.enqueue(symbol, stored.base, stored.want)) queued.push(symbol);
      const live = withLiveMinutes(hub, symbol, batchTf, range, stored.candles, stored.base);
      series[symbol] = { complete: stored.complete, coverage: stored.coverage, candles: live.candles, ...indexLabel(symbol) };
    }
    unknown.push(...eodUnknown);
    const incomplete = symbols.some((symbol) => series[symbol] && !series[symbol].complete && !isNseOnly(symbol));
    // Like /v1/quotes: a broker problem doesn't turn the answer into an error; it says why nothing was queued.
    const warning = !incomplete || !unavailable ? {} : eod ? { warning: "End-of-day mode: served from NSE's stored files; futures, indices before NSE's index file (Feb 2012) and days not downloaded yet are missing.", reason: unavailable.kind } : { warning: `The broker is unavailable (${unavailable.message}); showing what is stored.`, reason: unavailable.kind };
    return c.json({ tf: batchTf, adjust, from: range.from, to: range.to, series, queued, unknown, ...warning });
  });
}

/** `synthetic` for indices and baskets (absent for stocks and futures): a basket is never an NSE index. */
export function indexLabel(symbol: string): { synthetic?: boolean } {
  if (isBasket(symbol)) return { synthetic: true };
  return isIndex(symbol) ? { synthetic: false } : {};
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
