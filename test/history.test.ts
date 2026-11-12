import { afterEach, describe, expect, it } from "vitest";
import type { Priority } from "../src/broker/budget.js";
import { BrokerError } from "../src/broker/errors.js";
import type { Bar, HistoryResult, Resolution } from "../src/broker/fyers.js";
import { applyCashBhav } from "../src/history/fromBhav.js";
import { extendCoverage, missingRanges, wasAdjusted } from "../src/history/plan.js";
import { hourStart, resample, weekStart } from "../src/history/resample.js";
import { HistoryService, type HistoryBroker } from "../src/history/service.js";
import { readBars, readSeries, writeBars } from "../src/history/store.js";
import { finalBefore, formingNow, windowStart } from "../src/history/timeframes.js";
import { createLogger } from "../src/log.js";
import type { CashBhavRow } from "../src/nse/parsers/cashBhav.js";
import { cashDayStatuses, markDay, writeCashDay } from "../src/nse/store.js";
import { DAY_MS, IST_OFFSET_MS, MINUTE_MS, isWeekday, parseIsoDay } from "../src/time.js";
import { ist, makeHub, type TestHub } from "./support/hub.js";

const d = (iso: string) => parseIsoDay(iso)!;
const quiet = createLogger({ level: "error", secrets: [], write: () => {} });

describe("fetch planning (pure)", () => {
  const cov = { from: 100, to: 200 };

  it("fetches everything when nothing is stored, and nothing when it's covered", () => {
    expect(missingRanges(null, { from: 0, to: 50 }, 1_000, false)).toEqual([{ from: 0, to: 50, part: "all" }]);
    expect(missingRanges(cov, { from: 120, to: 180 }, 1_000, false)).toEqual([]);
  });

  it("fetches only the head and the tail, bridging any gap so coverage stays one range", () => {
    expect(missingRanges(cov, { from: 50, to: 150 }, 1_000, false)).toEqual([{ from: 50, to: 100, part: "head" }]);
    expect(missingRanges(cov, { from: 150, to: 300 }, 1_000, false)).toEqual([{ from: 200, to: 300, part: "tail" }]);
    expect(missingRanges(cov, { from: 400, to: 500 }, 1_000, false)).toEqual([{ from: 200, to: 500, part: "tail" }]);
    expect(missingRanges(cov, { from: 0, to: 50 }, 1_000, false)).toEqual([{ from: 0, to: 100, part: "head" }]);
  });

  it("re-fetches a forming bar only when its stored copy is stale", () => {
    // Everything final (before 200) is covered; the request reaches into the forming bar.
    expect(missingRanges(cov, { from: 150, to: 260 }, 200, false)).toEqual([]);
    expect(missingRanges(cov, { from: 150, to: 260 }, 200, true)).toEqual([{ from: 200, to: 260, part: "tail" }]);
  });

  it("extends coverage only when the new range touches it", () => {
    expect(extendCoverage(cov, { from: 50, to: 100 })).toEqual({ from: 50, to: 200 });
    expect(extendCoverage(cov, { from: 300, to: 400 })).toEqual(cov);
    expect(extendCoverage(null, { from: 5, to: 5 })).toEqual({ from: 5, to: 5 });
    expect(extendCoverage(cov, { from: 7, to: 7 })).toEqual(cov);
  });

  it("notices an adjusted (split) history only on bars that were final", () => {
    const stored: Bar[] = [1, 2, 3].map((t) => ({ t, o: 100, h: 100, l: 100, c: 100, v: 1 }));
    expect(wasAdjusted(stored, [{ t: 2, o: 50, h: 50, l: 50, c: 50, v: 1 }], 3)).toBe(true);
    expect(wasAdjusted(stored, [{ t: 3, o: 50, h: 50, l: 50, c: 50, v: 1 }], 3)).toBe(false); // t=3 was forming
    expect(wasAdjusted(stored, [{ t: 2, o: 100, h: 100, l: 100, c: 100.5, v: 1 }], 3)).toBe(false);
  });
});

describe("timeframes and resampling (pure)", () => {
  it("knows which bars are final", () => {
    // Wednesday 4 Nov 2026.
    expect(finalBefore("1d", ist(2026, 11, 4, 12))).toBe(d("2026-11-04")); // today's bar still forming
    expect(finalBefore("1d", ist(2026, 11, 4, 16, 30))).toBe(d("2026-11-05"));
    expect(finalBefore("1d", ist(2026, 11, 8, 12))).toBe(d("2026-11-07")); // Sunday: Friday's is the last
    expect(finalBefore("15m", ist(2026, 11, 4, 10, 7))).toBe(ist(2026, 11, 4, 10, 0));
    expect(finalBefore("15m", ist(2026, 11, 4, 20))).toBe(ist(2026, 11, 4, 15, 30));
    expect(finalBefore("5m", ist(2026, 11, 9, 8))).toBe(ist(2026, 11, 6, 15, 30)); // Monday pre-open
    expect(formingNow("1d", ist(2026, 11, 4, 15, 45))).toBe(true);
    expect(formingNow("15m", ist(2026, 11, 4, 15, 45))).toBe(false);
    expect(windowStart("1d", ist(2026, 11, 4, 12))).toBe(d("2026-11-04") - (5 * 365 - 3) * DAY_MS);
  });

  it("resamples daily into Monday-stamped weeks", () => {
    const days = ["2026-11-02", "2026-11-03", "2026-11-06", "2026-11-09"].map((iso, i) => ({ t: d(iso), o: 10 + i, h: 20 + i, l: 5 - i, c: 11 + i, v: 100 }));
    expect(weekStart(d("2026-11-08"))).toBe(d("2026-11-02"));
    expect(resample(days, weekStart)).toEqual([
      { t: d("2026-11-02"), o: 10, h: 22, l: 3, c: 13, v: 300 },
      { t: d("2026-11-09"), o: 13, h: 23, l: 2, c: 14, v: 100 },
    ]);
  });

  it("resamples 15-minute bars into session hours starting 09:15 IST", () => {
    const bars = Array.from({ length: 25 }, (_, i) => ({ t: ist(2026, 11, 4, 9, 15) + i * 15 * MINUTE_MS, o: i, h: i + 1, l: i - 1, c: i + 0.5, v: 10 }));
    const hours = resample(bars, hourStart);
    expect(hours.map((bar) => bar.t)).toEqual([9, 10, 11, 12, 13, 14, 15].map((h) => ist(2026, 11, 4, h, 15)));
    expect(hours[0]).toEqual({ t: ist(2026, 11, 4, 9, 15), o: 0, h: 4, l: -1, c: 3.5, v: 40 });
    expect(hours.at(-1)).toMatchObject({ o: 24, v: 10 }); // 15:15–15:30
  });
});

/** A fake broker that serves synthetic weekday bars and records each call. */
class FakeBroker implements HistoryBroker {
  calls: Array<{ symbol: string; resolution: Resolution; from: string; to: string }> = [];
  factor = 1;
  fail: BrokerError | null = null;
  delayMs = 0;
  priorities: Priority[] = [];
  async history(symbol: string, resolution: Resolution, fromDay: number, toDay: number, priority: Priority): Promise<HistoryResult> {
    this.priorities.push(priority);
    this.calls.push({ symbol, resolution, from: new Date(fromDay).toISOString().slice(0, 10), to: new Date(toDay).toISOString().slice(0, 10) });
    if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    if (this.fail) throw this.fail;
    const bars: Bar[] = [];
    for (let day = fromDay; day <= toDay; day += DAY_MS) {
      if (!isWeekday(day)) continue;
      if (resolution === "D") bars.push(bar(day, (100 + (day - d("2020-01-01")) / DAY_MS / 10) / this.factor));
      else for (let i = 0; i < 25; i += 1) bars.push(bar(day - IST_OFFSET_MS + (555 + 15 * i) * MINUTE_MS, 100 + i));
    }
    return { bars, coveredFromDay: fromDay, complete: true };
  }
}
const bar = (t: number, c: number): Bar => ({ t, o: c, h: c + 1, l: c - 1, c, v: 1000 });

describe("history service", () => {
  let t: TestHub;
  let now = ist(2026, 11, 4, 20); // Wednesday evening: today's daily bar is final
  afterEach(() => t?.cleanup());

  const service = (broker: HistoryBroker | null, fetchWaitMs = 5_000) => {
    t = makeHub();
    return new HistoryService({ db: t.db, broker, log: quiet, fetchWaitMs, clock: () => now });
  };

  it("fetches a missing range once, then serves it from the store", async () => {
    now = ist(2026, 11, 4, 20);
    const broker = new FakeBroker();
    const history = service(broker);
    const first = await history.candles("SBIN", "1d", d("2026-10-01"), d("2026-11-04"));
    expect(first.status).toBe("ok");
    expect(first.complete).toBe(true);
    expect(first.candles.at(-1)).toMatchObject({ t: d("2026-11-04"), dp: null });
    expect(broker.calls).toHaveLength(1);
    const again = await history.candles("SBIN", "1d", d("2026-10-05"), d("2026-11-04"));
    expect(again.candles.length).toBe(first.candles.length - 2);
    expect(broker.calls).toHaveLength(1);
  });

  it("fetches only the older part when a request reaches further back", async () => {
    now = ist(2026, 11, 4, 20);
    const broker = new FakeBroker();
    const history = service(broker);
    await history.candles("SBIN", "1d", d("2026-10-01"), d("2026-11-04"));
    await history.candles("SBIN", "1d", d("2026-06-01"), d("2026-11-04"));
    expect(broker.calls.map((c) => [c.from, c.to])).toEqual([
      ["2026-10-01", "2026-11-04"],
      ["2026-06-01", "2026-09-30"],
    ]);
    expect(readSeries(t.db, "SBIN", "1d")!.coverage).toEqual({ from: d("2026-06-01"), to: d("2026-11-05") });
  });

  it("asks only for the new tail the next evening (re-reading one final bar)", async () => {
    now = ist(2026, 11, 4, 20);
    const broker = new FakeBroker();
    const history = service(broker);
    await history.candles("SBIN", "1d", d("2026-10-01"), d("2026-11-04"));
    now = ist(2026, 11, 5, 20);
    const answer = await history.candles("SBIN", "1d", d("2026-10-01"), d("2026-11-05"));
    expect(broker.calls.at(-1)).toMatchObject({ from: "2026-11-04", to: "2026-11-05" });
    expect(answer.candles.at(-1)!.t).toBe(d("2026-11-05"));
  });

  it("drops and re-downloads history the broker adjusted for a split", async () => {
    now = ist(2026, 11, 4, 20);
    const broker = new FakeBroker();
    const history = service(broker);
    await history.candles("SBIN", "1d", d("2026-10-01"), d("2026-11-04"));
    broker.factor = 2; // a 1:2 split: every past price halves
    now = ist(2026, 11, 5, 20);
    const answer = await history.candles("SBIN", "1d", d("2026-10-01"), d("2026-11-05"));
    expect(broker.calls.map((c) => c.from)).toEqual(["2026-10-01", "2026-11-04", "2026-10-01"]);
    expect(answer.candles[0].c).toBeCloseTo((100 + (d("2026-10-01") - d("2020-01-01")) / DAY_MS / 10) / 2, 6);
  });

  it("serves 1w from 1d and 1h from 15m", async () => {
    now = ist(2026, 11, 4, 20);
    const broker = new FakeBroker();
    const history = service(broker);
    const weeks = await history.candles("SBIN", "1w", d("2026-10-07"), d("2026-11-04"));
    expect(weeks.base).toBe("1d");
    expect(weeks.candles.map((w) => new Date(w.t).toISOString().slice(0, 10))).toEqual(["2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26", "2026-11-02"]);
    expect(broker.calls[0]).toMatchObject({ resolution: "D", from: "2026-10-05" }); // whole first week
    const hours = await history.candles("SBIN", "1h", ist(2026, 11, 4, 0), ist(2026, 11, 4, 23));
    expect(hours.base).toBe("15m");
    expect(hours.candles).toHaveLength(7);
    expect(broker.calls[1]).toMatchObject({ resolution: "15" });
  });

  it("clamps to the broker's window instead of asking for what it doesn't serve", async () => {
    now = ist(2026, 11, 4, 20);
    const broker = new FakeBroker();
    const history = service(broker);
    const answer = await history.candles("SBIN", "15m", d("2020-01-01"), ist(2026, 11, 4, 23));
    expect(answer.complete).toBe(true);
    expect(broker.calls[0].from).toBe(new Date(windowStart("15m", now) + IST_OFFSET_MS).toISOString().slice(0, 10));
  });

  it("answers with what's stored when the broker is needed but unavailable", async () => {
    now = ist(2026, 11, 4, 20);
    const broker = new FakeBroker();
    const history = service(broker);
    await history.candles("SBIN", "1d", d("2026-10-01"), d("2026-11-04"));
    broker.fail = new BrokerError("Today's broker data budget is used up.", "budget");
    const answer = await history.candles("SBIN", "1d", d("2026-09-01"), d("2026-11-04"));
    expect(answer.status).toBe("unavailable");
    expect(answer.error?.kind).toBe("budget");
    expect(answer.complete).toBe(false);
    expect(answer.candles[0].t).toBe(d("2026-10-01"));
  });

  it("says not configured without a broker, and unknown_symbol for a symbol the broker rejects", async () => {
    now = ist(2026, 11, 4, 20);
    let answer = await service(null).candles("SBIN", "1d", d("2026-10-01"), d("2026-11-04"));
    expect(answer).toMatchObject({ status: "unavailable", candles: [] });
    expect(answer.error?.kind).toBe("not_configured");
    t.cleanup();
    const broker = new FakeBroker();
    broker.fail = new BrokerError("The broker doesn't know NSE:XYZ-EQ.", "bad_symbol");
    answer = await service(broker).candles("XYZ", "1d", d("2026-10-01"), d("2026-11-04"));
    expect(answer.status).toBe("unknown_symbol");
  });

  it("returns 'pending' instead of hanging, and fetches a series once for concurrent requests", async () => {
    now = ist(2026, 11, 4, 20);
    const broker = new FakeBroker();
    broker.delayMs = 150;
    const history = service(broker, 50);
    const [a, b] = await Promise.all([history.candles("SBIN", "1d", d("2026-10-01"), d("2026-11-04")), history.candles("SBIN", "1d", d("2026-10-01"), d("2026-11-04"))]);
    expect(a.status).toBe("pending");
    expect(b.status).toBe("pending");
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(broker.calls).toHaveLength(1);
    expect((await history.candles("SBIN", "1d", d("2026-10-01"), d("2026-11-04"))).status).toBe("ok");
  });
});

describe("history service latency", () => {
  let t: TestHub;
  afterEach(() => t?.cleanup());

  it("fetches what a chart needs at user priority", async () => {
    t = makeHub();
    const broker = new FakeBroker();
    const history = new HistoryService({ db: t.db, broker, log: quiet, fetchWaitMs: 5_000, clock: () => ist(2026, 11, 4, 20) });
    await history.candles("SBIN", "1d", d("2026-10-01"), d("2026-11-04"));
    expect(broker.priorities).toEqual(["user"]);
  });

  it("answers at once in the session when only the forming bar is stale, refreshing it in the background", async () => {
    t = makeHub();
    let now = ist(2026, 11, 4, 11); // Wednesday 11:00 IST, market open
    const broker = new FakeBroker();
    const history = new HistoryService({ db: t.db, broker, log: quiet, fetchWaitMs: 50, clock: () => now });
    const first = await history.candles("SBIN", "15m", d("2026-11-03"), now);
    expect(first.status).toBe("ok");
    expect(broker.calls).toHaveLength(1);

    now += 3 * MINUTE_MS; // the stored forming bar is now stale
    broker.delayMs = 300; // slower than fetchWaitMs: a waiting request would answer "pending"
    const again = await history.candles("SBIN", "15m", d("2026-11-03"), now);
    expect(again.status).toBe("ok");
    expect(again.candles.length).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 400)); // let the background refresh finish
    expect(broker.calls).toHaveLength(2); // the refresh still went out…
    expect(broker.priorities).toEqual(["user", "refresh"]); // …in the background, at refresh priority
  });
});

describe("daily candles from the NSE cash bhavcopy", () => {
  let t: TestHub;
  afterEach(() => t.cleanup());
  const row = (symbol: string, prevClose: number, close: number): CashBhavRow => ({ symbol, series: "EQ", prevClose, open: close - 1, high: close + 2, low: close - 2, close, volume: 5000, deliveryPct: 42.5 });

  const setup = () => {
    t = makeHub();
    const db = t.db;
    // SBIN and INFY stored (from the broker) through Wed 4 Nov 2026.
    for (const symbol of ["SBIN", "INFY"]) writeBars(db, symbol, "1d", [bar(d("2026-11-03"), 100), bar(d("2026-11-04"), 101)], { from: d("2026-11-03"), to: d("2026-11-05") }, 0);
    writeCashDay(db, d("2026-11-04"), [row("SBIN", 100, 101), row("INFY", 100, 101)], 0);
    return db;
  };

  it("appends the next session and its delivery % without a broker call", () => {
    const db = setup();
    const result = applyCashBhav(db, d("2026-11-05"), [row("SBIN", 101, 103), row("INFY", 101, 99)], quiet);
    expect(result).toEqual({ extended: 2, reset: [] });
    expect(readSeries(db, "SBIN", "1d")!.coverage).toEqual({ from: d("2026-11-03"), to: d("2026-11-06") });
    expect(readBars(db, "SBIN", "1d", d("2026-11-05"), d("2026-11-06"))[0]).toMatchObject({ c: 103, v: 5000 });
  });

  it("drops a symbol's history when PREV_CLOSE shows a corporate action", () => {
    const db = setup();
    const result = applyCashBhav(db, d("2026-11-05"), [row("SBIN", 50.5, 52), row("INFY", 101, 99)], quiet);
    expect(result.reset).toEqual(["SBIN"]);
    expect(readSeries(db, "SBIN", "1d")).toBeNull();
  });

  it("never extends across an unchecked weekday, but does across a known holiday", () => {
    const db = setup();
    expect(applyCashBhav(db, d("2026-11-06"), [row("SBIN", 101, 103)], quiet).extended).toBe(0);
    markDay(db, "cash_bhav", d("2026-11-05"), "holiday", 0, 0);
    expect(applyCashBhav(db, d("2026-11-06"), [row("SBIN", 101, 103)], quiet).extended).toBe(1);
  });

  it("treats a cash 'mismatch' as a holiday when the F&O file confirms it (Diwali: NSE served the previous day's cash file)", () => {
    const db = setup();
    markDay(db, "cash_bhav", d("2026-11-05"), "mismatch", 0, 0, "file is for 2026-11-04");
    expect(applyCashBhav(db, d("2026-11-06"), [row("SBIN", 101, 103)], quiet).extended).toBe(0); // F&O status unknown: don't guess
    markDay(db, "fo_bhav", d("2026-11-05"), "holiday", 0, 0);
    expect(cashDayStatuses(db).get(d("2026-11-05"))).toBe("holiday");
    expect(applyCashBhav(db, d("2026-11-06"), [row("SBIN", 101, 103)], quiet).extended).toBe(1);
  });
});
