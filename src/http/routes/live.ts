import type { Context, Hono } from "hono";
import { BrokerError } from "../../broker/errors.js";
import { BudgetExhaustedError } from "../../broker/gate.js";
import { normalizeSymbol } from "../../broker/symbols.js";
import { Fanout, type FanoutConnection, type FanoutDrain } from "../../live/fanout.js";
import type { LiveFeed, LiveStore, MinuteBar, Quote, QuoteFetcher, Tick } from "../../live/types.js";
import type { Logger } from "../../log.js";
import { DAY_MS, istDayKey, istDayStart, MINUTE_MS, SESSION_OPEN_MIN } from "../../time.js";
import { errorBody, requireScope, type HubEnv } from "../common.js";
import { ParamError, parseTime } from "../params.js";

// Live prices (scope: live; pins need admin):
//   GET    /v1/quotes?symbols=A,B             latest quote per symbol
//   GET    /v1/stream?symbols=A,B[&since=ms]  Server-Sent Events: status → snapshot → bars → ticks
//   POST   /v1/live/pin    { symbols: [...] } keep symbols subscribed across restarts
//   DELETE /v1/live/pin    { symbols: [...] }
//
// Quotes prefer what the one live feed already delivered (< 5 s old); only the
// rest cost a broker call, at user priority, batched, cached for 3 s and shared
// by concurrent requests — so a burst of clients asking for the same symbols is
// one broker call, not many. When the broker can't help, the last stored quote
// is returned marked stale, never an error: a client that has *something*
// (with its age) is better off than one that has a 503.
//
// The stream starts with the stored state (snapshot + minute-bar replay) so a
// client that connects right after a hub restart, or reconnects with
// Last-Event-ID, catches up before live ticks resume. Ticks go through the
// fan-out (src/live/fanout.ts), which coalesces them for slow clients.

export interface LiveLimits {
  /** Most symbols in one /v1/quotes request. */
  maxQuoteSymbols: number;
  /** Most symbols on one stream. */
  maxStreamSymbols: number;
  /** Most open streams per API key. */
  maxStreamsPerKey: number;
  /** Most persistent (pinned) symbols. */
  maxPinned: number;
  /** A live tick younger than this is served as fresh (ms). */
  freshMs: number;
  /** How long a broker quote is reused (ms). */
  quoteCacheMs: number;
  /** Symbols per broker quotes call. */
  quoteBatch: number;
  /** How long /v1/quotes waits for the broker before answering with stored quotes (ms). */
  quoteWaitMs: number;
  heartbeatMs: number;
  statusCheckMs: number;
  /** Most minute bars replayed on connect (shared across the stream's symbols). */
  maxReplayBars: number;
  /** Replay never reaches further back than this (ms). */
  maxReplayAgeMs: number;
  /** EventSource reconnect delay sent to clients (ms). */
  retryMs: number;
}

export const DEFAULT_LIVE_LIMITS: LiveLimits = {
  maxQuoteSymbols: 100,
  maxStreamSymbols: 100,
  maxStreamsPerKey: 5,
  maxPinned: 100,
  freshMs: 5_000,
  quoteCacheMs: 3_000,
  quoteBatch: 50,
  quoteWaitMs: 10_000,
  heartbeatMs: 15_000,
  statusCheckMs: 5_000,
  maxReplayBars: 20_000,
  maxReplayAgeMs: 4 * DAY_MS,
  retryMs: 3_000,
};

export interface LiveDeps {
  feed: LiveFeed;
  store: LiveStore;
  /** Batched REST quotes; null when this process has no broker (not configured / not the owner). */
  quotes: QuoteFetcher | null;
  clock?: () => number;
  limits?: Partial<LiveLimits>;
  log?: Logger;
  /** Called with newly pinned symbols (the hub repairs their session so far from broker history). */
  onPinned?: (symbols: string[]) => void;
}

/** A quote as served: the tick plus its age and whether it came from a fallback. */
export type ServedQuote = Quote & { ageMs: number; stale: boolean };

// ---------------------------------------------------------------- quote cache

interface BatchResult {
  ticks: Tick[];
  error: unknown;
}

interface Batch {
  promise: Promise<BatchResult>;
  result?: BatchResult;
}

class PendingError extends Error {
  constructor() {
    super("The broker hasn't answered yet.");
  }
}

/** Broker quotes cached briefly, with one in-flight call per symbol shared by every request that needs it. */
class QuoteCache {
  private cached = new Map<string, { tick: Tick; at: number }>();
  private inflight = new Map<string, Batch>();

  constructor(
    private fetcher: QuoteFetcher,
    private limits: LiveLimits,
    private clock: () => number,
  ) {}

  /** Cached entries still valid. */
  size(): number {
    this.purge();
    return this.cached.size;
  }

  async get(symbols: string[]): Promise<{ ticks: Map<string, Tick>; error: unknown }> {
    this.purge();
    const now = this.clock();
    const ticks = new Map<string, Tick>();
    const batches = new Set<Batch>();
    const toFetch: string[] = [];
    for (const symbol of symbols) {
      const hit = this.cached.get(symbol);
      const flying = this.inflight.get(symbol);
      if (hit && now - hit.at < this.limits.quoteCacheMs) ticks.set(symbol, hit.tick);
      else if (flying) batches.add(flying);
      else toFetch.push(symbol);
    }
    for (let i = 0; i < toFetch.length; i += this.limits.quoteBatch) batches.add(this.fetch(toFetch.slice(i, i + this.limits.quoteBatch)));

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.limits.quoteWaitMs);
      timer.unref?.();
    });
    await Promise.race([Promise.all([...batches].map((batch) => batch.promise)), timeout]);
    clearTimeout(timer);

    let error: unknown = null;
    const wanted = new Set(symbols);
    for (const batch of batches) {
      if (!batch.result) {
        error ??= new PendingError();
        continue;
      }
      error ??= batch.result.error;
      for (const tick of batch.result.ticks) if (wanted.has(tick.symbol)) ticks.set(tick.symbol, tick);
    }
    return { ticks, error };
  }

  private fetch(symbols: string[]): Batch {
    const batch: Batch = {
      promise: this.fetcher.quotes(symbols, "user").then(
        (ticks) => ({ ticks, error: null }),
        (error: unknown) => ({ ticks: [], error }),
      ),
    };
    batch.promise = batch.promise.then((result) => {
      batch.result = result;
      const at = this.clock();
      for (const tick of result.ticks) this.cached.set(tick.symbol, { tick, at });
      for (const symbol of symbols) if (this.inflight.get(symbol) === batch) this.inflight.delete(symbol);
      return result;
    });
    for (const symbol of symbols) this.inflight.set(symbol, batch);
    return batch;
  }

  private purge() {
    const now = this.clock();
    for (const [symbol, entry] of this.cached) if (now - entry.at >= this.limits.quoteCacheMs) this.cached.delete(symbol);
  }
}

// ---------------------------------------------------------------- shared state

interface LiveState {
  limits: LiveLimits;
  clock: () => number;
  fanout: Fanout;
  cache: QuoteCache | null;
  nextId: number;
}

// Keyed by the deps object, so liveRoutes and liveStatus share one fan-out and cache.
const states = new WeakMap<LiveDeps, LiveState>();

function stateFor(deps: LiveDeps): LiveState {
  let state = states.get(deps);
  if (!state) {
    const limits = { ...DEFAULT_LIVE_LIMITS, ...deps.limits };
    const clock = deps.clock ?? Date.now;
    state = {
      limits,
      clock,
      fanout: new Fanout(deps.feed, { heartbeatMs: limits.heartbeatMs, statusCheckMs: limits.statusCheckMs }),
      cache: deps.quotes ? new QuoteCache(deps.quotes, limits, clock) : null,
      nextId: 1,
    };
    states.set(deps, state);
  }
  return state;
}

/** The live section for GET /v1/status. */
export function liveStatus(deps: LiveDeps) {
  const state = stateFor(deps);
  return {
    feed: deps.feed.status(),
    persistentSymbols: deps.store.persistentSymbols(),
    quotesCached: state.cache?.size() ?? 0,
    streams: state.fanout.size,
  };
}

// ---------------------------------------------------------------- helpers

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string; code: string };

/** "sbin, infy" → ["SBIN", "INFY"]: normalised, de-duplicated, capped. */
export function parseSymbolList(raw: string | string[] | undefined | null, max: number, name = "symbols"): Parsed<string[]> {
  const parts = (Array.isArray(raw) ? raw : (raw ?? "").split(",")).map((part) => (typeof part === "string" ? part.trim() : "")).filter(Boolean);
  if (!parts.length) return { ok: false, error: `${name} is required: comma-separated NSE tickers such as SBIN,INFY,NIFTY (send & as %26).`, code: "bad_request" };
  const bad = parts.filter((part) => !normalizeSymbol(part));
  if (bad.length) return { ok: false, error: `Not NSE tickers: ${bad.slice(0, 5).join(", ")}${bad.length > 5 ? "…" : ""}.`, code: "bad_request" };
  const symbols = [...new Set(parts.map((part) => normalizeSymbol(part)!))];
  if (symbols.length > max) return { ok: false, error: `At most ${max} symbols per request (got ${symbols.length}).`, code: "too_many_symbols" };
  return { ok: true, value: symbols };
}

const serve = (tick: Tick, now: number, stale: boolean): ServedQuote => ({ ...tick, ageMs: Math.max(0, now - tick.ts), stale });

/** The newer of a stored quote and the last live tick seen, as a stale fallback. */
function fallback(stored: Quote | undefined, live: Tick | undefined): Tick | undefined {
  const fromStore = stored ? { ...stored, source: "store" as const } : undefined;
  if (!fromStore) return live;
  if (!live) return fromStore;
  return live.ts > fromStore.ts ? live : fromStore;
}

function describeError(error: unknown): { warning: string; reason: string; budget?: string } {
  if (error instanceof PendingError) return { warning: "The broker is slow to answer; showing stored quotes for the rest. Try again shortly.", reason: "pending" };
  if (error instanceof BudgetExhaustedError) return { warning: `${error.message} Showing stored quotes for the rest.`, reason: "budget", budget: error.reason };
  if (error instanceof BrokerError) return { warning: `The broker is unavailable (${error.message}); showing stored quotes for the rest.`, reason: error.kind };
  return { warning: "The broker quote request failed; showing stored quotes for the rest.", reason: "upstream" };
}

/** Start of today's regular IST session. */
const sessionStart = (now: number) => istDayStart(istDayKey(now)) + SESSION_OPEN_MIN * MINUTE_MS;

function sseEvent(event: string, data: unknown, id?: number): string {
  return `${id !== undefined ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const bar = (b: MinuteBar) => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, source: b.source });

// ---------------------------------------------------------------- routes

export interface LiveRoutes {
  /** Close all streams and stop listening to the feed (shutdown, tests). */
  close(): void;
}

export function liveRoutes(app: Hono<HubEnv>, deps: LiveDeps): LiveRoutes {
  const state = stateFor(deps);
  const { limits, clock, fanout } = state;

  app.get("/v1/quotes", requireScope("live"), async (c) => {
    const parsed = parseSymbolList(c.req.query("symbols"), limits.maxQuoteSymbols);
    if (!parsed.ok) return c.json(errorBody(parsed.error, parsed.code), 400);
    const symbols = parsed.value;

    const found = new Map<string, { tick: Tick; stale: boolean }>();
    let now = clock();
    const need: string[] = [];
    for (const symbol of symbols) {
      const tick = fanout.latest(symbol);
      if (tick && tick.source !== "store" && now - tick.ts < limits.freshMs) found.set(symbol, { tick, stale: false });
      else need.push(symbol);
    }

    let problem: ReturnType<typeof describeError> | null = null;
    if (need.length) {
      if (!state.cache) {
        problem = { warning: "This hub process has no broker connection; showing stored quotes.", reason: "not_configured" };
      } else {
        const answer = await state.cache.get(need);
        for (const [symbol, tick] of answer.ticks) found.set(symbol, { tick, stale: false });
        if (answer.error) {
          problem = describeError(answer.error);
          if (!(answer.error instanceof BrokerError) && !(answer.error instanceof BudgetExhaustedError) && !(answer.error instanceof PendingError)) {
            deps.log?.warn("live quotes failed", { error: answer.error });
          }
        }
      }
    }

    const rest = symbols.filter((symbol) => !found.has(symbol));
    if (rest.length) {
      const stored = deps.store.lastQuotes(rest);
      for (const symbol of rest) {
        const tick = fallback(stored.get(symbol), fanout.latest(symbol));
        if (tick) found.set(symbol, { tick, stale: true });
      }
    }

    now = clock();
    const quotes = symbols.flatMap((symbol) => {
      const hit = found.get(symbol);
      return hit ? [serve(hit.tick, now, hit.stale)] : [];
    });
    const missing = symbols.filter((symbol) => !found.has(symbol));
    return c.json({ quotes, missing, ...(problem ?? {}) });
  });

  app.get("/v1/stream", requireScope("live"), (c) => {
    const parsed = parseSymbolList(c.req.query("symbols"), limits.maxStreamSymbols);
    if (!parsed.ok) return c.json(errorBody(parsed.error, parsed.code), 400);
    const symbols = parsed.value;

    const now = clock();
    let since: number;
    const lastEventId = c.req.header("last-event-id")?.trim();
    try {
      // A reconnecting EventSource repeats the original URL, so Last-Event-ID (where it got to) wins over `since`.
      if (lastEventId && /^\d{1,14}$/.test(lastEventId)) since = Number(lastEventId);
      else since = parseTime("since", c.req.query("since"), "start", false) ?? sessionStart(now);
    } catch (error) {
      if (error instanceof ParamError) return c.json(errorBody(error.message, "bad_request"), 400);
      throw error;
    }

    const key = c.get("apiKey");
    if (fanout.countFor(key.id) >= limits.maxStreamsPerKey) {
      return c.json(errorBody(`At most ${limits.maxStreamsPerKey} open streams per key; close one, or put more symbols on one stream.`, "too_many_streams"), 429, { "Retry-After": "5" });
    }

    // Subscribe before reading the store, so no tick falls between the snapshot and the live stream.
    const connection = fanout.open(`stream:${key.id}:${state.nextId++}`, key.id, symbols);
    let preamble: string;
    try {
      preamble = streamPreamble(deps, state, symbols, since, now);
    } catch (error) {
      fanout.release(connection);
      throw error;
    }
    return c.body(sseBody(c, fanout, connection, preamble), 200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Proxies (nginx, some tunnels) buffer responses unless told not to.
      "X-Accel-Buffering": "no",
    });
  });

  const pinRoute = (action: "pin" | "unpin") => async (c: Context<HubEnv>) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(errorBody('Send a JSON body: { "symbols": ["SBIN", …] }.', "bad_request"), 400);
    }
    const raw = (body as { symbols?: unknown } | null)?.symbols;
    if (!Array.isArray(raw)) return c.json(errorBody('Send a JSON body: { "symbols": ["SBIN", …] }.', "bad_request"), 400);
    const parsed = parseSymbolList(raw as string[], limits.maxPinned);
    if (!parsed.ok) return c.json(errorBody(parsed.error, parsed.code), 400);

    const current = deps.store.persistentSymbols();
    if (action === "pin") {
      const added = parsed.value.filter((symbol) => !current.includes(symbol));
      const next = [...current, ...added];
      if (next.length > limits.maxPinned) return c.json(errorBody(`At most ${limits.maxPinned} pinned symbols (${current.length} pinned now).`, "too_many_symbols"), 400);
      if (added.length) {
        deps.store.pin(added);
        deps.feed.subscribe("persistent", added);
        deps.onPinned?.(added);
      }
      return c.json({ persistentSymbols: deps.store.persistentSymbols(), added });
    }
    // Symbols listed in HUB_LIVE_SYMBOLS can't be unpinned through the API: they stay ("kept").
    const candidates = parsed.value.filter((symbol) => current.includes(symbol));
    const kept = candidates.length ? deps.store.unpin(candidates) : [];
    const removed = candidates.filter((symbol) => !kept.includes(symbol));
    if (removed.length) deps.feed.unsubscribe("persistent", removed);
    return c.json({ persistentSymbols: deps.store.persistentSymbols(), removed, kept });
  };
  app.post("/v1/live/pin", requireScope("admin"), pinRoute("pin"));
  app.delete("/v1/live/pin", requireScope("admin"), pinRoute("unpin"));

  return {
    close: () => {
      fanout.close();
      states.delete(deps);
    },
  };
}

/** status → snapshot → one bars event per symbol, rendered once at connect. */
function streamPreamble(deps: LiveDeps, state: LiveState, symbols: string[], since: number, now: number): string {
  const { limits, fanout } = state;
  let out = `retry: ${limits.retryMs}\n` + sseEvent("status", deps.feed.status());

  const stored = deps.store.lastQuotes(symbols);
  const quotes: ServedQuote[] = [];
  const missing: string[] = [];
  for (const symbol of symbols) {
    const tick = fallback(stored.get(symbol), fanout.latest(symbol));
    if (tick) quotes.push(serve(tick, now, tick.source === "store" || now - tick.ts >= limits.freshMs));
    else missing.push(symbol);
  }
  out += sseEvent("snapshot", { quotes, missing });

  // From the start of the minute `since` falls in: that minute may have changed after the client saw it.
  const from = Math.max(since - (since % MINUTE_MS), now - limits.maxReplayAgeMs);
  const perSymbol = Math.max(1, Math.floor(limits.maxReplayBars / symbols.length));
  for (const symbol of symbols) {
    const bars = from < now ? deps.store.minuteBars(symbol, from, now + 1) : [];
    const truncated = bars.length > perSymbol;
    out += sseEvent("bars", { symbol, from, to: now, truncated, bars: (truncated ? bars.slice(-perSymbol) : bars).map(bar) });
  }
  return out;
}

/** The response body: preamble first, then whatever the fan-out buffered each time the client is ready for more. */
function sseBody(c: Context<HubEnv>, fanout: Fanout, connection: FanoutConnection, preamble: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const signal = c.req.raw.signal;
  let lastId = 0;
  let first: string | null = preamble;

  const release = () => {
    signal.removeEventListener("abort", release);
    fanout.release(connection);
  };
  signal.addEventListener("abort", release, { once: true });

  const render = (drain: FanoutDrain) => {
    let text = "";
    if (drain.status) text += sseEvent("status", drain.status);
    for (const tick of drain.ticks) {
      // Monotonic ids: Last-Event-ID then means "everything up to here", even when a quiet symbol's ltt is older.
      lastId = Math.max(lastId, tick.ltt || tick.ts);
      text += sseEvent("tick", tick, lastId);
    }
    if (drain.heartbeat) text += `: ping ${Date.now()}\n\n`;
    return text;
  };

  // highWaterMark 0: nothing is produced until the HTTP layer pulls, so while a
  // client's socket is backed up, ticks wait (coalesced) in the fan-out buffer.
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (first !== null) {
          controller.enqueue(encoder.encode(first));
          first = null;
          return;
        }
        const drain = await connection.next();
        if (!drain) {
          try {
            controller.close();
          } catch {
            // already cancelled
          }
          return;
        }
        controller.enqueue(encoder.encode(render(drain)));
      },
      cancel: release,
    },
    { highWaterMark: 0 },
  );
}
