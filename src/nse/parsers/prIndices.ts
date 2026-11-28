// The index rows of the PR zip's price file (PdDDMMYY.csv), for sessions
// whose index file (ind_close_all) NSE's archive doesn't have
// (market-data-hub#57). The file opens with one row per index before the
// stocks:
//   MKT,SERIES,SYMBOL,SECURITY,PREV_CL_PR,OPEN_PRICE,HIGH_PRICE,LOW_PRICE,CLOSE_PRICE,NET_TRDVAL,NET_TRDQTY,IND_SEC,CORP_IND,TRADES,HI_52_WK,LO_52_WK
//   Y, , ,CNX Nifty,      8510.80,      8439.20,      8457.50,      8341.40,      8363.05,…,Y, ,…
// (MKT "Y", no series or symbol, the index's name as the index file spells it
// that year). The change is worked out from PREV_CL_PR; volume, turnover and
// valuation ratios aren't there (null). The trade date is the file name's.
// Pure. Checked by hand on PR160212, PR080715 and PR200616.

import type { IndexCloseRow } from "./indexClose.js";

/** "Pd080715.csv" → the day key of 8 Jul 2015, or null for any other file. */
export function priceFileDay(name: string): number | null {
  const match = /^pd(\d{2})(\d{2})(\d{2})\.csv$/i.exec(name);
  if (!match) return null;
  const [day, month, year] = [Number(match[1]), Number(match[2]), 2000 + Number(match[3])];
  const t = Date.UTC(year, month - 1, day);
  const date = new Date(t);
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? t : null;
}

const price = (value: string | undefined): number | null => {
  const n = Number((value ?? "").trim());
  return (value ?? "").trim() !== "" && Number.isFinite(n) && n > 0 ? n : null;
};

export function parsePdIndices(csv: string): { rows: IndexCloseRow[]; badRows: number } {
  const lines = (csv.charCodeAt(0) === 0xfeff ? csv.slice(1) : csv).split(/\r?\n/);
  const header = (lines[0] ?? "").split(",").map((cell) => cell.trim().toUpperCase());
  const col = (name: string) => header.indexOf(name);
  const [mkt, series, symbol, security, prev, open, high, low, close] = ["MKT", "SERIES", "SYMBOL", "SECURITY", "PREV_CL_PR", "OPEN_PRICE", "HIGH_PRICE", "LOW_PRICE", "CLOSE_PRICE"].map(col);
  if ([mkt, series, symbol, security, prev, open, high, low, close].some((index) => index < 0)) return { rows: [], badRows: 0 };
  const rows = new Map<string, IndexCloseRow>();
  let badRows = 0;
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const cells = line.split(",");
    const isIndex = cells[mkt]?.trim() === "Y" && !cells[series]?.trim() && !cells[symbol]?.trim();
    if (!isIndex) {
      // The indices come first; the first stock (or section heading) ends them.
      if (rows.size) break;
      continue;
    }
    const name = (cells[security] ?? "").trim().replace(/\s+/g, " ");
    const closeValue = price(cells[close]);
    if (!name || closeValue === null) {
      badRows += 1;
      continue;
    }
    const prevClose = price(cells[prev]);
    const pointsChange = prevClose === null ? null : Math.round((closeValue - prevClose) * 100) / 100;
    rows.set(name, {
      name,
      open: price(cells[open]),
      high: price(cells[high]),
      low: price(cells[low]),
      close: closeValue,
      pointsChange,
      changePct: prevClose === null ? null : Math.round((closeValue / prevClose - 1) * 10_000) / 100,
      volume: null,
      turnoverCr: null,
      pe: null,
      pb: null,
      divYield: null,
    });
  }
  return { rows: [...rows.values()], badRows };
}
