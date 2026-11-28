import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createKey } from "../src/auth/keys.js";
import { assessHealth, type HealthInput } from "../src/health.js";
import { enqueueJob, type NseHistoryParams } from "../src/jobs/backfill.js";
import { HISTORY_DATASETS, historyDays, runNseHistory, validateNseHistory } from "../src/jobs/nseHistory.js";
import { Scheduler, dueTasks } from "../src/jobs/scheduler.js";
import { createLogger } from "../src/log.js";
import { NseClient, NseError } from "../src/nse/client.js";
import { ARCHIVE_FROM, PARTICIPANT_SWAP_NOTE, PUBLISH_MIN, importDay, participantsUrl, readParticipantsFile, recentDays, type NseContext } from "../src/nse/datasets.js";
import { netPositions, parseParticipantOi, participantTitleDate, type ParticipantPositions, type ParticipantRow } from "../src/nse/parsers/participantOi.js";
import { participantGaps, participantNotes, participantSpan, readParticipants, writeParticipantDay } from "../src/nse/participantStore.js";
import { checkedDays, markDay, recordRun, writeBan } from "../src/nse/store.js";
import { calendarFindings, participantFindings, type DayRecord } from "../src/quality/checks.js";
import { runQuality } from "../src/quality/run.js";
import { readFindings } from "../src/quality/store.js";
import { dataFreshness } from "../src/status.js";
import { DAY_MS, isoDay, parseIsoDay } from "../src/time.js";
import { calendar } from "../src/calendar/calendar.js";
import { ist, makeHub, type TestHub } from "./support/hub.js";
import { fakeFetch, fakeTime, type Route } from "./support/nse.js";

// NSE's participant-wise F&O open interest (market-data-hub#28): the
// fao_participant_oi file, from 2 Jan 2012. The fixtures are real files from
// NSE's archive, one per layout seen in a sample of the first session of every
// month 2012 → 2026 (plus each day of Jan 2012):
//   02012012  "CLIENT_TYPE", "FII " and "Total", FII listed before DII — and
//             the FII and DII rows carrying each other's labels
//   03012012  "NA" for no position
//   23012012  Indian-grouped decimals in quotes ("2,48,292.00")
//   01102015  fractions of a contract (NIFTY's lot went from 25 to 75)
//   01062016  the plain layout of 2012–2019
//   01102019  "Oct 01 2019": no comma in the date, no quotes
//   01062020  ""doubled quotes"" round the title, a tab after a header name
//   01032024  the year in a cell of its own: "Mar 01,"2024"""""
//   03112025  the current layout (spaces after header names)

const d = (iso: string) => parseIsoDay(iso)!;
const fixture = (day: string) => readFileSync(new URL(`./fixtures/fao_participant_oi_${day}.csv`, import.meta.url), "utf8");
const quiet = createLogger({ level: "error", secrets: [], write: () => {} });
const archive = "https://nse.test";
const ALL = ["02012012", "03012012", "23012012", "01102015", "01062016", "01102019", "01062020", "01032024", "03112025"];
const dayOf = (ddmmyyyy: string) => Date.UTC(Number(ddmmyyyy.slice(4)), Number(ddmmyyyy.slice(2, 4)) - 1, Number(ddmmyyyy.slice(0, 2)));
/** The 2025 file re-dated (its title is all that changes), for days the fixtures don't cover. */
const redated = (day: number) => fixture("03112025").replace("Nov 03, 2025", new Date(day).toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric", timeZone: "UTC" }));

let t: TestHub;
afterEach(() => t?.cleanup());

function context(routes: Record<string, Route | Route[]>, now: number) {
  t = makeHub({ clock: () => now });
  const time = fakeTime(now);
  const calls: Array<{ url: string; at: number; headers: Record<string, string> }> = [];
  const ctx: NseContext = { db: t.db, log: quiet, clock: time.clock, urls: { archiveUrl: archive }, nse: new NseClient({ log: quiet, clock: time.clock, sleep: time.sleep, fetch: fakeFetch(routes, calls, time.clock) }) };
  return { ctx, calls, time };
}

describe("parsing every layout NSE has used", () => {
  it("reads all four participant types and NSE's total from every era, with the date in the title", () => {
    for (const name of ALL) {
      const parsed = parseParticipantOi(fixture(name));
      expect(parsed.tradeDate, name).toBe(dayOf(name));
      expect(parsed.missingColumns, name).toEqual([]);
      expect(parsed.extraColumns, name).toEqual([]);
      expect(parsed.badRows, name).toBe(0);
      expect([...parsed.rows.keys()].sort(), name).toEqual(["client", "dii", "fii", "pro", "total"]);
      // Contracts, as printed: within NSE's rounding, the participants add up to its TOTAL row and longs equal shorts.
      expect(participantFindings([{ day: dayOf(name), rows: parsed.rows }]).filter((f) => f.subject === "totals"), name).toEqual([]);
    }
  });

  it("keeps the numbers exactly as NSE printed them", () => {
    const y2025 = parseParticipantOi(fixture("03112025")).rows;
    expect(y2025.get("fii")).toEqual({
      futIdxLong: 28322, futIdxShort: 153149, futStkLong: 3645001, futStkShort: 2275219,
      optIdxCallLong: 618499, optIdxPutLong: 630742, optIdxCallShort: 608823, optIdxPutShort: 411798,
      optStkCallLong: 73144, optStkPutLong: 103571, optStkCallShort: 105505, optStkPutShort: 61658,
      totalLong: 5099279, totalShort: 3616152,
    });
    expect(netPositions(y2025.get("fii")!)).toMatchObject({ futIdx: -124827, optIdxCall: 9676, optIdxPut: 218944 });
    expect(y2025.get("total")).toMatchObject({ futIdxLong: 313144, futIdxShort: 313144 });
    // "2,48,292.00" (23 Jan 2012) and "909608.3333" (1 Oct 2015: a third of a contract after NIFTY's lot tripled).
    expect(parseParticipantOi(fixture("23012012")).rows.get("client")).toMatchObject({ futIdxLong: 248292, totalLong: 2579343 });
    expect(parseParticipantOi(fixture("01102015")).rows.get("client")?.optIdxCallShort).toBe(909608.3333);
    // "NA" is no position (3 Jan 2012: the DII row's totals add up with it as 0).
    const na = parseParticipantOi(fixture("03012012"));
    expect(na.naCells).toBe(5);
    expect(na.rows.get("dii")).toMatchObject({ optIdxCallShort: 0, optIdxPutShort: 0, totalLong: 240985 });
  });

  it("reports 2 Jan 2012 as NSE printed it: FII before DII, and a DII row that writes options the FII row doesn't", () => {
    const parsed = parseParticipantOi(fixture("02012012"));
    expect(parsed.order).toEqual(["client", "fii", "dii", "pro", "total"]);
    expect(parsed.rows.get("fii")).toMatchObject({ futIdxLong: 55396, futIdxShort: 1387, optIdxCallShort: 0, optIdxPutShort: 0 });
    const findings = participantFindings([{ day: d("2012-01-02"), rows: parsed.rows }]);
    expect(findings).toMatchObject([{ check: "participant_oi", subject: "fii_dii", severity: "warning", detail: { diiWritten: 373412, fiiWritten: 0 } }]);
  });

  it("reads the title's date in all its spellings", () => {
    expect(participantTitleDate("Participant wise Open Interest (no. of contracts) in Equity Derivatives as on January 02, 2012")).toBe(d("2012-01-02"));
    expect(participantTitleDate("…as on Jun 01,2020")).toBe(d("2020-06-01"));
    expect(participantTitleDate("…as on Oct 01 2019,,,,")).toBe(d("2019-10-01"));
    expect(participantTitleDate("…as on Feb 30, 2020")).toBeNull();
    expect(participantTitleDate("…as on Foo 01, 2020")).toBeNull();
    expect(participantTitleDate("Participant wise Open Interest")).toBeNull();
  });

  it("reads columns by name, and says what it can't read", () => {
    const lines = fixture("03112025").split("\r\n");
    // Columns in another order, plus one the hub doesn't know: read by name.
    const header = lines[1].split(",");
    const swap = (row: string) => {
      const cells = row.split(",");
      [cells[1], cells[2]] = [cells[2], cells[1]];
      return [...cells, "7"].join(",");
    };
    const shuffled = parseParticipantOi([lines[0], swap([header[0], ...header.slice(1)].join(",")).replace(/,7$/, ",Future Index Net"), ...lines.slice(2).filter(Boolean).map(swap)].join("\n"));
    expect(shuffled.extraColumns).toEqual(["Future Index Net"]);
    expect(shuffled.rows.get("fii")).toMatchObject({ futIdxLong: 28322, futIdxShort: 153149 });
    // A column missing: nothing is read.
    const short = parseParticipantOi([lines[0], lines[1].replace(",Future Index Short", ""), ...lines.slice(2)].join("\n"));
    expect(short.missingColumns).toEqual(["futIdxShort"]);
    expect(short.rows.size).toBe(0);
    // An unknown label, a repeated one, a cell that isn't a number.
    const odd = parseParticipantOi([...lines.slice(0, 3), lines[2], lines[3].replace("75160", "75,16x"), "Prop,1,2,3,4,5,6,7,8,9,10,11,12,13,14", ...lines.slice(4)].join("\n"));
    expect(odd.badRows).toBe(3);
    expect([...odd.rows.keys()]).toEqual(["client", "fii", "pro", "total"]);
    expect(parseParticipantOi("<!DOCTYPE html><html>not found</html>").missingColumns).toHaveLength(14);
  });
});

describe("checking a file before it's stored", () => {
  it("stores 2 Jan 2012 with FII and DII swapped back, and says so", () => {
    const { ctx } = context({}, ist(2026, 11, 20, 20));
    const day = d("2012-01-02");
    const parsed = readParticipantsFile(ctx, day, Buffer.from(fixture("02012012")));
    expect(parsed.kind).toBe("ok");
    if (parsed.kind === "ok") expect(parsed.store()).toBe(5);
    const [stored] = readParticipants(ctx.db);
    expect(stored.rows.get("dii")).toMatchObject({ futIdxLong: 55396, futIdxShort: 1387 });
    expect(stored.rows.get("fii")).toMatchObject({ futIdxLong: 198027, futIdxShort: 208336, optIdxCallShort: 226048 });
    expect(participantNotes(ctx.db, day, day).get(day)).toBe(PARTICIPANT_SWAP_NOTE);
    // Swapped back, the day looks like 3 Jan's (DII 60,612 / 639 index futures; FII 226,477 / 204,064).
    expect(participantFindings(readParticipants(ctx.db))).toEqual([]);
  });

  it("treats another day's file as a mismatch, and a changed layout as a failure to retry", () => {
    const { ctx } = context({}, ist(2026, 11, 20, 20));
    expect(readParticipantsFile(ctx, d("2016-06-02"), Buffer.from(fixture("01062016")))).toEqual({ kind: "mismatch", note: "file is for 2016-06-01" });
    const noTotal = fixture("01062016").replace(/TOTAL,.*\r\n/, "");
    expect(() => readParticipantsFile(ctx, d("2016-06-01"), Buffer.from(noTotal))).toThrow(NseError);
    expect(() => readParticipantsFile(ctx, d("2016-06-01"), Buffer.from(noTotal))).toThrow(/no total row/);
    expect(() => readParticipantsFile(ctx, d("2016-06-01"), Buffer.from(fixture("01062016").replace("Future Index Long", "Fut Idx Long")))).toThrow(/lacks futIdxLong/);
  });
});

describe("storage (migration 14)", () => {
  it("round-trips a day, records it in nse_days, and lists F&O sessions without a file", () => {
    t = makeHub();
    expect((t.db.prepare("select id from _migrations where id = 14").get() as { id: number } | undefined)?.id).toBe(14);
    const rows = parseParticipantOi(fixture("01102015")).rows;
    writeParticipantDay(t.db, d("2015-10-01"), rows, 7);
    expect(readParticipants(t.db)).toEqual([{ day: d("2015-10-01"), rows }]);
    expect(checkedDays(t.db, "fo_participants").get(d("2015-10-01"))).toBe("ok");
    expect(participantSpan(t.db)).toEqual({ first: d("2015-10-01"), last: d("2015-10-01"), days: 1 });
    // Stored again: replaced, not added to.
    writeParticipantDay(t.db, d("2015-10-01"), rows, 8);
    expect((t.db.prepare("select count(*) as n from fo_participants").get() as { n: number }).n).toBe(5);
    for (const day of ["2015-09-30", "2015-10-01", "2015-10-05", "2015-10-06"]) markDay(t.db, "fo_bhav", d(day), "ok", 100, 1);
    markDay(t.db, "fo_participants", d("2015-10-05"), "holiday", 0, 1);
    expect(participantGaps(t.db, d("2015-09-01"), d("2015-10-31")).map((gap) => `${isoDay(gap.day)} ${gap.reason}`)).toEqual(["2015-09-30 not_downloaded", "2015-10-05 no_file", "2015-10-06 not_downloaded"]);
  });
});

describe("downloading: the evening run and `--only participants`", () => {
  it("starts at NSE's first file, 2 Jan 2012, and is part of `--only participants` and the full archive", () => {
    expect(ARCHIVE_FROM.fo_participants).toBe(d("2012-01-02"));
    expect(HISTORY_DATASETS).toContain("fo_participants");
    const params: NseHistoryParams = { from: "2011-12-26", to: "2012-01-06", datasets: ["fo_participants"] };
    expect(validateNseHistory(params, d("2026-11-20"))).toBeNull();
    t = makeHub();
    expect(historyDays(t.db, "fo_participants", d("2011-12-26"), d("2012-01-06")).map(isoDay)).toEqual(["2012-01-02", "2012-01-03", "2012-01-04", "2012-01-05", "2012-01-06"]);
  });

  it("`--only participants` downloads each day once: stored, no file, another day's file", async () => {
    const routes = {
      [participantsUrl(archive, d("2012-01-02"))]: new Response(fixture("02012012")),
      [participantsUrl(archive, d("2012-01-03"))]: new Response(fixture("03012012")),
      // 4 Jan: 404 (not routed). 5 Jan: NSE serves 3 Jan's file.
      [participantsUrl(archive, d("2012-01-05"))]: new Response(fixture("03012012")),
      [participantsUrl(archive, d("2012-01-06"))]: new Response(redated(d("2012-01-06"))),
    };
    const { ctx, calls } = context(routes, ist(2026, 11, 20, 20));
    const params: NseHistoryParams = { from: "2012-01-01", to: "2012-01-06", datasets: ["fo_participants"] };
    const job = await runNseHistory(ctx, enqueueJob(ctx.db, "nse_history", params).id);
    expect(job.state).toBe("done");
    expect(job.message).toBe("Done — 3 sessions stored, 1 day without a file, 1 file for another date.");
    expect(calls.map((call) => call.url)).toEqual(["02", "03", "04", "05", "06"].map((dd) => participantsUrl(archive, d(`2012-01-${dd}`))));
    expect([...checkedDays(ctx.db, "fo_participants")].sort(([a], [b]) => a - b).map(([day, status]) => `${isoDay(day)} ${status}`)).toEqual(["2012-01-02 ok", "2012-01-03 ok", "2012-01-04 holiday", "2012-01-05 mismatch", "2012-01-06 ok"]);
    expect(readParticipants(ctx.db).map((day) => isoDay(day.day))).toEqual(["2012-01-02", "2012-01-03", "2012-01-06"]);
    // Asked once: a second run asks NSE for nothing.
    calls.length = 0;
    const again = await runNseHistory(ctx, enqueueJob(ctx.db, "nse_history", params).id);
    expect(again.message).toBe("Done — 0 sessions stored, 0 days without a file.");
    expect(calls).toEqual([]);
  });

  it("the evening run asks for the recent days missing, today's only from 18:00, and stores them", async () => {
    // Thu 26 Nov 2026. Every other dataset is stored for the last two months; participant OI up to Fri 20 Nov.
    const time = fakeTime(ist(2026, 11, 26, 17, 0));
    const clock = time.clock;
    const now = {
      get at() {
        return time.state.now;
      },
      set at(value: number) {
        time.state.now = value;
      },
    };
    const participantCalls = () => calls.map((call) => call.url).filter((url) => url.includes("/nsccl/"));
    const calls: Array<{ url: string; at: number; headers: Record<string, string> }> = [];
    const routes: Record<string, Route> = {};
    for (const day of ["2026-11-23", "2026-11-25"]) routes[participantsUrl(archive, d(day))] = new Response(redated(d(day)));
    t = makeHub({ clock });
    const ctx: NseContext = { db: t.db, log: quiet, clock, urls: { archiveUrl: archive }, nse: new NseClient({ log: quiet, clock, sleep: time.sleep, fetch: fakeFetch(routes, calls, clock) }) };
    const cal = calendar();
    for (let day = d("2026-09-01"); day <= d("2026-11-26"); day += DAY_MS) {
      if (!cal.isTradingDay(day)) continue;
      for (const dataset of ["cash_bhav", "fo_bhav", "pr", "index_close", "fo_ban"] as const) markDay(t.db, dataset, day, "ok", 10, 1);
      if (day <= d("2026-11-20")) writeParticipantDay(t.db, day, parseParticipantOi(fixture("03112025")).rows, 1);
    }
    for (const name of ["lots", "fo_ban", "symbol_changes"] as const) recordRun(t.db, name, { at: ist(2026, 11, 26, 7, 0), ok: true });
    writeBan(t.db, d("2026-11-27"), [], ist(2026, 11, 26, 7, 0));
    const scheduler = new Scheduler({ nse: ctx, backfill: { db: t.db, history: t.hub.history, log: quiet, clock }, log: quiet });

    // 17:00: today's file isn't out yet (PUBLISH_MIN 18:00); Tue 24 Nov is a listed holiday, recorded without asking.
    expect(PUBLISH_MIN.fo_participants).toBe(18 * 60);
    expect(recentDays(ctx, "fo_participants", 10).map(isoDay)).toEqual(["2026-11-25", "2026-11-24", "2026-11-23"]);
    expect(dueTasks({ now: now.at, runs: new Map(), missing: { cash_bhav: 0, fo_bhav: 0, pr: 0, fo_participants: 3 }, banTradeDate: d("2026-11-27") })).toContain("fo_participants");
    await scheduler["nseRound"]();
    expect(participantCalls()).toEqual([participantsUrl(archive, d("2026-11-23")), participantsUrl(archive, d("2026-11-25"))]);
    expect(checkedDays(t.db, "fo_participants").get(d("2026-11-24"))).toBe("holiday");
    expect(participantSpan(t.db).last).toBe(d("2026-11-25"));

    // 18:30: today's file is asked for; NSE hasn't published it (404): not recorded, asked again half an hour later.
    now.at = ist(2026, 11, 26, 18, 30);
    calls.length = 0;
    await scheduler["nseRound"]();
    expect(participantCalls()).toEqual([participantsUrl(archive, d("2026-11-26"))]);
    expect(checkedDays(t.db, "fo_participants").has(d("2026-11-26"))).toBe(false);
    routes[participantsUrl(archive, d("2026-11-26"))] = new Response(redated(d("2026-11-26")));
    now.at = ist(2026, 11, 26, 19, 5);
    await scheduler["nseRound"]();
    expect(participantSpan(t.db).last).toBe(d("2026-11-26"));
    expect(dataFreshness(t.db).participants).toMatchObject({ lastSession: "2026-11-26", firstSession: "2026-09-01", lastError: null });
    expect(recentDays(ctx, "fo_participants", 10)).toEqual([]);
  });

  it("records a past day without a file as one, and doesn't ask for it again", async () => {
    const { ctx, calls } = context({}, ist(2026, 11, 20, 20));
    expect(await importDay(ctx, "fo_participants", d("2026-11-19"))).toBe("holiday");
    expect(await importDay(ctx, "fo_participants", d("2026-11-20"))).toBe("not_yet");
    expect(calls).toHaveLength(2);
    expect([...checkedDays(ctx.db, "fo_participants").keys()].map(isoDay)).toEqual(["2026-11-19"]);
  });
});

describe("data quality and health", () => {
  it("flags a file that doesn't add up beyond rounding", () => {
    const rows = parseParticipantOi(fixture("03112025")).rows;
    const tampered = new Map<ParticipantRow, ParticipantPositions>(rows);
    tampered.set("fii", { ...rows.get("fii")!, futIdxShort: rows.get("fii")!.futIdxShort + 1000 });
    const findings = participantFindings([{ day: d("2025-11-03"), rows: tampered }]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ check: "participant_oi", subject: "totals", severity: "warning" });
    expect(findings[0].detail?.problems).toEqual(["FII's short positions add up to 36,17,152, its total says 36,16,152", "futIdxShort: the participants add up to 3,14,144, NSE's total says 3,13,144"]);
    // A contract or two off (NSE's rounding of fractional contracts) is not a finding.
    tampered.set("fii", { ...rows.get("fii")!, futIdxShort: rows.get("fii")!.futIdxShort + 2, totalShort: rows.get("fii")!.totalShort + 2 });
    expect(participantFindings([{ day: d("2025-11-03"), rows: tampered }])).toEqual([]);
  });

  it("runs the check over stored days, and reports a session without a file like the other day files", () => {
    t = makeHub();
    const rows = parseParticipantOi(fixture("03112025")).rows;
    writeParticipantDay(t.db, d("2025-11-03"), new Map([...rows].map(([who, p]) => [who, who === "pro" ? { ...p, totalLong: p.totalLong + 500 } : p])), 1);
    runQuality(t.db, { clock: () => ist(2025, 11, 4, 20) });
    expect(readFindings(t.db, { check: "participant_oi" }).map((f) => f.subject)).toEqual(["totals"]);
    writeParticipantDay(t.db, d("2025-11-03"), rows, 2);
    runQuality(t.db, { clock: () => ist(2025, 11, 4, 20) });
    expect(readFindings(t.db, { check: "participant_oi" })).toEqual([]);

    const record = (status: DayRecord["status"]) => new Map([[d("2025-11-04"), { status, note: null }]]);
    const days = { cash_bhav: record("ok"), fo_bhav: record("ok"), index_close: record("ok"), pr: record("ok"), fo_participants: record("holiday") };
    expect(calendarFindings({ days, weekendSessions: [], recentFrom: 0 })).toMatchObject([{ check: "missing_session", subject: "fo_participants", severity: "problem" }]);
    expect(calendarFindings({ days, weekendSessions: [], recentFrom: 0, archiveGaps: { fo_participants: [d("2025-11-04")] } })).toMatchObject([{ check: "missing_session", subject: "fo_participants", severity: "info" }]);
    // A participant file alone doesn't make a day a session.
    expect(calendarFindings({ days: { cash_bhav: new Map(), fo_bhav: new Map(), index_close: new Map(), pr: new Map(), fo_participants: record("ok") }, weekendSessions: [], recentFrom: 0 })).toEqual([]);
  });

  it("warns while nothing is stored, and is stale like the other day files once something is", () => {
    const now = ist(2026, 11, 9, 21, 0);
    const fresh = { lastOk: d("2026-11-09"), checked: new Map() };
    const input: HealthInput = {
      now,
      sessionToday: true,
      jobsEnabled: true,
      nse: { cash_bhav: fresh, fo_bhav: fresh, pr: fresh, index_close: fresh, fo_participants: { lastOk: null, checked: new Map() } },
      refreshed: { lots: now - DAY_MS, fo_ban: now - DAY_MS },
      broker: { configured: false, owner: true, loginFailing: null, stoppedForToday: false, coolingDown: false },
      live: { enabled: false, running: false, feed: { mode: "idle", socket: "disabled" } },
      backup: null,
      disk: { volumes: [], warnBytes: 0, minBytes: 0 },
    };
    expect(assessHealth(input)).toMatchObject({ healthy: true, warnings: [expect.stringMatching(/^Participant OI file: nothing stored yet/)] });
    const stale = assessHealth({ ...input, nse: { ...input.nse, fo_participants: { lastOk: d("2026-11-05"), checked: new Map() } } });
    expect(stale.healthy).toBe(false);
    expect(stale.problems).toEqual(["Participant OI file is stale: last session stored 2026-11-05, missing 2026-11-09, 2026-11-08, 2026-11-06."]);
  });
});

describe("GET /v1/fo/participants", () => {
  function withKey(scopes: Array<"history" | "fo"> = ["fo"]) {
    t = makeHub({ clock: () => ist(2026, 11, 20, 20) });
    const { key } = createKey(t.db, "test", scopes);
    const app = t.app();
    return async (path: string) => {
      const res = await app.request(path, { headers: { authorization: `Bearer ${key}` } });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { status: res.status, body: (await res.json()) as any };
    };
  }

  it("answers not_ready before anything is stored, and needs the fo scope", async () => {
    let get = withKey();
    expect(await get("/v1/fo/participants")).toMatchObject({ status: 503, body: { code: "not_ready" } });
    expect((await get("/v1/fo/participants?from=2026-11-10&to=2026-11-01")).status).toBe(400);
    expect((await get("/v1/fo/participants?from=yesterday")).status).toBe(400);
    t.cleanup();
    get = withKey(["history"]);
    expect((await get("/v1/fo/participants")).status).toBe(403);
  });

  it("serves each day's positions in contracts with the nets, NSE's total, the hub's corrections and the sessions without a file", async () => {
    const get = withKey();
    const ctx: NseContext = { ...t.hub.nse };
    const store = (day: string, text: string) => {
      const parsed = readParticipantsFile(ctx, d(day), Buffer.from(text));
      if (parsed.kind === "ok") parsed.store();
    };
    store("2012-01-02", fixture("02012012"));
    store("2012-01-03", fixture("03012012"));
    store("2025-11-03", fixture("03112025"));
    for (const day of ["2012-01-02", "2012-01-03", "2012-01-04"]) markDay(t.db, "fo_bhav", d(day), "ok", 100, 1);

    const early = await get("/v1/fo/participants?from=2012-01-01&to=2012-01-31");
    expect(early.status).toBe(200);
    expect(early.body).toMatchObject({ from: "2012-01-01", to: "2012-01-31", unit: "contracts", knownFrom: "2012-01-02", lastDate: "2025-11-03" });
    expect(early.body.days.map((day: { date: string }) => day.date)).toEqual(["2012-01-02", "2012-01-03"]);
    expect(early.body.days[0].note).toBe(PARTICIPANT_SWAP_NOTE);
    expect(early.body.days[1].note).toBeUndefined();
    expect(early.body.days[0].participants.fii).toMatchObject({ indexFuturesLong: 198027, indexFuturesShort: 208336, indexFuturesNet: -10309 });
    expect(early.body.missing).toEqual([{ date: "2012-01-04", day: d("2012-01-04"), reason: "not_downloaded" }]);

    const recent = await get("/v1/fo/participants?from=2025-11-03&to=2025-11-03");
    const [day] = recent.body.days;
    expect(Object.keys(day.participants)).toEqual(["client", "dii", "fii", "pro"]);
    expect(day.participants.fii).toEqual({
      indexFuturesLong: 28322, indexFuturesShort: 153149, indexFuturesNet: -124827, indexFuturesLongShare: 0.1561,
      stockFuturesLong: 3645001, stockFuturesShort: 2275219, stockFuturesNet: 1369782,
      indexCallLong: 618499, indexCallShort: 608823, indexCallNet: 9676,
      indexPutLong: 630742, indexPutShort: 411798, indexPutNet: 218944,
      stockCallLong: 73144, stockCallShort: 105505, stockCallNet: -32361,
      stockPutLong: 103571, stockPutShort: 61658, stockPutNet: 41913,
      totalLong: 5099279, totalShort: 3616152, totalNet: 1483127,
    });
    expect(day.total).toMatchObject({ indexFuturesLong: 313144, indexFuturesShort: 313144, indexFuturesNet: 0, indexFuturesLongShare: 0.5 });
    // A range is only what was stored for it: a later day never shows up in (or changes) an earlier answer.
    expect((await get("/v1/fo/participants?from=2012-01-01&to=2012-01-02")).body.days).toEqual([early.body.days[0]]);
    // Default: the year up to today.
    expect((await get("/v1/fo/participants")).body).toMatchObject({ from: "2025-11-20", to: "2026-11-20", days: [] });
  });
});
