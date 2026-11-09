import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Bar } from "../src/broker/fyers.js";
import { readBars, readSeries, writeBars } from "../src/history/store.js";
import { IMPORTED_SERIES, ImportError, formatImportReport, importTradex, importTradexLocked } from "../src/import/tradex.js";
import { bhavFileDay, checkBhavDay, cleanBhav, mapSeriesKey, planMerge, prepareSeries, sameBhav } from "../src/import/tradexMap.js";
import { checkedDays, foMembersOn, readFoSymbol } from "../src/nse/store.js";
import { DAY_MS, IST_OFFSET_MS, MINUTE_MS, isWeekday, parseIsoDay } from "../src/time.js";
import { ist, makeHub, type TestHub } from "./support/hub.js";

const d = (iso: string) => parseIsoDay(iso)!;
const bar = (t: number, c: number): Bar => ({ t, o: c, h: c + 1, l: c - 1, c, v: 1000 });

describe("Tradex mapping (pure)", () => {
  it("maps series keys to hub tickers and timeframes", () => {
    expect(mapSeriesKey("NSE:SBIN-EQ:D")).toEqual({ ok: true, symbol: "SBIN", tf: "1d" });
    expect(mapSeriesKey("NSE:M&M-EQ:15")).toEqual({ ok: true, symbol: "M&M", tf: "15m" });
    expect(mapSeriesKey("NSE:BAJAJ-AUTO-EQ:5")).toEqual({ ok: true, symbol: "BAJAJ-AUTO", tf: "5m" });
    expect(mapSeriesKey("NSE:NIFTY50-INDEX:D")).toEqual({ ok: true, symbol: "NIFTY", tf: "1d" });
    expect(mapSeriesKey("NSE:NIFTYBANK-INDEX:15")).toEqual({ ok: true, symbol: "BANKNIFTY", tf: "15m" });
    expect(mapSeriesKey("NSE:SBIN-EQ:60")).toMatchObject({ ok: false, reason: expect.stringContaining('"60"') });
    expect(mapSeriesKey("NSE:SBIN-EQ:1")).toMatchObject({ ok: false });
    expect(mapSeriesKey("BSE:SENSEX-INDEX:D")).toMatchObject({ ok: false, reason: expect.stringContaining("index") });
    expect(mapSeriesKey("NSE:SBIN26NOVFUT:D")).toMatchObject({ ok: false, reason: expect.stringContaining("-EQ") });
    expect(mapSeriesKey("NSE:sbin-EQ:D")).toMatchObject({ ok: false });
    expect(mapSeriesKey("garbage")).toMatchObject({ ok: false });
  });

  it("claims coverage from covered_from to the newest final bar, leaving out a forming one", () => {
    const days = [d("2026-11-02"), d("2026-11-03"), d("2026-11-04"), d("2026-11-05")];
    // Synced on Thursday 5 Nov at 14:00 IST: the 5 Nov bar was still forming.
    const prepared = prepareSeries("1d", { coveredFrom: d("2026-11-01") + 3 * 3_600_000, syncedAt: ist(2026, 11, 5, 14, 0) }, days.map((t, i) => bar(t, 100 + i)));
    expect(prepared).toMatchObject({ ok: true, claimed: { from: d("2026-11-02"), to: d("2026-11-05") }, dropped: 1 });
    if (prepared.ok) expect(prepared.bars.map((b) => b.t)).toEqual(days.slice(0, 3));
    // Synced after the close: every bar is final, coverage ends after the newest.
    expect(prepareSeries("1d", { coveredFrom: d("2026-11-02"), syncedAt: ist(2026, 11, 5, 18, 0) }, days.map((t) => bar(t, 100)))).toMatchObject({ claimed: { to: d("2026-11-06") }, dropped: 0 });
  });

  it("moves daily bars stamped at IST midnight onto the day key", () => {
    const prepared = prepareSeries("1d", { coveredFrom: d("2026-11-01"), syncedAt: ist(2026, 11, 7, 10, 0) }, [bar(d("2026-11-05") - IST_OFFSET_MS, 10), bar(d("2026-11-06") - IST_OFFSET_MS, 11)]);
    expect(prepared).toMatchObject({ ok: true, claimed: { to: d("2026-11-07") } });
    if (prepared.ok) expect(prepared.bars.map((b) => b.t)).toEqual([d("2026-11-05"), d("2026-11-06")]);
  });

  it("intraday: rounds covered_from up to a bar and stops at the last closed bar", () => {
    const open = ist(2026, 11, 5, 9, 15);
    const bars = Array.from({ length: 8 }, (_, i) => bar(open + i * 15 * MINUTE_MS, 50 + i));
    // Synced at 11:07 IST: bars up to 10:45 are closed, 11:00 was forming.
    const prepared = prepareSeries("15m", { coveredFrom: open - 37 * 1000, syncedAt: ist(2026, 11, 5, 11, 7) }, bars);
    expect(prepared).toMatchObject({ ok: true, claimed: { from: open, to: ist(2026, 11, 5, 11, 0) }, dropped: 1 });
  });

  it("refuses series it can't vouch for", () => {
    const sync = { coveredFrom: d("2026-11-01"), syncedAt: ist(2026, 11, 7, 10, 0) };
    expect(prepareSeries("1d", sync, [])).toMatchObject({ ok: false, reason: "no bars" });
    expect(prepareSeries("1d", sync, [{ ...bar(d("2026-11-05"), 10), o: 0 }])).toMatchObject({ ok: false, reason: expect.stringContaining("malformed") });
    expect(prepareSeries("15m", sync, [bar(ist(2026, 11, 5, 9, 16), 10)])).toMatchObject({ ok: false, reason: expect.stringContaining("grid") });
    expect(prepareSeries("1d", sync, [bar(d("2026-11-05"), 10), bar(d("2026-11-05") + 3_600_000, 10)])).toMatchObject({ ok: false, reason: expect.stringContaining("two bars") });
    // Only a forming bar: nothing final to claim.
    expect(prepareSeries("1d", { coveredFrom: d("2026-11-05"), syncedAt: ist(2026, 11, 5, 12, 0) }, [bar(d("2026-11-05"), 10)])).toMatchObject({ ok: false });
  });

  it("merges into the hub only where the ranges touch and the prices agree", () => {
    const ours = [bar(d("2026-11-02"), 10), bar(d("2026-11-03"), 11), bar(d("2026-11-04"), 12)];
    const claimed = { from: d("2026-11-02"), to: d("2026-11-05") };
    expect(planMerge(null, [], claimed, ours)).toEqual({ action: "write", bars: ours, coverage: claimed });
    expect(planMerge({ from: d("2026-10-01"), to: d("2026-11-06") }, [], claimed, ours)).toMatchObject({ action: "unchanged" });
    expect(planMerge({ from: d("2026-11-10"), to: d("2026-11-12") }, [], claimed, ours)).toMatchObject({ action: "skip", reason: expect.stringContaining("gap") });
    // Touching at the end: the hub's range grows back, nothing of the hub's is rewritten.
    expect(planMerge({ from: d("2026-11-05"), to: d("2026-11-07") }, [], claimed, ours)).toEqual({ action: "write", bars: ours, coverage: { from: d("2026-11-02"), to: d("2026-11-07") } });
    // Overlapping: only bars outside the hub's coverage are written.
    const hubBar = bar(d("2026-11-04"), 12.01);
    expect(planMerge({ from: d("2026-11-04"), to: d("2026-11-07") }, [hubBar], claimed, ours)).toEqual({ action: "write", bars: ours.slice(0, 2), coverage: { from: d("2026-11-02"), to: d("2026-11-07") } });
    // A split adjusted one side only.
    expect(planMerge({ from: d("2026-11-04"), to: d("2026-11-07") }, [bar(d("2026-11-04"), 6)], claimed, ours)).toMatchObject({ action: "skip", reason: expect.stringContaining("split") });
  });

  it("reads bhav cache files and checks them against daily closes", () => {
    expect(bhavFileDay("06112026.json")).toBe(d("2026-11-06"));
    expect(bhavFileDay("31022026.json")).toBeNull();
    expect(bhavFileDay("notes.txt")).toBeNull();
    const row = { prevClose: 10, open: 10, high: 11, low: 9, close: 10.5, volume: 100, deliveryPct: 40 };
    const cleaned = cleanBhav({ SBIN: row, "M&M": { ...row, deliveryPct: null }, bad: row, ZERO: { ...row, close: 0 }, NAN: { ...row, open: Number.NaN } });
    expect(cleaned.rows.map((r) => r.symbol)).toEqual(["SBIN", "M&M"]);
    expect(cleaned.bad).toBe(3);

    const rows = ["A", "B", "C", "D", "E", "F"].map((symbol, i) => ({ symbol, ...row, close: 100 + i }));
    const closes = new Map(rows.map((r) => [r.symbol, r.close]));
    expect(checkBhavDay(rows, closes)).toEqual({ ok: true, compared: 6 });
    expect(checkBhavDay(rows, null)).toEqual({ ok: true, compared: 0 });
    expect(checkBhavDay(rows, new Map())).toMatchObject({ ok: false, reason: expect.stringContaining("no session") });
    const shifted = new Map(rows.map((r) => [r.symbol, r.close * 1.02]));
    expect(checkBhavDay(rows, shifted)).toMatchObject({ ok: false, reason: expect.stringContaining("only 0 of 6") });
    expect(checkBhavDay(rows, new Map([["A", 1]]))).toEqual({ ok: true, compared: 1 }); // too few to judge
    expect(sameBhav(rows, rows.map((r) => ({ ...r })))).toBe(true);
    expect(sameBhav(rows, rows.map((r, i) => ({ ...r, close: r.close + (i === 3 ? 1 : 0) })))).toBe(false);
  });
});

// ------------------------------------------------------------------ a synthetic Tradex install

const TRADEX_SCHEMA = `
  CREATE TABLE series (key TEXT PRIMARY KEY, covered_from INTEGER NOT NULL, synced_at INTEGER NOT NULL, count INTEGER NOT NULL DEFAULT 0, first_t INTEGER, last_t INTEGER);
  CREATE TABLE candles (key TEXT NOT NULL, t INTEGER NOT NULL, o REAL NOT NULL, h REAL NOT NULL, l REAL NOT NULL, c REAL NOT NULL, v REAL NOT NULL, PRIMARY KEY (key, t)) WITHOUT ROWID;
  CREATE TABLE fo_bhav_days (day INTEGER PRIMARY KEY, status TEXT NOT NULL, underlyings INTEGER NOT NULL DEFAULT 0, checked_at INTEGER NOT NULL, note TEXT);
  CREATE TABLE fo_futures (day INTEGER NOT NULL, symbol TEXT NOT NULL, nse_symbol TEXT NOT NULL, expiries INTEGER NOT NULL, lot REAL, underlying REAL,
    near_expiry INTEGER NOT NULL, near_close REAL NOT NULL, near_settle REAL NOT NULL, near_prev_close REAL NOT NULL, near_volume REAL NOT NULL, near_oi REAL NOT NULL, near_chg_oi REAL NOT NULL,
    next_expiry INTEGER, next_close REAL, next_settle REAL, next_prev_close REAL, next_volume REAL, next_oi REAL, next_chg_oi REAL, oi REAL NOT NULL, chg_oi REAL NOT NULL, PRIMARY KEY (day, symbol)) WITHOUT ROWID;
`;

/** Weekdays from `from` to `to` inclusive, except `skip`. */
const weekdays = (from: string, to: string, skip: string[] = []) => {
  const out: number[] = [];
  for (let t = d(from); t <= d(to); t += DAY_MS) if (isWeekday(t) && !skip.map(d).includes(t)) out.push(t);
  return out;
};

const SBIN_DAYS = weekdays("2026-10-01", "2026-11-06", ["2026-10-20"]); // 20 Oct: a holiday
const sbinClose = (t: number) => 900 + SBIN_DAYS.indexOf(t);

function writeSeries(db: Database.Database, key: string, coveredFrom: number, syncedAt: number, bars: Bar[]) {
  const insert = db.prepare("insert into candles values (?, ?, ?, ?, ?, ?, ?)");
  for (const b of bars) insert.run(key, b.t, b.o, b.h, b.l, b.c, b.v);
  db.prepare("insert into series values (?, ?, ?, ?, ?, ?)").run(key, coveredFrom, syncedAt, bars.length, bars[0]?.t ?? null, bars.at(-1)?.t ?? null);
}

function foRow(day: number, symbol: string, oi: number) {
  return { day, symbol, nse_symbol: symbol, expiries: 2, lot: 750, underlying: 950, near_expiry: d("2026-11-24"), near_close: 951, near_settle: 951, near_prev_close: 945, near_volume: 1000, near_oi: oi, near_chg_oi: 500, next_expiry: d("2026-12-29"), next_close: 955, next_settle: 955, next_prev_close: 949, next_volume: 10, next_oi: 1000, next_chg_oi: 0, oi: oi + 1000, chg_oi: 500 };
}

/** A Tradex .cache: market.db (candles + F&O) and screener/bhav. */
function makeTradex(root: string) {
  mkdirSync(root, { recursive: true });
  const file = path.join(root, "market.db");
  const db = new Database(file);
  db.exec(TRADEX_SCHEMA);
  // Daily SBIN, synced on Friday 6 Nov mid-session: the 6 Nov bar was forming.
  writeSeries(db, "NSE:SBIN-EQ:D", d("2026-10-01") - 2 * 3_600_000, ist(2026, 11, 6, 13, 0), SBIN_DAYS.map((t) => bar(t, sbinClose(t))));
  // NIFTY daily stamped at IST midnight, synced on the weekend.
  writeSeries(db, "NSE:NIFTY50-INDEX:D", d("2026-11-02") - 3_600_000, ist(2026, 11, 7, 10, 0), weekdays("2026-11-02", "2026-11-06").map((t, i) => bar(t - IST_OFFSET_MS, 24000 + i)));
  // 15-minute SBIN for one session, synced after the close.
  const open = ist(2026, 11, 5, 9, 15);
  writeSeries(db, "NSE:SBIN-EQ:15", open - 60_000, ist(2026, 11, 5, 16, 0), Array.from({ length: 25 }, (_, i) => bar(open + i * 15 * MINUTE_MS, 950 + i / 10)));
  writeSeries(db, "NSE:SBIN-EQ:60", open, ist(2026, 11, 5, 16, 0), [bar(open, 950)]);
  writeSeries(db, "BSE:SENSEX-INDEX:D", d("2026-11-02"), ist(2026, 11, 7, 10, 0), [bar(d("2026-11-02"), 80000)]);
  writeSeries(db, "NSE:BROKEN-EQ:D", d("2026-11-02"), ist(2026, 11, 7, 10, 0), [{ ...bar(d("2026-11-02"), 10), l: -5 }]);

  const insertFo = db.prepare(`insert into fo_futures values (@day, @symbol, @nse_symbol, @expiries, @lot, @underlying, @near_expiry, @near_close, @near_settle, @near_prev_close, @near_volume, @near_oi, @near_chg_oi,
    @next_expiry, @next_close, @next_settle, @next_prev_close, @next_volume, @next_oi, @next_chg_oi, @oi, @chg_oi)`);
  for (const [day, symbols] of [[d("2026-11-04"), ["RELIANCE", "SBIN"]], [d("2026-11-05"), ["RELIANCE", "SBIN", "TCS"]]] as const) {
    symbols.forEach((symbol, i) => insertFo.run(foRow(day, symbol, 10_000 * (i + 1))));
    db.prepare("insert into fo_bhav_days values (?, 'ok', ?, ?, null)").run(day, symbols.length, day + 20 * 3_600_000);
  }
  db.prepare("insert into fo_bhav_days values (?, 'holiday', 0, ?, null)").run(d("2026-10-20"), d("2026-10-21"));
  db.prepare("insert into fo_bhav_days values (?, 'ok', 5, ?, null)").run(d("2026-11-06"), d("2026-11-06")); // claims 5 rows, has none
  db.close();

  const bhav = path.join(root, "screener", "bhav");
  mkdirSync(bhav, { recursive: true });
  const name = (iso: string) => `${iso.slice(8, 10)}${iso.slice(5, 7)}${iso.slice(0, 4)}.json`;
  const rowFor = (t: number, extra = 0) => ({ prevClose: sbinClose(t) - 1, open: sbinClose(t), high: sbinClose(t) + 2, low: sbinClose(t) - 2, close: sbinClose(t) + extra, volume: 5000, deliveryPct: 41.5 });
  writeFileSync(path.join(bhav, name("2026-11-02")), JSON.stringify({ SBIN: rowFor(d("2026-11-02")), INFY: { ...rowFor(d("2026-11-02")), deliveryPct: null }, "bad sym": rowFor(d("2026-11-02")) }));
  writeFileSync(path.join(bhav, name("2026-10-20")), "null");
  writeFileSync(path.join(bhav, name("2026-11-03")), "null"); // but SBIN traded that day
  // NSE served 4 Nov's file for 5 Nov too.
  writeFileSync(path.join(bhav, name("2026-11-04")), JSON.stringify({ SBIN: rowFor(d("2026-11-04")) }));
  writeFileSync(path.join(bhav, name("2026-11-05")), JSON.stringify({ SBIN: rowFor(d("2026-11-04")) }));
  writeFileSync(path.join(bhav, "notes.txt"), "not a bhav file");
  return { file, screener: path.join(root, "screener") };
}

/** Everything the import may touch, for before/after comparisons. */
const snapshot = (h: TestHub) =>
  JSON.stringify(["series", "candles", "cash_bhav", "nse_days", "fo_futures"].map((table) => h.db.prepare(`select * from ${table} order by 1, 2, 3`).all()));

describe("import-tradex", () => {
  let h: TestHub;
  let root: string;
  let tradex: { file: string; screener: string };
  beforeEach(() => {
    h = makeHub();
    root = mkdtempSync(path.join(tmpdir(), "tradex-"));
    tradex = makeTradex(root);
  });
  afterEach(() => {
    h.cleanup();
    rmSync(root, { recursive: true, force: true });
  });

  const run = (dryRun = false) => importTradex({ db: h.db, tradexDb: tradex.file, screenerDir: tradex.screener, dryRun, now: ist(2026, 11, 9, 10, 0) });

  it("imports candles with honest coverage, cash bhav days that check out, and F&O days", async () => {
    const report = run();
    expect(report.candles).toMatchObject({
      seen: 6,
      imported: { "1d": { series: 2, bars: SBIN_DAYS.length - 1 + 5 }, "15m": { series: 1, bars: 25 }, "5m": { series: 0 } },
      unchanged: 0,
      droppedBars: 1,
    });
    expect(report.candles.skipped.map((s) => s.item).sort()).toEqual(["BSE:SENSEX-INDEX:D", "NSE:BROKEN-EQ:D", "NSE:SBIN-EQ:60"]);

    // SBIN daily: the forming 6 Nov bar is left out, so the hub will fetch it like any tail.
    expect(readSeries(h.db, "SBIN", "1d")).toMatchObject({ coverage: { from: d("2026-10-01"), to: d("2026-11-06") }, count: SBIN_DAYS.length - 1, lastT: d("2026-11-05") });
    expect(readSeries(h.db, "NIFTY", "1d")).toMatchObject({ coverage: { from: d("2026-11-02"), to: d("2026-11-07") }, firstT: d("2026-11-02") });
    expect(readSeries(h.db, "SBIN", "15m")).toMatchObject({ coverage: { from: ist(2026, 11, 5, 9, 15), to: ist(2026, 11, 5, 15, 30) }, count: 25 });

    // Cash bhav: 2 Nov imported, 20 Oct a holiday; 3 Nov (no file, but SBIN traded) and the 4/5 Nov copies skipped.
    expect(report.cashBhav).toMatchObject({ files: 5, imported: { days: 1, holidays: 1, rows: 2 }, badRows: 1 });
    expect(report.cashBhav!.skipped.map((s) => s.item).sort()).toEqual(["2026-11-03", "2026-11-04", "2026-11-05"]);
    expect([...checkedDays(h.db, "cash_bhav")]).toEqual(expect.arrayContaining([[d("2026-11-02"), "ok"], [d("2026-10-20"), "holiday"]]));
    expect(h.db.prepare("select series, deliv_pct from cash_bhav where symbol = 'SBIN'").get()).toEqual({ series: IMPORTED_SERIES, deliv_pct: 41.5 });

    // F&O: two days and a holiday; 6 Nov's day record doesn't match its rows.
    expect(report.fo).toMatchObject({ days: 4, imported: { ok: 2, holiday: 1, rows: 5 }, skipped: [{ item: "2026-11-06" }] });
    expect(foMembersOn(h.db, d("2026-11-06"))).toEqual({ day: d("2026-11-05"), symbols: ["RELIANCE", "SBIN", "TCS"] });
    expect(readFoSymbol(h.db, "SBIN", d("2026-11-01"), d("2026-11-30")).map((r) => r.near.oi)).toEqual([20_000, 20_000]);

    // Served by the API from the store, with delivery % — no broker configured.
    const res = await h.app().request("/v1/candles?symbol=SBIN&tf=1d&from=2026-11-02&to=2026-11-05", { headers: { Authorization: `Bearer ${(await import("../src/auth/keys.js")).createKey(h.db, "t", ["history"]).key}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { candles: Array<{ t: number; c: number; dp: number | null }>; complete: boolean };
    expect(body.complete).toBe(true);
    expect(body.candles.map((c) => [c.t, c.c, c.dp])).toEqual([d("2026-11-02"), d("2026-11-03"), d("2026-11-04"), d("2026-11-05")].map((t) => [t, sbinClose(t), t === d("2026-11-02") ? 41.5 : null]));

    expect(formatImportReport(report).join("\n")).toMatch(/1d +imported 2 series/);
  });

  it("is idempotent: a second run changes nothing", () => {
    run();
    const before = snapshot(h);
    const again = run();
    expect(snapshot(h)).toBe(before);
    expect(again.candles).toMatchObject({ unchanged: 3, imported: { "1d": { series: 0 }, "15m": { series: 0 } } });
    expect(again.cashBhav).toMatchObject({ unchanged: 2, imported: { days: 0, holidays: 0 } });
    expect(again.fo).toMatchObject({ unchanged: 3, imported: { ok: 0, holiday: 0 } });
  });

  it("dry run reports the same numbers and writes nothing", () => {
    const before = snapshot(h);
    const dry = run(true);
    expect(snapshot(h)).toBe(before);
    expect(formatImportReport(dry)[0]).toMatch(/DRY RUN/);
    const real = run();
    expect({ ...real, dryRun: true }).toEqual(dry);
  });

  it("merges with series the hub already has only where they touch", () => {
    // NIFTY: the hub has 9–10 Nov, which touches Tradex's [2 Nov, 7 Nov)? No: 7–8 Nov is a weekend gap in time.
    writeBars(h.db, "NIFTY", "1d", [bar(d("2026-11-09"), 25000)], { from: d("2026-11-09"), to: d("2026-11-10") }, 1);
    // SBIN 1d: the hub has 5–6 Nov with the same 5 Nov close: grows back to 1 Oct, its own bars kept.
    writeBars(h.db, "SBIN", "1d", [bar(d("2026-11-05"), sbinClose(d("2026-11-05"))), bar(d("2026-11-06"), 999)], { from: d("2026-11-05"), to: d("2026-11-07") }, 2);
    // SBIN 15m: the hub's prices are half of Tradex's (adjusted for a split since).
    writeBars(h.db, "SBIN", "15m", [bar(ist(2026, 11, 5, 15, 15), 475)], { from: ist(2026, 11, 5, 15, 15), to: ist(2026, 11, 5, 15, 30) }, 3);

    const report = run();
    expect(report.candles.skipped).toEqual(expect.arrayContaining([
      { item: "NSE:NIFTY50-INDEX:D", reason: expect.stringContaining("gap") },
      { item: "NSE:SBIN-EQ:15", reason: expect.stringContaining("split") },
    ]));
    expect(readSeries(h.db, "NIFTY", "1d")).toMatchObject({ coverage: { from: d("2026-11-09"), to: d("2026-11-10") }, count: 1 });
    expect(readSeries(h.db, "SBIN", "1d")).toMatchObject({ coverage: { from: d("2026-10-01"), to: d("2026-11-07") }, count: SBIN_DAYS.length });
    expect(readBars(h.db, "SBIN", "1d", d("2026-11-06"), d("2026-11-07"))[0].c).toBe(999);
    expect(readSeries(h.db, "SBIN", "15m")).toMatchObject({ count: 1 });
  });

  it("refuses to write while a hub server owns the data directory; a dry run is allowed", () => {
    writeFileSync(path.join(h.dir, "owner.lock"), String(process.ppid));
    const options = { db: h.db, tradexDb: tradex.file, screenerDir: tradex.screener, dryRun: false };
    expect(() => importTradexLocked(h.dir, options)).toThrow(ImportError);
    expect(() => importTradexLocked(h.dir, options)).toThrow(/owns/);
    expect(importTradexLocked(h.dir, { ...options, dryRun: true }).dryRun).toBe(true);
    rmSync(path.join(h.dir, "owner.lock"));
    expect(importTradexLocked(h.dir, options).candles.imported["1d"].series).toBe(2);
  });

  it("explains a missing or unreadable source", () => {
    expect(() => importTradex({ db: h.db, tradexDb: path.join(root, "nope.db"), dryRun: true })).toThrow(/No Tradex database/);
    writeFileSync(path.join(root, "junk.db"), "not sqlite at all, just text that is long enough to be a header");
    expect(() => importTradex({ db: h.db, tradexDb: path.join(root, "junk.db"), dryRun: true })).toThrow(/read-only/);
  });
});
