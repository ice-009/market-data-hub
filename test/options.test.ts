import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createKey } from "../src/auth/keys.js";
import { enqueueJob, type NseHistoryParams } from "../src/jobs/backfill.js";
import { runNseHistory, validateNseHistory } from "../src/jobs/nseHistory.js";
import { createLogger } from "../src/log.js";
import { NseClient } from "../src/nse/client.js";
import { foBhavUrl, importDay, type NseContext } from "../src/nse/datasets.js";
import { summarizeFoCsv } from "../src/nse/optionFile.js";
import { optionDays } from "../src/nse/optionImport.js";
import { black76, forwardDelta, impliedVol, normCdf, riskFree } from "../src/nse/optionMath.js";
import { optionDaysRead, readOptionSymbol, toSummary, writeOptionDay } from "../src/nse/optionStore.js";
import { FLAGS, constantMaturityIv, flagNames, summarizeOptions, usable, type ExpirySummary, type OptionSummary } from "../src/nse/optionSummary.js";
import { parseFoOptions, parseFoOptionsLegacy, type FoOptionRow } from "../src/nse/parsers/foOptions.js";
import { markDay, readFoSymbol, writeCashDay } from "../src/nse/store.js";
import { unzipSingle } from "../src/nse/unzip.js";
import { isoDay, parseIsoDay } from "../src/time.js";
import { percentileOf, rollingPercentiles } from "../src/http/routes/options.js";
import { ist, makeHub, type TestHub } from "./support/hub.js";
import { fakeFetch, fakeTime, makeZip, type Route } from "./support/nse.js";

// Daily option summaries (market-data-hub#30). Fixtures are real NSE F&O
// bhavcopies cut down to a few underlyings (every row of theirs kept, index
// strikes within a band): fo09NOV2001 (American CA/PA stock options),
// fo01OCT2010, fo13JUL2020 (old format), BhavCopy_NSE_FO_…_20251001 (UDiFF).
// Known levels: India VIX closed at 25.25 on 13 Jul 2020 and 10.29 on 1 Oct
// 2025 (NSE's index file); the lots NSE published were RELIANCE 250 (Oct 2010),
// 505 (Jul 2020), 500 (Oct 2025), SBIN 3,000 (Jul 2020), NIFTY 75 (2020, 2025).

const d = (iso: string) => parseIsoDay(iso)!;
const quiet = createLogger({ level: "error", secrets: [], write: () => {} });
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const csvOf = (name: string) => (name.endsWith(".zip") ? unzipSingle(fixture(name)).data.toString("utf8") : fixture(name).toString("utf8"));
const F2001 = "fo09NOV2001bhav-options.csv";
const F2010 = "fo01OCT2010bhav-options.csv.zip";
const F2020 = "fo13JUL2020bhav-options.csv.zip";
const F2025 = "fo-bhav-20251001-options.csv.zip";

function summaries(name: string, day: string): Map<string, OptionSummary> {
  const read = summarizeFoCsv(d(day), csvOf(name));
  if (read.kind !== "ok") throw new Error(read.note);
  return new Map(read.summaries.map((s) => [s.symbol, s]));
}

describe("Black-76", () => {
  it("prices calls and puts consistently with put–call parity, and inverts to the volatility", () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 7);
    expect(normCdf(1.959964)).toBeCloseTo(0.975, 6);
    expect(normCdf(-3)).toBeCloseTo(0.0013499, 6);
    const [F, K, t, vol, df] = [1000, 1040, 30 / 365, 0.25, Math.exp(-0.065 * (30 / 365))];
    const call = black76("C", F, K, t, vol, df);
    const put = black76("P", F, K, t, vol, df);
    expect(call - put).toBeCloseTo(df * (F - K), 8);
    expect(impliedVol("C", call, F, K, t, df)).toBeCloseTo(vol, 5);
    expect(impliedVol("P", put, F, K, t, df)).toBeCloseTo(vol, 5);
    expect(forwardDelta("C", F, F, t, vol)).toBeGreaterThan(0.5);
    expect(forwardDelta("C", F, K, t, vol) - forwardDelta("P", F, K, t, vol)).toBeCloseTo(1, 10);
  });

  it("finds no volatility for a price with no time value, or above the forward", () => {
    const df = 0.99;
    expect(impliedVol("C", df * 100, 1100, 1000, 0.1, df)).toBeNull(); // = intrinsic
    expect(impliedVol("C", 1100, 1100, 1000, 0.1, df)).toBeNull();
    expect(impliedVol("P", 0, 1100, 1000, 0.1, df)).toBeNull();
    expect(impliedVol("P", 5, 1100, 1000, 0, df)).toBeNull();
  });

  it("discounts at an approximate T-bill rate by year, clamped at both ends", () => {
    expect(riskFree(d("2020-07-13"))).toBe(0.035);
    expect(riskFree(d("1999-01-01"))).toBe(riskFree(d("2000-06-01")));
    expect(riskFree(d("2031-01-01"))).toBe(riskFree(d("2026-06-01")));
  });
});

describe("option rows of the F&O bhavcopy", () => {
  it("reads the old format's American CA/PA stock options and European index options, with notional turnover", () => {
    const parsed = parseFoOptionsLegacy(csvOf(F2001));
    expect(parsed.tradeDate).toBe(d("2001-11-09"));
    expect(parsed.badRows).toBe(0);
    const row = parsed.options.find((r) => r.nseSymbol === "RELIANCE" && r.strike === 240 && r.type === "C")!;
    expect(row).toMatchObject({ kind: "stock", american: true, expiry: d("2001-11-29"), close: 28.6, settle: 28.6, volume: 44, oi: 180000, turnover: 7_061_000, lot: null, underlying: null });
    expect(parsed.options.find((r) => r.nseSymbol === "NIFTY")).toMatchObject({ kind: "index", american: false });
    expect(parsed.futures.map((f) => `${f.kind}:${f.nseSymbol}`)).toContain("stock:RELIANCE");
  });

  it("reads the current format's options with lot, underlying and the actual expiry", () => {
    const parsed = parseFoOptions(csvOf(F2025));
    expect(parsed.tradeDate).toBe(d("2025-10-01"));
    const row = parsed.options.find((r) => r.nseSymbol === "RELIANCE" && r.strike === 1370 && r.type === "C" && r.expiry === d("2025-10-28"))!;
    expect(row).toMatchObject({ kind: "stock", american: false, volume: 8063, oi: 1_781_000, lot: 500, underlying: 1368.7 });
    expect(parseFoOptions("garbage\n1,2").options).toEqual([]);
  });

  it("uses a traded contract's settlement price only where its close confirms it", () => {
    // BANKNIFTY 56100 CE (25 Nov 2025) traded 35 contracts at a close of 820.50; NSE's settlement was 1,384.80.
    const rows = parseFoOptions(csvOf(F2025)).options.filter((r) => r.nseSymbol === "BANKNIFTY" && r.expiry === d("2025-11-25"));
    const at = (strike: number, type: "C" | "P") => rows.find((r) => r.strike === strike && r.type === type) as FoOptionRow;
    expect(usable(at(56100, "C"))).toBe(false);
    expect(usable(at(56000, "C"))).toBe(true);
    expect(usable(at(55600, "P"))).toBe(false); // untraded: theoretical settlement
  });
});

describe("daily summaries", () => {
  it("summarises RELIANCE on 1 Oct 2025: forward from the future, ATM IV, straddle, max pain, walls, PCR", () => {
    const s = summaries(F2025, "2025-10-01").get("RELIANCE")!;
    expect(s).toMatchObject({ kind: "stock", lot: 500, spot: 1368.7, expiries: 3, flags: 0 });
    const near = s.near!;
    expect(near).toMatchObject({ expiry: d("2025-10-28"), days: 27, forward: 1377.4, atmStrike: 1380, flags: 0 });
    expect(near.straddle).toBeCloseTo(53.35, 2);
    expect(near.atmIv!).toBeGreaterThan(0.17);
    expect(near.atmIv!).toBeLessThan(0.19);
    // The straddle ≈ 0.8·σ√T·F at the money: the two must tell the same story.
    expect(near.straddle! / (0.7979 * near.forward! * Math.sqrt(near.days / 365))).toBeCloseTo(near.atmIv!, 1);
    expect(near.iv25Put).not.toBeNull();
    expect(near.iv25Call).not.toBeNull();
    // Max pain, checked by brute force over the fixture's rows.
    const rows = parseFoOptions(csvOf(F2025)).options.filter((r) => r.nseSymbol === "RELIANCE" && r.expiry === d("2025-10-28"));
    const strikes = [...new Set(rows.map((r) => r.strike))];
    const pain = (x: number) => rows.reduce((sum, r) => sum + r.oi * Math.max(0, r.type === "C" ? x - r.strike : r.strike - x), 0);
    expect(near.maxPain).toBe(strikes.reduce((best, k) => (pain(k) < pain(best) ? k : best)));
    const maxOi = (type: "C" | "P") => rows.filter((r) => r.type === type).reduce((a, b) => (b.oi > a.oi ? b : a));
    expect(near.callWall).toBe(maxOi("C").strike);
    expect(near.putWall).toBe(maxOi("P").strike);
    expect(s.putOi / s.callOi).toBeCloseTo(0.81, 2);
  });

  it("files a renamed ticker under its new name", () => {
    const day = summaries(F2025, "2025-10-01");
    expect(day.get("TMPV")).toMatchObject({ nseSymbol: "TATAMOTORS", kind: "stock" });
    expect(day.has("TATAMOTORS")).toBe(false);
  });

  it("prices NIFTY's weekly expiries off put–call parity and reads iv30 from the monthlies, just under India VIX", () => {
    const nifty = summaries(F2025, "2025-10-01").get("NIFTY")!;
    expect(nifty.near).toMatchObject({ expiry: d("2025-10-07"), days: 6 });
    expect(flagNames(nifty.near!.flags)).toContain("FORWARD_PARITY");
    expect(nifty.near!.cpSpread).toBeNull();
    // India VIX closed at 10.29: ATM IV sits a little under it (VIX also prices the wings).
    expect(nifty.iv30!).toBeGreaterThan(0.09);
    expect(nifty.iv30!).toBeLessThan(0.1029);

    // 13 Jul 2020: the 24- and 31-day weeklies barely traded; iv30 interpolates the 17- and 45-day monthlies (≈ 21.7% and 23.8%).
    const n2020 = summaries(F2020, "2020-07-13").get("NIFTY")!;
    expect(n2020.iv30!).toBeGreaterThan(0.22);
    expect(n2020.iv30!).toBeLessThan(0.2525); // India VIX 25.25
    expect(n2020.lot).toBe(75);
  });

  it("estimates the old files' lots from turnover, within 1% of what NSE published", () => {
    const y2020 = summaries(F2020, "2020-07-13");
    expect(y2020.get("RELIANCE")!.lot).toBe(505);
    expect(Math.abs(y2020.get("SBIN")!.lot! - 3000)).toBeLessThanOrEqual(30);
    expect(y2020.get("RELIANCE")!.flags & FLAGS.LOT_ESTIMATED).toBeTruthy();
    expect(Math.abs(summaries(F2010, "2010-10-01").get("RELIANCE")!.lot! - 250)).toBeLessThanOrEqual(2.5);
  });

  it("flags American-style contracts and carries a forward to an expiry without one", () => {
    const reliance = summaries(F2001, "2001-11-09").get("RELIANCE")!;
    expect(flagNames(reliance.flags)).toEqual(["AMERICAN", "LOT_ESTIMATED"]);
    expect(reliance.lot).toBe(600);
    expect(reliance.near!.atmIv!).toBeGreaterThan(0.3);
    expect(reliance.near!.atmIv!).toBeLessThan(0.8);
    // Index options in 2010 are European.
    expect(summaries(F2010, "2010-10-01").get("NIFTY")!.flags & FLAGS.AMERICAN).toBe(0);
  });

  it("keeps every stock's ATM IV within sane bounds across eras", () => {
    for (const [name, day] of [[F2001, "2001-11-09"], [F2010, "2010-10-01"], [F2020, "2020-07-13"], [F2025, "2025-10-01"]] as const) {
      for (const s of summaries(name, day).values()) {
        for (const leg of [s.near, s.next]) {
          if (leg?.atmIv == null) continue;
          expect(leg.atmIv, `${s.symbol} ${day}`).toBeGreaterThan(0.05);
          expect(leg.atmIv, `${s.symbol} ${day}`).toBeLessThan(1.5);
        }
      }
    }
  });

  it("skips the expiring series and contracts past expiry", () => {
    const row = (expiry: number, strike: number, type: "C" | "P", settle: number): FoOptionRow => ({ kind: "stock", nseSymbol: "ABC", expiry, strike, type, american: false, close: settle, settle, volume: 10, oi: 100, chgOi: 0, turnover: null, underlying: 100, lot: 10 });
    const day = d("2025-10-28");
    const [s] = summarizeOptions(day, [row(d("2025-09-30"), 100, "C", 1), row(day, 100, "C", 1), row(day, 100, "P", 1), row(d("2025-11-25"), 100, "C", 3), row(d("2025-11-25"), 100, "P", 2.5)], []);
    expect(s.expiries).toBe(2);
    expect(s.near!.expiry).toBe(d("2025-11-25"));
    expect(s.next).toBeNull();
    expect(s.callOi).toBe(200); // the expiring series counts towards today's OI
  });

  it("interpolates total variance to 30 days", () => {
    const leg = (days: number, atmIv: number) => ({ days, atmIv }) as ExpirySummary;
    expect(constantMaturityIv([leg(20, 0.2), leg(40, 0.2)])).toBeCloseTo(0.2, 10);
    expect(constantMaturityIv([leg(20, 0.2), leg(40, 0.3)])).toBeCloseTo(Math.sqrt((0.04 * 20 + (0.09 * 40 - 0.04 * 20) / 2) / 30), 10);
    expect(constantMaturityIv([leg(2, 0.5), leg(45, 0.25)])).toBe(0.25); // under MIN_IV_DAYS skipped, flat beyond
    expect(constantMaturityIv([])).toBeNull();
  });
});

describe("storage, the evening file and the archive", () => {
  let t: TestHub;
  afterEach(() => t.cleanup());
  const archive = "https://nse.test";
  const context = (routes: Record<string, Route | Route[]>, now: number) => {
    t = makeHub();
    const time = fakeTime(now);
    const calls: string[] = [];
    const log: Array<{ url: string; at: number; headers: Record<string, string> }> = [];
    const fetch = fakeFetch(routes, log, time.clock);
    const ctx: NseContext = {
      db: t.db,
      log: quiet,
      clock: time.clock,
      urls: { archiveUrl: archive },
      nse: new NseClient({ log: quiet, clock: time.clock, sleep: time.sleep, fetch: (async (...args: Parameters<typeof fetch>) => (calls.push(String(args[0])), fetch(...args))) as typeof fetch }),
    };
    return { ctx, calls };
  };

  it("adds migration 13 and round-trips a day", () => {
    t = makeHub();
    expect((t.db.prepare("select id from _migrations where id = 13").get() as { id: number } | undefined)?.id).toBe(13);
    const day = d("2025-10-01");
    const rows = [...summaries(F2025, "2025-10-01").values()];
    writeOptionDay(t.db, day, rows, 1);
    const [stored] = readOptionSymbol(t.db, "RELIANCE", day, day).map(toSummary);
    expect(stored).toEqual(rows.find((s) => s.symbol === "RELIANCE"));
    expect(optionDaysRead(t.db).get(day)).toBe("ok");
  });

  it("stores the evening F&O file's option summaries with its futures", async () => {
    const day = d("2025-10-01");
    const { ctx } = context({ [foBhavUrl(archive, day)]: new Response(makeZip("BhavCopy_NSE_FO_0_0_0_20251001_F_0000.csv", Buffer.from(csvOf(F2025)))) }, ist(2025, 10, 1, 20));
    expect(await importDay(ctx, "fo_bhav", day)).toBe("ok");
    expect(readFoSymbol(ctx.db, "RELIANCE", day, day)).toHaveLength(1);
    expect(readOptionSymbol(ctx.db, "NIFTY", day, day)).toHaveLength(1);
    expect(optionDaysRead(ctx.db).get(day)).toBe("ok");
  });

  it("`--only options` reads stored F&O days again, and the options-only weeks before stock futures, once", async () => {
    const day = d("2001-11-09");
    const { ctx, calls } = context({ [foBhavUrl(archive, day)]: new Response(makeZip("fo09NOV2001bhav.csv", fixture(F2001))) }, ist(2026, 11, 20, 20));
    markDay(ctx.db, "fo_bhav", day, "ok", 2, 0); // stored before the hub kept options
    const params: NseHistoryParams = { from: "2001-11-07", to: "2001-11-09", datasets: ["options"] };
    expect(validateNseHistory(params, d("2026-11-20"))).toBeNull();
    expect(optionDays(ctx.db, d("2001-11-07"), d("2001-11-09")).map(isoDay)).toEqual(["2001-11-07", "2001-11-08", "2001-11-09"]);
    const job = await runNseHistory(ctx, enqueueJob(ctx.db, "nse_history", params).id);
    expect(job.state).toBe("done");
    expect(job.message).toContain("options read for 1 day");
    expect(calls).toEqual([foBhavUrl(archive, d("2001-11-07")), foBhavUrl(archive, d("2001-11-08")), foBhavUrl(archive, day)]);
    expect([...optionDaysRead(ctx.db)].map(([k, v]) => `${isoDay(k)} ${v}`)).toEqual(["2001-11-07 holiday", "2001-11-08 holiday", "2001-11-09 ok"]);
    expect(readOptionSymbol(ctx.db, "RELIANCE", day, day)).toHaveLength(1);
    // Nothing left to ask.
    expect(optionDays(ctx.db, d("2001-06-01"), d("2001-11-09")).some((x) => x >= d("2001-11-07"))).toBe(false);
  });
});

describe("GET /v1/options", () => {
  let t: TestHub;
  afterEach(() => t.cleanup());

  function withKey(scopes: Array<"history" | "fo"> = ["fo"]) {
    t = makeHub({ clock: () => ist(2025, 10, 20, 20) });
    const { key } = createKey(t.db, "test", scopes);
    const app = t.app();
    return async (path: string) => {
      const res = await app.request(path, { headers: { authorization: `Bearer ${key}` } });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { status: res.status, body: (await res.json()) as any };
    };
  }

  it("answers not_ready before anything is stored, and needs the fo scope", async () => {
    let get = withKey();
    expect((await get("/v1/options/summary?symbol=NIFTY")).body.code).toBe("not_ready");
    expect((await get("/v1/options/day")).status).toBe(503);
    expect((await get("/v1/options/summary")).status).toBe(400);
    t.cleanup();
    get = withKey(["history"]);
    expect((await get("/v1/options/summary?symbol=NIFTY")).status).toBe(403);
  });

  it("serves one underlying's days and the cross-section, with option-to-stock volume and no look-ahead", async () => {
    const get = withKey();
    const day = d("2025-10-01");
    const rows = [...summaries(F2025, "2025-10-01").values()];
    writeOptionDay(t.db, day, rows, 1);
    // A later day must not change what an earlier date answers.
    writeOptionDay(t.db, d("2025-10-03"), rows.map((s) => ({ ...s, day: d("2025-10-03"), iv30: 9 })), 1);
    writeCashDay(t.db, day, [{ symbol: "RELIANCE", series: "EQ", prevClose: 1360, open: 1360, high: 1370, low: 1355, close: 1368.7, volume: 10_000_000, deliveryPct: null }], 1);

    const summary = await get("/v1/options/summary?symbol=reliance&from=2025-09-01&to=2025-10-02");
    expect(summary.status).toBe(200);
    expect(summary.body).toMatchObject({ symbol: "RELIANCE", knownFrom: "2025-10-01", lastDate: "2025-10-03" });
    expect(summary.body.days).toHaveLength(1);
    const reliance = summary.body.days[0];
    expect(reliance).toMatchObject({ date: "2025-10-01", lot: 500, lotEstimated: false, stockVolume: 10_000_000, near: { expiry: "2025-10-28", atmStrike: 1380, flags: [] } });
    expect(reliance.optionShares).toBe((rows.find((s) => s.symbol === "RELIANCE")!.callVolume + rows.find((s) => s.symbol === "RELIANCE")!.putVolume) * 500);
    expect(reliance.pcrOi).toBeCloseTo(0.81, 2);
    expect(reliance.near.expectedMovePct).toBeCloseTo((100 * 53.35) / 1377.4, 2);
    expect(reliance.ivPercentile).toBeNull(); // under 60 days of history

    const cross = await get("/v1/options/day?date=2025-10-02&kind=index");
    expect(cross.body).toMatchObject({ date: "2025-10-01" });
    expect(cross.body.rows.map((r: { symbol: string }) => r.symbol)).toEqual(["BANKNIFTY", "NIFTY"]);
    expect(cross.body.rows[1].iv30).toBeLessThan(1);
    expect((await get("/v1/options/day")).body.date).toBe("2025-10-03");
    expect((await get("/v1/options/day?date=2025-09-01")).status).toBe(404);
    expect((await get("/v1/options/day?kind=bond")).status).toBe(400);
  });

  it("ranks iv30 against the year up to the day only", () => {
    const series = Array.from({ length: 100 }, (_, i) => ({ day: d("2025-01-01") + i * 86_400_000, iv30: i / 100 }));
    const percentiles = rollingPercentiles(series, [series[99].day, series[50].day]);
    expect(percentiles.get(series[99].day)).toBe(99);
    expect(percentiles.get(series[50].day)).toBeNull(); // 51 days < 60
    expect(percentileOf(0.5, Array(60).fill(0.4))).toBe(100);
  });
});
