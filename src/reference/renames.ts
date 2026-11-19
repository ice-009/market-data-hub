import type { Db } from "../db.js";
import type { SymbolChangeRow } from "../nse/parsers/symbolChange.js";
import { cashSessionsBetween, cashSpan, readSymbolChanges, sharedIsins, type IsinUse } from "../nse/store.js";
import { DAY_MS } from "../time.js";

// Renamed tickers, point in time. NSE renames a listing's ticker now and then
// (TELCO → TATAMOTORS in 2003 → TMPV in 2025; INFOSYSTCH → INFY in 2011), and
// its files are written under whatever the ticker was that day, so one company
// has one half of its history under each name. Two sources say which tickers
// belong together:
//   - NSE's symbolchange.csv (src/nse/parsers/symbolChange.ts): every rename
//     since 1999 with its effective date, the first session under the new name;
//   - ISINs in the old-format cash bhavcopies (2011 to 5 Jul 2024): one ISIN
//     traded under ticker A, then, after A's last day, under B. These add the
//     renames NSE's list lacks; where NSE's list has the same change (the same
//     pair, or the same old or new ticker within ISIN_MATCH_DAYS), NSE's wins.
//
// A *listing* is one company's line of names, oldest first, each name with the
// days it was in use: [from, until) as day keys, from = the effective date of
// the rename into it (null: since before any record), until = the effective
// date of the rename out of it (null: still in use). Lookups are by (ticker,
// day): the ticker as it was that day, so "INFOSYSTCH on 2005-01-03" and "INFY
// today" are the same listing, and a ticker renamed away and later taken by
// another company resolves by date. Pure, apart from the two db readers at the
// bottom.

/** An ISIN-seen rename within this many days of one in NSE's list, for the same old or new ticker, is that change. */
export const ISIN_MATCH_DAYS = 31;
/** Longest rename chain followed (the longest real one is 4; this only stops a bad file looping). */
const MAX_HOPS = 64;

export interface SymbolChange extends SymbolChangeRow {
  source: "nse" | "isin";
  /** The ISIN the change was seen under (source "isin"). */
  isin: string | null;
}

/** One name of a listing: in use from <= day < until (day keys; null = open-ended). */
export interface NameSpan {
  symbol: string;
  from: number | null;
  until: number | null;
}

/**
 * How the asked-for (ticker, day) found the listing:
 *   exact    the listing had that ticker on that day
 *   later    no listing had it that day; the one that took the ticker later (INFY asked for 2005)
 *   earlier  it had been renamed away by then; the listing that last had it (INFOSYSTCH asked for today)
 */
export type ListingMatch = "exact" | "later" | "earlier";

export interface Listing {
  /** Oldest first; the last is the listing's ticker today (or when it stopped trading). */
  names: NameSpan[];
  /** The renames between them, oldest first: changes[i] took names[i] to names[i + 1]. */
  changes: SymbolChange[];
  current: string;
  match: ListingMatch;
}

/** Has `symbol` a stored cash-bhavcopy row with from <= day < until (null = open-ended)? Tells a reused ticker from a retired one. */
export type TradedCheck = (symbol: string, from: number | null, until: number | null) => boolean;

/** Renames seen in ISINs: an ISIN under ticker A, then under B from after A's last day. Overlapping uses are ambiguous and skipped. Pure. */
export function isinChanges(uses: readonly IsinUse[]): SymbolChange[] {
  const byIsin = new Map<string, IsinUse[]>();
  for (const use of uses) byIsin.set(use.isin, [...(byIsin.get(use.isin) ?? []), use]);
  const out: SymbolChange[] = [];
  for (const [isin, list] of byIsin) {
    const sorted = [...list].sort((a, b) => a.firstDay - b.firstDay);
    for (let i = 1; i < sorted.length; i += 1) {
      const [before, after] = [sorted[i - 1], sorted[i]];
      if (before.symbol !== after.symbol && before.lastDay < after.firstDay) out.push({ oldSymbol: before.symbol, newSymbol: after.symbol, day: after.firstDay, company: "", source: "isin", isin });
    }
  }
  return out;
}

/** NSE's list plus the ISIN-seen renames it doesn't have, by effective date. Pure. */
export function mergeChanges(nse: readonly SymbolChangeRow[], seen: readonly SymbolChange[]): SymbolChange[] {
  const out: SymbolChange[] = nse.map((row) => ({ ...row, source: "nse", isin: null }));
  const byOld = new Map<string, SymbolChange[]>();
  const byNew = new Map<string, SymbolChange[]>();
  for (const change of out) {
    byOld.set(change.oldSymbol, [...(byOld.get(change.oldSymbol) ?? []), change]);
    byNew.set(change.newSymbol, [...(byNew.get(change.newSymbol) ?? []), change]);
  }
  const near = (a: SymbolChange, b: SymbolChange) => Math.abs(a.day - b.day) <= ISIN_MATCH_DAYS * DAY_MS;
  for (const change of seen) {
    const sameOld = byOld.get(change.oldSymbol) ?? [];
    const known = sameOld.some((n) => n.newSymbol === change.newSymbol || near(n, change)) || (byNew.get(change.newSymbol) ?? []).some((n) => near(n, change));
    if (!known) out.push(change);
  }
  return out.sort((a, b) => a.day - b.day || (a.oldSymbol < b.oldSymbol ? -1 : a.oldSymbol > b.oldSymbol ? 1 : 0));
}

/**
 * Renames chained on one day (GBNOV23 → SBNOV23 → SGBNOV23, all 15 Sep 2016)
 * as one: the middle ticker never traded. Pure.
 */
export function collapseSameDay(changes: readonly SymbolChange[]): SymbolChange[] {
  const byOldAndDay = new Map(changes.map((change) => [`${change.oldSymbol}|${change.day}`, change]));
  const absorbed = new Set(changes.map((change) => byOldAndDay.get(`${change.newSymbol}|${change.day}`)).filter((change): change is SymbolChange => change !== undefined));
  return changes
    .filter((change) => !absorbed.has(change))
    .map((change) => {
      let newSymbol = change.newSymbol;
      for (let hops = 0, next = byOldAndDay.get(`${newSymbol}|${change.day}`); next && hops < MAX_HOPS; hops += 1, next = byOldAndDay.get(`${newSymbol}|${change.day}`)) newSymbol = next.newSymbol;
      return newSymbol === change.newSymbol ? change : { ...change, newSymbol };
    });
}

interface Use extends NameSpan {
  came: SymbolChange | null;
  went: SymbolChange | null;
}

type Found = { use: Use } | { redirect: Exclude<ListingMatch, "exact">; day: number };

const lastAtOrBefore = (list: readonly SymbolChange[], day: number) => {
  let found: SymbolChange | null = null;
  for (const change of list) if (change.day <= day) found = change;
  return found;
};

export class Renames {
  private readonly out = new Map<string, SymbolChange[]>();
  private readonly into = new Map<string, SymbolChange[]>();
  readonly changes: readonly SymbolChange[];

  constructor(changes: readonly SymbolChange[]) {
    this.changes = collapseSameDay(changes).sort((a, b) => a.day - b.day);
    for (const change of this.changes) {
      this.out.set(change.oldSymbol, [...(this.out.get(change.oldSymbol) ?? []), change]);
      this.into.set(change.newSymbol, [...(this.into.get(change.newSymbol) ?? []), change]);
    }
  }

  /**
   * The use of `symbol` that covers `day`. A ticker's use starts with a rename
   * into it (or before any record) and ends with a rename out of it. Between a
   * rename out and the next rename in, nobody known held it: with `traded`, a
   * stored row there means a company listed under it anew (a reused ticker);
   * otherwise the lookup moves to the listing that took it next, or last had it.
   */
  private find(symbol: string, day: number, traded?: TradedCheck): Found {
    const outs = this.out.get(symbol) ?? [];
    const ins = this.into.get(symbol) ?? [];
    const came = lastAtOrBefore(ins, day);
    const left = lastAtOrBefore(outs, day);
    const went = outs.find((change) => change.day > day) ?? null;
    if (came && (!left || came.day >= left.day)) return { use: { symbol, from: came.day, until: went?.day ?? null, came, went } };
    const from = left?.day ?? null;
    const nextIn = ins.find((change) => change.day > day) ?? null;
    // Renamed away before anyone renamed into it again: someone listed under this ticker meanwhile.
    if (went && (!nextIn || went.day <= nextIn.day)) return { use: { symbol, from, until: went.day, came: null, went } };
    const until = nextIn?.day ?? null;
    if (!traded || traded(symbol, from, until) || (!nextIn && !left)) return { use: { symbol, from, until, came: null, went: null } };
    return nextIn ? { redirect: "later", day: nextIn.day } : { redirect: "earlier", day: left!.day - DAY_MS };
  }

  private useAt(symbol: string, day: number): Use {
    const found = this.find(symbol, day);
    if ("use" in found) return found.use;
    throw new Error("unreachable: find without a traded check always answers with a use");
  }

  /** The listing that had `symbol` on `day` (see ListingMatch for when none did). */
  listing(symbol: string, day: number, traded?: TradedCheck): Listing {
    let found = this.find(symbol, day, traded);
    let match: ListingMatch = "exact";
    if ("redirect" in found) {
      match = found.redirect;
      found = { use: this.useAt(symbol, found.day) };
    }
    const start = found.use;
    const names: Use[] = [start];
    const changes: SymbolChange[] = [];
    const seen = new Set<SymbolChange>();
    for (let use = start; use.came && !seen.has(use.came) && seen.size < MAX_HOPS; ) {
      const change: SymbolChange = use.came;
      seen.add(change);
      use = this.useAt(change.oldSymbol, change.day - DAY_MS);
      names.unshift(use);
      changes.unshift(change);
    }
    for (let use = start; use.went && !seen.has(use.went) && seen.size < MAX_HOPS; ) {
      const change: SymbolChange = use.went;
      seen.add(change);
      use = this.useAt(change.newSymbol, change.day);
      names.push(use);
      changes.push(change);
    }
    return { names: names.map(({ symbol: s, from, until }) => ({ symbol: s, from, until })), changes, current: names[names.length - 1].symbol, match };
  }
}

/** The listing's ticker on `day`, or null when the day is outside its names (before a reused ticker's listing). */
export function nameOn(listing: Listing, day: number): string | null {
  return listing.names.find((name) => (name.from === null || name.from <= day) && (name.until === null || day < name.until))?.symbol ?? null;
}

/**
 * The names a listing traded under within from..to (day keys, inclusive),
 * oldest first, each clipped to the range: what to read, name by name, to serve
 * one continuous history (`/v1/candles` over NSE's archive, #22).
 */
export function namesBetween(listing: Listing, from: number, to: number): Array<{ symbol: string; from: number; to: number }> {
  const out: Array<{ symbol: string; from: number; to: number }> = [];
  for (const name of listing.names) {
    const start = Math.max(from, name.from ?? from);
    const end = Math.min(to, name.until === null ? to : name.until - DAY_MS);
    if (start <= end) out.push({ symbol: name.symbol, from: start, to: end });
  }
  return out;
}

// ------------------------------------------------------------------ from the store

/** Every known rename: NSE's list (as last downloaded) plus those seen in stored ISINs. */
export function loadRenames(db: Db): Renames {
  return new Renames(mergeChanges(readSymbolChanges(db), isinChanges(sharedIsins(db))));
}

/** A stored cash-bhavcopy row for `symbol` in [from, until)? */
export function storedTraded(db: Db): TradedCheck {
  const statement = db.prepare("select 1 from cash_bhav where symbol = ? and day >= ? and day < ? limit 1");
  return (symbol, from, until) => Boolean(statement.get(symbol, from ?? Number.MIN_SAFE_INTEGER, until ?? Number.MAX_SAFE_INTEGER));
}

/** The listing that had `symbol` on `day`, from the store. With no renames stored, every ticker is its own listing. */
export function listingOf(db: Db, symbol: string, day: number, renames = loadRenames(db)): Listing {
  return renames.listing(symbol, day, storedTraded(db));
}

export interface StoredListing {
  names: Array<NameSpan & { stored: { first: number; last: number; sessions: number } | null }>;
  /**
   * Per change, whether the stored cash history runs on across it: the old
   * ticker's last stored session and the new one's first are consecutive
   * stored sessions (null when either side has nothing stored).
   */
  continuous: Array<boolean | null>;
}

/** What the cash bhavcopy store holds for each of a listing's names. */
export function storedListing(db: Db, listing: Listing): StoredListing {
  const names = listing.names.map((name) => ({ ...name, stored: cashSpan(db, name.symbol, name.from, name.until) }));
  const continuous = listing.changes.map((_, i) => {
    const [before, after] = [names[i].stored, names[i + 1].stored];
    return before && after ? before.last < after.first && cashSessionsBetween(db, before.last, after.first) === 0 : null;
  });
  return { names, continuous };
}
