import { readFileSync } from "node:fs";
import { deflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { readSeries, writeBars } from "../src/history/store.js";
import { banTarget, dueTasks } from "../src/jobs/scheduler.js";
import { createLogger } from "../src/log.js";
import { NseClient, NseError } from "../src/nse/client.js";
import { cashBhavUrl, daysToCheck, foBhavUrl, importDay, refreshBan, refreshLots, refreshResults, syncDays, type NseContext } from "../src/nse/datasets.js";
import { combinedOiChangePct, oiBuildup, oiFact } from "../src/nse/openInterest.js";
import { parseFnoBan } from "../src/nse/parsers/ban.js";
import { parseCashBhav } from "../src/nse/parsers/cashBhav.js";
import { aggregateStockFutures, parseFoBhav } from "../src/nse/parsers/foBhav.js";
import { parseNseLots } from "../src/nse/parsers/lots.js";
import { parseCalendar } from "../src/nse/parsers/results.js";
import { type DatasetName, checkedDays, foMembersOn, latestBan, markDay, readFoSymbol, readLots, readResults, readRuns, writeFoDay } from "../src/nse/store.js";
import { ZipError, unzipSingle } from "../src/nse/unzip.js";
import { DAY_MS, isoDay, parseIsoDay } from "../src/time.js";
import { ist, makeHub, type TestHub } from "./support/hub.js";

// Fixtures (a few KB): real NSE UDiFF F&O rows trimmed to a few underlyings
// (from Tradex) — fo-bhav-20251001.csv with tickers NSE later renamed, and
// fo-bhav-20251029.csv.zip zipped the way NSE ships it — plus a synthetic cash
// bhavcopy in NSE's column layout.
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const d = (iso: string) => parseIsoDay(iso)!;
const quiet = createLogger({ level: "error", secrets: [], write: () => {} });

describe("parsers (pure)", () => {
  it("reads the cash bhavcopy by header name, with its trade date and delivery %", () => {
    const parsed = parseCashBhav(fixture("sec_bhavdata_full_04112026.csv").toString("utf8"));
    expect(parsed.tradeDate).toBe(d("2026-11-04"));
    expect(parsed.mixedDates).toBe(false);
    expect(parsed.rows.map((r) => r.symbol)).toEqual(["INFY", "M&M", "SBIN", "XYZLTD", "BAJAJ-AUTO"]);
    expect(parsed.rows.find((r) => r.symbol === "SBIN")).toEqual({ symbol: "SBIN", series: "EQ", prevClose: 941.3, open: 943, high: 952.8, low: 939.15, close: 950.35, volume: 12458021, deliveryPct: 44.17 });
    expect(parsed.rows.find((r) => r.symbol === "XYZLTD")).toMatchObject({ series: "BE", deliveryPct: null });
    expect(parseCashBhav("garbage\n1,2,3").rows).toEqual([]);
    const mixed = parseCashBhav(`${fixture("sec_bhavdata_full_04112026.csv").toString("utf8")}TCS, EQ, 03-Nov-2026, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1\n`);
    expect(mixed.mixedDates).toBe(true);
  });

  it("reads F&O stock futures, combining months and filing renamed tickers under their new names", () => {
    const day = d("2025-10-01");
    const parsed = parseFoBhav(fixture("fo-bhav-20251001.csv").toString("utf8"));
    expect(parsed.tradeDate).toBe(day);
    const records = aggregateStockFutures(parsed.contracts, day);
    expect(records.map((r) => `${r.nseSymbol}→${r.symbol}`)).toEqual(["ICICIPRULI→ICICILIFE", "LTIM→LTM", "RELIANCE→RELIANCE", "TATAMOTORS→TMPV"]);
    expect(parsed.contracts).toHaveLength(12); // index futures and stock options are skipped
  });

  it("classifies OI buildup from price and combined OI change", () => {
    expect(oiBuildup(1, 1)).toBe("long-buildup");
    expect(oiBuildup(1, -1)).toBe("short-covering");
    expect(oiBuildup(-1, 1)).toBe("short-buildup");
    expect(oiBuildup(-1, -1)).toBe("long-unwinding");
    expect(oiBuildup(0, 1)).toBeNull();
  });

  it("reads lot sizes, the ban list and the results calendar", () => {
    const lots = parseNseLots(["UNDERLYING ,SYMBOL ,NOV-26 ,DEC-26 ,", "STATE BANK OF INDIA ,SBIN ,750 ,750 ,", "HINDUSTAN AERONAUTICS LTD ,HAL , ,150 ,"].join("\r\n"));
    expect(lots).toEqual({ SBIN: 750, HAL: 150 });
    expect(parseFnoBan("Securities in Ban For Trade Date 05-NOV-2026:\r\n1,ABFRL\r\n2,M&MFIN\r\n")).toEqual({ tradeDate: d("2026-11-05"), symbols: ["ABFRL", "M&MFIN"] });
    expect(parseFnoBan("Securities in Ban For Trade Date 06-NOV-2026: NIL\n").symbols).toEqual([]);
    const events = parseCalendar([
      { symbol: "TCS", company: "Tata Consultancy Services", purpose: "Financial Results/Dividend", date: "09-Oct-2026" },
      { symbol: "ABC", company: "ABC", purpose: "Fund Raising", date: "10-Oct-2026" },
      { symbol: "XYZ", sm_name: "XYZ Ltd", bm_purpose: "To consider Financial Results", bm_date: "2026-11-12" },
    ]);
    expect(events.map((e) => e.symbol)).toEqual(["TCS", "XYZ"]);
  });
});

/** A one-file zip, built by hand, to test the reader's edges (from Tradex's tests). */
function makeZip(name: string, data: Buffer, method: 0 | 8 = 8, files = 1): Buffer {
  const body = method === 8 ? deflateRawSync(data) : data;
  const nameBytes = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE(0, 42);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files, 8);
  end.writeUInt16LE(files, 10);
  end.writeUInt32LE(central.length + nameBytes.length, 12);
  end.writeUInt32LE(local.length + nameBytes.length + body.length, 16);
  return Buffer.concat([local, nameBytes, body, central, nameBytes, end]);
}

describe("unzip", () => {
  it("reads NSE's single-file zip and refuses anything else", () => {
    expect(unzipSingle(fixture("fo-bhav-20251029.csv.zip")).name).toBe("BhavCopy_NSE_FO_0_0_0_20251029_F_0000.csv");
    const text = Buffer.from("hello,world\n".repeat(50));
    expect(unzipSingle(makeZip("a.csv", text, 0)).data.equals(text)).toBe(true);
    expect(() => unzipSingle(Buffer.from("<html>Access denied</html>"))).toThrow(ZipError);
    expect(() => unzipSingle(makeZip("a.csv", text, 8, 2))).toThrow(/one file/);
    expect(() => unzipSingle(makeZip("a.csv", text, 8), 100)).toThrow(/too large/);
  });
});

describe("which days to download (pure)", () => {
  const thu = d("2026-11-05");
  const days = (list: number[]) => list.map(isoDay);
  it("lists unchecked weekdays newest first and waits for the evening for today", () => {
    expect(days(daysToCheck({ today: thu, minutes: 17 * 60, from: d("2026-10-30"), publishMin: 18 * 60, checked: new Map() }))).toEqual(["2026-11-04", "2026-11-03", "2026-11-02", "2026-10-30"]);
    expect(days(daysToCheck({ today: thu, minutes: 18 * 60 + 5, from: d("2026-11-02"), publishMin: 18 * 60, checked: new Map([[d("2026-11-03"), "ok"]]) }))).toEqual(["2026-11-05", "2026-11-04", "2026-11-02"]);
  });
  it("includes known weekend sessions and re-asks only listed statuses", () => {
    expect(days(daysToCheck({ today: d("2026-02-02"), minutes: 0, from: d("2026-01-30"), publishMin: 0, checked: new Map() }))).toEqual(["2026-02-02", "2026-02-01", "2026-01-30"]);
    const checked = new Map([
      [d("2026-11-04"), "mismatch"],
      [d("2026-11-03"), "holiday"],
    ]);
    expect(days(daysToCheck({ today: thu, minutes: 0, from: d("2026-11-03"), publishMin: 18 * 60, checked, recheck: ["mismatch"] }))).toEqual(["2026-11-04"]);
  });
});

/** A fake clock + sleep: sleeping advances time instantly and is recorded. */
function fakeTime(start: number) {
  const state = { now: start, sleeps: [] as number[] };
  return {
    state,
    clock: () => state.now,
    sleep: async (ms: number) => {
      state.sleeps.push(ms);
      state.now += ms;
    },
  };
}

type Route = Response | (() => Response);
function fakeFetch(routes: Record<string, Route | Route[]>, log: Array<{ url: string; at: number; headers: Record<string, string> }>, clock: () => number): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    log.push({ url, at: clock(), headers: (init?.headers ?? {}) as Record<string, string> });
    let route = routes[url];
    if (Array.isArray(route)) route = route.length > 1 ? route.shift()! : route[0];
    if (!route) return new Response("not found", { status: 404 });
    return typeof route === "function" ? route() : route.clone();
  }) as typeof fetch;
}

describe("polite NSE client", () => {
  it("spaces requests ≥ 1.1 s apart and sends browser headers", async () => {
    const time = fakeTime(0);
    const calls: Array<{ url: string; at: number; headers: Record<string, string> }> = [];
    const client = new NseClient({ log: quiet, clock: time.clock, sleep: time.sleep, fetch: fakeFetch({ "https://x/a": new Response("a") }, calls, time.clock) });
    await Promise.all([client.get("https://x/a"), client.get("https://x/a"), client.get("https://x/a")]);
    expect(calls.map((c) => c.at)).toEqual([0, 1_100, 2_200]);
    expect(calls[0].headers["User-Agent"]).toMatch(/Mozilla/);
  });

  it("backs off on 403 (pausing every request) and gives up after two retries", async () => {
    const time = fakeTime(0);
    const calls: Array<{ url: string; at: number; headers: Record<string, string> }> = [];
    const client = new NseClient({ log: quiet, clock: time.clock, sleep: time.sleep, fetch: fakeFetch({ "https://x/a": () => new Response("no", { status: 403 }) }, calls, time.clock) });
    const error = await client.get("https://x/a").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NseError);
    expect((error as NseError).status).toBe(403);
    expect(calls).toHaveLength(3);
    // Each retry waited for the back-off and the minute-long pause after a 403.
    expect(calls[1].at - calls[0].at).toBeGreaterThanOrEqual(60_000);
  });

  it("returns a 404 as an answer, not an error", async () => {
    const time = fakeTime(0);
    const client = new NseClient({ log: quiet, clock: time.clock, sleep: time.sleep, fetch: fakeFetch({}, [], time.clock) });
    expect((await client.get("https://x/missing")).status).toBe(404);
  });
});

describe("NSE datasets", () => {
  let t: TestHub;
  afterEach(() => t.cleanup());
  const archive = "https://nse.test";
  const context = (routes: Record<string, Route | Route[]>, now: number) => {
    t = makeHub();
    const time = fakeTime(now);
    const calls: Array<{ url: string; at: number; headers: Record<string, string> }> = [];
    const ctx: NseContext = { db: t.db, log: quiet, clock: time.clock, urls: { archiveUrl: archive, wwwUrl: "https://www.nse.test" }, nse: new NseClient({ log: quiet, clock: time.clock, sleep: time.sleep, fetch: fakeFetch(routes, calls, time.clock) }) };
    return { ctx, calls, time };
  };

  it("stores a day's F&O bhavcopy, and rejects a file served for another day (the holiday trap)", async () => {
    const zip = fixture("fo-bhav-20251029.csv.zip");
    const { ctx } = context({ [foBhavUrl(archive, d("2025-10-29"))]: new Response(zip), [foBhavUrl(archive, d("2025-10-30"))]: new Response(zip) }, ist(2025, 11, 3, 20));
    expect(await importDay(ctx, "fo_bhav", d("2025-10-29"))).toBe("ok");
    expect(await importDay(ctx, "fo_bhav", d("2025-10-30"))).toBe("mismatch");
    expect(await importDay(ctx, "fo_bhav", d("2025-10-31"))).toBe("holiday"); // 404 for a past weekday
    expect([...checkedDays(ctx.db, "fo_bhav")].map(([day, status]) => [isoDay(day), status])).toEqual([
      ["2025-10-29", "ok"],
      ["2025-10-30", "mismatch"],
      ["2025-10-31", "holiday"],
    ]);
    expect(foMembersOn(ctx.db, d("2025-11-03"))).toEqual({ day: d("2025-10-29"), symbols: ["RELIANCE", "SBIN", "TMPV"] });
    const sbin = readFoSymbol(ctx.db, "SBIN", 0, Number.MAX_SAFE_INTEGER)[0];
    expect(sbin.chgOi).toBe(-2343000 + 68250 + 45000);
    expect(combinedOiChangePct(sbin)).toBeCloseTo((-2229750 / (79837500 + 2229750)) * 100, 6);
    expect(oiFact(sbin).buildup).toBe("short-covering");
  });

  it("doesn't mark today missing when its file isn't out yet", async () => {
    const { ctx } = context({}, ist(2026, 11, 4, 18, 30));
    expect(await importDay(ctx, "cash_bhav", d("2026-11-04"))).toBe("not_yet");
    expect(checkedDays(ctx.db, "cash_bhav").size).toBe(0);
  });

  it("stores the cash bhavcopy and extends stored daily candles from it", async () => {
    const { ctx } = context({ [cashBhavUrl(archive, d("2026-11-04"))]: new Response(fixture("sec_bhavdata_full_04112026.csv")) }, ist(2026, 11, 4, 20));
    // SBIN stored through Tue 3 Nov, whose cash bhavcopy was stored too.
    writeBars(ctx.db, "SBIN", "1d", [{ t: d("2026-11-03"), o: 1, h: 1, l: 1, c: 941.3, v: 1 }], { from: d("2026-11-03"), to: d("2026-11-04") }, 0);
    markDay(ctx.db, "cash_bhav", d("2026-11-03"), "ok", 1, 0);
    const result = await syncDays(ctx, "cash_bhav", [d("2026-11-04")]);
    expect(result).toEqual({ stored: 1, failed: 0, stopped: null });
    expect(readSeries(ctx.db, "SBIN", "1d")!.coverage!.to).toBe(d("2026-11-05"));
    expect(readRuns(ctx.db).get("cash_bhav")?.lastError).toBeNull();
  });

  it("stops a run after three hard failures in a row", async () => {
    const days = [d("2026-10-26"), d("2026-10-27"), d("2026-10-28"), d("2026-10-29")];
    const { ctx, calls } = context(Object.fromEntries(days.map((day) => [cashBhavUrl(archive, day), () => new Response("busy", { status: 503 })])), ist(2026, 11, 4, 20));
    const result = await syncDays(ctx, "cash_bhav", days);
    expect(result.failed).toBe(3);
    expect(result.stopped).toMatch(/3 days in a row/);
    expect(calls).toHaveLength(9); // 3 days × (1 + 2 retries); the 4th day is never asked for
    expect(readRuns(ctx.db).get("cash_bhav")?.lastError).toMatch(/in a row/);
  });

  it("refreshes lots (falling back to the F&O bhavcopy), the ban list and the results calendar", async () => {
    const lotsCsv = ["UNDERLYING,SYMBOL,NOV-26,DEC-26", ...Array.from({ length: 60 }, (_, i) => `CO ${i},SYM${i},${100 + i},${100 + i}`)].join("\n");
    const { ctx, calls } = context(
      {
        [`${archive}/content/fo/fo_mktlots.csv`]: [new Response("oops", { status: 404 }), new Response(lotsCsv)],
        [`${archive}/content/fo/fo_secban.csv`]: new Response("Securities in Ban For Trade Date 05-NOV-2026:\n1,ABFRL\n"),
        "https://www.nse.test/": new Response("<html>", { headers: { "set-cookie": "nsit=abc; Path=/" } }),
        "https://www.nse.test/api/event-calendar": new Response(JSON.stringify([{ symbol: "TCS", company: "TCS", purpose: "Financial Results", date: "09-Nov-2026" }])),
      },
      ist(2026, 11, 4, 20),
    );
    // No lot file and no F&O bhavcopy stored: fails, says why.
    expect(await refreshLots(ctx)).toBe(false);
    expect(readRuns(ctx.db).get("lots")?.lastError).toMatch(/lot sizes/);
    writeFoDay(ctx.db, d("2026-11-03"), [], 0);
    expect(await refreshLots(ctx)).toBe(true);
    expect(readLots(ctx.db).SYM0).toBe(100);
    expect(await refreshBan(ctx)).toBe(true);
    expect(latestBan(ctx.db)).toMatchObject({ tradeDate: d("2026-11-05"), symbols: ["ABFRL"] });
    expect(await refreshResults(ctx)).toBe(true);
    expect(calls.at(-1)!.headers.Cookie).toBe("nsit=abc");
    expect(readResults(ctx.db, 0, Number.MAX_SAFE_INTEGER)).toEqual([{ symbol: "TCS", company: "TCS", date: d("2026-11-09"), purpose: "Financial Results" }]);
  });
});

describe("scheduler (pure)", () => {
  type Runs = Map<DatasetName, { lastAttemptAt: number | null; lastSuccessAt: number | null }>;
  const none: Runs = new Map();
  it("catches up missing days at once, and spaces retries half an hour apart", () => {
    const now = ist(2026, 11, 4, 10);
    expect(dueTasks({ now, runs: none, missing: { cash_bhav: 3, fo_bhav: 0 }, banTradeDate: null })).toEqual(["cash_bhav", "lots", "fo_ban", "results"]);
    const runs: Runs = new Map([["cash_bhav", { lastAttemptAt: now - 10 * 60_000, lastSuccessAt: null }]]);
    expect(dueTasks({ now, runs, missing: { cash_bhav: 3, fo_bhav: 0 }, banTradeDate: d("2026-11-04") })).not.toContain("cash_bhav");
  });

  it("refreshes lots and the results calendar once each evening", () => {
    const morning = ist(2026, 11, 4, 9);
    const runs: Runs = new Map([
      ["lots", { lastAttemptAt: ist(2026, 11, 3, 19), lastSuccessAt: ist(2026, 11, 3, 19) }],
      ["results", { lastAttemptAt: ist(2026, 11, 3, 19), lastSuccessAt: ist(2026, 11, 3, 19) }],
    ]);
    const input = { runs, missing: { cash_bhav: 0, fo_bhav: 0 }, banTradeDate: d("2026-11-04") };
    expect(dueTasks({ ...input, now: morning })).toEqual([]);
    expect(dueTasks({ ...input, now: ist(2026, 11, 4, 19) })).toEqual(["lots", "fo_ban", "results"]);
  });

  it("wants the next session's ban list from the evening on", () => {
    expect(isoDay(banTarget(ist(2026, 11, 4, 12)))).toBe("2026-11-04");
    expect(isoDay(banTarget(ist(2026, 11, 4, 19)))).toBe("2026-11-05");
    expect(isoDay(banTarget(ist(2026, 11, 6, 19)))).toBe("2026-11-09"); // Friday evening → Monday
    expect(banTarget(ist(2026, 11, 7, 12)) - d("2026-11-07")).toBe(2 * DAY_MS);
  });
});
