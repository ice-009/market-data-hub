import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createKey } from "../src/auth/keys.js";
import { migrate, type Db } from "../src/db.js";
import { enqueueJob } from "../src/jobs/backfill.js";
import { historyDays, indexFromPrDays, runNseHistory } from "../src/jobs/nseHistory.js";
import { createLogger } from "../src/log.js";
import { NseClient } from "../src/nse/client.js";
import { ARCHIVE_GAPS, INDEX_FROM_PR_NOTE, INDEX_GAP_NOTE, banUrl, importDay, indexCloseUrl, prUrl, type NseContext } from "../src/nse/datasets.js";
import { deriveLots, MIN_NOTIONAL, type FoOiDay } from "../src/nse/lotDerive.js";
import { checkDerivedLots, deriveStoredLots, lotHistory, lotsKnownFrom, lotsOn } from "../src/nse/lotHistory.js";
import { parseFnoBan } from "../src/nse/parsers/ban.js";
import { parseDdMmYyyy, parseIndexClose } from "../src/nse/parsers/indexClose.js";
import { parsePdIndices, priceFileDay } from "../src/nse/parsers/prIndices.js";
import { checkedDays, markDay, readIndexCloses, writeBan, writeCashDay } from "../src/nse/store.js";
import { calendarFindings, type CalendarDataset, type DayRecord } from "../src/quality/checks.js";
import { DAY_MS, isoDay, parseIsoDay } from "../src/time.js";
import { ist, makeHub, type TestHub } from "./support/hub.js";
import { fakeFetch, fakeTime, makeZip, type Route } from "./support/nse.js";

// Reference data before the hub's own downloads (market-data-hub#49, #50, #57):
// lot sizes derived from the old F&O files' open interest, NSE's archive of
// daily ban lists, and index closes from the PR zip where the index file is
// missing. Fixtures are real files, trimmed: Pd080715.csv (PR080715.zip),
// fo_secban_07012008 / 03012011 / 08072015, ind_close_all_09062014.

const d = (iso: string) => parseIsoDay(iso)!;
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const quiet = createLogger({ level: "error", secrets: [], write: () => {} });
const archive = "https://nse.test";
let t: TestHub;
afterEach(() => t?.cleanup());

function context(routes: Record<string, Route | Route[]>, now = Date.UTC(2026, 10, 20, 15)) {
  t = makeHub({ clock: () => now });
  const time = fakeTime(now);
  const calls: Array<{ url: string; at: number; headers: Record<string, string> }> = [];
  const ctx: NseContext = { db: t.db, log: quiet, clock: time.clock, urls: { archiveUrl: archive }, nse: new NseClient({ log: quiet, clock: time.clock, sleep: time.sleep, fetch: fakeFetch(routes, calls, time.clock) }) };
  return { ctx, calls };
}

const cashRow = { symbol: "SBIN", series: "EQ" as const, prevClose: 270, open: 270, high: 272, low: 265, close: 268, volume: 1, deliveryPct: null };

// ------------------------------------------------------------------ #49 lots

/** Near-month OI for `days` sessions from `start`: `lot` × a run of varied lot counts. */
function series(start: number, days: number, lot: number | ((i: number) => number), close: number | ((i: number) => number) = 500, expiry = (i: number) => start + (Math.floor(i / 20) + 1) * 30 * DAY_MS): FoOiDay[] {
  const out: FoOiDay[] = [];
  for (let i = 0; i < days; i += 1) {
    const l = typeof lot === "number" ? lot : lot(i);
    // Lot counts with no common factor (a fixed pseudo-random walk).
    const contracts = 1000 + ((i * 7919 + 13) % 997);
    out.push({ day: start + i * DAY_MS, nearExpiry: expiry(i), nearOi: l * contracts, close: typeof close === "number" ? close : close(i) });
  }
  return out;
}

describe("lots derived from open interest (pure)", () => {
  it("finds a constant lot", () => {
    const lots = deriveLots(series(d("2010-01-04"), 60, 250));
    expect(new Set(lots.map((lot) => lot.lot))).toEqual(new Set([250]));
    expect(lots.every((lot) => lot.confidence === "high")).toBe(true);
  });

  it("puts a bonus on the day the close halves, and NSE's revision on a roll", () => {
    // 1:1 bonus on day 30 (lot 250 → 500, close 500 → 250); revision to 400 when the near month rolls on day 60.
    const lots = deriveLots(series(d("2012-01-02"), 100, (i) => (i < 30 ? 250 : i < 60 ? 500 : 400), (i) => (i < 30 ? 500 : 250)));
    const changes = lots.filter((lot, i) => i === 0 || lot.lot !== lots[i - 1].lot).map((lot) => [isoDay(lot.day), lot.lot]);
    expect(changes).toEqual([
      ["2012-01-02", 250],
      [isoDay(d("2012-01-02") + 30 * DAY_MS), 500],
      [isoDay(d("2012-01-02") + 60 * DAY_MS), 400],
    ]);
    expect(lots.every((lot) => lot.confidence === "high")).toBe(true);
  });

  it("doesn't take a gcd across a change at the newest or oldest stored days", () => {
    // SBIN in Jun–Jul 2015: 1250, then 1000 from the July series. With only a few sessions after the
    // change, the run back from them reaches across it (gcd 250); that mustn't be read as the lot.
    const start = d("2015-05-25");
    const end = deriveLots(series(start, 48, (i) => (i < 40 ? 1250 : 1000)));
    const changes = end.filter((lot, i) => i === 0 || lot.lot !== end[i - 1].lot).map((lot) => [isoDay(lot.day), lot.lot]);
    expect(changes).toEqual([
      [isoDay(start), 1250],
      [isoDay(start + 40 * DAY_MS), 1000],
    ]);
    expect(end.some((lot) => lot.lot === 250)).toBe(false);
    // At the oldest days a run of a larger lot before the change is read too: 1000 for 8 sessions, then 1250.
    const begin = deriveLots(series(start, 48, (i) => (i < 8 ? 1000 : 1250), 500, (i) => start + (i < 8 ? 10 : 40) * DAY_MS));
    expect(begin.some((lot) => lot.lot === 250)).toBe(false);
    expect(begin.slice(8).every((lot) => lot.lot === 1250 && lot.confidence === "high")).toBe(true);
    expect(begin.slice(0, 8).every((lot) => lot.lot === 1000)).toBe(true);
  });

  it("starts afresh when a stock comes back to the F&O list", () => {
    const first = series(d("2008-01-01"), 30, 100, 900);
    const again = series(d("2012-01-02"), 30, 1250, 900);
    const lots = deriveLots([...first, ...again]);
    expect(lots.slice(0, 30).every((lot) => lot.lot === 100)).toBe(true);
    expect(lots.slice(30).every((lot) => lot.lot === 1250)).toBe(true);
  });

  it("marks implausible lots and too few figures as low confidence", () => {
    const tiny = deriveLots(series(d("2009-01-01"), 30, 2, 200));
    expect(tiny.every((lot) => lot.lot === 2 && lot.confidence === "low")).toBe(true);
    expect(2 * 200).toBeLessThan(MIN_NOTIONAL);
    const short = deriveLots(series(d("2009-01-01"), 5, 300));
    expect(short.every((lot) => lot.confidence === "low")).toBe(true);
  });
});

function foRow(db: Db, day: number, symbol: string, oi: number, lot: number | null, close = 500) {
  db.prepare(
    `insert into fo_futures (day, symbol, nse_symbol, expiries, lot, underlying, near_expiry, near_close, near_settle, near_prev_close, near_volume, near_oi, near_chg_oi, oi, chg_oi)
     values (?, ?, ?, 1, ?, null, ?, ?, ?, ?, 1, ?, 0, ?, 0)`,
  ).run(day, symbol, symbol, lot, day + 20 * DAY_MS, close, close, close, oi, oi);
  markDay(db, "fo_bhav", day, "ok", 1, 0);
}

describe("stored lot history", () => {
  /** SBIN: 40 old-format sessions with lot 1000, then 30 current-format ones with NSE's lot 750. */
  function store(db: Db) {
    const start = d("2024-05-01");
    series(start, 40, 1000).forEach((row) => foRow(db, row.day, "SBIN", row.nearOi, null));
    series(start + 40 * DAY_MS, 30, 750).forEach((row) => foRow(db, row.day, "SBIN", row.nearOi, 750));
    return start;
  }

  it("derives the old-format days, serves both sources as change points, and checks itself against NSE's lots", async () => {
    t = makeHub({ clock: () => ist(2026, 11, 20, 10) });
    const start = store(t.db);
    expect(lotsKnownFrom(t.db)).toBe(start + 40 * DAY_MS);
    const summary = deriveStoredLots(t.db);
    expect(summary).toMatchObject({ symbols: 1, days: 40, first: start, last: start + 39 * DAY_MS });
    expect(deriveStoredLots(t.db).days).toBe(40); // rebuilt whole, not added to
    expect(lotsKnownFrom(t.db)).toBe(start);
    expect(lotHistory(t.db, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER).SBIN).toEqual([
      { day: start, lot: 1000, source: "derived", confidence: "high" },
      { day: start + 40 * DAY_MS, lot: 750, source: "bhavcopy", confidence: "high" },
    ]);
    expect(lotsOn(t.db, start + 10 * DAY_MS + 3600_000)).toEqual({ day: start + 10 * DAY_MS, lots: [{ symbol: "SBIN", day: start + 10 * DAY_MS, lot: 1000, source: "derived", confidence: "high" }] });
    expect(lotsOn(t.db, start - DAY_MS)).toBeNull();
    expect(checkDerivedLots(t.db)).toMatchObject({ days: 30, high: 30, highRight: 30, wrong: [] });

    const { key } = createKey(t.db, "test", ["history"]);
    const app = t.app();
    const get = async (path: string) => {
      const res = await app.request(path, { headers: { authorization: `Bearer ${key}` } });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { status: res.status, body: (await res.json()) as any };
    };
    const history = await get("/v1/lots/history");
    expect(history.body).toMatchObject({ knownFrom: isoDay(start), knownFromDay: start, sources: { derived: { from: isoDay(start), to: isoDay(start + 39 * DAY_MS) }, bhavcopy: { from: isoDay(start + 40 * DAY_MS) } } });
    expect(history.body.lots.SBIN).toEqual([
      { date: isoDay(start), day: start, lot: 1000, source: "derived" },
      { date: isoDay(start + 40 * DAY_MS), day: start + 40 * DAY_MS, lot: 750, source: "bhavcopy" },
    ]);
    const past = await get(`/v1/lots?date=${isoDay(start + 12 * DAY_MS)}`);
    expect(past.body).toEqual({ date: isoDay(start + 12 * DAY_MS), foDate: isoDay(start + 12 * DAY_MS), foDay: start + 12 * DAY_MS, count: 1, lots: { SBIN: { lot: 1000, source: "derived" } } });
    expect((await get(`/v1/lots?date=${isoDay(start + 50 * DAY_MS)}&symbol=sbin`)).body).toMatchObject({ symbol: "SBIN", lot: 750, source: "bhavcopy" });
    expect((await get(`/v1/lots?date=${isoDay(start + 50 * DAY_MS)}&symbol=INFY`)).status).toBe(404);
    expect((await get("/v1/lots?date=2001-01-01")).body).toMatchObject({ code: "no_data", knownFrom: isoDay(start) });
    expect((await get("/v1/lots?date=soon")).status).toBe(400);
  });

  it("derives lots when an NSE history run that includes F&O ends", async () => {
    const { ctx } = context({});
    store(ctx.db);
    const job = enqueueJob(ctx.db, "nse_history", { from: "2026-11-01", to: "2026-11-01", datasets: ["fo_bhav"] });
    await runNseHistory(ctx, job.id);
    expect((ctx.db.prepare("select count(*) as n from lot_derived").get() as { n: number }).n).toBe(40);
  });
});

// ------------------------------------------------------------------ #50 ban lists

describe("past F&O ban lists", () => {
  it("reads every layout NSE's archive has used", () => {
    expect(parseFnoBan(fixture("fo_secban_08072015.csv").toString())).toEqual({ tradeDate: d("2015-07-08"), symbols: ["AMTEKAUTO"] });
    expect(parseFnoBan(fixture("fo_secban_03012011.csv").toString())).toEqual({ tradeDate: d("2011-01-03"), symbols: [] });
    const old = parseFnoBan(fixture("fo_secban_07012008.csv").toString());
    expect(old.tradeDate).toBe(d("2008-01-07"));
    expect(old.symbols).toHaveLength(11);
    expect(old.symbols).toContain("APTECHT");
  });

  it("downloads past trade dates day by day, keeping 'nobody banned' apart from 'no file'", async () => {
    const routes = {
      [banUrl(archive, d("2015-07-08"))]: new Response(fixture("fo_secban_08072015.csv")),
      [banUrl(archive, d("2015-07-09"))]: new Response("Securities in Ban For Trade Date 09-JUL-2015: NIL\n"),
      // 10 Jul: no file. 13 Jul: NSE serves another day's.
      [banUrl(archive, d("2015-07-13"))]: new Response(fixture("fo_secban_08072015.csv")),
    };
    const { ctx, calls } = context(routes);
    for (const iso of ["2015-07-08", "2015-07-09", "2015-07-10", "2015-07-13"]) foRow(ctx.db, d(iso), "SBIN", 1000, null);
    expect(historyDays(ctx.db, "fo_ban", d("2015-07-08"), d("2015-07-13"))).toEqual([d("2015-07-08"), d("2015-07-09"), d("2015-07-10"), d("2015-07-13")]);
    const job = enqueueJob(ctx.db, "nse_history", { from: "2015-07-08", to: "2015-07-13", datasets: ["fo_ban"] });
    const final = await runNseHistory(ctx, job.id);
    expect(final.state).toBe("done");
    expect(calls.map((call) => call.url)).toEqual([d("2015-07-08"), d("2015-07-09"), d("2015-07-10"), d("2015-07-13")].map((day) => banUrl(archive, day)));
    expect([...checkedDays(ctx.db, "fo_ban")].sort(([a], [b]) => a - b)).toEqual([
      [d("2015-07-08"), "ok"],
      [d("2015-07-09"), "ok"],
      [d("2015-07-10"), "holiday"],
      [d("2015-07-13"), "mismatch"],
    ]);
    // Asked again: nothing.
    expect(historyDays(ctx.db, "fo_ban", d("2015-07-08"), d("2015-07-13"))).toEqual([]);

    const { key } = createKey(ctx.db, "test", ["fo"]);
    const app = t.app();
    const get = async (path: string) => {
      const res = await app.request(path, { headers: { authorization: `Bearer ${key}` } });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { status: res.status, body: (await res.json()) as any };
    };
    writeBan(ctx.db, d("2026-11-23"), ["IEX"], 3); // the evening run's newest
    foRow(ctx.db, d("2015-07-14"), "SBIN", 1000, null); // never asked for
    const history = await get("/v1/fo/ban/history?to=2015-12-31");
    expect(history.body.knownFrom).toBe("2015-07-08");
    expect(history.body.days.map((day: { date: string; symbols: string[] }) => [day.date, day.symbols])).toEqual([
      ["2015-07-08", ["AMTEKAUTO"]],
      ["2015-07-09", []],
    ]);
    expect(history.body.missing).toEqual([
      { date: "2015-07-10", day: d("2015-07-10"), reason: "no_file" },
      { date: "2015-07-13", day: d("2015-07-13"), reason: "no_file" },
      { date: "2015-07-14", day: d("2015-07-14"), reason: "not_downloaded" },
    ]);
    expect((await get("/v1/fo/ban?date=2015-07-09")).body).toMatchObject({ tradeDate: "2015-07-09", symbols: [] });
    expect((await get("/v1/fo/ban?date=2015-07-10")).body).toMatchObject({ code: "no_data", reason: "no_file" });
    expect((await get("/v1/fo/ban?date=2015-07-14")).body).toMatchObject({ code: "no_data", reason: "not_downloaded" });
  });

  it("records the evening run's list as a stored day too", () => {
    t = makeHub();
    writeBan(t.db, d("2026-11-23"), [], 1);
    expect(checkedDays(t.db, "fo_ban").get(d("2026-11-23"))).toBe("ok");
  });
});

// ------------------------------------------------------------------ #57 index closes

describe("index closes where NSE's index file is missing", () => {
  it("reads index files that print their date with slashes (Jun 2014 – Jun 2015)", () => {
    expect(parseDdMmYyyy("09/06/2014")).toBe(d("2014-06-09"));
    expect(parseDdMmYyyy("09-06/2014")).toBeNull();
    const parsed = parseIndexClose(fixture("ind_close_all_09062014.csv").toString(), d("2014-06-09"));
    expect(parsed).toMatchObject({ tradeDate: d("2014-06-09"), mixedDates: false, badRows: 0 });
    expect(parsed.rows.map((row) => [row.name, row.close])).toEqual([
      ["CNX Nifty", 7654.6],
      ["CNX Nifty Junior", 16714.45],
    ]);
  });

  it("reads the index rows of the PR zip's price file", () => {
    expect(priceFileDay("Pd080715.csv")).toBe(d("2015-07-08"));
    expect(priceFileDay("Pr080715.csv")).toBeNull();
    const { rows, badRows } = parsePdIndices(fixture("Pd080715.csv").toString("latin1"));
    expect(badRows).toBe(0);
    expect(rows.map((row) => row.name)).toEqual(["CNX Nifty", "CNX IT", "CNX Nifty Junior", "BANK Nifty", "CNX Midcap", "India VIX"]);
    expect(rows[0]).toEqual({ name: "CNX Nifty", open: 8439.2, high: 8457.5, low: 8341.4, close: 8363.05, pointsChange: -147.75, changePct: -1.74, volume: null, turnoverCr: null, pe: null, pb: null, divYield: null });
  });

  const pd = () => makeZip("Pd080715.csv", fixture("Pd080715.csv"));

  it("asks the PR zip for a session whose index file is missing, and records a gap when it has none", async () => {
    const { ctx, calls } = context({ [prUrl(archive, d("2015-07-08"))]: new Response(pd()) });
    writeCashDay(ctx.db, d("2015-07-08"), [cashRow], 0);
    writeCashDay(ctx.db, d("2015-09-04"), [cashRow], 0);
    expect(await importDay(ctx, "index_close", d("2015-07-08"))).toBe("ok");
    expect(calls.map((call) => call.url)).toEqual([indexCloseUrl(archive, d("2015-07-08")), prUrl(archive, d("2015-07-08"))]);
    expect(ctx.db.prepare("select status, note from nse_days where dataset = 'index_close' and day = ?").get(d("2015-07-08"))).toEqual({ status: "ok", note: INDEX_FROM_PR_NOTE });
    expect(readIndexCloses(ctx.db, "NIFTY").map((row) => [isoDay(row.day), row.c])).toEqual([["2015-07-08", 8363.05]]);
    expect(readIndexCloses(ctx.db, "BANKNIFTY")).toHaveLength(1);

    // No PR zip either: a known gap, not asked again.
    expect(await importDay(ctx, "index_close", d("2015-09-04"))).toBe("holiday");
    expect(ctx.db.prepare("select status, note from nse_days where dataset = 'index_close' and day = ?").get(d("2015-09-04"))).toEqual({ status: "holiday", note: INDEX_GAP_NOTE });
    // A day the cash market didn't trade isn't worth the PR zip.
    const before = calls.length;
    expect(await importDay(ctx, "index_close", d("2015-09-07"))).toBe("holiday");
    expect(calls.length).toBe(before + 1);
  });

  it("asks once for the PR zips of sessions recorded without an index file", async () => {
    const { ctx, calls } = context({ [prUrl(archive, d("2015-07-08"))]: new Response(pd()) });
    writeCashDay(ctx.db, d("2015-07-08"), [cashRow], 0);
    markDay(ctx.db, "index_close", d("2015-07-08"), "holiday", 0, 0);
    markDay(ctx.db, "index_close", d("2015-07-09"), "holiday", 0, 0); // no cash session: left alone
    expect(indexFromPrDays(ctx.db, d("2015-01-01"), d("2015-12-31"))).toEqual([d("2015-07-08")]);
    const job = enqueueJob(ctx.db, "nse_history", { from: "2015-07-08", to: "2015-07-09", datasets: ["index_close"] });
    const final = await runNseHistory(ctx, job.id);
    expect(final.message).toMatch(/indices read from the PR zip for 1 session/);
    expect(calls.map((call) => call.url)).toEqual([prUrl(archive, d("2015-07-08"))]);
    expect(indexFromPrDays(ctx.db, d("2015-01-01"), d("2015-12-31"))).toEqual([]);
  });

  it("reports a session neither file has, and the misnamed PR zip of 2 Jan 2018, as known gaps", () => {
    const records = (entries: Array<[string, DayRecord]>) => new Map(entries.map(([iso, record]) => [d(iso), record]));
    const ok: DayRecord = { status: "ok", note: null };
    const days: Record<CalendarDataset, Map<number, DayRecord>> = {
      cash_bhav: records([["2015-09-04", ok], ["2015-09-07", ok], ["2018-01-02", ok]]),
      fo_bhav: records([["2015-09-04", ok], ["2015-09-07", ok], ["2018-01-02", ok]]),
      index_close: records([["2015-09-04", { status: "holiday", note: INDEX_GAP_NOTE }], ["2015-09-07", { status: "holiday", note: null }], ["2018-01-02", ok]]),
      pr: records([["2015-09-04", ok], ["2015-09-07", ok], ["2018-01-02", { status: "mismatch", note: "file is for 2019-01-02" }]]),
      fo_participants: new Map(),
    };
    const findings = calendarFindings({ days, weekendSessions: [], recentFrom: 0, archiveGaps: ARCHIVE_GAPS, gapNotes: [INDEX_GAP_NOTE] });
    expect(findings.map((f) => [isoDay(f.day), f.subject, f.severity])).toEqual([
      ["2015-09-04", "index_close", "info"],
      ["2015-09-07", "index_close", "problem"],
      ["2018-01-02", "pr", "info"],
    ]);
  });
});

// ------------------------------------------------------------------ migration 12

describe("migration 12", () => {
  it("records stored ban lists in nse_days and asks again for index files with slashed dates", () => {
    t = makeHub();
    const db = t.db;
    db.prepare("delete from _migrations where id = 12").run();
    db.exec("drop table lot_derived");
    db.prepare("delete from nse_days").run();
    db.prepare("insert into fo_ban (trade_date, symbols, fetched_at) values (?, ?, ?)").run(d("2026-11-12"), JSON.stringify(["IEX", "ABFRL"]), 5);
    markDay(db, "index_close", d("2014-06-09"), "mismatch", 0, 0, "file is for no date");
    markDay(db, "index_close", d("2014-06-10"), "mismatch", 0, 0, "file is for 2014-06-09");
    migrate(db);
    expect(db.prepare("select dataset, day, status, rows from nse_days order by dataset, day").all()).toEqual([
      { dataset: "fo_ban", day: d("2026-11-12"), status: "ok", rows: 2 },
      { dataset: "index_close", day: d("2014-06-10"), status: "mismatch", rows: 0 },
    ]);
  });
});
