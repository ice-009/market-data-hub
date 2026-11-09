import { mkdtempSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_STRIKES_PER_DAY } from "../src/broker/budget.js";
import { BrokerError } from "../src/broker/errors.js";
import { FyersClient, toQuoteTicks } from "../src/broker/fyers.js";
import { FyersAuth } from "../src/broker/fyersAuth.js";
import {
  createFyersSocketFactory,
  describeSocketError,
  fromFyersSymbol,
  toSocketTick,
  type DataSocket,
  type DataSocketEvents,
  type SdkDataSocketClass,
  type SdkSocket,
} from "../src/broker/fyersSocket.js";
import { BrokerGate } from "../src/broker/gate.js";
import { loadConfig, secretValues } from "../src/config.js";
import { openDb, type Db } from "../src/db.js";
import { FyersLiveFeed, backoffMs, pollList, socketShare, type FeedOptions } from "../src/live/feed.js";
import type { QuoteFetcher, Tick } from "../src/live/types.js";
import { createLogger, type Logger } from "../src/log.js";
import { mockPrice, startMockQuotes, type MockQuotes } from "./support/feedMockQuotes.js";
import { ACCESS_TOKEN, startMockFyers, type MockFyers } from "./support/mockFyers.js";
import { ist } from "./support/hub.js";

// The live feed, its upstream socket wrapper and batched REST quotes. Nothing
// here reaches the broker: quotes go to local mock servers, the socket is a fake
// (the real SDK is only loaded, never instantiated), and the feed runs on fake time.

const quietLog = (lines: string[] = []): Logger => createLogger({ level: "debug", secrets: [], write: (line) => lines.push(line) });

// --- REST quotes ------------------------------------------------------------------

describe("FyersClient.quotes against a mock server (no network)", () => {
  let fyers: MockFyers;
  let quotes: MockQuotes;
  let dir: string;
  let db: Db;
  let lines: string[];
  beforeAll(async () => {
    fyers = await startMockFyers();
    quotes = await startMockQuotes();
  });
  afterAll(async () => {
    await fyers.close();
    await quotes.close();
  });
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "hub-feed-"));
    db = openDb(dir);
    lines = [];
    quotes.calls.length = 0;
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const build = (now = () => Date.now()) => {
    const config = loadConfig({ ...fyers.env, FYERS_DATA_URL: `${quotes.url}/data`, HUB_DATA_DIR: dir });
    const log = createLogger({ level: "debug", secrets: secretValues(config.secrets), write: (line) => lines.push(line) });
    const gate = new BrokerGate(db, "standard");
    const auth = new FyersAuth({ secrets: config.secrets, fyers: config.fyers, dataDir: dir, log });
    return { gate, client: new FyersClient({ fyers: config.fyers, secrets: config.secrets, auth, gate, log, clock: now }) };
  };

  it("asks for ≤ 50 symbols per call, each through the gate at the caller's priority, and maps quotes to poll ticks", async () => {
    const { client, gate } = build(() => 1_762_662_345_000);
    const symbols = [...Array.from({ length: 118 }, (_, i) => `SYM${i}`), "NIFTY", "NOSUCH"];
    const ticks = await client.quotes(symbols, "refresh");
    expect(quotes.calls.map((call) => call.length)).toEqual([50, 50, 20]);
    expect(quotes.calls[2].slice(-2)).toEqual(["NSE:NIFTY50-INDEX", "NSE:NOSUCH-EQ"]);
    expect(gate.snapshot().byPriority).toMatchObject({ refresh: 3, user: 0, background: 0 });
    // The unknown symbol is left out; the index comes back under its hub name.
    expect(ticks).toHaveLength(119);
    expect(ticks.find((tick) => tick.symbol === "NIFTY")).toEqual({
      symbol: "NIFTY",
      ltp: mockPrice("NSE:NIFTY50-INDEX"),
      ch: 1.5,
      chp: 1.2,
      open: 99,
      high: 110,
      low: 98,
      prevClose: 98.5,
      volume: 12_345,
      ltt: 1_762_662_000_000,
      ts: 1_762_662_345_000,
      source: "poll",
    });
  });

  it("counts a 429 as a strike and doesn't retry it", async () => {
    const { client, gate } = build();
    quotes.failNext(429);
    await expect(client.quotes(["SBIN", "INFY"], "refresh")).rejects.toMatchObject({ kind: "rate_limited" });
    expect(quotes.calls).toHaveLength(1);
    expect(gate.snapshot()).toMatchObject({ strikes: 1, coolingDown: true });
    expect(lines.join("\n")).not.toContain(ACCESS_TOKEN);
  });

  it("makes no call once broker calls are stopped for the day", async () => {
    const { client, gate } = build();
    gate.budget.state.strikes = MAX_STRIKES_PER_DAY;
    await expect(client.quotes(["SBIN"], "refresh")).rejects.toMatchObject({ kind: "budget" });
    expect(quotes.calls).toHaveLength(0);
  });

  it("reports an upstream error body as a BrokerError", async () => {
    const { client } = build();
    quotes.failNext(500);
    await expect(client.quotes(["SBIN"], "user")).rejects.toBeInstanceOf(BrokerError);
  });

  it("skips junk entries and falls back to the receive time without a candle time", () => {
    const tickers = new Map([["NSE:SBIN-EQ", "SBIN"]]);
    const body = { s: "ok", d: [{ n: "NSE:SBIN-EQ", s: "ok", v: { lp: "801.5", volume: 10 } }, { n: "NSE:OTHER-EQ", v: { lp: 1 } }, { n: "NSE:SBIN-EQ", v: {} }, null] };
    expect(toQuoteTicks(body, tickers, 5_000)).toEqual([{ symbol: "SBIN", ltp: 801.5, ch: 0, chp: 0, open: 0, high: 0, low: 0, prevClose: 0, volume: 10, ltt: 5_000, ts: 5_000, source: "poll" }]);
    expect(toQuoteTicks({ s: "error" }, tickers, 1)).toEqual([]);
  });
});

// --- the socket wrapper -------------------------------------------------------------

class FakeSdkSocket implements SdkSocket {
  readonly FullMode = "full-mode";
  readonly handlers: Record<string, (payload: unknown) => void> = {};
  readonly subscribed: string[][] = [];
  readonly unsubscribed: string[][] = [];
  readonly modes: unknown[] = [];
  connects = 0;
  closed = false;
  on(event: string, listener: (payload: unknown) => void) {
    this.handlers[event] = listener;
  }
  subscribe(symbols: string[]) {
    this.subscribed.push(symbols);
  }
  unsubscribe(symbols: string[]) {
    this.unsubscribed.push(symbols);
  }
  mode(mode: unknown) {
    this.modes.push(mode);
  }
  connect() {
    this.connects += 1;
  }
  close() {
    this.closed = true;
  }
  fire(event: string, payload?: unknown) {
    this.handlers[event]?.(payload);
  }
}

function fakeSdk() {
  const created: Array<{ token: string; logPath?: string; flag?: boolean; cacheWasClear: boolean; socket: FakeSdkSocket }> = [];
  const sdk = {
    instance: "a stale cached socket" as unknown,
    getInstance(token: string, logPath?: string, flag?: boolean) {
      const socket = new FakeSdkSocket();
      created.push({ token, logPath, flag, cacheWasClear: sdk.instance === undefined, socket });
      sdk.instance = socket;
      return socket;
    },
  };
  return { sdk: sdk as SdkDataSocketClass, created };
}

describe("Fyers data socket wrapper", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "hub-socket-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const TOKEN = "eyJ.fake-token-for-tests.sig";
  const auth = { token: async () => TOKEN } as unknown as FyersAuth;

  it("builds a fresh SDK socket per call, logging into a private directory, and replays subscriptions on connect", async () => {
    const { sdk, created } = fakeSdk();
    const logDir = path.join(dir, "fyers-sdk");
    const factory = createFyersSocketFactory({ auth, clientId: "APP123-100", logDir, log: quietLog(), clock: () => 42_000, sdk });
    const socket = await factory();
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ token: `APP123-100:${TOKEN}`, logPath: logDir, flag: false, cacheWasClear: true });
    expect(statSync(logDir).mode & 0o777).toBe(0o700);

    const raw = created[0].socket;
    const events: Array<[keyof DataSocketEvents, unknown]> = [];
    socket.on("connect", () => events.push(["connect", null]));
    socket.on("message", (tick) => events.push(["message", tick]));
    socket.on("error", (error) => events.push(["error", error]));
    socket.on("close", () => events.push(["close", null]));

    socket.subscribe(["SBIN", "NIFTY"]);
    expect(raw.subscribed).toEqual([]); // not connected yet: sent on connect
    socket.connect();
    raw.fire("connect");
    expect(raw.subscribed).toEqual([["NSE:SBIN-EQ", "NSE:NIFTY50-INDEX"]]);
    expect(raw.modes).toEqual(["full-mode"]);
    socket.subscribe(["SBIN", "INFY"]);
    socket.unsubscribe(["NIFTY", "TCS"]);
    expect(raw.subscribed[1]).toEqual(["NSE:INFY-EQ"]);
    expect(raw.unsubscribed).toEqual([["NSE:NIFTY50-INDEX"]]);

    raw.fire("message", { type: "cn", code: 200, message: "connected" }); // control frame
    raw.fire("message", { symbol: "NSE:SBIN-EQ", ltp: 801.5, vol_traded_today: 1000, last_traded_time: 1_762_662_001, exch_feed_time: 1_762_662_002, ch: 2, chp: 0.25, open_price: 800, high_price: 805, low_price: 799, prev_close_price: 799.5 });
    raw.fire("message", { symbol: "NSE:NIFTY50-INDEX", ltp: 25_000 }); // unsubscribed above: dropped
    raw.fire("error", `{"code":-15,"message":"Please provide valid token ${TOKEN}"}`);
    raw.fire("close");
    expect(events).toEqual([
      ["connect", null],
      ["message", { symbol: "SBIN", ltp: 801.5, ch: 2, chp: 0.25, open: 800, high: 805, low: 799, prevClose: 799.5, volume: 1000, ltt: 1_762_662_001_000, ts: 42_000, source: "socket" }],
      ["error", { message: '{"code":-15,"message":"Please provide valid token [redacted]"}', auth: true }],
      ["close", null],
    ]);

    socket.close();
    expect(raw.closed).toBe(true);
    raw.fire("message", { symbol: "NSE:SBIN-EQ", ltp: 802 });
    expect(events).toHaveLength(4); // nothing after close

    await factory();
    expect(created[1].cacheWasClear).toBe(true);
  });

  it("normalises SDK messages and symbols", () => {
    expect(fromFyersSymbol("NSE:BAJAJ-AUTO-EQ")).toBe("BAJAJ-AUTO");
    expect(fromFyersSymbol("NSE:M&M-EQ")).toBe("M&M");
    expect(fromFyersSymbol("NSE:NIFTYBANK-INDEX")).toBe("BANKNIFTY");
    expect(fromFyersSymbol("NSE:SBIN26NOVFUT")).toBeNull();
    // Index frames carry no volume or trade time: the feed time stands in.
    expect(toSocketTick({ symbol: "NSE:NIFTY50-INDEX", ltp: 25_100.5, exch_feed_time: 1_762_662_003, prev_close_price: 25_000 }, 9)).toMatchObject({ symbol: "NIFTY", volume: 0, ltt: 1_762_662_003_000, prevClose: 25_000, ts: 9 });
    expect(toSocketTick({ symbol: "NSE:SBIN-EQ" }, 1)).toBeNull();
    expect(toSocketTick({ symbol: "NSE:SBIN-EQ", ltp: Number.NaN }, 1)).toBeNull();
    expect(describeSocketError(new Error("socket hang up"))).toEqual({ message: "socket hang up", auth: false });
  });

  it("can load the installed SDK (CommonJS) without opening anything", () => {
    const sdk = createRequire(import.meta.url)("fyers-api-v3") as { fyersDataSocket?: { getInstance?: unknown } };
    expect(typeof sdk.fyersDataSocket?.getInstance).toBe("function");
  });
});

// --- the feed (fake socket, fake time) ------------------------------------------------

class FakeSocket implements DataSocket {
  readonly subscribed = new Set<string>();
  readonly subscribeCalls: string[][] = [];
  readonly unsubscribeCalls: string[][] = [];
  connects = 0;
  connected = false;
  closed = false;
  private readonly listeners: { [E in keyof DataSocketEvents]: Array<DataSocketEvents[E]> } = { connect: [], message: [], error: [], close: [] };
  constructor(private readonly autoConnect: boolean) {}
  connect() {
    this.connects += 1;
    if (this.autoConnect) queueMicrotask(() => this.open());
  }
  subscribe(symbols: string[]) {
    this.subscribeCalls.push(symbols);
    symbols.forEach((symbol) => this.subscribed.add(symbol));
  }
  unsubscribe(symbols: string[]) {
    this.unsubscribeCalls.push(symbols);
    symbols.forEach((symbol) => this.subscribed.delete(symbol));
  }
  close() {
    this.closed = true;
    this.connected = false;
  }
  on<E extends keyof DataSocketEvents>(event: E, listener: DataSocketEvents[E]) {
    this.listeners[event].push(listener);
  }
  open() {
    if (this.closed) return;
    this.connected = true;
    this.listeners.connect.forEach((listener) => listener());
  }
  tick(symbol: string, ltp = 100) {
    const now = Date.now();
    const tick: Tick = { symbol, ltp, ch: 0, chp: 0, open: ltp, high: ltp, low: ltp, prevClose: ltp, volume: 1, ltt: now, ts: now, source: "socket" };
    this.listeners.message.forEach((listener) => listener(tick));
  }
  drop() {
    this.connected = false;
    this.listeners.close.forEach((listener) => listener());
  }
  error(error: { message: string; auth: boolean }) {
    this.listeners.error.forEach((listener) => listener(error));
  }
}

interface Harness {
  feed: FyersLiveFeed;
  sockets: FakeSocket[];
  /** Factory calls (fake time). */
  opens: number[];
  polls: Array<{ symbols: string[]; priority: string; at: number }>;
  ticks: Tick[];
  downtimes: Array<{ from: number; to: number }>;
  /** Whether the next sockets connect by themselves. */
  autoConnect: { value: boolean };
}

function harness(options: Partial<FeedOptions> & { fetch?: (symbols: string[]) => Promise<Tick[]> } = {}): Harness {
  const sockets: FakeSocket[] = [];
  const opens: number[] = [];
  const polls: Harness["polls"] = [];
  const autoConnect = { value: true };
  const fetcher: QuoteFetcher = {
    quotes: async (symbols, priority) => {
      polls.push({ symbols, priority, at: Date.now() });
      if (options.fetch) return options.fetch(symbols);
      return symbols.map((symbol) => ({ symbol, ltp: 50, ch: 0, chp: 0, open: 50, high: 50, low: 50, prevClose: 50, volume: 1, ltt: Date.now(), ts: Date.now(), source: "poll" as const }));
    },
  };
  const feed = new FyersLiveFeed({
    plan: { socketSymbols: 100, quoteBatch: 50 },
    socket: async () => {
      opens.push(Date.now());
      const socket = new FakeSocket(autoConnect.value);
      sockets.push(socket);
      return socket;
    },
    quotes: fetcher,
    log: quietLog(),
    ...options,
  });
  const ticks: Tick[] = [];
  const downtimes: Array<{ from: number; to: number }> = [];
  feed.onTick((tick) => ticks.push(tick));
  feed.onReconnect((downtime) => downtimes.push(downtime));
  return { feed, sockets, opens, polls, ticks, downtimes, autoConnect };
}

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const T0 = ist(2026, 11, 9, 10, 0); // a Monday, mid-session

describe("live feed", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: T0 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("decides socket share, polling and backoff with pure functions", () => {
    expect(socketShare(["A", "B", "C"], 2, true)).toEqual(["A", "B"]);
    expect(socketShare(["A", "B"], 2, false)).toEqual([]);
    const heard = new Map([
      ["A", 1_000],
      ["B", 0],
    ]);
    const base = { wanted: ["A", "B", "C"], onSocket: new Set(["A", "B"]), heard, now: 180_000, symbolSilentMs: 180_000 };
    expect(pollList({ ...base, socketHealthy: true })).toEqual(["B", "C"]);
    expect(pollList({ ...base, socketHealthy: false })).toEqual(["A", "B", "C"]);
    expect([1, 2, 3, 6, 7, 8, 50].map((n) => backoffMs(n, 1_000, 60_000))).toEqual([1_000, 2_000, 4_000, 32_000, 60_000, 60_000, 60_000]);
  });

  it("reference-counts subscriptions per owner and batches upstream changes", async () => {
    const { feed, sockets } = harness();
    feed.subscribe("a", ["SBIN", "infy", "not a symbol!"]);
    feed.subscribe("b", ["SBIN"]);
    feed.subscribe("b", ["SBIN"]); // an owner wants a symbol once
    feed.start();
    await advance(0);
    expect(sockets).toHaveLength(1);
    expect(sockets[0].connected).toBe(true);
    expect([...sockets[0].subscribed]).toEqual(["SBIN", "INFY"]);
    expect(feed.symbols()).toEqual(["SBIN", "INFY"]);

    feed.unsubscribe("a", ["SBIN"]);
    await advance(250);
    expect(sockets[0].unsubscribeCalls).toEqual([]); // "b" still wants it
    feed.unsubscribe("b");
    feed.subscribe("c", ["TCS"]);
    feed.subscribe("c", ["WIPRO"]);
    await advance(250);
    expect(sockets[0].unsubscribeCalls).toEqual([["SBIN"]]);
    expect(sockets[0].subscribeCalls.slice(1)).toEqual([["TCS", "WIPRO"]]); // one upstream call for both
    expect(feed.symbols()).toEqual(["INFY", "TCS", "WIPRO"]);
    feed.unsubscribe("a");
    feed.unsubscribe("c", ["TCS", "WIPRO"]);
    expect(feed.symbols()).toEqual([]);
    await feed.stop();
  });

  it("polls symbols beyond the socket's capacity, in batches at refresh priority, and promotes them when room frees up", async () => {
    const { feed, sockets, polls, ticks } = harness({ plan: { socketSymbols: 2, quoteBatch: 2 } });
    feed.subscribe("a", ["AAA", "BBB", "CCC", "DDD", "EEE"]);
    feed.start();
    await advance(0);
    expect([...sockets[0].subscribed]).toEqual(["AAA", "BBB"]);
    expect(feed.status()).toMatchObject({ mode: "mixed", socket: "connected", socketSymbols: 2, polledSymbols: 3, capacity: 2 });

    await advance(15_000);
    expect(polls.map((poll) => [poll.symbols, poll.priority])).toEqual([
      [["CCC", "DDD"], "refresh"],
      [["EEE"], "refresh"],
    ]);
    expect(ticks.map((tick) => `${tick.symbol}:${tick.source}`)).toEqual(["CCC:poll", "DDD:poll", "EEE:poll"]);

    sockets[0].tick("AAA");
    feed.unsubscribe("a", ["AAA"]);
    await advance(250);
    expect(sockets[0].unsubscribeCalls).toEqual([["AAA"]]);
    expect(sockets[0].subscribeCalls.at(-1)).toEqual(["CCC"]);
    polls.length = 0;
    await advance(15_000);
    expect(polls.map((poll) => poll.symbols)).toEqual([["DDD", "EEE"]]);
    await feed.stop();
  });

  it("restarts a silent socket, polls its symbols meanwhile, and reports the gap on reconnect", async () => {
    const { feed, sockets, polls, downtimes, autoConnect } = harness();
    feed.subscribe("persistent", ["SBIN", "INFY"]);
    feed.start();
    await advance(0);
    await advance(10_000);
    sockets[0].tick("SBIN");
    const lastHeard = Date.now();
    autoConnect.value = false; // the next socket hangs until we open it

    await advance(59_000);
    expect(sockets).toHaveLength(1); // 59 s of silence: still fine
    expect(polls).toEqual([]);
    await advance(2_000); // watchdog at +70 s restarts it; the retry after 1 s opens a new socket
    expect(sockets[0].closed).toBe(true);
    expect(sockets).toHaveLength(2);
    expect(feed.status()).toMatchObject({ socket: "connecting", mode: "polling", polledSymbols: 2 });

    await advance(4_000); // the poll at +75 s covers the socket's symbols
    expect(polls.map((poll) => poll.symbols)).toEqual([["SBIN", "INFY"]]);

    sockets[1].open();
    expect(downtimes).toEqual([{ from: lastHeard, to: Date.now() }]);
    sockets[1].tick("SBIN");
    sockets[1].tick("INFY");
    await advance(15_000);
    expect(polls).toHaveLength(1); // ticks resumed: polling stopped
    expect(feed.status()).toMatchObject({ mode: "socket", socketSymbols: 2, polledSymbols: 0, reconnects: 1 });
    await feed.stop();
  });

  it("polls a single silent symbol after 3 minutes and stops once its ticks resume", async () => {
    const { feed, sockets, polls } = harness();
    feed.subscribe("a", ["SBIN", "INFY"]);
    feed.start();
    await advance(0);
    const socket = sockets[0];
    const run = async (ms: number) => {
      for (let t = 0; t < ms; t += 5_000) {
        socket.tick("SBIN");
        await advance(5_000);
      }
    };
    await run(175_000);
    expect(polls).toEqual([]);
    await run(10_000); // INFY passes 3 minutes of silence at +180 s
    expect(polls.map((poll) => poll.symbols)).toEqual([["INFY"]]);
    expect(feed.status()).toMatchObject({ mode: "mixed", socketSymbols: 1, polledSymbols: 1 });
    socket.tick("INFY");
    await run(30_000);
    expect(polls).toHaveLength(1);
    expect(sockets).toHaveLength(1);
    await feed.stop();
  });

  it("backs off exponentially, capped at a minute, while the socket can't be opened", async () => {
    let fail = true;
    const sockets: FakeSocket[] = [];
    const opens: number[] = [];
    const { feed } = harness({
      socket: async () => {
        opens.push(Date.now());
        if (fail) throw new BrokerError("Broker login failed: test", "auth");
        const socket = new FakeSocket(true);
        sockets.push(socket);
        return socket;
      },
    });
    feed.subscribe("a", ["SBIN"]);
    feed.start();
    await advance(200_000);
    expect(opens.slice(1).map((at, i) => (at - opens[i]) / 1_000)).toEqual([1, 2, 4, 8, 16, 32, 60, 60]);
    expect(feed.status()).toMatchObject({ socket: "disconnected", mode: "polling", reconnects: 8 });

    // A socket that connects but closes before any tick keeps backing off; a tick resets it.
    fail = false;
    await advance(60_000);
    expect(sockets).toHaveLength(1);
    const droppedAt = Date.now();
    sockets[0].drop();
    await advance(60_000);
    expect(sockets).toHaveLength(2); // retried after the capped delay, not 1 s
    expect(opens.at(-1)! - droppedAt).toBe(60_000);
    sockets[1].tick("SBIN");
    sockets[1].drop();
    await advance(1_000);
    expect(sockets).toHaveLength(3);
    await feed.stop();
  });

  it("gives up on a socket that doesn't connect in time", async () => {
    const { feed, sockets, autoConnect } = harness();
    autoConnect.value = false;
    feed.subscribe("a", ["SBIN"]);
    feed.start();
    await advance(14_000);
    expect(sockets).toHaveLength(1);
    await advance(2_000); // timeout at 15 s, retry 1 s later
    expect(sockets[0].closed).toBe(true);
    expect(sockets).toHaveLength(2);
    await feed.stop();
  });

  it("restarts on a token error but not on a per-request socket error", async () => {
    const { feed, sockets } = harness();
    feed.subscribe("a", ["SBIN"]);
    feed.start();
    await advance(0);
    sockets[0].error({ message: "invalid symbol NSE:XYZ-EQ", auth: false });
    expect(sockets[0].closed).toBe(false);
    sockets[0].error({ message: "Please provide valid token", auth: true });
    expect(sockets[0].closed).toBe(true);
    await advance(1_000);
    expect(sockets).toHaveLength(2);
    await feed.stop();
  });

  it("runs only in market hours: closes the socket at 15:30, stays idle overnight, and reports the overnight gap at the open", async () => {
    vi.setSystemTime(ist(2026, 11, 9, 15, 28));
    const { feed, sockets, polls, downtimes } = harness({ plan: { socketSymbols: 1, quoteBatch: 50 } });
    feed.subscribe("a", ["SBIN", "INFY"]);
    feed.start();
    await advance(0);
    expect(sockets).toHaveLength(1);
    await advance(55_000);
    sockets[0].tick("SBIN");
    await advance(30_000);
    sockets[0].tick("SBIN");
    const lastHeard = Date.now();
    expect(polls.length).toBeGreaterThan(0); // INFY is beyond capacity: polled in the session
    await advance(36_000); // 15:30
    expect(sockets[0].closed).toBe(true);
    expect(feed.status()).toMatchObject({ mode: "idle", socket: "disconnected", polledSymbols: 0 });
    const polled = polls.length;
    await advance(10 * 60_000);
    expect(polls).toHaveLength(polled);
    expect(sockets).toHaveLength(1);

    vi.setSystemTime(ist(2026, 11, 10, 9, 14) + 50_000);
    await advance(5_000);
    expect(sockets).toHaveLength(1); // 09:14:55: not yet
    await advance(10_000);
    expect(sockets).toHaveLength(2);
    expect(downtimes).toHaveLength(1);
    expect(downtimes[0].from).toBe(lastHeard);
    expect(downtimes[0].to).toBeGreaterThanOrEqual(ist(2026, 11, 10, 9, 15)); // when the socket connected after the open
    await feed.stop();
  });

  it("does nothing at the weekend", async () => {
    vi.setSystemTime(ist(2026, 11, 14, 11, 0)); // a Saturday
    const { feed, sockets, polls } = harness();
    feed.subscribe("a", ["SBIN"]);
    feed.start();
    await advance(5 * 60_000);
    expect(sockets).toHaveLength(0);
    expect(polls).toHaveLength(0);
    expect(feed.status().mode).toBe("idle");
    await feed.stop();
  });

  it("emits the previous run's downtime on start", () => {
    const { feed, downtimes } = harness({ resumeFrom: T0 - 3_600_000 });
    feed.start();
    expect(downtimes).toEqual([{ from: T0 - 3_600_000, to: T0 }]);
    void feed.stop();
  });

  it("polls everything without a socket, one round at a time", async () => {
    const pending: Array<() => void> = [];
    const { feed, polls } = harness({
      socket: null,
      plan: { socketSymbols: 100, quoteBatch: 2 },
      fetch: (symbols) => new Promise((resolve) => pending.push(() => resolve(symbols.map((symbol) => ({ symbol, ltp: 1, ch: 0, chp: 0, open: 1, high: 1, low: 1, prevClose: 1, volume: 0, ltt: 0, ts: Date.now(), source: "poll" as const }))))),
    });
    feed.subscribe("a", ["SBIN", "INFY", "TCS"]);
    feed.start();
    expect(feed.status()).toMatchObject({ socket: "disabled", mode: "polling", polledSymbols: 3 });
    await advance(45_000);
    expect(polls).toHaveLength(1); // the first batch is still waiting: later rounds skipped
    pending.shift()!();
    await advance(0);
    expect(polls.map((poll) => poll.symbols)).toEqual([["SBIN", "INFY"], ["TCS"]]);
    pending.shift()!();
    await advance(15_000);
    expect(polls).toHaveLength(3);
    pending.shift()!();
    await feed.stop();
  });

  it("stops polling for the day when the broker budget is spent, and resumes the next day", async () => {
    let spent = true;
    const { feed, polls } = harness({
      socket: null,
      fetch: async (symbols) => {
        if (spent) throw new BrokerError("Today's broker data budget is used up.", "budget");
        return symbols.map((symbol) => ({ symbol, ltp: 1, ch: 0, chp: 0, open: 1, high: 1, low: 1, prevClose: 1, volume: 0, ltt: 0, ts: Date.now(), source: "poll" as const }));
      },
    });
    feed.subscribe("a", ["SBIN"]);
    feed.start();
    await advance(15_000);
    expect(polls).toHaveLength(1);
    expect(feed.status()).toMatchObject({ mode: "down", pollingStopped: "budget", polledSymbols: 0 });
    await advance(5 * 60_000);
    expect(polls).toHaveLength(1);

    spent = false;
    vi.setSystemTime(ist(2026, 11, 10, 10, 0));
    await advance(15_000);
    expect(polls).toHaveLength(2);
    expect(feed.status()).toMatchObject({ mode: "polling", pollingStopped: null });
    await feed.stop();
  });

  it("stops cleanly: socket closed, no timers left, no more ticks", async () => {
    const { feed, sockets, ticks } = harness();
    feed.subscribe("a", ["SBIN"]);
    feed.start();
    await advance(0);
    sockets[0].tick("SBIN");
    await feed.stop();
    expect(sockets[0].closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    sockets[0].tick("SBIN");
    expect(ticks).toHaveLength(1);
  });
});
