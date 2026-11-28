// The option rows (and the futures they're priced against) of NSE's F&O
// bhavcopy, in both of its formats. Pure: no I/O. src/nse/parsers/foBhav.ts
// reads the same files for stock futures only; this reads what it skips.
//
//   old  foDDMONYYYYbhav.csv (first F&O session → 5 Jul 2024)
//        INSTRUMENT OPTIDX/OPTSTK (FUTIDX/FUTSTK), OPTION_TYP CE/PE — or CA/PA,
//        American-style stock options, until NSE moved them to European style
//        in 2010–11. VAL_INLAKH is notional turnover in ₹ lakh,
//        (strike + premium) × shares; OPEN_INT and CHG_IN_OI are in shares,
//        CONTRACTS in contracts. No lot, no underlying price.
//   new  BhavCopy_NSE_FO_0_0_0_YYYYMMDD_F_0000.csv (UDiFF, 8 Jul 2024 →)
//        FinInstrmTp IDO/STO (IDF/STF), OptnTp CE/PE, TtlTradgVol in contracts,
//        TtlTrfVal notional turnover in ₹, NewBrdLotQty the lot, UndrlygPric the
//        underlying's price, FininstrmActlXpryDt the expiry after holiday moves.
//
// Prices kept: the settlement price (SETTLE_PR / SttlmPric) and the close. For a
// contract that didn't trade NSE's close is the last one it had (possibly weeks
// old) and its settlement price a theoretical one NSE computes, so the
// summaries only read implied volatility from contracts that traded.
// Malformed rows are skipped and counted, never guessed at.

import { parseDmyDay, parseIsoDay } from "../../time.js";
import { FO_RENAMES } from "./foBhav.js";

export type OptionKind = "index" | "stock";

export interface FoOptionRow {
  kind: OptionKind;
  /** Ticker as written in the file. */
  nseSymbol: string;
  expiry: number;
  strike: number;
  type: "C" | "P";
  /** CA/PA in the old format: American-style. */
  american: boolean;
  close: number;
  settle: number;
  /** Contracts traded. */
  volume: number;
  /** Open interest and its change, in shares. */
  oi: number;
  chgOi: number;
  /** Notional turnover in ₹ ((strike + premium) × shares), null when the file has none. */
  turnover: number | null;
  /** The underlying's price (new format only). */
  underlying: number | null;
  /** Lot (new format only). */
  lot: number | null;
}

export interface FoFutureRow {
  kind: OptionKind;
  nseSymbol: string;
  expiry: number;
  settle: number;
  volume: number;
  turnover: number | null;
}

export interface FoOptionsParse {
  tradeDate: number | null;
  mixedDates: boolean;
  options: FoOptionRow[];
  futures: FoFutureRow[];
  /** Option and futures rows that couldn't be read. */
  badRows: number;
}

/**
 * Index tickers NSE's F&O files used before the index was renamed, mapped to the
 * hub's index symbol (src/reference/indices.ts). Stock tickers follow FO_RENAMES.
 */
export const INDEX_FO_RENAMES: Readonly<Record<string, string>> = {
  CNXIT: "NIFTYIT",
  NFTYMCAP50: "NIFTYMIDCAP50",
  CNXINFRA: "NIFTYINFRA",
};

/** The hub symbol an F&O ticker's summaries are filed under. */
export const optionSymbol = (kind: OptionKind, nseSymbol: string) => (kind === "index" ? (INDEX_FO_RENAMES[nseSymbol] ?? nseSymbol) : (FO_RENAMES[nseSymbol] ?? nseSymbol));

const SYMBOL_RE = /^[A-Z0-9&_.-]{1,20}$/;

function num(value: string | undefined): number | null {
  const text = (value ?? "").trim();
  if (text === "" || text === "-") return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

const NEW_REQUIRED = ["TradDt", "FinInstrmTp", "TckrSymb", "XpryDt", "StrkPric", "OptnTp", "ClsPric", "SttlmPric", "OpnIntrst", "ChngInOpnIntrst", "TtlTradgVol"] as const;
const OLD_REQUIRED = ["INSTRUMENT", "SYMBOL", "EXPIRY_DT", "STRIKE_PR", "OPTION_TYP", "CLOSE", "SETTLE_PR", "CONTRACTS", "OPEN_INT", "CHG_IN_OI", "TIMESTAMP"] as const;

type Instrument = { kind: OptionKind; option: boolean };
const NEW_INSTRUMENTS: Readonly<Record<string, Instrument>> = { IDO: { kind: "index", option: true }, STO: { kind: "stock", option: true }, IDF: { kind: "index", option: false }, STF: { kind: "stock", option: false } };
const OLD_INSTRUMENTS: Readonly<Record<string, Instrument>> = { OPTIDX: { kind: "index", option: true }, OPTSTK: { kind: "stock", option: true }, FUTIDX: { kind: "index", option: false }, FUTSTK: { kind: "stock", option: false } };

interface Format {
  required: readonly string[];
  upper: boolean;
  /** kind and instrument from the instrument column, or null for rows not read. */
  instrument: (value: string) => Instrument | null;
  day: (value: string) => number | null;
  col: { instrument: string; symbol: string; tradeDate: string; expiry: string; actualExpiry?: string; strike: string; type: string; close: string; settle: string; volume: string; oi: string; chgOi: string; turnover: string; underlying?: string; lot?: string };
  turnoverScale: number;
}

const NEW_FORMAT: Format = {
  required: NEW_REQUIRED,
  upper: false,
  instrument: (value) => NEW_INSTRUMENTS[value] ?? null,
  day: parseIsoDay,
  col: { instrument: "FinInstrmTp", symbol: "TckrSymb", tradeDate: "TradDt", expiry: "XpryDt", actualExpiry: "FininstrmActlXpryDt", strike: "StrkPric", type: "OptnTp", close: "ClsPric", settle: "SttlmPric", volume: "TtlTradgVol", oi: "OpnIntrst", chgOi: "ChngInOpnIntrst", turnover: "TtlTrfVal", underlying: "UndrlygPric", lot: "NewBrdLotQty" },
  turnoverScale: 1,
};

const OLD_FORMAT: Format = {
  required: OLD_REQUIRED,
  upper: true,
  instrument: (value) => OLD_INSTRUMENTS[value.toUpperCase()] ?? null,
  day: parseDmyDay,
  col: { instrument: "INSTRUMENT", symbol: "SYMBOL", tradeDate: "TIMESTAMP", expiry: "EXPIRY_DT", strike: "STRIKE_PR", type: "OPTION_TYP", close: "CLOSE", settle: "SETTLE_PR", volume: "CONTRACTS", oi: "OPEN_INT", chgOi: "CHG_IN_OI", turnover: "VAL_INLAKH" },
  turnoverScale: 100_000,
};

const OPTION_TYPES: Record<string, { type: "C" | "P"; american: boolean }> = { CE: { type: "C", american: false }, PE: { type: "P", american: false }, CA: { type: "C", american: true }, PA: { type: "P", american: true } };

function parseWith(csv: string, format: Format): FoOptionsParse {
  const lines = csv.split(/\r?\n/);
  const header = (lines[0] ?? "").replace(/^\uFEFF/, "").split(",").map((cell) => (format.upper ? cell.trim().toUpperCase() : cell.trim()));
  const col = new Map(header.map((name, index) => [name, index]));
  const empty: FoOptionsParse = { tradeDate: null, mixedDates: false, options: [], futures: [], badRows: 0 };
  if (!format.required.every((name) => col.has(name))) return empty;
  const index = (name: string | undefined) => (name === undefined ? -1 : (col.get(name) ?? -1));
  const c = Object.fromEntries(Object.entries(format.col).map(([key, name]) => [key, index(name)])) as Record<keyof Format["col"], number>;

  const options: FoOptionRow[] = [];
  const futures: FoFutureRow[] = [];
  const dates = new Set<number>();
  let badRows = 0;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) continue;
    const cells = line.split(",");
    const instrument = format.instrument((cells[c.instrument] ?? "").trim());
    if (!instrument) continue;
    const nseSymbol = (cells[c.symbol] ?? "").trim().toUpperCase();
    const day = format.day((cells[c.tradeDate] ?? "").trim());
    const listed = format.day((cells[c.expiry] ?? "").trim());
    const actual = c.actualExpiry >= 0 ? format.day((cells[c.actualExpiry] ?? "").trim()) : null;
    const expiry = actual ?? listed;
    const settle = num(cells[c.settle]);
    const volume = num(cells[c.volume]);
    const turnoverRaw = c.turnover >= 0 ? num(cells[c.turnover]) : null;
    const turnover = turnoverRaw === null ? null : turnoverRaw * format.turnoverScale;
    if (!SYMBOL_RE.test(nseSymbol) || day === null || expiry === null || settle === null || volume === null || settle < 0 || volume < 0) {
      badRows += 1;
      continue;
    }
    dates.add(day);
    if (!instrument.option) {
      futures.push({ kind: instrument.kind, nseSymbol, expiry, settle, volume, turnover });
      continue;
    }
    const strike = num(cells[c.strike]);
    const type = OPTION_TYPES[(cells[c.type] ?? "").trim().toUpperCase()];
    const close = num(cells[c.close]);
    const oi = num(cells[c.oi]);
    const chgOi = num(cells[c.chgOi]);
    if (strike === null || strike <= 0 || !type || close === null || oi === null || chgOi === null || oi < 0) {
      badRows += 1;
      continue;
    }
    const lot = c.lot >= 0 ? num(cells[c.lot]) : null;
    const underlying = c.underlying >= 0 ? num(cells[c.underlying]) : null;
    options.push({
      kind: instrument.kind,
      nseSymbol,
      expiry,
      strike,
      type: type.type,
      american: type.american,
      close,
      settle,
      volume,
      oi,
      chgOi,
      turnover,
      underlying: underlying !== null && underlying > 0 ? underlying : null,
      lot: lot !== null && lot > 0 ? lot : null,
    });
  }
  const sorted = [...dates].sort((a, b) => a - b);
  return { tradeDate: sorted.at(-1) ?? null, mixedDates: sorted.length > 1, options, futures, badRows };
}

/** The current (UDiFF) format, from 8 Jul 2024. */
export const parseFoOptions = (csv: string) => parseWith(csv, NEW_FORMAT);

/** The old format, up to 5 Jul 2024. */
export const parseFoOptionsLegacy = (csv: string) => parseWith(csv, OLD_FORMAT);
