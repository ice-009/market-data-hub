// NSE calendar helpers (IST). Daily bars are keyed by the "day key": UTC
// midnight of the IST calendar date, so a daily bar's time reads as its trade
// date in any timezone. Intraday bars use the real instant their bar starts.
// Exchange holidays aren't known here; callers learn them from NSE's files.

export const MINUTE_MS = 60_000;
export const DAY_MS = 24 * 60 * MINUTE_MS;
export const IST_OFFSET_MS = 5.5 * 60 * MINUTE_MS;
/** Regular session, minutes after IST midnight. */
export const SESSION_OPEN_MIN = 9 * 60 + 15;
export const SESSION_CLOSE_MIN = 15 * 60 + 30;

export interface IstParts {
  /** Day key of the IST date. */
  day: number;
  /** Minutes since IST midnight. */
  minutes: number;
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
}

export function istParts(time: number = Date.now()): IstParts {
  const ist = new Date(time + IST_OFFSET_MS);
  return {
    day: Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()),
    minutes: ist.getUTCHours() * 60 + ist.getUTCMinutes(),
    weekday: ist.getUTCDay(),
  };
}

/** Day key for a timestamp. */
export const istDayKey = (time: number = Date.now()) => istParts(time).day;

/** The instant an IST date begins (its day key minus 5:30). */
export const istDayStart = (dayKey: number) => dayKey - IST_OFFSET_MS;

export function isWeekday(dayKey: number): boolean {
  const weekday = new Date(dayKey).getUTCDay();
  return weekday !== 0 && weekday !== 6;
}

/** Inside the regular 09:15–15:30 IST session on a weekday. */
export function isMarketOpen(time: number = Date.now()): boolean {
  const { minutes, weekday } = istParts(time);
  return weekday !== 0 && weekday !== 6 && minutes >= SESSION_OPEN_MIN && minutes < SESSION_CLOSE_MIN;
}

/** The weekday on or before `dayKey`. */
export function weekdayOnOrBefore(dayKey: number): number {
  let day = dayKey;
  while (!isWeekday(day)) day -= DAY_MS;
  return day;
}

/** "2026-11-05" for a day key. */
export const isoDay = (dayKey: number) => new Date(dayKey).toISOString().slice(0, 10);

/** "2025-10-29" → day key, or null when it isn't a real date. */
export function parseIsoDay(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const month = Number(match[2]) - 1;
  const t = Date.UTC(Number(match[1]), month, Number(match[3]));
  return Number.isFinite(t) && new Date(t).getUTCMonth() === month && new Date(t).getUTCDate() === Number(match[3]) ? t : null;
}

const MONTHS: Record<string, number> = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

/** "04-Nov-2026" / "4-NOV-2026" → day key, or null. */
export function parseDmyDay(value: string): number | null {
  const match = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(value.trim());
  if (!match) return null;
  const month = MONTHS[match[2].toUpperCase()];
  if (month === undefined) return null;
  const t = Date.UTC(Number(match[3]), month, Number(match[1]));
  return new Date(t).getUTCDate() === Number(match[1]) ? t : null;
}

/** "04-Nov-2026" (or "2026-11-04") → day key. */
export const parseNseDay = (value: string) => parseDmyDay(value) ?? parseIsoDay(value);

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
