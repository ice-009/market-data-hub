import { DAY_MS, istDayKey, istDayStart, parseIsoDay } from "../time.js";

// Query-parameter parsing shared by the routes (pure). Times are accepted as an
// IST date (YYYY-MM-DD) or epoch milliseconds. For daily data a date means that
// trade date (its day key); for intraday data `from` is the start of the IST day
// and `to` its end, so `to=2026-11-05` includes that whole session.

export class ParamError extends Error {}

/** Parse a `from`/`to` value. `daily`: return a day key instead of an instant. */
export function parseTime(name: string, raw: string | undefined, edge: "start" | "end", daily: boolean): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const value = raw.trim();
  if (/^\d{10,14}$/.test(value)) {
    const ms = Number(value);
    return daily ? istDayKey(ms) : ms;
  }
  const day = parseIsoDay(value);
  if (day === null) throw new ParamError(`${name} must be a date (YYYY-MM-DD) or epoch milliseconds.`);
  if (daily) return day;
  return edge === "start" ? istDayStart(day) : istDayStart(day) + DAY_MS - 1;
}

/** A from/to pair with defaults; `from` after `to` is an error. */
export function parseRange(query: { from?: string; to?: string }, daily: boolean, defaultSpanDays: number, now: number): { from: number; to: number } {
  const to = parseTime("to", query.to, "end", daily) ?? (daily ? istDayKey(now) : now);
  const from = parseTime("from", query.from, "start", daily) ?? to - defaultSpanDays * DAY_MS;
  if (from > to) throw new ParamError("from must not be after to.");
  return { from, to };
}
