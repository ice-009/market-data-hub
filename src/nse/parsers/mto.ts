import { parseDmyDay } from "../../time.js";

// NSE's security-wise delivery position (MTO_DDMMYYYY.DAT), published since
// 2002: the delivery % that the old cash bhavcopy (./cmBhav.ts) lacks.
//
//   Security Wise Delivery Position - Compulsory Rolling Settlement
//   10,MTO,03012005,208721272,0000752
//   Trade Date <03-JAN-2005>,Settlement Type <N>,…
//   Record Type,Sr No,Name of Security,Quantity Traded,Deliverable Quantity(…),% of Deliverable Quantity to Traded Quantity
//   20,1,3MINDIA,EQ,1387,971,70.01
//
// Returns the trade date and delivery % per "SYMBOL|SERIES". Pure.

export interface MtoParse {
  tradeDate: number | null;
  deliveryPct: Map<string, number>;
  badRows: number;
}

export const mtoKey = (symbol: string, series: string) => `${symbol}|${series}`;

export function parseMto(text: string): MtoParse {
  const deliveryPct = new Map<string, number>();
  let tradeDate: number | null = null;
  let badRows = 0;
  for (const line of text.split(/\r?\n/)) {
    const date = /^Trade Date <([^>]+)>/i.exec(line.trim());
    if (date) {
      tradeDate = parseDmyDay(date[1]);
      continue;
    }
    const cells = line.split(",").map((cell) => cell.trim());
    if (cells[0] !== "20") continue;
    const symbol = (cells[2] ?? "").toUpperCase();
    const series = (cells[3] ?? "").toUpperCase();
    const pct = Number(cells[6]);
    if (!symbol || !series || cells[6] === undefined || cells[6] === "" || !Number.isFinite(pct) || pct < 0 || pct > 100) {
      badRows += 1;
      continue;
    }
    deliveryPct.set(mtoKey(symbol, series), pct);
  }
  return { tradeDate, deliveryPct, badRows };
}
