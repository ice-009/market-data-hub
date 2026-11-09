import type { Resolution } from "../broker/fyers.js";
import { DAY_MS, MINUTE_MS, SESSION_CLOSE_MIN, SESSION_OPEN_MIN, istDayKey, istDayStart, istParts, isWeekday, weekdayOnOrBefore } from "../time.js";

// Timeframes the API serves, and the stored ("base") series each comes from:
// 1w is resampled from 1d, 1h from 15m (or 5m). Pure.

export const TIMEFRAMES = ["1d", "1w", "1h", "15m", "5m"] as const;
export type Tf = (typeof TIMEFRAMES)[number];
export type BaseTf = "1d" | "15m" | "5m";

export const isTf = (value: string): value is Tf => (TIMEFRAMES as readonly string[]).includes(value);

export interface BaseSpec {
  resolution: Resolution;
  barMs: number;
  daily: boolean;
  /** How far back the broker serves this resolution (days). */
  windowDays: number;
  /** While a bar is forming, a stored copy younger than this is served as is. */
  freshMs: number;
}

export const BASE: Record<BaseTf, BaseSpec> = {
  "1d": { resolution: "D", barMs: DAY_MS, daily: true, windowDays: 5 * 365 - 3, freshMs: 15 * MINUTE_MS },
  "15m": { resolution: "15", barMs: 15 * MINUTE_MS, daily: false, windowDays: 4 * 90, freshMs: MINUTE_MS },
  "5m": { resolution: "5", barMs: 5 * MINUTE_MS, daily: false, windowDays: 4 * 90, freshMs: MINUTE_MS },
};

/** A daily bar is final once this many minutes after IST midnight have passed (well after the 15:30 close). */
export const DAILY_FINAL_MIN = 16 * 60;

/** The IST date a bar of `tf` belongs to. */
export const dayOf = (tf: BaseTf, t: number) => (BASE[tf].daily ? t : istDayKey(t));

/** Where an IST date starts on `tf`'s time axis. */
export const dayStartT = (tf: BaseTf, day: number) => (BASE[tf].daily ? day : istDayStart(day));

/**
 * Exclusive bound of the bars that are final at `now`: every bar starting
 * before it has closed. Weekends count as closed; exchange holidays aren't known.
 */
export function finalBefore(tf: BaseTf, now: number): number {
  const { day, minutes } = istParts(now);
  if (BASE[tf].daily) {
    const lastFinal = isWeekday(day) && minutes >= DAILY_FINAL_MIN ? day : weekdayOnOrBefore(day - DAY_MS);
    return lastFinal + DAY_MS;
  }
  if (isWeekday(day) && minutes >= SESSION_OPEN_MIN && minutes < SESSION_CLOSE_MIN) {
    const barMs = BASE[tf].barMs;
    return Math.floor(now / barMs) * barMs;
  }
  const lastSession = isWeekday(day) && minutes >= SESSION_CLOSE_MIN ? day : weekdayOnOrBefore(day - DAY_MS);
  return istDayStart(lastSession) + SESSION_CLOSE_MIN * MINUTE_MS;
}

/** A bar of `tf` may be forming now (so a stored copy goes stale). */
export function formingNow(tf: BaseTf, now: number): boolean {
  const { day, minutes } = istParts(now);
  return isWeekday(day) && minutes >= SESSION_OPEN_MIN && minutes < (BASE[tf].daily ? DAILY_FINAL_MIN : SESSION_CLOSE_MIN);
}

/** Earliest bar start the broker serves for `tf` at `now`. */
export function windowStart(tf: BaseTf, now: number): number {
  return dayStartT(tf, istDayKey(now) - BASE[tf].windowDays * DAY_MS);
}
