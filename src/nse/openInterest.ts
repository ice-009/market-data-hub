// Open-interest reading of a stock's futures for one session, from the NSE F&O
// bhavcopy (src/core/parsers/foBhavcopy.ts). Pure.
//
// The usual "buildup" labels cross the sign of the price change with the sign
// of the change in open interest:
//
//                  OI up            OI down
//   price up       Long buildup     Short covering
//   price down     Short buildup    Long unwinding
//
// Price change is the near-month future's close vs its own previous close (same
// contract, so an expiry roll can't fake a move). OI change is the combined
// change across all listed months (sum of each month's change, so a rollover
// isn't read as unwinding).
//
// INFORMATION ONLY. Tested over Oct 2025 – Nov 2026 on every F&O stock, none of
// the four classes (nor the futures basis) gave a tradeable edge after costs,
// either overnight or close to close (Tradex's research). The hub serves it as
// a fact, not a signal. (Ported from Tradex, MIT.)

import type { FoDayRecord } from "./parsers/foBhav.js";

export type OiBuildup = "long-buildup" | "short-buildup" | "short-covering" | "long-unwinding";

export const BUILDUP_LABEL: Record<OiBuildup, string> = {
  "long-buildup": "Long buildup",
  "short-buildup": "Short buildup",
  "short-covering": "Short covering",
  "long-unwinding": "Long unwinding",
};

/** The buildup class from the two signs; null when either is flat (or not a number). */
export function oiBuildup(priceChange: number, oiChange: number): OiBuildup | null {
  if (!Number.isFinite(priceChange) || !Number.isFinite(oiChange) || priceChange === 0 || oiChange === 0) return null;
  if (priceChange > 0) return oiChange > 0 ? "long-buildup" : "short-covering";
  return oiChange > 0 ? "short-buildup" : "long-unwinding";
}

/** Combined OI change as % of the previous session's combined OI (null when there was none). */
export function combinedOiChangePct(record: Pick<FoDayRecord, "oi" | "chgOi">): number | null {
  const previous = record.oi - record.chgOi;
  return previous > 0 ? (record.chgOi / previous) * 100 : null;
}

/** One F&O stock's futures reading for one session. */
export interface OiFact {
  /** Session of the F&O data (day key). */
  day: number;
  buildup: OiBuildup | null;
  /** Near-month future's % change on that session. */
  pricePct: number;
  /** Combined OI change %, null when there was no previous OI. */
  oiPct: number | null;
  /** Combined OI and its change, in shares. */
  oi: number;
  chgOi: number;
  /** Near-month future's premium (+) or discount (−) to the underlying, %. */
  basisPct: number | null;
}

export function oiFact(record: FoDayRecord): OiFact {
  const { near } = record;
  return {
    day: record.day,
    buildup: oiBuildup(near.close - near.prevClose, record.chgOi),
    pricePct: near.prevClose > 0 ? (near.close / near.prevClose - 1) * 100 : 0,
    oiPct: combinedOiChangePct(record),
    oi: record.oi,
    chgOi: record.chgOi,
    basisPct: record.underlying && record.underlying > 0 ? (near.close / record.underlying - 1) * 100 : null,
  };
}
