// Stock-futures lot-size files → lot per underlying. Pure: no I/O.
// The downloads live in src/nse/datasets.ts. (Ported from Tradex, MIT.)

const MONTH_COLUMN = /^[A-Z]{3}-\d{2}$/;

/** NSE fo_mktlots.csv → lot per symbol for the nearest listed month. */
export function parseNseLots(csv: string): Record<string, number> {
  const lines = csv.split(/\r?\n/).map((line) => line.split(",").map((cell) => cell.trim()));
  const headerIndex = lines.findIndex((cells) => cells.some((cell) => cell.toUpperCase() === "SYMBOL"));
  if (headerIndex < 0) return {};
  const header = lines[headerIndex].map((cell) => cell.toUpperCase());
  const symbolCol = header.indexOf("SYMBOL");
  const monthCols = header.map((cell, index) => (MONTH_COLUMN.test(cell) ? index : -1)).filter((index) => index > symbolCol);
  const lots: Record<string, number> = {};
  for (const cells of lines.slice(headerIndex + 1)) {
    const symbol = cells[symbolCol]?.toUpperCase();
    if (!symbol || !/^[A-Z0-9&-]+$/.test(symbol)) continue;
    // Nearest month with a lot (the first month column that has a number).
    const cols = monthCols.length ? monthCols : cells.map((_, index) => index).filter((index) => index > symbolCol);
    for (const col of cols) {
      const value = Number(cells[col]);
      if (Number.isInteger(value) && value > 0) {
        lots[symbol] = value;
        break;
      }
    }
  }
  return lots;
}

/** Fyers NSE_FO.csv → lot per underlying, from futures rows. */
export function parseFyersLots(csv: string): Record<string, number> {
  const lots: Record<string, number> = {};
  for (const line of csv.split(/\r?\n/)) {
    const cells = line.split(",").map((cell) => cell.trim());
    const ticker = cells.find((cell) => /^NSE:[A-Z0-9&-]+\d{2}[A-Z]{3}FUT$/.test(cell));
    if (!ticker) continue;
    const underlying = ticker.slice(4).replace(/\d{2}[A-Z]{3}FUT$/, "");
    const lot = Number(cells[3]);
    if (Number.isInteger(lot) && lot > 0 && !lots[underlying]) lots[underlying] = lot;
  }
  return lots;
}

