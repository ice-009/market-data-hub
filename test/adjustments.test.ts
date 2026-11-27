import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createKey } from "../src/auth/keys.js";
import { compareSeries } from "../src/history/adjustCheck.js";
import { checkAdjustments } from "../src/history/adjustCheck.js";
import { ADJUSTMENT_VERSION, cumulative, decideFactor, deriveFactors, ensureFactors, inferLooseRatio, inferPartial, inferRatio, lastAdjustmentRun, listingFactors, prevCloseRatio, readFactors, rederiveAll, volatility, type Factor, type PairContext } from "../src/history/adjustments.js";
import { applyCashBhav } from "../src/history/fromBhav.js";
import { archiveDaily } from "../src/history/fromArchive.js";
import { readSeries, writeBars } from "../src/history/store.js";
import { enqueueJob } from "../src/jobs/backfill.js";
import { corporateActionDays, runNseHistory } from "../src/jobs/nseHistory.js";
import { createLogger } from "../src/log.js";
import { NseClient } from "../src/nse/client.js";
import { importDay, prUrl, type NseContext } from "../src/nse/datasets.js";
import { classifyPurpose, corporateActionsFileDay, parseCorporateActions, rightsTerms } from "../src/nse/parsers/corporateActions.js";
import type { CashBhavRow } from "../src/nse/parsers/cashBhav.js";
import { parseCmBhav } from "../src/nse/parsers/cmBhav.js";
import { corporateActionDaysRead, markDay, readCorporateActions, refreshCorporateActions, writeCashDay, writeCorporateActions, writeSymbolChanges, type StoredCorporateAction } from "../src/nse/store.js";
import { unzipFile } from "../src/nse/unzip.js";
import type { Db } from "../src/db.js";
import { DAY_MS, isWeekday, isoDay, parseIsoDay } from "../src/time.js";
import { ist, makeHub, type TestHub } from "./support/hub.js";
import { fakeFetch, fakeTime, type Route } from "./support/nse.js";

// Split and bonus adjustment (market-data-hub#20) and NSE's corporate actions
// (market-data-hub#25). Prices below are NSE's, as printed in its files: the
// cash bhavcopy rows come from real files (the 28 Jul 2022 cm bhavcopy for
// TATASTEEL; the hub's store of the 2025–26 files for the others), the bc
// fixtures are real PR zips' corporate-actions files (PR011010's Bc011010.csv;
// PR040425 trimmed to its bm and bc files; bc14112025.csv trimmed to 40 rows;
// PR100125's Bc100125.csv, its equity rows; PR200910's Bc200910.csv and
// PR220611's Bc220611.csv, two tickers each), and the old-format cm bhavcopies
// of 28 Feb and 1 Mar 1997, 11–12 Oct 2001, 20–21 Sep 2010 and 22–23 Jun 2011
// are NSE's files trimmed to a few tickers. Prices in the pure tests are NSE's
// rows as the hub stores them (#58).

const d = (iso: string) => parseIsoDay(iso)!;
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const quiet = createLogger({ level: "error", secrets: [], write: () => {} });

let t: TestHub;
afterEach(() => t?.cleanup());

/** One session of a ticker: [ISO date, PREV_CLOSE, open, close]. */
type Session = [string, number, number, number];

/**
 * Store cash days for several tickers at once (a day's file is written whole),
 * and mark every other weekday in the span a holiday, so sessions are
 * consecutive — except the days in `unchecked`.
 */
function seed(db: Db, tickers: Record<string, Session[]>, unchecked: string[] = []) {
  const byDay = new Map<number, CashBhavRow[]>();
  for (const [symbol, sessions] of Object.entries(tickers)) {
    for (const [iso, prevClose, open, close] of sessions) {
      const row: CashBhavRow = { symbol, series: "EQ", prevClose, open, high: Math.max(open, close), low: Math.min(open, close), close, volume: 1000, deliveryPct: null };
      byDay.set(d(iso), [...(byDay.get(d(iso)) ?? []), row]);
    }
  }
  const days = [...byDay.keys()].sort((a, b) => a - b);
  for (const day of days) writeCashDay(db, day, byDay.get(day)!, 0);
  const skip = new Set(unchecked.map(d));
  for (let day = days[0]; day <= days[days.length - 1]; day += DAY_MS) if (isWeekday(day) && !byDay.has(day) && !skip.has(day)) markDay(db, "cash_bhav", day, "holiday", 0, 0);
}

/** Store a bc file as if read from the PR zip of `day`. */
function storeBc(db: Db, name: string, csv: string) {
  writeCorporateActions(db, corporateActionsFileDay(name)!, parseCorporateActions(csv).rows);
}

const factorsOf = (db: Db, symbol: string) => readFactors(db, symbol).map((f) => ({ date: isoDay(f.day), factor: Number(f.factor.toFixed(5)), source: f.source }));

describe("NSE's corporate-actions file (the PR zip's bc file)", () => {
  it("reads its three date layouts, equity rows only, each action once", () => {
    const old = parseCorporateActions(fixture("Bc011010.csv").toString("utf8"));
    expect(old.badRows).toBe(0);
    const havells = old.rows.filter((row) => row.symbol === "HAVELLS"); // listed as BE and EQ
    expect(havells).toEqual([{ symbol: "HAVELLS", series: "EQ", company: "Havells India Limited", exDay: d("2010-10-08"), recordDay: d("2010-10-11"), purpose: "BONUS 1:1" }]);
    expect(old.rows.find((row) => row.symbol === "GENUSPOWER")).toMatchObject({ exDay: d("2010-10-22"), purpose: "FV SPLIT RS.10 TO RE.1" });

    const zip = fixture("PR040425.zip");
    const bc = unzipFile(zip, (name) => corporateActionsFileDay(name) !== null)!;
    expect(corporateActionsFileDay(bc.name)).toBe(d("2025-04-04"));
    const april = parseCorporateActions(bc.data.toString("utf8"));
    expect(april.rows.find((row) => row.symbol === "SIEMENS")).toMatchObject({ exDay: d("2025-04-07"), purpose: "DEMERGER" });
    expect(april.rows.find((row) => row.symbol === "AFIL")).toMatchObject({ exDay: d("2025-04-17"), purpose: "FVSPLT FRM RS 10 TO RE 1" });

    const november = parseCorporateActions(fixture("bc14112025.csv").toString("utf8"));
    expect(november.rows.every((row) => row.series === "EQ" || row.series === "BE")).toBe(true); // bonds and G-secs skipped
    expect(november.rows.find((row) => row.symbol === "ADANIENT")).toMatchObject({ exDay: d("2025-11-17"), recordDay: d("2025-11-17"), purpose: "RIGHTS 3:25@PRM RS 1799" });
    expect(corporateActionsFileDay("bc14112025.csv")).toBe(d("2025-11-14"));
    expect(corporateActionsFileDay("Bc011010.csv")).toBe(d("2010-10-01"));
    expect(corporateActionsFileDay("bm14112025.txt")).toBeNull();
  });

  it("reads what a purpose means for prices", () => {
    const cases: Array<[string, string[], number | null]> = [
      ["BONUS 1:1", ["bonus"], 0.5],
      ["BONUS 3:2", ["bonus"], 0.4],
      ["BONUS 1:5", ["bonus"], 5 / 6],
      ["FV SPLIT RS.10 TO RE.1", ["split"], 0.1],
      ["FV SPLIT RS.2/- TO RE.1/-", ["split"], 0.5],
      ["FV SPLT FRM RS 5 TO RS 2", ["split"], 0.4],
      ["FVSPLT FRM RS 10 TO RE 1", ["split"], 0.1],
      ["FACE VALUE SPLIT (SUB-DIVISION) - FROM RS 10/- PER SHARE TO RE 1/- PER SHARE", ["split"], 0.1],
      ["CONSOLIDATION OF SHARES FROM RE 1 TO RS 10", ["consolidation"], 10],
      ["BONUS 1:1/INTDIV - RS 2 PER SH", ["bonus", "dividend"], 0.5],
      ["RIGHTS 3:25@PRM RS 1799", ["rights"], null],
      ["DEMERGER", ["demerger"], null],
      ["AGM/DIV-RS2/SCH OF ARRGMT", ["arrangement", "dividend"], null],
      ["INTDIV - RS 18 PER SH", ["dividend"], null],
      ["DIV- FIN RS.3+SPL RS.7.50", ["dividend"], null],
      ["BUY BACK", ["buyback"], null],
      ["Annual General Meeting", ["other"], null],
      // A bonus and a split on one ex-date multiply; NSE's spellings of both (#58).
      ["BON1:1/FV SPLT RS10TO RE1", ["bonus", "split"], 0.05], // TITAN, 23 Jun 2011
      ["BON 1:1/SPLIT RS.10TORS.2", ["bonus", "split"], 0.1], // BAJFINANCE, 8 Sep 2016
      ["BONUS1:1/FV SPL-RS10TORS5", ["bonus", "split"], 0.25], // TECHM, 19 Mar 2015
      ["BON 1:1/SPL RS10 TO RS2", ["bonus", "split"], 0.1], // HINDZINC, 7 Mar 2011
      ["BONS1:1/FV SPLT RS5TO RE1", ["bonus", "split"], 0.1], // BLKASHYAP
      ["FV SPL-RS10TORS5/BON-2:1", ["bonus", "split"], 1 / 6], // ENGINERSIN
      ["BONUS 1:1/SPLIT RS10 TO 2", ["bonus", "split"], 0.1], // DEEPAKNTR
      ["DIV-2.50/FV SPL RS10TORS2", ["split", "dividend"], 0.2], // BHUSANSTL, 21 Sep 2010
      ["DIV-RS 2/FV-SPTLRS10TORS2", ["split", "dividend"], 0.2], // GREAVESCOT
      ["SUB DIV FRM RS 10 TO RS 2", ["split"], 0.2], // LAOPALA: a sub-division, not a dividend
      ["AGM/FV SPLT FRM 10 TO 1", ["split"], 0.1], // CCAVENUE (INFIBEAM)
      ["FVSPLTFRM 761.25TO76.125", ["split"], 0.1], // an ETF
      ["DV-FIN 7.5+SPL 7.5/BON1:1", ["bonus", "dividend"], 0.5], // RAJPALAYAM: SPL without face values is a special dividend
      ["SPL DIV RS 500 PER SHARE", ["dividend"], null],
      ["BON 1 DVR : 4 EQ SHARES", ["bonus"], null], // DVR shares aren't more of the same shares
    ];
    for (const [purpose, kinds, ratio] of cases) {
      const meaning = classifyPurpose(purpose);
      expect(meaning.kinds, purpose).toEqual(kinds);
      if (ratio === null) expect(meaning.ratio, purpose).toBeNull();
      else expect(meaning.ratio, purpose).toBeCloseTo(ratio, 10);
    }
    // Named without terms — none given, or cut off by NSE's 25-character column: `partial`, the gap decides.
    expect(classifyPurpose("AGM/DIV-RS 29.50/BONUS")).toMatchObject({ kinds: ["bonus", "dividend"], ratio: null, partial: true }); // INFY, 15 Jun 2015
    expect(classifyPurpose("FV SPLT FRM RS 10/- TO RS")).toMatchObject({ kinds: ["split"], ratio: null, partial: true, parts: [{ kind: "split", ratio: null, from: 10 }] }); // CONCOR, 26 Jun 2018
    expect(classifyPurpose("BON 1:1/SPLIT RS.10TORS.2")).toMatchObject({ partial: false, parts: [{ kind: "bonus", ratio: 0.5 }, { kind: "split", ratio: 0.2 }] });
    expect(classifyPurpose("BON 1 DVR : 4 EQ SHARES").partial).toBe(false);
    expect(rightsTerms("RIGHTS 3:25@PRM RS 1799")).toEqual({ offered: 3, held: 25, price: 1799 });
    expect(rightsTerms("RGHTS 2:7 @PRM RS 3496/-")).toEqual({ offered: 2, held: 7, price: 3496 });
    expect(rightsTerms("RIGHTS 55:91 @PRM RS 121")).toEqual({ offered: 55, held: 91, price: 121 });
    expect(rightsTerms("RIGHTS 5:9")).toEqual({ offered: 5, held: 9, price: null });
    expect(rightsTerms("BONUS 1:1")).toBeNull();
  });

  it("reads 2010–11 files' combined and FV SPL purposes as NSE printed them (#58)", () => {
    const june = parseCorporateActions(fixture("Bc220611.csv").toString("utf8")).rows;
    expect(june.find((row) => row.symbol === "TITAN")).toMatchObject({ series: "EQ", exDay: d("2011-06-23"), purpose: "BON1:1/FV SPLT RS10TO RE1" });
    expect(classifyPurpose(june.find((row) => row.symbol === "TITAN")!.purpose).ratio).toBeCloseTo(0.05, 12);
    const september = parseCorporateActions(fixture("Bc200910.csv").toString("utf8")).rows;
    expect(september.map((row) => [row.symbol, classifyPurpose(row.purpose).kinds, classifyPurpose(row.purpose).ratio])).toEqual([
      ["BHUSANSTL", ["split", "dividend"], 0.2],
      // A final and a special dividend: "SPL" here is no split.
      ["GREAVESCOT", ["dividend"], null],
    ]);
  });
});

describe("deriving factors (pure)", () => {
  const action = (purpose: string): StoredCorporateAction => ({ symbol: "X", exDay: 0, purpose, series: "EQ", company: "", recordDay: null, ...classifyPurpose(purpose), firstDay: 0, lastDay: 0 });
  const none: PairContext = { actions: [], listedNear: false, bcCovered: false, acrossRename: false };
  const pair = (prevClose: number, filePrev: number, open: number, close: number, context = none) => decideFactor({ day: d("2026-01-01"), c: prevClose }, { symbol: "X", day: d("2026-01-02"), prev_close: filePrev, o: open, c: close }, context);

  it("snaps a gap to a standard ratio only when open and close both say so", () => {
    expect(inferRatio(0.1008, 0.099)).toBe(0.1); // ANGELONE 1:10, 26 Feb 2026
    expect(inferRatio(0.7687, 0.7854)).toBe(0.75); // CUB bonus 1:3, 12 Jun 2026
    expect(inferRatio(0.27, 0.2704)).toBe(0.25); // MOTILALOFS bonus 3:1, 10 Jun 2024: traded 8% above its new base
    expect(inferRatio(0.506, 0.6)).toBe(0.5); // COCHINSHIP bonus 1:1, 10 Jan 2024: closed 19% above
    expect(inferRatio(0.1577, 0.1778)).toBe(1 / 6); // NYKAA bonus 5:1, 10 Nov 2022
    expect(inferRatio(0.85, 0.8)).toBeNull(); // a bad day
    expect(inferRatio(0.62, 0.6)).toBeNull(); // a worse one: near 2/3, but 2/3 and 3/4 must be close
    expect(inferRatio(0.5, 0.7)).toBeNull(); // opened at half, closed far from it
  });

  it("prefers NSE's own PREV_CLOSE, then the bc file, then a price gap — and only where the bc file lists nothing for the ticker", () => {
    expect(pair(13.83, 138.3, 135.65, 130.05)).toMatchObject({ factor: 10, source: "prev_close" }); // CCAVENUE 1→10, 19 Oct 2026
    // VERTOZ, 11 Jul 2025: PREV_CLOSE 9.81 against a 9.17 close, but it opened at 96.28 — a slip; the gap says ×10.
    expect(pair(9.17, 9.81, 96.28, 87.11)).toMatchObject({ factor: 10, source: "price_gap" });
    expect(pair(959.4, 959.4, 98.1, 100.35)).toMatchObject({ factor: 0.1, source: "price_gap" }); // TATASTEEL 1:10, 28 Jul 2022
    // A bc file was read and lists nothing for the ticker: NSE's files miss some (SHRIRAMFIN 1:5, 10 Jan 2025) — a halving or more is still a ratio …
    expect(pair(2809.85, 2809.85, 566, 532, { ...none, bcCovered: true })).toMatchObject({ factor: 0.2, source: "price_gap" });
    // … a quarter off isn't (2/3 and 3/4 only where no bc file was read) …
    expect(pair(745.25, 745.25, 560, 559, { ...none, bcCovered: true })).toBeNull();
    expect(pair(745.25, 745.25, 560, 559)).toMatchObject({ factor: 0.75, source: "price_gap" });
    // … and where it lists something else for the ticker near the date, a gap is just a gap.
    expect(pair(959.4, 959.4, 98.1, 100.35, { ...none, listedNear: true, bcCovered: true })).toBeNull();
    expect(pair(959.4, 959.4, 98.1, 100.35, { ...none, acrossRename: true })).toBeNull();
    expect(pair(745.25, 745.25, 597, 599.65, { ...none, actions: [action("BONUS 1:4")], listedNear: true, bcCovered: true })).toMatchObject({ factor: 0.8, source: "corporate_action", action: "BONUS 1:4" }); // CONCOR, 4 Jul 2025
    expect(pair(745.25, 745.25, 745, 740, { ...none, actions: [action("BONUS 1:4")], listedNear: true, bcCovered: true })).toBeNull(); // the price didn't move: wrong date for this ticker
    expect(pair(745.25, 745.25, 597, 599.65)).toBeNull(); // 0.8 isn't a ratio a gap is taken for
    expect(decideFactor({ day: 0, c: 1.03 }, { symbol: "SICAL-RE", day: DAY_MS, prev_close: 1.03, o: 0.52, c: 0.51 }, none)).toBeNull(); // a rights entitlement
  });

  it("takes an adjusted PREV_CLOSE only within one series, for a listed action or a standard ratio on a day the file is right (#53)", () => {
    const halved = (context: PairContext, series: [string, string] = ["EQ", "EQ"]) => decideFactor({ day: d("2026-01-01"), c: 100, series: series[0] }, { symbol: "X", day: d("2026-01-02"), series: series[1], prev_close: 50, o: 51, c: 52 }, context);
    expect(halved({ ...none, listedNear: true, bcCovered: true })).toMatchObject({ factor: 0.5, source: "prev_close" });
    // BE's PREVCLOSE is BE's last close: against an EQ close it says nothing.
    expect(halved({ ...none, listedNear: true, bcCovered: true }, ["EQ", "BE"])).toBeNull();
    // PREV_CLOSE off for many tickers that day: a glitch in the file, not NSE's word on this one.
    expect(halved({ ...none, listedNear: true, bcCovered: true, noisyDay: true })).toBeNull();
    // SRTRANSFIN, 19 Oct 2001: PREV_CLOSE 8.15 against an 8.35 close (×0.976) — no standard ratio, nothing in a bc file.
    expect(decideFactor({ day: d("2001-10-18"), c: 8.35 }, { symbol: "SRTRANSFIN", day: d("2001-10-19"), prev_close: 8.15, o: 8, c: 8.15 }, none)).toBeNull();
    // The bc file lists it: NSE's PREV_CLOSE is the factor, standard or not (CARERATING, 18 Sep 2018).
    expect(decideFactor({ day: d("2018-09-17"), c: 1301.05 }, { symbol: "CARERATING", day: d("2018-09-18"), prev_close: 1264.05, o: 1279.8, c: 1267 }, { ...none, actions: [action("AGM/DIV-RS 37 PER SHARE")], listedNear: true, bcCovered: true })).toMatchObject({ source: "prev_close" });
    expect([0.5, 0.2, 10, 0.8, 1 / 3].map((ratio) => prevCloseRatio(ratio * 1.004))).toEqual([0.5, 0.2, 10, 0.8, 1 / 3]);
    expect([0.973, 1.0245, 0.94, 0.7, 0.59].map(prevCloseRatio)).toEqual([null, null, null, null, null]);
  });

  it("takes a gap for a ratio only far outside the stock's own daily moves", () => {
    // A stock that moves 1% a day doesn't lose a quarter but for a 1:3 bonus; one that moves 7% a day (PRAJIND, Aug 2000) does.
    expect(pair(745.25, 745.25, 560, 559, { ...none, sigma: 0.01 })).toMatchObject({ factor: 0.75, source: "price_gap" });
    expect(pair(19.85, 19.85, 15.45, 15.4, { ...none, sigma: 0.07 })).toBeNull();
    // Too little history to tell: only a halving or more.
    expect(pair(745.25, 745.25, 560, 559, { ...none, sigma: null })).toBeNull();
    expect(pair(200, 200, 100, 101, { ...none, sigma: null })).toMatchObject({ factor: 0.5 });
    expect(volatility([0.01, -0.01, 0.01, -0.01])).toBeNull();
    expect(volatility([0.01, -0.01, 0.01, -0.01, 0])).toBeCloseTo(0.01, 10);
  });

  it("takes a demerger's opening gap and a rights issue's ex-rights price", () => {
    // SIEMENS, 7 Apr 2025 (Siemens Energy demerged): the broker's factor is 0.4971.
    expect(pair(4928.15, 4928.15, 2450, 2812.45, { ...none, actions: [action("DEMERGER")], listedNear: true, bcCovered: true })!.factor).toBeCloseTo(2450 / 4928.15, 10);
    // ADANIENT, 17 Nov 2025, RIGHTS 3:25 at a premium of 1799: the broker's factor is 0.9695.
    const rights = pair(2516.8, 2516.8, 2460, 2462, { ...none, actions: [action("RIGHTS 3:25@PRM RS 1799")], listedNear: true, bcCovered: true })!;
    expect(rights).toMatchObject({ source: "corporate_action" });
    expect(rights.factor).toBeCloseTo((25 * 2516.8 + 3 * 1799) / (28 * 2516.8), 10);
    expect(rights.factor).toBeCloseTo(0.9695, 3);
    expect(pair(4.93, 4.93, 4.93, 4.69, { ...none, actions: [action("RIGHTS 5:9")], listedNear: true, bcCovered: true })).toBeNull(); // PRAXIS: no price, nothing to compute
  });

  it("reads a combined, a cut-off and a ratio-less purpose against the gap (#58)", () => {
    const listed = (purpose: string): PairContext => ({ ...none, actions: [action(purpose)], listedNear: true, bcCovered: true });
    // TITAN, 23 Jun 2011: a 1:1 bonus and a ₹10 → ₹1 split, 4292.45 → 210 / 228.9.
    const titan = pair(4292.45, 4292.45, 210, 228.9, listed("BON1:1/FV SPLT RS10TO RE1"))!;
    expect(titan).toMatchObject({ source: "corporate_action", action: "BON1:1/FV SPLT RS10TO RE1" });
    expect(titan.factor).toBeCloseTo(0.05, 12);
    // INFY, 15 Jun 2015: "AGM/DIV-RS 29.50/BONUS", no ratio — the usual bonus the gap fits: 1:1.
    expect(pair(1975.05, 1975.05, 976.95, 990.45, listed("AGM/DIV-RS 29.50/BONUS"))).toMatchObject({ factor: 0.5, source: "corporate_action" });
    // CONCOR, 26 Jun 2018: NSE cut "FV SPLT FRM RS 10/- TO RS" off before the new face value: ₹10 → ₹5.
    expect(pair(1244.4, 1244.4, 613.3, 623.9, listed("FV SPLT FRM RS 10/- TO RS"))).toMatchObject({ factor: 0.5, source: "corporate_action" });
    // A ratio-less bonus on a day the price didn't move: no guess.
    expect(pair(1975.05, 1975.05, 1970, 1980, listed("AGM/DIV-RS 29.50/BONUS"))).toBeNull();
    expect(inferPartial(1, [{ kind: "bonus", ratio: null }], 0.97, 0.96)).toBeNull();
    // AXITA, 20 Sep 2024, BONUS 1:3: opened at 0.866 — as near 1 as 0.75 — and closed at 0.802: the close bears it out.
    expect(pair(21.59, 21.59, 18.7, 17.32, listed("BONUS 1:3"))).toMatchObject({ factor: 0.75, source: "corporate_action" });
  });

  it("takes a split listed a few days off only when the gap fits it closely (#58)", () => {
    // KRITIKA: the split is listed for 29 Aug 2022; it traded at the old price that day and at a fifth on the 30th.
    const off: PairContext = { ...none, actions: [action("FVSPLT FRM RS 10 TO RS 2")], listedNear: true, bcCovered: true, offDate: true };
    expect(pair(140.5, 140.5, 29.5, 29.5, off)).toMatchObject({ factor: 0.2, source: "corporate_action" });
    expect(pair(140.5, 140.5, 100, 98, off)).toBeNull();
    // A 1:10 bonus's 0.91 is a move a normal day makes: no telling which day was the bonus.
    expect(pair(100, 100, 90.9, 90.9, { ...off, actions: [action("BONUS 1:10")], sigma: 0.03 })).toBeNull();
  });

  it("picks the ratio both open and close fit, and reads old ex-dates whose first trade was off — not crashes (#58)", () => {
    // SUZLON, 21 Jan 2008, a 1:5 split: opened at 0.224 (a shade nearer 1/4), closed at 0.193.
    expect(inferRatio(424.4 / 1896.9, 366.05 / 1896.9)).toBe(0.2);
    expect(pair(1896.9, 1896.9, 424.4, 366.05)).toMatchObject({ factor: 0.2, source: "price_gap" });
    // DIVISLAB, 30 Jul 2009, a 1:1 bonus: opened at 0.563, closed at 0.495, and stayed there.
    const divis = { ...none, after: [536.05, 511.7, 499.35, 498.6, 485.95] };
    expect(pair(1108.55, 1108.55, 624, 549.15)).toBeNull(); // the open alone is too far off
    expect(pair(1108.55, 1108.55, 624, 549.15, divis)).toMatchObject({ factor: 0.5, source: "price_gap" });
    // SATYAMCOMP, 7 Jan 2009: opened at the last close and crashed to 0.225 — no split.
    expect(pair(178.95, 178.95, 179, 40.25, { ...none, after: [23.75, 34.4, 31.05, 29.85] })).toBeNull();
    // An open at half and a close at half, but a trade back above the old price that day (PASUPATFAB, 9 May 2000).
    expect(inferLooseRatio(4 / 7, 3.5 / 7, [3.5, 3.6, 3.4], 3.5, 9.9 / 7)).toBeNull();
    expect(inferLooseRatio(4 / 7, 3.5 / 7, [3.5, 3.6, 3.4], 3.5, 4 / 7)).toBe(0.5);
    // Moving on from there: a halving that doesn't hold.
    expect(inferLooseRatio(624 / 1108.55, 549.15 / 1108.55, [900, 950, 1000], 549.15)).toBeNull();
  });

  it("multiplies factors after a bar", () => {
    const factors = [{ day: d("2026-01-10"), factor: 0.5 }, { day: d("2026-02-10"), factor: 0.2 }] as Factor[];
    const at = cumulative(factors);
    expect(at(d("2026-01-09"))).toBeCloseTo(0.1, 12);
    expect(at(d("2026-01-10"))).toBeCloseTo(0.2, 12);
    expect(at(d("2026-02-10"))).toBe(1);
  });
});

describe("deriving factors from the store", () => {
  it("finds each ex-date once, never across an unchecked day", () => {
    t = makeHub();
    seed(t.db, {
      // TATASTEEL's 1:10 split: the 28 Jul 2022 file's PREVCLOSE is 959.4, the unadjusted close.
      TATASTEEL: [["2022-07-26", 950, 952, 949.5], ["2022-07-27", 949.5, 950, 959.4], ["2022-07-28", 959.4, 98.1, 100.35], ["2022-07-29", 100.35, 101, 107.6]],
      // A 50% gap across 1 Aug, a day NSE was never asked about: not a pair.
      GAPPY: [["2022-07-29", 100, 100, 100], ["2022-08-02", 100, 50, 50]],
      FLAT: [["2022-07-26", 10, 10, 10], ["2022-08-02", 10, 10, 10]],
    }, ["2022-08-01"]);
    const result = deriveFactors(t.db);
    expect(result).toMatchObject({ factors: 1, bySource: { price_gap: 1, prev_close: 0, corporate_action: 0 }, changed: ["TATASTEEL"] });
    expect(factorsOf(t.db, "TATASTEEL")).toEqual([{ date: "2022-07-28", factor: 0.1, source: "price_gap" }]);
    expect(factorsOf(t.db, "GAPPY")).toEqual([]);
    // Raw prices stay raw; the archive serves them adjusted.
    expect((t.db.prepare("select c from cash_bhav where symbol = 'TATASTEEL' and day = ?").get(d("2022-07-27")) as { c: number }).c).toBe(959.4);
    expect(archiveDaily(t.db, "TATASTEEL", d("2022-07-26"), d("2022-07-29")).bars.map((bar) => bar.c)).toEqual([94.95, 95.94, 100.35, 107.6]);
    expect(archiveDaily(t.db, "TATASTEEL", d("2022-07-26"), d("2022-07-29"), { adjusted: false }).bars.map((bar) => bar.c)).toEqual([949.5, 959.4, 100.35, 107.6]);
    // Deriving again changes nothing; a narrower range only touches its days.
    expect(deriveFactors(t.db).changed).toEqual([]);
    expect(deriveFactors(t.db, { from: d("2022-07-29") })).toMatchObject({ factors: 0, changed: [] });
    expect(factorsOf(t.db, "TATASTEEL")).toHaveLength(1);
  });

  it("uses the bc file where one was read: its ratio, its demerger — and no guess when it lists nothing", () => {
    t = makeHub();
    seed(t.db, {
      CONCOR: [["2025-07-02", 745.75, 748, 744.25], ["2025-07-03", 744.25, 748, 745.25], ["2025-07-04", 745.25, 597, 599.65]],
      SIEMENS: [["2025-04-03", 5282.85, 5201, 5248.55], ["2025-04-04", 5248.55, 5287.45, 4928.15], ["2025-04-07", 4928.15, 2450, 2812.45], ["2025-04-08", 2812.45, 2938.35, 2763.45]],
      // A quarter off on 7 Apr; the bc file read for 4 Apr lists nothing for it: a crash, not a 1:3 bonus.
      CRASHCO: [["2025-04-04", 200, 200, 200], ["2025-04-07", 200, 150, 150]],
    });
    const zip = fixture("PR040425.zip");
    storeBc(t.db, "Bc040425.csv", unzipFile(zip, (name) => corporateActionsFileDay(name) !== null)!.data.toString("utf8"));
    writeCorporateActions(t.db, d("2025-07-03"), parseCorporateActions("SERIES,SYMBOL,SECURITY,RECORD_DT,BC_STRT_DT,BC_END_DT,EX_DT,ND_STRT_DT,ND_END_DT,PURPOSE\nEQ,CONCOR,Container Corp of India,04/07/2025, , ,04/07/2025, , ,BONUS 1:4\n").rows);
    deriveFactors(t.db);
    expect(factorsOf(t.db, "CONCOR")).toEqual([{ date: "2025-07-04", factor: 0.8, source: "corporate_action" }]);
    expect(factorsOf(t.db, "SIEMENS")).toEqual([{ date: "2025-04-07", factor: Number((2450 / 4928.15).toFixed(5)), source: "corporate_action" }]);
    expect(readFactors(t.db, "SIEMENS")[0].action).toBe("DEMERGER");
    expect(factorsOf(t.db, "CRASHCO")).toEqual([]);
  });

  it("derives TITAN's bonus-and-split and BHUSANSTL's FV SPL from NSE's own files, and refreshes what was stored under the old parser (#58)", () => {
    t = makeHub();
    for (const name of ["cm20SEP2010bhav.csv", "cm21SEP2010bhav.csv", "cm22JUN2011bhav.csv", "cm23JUN2011bhav.csv"]) {
      const parsed = parseCmBhav(fixture(name).toString("utf8"));
      writeCashDay(t.db, parsed.tradeDate!, parsed.rows, 0);
    }
    storeBc(t.db, "Bc200910.csv", fixture("Bc200910.csv").toString("utf8"));
    storeBc(t.db, "Bc220611.csv", fixture("Bc220611.csv").toString("utf8"));
    deriveFactors(t.db);
    const all = t.db.prepare("select symbol, day, factor, source, action from adjustment_factors order by day").all() as Array<{ symbol: string; day: number; factor: number; source: string; action: string }>;
    expect(all.map((row) => [row.symbol, isoDay(row.day), Number(row.factor.toFixed(6)), row.source, row.action])).toEqual([
      ["BHUSANSTL", "2010-09-21", 0.2, "corporate_action", "DIV-2.50/FV SPL RS10TORS2"],
      ["TITAN", "2011-06-23", 0.05, "corporate_action", "BON1:1/FV SPLT RS10TO RE1"],
    ]);
    // 22 Jun's 4292.45 in 23 Jun's shares: 20 for one.
    expect(archiveDaily(t.db, "TITAN", d("2011-06-22"), d("2011-06-23")).bars.map((bar) => bar.c)).toEqual([214.62, 228.9]);

    // A row stored by the old parser (a split only, 0.1): rewritten as today's parser reads it.
    t.db.prepare("update corporate_actions set kinds = 'split', ratio = 0.1 where symbol = 'TITAN'").run();
    expect(refreshCorporateActions(t.db)).toBe(1);
    expect(t.db.prepare("select kinds, ratio from corporate_actions where symbol = 'TITAN'").get()).toEqual({ kinds: "bonus,split", ratio: 0.05 });
    expect(refreshCorporateActions(t.db)).toBe(0);
  });

  it("takes an action listed for a day the ticker didn't trade, or a few days off, once (#58)", () => {
    t = makeHub();
    const bc = (lines: string[]) => parseCorporateActions(`SERIES,SYMBOL,SECURITY,RECORD_DT,BC_STRT_DT,BC_END_DT,EX_DT,ND_STRT_DT,ND_END_DT,PURPOSE\n${lines.join("\n")}\n`).rows;
    // ABMINTLTD: BONUS 5:1, ex 15 Mar 2017 — no trade that day; at a sixth on the 16th.
    seed(t.db, { ABMINTLTD: [["2017-03-10", 193.8, 203.45, 203.45], ["2017-03-14", 203.45, 213.35, 213.6], ["2017-03-16", 213.6, 37.35, 37.35], ["2017-03-17", 37.35, 39.2, 39.2]] });
    writeCorporateActions(t.db, d("2017-03-14"), bc(["BE,ABMINTLTD,ABM International Ltd,16/03/2017, , ,15/03/2017, , ,BONUS 5:1"]));
    deriveFactors(t.db);
    expect(factorsOf(t.db, "ABMINTLTD")).toEqual([{ date: "2017-03-16", factor: Number((1 / 6).toFixed(5)), source: "corporate_action" }]);

    t.cleanup();
    t = makeHub();
    // KRITIKA: the split is listed for 29 Aug 2022, which traded at the old price; the 30th at a fifth.
    seed(t.db, {
      KRITIKA: [["2022-08-24", 116.3, 122.1, 121.45], ["2022-08-25", 121.45, 127.5, 127.5], ["2022-08-26", 127.5, 133.85, 133.85], ["2022-08-29", 133.85, 140.5, 140.5], ["2022-08-30", 140.5, 29.5, 29.5], ["2022-09-01", 29.5, 30.95, 30.95], ["2022-09-02", 30.95, 32.4, 32.4]],
    });
    writeCorporateActions(t.db, d("2022-08-26"), bc(["EQ,KRITIKA,Kritika Wires Ltd,29/08/2022, , ,29/08/2022, , ,FVSPLT FRM RS 10 TO RS 2"]));
    deriveFactors(t.db);
    expect(factorsOf(t.db, "KRITIKA")).toEqual([{ date: "2022-08-30", factor: 0.2, source: "corporate_action" }]);
    expect(readFactors(t.db, "KRITIKA")[0].action).toBe("FVSPLT FRM RS 10 TO RS 2");
  });

  it("reads no action into the 1997 and 2001 files' PREV_CLOSE: another series' close, or a whole file off (#53)", () => {
    t = makeHub();
    // One more ticker each with NSE's PREV_CLOSE at exactly half and the open bearing it out.
    const half = (symbol: string, prevClose: number, close: number): CashBhavRow => ({ symbol, series: "EQ", prevClose, open: close, high: close, low: close, close, volume: 100, deliveryPct: null });
    const extra: Record<string, CashBhavRow[]> = {
      "cm28FEB1997bhav.csv": [half("HALFA", 100, 100)],
      "cm01MAR1997bhav.csv": [half("HALFA", 50, 51)],
      "cm11OCT2001bhav.csv": [half("HALFB", 100, 100)],
      "cm12OCT2001bhav.csv": [half("HALFB", 50, 51)],
    };
    for (const [name, rows] of Object.entries(extra)) {
      const parsed = parseCmBhav(fixture(name).toString("utf8"));
      writeCashDay(t.db, parsed.tradeDate!, [...parsed.rows, ...rows], 0);
    }
    // 11 Oct 2001: SRTRANSFIN traded in both series (EQ 7.4 is stored, BE closed 7.2); 12 Oct only in BE, PREVCLOSE 7.2 — BE's close.
    expect(t.db.prepare("select series, prev_close, c from cash_bhav where symbol = 'SRTRANSFIN' order by day").all()).toEqual([{ series: "EQ", prev_close: 7.1, c: 7.4 }, { series: "BE", prev_close: 7.2, c: 7.35 }]);
    // 1 Mar 1997: every ticker's PREVCLOSE is off (RELIANCE 272.2 against a 293.75 close; 814 tickers in the whole file).
    expect(t.db.prepare("select prev_close from cash_bhav where symbol = 'RELIANCE' and day = ?").pluck().get(d("1997-03-01"))).toBe(272.2);
    deriveFactors(t.db);
    const all = t.db.prepare("select symbol, day, factor, source from adjustment_factors order by day").all() as Array<{ symbol: string; day: number; factor: number; source: string }>;
    expect(all.map((row) => [row.symbol, isoDay(row.day), row.factor, row.source])).toEqual([
      // On the day the file is off the halving is still a gap (no bc file then), not NSE's word …
      ["HALFA", "1997-03-01", 0.5, "price_gap"],
      // … on a day it's right, PREV_CLOSE at a standard ratio is.
      ["HALFB", "2001-10-12", 0.5, "prev_close"],
    ]);
  });

  it("infers SHRIRAMFIN's 1:5 split, 10 Jan 2025, though that day's bc file was read: it doesn't list it (#54)", () => {
    t = makeHub();
    seed(t.db, {
      SHRIRAMFIN: [
        ["2024-12-09", 3126.35, 3100.6, 3106.9], ["2024-12-10", 3106.9, 3125.45, 3186.5], ["2024-12-11", 3186.5, 3195.5, 3248.25], ["2024-12-12", 3248.25, 3239.5, 3248.1],
        ["2024-12-13", 3248.1, 3242.05, 3162.55], ["2024-12-16", 3162.55, 3174.0, 3137.45], ["2024-12-17", 3137.45, 3135.0, 2976.9], ["2024-12-18", 2976.9, 2976.9, 2931.4],
        ["2024-12-19", 2931.4, 2870.0, 2945.45], ["2024-12-20", 2945.45, 2953.25, 2877.25], ["2024-12-23", 2877.25, 2906.0, 2882.9], ["2024-12-24", 2882.9, 2883.0, 2882.95],
        ["2024-12-26", 2882.95, 2892.3, 2926.9], ["2024-12-27", 2926.9, 2936.9, 2898.9], ["2024-12-30", 2898.9, 2912.8, 2919.0], ["2024-12-31", 2919.0, 2897.9, 2889.15],
        ["2025-01-01", 2889.15, 2899.0, 2918.65], ["2025-01-02", 2918.65, 2937.3, 3060.05], ["2025-01-03", 3060.05, 3060.0, 3048.35], ["2025-01-06", 3048.35, 3031.0, 2969.55],
        ["2025-01-07", 2969.55, 2977.05, 2958.4], ["2025-01-08", 2958.4, 2970.0, 2898.75], ["2025-01-09", 2898.75, 2903.75, 2809.85],
        // PREV_CLOSE is the unadjusted close; the stock opens at a fifth.
        ["2025-01-10", 2809.85, 566.0, 532.0], ["2025-01-13", 532.0, 530.05, 521.1],
      ],
    });
    storeBc(t.db, "Bc100125.csv", fixture("Bc100125.csv").toString("utf8"));
    // The file was read — it lists JAIBALAJI's and NAVA's splits — but nothing for SHRIRAMFIN.
    const listed = readCorporateActions(t.db, d("2025-01-01"), d("2025-01-31")).map((action) => action.symbol);
    expect(listed).toEqual(expect.arrayContaining(["JAIBALAJI", "NAVA"]));
    expect(listed).not.toContain("SHRIRAMFIN");
    deriveFactors(t.db);
    expect(factorsOf(t.db, "SHRIRAMFIN")).toEqual([{ date: "2025-01-10", factor: 0.2, source: "price_gap" }]);
    expect(archiveDaily(t.db, "SHRIRAMFIN", d("2025-01-09"), d("2025-01-10")).bars.map((bar) => bar.c)).toEqual([561.97, 532]);
  });

  it("doesn't read an illiquid stock's bad day as a bonus (PRAJIND, 18 Aug 2000) (#53)", () => {
    t = makeHub();
    seed(t.db, {
      // NSE's rows: a stock moving 5–15% a day loses a quarter in one trade and is back up 13% the next session.
      PRAJIND: [
        ["2000-07-17", 22.0, 22.0, 22.0], ["2000-07-18", 22.0, 21.1, 21.0], ["2000-07-19", 21.0, 21.0, 21.0], ["2000-07-20", 21.0, 20.0, 20.0], ["2000-07-21", 20.0, 20.0, 20.8],
        ["2000-07-24", 20.8, 22.0, 20.0], ["2000-07-25", 20.0, 21.5, 21.5], ["2000-07-26", 21.5, 21.5, 20.05], ["2000-07-27", 20.05, 20.1, 18.65], ["2000-07-28", 18.65, 20.2, 20.25],
        ["2000-07-31", 20.25, 21.0, 21.0], ["2000-08-01", 21.0, 20.0, 19.55], ["2000-08-08", 19.55, 16.85, 16.85], ["2000-08-10", 16.85, 19.75, 20.25], ["2000-08-11", 20.25, 20.0, 20.0],
        ["2000-08-14", 20.0, 18.4, 19.85], ["2000-08-18", 19.85, 15.45, 15.4], ["2000-08-21", 15.4, 17.45, 17.45], ["2000-08-22", 17.45, 16.75, 15.85],
      ],
    });
    deriveFactors(t.db);
    expect(factorsOf(t.db, "PRAJIND")).toEqual([]);
  });

  it("follows a company across a rename; the rename itself is no action, and a reused ticker isn't one company", () => {
    t = makeHub();
    writeSymbolChanges(t.db, [{ oldSymbol: "OLDCO", newSymbol: "NEWCO", day: d("2025-03-03"), company: "Co Ltd" }]);
    seed(t.db, {
      // A 1:1 bonus under the old name, then the rename (NSE carries the close across), then a 1:10 split under the new.
      OLDCO: [["2025-02-26", 200, 200, 200], ["2025-02-27", 200, 100, 100], ["2025-02-28", 100, 100, 100],
        // Another company lists under the old ticker much later: its first close isn't comparable with OLDCO's.
        ["2025-06-02", 0, 40, 40]],
      NEWCO: [["2025-03-03", 100, 101, 101], ["2025-03-04", 101, 10.1, 10.2]],
    });
    deriveFactors(t.db);
    expect(factorsOf(t.db, "OLDCO")).toEqual([{ date: "2025-02-27", factor: 0.5, source: "price_gap" }]);
    expect(factorsOf(t.db, "NEWCO")).toEqual([{ date: "2025-03-04", factor: 0.1, source: "price_gap" }]);
    // Asked as NEWCO, or as OLDCO before the rename: one company, both factors.
    for (const [symbol, day] of [["NEWCO", d("2025-03-04")], ["OLDCO", d("2025-02-27")]] as const) {
      const { listing, factors } = listingFactors(t.db, symbol, day);
      expect(listing.names.map((name) => name.symbol)).toEqual(["OLDCO", "NEWCO"]);
      expect(factors.map((f) => [f.symbol, isoDay(f.day)])).toEqual([["OLDCO", "2025-02-27"], ["NEWCO", "2025-03-04"]]);
    }
    // NEWCO's history in OLDCO's days, adjusted to today's shares: 200 → 200 × 0.5 × 0.1.
    expect(cumulative(listingFactors(t.db, "NEWCO", d("2025-03-04")).factors)(d("2025-02-26")) * 200).toBeCloseTo(10, 10);

    // An adjusted PREV_CLOSE on the first day under the new name is a factor, kept under the new ticker.
    t.cleanup();
    t = makeHub();
    writeSymbolChanges(t.db, [{ oldSymbol: "OLDCO", newSymbol: "NEWCO", day: d("2025-03-03"), company: "Co Ltd" }]);
    seed(t.db, { OLDCO: [["2025-02-28", 100, 100, 100]], NEWCO: [["2025-03-03", 50, 51, 51]] });
    deriveFactors(t.db);
    expect(readFactors(t.db, "NEWCO")).toMatchObject([{ day: d("2025-03-03"), factor: 0.5, source: "prev_close", renamedFrom: "OLDCO" }]);
  });

  it("re-derives on start once, drops end-of-day series built on old factors, and resets a broker series on the evening's ex-date", () => {
    t = makeHub();
    seed(t.db, { SBIN: [["2026-11-02", 500, 500, 500], ["2026-11-03", 500, 501, 502]] });
    expect(ensureFactors(t.db, { endOfDay: true, now: 1 })).toMatchObject({ factors: 0 });
    expect(ensureFactors(t.db, { endOfDay: true, now: 2 })).toBeNull();
    expect(lastAdjustmentRun(t.db)).toMatchObject({ version: ADJUSTMENT_VERSION, derivedAt: 1, factors: 0 });

    // A stored series (from the archive, end-of-day mode) through 3 Nov; 4 Nov is a 1:2 split.
    writeBars(t.db, "SBIN", "1d", [{ t: d("2026-11-03"), o: 501, h: 502, l: 501, c: 502, v: 1 }], { from: d("2026-11-03"), to: d("2026-11-04") }, 0);
    const split: CashBhavRow = { symbol: "SBIN", series: "EQ", prevClose: 502, open: 252, high: 255, low: 250, close: 253, volume: 2, deliveryPct: null };
    writeCashDay(t.db, d("2026-11-04"), [split], 0);
    expect(deriveFactors(t.db, { from: d("2026-11-04") }).changed).toEqual(["SBIN"]);
    expect(applyCashBhav(t.db, d("2026-11-04"), [split], quiet).reset).toEqual(["SBIN"]); // PREV_CLOSE alone (502 = 502) wouldn't have told
    expect(readSeries(t.db, "SBIN", "1d")).toBeNull();

    writeBars(t.db, "SBIN", "1d", [{ t: d("2026-11-03"), o: 1, h: 1, l: 1, c: 1, v: 1 }], { from: d("2026-11-03"), to: d("2026-11-04") }, 0);
    t.db.prepare("delete from adjustment_factors").run();
    expect(rederiveAll(t.db, { endOfDay: false, now: 3 })).toMatchObject({ changed: ["SBIN"], reset: [] }); // a broker's series doesn't depend on our factors
    t.db.prepare("delete from adjustment_factors").run();
    expect(rederiveAll(t.db, { endOfDay: true, now: 4 })).toMatchObject({ changed: ["SBIN"], reset: ["SBIN"] });
    expect(readSeries(t.db, "SBIN", "1d")).toBeNull();
  });
});

describe("checking factors against the broker", () => {
  const joined = (closes: Array<[string, number, number]>) => closes.map(([iso, broker, raw]) => ({ day: d(iso), broker, raw }));
  const factor = (iso: string, value: number, source: Factor["source"] = "price_gap") => ({ symbol: "X", day: d(iso), factor: value, source, prevDay: 0, prevC: 0, prevClose: 0, o: 0, c: 0, action: null, renamedFrom: null }) as Factor;
  const context = (actions: Array<{ purpose: string; kinds: string[] }> = [], syncedAt = Number.MAX_SAFE_INTEGER) => ({ syncedAt, actionsNear: () => actions });

  it("agrees on a split the broker adjusted too, level by level", () => {
    const series = joined([["2026-01-12", 426.52, 2132.6], ["2026-01-13", 426.52, 2132.6], ["2026-01-14", 421, 421], ["2026-01-15", 425, 425]]);
    const result = compareSeries("KOTAKBANK", series, [factor("2026-01-14", 0.2)], 0.005, context());
    expect(result.check).toMatchObject({ overlap: 4, events: 1, agreed: 1, matchingBars: 4 });
    expect(result.disagreements).toEqual([]);
  });

  it("says why when they disagree", () => {
    // The broker took 3% off for a dividend; split factors don't.
    const dividend = compareSeries("X", joined([["2026-01-01", 97, 100], ["2026-01-02", 98, 98]]), [], 0.005, context([{ purpose: "INTDIV - RS 3 PER SH", kinds: ["dividend"] }]));
    expect(dividend.disagreements).toMatchObject([{ reason: "dividend", broker: 0.97, derived: 1 }]);
    // One bad bar on one side, back the next session.
    const blip = compareSeries("X", joined([["2026-01-01", 100, 100], ["2026-01-02", 110, 101], ["2026-01-05", 102, 102]]), [], 0.005, context());
    expect(blip.disagreements).toMatchObject([{ reason: "data_error", date: "2026-01-02" }]);
    // A series downloaded before the ex-date and extended from the bhavcopy since: never adjusted.
    const stale = compareSeries("X", joined([["2026-01-01", 1000, 1000], ["2026-01-02", 100, 100]]), [factor("2026-01-02", 0.1)], 0.005, context([], d("2025-12-31")));
    expect(stale.disagreements).toMatchObject([{ reason: "broker_stale", broker: 1, derived: 0.1 }]);
    expect(compareSeries("X", joined([["2026-01-01", 97, 100], ["2026-01-02", 98, 98]]), [], 0.005, context([{ purpose: "RIGHTS 5:9", kinds: ["rights"] }])).disagreements[0].reason).toBe("rights");
    expect(compareSeries("X", joined([["2026-01-01", 97, 100], ["2026-01-02", 98, 98]]), [], 0.005, context()).disagreements[0]).toMatchObject({ reason: "unexplained", note: expect.stringMatching(/no corporate-actions file/) });
  });

  it("runs over every stored daily series, across a rename", () => {
    t = makeHub();
    writeSymbolChanges(t.db, [{ oldSymbol: "OLDCO", newSymbol: "NEWCO", day: d("2025-03-03"), company: "Co Ltd" }]);
    seed(t.db, { OLDCO: [["2025-02-26", 200, 200, 200], ["2025-02-27", 200, 100, 100], ["2025-02-28", 100, 100, 100]], NEWCO: [["2025-03-03", 100, 101, 101], ["2025-03-04", 101, 102, 102]] });
    deriveFactors(t.db);
    // The broker's adjusted series, under today's ticker.
    writeBars(t.db, "NEWCO", "1d", [100, 100, 100, 101, 102].map((c, i) => ({ t: [d("2025-02-26"), d("2025-02-27"), d("2025-02-28"), d("2025-03-03"), d("2025-03-04")][i], o: c, h: c, l: c, c, v: 1 })), { from: d("2025-02-26"), to: d("2025-03-05") }, Date.now());
    writeBars(t.db, "NIFTY", "1d", [{ t: d("2025-02-26"), o: 1, h: 1, l: 1, c: 1, v: 1 }], null, 0); // indices aren't checked
    const report = checkAdjustments(t.db);
    expect(report).toMatchObject({ symbols: 1, overlapping: 1, overlapBars: 5, matchingBars: 5, events: 1, agreed: 1, disagreements: [], derived: { price_gap: 1 } });
  });
});

describe("the API", () => {
  async function api() {
    t = makeHub({ clock: () => ist(2025, 3, 10, 12) });
    writeSymbolChanges(t.db, [{ oldSymbol: "OLDCO", newSymbol: "NEWCO", day: d("2025-03-03"), company: "Co Ltd" }]);
    seed(t.db, { OLDCO: [["2025-02-26", 200, 200, 200], ["2025-02-27", 200, 100, 100], ["2025-02-28", 100, 100, 100]], NEWCO: [["2025-03-03", 100, 101, 101], ["2025-03-04", 101, 10.1, 10.2], ["2025-03-05", 10.2, 10.3, 10.4]] });
    deriveFactors(t.db);
    const { key } = createKey(t.db, "test", ["history"]);
    const app = t.app();
    return async (path: string) => {
      const res = await app.request(path, { headers: { authorization: `Bearer ${key}` } });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { status: res.status, body: (await res.json()) as any };
    };
  }

  it("serves a listing's factors with what each bar before it is multiplied by", async () => {
    const get = await api();
    const answer = await get("/v1/adjustments?symbol=NEWCO");
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ symbol: "NEWCO", current: "NEWCO", names: [{ symbol: "OLDCO", from: null, until: "2025-03-02" }, { symbol: "NEWCO", from: "2025-03-03", until: null }] });
    expect(answer.body.factors.map((f: { date: string; symbol: string; factor: number; source: string }) => [f.date, f.symbol, f.factor, f.source])).toEqual([
      ["2025-02-27", "OLDCO", 0.5, "price_gap"],
      ["2025-03-04", "NEWCO", 0.1, "price_gap"],
    ]);
    expect(answer.body.factors[0].cumulative).toBeCloseTo(0.05, 12);
    expect((await get("/v1/adjustments?symbol=NEWCO&from=2025-03-01")).body.factors).toHaveLength(1);
    expect((await get("/v1/adjustments")).status).toBe(400);
  });

  it("serves raw and adjusted daily candles", async () => {
    const get = await api();
    // This hub has no broker: adjusted daily bars come from the archive and the factors.
    const adjusted = await get("/v1/candles?symbol=NEWCO&tf=1d&from=2025-03-03&to=2025-03-05");
    expect(adjusted.body).toMatchObject({ adjust: "split" });
    expect(adjusted.body.candles.map((bar: { c: number }) => bar.c)).toEqual([10.1, 10.2, 10.4]);
    const raw = await get("/v1/candles?symbol=NEWCO&tf=1d&from=2025-03-03&to=2025-03-05&adjust=none");
    expect(raw.status).toBe(200);
    expect(raw.body).toMatchObject({ adjust: "none", complete: true });
    expect(raw.body.candles.map((bar: { c: number; dp: number | null }) => [bar.c, bar.dp])).toEqual([[101, null], [10.2, null], [10.4, null]]);
    const weekly = await get("/v1/candles?symbol=NEWCO&tf=1w&from=2025-03-03&to=2025-03-05&adjust=none");
    expect(weekly.body.candles).toMatchObject([{ t: d("2025-03-03"), o: 101, c: 10.4 }]);
    const batch = await get("/v1/candles/batch?symbols=NEWCO,NOSUCH&from=2025-03-03&to=2025-03-05&adjust=none");
    expect(batch.body).toMatchObject({ adjust: "none", unknown: ["NOSUCH"], queued: [] });
    expect(batch.body.series.NEWCO.candles.map((bar: { c: number }) => bar.c)).toEqual([101, 10.2, 10.4]);
    expect((await get("/v1/candles?symbol=NEWCO&tf=1d&adjust=total")).status).toBe(400);
    expect((await get("/v1/candles?symbol=NEWCO&tf=15m&adjust=none")).status).toBe(400);
    expect((await get("/v1/candles?symbol=NOSUCH&tf=1d&adjust=none")).status).toBe(404);
  });

  it("serves the corporate actions once a bc file is stored, across renames", async () => {
    const get = await api();
    expect((await get("/v1/corporate-actions?symbol=NEWCO")).body.code).toBe("not_ready");
    storeBc(t.db, "bc26022025.csv", "SERIES,SYMBOL,SECURITY,RECORD_DT,BC_STRT_DT,BC_END_DT,EX_DT,ND_STRT_DT,ND_END_DT,PURPOSE\nEQ,OLDCO,Co Ltd,2025-02-27,,,2025-02-27,,,BONUS 1:1\nEQ,OTHER,Other Ltd,2025-02-27,,,2025-02-27,,,INTDIV - RS 2 PER SH\n");
    const answer = await get("/v1/corporate-actions?symbol=NEWCO");
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ symbol: "NEWCO", asOf: "2025-02-26", actions: [{ symbol: "OLDCO", exDate: "2025-02-27", purpose: "BONUS 1:1", kinds: ["bonus"], ratio: 0.5 }] });
    expect((await get("/v1/corporate-actions?from=2025-02-01&to=2025-03-01")).body.actions.map((a: { symbol: string }) => a.symbol)).toEqual(["OLDCO", "OTHER"]);
    expect((await get("/v1/corporate-actions?from=2020-01-01&to=2025-03-01")).status).toBe(400); // over 400 days without a symbol
  });
});

describe("corporate actions from the PR zip", () => {
  const archive = "https://nse.test";
  const context = (routes: Record<string, Route | Route[]>, now: number) => {
    t = makeHub();
    const time = fakeTime(now);
    const calls: Array<{ url: string; at: number; headers: Record<string, string> }> = [];
    const ctx: NseContext = { db: t.db, log: quiet, clock: time.clock, urls: { archiveUrl: archive }, nse: new NseClient({ log: quiet, clock: time.clock, sleep: time.sleep, fetch: fakeFetch(routes, calls, time.clock) }) };
    return { ctx, calls };
  };

  it("stores them with the results calendar, and reads them once for PR days stored before", async () => {
    const zip = fixture("PR040425.zip");
    const { ctx, calls } = context({ [prUrl(archive, d("2025-04-04"))]: new Response(zip) }, ist(2026, 11, 19, 20));
    expect(await importDay(ctx, "pr", d("2025-04-04"))).toBe("ok");
    expect(readCorporateActions(ctx.db, d("2025-04-07"), d("2025-04-07"), ["SIEMENS"])).toMatchObject([{ purpose: "DEMERGER", kinds: ["demerger"], ratio: null, firstDay: d("2025-04-04") }]);
    expect(corporateActionDaysRead(ctx.db).has(d("2025-04-04"))).toBe(true);

    // A PR day stored before the hub read bc files: the history job reads it again, just for them.
    ctx.db.prepare("delete from corporate_actions").run();
    ctx.db.prepare("delete from corporate_action_days").run();
    expect(corporateActionDays(ctx.db, d("2025-01-01"), d("2025-12-31"))).toEqual([d("2025-04-04")]);
    for (let day = d("2025-04-01"); day <= d("2025-04-07"); day += DAY_MS) if (day !== d("2025-04-04")) markDay(ctx.db, "pr", day, "holiday", 0, 0);
    const job = enqueueJob(ctx.db, "nse_history", { from: "2025-04-01", to: "2025-04-07", datasets: ["pr"] });
    const final = await runNseHistory(ctx, job.id);
    expect(final).toMatchObject({ state: "done", message: expect.stringMatching(/corporate actions read for 1 stored day/) });
    expect(calls.filter((call) => call.url === prUrl(archive, d("2025-04-04")))).toHaveLength(2);
    expect(readCorporateActions(ctx.db, d("2025-04-07"), d("2025-04-07"), ["SIEMENS"])).toHaveLength(1);
    expect(corporateActionDays(ctx.db, d("2025-01-01"), d("2025-12-31"))).toEqual([]);
    expect(lastAdjustmentRun(ctx.db)).not.toBeNull(); // the run derived the factors again
  });
});
