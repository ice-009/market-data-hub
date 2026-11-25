import type { Hono } from "hono";
import { BrokerError } from "../../broker/errors.js";
import type { Bar } from "../../broker/fyers.js";
import { isFuture, isIndex, isNseOnly, normalizeSymbol } from "../../broker/symbols.js";
import { EOD_INTRADAY_MESSAGE, archiveContext, archiveDaily, type ArchiveContext } from "../../history/fromArchive.js";
import { archivePartOrNull, brokerSeam, handover, joinCoverage, joinSpans, storedReference, storedSpans, type SourceSpan } from "../../history/longDaily.js";
import { needsBrokerBeyond, type Range } from "../../history/plan.js";
import { resample, weekStart } from "../../history/resample.js";
import { baseRange, type CandleAnswer, type CandleRow } from "../../history/service.js";
import { readSeries } from "../../history/store.js";
import type { BaseTf } from "../../history/timeframes.js";
import { finalBefore, isTf, TIMEFRAMES, type Tf } from "../../history/timeframes.js";
import type { Hub } from "../../hub.js";
import { bucketOf, mergeMinutes } from "../../live/merge.js";
import { lastOkDay } from "../../nse/store.js";
import { isBasket } from "../../reference/indices.js";
import { tradingDayOnOrBefore } from "../../calendar/calendar.js";
import { DAY_MS, istDayKey } from "../../time.js";
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
// Daily and weekly history reaches back before the broker's ~5-year window
// (#22, src/history/longDaily.ts): a stock's older bars come from NSE's stored
// cash bhavcopies (back to 1994, renamed tickers joined), lined up with the
// broker's at the seam; an index's from NSE's index file (2012 on). `sources`
// says which stretch came from where.
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
// Older than the broker's window, stocks are answered from the archive as in
// /v1/candles (nothing to queue for those days).
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
/** A stock's adjusted daily history that may reach back into NSE's archive. */
const archiveStock = (symbol: string) => !isIndex(symbol) && !isFuture(symbol);
/** The last day a daily (weekly) request reads: `to`, or the Sunday of its week. */
const lastDayOf = (tf: "1d" | "1w", range: Range) => (tf === "1d" ? range.to : weekStart(range.to) + 6 * DAY_MS);

/**
 * A stock's daily (weekly) candles as traded, from the stored cash bhavcopies,
 * with delivery % on daily bars, renamed tickers joined. Null when no stored
 * file has ever listed it.
 */
export function rawCandles(hub: Hub, symbol: string, tf: "1d" | "1w", range: { from: number; to: number }, context?: ArchiveContext): { candles: CandleRow[]; complete: boolean; coverage: { from: number; to: number } | null; sources: SourceSpan[] } | null {
  const want = baseRange(tf, range.from, range.to);
  let result: ReturnType<typeof archiveDaily>;
  try {
    result = archiveDaily(hub.db, symbol, want.from, tf === "1d" ? range.to : want.to - DAY_MS, { adjusted: false, context });
  } catch (error) {
    if (error instanceof BrokerError && error.kind === "bad_symbol") return null;
    if (error instanceof BrokerError) return { candles: [], complete: false, coverage: null, sources: [] };
    throw error;
  }
  let candles: CandleRow[] = result.bars;
  if (tf === "1d") candles = candles.map((bar) => ({ ...bar, dp: result.dp.get(bar.t) ?? null }));
  else candles = resample(candles, weekStart);
  candles = candles.filter((bar) => bar.t >= want.from && bar.t <= range.to);
  // Complete: every session of the range up to the newest one NSE could have published is stored or a holiday.
  const newestFinal = tradingDayOnOrBefore(istDayKey(hub.clock()) - DAY_MS);
  const lastDay = tf === "1d" ? range.to : want.to - DAY_MS;
  const complete = result.coveredFromDay <= want.from && result.coveredToDay >= Math.min(lastDay, newestFinal);
  const names = result.names.map((name) => name.symbol);
  const sources: SourceSpan[] = candles.length ? [{ source: "archive", from: candles[0].t, to: candles[candles.length - 1].t, ...(names.length ? { names } : {}) }] : [];
  return { candles, complete, coverage: result.bars.length ? { from: result.coveredFromDay, to: result.coveredToDay + DAY_MS } : null, sources };
}

interface LongAnswer {
  candles: CandleRow[];
  complete: boolean;
  coverage: Range | null;
  sources: SourceSpan[];
}

/**
 * Join a stock's archive bars (before the hand-over) with the daily bars
 * served inside the window, as `tf` candles within `range`. `inWindow` null:
 * the broker doesn't know the ticker (delisted, or renamed away), so the
 * archive serves the whole range. Null when the archive has nothing before
 * the hand-over (the caller answers as before).
 */
function joinLong(hub: Hub, symbol: string, tf: "1d" | "1w", range: Range, inWindow: { candles: CandleRow[]; complete: boolean; coverage: Range | null } | null, context?: ArchiveContext): LongAnswer | null {
  const now = hub.clock();
  const want = baseRange(tf, range.from, range.to);
  const lastDay = lastDayOf(tf, range);
  const seam = brokerSeam(now);
  const until = inWindow ? handover(hub.db, symbol, seam) : lastDay + DAY_MS;
  const reference = inWindow ? storedReference(hub.db, symbol, until) : [];
  const archive = archivePartOrNull(hub.db, symbol, want.from, Math.min(until, lastDay + DAY_MS), reference, { adjusted: true, today: istDayKey(now), context });
  if (!archive?.bars.length) return null;
  const after = (inWindow?.candles ?? []).filter((bar) => bar.t >= until);
  let candles: CandleRow[] = [...archive.bars, ...after];
  if (tf === "1w") candles = resample(candles, weekStart);
  candles = candles.filter((bar) => bar.t >= want.from && bar.t <= range.to);
  const spans: SourceSpan[] = [...(archive.span ? [archive.span] : []), ...storedSpans(symbol, hub.mode, after, seam)];
  const reachesWindow = lastDay >= until;
  return {
    candles,
    complete: archive.complete && (!reachesWindow || !inWindow || inWindow.complete),
    coverage: reachesWindow && inWindow ? joinCoverage(archive.coverage, inWindow.coverage) : archive.coverage,
    sources: joinSpans(spans),
  };
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
      return c.json({ symbol, tf, adjust, from: range.from, to: range.to, complete: raw.complete, coverage: raw.coverage, liveThrough: live.through, sources: raw.sources, candles: live.candles });
    }

    // End-of-day mode: no intraday bars exist to serve or fetch (no Retry-After: asking again won't help).
    // NSE-file-only indices and baskets have no intraday bars with a broker either: they answer 404 below.
    if (hub.mode === "end_of_day" && !BASE_DAILY.has(tf) && !isNseOnly(symbol)) return c.json({ ...errorBody(EOD_INTRADAY_MESSAGE, "not_configured"), mode: "end_of_day" }, 503);

    let answer: CandleAnswer & { sources?: SourceSpan[] };
    const seam = brokerSeam(hub.clock());
    const daily = tf === "1d" || tf === "1w";
    const long = daily && archiveStock(symbol) && baseRange(tf, range.from, range.to).from < seam ? await longCandles(hub, symbol, tf as "1d" | "1w", range) : null;
    if (long) answer = long;
    else {
      answer = await hub.history.candles(symbol, tf, range.from, range.to);
      // Inside the window, or nothing in the archive: as before, plus where the bars came from.
      if (daily) {
        answer.sources = storedSpans(symbol, hub.mode, answer.candles, seam);
        // Before the window an index has only what NSE's index file reaches back to.
        const wantFrom = baseRange(tf, range.from, range.to).from;
        if (isIndex(symbol) && wantFrom < seam) answer.complete = answer.complete && Boolean(answer.coverage && answer.coverage.from <= wantFrom);
      }
    }
    const live = withLiveMinutes(hub, symbol, tf, range, answer.candles, answer.base);
    const body = { symbol, tf, adjust, from: range.from, to: range.to, complete: answer.complete, coverage: answer.coverage, liveThrough: live.through, ...indexLabel(symbol), ...(answer.sources ? { sources: answer.sources } : {}), candles: live.candles };
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

    const now = hub.clock();
    const seam = brokerSeam(now);
    const wantFrom = baseRange(batchTf, range.from, range.to).from;
    const reachesBack = wantFrom < seam;
    // One read of the cash days' statuses and the renames for every symbol of the request.
    let context: ArchiveContext | undefined;
    const sharedContext = () => (context ??= archiveContext(hub.db, wantFrom));

    // A malformed ticker shouldn't sink a 300-symbol screen: it is reported as unknown.
    const unknown: string[] = [];
    const symbols: string[] = [];
    const archiveOnly: string[] = [];
    for (const part of parts) {
      const symbol = normalizeSymbol(part);
      if (!symbol) unknown.push(part);
      else if (hub.historyQueue.isUnknown(symbol)) {
        // The broker doesn't know it (delisted, renamed away): the archive may still have its history.
        if (reachesBack && adjust === "split" && archiveStock(symbol) && !archiveOnly.includes(symbol)) archiveOnly.push(symbol);
        else unknown.push(symbol);
      } else if (!symbols.includes(symbol)) symbols.push(symbol);
    }

    const unavailable = hub.brokerUnavailable();
    const latestFinal = tradingDayOnOrBefore(finalBefore("1d", now) - DAY_MS);
    const bhavPending = hub.config.jobsEnabled && (lastOkDay(hub.db, "cash_bhav") ?? -Infinity) < latestFinal;
    // Likewise index series, once the hub stores NSE's index file (which comes out in the evening too).
    const lastIndexDay = lastOkDay(hub.db, "index_close");
    const indexFilePending = hub.config.jobsEnabled && lastIndexDay !== null && lastIndexDay < latestFinal;
    const series: Record<string, { complete: boolean; coverage: { from: number; to: number } | null; candles: Bar[]; synthetic?: boolean; sources?: SourceSpan[] }> = {};
    const queued: string[] = [];
    const eod = hub.mode === "end_of_day";
    const eodUnknown: string[] = [];
    for (const symbol of archiveOnly) {
      const long = joinLong(hub, symbol, batchTf, range, null, sharedContext());
      if (long) series[symbol] = { complete: long.complete, coverage: long.coverage, candles: long.candles, sources: long.sources };
      else unknown.push(symbol);
    }
    for (const symbol of symbols) {
      // As traded: NSE's stored bhavcopies, never queued (the broker has only adjusted history).
      if (rawStock(adjust, symbol)) {
        const raw = rawCandles(hub, symbol, batchTf, range, reachesBack ? sharedContext() : undefined);
        if (!raw) {
          eodUnknown.push(symbol);
          continue;
        }
        const live = withLiveMinutes(hub, symbol, batchTf, range, raw.candles, "1d");
        series[symbol] = { complete: raw.complete, coverage: raw.coverage, candles: live.candles, sources: raw.sources };
        continue;
      }
      // Older than the window, a stock's history comes from the archive: only the window's part is the store's (and the broker's).
      const long = reachesBack && archiveStock(symbol);
      const ask = long ? { tf: "1d" as const, from: seam, to: Math.max(lastDayOf(batchTf, range), seam) } : { tf: batchTf, from: range.from, to: range.to };
      let stored = hub.history.stored(symbol, ask.tf, ask.from, ask.to);
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
        stored = hub.history.stored(symbol, ask.tf, ask.from, ask.to);
      }
      const fromNse = isIndex(symbol) ? indexFilePending : bhavPending && !isFuture(symbol);
      // NSE-file-only series (other indices, baskets) are never queued: the broker can't add to them.
      const inWindow = !long || range.to >= seam;
      const needed = inWindow && !isNseOnly(symbol) && !stored.complete && (!fromNse || needsBrokerBeyond(stored.coverage, stored.want, latestFinal));
      if (needed && !unavailable && hub.historyQueue.enqueue(symbol, stored.base, stored.want)) queued.push(symbol);
      const joined = long ? joinLong(hub, symbol, batchTf, range, { candles: stored.candles, complete: stored.complete, coverage: stored.coverage }, sharedContext()) : null;
      if (joined) {
        const live = withLiveMinutes(hub, symbol, batchTf, range, joined.candles, "1d");
        series[symbol] = { complete: joined.complete, coverage: joined.coverage, candles: live.candles, sources: joined.sources };
        continue;
      }
      if (long) stored = hub.history.stored(symbol, batchTf, range.from, range.to);
      // Before the window an index has only what NSE's index file reaches back to.
      const complete = stored.complete && (!reachesBack || !isIndex(symbol) || Boolean(stored.coverage && stored.coverage.from <= wantFrom));
      const live = withLiveMinutes(hub, symbol, batchTf, range, stored.candles, stored.base);
      series[symbol] = { complete, coverage: stored.coverage, candles: live.candles, ...indexLabel(symbol), sources: storedSpans(symbol, hub.mode, stored.candles, seam) };
    }
    unknown.push(...eodUnknown);
    const incomplete = symbols.some((symbol) => series[symbol] && !series[symbol].complete && !isNseOnly(symbol));
    // Like /v1/quotes: a broker problem doesn't turn the answer into an error; it says why nothing was queued.
    const warning = !incomplete || !unavailable ? {} : eod ? { warning: "End-of-day mode: served from NSE's stored files; futures, indices before NSE's index file (Feb 2012) and days not downloaded yet are missing.", reason: unavailable.kind } : { warning: `The broker is unavailable (${unavailable.message}); showing what is stored.`, reason: unavailable.kind };
    return c.json({ tf: batchTf, adjust, from: range.from, to: range.to, series, queued, unknown, ...warning });
  });
}

/**
 * /v1/candles for a stock reaching back before the broker's window: the
 * window's part as usual (fetched if missing, at user priority), joined with
 * the archive. Null when the archive has nothing for the older days (then the
 * request is answered exactly as before).
 */
async function longCandles(hub: Hub, symbol: string, tf: "1d" | "1w", range: Range): Promise<(CandleAnswer & { sources: SourceSpan[] }) | null> {
  const seam = brokerSeam(hub.clock());
  const lastDay = lastDayOf(tf, range);
  // The window's daily bars (or, for a range ending before it, the first few — the seam's reference — once).
  const windowTo = lastDay >= seam ? lastDay : Math.min(seam + 30 * DAY_MS, istDayKey(hub.clock()));
  const needSeam = lastDay >= seam || storedReference(hub.db, symbol, seam).length === 0;
  const inWindow = needSeam ? await hub.history.candles(symbol, "1d", seam, windowTo) : null;
  if (inWindow?.status === "unknown_symbol") {
    // The broker doesn't know the ticker (delisted, renamed away): the archive alone, when it has it.
    const archive = joinLong(hub, symbol, tf, range, null);
    return archive ? { status: "ok", base: "1d", ...archive } : null;
  }
  const part = lastDay >= seam && inWindow ? inWindow : { candles: [], complete: true, coverage: readSeries(hub.db, symbol, "1d")?.coverage ?? null };
  const joined = joinLong(hub, symbol, tf, range, part);
  if (!joined) return null;
  return { status: lastDay >= seam && inWindow ? inWindow.status : "ok", base: "1d", ...joined, ...(lastDay >= seam && inWindow?.error ? { error: inWindow.error } : {}) };
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
