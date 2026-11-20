import type { Hono } from "hono";
import { normalizeSymbol } from "../../broker/symbols.js";
import { lastAdjustmentRun, readListingFactors } from "../../history/adjustments.js";
import type { Hub } from "../../hub.js";
import { readCorporateActions, type StoredCorporateAction } from "../../nse/store.js";
import { listingOf, type Listing } from "../../reference/renames.js";
import { DAY_MS, isoDay, istDayKey } from "../../time.js";
import { errorBody, requireScope, type HubEnv } from "../common.js";
import { ParamError, parseTime } from "../params.js";

// Split and bonus adjustment (src/history/adjustments.ts), from the hub's store:
//   GET /v1/adjustments?symbol[&from&to]         history  a listing's adjustment factors (ex-dates)
//   GET /v1/corporate-actions?[symbol&]from&to   history  NSE's corporate actions (the PR zip's bc file)
// Both follow a company across ticker renames: INFY includes INFOSYSTCH's days.
// Dates as YYYY-MM-DD and as day keys (ms). Raw prices: /v1/candles?adjust=none.

/** Most calendar days a /v1/corporate-actions range may span without a symbol. */
export const MAX_ACTION_DAYS = 400;

function dayRange(from: string | undefined, to: string | undefined, defaults: { from: number; to: number }) {
  const range = { from: parseTime("from", from, "start", true) ?? defaults.from, to: parseTime("to", to, "end", true) ?? defaults.to };
  if (range.from > range.to) throw new ParamError("from must not be after to.");
  return range;
}

const actionRow = (action: StoredCorporateAction) => ({
  symbol: action.symbol,
  exDate: isoDay(action.exDay),
  exDay: action.exDay,
  recordDate: action.recordDay === null ? null : isoDay(action.recordDay),
  purpose: action.purpose,
  kinds: action.kinds,
  ratio: action.ratio,
  series: action.series,
  company: action.company,
});

/** A listing's names, each clipped to the range, for reading per-name rows. */
const namesIn = (listing: Listing) => listing.names.map((name) => ({ symbol: name.symbol, from: name.from === null ? null : isoDay(name.from), until: name.until === null ? null : isoDay(name.until - DAY_MS) }));

export function adjustmentRoutes(app: Hono<HubEnv>, hub: Hub) {
  const bad = (error: unknown) => {
    if (error instanceof ParamError) return errorBody(error.message, "bad_request");
    throw error;
  };

  app.get("/v1/adjustments", requireScope("history"), (c) => {
    const symbol = normalizeSymbol(c.req.query("symbol") ?? "");
    if (!symbol) return c.json(errorBody("symbol is required (an NSE ticker such as INFY).", "bad_request"), 400);
    let range: { from: number; to: number };
    try {
      range = dayRange(c.req.query("from"), c.req.query("to"), { from: Number.MIN_SAFE_INTEGER, to: Number.MAX_SAFE_INTEGER });
    } catch (error) {
      return c.json(bad(error), 400);
    }
    const listing = listingOf(hub.db, symbol, Math.min(range.to, istDayKey(hub.clock())));
    const all = readListingFactors(hub.db, listing);
    // `cumulative`: what a bar the session before this ex-date is multiplied by (this factor and every later one).
    let cumulative = 1;
    const withCumulative = all
      .slice()
      .reverse()
      .map((factor) => {
        cumulative *= factor.factor;
        return { factor, cumulative };
      })
      .reverse();
    const factors = withCumulative
      .filter(({ factor }) => factor.day >= range.from && factor.day <= range.to)
      .map(({ factor, cumulative: product }) => ({
        date: isoDay(factor.day),
        day: factor.day,
        symbol: factor.symbol,
        factor: factor.factor,
        cumulative: product,
        source: factor.source,
        prevDate: isoDay(factor.prevDay),
        prevClose: factor.prevC,
        filePrevClose: factor.prevClose,
        open: factor.o,
        close: factor.c,
        action: factor.action,
        renamedFrom: factor.renamedFrom,
      }));
    const run = lastAdjustmentRun(hub.db);
    return c.json({ symbol, current: listing.current, names: namesIn(listing), derivedAt: run?.derivedAt ?? null, factors });
  });

  app.get("/v1/corporate-actions", requireScope("history"), (c) => {
    const raw = c.req.query("symbol");
    const symbol = raw ? normalizeSymbol(raw) : null;
    if (raw && !symbol) return c.json(errorBody("symbol must be an NSE ticker such as INFY.", "bad_request"), 400);
    const today = istDayKey(hub.clock());
    let range: { from: number; to: number };
    try {
      range = dayRange(c.req.query("from"), c.req.query("to"), symbol ? { from: Number.MIN_SAFE_INTEGER, to: Number.MAX_SAFE_INTEGER } : { from: today - 30 * DAY_MS, to: today + 30 * DAY_MS });
      if (!symbol && range.to - range.from > MAX_ACTION_DAYS * DAY_MS) throw new ParamError(`Without a symbol, from..to may span at most ${MAX_ACTION_DAYS} days.`);
    } catch (error) {
      return c.json(bad(error), 400);
    }
    const days = (hub.db.prepare("select count(*) as n, max(day) as last from corporate_action_days").get() as { n: number; last: number | null });
    if (!days.n) return c.json(errorBody("No corporate-actions file (the PR zip's bc file) is stored yet; the hub reads it each evening, and `hub data nse-history` reads the archive's (from 2010).", "not_ready"), 503);
    let actions: StoredCorporateAction[];
    let names: ReturnType<typeof namesIn> | undefined;
    if (symbol) {
      const listing = listingOf(hub.db, symbol, Math.min(range.to, today));
      names = namesIn(listing);
      actions = listing.names.flatMap((name) => readCorporateActions(hub.db, Math.max(range.from, name.from ?? range.from), Math.min(range.to, name.until === null ? range.to : name.until - DAY_MS), [name.symbol]));
    } else actions = readCorporateActions(hub.db, range.from, range.to);
    return c.json({ ...(symbol ? { symbol, names } : { from: isoDay(range.from), to: isoDay(range.to) }), asOf: days.last === null ? null : isoDay(days.last), actions: actions.map(actionRow) });
  });
}
