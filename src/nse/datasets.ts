import type { Db } from "../db.js";
import { applyCashBhav } from "../history/fromBhav.js";
import type { Logger } from "../log.js";
import { DAY_MS, isoDay, istParts } from "../time.js";
import { NseError, type NseClient } from "./client.js";
import { parseCashBhav } from "./parsers/cashBhav.js";
import { aggregateStockFutures, parseFoBhav } from "./parsers/foBhav.js";
import { parseFnoBan } from "./parsers/ban.js";
import { parseNseLots } from "./parsers/lots.js";
import { parseCalendar } from "./parsers/results.js";
import { checkedDays, lotsFromFoBhav, markDay, recordRun, writeBan, writeCashDay, writeFoDay, writeLots, writeResults, type DayDataset, type DayStatus } from "./store.js";
import { ZipError, isZip, unzipSingle } from "./unzip.js";

// NSE's daily files, downloaded from its free public archive — no broker calls:
//   cash_bhav  sec_bhavdata_full_DDMMYYYY.csv: close, volume, delivery % per stock
//   fo_bhav    BhavCopy_NSE_FO_0_0_0_YYYYMMDD_F_0000.csv.zip (UDiFF): stock futures OI
//   lots       fo_mktlots.csv (fallback: the lot column of the latest F&O bhavcopy)
//   fo_ban     fo_secban.csv
//   results    the website's event-calendar JSON (needs the home page's cookies first)
// NSE's archive has been seen to serve another day's file for a holiday URL, so
// the trade date written inside a file must equal the date asked for.

export interface NseContext {
  db: Db;
  nse: NseClient;
  log: Logger;
  urls: { archiveUrl: string; wwwUrl: string };
  clock: () => number;
}

/** Don't ask for today's file before this (minutes after IST midnight). */
export const PUBLISH_MIN: Record<DayDataset, number> = { cash_bhav: 17 * 60 + 30, fo_bhav: 18 * 60 };

/** Weekend days NSE held a full session on. Add new ones here (e.g. a Budget day on a weekend). */
export const WEEKEND_SESSIONS: readonly number[] = [Date.UTC(2026, 1, 1)]; // Sun 1 Feb 2026, Union Budget

/** Stop a run after this many days in a row fail hard (403/429/timeouts after retries). */
export const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * Trading days from `from` through `today` (day keys) that still need a
 * download, newest first: weekdays plus WEEKEND_SESSIONS. Today counts only
 * after `publishMin`. `recheck` lists statuses worth asking again. Pure.
 */
export function daysToCheck(params: { today: number; minutes: number; from: number; publishMin: number; checked: ReadonlyMap<number, string>; recheck?: readonly string[] }): number[] {
  const { today, minutes, from, publishMin, checked, recheck = [] } = params;
  const out: number[] = [];
  for (let day = today; day >= from; day -= DAY_MS) {
    const weekday = new Date(day).getUTCDay();
    if ((weekday === 0 || weekday === 6) && !WEEKEND_SESSIONS.includes(day)) continue;
    if (day === today && minutes < publishMin) continue;
    const status = checked.get(day);
    if (status === undefined || recheck.includes(status)) out.push(day);
  }
  return out;
}

const ddmmyyyy = (day: number) => isoDay(day).split("-").reverse().join("");
const yyyymmdd = (day: number) => isoDay(day).replaceAll("-", "");

export const cashBhavUrl = (archiveUrl: string, day: number) => `${archiveUrl}/products/content/sec_bhavdata_full_${ddmmyyyy(day)}.csv`;
export const foBhavUrl = (archiveUrl: string, day: number) => `${archiveUrl}/content/fo/BhavCopy_NSE_FO_0_0_0_${yyyymmdd(day)}_F_0000.csv.zip`;

export type DayOutcome = DayStatus | "not_yet";

/** What a downloaded day file contains, before it's stored. Exported for tests. */
export type DayParse =
  | { kind: "ok"; store: () => number; badRows: number }
  | { kind: "mismatch"; note: string };

function checkDate(fileDate: number | null, mixed: boolean, day: number): string | null {
  if (mixed) return "file has more than one trade date";
  if (fileDate !== day) return `file is for ${fileDate === null ? "no date" : isoDay(fileDate)}`;
  return null;
}

/** Parse a cash bhavcopy body for `day`. */
export function readCashFile(ctx: NseContext, day: number, body: Buffer): DayParse {
  const parsed = parseCashBhav(body.toString("utf8"));
  const wrong = checkDate(parsed.tradeDate, parsed.mixedDates, day);
  if (wrong) return { kind: "mismatch", note: wrong };
  if (!parsed.rows.length) throw new NseError("no EQ rows in the cash bhavcopy (format change?)", null, false);
  return {
    kind: "ok",
    badRows: parsed.badRows,
    store: () => {
      writeCashDay(ctx.db, day, parsed.rows, ctx.clock());
      applyCashBhav(ctx.db, day, parsed.rows, ctx.log);
      return parsed.rows.length;
    },
  };
}

/** Parse a zipped F&O bhavcopy for `day`. */
export function readFoFile(ctx: NseContext, day: number, body: Buffer): DayParse {
  if (!isZip(body)) throw new NseError("NSE sent something that isn't a zip file", null, true);
  let csv: string;
  try {
    csv = unzipSingle(body).data.toString("utf8");
  } catch (error) {
    // A broken zip is usually a cut-off download: worth another try.
    throw new NseError(`bad zip: ${(error as ZipError).message}`, null, true);
  }
  const parsed = parseFoBhav(csv);
  const wrong = checkDate(parsed.tradeDate, parsed.mixedDates, day);
  if (wrong) return { kind: "mismatch", note: wrong };
  if (!parsed.contracts.length) throw new NseError("no stock-futures rows in the F&O bhavcopy (format change?)", null, false);
  const records = aggregateStockFutures(parsed.contracts, day);
  return {
    kind: "ok",
    badRows: parsed.badRows,
    store: () => {
      writeFoDay(ctx.db, day, records, ctx.clock());
      return records.length;
    },
  };
}

/** Download, check and store one day. Throws NseError when NSE won't serve it. */
export async function importDay(ctx: NseContext, dataset: DayDataset, day: number): Promise<DayOutcome> {
  const url = dataset === "cash_bhav" ? cashBhavUrl(ctx.urls.archiveUrl, day) : foBhavUrl(ctx.urls.archiveUrl, day);
  const response = await ctx.nse.get(url);
  const today = istParts(ctx.clock()).day;
  if (response.status === 404) {
    // Today's file may just not be out yet; an earlier weekday without a file is a holiday.
    if (day >= today) return "not_yet";
    markDay(ctx.db, dataset, day, "holiday", 0, ctx.clock());
    return "holiday";
  }
  const parsed = dataset === "cash_bhav" ? readCashFile(ctx, day, response.body) : readFoFile(ctx, day, response.body);
  if (parsed.kind === "mismatch") {
    ctx.log.warn("NSE served a file for another date; treated as no data", { dataset, day: isoDay(day), note: parsed.note });
    if (day < today) markDay(ctx.db, dataset, day, "mismatch", 0, ctx.clock(), parsed.note);
    return "mismatch";
  }
  const rows = parsed.store();
  if (parsed.badRows) ctx.log.warn("some rows couldn't be read", { dataset, day: isoDay(day), badRows: parsed.badRows });
  ctx.log.info("NSE file stored", { dataset, day: isoDay(day), rows });
  return "ok";
}

export interface SyncResult {
  stored: number;
  failed: number;
  /** Why the run stopped early, or null. */
  stopped: string | null;
}

/**
 * Import `days` oldest first (so the cash bhavcopy can extend daily candles in
 * order). Stops after MAX_CONSECUTIVE_FAILURES hard failures in a row.
 */
export async function syncDays(ctx: NseContext, dataset: DayDataset, days: number[], shouldStop: () => boolean = () => false, onDay?: (day: number, outcome: DayOutcome | "failed") => void): Promise<SyncResult> {
  const result: SyncResult = { stored: 0, failed: 0, stopped: null };
  let consecutive = 0;
  let lastError = "";
  for (const day of [...days].sort((a, b) => a - b)) {
    if (shouldStop()) {
      result.stopped = "stopped";
      break;
    }
    try {
      const outcome = await importDay(ctx, dataset, day);
      if (outcome === "ok") result.stored += 1;
      consecutive = 0;
      onDay?.(day, outcome);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      ctx.log.warn("NSE day failed", { dataset, day: isoDay(day), error: lastError });
      result.failed += 1;
      consecutive += 1;
      onDay?.(day, "failed");
      if (consecutive >= MAX_CONSECUTIVE_FAILURES) {
        result.stopped = `NSE refused ${consecutive} days in a row (${lastError}); stopped so as not to hammer it.`;
        break;
      }
    }
  }
  const ok = result.failed === 0 && !result.stopped;
  recordRun(ctx.db, dataset, { at: ctx.clock(), ok, error: result.stopped ?? (result.failed ? `${result.failed} day(s) failed: ${lastError}` : null) });
  return result;
}

/** The recent days a dataset is missing (the evening run and the catch-up on start). */
export function recentDays(ctx: NseContext, dataset: DayDataset, lookbackDays: number): number[] {
  const { day: today, minutes } = istParts(ctx.clock());
  const from = today - lookbackDays * DAY_MS;
  return daysToCheck({ today, minutes, from, publishMin: PUBLISH_MIN[dataset], checked: checkedDays(ctx.db, dataset, from), recheck: ["mismatch"] });
}

async function guarded(ctx: NseContext, name: "lots" | "fo_ban" | "results", run: () => Promise<Record<string, unknown>>): Promise<boolean> {
  try {
    const info = await run();
    recordRun(ctx.db, name, { at: ctx.clock(), ok: true, info });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.log.warn("NSE dataset refresh failed", { dataset: name, error: message });
    recordRun(ctx.db, name, { at: ctx.clock(), ok: false, error: message });
    return false;
  }
}

/** Lot sizes from NSE's fo_mktlots.csv; the latest F&O bhavcopy's lots when that file is unavailable. */
export function refreshLots(ctx: NseContext): Promise<boolean> {
  return guarded(ctx, "lots", async () => {
    let lots: Record<string, number> = {};
    let source = "nse_mktlots";
    try {
      const response = await ctx.nse.get(`${ctx.urls.archiveUrl}/content/fo/fo_mktlots.csv`, { Accept: "text/csv,*/*" });
      if (response.status === 200) lots = parseNseLots(response.body.toString("utf8"));
    } catch (error) {
      ctx.log.warn("NSE lot file unavailable", { error });
    }
    if (Object.keys(lots).length < 50) {
      lots = lotsFromFoBhav(ctx.db);
      source = "fo_bhavcopy";
    }
    if (Object.keys(lots).length < 50) throw new Error(`only ${Object.keys(lots).length} lot sizes found`);
    writeLots(ctx.db, lots);
    return { source, count: Object.keys(lots).length };
  });
}

export function refreshBan(ctx: NseContext): Promise<boolean> {
  return guarded(ctx, "fo_ban", async () => {
    const response = await ctx.nse.get(`${ctx.urls.archiveUrl}/content/fo/fo_secban.csv`, { Accept: "text/csv,*/*" });
    if (response.status !== 200) throw new Error(`NSE ban list ${response.status}`);
    const list = parseFnoBan(response.body.toString("utf8"));
    if (list.tradeDate === null) throw new Error("ban list has no trade date (format change?)");
    writeBan(ctx.db, list.tradeDate, list.symbols, ctx.clock());
    return { tradeDate: isoDay(list.tradeDate), count: list.symbols.length };
  });
}

/** NSE serves its JSON API only to a browser-like session: load the home page for cookies first. */
export function refreshResults(ctx: NseContext): Promise<boolean> {
  return guarded(ctx, "results", async () => {
    const home = await ctx.nse.get(`${ctx.urls.wwwUrl}/`, { Accept: "text/html" });
    const cookie = home.setCookies.map((value) => value.split(";")[0]).filter(Boolean).join("; ");
    const response = await ctx.nse.get(`${ctx.urls.wwwUrl}/api/event-calendar`, {
      Accept: "application/json, text/plain, */*",
      Referer: `${ctx.urls.wwwUrl}/companies-listing/corporate-filings-event-calendar`,
      ...(cookie ? { Cookie: cookie } : {}),
    });
    if (response.status !== 200) throw new Error(`NSE event calendar ${response.status}`);
    let json: unknown;
    try {
      json = JSON.parse(response.body.toString("utf8"));
    } catch {
      throw new Error("NSE event calendar isn't JSON");
    }
    const events = parseCalendar(json);
    writeResults(ctx.db, events);
    return { count: events.length };
  });
}
