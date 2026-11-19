import { INDEX_SYMBOLS } from "../broker/symbols.js";
import type { Db } from "../db.js";
import { BASE_LEVEL, basketMembers, MAX_MOVE, MIN_MEMBERS } from "../history/baskets.js";
import { readSeries } from "../history/store.js";
import { lastOkDay, storedDays, unmappedIndexNames } from "../nse/store.js";
import { DAY_MS, isoDay } from "../time.js";
import { BASKETS, NSE_INDICES, SECTORS } from "./indices.js";

// GET /v1/indices: every index and synthetic basket the hub serves daily
// candles for, with how far back each one's stored history reaches, and the
// NIFTY 500 industries mapped to their sector indices and baskets.

export const BASKET_METHOD =
  `Equal-weight average of today's members' daily moves (close / NSE's PREV_CLOSE − 1, so splits and bonuses don't show), ` +
  `chained from ${BASE_LEVEL} on the first session with at least ${MIN_MEMBERS} members priced; moves beyond ±${MAX_MOVE * 100}% are left out as bad data. ` +
  `Members are today's, so older history has survivorship bias: a stand-in where no NSE index history exists, not an NSE index.`;

function history(db: Db, symbol: string) {
  const meta = readSeries(db, symbol, "1d");
  return {
    firstSession: meta?.firstT == null ? null : isoDay(meta.firstT),
    lastSession: meta?.lastT == null ? null : isoDay(meta.lastT),
    sessions: meta?.count ?? 0,
    coverage: meta?.coverage ? { from: isoDay(meta.coverage.from), to: isoDay(meta.coverage.to - DAY_MS) } : null,
  };
}

export function indexCatalog(db: Db) {
  const file = storedDays(db, "index_close");
  const last = lastOkDay(db, "index_close");
  return {
    indices: NSE_INDICES.map((info) => ({ symbol: info.symbol, name: info.name, synthetic: false, source: "nse_index_file", intraday: info.symbol in INDEX_SYMBOLS, ...history(db, info.symbol) })),
    baskets: BASKETS.map((basket) => ({
      symbol: basket.symbol,
      name: basket.name,
      synthetic: true,
      source: "equal_weight_basket",
      universe: basket.universe,
      industry: basket.industry,
      standsFor: basket.standsFor,
      members: basketMembers(db, basket).length,
      ...history(db, basket.symbol),
    })),
    sectors: SECTORS.map((sector) => ({ industry: sector.industry, indices: sector.indices, basket: sector.basket })),
    basketMethod: BASKET_METHOD,
    indexFile: { firstSession: file.first === null ? null : isoDay(file.first), lastSession: last === null ? null : isoDay(last), sessions: file.sessions, unmappedNames: unmappedIndexNames(db) },
  };
}
