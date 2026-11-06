import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createKey, type Scope } from "../src/auth/keys.js";
import { readBars, writeBars } from "../src/history/store.js";
import { writeCashDay, writeBan, writeFoDay, writeLots, writeResults, recordRun } from "../src/nse/store.js";
import { aggregateStockFutures, parseFoBhav } from "../src/nse/parsers/foBhav.js";
import { unzipSingle } from "../src/nse/unzip.js";
import { DAY_MS, istDayKey, isWeekday, parseIsoDay } from "../src/time.js";
import { readFileSync } from "node:fs";
import { ACCESS_TOKEN, FAKE_SECRETS, startMockFyers, type MockFyers } from "./support/mockFyers.js";
import { makeHub, type TestHub } from "./support/hub.js";

const d = (iso: string) => parseIsoDay(iso)!;
const auth = (key: string) => ({ headers: { authorization: `Bearer ${key}` } });

let t: TestHub;
afterEach(() => t?.cleanup());

function withKey(scopes: Scope[] = ["history", "fo"], options: Parameters<typeof makeHub>[0] = {}) {
  t = makeHub(options);
  const { key } = createKey(t.db, "test", scopes);
  const app = t.app();
  const get = async (path: string) => {
    const res = await app.request(path, auth(key));
    // Response bodies are checked field by field below; `any` keeps those checks short.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { res, status: res.status, body: (await res.json()) as any };
  };
  return { key, get };
}

describe("/v1/candles", () => {
  it("rejects bad parameters with clear 400s", async () => {
    const { get } = withKey();
    expect((await get("/v1/candles")).body).toMatchObject({ code: "bad_request", error: expect.stringMatching(/symbol is required/) });
    expect((await get("/v1/candles?symbol=SBIN&tf=2d")).body.error).toMatch(/tf must be one of 1d, 1w, 1h, 15m, 5m/);
    expect((await get("/v1/candles?symbol=SBIN&from=yesterday")).body.error).toMatch(/from must be a date/);
    expect((await get("/v1/candles?symbol=SBIN&from=2026-02-30")).status).toBe(400);
    expect((await get("/v1/candles?symbol=SBIN&from=2026-13-01")).body.error).toMatch(/from must be a date/);
    expect((await get("/v1/candles?symbol=SBIN&from=2026-10-10&to=2026-10-01")).body.error).toMatch(/from must not be after to/);
    expect((await get("/v1/candles?symbol=NSE:SBIN-EQ")).status).toBe(400);
  });

  it("needs the history scope", async () => {
    const { get } = withKey(["fo"]);
    expect((await get("/v1/candles?symbol=SBIN")).status).toBe(403);
  });

  it("serves stored candles with delivery %, and 503 + what's stored when the broker would be needed", async () => {
    const { get } = withKey(); // no broker configured
    const days = [d("2026-10-05"), d("2026-10-06")];
    writeBars(t.db, "SBIN", "1d", days.map((day, i) => ({ t: day, o: 10, h: 12, l: 9, c: 11 + i, v: 100 })), { from: days[0], to: days[1] + DAY_MS }, Date.now());
    writeCashDay(t.db, days[1], [{ symbol: "SBIN", series: "EQ", prevClose: 11, open: 10, high: 12, low: 9, close: 12, volume: 100, deliveryPct: 47.5 }], 0);

    const ok = await get("/v1/candles?symbol=sbin&tf=1d&from=2026-10-05&to=2026-10-06");
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ symbol: "SBIN", tf: "1d", complete: true, from: days[0], to: days[1] });
    expect(ok.body.candles).toEqual([
      { t: days[0], o: 10, h: 12, l: 9, c: 11, v: 100, dp: null },
      { t: days[1], o: 10, h: 12, l: 9, c: 12, v: 100, dp: 47.5 },
    ]);

    const more = await get("/v1/candles?symbol=SBIN&tf=1d&from=2026-10-01&to=2026-10-06");
    expect(more.status).toBe(503);
    expect(more.res.headers.get("retry-after")).toBe("60");
    expect(more.body).toMatchObject({ code: "broker_unavailable", reason: "not_configured", complete: false });
    expect(more.body.candles).toHaveLength(2);
  });

  describe("end to end with a mock Fyers server", () => {
    let mock: MockFyers;
    beforeAll(async () => {
      mock = await startMockFyers();
    });
    afterAll(() => mock.close());

    it("logs in, fetches what's missing, stores it, and reports it in /v1/status without secrets", async () => {
      mock.history.length = 0;
      const { key, get } = withKey(["history"], { env: mock.env });
      const first = await get("/v1/candles?symbol=SBIN&tf=1d&from=2026-09-01&to=2026-10-30");
      expect(first.status).toBe(200);
      expect(first.body.complete).toBe(true);
      expect(first.body.candles.length).toBe(44); // weekdays in Sep–Oct 2026
      expect(mock.history).toHaveLength(1);
      expect(readBars(t.db, "SBIN", "1d", d("2026-09-01"), d("2026-10-31"))).toHaveLength(44);

      // A weekly view of the same months needs only the first week's missing Monday.
      const weeks = await get("/v1/candles?symbol=SBIN&tf=1w&from=2026-09-02&to=2026-10-30");
      expect(weeks.body.candles[0].t).toBe(d("2026-08-31"));
      expect(mock.history.at(-1)).toMatchObject({ from: "2026-08-31", to: "2026-08-31" });

      // Two weekdays a week or more ago (inside the broker's one-year intraday window).
      let day = istDayKey() - 7 * DAY_MS;
      while (!isWeekday(day) || !isWeekday(day - DAY_MS)) day -= DAY_MS;
      const iso = (key: number) => new Date(key).toISOString().slice(0, 10);
      const hours = await get(`/v1/candles?symbol=NIFTY&tf=1h&from=${iso(day - DAY_MS)}&to=${iso(day)}`);
      expect(hours.status).toBe(200);
      expect(hours.body.candles).toHaveLength(14);
      expect(mock.history.at(-1)).toMatchObject({ symbol: "NSE:NIFTY50-INDEX", resolution: "15" });

      const unknown = await get("/v1/candles?symbol=NOSUCH&tf=1d&from=2026-10-01&to=2026-10-02");
      expect(unknown.status).toBe(404);
      expect(unknown.body.code).toBe("unknown_symbol");

      const status = await get("/v1/status");
      expect(status.body.broker).toMatchObject({ configured: true, connected: true, ownsConnection: true, budget: { plan: "standard", strikes: 0 } });
      expect(status.body.broker.budget.usedToday).toBe(mock.history.length);
      expect(status.body.data.candles).toEqual(expect.arrayContaining([expect.objectContaining({ tf: "1d", series: 1 })]));
      const raw = JSON.stringify(status.body) + t.lines.join("\n");
      for (const secret of [...Object.values(FAKE_SECRETS).filter((s) => s.length > 4), ACCESS_TOKEN, key]) expect(raw).not.toContain(secret);
    });

    it("answers 503 with stored data once the broker rate-limits", async () => {
      mock.history.length = 0;
      const { get } = withKey(["history"], { env: mock.env });
      await get("/v1/candles?symbol=INFY&tf=1d&from=2026-10-01&to=2026-10-09");
      mock.failNext(429);
      const res = await get("/v1/candles?symbol=INFY&tf=1d&from=2026-09-01&to=2026-10-09");
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ code: "broker_unavailable", reason: "rate_limited" });
      expect(res.body.candles.length).toBe(7);
      expect((await get("/v1/status")).body.broker.budget).toMatchObject({ strikes: 1, coolingDown: true });
    });
  });
});

describe("reference endpoints", () => {
  it("serves universes, the F&O list from the newest stored bhavcopy", async () => {
    const { get } = withKey(["history"]);
    const nifty50 = await get("/v1/universe/nifty50");
    expect(nifty50.body).toMatchObject({ name: "nifty50", source: "snapshot", count: 50 });
    expect(nifty50.body.members[0]).toEqual({ symbol: "ADANIENT", name: "Adani Enterprises Ltd.", industry: "Metals & Mining" });
    expect((await get("/v1/universe/nifty100")).body.count).toBe(100);
    expect((await get("/v1/universe/nifty500")).body.count).toBeGreaterThanOrEqual(500); // NSE has listed 501 at times
    expect((await get("/v1/universe/fno")).body).toMatchObject({ source: "snapshot" });
    const today = istDayKey();
    writeFoDay(t.db, today, aggregateStockFutures(parseFoBhav(unzipSingle(readFileSync(new URL("./fixtures/fo-bhav-20251029.csv.zip", import.meta.url))).data.toString("utf8")).contracts, d("2025-10-29")), Date.now());
    const fno = await get("/v1/universe/fno");
    expect(fno.body).toMatchObject({ source: "nse_fo_bhavcopy", count: 3 });
    expect(fno.body.members.map((m: { symbol: string }) => m.symbol)).toEqual(["RELIANCE", "SBIN", "TMPV"]);
    expect((await get("/v1/universe/sensex")).status).toBe(404);
  });

  it("serves F&O OI, point-in-time members and the ban list (scope fo)", async () => {
    const { get } = withKey(["fo"]);
    expect((await get("/v1/fo/ban")).status).toBe(503);
    const day = d("2025-10-29");
    const csv = unzipSingle(readFileSync(new URL("./fixtures/fo-bhav-20251029.csv.zip", import.meta.url))).data.toString("utf8");
    writeFoDay(t.db, day, aggregateStockFutures(parseFoBhav(csv).contracts, day), Date.now());

    const oi = await get("/v1/fo/oi?symbol=SBIN&from=2025-10-01&to=2025-10-31");
    expect(oi.status).toBe(200);
    expect(oi.body.days).toHaveLength(1);
    expect(oi.body.days[0]).toMatchObject({ date: "2025-10-29", chgOi: -2343000 + 68250 + 45000, buildup: "short-covering", near: { expiry: "2025-11-25" } });
    expect((await get("/v1/fo/oi")).status).toBe(400);

    expect((await get("/v1/fo/members?date=2025-11-02")).body).toEqual({ date: "2025-11-02", tradeDate: "2025-10-29", count: 3, symbols: ["RELIANCE", "SBIN", "TMPV"] });
    expect((await get("/v1/fo/members?date=2025-10-01")).status).toBe(404);

    writeBan(t.db, d("2026-11-05"), ["ABFRL"], 1);
    expect((await get("/v1/fo/ban")).body).toMatchObject({ tradeDate: "2026-11-05", symbols: ["ABFRL"] });
    expect((await get("/v1/lots")).status).toBe(403); // lots need history
  });

  it("serves lots and the results calendar", async () => {
    const { get } = withKey(["history"]);
    expect((await get("/v1/lots")).status).toBe(503);
    writeLots(t.db, { SBIN: 750, HAL: 150 });
    recordRun(t.db, "lots", { at: 5, ok: true, info: { source: "nse_mktlots", count: 2 } });
    expect((await get("/v1/lots")).body).toEqual({ source: "nse_mktlots", fetchedAt: 5, count: 2, lots: { HAL: 150, SBIN: 750 } });
    expect((await get("/v1/lots?symbol=sbin")).body).toMatchObject({ symbol: "SBIN", lot: 750 });
    expect((await get("/v1/lots?symbol=NOPE")).status).toBe(404);

    const today = istDayKey();
    writeResults(t.db, [{ symbol: "TCS", company: "TCS", date: today + 3 * DAY_MS, purpose: "Financial Results" }]);
    recordRun(t.db, "results", { at: 9, ok: true, info: { count: 1 } });
    const calendar = await get("/v1/results-calendar");
    expect(calendar.body.events).toHaveLength(1);
    expect(calendar.body.events[0]).toMatchObject({ symbol: "TCS", day: today + 3 * DAY_MS });
    expect((await get("/v1/results-calendar?symbol=INFY")).body.events).toEqual([]);
  });

  it("computes the market regime from stored candles", async () => {
    const { get } = withKey(["history"]);
    const today = istDayKey();
    const weekdays: number[] = [];
    for (let day = today - DAY_MS; weekdays.length < 260; day -= DAY_MS) if (isWeekday(day)) weekdays.unshift(day);
    const series = (start: number, step: number) => weekdays.map((day, i) => ({ t: day, o: start + i * step, h: start + i * step, l: start + i * step, c: start + i * step, v: 1 }));
    // Coverage reaching into the future: nothing to fetch, whatever the time of day.
    const everything = { from: 0, to: today + 10 * DAY_MS };
    writeBars(t.db, "NIFTY", "1d", series(20_000, 10), everything, Date.now());
    writeBars(t.db, "RELIANCE", "1d", series(1_000, 1), everything, Date.now()); // rising: above its 50-day
    writeBars(t.db, "TCS", "1d", series(4_000, -1), everything, Date.now()); // falling: below
    const regime = await get("/v1/market/regime?universe=nifty50");
    expect(regime.status).toBe(200);
    expect(regime.body).toMatchObject({ state: "caution", niftyAbove200: true, niftyAbove50: true, breadth50: 0.5, breadth: { universe: "nifty50", above50: 1, counted: 2, members: 50 } });
    expect((await get("/v1/market/regime?universe=world")).status).toBe(400);
  });
});
