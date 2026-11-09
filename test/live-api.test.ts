import { afterEach, describe, expect, it } from "vitest";
import { createKey, type Scope } from "../src/auth/keys.js";
import { BrokerError } from "../src/broker/errors.js";
import { BudgetExhaustedError } from "../src/broker/gate.js";
import { liveStatus, type LiveDeps, type LiveLimits } from "../src/http/routes/live.js";
import { Fanout } from "../src/live/fanout.js";
import type { FeedStatus, LiveFeed, LiveStore, MinuteBar, Quote, QuoteFetcher, Tick } from "../src/live/types.js";
import { makeHub, ist, type TestHub } from "./support/hub.js";
import { SseReader, type SseEvent } from "./support/sse.js";

// The live API against fakes of the feed, store and broker quotes: no broker,
// no sockets. Streams are read straight from the Response body, so a test
// controls exactly when the "client" reads — which is how backpressure is shown.

const NOW = ist(2026, 11, 9, 10, 0); // a Monday, 10:00 IST
const SESSION = ist(2026, 11, 9, 9, 15);

class FakeFeed implements LiveFeed {
  subs = new Map<string, Set<string>>();
  calls: string[] = [];
  private tickListeners = new Set<(tick: Tick) => void>();
  current: FeedStatus = { mode: "socket", socket: "connected", socketSymbols: 0, polledSymbols: 0, capacity: 100, lastTickAt: null, reconnects: 0 };
  subscribe(owner: string, symbols: string[]) {
    this.calls.push(`sub ${owner} ${symbols.join(",")}`);
    const set = this.subs.get(owner) ?? new Set();
    symbols.forEach((s) => set.add(s));
    this.subs.set(owner, set);
  }
  unsubscribe(owner: string, symbols?: string[]) {
    this.calls.push(`unsub ${owner}${symbols ? ` ${symbols.join(",")}` : ""}`);
    if (!symbols) this.subs.delete(owner);
    else symbols.forEach((s) => this.subs.get(owner)?.delete(s));
  }
  symbols() {
    return [...new Set([...this.subs.values()].flatMap((s) => [...s]))];
  }
  onTick(listener: (tick: Tick) => void) {
    this.tickListeners.add(listener);
    return () => this.tickListeners.delete(listener);
  }
  onReconnect() {
    return () => {};
  }
  status() {
    return { ...this.current };
  }
  start() {}
  async stop() {}
  emit(tick: Tick) {
    for (const listener of this.tickListeners) listener(tick);
  }
  get listeners() {
    return this.tickListeners.size;
  }
}

class FakeStore implements LiveStore {
  quotes = new Map<string, Quote>();
  bars: MinuteBar[] = [];
  pinned: string[] = [];
  barCalls: { symbol: string; from: number; to: number }[] = [];
  record() {}
  lastQuotes(symbols: string[]) {
    return new Map(symbols.filter((s) => this.quotes.has(s)).map((s) => [s, this.quotes.get(s)!]));
  }
  minuteBars(symbol: string, from: number, to: number) {
    this.barCalls.push({ symbol, from, to });
    return this.bars.filter((b) => b.symbol === symbol && b.t >= from && b.t < to);
  }
  persistentSymbols() {
    return [...this.pinned];
  }
  config: string[] = [];
  setPersistentSymbols(symbols: string[]) {
    this.pinned = [...symbols];
  }
  pin(symbols: string[]) {
    this.pinned.push(...symbols.filter((s) => !this.pinned.includes(s)));
  }
  unpin(symbols: string[]) {
    const kept = symbols.filter((s) => this.config.includes(s));
    this.pinned = this.pinned.filter((s) => !symbols.includes(s) || kept.includes(s));
    return kept;
  }
  flush() {}
}

class FakeQuotes implements QuoteFetcher {
  calls: string[][] = [];
  fail: unknown = null;
  gate: Promise<void> | null = null;
  async quotes(symbols: string[]) {
    this.calls.push(symbols);
    if (this.gate) await this.gate;
    if (this.fail) throw this.fail;
    return symbols.filter((s) => s !== "NOSUCH").map((s) => tick(s, 500, { source: "poll", ts: clockNow }));
  }
}

let clockNow = NOW;
function tick(symbol: string, ltp: number, extra: Partial<Tick> = {}): Tick {
  return { symbol, ltp, ch: 1, chp: 0.2, open: ltp - 1, high: ltp + 1, low: ltp - 2, prevClose: ltp - 1, volume: 1000, ltt: clockNow - 1000, ts: clockNow, source: "socket", ...extra };
}

let t: TestHub;
let close: (() => void) | null = null;
afterEach(() => {
  close?.();
  close = null;
  t?.cleanup();
  clockNow = NOW;
});

function setup(options: { scopes?: Scope[]; limits?: Partial<LiveLimits>; quotes?: FakeQuotes | null } = {}) {
  t = makeHub();
  const feed = new FakeFeed();
  const store = new FakeStore();
  const quotes = options.quotes === undefined ? new FakeQuotes() : options.quotes;
  const deps: LiveDeps = { feed, store, quotes, clock: () => clockNow, limits: options.limits };
  // The hub's app mounts the live routes on these fake deps (its own feed and store are unused).
  const app = t.app({ live: deps });
  close = () => void t.hub.live.stop();
  const { key } = createKey(t.db, "test", options.scopes ?? ["live"]);
  const headers = (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${key}`, ...extra });
  const get = async (path: string) => {
    const res = await app.request(path, { headers: headers() });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, body: (await res.json()) as any };
  };
  const send = async (method: string, path: string, body: unknown) => {
    const res = await app.request(path, { method, headers: headers({ "content-type": "application/json" }), body: typeof body === "string" ? body : JSON.stringify(body) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, body: (await res.json()) as any };
  };
  const stream = (path: string, extra: Record<string, string> = {}, signal?: AbortSignal) => app.request(path, { headers: headers(extra), signal });
  return { feed, store, quotes, deps, app, key, get, send, stream };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("auth and scopes", () => {
  it("needs the live scope for quotes and streams, admin for pins", async () => {
    const { get, send, stream } = setup({ scopes: ["history"] });
    expect((await get("/v1/quotes?symbols=SBIN")).status).toBe(403);
    expect((await stream("/v1/stream?symbols=SBIN")).status).toBe(403);
    const live = setup({ scopes: ["live"] });
    expect((await live.get("/v1/quotes?symbols=SBIN")).status).toBe(200);
    expect((await live.send("POST", "/v1/live/pin", { symbols: ["SBIN"] })).body).toMatchObject({ code: "forbidden" });
    expect((await send("POST", "/v1/live/pin", { symbols: ["SBIN"] })).status).toBe(403);
  });

  it("admin holds every scope; no key is 401", async () => {
    const { get, app } = setup({ scopes: ["admin"] });
    expect((await get("/v1/quotes?symbols=SBIN")).status).toBe(200);
    expect((await app.request("/v1/quotes?symbols=SBIN")).status).toBe(401);
  });
});

describe("GET /v1/quotes", () => {
  it("rejects bad symbol lists", async () => {
    const { get } = setup({ limits: { maxQuoteSymbols: 3 } });
    expect((await get("/v1/quotes")).body).toMatchObject({ code: "bad_request", error: expect.stringMatching(/symbols is required/) });
    expect((await get("/v1/quotes?symbols=,,")).status).toBe(400);
    expect((await get("/v1/quotes?symbols=SBIN,NSE:INFY-EQ")).body.error).toMatch(/Not NSE tickers: NSE:INFY-EQ/);
    expect((await get("/v1/quotes?symbols=A,B,C,D")).body).toMatchObject({ code: "too_many_symbols" });
    expect((await get("/v1/quotes?symbols=a,A,b,c")).status).toBe(200); // de-duplicated to three
  });

  it("serves a fresh live tick without calling the broker", async () => {
    const { feed, quotes, get } = setup();
    feed.emit(tick("SBIN", 800, { ts: NOW - 1000 }));
    const { status, body } = await get("/v1/quotes?symbols=sbin");
    expect(status).toBe(200);
    expect(body).toEqual({ quotes: [expect.objectContaining({ symbol: "SBIN", ltp: 800, source: "socket", ageMs: 1000, stale: false })], missing: [] });
    expect(quotes!.calls).toEqual([]);
  });

  it("fetches what isn't fresh in one batched call and caches it for 3 s", async () => {
    const { feed, quotes, get } = setup();
    feed.emit(tick("SBIN", 800, { ts: NOW - 1000 }));
    feed.emit(tick("INFY", 1500, { ts: NOW - 6000 })); // too old
    const first = await get("/v1/quotes?symbols=SBIN,INFY,TCS");
    expect(quotes!.calls).toEqual([["INFY", "TCS"]]);
    expect(first.body.quotes.map((q: Quote) => [q.symbol, q.source])).toEqual([
      ["SBIN", "socket"],
      ["INFY", "poll"],
      ["TCS", "poll"],
    ]);
    expect(first.body.warning).toBeUndefined();

    clockNow = NOW + 2000;
    const second = await get("/v1/quotes?symbols=TCS");
    expect(quotes!.calls).toHaveLength(1);
    expect(second.body.quotes[0]).toMatchObject({ symbol: "TCS", ageMs: 2000, stale: false });

    clockNow = NOW + 3000;
    await get("/v1/quotes?symbols=TCS");
    expect(quotes!.calls).toEqual([["INFY", "TCS"], ["TCS"]]);
  });

  it("splits large lists into broker-sized batches", async () => {
    const { quotes, get } = setup({ limits: { quoteBatch: 2 } });
    await get("/v1/quotes?symbols=A,B,C,D,E");
    expect(quotes!.calls).toEqual([["A", "B"], ["C", "D"], ["E"]]);
  });

  it("shares one in-flight broker call between concurrent requests", async () => {
    const { quotes, get } = setup();
    let open!: () => void;
    quotes!.gate = new Promise((resolve) => (open = resolve));
    const a = get("/v1/quotes?symbols=SBIN,INFY");
    const b = get("/v1/quotes?symbols=INFY,SBIN");
    await settle();
    open();
    const [ra, rb] = await Promise.all([a, b]);
    expect(quotes!.calls).toEqual([["SBIN", "INFY"]]);
    expect(ra.body.quotes).toHaveLength(2);
    expect(rb.body.quotes.map((q: Quote) => q.symbol)).toEqual(["INFY", "SBIN"]);
  });

  it("falls back to stored quotes marked stale, with a warning, when the broker fails", async () => {
    const { store, quotes, get } = setup();
    store.quotes.set("SBIN", tick("SBIN", 790, { ts: NOW - 3_600_000, source: "socket" }));
    quotes!.fail = new BrokerError("Today's broker data budget is used up.", "budget");
    const { status, body } = await get("/v1/quotes?symbols=SBIN,NEWCO");
    expect(status).toBe(200);
    expect(body.quotes).toEqual([expect.objectContaining({ symbol: "SBIN", ltp: 790, source: "store", ageMs: 3_600_000, stale: true })]);
    expect(body.missing).toEqual(["NEWCO"]);
    expect(body).toMatchObject({ reason: "budget", warning: expect.stringMatching(/budget is used up/) });
  });

  it("names the budget reason for BudgetExhaustedError", async () => {
    const { quotes, get } = setup();
    quotes!.fail = new BudgetExhaustedError("strikes");
    const { body } = await get("/v1/quotes?symbols=SBIN");
    expect(body).toMatchObject({ quotes: [], missing: ["SBIN"], reason: "budget", budget: "strikes" });
  });

  it("answers from the store when the broker is slow, and lists what the broker doesn't know", async () => {
    const { store, quotes, get } = setup({ limits: { quoteWaitMs: 20 } });
    store.quotes.set("SBIN", tick("SBIN", 790));
    quotes!.gate = new Promise(() => {});
    const slow = await get("/v1/quotes?symbols=SBIN");
    expect(slow.body).toMatchObject({ reason: "pending", quotes: [expect.objectContaining({ stale: true })] });

    const fast = setup();
    const { body } = await fast.get("/v1/quotes?symbols=SBIN,NOSUCH");
    expect(body.missing).toEqual(["NOSUCH"]);
  });

  it("without a broker, serves the newest of stored and last live quote", async () => {
    const { feed, store, get } = setup({ quotes: null });
    store.quotes.set("SBIN", tick("SBIN", 790, { ts: NOW - 60_000 }));
    feed.emit(tick("SBIN", 795, { ts: NOW - 30_000 }));
    store.quotes.set("INFY", tick("INFY", 1500, { ts: NOW - 10_000 }));
    feed.emit(tick("INFY", 1490, { ts: NOW - 50_000 }));
    const { body } = await get("/v1/quotes?symbols=SBIN,INFY");
    expect(body.reason).toBe("not_configured");
    expect(body.quotes.map((q: Quote & { stale: boolean }) => [q.symbol, q.ltp, q.source, q.stale])).toEqual([
      ["SBIN", 795, "socket", true],
      ["INFY", 1500, "store", true],
    ]);
  });
});

describe("GET /v1/stream", () => {
  it("sends status → snapshot → bars (from today's session) → ticks, with resumable ids", async () => {
    const { feed, store, stream } = setup();
    store.quotes.set("SBIN", tick("SBIN", 790, { ts: NOW - 60_000 }));
    store.bars.push(
      { symbol: "SBIN", t: SESSION - 60_000, o: 1, h: 1, l: 1, c: 1, v: 1, source: "broker" }, // yesterday's last-minute edge: excluded
      { symbol: "SBIN", t: SESSION, o: 780, h: 792, l: 779, c: 790, v: 500, source: "broker" },
      { symbol: "SBIN", t: SESSION + 60_000, o: 790, h: 791, l: 788, c: 789, v: 300, source: "live" },
    );
    const res = await stream("/v1/stream?symbols=SBIN,INFY");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/event-stream/);
    expect(feed.subs.get([...feed.subs.keys()][0])).toEqual(new Set(["SBIN", "INFY"]));

    const sse = SseReader.of(res);
    const head = await sse.until(4);
    expect(head.map((e) => e.event)).toEqual(["status", "snapshot", "bars", "bars"]);
    expect(head[0]).toMatchObject({ retry: 3000, data: { mode: "socket", socket: "connected" } });
    expect(head[1].data).toEqual({ quotes: [expect.objectContaining({ symbol: "SBIN", ltp: 790, source: "store", ageMs: 60_000, stale: true })], missing: ["INFY"] });
    expect(head[2].data).toEqual({
      symbol: "SBIN",
      from: SESSION,
      to: NOW,
      truncated: false,
      bars: [
        { t: SESSION, o: 780, h: 792, l: 779, c: 790, v: 500, source: "broker" },
        { t: SESSION + 60_000, o: 790, h: 791, l: 788, c: 789, v: 300, source: "live" },
      ],
    });
    expect(head[3].data).toMatchObject({ symbol: "INFY", bars: [] });

    feed.emit(tick("SBIN", 801, { ltt: NOW + 5000 }));
    feed.emit(tick("TCS", 3000)); // not on this stream
    const [live] = await sse.chunk();
    expect(live).toMatchObject({ event: "tick", id: String(NOW + 5000), data: { symbol: "SBIN", ltp: 801 } });

    // Ids never go backwards, even for a quiet symbol whose last trade is older.
    feed.emit(tick("INFY", 1500, { ltt: NOW - 600_000 }));
    expect((await sse.chunk())[0]).toMatchObject({ event: "tick", id: String(NOW + 5000), data: { symbol: "INFY" } });
    await sse.cancel();
  });

  it("replays from Last-Event-ID (winning over since) or since, clamped to the replay window", async () => {
    const { store, stream } = setup({ limits: { maxReplayAgeMs: 3_600_000 } });
    const resume = SESSION + 30 * 60_000 + 25_000;
    await SseReader.of(await stream(`/v1/stream?symbols=SBIN&since=${SESSION}`, { "last-event-id": String(resume) })).cancel();
    expect(store.barCalls.at(-1)).toEqual({ symbol: "SBIN", from: SESSION + 30 * 60_000, to: NOW + 1 });

    await SseReader.of(await stream(`/v1/stream?symbols=SBIN&since=${NOW - 120_000}`)).cancel();
    expect(store.barCalls.at(-1)!.from).toBe(NOW - 120_000);

    await SseReader.of(await stream("/v1/stream?symbols=SBIN&since=2026-11-02")).cancel();
    expect(store.barCalls.at(-1)!.from).toBe(NOW - 3_600_000);

    const bad = await stream("/v1/stream?symbols=SBIN&since=yesterday");
    expect(bad.status).toBe(400);
  });

  it("caps the replay per symbol, keeping the most recent bars", async () => {
    const { store, stream } = setup({ limits: { maxReplayBars: 4 } });
    for (let i = 0; i < 10; i++) for (const symbol of ["A", "B"]) store.bars.push({ symbol, t: SESSION + i * 60_000, o: i, h: i, l: i, c: i, v: i, source: "live" });
    const sse = SseReader.of(await stream("/v1/stream?symbols=A,B"));
    const events = await sse.until(4);
    expect(events[2].data).toMatchObject({ symbol: "A", truncated: true, bars: [{ c: 8 }, { c: 9 }] });
    await sse.cancel();
  });

  it("unsubscribes when the client cancels or the request aborts", async () => {
    const { feed, deps, stream } = setup();
    const sse = SseReader.of(await stream("/v1/stream?symbols=SBIN"));
    await sse.until(3);
    expect(liveStatus(deps).streams).toBe(1);
    await sse.cancel();
    expect(feed.subs.size).toBe(0);
    expect(feed.calls.filter((c) => c.startsWith("unsub stream:"))).toHaveLength(1);
    expect(liveStatus(deps).streams).toBe(0);

    const abort = new AbortController();
    const res = await stream("/v1/stream?symbols=INFY", {}, abort.signal);
    await SseReader.of(res).until(3);
    expect(feed.subs.size).toBe(1);
    abort.abort();
    await settle();
    expect(feed.subs.size).toBe(0);
    expect(liveStatus(deps).streams).toBe(0);
  });

  it("caps symbols per stream and streams per key", async () => {
    const { stream, feed } = setup({ limits: { maxStreamSymbols: 2, maxStreamsPerKey: 2 } });
    const tooMany = await stream("/v1/stream?symbols=A,B,C");
    expect(tooMany.status).toBe(400);
    expect(await tooMany.json()).toMatchObject({ code: "too_many_symbols" });
    expect((await stream("/v1/stream")).status).toBe(400);

    const one = SseReader.of(await stream("/v1/stream?symbols=A"));
    const two = SseReader.of(await stream("/v1/stream?symbols=B"));
    const three = await stream("/v1/stream?symbols=C");
    expect(three.status).toBe(429);
    expect(await three.json()).toMatchObject({ code: "too_many_streams" });
    expect(feed.subs.size).toBe(2); // the refused one never subscribed
    await one.cancel();
    const four = await stream("/v1/stream?symbols=C");
    expect(four.status).toBe(200);
    await SseReader.of(four).cancel();
    await two.cancel();
    expect(feed.subs.size).toBe(0);
  });

  it("coalesces ticks to the latest per symbol while the client isn't reading", async () => {
    const { feed, stream } = setup();
    const sse = SseReader.of(await stream("/v1/stream?symbols=SBIN,INFY"));
    await sse.until(4);
    for (let i = 1; i <= 1000; i++) {
      feed.emit(tick("SBIN", 800 + i, { ltt: NOW + i }));
      if (i % 10 === 0) feed.emit(tick("INFY", 1500 + i, { ltt: NOW + i }));
    }
    const events = await sse.chunk();
    expect(events.map((e) => [e.event, (e.data as Tick).symbol, (e.data as Tick).ltp])).toEqual([
      ["tick", "SBIN", 1800],
      ["tick", "INFY", 2500],
    ]);
    expect(events[1].id).toBe(String(NOW + 1000));
    await sse.cancel();
  });

  it("sends heartbeats and a status event when the feed mode changes", async () => {
    const { feed, stream } = setup({ limits: { heartbeatMs: 20, statusCheckMs: 10 } });
    const sse = SseReader.of(await stream("/v1/stream?symbols=SBIN"));
    await sse.until(3);
    expect((await sse.chunk())[0]).toMatchObject({ event: "comment", comment: expect.stringMatching(/^ping \d+$/) });
    feed.current = { ...feed.current, mode: "polling", socket: "disconnected" };
    let status: SseEvent | undefined;
    while (!status) status = (await sse.chunk()).find((e) => e.event === "status");
    expect(status.data).toMatchObject({ mode: "polling", socket: "disconnected" });
    await sse.cancel();
  });
});

describe("Fanout", () => {
  it("bounds each connection to one tick per symbol and stops timers and listeners on close", async () => {
    const feed = new FakeFeed();
    const fanout = new Fanout(feed, { heartbeatMs: 1000, statusCheckMs: 1000 });
    const slow = fanout.open("c1", "k1", ["SBIN", "INFY"]);
    const fast = fanout.open("c2", "k1", ["SBIN"]);
    expect(fanout.countFor("k1")).toBe(2);
    const reading = fast.next();
    feed.emit(tick("SBIN", 1));
    expect((await reading)!.ticks.map((x) => x.ltp)).toEqual([1]);
    for (let i = 2; i <= 500; i++) feed.emit(tick(i % 2 ? "SBIN" : "INFY", i));
    expect(slow.pending).toBe(2);
    expect(slow.coalesced).toBe(498);
    expect(fanout.latest("INFY")!.ltp).toBe(500);
    fanout.release(slow);
    fanout.release(slow);
    expect(feed.calls.filter((c) => c === "unsub c1")).toHaveLength(1);
    expect((await fast.next())!.ticks.map((x) => x.ltp)).toEqual([499]); // the fast one is coalesced too
    const ended = fast.next();
    fanout.close();
    expect(await ended).toBeNull();
    expect(feed.listeners).toBe(0);
    expect(feed.subs.size).toBe(0);
  });
});

describe("pins and status", () => {
  it("POST/DELETE /v1/live/pin update the persistent set and the feed", async () => {
    const { feed, store, send, deps } = setup({ scopes: ["admin"], limits: { maxPinned: 3 } });
    const pinned: string[][] = [];
    deps.onPinned = (symbols) => pinned.push(symbols);
    store.pinned = ["NIFTY"];
    store.config = ["NIFTY"];
    const pin = await send("POST", "/v1/live/pin", { symbols: ["sbin", "NIFTY", "infy"] });
    expect(pin).toEqual({ status: 200, body: { persistentSymbols: ["NIFTY", "SBIN", "INFY"], added: ["SBIN", "INFY"] } });
    expect(feed.calls).toEqual(["sub persistent SBIN,INFY"]);
    expect(pinned).toEqual([["SBIN", "INFY"]]);
    expect((await send("POST", "/v1/live/pin", { symbols: ["TCS"] })).body).toMatchObject({ code: "too_many_symbols" });

    const unpin = await send("DELETE", "/v1/live/pin", { symbols: ["SBIN", "TCS"] });
    expect(unpin.body).toEqual({ persistentSymbols: ["NIFTY", "INFY"], removed: ["SBIN"], kept: [] });
    expect(feed.calls.at(-1)).toBe("unsub persistent SBIN");
    expect(store.pinned).toEqual(["NIFTY", "INFY"]);

    // A HUB_LIVE_SYMBOLS symbol stays subscribed: the feed isn't told to drop it.
    const config = await send("DELETE", "/v1/live/pin", { symbols: ["NIFTY"] });
    expect(config.body).toEqual({ persistentSymbols: ["NIFTY", "INFY"], removed: [], kept: ["NIFTY"] });
    expect(feed.calls.at(-1)).toBe("unsub persistent SBIN");

    expect((await send("POST", "/v1/live/pin", "not json")).status).toBe(400);
    expect((await send("POST", "/v1/live/pin", { symbols: "SBIN" })).status).toBe(400);
    expect((await send("POST", "/v1/live/pin", { symbols: ["BAD:SYM"] })).status).toBe(400);

    expect(liveStatus(deps)).toEqual({ feed: feed.status(), persistentSymbols: ["NIFTY", "INFY"], quotesCached: 0, streams: 0 });
  });

  it("liveStatus counts cached broker quotes", async () => {
    const { deps, get } = setup();
    await get("/v1/quotes?symbols=SBIN,INFY");
    expect(liveStatus(deps).quotesCached).toBe(2);
    clockNow = NOW + 5000;
    expect(liveStatus(deps).quotesCached).toBe(0);
  });
});
