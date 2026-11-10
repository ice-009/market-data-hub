import type { Bar } from "../broker/fyers.js";
import { hourStart, weekStart } from "../history/resample.js";
import type { Tf } from "../history/timeframes.js";
import { MINUTE_MS, istDayKey } from "../time.js";
import type { MinuteBar, Quote } from "./types.js";

// Folding live minutes into stored candles (pure), so /v1/candles is current
// to the minute: the stored forming bar (5m, 15m, 1h, 1d or 1w) is brought up
// to date and bars the store doesn't have yet (today's daily bar, the hours
// since the last sync, the minutes since the last 1m download) are built from minutes.
//
//   - Minutes before the last stored candle's bucket change nothing (stored bars are final).
//   - The last stored candle keeps its open (the broker saw the bucket from its
//     start; live minutes may not have), widens high/low, and takes the newest
//     close. Its volume: the stored volume plus the minutes after `storedAt`
//     when the caller knows when it was stored (the series' syncedAt), else the
//     larger of the stored volume and the minutes' sum.
//   - Later buckets are built from minutes alone.
//   - For 1d, an optional quote (same IST day) is the day's own open, high,
//     low, close and cumulative volume — exact even when the hub missed minutes.
//
// Buckets match src/history/resample.ts: 1m/5m/15m on the clock (IST and UTC agree
// on those boundaries), hours from 09:15 IST, days by IST day key, weeks from Monday.

export function bucketOf(tf: Tf, t: number): number {
  switch (tf) {
    case "1m":
      return Math.floor(t / MINUTE_MS) * MINUTE_MS;
    case "5m":
      return Math.floor(t / (5 * MINUTE_MS)) * 5 * MINUTE_MS;
    case "15m":
      return Math.floor(t / (15 * MINUTE_MS)) * 15 * MINUTE_MS;
    case "1h":
      return hourStart(t);
    case "1d":
      return istDayKey(t);
    case "1w":
      return weekStart(istDayKey(t));
  }
}

export interface MergeOptions {
  /** When the last stored candle was fetched (series syncedAt): minutes ending before it are already in it. */
  storedAt?: number;
  /** The latest quote, for today's daily bar (1d only). */
  quote?: Quote | null;
}

/**
 * Stored candles of `tf` (oldest first) with the live minutes folded in.
 * Returns a new array; stored candles other than the last are passed through
 * untouched (extra fields such as delivery % included).
 */
export function mergeMinutes<T extends Bar>(tf: Tf, candles: T[], minutes: MinuteBar[], options: MergeOptions = {}): Array<T | Bar> {
  const out: Array<T | Bar> = [...candles];
  const last = candles.length ? candles[candles.length - 1] : null;
  const sorted = minutes.filter((bar) => Number.isFinite(bar.c)).sort((a, b) => a.t - b.t);

  // Group the minutes that matter into buckets.
  const buckets = new Map<number, MinuteBar[]>();
  for (const bar of sorted) {
    const t = bucketOf(tf, bar.t);
    if (last && t < last.t) continue;
    const list = buckets.get(t);
    if (list) list.push(bar);
    else buckets.set(t, [bar]);
  }

  for (const [t, list] of buckets) {
    if (last && t === last.t) {
      out[out.length - 1] = updateLast(last, list, options.storedAt);
    } else {
      out.push({ t, o: list[0].o, h: Math.max(...list.map((bar) => bar.h)), l: Math.min(...list.map((bar) => bar.l)), c: list[list.length - 1].c, v: sum(list) });
    }
  }

  if (tf === "1d" && options.quote) applyQuote(out, options.quote, last?.t ?? null);
  return out;
}

const sum = (bars: MinuteBar[]) => bars.reduce((total, bar) => total + bar.v, 0);

function updateLast<T extends Bar>(stored: T, minutes: MinuteBar[], storedAt: number | undefined): T {
  const merged = { ...stored };
  merged.h = Math.max(stored.h, ...minutes.map((bar) => bar.h));
  merged.l = Math.min(stored.l, ...minutes.map((bar) => bar.l));
  if (storedAt !== undefined) {
    // Only minutes still forming (or later) when the candle was stored are news.
    const after = minutes.filter((bar) => bar.t + MINUTE_MS > storedAt);
    if (after.length) {
      merged.c = after[after.length - 1].c;
      merged.v = stored.v + sum(after.filter((bar) => bar.t >= storedAt));
    }
  } else {
    merged.c = minutes[minutes.length - 1].c;
    merged.v = Math.max(stored.v, sum(minutes));
  }
  return merged;
}

/** The quote's day is the last bar (or a new one): its day fields are exact. */
function applyQuote(out: Bar[], quote: Quote, lastStoredT: number | null) {
  if (!Number.isFinite(quote.ltp) || quote.ltp <= 0) return;
  const day = istDayKey(quote.ltt > 0 ? quote.ltt : quote.ts);
  if (lastStoredT !== null && day < lastStoredT) return;
  const index = out.findIndex((bar) => bar.t === day);
  const current = index >= 0 ? out[index] : null;
  const bar: Bar = {
    ...(current ?? {}),
    t: day,
    o: quote.open > 0 ? quote.open : (current?.o ?? quote.ltp),
    h: Math.max(quote.high > 0 ? quote.high : quote.ltp, current?.h ?? -Infinity, quote.ltp),
    l: Math.min(quote.low > 0 ? quote.low : quote.ltp, current?.l ?? Infinity, quote.ltp),
    c: quote.ltp,
    v: Math.max(quote.volume || 0, current?.v ?? 0),
  };
  if (index >= 0) out[index] = bar;
  else if (!out.length || out[out.length - 1].t < day) out.push(bar);
}
