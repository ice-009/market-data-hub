import type { Hono } from "hono";
import { isIndex, normalizeSymbol } from "../../broker/symbols.js";
import type { Hub } from "../../hub.js";
import { optionDayOnOrBefore, optionSpan, readIv30, readOptionDay, readOptionSymbol, stockVolumes, toSummary, type OptionSummaryRow } from "../../nse/optionStore.js";
import { flagNames, FLAGS, type ExpirySummary, type OptionSummary } from "../../nse/optionSummary.js";
import { FO_RENAMES } from "../../nse/parsers/foBhav.js";
import { listingOf, namesBetween } from "../../reference/renames.js";
import { DAY_MS, isoDay, istDayKey } from "../../time.js";
import { errorBody, requireScope, type HubEnv } from "../common.js";
import { ParamError, parseTime } from "../params.js";

// Daily option summaries (market-data-hub#30; computed in src/nse/optionSummary.ts):
//   GET /v1/options/summary?symbol=NIFTY[&from&to]   fo   one underlying, day by day (default: the last year)
//   GET /v1/options/day[?date=YYYY-MM-DD][&kind]     fo   every underlying on the newest stored day on or before `date`
// A stock's history follows it across ticker renames (as /v1/candles does).
// `ivPercentile`: the share of the 365 calendar days up to and including the
// day (at least IV_PERCENTILE_MIN_DAYS of them stored) whose iv30 was lower —
// nothing after the day is read, so a past day's answer never changes.

export const IV_PERCENTILE_WINDOW_DAYS = 365;
export const IV_PERCENTILE_MIN_DAYS = 60;

const round = (value: number | null, digits = 4) => (value === null || !Number.isFinite(value) ? null : Number(value.toFixed(digits)));
const ratio = (a: number, b: number) => (b > 0 ? round(a / b) : null);

function legJson(leg: ExpirySummary | null) {
  if (!leg) return null;
  return {
    expiry: isoDay(leg.expiry),
    expiryDay: leg.expiry,
    days: leg.days,
    forward: round(leg.forward, 2),
    atmStrike: leg.atmStrike,
    straddle: round(leg.straddle, 2),
    expectedMovePct: leg.straddle !== null && leg.forward ? round((100 * leg.straddle) / leg.forward, 3) : null,
    atmIv: round(leg.atmIv),
    callIv: round(leg.callIv),
    putIv: round(leg.putIv),
    cpSpread: round(leg.cpSpread),
    iv25Put: round(leg.iv25Put),
    iv25Call: round(leg.iv25Call),
    skew25: leg.iv25Put !== null && leg.iv25Call !== null ? round(leg.iv25Put - leg.iv25Call) : null,
    maxPain: leg.maxPain,
    callWall: leg.callWall,
    callWallOi: leg.callWallOi,
    putWall: leg.putWall,
    putWallOi: leg.putWallOi,
    callOi: leg.callOi,
    putOi: leg.putOi,
    pcrOi: ratio(leg.putOi, leg.callOi),
    strikes: leg.strikes,
    liquidStrikes: leg.liquid,
    flags: flagNames(leg.flags),
  };
}

function dayJson(s: OptionSummary, extra: { stockVolume: number | null; ivPercentile: number | null }) {
  const optionShares = s.lot !== null ? (s.callVolume + s.putVolume) * s.lot : null;
  return {
    date: isoDay(s.day),
    day: s.day,
    ticker: s.nseSymbol,
    kind: s.kind,
    spot: s.spot,
    lot: s.lot,
    lotEstimated: (s.flags & FLAGS.LOT_ESTIMATED) !== 0,
    expiries: s.expiries,
    callOi: s.callOi,
    putOi: s.putOi,
    callChgOi: s.callChgOi,
    putChgOi: s.putChgOi,
    callVolume: s.callVolume,
    putVolume: s.putVolume,
    pcrOi: ratio(s.putOi, s.callOi),
    pcrVolume: ratio(s.putVolume, s.callVolume),
    optionShares,
    stockVolume: extra.stockVolume,
    optionToStock: optionShares !== null && extra.stockVolume ? round(optionShares / extra.stockVolume) : null,
    iv30: round(s.iv30),
    ivPercentile: extra.ivPercentile,
    flags: flagNames(s.flags),
    near: legJson(s.near),
    next: legJson(s.next),
  };
}

/** Percentile (0–100) of `value` among `history` (values strictly lower), or null with too few. */
export function percentileOf(value: number | null, history: readonly number[]): number | null {
  if (value === null || history.length < IV_PERCENTILE_MIN_DAYS) return null;
  const lower = history.filter((v) => v < value).length;
  return Math.round((1000 * lower) / history.length) / 10;
}

/** Each day's ivPercentile over its own trailing window, from (day, iv30) pairs sorted by day. */
export function rollingPercentiles(series: ReadonlyArray<{ day: number; iv30: number }>, days: readonly number[]): Map<number, number | null> {
  const out = new Map<number, number | null>();
  let start = 0;
  let end = 0;
  for (const day of [...days].sort((a, b) => a - b)) {
    while (end < series.length && series[end].day <= day) end += 1;
    while (start < end && series[start].day <= day - IV_PERCENTILE_WINDOW_DAYS * DAY_MS) start += 1;
    const own = end > 0 && series[end - 1].day === day ? series[end - 1].iv30 : null;
    out.set(day, percentileOf(own, series.slice(start, end).map((point) => point.iv30)));
  }
  return out;
}

export function optionRoutes(app: Hono<HubEnv>, hub: Hub) {
  const notReady = () => errorBody("No option summaries are stored yet: they come with the evening's F&O bhavcopy, and `hub data nse-history --only options` reads the archive.", "not_ready");

  app.get("/v1/options/summary", requireScope("fo"), (c) => {
    const raw = c.req.query("symbol");
    const symbol = raw ? normalizeSymbol(raw) : null;
    if (!symbol) return c.json(errorBody("symbol is required: an NSE ticker or index such as SBIN or NIFTY.", "bad_request"), 400);
    const today = istDayKey(hub.clock());
    let from: number;
    let to: number;
    try {
      to = parseTime("to", c.req.query("to"), "end", true) ?? today;
      from = parseTime("from", c.req.query("from"), "start", true) ?? to - 365 * DAY_MS;
      if (from > to) throw new ParamError("from must not be after to.");
    } catch (error) {
      if (error instanceof ParamError) return c.json(errorBody(error.message, "bad_request"), 400);
      throw error;
    }
    const span = optionSpan(hub.db);
    if (span.last === null) return c.json(notReady(), 503);

    // The names the listing traded under (a stock renamed: INFY was INFOSYSTCH), plus the F&O file's own renames.
    const segments = isIndex(symbol) ? [{ symbol, from, to }] : namesBetween(listingOf(hub.db, symbol, Math.min(to, today)), from, to);
    const byDay = new Map<number, OptionSummaryRow>();
    for (const segment of segments) {
      for (const name of new Set([segment.symbol, FO_RENAMES[segment.symbol] ?? segment.symbol])) {
        for (const row of readOptionSymbol(hub.db, name, segment.from, segment.to)) if (!byDay.has(row.day as number)) byDay.set(row.day as number, row);
      }
    }
    const summaries = [...byDay.values()].map(toSummary).sort((a, b) => a.day - b.day);
    const history: Array<{ day: number; iv30: number }> = [];
    if (summaries.length) {
      // The year before `from` as well, for the first days' percentiles.
      const windowFrom = summaries[0].day - IV_PERCENTILE_WINDOW_DAYS * DAY_MS;
      for (const segment of isIndex(symbol) ? [{ symbol, from: windowFrom, to }] : namesBetween(listingOf(hub.db, symbol, Math.min(to, today)), windowFrom, to)) {
        for (const name of new Set([segment.symbol, FO_RENAMES[segment.symbol] ?? segment.symbol])) {
          for (const row of readOptionSymbol(hub.db, name, segment.from, segment.to)) if (row.iv30 !== null) history.push({ day: row.day as number, iv30: row.iv30 as number });
        }
      }
      history.sort((a, b) => a.day - b.day);
    }
    const percentiles = rollingPercentiles(history, summaries.map((s) => s.day));
    const volumes = summaries.length ? stockVolumes(hub.db, [...new Set(summaries.map((s) => s.nseSymbol))], summaries[0].day, summaries.at(-1)!.day) : new Map<string, number>();
    return c.json({
      symbol,
      from: isoDay(from),
      to: isoDay(to),
      knownFrom: isoDay(span.first!),
      knownFromDay: span.first,
      lastDate: isoDay(span.last),
      lastDay: span.last,
      days: summaries.map((s) => dayJson(s, { stockVolume: volumes.get(`${s.nseSymbol}:${s.day}`) ?? null, ivPercentile: percentiles.get(s.day) ?? null })),
    });
  });

  app.get("/v1/options/day", requireScope("fo"), (c) => {
    let asked: number;
    try {
      asked = parseTime("date", c.req.query("date"), "end", true) ?? istDayKey(hub.clock());
    } catch (error) {
      if (error instanceof ParamError) return c.json(errorBody(error.message, "bad_request"), 400);
      throw error;
    }
    const kind = c.req.query("kind");
    if (kind !== undefined && kind !== "stock" && kind !== "index") return c.json(errorBody('kind must be "stock" or "index".', "bad_request"), 400);
    const day = optionDayOnOrBefore(hub.db, asked);
    if (day === null) return c.json(optionSpan(hub.db).last === null ? notReady() : errorBody(`No option summaries stored on or before ${isoDay(asked)}.`, "not_found"), optionSpan(hub.db).last === null ? 503 : 404);
    const summaries = readOptionDay(hub.db, day).map(toSummary).filter((s) => !kind || s.kind === kind);
    const series = new Map<string, number[]>();
    for (const point of readIv30(hub.db, day - (IV_PERCENTILE_WINDOW_DAYS - 1) * DAY_MS, day)) {
      const list = series.get(point.symbol) ?? [];
      list.push(point.iv30);
      series.set(point.symbol, list);
    }
    const volumes = stockVolumes(hub.db, summaries.map((s) => s.nseSymbol), day, day);
    return c.json({
      date: isoDay(day),
      day,
      count: summaries.length,
      rows: summaries.map((s) => ({ symbol: s.symbol, ...dayJson(s, { stockVolume: volumes.get(`${s.nseSymbol}:${day}`) ?? null, ivPercentile: percentileOf(s.iv30, series.get(s.symbol) ?? []) }) })),
    });
  });
}
