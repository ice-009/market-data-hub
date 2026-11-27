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
//                        (BON, BONS, glued or not: "BONUS1:1", "BON-2:1")
//   FV SPLIT RS x TO RS y (SPLT, SPTL, SUB DIV, SUB-DIVISION…; or "FV SPL",
//                        "SPL RS10 TO RS2" when face values go down): prices × y/x
//   CONSOLIDATION x TO y prices × y/x (y > x)
//   Several at once multiply: "BON 1:1/SPLIT RS.10TORS.2" → 0.5 × 0.2. One
//   named without its terms ("AGM/DIV-RS 29.50/BONUS", or cut off by NSE's
//   25-character column: "FV SPLT FRM RS 10/- TO RS") is `partial`: the
//   factor then comes from the price gap (src/history/adjustments.ts).
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

/** One bonus, split or consolidation in a purpose, and what it does to the price (null: the purpose doesn't say). */
export interface PricePart {
  kind: "bonus" | "split" | "consolidation";
  ratio: number | null;
  /** A split's old face value, when the purpose gives it but not the new one ("FV SPLT FRM RS 10/- TO RS"). */
  from?: number;
}

export interface Classified {
  kinds: ActionKind[];
  /**
   * What the action does to the price (prices before the ex-date are multiplied
   * by it): bonus, split and consolidation only, multiplied together when one
   * purpose has more than one ("BON 1:1/SPLIT RS.10TORS.2" → 0.5 × 0.2); null
   * when it names none, or none with its terms.
   */
  ratio: number | null;
  /** The bonus, split and consolidation it names, each with its ratio. */
  parts: PricePart[];
  /**
   * It names a bonus, split or consolidation without its terms ("AGM/DIV-RS
   * 29.50/BONUS"; "FV SPLT FRM RS 10/- TO RS", cut off by NSE): the ratio is
   * then read from the price gap (src/history/adjustments.ts).
   */
  partial: boolean;
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
  const seen = new Map<string, number>();
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
    const row = { symbol, series, company: (cells[c.company] ?? "").trim(), exDay, recordDay: c.record >= 0 ? parseBcDate(cells[c.record]) : null, purpose };
    const earlier = seen.get(key);
    // Listed once per series: keep one row, the EQ one when there is one (its company name is NSE's usual spelling).
    if (earlier === undefined) {
      seen.set(key, rows.length);
      rows.push(row);
    } else if (series === "EQ") rows[earlier] = row;
  }
  return { rows, badRows, undated };
}

const NUMBER = String.raw`(\d+(?:\.\d+)?)`;
// Face values, "from TO to", right after a split or consolidation word. NSE
// writes them every way: "RS.10 TO RE.1", "RS 10/- TO RS 5", "RS.10TORS.2",
// "RS10 TO 2", "FRM 10 TO 1", "FRM100TO1", "RS 10/- PER SHARE TO RE 1/- PER
// SHARE". The target is optional: NSE cuts PURPOSE off at 25 characters, so
// "FV SPLT FRM RS 10/- TO RS" and "FV SPLT FRM RS 126.18 TO" have none.
const FACE_VALUES = new RegExp(
  String.raw`^[^0-9:]{0,24}?(?:R[SE]\.?\s*)?${NUMBER}\s*(?:\/-)?\s*(?:PER\s+SHARE\s*|EACH\s*|PER\s+SH\s*)?(?:\/-\s*)?TO\s*(?:R[SE]\.?\s*)?(?:${NUMBER})?`,
);

/** The face values after `from` in `text`; `to` null when NSE cut the purpose off before it. */
function faceValues(text: string, from: number): { from: number; to: number | null } | null {
  const match = text.slice(from).match(FACE_VALUES);
  if (!match) return null;
  const before = Number(match[1]);
  const after = match[2] === undefined ? null : Number(match[2]);
  if (!(before > 0)) return null;
  return { from: before, to: after !== null && after > 0 && after !== before ? after : null };
}

/** Words that name a split by themselves. */
const SPLIT_WORD = /SPLIT|SPLT|SPTL|SUB[-\s]?DIV(?!IDEND)/;
/**
 * Words that name a split only with face values going down after them: "FV",
 * "FACE VALUE", "FVS", and "SPL" — which is just as often a special dividend
 * ("SPL DIV", "DIV- FIN RS.3+SPL RS.7.50").
 */
const FACE_VALUE_WORD = /\bF\.?\s?V\b\.?|FACE\s*VALUE|\bFVS\b|\bSPL\b(?![\s-]*(?:INT|DI?V))/g;
const CONSOLIDATION_WORD = /CONSOLIDAT|\bCONSL?\b/;
/** "BONUS", "BON", "BONS", glued to what follows or not ("BONUS1:1", "BON1:1"), but not "BOND". */
const BONUS_WORD = /\bBON(?:US|S)?(?![A-Z])/;
const BONUS_TERMS = /\bBON(?:US|S)?(?![A-Z])[^0-9]{0,12}(\d+)\s*:\s*(\d+)/;

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
  const parts: PricePart[] = [];

  const bonus = text.match(BONUS_TERMS);
  const [a, b] = bonus ? [Number(bonus[1]), Number(bonus[2])] : [0, 0];
  // Bonus debentures, preference or DVR shares ("BON 1 DVR : 4 EQ SHARES") aren't more of the same shares: no price part.
  if (BONUS_WORD.test(text) && /DVR|DEBT|DEBEN|PREF/.test(text)) kinds.add("bonus");
  else if (a > 0 && b > 0) parts.push({ kind: "bonus", ratio: b / (a + b) });
  else if (BONUS_WORD.test(text)) parts.push({ kind: "bonus", ratio: null });

  const consolidation = CONSOLIDATION_WORD.exec(text);
  if (consolidation) {
    const values = faceValues(text, consolidation.index + consolidation[0].length);
    parts.push({ kind: "consolidation", ratio: values?.to && values.to > values.from ? values.to / values.from : null });
  } else {
    const word = SPLIT_WORD.exec(text);
    let split: PricePart | null = null;
    if (word) {
      const values = faceValues(text, word.index + word[0].length);
      split = { kind: "split", ratio: values?.to && values.to < values.from ? values.to / values.from : null, ...(values ? { from: values.from } : {}) };
    }
    // "FV SPL RS.5TORE.1", "BON 1:1/SPL RS10 TO RS2": face values going down after FV or SPL.
    if (!split?.ratio) {
      for (const match of text.matchAll(FACE_VALUE_WORD)) {
        const values = faceValues(text, match.index + match[0].length);
        if (values?.to && values.to < values.from) {
          split = { kind: "split", ratio: values.to / values.from };
          break;
        }
        // "FV SPLT FRM RS 10/- TO RS" is caught by SPLIT_WORD; an "FV … TO" cut off with no split word is too thin to call.
      }
    }
    if (split) parts.push(split);
  }
  for (const part of parts) kinds.add(part.kind);
  const known = parts.filter((part) => part.ratio !== null);
  const ratio = known.length ? known.reduce((product, part) => product * part.ratio!, 1) : null;

  if (/\bRI?GH?TS?\b/.test(text)) kinds.add("rights");
  if (/DE-?MERGER|SPIN.?OFF/.test(text)) kinds.add("demerger");
  else if (/ARRANGEMENT|ARRGMT|\bARR\b/.test(text)) kinds.add("arrangement");
  if (/AMALGAMATION|(?<!DE-?)MERGER/.test(text)) kinds.add("merger");
  if (/(?<!SUB[-\s]?)DIV(?!ISI)|\bDV\b/.test(text)) kinds.add("dividend");
  if (/BUY\s?-?BACK/.test(text)) kinds.add("buyback");
  if (/CAPITAL REDUCTION|REDUCTION OF CAPITAL/.test(text)) kinds.add("capital_reduction");
  if (!kinds.size) kinds.add("other");
  return { kinds: [...kinds], ratio, parts, partial: parts.some((part) => part.ratio === null) };
}
