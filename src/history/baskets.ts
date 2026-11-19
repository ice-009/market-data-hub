import type { Bar } from "../broker/fyers.js";
import { readKv, writeKv, type Db } from "../db.js";
import { BASKETS, type BasketInfo } from "../reference/indices.js";
import { getUniverse } from "../reference/universe.js";
import { dayStatuses, lastOkDay } from "../nse/store.js";
import { DAY_MS } from "../time.js";
import { runStart } from "./fromIndices.js";
import { readBars, readSeries, resetSymbol, writeBars } from "./store.js";

// Synthetic equal-weight baskets (EW-IT, EW-NIFTY50…; src/reference/indices.ts)
// built from the NSE cash bhavcopy, for history no real index covers: before
// NSE's index file starts (2012) and before a sector index launched.
//
// Each session's move is the plain average of the members' moves, each member's
// move being close / PREV_CLOSE − 1. NSE adjusts PREV_CLOSE on ex-dates, so a
// split or bonus doesn't show up as a crash. Open, high and low are averaged
// the same way (so the high is the average member's high, not the basket's
// intraday high). The level starts at 1000 on the first session with at least
// MIN_MEMBERS members priced. A member's first day in the file (no previous
// close of its own), a zero PREV_CLOSE, or a move beyond MAX_MOVE (bad data) is
// left out of that day. A session where no member traded repeats the level.
//
// Members are TODAY's members of the industry (the NIFTY 500 list snapshot):
// history is back-filled with today's winners — survivorship bias — so a
// basket is a stand-in, never an index, and is labelled synthetic in the API.
//
// Built only over the unbroken run of stored cash sessions ending at the
// newest one. Each run extends the stored baskets from their last bar; when the
// run reaches further back than last time (a history download) or the members
// change, they are rebuilt from scratch.

export const MIN_MEMBERS = 3;
export const MAX_MOVE = 0.5;
export const BASE_LEVEL = 1000;
const STATE_KEY = "index_baskets";

interface BuildState {
  runFrom: number;
  members: Record<string, string>;
}

export function basketMembers(db: Db, basket: BasketInfo): string[] {
  const members = getUniverse(db, basket.universe).members;
  return members.filter((member) => basket.industry === null || member.industry === basket.industry).map((member) => member.symbol).sort();
}

interface Sums {
  n: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

/**
 * Basket bars for `sessions` (cash days, oldest first), continuing from
 * `prevLevel` (null: start the basket at the first session with enough members).
 */
function computeBars(db: Db, members: string[], sessions: number[], prevLevel: number | null): Bar[] {
  if (!sessions.length) return [];
  const from = sessions[0];
  const to = sessions[sessions.length - 1];
  const byDay = new Map<number, Sums>();
  // One row before `from` per member tells whether `from` is its first day in the file.
  const statement = db.prepare("select day, o, h, l, c, prev_close as pc from cash_bhav where symbol = ? and day between ? and ? order by day");
  const before = db.prepare("select 1 from cash_bhav where symbol = ? and day < ? limit 1");
  for (const symbol of members) {
    let seen = Boolean(before.get(symbol, from));
    for (const row of statement.iterate(symbol, from, to) as Iterable<{ day: number; o: number; h: number; l: number; c: number; pc: number }>) {
      const first = !seen;
      seen = true;
      if (first || !(row.pc > 0) || !(row.c > 0)) continue;
      const move = row.c / row.pc - 1;
      if (Math.abs(move) > MAX_MOVE) continue;
      const ratio = (value: number) => (value > 0 && Math.abs(value / row.pc - 1) <= MAX_MOVE ? value / row.pc - 1 : move);
      const sums = byDay.get(row.day) ?? { n: 0, o: 0, h: 0, l: 0, c: 0 };
      sums.n += 1;
      sums.o += ratio(row.o);
      sums.h += ratio(row.h);
      sums.l += ratio(row.l);
      sums.c += move;
      byDay.set(row.day, sums);
    }
  }
  const bars: Bar[] = [];
  let level = prevLevel;
  for (const day of sessions) {
    const sums = byDay.get(day);
    if (level === null) {
      if (!sums || sums.n < MIN_MEMBERS) continue;
      level = BASE_LEVEL;
    }
    if (!sums || !sums.n) {
      bars.push({ t: day, o: level, h: level, l: level, c: level, v: 0 });
      continue;
    }
    const at = (sum: number) => level! * (1 + sum / sums.n);
    const [o, c] = [at(sums.o), at(sums.c)];
    bars.push({ t: day, o, h: Math.max(at(sums.h), o, c), l: Math.min(at(sums.l), o, c), c, v: 0 });
    level = c;
  }
  return bars;
}

export interface BasketResult {
  rebuilt: string[];
  extended: string[];
}

/** Bring every basket up to date with the stored cash bhavcopy (see the header). */
export function refreshBaskets(db: Db, now: number): BasketResult {
  const result: BasketResult = { rebuilt: [], extended: [] };
  const newest = lastOkDay(db, "cash_bhav");
  if (newest === null) return result;
  const statuses = dayStatuses(db, "cash_bhav");
  const floor = Math.min(...statuses.keys());
  const from = runStart(newest, statuses, () => true, floor);
  const sessions = [...statuses].filter(([day, status]) => status === "ok" && day >= from && day <= newest).map(([day]) => day).sort((a, b) => a - b);
  const saved = readKv<BuildState>(db, STATE_KEY);
  const state: BuildState = { runFrom: from, members: {} };

  for (const basket of BASKETS) {
    const members = basketMembers(db, basket);
    const signature = members.join(",");
    state.members[basket.symbol] = signature;
    if (members.length < MIN_MEMBERS) {
      if (readSeries(db, basket.symbol, "1d")) resetSymbol(db, basket.symbol);
      continue;
    }
    const meta = readSeries(db, basket.symbol, "1d");
    const last = meta?.lastT ?? null;
    const incremental = saved?.runFrom === from && saved.members[basket.symbol] === signature && meta?.coverage && last !== null;
    if (incremental) {
      const fresh = sessions.filter((day) => day > last);
      if (!fresh.length) continue;
      const [previous] = readBars(db, basket.symbol, "1d", last, last + 1);
      const bars = computeBars(db, members, fresh, previous?.c ?? null);
      writeBars(db, basket.symbol, "1d", bars, { from: meta.coverage!.from, to: newest + DAY_MS }, now);
      result.extended.push(basket.symbol);
    } else {
      const bars = computeBars(db, members, sessions, null);
      if (meta) resetSymbol(db, basket.symbol);
      if (!bars.length) continue;
      writeBars(db, basket.symbol, "1d", bars, { from: bars[0].t, to: newest + DAY_MS }, now);
      result.rebuilt.push(basket.symbol);
    }
  }
  writeKv(db, STATE_KEY, state, now);
  return result;
}
