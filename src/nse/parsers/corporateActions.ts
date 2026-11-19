import { parseNseDay } from "../../time.js";
import { splitCsvLine } from "./symbolChange.js";

// NSE's corporate-actions file → bonus, split, rights, dividend… with ex-dates.
// Pure: no I/O. The file is bcDDMMYYYY.csv (BcDDMMYY.csv in older zips) inside
// the daily PR zip (src/nse/datasets.ts), since 2010. Each day's file lists the
// actions NSE knows about whose ex-date is near (a few days either side), so the
// calendar is the union of the days' files. The layout hasn't changed, only the
// date format:
//
//   SERIES,SYMBOL,SECURITY,RECORD_DT,BC_STRT_DT,BC_END_DT,EX_DT,ND_STRT_DT,ND_END_DT,PURPOSE
//   EQ,HAVELLS,Havells India Limited,11/10/2010, , ,08/10/2010, , ,BONUS 1:1
//   EQ,VGL,VARVEE GLOBAL LIMITED,2026-11-27,,,2026-11-27,,,FV SPLT FRM RS 5 TO RS 2
//
// Only the cash market's equity rows (EQ, BE — what cash_bhav holds) are kept;
// bonds, T-bills, SME and the like are skipped. NSE lists an action once per
// series, so rows are de-duplicated by (symbol, ex-date, purpose).
//
// PURPOSE is free text, written differently over the years. `classifyPurpose`
// reads what matters for prices out of it:
//   BONUS a:b            a new shares for every b held: prices × b/(a+b)
//   FV SPLIT RS x TO RS y (SPLT, SUB-DIVISION…): prices × y/x
//   CONSOLIDATION x TO y prices × y/x (y > x)
//   RIGHTS a:b [@ PRM P] a rights issue: its factor depends on the price the
//                        day before (rightsTerms; src/history/adjustments.ts)
//   DEMERGER / SCHEME OF ARRANGEMENT, DIVIDEND, MERGER, BUY BACK, …: classified only

export type ActionKind = "bonus" | "split" | "consolidation" | "rights" | "demerger" | "arrangement" | "dividend" | "merger" | "buyback" | "capital_reduction" | "other";

export interface CorporateActionRow {
  symbol: string;
  series: string;
  company: string;
  /** Ex-date (day key): the first session the price trades without the entitlement. */
  exDay: number;
  recordDay: number | null;
  purpose: string;
}

export interface CorporateActionsParse {
  rows: CorporateActionRow[];
  /** Equity rows whose ex-date couldn't be read. */
  badRows: number;
  /** Equity rows without an ex-date (a merger, say): nothing to adjust on a day. */
  undated: number;
}

export interface Classified {
  kinds: ActionKind[];
  /**
   * What the action does to the price (prices before the ex-date are multiplied
   * by it): bonus, split and consolidation only, multiplied together when one
   * purpose has more than one; null for everything else.
   */
  ratio: number | null;
}

const EQUITY_SERIES = new Set(["EQ", "BE"]);

/** "PR181126.zip"'s "bc18112026.csv" (or the older "Bc011010.csv") → the day it's for, or null. */
export function corporateActionsFileDay(name: string): number | null {
  const match = name.match(/^bc(\d{2})(\d{2})(\d{4}|\d{2})\.csv$/i);
  if (!match) return null;
  const year = match[3].length === 2 ? 2000 + Number(match[3]) : Number(match[3]);
  const day = Date.UTC(year, Number(match[2]) - 1, Number(match[1]));
  return new Date(day).getUTCDate() === Number(match[1]) ? day : null;
}

/** "26/10/2010", "2026-11-23" or "22-OCT-2010" → day key; blank → null. */
export function parseBcDate(value: string | undefined): number | null {
  const text = (value ?? "").trim();
  if (!text) return null;
  const dmy = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (dmy) {
    const day = Date.UTC(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1]));
    return new Date(day).getUTCDate() === Number(dmy[1]) ? day : null;
  }
  return parseNseDay(text);
}

export function parseCorporateActions(csv: string): CorporateActionsParse {
  const lines = csv.split(/\r?\n/);
  const header = splitCsvLine((lines[0] ?? "").replace(/^\uFEFF/, "")).map((cell) => cell.trim().toUpperCase());
  const col = (name: string) => header.indexOf(name);
  const c = { series: col("SERIES"), symbol: col("SYMBOL"), company: col("SECURITY"), record: col("RECORD_DT"), ex: col("EX_DT"), purpose: col("PURPOSE") };
  if (c.series < 0 || c.symbol < 0 || c.ex < 0 || c.purpose < 0) return { rows: [], badRows: 0, undated: 0 };
  const rows: CorporateActionRow[] = [];
  const seen = new Set<string>();
  let badRows = 0;
  let undated = 0;
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const cells = splitCsvLine(line);
    const series = (cells[c.series] ?? "").trim().toUpperCase();
    if (!EQUITY_SERIES.has(series)) continue;
    const symbol = (cells[c.symbol] ?? "").trim().toUpperCase();
    // A purpose with a comma in it is split across cells: join the tail back.
    const purpose = cells.slice(c.purpose).join(",").replace(/\s+/g, " ").trim();
    const exDay = parseBcDate(cells[c.ex]);
    if (!symbol || !purpose) continue;
    if (!(cells[c.ex] ?? "").trim()) {
      undated += 1;
      continue;
    }
    if (exDay === null) {
      badRows += 1;
      continue;
    }
    const key = `${symbol}|${exDay}|${purpose.toUpperCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ symbol, series, company: (cells[c.company] ?? "").trim(), exDay, recordDay: c.record >= 0 ? parseBcDate(cells[c.record]) : null, purpose });
  }
  return { rows, badRows, undated };
}

const NUMBER = String.raw`(\d+(?:\.\d+)?)`;
// "RS.10", "RS 10/-", "RE.1", "RS10", "RS. 2/-" … "TO" … the same. FROM is optional ("FV SPLIT RS.10 TO RE.1").
const FACE_VALUES = new RegExp(String.raw`R[SE]\.?\s*${NUMBER}\s*(?:\/-)?\s*(?:PER\s+SHARE\s*|EACH\s*)?(?:\/-\s*)?TO\s+R[SE]\.?\s*${NUMBER}`, "i");

function faceValues(text: string): { from: number; to: number } | null {
  const match = text.match(FACE_VALUES);
  if (!match) return null;
  const from = Number(match[1]);
  const to = Number(match[2]);
  return from > 0 && to > 0 && from !== to ? { from, to } : null;
}

export interface RightsTerms {
  /** `offered` new shares for every `held`, at `price` (rupees; null when the purpose doesn't say). */
  offered: number;
  held: number;
  price: number | null;
}

/**
 * A rights issue's terms: "RIGHTS 3:25@PRM RS 1799", "RGHTS 2:7 @PRM RS 3496/-",
 * "RIGHTS 1:5 @ PREMIUM RS 100/-", "RIGHTS 5:9". A premium is taken for the
 * price: the face value it leaves out (₹1–10) is small next to it. Pure.
 */
export function rightsTerms(purpose: string): RightsTerms | null {
  const match = purpose.toUpperCase().match(/\bRI?GH?TS?\b\s*(\d+)\s*:\s*(\d+)(?:\s*(?:@|AT)\s*(?:PRM|PREM(?:IUM)?)?\.?\s*(?:OF\s*)?R[SE]\.?\s*(\d+(?:\.\d+)?))?/);
  if (!match) return null;
  const [offered, held] = [Number(match[1]), Number(match[2])];
  if (!(offered > 0) || !(held > 0)) return null;
  return { offered, held, price: match[3] === undefined ? null : Number(match[3]) };
}

/** What a PURPOSE says, for prices. Pure. */
export function classifyPurpose(purpose: string): Classified {
  const text = purpose.toUpperCase();
  const kinds = new Set<ActionKind>();
  let ratio: number | null = null;
  const times = (value: number) => {
    ratio = (ratio ?? 1) * value;
  };

  const bonus = text.match(/\bBON(?:US)?\b[^0-9]{0,12}(\d+)\s*:\s*(\d+)/);
  if (bonus) {
    const [a, b] = [Number(bonus[1]), Number(bonus[2])];
    if (a > 0 && b > 0) {
      kinds.add("bonus");
      times(b / (a + b));
    }
  } else if (/\bBON(?:US)?\b/.test(text)) kinds.add("bonus");

  const values = faceValues(text);
  if (/CONSOLIDAT|\bCONSL?\b/.test(text)) {
    kinds.add("consolidation");
    if (values && values.to > values.from) times(values.to / values.from);
  } else if (/SPLIT|SPLT|SUB-?\s?DIVI/.test(text) || (/\bF\.?V\b|FACE VALUE/.test(text) && values && values.to < values.from)) {
    kinds.add("split");
    if (values && values.to < values.from) times(values.to / values.from);
  }

  if (/\bRI?GH?TS?\b/.test(text)) kinds.add("rights");
  if (/DE-?MERGER|SPIN.?OFF/.test(text)) kinds.add("demerger");
  else if (/ARRANGEMENT|ARRGMT|\bARR\b/.test(text)) kinds.add("arrangement");
  if (/AMALGAMATION|(?<!DE-?)MERGER/.test(text)) kinds.add("merger");
  if (/DIV(?!ISI)/.test(text)) kinds.add("dividend");
  if (/BUY\s?-?BACK/.test(text)) kinds.add("buyback");
  if (/CAPITAL REDUCTION|REDUCTION OF CAPITAL/.test(text)) kinds.add("capital_reduction");
  if (!kinds.size) kinds.add("other");
  return { kinds: [...kinds], ratio };
}
