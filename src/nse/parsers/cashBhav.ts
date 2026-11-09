import { parseNseDay } from "../../time.js";

// NSE full cash bhavcopy (sec_bhavdata_full_DDMMYYYY.csv) → one row per symbol.
// Columns are found by header name (NSE pads them with spaces). EQ is the normal
// rolling segment; BE (trade-for-trade) keeps a series going if a stock moves
// there. The file's own trade date (DATE1) is returned so the caller can reject
// a file served for another day. Pure. (Adapted from Tradex, MIT.)

export interface CashBhavRow {
  symbol: string;
  series: "EQ" | "BE";
  prevClose: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Delivered quantity as % of traded (null when NSE prints "-"). */
  deliveryPct: number | null;
}

export interface CashBhavParse {
  tradeDate: number | null;
  mixedDates: boolean;
  rows: CashBhavRow[];
  badRows: number;
}

const REQUIRED = ["SYMBOL", "SERIES", "DATE1", "PREV_CLOSE", "OPEN_PRICE", "HIGH_PRICE", "LOW_PRICE", "CLOSE_PRICE", "TTL_TRD_QNTY", "DELIV_PER"] as const;
const SYMBOL_RE = /^[A-Z0-9&_-]{1,20}$/;

export function parseCashBhav(csv: string): CashBhavParse {
  const lines = csv.split(/\r?\n/);
  const header = (lines[0] ?? "").replace(/^\uFEFF/, "").split(",").map((cell) => cell.trim().toUpperCase());
  const col = new Map(header.map((name, index) => [name, index]));
  if (!REQUIRED.every((name) => col.has(name))) return { tradeDate: null, mixedDates: false, rows: [], badRows: 0 };
  const at = (cells: string[], name: (typeof REQUIRED)[number]) => (cells[col.get(name)!] ?? "").trim();

  const bySymbol = new Map<string, CashBhavRow>();
  const dates = new Set<number>();
  let badRows = 0;
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const cells = line.split(",");
    const series = at(cells, "SERIES").toUpperCase();
    if (series !== "EQ" && series !== "BE") continue;
    const symbol = at(cells, "SYMBOL").toUpperCase();
    const day = parseNseDay(at(cells, "DATE1"));
    const [prevClose, open, high, low, close, volume] = (["PREV_CLOSE", "OPEN_PRICE", "HIGH_PRICE", "LOW_PRICE", "CLOSE_PRICE", "TTL_TRD_QNTY"] as const).map((name) => Number(at(cells, name)));
    const delivery = at(cells, "DELIV_PER");
    if (!SYMBOL_RE.test(symbol) || day === null || ![prevClose, open, high, low, close, volume].every((n) => Number.isFinite(n) && n >= 0) || close <= 0) {
      badRows += 1;
      continue;
    }
    dates.add(day);
    // EQ wins over BE when a symbol has both.
    if (series === "BE" && bySymbol.get(symbol)?.series === "EQ") continue;
    const deliveryPct = delivery === "" || delivery === "-" || !Number.isFinite(Number(delivery)) ? null : Number(delivery);
    bySymbol.set(symbol, { symbol, series, prevClose, open, high, low, close, volume, deliveryPct });
  }
  const sorted = [...dates].sort((a, b) => a - b);
  return { tradeDate: sorted.at(-1) ?? null, mixedDates: sorted.length > 1, rows: [...bySymbol.values()], badRows };
}
