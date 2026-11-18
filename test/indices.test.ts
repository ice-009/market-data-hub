import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createKey } from "../src/auth/keys.js";
import { isIndex, isNseOnly } from "../src/broker/symbols.js";
import { basketMembers, BASE_LEVEL, refreshBaskets } from "../src/history/baskets.js";
import { runStart, syncIndexSeries } from "../src/history/fromIndices.js";
import { readBars, readSeries, writeBars } from "../src/history/store.js";
import { enqueueJob } from "../src/jobs/backfill.js";
import { historyDays, runNseHistory } from "../src/jobs/nseHistory.js";
import { dueTasks } from "../src/jobs/scheduler.js";
import { createLogger } from "../src/log.js";
import { NseClient } from "../src/nse/client.js";
import { ARCHIVE_FROM, importDay, indexCloseUrl, type NseContext } from "../src/nse/datasets.js";
import { parseIndexClose, type IndexCloseRow } from "../src/nse/parsers/indexClose.js";
import { checkedDays, markDay, unmappedIndexNames, writeCashDay, writeIndexDay, type DayStatus } from "../src/nse/store.js";
import { basketInfo, BASKETS, indexSymbolForName, NSE_INDICES, SECTORS } from "../src/reference/indices.js";
import { DAY_MS, isoDay, parseIsoDay } from "../src/time.js";
import { ist, makeHub, type TestHub } from "./support/hub.js";
import { fakeFetch, fakeTime, type Route } from "./support/nse.js";

// NSE's daily index file (ind_close_all) → index candles back to 2012, and the
// synthetic equal-weight baskets built from the cash bhavcopy. The fixtures
// are real files from NSE's archive (1 Mar 2012, the earliest month it has;
// 1 Jan 2013; 1 Jul 2015, under the "CNX" names; 17 Nov 2026).

const d = (iso: string) => parseIsoDay(iso)!;
const quiet = createLogger({ level: "error", secrets: [], write: () => {} });
const fixture = (day: string) => readFileSync(new URL(`./fixtures/ind_close_all_${day}.csv`, import.meta.url), "utf8");
const archive = "https://nse.test";

let t: TestHub;
afterEach(() => t?.cleanup());

const row = (name: string, close: number, extra: Partial<IndexCloseRow> = {}): IndexCloseRow => ({ name, open: close - 1, high: close + 2, low: close - 2, close, pointsChange: null, changePct: null, volume: 100, turnoverCr: null, pe: null, pb: null, divYield: null, ...extra });

describe("NSE's index file (real files)", () => {
  it("reads the 2026 file and finds every index the hub serves under its current name", () => {
    const parsed = parseIndexClose(fixture("17112026"));
    expect(parsed.tradeDate).toBe(d("2026-11-17"));
    expect(parsed.mixedDates).toBe(false);
    expect(parsed.badRows).toBe(0);
    expect(parsed.rows.length).toBeGreaterThan(150);
    const nifty = parsed.rows.find((r) => r.name === "Nifty 50")!;
    expect(nifty).toMatchObject({ open: 25277.3, high: 25501.35, low: 25267.3, close: 25387.4, changePct: 0.38, volume: 342549112, pe: 20.68 });
    // Close-only indices print "-" for open/high/low.
    expect(parsed.rows.find((r) => r.name === "Nifty 1D Rate Index")).toMatchObject({ open: null, high: null, low: null, close: 2626.59, volume: null });
    const mapped = new Set(parsed.rows.map((r) => indexSymbolForName(r.name)).filter(Boolean));
    expect(NSE_INDICES.map((info) => info.symbol).filter((symbol) => !mapped.has(symbol))).toEqual([]);
    expect(parsed.rows.find((r) => indexSymbolForName(r.name) === "INDIAVIX")?.close).toBe(15.52);
  });

  it("maps the 2012, 2013 and 2015 names (S&P CNX, CNX) to the same symbols", () => {
    const old = ["NIFTY", "NIFTYNXT50", "NIFTY100", "NIFTY200", "NIFTY500", "NIFTYMIDCAP50", "NIFTYMIDCAP100", "NIFTYSMLCAP100", "BANKNIFTY", "FINNIFTY", "NIFTYIT", "NIFTYAUTO", "NIFTYFMCG", "NIFTYPHARMA", "NIFTYMETAL", "NIFTYREALTY", "NIFTYMEDIA", "NIFTYENERGY", "NIFTYPSUBANK", "NIFTYINFRA", "NIFTYCONSUMPTION", "NIFTYCOMMODITIES", "NIFTYSERVICES"];
    for (const [file, day] of [["01032012", "2012-03-01"], ["01012013", "2013-01-01"], ["01072015", "2015-07-01"]]) {
      const parsed = parseIndexClose(fixture(file));
      expect(parsed.tradeDate).toBe(d(day));
      const mapped = new Set(parsed.rows.map((r) => indexSymbolForName(r.name)));
      expect(old.filter((symbol) => !mapped.has(symbol))).toEqual([]);
    }
    // March 2012's header stops at "P/B," — columns are read by position.
    const march = parseIndexClose(fixture("01032012"));
    expect(march.rows.find((r) => r.name === "S&P CNX Nifty")).toMatchObject({ close: 5339.75, pb: 3.01, divYield: 1.48 });
    expect(indexSymbolForName("S&P CNX Nifty")).toBe("NIFTY");
    expect(indexSymbolForName("CNX Nifty")).toBe("NIFTY");
    expect(indexSymbolForName("  nifty   50 ")).toBe("NIFTY");
    expect(indexSymbolForName("Nifty Alpha 50")).toBeNull();
    expect(parseIndexClose(fixture("01072015")).rows.find((r) => indexSymbolForName(r.name) === "INDIAVIX")).toBeDefined();
  });

  it("rejects NSE's 404 page and garbage", () => {
    expect(parseIndexClose("<!DOCTYPE html>\n<html lang=\"en\">").rows).toEqual([]);
    expect(parseIndexClose("Index Name,Index Date,Open Index Value,High Index Value,Low Index Value,Closing Index Value\nNifty 50,31-02-2026,1,1,1,1\nNifty IT,17-11-2026,1,1,1,-").badRows).toBe(2);
    const two = parseIndexClose("Index Name,Index Date,Open Index Value,High Index Value,Low Index Value,Closing Index Value\nNifty 50,17-11-2026,1,1,1,1\nNifty IT,18-11-2026,1,1,1,1");
    expect(two.mixedDates).toBe(true);
  });

  it("lists every industry of the NIFTY 500 snapshot, with a basket each", () => {
    t = makeHub();
    const all = readFileSync(new URL("../reference/universe/nifty500.csv", import.meta.url), "utf8").split(/\r?\n/).slice(1).filter(Boolean).map((line) => line.split(",")[1]);
    expect([...new Set(all)].filter((industry) => !SECTORS.some((s) => s.industry === industry))).toEqual([]);
    for (const s of SECTORS) for (const index of s.indices) expect(NSE_INDICES.some((info) => info.symbol === index)).toBe(true);
    expect(BASKETS.every((basket) => basket.symbol.startsWith("EW-") && isIndex(basket.symbol) && isNseOnly(basket.symbol))).toBe(true);
    expect([isNseOnly("NIFTY"), isNseOnly("NIFTYAUTO"), isNseOnly("SBIN"), isIndex("NIFTYAUTO"), isIndex("SBIN")]).toEqual([false, true, false, true, false]);
  });
});

describe("index candles from the index file", () => {
  const context = (routes: Record<string, Route | Route[]>, now: number) => {
    t = makeHub();
    const time = fakeTime(now);
    const calls: Array<{ url: string; at: number; headers: Record<string, string> }> = [];
    const ctx: NseContext = { db: t.db, log: quiet, clock: time.clock, urls: { archiveUrl: archive, wwwUrl: "https://www.nse.test" }, nse: new NseClient({ log: quiet, clock: time.clock, sleep: time.sleep, fetch: fakeFetch(routes, calls, time.clock) }) };
    return { ctx, calls };
  };

  it("imports the evening file into NIFTY and the sector indices; a 404 is a holiday, another day's file a mismatch", async () => {
    const { ctx, calls } = context(
      {
        [indexCloseUrl(archive, d("2026-11-17"))]: new Response(fixture("17112026")),
        [indexCloseUrl(archive, d("2026-11-16"))]: new Response(fixture("17112026")),
      },
      ist(2026, 11, 17, 20),
    );
    expect(indexCloseUrl(archive, d("2026-11-17"))).toBe(`${archive}/content/indices/ind_close_all_17112026.csv`);
    expect(await importDay(ctx, "index_close", d("2026-11-17"))).toBe("ok");
    expect(await importDay(ctx, "index_close", d("2026-11-16"))).toBe("mismatch");
    expect(await importDay(ctx, "index_close", d("2026-11-10"))).toBe("holiday");
    expect(calls).toHaveLength(3);
    expect(readBars(ctx.db, "NIFTY", "1d", 0, Number.MAX_SAFE_INTEGER)).toEqual([{ t: d("2026-11-17"), o: 25277.3, h: 25501.35, l: 25267.3, c: 25387.4, v: 342549112 }]);
    expect(readBars(ctx.db, "NIFTYCHEMICALS", "1d", 0, Number.MAX_SAFE_INTEGER)).toHaveLength(1);
    expect(readSeries(ctx.db, "NIFTYIT", "1d")?.coverage).toEqual({ from: d("2026-11-17"), to: d("2026-11-18") });
    // A close-only index: open/high/low are the close.
    expect(unmappedIndexNames(ctx.db)).toContain("Nifty 1D Rate Index");
    expect(readBars(ctx.db, "INDIAVIX", "1d", 0, Number.MAX_SAFE_INTEGER)[0]).toMatchObject({ c: 15.52, v: 0 });
  });

  it("covers the unbroken run of sessions ending at the newest day, across holidays, and joins broker coverage", () => {
    t = makeHub();
    const db = t.db;
    // Mon 2 – Fri 6 Nov 2026; Wed 4 a holiday; NIFTYAUTO has no row on Mon 2 (not launched yet).
    writeIndexDay(db, d("2026-11-02"), [row("Nifty 50", 100)], 0);
    markDay(db, "index_close", d("2026-11-04"), "holiday", 0, 0);
    for (const [day, close] of [["2026-11-03", 101], ["2026-11-05", 102], ["2026-11-06", 103]] as const) writeIndexDay(db, d(day), [row("Nifty 50", close), row("CNX Auto", close * 10)], 0);
    // NIFTY already has broker bars from Fri 6 Nov on.
    writeBars(db, "NIFTY", "1d", [{ t: d("2026-11-06"), o: 1, h: 1, l: 1, c: 103, v: 0 }, { t: d("2026-11-09"), o: 1, h: 1, l: 1, c: 104, v: 0 }], { from: d("2026-11-06"), to: d("2026-11-10") }, 5);
    const result = syncIndexSeries(db, 10);
    expect(result.symbols).toBe(2);
    expect(readSeries(db, "NIFTY", "1d")).toMatchObject({ coverage: { from: d("2026-11-02"), to: d("2026-11-10") }, count: 5, syncedAt: 5 });
    expect(readSeries(db, "NIFTYAUTO", "1d")?.coverage).toEqual({ from: d("2026-11-03"), to: d("2026-11-07") });
    expect(readBars(db, "NIFTYAUTO", "1d", 0, Number.MAX_SAFE_INTEGER).map((bar) => bar.c)).toEqual([1010, 1020, 1030]);

    // A day not checked at all breaks the run.
    const statuses = new Map<number, DayStatus>([[d("2026-11-06"), "ok"], [d("2026-11-05"), "ok"], [d("2026-11-03"), "ok"]]);
    expect(isoDay(runStart(d("2026-11-06"), statuses, () => true, d("2026-11-01")))).toBe("2026-11-05");
    statuses.set(d("2026-11-04"), "holiday");
    expect(isoDay(runStart(d("2026-11-06"), statuses, () => true, d("2026-11-01")))).toBe("2026-11-03");
    expect(isoDay(runStart(d("2026-11-06"), statuses, (day) => day !== d("2026-11-03"), d("2026-11-01")))).toBe("2026-11-05");
  });

  it("downloads the index file in `hub data nse-history`, from Feb 2012, and builds the candles when the run ends", async () => {
    const { ctx, calls } = context({ [indexCloseUrl(archive, d("2012-03-01"))]: new Response(fixture("01032012")), [indexCloseUrl(archive, d("2013-01-01"))]: new Response(fixture("01012013")) }, ist(2026, 11, 16, 20));
    expect(historyDays(ctx.db, "index_close", d("1994-11-03"), d("2012-02-20")).map(isoDay)).toEqual(["2012-02-16", "2012-02-17", "2012-02-20"]);
    expect(isoDay(ARCHIVE_FROM.index_close)).toBe("2012-02-16");
    const job = enqueueJob(ctx.db, "nse_history", { from: "2012-02-29", to: "2012-03-02", datasets: ["index_close"] });
    const final = await runNseHistory(ctx, job.id);
    expect(final.state).toBe("done");
    expect(calls.map((call) => call.url)).toEqual(["2012-02-29", "2012-03-01", "2012-03-02"].map((day) => indexCloseUrl(archive, d(day))));
    expect([...checkedDays(ctx.db, "index_close")].map(([day, status]) => `${isoDay(day)} ${status}`)).toEqual(["2012-02-29 holiday", "2012-03-01 ok", "2012-03-02 holiday"]);
    expect(readBars(ctx.db, "NIFTY", "1d", 0, Number.MAX_SAFE_INTEGER).map((bar) => bar.c)).toEqual([5339.75]);
    expect(readBars(ctx.db, "BANKNIFTY", "1d", 0, Number.MAX_SAFE_INTEGER)).toHaveLength(1);
  });

  it("asks for the index file in the evening run", () => {
    const now = ist(2026, 11, 17, 19);
    expect(dueTasks({ now, runs: new Map(), missing: { cash_bhav: 0, fo_bhav: 0, index_close: 1 }, banTradeDate: d("2026-11-18") })).toContain("index_close");
    expect(dueTasks({ now, runs: new Map(), missing: { cash_bhav: 0, fo_bhav: 0 }, banTradeDate: d("2026-11-18") })).not.toContain("index_close");
  });
});

describe("synthetic baskets", () => {
  /** Cash days for `symbols`: [day, closes, prevCloses]. */
  const cashDay = (db: TestHub["db"], day: string, rows: Array<[string, number, number]>) =>
    writeCashDay(db, d(day), rows.map(([symbol, close, prev]) => ({ symbol, series: "EQ" as const, prevClose: prev, open: prev, high: Math.max(prev, close), low: Math.min(prev, close), close, volume: 1, deliveryPct: null })), 0);

  it("averages members' moves from PREV_CLOSE (split-safe), from the first session with enough members, and extends like a rebuild", () => {
    t = makeHub();
    const db = t.db;
    const [a, b, c] = basketMembers(db, basketInfo("EW-IT")!);
    // Fri 6: first day in the file for all (left out). Mon 9: A +10%, B −10%, C +3% → +1%.
    cashDay(db, "2026-11-06", [[a, 100, 90], [b, 100, 100], [c, 100, 100]]);
    cashDay(db, "2026-11-09", [[a, 110, 100], [b, 90, 100], [c, 103, 100]]);
    // Tue 10: B splits 1:2 (close 46.8 vs adjusted PREV_CLOSE 45 → +4%); A flat; C −1%. A 70% "move" for no one.
    cashDay(db, "2026-11-10", [[a, 110, 110], [b, 46.8, 45], [c, 101.97, 103]]);
    markDay(db, "cash_bhav", d("2026-11-07"), "holiday", 0, 0);
    markDay(db, "cash_bhav", d("2026-11-08"), "holiday", 0, 0);
    const first = refreshBaskets(db, 1);
    expect(first.rebuilt).toContain("EW-IT");
    const bars = readBars(db, "EW-IT", "1d", 0, Number.MAX_SAFE_INTEGER);
    expect(bars.map((bar) => isoDay(bar.t))).toEqual(["2026-11-09", "2026-11-10"]);
    expect(bars[0].c).toBeCloseTo(BASE_LEVEL * 1.01, 6);
    expect(bars[1].c).toBeCloseTo(BASE_LEVEL * 1.01 * 1.01, 6);
    expect(readSeries(db, "EW-IT", "1d")?.coverage).toEqual({ from: d("2026-11-09"), to: d("2026-11-11") });
    // Other industries had no members priced: no basket.
    expect(readSeries(db, "EW-AUTO", "1d")).toBeNull();

    // Next session: extended from the stored level, the same as a rebuild from scratch.
    cashDay(db, "2026-11-11", [[a, 121, 110], [b, 46.8, 46.8], [c, 101.97, 101.97], ["ZZZOUT", 200, 100]]);
    const second = refreshBaskets(db, 2);
    expect(second.extended).toContain("EW-IT");
    expect(second.rebuilt).toEqual([]);
    const extended = readBars(db, "EW-IT", "1d", 0, Number.MAX_SAFE_INTEGER).map((bar) => bar.c);
    expect(extended[2]).toBeCloseTo(BASE_LEVEL * 1.01 * 1.01 * (1 + 0.1 / 3), 6);
    expect(refreshBaskets(db, 3)).toEqual({ rebuilt: [], extended: [] });

    // Older history arriving (a download) rebuilds from scratch.
    cashDay(db, "2026-11-05", [[a, 90, 90], [b, 100, 100], [c, 100, 100]]);
    const third = refreshBaskets(db, 4);
    expect(third.rebuilt).toContain("EW-IT");
    // Fri 6 now counts (all three had a previous day): A +11.1%, B 0, C 0.
    expect(readBars(db, "EW-IT", "1d", 0, Number.MAX_SAFE_INTEGER).map((bar) => isoDay(bar.t))).toEqual(["2026-11-06", "2026-11-09", "2026-11-10", "2026-11-11"]);
  });

  it("waits for MIN_MEMBERS members and leaves out impossible moves", () => {
    t = makeHub();
    const db = t.db;
    const [a, b, c] = basketMembers(db, basketInfo("EW-IT")!);
    cashDay(db, "2026-11-09", [[a, 100, 100], [b, 100, 100]]);
    cashDay(db, "2026-11-10", [[a, 101, 100], [b, 101, 100], [c, 100, 100]]);
    cashDay(db, "2026-11-11", [[a, 102.01, 101], [b, 202, 101], [c, 101, 100]]);
    cashDay(db, "2026-11-12", [[a, 102.01, 102.01], [b, 202, 202], [c, 102.01, 101]]);
    refreshBaskets(db, 1);
    // Tue 10: only A and B have a previous day (2 < 3); Wed 11: A +1%, C +1%, B's +100% left out.
    const bars = readBars(db, "EW-IT", "1d", 0, Number.MAX_SAFE_INTEGER);
    expect(bars.map((bar) => isoDay(bar.t))).toEqual(["2026-11-12"]);
  });
});

describe("the API", () => {
  const withKey = (now: number) => {
    t = makeHub({ clock: () => now });
    const { key } = createKey(t.db, "test", ["history"]);
    const app = t.app();
    const get = async (path: string) => {
      const res = await app.request(path, { headers: { authorization: `Bearer ${key}` } });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { status: res.status, body: (await res.json()) as any };
    };
    return { get };
  };

  it("serves NSE-file indices and baskets from the store, labelled, without the broker", async () => {
    const { get } = withKey(ist(2026, 11, 18, 12));
    const db = t.db;
    for (const [day, close] of [["2026-11-16", 100], ["2026-11-17", 101]] as const) writeIndexDay(db, d(day), [row("Nifty Auto", close), row("Nifty 50", close * 250)], 0);
    syncIndexSeries(db, 0);
    const [a, b, c] = basketMembers(db, basketInfo("EW-IT")!);
    for (const day of ["2026-11-13", "2026-11-16", "2026-11-17"]) writeCashDay(db, d(day), [a, b, c].map((symbol) => ({ symbol, series: "EQ" as const, prevClose: 100, open: 100, high: 101, low: 99, close: 101, volume: 1, deliveryPct: null })), 0);
    markDay(db, "cash_bhav", d("2026-11-14"), "holiday", 0, 0);
    markDay(db, "cash_bhav", d("2026-11-15"), "holiday", 0, 0);
    refreshBaskets(db, 0);

    const auto = await get("/v1/candles?symbol=NIFTYAUTO&tf=1d&from=2026-11-01&to=2026-11-17");
    expect(auto.status).toBe(200);
    expect(auto.body).toMatchObject({ symbol: "NIFTYAUTO", synthetic: false, complete: false });
    expect(auto.body.candles.map((bar: { c: number }) => bar.c)).toEqual([100, 101]);
    expect((await get("/v1/candles?symbol=NIFTYAUTO&tf=15m")).status).toBe(404);
    const basket = await get("/v1/candles?symbol=EW-IT&tf=1d&from=2026-11-01&to=2026-11-17");
    expect(basket.status).toBe(200);
    expect(basket.body.synthetic).toBe(true);
    expect(basket.body.candles.map((bar: { c: number }) => bar.c)).toEqual([1010, 1020.1]);
    expect((await get("/v1/candles?symbol=SBIN&tf=1d&from=2026-11-16&to=2026-11-17")).body.synthetic).toBeUndefined();

    // The batch never queues them, and doesn't blame the broker for their missing years.
    const batch = await get("/v1/candles/batch?symbols=NIFTYAUTO,EW-IT&tf=1d&from=2025-01-01&to=2026-11-17");
    expect(batch.status).toBe(200);
    expect(batch.body.queued).toEqual([]);
    expect(batch.body.warning).toBeUndefined();
    expect(batch.body.series["EW-IT"].synthetic).toBe(true);
    expect(batch.body.series.NIFTYAUTO).toMatchObject({ synthetic: false });

    const list = await get("/v1/indices");
    expect(list.status).toBe(200);
    expect(list.body.indices.find((i: { symbol: string }) => i.symbol === "NIFTYAUTO")).toMatchObject({ name: "Nifty Auto", synthetic: false, intraday: false, firstSession: "2026-11-16", lastSession: "2026-11-17", sessions: 2 });
    expect(list.body.indices.find((i: { symbol: string }) => i.symbol === "NIFTY")).toMatchObject({ intraday: true, sessions: 2 });
    expect(list.body.baskets.find((i: { symbol: string }) => i.symbol === "EW-IT")).toMatchObject({ synthetic: true, industry: "Information Technology", standsFor: "NIFTYIT", firstSession: "2026-11-16", sessions: 2 });
    expect(list.body.sectors.find((s: { industry: string }) => s.industry === "Information Technology")).toEqual({ industry: "Information Technology", indices: ["NIFTYIT"], basket: "EW-IT" });
    expect(list.body.basketMethod).toMatch(/survivorship/);
    expect(list.body.indexFile).toMatchObject({ firstSession: "2026-11-16", lastSession: "2026-11-17", sessions: 2 });
  });

  it("feeds the market regime from the index file's NIFTY", async () => {
    const { get } = withKey(ist(2026, 11, 18, 12));
    const db = t.db;
    // 320 weekdays (over 420 days) of NIFTY rising 1 a day, through Tue 17 Nov 2026.
    const days: number[] = [];
    for (let day = d("2026-11-17"); days.length < 320; day -= DAY_MS) if (![0, 6].includes(new Date(day).getUTCDay())) days.unshift(day);
    days.forEach((day, i) => writeIndexDay(db, day, [row("Nifty 50", 20000 + i)], 0));
    syncIndexSeries(db, 0);
    const regime = await get("/v1/market/regime?universe=nifty50");
    expect(regime.status).toBe(200);
    expect(regime.body.nifty).toMatchObject({ close: 20319, bars: expect.any(Number) });
    expect(regime.body.niftyAbove200).toBe(true);
  });
});
