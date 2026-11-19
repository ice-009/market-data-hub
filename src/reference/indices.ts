// The indices the hub serves daily history for, and how NSE's index file names
// them. Pure.
//
// Real indices come from NSE's daily index file (ind_close_all, from Feb/Mar
// 2012; src/nse/datasets.ts). NSE renamed most indices over the years — "S&P
// CNX Nifty" until 2013, "CNX Nifty" until Nov 2015, "Nifty 50" since; the
// sector indices went "CNX IT" → "Nifty IT" — so each hub symbol lists every
// name it has had. Names are matched ignoring case and spacing. A few
// symbols (NIFTY, BANKNIFTY…) are also served by the broker (intraday, live
// quotes); the rest are daily-only, from NSE's file alone.
//
// Synthetic baskets ("EW-…") stand in where no real index history exists —
// before 2012, and before a sector index's launch (NSE added Capital Goods,
// Chemicals, Power… only recently). Each is an equal-weight basket of today's
// members of one NIFTY 500 industry (or of NIFTY 50 / NIFTY 500 themselves),
// rebuilt from the NSE cash bhavcopy (src/history/baskets.ts). They are NOT
// NSE indices: today's members back-filled, so history has survivorship
// bias. The API marks them `synthetic: true` everywhere.

export interface IndexInfo {
  symbol: string;
  /** NSE's current name. */
  name: string;
  /** Every name NSE's index file has used for it (current first). */
  aliases: readonly string[];
}

export const NSE_INDICES: readonly IndexInfo[] = [
  // Broad market
  { symbol: "NIFTY", name: "Nifty 50", aliases: ["Nifty 50", "CNX Nifty", "S&P CNX Nifty"] },
  { symbol: "NIFTYNXT50", name: "Nifty Next 50", aliases: ["Nifty Next 50", "CNX Nifty Junior", "Nifty Junior"] },
  { symbol: "NIFTY100", name: "Nifty 100", aliases: ["Nifty 100", "CNX 100"] },
  { symbol: "NIFTY200", name: "Nifty 200", aliases: ["Nifty 200", "CNX 200"] },
  { symbol: "NIFTY500", name: "Nifty 500", aliases: ["Nifty 500", "CNX 500", "S&P CNX 500"] },
  { symbol: "NIFTYMIDCAP50", name: "Nifty Midcap 50", aliases: ["Nifty Midcap 50"] },
  { symbol: "NIFTYMIDCAP100", name: "Nifty Midcap 100", aliases: ["Nifty Midcap 100", "CNX Midcap"] },
  { symbol: "NIFTYMIDCAP150", name: "Nifty Midcap 150", aliases: ["Nifty Midcap 150"] },
  { symbol: "NIFTYSMLCAP100", name: "Nifty Smallcap 100", aliases: ["Nifty Smallcap 100", "CNX Smallcap"] },
  { symbol: "NIFTYSMLCAP250", name: "Nifty Smallcap 250", aliases: ["Nifty Smallcap 250"] },
  { symbol: "MIDCPNIFTY", name: "Nifty Midcap Select", aliases: ["Nifty Midcap Select"] },
  { symbol: "INDIAVIX", name: "India VIX", aliases: ["India VIX"] },
  // Sectors
  { symbol: "BANKNIFTY", name: "Nifty Bank", aliases: ["Nifty Bank", "CNX Bank", "Bank Nifty"] },
  { symbol: "FINNIFTY", name: "Nifty Financial Services", aliases: ["Nifty Financial Services", "CNX Finance"] },
  { symbol: "NIFTYPVTBANK", name: "Nifty Private Bank", aliases: ["Nifty Private Bank"] },
  { symbol: "NIFTYPSUBANK", name: "Nifty PSU Bank", aliases: ["Nifty PSU Bank", "CNX PSU Bank"] },
  { symbol: "NIFTYIT", name: "Nifty IT", aliases: ["Nifty IT", "CNX IT"] },
  { symbol: "NIFTYAUTO", name: "Nifty Auto", aliases: ["Nifty Auto", "CNX Auto"] },
  { symbol: "NIFTYFMCG", name: "Nifty FMCG", aliases: ["Nifty FMCG", "CNX FMCG"] },
  { symbol: "NIFTYPHARMA", name: "Nifty Pharma", aliases: ["Nifty Pharma", "CNX Pharma"] },
  { symbol: "NIFTYHEALTHCARE", name: "Nifty Healthcare Index", aliases: ["Nifty Healthcare Index", "Nifty Healthcare"] },
  { symbol: "NIFTYMETAL", name: "Nifty Metal", aliases: ["Nifty Metal", "CNX Metal"] },
  { symbol: "NIFTYREALTY", name: "Nifty Realty", aliases: ["Nifty Realty", "CNX Realty"] },
  { symbol: "NIFTYMEDIA", name: "Nifty Media", aliases: ["Nifty Media", "CNX Media"] },
  { symbol: "NIFTYENERGY", name: "Nifty Energy", aliases: ["Nifty Energy", "CNX Energy"] },
  { symbol: "NIFTYOILGAS", name: "Nifty Oil & Gas", aliases: ["Nifty Oil & Gas"] },
  { symbol: "NIFTYPOWER", name: "Nifty Power", aliases: ["Nifty Power"] },
  { symbol: "NIFTYINFRA", name: "Nifty Infrastructure", aliases: ["Nifty Infrastructure", "CNX Infrastructure"] },
  { symbol: "NIFTYCONSUMPTION", name: "Nifty India Consumption", aliases: ["Nifty India Consumption", "CNX Consumption"] },
  { symbol: "NIFTYCOMMODITIES", name: "Nifty Commodities", aliases: ["Nifty Commodities", "CNX Commodities"] },
  { symbol: "NIFTYSERVICES", name: "Nifty Services Sector", aliases: ["Nifty Services Sector", "CNX Service Sector"] },
  { symbol: "NIFTYCONSRDURBL", name: "Nifty Consumer Durables", aliases: ["Nifty Consumer Durables"] },
  { symbol: "NIFTYCONSRSERV", name: "Nifty Consumer Services", aliases: ["Nifty Consumer Services"] },
  { symbol: "NIFTYCAPGOODS", name: "Nifty Capital Goods", aliases: ["Nifty Capital Goods"] },
  { symbol: "NIFTYCHEMICALS", name: "Nifty Chemicals", aliases: ["Nifty Chemicals"] },
  { symbol: "NIFTYCEMENT", name: "Nifty Cement", aliases: ["Nifty Cement"] },
  { symbol: "NIFTYCONSTRUCT", name: "Nifty Construction", aliases: ["Nifty Construction"] },
  { symbol: "NIFTYTELECOM", name: "Nifty Telecommunications", aliases: ["Nifty Telecommunications"] },
];

/** Prefix of a synthetic equal-weight basket's symbol. */
export const BASKET_PREFIX = "EW-";

export interface SectorInfo {
  /** The NIFTY 500 list's industry (niftyindices.com's classification). */
  industry: string;
  /** NSE sector indices that track it, best first (the first one with history for a window should be used). */
  indices: readonly string[];
  /** Its synthetic basket. */
  basket: string;
}

const sector = (industry: string, code: string, indices: string[]): SectorInfo => ({ industry, indices, basket: `${BASKET_PREFIX}${code}` });

/** Every industry in the NIFTY 500 list, with its sector indices and basket. */
export const SECTORS: readonly SectorInfo[] = [
  sector("Financial Services", "FINANCIAL", ["FINNIFTY", "BANKNIFTY"]),
  sector("Capital Goods", "CAPGOODS", ["NIFTYCAPGOODS"]),
  sector("Healthcare", "HEALTHCARE", ["NIFTYHEALTHCARE", "NIFTYPHARMA"]),
  sector("Automobile and Auto Components", "AUTO", ["NIFTYAUTO"]),
  sector("Fast Moving Consumer Goods", "FMCG", ["NIFTYFMCG"]),
  sector("Chemicals", "CHEMICALS", ["NIFTYCHEMICALS"]),
  sector("Information Technology", "IT", ["NIFTYIT"]),
  sector("Consumer Services", "CONSRSERV", ["NIFTYCONSRSERV"]),
  sector("Metals & Mining", "METALS", ["NIFTYMETAL"]),
  sector("Power", "POWER", ["NIFTYPOWER", "NIFTYENERGY"]),
  sector("Oil Gas & Consumable Fuels", "OILGAS", ["NIFTYOILGAS", "NIFTYENERGY"]),
  sector("Consumer Durables", "CONSRDURBL", ["NIFTYCONSRDURBL"]),
  sector("Services", "SERVICES", ["NIFTYSERVICES"]),
  sector("Realty", "REALTY", ["NIFTYREALTY"]),
  sector("Construction", "CONSTRUCT", ["NIFTYCONSTRUCT", "NIFTYINFRA"]),
  sector("Construction Materials", "CONSTMATL", ["NIFTYCEMENT"]),
  sector("Telecommunication", "TELECOM", ["NIFTYTELECOM"]),
  sector("Textiles", "TEXTILES", []),
  sector("Media Entertainment & Publication", "MEDIA", ["NIFTYMEDIA"]),
  sector("Diversified", "DIVERSIFIED", []),
];

export interface BasketInfo {
  symbol: string;
  name: string;
  /** Which members: one NIFTY 500 industry, or a whole index list. */
  universe: "nifty50" | "nifty500";
  industry: string | null;
  /** The real index it stands in for, when there is one. */
  standsFor: string | null;
}

export const BASKETS: readonly BasketInfo[] = [
  { symbol: `${BASKET_PREFIX}NIFTY50`, name: "Equal-weight NIFTY 50 basket (synthetic)", universe: "nifty50", industry: null, standsFor: "NIFTY" },
  { symbol: `${BASKET_PREFIX}NIFTY500`, name: "Equal-weight NIFTY 500 basket (synthetic)", universe: "nifty500", industry: null, standsFor: "NIFTY500" },
  ...SECTORS.map((s): BasketInfo => ({ symbol: s.basket, name: `Equal-weight ${s.industry} basket (synthetic)`, universe: "nifty500", industry: s.industry, standsFor: s.indices[0] ?? null })),
];

const normalize = (name: string) => name.trim().replace(/\s+/g, " ").toLowerCase();

const BY_NAME = new Map(NSE_INDICES.flatMap((info) => info.aliases.map((alias) => [normalize(alias), info.symbol] as const)));
const BY_SYMBOL = new Map(NSE_INDICES.map((info) => [info.symbol, info]));
const BASKET_BY_SYMBOL = new Map(BASKETS.map((basket) => [basket.symbol, basket]));

/** The hub symbol for a name in NSE's index file ("S&P CNX Nifty" → NIFTY), or null for an index the hub doesn't serve. */
export const indexSymbolForName = (name: string): string | null => BY_NAME.get(normalize(name)) ?? null;

export const indexInfo = (symbol: string): IndexInfo | null => BY_SYMBOL.get(symbol) ?? null;
export const basketInfo = (symbol: string): BasketInfo | null => BASKET_BY_SYMBOL.get(symbol) ?? null;

/** A real NSE index the hub stores from NSE's index file. */
export const isNseIndex = (symbol: string) => BY_SYMBOL.has(symbol);
export const isBasket = (symbol: string) => BASKET_BY_SYMBOL.has(symbol);
