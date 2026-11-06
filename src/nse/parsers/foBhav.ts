// NSE F&O bhavcopy, UDiFF format (BhavCopy_NSE_FO_0_0_0_YYYYMMDD_F_0000.csv,
// published zipped every evening) → one record per stock-futures underlying.
// Pure: no I/O. The download lives in src/nse/datasets.ts. (Ported from Tradex, MIT.)
//
// The file has one row per contract (futures and options on indices and
// stocks). Only stock futures (FinInstrmTp = STF) are read. Per underlying we
// keep the near and next month (close, settlement, volume, OI, change in OI)
// and the COMBINED open interest across every listed month. Its daily change is
// the sum of each contract's own change in OI, not today's total minus
// yesterday's: on the day after an expiry the expired month simply isn't in the
// file any more, and a naive difference would show its whole OI as "unwinding"
// when most of it was rolled into the next month days earlier.
//
// Columns are found by header name (NSE has reordered files before). Every
// field used is validated; a malformed row is skipped and counted, never
// guessed at. The file's own trade date is returned so the caller can reject a
// file served for the wrong day (seen on NSE's cash archive around holidays).

import { parseIsoDay as isoDayKey } from "../../time.js";

/** Tickers NSE renamed (or replaced after a demerger) during the stored period: old → new. Price history lives under the new one. */
export const FO_RENAMES: Readonly<Record<string, string>> = {
  LTIM: "LTM",
  ICICIPRULI: "ICICILIFE",
  TATAMOTORS: "TMPV",
};

export interface FoContract {
  symbol: string;
  /** Expiry as a day key (UTC midnight of the date). */
  expiry: number;
  close: number;
  settle: number;
  prevClose: number;
  /** Contracts traded (UDiFF TtlTradgVol is in contracts, not shares). */
  volume: number;
  /** Open interest in shares. */
  oi: number;
  chgOi: number;
  underlying: number | null;
  lot: number | null;
}

export interface FoLeg {
  expiry: number;
  close: number;
  settle: number;
  prevClose: number;
  volume: number;
  oi: number;
  chgOi: number;
}

/** One underlying's stock futures on one trade day. */
export interface FoDayRecord {
  day: number;
  /** App ticker (after FO_RENAMES). */
  symbol: string;
  /** Ticker as written in the file. */
  nseSymbol: string;
  /** Listed months with a row in the file (usually 3). */
  expiries: number;
  lot: number | null;
  underlying: number | null;
  near: FoLeg;
  next: FoLeg | null;
  /** Open interest summed over every listed month (shares). */
  oi: number;
  /** Sum of each month's change in OI (shares). */
  chgOi: number;
}

export interface FoParseResult {
  /** Trade date written in the file (day key), null when no valid row had one. */
  tradeDate: number | null;
  /** More than one trade date in the file: don't trust it. */
  mixedDates: boolean;
  contracts: FoContract[];
  /** Stock-futures rows that couldn't be read. */
  badRows: number;
}

const SYMBOL_RE = /^[A-Z0-9&_.-]{1,20}$/;
const REQUIRED = ["TradDt", "FinInstrmTp", "TckrSymb", "XpryDt", "ClsPric", "SttlmPric", "PrvsClsgPric", "OpnIntrst", "ChngInOpnIntrst", "TtlTradgVol"] as const;

function num(value: string | undefined): number | null {
  const text = (value ?? "").trim();
  if (text === "" || text === "-") return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

export function parseFoBhav(csv: string): FoParseResult {
  const lines = csv.split(/\r?\n/);
  const header = (lines[0] ?? "").replace(/^\uFEFF/, "").split(",").map((cell) => cell.trim());
  const col = new Map(header.map((name, index) => [name, index]));
  if (!REQUIRED.every((name) => col.has(name))) return { tradeDate: null, mixedDates: false, contracts: [], badRows: 0 };
  const at = (cells: string[], name: string) => cells[col.get(name) ?? -1];

  const contracts: FoContract[] = [];
  const dates = new Set<number>();
  let badRows = 0;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) continue;
    const cells = line.split(",");
    if (at(cells, "FinInstrmTp")?.trim() !== "STF") continue;
    const symbol = (at(cells, "TckrSymb") ?? "").trim().toUpperCase();
    const day = isoDayKey(at(cells, "TradDt") ?? "");
    const expiry = isoDayKey(at(cells, "XpryDt") ?? "");
    const close = num(at(cells, "ClsPric"));
    const settle = num(at(cells, "SttlmPric"));
    const prevClose = num(at(cells, "PrvsClsgPric"));
    const oi = num(at(cells, "OpnIntrst"));
    const chgOi = num(at(cells, "ChngInOpnIntrst"));
    const volume = num(at(cells, "TtlTradgVol"));
    if (!SYMBOL_RE.test(symbol) || day === null || expiry === null || close === null || settle === null || prevClose === null || oi === null || chgOi === null || volume === null || oi < 0 || volume < 0) {
      badRows += 1;
      continue;
    }
    dates.add(day);
    contracts.push({ symbol, expiry, close, settle, prevClose, volume, oi, chgOi, underlying: num(at(cells, "UndrlygPric")), lot: num(at(cells, "NewBrdLotQty")) });
  }
  const sorted = [...dates].sort((a, b) => a - b);
  return { tradeDate: sorted.length === 1 ? sorted[0] : (sorted.at(-1) ?? null), mixedDates: sorted.length > 1, contracts, badRows };
}

const leg = (contract: FoContract): FoLeg => ({
  expiry: contract.expiry,
  close: contract.close,
  settle: contract.settle,
  prevClose: contract.prevClose,
  volume: contract.volume,
  oi: contract.oi,
  chgOi: contract.chgOi,
});

/**
 * Per-underlying records for one trade day. Contracts already past expiry are
 * ignored; renamed tickers are filed under their new name (when a file lists
 * both, the new ticker's own rows win).
 */
export function aggregateStockFutures(contracts: FoContract[], day: number, renames: Readonly<Record<string, string>> = FO_RENAMES): FoDayRecord[] {
  const bySymbol = new Map<string, FoContract[]>();
  for (const contract of contracts) {
    if (contract.expiry < day) continue;
    const list = bySymbol.get(contract.symbol) ?? [];
    list.push(contract);
    bySymbol.set(contract.symbol, list);
  }
  const out = new Map<string, FoDayRecord>();
  for (const [nseSymbol, list] of bySymbol) {
    const symbol = renames[nseSymbol] ?? nseSymbol;
    if (symbol !== nseSymbol && bySymbol.has(symbol)) continue;
    const months = [...list].sort((a, b) => a.expiry - b.expiry);
    const near = months[0];
    out.set(symbol, {
      day,
      symbol,
      nseSymbol,
      expiries: months.length,
      lot: near.lot,
      underlying: near.underlying,
      near: leg(near),
      next: months[1] ? leg(months[1]) : null,
      oi: months.reduce((sum, month) => sum + month.oi, 0),
      chgOi: months.reduce((sum, month) => sum + month.chgOi, 0),
    });
  }
  return [...out.values()].sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
}
