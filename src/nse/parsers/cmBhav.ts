import { parseDmyDay } from "../../time.js";
import type { CashBhavParse, CashBhavRow } from "./cashBhav.js";

// NSE's old cash bhavcopy (cmDDMONYYYYbhav.csv, zipped), the format of its
// archive from the first session (3 Nov 1994) through 5 Jul 2024:
//   SYMBOL,SERIES,OPEN,HIGH,LOW,CLOSE,LAST,PREVCLOSE,TOTTRDQTY,TOTTRDVAL,TIMESTAMP[,TOTALTRADES,ISIN],
// Read into the same rows as the current format (src/nse/parsers/cashBhav.ts),
// without delivery %: for these days it comes from a separate file (./mto.ts).
// The ISIN column appears in 2011 (absent in Jan 2010, present by Jun 2011);
// where it is there, each row carries its ISIN, which joins renamed tickers
// (src/reference/renames.ts).
// Prices are as traded, not adjusted for later splits or bonuses; PREVCLOSE is
// NSE's, which NSE adjusts on an ex-date. The oldest files have rows where the
// open lies outside the day's high–low range; they're kept as NSE printed them.
// Pure.

const REQUIRED = ["SYMBOL", "SERIES", "OPEN", "HIGH", "LOW", "CLOSE", "PREVCLOSE", "TOTTRDQTY", "TIMESTAMP"] as const;
// Old tickers include a few characters today's don't ("SRERAYHY+H" in 1996).
const SYMBOL_RE = /^[A-Z0-9&_+.-]{1,20}$/;
const ISIN_RE = /^IN[A-Z0-9]{10}$/;

export function parseCmBhav(csv: string): CashBhavParse {
  const lines = csv.split(/\r?\n/);
  const header = (lines[0] ?? "").replace(/^\uFEFF/, "").split(",").map((cell) => cell.trim().toUpperCase());
  const col = new Map(header.map((name, index) => [name, index]));
  if (!REQUIRED.every((name) => col.has(name))) return { tradeDate: null, mixedDates: false, rows: [], badRows: 0 };
  const at = (cells: string[], name: (typeof REQUIRED)[number]) => (cells[col.get(name)!] ?? "").trim();
  const isinAt = col.get("ISIN");

  const bySymbol = new Map<string, CashBhavRow>();
  const dates = new Set<number>();
  let badRows = 0;
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const cells = line.split(",");
    const series = at(cells, "SERIES").toUpperCase();
    if (series !== "EQ" && series !== "BE") continue;
    const symbol = at(cells, "SYMBOL").toUpperCase();
    const day = parseDmyDay(at(cells, "TIMESTAMP"));
    const [prevClose, open, high, low, close, volume] = (["PREVCLOSE", "OPEN", "HIGH", "LOW", "CLOSE", "TOTTRDQTY"] as const).map((name) => Number(at(cells, name)));
    if (!SYMBOL_RE.test(symbol) || day === null || ![prevClose, open, high, low, close, volume].every((n) => Number.isFinite(n) && n >= 0) || close <= 0) {
      badRows += 1;
      continue;
    }
    dates.add(day);
    // EQ wins over BE when a symbol has both.
    if (series === "BE" && bySymbol.get(symbol)?.series === "EQ") continue;
    const isin = isinAt === undefined ? "" : (cells[isinAt] ?? "").trim().toUpperCase();
    bySymbol.set(symbol, { symbol, series, prevClose, open, high, low, close, volume, deliveryPct: null, ...(ISIN_RE.test(isin) ? { isin } : {}) });
  }
  const sorted = [...dates].sort((a, b) => a - b);
  return { tradeDate: sorted.at(-1) ?? null, mixedDates: sorted.length > 1, rows: [...bySymbol.values()], badRows };
}
