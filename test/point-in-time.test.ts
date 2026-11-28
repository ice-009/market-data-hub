import { afterEach, describe, expect, it } from "vitest";
import { createKey, type Scope } from "../src/auth/keys.js";
import type { Db } from "../src/db.js";
import { markDay, writeBan, writeCashDay } from "../src/nse/store.js";
import { parseIsoDay } from "../src/time.js";
import { ist, makeHub, type TestHub } from "./support/hub.js";

// Reference data as it was on past days (ice-009/tradex-public#19): lot
// history from the F&O bhavcopy's lot column, the stored ban list of each
// trade date, and many listings' split/bonus factors in one request.

const d = (iso: string) => parseIsoDay(iso)!;
let t: TestHub;
afterEach(() => t?.cleanup());

function withKey(scopes: Scope[] = ["history", "fo"]) {
  t = makeHub({ clock: () => ist(2026, 11, 20, 10) });
  const { key } = createKey(t.db, "test", scopes);
  const app = t.app();
  const get = async (path: string) => {
    const res = await app.request(path, { headers: { authorization: `Bearer ${key}` } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, body: (await res.json()) as any };
  };
  return { get };
}

/** One stock's futures row on a day; `lot` null as in NSE's old-format files (before 8 Jul 2024). */
function foRow(db: Db, iso: string, symbol: string, lot: number | null) {
  db.prepare(
    `insert into fo_futures (day, symbol, nse_symbol, expiries, lot, underlying, near_expiry, near_close, near_settle, near_prev_close, near_volume, near_oi, near_chg_oi, oi, chg_oi)
     values (?, ?, ?, 1, ?, null, ?, 100, 100, 100, 1, 1, 0, 1, 0)`,
  ).run(d(iso), symbol, symbol, lot, d(iso) + 20 * 86_400_000);
  markDay(db, "fo_bhav", d(iso), "ok", 1, 0);
}

describe("GET /v1/lots/history", () => {
  it("serves lots as change points from the first file with a lot column, and says from when", async () => {
    const { get } = withKey(["history"]);
    expect((await get("/v1/lots/history")).body.code).toBe("not_ready");
    foRow(t.db, "2024-07-05", "SBIN", null); // old format: no lot
    foRow(t.db, "2024-07-08", "SBIN", 1500);
    foRow(t.db, "2024-07-09", "SBIN", 1500);
    foRow(t.db, "2024-12-27", "SBIN", 750);
    foRow(t.db, "2024-12-27", "HAL", 150);
    foRow(t.db, "2025-01-02", "HAL", 150);

    const all = await get("/v1/lots/history");
    expect(all.status).toBe(200);
    expect(all.body).toMatchObject({ from: null, to: "2026-11-20", knownFrom: "2024-07-08", knownFromDay: d("2024-07-08"), lastDate: "2025-01-02" });
    expect(all.body.lots).toEqual({
      HAL: [{ date: "2024-12-27", day: d("2024-12-27"), lot: 150, source: "bhavcopy" }],
      SBIN: [
        { date: "2024-07-08", day: d("2024-07-08"), lot: 1500, source: "bhavcopy" },
        { date: "2024-12-27", day: d("2024-12-27"), lot: 750, source: "bhavcopy" },
      ],
    });
    expect(all.body.sources).toEqual({ bhavcopy: { from: "2024-07-08", to: "2025-01-02", fromDay: d("2024-07-08"), toDay: d("2025-01-02") }, derived: null });
    // The range's first day is a change point even when it isn't the stock's first.
    expect((await get("/v1/lots/history?symbol=sbin&from=2024-07-09&to=2024-12-31")).body.lots).toEqual({
      SBIN: [
        { date: "2024-07-09", day: d("2024-07-09"), lot: 1500, source: "bhavcopy" },
        { date: "2024-12-27", day: d("2024-12-27"), lot: 750, source: "bhavcopy" },
      ],
    });
    // Before the lot column there is nothing, never an earlier or later day's lot.
    expect((await get("/v1/lots/history?from=2024-01-01&to=2024-07-05")).body.lots).toEqual({});
    expect((await get("/v1/lots/history?from=2025-01-02&to=2024-01-01")).status).toBe(400);
    expect((await get("/v1/lots/history?symbol=NSE:SBIN-EQ")).status).toBe(400);
  });

  it("knows no lots when every stored file is old-format", async () => {
    const { get } = withKey(["history"]);
    foRow(t.db, "2017-01-02", "SBIN", null);
    expect((await get("/v1/lots/history")).body).toMatchObject({ knownFrom: null, lots: {} });
  });
});

describe("the F&O ban list of past trade dates", () => {
  it("GET /v1/fo/ban?date= answers exactly that day's stored list, or 404 with knownFrom", async () => {
    const { get } = withKey(["fo"]);
    expect((await get("/v1/fo/ban?date=2026-11-10")).status).toBe(503);
    writeBan(t.db, d("2026-11-10"), ["ABFRL", "IEX"], 1);
    writeBan(t.db, d("2026-11-12"), [], 2);
    writeBan(t.db, d("2026-11-23"), ["IEX"], 3);

    expect((await get("/v1/fo/ban")).body).toMatchObject({ tradeDate: "2026-11-23", symbols: ["IEX"] });
    expect((await get("/v1/fo/ban?date=2026-11-10")).body).toMatchObject({ tradeDate: "2026-11-10", symbols: ["ABFRL", "IEX"], current: false });
    expect((await get("/v1/fo/ban?date=2026-11-12")).body).toMatchObject({ tradeDate: "2026-11-12", symbols: [] });
    const missing = await get("/v1/fo/ban?date=2026-11-11");
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ code: "no_data", knownFrom: "2026-11-10" });
    expect((await get("/v1/fo/ban?date=2001-01-01")).status).toBe(404);
    expect((await get("/v1/fo/ban?date=soon")).status).toBe(400);
  });

  it("GET /v1/fo/ban/history lists every stored trade date in the range", async () => {
    const { get } = withKey(["fo"]);
    expect((await get("/v1/fo/ban/history")).status).toBe(503);
    writeBan(t.db, d("2026-11-10"), ["ABFRL"], 1);
    writeBan(t.db, d("2026-11-12"), [], 2);
    expect((await get("/v1/fo/ban/history")).body).toEqual({
      knownFrom: "2026-11-10",
      knownFromDay: d("2026-11-10"),
      days: [
        { date: "2026-11-10", day: d("2026-11-10"), symbols: ["ABFRL"], fetchedAt: 1 },
        { date: "2026-11-12", day: d("2026-11-12"), symbols: [], fetchedAt: 2 },
      ],
      missing: [],
    });
    expect((await get("/v1/fo/ban/history?from=2026-11-11")).body.days.map((day: { date: string }) => day.date)).toEqual(["2026-11-12"]);
    expect((await get("/v1/lots/history")).status).toBe(403); // lots need history
  });
});

describe("GET /v1/adjustments/batch", () => {
  it("serves each listing's factors with the cumulative product, like /v1/adjustments", async () => {
    const { get } = withKey(["history"]);
    writeCashDay(t.db, d("2026-01-13"), [{ symbol: "KOTAKBANK", series: "EQ", prevClose: 2100, open: 2120, high: 2140, low: 2110, close: 2132.6, volume: 1, deliveryPct: null }], 0);
    const insert = t.db.prepare(
      "insert into adjustment_factors (symbol, day, factor, source, prev_day, prev_c, prev_close, o, c, action, renamed_from) values (?, ?, ?, 'price_gap', ?, 100, 100, 50, 50, ?, null)",
    );
    insert.run("KOTAKBANK", d("2024-03-01"), 0.5, d("2024-02-29"), "BONUS 1:1");
    insert.run("KOTAKBANK", d("2026-01-14"), 0.2, d("2026-01-13"), null);

    const answer = await get("/v1/adjustments/batch?symbols=kotakbank,SBIN");
    expect(answer.status).toBe(200);
    expect(answer.body.series.SBIN).toEqual({ current: "SBIN", factors: [] });
    expect(answer.body.series.KOTAKBANK.current).toBe("KOTAKBANK");
    expect(answer.body.series.KOTAKBANK.factors).toEqual([
      { date: "2024-03-01", day: d("2024-03-01"), symbol: "KOTAKBANK", factor: 0.5, cumulative: 0.1, source: "price_gap", action: "BONUS 1:1" },
      { date: "2026-01-14", day: d("2026-01-14"), symbol: "KOTAKBANK", factor: 0.2, cumulative: 0.2, source: "price_gap", action: null },
    ]);
    const single = await get("/v1/adjustments?symbol=KOTAKBANK");
    expect(single.body.factors.map((factor: { cumulative: number }) => factor.cumulative)).toEqual(answer.body.series.KOTAKBANK.factors.map((factor: { cumulative: number }) => factor.cumulative));

    expect((await get("/v1/adjustments/batch")).status).toBe(400);
    expect((await get(`/v1/adjustments/batch?symbols=${Array.from({ length: 301 }, (_, i) => `S${i}`).join(",")}`)).status).toBe(400);
    expect((await get("/v1/adjustments/batch?symbols=NSE:SBIN-EQ")).status).toBe(400);
  });
});
