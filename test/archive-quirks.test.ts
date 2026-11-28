import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { calendar, setCalendar } from "../src/calendar/calendar.js";
import { setOverride } from "../src/calendar/store.js";
import { migrate } from "../src/db.js";
import { archiveDaily } from "../src/history/fromArchive.js";
import { fillSessionGaps } from "../src/history/fromBhav.js";
import { readBars, readSeries, writeBars } from "../src/history/store.js";
import { historyDays } from "../src/jobs/nseHistory.js";
import { createLogger } from "../src/log.js";
import { NseClient } from "../src/nse/client.js";
import { ARCHIVE_GAPS, EMPTY_FILE_NOTE, WEEKEND_SESSIONS, cashBhavUrl, daysToCheck, importDay, indexCloseUrl, type NseContext } from "../src/nse/datasets.js";
import { parseCmBhav } from "../src/nse/parsers/cmBhav.js";
import { parseDdMmYyyy, parseIndexClose } from "../src/nse/parsers/indexClose.js";
import type { CashBhavRow } from "../src/nse/parsers/cashBhav.js";
import { checkedDays, coverageStatuses, dayStatuses, markDay, readIndexCloses, writeCashDay, type DayDataset } from "../src/nse/store.js";
import { calendarFindings, type CalendarDataset, type DayRecord } from "../src/quality/checks.js";
import { DAY_MS, parseDmyDay, parseIsoDay } from "../src/time.js";
import { ist, makeHub, type TestHub } from "./support/hub.js";
import { fakeFetch, fakeTime, makeZip, type Route } from "./support/nse.js";

// Quirks of NSE's archive that the data-quality checks found on real data
// (market-data-hub#41–#45). The fixtures are real files, cut to a few rows:
// ind_close_all_06042023.csv prints its date month first ("04-06-2023");
// cm13JUL2020bhav.csv has a two-digit year ("13-Jul-20") and comes zipped in a
// folder (cm13JUL2020bhav.csv/cm13JUL2020bhav.csv). NSE serves 6 Sep 1995's
// cash file as HTTP 200 with no bytes (#59).

const d = (iso: string) => parseIsoDay(iso)!;
const quiet = createLogger({ level: "error", secrets: [], write: () => {} });
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const archive = "https://nse.test";

let t: TestHub | undefined;
afterEach(() => {
  t?.cleanup();
  t = undefined;
});

const context = (routes: Record<string, Route | Route[]>, now: number) => {
  t = makeHub();
  const time = fakeTime(now);
  const calls: Array<{ url: string; at: number; headers: Record<string, string> }> = [];
  const ctx: NseContext = { db: t.db, log: quiet, clock: time.clock, urls: { archiveUrl: archive }, nse: new NseClient({ log: quiet, clock: time.clock, sleep: time.sleep, fetch: fakeFetch(routes, calls, time.clock) }) };
  return { ctx, calls };
};

describe("index files that print the date month first (#41)", () => {
  it("reads 6 Apr 2023's file (\"04-06-2023\") as 6 Apr when that's the day asked for", () => {
    const csv = fixture("ind_close_all_06042023.csv");
    expect(parseIndexClose(csv).tradeDate).toBe(d("2023-06-04")); // without the day asked for: day first, as before
    const parsed = parseIndexClose(csv, d("2023-04-06"));
    expect(parsed).toMatchObject({ tradeDate: d("2023-04-06"), mixedDates: false, badRows: 0 });
    expect(parsed.rows.find((row) => row.name === "Nifty 50")).toMatchObject({ open: 17533.85, high: 17638.7, low: 17502.85, close: 17599.15 });
    expect(parsed.rows.find((row) => row.name === "India VIX")?.close).toBe(11.8);
  });

  it("reads either order only as the day asked for; anything else stays day first", () => {
    expect(parseDdMmYyyy("04-06-2023", d("2023-04-06"))).toBe(d("2023-04-06"));
    expect(parseDdMmYyyy("04-06-2023", d("2023-06-04"))).toBe(d("2023-06-04"));
    expect(parseDdMmYyyy("04-06-2023", d("2023-04-05"))).toBe(d("2023-06-04"));
    expect(parseDdMmYyyy("04-13-2023", d("2023-04-13"))).toBe(d("2023-04-13")); // month first, day > 12
    expect(parseDdMmYyyy("04-13-2023")).toBeNull();
    expect(parseDdMmYyyy("31-02-2023", d("2023-02-28"))).toBeNull();
  });

  it("stores the session; a file for another day is still a mismatch", async () => {
    const { ctx } = context(
      {
        [indexCloseUrl(archive, d("2023-04-06"))]: new Response(fixture("ind_close_all_06042023.csv")),
        [indexCloseUrl(archive, d("2023-04-05"))]: new Response(fixture("ind_close_all_06042023.csv")),
      },
      ist(2026, 11, 20, 20),
    );
    expect(await importDay(ctx, "index_close", d("2023-04-06"), { extend: false })).toBe("ok");
    expect(readIndexCloses(ctx.db, "NIFTY").map((row) => [row.day, row.c])).toEqual([[d("2023-04-06"), 17599.15]]);
    expect(await importDay(ctx, "index_close", d("2023-04-05"), { extend: false })).toBe("mismatch");
    expect(ctx.db.prepare("select note from nse_days where dataset = 'index_close' and day = ?").pluck().get(d("2023-04-05"))).toBe("file is for 2023-06-04");
  });
});

describe("the cash bhavcopy of 13 Jul 2020 (#42)", () => {
  it("reads a two-digit year", () => {
    expect(parseDmyDay("13-Jul-20")).toBe(d("2020-07-13"));
    expect(parseDmyDay("03-NOV-94")).toBe(d("1994-11-03"));
    expect(parseDmyDay("13-JUL-2020")).toBe(d("2020-07-13"));
    expect(parseDmyDay("31-Feb-20")).toBeNull();
    const parsed = parseCmBhav(fixture("cm13JUL2020bhav.csv"));
    expect(parsed).toMatchObject({ tradeDate: d("2020-07-13"), mixedDates: false, badRows: 0 });
    expect(parsed.rows.map((row) => `${row.symbol}/${row.series}`)).toEqual(["20MICRONS/EQ", "21STCENMGM/EQ", "63MOONS/BE", "INFY/EQ", "RELIANCE/EQ", "SBIN/EQ", "TCS/EQ"]);
    expect(parsed.rows.find((row) => row.symbol === "RELIANCE")).toMatchObject({ prevClose: 1878.05, open: 1903.35, close: 1935, volume: 32124397, isin: "INE002A01018" });
  });

  it("stores the day from its zip (the file sits in a folder)", async () => {
    const day = d("2020-07-13");
    const { ctx } = context({ [cashBhavUrl(archive, day)]: new Response(makeZip("cm13JUL2020bhav.csv/cm13JUL2020bhav.csv", Buffer.from(fixture("cm13JUL2020bhav.csv")))) }, ist(2026, 11, 20, 20));
    expect(await importDay(ctx, "cash_bhav", day, { extend: false })).toBe("ok"); // no MTO file here: stored without delivery %
    expect(ctx.db.prepare("select count(*) from cash_bhav where day = ?").pluck().get(day)).toBe(7);
  });
});

describe("the session calendar (#43, #44)", () => {
  const records = (entries: Array<[string, DayRecord["status"]]>) => new Map(entries.map(([day, status]) => [d(day), { status, note: null }]));

  it("lists the weekend sessions the archive has (Muhurat, Budget days, special sessions), so the evening run asks for them", () => {
    for (const day of ["2019-10-27", "2020-02-01", "2020-11-14", "2023-11-12", "2024-01-20", "2024-03-02", "2024-05-18", "2025-02-01", "2026-02-01", "2026-11-08"]) expect(WEEKEND_SESSIONS).toContain(d(day));
    expect(WEEKEND_SESSIONS.every((day) => [0, 6].includes(new Date(day).getUTCDay()))).toBe(true);
    const days = daysToCheck({ today: d("2026-11-09"), minutes: 20 * 60, from: d("2026-11-06"), publishMin: 0, checked: new Map() });
    expect(days).toEqual([d("2026-11-09"), d("2026-11-08"), d("2026-11-06")]);
  });

  it("reports a session NSE's archive has no file for as a known gap (info), not a problem", () => {
    const days: Record<CalendarDataset, Map<number, DayRecord>> = {
      cash_bhav: records([["2021-03-30", "ok"], ["2021-03-31", "ok"]]),
      fo_bhav: records([["2021-03-30", "holiday"], ["2021-03-31", "holiday"]]),
      index_close: records([["2021-03-30", "ok"], ["2021-03-31", "ok"]]),
      pr: new Map(),
    };
    const findings = calendarFindings({ days, weekendSessions: [], recentFrom: 0, archiveGaps: ARCHIVE_GAPS });
    expect(findings.map((f) => [f.check, f.day, f.subject, f.severity])).toEqual([
      ["missing_session", d("2021-03-30"), "fo_bhav", "info"],
      ["missing_session", d("2021-03-31"), "fo_bhav", "problem"],
    ]);
    expect(findings[0].message).toBe("F&O bhavcopy: nothing stored for Tue 30 Mar 2021, a session (the Cash bhavcopy and Index file has it): NSE had no file for it (404), a known gap in its archive.");
  });
});

describe("repairing what the bugs left behind (#44, #45)", () => {
  it("migration 9 forgets the days marked mismatch by the date bugs, so NSE history asks for them again", () => {
    t = makeHub();
    const db = t.db;
    const mark = (dataset: DayDataset, iso: string, note: string) => markDay(db, dataset, d(iso), "mismatch", 0, 0, note);
    mark("index_close", "2023-04-06", "file is for 2023-06-04");
    mark("index_close", "2023-04-11", "file is for 2023-11-04");
    mark("index_close", "2023-04-07", "file is for 2023-04-06"); // a real wrong-date file: kept
    mark("cash_bhav", "2020-07-13", "file is for no date");
    mark("cash_bhav", "2026-10-04", "file is for 2026-10-01"); // a weekend URL served Friday's file: kept
    mark("pr", "2018-01-02", "file is for 2019-01-02");
    db.prepare("delete from _migrations where id = 9").run();
    migrate(db);
    const left = db.prepare("select dataset, day from nse_days order by dataset, day").all() as Array<{ dataset: string; day: number }>;
    expect(left).toEqual([
      { dataset: "cash_bhav", day: d("2026-10-04") },
      { dataset: "index_close", day: d("2023-04-07") },
      { dataset: "pr", day: d("2018-01-02") },
    ]);
    expect(historyDays(db, "index_close", d("2023-04-06"), d("2023-04-11"))).toEqual([d("2023-04-06"), d("2023-04-10"), d("2023-04-11")]);
  });

  it("fills a weekend session's bar into stored daily series that skipped it, from the cash bhavcopy", () => {
    t = makeHub();
    const db = t.db;
    const [fri, sun, mon] = [d("2026-11-06"), d("2026-11-08"), d("2026-11-09")];
    const bar = (day: number, c: number) => ({ t: day, o: c, h: c, l: c, c, v: 1 });
    // TECHM and ACME were extended from Friday straight to Monday; ACME's stored history is on another price basis (a split since).
    writeBars(db, "TECHM", "1d", [bar(fri, 1831), bar(mon, 1805)], { from: fri, to: mon + DAY_MS }, 7);
    writeBars(db, "ACME", "1d", [bar(fri, 50), bar(mon, 51)], { from: fri, to: mon + DAY_MS }, 7);
    // SBIN's series has it already; INFY's ends before it.
    writeBars(db, "SBIN", "1d", [bar(fri, 800), bar(sun, 801), bar(mon, 802)], { from: fri, to: mon + DAY_MS }, 7);
    writeBars(db, "INFY", "1d", [bar(fri, 1500)], { from: fri, to: fri + DAY_MS }, 7);
    const cash = (symbol: string, prevClose: number, close: number) => ({ symbol, series: "EQ" as const, prevClose, open: close - 5, high: close + 5, low: close - 10, close, volume: 1234, deliveryPct: null });
    writeCashDay(db, sun, [cash("TECHM", 1831, 1840), cash("ACME", 100, 101), cash("SBIN", 800, 801), cash("INFY", 1500, 1510)], 0);
    markDay(db, "cash_bhav", sun, "ok", 4, 0);
    expect(checkedDays(db, "cash_bhav").get(sun)).toBe("ok");

    expect(fillSessionGaps(db, WEEKEND_SESSIONS, quiet)).toBe(1);
    expect(readBars(db, "TECHM", "1d", 0, Number.MAX_SAFE_INTEGER)).toEqual([bar(fri, 1831), { t: sun, o: 1835, h: 1845, l: 1830, c: 1840, v: 1234 }, bar(mon, 1805)]);
    expect(readSeries(db, "TECHM", "1d")).toMatchObject({ coverage: { from: fri, to: mon + DAY_MS }, count: 3, syncedAt: 7 });
    expect(readBars(db, "ACME", "1d", sun, sun + 1)).toEqual([]);
    expect(readBars(db, "INFY", "1d", 0, Number.MAX_SAFE_INTEGER)).toHaveLength(1);
    expect(fillSessionGaps(db, WEEKEND_SESSIONS, quiet)).toBe(0);
  });
});

describe("a day NSE answers with an empty file (#59)", () => {
  // cm06SEP1995bhav.csv.zip: HTTP 200, no bytes (checked 26 Nov 2026); 5 and 7 Sep 1995 are ordinary files.
  const row = (close: number): CashBhavRow => ({ symbol: "ACC", series: "EQ", prevClose: close, open: close, high: close, low: close, close, volume: 1, deliveryPct: null });
  const listed = calendar();
  afterEach(() => setCalendar(listed));

  it("is recorded as a day without a file, so daily candles reach back past it", async () => {
    const { ctx, calls } = context({ [cashBhavUrl(archive, d("1995-09-06"))]: new Response(new Uint8Array(0)) }, ist(2026, 11, 26, 20));
    writeCashDay(ctx.db, d("1995-09-05"), [row(100)], 0);
    writeCashDay(ctx.db, d("1995-09-07"), [row(101)], 0);
    // Before: the unchecked 6 Sep cuts coverage off at the 7th.
    expect(archiveDaily(ctx.db, "ACC", d("1995-09-05"), d("1995-09-07"), { adjusted: false })).toMatchObject({ coveredFromDay: d("1995-09-07"), bars: [{ t: d("1995-09-07") }] });
    expect(await importDay(ctx, "cash_bhav", d("1995-09-06"))).toBe("holiday");
    expect(calls).toHaveLength(1); // not retried as a broken download
    expect(ctx.db.prepare("select status, note from nse_days where dataset = 'cash_bhav' and day = ?").get(d("1995-09-06"))).toEqual({ status: "holiday", note: EMPTY_FILE_NOTE });
    const after = archiveDaily(ctx.db, "ACC", d("1995-09-05"), d("1995-09-07"), { adjusted: false });
    expect(after.coveredFromDay).toBe(d("1995-09-05"));
    expect(after.bars.map((bar) => bar.c)).toEqual([100, 101]);
  });

  it("is just not out yet when it's today's", async () => {
    const { ctx } = context({ [cashBhavUrl(archive, d("2026-11-26"))]: new Response(new Uint8Array(0)) }, ist(2026, 11, 26, 18));
    expect(await importDay(ctx, "cash_bhav", d("2026-11-26"))).toBe("not_yet");
    expect(checkedDays(ctx.db, "cash_bhav").has(d("2026-11-26"))).toBe(false);
  });

  it("can be settled with the calendar instead: a holiday added by hand counts as checked", () => {
    t = makeHub();
    writeCashDay(t.db, d("1995-09-05"), [row(100)], 0);
    writeCashDay(t.db, d("1995-09-07"), [row(101)], 0);
    expect(archiveDaily(t.db, "ACC", d("1995-09-05"), d("1995-09-07")).coveredFromDay).toBe(d("1995-09-07"));
    setOverride(t.db, { day: d("1995-09-06"), kind: "holiday", name: "NSE archive: empty file" });
    expect(archiveDaily(t.db, "ACC", d("1995-09-05"), d("1995-09-07")).coveredFromDay).toBe(d("1995-09-05"));
    expect(coverageStatuses(t.db, "cash_bhav").get(d("1995-09-06"))).toBe("holiday");
    expect(dayStatuses(t.db, "cash_bhav").has(d("1995-09-06"))).toBe(false); // what NSE is asked for is unchanged
  });
});
