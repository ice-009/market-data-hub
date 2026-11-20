import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createKey } from "../src/auth/keys.js";
import { migrate } from "../src/db.js";
import { assessHealth, type HealthInput } from "../src/health.js";
import { writeBars } from "../src/history/store.js";
import { enqueueJob } from "../src/jobs/backfill.js";
import type { CashBhavRow } from "../src/nse/parsers/cashBhav.js";
import type { FoDayRecord } from "../src/nse/parsers/foBhav.js";
import { markDay, recordRun, writeCashDay, writeFoDay, writeLots } from "../src/nse/store.js";
import { CashScanner, actionLike, brokerFindings, calendarFindings, candleGapFindings, foFindings, lotFileFindings, type CashRow, type DayRecord } from "../src/quality/checks.js";
import { logFindings, runQuality } from "../src/quality/run.js";
import { readFindings, saveFindings, type Finding } from "../src/quality/store.js";
import { DAY_MS, isWeekday, parseIsoDay } from "../src/time.js";
import { ist, makeHub, type TestHub } from "./support/hub.js";

// Data-quality monitors (ice-009/tradex-public#21): the pure checks, the
// incremental runner, and how findings reach /v1/quality, /v1/status and the log.

const d = (iso: string) => parseIsoDay(iso)!;
const records = (entries: Array<[string, DayRecord["status"], string?]>) => new Map(entries.map(([day, status, note]) => [d(day), { status, note: note ?? null }]));
const noDays = () => new Map<number, DayRecord>();

/** `count` weekdays ending on `last` (inclusive), oldest first. */
function sessions(last: string, count: number): number[] {
  const out: number[] = [];
  for (let day = d(last); out.length < count; day -= DAY_MS) if (isWeekday(day)) out.unshift(day);
  return out;
}

/** A gentle deterministic walk: about ±1% a day. */
const walk = (i: number, seed = 1) => 100 * Math.exp(0.01 * Math.sin(i * 1.7 + seed) + 0.002 * i);

const cashRow = (symbol: string, prevClose: number, close: number, extra: Partial<CashBhavRow> = {}): CashBhavRow => ({ symbol, series: "EQ", prevClose, open: prevClose, high: Math.max(prevClose, close) * 1.01, low: Math.min(prevClose, close) * 0.99, close, volume: 1000, deliveryPct: 50, ...extra });

describe("data quality: the session calendar", () => {
  it("flags a session whose file is missing, and NSE's wrong-date files that nothing confirms as holidays", () => {
    const findings = calendarFindings({
      days: {
        // Mon 16 Nov: cash stored, F&O 404 → the F&O file is missing.
        // Tue 17 Nov: cash served Monday's file, F&O 404 → a holiday, fine.
        // Wed 18 Nov: cash served Tuesday's file, F&O never asked → unconfirmed.
        // Sat 21 Nov: cash served Friday's file → NSE does that for weekends, fine.
        cash_bhav: records([["2026-11-16", "ok"], ["2026-11-17", "mismatch", "file is for 2026-11-16"], ["2026-11-18", "mismatch", "file is for 2026-11-17"], ["2026-11-21", "mismatch", "file is for 2026-11-20"]]),
        fo_bhav: records([["2026-11-16", "holiday"], ["2026-11-17", "holiday"]]),
        index_close: records([["2026-11-16", "ok"]]),
        pr: noDays(),
      },
      weekendSessions: [],
      recentFrom: d("2026-01-01"),
    });
    expect(findings.map((f) => [f.check, f.subject, f.severity])).toEqual([
      ["missing_session", "fo_bhav", "problem"],
      ["wrong_date", "cash_bhav", "warning"],
    ]);
    expect(findings[0].message).toBe("F&O bhavcopy: nothing stored for Mon 16 Nov 2026, a session (the Cash bhavcopy and Index file has it): NSE had no file for it (404).");
    expect(findings[1].message).toMatch(/^Cash bhavcopy: asked for Wed 18 Nov 2026, NSE served another day's file \(file is for 2026-11-17\)\. Nothing confirms it was a holiday yet/);
  });

  it("flags weekend sessions the calendar doesn't list (a warning when recent)", () => {
    const days = { cash_bhav: records([["2026-11-08", "ok"], ["2025-02-01", "ok"], ["2026-02-01", "ok"]]), fo_bhav: records([["2026-11-08", "ok"]]), index_close: noDays(), pr: noDays() };
    const findings = calendarFindings({ days, weekendSessions: [d("2026-02-01")], recentFrom: d("2026-01-01") });
    expect(findings.map((f) => [f.check, f.day, f.severity])).toEqual([
      ["unlisted_session", d("2025-02-01"), "info"],
      ["unlisted_session", d("2026-11-08"), "warning"],
    ]);
    expect(findings[1].message).toMatch(/^NSE held a session on Sun 8 Nov 2026 \(Cash bhavcopy and F&O bhavcopy stored\)/);
  });
});

describe("data quality: price outliers and repeated files", () => {
  /** One symbol over `count` sessions; `last` overrides the final session's row. */
  function feed(count: number, last: (prevClose: number) => Partial<CashRow> & { c: number }, options: Omit<ConstructorParameters<typeof CashScanner>[0], "sessions"> = {}) {
    const days = sessions("2026-11-18", count);
    const scanner = new CashScanner({ sessions: days, ...options });
    const rows: CashRow[] = [];
    let prev = walk(0);
    days.forEach((day, i) => {
      const base: CashRow = { symbol: "ACME", day, prevClose: prev, o: prev, h: prev * 1.01, l: prev * 0.99, c: walk(i), v: 1000 + i };
      const row = i === days.length - 1 ? { ...base, ...last(prev) } : base;
      rows.push(row);
      prev = row.c;
    });
    // Only the last session is reported; the rest warm up the volatility.
    return scanner.symbol(rows, (day) => day === days[days.length - 1]);
  }

  it("flags a move far beyond the stock's volatility, and says when it looks like a split", () => {
    const [finding, ...rest] = feed(40, (prev) => ({ c: prev * 0.502 }));
    expect(rest).toEqual([]);
    expect(finding).toMatchObject({ check: "price_outlier", subject: "ACME", severity: "warning", detail: { actionLike: "1/2", priceBand: "beyond" } });
    expect(finding.message).toMatch(/^ACME: -49\.8% close to close on Wed 18 Nov 2026 .+ with no corporate action on record\. Beyond NSE's widest price band \(20%\) and a 1\/2 price ratio: most likely a split/);
  });

  it("leaves alone moves a corporate action explains: NSE's PREV_CLOSE, an F&O lot change, or the hook", () => {
    // PREV_CLOSE adjusted for a 1:2 split: the close is only 1% under it.
    expect(feed(40, (prev) => ({ prevClose: prev / 2, c: (prev / 2) * 0.99 }))).toEqual([]);
    // An F&O lot that doubled the same day.
    const day = d("2026-11-18");
    expect(feed(40, (prev) => ({ c: prev * 0.5 }), { lotFactors: new Map([[`ACME|${day}`, 0.5]]) })).toEqual([]);
    // A lot change that doesn't match the move explains nothing.
    expect(feed(40, (prev) => ({ c: prev * 0.5 }), { lotFactors: new Map([[`ACME|${day}`, 0.875]]) })).toHaveLength(1);
    // The corporate-action hook (the adjustment table, market-data-hub#20).
    expect(feed(40, (prev) => ({ c: prev * 0.2 }), { corporateAction: (symbol, at) => (symbol === "ACME" && at === day ? { factor: 0.2, source: "adjustments" } : null) })).toEqual([]);
    // …but a move that's an outlier even after the adjustment is still one.
    const after = feed(40, (prev) => ({ c: prev * 0.2 * 0.7 }), { corporateAction: () => ({ factor: 0.2, source: "adjustments" }) });
    expect(after[0].message).toMatch(/-30\.0% close to close .+after a ×0\.200 adjustments adjustment/);
  });

  it("calls a close at its price band info, and needs enough history and a big enough move", () => {
    const band = feed(40, (prev) => ({ c: prev * 1.2 }));
    expect(band).toMatchObject([{ severity: "info", detail: { priceBand: "at" } }]);
    expect(feed(15, (prev) => ({ c: prev * 0.5 }))).toEqual([]); // under VOL_MIN_RETURNS
    expect(feed(40, (prev) => ({ c: prev * 0.93 }))).toEqual([]); // under 10%
  });

  it("flags a cash file that repeats the previous session's prices", () => {
    const [monday, tuesday] = sessions("2026-11-17", 2);
    const scanner = new CashScanner({ sessions: [monday, tuesday] });
    const row = (i: number, day: number): CashRow => ({ symbol: `S${i}`, day, prevClose: 100, o: 100, h: 102, l: 99, c: 101 + (i % 3), v: 500 + i });
    for (let i = 0; i < 60; i += 1) expect(scanner.symbol([row(i, monday), row(i, tuesday)], () => true)).toEqual([]);
    expect(scanner.repeated([monday])).toEqual([]);
    expect(scanner.repeated([monday, tuesday])).toMatchObject([{ check: "repeated_file", day: tuesday, subject: "cash_bhav", severity: "problem", detail: { repeated: 60, shared: 60 } }]);
  });

  it("matches common corporate-action ratios only", () => {
    expect([0.5, 0.21, 0.098, 0.667, 0.4, 10.3].map(actionLike)).toEqual(["1/2", "1/5", "1/10", "2/3", "2/5", "10×"]);
    expect([0.8, 0.7, 0.62, 1.2, 1.5].map(actionLike)).toEqual([null, null, null, null, null]);
  });
});

describe("data quality: F&O lists, lots and stored candles", () => {
  const lots = (entries: Record<string, number | null>) => new Map(Object.entries(entries));

  it("reports lot-size and F&O-list changes, and a list that looks cut off", () => {
    const findings = foFindings({ day: d("2026-10-27"), lots: lots({ SBIN: 750, INFY: 400, TCS: 175 }) }, { day: d("2026-10-28"), lots: lots({ SBIN: 1500, INFY: 400, CUB: 5000, TCS: null }) });
    expect(findings.map((f) => [f.check, f.severity])).toEqual([
      ["fo_list_change", "info"],
      ["lot_change", "info"],
    ]);
    expect(findings[0].message).toBe("F&O list on Wed 28 Oct 2026: 1 stock added (CUB); 4 stocks.");
    expect(findings[1]).toMatchObject({ message: "Lot sizes changed for 1 stock on Wed 28 Oct 2026: SBIN 750→1,500.", detail: { changes: [{ symbol: "SBIN", from: 750, to: 1500 }] } });
    const before = lots(Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`S${i}`, 100])));
    const after = lots(Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`S${i}`, 100])));
    expect(foFindings({ day: d("2026-10-27"), lots: before }, { day: d("2026-10-28"), lots: after })).toMatchObject([{ check: "fo_list_change", severity: "problem" }]);
    // Stocks leaving after their last contract expired (NSE's periodic exclusions) are expected.
    const expired = new Set(Array.from({ length: 50 }, (_, i) => `S${150 + i}`));
    expect(foFindings({ day: d("2026-10-27"), lots: before, expired }, { day: d("2026-10-28"), lots: after })).toMatchObject([{ check: "fo_list_change", severity: "info" }]);
  });

  it("compares NSE's lot file with the newest F&O bhavcopy", () => {
    expect(lotFileFindings({ SBIN: 750, NIFTY: 75 }, { day: d("2026-11-18"), lots: lots({ SBIN: 750 }) })).toEqual([]);
    expect(lotFileFindings({ SBIN: 1500 }, { day: d("2026-11-18"), lots: lots({ SBIN: 750 }) })).toMatchObject([{ check: "lot_file_mismatch", subject: "lots", severity: "warning", detail: { differ: [{ symbol: "SBIN", file: 1500, bhavcopy: 750 }] } }]);
  });

  it("tells a corporate action the broker adjusted for from a real mismatch", () => {
    const days = sessions("2026-06-05", 8);
    // Broker history adjusted for a 1:2 split on day 5; NSE's raw closes halve that day.
    const split = days.map((day, i) => ({ day, stored: 50 + i * 0.1, nse: i < 5 ? (50 + i * 0.1) * 2 : 50 + i * 0.1 }));
    expect(brokerFindings("ACME", split)).toMatchObject([{ check: "broker_mismatch", day: days[5], severity: "info", detail: { factor: 0.5, sessions: 5, exDate: new Date(days[5]).toISOString().slice(0, 10) } }]);
    // The adjustment table (once it exists) makes the two agree.
    expect(brokerFindings("ACME", split, (_symbol, day) => (day < days[5] ? 0.5 : 1))).toEqual([]);
    // Closes that disagree through the newest day: a warning.
    const off = days.map((day, i) => ({ day, stored: 100, nse: i >= 6 ? 103 : 100 }));
    expect(brokerFindings("ACME", off)).toMatchObject([{ severity: "warning", day: days[6], detail: { sessions: 2, newest: true } }]);
    // A stretch ending where the archive has days not downloaded yet isn't judged.
    expect(brokerFindings("ACME", split, undefined, () => false)).toEqual([]);
  });

  it("names the sessions stored candles lack", () => {
    expect(candleGapFindings("ABB", [d("2026-11-08")])).toMatchObject([{ check: "candle_gap", subject: "ABB", day: d("2026-11-08"), message: "ABB: stored daily candles lack 1 session it traded (Sun 8 Nov 2026)." }]);
  });
});

describe("data quality: findings storage", () => {
  let t: TestHub;
  beforeEach(() => (t = makeHub()));
  afterEach(() => t.cleanup());

  it("refreshes findings, resolves the ones a check no longer makes, and says which are new", () => {
    const finding = (subject: string): Finding => ({ check: "price_outlier", day: d("2026-11-18"), subject, severity: "warning", message: subject });
    expect(saveFindings(t.db, "price_outlier", { days: [d("2026-11-18")] }, [finding("A"), finding("B")], 1).map((f) => f.subject)).toEqual(["A", "B"]);
    expect(saveFindings(t.db, "price_outlier", { days: [d("2026-11-18")] }, [finding("A")], 2)).toEqual([]);
    expect(readFindings(t.db).map((f) => [f.subject, f.firstSeenAt, f.lastSeenAt])).toEqual([["A", 1, 2]]);
    expect(readFindings(t.db, { status: "resolved" })).toMatchObject([{ subject: "B", resolvedAt: 2 }]);
    // Back again after being resolved: new again.
    expect(saveFindings(t.db, "price_outlier", { days: [d("2026-11-18")] }, [finding("A"), finding("B")], 3).map((f) => f.subject)).toEqual(["B"]);
    // Another day's findings are outside the scope.
    expect(saveFindings(t.db, "price_outlier", { days: [d("2026-11-17")] }, [], 4)).toEqual([]);
    expect(readFindings(t.db)).toHaveLength(2);
  });

  it("comes after the adjustment tables (migrations 7 and 8)", () => {
    const ids = (t.db.prepare("select id from _migrations order by id").all() as Array<{ id: number }>).map((row) => row.id);
    expect(ids).toEqual(expect.arrayContaining([7, 8]));
    migrate(t.db); // idempotent
  });
});

describe("data quality: the runner", () => {
  let t: TestHub;
  beforeEach(() => (t = makeHub()));
  afterEach(() => t.cleanup());

  const DAYS = sessions("2026-11-18", 45);
  const fo = (day: number, symbol: string, lot: number): FoDayRecord => ({ day, symbol, nseSymbol: symbol, expiries: 3, lot, underlying: 100, near: { expiry: day + 7 * DAY_MS, close: 100, settle: 100, prevClose: 100, volume: 1, oi: 1, chgOi: 0 }, next: null, oi: 1, chgOi: 0 });

  /** 45 sessions of SBIN and INFY (and every weekday in between asked for); SBIN halves on the last day, its F&O lot doubles. */
  function seed(days = DAYS) {
    for (let day = days[0] - 120 * DAY_MS; day < days[0]; day += DAY_MS) if (isWeekday(day)) markDay(t.db, "cash_bhav", day, "holiday", 0, 0);
    for (let day = days[0] - 20 * DAY_MS; day < days[0]; day += DAY_MS) if (isWeekday(day)) markDay(t.db, "fo_bhav", day, "holiday", 0, 0);
    let sbin = 100;
    let infy = 100;
    days.forEach((day, i) => {
      const last = i === DAYS.length - 1;
      const nextSbin = last ? sbin * 0.5 : walk(i);
      const nextInfy = walk(i, 3);
      writeCashDay(t.db, day, [cashRow("SBIN", sbin, nextSbin), cashRow("INFY", infy, nextInfy)], 1);
      writeFoDay(t.db, day, [fo(day, "SBIN", last ? 1500 : 750), fo(day, "INFY", 400)], 1);
      sbin = nextSbin;
      infy = nextInfy;
    });
  }

  it("checks each stored day once, and a new day on its own", () => {
    seed(DAYS.slice(0, -1));
    const first = runQuality(t.db, { clock: () => 1_000 });
    expect(first).toMatchObject({ checkedDays: (DAYS.length - 1) * 2, pendingDays: 0, done: true });
    expect(first.fresh).toEqual([]);
    expect(runQuality(t.db, { clock: () => 2_000 }).checkedDays).toBe(0);

    // The evening's file: SBIN halves with no corporate action on record, and its lot doubles.
    const last = DAYS[DAYS.length - 1];
    writeCashDay(t.db, last, [cashRow("SBIN", walk(DAYS.length - 2), walk(DAYS.length - 2) * 0.5), cashRow("INFY", walk(DAYS.length - 2, 3), walk(DAYS.length - 1, 3))], 3);
    writeFoDay(t.db, last, [fo(last, "SBIN", 1500), fo(last, "INFY", 400)], 3);
    const evening = runQuality(t.db, { clock: () => 4_000 });
    expect(evening.checkedDays).toBe(2);
    // The lot change is recorded, and it explains SBIN's halving: no outlier.
    expect(evening.fresh.map((f) => [f.check, f.subject])).toEqual([["lot_change", "fo"]]);
  });

  it("leaves alone a move on a stored split/bonus ex-date", () => {
    seed();
    t.db.prepare("delete from fo_futures where symbol = 'SBIN' and lot = 1500").run(); // no lot change to explain it
    const last = DAYS[DAYS.length - 1];
    t.db
      .prepare("insert into adjustment_factors (symbol, day, factor, source, prev_day, prev_c, prev_close, o, c) values ('SBIN', ?, 0.5, 'corporate_action', ?, 100, 100, 50, 50)")
      .run(last, DAYS[DAYS.length - 2]);
    expect(runQuality(t.db, { clock: () => 1_000 }).fresh.map((f) => [f.check, f.subject])).toEqual([["fo_list_change", "fo"]]);
  });

  it("flags an unexplained halving, and checks again with --full", () => {
    seed();
    t.db.prepare("delete from fo_futures where symbol = 'SBIN' and lot = 1500").run(); // no lot change to explain it
    const result = runQuality(t.db, { clock: () => 1_000 });
    expect(result.fresh.map((f) => [f.check, f.subject, f.severity])).toEqual([
      ["fo_list_change", "fo", "info"],
      ["price_outlier", "SBIN", "warning"],
    ]);
    const full = runQuality(t.db, { clock: () => 2_000, full: true });
    expect(full.checkedDays).toBe(DAYS.length * 2);
    expect(full.fresh).toEqual([]);
    expect(readFindings(t.db, { check: "price_outlier" })).toMatchObject([{ subject: "SBIN", firstSeenAt: 1_000, lastSeenAt: 2_000 }]);
  });

  it("works in chunks within its budget, newest sessions first", () => {
    seed();
    let now = 0;
    // Each clock read moves time on by 1 ms: a budget of 1 ms allows one chunk per run (at least one always runs).
    const clock = () => (now += 1);
    const first = runQuality(t.db, { clock, budgetMs: 1 });
    expect(first.done).toBe(false);
    expect(first.checkedDays).toBe(DAYS.length); // the F&O days (one chunk of 45)
    expect(runQuality(t.db, { clock, budgetMs: 1 })).toMatchObject({ checkedDays: DAYS.length, done: true });
  });

  it("lets a day wait for the sessions before it while an NSE history job may download them", () => {
    seed();
    // Two weeks before the first stored day were never asked for.
    t.db.prepare("delete from nse_days where dataset = 'cash_bhav' and status = 'holiday' and day > ?").run(DAYS[0] - 14 * DAY_MS);
    enqueueJob(t.db, "nse_history", { from: "2026-01-01", to: "2026-11-17", datasets: ["cash_bhav"] });
    const waiting = runQuality(t.db, { clock: () => ist(2026, 11, 18, 21, 0) });
    expect(waiting.waitingDays).toBeGreaterThan(0);
    expect(waiting.pendingDays).toBe(waiting.waitingDays);
    t.db.prepare("update jobs set state = 'done'").run();
    expect(runQuality(t.db, { clock: () => ist(2026, 11, 18, 21, 0) })).toMatchObject({ waitingDays: 0, pendingDays: 0 });
  });

  it("compares stored daily candles with the bhavcopy and finds sessions they lack", () => {
    seed();
    // INFY's stored candles: day 10 missing, and the first five at half NSE's close with a jump after them (bad history, not an adjustment).
    const bars = DAYS.slice(0, -2)
      .map((day, i) => ({ t: day, o: 1, h: 1, l: 1, c: walk(i, 3) * (i < 5 ? 0.5 : 1), v: 1 }))
      .filter((_, i) => i !== 10);
    writeBars(t.db, "INFY", "1d", bars, { from: DAYS[0], to: DAYS[DAYS.length - 3] + DAY_MS }, 1);
    runQuality(t.db, { clock: () => 1 });
    expect(readFindings(t.db, { check: "candle_gap" })).toMatchObject([{ subject: "INFY", day: DAYS[10] }]);
    expect(readFindings(t.db, { check: "broker_mismatch" })).toMatchObject([{ subject: "INFY", day: DAYS[0], severity: "warning", detail: { sessions: 5, ratio: 0.5 } }]);
  });
});

describe("data quality: health, the API and the log", () => {
  let t: TestHub;
  beforeEach(() => (t = makeHub()));
  afterEach(() => t.cleanup());

  const healthy = (now: number): HealthInput => ({
    now,
    sessionToday: true,
    jobsEnabled: true,
    nse: { cash_bhav: { lastOk: now, checked: new Map() }, fo_bhav: { lastOk: now, checked: new Map() }, pr: { lastOk: now, checked: new Map() } },
    refreshed: { lots: now, fo_ban: now },
    broker: { configured: false, owner: true, loginFailing: null, stoppedForToday: false, coolingDown: false },
    live: { enabled: false, running: false, feed: { mode: "idle", socket: "disabled" } },
    backup: null,
    disk: { volumes: [], warnBytes: 0, minBytes: 0 },
  });

  it("warns about a dataset that keeps failing, and flags it after a day (market-data-hub#14)", () => {
    const now = ist(2026, 11, 18, 11, 0);
    const failing = (failures: number, sinceMs: number) => assessHealth({ ...healthy(now), failing: [{ name: "pr", failures, failingSince: now - sinceMs, lastError: "NSE timed out" }] });
    expect(failing(2, 3_600_000)).toMatchObject({ healthy: true, warnings: [] });
    expect(failing(3, 90 * 60_000)).toMatchObject({ healthy: true, warnings: ["PR zip (results calendar): the last 3 refresh attempts failed (failing for 2 hours); last error: NSE timed out"] });
    expect(failing(48, DAY_MS)).toMatchObject({ healthy: false, problems: ["PR zip (results calendar): the last 48 refresh attempts failed (failing for 24 hours); last error: NSE timed out"] });
  });

  it("counts failures in a row, and forgets them after a success", () => {
    recordRun(t.db, "lots", { at: 1, ok: false, error: "x" });
    recordRun(t.db, "lots", { at: 2, ok: false, error: "y" });
    expect(t.db.prepare("select failures, failing_since from datasets where name = 'lots'").get()).toEqual({ failures: 2, failing_since: 1 });
    recordRun(t.db, "lots", { at: 3, ok: true });
    expect(t.db.prepare("select failures, failing_since from datasets where name = 'lots'").get()).toEqual({ failures: 0, failing_since: null });
  });

  it("serves findings on /v1/quality and sums them up in /v1/status", async () => {
    const { key } = createKey(t.db, "tradex", ["history"]);
    const get = async (path: string) => {
      const response = await t.app().request(path, { headers: { Authorization: `Bearer ${key}` } });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };
    const today = parseIsoDay(new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10))!;
    saveFindings(t.db, "missing_session", null, [{ check: "missing_session", day: today - DAY_MS, subject: "fo_bhav", severity: "problem", message: "F&O bhavcopy: nothing stored for yesterday." }], 5);
    saveFindings(t.db, "lot_change", null, [{ check: "lot_change", day: today - 2 * DAY_MS, subject: "fo", severity: "info", message: "Lot sizes changed.", detail: { changes: [] } }], 5);
    writeLots(t.db, { SBIN: 750 });

    const all = await get("/v1/quality");
    expect(all.status).toBe(200);
    expect(all.body).toMatchObject({ count: 2, findings: [{ check: "missing_session", severity: "problem", subject: "fo_bhav" }, { check: "lot_change", detail: { changes: [] } }], summary: { open: { problem: 1, warning: 0, info: 1 } } });
    expect((await get("/v1/quality?severity=warning")).body).toMatchObject({ count: 1 });
    expect((await get("/v1/quality?check=lot_change&subject=fo")).body).toMatchObject({ count: 1 });
    expect((await get("/v1/quality?status=resolved")).body).toMatchObject({ count: 0 });
    for (const bad of ["check=nope", "severity=bad", "limit=0", "from=2026-11-18&to=2026-11-01", "status=x"]) expect((await get(`/v1/quality?${bad}`)).status).toBe(400);

    const status = await get("/v1/status");
    expect(status.body.quality).toMatchObject({ open: { problem: 1, info: 1 }, recent: [{ check: "missing_session" }, { check: "lot_change" }] });
    expect(status.body.warnings).toContainEqual(expect.stringMatching(/^Data quality: 1 problem in the last 14 days' data \(see \/v1\/quality\)\. F&O bhavcopy: nothing stored for yesterday\.$/));
  });

  it("logs new findings one by one, or as a tally when there are many", () => {
    const finding = (i: number, severity: Finding["severity"]): Finding => ({ check: "price_outlier", day: d("2026-11-18"), subject: `S${i}`, severity, message: `m${i}` });
    logFindings(t.hub.log, [finding(1, "warning"), finding(2, "info")]);
    logFindings(t.hub.log, Array.from({ length: 12 }, (_, i) => finding(i, "warning")));
    const lines = t.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.filter((line) => String(line.msg).startsWith("data-quality"))).toMatchObject([
      { level: "warn", msg: "data-quality finding", subject: "S1", finding: "m1" },
      { level: "info", msg: "data-quality finding", subject: "S2" },
      { level: "info", msg: "data-quality findings", count: 12, tally: { "price_outlier:warning": 12 } },
    ]);
  });

  it("runs in the scheduler's rounds and logs what it finds", () => {
    markDay(t.db, "cash_bhav", d("2026-11-16"), "ok", 1, 1);
    markDay(t.db, "fo_bhav", d("2026-11-16"), "holiday", 0, 1);
    t.hub.scheduler.qualityRound();
    expect(readFindings(t.db, { check: "missing_session" })).toMatchObject([{ subject: "fo_bhav" }]);
    expect(t.lines.some((line) => line.includes("data-quality finding") && line.includes("fo_bhav"))).toBe(true);
  });
});
