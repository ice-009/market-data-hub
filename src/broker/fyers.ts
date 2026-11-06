import type { FyersConfig, Secrets } from "../config.js";
import type { Logger } from "../log.js";
import { DAY_MS, isoDay, istDayKey } from "../time.js";
import type { Priority } from "./budget.js";
import { BrokerError } from "./errors.js";
import type { FyersAuth } from "./fyersAuth.js";
import { BudgetExhaustedError, type BrokerGate } from "./gate.js";
import { toFyersSymbol } from "./symbols.js";

// Fyers Data API: history only in H1 (quotes and the live socket arrive in H2).
// Every call goes through the request budget (./gate.ts). A 429 is never
// retried: it counts a strike and pauses everything, because Fyers blocks the
// account for the day after repeated per-minute breaches.
//
// Limits verified against a live account (in Tradex, where this was ported
// from): daily ("D") requests may not span more than 366 days; intraday spans
// are kept at 90 days; the Standard plan serves 5 years of daily and about a
// year of intraday history, and a request starting earlier fails with 422.

export type Resolution = "D" | "60" | "15" | "5" | "1";

export const CHUNK_DAYS: Record<"daily" | "intraday", number> = { daily: 365, intraday: 90 };

/** A bar: start time (daily bars: IST day key), OHLC and volume. */
export interface Bar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface HistoryResult {
  bars: Bar[];
  /** Earliest day (key) from which the result is complete through `toDay`. */
  coveredFromDay: number;
  /** False when a request failed part-way (the older part is still missing). */
  complete: boolean;
}

/** Day ranges (inclusive day keys) of at most `maxDays` + 1 dates each, newest first. Pure. */
export function planChunks(fromDay: number, toDay: number, maxDays: number): Array<{ from: number; to: number }> {
  const chunks: Array<{ from: number; to: number }> = [];
  for (let to = toDay; to >= fromDay; ) {
    const from = to - maxDays * DAY_MS;
    chunks.push({ from: Math.max(from, fromDay), to });
    to = from - DAY_MS;
  }
  return chunks;
}

type Tuple = [number, number, number, number, number, number?];

/** Fyers candle tuples → bars, oldest first. Daily stamps (IST midnight) become day keys. Pure. */
export function toBars(candles: unknown, daily: boolean): Bar[] {
  if (!Array.isArray(candles)) return [];
  const bars: Bar[] = [];
  for (const raw of candles as Tuple[]) {
    if (!Array.isArray(raw) || raw.length < 5 || raw.slice(0, 5).some((x) => typeof x !== "number" || !Number.isFinite(x))) continue;
    const ms = raw[0] * 1000;
    bars.push({ t: daily ? istDayKey(ms) : ms, o: raw[1], h: raw[2], l: raw[3], c: raw[4], v: typeof raw[5] === "number" ? raw[5] : 0 });
  }
  return bars.sort((a, b) => a.t - b.t);
}

class BeyondWindow extends Error {}

export interface FyersClientOptions {
  fyers: FyersConfig;
  secrets: Secrets;
  auth: FyersAuth;
  gate: BrokerGate;
  log: Logger;
  fetch?: typeof fetch;
}

export class FyersClient {
  private readonly fetch: typeof fetch;

  constructor(private readonly options: FyersClientOptions) {
    this.fetch = options.fetch ?? fetch;
  }

  /**
   * Bars for `symbol` (a hub ticker) over whole IST days `fromDay`…`toDay`, in as
   * few ≤ chunk-size requests as possible, newest chunk first. Throws BrokerError
   * when nothing could be fetched; a failure part-way returns what arrived with
   * `complete: false`. A 422 (older than the plan serves) ends the walk: there's
   * nothing older to fetch.
   */
  async history(symbol: string, resolution: Resolution, fromDay: number, toDay: number, priority: Priority): Promise<HistoryResult> {
    const daily = resolution === "D";
    const chunks = planChunks(fromDay, toDay, CHUNK_DAYS[daily ? "daily" : "intraday"]);
    const bars: Bar[] = [];
    let coveredFromDay = toDay + DAY_MS;
    for (const [index, chunk] of chunks.entries()) {
      try {
        bars.push(...(await this.chunk(toFyersSymbol(symbol), resolution, chunk.from, chunk.to, priority)));
        coveredFromDay = chunk.from;
      } catch (error) {
        if (error instanceof BeyondWindow) return { bars: dedupe(bars), coveredFromDay: fromDay, complete: true };
        if (index === 0) throw error;
        this.options.log.warn("broker history stopped part-way", { symbol, resolution, at: isoDay(chunk.to), error });
        return { bars: dedupe(bars), coveredFromDay, complete: false };
      }
    }
    return { bars: dedupe(bars), coveredFromDay: fromDay, complete: true };
  }

  private async chunk(fyersSymbol: string, resolution: Resolution, fromDay: number, toDay: number, priority: Priority, retried = false): Promise<Bar[]> {
    const token = await this.options.auth.token();
    const query = new URLSearchParams({ symbol: fyersSymbol, resolution, date_format: "1", range_from: isoDay(fromDay), range_to: isoDay(toDay), cont_flag: "1" });
    let release: () => void;
    try {
      release = await this.options.gate.acquire(priority);
    } catch (error) {
      if (error instanceof BudgetExhaustedError) throw new BrokerError(error.message, "budget");
      throw error;
    }
    let response: Response;
    let body: Record<string, unknown> | null;
    try {
      response = await this.fetch(`${this.options.fyers.dataUrl}/history?${query}`, {
        headers: { Authorization: `${this.options.secrets.fyersClientId}:${token}`, Accept: "application/json" },
        signal: AbortSignal.timeout(30_000),
      });
      body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    } catch {
      throw new BrokerError("Couldn't reach the broker.", "network");
    } finally {
      release();
    }

    if (response.status === 429) {
      this.options.gate.rateLimited();
      this.options.log.warn("broker answered 429: strike counted, pausing broker calls", { strikes: this.options.gate.budget.state.strikes });
      throw new BrokerError("The broker rate-limited the hub; broker calls are paused.", "rate_limited");
    }
    if (response.status === 401) {
      this.options.auth.invalidate();
      if (!retried) return this.chunk(fyersSymbol, resolution, fromDay, toDay, priority, true);
      throw new BrokerError("The broker rejected the access token.", "auth");
    }
    if (response.status === 422) throw new BeyondWindow();
    const status = typeof body?.s === "string" ? body.s : null;
    const message = typeof body?.message === "string" ? body.message : "";
    if (body?.code === -300 || /invalid symbol/i.test(message)) throw new BrokerError(`The broker doesn't know ${fyersSymbol}.`, "bad_symbol");
    if (!response.ok) throw new BrokerError(`Broker history failed: HTTP ${response.status}${message ? ` (${message.slice(0, 120)})` : ""}.`, "upstream");
    // Fyers reports many errors as HTTP 200 with { s: "error" }; "no_data" is a genuine empty answer.
    if (status && status !== "ok" && status !== "no_data") throw new BrokerError(`Broker history error${body?.code !== undefined ? ` ${String(body.code)}` : ""}: ${(message || status).slice(0, 120)}.`, "upstream");
    return toBars(body?.candles, resolution === "D");
  }
}

function dedupe(bars: Bar[]): Bar[] {
  const byT = new Map(bars.map((bar) => [bar.t, bar]));
  return [...byT.values()].sort((a, b) => a.t - b.t);
}
