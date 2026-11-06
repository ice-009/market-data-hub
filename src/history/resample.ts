import type { Bar } from "../broker/fyers.js";
import { DAY_MS, MINUTE_MS, SESSION_OPEN_MIN, istDayStart, istParts } from "../time.js";

// Bigger bars from smaller ones (pure): weekly from daily, hourly from 15- or
// 5-minute. Buckets are aligned the way NSE charts are: weeks start on Monday
// (stamped with Monday's day key even when Monday was a holiday), hours start at
// 09:15 IST (09:15, 10:15 … 15:15, the last one 15 minutes long).

/** Monday's day key for a daily bar's day key. */
export const weekStart = (dayKey: number) => dayKey - ((new Date(dayKey).getUTCDay() + 6) % 7) * DAY_MS;

/** Start of the session-aligned hour that the instant `t` falls in. */
export function hourStart(t: number): number {
  const { day, minutes } = istParts(t);
  const offset = Math.floor((minutes - SESSION_OPEN_MIN) / 60) * 60;
  return istDayStart(day) + (SESSION_OPEN_MIN + offset) * MINUTE_MS;
}

/** Group bars (oldest first) by `bucket(t)` into OHLCV bars. */
export function resample(bars: Bar[], bucket: (t: number) => number): Bar[] {
  const out: Bar[] = [];
  let current: Bar | null = null;
  for (const bar of [...bars].sort((a, b) => a.t - b.t)) {
    const t = bucket(bar.t);
    if (current && current.t === t) {
      current.h = Math.max(current.h, bar.h);
      current.l = Math.min(current.l, bar.l);
      current.c = bar.c;
      current.v += bar.v;
    } else {
      current = { t, o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v };
      out.push(current);
    }
  }
  return out;
}
