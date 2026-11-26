import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createKey } from "../src/auth/keys.js";
import { Calendar, calendar, calendarStatus, calendarWarnings, isMarketOpen, loadYearLists, parseYearList, setCalendar } from "../src/calendar/calendar.js";
import { CALENDAR_NOTE, archiveDays, forgetUnlistedHolidays, removeOverride, setOverride, syncCalendar } from "../src/calendar/store.js";
import { openDb, type Db } from "../src/db.js";
import { hubHealth } from "../src/health.js";
import { foldTick, newAgg } from "../src/live/aggregate.js";
import { SqliteLiveStore } from "../src/live/store.js";
import type { Tick } from "../src/live/types.js";
import { WEEKEND_SESSIONS, daysToCheck } from "../src/nse/datasets.js";
import { checkedDays, markDay, recordRun, writeBan, type DayDataset } from "../src/nse/store.js";
import { calendarFindings, type DayRecord } from "../src/quality/checks.js";
import { DAY_MS, isoDay, parseIsoDay } from "../src/time.js";
import { ist, makeHub, type TestHub } from "./support/hub.js";
import { fakeFetch } from "./support/nse.js";

// The NSE trading calendar (market-data-hub#17): NSE's checked-in holiday
// lists and special sessions, holidays derived from the archive, overrides,
// and what uses them — health, the evening run, live bars, /v1/calendar.

const d = (iso: string) => parseIsoDay(iso)!;
const DATASETS: readonly DayDataset[] = ["cash_bhav", "fo_bhav", "index_close", "pr"];

const listed = calendar();
afterEach(() => setCalendar(listed));

const dirs: string[] = [];
const dbs: Db[] = [];
function tempDb(): Db {
  const dir = mkdtempSync(path.join(tmpdir(), "calendar-"));
  dirs.push(dir);
  const db = openDb(dir);
  dbs.push(db);
  return db;
}
afterEach(() => {
  for (const db of dbs.splice(0)) if (db.open) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** An index tick as the socket sends it: no trade time, so the receipt time counts. */
const indexTick = (symbol: string, ts: number, ltp: number): Tick => ({ symbol, ltp, ch: 0, chp: 0, open: ltp, high: ltp, low: ltp, prevClose: ltp, volume: 0, ltt: 0, ts, source: "socket" });

describe("the calendar (pure)", () => {
  it("reads NSE's 2026 list (circular NSE/CMTR/71775 and its additions)", () => {
    const lists = loadYearLists();
    const y2026 = lists.find((list) => list.year === 2026)!;
    expect(y2026.source).toMatch(/NSE\/CMTR\/71775/);
    expect(y2026.holidays).toHaveLength(20); // 16 weekday holidays (15 + 15 Jan's election) and 4 on weekends
    const cal = new Calendar(lists);
    expect([...cal.listedYears]).toEqual([2026]);
    expect(cal.info(d("2026-11-24"))).toMatchObject({ trading: false, kind: "holiday", name: "Prakash Gurpurb Sri Guru Nanak Dev", source: "nse_list", hours: null });
    expect(cal.info(d("2026-12-25"))).toMatchObject({ trading: false, kind: "holiday", name: "Christmas" });
    expect(cal.info(d("2026-08-15"))).toMatchObject({ trading: false, kind: "weekend", name: "Independence Day" });
    expect(cal.info(d("2026-11-25"))).toMatchObject({ trading: true, kind: "regular", source: "rule", hours: { open: 555, close: 930 } });
    expect(isoDay(cal.next(d("2026-11-23")))).toBe("2026-11-25");
    expect(isoDay(cal.previous(d("2026-11-25")))).toBe("2026-11-23");
    // 2026: 261 weekdays, 16 of them holidays, plus the Budget Sunday and the Muhurat Sunday.
    expect(cal.tradingDays(d("2026-01-01"), d("2026-12-31"))).toHaveLength(261 - 16 + 2);
  });

  it("knows weekend sessions and their hours: Sun 8 Nov 2026's Muhurat trading, 14:20–15:30", () => {
    const cal = calendar();
    expect(cal.info(d("2026-11-08"))).toMatchObject({ trading: true, kind: "special", name: "Muhurat trading (Diwali)", source: "nse_list", hours: { open: 14 * 60 + 20, close: 15 * 60 + 30 } });
    expect(cal.info(d("2026-02-01"))).toMatchObject({ trading: true, kind: "special", name: "Union Budget", hours: { open: 555, close: 930 } });
    expect(isMarketOpen(ist(2026, 11, 8, 10))).toBe(false);
    expect(isMarketOpen(ist(2026, 11, 8, 14, 20))).toBe(true);
    expect(isMarketOpen(ist(2026, 11, 8, 15, 30))).toBe(false);
    expect(isoDay(cal.next(d("2026-11-06")))).toBe("2026-11-08");
    expect(isoDay(cal.previous(d("2026-11-09")))).toBe("2026-11-08");
    // The live feed makes bars inside the session only.
    const agg = newAgg("NIFTY");
    expect(foldTick(agg, indexTick("NIFTY", ist(2026, 11, 8, 10, 0), 24000))).toBeNull();
    expect(foldTick(agg, indexTick("NIFTY", ist(2026, 11, 8, 14, 30), 24010))).toMatchObject({ t: ist(2026, 11, 8, 14, 30), c: 24010 });
    // The evening run asks for its files; other weekend days it doesn't.
    const due = daysToCheck({ today: d("2026-11-09"), minutes: 0, from: d("2026-11-07"), publishMin: 17 * 60, checked: new Map() });
    expect(due.map(isoDay)).toEqual(["2026-11-08"]);
  });

  it("keeps WEEKEND_SESSIONS (the old hand list) as the checked-in weekend sessions", () => {
    expect(WEEKEND_SESSIONS.map(isoDay)).toEqual(["2019-10-27", "2020-02-01", "2020-11-14", "2023-11-12", "2024-01-20", "2024-03-02", "2024-05-18", "2025-02-01", "2026-02-01", "2026-11-08"]);
  });

  it("rejects a malformed year file", () => {
    expect(() => parseYearList(JSON.stringify({ year: 2027, holidays: [{ date: "2026-12-25", name: "Christmas" }] }), "2027.json")).toThrow(/2027\.json: holiday date "2026-12-25" isn't a date in 2027/);
    expect(() => parseYearList(JSON.stringify({ year: 2027, sessions: [{ date: "2027-02-01", name: "Budget", open: "25:00" }] }), "2027.json")).toThrow(/bad hours/);
    expect(parseYearList(JSON.stringify({ year: 2027, source: "x", sessions: [] }), "2027.json")).toMatchObject({ year: 2027, holidays: null, sessions: [] });
  });

  it("warns in December when next year's list is missing, and all year when this year's is", () => {
    const cal = calendar();
    expect(calendarWarnings(ist(2026, 11, 25, 12), cal)).toEqual([]);
    expect(calendarWarnings(ist(2026, 12, 1, 9), cal)).toEqual([expect.stringMatching(/NSE's holiday list for 2027 isn't in the hub yet/)]);
    expect(calendarWarnings(ist(2027, 3, 1, 9), cal)).toEqual([expect.stringMatching(/no NSE holiday list for 2027/)]);
    // Holidays added by hand make the year listed.
    const with2027 = cal.with({ overrides: new Map([[d("2027-01-26"), { day: d("2027-01-26"), kind: "holiday", name: "Republic Day", hours: null, updatedAt: 0 }]]) });
    expect(calendarWarnings(ist(2026, 12, 1, 9), with2027)).toEqual([]);
    expect(calendarStatus(ist(2026, 12, 1, 9), with2027)).toMatchObject({ listedYears: [2026, 2027], nextYearListed: true });
  });

  it("flags disagreements between NSE's archive and the list (calendar_mismatch)", () => {
    const records = (entries: Array<[string, DayRecord["status"]]>) => new Map(entries.map(([day, status]) => [d(day), { status, note: null }]));
    const days = {
      // 24 Nov: files stored for a listed holiday. 18 Nov: no files for a weekday the list doesn't name. 10 Nov: a listed holiday NSE answered with another day's file.
      cash_bhav: records([["2026-11-24", "ok"], ["2026-11-18", "holiday"], ["2026-11-10", "mismatch"]]),
      fo_bhav: records([["2026-11-18", "holiday"]]),
      index_close: new Map<number, DayRecord>(),
      pr: new Map<number, DayRecord>(),
    };
    const findings = calendarFindings({ days, weekendSessions: [], recentFrom: 0, listed: { holidays: new Map([[d("2026-11-24"), "Prakash Gurpurb Sri Guru Nanak Dev"], [d("2026-11-10"), "Diwali-Balipratipada"]]), years: new Set([2026]) } });
    expect(findings.map((f) => [f.check, isoDay(f.day)])).toEqual([
      ["calendar_mismatch", "2026-11-18"],
      ["calendar_mismatch", "2026-11-24"],
    ]);
    expect(findings[0].message).toMatch(/hub data calendar holiday 2026-11-18/);
    expect(findings[1].message).toMatch(/lists as a holiday \(Prakash Gurpurb/);
  });
});

describe("the calendar from the database", () => {
  it("derives past holidays and sessions from NSE's archive (Holi, Fri 14 Mar 2025; Muhurat, Sun 3 Nov 2013)", () => {
    const db = tempDb();
    markDay(db, "cash_bhav", d("2025-03-13"), "ok", 2000, 1);
    markDay(db, "fo_bhav", d("2025-03-13"), "ok", 200, 1);
    // Holi: NSE served Thursday's cash file under Friday's name, and 404 for the rest.
    markDay(db, "cash_bhav", d("2025-03-14"), "mismatch", 0, 1, "file is for 2025-03-13");
    for (const dataset of ["fo_bhav", "index_close", "pr"] as const) markDay(db, dataset, d("2025-03-14"), "holiday", 0, 1);
    markDay(db, "cash_bhav", d("2025-03-15"), "holiday", 0, 1); // a Saturday: nothing to say
    // A file for another date alone doesn't make a holiday, nor does an F&O 404 without the cash market's word.
    markDay(db, "cash_bhav", d("2025-03-19"), "mismatch", 0, 1, "file is for 2025-03-18");
    markDay(db, "fo_bhav", d("2025-03-20"), "holiday", 0, 1);
    markDay(db, "cash_bhav", d("2013-11-03"), "ok", 1500, 1);
    expect([...archiveDays(db)].map(([day, kind]) => [isoDay(day), kind]).sort()).toEqual([
      ["2013-11-03", "session"],
      ["2025-03-13", "session"],
      ["2025-03-14", "holiday"],
    ]);

    const cal = syncCalendar(db);
    expect(calendar()).toBe(cal);
    expect(cal.info(d("2025-03-14"))).toMatchObject({ trading: false, kind: "holiday", name: null, source: "archive" });
    expect(isoDay(cal.previous(d("2025-03-17")))).toBe("2025-03-13");
    expect(cal.info(d("2025-03-19"))).toMatchObject({ trading: true, source: "rule" });
    expect(cal.info(d("2013-11-03"))).toMatchObject({ trading: true, kind: "special", source: "archive" });
    // Unchanged database: the same calendar, without rebuilding.
    expect(syncCalendar(db)).toBe(cal);
  });

  it("takes holidays and sessions added by hand over the list and the archive", () => {
    const db = tempDb();
    // The evening run recorded Christmas 2026 from the list without asking NSE…
    for (const dataset of DATASETS) markDay(db, dataset, d("2026-12-25"), "holiday", 0, 1, CALENDAR_NOTE);
    expect(syncCalendar(db).info(d("2026-12-25"))).toMatchObject({ trading: false, source: "nse_list" });
    // …then NSE announced a session after all: its files are asked for again.
    setOverride(db, { day: d("2026-12-25"), kind: "session", name: "Special session", hours: { open: 10 * 60, close: 12 * 60 } }, 5);
    expect(calendar().info(d("2026-12-25"))).toMatchObject({ trading: true, kind: "special", name: "Special session", source: "override", hours: { open: 600, close: 720 } });
    expect(checkedDays(db, "cash_bhav").has(d("2026-12-25"))).toBe(false);
    // A holiday announced late, in a year without a list.
    setOverride(db, { day: d("2027-01-26"), kind: "holiday", name: "Republic Day" }, 6);
    expect(calendar().info(d("2027-01-26"))).toMatchObject({ trading: false, kind: "holiday", name: "Republic Day", source: "override" });
    expect(calendar().listedYears.has(2027)).toBe(true);
    expect(removeOverride(db, d("2027-01-26"))).toBe(true);
    expect(removeOverride(db, d("2027-01-26"))).toBe(false);
    expect(calendar().info(d("2027-01-26"))).toMatchObject({ trading: true, source: "rule" });
  });

  it("forgets days recorded as listed holidays once the list no longer has them", () => {
    const db = tempDb();
    markDay(db, "cash_bhav", d("2026-11-24"), "holiday", 0, 1, CALENDAR_NOTE);
    markDay(db, "cash_bhav", d("2026-11-25"), "holiday", 0, 1, CALENDAR_NOTE); // not a listed holiday
    expect(forgetUnlistedHolidays(db, syncCalendar(db))).toBe(1);
    expect([...checkedDays(db, "cash_bhav").keys()].map(isoDay)).toEqual(["2026-11-24"]);
  });
});

describe("Tue 24 Nov 2026, Guru Nanak Jayanti: an exchange holiday end to end", () => {
  let t: TestHub;
  const clock = { now: ist(2026, 11, 24, 20, 0) };
  const calls: Array<{ url: string; at: number; headers: Record<string, string> }> = [];

  beforeEach(() => {
    calls.length = 0;
    clock.now = ist(2026, 11, 24, 20, 0);
    t = makeHub({ clock: () => clock.now, fetch: fakeFetch({}, calls, () => clock.now) });
    // Every session up to Monday 23 Nov is stored (the PR zip's 60-day lookback included); the
    // listed holidays in between (14 Sep, 2 Oct, 20 Oct, 10 Nov) were never asked for.
    const cal = calendar();
    for (let day = d("2026-09-01"); day <= d("2026-11-23"); day += DAY_MS) if (cal.isTradingDay(day)) for (const dataset of DATASETS) markDay(t.db, dataset, day, "ok", 10, 1);
    // The daily refreshes are done for the evening.
    for (const name of ["lots", "fo_ban", "symbol_changes"] as const) recordRun(t.db, name, { at: ist(2026, 11, 24, 19, 0), ok: true });
    writeBan(t.db, d("2026-11-25"), [], ist(2026, 11, 24, 19, 0));
  });
  afterEach(() => t.cleanup());

  it("reports no stale datasets, asks NSE for nothing, and makes no live bars", async () => {
    // The live socket sends index ticks all day (no trade time): no bars on a holiday, only the last quote.
    const store = new SqliteLiveStore({ db: t.db, clock: () => clock.now, timer: false });
    for (let minute = 9 * 60 + 22; minute < 15 * 60 + 28; minute += 15) {
      clock.now = ist(2026, 11, 24, 0, minute);
      store.record([indexTick("NIFTY", clock.now, 25349.65), indexTick("BANKNIFTY", clock.now, 62585.35)]);
      store.flushDue();
    }
    store.flush();
    expect((t.db.prepare("select count(*) as n from live_bars_1m").get() as { n: number }).n).toBe(0);
    expect(store.lastQuotes(["NIFTY"]).get("NIFTY")?.ltp).toBe(25349.65);

    // 20:00, before the evening run: nothing is missing (the holiday isn't a session).
    clock.now = ist(2026, 11, 24, 20, 0);
    const feed = { mode: "idle" as const, socket: "disconnected" as const };
    const before = hubHealth(t.hub, feed, clock.now);
    expect(before.problems).toEqual([]);
    expect(before.warnings.filter((w) => /stale/.test(w))).toEqual([]);

    // The evening run: the day (and the PR zip's earlier listed holidays) are recorded without a single request.
    await t.hub.scheduler["nseRound"]();
    expect(calls.map((call) => call.url)).toEqual([]);
    for (const dataset of DATASETS) expect(checkedDays(t.db, dataset).get(d("2026-11-24")), dataset).toBe("holiday");
    expect([...checkedDays(t.db, "pr")].filter(([, status]) => status === "holiday").map(([day]) => isoDay(day)).sort()).toEqual(["2026-10-02", "2026-10-20", "2026-11-10", "2026-11-24"]);
    expect(t.db.prepare("select distinct note from nse_days where day = ?").all(d("2026-11-24"))).toEqual([{ note: CALENDAR_NOTE }]);

    // Every half hour all evening: still nothing to ask.
    for (let i = 0; i < 6; i += 1) {
      clock.now += 30 * 60_000;
      await t.hub.scheduler["nseRound"]();
    }
    expect(calls).toEqual([]);

    // /v1/status: healthy, and says today is a holiday and tomorrow trades.
    clock.now = ist(2026, 11, 24, 21, 0);
    const { key } = createKey(t.db, "tradex", ["history"]);
    const get = async (url: string) => {
      const response = await t.app().request(url, { headers: { Authorization: `Bearer ${key}` } });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { status: response.status, body: (await response.json()) as any };
    };
    const status = await get("/v1/status");
    expect(status.body.problems).toEqual([]);
    expect(status.body.warnings.filter((w: string) => /stale/.test(w))).toEqual([]);
    expect(status.body.calendar).toMatchObject({
      today: "2026-11-24",
      tradingDay: false,
      kind: "holiday",
      holiday: { name: "Prakash Gurpurb Sri Guru Nanak Dev", source: "nse_list" },
      session: null,
      marketOpen: false,
      nextTradingDay: "2026-11-25",
      previousTradingDay: "2026-11-23",
      listedYears: [2026],
    });

    // The next morning nothing is missing either, and the market opens on time.
    clock.now = ist(2026, 11, 25, 8, 0);
    expect(hubHealth(t.hub, feed, clock.now).problems).toEqual([]);
    expect(isMarketOpen(ist(2026, 11, 25, 9, 15))).toBe(true);
    expect(isMarketOpen(ist(2026, 11, 24, 9, 15))).toBe(false);
  });

  it("serves the calendar: GET /v1/calendar", async () => {
    const { key } = createKey(t.db, "tradex", ["history"]);
    const get = async (url: string) => {
      const response = await t.app().request(url, { headers: { Authorization: `Bearer ${key}` } });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { status: response.status, body: (await response.json()) as any };
    };
    const nov = await get("/v1/calendar?from=2026-11-01&to=2026-11-30");
    expect(nov.status).toBe(200);
    expect(nov.body).toMatchObject({ from: "2026-11-01", to: "2026-11-30", today: "2026-11-24", tradingToday: false, nextTradingDay: "2026-11-25", listedYears: [2026] });
    // 21 weekdays, two of them holidays, and the Muhurat Sunday.
    expect(nov.body.tradingDays).toHaveLength(20);
    expect(nov.body.tradingDays).toContain("2026-11-08");
    expect(nov.body.tradingDays).not.toContain("2026-11-24");
    expect(nov.body.holidays).toEqual([
      { date: "2026-11-10", day: d("2026-11-10"), name: "Diwali-Balipratipada", source: "nse_list", weekend: false },
      { date: "2026-11-24", day: d("2026-11-24"), name: "Prakash Gurpurb Sri Guru Nanak Dev", source: "nse_list", weekend: false },
    ]);
    expect(nov.body.specialSessions).toEqual([{ date: "2026-11-08", day: d("2026-11-08"), name: "Muhurat trading (Diwali)", source: "nse_list", session: { open: "14:20", close: "15:30" } }]);
    expect(nov.body.lists).toEqual([{ year: 2026, source: expect.stringMatching(/NSE\/CMTR\/71775/), url: "https://nsearchives.nseindia.com/content/circulars/CMTR71775.pdf" }]);

    // The archive's holidays: a weekday whose stored days say so.
    const past = await get("/v1/calendar?from=2026-10-01&to=2026-10-31");
    expect(past.body.holidays.map((h: { date: string }) => h.date)).toEqual(["2026-10-02", "2026-10-20"]);

    const year = await get("/v1/calendar");
    expect(year.body).toMatchObject({ from: "2026-01-01", to: "2026-12-31" });
    expect(year.body.tradingDays).toHaveLength(247);
    expect(year.body.holidays.filter((h: { weekend: boolean }) => !h.weekend)).toHaveLength(16);

    expect((await get("/v1/calendar?from=2026-12-01&to=2026-11-01")).status).toBe(400);
    expect((await get("/v1/calendar?from=nope")).status).toBe(400);
    expect((await get("/v1/calendar?from=1950-01-01&to=2026-01-01")).status).toBe(400);
  });
});
