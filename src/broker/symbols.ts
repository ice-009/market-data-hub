// Hub symbols are plain NSE tickers (SBIN, M&M, BAJAJ-AUTO) and a few index
// names (NIFTY, BANKNIFTY…). Fyers wants EXCHANGE:SYMBOL-SEGMENT; the mapping is
// string construction, never a network lookup. Pure.

export const INDEX_SYMBOLS: Readonly<Record<string, string>> = {
  NIFTY: "NSE:NIFTY50-INDEX",
  BANKNIFTY: "NSE:NIFTYBANK-INDEX",
  FINNIFTY: "NSE:FINNIFTY-INDEX",
  MIDCPNIFTY: "NSE:MIDCPNIFTY-INDEX",
  NIFTYNXT50: "NSE:NIFTYNXT50-INDEX",
  NIFTYIT: "NSE:NIFTYIT-INDEX",
  INDIAVIX: "NSE:INDIAVIX-INDEX",
};

const TICKER = /^[A-Z0-9][A-Z0-9&_-]{0,19}$/;

/** Normalise a requested symbol ("sbin " → "SBIN"); null when it can't be an NSE ticker. */
export function normalizeSymbol(raw: string): string | null {
  const symbol = raw.trim().toUpperCase();
  return TICKER.test(symbol) ? symbol : null;
}

export const isIndex = (symbol: string) => symbol in INDEX_SYMBOLS;

export function toFyersSymbol(symbol: string): string {
  return INDEX_SYMBOLS[symbol] ?? `NSE:${symbol}-EQ`;
}
