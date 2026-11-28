import { afterEach, describe, expect, it } from "vitest";
import { readBars, readSeries, writeBars } from "../src/history/store.js";
import { cancelJob, enqueueJob, getJob, nextRunnableJob, type NseHistoryParams } from "../src/jobs/backfill.js";
import { historyDays, runNseHistory, validateNseHistory } from "../src/jobs/nseHistory.js";
import { createLogger } from "../src/log.js";
import { NseClient } from "../src/nse/client.js";
import { ARCHIVE_FROM, cashBhavUrl, foBhavUrl, importDay, mtoUrl, type NseContext } from "../src/nse/datasets.js";
import { oiFact } from "../src/nse/openInterest.js";
import { parseCmBhav } from "../src/nse/parsers/cmBhav.js";
import { aggregateStockFutures, parseFoBhavLegacy } from "../src/nse/parsers/foBhav.js";
import { parseMto } from "../src/nse/parsers/mto.js";
import { checkedDays, markDay, readFoSymbol, readRuns, type DayDataset } from "../src/nse/store.js";
import { isoDay, parseIsoDay } from "../src/time.js";
import { ist, makeHub, type TestHub } from "./support/hub.js";
import { fakeFetch, fakeTime, makeZip, type Route } from "./support/nse.js";

// NSE's archive before 8 Jul 2024 (old formats, synthetic rows in NSE's
// layouts — real files were checked by hand: cm03NOV1994, cm03JAN1996,
// cm04JAN2010, cm05JUL2024, MTO_03012005, fo09NOV2001, fo05JUL2024) and the
// `hub data nse-history` job that downloads it.

const d = (iso: string) => parseIsoDay(iso)!;
const quiet = createLogger({ level: "error", secrets: [], write: () => {} });
const MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
/** "05-JUL-2024" (NSE pads the day in newer files; "3-NOV-1994" in the oldest). */
const nseDate = (day: number, pad = true) => `${pad ? String(new Date(day).getUTCDate()).padStart(2, "0") : new Date(day).getUTCDate()}-${MON[new Date(day).getUTCMonth()]}-${new Date(day).getUTCFullYear()}`;

/** An old-format cash bhavcopy: [symbol, series, close, prevClose]. */
function cmCsv(day: number, rows: Array<[string, string, number, number]>, pad = true): string {
  return [
    "SYMBOL,SERIES,OPEN,HIGH,LOW,CLOSE,LAST,PREVCLOSE,TOTTRDQTY,TOTTRDVAL,TIMESTAMP,TOTALTRADES,ISIN,",
    ...rows.map(([symbol, series, close, prev]) => `${symbol},${series},${close},${close + 1},${close - 1},${close},${close},${prev},1000,${close * 1000},${nseDate(day, pad)},10,INE000000000,`),
  ].join("\n");
}
const cmZip = (day: number, rows: Array<[string, string, number, number]>) => makeZip("cm.csv", Buffer.from(cmCsv(day, rows)));

function mto(day: number, rows: Array<[string, string, number]>): string {
  return [
    "Security Wise Delivery Position - Compulsory Rolling Settlement",
    "10,MTO,05072024,1,0000002",
    `Trade Date <${nseDate(day)}>,Settlement Type <N>,Settlement No <2024127>,Settlement Date <08-JUL-2024>`,
    "Record Type,Sr No,Name of Security,Quantity Traded,Deliverable Quantity(gross across client level),% of Deliverable Quantity to Traded Quantity",
    ...rows.map(([symbol, series, pct], i) => `20,${i + 1},${symbol},${series},1000,${pct * 10},${pct.toFixed(2)}`),
  ].join("\r\n");
}

/** An old-format F&O bhavcopy: [instrument, symbol, expiry, close, oi, chgOi]. */
function foCsv(day: number, rows: Array<[string, string, number, number, number, number]>): string {
  const expiry = (t: number) => `${String(new Date(t).getUTCDate()).padStart(2, "0")}-${MON[new Date(t).getUTCMonth()][0]}${MON[new Date(t).getUTCMonth()].slice(1).toLowerCase()}-${new Date(t).getUTCFullYear()}`;
  return [
    "INSTRUMENT,SYMBOL,EXPIRY_DT,STRIKE_PR,OPTION_TYP,OPEN,HIGH,LOW,CLOSE,SETTLE_PR,CONTRACTS,VAL_INLAKH,OPEN_INT,CHG_IN_OI,TIMESTAMP,",
    ...rows.map(([instrument, symbol, exp, close, oi, chg]) => `${instrument},${symbol},${expiry(exp)},0,XX,${close},${close},${close},${close},${close},12,1.5,${oi},${chg},${nseDate(day)},`),
  ].join("\n");
}
const foZip = (day: number, rows: Array<[string, string, number, number, number, number]>) => makeZip("fo.csv", Buffer.from(foCsv(day, rows)));

/** A current-format (sec_bhavdata_full) cash bhavcopy with one SBIN row. */
const secFull = (day: number, close: number) =>
  `SYMBOL, SERIES, DATE1, PREV_CLOSE, OPEN_PRICE, HIGH_PRICE, LOW_PRICE, LAST_PRICE, CLOSE_PRICE, AVG_PRICE, TTL_TRD_QNTY, TURNOVER_LACS, NO_OF_TRADES, DELIV_QTY, DELIV_PER\nSBIN, EQ, ${nseDate(day)}, ${close - 1}, ${close}, ${close}, ${close}, ${close}, ${close}, ${close}, 1000, 1, 1, 500, 50.00\n`;

describe("NSE's old formats (pure)", () => {
  it("reads the old cash bhavcopy into the current rows, without delivery % (and with the ISIN where the file has one)", () => {
    const parsed = parseCmBhav(cmCsv(d("1994-11-03"), [["ACC", "EQ", 4636.75, 0], ["ACC", "BE", 1, 1], ["XYZ", "BE", 10, 9], ["SRERAYHY+H", "EQ", 8.5, 8.85], ["NCD1", "N1", 100, 100]], false));
    expect(parsed.tradeDate).toBe(d("1994-11-03"));
    expect(parsed.badRows).toBe(0);
    expect(parsed.rows.map((row) => `${row.symbol}/${row.series}`)).toEqual(["ACC/EQ", "XYZ/BE", "SRERAYHY+H/EQ"]); // EQ wins; debt series skipped
    expect(parsed.rows[0]).toEqual({ symbol: "ACC", series: "EQ", prevClose: 0, open: 4636.75, high: 4637.75, low: 4635.75, close: 4636.75, volume: 1000, deliveryPct: null, isin: "INE000000000" });
    expect(parseCmBhav(`${cmCsv(d("2010-01-04"), [["SBIN", "EQ", 1, 1]])}\nINFY,EQ,1,1,1,1,1,1,1,1,05-JAN-2010,`).mixedDates).toBe(true);
    expect(parseCmBhav("garbage\n1,2").rows).toEqual([]);
  });

  it("reads delivery % from the MTO file, keyed by symbol and series", () => {
    const parsed = parseMto(mto(d("2005-01-03"), [["3MINDIA", "EQ", 70.01], ["XYZ", "BE", 100]]));
    expect(parsed.tradeDate).toBe(d("2005-01-03"));
    expect([...parsed.deliveryPct]).toEqual([["3MINDIA|EQ", 70.01], ["XYZ|BE", 100]]);
    expect(parseMto("20,1,BAD,EQ,1,1,abc").badRows).toBe(1);
  });

  it("reads stock futures from the old F&O bhavcopy; without a previous close there is no buildup", () => {
    const day = d("2001-11-09");
    const parsed = parseFoBhavLegacy(foCsv(day, [["FUTIDX", "NIFTY", d("2001-11-29"), 990, 1, 1], ["FUTSTK", "ACC", d("2001-11-29"), 147.55, 175500, 175500], ["FUTSTK", "ACC", d("2001-12-27"), 148, 3000, 3000], ["OPTSTK", "ACC", d("2001-11-29"), 5, 1, 1]]));
    expect(parsed.tradeDate).toBe(day);
    expect(parsed.contracts).toHaveLength(2);
    const [acc] = aggregateStockFutures(parsed.contracts, day);
    expect(acc).toMatchObject({ symbol: "ACC", expiries: 2, oi: 178500, chgOi: 178500, lot: null, underlying: null, near: { expiry: d("2001-11-29"), close: 147.55, prevClose: 0, volume: 12 } });
    expect(oiFact(acc)).toMatchObject({ buildup: null, pricePct: 0 });
  });

  it("asks for the old formats up to 5 Jul 2024 and the current ones from 8 Jul", () => {
    const a = "https://nse.test";
    expect(cashBhavUrl(a, d("1996-01-03"))).toBe(`${a}/content/historical/EQUITIES/1996/JAN/cm03JAN1996bhav.csv.zip`);
    expect(cashBhavUrl(a, d("2024-07-05"))).toBe(`${a}/content/historical/EQUITIES/2024/JUL/cm05JUL2024bhav.csv.zip`);
    expect(cashBhavUrl(a, d("2024-07-08"))).toBe(`${a}/products/content/sec_bhavdata_full_08072024.csv`);
    expect(foBhavUrl(a, d("2001-11-09"))).toBe(`${a}/content/historical/DERIVATIVES/2001/NOV/fo09NOV2001bhav.csv.zip`);
    expect(foBhavUrl(a, d("2024-07-08"))).toBe(`${a}/content/fo/BhavCopy_NSE_FO_0_0_0_20240708_F_0000.csv.zip`);
    expect(mtoUrl(a, d("2005-01-03"))).toBe(`${a}/archives/equities/mto/MTO_03012005.DAT`);
  });
});

describe("NSE history", () => {
  let t: TestHub;
  afterEach(() => t.cleanup());
  const archive = "https://nse.test";
  const context = (routes: Record<string, Route | Route[]>, now: number) => {
    t = makeHub();
    const time = fakeTime(now);
    const calls: Array<{ url: string; at: number; headers: Record<string, string> }> = [];
    const ctx: NseContext = { db: t.db, log: quiet, clock: time.clock, urls: { archiveUrl: archive }, nse: new NseClient({ log: quiet, clock: time.clock, sleep: time.sleep, fetch: fakeFetch(routes, calls, time.clock) }) };
    return { ctx, calls, time };
  };
  const statuses = (ctx: NseContext, dataset: "cash_bhav" | "fo_bhav") => [...checkedDays(ctx.db, dataset)].sort(([a], [b]) => a - b).map(([day, status]) => `${isoDay(day)} ${status}`);
  const deliveryOf = (ctx: NseContext, symbol: string, day: number) => (ctx.db.prepare("select deliv_pct from cash_bhav where symbol = ? and day = ?").get(symbol, day) as { deliv_pct: number | null }).deliv_pct;

  it("stores an old-format cash day with delivery % from its MTO file, and leaves stored candles alone", async () => {
    const day = d("2005-01-03");
    const { ctx, calls } = context(
      {
        [cashBhavUrl(archive, day)]: new Response(cmZip(day, [["SBIN", "EQ", 600, 590], ["XYZ", "BE", 10, 9]])),
        [mtoUrl(archive, day)]: new Response(mto(day, [["SBIN", "EQ", 44.5]])),
      },
      ist(2026, 11, 16, 20),
    );
    // A stored series that ends the session before: the evening run would extend it; history must not.
    writeBars(ctx.db, "SBIN", "1d", [{ t: d("2004-12-31"), o: 1, h: 1, l: 1, c: 590, v: 1 }], { from: d("2004-12-31"), to: d("2005-01-01") }, 0);
    markDay(ctx.db, "cash_bhav", d("2004-12-31"), "ok", 1, 0);
    expect(await importDay(ctx, "cash_bhav", day, { extend: false })).toBe("ok");
    expect(calls.map((call) => call.url)).toEqual([cashBhavUrl(archive, day), mtoUrl(archive, day)]);
    expect(deliveryOf(ctx, "SBIN", day)).toBe(44.5);
    expect(deliveryOf(ctx, "XYZ", day)).toBeNull();
    expect(readSeries(ctx.db, "SBIN", "1d")!.coverage!.to).toBe(d("2005-01-01"));
    expect(readBars(ctx.db, "SBIN", "1d", 0, Number.MAX_SAFE_INTEGER)).toHaveLength(1);
  });

  it("stores an old-format day without delivery % when there is no MTO file, or one for another date; never asks before 2002", async () => {
    const [a, b, early] = [d("2005-01-03"), d("2005-01-04"), d("1999-01-04")];
    const { ctx, calls } = context(
      {
        [cashBhavUrl(archive, a)]: new Response(cmZip(a, [["SBIN", "EQ", 600, 590]])),
        [cashBhavUrl(archive, b)]: new Response(cmZip(b, [["SBIN", "EQ", 601, 600]])),
        [mtoUrl(archive, b)]: new Response(mto(a, [["SBIN", "EQ", 44.5]])),
        [cashBhavUrl(archive, early)]: new Response(cmZip(early, [["SBIN", "EQ", 100, 99]])),
      },
      ist(2026, 11, 16, 20),
    );
    expect(await importDay(ctx, "cash_bhav", a, { extend: false })).toBe("ok");
    expect(await importDay(ctx, "cash_bhav", b, { extend: false })).toBe("ok");
    expect(await importDay(ctx, "cash_bhav", early, { extend: false })).toBe("ok");
    expect([deliveryOf(ctx, "SBIN", a), deliveryOf(ctx, "SBIN", b), deliveryOf(ctx, "SBIN", early)]).toEqual([null, null, null]);
    expect(calls.some((call) => call.url === mtoUrl(archive, early))).toBe(false);
  });

  it("lists every weekend day for the cash market, and only the weekends it traded for F&O", () => {
    const { ctx } = context({}, ist(2026, 11, 16, 20));
    const days = (dataset: DayDataset, from: string, to: string) => historyDays(ctx.db, dataset, d(from), d(to)).map(isoDay);
    expect(days("cash_bhav", "2013-10-31", "2013-11-04")).toEqual(["2013-10-31", "2013-11-01", "2013-11-02", "2013-11-03", "2013-11-04"]);
    expect(days("fo_bhav", "2013-10-31", "2013-11-04")).toEqual(["2013-10-31", "2013-11-01", "2013-11-04"]);
    // Sun 3 Nov 2013: a weekend session WEEKEND_SESSIONS doesn't list (Muhurat). Once the cash market shows it, F&O asks for it too.
    markDay(ctx.db, "cash_bhav", d("2013-11-03"), "ok", 1, 0);
    markDay(ctx.db, "cash_bhav", d("2013-11-02"), "holiday", 0, 0);
    markDay(ctx.db, "fo_bhav", d("2013-10-31"), "ok", 1, 0);
    expect(days("cash_bhav", "2013-10-31", "2013-11-04")).toEqual(["2013-10-31", "2013-11-01", "2013-11-04"]);
    expect(days("fo_bhav", "2013-10-31", "2013-11-04")).toEqual(["2013-11-01", "2013-11-03", "2013-11-04"]);
    expect(days("pr", "2013-10-31", "2013-11-04")).toEqual(["2013-10-31", "2013-11-01", "2013-11-03", "2013-11-04"]);
    // Sat 20 Jan 2024, a listed special session: asked for from the start.
    expect(days("fo_bhav", "2024-01-18", "2024-01-22")).toEqual(["2024-01-18", "2024-01-19", "2024-01-20", "2024-01-22"]);
    // Nothing before the archive starts: no F&O before the first stock futures, no PR zip before 2010.
    expect(days("fo_bhav", "2001-11-05", "2001-11-09")).toEqual(["2001-11-09"]);
    expect(days("pr", "2009-12-30", "2010-01-04")).toEqual(["2010-01-01", "2010-01-04"]);
    expect(historyDays(ctx.db, "cash_bhav", d("1994-10-01"), ARCHIVE_FROM.cash_bhav).map(isoDay)).toEqual(["1994-11-03"]);
  });

  it("validates the range", () => {
    const today = d("2026-11-16");
    const params = (over: Partial<NseHistoryParams>): NseHistoryParams => ({ from: "1994-11-03", to: "2026-11-15", datasets: ["cash_bhav", "fo_bhav"], ...over });
    expect(validateNseHistory(params({}), today)).toBeNull();
    expect(validateNseHistory(params({ to: "2026-11-16" }), today)).toMatch(/before today/);
    expect(validateNseHistory(params({ from: "2026-11-15", to: "2026-11-14" }), today)).toMatch(/on or before/);
    expect(validateNseHistory(params({ from: "1994-13-01" }), today)).toMatch(/dates like/);
    expect(validateNseHistory(params({ datasets: [] }), today)).toMatch(/cash, fo, pr, indices or options/);
  });

  // Thu 4 Jul – Tue 9 Jul 2024: old formats through Fri 5 Jul, the current ones from Mon 8 Jul.
  const RANGE = { from: "2024-07-04", to: "2024-07-09", datasets: ["cash_bhav", "fo_bhav"] } satisfies NseHistoryParams;
  const exp = d("2024-07-25");
  const routesFor = (): Record<string, Route | Route[]> => ({
    [cashBhavUrl(archive, d("2024-07-04"))]: new Response(cmZip(d("2024-07-04"), [["SBIN", "EQ", 840, 835]])),
    [cashBhavUrl(archive, d("2024-07-05"))]: new Response(cmZip(d("2024-07-05"), [["SBIN", "EQ", 842, 840]])),
    [mtoUrl(archive, d("2024-07-05"))]: new Response(mto(d("2024-07-05"), [["SBIN", "EQ", 51.2]])),
    [cashBhavUrl(archive, d("2024-07-08"))]: new Response(secFull(d("2024-07-08"), 845)),
    [cashBhavUrl(archive, d("2024-07-09"))]: new Response(secFull(d("2024-07-09"), 850)),
    [foBhavUrl(archive, d("2024-07-04"))]: new Response(foZip(d("2024-07-04"), [["FUTSTK", "SBIN", exp, 843, 1000, 10]])),
    [foBhavUrl(archive, d("2024-07-05"))]: new Response(foZip(d("2024-07-05"), [["FUTSTK", "SBIN", exp, 845, 1100, 100]])),
  });

  it("downloads a range across the format change, records nothing the evening run relies on, and resumes without asking again", async () => {
    const { ctx, calls } = context(routesFor(), ist(2026, 11, 16, 20));
    const job = enqueueJob(ctx.db, "nse_history", RANGE);
    expect(nextRunnableJob(ctx.db, ctx.clock())?.kind).toBe("nse_history");
    const final = await runNseHistory(ctx, job.id);
    expect(final.state).toBe("done");
    expect(statuses(ctx, "cash_bhav")).toEqual(["2024-07-04 ok", "2024-07-05 ok", "2024-07-06 holiday", "2024-07-07 holiday", "2024-07-08 ok", "2024-07-09 ok"]);
    expect(statuses(ctx, "fo_bhav")).toEqual(["2024-07-04 ok", "2024-07-05 ok", "2024-07-08 holiday", "2024-07-09 holiday"]);
    expect(final.message).toMatch(/^Done — 6 sessions stored, 4 days without a file/);
    expect(deliveryOf(ctx, "SBIN", d("2024-07-05"))).toBe(51.2);
    expect(deliveryOf(ctx, "SBIN", d("2024-07-08"))).toBe(50);
    expect(readFoSymbol(ctx.db, "SBIN", 0, Number.MAX_SAFE_INTEGER).map((record) => record.oi)).toEqual([1000, 1100]);
    // The scheduler spaces its evening retries by these runs: a history download leaves them alone.
    expect(readRuns(ctx.db).has("cash_bhav")).toBe(false);
    expect(readRuns(ctx.db).has("fo_bhav")).toBe(false);

    const asked = calls.length;
    const again = await runNseHistory(ctx, enqueueJob(ctx.db, "nse_history", RANGE).id);
    expect(again.message).toBe("Done — 0 sessions stored, 0 days without a file.");
    expect(calls.length).toBe(asked);
  });

  it("pauses for market hours and resumes after the close", async () => {
    const { ctx, calls, time } = context(routesFor(), ist(2026, 11, 16, 9, 14) + 58_000);
    const job = enqueueJob(ctx.db, "nse_history", RANGE);
    const paused = await runNseHistory(ctx, job.id);
    expect(paused.state).toBe("paused");
    expect(paused.message).toMatch(/market hours/);
    expect(paused.resumeAfter).toBe(ist(2026, 11, 16, 15, 35));
    expect(calls.length).toBeGreaterThan(0);
    expect(nextRunnableJob(ctx.db, ctx.clock())).toBeNull();
    time.state.now = ist(2026, 11, 16, 15, 40);
    expect(nextRunnableJob(ctx.db, ctx.clock())?.id).toBe(job.id);
    expect((await runNseHistory(ctx, job.id)).state).toBe("done");
    expect(statuses(ctx, "cash_bhav")).toHaveLength(6);
  });

  it("pauses after NSE refuses days in a row", async () => {
    const busy = () => new Response("busy", { status: 503 });
    const routes = Object.fromEntries(["2024-07-04", "2024-07-05", "2024-07-06", "2024-07-07"].map((day) => [cashBhavUrl(archive, d(day)), busy]));
    const { ctx } = context(routes, ist(2026, 11, 16, 20));
    const refused = await runNseHistory(ctx, enqueueJob(ctx.db, "nse_history", RANGE).id);
    expect(refused.state).toBe("paused");
    expect(refused.message).toMatch(/3 days in a row/);
    expect(refused.resumeAfter).toBe(ctx.clock() + 15 * 60_000);
    expect(checkedDays(ctx.db, "cash_bhav").size).toBe(0);
  });

  it("doesn't start, and pauses, while free disk is under the floor; resumes once there's room", async () => {
    const { ctx, calls } = context(routesFor(), ist(2026, 11, 16, 20));
    let free = 1.5e9;
    ctx.disk = { dir: t.dir, minFreeBytes: 2e9, free: () => free };
    const job = enqueueJob(ctx.db, "nse_history", RANGE);
    const refused = await runNseHistory(ctx, job.id);
    expect(refused.state).toBe("paused");
    expect(refused.message).toBe("Paused: only 1.5 GB free on the disk, under the 2.0 GB kept free (HUB_DISK_MIN_GB). Free some space; the hub server retries every 30 minutes (or run the command again).");
    expect(refused.resumeAfter).toBe(ctx.clock() + 30 * 60_000);
    expect(calls).toHaveLength(0);

    // Room again: it runs, until the disk fills up after two cash days.
    free = 50e9;
    const paused = await runNseHistory(ctx, job.id, (progress) => {
      if (progress.done === 2) free = 1.9e9;
    });
    expect(paused.state).toBe("paused");
    expect(paused.message).toMatch(/^Paused after 2 sessions stored, 0 days without a file: only 1.9 GB free on the disk/);
    expect(statuses(ctx, "cash_bhav")).toEqual(["2024-07-04 ok", "2024-07-05 ok"]);
    free = 50e9;
    expect((await runNseHistory(ctx, job.id)).state).toBe("done");
    expect(statuses(ctx, "cash_bhav")).toHaveLength(6);
  });

  it("stops after the current day when cancelled", async () => {
    const { ctx } = context(routesFor(), ist(2026, 11, 16, 20));
    const job = enqueueJob(ctx.db, "nse_history", RANGE);
    const final = await runNseHistory(ctx, job.id, (progress) => {
      if (progress.done === 1) cancelJob(ctx.db, job.id);
    });
    expect(final.state).toBe("cancelled");
    expect(getJob(ctx.db, job.id)?.done).toBe(1);
    expect(statuses(ctx, "cash_bhav")).toEqual(["2024-07-04 ok"]);
  });
});
