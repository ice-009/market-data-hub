import type { Hono } from "hono";
import type { Hub } from "../../hub.js";
import { readRuns } from "../../nse/store.js";
import { IMPORTED_SERIES } from "../../import/tradex.js";
import { archiveSymbols } from "../../reference/archiveSymbols.js";
import { listingOf, loadRenames, nameOn, storedListing, type NameSpan, type SymbolChange } from "../../reference/renames.js";
import { DAY_MS, isoDay, istDayKey } from "../../time.js";
import { errorBody, requireScope, type HubEnv } from "../common.js";
import { ParamError, parseTime } from "../params.js";

// Ticker renames, point in time (src/reference/renames.ts):
//   GET /v1/symbols/history?symbol[&date]        history  one listing's tickers over time, and its stored cash history per ticker
//   GET /v1/symbols/changes[?symbol][&from&to]   history  every known rename (NSE's list + renames seen in ISINs)
//   GET /v1/symbols/archive[?from&to][&series][&after&limit]  history  every ticker in the stored cash bhavcopies (#60)
// `symbol` is a ticker as it was on `date` (default today): INFOSYSTCH with a
// 2005 date and INFY today are the same listing.

// Old tickers include characters today's don't (SRERAYHY+H in 1996).
const TICKER = /^[A-Z0-9][A-Z0-9&_+.-]{0,19}$/;

/** Page size of /v1/symbols/archive: default and most. */
export const ARCHIVE_PAGE = { default: 2000, max: 10000 };

const nameBody = (name: NameSpan) => ({ symbol: name.symbol, from: name.from === null ? null : isoDay(name.from), to: name.until === null ? null : isoDay(name.until - DAY_MS) });

const changeBody = (change: SymbolChange) => ({
  date: isoDay(change.day),
  day: change.day,
  oldSymbol: change.oldSymbol,
  newSymbol: change.newSymbol,
  company: change.company,
  source: change.source,
  isin: change.isin,
});

export function symbolRoutes(app: Hono<HubEnv>, hub: Hub) {
  const fetchedAt = () => readRuns(hub.db).get("symbol_changes")?.lastSuccessAt ?? null;
  const notReady = () => errorBody("NSE's list of ticker changes hasn't been downloaded yet; the hub fetches it in the evening and on start.", "not_ready");

  app.get("/v1/symbols/history", requireScope("history"), (c) => {
    const symbol = (c.req.query("symbol") ?? "").trim().toUpperCase();
    if (!TICKER.test(symbol)) return c.json(errorBody("symbol is required (an NSE ticker such as INFY, or an old one such as INFOSYSTCH).", "bad_request"), 400);
    let day: number;
    try {
      day = parseTime("date", c.req.query("date"), "start", true) ?? istDayKey(hub.clock());
    } catch (error) {
      if (error instanceof ParamError) return c.json(errorBody(error.message, "bad_request"), 400);
      throw error;
    }
    const at = fetchedAt();
    if (at === null) return c.json(notReady(), 503);
    const listing = listingOf(hub.db, symbol, day);
    const stored = storedListing(hub.db, listing);
    return c.json({
      symbol,
      date: isoDay(day),
      match: listing.match,
      onDate: nameOn(listing, day),
      current: listing.current,
      names: stored.names.map((name) => ({
        ...nameBody(name),
        stored: name.stored ? { first: isoDay(name.stored.first), last: isoDay(name.stored.last), sessions: name.stored.sessions } : null,
      })),
      changes: listing.changes.map((change, i) => ({ ...changeBody(change), continuous: stored.continuous[i] })),
      fetchedAt: at,
    });
  });

  app.get("/v1/symbols/changes", requireScope("history"), (c) => {
    let from: number | undefined;
    let to: number | undefined;
    try {
      from = parseTime("from", c.req.query("from"), "start", true);
      to = parseTime("to", c.req.query("to"), "end", true);
      if (from !== undefined && to !== undefined && from > to) throw new ParamError("from must not be after to.");
    } catch (error) {
      if (error instanceof ParamError) return c.json(errorBody(error.message, "bad_request"), 400);
      throw error;
    }
    const at = fetchedAt();
    if (at === null) return c.json(notReady(), 503);
    const symbol = c.req.query("symbol")?.trim().toUpperCase();
    const changes = loadRenames(hub.db).changes.filter(
      (change) => (from === undefined || change.day >= from) && (to === undefined || change.day <= to) && (!symbol || change.oldSymbol === symbol || change.newSymbol === symbol),
    );
    return c.json({ from: from === undefined ? null : isoDay(from), to: to === undefined ? null : isoDay(to), fetchedAt: at, count: changes.length, changes: changes.map(changeBody) });
  });

  app.get("/v1/symbols/archive", requireScope("history"), (c) => {
    let from: number | undefined;
    let to: number | undefined;
    const series = c.req.query("series")?.trim().toUpperCase() || null;
    const after = c.req.query("after")?.trim().toUpperCase() || null;
    const limitRaw = c.req.query("limit");
    const limit = limitRaw === undefined ? ARCHIVE_PAGE.default : Number(limitRaw);
    try {
      from = parseTime("from", c.req.query("from"), "start", true);
      to = parseTime("to", c.req.query("to"), "end", true);
      if (from !== undefined && to !== undefined && from > to) throw new ParamError("from must not be after to.");
      if (series !== null && series !== "EQ" && series !== "BE") throw new ParamError("series must be EQ or BE (the cash bhavcopy's equity series the hub stores).");
      if (after !== null && !TICKER.test(after)) throw new ParamError("after must be a ticker: the last one of the previous page.");
      if (!Number.isInteger(limit) || limit < 1 || limit > ARCHIVE_PAGE.max) throw new ParamError(`limit must be a whole number from 1 to ${ARCHIVE_PAGE.max}.`);
    } catch (error) {
      if (error instanceof ParamError) return c.json(errorBody(error.message, "bad_request"), 400);
      throw error;
    }
    const all = archiveSymbols(hub.db, from ?? Number.MIN_SAFE_INTEGER, to ?? Number.MAX_SAFE_INTEGER);
    // Days imported from Tradex carry "EQ/BE" (series unknown): they count for either.
    const matching = series ? all.filter((row) => row.series.includes(series) || row.series.includes(IMPORTED_SERIES)) : all;
    // Tickers are sorted by code point (SQLite's order): the page starts after `after`.
    let start = 0;
    if (after !== null) {
      let hi = matching.length;
      while (start < hi) {
        const mid = (start + hi) >> 1;
        if (matching[mid].symbol <= after) start = mid + 1;
        else hi = mid;
      }
    }
    const page = matching.slice(start, start + limit);
    const more = start + limit < matching.length;
    return c.json({
      from: from === undefined ? null : isoDay(from),
      to: to === undefined ? null : isoDay(to),
      series,
      count: matching.length,
      returned: page.length,
      next: more ? page[page.length - 1].symbol : null,
      renamesFetchedAt: fetchedAt(),
      symbols: page.map((row) => ({
        symbol: row.symbol,
        first: isoDay(row.first),
        last: isoDay(row.last),
        sessions: row.sessions,
        series: row.series,
        listing: row.listing ? { current: row.listing.current, names: row.listing.names.map(nameBody) } : null,
      })),
    });
  });
}
