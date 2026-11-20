import type { Hono } from "hono";
import { normalizeSymbol } from "../../broker/symbols.js";
import type { Db } from "../../db.js";
import { lastAdjustmentRun, readListingFactors } from "../../history/adjustments.js";
import type { Hub } from "../../hub.js";
import { lastOkDay } from "../../nse/store.js";
import { loadRenames, storedTraded } from "../../reference/renames.js";
import { isoDay, istDayKey } from "../../time.js";
import { errorBody, requireScope, type HubEnv } from "../common.js";
import { ParamError, parseTime } from "../params.js";

// Reference data as it was on past days, for point-in-time readers (Tradex's
// asOf, ice-009/tradex-public#19). All from what the hub already stores:
//   GET /v1/lots/history[?symbol][&from&to]   history  lot per stock per F&O day, as change points
//   GET /v1/fo/ban/history[?from&to]          fo       the stored F&O ban list of every trade date
//   GET /v1/adjustments/batch?symbols=A,B     history  many listings' split/bonus factors in one request
// Each history answer says from when it is known (`knownFrom`): before that day
// the hub has no record, and a reader must not assume today's value.

/** Most symbols in one /v1/adjustments/batch request. */
export const MAX_BATCH_SYMBOLS = 300;

const TICKER = /^[A-Z0-9][A-Z0-9&_+.-]{0,19}$/;

function dayRange(from: string | undefined, to: string | undefined, today: number) {
  const range = { from: parseTime("from", from, "start", true) ?? Number.MIN_SAFE_INTEGER, to: parseTime("to", to, "end", true) ?? today };
  if (range.from > range.to) throw new ParamError("from must not be after to.");
  return range;
}

/** First F&O day whose bhavcopy carries a lot column (NSE's format from 8 Jul 2024); older files don't. */
export function lotsKnownFrom(db: Db): number | null {
  return (db.prepare("select min(day) as day from fo_futures where lot is not null").get() as { day: number | null }).day;
}

/**
 * Lot per stock between `from` and `to` as change points: each stock's first
 * stored day in the range, then every day its lot differs from the day before.
 */
export function lotHistory(db: Db, from: number, to: number, symbol?: string): Record<string, Array<{ day: number; lot: number }>> {
  const rows = (
    symbol
      ? db.prepare("select symbol, day, lot from fo_futures where symbol = ? and day between ? and ? and lot is not null order by day").all(symbol, from, to)
      : db.prepare("select symbol, day, lot from fo_futures where day between ? and ? and lot is not null order by symbol, day").all(from, to)
  ) as Array<{ symbol: string; day: number; lot: number }>;
  const out: Record<string, Array<{ day: number; lot: number }>> = {};
  for (const row of rows) {
    const list = (out[row.symbol] ??= []);
    if (list.at(-1)?.lot !== row.lot) list.push({ day: row.day, lot: row.lot });
  }
  return out;
}

/** Stored ban lists with from <= trade date <= to, oldest first. */
export function banHistory(db: Db, from: number, to: number): Array<{ tradeDate: number; symbols: string[]; fetchedAt: number }> {
  const rows = db.prepare("select trade_date, symbols, fetched_at from fo_ban where trade_date between ? and ? order by trade_date").all(from, to) as Array<{ trade_date: number; symbols: string; fetched_at: number }>;
  return rows.map((row) => ({ tradeDate: row.trade_date, symbols: JSON.parse(row.symbols) as string[], fetchedAt: row.fetched_at }));
}

export function banKnownFrom(db: Db): number | null {
  return (db.prepare("select min(trade_date) as day from fo_ban").get() as { day: number | null }).day;
}

export function pointInTimeRoutes(app: Hono<HubEnv>, hub: Hub) {
  const bad = (error: unknown) => {
    if (error instanceof ParamError) return errorBody(error.message, "bad_request");
    throw error;
  };
  const iso = (day: number | null) => (day === null ? null : isoDay(day));

  app.get("/v1/lots/history", requireScope("history"), (c) => {
    const raw = c.req.query("symbol");
    const symbol = raw ? normalizeSymbol(raw) : null;
    if (raw && !symbol) return c.json(errorBody("symbol must be an NSE ticker such as SBIN.", "bad_request"), 400);
    let range: { from: number; to: number };
    try {
      range = dayRange(c.req.query("from"), c.req.query("to"), istDayKey(hub.clock()));
    } catch (error) {
      return c.json(bad(error), 400);
    }
    const lastDay = lastOkDay(hub.db, "fo_bhav");
    if (lastDay === null) return c.json(errorBody("No F&O bhavcopy is stored yet; the hub fetches it in the evening and on start.", "not_ready"), 503);
    const knownFrom = lotsKnownFrom(hub.db);
    const history = knownFrom === null ? {} : lotHistory(hub.db, Math.max(range.from, knownFrom), range.to, symbol ?? undefined);
    const lots = Object.fromEntries(Object.entries(history).map(([name, changes]) => [name, changes.map((change) => ({ date: isoDay(change.day), day: change.day, lot: change.lot }))]));
    return c.json({
      from: range.from === Number.MIN_SAFE_INTEGER ? null : isoDay(range.from),
      to: isoDay(range.to),
      knownFrom: iso(knownFrom),
      knownFromDay: knownFrom,
      lastDate: isoDay(lastDay),
      lastDay,
      lots,
    });
  });

  app.get("/v1/fo/ban/history", requireScope("fo"), (c) => {
    let range: { from: number; to: number };
    try {
      range = dayRange(c.req.query("from"), c.req.query("to"), Number.MAX_SAFE_INTEGER);
    } catch (error) {
      return c.json(bad(error), 400);
    }
    const knownFrom = banKnownFrom(hub.db);
    if (knownFrom === null) return c.json(errorBody("The F&O ban list hasn't been downloaded from NSE yet; the hub fetches it in the evening and on start.", "not_ready"), 503);
    const days = banHistory(hub.db, range.from, range.to).map((ban) => ({ date: isoDay(ban.tradeDate), day: ban.tradeDate, symbols: ban.symbols, fetchedAt: ban.fetchedAt }));
    return c.json({ knownFrom: isoDay(knownFrom), knownFromDay: knownFrom, days });
  });

  app.get("/v1/adjustments/batch", requireScope("history"), (c) => {
    const symbols = [...new Set((c.req.query("symbols") ?? "").split(",").map((symbol) => symbol.trim().toUpperCase()).filter(Boolean))];
    if (!symbols.length) return c.json(errorBody("symbols is required (comma-separated NSE tickers).", "bad_request"), 400);
    if (symbols.length > MAX_BATCH_SYMBOLS) return c.json(errorBody(`At most ${MAX_BATCH_SYMBOLS} symbols per request.`, "bad_request"), 400);
    const invalid = symbols.filter((symbol) => !TICKER.test(symbol));
    if (invalid.length) return c.json(errorBody(`Not NSE tickers: ${invalid.slice(0, 5).join(", ")}.`, "bad_request"), 400);
    const today = istDayKey(hub.clock());
    const renames = loadRenames(hub.db);
    const traded = storedTraded(hub.db);
    const series = Object.fromEntries(
      symbols.map((symbol) => {
        const listing = renames.listing(symbol, today, traded);
        const all = readListingFactors(hub.db, listing);
        // `cumulative` as in /v1/adjustments: this factor and every later one.
        let product = 1;
        const cumulative = all.map((factor) => factor.factor).reverse().map((factor) => (product *= factor)).reverse();
        return [symbol, { current: listing.current, factors: all.map((factor, i) => ({ date: isoDay(factor.day), day: factor.day, symbol: factor.symbol, factor: factor.factor, cumulative: cumulative[i], source: factor.source, action: factor.action })) }];
      }),
    );
    return c.json({ derivedAt: lastAdjustmentRun(hub.db)?.derivedAt ?? null, series });
  });
}
