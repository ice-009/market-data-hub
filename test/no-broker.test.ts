import { afterEach, describe, expect, it } from "vitest";
import { createKey } from "../src/auth/keys.js";
import { BrokerError } from "../src/broker/errors.js";
import { deriveFactors, rederiveAll } from "../src/history/adjustments.js";
import { applyCashBhav } from "../src/history/fromBhav.js";
import { archiveDaily } from "../src/history/fromArchive.js";
import { readBars, readSeries } from "../src/history/store.js";
import { getJob, updateJob } from "../src/jobs/backfill.js";
import { queueEndOfDayHistory } from "../src/jobs/endOfDay.js";
import type { CashBhavRow } from "../src/nse/parsers/cashBhav.js";
import { markDay, writeCashDay } from "../src/nse/store.js";
import { DAY_MS, parseIsoDay } from "../src/time.js";
import { ist, makeHub, type TestHub } from "./support/hub.js";

// End-of-day mode (market-data-hub#32): no broker credentials at all. Daily
// stock candles come from the stored NSE cash bhavcopies, adjusted for splits
// with the stored factors (here from NSE's own PREV_CLOSE; market-data-hub#20);
// live and intraday requests answer not_configured.

const d = (iso: string) => parseIsoDay(iso)!;
const row = (symbol: string, prevClose: number, close: number, extra: Partial<CashBhavRow> = {}): CashBhavRow => ({
  symbol,
  series: "EQ",
  prevClose,
  open: close - 2,
  high: close + 5,
  low: close - 5,
  close,
  volume: 1000,
  deliveryPct: 50,
  ...extra,
});

/**
 * A small archive: 22 Oct stored, 23 Oct never asked for (a gap), 27 Oct a
 * holiday, sessions 26 Oct – 6 Nov stored. SBIN splits 1:2 on 4 Nov (that
 * file's PREV_CLOSE is 500, half of 3 Nov's close); INFY doesn't.
 */
function seedArchive(t: TestHub) {
  const sbin: Array<[string, number, number, Partial<CashBhavRow>?]> = [
    ["2026-10-22", 980, 990],
    ["2026-10-26", 990, 1000],
    ["2026-10-28", 1000, 1010],
    ["2026-10-29", 1010, 1020],
    ["2026-10-30", 1020, 1000],
    ["2026-11-02", 1000, 990],
    ["2026-11-03", 990, 1000],
    ["2026-11-04", 500, 505, { open: 501, high: 510, low: 495, volume: 4000 }],
    ["2026-11-05", 505, 510],
    ["2026-11-06", 510, 520],
  ];
  let infy = 1500;
  for (const [iso, prevClose, close, extra] of sbin) {
    writeCashDay(t.db, d(iso), [row("SBIN", prevClose, close, extra), row("INFY", infy, infy + 10)], 0);
    infy += 10;
  }
  markDay(t.db, "cash_bhav", d("2026-10-27"), "holiday", 0, 0);
  deriveFactors(t.db);
}

let t: TestHub;
afterEach(() => t?.cleanup());

/** A hub without broker credentials, its clock at `now` (Sunday 8 Nov 2026 noon IST by default). */
function eodHub() {
  const clock = { now: ist(2026, 11, 8, 12) };
  t = makeHub({ clock: () => clock.now });
  seedArchive(t);
  const { key } = createKey(t.db, "test", ["history", "fo", "live"]);
  const app = t.app();
  const get = async (path: string) => {
    const res = await app.request(path, { headers: { authorization: `Bearer ${key}` } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { res, status: res.status, body: (await res.json()) as any };
  };
  return { clock, get };
}

describe("daily candles from the stored archive (pure read)", () => {
  it("adjusts bars before an ex-date with NSE's PREV_CLOSE, and claims only the checked stretch", () => {
    t = makeHub();
    seedArchive(t);
    const result = archiveDaily(t.db, "SBIN", d("2026-10-01"), d("2026-11-06"));
    // 23 Oct was never asked for: coverage starts after it (the holiday on 27 Oct doesn't break it).
    expect(result.coveredFromDay).toBe(d("2026-10-24"));
    expect(result.coveredToDay).toBe(d("2026-11-06"));
    expect(result.bars.map((bar) => bar.t)).toEqual(["2026-10-26", "2026-10-28", "2026-10-29", "2026-10-30", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06"].map(d));
    // Before the split: halved prices, doubled volume. From the ex-date on: as traded.
    expect(result.bars[0]).toEqual({ t: d("2026-10-26"), o: 499, h: 502.5, l: 497.5, c: 500, v: 2000 });
    expect(result.bars[5]).toMatchObject({ t: d("2026-11-03"), c: 500, v: 2000 });
    expect(result.bars[6]).toEqual({ t: d("2026-11-04"), o: 501, h: 510, l: 495, c: 505, v: 4000 });
    // No ex-date: nothing changes.
    expect(archiveDaily(t.db, "INFY", d("2026-10-26"), d("2026-11-06")).bars[0]).toMatchObject({ c: 1520, v: 1000 });
  });

  it("reaches as far back as the archive once the gap is filled, and only to what's stored at the newest end", () => {
    t = makeHub();
    seedArchive(t);
    markDay(t.db, "cash_bhav", d("2026-10-23"), "holiday", 0, 0);
    deriveFactors(t.db);
    const older = archiveDaily(t.db, "SBIN", d("2026-10-01"), d("2026-11-09"));
    expect(older.bars[0]).toMatchObject({ t: d("2026-10-22"), c: 495 });
    expect(older.coveredToDay).toBe(d("2026-11-07")); // through Saturday: Sun 8 Nov's file (Muhurat) isn't stored yet
  });

  it("says why when it can't answer", () => {
    t = makeHub();
    const kind = (fn: () => unknown) => {
      try {
        fn();
      } catch (error) {
        return error instanceof BrokerError ? error.kind : "other";
      }
      return null;
    };
    expect(kind(() => archiveDaily(t.db, "SBIN", d("2026-10-01"), d("2026-11-06")))).toBe("upstream"); // nothing stored yet
    seedArchive(t);
    expect(kind(() => archiveDaily(t.db, "NOSUCH", d("2026-10-01"), d("2026-11-06")))).toBe("bad_symbol");
    expect(archiveDaily(t.db, "SBIN", d("2026-01-01"), d("2026-01-31")).bars).toEqual([]); // older than anything stored
  });
});

describe("the API in end-of-day mode", () => {
  it("says so in /v1/status", async () => {
    const { get } = eodHub();
    const status = await get("/v1/status");
    expect(status.body).toMatchObject({
      mode: "end_of_day",
      modeLabel: "End-of-day only",
      features: { dailyCandles: true, fo: true, intradayCandles: false, liveQuotes: false, stream: false, indexCandles: false },
      broker: { configured: false, connected: false },
    });
    expect(status.body.modeNote).toMatch(/No broker is configured/);
  });

  it("serves daily and weekly candles from NSE's files, nothing intraday", async () => {
    const { get } = eodHub();
    const daily = await get("/v1/candles?symbol=SBIN&tf=1d&from=2026-10-26&to=2026-11-06");
    expect(daily.status).toBe(200);
    expect(daily.body).toMatchObject({ complete: true, coverage: { from: d("2026-10-26"), to: d("2026-11-07") } });
    expect(daily.body.candles).toHaveLength(9);
    expect(daily.body.candles[0]).toMatchObject({ t: d("2026-10-26"), c: 500, dp: 50 });
    expect(readSeries(t.db, "SBIN", "1d")?.coverage).toEqual({ from: d("2026-10-26"), to: d("2026-11-07") });

    const weekly = await get("/v1/candles?symbol=SBIN&tf=1w&from=2026-10-26&to=2026-11-06");
    expect(weekly.body.candles.map((bar: { t: number; c: number }) => [bar.t, bar.c])).toEqual([
      [d("2026-10-26"), 500],
      [d("2026-11-02"), 520],
    ]);

    // Asking further back than the archive reaches isn't an error: there is nothing more to get.
    const longer = await get("/v1/candles?symbol=SBIN&tf=1d&from=2026-10-01&to=2026-11-06");
    expect(longer.status).toBe(200);
    expect(longer.body.complete).toBe(false);

    for (const tf of ["5m", "15m", "1h", "1m"]) {
      const intraday = await get(`/v1/candles?symbol=SBIN&tf=${tf}`);
      expect(intraday.status, tf).toBe(503);
      expect(intraday.res.headers.get("retry-after"), tf).toBeNull();
      expect(intraday.body, tf).toMatchObject({ code: "not_configured", mode: "end_of_day", error: expect.stringMatching(/Intraday candles need a broker/) });
    }
    const index = await get("/v1/candles?symbol=NIFTY&tf=1d&from=2026-10-26&to=2026-11-06");
    expect(index.status).toBe(503);
    expect(index.body).toMatchObject({ code: "not_configured", error: expect.stringMatching(/Index candles beyond NSE's index file/), candles: [] });
    expect((await get("/v1/candles?symbol=SBIN26NOVFUT&tf=1d&from=2026-10-26&to=2026-11-06")).body.code).toBe("not_configured");
    expect((await get("/v1/candles?symbol=NOSUCH&tf=1d&from=2026-10-26&to=2026-11-06")).status).toBe(404);
  });

  it("keeps the series current from the evening bhavcopy, and fills older days once they're downloaded", async () => {
    const { clock, get } = eodHub();
    await get("/v1/candles?symbol=SBIN&tf=1d&from=2026-10-26&to=2026-11-06");
    // Monday evening: the scheduler stores 9 Nov's file and extends every stored series by it.
    clock.now = ist(2026, 11, 9, 19);
    writeCashDay(t.db, d("2026-11-09"), [row("SBIN", 520, 530)], clock.now);
    applyCashBhav(t.db, d("2026-11-09"), [row("SBIN", 520, 530)], t.hub.log);
    expect(readBars(t.db, "SBIN", "1d", d("2026-11-09"), d("2026-11-10"))).toHaveLength(1);
    // `hub data nse-history` later asks NSE for 23 Oct (a holiday, say), and derives the factors again: the next request reaches 22 Oct.
    markDay(t.db, "cash_bhav", d("2026-10-23"), "holiday", 0, 0);
    expect(rederiveAll(t.db, { endOfDay: true, now: clock.now }).changed).toEqual([]);
    const answer = await get("/v1/candles?symbol=SBIN&tf=1d&from=2026-10-22&to=2026-11-09");
    expect(answer.body.complete).toBe(true);
    expect(answer.body.candles.map((bar: { c: number }) => bar.c)).toEqual([495, 500, 505, 510, 500, 495, 500, 505, 510, 520, 530]);
  });

  it("fills a batch from the store in one request, without queueing", async () => {
    const { get } = eodHub();
    const batch = await get("/v1/candles/batch?symbols=SBIN,INFY,NIFTY,NOSUCH&from=2026-10-26&to=2026-11-06");
    expect(batch.status).toBe(200);
    expect(batch.body).toMatchObject({ queued: [], unknown: ["NOSUCH"], reason: "not_configured", warning: expect.stringMatching(/End-of-day mode/) });
    expect(batch.body.series.SBIN).toMatchObject({ complete: true });
    expect(batch.body.series.SBIN.candles).toHaveLength(9);
    expect(batch.body.series.INFY.candles.at(-1)).toMatchObject({ t: d("2026-11-06"), c: 1600 });
    expect(batch.body.series.NIFTY).toMatchObject({ complete: false, candles: [] });
  });

  it("answers live requests and the market regime with not_configured", async () => {
    const { get } = eodHub();
    for (const path of ["/v1/quotes?symbols=SBIN", "/v1/stream?symbols=SBIN"]) {
      const answer = await get(path);
      expect(answer.status, path).toBe(503);
      expect(answer.body, path).toMatchObject({ code: "not_configured", mode: "end_of_day", error: expect.stringMatching(/Live prices need a broker/) });
    }
    const regime = await get("/v1/market/regime");
    expect(regime.status).toBe(503);
    expect(regime.body).toMatchObject({ code: "not_configured", mode: "end_of_day" });
  });

  it("still serves the NSE reference data", async () => {
    const { get } = eodHub();
    // Nothing downloaded in this test: the usual not_ready answers, not not_configured.
    expect((await get("/v1/lots")).body.code).toBe("not_ready");
    expect((await get("/v1/fo/ban")).body.code).toBe("not_ready");
    expect((await get("/v1/universe/nifty50")).status).toBe(200);
  });
});

describe("queueEndOfDayHistory", () => {
  const now = ist(2026, 11, 18, 20);

  it("queues the archive download once, and nothing when every day is already asked for", () => {
    t = makeHub();
    expect(queueEndOfDayHistory(t.db, 0, now)).toBeNull();
    const job = queueEndOfDayHistory(t.db, 1, now)!;
    expect(job).toMatchObject({ kind: "nse_history", params: { from: "2025-11-17", to: "2026-11-17", datasets: ["cash_bhav", "fo_bhav", "pr", "index_close"] } });
    expect(queueEndOfDayHistory(t.db, 1, now)).toBeNull(); // still open
    updateJob(t.db, job.id, { state: "done" }, now);
    for (let day = d("2025-11-17"); day <= d("2026-11-17"); day += DAY_MS) {
      markDay(t.db, "cash_bhav", day, "holiday", 0, now);
      markDay(t.db, "fo_bhav", day, "holiday", 0, now);
      markDay(t.db, "pr", day, "holiday", 0, now);
      markDay(t.db, "index_close", day, "holiday", 0, now);
    }
    expect(queueEndOfDayHistory(t.db, 1, now)).toBeNull();
    expect(getJob(t.db, job.id)?.state).toBe("done");
  });
});
