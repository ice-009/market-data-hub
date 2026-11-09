import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createKey } from "../src/auth/keys.js";
import type { DataSocket, DataSocketEvents } from "../src/broker/fyersSocket.js";
import type { FeedTimers } from "../src/live/feed.js";
import type { MinuteBar, Tick } from "../src/live/types.js";
import { writeBars } from "../src/history/store.js";
import { DAY_MS, MINUTE_MS, istDayStart } from "../src/time.js";
import { ist, makeHub, type TestHub } from "./support/hub.js";
import { ACCESS_TOKEN, startMockFyers, type MockFyers } from "./support/mockFyers.js";
import { SseReader, type SseEvent } from "./support/sse.js";

// The user's key requirement, end to end: when the hub goes down and comes
// back, it loads what it had and carries on — subscriptions resume by
// themselves, last quotes are served at once, the minutes missed while down are
// repaired from broker 1-minute history, and a reconnecting stream client gets
// a snapshot and a replay of what it missed, then live ticks.
//
// Two hub instances run in turn on one data directory, in process: the broker
// is the mock HTTP server (test/support/mockFyers.ts) plus a fake socket, and
// time is virtual — the feed's timers and recovery's waits advance a fake
// clock, so minutes pass instantly. Nothing reaches the real broker.

/** Virtual time: a clock plus the feed's timers, fired in order as time advances. */
class VirtualTime implements FeedTimers {
  private queue: Array<{ id: number; at: number; callback: () => void }> = [];
  private seq = 0;
  constructor(public now: number) {}
  readonly clock = () => this.now;
  setTimeout(callback: () => void, ms: number) {
    const id = ++this.seq;
    this.queue.push({ id, at: this.now + ms, callback });
    return id;
  }
  clearTimeout(handle: unknown) {
    this.queue = this.queue.filter((timer) => timer.id !== handle);
  }
  advance(ms: number) {
    const target = this.now + ms;
    for (;;) {
      const due = this.queue.filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.queue = this.queue.filter((timer) => timer !== due);
      this.now = Math.max(this.now, due.at);
      due.callback();
    }
    this.now = target;
  }
}

/** Stand-in for the broker's data socket: records subscriptions; the test pushes ticks. */
class FakeSocket implements DataSocket {
  readonly subscribed = new Set<string>();
  connected = false;
  closed = false;
  private readonly listeners: { [E in keyof DataSocketEvents]: Array<DataSocketEvents[E]> } = { connect: [], message: [], error: [], close: [] };
  constructor(private readonly time: VirtualTime) {}
  connect() {
    queueMicrotask(() => {
      if (this.closed) return;
      this.connected = true;
      this.listeners.connect.forEach((listener) => listener());
    });
  }
  subscribe(symbols: string[]) {
    symbols.forEach((symbol) => this.subscribed.add(symbol));
  }
  unsubscribe(symbols: string[]) {
    symbols.forEach((symbol) => this.subscribed.delete(symbol));
  }
  close() {
    this.closed = true;
    this.connected = false;
  }
  on<E extends keyof DataSocketEvents>(event: E, listener: DataSocketEvents[E]) {
    this.listeners[event].push(listener);
  }
  tick(symbol: string, ltp: number, volume: number): Tick {
    const now = this.time.now;
    const tick: Tick = { symbol, ltp, ch: 1, chp: 0.1, open: ltp - 5, high: ltp + 5, low: ltp - 10, prevClose: ltp - 1, volume, ltt: now, ts: now, source: "socket" };
    this.listeners.message.forEach((listener) => listener(tick));
    return tick;
  }
}

/** Let promise chains and I/O callbacks run (socket connects, route handlers). */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** The mock broker's close for a minute bar: distinct per minute, so a repaired minute is recognisable. */
const priceAt = (t: number) => 100 + Math.floor(t / MINUTE_MS) % 1000 / 10;

const MON = (hour: number, minute: number, second = 0) => ist(2026, 11, 9, hour, minute) + second * 1000; // Monday 9 Nov 2026, IST

let mock: MockFyers;
let dir: string;
const hubs: TestHub[] = [];
beforeAll(async () => {
  mock = await startMockFyers();
  mock.price = (_symbol, t) => priceAt(t);
});
afterAll(() => mock.close());
afterEach(() => {
  for (const hub of hubs.splice(0)) hub.cleanup();
  rmSync(dir, { recursive: true, force: true });
  mock.history.length = 0;
});

function bootHub(time: VirtualTime, sockets: FakeSocket[]) {
  const t = makeHub({
    dir,
    env: { ...mock.env, HUB_LIVE_SYMBOLS: "NIFTY", HUB_FETCH_WAIT_MS: "5000" },
    clock: time.clock,
    live: {
      socket: async () => {
        const socket = new FakeSocket(time);
        sockets.push(socket);
        return socket;
      },
      feedTimers: time,
      // Silence never trips the watchdog or polling here: the scenario is about restarts.
      feedTuning: { socketSilentMs: DAY_MS, symbolSilentMs: DAY_MS, pollEveryMs: 60 * MINUTE_MS },
      // Recovery's waits (for a minute to close, 4 s between calls) pass in virtual time.
      sleep: async (ms) => {
        await settle();
        time.advance(ms);
      },
      flushTimer: false,
    },
  });
  hubs.push(t);
  return t;
}

async function recoveryIdle(t: TestHub) {
  await vi.waitFor(() => expect(t.hub.live.recovery!.status().running).toBe(false), { timeout: 5_000, interval: 5 });
}

const minuteHistoryCalls = () => mock.history.filter((call) => call.resolution === "1");

describe.each([
  ["a clean shutdown", true],
  ["a crash (nothing flushed after the last periodic write)", false],
])("restart after %s", (_name, graceful) => {
  it("resumes subscriptions, serves stored quotes, repairs the gap, replays to streams and keeps candles current", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "hub-e2e-"));
    const time = new VirtualTime(MON(10, 0));
    // A valid broker token, as a morning login would have left (the mock checks TOTP against real time).
    writeFileSync(path.join(dir, "fyers-token.json"), JSON.stringify({ accessToken: ACCESS_TOKEN, fetchedAt: time.now }));

    // ── First run, 10:00 IST ────────────────────────────────────────────────
    const socketsA: FakeSocket[] = [];
    const a = bootHub(time, socketsA);
    const appA = a.app();
    const { key } = createKey(a.db, "e2e", ["admin"]);
    const auth = { authorization: `Bearer ${key}` };
    a.hub.live.start();
    await settle();
    expect(socketsA).toHaveLength(1);
    expect([...socketsA[0].subscribed]).toEqual(["NIFTY"]); // HUB_LIVE_SYMBOLS, no client needed
    await recoveryIdle(a); // first start: today's session so far for NIFTY

    const pin = await appA.request("/v1/live/pin", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ symbols: ["SBIN", "INFY"] }) });
    expect(await pin.json()).toEqual({ persistentSymbols: ["NIFTY", "INFY", "SBIN"], added: ["SBIN", "INFY"] });
    await recoveryIdle(a); // new pins: their session so far
    expect([...socketsA[0].subscribed].sort()).toEqual(["INFY", "NIFTY", "SBIN"]);
    const callsA = minuteHistoryCalls();
    expect(callsA.map((call) => call.symbol)).toEqual(["NSE:NIFTY50-INDEX", "NSE:SBIN-EQ", "NSE:INFY-EQ"]);
    expect(a.hub.gate!.snapshot().byPriority.background).toBe(3);

    time.now = MON(10, 2, 20);
    const streamA = SseReader.of(await appA.request("/v1/stream?symbols=SBIN,INFY", { headers: auth }));
    const preambleA = await streamA.until(4);
    expect(preambleA.map((event) => event.event)).toEqual(["status", "snapshot", "bars", "bars"]);
    expect(preambleA[1].data).toEqual({ quotes: [], missing: ["SBIN", "INFY"] });
    const sbinBarsA = preambleA[2].data as { symbol: string; bars: MinuteBar[] };
    expect(sbinBarsA.bars).toHaveLength(47); // 09:15 … 10:01, from the broker
    expect(sbinBarsA.bars.every((bar) => bar.source === "broker")).toBe(true);

    time.now = MON(10, 2, 30);
    socketsA[0].tick("SBIN", 801, 1_000);
    socketsA[0].tick("INFY", 1501, 5_000);
    socketsA[0].tick("NIFTY", 24_001, 0);
    expect((await streamA.until(2)).map((event) => (event.data as Tick).symbol).sort()).toEqual(["INFY", "SBIN"]);
    time.now = MON(10, 2, 31);
    a.hub.live.store.flushDue(); // the store's periodic write
    time.now = MON(10, 3, 10);
    socketsA[0].tick("SBIN", 802, 1_500);
    await streamA.until(1);
    time.now = MON(10, 3, 40);
    socketsA[0].tick("SBIN", 803, 1_800);
    const [lastTickA] = await streamA.until(1);
    expect(lastTickA).toMatchObject({ event: "tick", id: String(MON(10, 3, 40)), data: { symbol: "SBIN", ltp: 803 } });

    // ── Down: a clean stop (final flush) or a crash (ticks since 10:02:31 lost) ──
    await a.hub.live.stop({ flush: graceful });
    expect(await streamA.chunk()).toEqual([]); // the stream ended
    a.db.close();
    time.now = MON(10, 10, 40); // seven minutes later

    // ── Second run, same data directory ─────────────────────────────────────
    const socketsB: FakeSocket[] = [];
    const b = bootHub(time, socketsB);
    const appB = b.app();
    const historyBefore = mock.history.length;
    const budgetBefore = b.hub.gate!.snapshot().byPriority.background;

    // Before the feed is even running: the last quotes come straight from the database.
    const quotes = (await (await appB.request("/v1/quotes?symbols=SBIN,INFY", { headers: auth })).json()) as { quotes: Array<Tick & { stale: boolean }> };
    expect(quotes.quotes.map((quote) => [quote.symbol, quote.ltp, quote.source, quote.stale])).toEqual([
      ["SBIN", graceful ? 803 : 801, "store", true],
      ["INFY", 1501, "store", true],
    ]);
    expect(mock.history.length).toBe(historyBefore);

    b.hub.live.start();
    await settle();
    // The persistent set is resubscribed upstream without any client.
    expect(socketsB).toHaveLength(1);
    expect(socketsB[0].connected).toBe(true);
    expect([...socketsB[0].subscribed].sort()).toEqual(["INFY", "NIFTY", "SBIN"]);

    // Recovery fetches the missed minutes from broker 1-minute history.
    await recoveryIdle(b);
    const repairCalls = mock.history.slice(historyBefore);
    expect(repairCalls.map((call) => [call.symbol, call.resolution, call.from, call.to])).toEqual([
      ["NSE:NIFTY50-INDEX", "1", "2026-11-09", "2026-11-09"],
      ["NSE:INFY-EQ", "1", "2026-11-09", "2026-11-09"],
      ["NSE:SBIN-EQ", "1", "2026-11-09", "2026-11-09"],
    ]);
    expect(b.hub.gate!.snapshot().byPriority.background - budgetBefore).toBe(3); // through the request budget
    const gapStart = graceful ? MON(10, 3) : MON(10, 2); // the minute of the last tick that was stored
    const repaired = b.hub.live.store.minuteBars("SBIN", gapStart, MON(10, 11));
    expect(repaired.map((bar) => bar.t)).toEqual(Array.from({ length: (MON(10, 11) - gapStart) / MINUTE_MS }, (_, i) => gapStart + i * MINUTE_MS));
    expect(repaired.every((bar) => bar.source === "broker" && bar.c === priceAt(bar.t))).toBe(true);
    expect(b.hub.live.recovery!.status()).toMatchObject({ running: false, pending: 0, last: { reason: "start", calls: 3, failed: 0 } });

    // A stream client reconnecting with Last-Event-ID: snapshot, then a replay covering the gap, then live ticks.
    const streamB = SseReader.of(await appB.request("/v1/stream?symbols=SBIN", { headers: { ...auth, "last-event-id": lastTickA.id! } }));
    const [status, snapshot, bars] = await streamB.until(3);
    expect(status).toMatchObject({ event: "status", data: { mode: "socket", socket: "connected" } });
    expect(snapshot.data).toMatchObject({ quotes: [{ symbol: "SBIN", ltp: graceful ? 803 : 801, source: "store", stale: true }], missing: [] });
    const replay = (bars.data as { from: number; bars: MinuteBar[] }).bars;
    expect((bars.data as { from: number }).from).toBe(MON(10, 3));
    expect(replay.map((bar) => bar.t)).toEqual(Array.from({ length: 8 }, (_, i) => MON(10, 3 + i)));
    expect(replay.every((bar) => bar.source === "broker")).toBe(true);
    time.now = MON(10, 11, 10);
    socketsB[0].tick("SBIN", 812.5, 9_000);
    const [live] = await streamB.until(1);
    expect(live).toMatchObject({ event: "tick", id: String(MON(10, 11, 10)), data: { symbol: "SBIN", ltp: 812.5, source: "socket" } });

    // Quotes now come from the running feed, without a broker call.
    const fresh = (await (await appB.request("/v1/quotes?symbols=SBIN", { headers: auth })).json()) as { quotes: Tick[] };
    expect(fresh.quotes[0]).toMatchObject({ symbol: "SBIN", ltp: 812.5, source: "socket", stale: false });

    // Candles are current to the minute. With the broker's 5m history unavailable they're built
    // from the stored minutes alone — the repaired ones included.
    mock.until = time.clock;
    mock.failNext(500);
    const fallback = await appB.request("/v1/candles?symbol=SBIN&tf=5m&from=2026-11-09&to=2026-11-09", { headers: auth });
    expect(fallback.status).toBe(503);
    const fallbackBody = (await fallback.json()) as { liveThrough: number; candles: Array<{ t: number; c: number; v: number }> };
    expect(fallbackBody.candles.map((bar) => bar.t)).toEqual(Array.from({ length: 12 }, (_, i) => MON(9, 15 + 5 * i)));
    expect(fallbackBody.candles.find((bar) => bar.t === MON(10, 5))).toMatchObject({ c: priceAt(MON(10, 9)), v: 5_000 });
    expect(fallbackBody.candles.at(-1)!.c).toBe(812.5);
    expect(fallbackBody.liveThrough).toBe(MON(10, 11));
    // With the broker's history: its forming 10:10 bar, brought up to the live tick.
    time.now += 5_000; // the broker gate paces calls by (virtual) time
    const ok = await appB.request("/v1/candles?symbol=SBIN&tf=5m&from=2026-11-09&to=2026-11-09", { headers: auth });
    expect(ok.status).toBe(200);
    const okBody = (await ok.json()) as { candles: Array<{ t: number; c: number }> };
    expect(okBody.candles.at(-1)).toMatchObject({ t: MON(10, 10), c: 812.5 });
    time.now += 5_000;
    const daily = (await (await appB.request("/v1/candles?symbol=SBIN&tf=1d&from=2026-11-02&to=2026-11-09", { headers: auth })).json()) as { candles: Array<{ t: number; c: number; v: number }> };
    expect(daily.candles.at(-1)).toMatchObject({ t: Date.UTC(2026, 10, 9), c: 812.5, v: 9_000 });

    // /v1/status reports it all.
    const statusBody = (await (await appB.request("/v1/status", { headers: auth })).json()) as { live: Record<string, unknown> };
    expect(statusBody.live).toMatchObject({
      enabled: true,
      running: true,
      feed: { mode: "socket", socket: "connected" },
      persistentSymbols: ["NIFTY", "INFY", "SBIN"],
      streams: 1,
      recovery: { pending: 0, last: { reason: "start", calls: 3 } },
      store: { previousRun: { lastTickAt: graceful ? MON(10, 3, 40) : MON(10, 2, 30) } },
    });
    await streamB.cancel();
  });
});

describe("a process without the broker", () => {
  it("serves stored quotes and bars read-only and reports the feed down", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "hub-e2e-"));
    const time = new VirtualTime(MON(10, 0));
    // Something stored by an earlier run.
    const first = makeHub({ dir, env: { ...mock.env }, clock: time.clock, live: { socket: null, flushTimer: false } });
    hubs.push(first);
    first.hub.live.store.pin(["SBIN"]);
    first.hub.live.store.record([{ symbol: "SBIN", ltp: 800, ch: 0, chp: 0, open: 800, high: 800, low: 800, prevClose: 800, volume: 10, ltt: MON(9, 30), ts: MON(9, 30), source: "socket" }]);
    first.hub.live.store.flush();
    first.db.close();

    // No broker credentials (or HUB_LIVE=off): nothing is started, nothing is called.
    const t = makeHub({ dir, clock: time.clock, owner: false });
    hubs.push(t);
    t.hub.live.start(); // a no-op without a broker
    const app = t.app();
    const { key } = createKey(t.db, "ro", ["live"]);
    const headers = { authorization: `Bearer ${key}` };
    const quotes = (await (await app.request("/v1/quotes?symbols=SBIN", { headers })).json()) as { quotes: Tick[]; reason: string };
    expect(quotes).toMatchObject({ quotes: [{ symbol: "SBIN", ltp: 800, source: "store", stale: true }], reason: "not_configured" });
    const stream = SseReader.of(await app.request(`/v1/stream?symbols=SBIN&since=${MON(9, 15)}`, { headers }));
    const events: SseEvent[] = await stream.until(3);
    expect(events[0]).toMatchObject({ event: "status", data: { mode: "down", socket: "disabled" } });
    expect(events[1].data).toMatchObject({ quotes: [{ symbol: "SBIN", ltp: 800 }] });
    expect((events[2].data as { bars: MinuteBar[] }).bars).toEqual([expect.objectContaining({ t: MON(9, 30), c: 800, source: "live" })]);
    const status = (await (await app.request("/v1/status", { headers })).json()) as { live: Record<string, unknown> };
    expect(status.live).toMatchObject({ enabled: false, running: false, feed: { mode: "down" }, persistentSymbols: ["SBIN"], recovery: null });
    await stream.cancel();
    expect(mock.history).toHaveLength(0);
  });
});

describe("/v1/candles with live minutes", () => {
  it("brings every timeframe up to the minute from stored candles plus live and repaired minutes", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "hub-e2e-"));
    const now = MON(10, 11, 30);
    const t = makeHub({ dir, clock: () => now }); // no broker: candles come from the store alone
    hubs.push(t);
    const bar = (time: number, c: number, v = 100) => ({ t: time, o: c, h: c + 1, l: c - 1, c, v });
    // History synced at 10:07: 5m and 15m bars through the forming 10:05 / 10:00 bar, daily bars through Friday.
    const dayFrom = istDayStart(Date.UTC(2026, 9, 1));
    writeBars(t.db, "SBIN", "5m", Array.from({ length: 11 }, (_, i) => bar(MON(9, 15 + 5 * i), 150 + i)), { from: dayFrom, to: MON(10, 5) }, MON(10, 7));
    writeBars(t.db, "SBIN", "15m", Array.from({ length: 4 }, (_, i) => bar(MON(9, 15 + 15 * i), 150 + i)), { from: dayFrom, to: MON(10, 0) }, MON(10, 7));
    const days = [2, 3, 4, 5, 6].map((d) => Date.UTC(2026, 10, d));
    writeBars(t.db, "SBIN", "1d", days.map((day, i) => bar(day, 140 + i, 1_000_000)), { from: Date.UTC(2026, 9, 1), to: Date.UTC(2026, 10, 7) }, MON(10, 7));
    // Minutes since: repaired from the broker (10:05–10:10), then a live tick in the forming 10:11 minute.
    t.hub.live.store.writeBrokerBars(Array.from({ length: 6 }, (_, i): MinuteBar => ({ symbol: "SBIN", ...bar(MON(10, 5 + i), 800 + i, 10), source: "broker" })));
    t.hub.live.store.record([{ symbol: "SBIN", ltp: 812.5, ch: 0, chp: 0, open: 780, high: 815, low: 770, prevClose: 790, volume: 2_500_000, ltt: MON(10, 11, 20), ts: MON(10, 11, 20), source: "socket" }]);

    const app = t.app();
    const { key } = createKey(t.db, "c", ["history"]);
    const candles = async (tf: string, from: string) => (await (await app.request(`/v1/candles?symbol=SBIN&tf=${tf}&from=${from}&to=2026-11-09`, { headers: { authorization: `Bearer ${key}` } })).json()) as { liveThrough: number | null; candles: Array<{ t: number; o: number; h: number; l: number; c: number; v: number }> };

    const m5 = await candles("5m", "2026-11-09");
    expect(m5.liveThrough).toBe(MON(10, 11));
    // The stored forming bar keeps its open, takes the minutes after the sync; the next bucket comes from minutes alone.
    expect(m5.candles.find((c) => c.t === MON(10, 5))).toMatchObject({ o: 160, c: 804, h: 805, v: 100 + 3 * 10 });
    expect(m5.candles.at(-1)).toMatchObject({ t: MON(10, 10), o: 805, c: 812.5 });
    for (const [tf, last] of [["15m", MON(10, 0)], ["1h", MON(9, 15)]] as const) {
      const body = await candles(tf, "2026-11-09");
      expect(body.candles.at(-1), tf).toMatchObject({ t: last, c: 812.5 });
      expect(body.liveThrough, tf).toBe(MON(10, 11));
    }
    // Today's daily bar comes from the latest quote (exact even where minutes are missing); the week from the minutes.
    const d1 = await candles("1d", "2026-11-02");
    expect(d1.candles.map((c) => c.t)).toEqual([...days, Date.UTC(2026, 10, 9)]);
    expect(d1.candles.at(-1)).toMatchObject({ o: 780, h: 815, l: 770, c: 812.5, v: 2_500_000 });
    const w1 = await candles("1w", "2026-11-02");
    expect(w1.candles.map((c) => c.t)).toEqual([Date.UTC(2026, 10, 2), Date.UTC(2026, 10, 9)]);
    expect(w1.candles.at(-1)).toMatchObject({ c: 812.5 });
    // A range that ends before the live minutes is left as stored.
    const past = await app.request("/v1/candles?symbol=SBIN&tf=1d&from=2026-11-02&to=2026-11-06", { headers: { authorization: `Bearer ${key}` } });
    const pastBody = (await past.json()) as { liveThrough: number | null; candles: Array<{ t: number }> };
    expect(pastBody.candles.map((c) => c.t)).toEqual(days);
    expect(pastBody.liveThrough).toBeNull();
  });
});

describe("a server waiting for the owner lock", () => {
  it("answers from the store until it takes over, then starts the feed with everything already wanted", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "hub-e2e-"));
    const time = new VirtualTime(MON(11, 0));
    writeFileSync(path.join(dir, "fyers-token.json"), JSON.stringify({ accessToken: ACCESS_TOKEN, fetchedAt: time.now }));
    const sockets: FakeSocket[] = [];
    const t = bootHub(time, sockets);
    t.hub.owner = false; // a CLI backfill holds the lock
    const app = t.app();
    const { key } = createKey(t.db, "w", ["live"]);
    const headers = { authorization: `Bearer ${key}` };

    const quotes = (await (await app.request("/v1/quotes?symbols=SBIN", { headers })).json()) as { missing: string[]; reason: string };
    expect(quotes).toMatchObject({ missing: ["SBIN"], reason: "not_owner" });
    const stream = SseReader.of(await app.request("/v1/stream?symbols=SBIN", { headers }));
    expect((await stream.until(3))[0]).toMatchObject({ event: "status", data: { mode: "down", socket: "disconnected" } });
    expect(sockets).toHaveLength(0);
    expect(mock.history).toHaveLength(0);

    // What src/server.ts does when the lock frees up.
    t.hub.owner = true;
    t.hub.live.start();
    await settle();
    expect([...sockets[0].subscribed].sort()).toEqual(["NIFTY", "SBIN"]); // config + the open stream
    sockets[0].tick("SBIN", 805, 100);
    expect(await stream.until(1)).toEqual([expect.objectContaining({ event: "tick", data: expect.objectContaining({ ltp: 805 }) })]);
    await recoveryIdle(t);
    expect(minuteHistoryCalls().map((call) => call.symbol)).toEqual(["NSE:NIFTY50-INDEX"]); // the persistent set's session so far
    await stream.cancel();
  });
});
