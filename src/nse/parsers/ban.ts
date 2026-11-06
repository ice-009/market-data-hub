// NSE's daily list of F&O securities in the ban period (fo_secban.csv): a stock
// whose open interest crossed 95% of its market-wide position limit. While it's
// in the ban, no new futures/options positions may be opened — only reduced.
// Layout (as published; parsed tolerantly since NSE has changed it before):
//   Securities in Ban For Trade Date 05-NOV-2026:
//   1,ABFRL
//   2,HINDCOPPER
// or "…: NIL" on days with nothing in ban. Pure. (Ported from Tradex, MIT.)

export interface FnoBanList {
  /** IST trade date the list is for (UTC midnight ms), when the header has one. */
  tradeDate: number | null;
  symbols: string[];
}

const MONTHS: Record<string, number> = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

export function parseFnoBan(text: string): FnoBanList {
  const symbols = new Set<string>();
  let tradeDate: number | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const date = line.match(/(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
    if (date && /ban/i.test(line)) {
      const month = MONTHS[date[2].toUpperCase()];
      if (month !== undefined) tradeDate = Date.UTC(Number(date[3]), month, Number(date[1]));
      continue;
    }
    const cells = line.split(",").map((cell) => cell.trim().replace(/^"|"$/g, ""));
    // "1,ABFRL" (serial, symbol) or a bare "ABFRL".
    const candidate = cells.length >= 2 && /^\d+$/.test(cells[0]) ? cells[1] : cells.length === 1 ? cells[0] : "";
    const symbol = candidate.toUpperCase();
    if (/^[A-Z0-9&-]{2,20}$/.test(symbol) && !/^\d+$/.test(symbol) && symbol !== "NIL") symbols.add(symbol);
  }
  return { tradeDate, symbols: [...symbols] };
}
