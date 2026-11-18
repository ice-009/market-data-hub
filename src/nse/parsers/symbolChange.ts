import { parseDmyDay } from "../../time.js";

// NSE's list of ticker changes (content/equities/symbolchange.csv on the
// archive), every rename since 1999:
//   NAME OF THE COMPANY,OLD SYMBOL,NEW SYMBOL,EFFECTIVE DATE
//   Infosys Limited,INFOSYSTCH,INFY,29-JUN-2011
// The effective date is the first session under the new ticker (INFOSYSTCH's
// last bhavcopy row is 28 Jun 2011, INFY's first 29 Jun). Columns are found by
// header name; a quoted company name may hold commas. The file also lists ETFs,
// bonds and gold bonds, and a few rows whose old and new ticker are the same:
// those are skipped. Pure.

export interface SymbolChangeRow {
  oldSymbol: string;
  newSymbol: string;
  /** Effective date (day key): the first session under newSymbol. */
  day: number;
  company: string;
}

export interface SymbolChangeParse {
  rows: SymbolChangeRow[];
  /** Rows that couldn't be read (a bad ticker or date). */
  badRows: number;
  /** Rows naming the same ticker twice, or repeating an earlier (old ticker, date). */
  skipped: number;
}

// As in the old cash bhavcopy: old tickers include a few characters today's don't.
const SYMBOL_RE = /^[A-Z0-9&_+.-]{1,20}$/;

/** One CSV line → cells, with "quoted, fields" and "" escapes. */
export function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      cells.push(cell);
      cell = "";
    } else cell += ch;
  }
  cells.push(cell);
  return cells;
}

export function parseSymbolChanges(csv: string): SymbolChangeParse {
  const lines = csv.split(/\r?\n/);
  const header = splitCsvLine((lines[0] ?? "").replace(/^\uFEFF/, "")).map((cell) => cell.trim().toUpperCase());
  const col = { company: header.indexOf("NAME OF THE COMPANY"), old: header.indexOf("OLD SYMBOL"), new: header.indexOf("NEW SYMBOL"), date: header.indexOf("EFFECTIVE DATE") };
  if (col.old < 0 || col.new < 0 || col.date < 0) return { rows: [], badRows: 0, skipped: 0 };

  const rows: SymbolChangeRow[] = [];
  const seen = new Set<string>();
  let badRows = 0;
  let skipped = 0;
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const cells = splitCsvLine(line);
    const oldSymbol = (cells[col.old] ?? "").trim().toUpperCase();
    const newSymbol = (cells[col.new] ?? "").trim().toUpperCase();
    const day = parseDmyDay(cells[col.date] ?? "");
    if (!SYMBOL_RE.test(oldSymbol) || !SYMBOL_RE.test(newSymbol) || day === null) {
      badRows += 1;
      continue;
    }
    const key = `${oldSymbol}|${day}`;
    if (oldSymbol === newSymbol || seen.has(key)) {
      skipped += 1;
      continue;
    }
    seen.add(key);
    rows.push({ oldSymbol, newSymbol, day, company: col.company >= 0 ? (cells[col.company] ?? "").trim().replace(/\s+/g, " ") : "" });
  }
  rows.sort((a, b) => a.day - b.day || (a.oldSymbol < b.oldSymbol ? -1 : 1));
  return { rows, badRows, skipped };
}
