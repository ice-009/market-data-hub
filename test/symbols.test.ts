import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createKey, type Scope } from "../src/auth/keys.js";
import { enqueueJob } from "../src/jobs/backfill.js";
import { isinDays, runNseHistory } from "../src/jobs/nseHistory.js";
import { createLogger } from "../src/log.js";
import { NseClient } from "../src/nse/client.js";
import { MIN_SYMBOL_CHANGES, cashBhavUrl, importDay, mtoUrl, refreshSymbolChanges, type NseContext } from "../src/nse/datasets.js";
import { parseCmBhav } from "../src/nse/parsers/cmBhav.js";
import { parseSymbolChanges, splitCsvLine, type SymbolChangeRow } from "../src/nse/parsers/symbolChange.js";
import { isinDaysRead, markDay, readRuns, readSymbolChanges, sharedIsins, writeCashDay, writeIsins, writeSymbolChanges } from "../src/nse/store.js";
import { Renames, collapseSameDay, isinChanges, listingOf, loadRenames, mergeChanges, nameOn, namesBetween, type SymbolChange } from "../src/reference/renames.js";
import { isoDay, istDayKey, parseIsoDay } from "../src/time.js";
import { ist, makeHub, type TestHub } from "./support/hub.js";
import { fakeFetch, fakeTime, makeZip, type Route } from "./support/nse.js";

// Ticker renames (ice-009/market-data-hub#21). Fixtures are real NSE rows,
// trimmed: symbolchange.csv (16 of its 1,080 rows, Nov 2026) and the old-format
// cash bhavcopies of 28 and 29 Jun 2011 (INFOSYSTCH's last session and INFY's
// first, same ISIN), unzipped.

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const d = (iso: string) => parseIsoDay(iso)!;
const quiet = createLogger({ level: "error", secrets: [], write: () => {} });
const TODAY = d("2026-11-18");
const nse = (rows: SymbolChangeRow[]): SymbolChange[] => rows.map((row) => ({ ...row, source: "nse", isin: null }));
const change = (oldSymbol: string, newSymbol: string, day: string): SymbolChange => ({ oldSymbol, newSymbol, day: d(day), company: "", source: "nse", isin: null });
const spans = (renames: Renames, symbol: string, day: string, traded?: (symbol: string, from: number | null, until: number | null) => boolean) => {
  const listing = renames.listing(symbol, d(day), traded);
  return { ...listing, names: listing.names.map((name) => `${name.symbol} ${name.from === null ? "…" : isoDay(name.from)}→${name.until === null ? "…" : isoDay(name.until)}`) };
};

describe("NSE's symbolchange.csv (pure)", () => {
  it("reads every rename by header name, skipping rows that name one ticker twice", () => {
    const parsed = parseSymbolChanges(fixture("symbolchange.csv"));
    expect(parsed).toMatchObject({ badRows: 0, skipped: 1 }); // Interise Trust, INTERISE → INTERISE
    expect(parsed.rows).toHaveLength(15);
    expect(parsed.rows[0]).toEqual({ oldSymbol: "HCL-HP", newSymbol: "HCL-INSYS", day: d("2000-04-12"), company: "HCL Infosystems Limited" });
    expect(parsed.rows.find((row) => row.oldSymbol === "INFOSYSTCH")).toEqual({ oldSymbol: "INFOSYSTCH", newSymbol: "INFY", day: d("2011-06-29"), company: "Infosys Limited" });
    expect(parsed.rows.find((row) => row.oldSymbol === "RDAXEDG")?.company).toBe("NIPPON INDIA MF - NIPPON INDIA Dual Advantage FTF Sr. x Plan E - GO");
    expect(parsed.rows.find((row) => row.oldSymbol === "780LTFL30")?.company).toBe("");
    expect(parsed.rows.map((row) => row.day)).toEqual([...parsed.rows.map((row) => row.day)].sort((a, b) => a - b));
  });

  it("copes with quoted names, bad rows and a file that isn't the list", () => {
    expect(splitCsvLine('"Foo, ""Bar"" Ltd",A,B,01-JAN-2020')).toEqual(['Foo, "Bar" Ltd', "A", "B", "01-JAN-2020"]);
    const parsed = parseSymbolChanges('NAME OF THE COMPANY,OLD SYMBOL,NEW SYMBOL,EFFECTIVE DATE\r\n"Foo, Ltd",foo,BAR,01-JAN-2020\r\nX,BAD TICKER,Y,01-JAN-2020\r\nX,A,B,31-FEB-2020\r\nFoo,FOO,BAZ,01-JAN-2020\r\n');
    expect(parsed).toEqual({ rows: [{ oldSymbol: "FOO", newSymbol: "BAR", day: d("2020-01-01"), company: "Foo, Ltd" }], badRows: 2, skipped: 1 });
    expect(parseSymbolChanges("<html>blocked</html>")).toEqual({ rows: [], badRows: 0, skipped: 0 });
  });

  it("reads ISINs from the old cash bhavcopy where it has the column (2011 on), for EQ/BE rows only", () => {
    const parsed = parseCmBhav(fixture("cm28JUN2011bhav.csv"));
    expect(parsed.rows.map((row) => `${row.symbol} ${row.isin}`)).toEqual(["20MICRONS INE144J01019", "INFOSYSTCH INE009A01021", "SBIN INE062A01012", "TATAMOTORS INE155A01014"]);
    expect(parseCmBhav(fixture("cm29JUN2011bhav.csv")).rows.find((row) => row.symbol === "INFY")?.isin).toBe("INE009A01021");
    // Jan 2010's header has no ISIN column (cm04JAN2010).
    const old = parseCmBhav("SYMBOL,SERIES,OPEN,HIGH,LOW,CLOSE,LAST,PREVCLOSE,TOTTRDQTY,TOTTRDVAL,TIMESTAMP,\n20MICRONS,EQ,46,47.9,45.7,47.55,47.5,46.05,36282,1719201.35,4-JAN-2010,\n");
    expect(old.rows).toHaveLength(1);
    expect(old.rows[0]).not.toHaveProperty("isin");
  });
});

describe("renames, point in time (pure)", () => {
  const renames = new Renames(nse(parseSymbolChanges(fixture("symbolchange.csv")).rows));

  it("joins a listing's names, whichever name and date it's asked by", () => {
    const infy = spans(renames, "INFY", "2026-11-18");
    expect(infy).toMatchObject({ names: ["INFOSYSTCH …→2011-06-29", "INFY 2011-06-29→…"], current: "INFY", match: "exact" });
    expect(spans(renames, "INFOSYSTCH", "2005-01-03")).toEqual(infy);
    expect(nameOn(renames.listing("INFY", TODAY), d("2005-01-03"))).toBe("INFOSYSTCH");
    expect(nameOn(renames.listing("INFY", TODAY), d("2011-06-29"))).toBe("INFY");

    const tmpv = renames.listing("TMPV", TODAY);
    expect(tmpv.names.map((name) => name.symbol)).toEqual(["TELCO", "TATAMOTORS", "TMPV"]);
    expect(tmpv.changes.map((c) => `${c.oldSymbol}→${c.newSymbol} ${isoDay(c.day)}`)).toEqual(["TELCO→TATAMOTORS 2003-12-26", "TATAMOTORS→TMPV 2025-10-24"]);
    expect(renames.listing("TATAMOTORS", d("2011-06-28")).current).toBe("TMPV");
    expect(renames.listing("TELCO", d("1999-01-01")).current).toBe("TMPV");
    expect(renames.listing("LTM", TODAY).names.map((name) => name.symbol)).toEqual(["LTI", "LTIM", "LTM"]);
    expect(renames.listing("ANDHRAPAP", TODAY).names.map((name) => name.symbol)).toEqual(["APPAPER", "IPAPPM", "ANDPAPER", "ANDHRAPAP"]);
    // A ticker never renamed is its own listing.
    expect(spans(renames, "SBIN", "2005-01-03")).toMatchObject({ names: ["SBIN …→…"], current: "SBIN", match: "exact", changes: [] });
  });

  it("lists the names to read for a date range, each clipped to it (what #22 serves from)", () => {
    const between = namesBetween(renames.listing("TMPV", TODAY), d("2003-01-01"), d("2026-01-02"));
    expect(between.map((name) => `${name.symbol} ${isoDay(name.from)}..${isoDay(name.to)}`)).toEqual(["TELCO 2003-01-01..2003-12-25", "TATAMOTORS 2003-12-26..2025-10-23", "TMPV 2025-10-24..2026-01-02"]);
    expect(namesBetween(renames.listing("TMPV", TODAY), d("2012-01-01"), d("2012-12-31")).map((name) => name.symbol)).toEqual(["TATAMOTORS"]);
  });

  it("finds the listing for a ticker asked on a day nobody had it, by what is stored", () => {
    const never = () => false;
    // INFY on a 2005 date: Infosys was INFOSYSTCH then; INFY is the listing that took the name later.
    expect(spans(renames, "INFY", "2005-01-03", never)).toMatchObject({ current: "INFY", match: "later", names: ["INFOSYSTCH …→2011-06-29", "INFY 2011-06-29→…"] });
    // INFOSYSTCH today: renamed away and not traded since → the listing that last had it.
    expect(spans(renames, "INFOSYSTCH", "2026-11-18", never)).toMatchObject({ current: "INFY", match: "earlier" });
    // …but if something trades as INFOSYSTCH again, that's a new company with the old ticker.
    expect(spans(renames, "INFOSYSTCH", "2026-11-18", () => true)).toMatchObject({ current: "INFOSYSTCH", match: "exact", names: ["INFOSYSTCH 2011-06-29→…"], changes: [] });
  });

  it("keeps a reused ticker's two companies apart", () => {
    // OLDCO renamed NEWCO in 2010; in 2015 another company renamed itself OLDCO.
    const reused = new Renames([change("OLDCO", "NEWCO", "2010-01-04"), change("OTHER", "OLDCO", "2015-03-02")]);
    expect(spans(reused, "OLDCO", "2005-01-03").names).toEqual(["OLDCO …→2010-01-04", "NEWCO 2010-01-04→…"]);
    expect(spans(reused, "OLDCO", "2020-01-01").names).toEqual(["OTHER …→2015-03-02", "OLDCO 2015-03-02→…"]);
    expect(spans(reused, "NEWCO", "2020-01-01").names).toEqual(["OLDCO …→2010-01-04", "NEWCO 2010-01-04→…"]);
    // Between the two, nobody known had OLDCO: with nothing stored, the listing that took it next.
    expect(spans(reused, "OLDCO", "2012-01-02", () => false)).toMatchObject({ current: "OLDCO", match: "later" });
  });

  it("treats renames chained on one day as one, and never loops", () => {
    // GBNOV23 → SBNOV23 → SGBNOV23, all on 15 Sep 2016 (real rows).
    expect(renames.listing("SGBNOV23", TODAY).names.map((name) => name.symbol)).toEqual(["GBNOV23", "SGBNOV23"]);
    expect(collapseSameDay([change("A", "B", "2020-01-01"), change("B", "A", "2020-01-01")])).toEqual([]);
    const loop = new Renames([change("A", "B", "2020-01-01"), change("B", "A", "2021-01-01"), change("A", "B", "2022-01-03")]);
    expect(loop.listing("B", TODAY).names.map((name) => name.symbol)).toEqual(["A", "B", "A", "B"]);
  });

  it("finds renames in ISINs and adds those NSE's list lacks", () => {
    const uses = [
      { isin: "INE009A01021", symbol: "INFOSYSTCH", firstDay: d("2011-01-03"), lastDay: d("2011-06-28") },
      { isin: "INE009A01021", symbol: "INFY", firstDay: d("2011-06-29"), lastDay: d("2024-07-05") },
      { isin: "INE111A01011", symbol: "ABC", firstDay: d("2012-01-02"), lastDay: d("2013-05-10") },
      { isin: "INE111A01011", symbol: "ABCNEW", firstDay: d("2013-05-13"), lastDay: d("2024-07-05") },
      // The same ISIN under two tickers at once: ambiguous, ignored.
      { isin: "INE222A01011", symbol: "P", firstDay: d("2012-01-02"), lastDay: d("2014-01-01") },
      { isin: "INE222A01011", symbol: "Q", firstDay: d("2013-01-01"), lastDay: d("2015-01-01") },
    ];
    const seen = isinChanges(uses);
    expect(seen.map((c) => `${c.oldSymbol}→${c.newSymbol} ${isoDay(c.day)} ${c.isin}`)).toEqual(["INFOSYSTCH→INFY 2011-06-29 INE009A01021", "ABC→ABCNEW 2013-05-13 INE111A01011"]);
    const nseRows = parseSymbolChanges(fixture("symbolchange.csv")).rows;
    const merged = mergeChanges(nseRows, seen);
    expect(merged).toHaveLength(nseRows.length + 1);
    expect(merged.filter((c) => c.oldSymbol === "INFOSYSTCH")).toEqual([expect.objectContaining({ source: "nse", company: "Infosys Limited", isin: null })]);
    expect(merged.find((c) => c.oldSymbol === "ABC")).toMatchObject({ newSymbol: "ABCNEW", source: "isin", isin: "INE111A01011" });
    // NSE's list dates a change a few days off from the files: still the same change.
    expect(mergeChanges([{ oldSymbol: "ABC", newSymbol: "ABCLTD", day: d("2013-05-10"), company: "ABC" }], seen.slice(1))).toHaveLength(1);
  });
});

describe("ticker renames in the hub", () => {
  let t: TestHub;
  afterEach(() => t.cleanup());
  const archive = "https://nse.test";
  const listUrl = `${archive}/content/equities/symbolchange.csv`;
  /** The fixture plus filler rows, so the file passes the sanity floor. */
  const fullList = () => `${fixture("symbolchange.csv").trimEnd()}\n${Array.from({ length: MIN_SYMBOL_CHANGES }, (_, i) => `Filler ${i} Limited,FILL${i},FILLED${i},01-JAN-2001`).join("\n")}\n`;
  const zipOf = (name: string) => new Response(makeZip(`${name}.csv`, Buffer.from(fixture(`${name}.csv`))));
  const context = (routes: Record<string, Route | Route[]>, now = ist(2026, 11, 18, 19)) => {
    t = makeHub();
    const time = fakeTime(now);
    const calls: Array<{ url: string; at: number; headers: Record<string, string> }> = [];
    const ctx: NseContext = { db: t.db, log: quiet, clock: time.clock, urls: { archiveUrl: archive }, nse: new NseClient({ log: quiet, clock: time.clock, sleep: time.sleep, fetch: fakeFetch(routes, calls, time.clock) }) };
    return { ctx, calls };
  };

  it("downloads NSE's list, replacing the stored one, and keeps it when NSE sends something short", async () => {
    const { ctx } = context({ [listUrl]: [new Response(fullList()), new Response("NAME OF THE COMPANY,OLD SYMBOL,NEW SYMBOL,EFFECTIVE DATE\nInfosys Limited,INFOSYSTCH,INFY,29-JUN-2011\n")] });
    writeSymbolChanges(ctx.db, [{ oldSymbol: "STALE", newSymbol: "GONE", day: d("2001-01-01"), company: "" }]);
    expect(await refreshSymbolChanges(ctx)).toBe(true);
    expect(readSymbolChanges(ctx.db)).toHaveLength(15 + MIN_SYMBOL_CHANGES);
    expect(readSymbolChanges(ctx.db).some((row) => row.oldSymbol === "STALE")).toBe(false);
    expect(readRuns(ctx.db).get("symbol_changes")).toMatchObject({ lastError: null, info: { count: 15 + MIN_SYMBOL_CHANGES } });
    expect(await refreshSymbolChanges(ctx)).toBe(false);
    expect(readRuns(ctx.db).get("symbol_changes")?.lastError).toMatch(/only 1 symbol changes/);
    expect(readSymbolChanges(ctx.db)).toHaveLength(15 + MIN_SYMBOL_CHANGES);
  });

  it("records ISINs from old-format cash days and finds the rename in them", async () => {
    const routes = { [cashBhavUrl(archive, d("2011-06-28"))]: zipOf("cm28JUN2011bhav"), [cashBhavUrl(archive, d("2011-06-29"))]: zipOf("cm29JUN2011bhav") };
    const { ctx } = context(routes);
    expect(await importDay(ctx, "cash_bhav", d("2011-06-28"), { extend: false })).toBe("ok");
    expect(await importDay(ctx, "cash_bhav", d("2011-06-29"), { extend: false })).toBe("ok");
    expect(await importDay(ctx, "cash_bhav", d("2011-06-29"), { extend: false })).toBe("ok"); // again: idempotent
    expect(sharedIsins(ctx.db)).toEqual([
      { isin: "INE009A01021", symbol: "INFOSYSTCH", firstDay: d("2011-06-28"), lastDay: d("2011-06-28") },
      { isin: "INE009A01021", symbol: "INFY", firstDay: d("2011-06-29"), lastDay: d("2011-06-29") },
    ]);
    expect([...isinDaysRead(ctx.db)]).toEqual([d("2011-06-28"), d("2011-06-29")]);
    // With no NSE list at all, the ISINs alone join Infosys.
    const listing = listingOf(ctx.db, "INFY", TODAY);
    expect(listing.names.map((name) => name.symbol)).toEqual(["INFOSYSTCH", "INFY"]);
    expect(listing.changes[0]).toMatchObject({ source: "isin", isin: "INE009A01021", day: d("2011-06-29") });
    // NSE's own row for the change wins.
    writeSymbolChanges(ctx.db, parseSymbolChanges(fixture("symbolchange.csv")).rows);
    expect(loadRenames(ctx.db).changes.filter((c) => c.newSymbol === "INFY")).toEqual([expect.objectContaining({ source: "nse", company: "Infosys Limited" })]);
  });

  it("reads just the ISINs of stored old-format days that lack them, once, when NSE history runs", async () => {
    const routes = { [cashBhavUrl(archive, d("2011-06-28"))]: zipOf("cm28JUN2011bhav"), [cashBhavUrl(archive, d("2011-06-29"))]: zipOf("cm29JUN2011bhav") };
    const { ctx, calls } = context(routes);
    // Downloaded before the hub kept ISINs: stored, with delivery %, but no ISINs.
    for (const [day, symbol] of [["2011-06-28", "INFOSYSTCH"], ["2011-06-29", "INFY"]] as const)
      writeCashDay(ctx.db, d(day), [{ symbol, series: "EQ", prevClose: 1, open: 1, high: 1, low: 1, close: 1, volume: 1, deliveryPct: 40 }], 0);
    markDay(ctx.db, "cash_bhav", d("2011-06-27"), "ok", 0, 0);
    writeIsins(ctx.db, d("2011-06-27"), []); // already read (a day whose file had no ISINs counts too)
    markDay(ctx.db, "cash_bhav", d("2010-06-01"), "ok", 0, 0); // before ISIN_FROM: never asked
    expect(isinDays(ctx.db, d("2010-01-01"), d("2024-12-31"))).toEqual([d("2011-06-28"), d("2011-06-29")]);

    const range = { from: "2011-06-27", to: "2011-06-29", datasets: ["cash_bhav" as const] };
    const final = await runNseHistory(ctx, enqueueJob(ctx.db, "nse_history", range).id);
    expect(final).toMatchObject({ state: "done", done: 2, total: 2 });
    expect(final.message).toBe("Done — 0 sessions stored, 0 days without a file, ISINs read for 2 stored days.");
    expect(calls.map((call) => call.url)).toEqual([cashBhavUrl(archive, d("2011-06-28")), cashBhavUrl(archive, d("2011-06-29"))]); // no MTO files
    expect(calls.some((call) => call.url === mtoUrl(archive, d("2011-06-28")))).toBe(false);
    // The stored prices and delivery % are left alone; the rename is now known.
    expect(ctx.db.prepare("select c, deliv_pct from cash_bhav where symbol = 'INFY'").get()).toEqual({ c: 1, deliv_pct: 40 });
    expect(listingOf(ctx.db, "INFY", TODAY).names.map((name) => name.symbol)).toEqual(["INFOSYSTCH", "INFY"]);

    const again = await runNseHistory(ctx, enqueueJob(ctx.db, "nse_history", range).id);
    expect(again.message).toBe("Done — 0 sessions stored, 0 days without a file.");
    expect(calls).toHaveLength(2);
  });

  describe("/v1/symbols", () => {
    const withKey = (scopes: Scope[] = ["history"]) => {
      const { key } = createKey(t.db, "test", scopes);
      const app = t.app();
      return async (path: string) => {
        const res = await app.request(path, { headers: { authorization: `Bearer ${key}` } });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return { status: res.status, body: (await res.json()) as any };
      };
    };
    const stored = async () => {
      const { ctx } = context({ [listUrl]: new Response(fullList()), [cashBhavUrl(archive, d("2011-06-28"))]: zipOf("cm28JUN2011bhav"), [cashBhavUrl(archive, d("2011-06-29"))]: zipOf("cm29JUN2011bhav") });
      await importDay(ctx, "cash_bhav", d("2011-06-28"), { extend: false });
      await importDay(ctx, "cash_bhav", d("2011-06-29"), { extend: false });
      return ctx;
    };

    it("answers 503 not_ready until NSE's list is stored, and checks its parameters", async () => {
      context({});
      const get = withKey();
      expect(await get("/v1/symbols/history?symbol=INFY")).toMatchObject({ status: 503, body: { code: "not_ready" } });
      expect(await get("/v1/symbols/changes")).toMatchObject({ status: 503, body: { code: "not_ready" } });
      expect(await get("/v1/symbols/history")).toMatchObject({ status: 400, body: { code: "bad_request" } });
      expect(await get("/v1/symbols/history?symbol=INFY&date=2011-02-30")).toMatchObject({ status: 400, body: { error: expect.stringMatching(/date must be a date/) } });
      expect(await get("/v1/symbols/changes?from=2020-01-02&to=2020-01-01")).toMatchObject({ status: 400, body: { error: "from must not be after to." } });
      expect((await withKey(["fo"])("/v1/symbols/history?symbol=INFY")).status).toBe(403);
    });

    it("serves a listing's names point in time, with the cash history stored under each", async () => {
      const ctx = await stored();
      await refreshSymbolChanges(ctx);
      const get = withKey();
      const now = await get("/v1/symbols/history?symbol=infy");
      expect(now.status).toBe(200);
      expect(now.body).toEqual({
        symbol: "INFY",
        date: isoDay(istDayKey()),
        match: "exact",
        onDate: "INFY",
        current: "INFY",
        names: [
          { symbol: "INFOSYSTCH", from: null, to: "2011-06-28", stored: { first: "2011-06-28", last: "2011-06-28", sessions: 1 } },
          { symbol: "INFY", from: "2011-06-29", to: null, stored: { first: "2011-06-29", last: "2011-06-29", sessions: 1 } },
        ],
        changes: [{ date: "2011-06-29", day: d("2011-06-29"), oldSymbol: "INFOSYSTCH", newSymbol: "INFY", company: "Infosys Limited", source: "nse", isin: null, continuous: true }],
        fetchedAt: readRuns(ctx.db).get("symbol_changes")!.lastSuccessAt,
      });
      // As of 2005 the same listing was INFOSYSTCH, asked by either name.
      expect((await get("/v1/symbols/history?symbol=INFOSYSTCH&date=2005-01-03")).body).toMatchObject({ match: "exact", onDate: "INFOSYSTCH", current: "INFY" });
      expect((await get("/v1/symbols/history?symbol=INFY&date=2005-01-03")).body).toMatchObject({ match: "later", onDate: "INFOSYSTCH", current: "INFY" });
      expect((await get("/v1/symbols/history?symbol=INFOSYSTCH")).body).toMatchObject({ match: "earlier", onDate: "INFY", current: "INFY" });
      // Nothing stored on one side: continuity unknown.
      const tmpv = (await get("/v1/symbols/history?symbol=TMPV")).body;
      expect(tmpv.names.map((name: { symbol: string; stored: unknown }) => `${name.symbol} ${name.stored ? "stored" : "-"}`)).toEqual(["TELCO -", "TATAMOTORS stored", "TMPV -"]);
      expect(tmpv.changes.map((c: { continuous: boolean | null }) => c.continuous)).toEqual([null, null]);
      // A gap: a stored session in between that the old ticker misses.
      writeCashDay(ctx.db, d("2011-06-30"), [{ symbol: "SBIN", series: "EQ", prevClose: 1, open: 1, high: 1, low: 1, close: 1, volume: 1, deliveryPct: null }], 0);
      ctx.db.prepare("delete from cash_bhav where symbol = 'INFY'").run();
      writeCashDay(ctx.db, d("2011-07-01"), [{ symbol: "INFY", series: "EQ", prevClose: 1, open: 1, high: 1, low: 1, close: 1, volume: 1, deliveryPct: null }], 0);
      expect((await get("/v1/symbols/history?symbol=INFY")).body.changes[0].continuous).toBe(false);
    });

    it("lists every ticker in the stored cash archive, a renamed one with its listing, in pages (#60)", async () => {
      const ctx = await stored();
      const get = withKey();
      // Before NSE's list of renames is in: every ticker, no listings yet.
      expect((await get("/v1/symbols/archive")).body).toMatchObject({ from: null, to: null, series: null, count: 5, returned: 5, next: null, renamesFetchedAt: null });
      await refreshSymbolChanges(ctx);
      const all = (await get("/v1/symbols/archive")).body;
      expect(all.renamesFetchedAt).toBe(readRuns(ctx.db).get("symbol_changes")!.lastSuccessAt);
      expect(all.symbols.map((row: { symbol: string }) => row.symbol)).toEqual(["20MICRONS", "INFOSYSTCH", "INFY", "SBIN", "TATAMOTORS"]);
      const infosys = { current: "INFY", names: [{ symbol: "INFOSYSTCH", from: null, to: "2011-06-28" }, { symbol: "INFY", from: "2011-06-29", to: null }] };
      expect(all.symbols[1]).toEqual({ symbol: "INFOSYSTCH", first: "2011-06-28", last: "2011-06-28", sessions: 1, series: ["EQ"], listing: infosys });
      expect(all.symbols[2]).toMatchObject({ symbol: "INFY", first: "2011-06-29", listing: infosys });
      expect(all.symbols[3]).toEqual({ symbol: "SBIN", first: "2011-06-28", last: "2011-06-29", sessions: 2, series: ["EQ"], listing: null });
      expect(all.symbols[4].listing).toEqual({ current: "TMPV", names: [{ symbol: "TELCO", from: null, to: "2003-12-25" }, { symbol: "TATAMOTORS", from: "2003-12-26", to: "2025-10-23" }, { symbol: "TMPV", from: "2025-10-24", to: null }] });
      // One day's universe.
      expect((await get("/v1/symbols/archive?from=2011-06-29&to=2011-06-29")).body.symbols.map((row: { symbol: string }) => row.symbol)).toEqual(["20MICRONS", "INFY", "SBIN", "TATAMOTORS"]);
      // Pages: `next` is the `after` of the next one.
      const pages: string[][] = [];
      let after: string | null = "";
      while (after !== null) {
        const page: { count: number; next: string | null; symbols: Array<{ symbol: string }> } = (await get(`/v1/symbols/archive?limit=2${after ? `&after=${after}` : ""}`)).body;
        expect(page.count).toBe(5);
        pages.push(page.symbols.map((row) => row.symbol));
        after = page.next;
      }
      expect(pages).toEqual([["20MICRONS", "INFOSYSTCH"], ["INFY", "SBIN"], ["TATAMOTORS"]]);
      // A day stored since: the list follows.
      writeCashDay(ctx.db, d("2011-06-30"), [{ symbol: "NEWCO", series: "BE", prevClose: 1, open: 1, high: 1, low: 1, close: 1, volume: 1, deliveryPct: null }], 1);
      expect((await get("/v1/symbols/archive")).body.count).toBe(6);
      expect((await get("/v1/symbols/archive?series=be")).body.symbols.map((row: { symbol: string }) => row.symbol)).toEqual(["NEWCO"]);
      for (const bad of ["series=N1", "limit=0", "limit=10001", "after=no%20such", "from=2011-07-01&to=2011-06-01"]) expect((await get(`/v1/symbols/archive?${bad}`)).status).toBe(400);
      expect((await withKey(["fo"])("/v1/symbols/archive")).status).toBe(403);
    });

    it("lists the renames, by date range or ticker", async () => {
      const ctx = await stored();
      await refreshSymbolChanges(ctx);
      const get = withKey();
      const all = (await get("/v1/symbols/changes")).body;
      // GBNOV23 → SBNOV23 → SGBNOV23 on one day is one change.
      expect(all).toMatchObject({ from: null, to: null, count: 14 + MIN_SYMBOL_CHANGES });
      expect(all.changes.find((c: { oldSymbol: string }) => c.oldSymbol === "GBNOV23")).toMatchObject({ newSymbol: "SGBNOV23", date: "2016-09-15" });
      const recent = (await get("/v1/symbols/changes?from=2025-01-01")).body;
      expect(recent.changes.map((c: { oldSymbol: string; newSymbol: string; date: string }) => `${c.date} ${c.oldSymbol}→${c.newSymbol}`)).toEqual(["2025-02-19 780LTFL30→799LTFL30", "2025-10-24 TATAMOTORS→TMPV", "2026-02-27 LTIM→LTM", "2026-10-23 ICICIPRULI→ICICILIFE"]);
      expect((await get("/v1/symbols/changes?symbol=ltim")).body.changes.map((c: { date: string }) => c.date)).toEqual(["2022-12-05", "2026-02-27"]);
      expect((await get("/v1/symbols/changes?from=2011-06-29&to=2011-06-29")).body.changes).toEqual([{ date: "2011-06-29", day: d("2011-06-29"), oldSymbol: "INFOSYSTCH", newSymbol: "INFY", company: "Infosys Limited", source: "nse", isin: null }]);
    });
  });
});
