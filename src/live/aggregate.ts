import { MINUTE_MS, SESSION_CLOSE_MIN, SESSION_OPEN_MIN, istDayKey, istDayStart, isMarketOpen } from "../time.js";
import type { MinuteBar, Tick } from "./types.js";

// Ticks → 1-minute bars (no I/O; the store owns the state between calls).
//
//   minute   floor(ltt to the minute) — the exchange's trade time, not when the
//            hub received it, so a late tick lands in the minute it traded in.
//   o/h/l/c  from ltp. A tick older than a minute's latest one (out of order)
//            can extend h/l, and becomes the open if it's the earliest seen, but
//            never moves the close.
//   v        the rise in the tick's cumulative day volume since the previous
//            tick of the same IST day; never negative (a late or duplicate tick
//            adds 0). At a new day the baseline resets: the session's first
//            minute takes everything traded so far (pre-open included, as NSE
//            charts do); a first tick later in the day (the hub started
//            mid-session) adds 0, because the minute it came from is unknown —
//            recovery replaces those minutes with broker bars.
//   session  only ticks inside 09:15–15:30 IST on weekdays make bars (ticks
//            outside it are still kept as last quotes by the store). Pre-open
//            ticks leave the baseline alone so their volume reaches 09:15.
//
// A few recent minutes stay open in memory so a tick delayed by network jitter
// still folds into its own minute; older ones are final and later ticks for
// them are dropped (the store has already written them).

/** Minutes kept open for late ticks (the forming minute and the two before it). */
export const OPEN_MINUTES = 3;

/** A minute bar being built, with the trade times that decide its open and close. */
export interface MinuteAcc extends MinuteBar {
  firstLtt: number;
  lastLtt: number;
}

export interface SymbolAgg {
  symbol: string;
  /** IST day of the volume baseline (null until the first tick). */
  day: number | null;
  /** Cumulative day volume already counted into bars that day. */
  volume: number;
  /** Open minutes, oldest first (at most OPEN_MINUTES). */
  open: MinuteAcc[];
  /** Minutes before this that aren't open are final: later ticks for them are dropped. */
  finalBefore: number;
}

export const newAgg = (symbol: string): SymbolAgg => ({ symbol, day: null, volume: 0, open: [], finalBefore: -Infinity });

export const minuteOf = (time: number) => Math.floor(time / MINUTE_MS) * MINUTE_MS;

/** The tick's trade time, falling back to receipt time when the broker sent none. */
export const tradeTime = (tick: Tick) => (Number.isFinite(tick.ltt) && tick.ltt > 0 ? tick.ltt : tick.ts);

/** Session [open, close) of an IST day key. */
export function sessionOf(dayKey: number): { from: number; to: number } {
  const start = istDayStart(dayKey);
  return { from: start + SESSION_OPEN_MIN * MINUTE_MS, to: start + SESSION_CLOSE_MIN * MINUTE_MS };
}

/** Set the volume baseline for a symbol's first sight of `day` at trade time `ltt`. */
function startDay(agg: SymbolAgg, day: number, ltt: number, volume: number) {
  agg.day = day;
  // From before the first minute ended we saw everything: count it all (pre-open
  // volume lands in the first minute). Later, we don't know when it traded: count none.
  agg.volume = ltt < sessionOf(day).from + MINUTE_MS ? 0 : volume;
}

/**
 * Fold one tick into a symbol's state (mutates `agg`). Returns the minute it
 * changed, or null when the tick made no bar (outside the session, a final
 * minute, a bad price).
 */
export function foldTick(agg: SymbolAgg, tick: Tick): MinuteAcc | null {
  const ltt = tradeTime(tick);
  const day = istDayKey(ltt);

  let delta = 0;
  if (Number.isFinite(tick.volume) && tick.volume >= 0) {
    if (agg.day === null || day > agg.day) startDay(agg, day, ltt, tick.volume);
    // Before the open the baseline waits for the first minute; a tick from an
    // earlier day than the baseline is stale and adds nothing.
    if (day === agg.day && ltt >= sessionOf(day).from) {
      delta = Math.max(0, tick.volume - agg.volume);
      agg.volume = Math.max(agg.volume, tick.volume);
    }
  }

  if (!isMarketOpen(ltt) || !Number.isFinite(tick.ltp) || tick.ltp <= 0) return null;
  const t = minuteOf(ltt);
  let bar = agg.open.find((acc) => acc.t === t);
  if (!bar) {
    if (t < agg.finalBefore) return null;
    bar = { symbol: agg.symbol, t, o: tick.ltp, h: tick.ltp, l: tick.ltp, c: tick.ltp, v: 0, source: "live", firstLtt: ltt, lastLtt: ltt };
    agg.open.push(bar);
    agg.open.sort((a, b) => a.t - b.t);
    // Keep the newest OPEN_MINUTES minutes (by time, not arrival) open.
    const newest = agg.open[agg.open.length - 1].t;
    agg.finalBefore = Math.max(agg.finalBefore, newest - (OPEN_MINUTES - 1) * MINUTE_MS);
    agg.open = agg.open.filter((acc) => acc.t >= agg.finalBefore);
  } else {
    if (ltt < bar.firstLtt) {
      bar.o = tick.ltp;
      bar.firstLtt = ltt;
    }
    if (ltt >= bar.lastLtt) {
      bar.c = tick.ltp;
      bar.lastLtt = ltt;
    }
    bar.h = Math.max(bar.h, tick.ltp);
    bar.l = Math.min(bar.l, tick.ltp);
  }
  bar.v += delta;
  return bar;
}

/**
 * Seed a symbol's state after a restart from what the store kept: the last
 * quote gives the volume baseline; a stored bar of the quote's minute is open
 * again (so the next tick extends it instead of replacing it with a one-tick
 * bar), and anything older is final.
 */
export function seedAgg(symbol: string, last: { ltt: number; volume: number } | null, bar: MinuteBar | null): SymbolAgg {
  const agg = newAgg(symbol);
  if (last) {
    agg.day = istDayKey(last.ltt);
    // Volume up to the last quote is already in the stored bars (pre-open volume is still to come).
    agg.volume = Number.isFinite(last.volume) && last.ltt >= sessionOf(agg.day).from ? last.volume : 0;
    agg.finalBefore = minuteOf(last.ltt);
  }
  if (bar) {
    agg.open.push({ ...bar, firstLtt: bar.t, lastLtt: last && minuteOf(last.ltt) === bar.t ? last.ltt : bar.t });
    agg.finalBefore = bar.t;
  }
  return agg;
}
