// Hub symbols are plain NSE tickers (SBIN, M&M, BAJAJ-AUTO), a few index names
// (NIFTY, BANKNIFTY…) and futures contracts written the way Fyers writes them
// without the exchange: underlying + YY + MON + "FUT" (SBIN26NOVFUT, M&M26DECFUT).
// Fyers wants EXCHANGE:SYMBOL-SEGMENT for stocks and indices and NSE:<contract>
// for futures; the mapping is string construction, never a network lookup. Pure.

export const INDEX_SYMBOLS: Readonly<Record<string, string>> = {
  NIFTY: "NSE:NIFTY50-INDEX",
  BANKNIFTY: "NSE:NIFTYBANK-INDEX",
  FINNIFTY: "NSE:FINNIFTY-INDEX",
  MIDCPNIFTY: "NSE:MIDCPNIFTY-INDEX",
  NIFTYNXT50: "NSE:NIFTYNXT50-INDEX",
  NIFTYIT: "NSE:NIFTYIT-INDEX",
  INDIAVIX: "NSE:INDIAVIX-INDEX",
};

export const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"] as const;

const TICKER = /^[A-Z0-9][A-Z0-9&_-]{0,19}$/;
// The year is always the two digits right before the month, so an underlying
// that ends in digits (NIFTYNXT50) still splits correctly: the group backtracks.
const FUTURE = new RegExp(`^([A-Z0-9][A-Z0-9&_-]{0,19})(\\d{2})(${MONTHS.join("|")})FUT$`);

/**
 * Normalise a requested symbol ("sbin " → "SBIN"); null when it can't be a hub
 * symbol. A futures contract may also be sent in Fyers' own form
 * (NSE:SBIN26NOVFUT), which is how Tradex names them; stocks and indices may not
 * (NSE:SBIN-EQ stays invalid, so there is one spelling per stored series).
 */
export function normalizeSymbol(raw: string): string | null {
  let symbol = raw.trim().toUpperCase();
  if (symbol.startsWith("NSE:") && FUTURE.test(symbol.slice(4))) symbol = symbol.slice(4);
  return TICKER.test(symbol) || FUTURE.test(symbol) ? symbol : null;
}

export const isIndex = (symbol: string) => symbol in INDEX_SYMBOLS;

export interface FutureContract {
  underlying: string;
  /** Full year (2026). */
  year: number;
  /** 0-based month (10 = November). */
  month: number;
}

/** SBIN26NOVFUT → { underlying: SBIN, year: 2026, month: 10 }; null for anything that isn't a futures ticker. */
export function parseFuture(symbol: string): FutureContract | null {
  const match = FUTURE.exec(symbol);
  if (!match) return null;
  return { underlying: match[1], year: 2000 + Number(match[2]), month: MONTHS.indexOf(match[3] as (typeof MONTHS)[number]) };
}

export const isFuture = (symbol: string) => FUTURE.test(symbol);

/**
 * The futures ticker for an underlying and an expiry date (day key): NSE names a
 * monthly contract by the month it expires in, and a holiday only ever moves
 * expiry earlier, so the expiry's own month is the contract's.
 */
export function futureTicker(underlying: string, expiryDay: number): string {
  const date = new Date(expiryDay);
  return `${underlying}${String(date.getUTCFullYear() % 100).padStart(2, "0")}${MONTHS[date.getUTCMonth()]}FUT`;
}

export function toFyersSymbol(symbol: string): string {
  if (isFuture(symbol)) return `NSE:${symbol}`;
  return INDEX_SYMBOLS[symbol] ?? `NSE:${symbol}-EQ`;
}

/** Fyers symbol → hub ticker ("NSE:SBIN-EQ" → "SBIN", "NSE:NIFTY50-INDEX" → "NIFTY", "NSE:SBIN26NOVFUT" → "SBIN26NOVFUT"); null for anything else. */
export function fromFyersSymbol(fyersSymbol: string): string | null {
  for (const [ticker, fyers] of Object.entries(INDEX_SYMBOLS)) if (fyers === fyersSymbol) return ticker;
  const equity = /^NSE:(.+)-EQ$/.exec(fyersSymbol);
  if (equity) return equity[1];
  const contract = /^NSE:(.+)$/.exec(fyersSymbol);
  return contract && isFuture(contract[1]) ? contract[1] : null;
}
