import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BrokerError } from "../src/broker/errors.js";
import type { Bar, HistoryResult } from "../src/broker/fyers.js";
import { openDb, readKv, type Db } from "../src/db.js";
import { foldTick, newAgg, seedAgg, type SymbolAgg } from "../src/live/aggregate.js";
import { bucketOf, mergeMinutes } from "../src/live/merge.js";
import { LiveRecovery, RECOVERY_KEY, downtimeStart, latestSessionDay, mergeTasks, minuteFetcher, planRecovery, recoveryWindowStart, sessionSlices, type HistoryFn } from "../src/live/recovery.js";
import { SqliteLiveStore } from "../src/live/store.js";
import type { MinuteBar, Tick } from "../src/live/types.js";
import { DAY_MS, MINUTE_MS, parseIsoDay } from "../src/time.js";
import { ist } from "./support/hub.js";

// Monday 9 Nov 2026 is a trading weekday; Friday 6 Nov the session before it.
const d = (iso: string) => parseIsoDay(iso)!;
const mon = (hour: number, minute = 0, second = 0) => ist(2026, 11, 9, hour, minute) + second * 1000;
const fri = (hour: number, minute = 0, second = 0) => ist(2026, 11, 6, hour, minute) + second * 1000;

const tick = (symbol: string, ltt: number, ltp: number, volume: number, extra: Partial<Tick> = {}): Tick => ({
  symbol,
  ltp,
  ch: ltp - 100,
  chp: ltp - 100,
  open: 100,
  high: Math.max(100, ltp),
  low: Math.min(100, ltp),
  prevClose: 100,
  volume,
  ltt,
  ts: ltt + 200,
  source: "socket",
  ...extra,
});

const fold = (agg: SymbolAgg, ticks: Tick[]) => ticks.map((t) => foldTick(agg, t));
const ohlcv = (bar: { o: number; h: number; l: number; c: number; v: number } | null | undefined) => (bar ? [bar.o, bar.h, bar.l, bar.c, bar.v] : null);

const dirs: string[] = [];
const dbs: Db[] = [];
function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "live-store-"));
  dirs.push(dir);
  return dir;
}
function open(dir: string) {
  const db = openDb(dir);
  dbs.push(db);
  return db;
}
afterEach(() => {
  for (const db of dbs.splice(0)) if (db.open) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A store on a fresh database with a hand-driven clock. */
function makeStore(at: number, dir = tempDir(), extra: { retentionDays?: number } = {}) {
  const clock = { now: at };
  const db = open(dir);
  const store = new SqliteLiveStore({ db, clock: () => clock.now, timer: false, ...extra });
  return { dir, db, store, clock };
}

// ── Aggregation ─────────────────────────────────────────────────────────────

describe("aggregation (pure)", () => {
  it("builds OHLC from ltp and volume from the rise in cumulative volume", () => {
    const agg = newAgg("SBIN");
    fold(agg, [tick("SBIN", mon(9, 15, 2), 100, 5_000), tick("SBIN", mon(9, 15, 20), 102, 5_400), tick("SBIN", mon(9, 15, 40), 99, 5_500), tick("SBIN", mon(9, 15, 59), 101, 6_000)]);
    // The first tick of the day in the first minute counts everything traded so far.
    expect(agg.open).toHaveLength(1);
    expect(ohlcv(agg.open[0])).toEqual([100, 102, 99, 101, 6_000]);
    const next = foldTick(agg, tick("SBIN", mon(9, 16, 1), 103, 6_250));
    expect(next?.t).toBe(mon(9, 16));
    expect(ohlcv(next)).toEqual([103, 103, 103, 103, 250]);
  });

  it("counts no volume for the first tick seen mid-session, and never a negative delta", () => {
    const agg = newAgg("SBIN");
    const first = foldTick(agg, tick("SBIN", mon(11, 0, 5), 100, 1_000_000));
    expect(first?.v).toBe(0);
    foldTick(agg, tick("SBIN", mon(11, 0, 10), 100, 1_000_300));
    foldTick(agg, tick("SBIN", mon(11, 0, 20), 100, 1_000_100)); // a stale cumulative
    expect(agg.open[0].v).toBe(300);
    foldTick(agg, tick("SBIN", mon(11, 0, 30), 100, 1_000_400));
    expect(agg.open[0].v).toBe(400);
  });

  it("resets the volume baseline at a new trading day", () => {
    const agg = newAgg("SBIN");
    fold(agg, [tick("SBIN", fri(15, 29, 10), 100, 9_000_000), tick("SBIN", fri(15, 29, 50), 100, 9_000_500)]);
    const monday = foldTick(agg, tick("SBIN", mon(9, 15, 3), 101, 20_000));
    expect(monday?.v).toBe(20_000);
    expect(agg.day).toBe(d("2026-11-09"));
    // A late Friday tick after Monday started adds nothing and makes no bar.
    expect(foldTick(agg, tick("SBIN", fri(15, 29, 59), 100, 9_000_600))).toBeNull();
    expect(agg.open.find((bar) => bar.t === mon(9, 15))?.v).toBe(20_000);
  });

  it("makes no bars outside the session, and pre-open volume lands in 09:15", () => {
    const agg = newAgg("SBIN");
    expect(foldTick(agg, tick("SBIN", mon(9, 8), 99, 40_000))).toBeNull(); // pre-open
    const open = foldTick(agg, tick("SBIN", mon(9, 15, 1), 100, 41_000));
    expect(open?.v).toBe(41_000);
    expect(foldTick(agg, tick("SBIN", mon(15, 30, 2), 104, 900_000))).toBeNull(); // after the close
    expect(foldTick(agg, tick("SBIN", ist(2026, 11, 7, 11), 104, 1))).toBeNull(); // Saturday
  });

  it("handles out-of-order and duplicate ticks", () => {
    const agg = newAgg("SBIN");
    fold(agg, [tick("SBIN", mon(10, 0, 10), 100, 1_000), tick("SBIN", mon(10, 0, 30), 101, 1_100)]);
    // Earlier than the minute's first tick: becomes the open, can't move the close.
    foldTick(agg, tick("SBIN", mon(10, 0, 5), 98, 1_050));
    expect(ohlcv(agg.open[0])).toEqual([98, 101, 98, 101, 100]);
    // Exact duplicate: nothing changes.
    foldTick(agg, tick("SBIN", mon(10, 0, 30), 101, 1_100));
    expect(ohlcv(agg.open[0])).toEqual([98, 101, 98, 101, 100]);
    // A late tick for an earlier open minute still lands there (h/l only).
    fold(agg, [tick("SBIN", mon(10, 1, 10), 102, 1_200), tick("SBIN", mon(10, 0, 20), 104, 1_150)]);
    expect(ohlcv(agg.open[0])).toEqual([98, 104, 98, 101, 100]);
    expect(agg.open[1].v).toBe(100);
    // Once three newer minutes exist, 10:00 is final: a tick for it is dropped.
    fold(agg, [tick("SBIN", mon(10, 2, 1), 102, 1_300), tick("SBIN", mon(10, 3, 1), 102, 1_400)]);
    expect(agg.open.map((bar) => bar.t)).toEqual([mon(10, 1), mon(10, 2), mon(10, 3)]);
    expect(foldTick(agg, tick("SBIN", mon(10, 0, 50), 120, 1_400))).toBeNull();
  });

  it("continues a stored minute after a restart instead of replacing it", () => {
    const stored: MinuteBar = { symbol: "SBIN", t: mon(10, 0), o: 100, h: 103, l: 99, c: 102, v: 500, source: "live" };
    const agg = seedAgg("SBIN", { ltt: mon(10, 0, 40), volume: 10_000 }, stored);
    const bar = foldTick(agg, tick("SBIN", mon(10, 0, 50), 101, 10_200));
    expect(ohlcv(bar)).toEqual([100, 103, 99, 101, 700]);
    // An earlier minute is final after a restart.
    expect(foldTick(agg, tick("SBIN", mon(9, 59, 59), 90, 10_200))).toBeNull();
  });
});

// ── Store ───────────────────────────────────────────────────────────────────

const countBars = (db: Db) => (db.prepare("select count(*) as n from live_bars_1m").get() as { n: number }).n;
const countQuotes = (db: Db) => (db.prepare("select count(*) as n from live_quotes").get() as { n: number }).n;

describe("live store", () => {
  it("buffers writes: quotes and closed minutes every flush, the forming minute less often", () => {
    const { db, store, clock } = makeStore(mon(10, 0, 10));
    store.record([tick("SBIN", mon(10, 0, 1), 100, 1_000), tick("SBIN", mon(10, 0, 9), 101, 1_100), tick("INFY", mon(10, 0, 5), 50, 10)]);
    expect(countQuotes(db)).toBe(0); // nothing written yet
    // Reads see the buffer anyway.
    expect(store.lastQuotes(["SBIN"]).get("SBIN")?.ltp).toBe(101);
    expect(store.minuteBars("SBIN", mon(10, 0), mon(10, 1))).toHaveLength(1);

    store.flushDue(); // first step writes everything (the forming flush is due)
    expect(countQuotes(db)).toBe(2);
    expect(countBars(db)).toBe(2);

    clock.now = mon(10, 0, 12);
    store.record([tick("SBIN", mon(10, 0, 11), 105, 1_300)]);
    store.flushDue(); // the quote is written, the forming minute waits
    expect((db.prepare("select ltp from live_quotes where symbol = 'SBIN'").get() as { ltp: number }).ltp).toBe(105);
    expect((db.prepare("select c from live_bars_1m where symbol = 'SBIN'").get() as { c: number }).c).toBe(101);

    clock.now = mon(10, 1, 1);
    store.record([tick("SBIN", mon(10, 1, 0), 106, 1_400)]);
    store.flushDue(); // 10:00 has closed: written final, and the 5 s forming interval has passed too
    expect(ohlcv(db.prepare("select o, h, l, c, v from live_bars_1m where symbol = 'SBIN' and t = ?").get(mon(10, 0)) as Bar)).toEqual([100, 105, 100, 105, 300]);
    expect(countBars(db)).toBe(3);
    expect(store.stats().bufferedBars).toBe(0);
  });

  it("survives a restart: last quotes, bars and persistent symbols are all there", () => {
    const first = makeStore(mon(10, 5, 30));
    first.store.setPersistentSymbols(["NIFTY", "SBIN"], "config");
    first.store.pin(["INFY"]);
    first.store.record([tick("SBIN", mon(10, 4, 10), 100, 1_000), tick("SBIN", mon(10, 5, 10), 102, 1_500), tick("INFY", mon(10, 5, 20), 50, 70)]);
    first.store.close();
    first.db.close();

    const db = open(first.dir);
    const store = new SqliteLiveStore({ db, clock: () => mon(10, 5, 40), timer: false });
    expect(store.persistentSymbols().sort()).toEqual(["INFY", "NIFTY", "SBIN"]);
    expect(store.persistentEntries().find((e) => e.symbol === "INFY")?.origin).toBe("pin");
    const quotes = store.lastQuotes(["SBIN", "INFY", "TCS"]);
    expect(quotes.get("SBIN")).toMatchObject({ ltp: 102, volume: 1_500, ltt: mon(10, 5, 10), source: "store" });
    expect(quotes.get("INFY")?.source).toBe("store");
    expect(quotes.has("TCS")).toBe(false);
    expect(store.minuteBars("SBIN", mon(10, 0), mon(10, 10)).map((bar) => bar.t)).toEqual([mon(10, 4), mon(10, 5)]);
    expect(store.previousRun()).toEqual({ lastTickAt: mon(10, 5, 20) + 200, aliveAt: mon(10, 5, 30) });

    // The next tick of the same minute extends the stored bar (500 so far) and its volume continues.
    store.record([tick("SBIN", mon(10, 5, 50), 99, 1_600)]);
    const [bar] = store.minuteBars("SBIN", mon(10, 5), mon(10, 6));
    expect(ohlcv(bar)).toEqual([102, 102, 99, 99, 600]);
    expect(store.lastQuotes(["SBIN"]).get("SBIN")?.source).toBe("socket");
  });

  it("never lets a live bar replace a broker bar", () => {
    const { db, store } = makeStore(mon(10, 2));
    store.writeBrokerBars([{ symbol: "SBIN", t: mon(10, 0), o: 1, h: 2, l: 1, c: 2, v: 99, source: "broker" }]);
    store.record([tick("SBIN", mon(10, 0, 30), 100, 1_000), tick("SBIN", mon(10, 1, 30), 100, 1_100)]);
    expect(store.minuteBars("SBIN", mon(10, 0), mon(10, 2)).map((bar) => bar.source)).toEqual(["broker", "live"]);
    store.flush();
    expect(db.prepare("select source, v from live_bars_1m where t = ?").get(mon(10, 0))).toEqual({ source: "broker", v: 99 });
    // And the other way round, broker bars replace live ones.
    store.writeBrokerBars([{ symbol: "SBIN", t: mon(10, 1), o: 5, h: 5, l: 5, c: 5, v: 5, source: "broker" }]);
    expect(store.minuteBars("SBIN", mon(10, 0), mon(10, 2)).map((bar) => bar.source)).toEqual(["broker", "broker"]);
  });

  it("keeps config and pinned symbols apart", () => {
    const { store } = makeStore(mon(8));
    store.setPersistentSymbols(["NIFTY", "SBIN"], "config");
    store.pin(["SBIN", "INFY"]);
    expect(store.unpin(["SBIN", "INFY"])).toEqual(["SBIN"]); // SBIN stays: the config lists it
    expect(store.persistentSymbols().sort()).toEqual(["NIFTY", "SBIN"]);
    store.setPersistentSymbols(["TCS"]); // the interface's call replaces the pins
    store.setPersistentSymbols(["NIFTY"], "config");
    expect(store.persistentSymbols().sort()).toEqual(["NIFTY", "TCS"]);
  });

  it("deletes minute bars past the retention, at most hourly", () => {
    const { db, store, clock } = makeStore(mon(12), undefined, { retentionDays: 30 });
    store.writeBrokerBars([
      { symbol: "SBIN", t: mon(10) - 31 * DAY_MS, o: 1, h: 1, l: 1, c: 1, v: 1, source: "broker" },
      { symbol: "SBIN", t: mon(10) - 29 * DAY_MS, o: 1, h: 1, l: 1, c: 1, v: 1, source: "broker" },
    ]);
    store.flushDue();
    expect(countBars(db)).toBe(1);
    store.writeBrokerBars([{ symbol: "SBIN", t: mon(10) - 40 * DAY_MS, o: 1, h: 1, l: 1, c: 1, v: 1, source: "broker" }]);
    clock.now = mon(12, 30);
    store.flushDue();
    expect(countBars(db)).toBe(2); // not yet an hour since the last sweep
    clock.now = mon(13, 1);
    store.flushDue();
    expect(countBars(db)).toBe(1);
  });
});

// ── Recovery ────────────────────────────────────────────────────────────────

describe("recovery planning (pure)", () => {
  it("knows when the previous run stopped seeing the market", () => {
    expect(downtimeStart({ lastTickAt: null, aliveAt: null })).toBeNull();
    expect(downtimeStart({ lastTickAt: mon(11, 7, 30), aliveAt: mon(11, 7, 31) })).toBe(mon(11, 7));
    // Last tick in the final minute and alive past the close: nothing was missed.
    expect(downtimeStart({ lastTickAt: fri(15, 29, 58), aliveAt: fri(15, 45) })).toBe(fri(15, 30));
    // Crashed inside the final minute: that minute is partial.
    expect(downtimeStart({ lastTickAt: fri(15, 29, 58), aliveAt: fri(15, 29, 58) })).toBe(fri(15, 29));
  });

  it("cuts a range into session slices, newest first, skipping the weekend", () => {
    expect(sessionSlices(fri(11), mon(10))).toEqual([
      { day: d("2026-11-09"), from: mon(9, 15), to: mon(10) },
      { day: d("2026-11-06"), from: fri(11), to: fri(15, 30) },
    ]);
    expect(sessionSlices(fri(16), mon(9))).toEqual([]);
    expect(latestSessionDay(mon(9))).toBe(d("2026-11-06"));
    expect(recoveryWindowStart(mon(10), 2)).toBe(fri(9, 15));
  });

  it("plans a downtime inside today's session, through the minute now is in", () => {
    const tasks = planRecovery({ symbols: ["SBIN", "INFY"], now: mon(11, 30, 20), from: () => mon(11, 7), sessions: 2 });
    expect(tasks).toEqual([
      { symbol: "SBIN", day: d("2026-11-09"), from: mon(11, 7), to: mon(11, 31) },
      { symbol: "INFY", day: d("2026-11-09"), from: mon(11, 7), to: mon(11, 31) },
    ]);
  });

  it("plans across sessions newest first, within the window, and fetches the latest session for new symbols", () => {
    // Down since Thursday: Thursday is outside the 2-session window.
    const tasks = planRecovery({ symbols: ["SBIN", "NEW"], now: mon(10, 0, 5), from: (s) => (s === "SBIN" ? ist(2026, 11, 5, 12) : null), sessions: 2 });
    expect(tasks).toEqual([
      { symbol: "SBIN", day: d("2026-11-09"), from: mon(9, 15), to: mon(10, 1) },
      { symbol: "NEW", day: d("2026-11-09"), from: mon(9, 15), to: mon(10, 1) },
      { symbol: "SBIN", day: d("2026-11-06"), from: fri(9, 15), to: fri(15, 30) },
    ]);
  });

  it("skips minutes already repaired, and merges overlapping work per symbol and day", () => {
    const tasks = planRecovery({ symbols: ["SBIN", "INFY"], now: mon(10, 0, 5), from: () => fri(14), sessions: 2, repaired: (s, from) => s === "SBIN" && from === fri(14) });
    expect(tasks.map((task) => `${task.symbol}@${task.day === d("2026-11-09") ? "mon" : "fri"}`)).toEqual(["SBIN@mon", "INFY@mon", "INFY@fri"]);
    const merged = mergeTasks(tasks, [{ symbol: "INFY", day: d("2026-11-06"), from: fri(13), to: fri(14, 30) }]);
    expect(merged.find((task) => task.symbol === "INFY" && task.day === d("2026-11-06"))).toMatchObject({ from: fri(13), to: fri(15, 30) });
    expect(merged).toHaveLength(3);
  });
});

/** A fake broker: one bar per session minute in the asked range (marked by price 500). */
function fakeBroker(clock: { now: number }, options: { fail?: (symbol: string, call: number) => Error | null; empty?: (symbol: string) => boolean } = {}) {
  const calls: Array<{ symbol: string; from: number; to: number; at: number }> = [];
  const fetch = async (symbol: string, from: number, to: number): Promise<MinuteBar[]> => {
    calls.push({ symbol, from, to, at: clock.now });
    const error = options.fail?.(symbol, calls.length);
    if (error) throw error;
    if (options.empty?.(symbol)) return [];
    const bars: MinuteBar[] = [];
    // Like the real broker, the minute still forming comes back too (the runner must drop it).
    for (let t = from; t < Math.min(to, clock.now + MINUTE_MS); t += MINUTE_MS) bars.push({ symbol, t, o: 500, h: 501, l: 499, c: 500, v: 10, source: "broker" });
    return bars;
  };
  return { calls, fetch };
}

function makeRecovery(store: SqliteLiveStore, db: Db, clock: { now: number }, broker: ReturnType<typeof fakeBroker>, symbols: string[] = []) {
  const sleeps: number[] = [];
  const recovery = new LiveRecovery({
    db,
    store,
    fetch: broker.fetch,
    symbols: () => symbols,
    clock: () => clock.now,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.now += ms;
    },
  });
  return { recovery, sleeps };
}

describe("recovery runs", () => {
  /** A previous run that saw SBIN and INFY from 10:00 to 10:05 and then died; restarted at 10:30. */
  function crashedAt1005() {
    const first = makeStore(mon(10, 5, 30));
    const ticks: Tick[] = [];
    for (let m = 0; m <= 5; m += 1) ticks.push(tick("SBIN", mon(10, m, 10), 100 + m, 1_000 + m * 100), tick("INFY", mon(10, m, 20), 50, 10 + m));
    first.store.record(ticks);
    first.store.flushDue();
    first.db.close();
    const clock = { now: mon(10, 30, 10) };
    const db = open(first.dir);
    const store = new SqliteLiveStore({ db, clock: () => clock.now, timer: false });
    return { db, store, clock };
  }

  it("repairs the downtime at start from broker minutes, newest first and paced", async () => {
    const { db, store, clock } = crashedAt1005();
    const broker = fakeBroker(clock);
    const { recovery, sleeps } = makeRecovery(store, db, clock, broker);
    const report = await recovery.recoverOnStart(["SBIN", "INFY", "NEW"]);

    expect(broker.calls.map((call) => [call.symbol, call.from, call.to])).toEqual([
      ["SBIN", mon(10, 5), mon(10, 31)],
      ["INFY", mon(10, 5), mon(10, 31)],
      ["NEW", mon(9, 15), mon(10, 31)],
    ]);
    // Waits for 10:30 to close (plus the settle time), then one call every 4 s at most.
    expect(broker.calls[0].at).toBeGreaterThanOrEqual(mon(10, 31, 5));
    expect(broker.calls[1].at - broker.calls[0].at).toBeGreaterThanOrEqual(4_000);
    expect(sleeps.length).toBeGreaterThan(0);
    expect(report).toMatchObject({ reason: "start", planned: 3, calls: 3, failed: 0, pending: 0 });

    // The partial 10:05 minute and the gap are broker bars now; earlier live minutes are untouched.
    const bars = store.minuteBars("SBIN", mon(10, 0), mon(10, 31));
    expect(bars.find((bar) => bar.t === mon(10, 4))?.source).toBe("live");
    expect(bars.filter((bar) => bar.t >= mon(10, 5)).every((bar) => bar.source === "broker")).toBe(true);
    expect(bars.filter((bar) => bar.t >= mon(10, 5))).toHaveLength(26);
    expect(store.minuteBars("NEW", mon(9, 15), mon(10, 31))).toHaveLength(76);
    expect(recovery.status()).toMatchObject({ running: false, pending: 0, last: { calls: 3 } });

    // Idempotent: the same gap again costs nothing.
    const again = await recovery.recoverGap({ from: mon(10, 5), to: mon(10, 30, 59) });
    expect(again).toMatchObject({ calls: 0 });
    expect(broker.calls).toHaveLength(3);
  });

  it("doesn't refetch a session the hub saw to the close, even if the feed already started", async () => {
    const first = makeStore(fri(15, 29, 59));
    first.store.record([tick("SBIN", fri(15, 29, 50), 100, 1_000), tick("INFY", fri(15, 29, 55), 50, 10)]);
    first.store.flushDue();
    first.clock.now = fri(15, 45);
    first.store.close(); // a clean stop after the close
    first.db.close();

    const clock = { now: mon(10, 0, 10) };
    const db = open(first.dir);
    const store = new SqliteLiveStore({ db, clock: () => clock.now, timer: false });
    store.record([tick("SBIN", mon(10, 0, 5), 101, 50_000)]);
    store.flushDue(); // ticks already recorded don't change the plan
    const broker = fakeBroker(clock);
    const { recovery } = makeRecovery(store, db, clock, broker);
    await recovery.recoverOnStart(["SBIN", "INFY"]);
    expect(broker.calls.map((call) => [call.symbol, call.from, call.to])).toEqual([
      ["SBIN", mon(9, 15), mon(10, 1)],
      ["INFY", mon(9, 15), mon(10, 1)],
    ]);
  });

  it("resumes after a stop or a crash part-way, and drops unknown symbols", async () => {
    const { db, store, clock } = crashedAt1005();
    const broker = fakeBroker(clock, {
      fail: (symbol, call) => (call === 2 ? new BrokerError("budget spent", "budget") : symbol === "BAD" ? new BrokerError("unknown", "bad_symbol") : null),
    });
    const first = makeRecovery(store, db, clock, broker);
    const report = await first.recovery.recoverOnStart(["SBIN", "INFY", "BAD"]);
    expect(report).toMatchObject({ calls: 2, pending: 2, error: "budget spent" });
    expect((readKv<{ pending: unknown[] }>(db, RECOVERY_KEY))?.pending).toHaveLength(2);

    // A new process (the hub restarted) picks the remainder up from the database.
    const second = makeRecovery(store, db, clock, broker);
    expect(second.recovery.pending().map((task) => task.symbol)).toEqual(["INFY", "BAD"]);
    const resumed = await second.recovery.resume();
    expect(resumed).toMatchObject({ reason: "resume", calls: 2, failed: 1, pending: 0 });
    expect(store.minuteBars("INFY", mon(10, 5), mon(10, 31)).every((bar) => bar.source === "broker")).toBe(true);
  });

  it("repairs a feed gap for the followed symbols", async () => {
    const { db, store, clock } = makeStore(mon(14, 0, 30));
    const broker = fakeBroker(clock);
    const { recovery } = makeRecovery(store, db, clock, broker, ["SBIN", "INFY"]);
    const report = await recovery.recoverGap({ from: mon(13, 50, 12), to: mon(13, 58, 40) });
    expect(broker.calls.map((call) => [call.symbol, call.from, call.to])).toEqual([
      ["SBIN", mon(13, 50), mon(13, 59)],
      ["INFY", mon(13, 50), mon(13, 59)],
    ]);
    expect(report.bars).toBe(18);
    // Outside the session there's nothing to repair.
    expect(await recovery.recoverGap({ from: mon(16), to: mon(17) })).toMatchObject({ calls: 0, planned: 0 });
  });

  it("stops asking for a day the broker has no minutes for (a holiday)", async () => {
    const { db, store, clock } = makeStore(mon(11, 0, 30));
    const broker = fakeBroker(clock, { empty: () => true });
    const { recovery } = makeRecovery(store, db, clock, broker);
    const report = await recovery.recoverSymbols(["A", "B", "C", "D", "E"]);
    expect(report).toMatchObject({ calls: 3, skipped: 2, pending: 0 });
  });

  it("builds a minute fetcher on FyersClient.history", async () => {
    const asked: unknown[] = [];
    const history: HistoryFn = async (symbol, resolution, fromDay, toDay, priority) => {
      asked.push([symbol, resolution, fromDay, toDay, priority]);
      const bars: Bar[] = [mon(9, 59), mon(10), mon(10, 1), mon(10, 2)].map((t) => ({ t, o: 1, h: 1, l: 1, c: 1, v: 1 }));
      return { bars, coveredFromDay: fromDay, complete: true } satisfies HistoryResult;
    };
    const bars = await minuteFetcher(history)("SBIN", mon(10), mon(10, 2));
    expect(asked).toEqual([["SBIN", "1", d("2026-11-09"), d("2026-11-09"), "background"]]);
    expect(bars).toEqual([mon(10), mon(10, 1)].map((t) => ({ symbol: "SBIN", t, o: 1, h: 1, l: 1, c: 1, v: 1, source: "broker" })));
  });
});

// ── Merge ───────────────────────────────────────────────────────────────────

const minute = (t: number, c: number, v = 10, extra: Partial<MinuteBar> = {}): MinuteBar => ({ symbol: "SBIN", t, o: c, h: c + 1, l: c - 1, c, v, source: "live", ...extra });

describe("merging minutes into candles (pure)", () => {
  it("updates the forming 5m bar and appends new ones; older minutes change nothing", () => {
    const candles = [
      { t: mon(9, 15), o: 90, h: 95, l: 89, c: 94, v: 5_000 },
      { t: mon(9, 20), o: 100, h: 101, l: 99, c: 100.5, v: 30 },
    ];
    const minutes = [minute(mon(9, 19), 500), ...[20, 21, 22, 23, 24, 25, 26].map((m) => minute(mon(9, m), 100 + (m - 20)))];
    const out = mergeMinutes("5m", candles, minutes);
    expect(out[0]).toEqual(candles[0]);
    expect(ohlcv(out[1])).toEqual([100, 105, 99, 104, 50]);
    expect(out[2]).toEqual({ t: mon(9, 25), o: 105, h: 107, l: 104, c: 106, v: 20 });
    expect(out).toHaveLength(3);
    expect(candles[1].c).toBe(100.5); // the input isn't changed
  });

  it("counts only minutes after the stored time when it's known", () => {
    const candles = [{ t: mon(9, 20), o: 100, h: 101, l: 99, c: 100.5, v: 1_000 }];
    const minutes = [20, 21, 22, 23, 24].map((m) => minute(mon(9, m), 100 + (m - 20)));
    const [bar] = mergeMinutes("5m", candles, minutes, { storedAt: mon(9, 22, 30) });
    expect(ohlcv(bar)).toEqual([100, 105, 99, 104, 1_020]);
  });

  it("buckets 15m on the clock and 1h from 09:15 IST", () => {
    expect(bucketOf("15m", mon(9, 29))).toBe(mon(9, 15));
    expect(bucketOf("15m", mon(9, 30))).toBe(mon(9, 30));
    expect(bucketOf("1h", mon(11, 14))).toBe(mon(10, 15));
    expect(bucketOf("1h", mon(15, 29))).toBe(mon(15, 15));
    const hourly = mergeMinutes("1h", [{ t: mon(10, 15), o: 100, h: 100, l: 100, c: 100, v: 0 }], [minute(mon(10, 20), 101), minute(mon(11, 14), 99), minute(mon(11, 15), 98)]);
    expect(hourly.map((bar) => [bar.t, bar.c])).toEqual([
      [mon(10, 15), 99],
      [mon(11, 15), 98],
    ]);
    const quarter = mergeMinutes("15m", [], [minute(mon(9, 15), 100), minute(mon(9, 29), 102), minute(mon(9, 30), 103)]);
    expect(quarter.map((bar) => [bar.t, bar.o, bar.c, bar.v])).toEqual([
      [mon(9, 15), 100, 102, 20],
      [mon(9, 30), 103, 103, 10],
    ]);
  });

  it("builds today's daily bar from minutes, or exactly from the quote", () => {
    const daily = [{ t: d("2026-11-06"), o: 90, h: 99, l: 89, c: 95, v: 1_000_000, dp: 41.2 }];
    const minutes = [minute(mon(9, 15), 96, 500), minute(mon(12, 0), 98, 700)];
    const fromMinutes = mergeMinutes("1d", daily, minutes);
    expect(fromMinutes[0]).toEqual(daily[0]);
    expect(fromMinutes[1]).toEqual({ t: d("2026-11-09"), o: 96, h: 99, l: 95, c: 98, v: 1_200 });
    const quote = { ...tick("SBIN", mon(12, 0, 5), 98.5, 2_500_000), open: 95.5, high: 101, low: 94 };
    const withQuote = mergeMinutes("1d", daily, minutes, { quote });
    expect(withQuote[1]).toEqual({ t: d("2026-11-09"), o: 95.5, h: 101, l: 94, c: 98.5, v: 2_500_000 });
    // A stored forming daily bar keeps its extra fields.
    const forming = mergeMinutes("1d", [{ ...daily[0], t: d("2026-11-09") }], minutes, { quote });
    expect(forming).toHaveLength(1);
    expect(forming[0]).toMatchObject({ t: d("2026-11-09"), dp: 41.2, c: 98.5, v: 2_500_000 });
  });

  it("extends this week's bar or starts a new one", () => {
    const weekly = [{ t: d("2026-11-02"), o: 80, h: 99, l: 79, c: 95, v: 9_000 }];
    const out = mergeMinutes("1w", weekly, [minute(mon(9, 15), 96, 500)]);
    expect(out[1]).toEqual({ t: d("2026-11-09"), o: 96, h: 97, l: 95, c: 96, v: 500 });
    const same = mergeMinutes("1w", [{ ...weekly[0], t: d("2026-11-09") }], [minute(mon(9, 15), 120, 500)]);
    expect(same).toEqual([{ t: d("2026-11-09"), o: 80, h: 121, l: 79, c: 120, v: 9_000 }]);
  });
});
