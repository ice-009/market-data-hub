import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createKey } from "../src/auth/keys.js";
import type { Bar } from "../src/broker/fyers.js";
import type { Db } from "../src/db.js";
import { archiveDaily } from "../src/history/fromArchive.js";
import { brokerSeam, handover, joinCoverage, joinSpans, scaleBars, seamFit, storedSpans } from "../src/history/longDaily.js";
import { checkSeams } from "../src/history/seamCheck.js";
import { writeBars } from "../src/history/store.js";
import { markDay, writeCashDay, writeSymbolChanges } from "../src/nse/store.js";
import { DAY_MS, isWeekday, isoDay, parseIsoDay } from "../src/time.js";
import { ist, makeHub, type TestHub } from "./support/hub.js";
import { startMockFyers, type MockFyers } from "./support/mockFyers.js";

// Daily history before the broker's window (#22): NSE's archive joined to the
// broker's bars. The seam test runs on real data (test/fixtures/seam-2021.json:
// the hub's store, 1 Oct 2021 – 31 Jan 2022): CONCOR, whose 1:4 bonus of July
// 2023 the hub's factors lack but the broker's history has, so the archive must
// be scaled to line up; ANGELONE, renamed from ANGELBRKG on 11 Nov 2021, two
// weeks before the seam.

const d = (iso: string) => parseIsoDay(iso)!;
const bar = (iso: string, c: number, o = c): Bar => ({ t: d(iso), o, h: Math.max(o, c), l: Math.min(o, c), c, v: 100 });

describe("lining the archive up with the broker (pure)", () => {
  it("measures the median ratio over the first common sessions, and keeps the factors within 0.5%", () => {
    const archive = [bar("2021-11-24", 100), bar("2021-11-25", 101), bar("2021-11-26", 102), bar("2021-11-29", 103)];
    expect(seamFit(archive, archive.map((b) => ({ ...b, c: b.c * 1.003 })))).toMatchObject({ scale: 1, sessions: 4 });
    const fit = seamFit(archive, [{ ...archive[0], c: 80 }, { ...archive[1], c: 80.8 }, { ...archive[2], c: 999 }, { ...archive[3], c: 82.4 }]);
    expect(fit.scale).toBeCloseTo(0.8, 6); // one bad bar doesn't move the median
    expect(seamFit(archive, [bar("2022-01-03", 50)])).toEqual({ scale: 1, sessions: 0, gap: null });
    expect(scaleBars([{ t: 0, o: 10, h: 11, l: 9, c: 10.01, v: 1000 }], 0.5)).toEqual([{ t: 0, o: 5, h: 5.5, l: 4.5, c: 5.01, v: 2000 }]);
  });

  it("joins spans and coverages only where they touch", () => {
    expect(joinSpans([{ source: "archive", from: 1, to: 2, names: ["A"] }, { source: "archive", from: 3, to: 4, names: ["A", "B"] }, { source: "broker", from: 5, to: 6 }])).toEqual([{ source: "archive", from: 1, to: 4, names: ["A", "B"] }, { source: "broker", from: 5, to: 6 }]);
    expect(joinCoverage({ from: 1, to: 5 }, { from: 5, to: 9 })).toEqual({ from: 1, to: 9 });
    expect(joinCoverage({ from: 1, to: 4 }, { from: 5, to: 9 })).toEqual({ from: 5, to: 9 });
    expect(joinCoverage(null, { from: 5, to: 9 })).toEqual({ from: 5, to: 9 });
  });

  it("labels an index's bars before the window as NSE's index file", () => {
    const seam = d("2021-11-24");
    expect(storedSpans("NIFTY", "broker", [bar("2015-01-01", 1), bar("2021-11-23", 1), bar("2021-11-24", 1)], seam)).toEqual([
      { source: "index_file", from: d("2015-01-01"), to: d("2021-11-23") },
      { source: "broker", from: d("2021-11-24"), to: d("2021-11-24") },
    ]);
    expect(storedSpans("NIFTYAUTO", "broker", [bar("2015-01-01", 1)], seam)).toEqual([{ source: "index_file", from: d("2015-01-01"), to: d("2015-01-01") }]);
    expect(storedSpans("EW-IT", "broker", [bar("2015-01-01", 1)], seam)[0].source).toBe("basket");
    expect(storedSpans("SBIN", "end_of_day", [bar("2025-01-01", 1)], seam)[0].source).toBe("archive");
    expect(brokerSeam(ist(2026, 11, 20, 12))).toBe(d("2021-11-24"));
  });
});

// ------------------------------------------------------------------ the real fixture

interface Fixture {
  cash: Record<string, Array<[string, "EQ" | "BE", number, number, number, number, number, number, number | null]>>;
  broker: Record<string, Array<[string, number, number, number, number, number]>>;
  days: { ok: string[]; holiday: string[] };
  factors: Array<{ symbol: string; date: string; factor: number; source: string; prevDate: string; prevC: number; prevClose: number; o: number; c: number }>;
  renames: Array<{ oldSymbol: string; newSymbol: string; date: string; company: string }>;
}
const fixture = JSON.parse(readFileSync(new URL("./fixtures/seam-2021.json", import.meta.url), "utf8")) as Fixture;
const NOW = ist(2026, 11, 20, 12); // the broker's window then starts on 24 Nov 2021
const SEAM = d("2021-11-24");
const END = d("2022-01-31");

function load(db: Db) {
  const byDay = new Map<string, Parameters<typeof writeCashDay>[2]>();
  for (const [symbol, rows] of Object.entries(fixture.cash)) {
    for (const [iso, series, prevClose, open, high, low, close, volume, deliveryPct] of rows) byDay.set(iso, [...(byDay.get(iso) ?? []), { symbol, series, prevClose, open, high, low, close, volume, deliveryPct }]);
  }
  for (const iso of fixture.days.ok) writeCashDay(db, d(iso), byDay.get(iso) ?? [], 0);
  for (const iso of fixture.days.holiday) markDay(db, "cash_bhav", d(iso), "holiday", 0, 0);
  const insert = db.prepare("insert into adjustment_factors (symbol, day, factor, source, prev_day, prev_c, prev_close, o, c, action, renamed_from) values (?, ?, ?, ?, ?, ?, ?, ?, ?, null, null)");
  for (const f of fixture.factors) insert.run(f.symbol, d(f.date), f.factor, f.source, d(f.prevDate), f.prevC, f.prevClose, f.o, f.c);
  writeSymbolChanges(db, fixture.renames.map((r) => ({ oldSymbol: r.oldSymbol, newSymbol: r.newSymbol, day: d(r.date), company: r.company })));
  // The broker's series as the hub stored them: the window from the seam on.
  for (const [symbol, rows] of Object.entries(fixture.broker)) {
    const bars = rows.map(([iso, o, h, l, c, v]) => ({ t: d(iso), o, h, l, c, v })).filter((b) => b.t >= SEAM);
    writeBars(db, symbol, "1d", bars, { from: SEAM, to: END + DAY_MS }, NOW);
  }
}

describe("the seam on real data", () => {
  let mock: MockFyers;
  let t: TestHub;
  beforeAll(async () => {
    mock = await startMockFyers();
  });
  afterAll(() => mock.close());
  afterEach(() => t?.cleanup());

  function hub() {
    t = makeHub({ env: mock.env, clock: () => NOW });
    load(t.db);
    const { key } = createKey(t.db, "test", ["history"]);
    const app = t.app();
    return async (path: string) => {
      const res = await app.request(path, { headers: { authorization: `Bearer ${key}` } });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { status: res.status, body: (await res.json()) as any };
    };
  }

  /** Every stored session in the range is a bar, and the step across the seam is a market move. */
  function expectSeamless(candles: Bar[], from: number, seam = SEAM) {
    const sessions = fixture.days.ok.map(d).filter((day) => day >= from && day <= END);
    expect(candles.map((c) => isoDay(c.t))).toEqual(sessions.map(isoDay));
    const i = candles.findIndex((c) => c.t >= seam);
    const [before, after] = [candles[i - 1], candles[i]];
    expect(Math.abs(Math.log(after.o / before.c))).toBeLessThan(0.03);
    // No step anywhere is anything like a split: the largest close-to-close move stays a market move.
    const moves = candles.slice(1).map((c, k) => Math.abs(Math.log(c.c / candles[k].c)));
    expect(Math.max(...moves)).toBeLessThan(0.12);
  }

  it("scales CONCOR's archive to the broker's level (its 2023 bonus is in the broker's history, not the hub's factors)", async () => {
    const get = await hub();
    const answer = await get("/v1/candles?symbol=CONCOR&tf=1d&from=2021-10-01&to=2022-01-31");
    expect(answer.status).toBe(200);
    const { sources, candles, complete, coverage } = answer.body;
    expect(sources).toHaveLength(2);
    expect(sources[0]).toMatchObject({ source: "archive", from: d("2021-10-01"), to: d("2021-11-23"), names: ["CONCOR"] });
    expect(sources[0].scale).toBeCloseTo(0.8, 2);
    expect(sources[1]).toEqual({ source: "broker", from: SEAM, to: END });
    expect(complete).toBe(true);
    expect(coverage).toEqual({ from: d("2021-10-01"), to: END + DAY_MS });
    expectSeamless(candles, d("2021-10-01"));
    // The archive's days: NSE's close × the scale, with NSE's delivery %.
    const raw = fixture.cash.CONCOR.find((row) => row[0] === "2021-11-01")!;
    const served = candles.find((c: Bar) => c.t === d("2021-11-01"));
    expect(served.c).toBeCloseTo(raw[6] * sources[0].scale, 1);
    expect(served.dp).toBe(raw[8]);
    // The broker's days unchanged.
    expect(candles.find((c: Bar) => c.t === SEAM).c).toBe(fixture.broker.CONCOR.find((row) => row[0] === "2021-11-24")![4]);
    expect(mock.history).toEqual([]); // all stored: no broker call
  });

  it("joins ANGELBRKG to ANGELONE across the rename, with no scale needed", async () => {
    const get = await hub();
    const answer = await get("/v1/candles?symbol=ANGELONE&tf=1d&from=2021-10-01&to=2022-01-31");
    // The broker's series starts on 29 Nov (not at the seam, 24 Nov): the archive hands over there.
    expect(answer.body.sources).toEqual([
      { source: "archive", from: d("2021-10-01"), to: d("2021-11-26"), names: ["ANGELBRKG", "ANGELONE"] },
      { source: "broker", from: d("2021-11-29"), to: END },
    ]);
    expectSeamless(answer.body.candles, d("2021-10-01"), d("2021-11-29"));
    // Across the rename (10 → 11 Nov) too.
    const [last, first] = [answer.body.candles.find((c: Bar) => c.t === d("2021-11-10")), answer.body.candles.find((c: Bar) => c.t === d("2021-11-11"))];
    expect(Math.abs(Math.log(first.o / last.c))).toBeLessThan(0.05);
    // Point in time: the old ticker, asked for its own days, is the same history.
    const old = await get("/v1/candles?symbol=ANGELBRKG&tf=1d&from=2021-10-01&to=2021-11-10");
    expect(old.body.candles.map((c: Bar) => c.c)).toEqual(answer.body.candles.filter((c: Bar) => c.t <= d("2021-11-10")).map((c: Bar) => c.c));
    // As traded: the names joined, raw prices (ANGELONE's 2026 split isn't applied).
    const raw = await get("/v1/candles?symbol=ANGELONE&tf=1d&from=2021-10-01&to=2021-11-30&adjust=none");
    expect(raw.body.sources).toEqual([{ source: "archive", from: d("2021-10-01"), to: d("2021-11-30"), names: ["ANGELBRKG", "ANGELONE"] }]);
    expect(raw.body.candles[0].c).toBe(fixture.cash.ANGELBRKG[0][6]);
  });

  it("serves the same through the batch endpoint and as weekly candles", async () => {
    const get = await hub();
    const single = await get("/v1/candles?symbol=CONCOR&tf=1d&from=2021-10-01&to=2022-01-31");
    const batch = await get("/v1/candles/batch?symbols=CONCOR,ANGELONE&tf=1d&from=2021-10-01&to=2022-01-31");
    expect(batch.status).toBe(200);
    expect(batch.body.queued).toEqual([]);
    expect(batch.body.series.CONCOR.candles).toEqual(single.body.candles);
    expect(batch.body.series.CONCOR.sources).toEqual(single.body.sources);
    expectSeamless(batch.body.series.ANGELONE.candles, d("2021-10-01"), d("2021-11-29"));
    const weekly = await get("/v1/candles?symbol=CONCOR&tf=1w&from=2021-10-04&to=2022-01-28");
    const weeks = weekly.body.candles.map((c: Bar) => c.t);
    expect(weeks).toEqual(Array.from({ length: 17 }, (_, i) => d("2021-10-04") + i * 7 * DAY_MS));
    const seamWeek = weekly.body.candles.find((c: Bar) => c.t === d("2021-11-22"));
    const days = single.body.candles.filter((c: Bar) => c.t >= d("2021-11-22") && c.t < d("2021-11-29"));
    expect(seamWeek).toMatchObject({ o: days[0].o, c: days.at(-1).c, h: Math.max(...days.map((c: Bar) => c.h)) });
    // A range wholly before the window: the archive alone, lined up all the same.
    const older = await get("/v1/candles?symbol=CONCOR&tf=1d&from=2021-10-01&to=2021-11-15");
    expect(older.body.sources).toHaveLength(1);
    expect(older.body.candles).toEqual(single.body.candles.filter((c: Bar) => c.t <= d("2021-11-15")));
    expect(mock.history).toEqual([]);
  });

  it("passes the seam check", () => {
    t = makeHub({ env: mock.env, clock: () => NOW });
    load(t.db);
    const report = checkSeams(t.db, NOW, { symbols: ["CONCOR", "ANGELONE"] });
    expect(report).toMatchObject({ seam: "2021-11-24", checked: 2, scaled: 1, renamed: 1, problems: { seam: 0, jump: 0, gap: 0 } });
    expect(report.rows.find((row) => row.symbol === "CONCOR")!.maxDiffPct).toBeLessThan(0.5);
  });
});

describe("before the broker's window, without real data", () => {
  let t: TestHub;
  afterEach(() => t?.cleanup());

  it("hands over at the stored series' first bar when it starts well after the seam", async () => {
    t = makeHub({ clock: () => ist(2026, 11, 20, 12) });
    const days: number[] = [];
    for (let day = d("2021-10-01"); day <= d("2022-03-31"); day += DAY_MS) if (isWeekday(day)) days.push(day);
    for (const [i, day] of days.entries()) writeCashDay(t.db, day, [{ symbol: "LATE", series: "EQ", prevClose: 100 + i - 1, open: 100 + i, high: 100 + i, low: 100 + i, close: 100 + i, volume: 1, deliveryPct: null }], 0);
    // The broker's series begins in February (it knows the stock only from then).
    writeBars(t.db, "LATE", "1d", days.filter((day) => day >= d("2022-02-01")).map((day) => ({ t: day, o: 1, h: 1, l: 1, c: 1, v: 1 })), { from: SEAM, to: d("2022-04-01") }, 0);
    expect(handover(t.db, "LATE", SEAM)).toBe(d("2022-02-01"));
    const { key } = createKey(t.db, "test", ["history"]);
    const res = await t.app().request("/v1/candles?symbol=LATE&tf=1d&from=2021-10-01&to=2022-03-31", { headers: { authorization: `Bearer ${key}` } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (await res.json()) as any;
    expect(body.candles).toHaveLength(days.length); // no gap between the seam and the broker's first bar
    expect(body.sources.map((s: { from: number; to: number }) => [isoDay(s.from), isoDay(s.to)])).toEqual([["2021-10-01", "2022-01-31"], ["2022-02-01", "2022-03-31"]]);
    expect(archiveDaily(t.db, "LATE", d("2021-10-01"), d("2021-10-05")).names).toEqual([{ symbol: "LATE", from: d("2021-10-01"), to: d("2021-10-05") }]);
  });
});
