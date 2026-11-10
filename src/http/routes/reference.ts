import type { Hono } from "hono";
import { futureTicker, normalizeSymbol } from "../../broker/symbols.js";
import type { Hub } from "../../hub.js";
import { combinedOiChangePct, oiFact } from "../../nse/openInterest.js";
import type { FoDayRecord, FoLeg } from "../../nse/parsers/foBhav.js";
import { foMembersBetween, foMembersOn, lastOkDay, latestBan, latestFoRecord, readFoDay, readFoSymbol, readLots, readResults, readRuns } from "../../nse/store.js";
import { computeRegime } from "../../reference/marketRegime.js";
import { getUniverse, isUniverse, UNIVERSES } from "../../reference/universe.js";
import { banTarget } from "../../jobs/scheduler.js";
import { DAY_MS, isoDay, istDayKey } from "../../time.js";
import { errorBody, requireScope, type HubEnv } from "../common.js";
import { ParamError, parseRange, parseTime } from "../params.js";

// Reference data, all from the hub's own store (filled by the NSE jobs):
//   GET /v1/universe/:name                 history  fno | nifty50 | nifty100 | nifty200 | nifty500
//   GET /v1/fo/oi?symbol&from&to           fo       stock futures OI from the NSE F&O bhavcopy
//   GET /v1/fo/oi/day[?date]               fo       every stock's futures OI on one trade day
//   GET /v1/fo/members?date                fo       F&O list on a date (point-in-time)
//   GET /v1/fo/members?from&to             fo       F&O list on every stored trade day in a range
//   GET /v1/fo/contracts?symbol            fo       a stock's near/next futures contracts (hub tickers)
//   GET /v1/fo/ban                         fo       the F&O ban list
//   GET /v1/lots[?symbol]                  history  stock-futures lot sizes
//   GET /v1/results-calendar?from&to       history  results dates from NSE's event calendar
//   GET /v1/market/regime[?universe]       history  NIFTY trend + breadth
// Dates in responses are IST trade dates, as YYYY-MM-DD and as day keys (ms).

/** Most calendar days one /v1/fo/members range may span. */
export const MAX_MEMBER_DAYS = 400;

/** One stock's futures on one day, as /v1/fo/oi and /v1/fo/oi/day serve it. */
function oiRow(record: FoDayRecord) {
  const fact = oiFact(record);
  return {
    date: isoDay(record.day),
    day: record.day,
    nseSymbol: record.nseSymbol,
    expiries: record.expiries,
    lot: record.lot,
    underlying: record.underlying,
    near: { ...record.near, expiry: isoDay(record.near.expiry) },
    next: record.next ? { ...record.next, expiry: isoDay(record.next.expiry) } : null,
    oi: record.oi,
    chgOi: record.chgOi,
    oiChangePct: combinedOiChangePct(record),
    pricePct: fact.pricePct,
    buildup: fact.buildup,
    basisPct: fact.basisPct,
  };
}

const notReady = (what: string) => errorBody(`${what} hasn't been downloaded from NSE yet; the hub fetches it in the evening and on start.`, "not_ready");

export function referenceRoutes(app: Hono<HubEnv>, hub: Hub) {
  const bad = (error: unknown) => {
    if (error instanceof ParamError) return errorBody(error.message, "bad_request");
    throw error;
  };

  app.get("/v1/universe/:name", requireScope("history"), (c) => {
    const name = c.req.param("name");
    if (!isUniverse(name)) return c.json(errorBody(`Unknown universe. Choose from ${UNIVERSES.join(", ")}.`, "not_found"), 404);
    const universe = getUniverse(hub.db, name);
    return c.json({ ...universe, count: universe.members.length });
  });

  app.get("/v1/fo/oi", requireScope("fo"), (c) => {
    const symbol = normalizeSymbol(c.req.query("symbol") ?? "");
    if (!symbol) return c.json(errorBody("symbol is required (an NSE ticker such as SBIN).", "bad_request"), 400);
    let range: { from: number; to: number };
    try {
      range = parseRange({ from: c.req.query("from"), to: c.req.query("to") }, true, 30, Date.now());
    } catch (error) {
      return c.json(bad(error), 400);
    }
    const days = readFoSymbol(hub.db, symbol, range.from, range.to).map(oiRow);
    return c.json({ symbol, from: isoDay(range.from), to: isoDay(range.to), days });
  });

  // One trade day across every stock (a screener's OI column): the newest stored day by
  // default; an explicit date must be a stored trade day (no silent fallback to an older one).
  app.get("/v1/fo/oi/day", requireScope("fo"), (c) => {
    let day: number | undefined;
    try {
      day = parseTime("date", c.req.query("date"), "start", true);
    } catch (error) {
      return c.json(bad(error), 400);
    }
    const latest = lastOkDay(hub.db, "fo_bhav");
    if (latest === null) return c.json(errorBody("No F&O bhavcopy is stored yet; the hub fetches it in the evening and on start.", "not_ready"), 404);
    const target = day ?? latest;
    const records = readFoDay(hub.db, target);
    if (!records.length) return c.json(errorBody(`No F&O bhavcopy is stored for ${isoDay(target)} (newest: ${isoDay(latest)}).`, "no_data"), 404);
    return c.json({ date: isoDay(target), day: target, rows: records.map((record) => ({ symbol: record.symbol, ...oiRow(record) })) });
  });

  app.get("/v1/fo/members", requireScope("fo"), (c) => {
    if (c.req.query("from") !== undefined || c.req.query("to") !== undefined) {
      if (c.req.query("date") !== undefined) return c.json(errorBody("Use either date or from/to, not both.", "bad_request"), 400);
      let range: { from: number; to: number };
      try {
        range = parseRange({ from: c.req.query("from"), to: c.req.query("to") }, true, 30, Date.now());
        if (range.to - range.from >= MAX_MEMBER_DAYS * DAY_MS) throw new ParamError(`A range may span at most ${MAX_MEMBER_DAYS} days.`);
      } catch (error) {
        return c.json(bad(error), 400);
      }
      const days = foMembersBetween(hub.db, range.from, range.to).map((entry) => ({ date: isoDay(entry.day), day: entry.day, symbols: entry.symbols }));
      return c.json({ from: isoDay(range.from), to: isoDay(range.to), days });
    }
    let day: number;
    try {
      day = parseTime("date", c.req.query("date"), "start", true) ?? istDayKey();
    } catch (error) {
      return c.json(bad(error), 400);
    }
    const members = foMembersOn(hub.db, day);
    if (!members) return c.json(errorBody(`No F&O bhavcopy is stored on or before ${isoDay(day)}.`, "no_data"), 404);
    return c.json({ date: isoDay(day), tradeDate: isoDay(members.day), count: members.symbols.length, symbols: members.symbols });
  });

  // Contracts as hub tickers (SBIN26NOVFUT), usable with /v1/candles, /v1/quotes and /v1/stream.
  // From the newest stored F&O bhavcopy, which lists the near and next month; a
  // contract that has expired since that file is left out.
  app.get("/v1/fo/contracts", requireScope("fo"), (c) => {
    const symbol = normalizeSymbol(c.req.query("symbol") ?? "");
    if (!symbol) return c.json(errorBody("symbol is required (an NSE ticker such as SBIN).", "bad_request"), 400);
    const latest = latestFoRecord(hub.db, symbol);
    if (!latest) return c.json(errorBody("No F&O bhavcopy is stored yet; the hub fetches it in the evening and on start.", "not_ready"), 404);
    const { record } = latest;
    if (!record) return c.json(errorBody(`${symbol} has no stock futures in the F&O bhavcopy of ${isoDay(latest.day)}.`, "not_found"), 404);
    const today = istDayKey(hub.clock());
    const legs = [record.near, record.next].filter((leg): leg is FoLeg => leg !== null && leg.expiry >= today);
    const contracts = legs.map((leg, index) => ({ ticker: futureTicker(record.nseSymbol, leg.expiry), expiry: isoDay(leg.expiry), kind: index === 0 ? ("near" as const) : ("next" as const) }));
    return c.json({ symbol, asOf: isoDay(latest.day), lot: record.lot ?? readLots(hub.db)[symbol] ?? null, contracts });
  });

  app.get("/v1/fo/ban", requireScope("fo"), (c) => {
    const ban = latestBan(hub.db);
    if (!ban) return c.json(notReady("The F&O ban list"), 503);
    return c.json({ tradeDate: isoDay(ban.tradeDate), symbols: ban.symbols, fetchedAt: ban.fetchedAt, current: ban.tradeDate >= banTarget(Date.now()) });
  });

  app.get("/v1/lots", requireScope("history"), (c) => {
    const lots = readLots(hub.db);
    const run = readRuns(hub.db).get("lots");
    if (!Object.keys(lots).length) return c.json(notReady("The lot-size file"), 503);
    const symbol = c.req.query("symbol");
    if (symbol !== undefined) {
      const ticker = normalizeSymbol(symbol);
      if (!ticker || !(ticker in lots)) return c.json(errorBody(`No lot size for ${symbol}.`, "not_found"), 404);
      return c.json({ symbol: ticker, lot: lots[ticker], source: run?.info?.source ?? null, fetchedAt: run?.lastSuccessAt ?? null });
    }
    return c.json({ source: run?.info?.source ?? null, fetchedAt: run?.lastSuccessAt ?? null, count: Object.keys(lots).length, lots });
  });

  app.get("/v1/results-calendar", requireScope("history"), (c) => {
    const today = istDayKey();
    let range: { from: number; to: number };
    try {
      range = {
        from: parseTime("from", c.req.query("from"), "start", true) ?? today - 7 * DAY_MS,
        to: parseTime("to", c.req.query("to"), "end", true) ?? today + 60 * DAY_MS,
      };
      if (range.from > range.to) throw new ParamError("from must not be after to.");
    } catch (error) {
      return c.json(bad(error), 400);
    }
    const run = readRuns(hub.db).get("results");
    if (!run?.lastSuccessAt) return c.json(notReady("The results calendar"), 503);
    const symbol = c.req.query("symbol") ? (normalizeSymbol(c.req.query("symbol")!) ?? "") : undefined;
    const events = readResults(hub.db, range.from, range.to, symbol).map((event) => ({ ...event, date: isoDay(event.date), day: event.date }));
    return c.json({ from: isoDay(range.from), to: isoDay(range.to), fetchedAt: run.lastSuccessAt, events });
  });

  app.get("/v1/market/regime", requireScope("history"), async (c) => {
    const universe = c.req.query("universe") ?? "nifty500";
    if (!isUniverse(universe)) return c.json(errorBody(`universe must be one of ${UNIVERSES.join(", ")}.`, "bad_request"), 400);
    const answer = await computeRegime(hub.db, hub.history, universe);
    if (!answer.regime) return c.json(errorBody(`NIFTY history isn't available (${answer.error ?? "unknown"}).`, answer.status === "pending" ? "fetch_pending" : "broker_unavailable"), 503, { "Retry-After": answer.status === "pending" ? "10" : "60" });
    if (answer.status !== "ok") return c.json({ ...errorBody(`Computed from stored data only (${answer.error ?? "broker unavailable"}).`, "broker_unavailable"), ...answer.regime }, 503, { "Retry-After": "60" });
    return c.json(answer.regime);
  });
}
