import type { Hono } from "hono";
import { normalizeSymbol } from "../../broker/symbols.js";
import type { Db } from "../../db.js";
import { lastAdjustmentRun, readListingFactors } from "../../history/adjustments.js";
import type { Hub } from "../../hub.js";
import { lotSources, lotsKnownFrom, lotHistory } from "../../nse/lotHistory.js";
import { lastOkDay } from "../../nse/store.js";
import { loadRenames, storedTraded } from "../../reference/renames.js";
import { isoDay, istDayKey } from "../../time.js";
import { errorBody, requireScope, type HubEnv } from "../common.js";
import { ParamError, parseTime } from "../params.js";

// Reference data as it was on past days, for point-in-time readers (Tradex's
// asOf, ice-009/tradex-public#19). All from what the hub already stores:
//   GET /v1/lots/history[?symbol][&from&to]   history  lot per stock per F&O day, as change points
//                                                      (NSE's lot column from 8 Jul 2024, derived from
//                                                      the open interest before: src/nse/lotHistory.ts)
//   GET /v1/fo/ban/history[?from&to]          fo       the stored F&O ban list of every trade date
//                                                      (NSE's archive from 2008), and the sessions without one
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

/** Stored ban lists with from <= trade date <= to, oldest first. */
export function banHistory(db: Db, from: number, to: number): Array<{ tradeDate: number; symbols: string[]; fetchedAt: number }> {
  const rows = db.prepare("select trade_date, symbols, fetched_at from fo_ban where trade_date between ? and ? order by trade_date").all(from, to) as Array<{ trade_date: number; symbols: string; fetched_at: number }>;
  return rows.map((row) => ({ tradeDate: row.trade_date, symbols: JSON.parse(row.symbols) as string[], fetchedAt: row.fetched_at }));
}

export function banKnownFrom(db: Db): number | null {
  return (db.prepare("select min(trade_date) as day from fo_ban").get() as { day: number | null }).day;
}

/**
 * F&O sessions (stored F&O bhavcopy days) from..to with no stored ban list,
 * and whether NSE was asked for one: "no_file" (its archive has none for
 * that day) or "not_downloaded".
 */
export function banGaps(db: Db, from: number, to: number): Array<{ day: number; reason: "no_file" | "not_downloaded" }> {
  const rows = db
    .prepare(
      `select f.day, b.status from nse_days f
       left join nse_days b on b.dataset = 'fo_ban' and b.day = f.day
       where f.dataset = 'fo_bhav' and f.status = 'ok' and f.day between ? and ?
         and not exists (select 1 from fo_ban where trade_date = f.day)
       order by f.day`,
    )
    .all(from, to) as Array<{ day: number; status: string | null }>;
  return rows.map((row) => ({ day: row.day, reason: row.status === null ? "not_downloaded" : "no_file" }));
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
    const lots = Object.fromEntries(
      Object.entries(history).map(([name, changes]) => [
        name,
        changes.map((change) => ({ date: isoDay(change.day), day: change.day, lot: change.lot, source: change.source, ...(change.confidence === "low" ? { confidence: "low" as const } : {}) })),
      ]),
    );
    const sources = lotSources(hub.db);
    const span = (value: { from: number; to: number } | null) => (value ? { from: isoDay(value.from), to: isoDay(value.to), fromDay: value.from, toDay: value.to } : null);
    return c.json({
      from: range.from === Number.MIN_SAFE_INTEGER ? null : isoDay(range.from),
      to: isoDay(range.to),
      knownFrom: iso(knownFrom),
      knownFromDay: knownFrom,
      lastDate: isoDay(lastDay),
      lastDay,
      sources: { bhavcopy: span(sources.bhavcopy), derived: span(sources.derived) },
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
    const missing = banGaps(hub.db, Math.max(range.from, knownFrom), range.to).map((gap) => ({ date: isoDay(gap.day), day: gap.day, reason: gap.reason }));
    return c.json({ knownFrom: isoDay(knownFrom), knownFromDay: knownFrom, days, missing });
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
