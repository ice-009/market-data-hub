import { readFileSync } from "node:fs";
import type { Db } from "../db.js";
import { foMembersOn } from "../nse/store.js";
import { DAY_MS, isoDay, istDayKey } from "../time.js";

// Symbol universes. The index lists are snapshots from niftyindices.com
// (ind_nifty{50,100,200,500}list.csv) in reference/universe/ — indices
// rebalance twice a year; refresh by downloading those files again. The F&O
// list comes from the newest stored NSE F&O bhavcopy (every stock with futures
// that day), falling back to the reference/universe/fno.txt snapshot when no
// recent bhavcopy is stored. (Snapshots and loader adapted from Tradex, MIT.)

export const UNIVERSES = ["fno", "nifty50", "nifty100", "nifty200", "nifty500"] as const;
export type UniverseName = (typeof UNIVERSES)[number];
export const isUniverse = (value: string): value is UniverseName => (UNIVERSES as readonly string[]).includes(value);

export interface UniverseMember {
  symbol: string;
  name: string;
  industry: string;
}

export interface Universe {
  name: UniverseName;
  source: "snapshot" | "nse_fo_bhavcopy";
  /** Trade date of the F&O bhavcopy the list came from (fno only). */
  asOf: string | null;
  members: UniverseMember[];
}

const DIR = new URL("../../reference/universe/", import.meta.url);
/** A stored F&O bhavcopy older than this doesn't define today's F&O list. */
const FO_FRESH_DAYS = 10;

const cache = new Map<string, UniverseMember[]>();

function indexCsv(file: string): UniverseMember[] {
  let members = cache.get(file);
  if (!members) {
    members = readFileSync(new URL(file, DIR), "utf8")
      .split(/\r?\n/)
      .slice(1)
      .map((line) => line.split(","))
      .filter((cols) => cols.length >= 3 && cols[2]?.trim())
      .map(([name, industry, symbol]) => ({ symbol: symbol.trim().toUpperCase(), name: name.trim(), industry: industry.trim() }));
    cache.set(file, members);
  }
  return members;
}

function withNames(symbols: string[]): UniverseMember[] {
  const known = new Map(indexCsv("nifty500.csv").map((member) => [member.symbol, member]));
  return symbols.map((symbol) => known.get(symbol) ?? { symbol, name: symbol, industry: "" });
}

export function getUniverse(db: Db, name: UniverseName, now = Date.now()): Universe {
  if (name !== "fno") return { name, source: "snapshot", asOf: null, members: indexCsv(`${name}.csv`) };
  const today = istDayKey(now);
  const latest = foMembersOn(db, today);
  if (latest && today - latest.day <= FO_FRESH_DAYS * DAY_MS && latest.symbols.length) {
    return { name, source: "nse_fo_bhavcopy", asOf: isoDay(latest.day), members: withNames(latest.symbols) };
  }
  const snapshot = readFileSync(new URL("fno.txt", DIR), "utf8")
    .split(/\r?\n/)
    .map((symbol) => symbol.trim().toUpperCase())
    .filter(Boolean);
  return { name, source: "snapshot", asOf: null, members: withNames([...new Set(snapshot)].sort()) };
}
