import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createKey, type Scope } from "../src/auth/keys.js";
import { BrokerError } from "../src/broker/errors.js";
import { toSocketTick } from "../src/broker/fyersSocket.js";
import { fromFyersSymbol, futureTicker, isFuture, normalizeSymbol, parseFuture, toFyersSymbol } from "../src/broker/symbols.js";
import { applyCashBhav } from "../src/history/fromBhav.js";
import { HistoryQueue, type QueueHistory } from "../src/history/queue.js";
import { pruneBefore, readBars, readSeries, writeBars } from "../src/history/store.js";
import type { BaseTf } from "../src/history/timeframes.js";
import { mergeMinutes } from "../src/live/merge.js";
import type { MinuteBar, Tick } from "../src/live/types.js";
import { createLogger } from "../src/log.js";
import { aggregateStockFutures, parseFoBhav } from "../src/nse/parsers/foBhav.js";
import { markDay, writeCashDay, writeFoDay, writeLots } from "../src/nse/store.js";
import { unzipSingle } from "../src/nse/unzip.js";
import { DAY_MS, MINUTE_MS, parseIsoDay } from "../src/time.js";
import { ist, makeHub, type TestHub } from "./support/hub.js";
import { ACCESS_TOKEN, startMockFyers, type MockFyers } from "./support/mockFyers.js";

// H5: the endpoints Tradex needs to drop its own Fyers and NSE fetching —
// batch daily candles, one day's F&O OI across stocks, F&O membership over a
// range, futures contracts as symbols, and 1-minute candles. Broker calls go to
// the mock server in test/support; nothing reaches Fyers or NSE.

const d = (iso: string) => parseIsoDay(iso)!;
const auth = (key: string) => ({ headers: { authorization: `Bearer ${key}` } });
const quietLog = createLogger({ level: "error", secrets: [], write: () => {} });

let t: TestHub;
afterEach(() => t?.cleanup());

function withKey(scopes: Scope[] = ["history", "fo"], options: Parameters<typeof makeHub>[0] = {}) {
  t = makeHub(options);
  const { key } = createKey(t.db, "test", scopes);
  const app = t.app();
  const get = async (path: string) => {
    const res = await app.request(path, auth(key));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { res, status: res.status, body: (await res.json()) as any };
  };
  return { key, get, app };
}

const foCsv = (name: string) => (name.endsWith(".zip") ? unzipSingle(readFileSync(new URL(`./fixtures/${name}`, import.meta.url))).data.toString("utf8") : readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const storeFoDay = (db: TestHub["db"], iso: string, file: string) => writeFoDay(db, d(iso), aggregateStockFutures(parseFoBhav(foCsv(file)).contracts, d(iso)), Date.now());

describe("futures contracts as symbols (pure)", () => {
  it("accepts SBIN26NOVFUT, and Fyers' NSE:SBIN26NOVFUT, but still not NSE:SBIN-EQ", () => {
    expect(normalizeSymbol("SBIN26NOVFUT")).toBe("SBIN26NOVFUT");
    expect(normalizeSymbol(" nse:sbin26novfut ")).toBe("SBIN26NOVFUT");
    expect(normalizeSymbol("NSE:M&M26DECFUT")).toBe("M&M26DECFUT");
    expect(normalizeSymbol("NSE:BAJAJ-AUTO27JANFUT")).toBe("BAJAJ-AUTO27JANFUT");
    // A 20-character underlying still fits once the contract suffix is added.
    expect(normalizeSymbol("ABCDEFGHIJKLMNOPQRST26NOVFUT")).toBe("ABCDEFGHIJKLMNOPQRST26NOVFUT");
    expect(normalizeSymbol("NSE:SBIN-EQ")).toBeNull();
    expect(normalizeSymbol("NSE:SBIN")).toBeNull();
    expect(normalizeSymbol("NSE:SBIN26NOV1000CE")).toBeNull();
    expect(normalizeSymbol("M&M")).toBe("M&M");
  });

  it("maps futures to Fyers and back, leaving stocks and indices as they were", () => {
    expect(toFyersSymbol("SBIN26NOVFUT")).toBe("NSE:SBIN26NOVFUT");
    expect(toFyersSymbol("M&M26NOVFUT")).toBe("NSE:M&M26NOVFUT");
    expect(toFyersSymbol("BAJAJ-AUTO26NOVFUT")).toBe("NSE:BAJAJ-AUTO26NOVFUT");
    expect(toFyersSymbol("NIFTY26NOVFUT")).toBe("NSE:NIFTY26NOVFUT");
    expect(toFyersSymbol("SBIN")).toBe("NSE:SBIN-EQ");
    expect(toFyersSymbol("M&M")).toBe("NSE:M&M-EQ");
    expect(toFyersSymbol("BAJAJ-AUTO")).toBe("NSE:BAJAJ-AUTO-EQ");
    expect(toFyersSymbol("NIFTY")).toBe("NSE:NIFTY50-INDEX");
    for (const symbol of ["SBIN26NOVFUT", "M&M26NOVFUT", "BAJAJ-AUTO26NOVFUT", "SBIN", "M&M", "NIFTY", "BANKNIFTY"]) expect(fromFyersSymbol(toFyersSymbol(symbol))).toBe(symbol);
    expect(fromFyersSymbol("NSE:SBIN26NOV800CE")).toBeNull();
    expect(fromFyersSymbol("BSE:SENSEX-INDEX")).toBeNull();
    expect(toSocketTick({ symbol: "NSE:SBIN26NOVFUT", ltp: 951.2, vol_traded_today: 1200, last_traded_time: 1_794_200_401 }, 7)).toMatchObject({ symbol: "SBIN26NOVFUT", ltp: 951.2, volume: 1200 });
  });

  it("splits a contract into underlying, year and month — digits in the underlying included", () => {
    expect(parseFuture("SBIN26NOVFUT")).toEqual({ underlying: "SBIN", year: 2026, month: 10 });
    expect(parseFuture("NIFTYNXT5027JANFUT")).toEqual({ underlying: "NIFTYNXT50", year: 2027, month: 0 });
    expect(parseFuture("M&M26DECFUT")).toEqual({ underlying: "M&M", year: 2026, month: 11 });
    expect(parseFuture("SBIN26XYZFUT")).toBeNull();
    expect(parseFuture("SBIN")).toBeNull();
    expect(isFuture("BAJAJ-AUTO26NOVFUT")).toBe(true);
    expect(isFuture("BAJAJ-AUTO")).toBe(false);
  });

  it("names a contract by its expiry month, as NSE's own instrument names do", () => {
    expect(futureTicker("SBIN", d("2026-11-24"))).toBe("SBIN26NOVFUT");
    expect(futureTicker("M&M", d("2026-12-29"))).toBe("M&M26DECFUT");
    expect(futureTicker("BAJAJ-AUTO", d("2030-01-29"))).toBe("BAJAJ-AUTO30JANFUT");
    // Every stock-futures row in a real bhavcopy: the hub's ticker equals NSE's FinInstrmNm.
    const csv = foCsv("fo-bhav-20251029.csv.zip");
    const [header, ...rows] = csv.split(/\r?\n/).filter(Boolean);
    const col = (name: string) => header.split(",").indexOf(name);
    const stf = rows.map((row) => row.split(",")).filter((cells) => cells[col("FinInstrmTp")] === "STF");
    expect(stf.length).toBeGreaterThan(5);
    for (const cells of stf) expect(futureTicker(cells[col("TckrSymb")], d(cells[col("XpryDt")]))).toBe(cells[col("FinInstrmNm")]);
  });
});

describe("1-minute candles (pure parts)", () => {
  it("folds live minutes into 1m candles: the stored last minute is updated, later minutes appended", () => {
    const t0 = ist(2026, 11, 4, 11, 57);
    const stored = [0, 1].map((i) => ({ t: t0 - MINUTE_MS + i * MINUTE_MS, o: 10, h: 11, l: 9, c: 10, v: 100 }));
    const minute = (offset: number, c: number, source: MinuteBar["source"] = "live"): MinuteBar => ({ symbol: "SBIN", t: t0 + offset * MINUTE_MS, o: c, h: c + 1, l: c - 1, c, v: 5, source });
    const merged = mergeMinutes("1m", stored, [minute(-5, 1), minute(0, 12), minute(1, 13), minute(2, 14, "broker")]);
    expect(merged.map((bar) => bar.t)).toEqual([t0 - MINUTE_MS, t0, t0 + MINUTE_MS, t0 + 2 * MINUTE_MS]);
    expect(merged[0]).toEqual(stored[0]); // older minutes don't touch stored bars
    expect(merged[1]).toMatchObject({ o: 10, h: 13, l: 9, c: 12 });
    expect(merged[3]).toMatchObject({ o: 14, c: 14, v: 5 });
  });

  it("prunes a series to its window, moving coverage up (or clearing it)", () => {
    t = makeHub();
    const base = ist(2026, 10, 1, 9, 15);
    const bars = Array.from({ length: 6 }, (_, i) => ({ t: base + i * MINUTE_MS, o: 1, h: 1, l: 1, c: 1, v: 1 }));
    writeBars(t.db, "SBIN", "1m", bars, { from: base, to: base + 6 * MINUTE_MS }, 1);
    pruneBefore(t.db, "SBIN", "1m", base + 3 * MINUTE_MS);
    expect(readBars(t.db, "SBIN", "1m", 0, Infinity).map((bar) => bar.t)).toEqual([3, 4, 5].map((i) => base + i * MINUTE_MS));
    expect(readSeries(t.db, "SBIN", "1m")).toMatchObject({ coverage: { from: base + 3 * MINUTE_MS, to: base + 6 * MINUTE_MS }, count: 3, firstT: base + 3 * MINUTE_MS });
    pruneBefore(t.db, "SBIN", "1m", base + DAY_MS);
    expect(readSeries(t.db, "SBIN", "1m")).toMatchObject({ coverage: null, count: 0, firstT: null });
  });
});

describe("background history queue", () => {
  /** A history stand-in whose fetches the test completes by hand. */
  function fakeHistory() {
    const calls: Array<{ symbol: string; base: BaseTf; from: number; to: number; finish: (error?: Error) => void }> = [];
    const history: QueueHistory = {
      ensure: (symbol, base, want) =>
        new Promise<void>((resolve, reject) => {
          calls.push({ symbol, base, from: want.from, to: want.to, finish: (error) => (error ? reject(error) : resolve()) });
        }),
    };
    return { history, calls };
  }
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("fetches each series once however often it is asked for, widening a waiting entry's range", async () => {
    const { history, calls } = fakeHistory();
    const queue = new HistoryQueue({ history, log: quietLog, concurrency: 1 });
    expect(queue.enqueue("SBIN", "1d", { from: 10, to: 20 })).toBe(true);
    expect(queue.enqueue("INFY", "1d", { from: 10, to: 20 })).toBe(true);
    expect(queue.enqueue("SBIN", "1d", { from: 12, to: 18 })).toBe(true); // running, already covered: nothing added
    expect(queue.enqueue("INFY", "1d", { from: 5, to: 25 })).toBe(true); // waiting: widened
    expect(queue.enqueue("SBIN", "1d", { from: 1, to: 2 })).toBe(true); // running but not covered: queued after it
    await tick();
    expect(calls.map((call) => call.symbol)).toEqual(["SBIN"]);
    calls[0].finish();
    await tick();
    expect(calls.slice(1).map((call) => [call.symbol, call.from, call.to])).toEqual([["INFY", 5, 25]]);
    calls[1].finish();
    await tick();
    expect(calls.slice(2).map((call) => [call.symbol, call.from, call.to])).toEqual([["SBIN", 1, 2]]);
    calls[2].finish();
    await queue.idle();
    expect(queue.status()).toMatchObject({ pending: 0, running: 0 });
    expect(queue.enqueue("SBIN", "1d", { from: 5, to: 5 })).toBe(false); // empty range
  });

  it("remembers symbols the broker doesn't know, and pauses (keeping its work) on broker-wide problems", async () => {
    const { history, calls } = fakeHistory();
    const queue = new HistoryQueue({ history, log: quietLog, concurrency: 1, retryMs: 60_000, maxQueued: 3 });
    queue.enqueue("NOSUCH", "1d", { from: 1, to: 2 });
    queue.enqueue("SBIN", "1d", { from: 1, to: 2 });
    queue.enqueue("INFY", "1d", { from: 1, to: 2 });
    expect(queue.enqueue("TCS", "1d", { from: 1, to: 2 })).toBe(true);
    expect(queue.enqueue("HAL", "1d", { from: 1, to: 2 })).toBe(false); // full
    await tick();
    calls[0].finish(new BrokerError("unknown", "bad_symbol"));
    await tick();
    expect(queue.isUnknown("NOSUCH")).toBe(true);
    expect(queue.enqueue("NOSUCH", "1d", { from: 1, to: 2 })).toBe(false);
    calls[1].finish(new BrokerError("Today's broker data budget is used up.", "budget"));
    await queue.idle();
    expect(calls.map((call) => call.symbol)).toEqual(["NOSUCH", "SBIN"]);
    expect(queue.status()).toMatchObject({ pending: 3, running: 0, lastError: "Today's broker data budget is used up." });
    expect(queue.status().pausedUntil).not.toBeNull();
    queue.stop();
  });
});

describe("GET /v1/candles/batch", () => {
  let mock: MockFyers;
  beforeAll(async () => {
    mock = await startMockFyers();
  });
  afterAll(() => mock.close());

  it("validates its parameters", async () => {
    const { get } = withKey(["history"]);
    expect((await get("/v1/candles/batch")).body).toMatchObject({ code: "bad_request" });
    expect((await get("/v1/candles/batch?symbols=SBIN&tf=15m")).body.error).toMatch(/tf must be one of 1d, 1w/);
    expect((await get("/v1/candles/batch?symbols=SBIN&from=2026-10-10&to=2026-10-01")).status).toBe(400);
    const many = Array.from({ length: 301 }, (_, i) => `S${i}`).join(",");
    expect((await get(`/v1/candles/batch?symbols=${many}`)).body).toMatchObject({ code: "too_many_symbols" });
    expect((await withKey(["fo"]).get("/v1/candles/batch?symbols=SBIN")).status).toBe(403);
  });

  it("answers from the store at once, queues what's missing (once), and serves it on the next request", async () => {
    mock.history.length = 0;
    const { get } = withKey(["history"], { env: mock.env });
    writeCashDay(t.db, d("2026-10-29"), [{ symbol: "SBIN", series: "EQ", prevClose: 1, open: 1, high: 1, low: 1, close: 1, volume: 1, deliveryPct: 61.5 }], 0);
    const url = "/v1/candles/batch?symbols=SBIN,infy,NOSUCH,bad$sym,SBIN&tf=1d&from=2026-09-01&to=2026-10-30";
    const [first, second] = await Promise.all([get(url), get(url)]);
    for (const answer of [first, second]) {
      expect(answer.status).toBe(200);
      expect(answer.body).toMatchObject({ tf: "1d", from: d("2026-09-01"), to: d("2026-10-30"), unknown: ["bad$sym"] });
      expect(Object.keys(answer.body.series)).toEqual(["SBIN", "INFY", "NOSUCH"]);
    }
    expect(first.body.queued).toEqual(["SBIN", "INFY", "NOSUCH"]);
    expect(first.body.series.SBIN).toEqual({ complete: false, coverage: null, candles: [] });

    await t.hub.historyQueue.idle();
    // Two requests, one broker call per symbol.
    expect(mock.history.filter((call) => call.symbol === "NSE:SBIN-EQ")).toHaveLength(1);
    expect(mock.history.filter((call) => call.symbol === "NSE:INFY-EQ")).toHaveLength(1);
    expect(mock.history.every((call) => call.resolution === "D")).toBe(true);

    const third = await get(url);
    expect(third.body.queued).toEqual([]);
    expect(third.body.unknown).toEqual(["NOSUCH", "bad$sym"]);
    expect(Object.keys(third.body.series)).toEqual(["SBIN", "INFY"]);
    const sbin = third.body.series.SBIN;
    expect(sbin.complete).toBe(true);
    expect(sbin.coverage.from).toBeLessThanOrEqual(d("2026-09-01"));
    expect(sbin.candles[0].t).toBe(d("2026-09-01"));
    expect(sbin.candles.at(-1)).toMatchObject({ t: d("2026-10-30"), dp: null });
    expect(sbin.candles.find((bar: { t: number }) => bar.t === d("2026-10-29")).dp).toBe(61.5);

    const weekly = await get("/v1/candles/batch?symbols=SBIN&tf=1w&from=2026-09-07&to=2026-10-30");
    expect(weekly.body.series.SBIN.candles.map((bar: { t: number }) => bar.t)).toEqual(Array.from({ length: 8 }, (_, i) => d("2026-09-07") + i * 7 * DAY_MS));
  });

  it("queues nothing without a broker, and says why", async () => {
    const { get } = withKey(["history"]);
    writeBars(t.db, "SBIN", "1d", [{ t: d("2026-10-29"), o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }], { from: d("2026-10-29"), to: d("2026-10-30") }, 1);
    const answer = await get("/v1/candles/batch?symbols=SBIN,INFY&from=2026-10-29&to=2026-10-29");
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ queued: [], unknown: [], reason: "not_configured" });
    expect(answer.body.series.SBIN).toEqual({ complete: true, coverage: { from: d("2026-10-29"), to: d("2026-10-30") }, candles: [{ t: d("2026-10-29"), o: 1, h: 2, l: 0.5, c: 1.5, v: 10, dp: null }] });
    expect(answer.body.series.INFY).toEqual({ complete: false, coverage: null, candles: [] });
  });
});

describe("F&O: one day across stocks, membership over a range, contracts", () => {
  it("GET /v1/fo/oi/day serves the newest stored day by default, or an exact date", async () => {
    const { get } = withKey(["fo"]);
    expect((await get("/v1/fo/oi/day")).body).toMatchObject({ code: "not_ready" });
    expect((await get("/v1/fo/oi/day")).status).toBe(404);
    storeFoDay(t.db, "2025-10-01", "fo-bhav-20251001.csv");
    storeFoDay(t.db, "2025-10-29", "fo-bhav-20251029.csv.zip");

    const latest = await get("/v1/fo/oi/day");
    expect(latest.status).toBe(200);
    expect(latest.body).toMatchObject({ date: "2025-10-29", day: d("2025-10-29") });
    expect(latest.body.rows.map((row: { symbol: string }) => row.symbol)).toEqual(["RELIANCE", "SBIN", "TMPV"]);
    // Each row is exactly a /v1/fo/oi item plus its symbol.
    const single = await get("/v1/fo/oi?symbol=SBIN&from=2025-10-29&to=2025-10-29");
    expect(latest.body.rows[1]).toEqual({ symbol: "SBIN", ...single.body.days[0] });
    expect(latest.body.rows[1]).toMatchObject({ near: { expiry: "2025-11-25" }, next: { expiry: "2025-12-30" }, buildup: "short-covering" });

    const older = await get("/v1/fo/oi/day?date=2025-10-01");
    expect(older.body.rows.map((row: { symbol: string; nseSymbol: string }) => `${row.nseSymbol}→${row.symbol}`)).toEqual(["ICICIPRULI→ICICILIFE", "LTIM→LTM", "RELIANCE→RELIANCE", "TATAMOTORS→TMPV"]);
    expect((await get("/v1/fo/oi/day?date=2025-10-02")).body).toMatchObject({ code: "no_data" });
    expect((await get("/v1/fo/oi/day?date=yesterday")).status).toBe(400);
  });

  it("GET /v1/fo/members takes a from/to range (at most 400 days); ?date= is unchanged", async () => {
    const { get } = withKey(["fo"]);
    storeFoDay(t.db, "2025-10-01", "fo-bhav-20251001.csv");
    storeFoDay(t.db, "2025-10-29", "fo-bhav-20251029.csv.zip");
    markDay(t.db, "fo_bhav", d("2025-10-02"), "holiday", 0, 1);

    expect((await get("/v1/fo/members?from=2025-09-01&to=2025-11-30")).body).toEqual({
      from: "2025-09-01",
      to: "2025-11-30",
      days: [
        { date: "2025-10-01", day: d("2025-10-01"), symbols: ["ICICILIFE", "LTM", "RELIANCE", "TMPV"] },
        { date: "2025-10-29", day: d("2025-10-29"), symbols: ["RELIANCE", "SBIN", "TMPV"] },
      ],
    });
    expect((await get("/v1/fo/members?from=2025-10-02&to=2025-10-28")).body.days).toEqual([]);
    expect((await get("/v1/fo/members?from=2024-09-01&to=2025-10-29")).body.error).toMatch(/at most 400 days/);
    expect((await get("/v1/fo/members?from=2024-09-25&to=2025-10-29")).status).toBe(200); // 399 days apart
    expect((await get("/v1/fo/members?date=2025-10-29&from=2025-10-01")).status).toBe(400);
    expect((await get("/v1/fo/members?date=2025-11-02")).body).toEqual({ date: "2025-11-02", tradeDate: "2025-10-29", count: 3, symbols: ["RELIANCE", "SBIN", "TMPV"] });
  });

  it("GET /v1/fo/contracts names the near and next month as hub tickers, dropping an expired one", async () => {
    let now = ist(2025, 10, 30, 10, 0);
    const { get } = withKey(["fo"], { clock: () => now });
    expect((await get("/v1/fo/contracts?symbol=SBIN")).body).toMatchObject({ code: "not_ready" });
    storeFoDay(t.db, "2025-10-01", "fo-bhav-20251001.csv");
    storeFoDay(t.db, "2025-10-29", "fo-bhav-20251029.csv.zip");
    writeLots(t.db, { SBIN: 999 });

    expect((await get("/v1/fo/contracts?symbol=sbin")).body).toEqual({
      symbol: "SBIN",
      asOf: "2025-10-29",
      lot: 750,
      contracts: [
        { ticker: "SBIN25NOVFUT", expiry: "2025-11-25", kind: "near" },
        { ticker: "SBIN25DECFUT", expiry: "2025-12-30", kind: "next" },
      ],
    });
    expect((await get("/v1/fo/contracts?symbol=INFY")).body).toMatchObject({ code: "not_found" });
    expect((await get("/v1/fo/contracts")).status).toBe(400);

    now = ist(2025, 11, 26, 10, 0); // November expired; no newer file stored yet
    expect((await get("/v1/fo/contracts?symbol=TMPV")).body.contracts).toEqual([{ ticker: "TMPV25DECFUT", expiry: "2025-12-30", kind: "near" }]);
  });
});

describe("futures and 1m through the API, against the mock broker", () => {
  let mock: MockFyers;
  beforeAll(async () => {
    mock = await startMockFyers();
  });
  afterAll(() => mock.close());
  const dirs: string[] = [];
  afterEach(() => {
    mock.until = null;
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** A hub on virtual time. The mock checks the login's TOTP against real time, so it starts with a token. */
  function hubAt(now: number, env: Record<string, string> = {}) {
    const dir = mkdtempSync(path.join(tmpdir(), "hub-test-"));
    dirs.push(dir);
    writeFileSync(path.join(dir, "fyers-token.json"), JSON.stringify({ accessToken: ACCESS_TOKEN, fetchedAt: now }));
    return withKey(["history"], { env: { ...mock.env, ...env }, clock: () => now, dir });
  }

  it("batch: in the evening, a stock missing only today's session waits for the free cash bhavcopy", async () => {
    const now = ist(2026, 11, 4, 16, 30); // Wednesday, after the close, before NSE's file
    const { get } = hubAt(now, { HUB_JOBS: "on" });
    const bars = (to: string) => {
      const out = [];
      for (let day = d("2026-10-01"); day <= d(to); day += DAY_MS) out.push({ t: day, o: 1, h: 1, l: 1, c: 1, v: 1 });
      return out;
    };
    for (const symbol of ["SBIN", "NIFTY", "SBIN26NOVFUT"]) writeBars(t.db, symbol, "1d", bars("2026-11-03"), { from: d("2026-10-01"), to: d("2026-11-04") }, now);
    writeBars(t.db, "INFY", "1d", bars("2026-11-02"), { from: d("2026-10-01"), to: d("2026-11-03") }, now);
    // Only what gets queued matters here: a queue whose fetches do nothing.
    t.hub.historyQueue = new HistoryQueue({ history: { ensure: async () => {} }, log: quietLog });
    const url = "/v1/candles/batch?symbols=SBIN,NIFTY,SBIN26NOVFUT,INFY&from=2026-10-01&to=2026-11-04";
    const evening = await get(url);
    expect(Object.values(evening.body.series).map((entry) => (entry as { complete: boolean }).complete)).toEqual([false, false, false, false]);
    expect(evening.body.queued).toEqual(["NIFTY", "SBIN26NOVFUT", "INFY"]);
    // Once the day's file is stored, a stock still behind is fetched like any other.
    markDay(t.db, "cash_bhav", d("2026-11-04"), "ok", 0, now);
    expect((await get(url)).body.queued).toEqual(["SBIN", "NIFTY", "SBIN26NOVFUT", "INFY"]);
  });

  it("serves a futures contract's daily and intraday candles (no delivery %, no split checks)", async () => {
    mock.history.length = 0;
    const { get } = withKey(["history"], { env: mock.env });
    const daily = await get("/v1/candles?symbol=NSE:SBIN26NOVFUT&tf=1d&from=2026-10-01&to=2026-10-30");
    expect(daily.status).toBe(200);
    expect(daily.body).toMatchObject({ symbol: "SBIN26NOVFUT", complete: true });
    expect(daily.body.candles[0]).toMatchObject({ t: d("2026-10-01"), dp: null });
    const intraday = await get("/v1/candles?symbol=SBIN26NOVFUT&tf=15m&from=2026-10-29&to=2026-10-30");
    expect(intraday.status).toBe(200);
    expect(intraday.body.candles).toHaveLength(2 * 25);
    expect(new Set(mock.history.map((call) => call.symbol))).toEqual(new Set(["NSE:SBIN26NOVFUT"]));

    // The evening cash bhavcopy never extends (or resets) a futures series.
    const before = readSeries(t.db, "SBIN26NOVFUT", "1d")!;
    markDay(t.db, "cash_bhav", d("2026-10-30"), "ok", 1, 1);
    const result = applyCashBhav(t.db, d("2026-11-02"), [{ symbol: "SBIN26NOVFUT", series: "EQ", prevClose: 1, open: 1, high: 1, low: 1, close: 1, volume: 1, deliveryPct: null }], quietLog);
    expect(result).toEqual({ extended: 0, reset: [] });
    expect(readSeries(t.db, "SBIN26NOVFUT", "1d")).toEqual(before);
  });

  it("serves 1m from broker 1-minute history (30-day window) plus the live store's newer minutes", async () => {
    mock.history.length = 0;
    const now = ist(2026, 11, 4, 12, 0) + 30_000; // Wednesday, mid-session
    mock.until = () => ist(2026, 11, 4, 11, 58); // the broker lags a little
    const { get } = hubAt(now);
    const live = (hh: number, mm: number, c: number): MinuteBar => ({ symbol: "SBIN", t: ist(2026, 11, 4, hh, mm), o: c, h: c, l: c, c, v: 7, source: "live" });
    // Minutes the hub recorded from ticks (written straight to the store here).
    const insert = t.db.prepare("insert into live_bars_1m (symbol, t, o, h, l, c, v, source) values (?, ?, ?, ?, ?, ?, ?, 'live')");
    for (const bar of [live(11, 58, 501), live(11, 59, 502), live(12, 0, 503)]) insert.run(bar.symbol, bar.t, bar.o, bar.h, bar.l, bar.c, bar.v);

    const answer = await get("/v1/candles?symbol=SBIN&tf=1m&from=2026-11-03&to=2026-11-04");
    expect(answer.status).toBe(200);
    expect(mock.history.map((call) => [call.symbol, call.resolution, call.from, call.to])).toEqual([["NSE:SBIN-EQ", "1", "2026-11-03", "2026-11-04"]]);
    const candles = answer.body.candles as Array<{ t: number; c: number }>;
    expect(candles[0].t).toBe(ist(2026, 11, 3, 9, 15));
    expect(candles.filter((bar) => bar.t < ist(2026, 11, 4, 0, 0))).toHaveLength(375);
    expect(candles.slice(-4).map((bar) => bar.t)).toEqual([ist(2026, 11, 4, 11, 57), ist(2026, 11, 4, 11, 58), ist(2026, 11, 4, 11, 59), ist(2026, 11, 4, 12, 0)]);
    expect(candles.slice(-3).map((bar) => bar.c)).toEqual([501, 502, 503]);
    expect(answer.body.liveThrough).toBe(ist(2026, 11, 4, 12, 0));

    // A range older than the window is clamped to the last 30 days.
    mock.history.length = 0;
    const old = await get("/v1/candles?symbol=INFY&tf=1m&from=2026-08-01&to=2026-10-10");
    expect(old.status).toBe(200);
    expect(mock.history.map((call) => [call.resolution, call.from, call.to])).toEqual([["1", "2026-10-05", "2026-10-10"]]);
    expect(old.body.complete).toBe(true);
    expect(old.body.candles[0].t).toBe(ist(2026, 10, 5, 9, 15));
    expect((await get("/v1/candles?symbol=SBIN&tf=2m")).body.error).toMatch(/1d, 1w, 1h, 15m, 5m, 1m/);
  });

  it("serves quotes for futures (and accepts Fyers' form)", async () => {
    const asked: string[][] = [];
    const tick = (symbol: string): Tick => ({ symbol, ltp: 950, ch: 1, chp: 0.1, open: 949, high: 951, low: 948, prevClose: 949, volume: 10, ltt: 1, ts: Date.now(), source: "poll" });
    t = makeHub();
    const { key } = createKey(t.db, "test", ["live"]);
    const app = t.app({ live: { feed: t.hub.live.feed, store: t.hub.live.store, quotes: { quotes: async (symbols) => (asked.push(symbols), symbols.map(tick)) } } });
    const res = await app.request("/v1/quotes?symbols=SBIN26NOVFUT,NSE:INFY26DECFUT", auth(key));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { quotes: Array<{ symbol: string }> };
    expect(body.quotes.map((quote) => quote.symbol)).toEqual(["SBIN26NOVFUT", "INFY26DECFUT"]);
    expect(asked).toEqual([["SBIN26NOVFUT", "INFY26DECFUT"]]);
  });
});
