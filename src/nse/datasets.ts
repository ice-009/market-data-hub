import type { Db } from "../db.js";
import type { DiskFloor } from "../disk.js";
import { deriveFactors } from "../history/adjustments.js";
import { applyCashBhav } from "../history/fromBhav.js";
import { syncIndexSeries } from "../history/fromIndices.js";
import type { Logger } from "../log.js";
import { calendar } from "../calendar/calendar.js";
import { CALENDAR_NOTE, isListedHoliday } from "../calendar/store.js";
import { DAY_MS, isoDay, istParts, isWeekday } from "../time.js";
import { NseError, type NseClient } from "./client.js";
import { parseCashBhav, type CashBhavParse } from "./parsers/cashBhav.js";
import { parseCmBhav } from "./parsers/cmBhav.js";
import { corporateActionsFileDay, parseCorporateActions, type CorporateActionRow } from "./parsers/corporateActions.js";
import { aggregateStockFutures, parseFoBhav, parseFoBhavLegacy } from "./parsers/foBhav.js";
import { parseIndexClose } from "./parsers/indexClose.js";
import { mtoKey, parseMto } from "./parsers/mto.js";
import { parseFnoBan } from "./parsers/ban.js";
import { parseNseLots } from "./parsers/lots.js";
import { boardMeetingsFileDay, parseBoardMeetings, resultsEvents } from "./parsers/results.js";
import { parseSymbolChanges } from "./parsers/symbolChange.js";
import { dayStatuses, lotsFromFoBhav, markDay, recordRun, writeBan, writeCashDay, writeCorporateActions, writeFoDay, writeIndexDay, writeIsins, writeLots, writePrDay, writeSymbolChanges, type DayDataset, type DayStatus } from "./store.js";
import { ZipError, isZip, unzipFile, unzipSingle } from "./unzip.js";
import { writeOptionDay } from "./optionStore.js";
import { summarizeFoCsv } from "./optionFile.js";

// NSE's daily files, downloaded from its free public archive — no broker calls:
//   cash_bhav  sec_bhavdata_full_DDMMYYYY.csv: close, volume, delivery % per stock
//   fo_bhav    BhavCopy_NSE_FO_0_0_0_YYYYMMDD_F_0000.csv.zip (UDiFF): stock futures OI
//   index_close  content/indices/ind_close_all_DDMMYYYY.csv: every NSE index's OHLC
//              (from Feb/Mar 2012); extends index candles (src/history/fromIndices.ts)
//   lots       fo_mktlots.csv (fallback: the lot column of the latest F&O bhavcopy)
//   fo_ban     fo_secban.csv
//   pr         PRDDMMYY.zip, the daily "PR" bundle (since 2010): its board-meetings file
//              bmDDMMYYYY.txt fills the results calendar, its corporate-actions file
//              bcDDMMYYYY.csv the corporate actions (bonus, split, dividend… with ex-dates)
//   symbol_changes  content/equities/symbolchange.csv: every ticker rename since 1999
// Nothing comes from www.nseindia.com: its JSON API (the event calendar the
// results used to come from) hangs behind bot protection since Nov 2026.
// Days up to 5 Jul 2024 come from the archive's older formats (src/jobs/nseHistory.ts
// downloads them back to 1994): the cash bhavcopy cmDDMONYYYYbhav.csv.zip plus
// the delivery file MTO_DDMMYYYY.DAT, and the F&O bhavcopy foDDMONYYYYbhav.csv.zip.
// The old cash files also carry each security's ISIN (from 2011), recorded in
// isin_symbols to join renamed tickers. NSE's archive has been seen to serve
// another day's file for a holiday URL, so the trade date written inside a file
// (for the PR zip, in its board-meetings file's name) must equal the date asked for.

export interface NseContext {
  db: Db;
  nse: NseClient;
  log: Logger;
  urls: { archiveUrl: string };
  clock: () => number;
  /** The free space NSE history downloads leave on the database's disk (HUB_DISK_MIN_GB); absent = no check. */
  disk?: DiskFloor;
  /** No broker: stored daily series are built from the archive and its adjustment factors (dropped when those change). */
  endOfDay?: boolean;
}

/** Don't ask for today's file before this (minutes after IST midnight). */
export const PUBLISH_MIN: Record<DayDataset, number> = { cash_bhav: 17 * 60 + 30, fo_bhav: 18 * 60, pr: 17 * 60 + 30, index_close: 18 * 60 };

/**
 * Weekend days NSE held a session on (cash, F&O and index files all stored),
 * from the checked-in calendar (reference/holidays/<year>.json, `sessions`).
 * Add new ones there: a Budget day or Diwali's Muhurat session on a weekend, a
 * special session (or, without a release, `hub data calendar session`).
 * `hub data quality` reports any it finds unlisted (unlisted_session) once an
 * NSE history download has fetched the weekends.
 */
export const WEEKEND_SESSIONS: readonly number[] = [...calendar().listedSessions.keys()].filter((day) => !isWeekday(day)).sort((a, b) => a - b);

/**
 * Sessions whose file NSE's archive doesn't have (every URL tried answers
 * 404), checked by hand: the data-quality check reports them as known gaps
 * (info), not as missing sessions.
 *   fo_bhav 30 Mar 2021: fo30MAR2021bhav.csv.zip and the UDiFF name both 404;
 *   the day's F&O market-activity report (archives/fo/mkt/fo30032021.zip)
 *   exists but has no settlement price, change in OI, underlying or lot.
 */
export const ARCHIVE_GAPS: Readonly<Record<DayDataset, readonly number[]>> = {
  cash_bhav: [],
  fo_bhav: [Date.UTC(2021, 2, 30)],
  pr: [],
  index_close: [],
};

/** The last session of NSE's old file formats (Fri 5 Jul 2024); the current ones start on Mon 8 Jul 2024. */
export const LEGACY_LAST_DAY = Date.UTC(2024, 6, 5);

/**
 * The first session worth asking NSE's archive for: the cash market's first (3
 * Nov 1994), the first with stock futures (9 Nov 2001; F&O files from 12 Jun
 * 2000 have index futures only, and only stock futures are stored), the PR
 * zip's first year (2010; 2008 and 2009 answer 404) and NSE's index file's
 * start in the second half of Feb 2012 (15 Feb: none; 1 Mar: there).
 */
export const ARCHIVE_FROM: Record<DayDataset, number> = { cash_bhav: Date.UTC(1994, 10, 3), fo_bhav: Date.UTC(2001, 10, 9), pr: Date.UTC(2010, 0, 1), index_close: Date.UTC(2012, 1, 16) };

/** Delivery positions (MTO files) start in 2002 (none in 2001 when checked); earlier days have no delivery %. */
export const MTO_FROM = Date.UTC(2002, 0, 1);

/**
 * The old cash bhavcopy has an ISIN column from 2011 (cm04JAN2010 has none,
 * cm28JUN2011 has it). Stored days from here to LEGACY_LAST_DAY whose ISINs
 * weren't read (downloaded before the hub kept them) are read again by
 * `hub data nse-history`; earlier days aren't asked for.
 */
export const ISIN_FROM = Date.UTC(2011, 0, 1);

/** Stop a run after this many days in a row fail hard (403/429/timeouts after retries). */
export const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * Days from `from` through `today` (day keys) that still need a download,
 * newest first: weekdays plus the weekend days the calendar has a session on
 * (every weekend day with `weekends`, for history where NSE's Budget-day and
 * Muhurat sessions aren't listed). Listed holidays stay in: importDay records
 * them without asking NSE. Today counts only after `publishMin`. `recheck`
 * lists statuses worth asking again. Pure, given the calendar.
 */
export function daysToCheck(params: { today: number; minutes: number; from: number; publishMin: number; checked: ReadonlyMap<number, string>; recheck?: readonly string[]; weekends?: boolean }): number[] {
  const { today, minutes, from, publishMin, checked, recheck = [], weekends = false } = params;
  const out: number[] = [];
  for (let day = today; day >= from; day -= DAY_MS) {
    const weekday = new Date(day).getUTCDay();
    if ((weekday === 0 || weekday === 6) && !weekends && !calendar().isTradingDay(day)) continue;
    if (day === today && minutes < publishMin) continue;
    const status = checked.get(day);
    if (status === undefined || recheck.includes(status)) out.push(day);
  }
  return out;
}

const ddmmyyyy = (day: number) => isoDay(day).split("-").reverse().join("");
const ddmmyy = (day: number) => ddmmyyyy(day).slice(0, 4) + ddmmyyyy(day).slice(6);
const yyyymmdd = (day: number) => isoDay(day).replaceAll("-", "");
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
/** The old archive's path for a day: "2010/JAN" and "04JAN2010". */
const legacyParts = (day: number) => {
  const date = new Date(day);
  const year = date.getUTCFullYear();
  const month = MONTHS[date.getUTCMonth()];
  return { folder: `${year}/${month}`, stamp: `${String(date.getUTCDate()).padStart(2, "0")}${month}${year}` };
};

export const isLegacyDay = (day: number) => day <= LEGACY_LAST_DAY;

export function cashBhavUrl(archiveUrl: string, day: number): string {
  if (!isLegacyDay(day)) return `${archiveUrl}/products/content/sec_bhavdata_full_${ddmmyyyy(day)}.csv`;
  const { folder, stamp } = legacyParts(day);
  return `${archiveUrl}/content/historical/EQUITIES/${folder}/cm${stamp}bhav.csv.zip`;
}

export function foBhavUrl(archiveUrl: string, day: number): string {
  if (!isLegacyDay(day)) return `${archiveUrl}/content/fo/BhavCopy_NSE_FO_0_0_0_${yyyymmdd(day)}_F_0000.csv.zip`;
  const { folder, stamp } = legacyParts(day);
  return `${archiveUrl}/content/historical/DERIVATIVES/${folder}/fo${stamp}bhav.csv.zip`;
}

export const indexCloseUrl = (archiveUrl: string, day: number) => `${archiveUrl}/content/indices/ind_close_all_${ddmmyyyy(day)}.csv`;

export const mtoUrl = (archiveUrl: string, day: number) => `${archiveUrl}/archives/equities/mto/MTO_${ddmmyyyy(day)}.DAT`;

export const prUrl = (archiveUrl: string, day: number) => `${archiveUrl}/archives/equities/bhavcopy/pr/PR${ddmmyy(day)}.zip`;

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

function fromZip<T>(body: Buffer, read: () => T): T {
  if (!isZip(body)) throw new NseError("NSE sent something that isn't a zip file", null, true);
  try {
    return read();
  } catch (error) {
    // A broken zip is usually a cut-off download: worth another try.
    throw new NseError(`bad zip: ${(error as ZipError).message}`, null, true);
  }
}

export const unzipped = (body: Buffer): string => fromZip(body, () => unzipSingle(body).data.toString("utf8"));

export interface ImportOptions {
  /** Extend stored daily candles from a cash day (the evening run). History downloads don't: the days are older than any series' end. */
  extend?: boolean;
}

/**
 * Parse a cash bhavcopy body for `day` (zipped, in the old format, up to
 * LEGACY_LAST_DAY). `delivery` adds delivery % to an old-format day's rows.
 */
export function readCashFile(ctx: NseContext, day: number, body: Buffer, options: ImportOptions & { delivery?: ReadonlyMap<string, number> } = {}): DayParse {
  const parsed: CashBhavParse = isLegacyDay(day) ? parseCmBhav(unzipped(body)) : parseCashBhav(body.toString("utf8"));
  const wrong = checkDate(parsed.tradeDate, parsed.mixedDates, day);
  if (wrong) return { kind: "mismatch", note: wrong };
  if (!parsed.rows.length) throw new NseError("no EQ rows in the cash bhavcopy (format change?)", null, false);
  const { delivery, extend = true } = options;
  const rows = delivery ? parsed.rows.map((row) => ({ ...row, deliveryPct: delivery.get(mtoKey(row.symbol, row.series)) ?? null })) : parsed.rows;
  return {
    kind: "ok",
    badRows: parsed.badRows,
    store: () => {
      writeCashDay(ctx.db, day, rows, ctx.clock());
      if (isLegacyDay(day)) writeIsins(ctx.db, day, rows);
      // The evening's day (and any stored after it): its ex-dates, before the stored series are extended.
      // A history download derives everything once at the end of its run instead.
      if (extend) {
        deriveFactors(ctx.db, { from: day });
        applyCashBhav(ctx.db, day, rows, ctx.log);
      }
      return rows.length;
    },
  };
}

/**
 * Delivery % for an old-format cash day, from its MTO file: null when NSE has
 * none (before 2002, or a 404) or serves another day's. A refused request
 * throws, so the day is tried again rather than stored without it.
 */
async function legacyDelivery(ctx: NseContext, day: number): Promise<Map<string, number> | null> {
  if (day < MTO_FROM) return null;
  const response = await ctx.nse.get(mtoUrl(ctx.urls.archiveUrl, day));
  if (response.status === 404) return null;
  const parsed = parseMto(response.body.toString("utf8"));
  if (parsed.tradeDate !== day) {
    ctx.log.warn("NSE delivery file is for another date; day stored without delivery %", { day: isoDay(day), fileDate: parsed.tradeDate === null ? null : isoDay(parsed.tradeDate) });
    return null;
  }
  return parsed.deliveryPct;
}

/**
 * Parse a zipped F&O bhavcopy for `day` (the old format up to LEGACY_LAST_DAY):
 * stock futures, and the day's option summaries (src/nse/optionFile.ts) —
 * stored with it unless they couldn't be computed (logged; the day's options
 * are then read again by `hub data nse-history --only options`).
 */
export function readFoFile(ctx: NseContext, day: number, body: Buffer): DayParse {
  const csv = unzipped(body);
  const parsed = isLegacyDay(day) ? parseFoBhavLegacy(csv) : parseFoBhav(csv);
  const wrong = checkDate(parsed.tradeDate, parsed.mixedDates, day);
  if (wrong) return { kind: "mismatch", note: wrong };
  if (!parsed.contracts.length) throw new NseError("no stock-futures rows in the F&O bhavcopy (format change?)", null, false);
  const records = aggregateStockFutures(parsed.contracts, day);
  let options: ReturnType<typeof summarizeFoCsv> | null = null;
  try {
    options = summarizeFoCsv(day, csv);
  } catch (error) {
    ctx.log.warn("option summaries couldn't be computed; the futures are stored without them", { day: isoDay(day), error });
  }
  return {
    kind: "ok",
    badRows: parsed.badRows,
    store: () => {
      writeFoDay(ctx.db, day, records, ctx.clock());
      if (options?.kind === "ok") writeOptionDay(ctx.db, day, options.summaries, ctx.clock());
      return records.length;
    },
  };
}

/** Parse NSE's index file for `day`; `extend` (the evening run) also extends the index candles. */
export function readIndexFile(ctx: NseContext, day: number, body: Buffer, options: ImportOptions = {}): DayParse {
  const parsed = parseIndexClose(body.toString("utf8"), day);
  const wrong = checkDate(parsed.tradeDate, parsed.mixedDates, day);
  if (wrong) return { kind: "mismatch", note: wrong };
  if (!parsed.rows.length) throw new NseError("no rows in the index file (format change?)", null, false);
  const { extend = true } = options;
  return {
    kind: "ok",
    badRows: parsed.badRows,
    store: () => {
      writeIndexDay(ctx.db, day, parsed.rows, ctx.clock());
      if (extend) syncIndexSeries(ctx.db, ctx.clock(), day);
      return parsed.rows.length;
    },
  };
}

/**
 * Read a PR zip for `day`: the financial-results meetings in its board-meetings
 * file (the results calendar) and the rows of its corporate-actions file. The
 * date in the board-meetings file's name must be `day`.
 */
export function readPrFile(ctx: NseContext, day: number, body: Buffer): DayParse {
  const file = fromZip(body, () => unzipFile(body, (name) => boardMeetingsFileDay(name) !== null));
  if (!file) throw new NseError("no board-meetings file in the PR zip (format change?)", null, false);
  const wrong = checkDate(boardMeetingsFileDay(file.name.split("/").pop()!), false, day);
  if (wrong) return { kind: "mismatch", note: wrong };
  const parsed = parseBoardMeetings(file.data.toString("utf8"));
  const events = resultsEvents(parsed.meetings);
  const actions = readCorporateActionsFile(ctx, day, body);
  return {
    kind: "ok",
    badRows: parsed.badRows + (actions?.badRows ?? 0),
    store: () => {
      writePrDay(ctx.db, day, events, ctx.clock());
      if (actions) writeCorporateActions(ctx.db, day, actions.rows);
      return events.length;
    },
  };
}

/**
 * The equity rows of a PR zip's corporate-actions file (bcDDMMYYYY.csv), or
 * null when the zip has none or it's for another date (logged).
 */
function readCorporateActionsFile(ctx: NseContext, day: number, body: Buffer): { rows: CorporateActionRow[]; badRows: number } | null {
  const file = fromZip(body, () => unzipFile(body, (name) => corporateActionsFileDay(name.split("/").pop()!) !== null));
  if (!file) {
    ctx.log.warn("no corporate-actions file in the PR zip", { day: isoDay(day) });
    return null;
  }
  const fileDay = corporateActionsFileDay(file.name.split("/").pop()!);
  if (fileDay !== day) {
    ctx.log.warn("the PR zip's corporate-actions file is for another date; not read", { day: isoDay(day), fileDate: fileDay === null ? null : isoDay(fileDay) });
    return null;
  }
  const parsed = parseCorporateActions(file.data.toString("utf8"));
  return { rows: parsed.rows, badRows: parsed.badRows };
}

/**
 * Read only the corporate actions of a stored PR day (one downloaded before the
 * hub kept them): the results events and nse_days aren't touched. A day without
 * a usable bc file is recorded as read, with no rows, so it isn't asked for
 * again. Throws NseError when NSE won't serve it.
 */
export async function importCorporateActions(ctx: NseContext, day: number): Promise<DayOutcome> {
  const response = await ctx.nse.get(prUrl(ctx.urls.archiveUrl, day));
  if (response.status === 404) {
    writeCorporateActions(ctx.db, day, []);
    return "holiday";
  }
  const actions = readCorporateActionsFile(ctx, day, response.body);
  writeCorporateActions(ctx.db, day, actions?.rows ?? []);
  return actions ? "ok" : "mismatch";
}

/** nse_days note of a past day NSE answered with an empty file (HTTP 200, no bytes). */
export const EMPTY_FILE_NOTE = "NSE served an empty file";

const DAY_URL: Record<DayDataset, (archiveUrl: string, day: number) => string> = { cash_bhav: cashBhavUrl, fo_bhav: foBhavUrl, pr: prUrl, index_close: indexCloseUrl };

/**
 * Download, check and store one day. A day the calendar lists as an exchange
 * holiday (NSE's list, or `hub data calendar`) is recorded as one without
 * asking NSE, whose archive answers such days with another day's file.
 * Throws NseError when NSE won't serve it.
 */
export async function importDay(ctx: NseContext, dataset: DayDataset, day: number, options: ImportOptions = {}): Promise<DayOutcome> {
  if (isListedHoliday(calendar(), day)) {
    markDay(ctx.db, dataset, day, "holiday", 0, ctx.clock(), CALENDAR_NOTE);
    ctx.log.debug("exchange holiday: NSE not asked", { dataset, day: isoDay(day), holiday: calendar().info(day).name });
    return "holiday";
  }
  const url = DAY_URL[dataset](ctx.urls.archiveUrl, day);
  const response = await ctx.nse.get(url);
  const today = istParts(ctx.clock()).day;
  if (response.status === 404) {
    // Today's file may just not be out yet; an earlier weekday without a file is a holiday.
    if (day >= today) return "not_yet";
    markDay(ctx.db, dataset, day, "holiday", 0, ctx.clock());
    return "holiday";
  }
  // NSE answers some old days with 200 and nothing in it (cm06SEP1995bhav.csv.zip): no file, like a 404 —
  // not a broken download to retry forever, which left the day unchecked and cut daily candles off at 7 Sep 1995 (#59).
  if (!response.body.length) {
    if (day >= today) return "not_yet";
    markDay(ctx.db, dataset, day, "holiday", 0, ctx.clock(), EMPTY_FILE_NOTE);
    ctx.log.warn("NSE served an empty file; the day is recorded as having none", { dataset, day: isoDay(day) });
    return "holiday";
  }
  let parsed: DayParse;
  if (dataset === "fo_bhav") parsed = readFoFile(ctx, day, response.body);
  else if (dataset === "pr") parsed = readPrFile(ctx, day, response.body);
  else if (dataset === "index_close") parsed = readIndexFile(ctx, day, response.body, options);
  else {
    parsed = readCashFile(ctx, day, response.body, options);
    // An old-format day's delivery % is a second file, asked for only once the prices check out.
    if (parsed.kind === "ok" && isLegacyDay(day)) {
      const delivery = await legacyDelivery(ctx, day);
      if (delivery) parsed = readCashFile(ctx, day, response.body, { ...options, delivery });
    }
  }
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

/**
 * Read only the ISINs of a stored old-format cash day (one that was downloaded
 * before the hub kept them): the prices and delivery % stored are left as they
 * are, and nse_days isn't touched. Throws NseError when NSE won't serve it.
 */
export async function importIsins(ctx: NseContext, day: number): Promise<DayOutcome> {
  if (!isLegacyDay(day)) throw new Error(`${isoDay(day)} is in NSE's current format, which has no ISIN column`);
  const response = await ctx.nse.get(cashBhavUrl(ctx.urls.archiveUrl, day));
  if (response.status === 404) {
    writeIsins(ctx.db, day, []);
    return "holiday";
  }
  const parsed = parseCmBhav(unzipped(response.body));
  const wrong = checkDate(parsed.tradeDate, parsed.mixedDates, day);
  if (wrong) {
    ctx.log.warn("NSE served a file for another date; its ISINs weren't read", { day: isoDay(day), note: wrong });
    return "mismatch";
  }
  writeIsins(ctx.db, day, parsed.rows);
  return "ok";
}

export interface SyncResult {
  stored: number;
  failed: number;
  /** Why the run stopped early, or null. */
  stopped: string | null;
}

export interface SyncOptions extends ImportOptions {
  /**
   * Record the run in `datasets` (the scheduler spaces its evening retries by
   * it, and status reports it). History downloads don't, so they never delay
   * or mask the evening run.
   */
  record?: boolean;
  /** Read only the ISINs of stored old-format cash days (importIsins). */
  isinsOnly?: boolean;
  /** Read only the corporate actions of stored PR days (importCorporateActions). */
  actionsOnly?: boolean;
  /** Read each day with this instead (the option summaries of stored F&O days: src/nse/optionFile.ts). */
  importer?: (ctx: NseContext, day: number) => Promise<DayOutcome>;
}

/**
 * Import `days` oldest first (so the cash bhavcopy can extend daily candles in
 * order). Stops after MAX_CONSECUTIVE_FAILURES hard failures in a row.
 */
export async function syncDays(ctx: NseContext, dataset: DayDataset, days: number[], shouldStop: () => boolean = () => false, onDay?: (day: number, outcome: DayOutcome | "failed") => void, options: SyncOptions = {}): Promise<SyncResult> {
  const { record = true, isinsOnly = false, actionsOnly = false, importer, ...importOptions } = options;
  const result: SyncResult = { stored: 0, failed: 0, stopped: null };
  let consecutive = 0;
  let lastError = "";
  for (const day of [...days].sort((a, b) => a - b)) {
    if (shouldStop()) {
      result.stopped = "stopped";
      break;
    }
    try {
      const outcome = importer ? await importer(ctx, day) : isinsOnly ? await importIsins(ctx, day) : actionsOnly ? await importCorporateActions(ctx, day) : await importDay(ctx, dataset, day, importOptions);
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
  if (record)
    recordRun(ctx.db, dataset, { at: ctx.clock(), ok, error: result.stopped ?? (result.failed ? `${result.failed} day(s) failed: ${lastError}` : null) });
  return result;
}

/**
 * The recent days a dataset is missing (the evening run and the catch-up on
 * start): days never asked for in the last `lookbackDays`, plus `mismatch` days
 * in the last `recheckDays`.
 */
export function recentDays(ctx: NseContext, dataset: DayDataset, lookbackDays: number, recheckDays = lookbackDays): number[] {
  const { day: today, minutes } = istParts(ctx.clock());
  const from = today - lookbackDays * DAY_MS;
  const checked = dayStatuses(ctx.db, dataset, from);
  const recheckFrom = today - recheckDays * DAY_MS;
  return daysToCheck({ today, minutes, from, publishMin: PUBLISH_MIN[dataset], checked, recheck: ["mismatch"] }).filter((day) => day >= recheckFrom || !checked.has(day));
}

async function guarded(ctx: NseContext, name: "lots" | "fo_ban" | "symbol_changes", run: () => Promise<Record<string, unknown>>): Promise<boolean> {
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

/** Fewer rows than this means a cut-off or changed file (NSE's list had 1,080 in Nov 2026): keep the stored one. */
export const MIN_SYMBOL_CHANGES = 100;

/** NSE's ticker renames (symbolchange.csv), replacing the stored list. */
export function refreshSymbolChanges(ctx: NseContext): Promise<boolean> {
  return guarded(ctx, "symbol_changes", async () => {
    const response = await ctx.nse.get(`${ctx.urls.archiveUrl}/content/equities/symbolchange.csv`, { Accept: "text/csv,*/*" });
    if (response.status !== 200) throw new Error(`NSE symbol changes ${response.status}`);
    const parsed = parseSymbolChanges(response.body.toString("utf8"));
    if (parsed.rows.length < MIN_SYMBOL_CHANGES) throw new Error(`only ${parsed.rows.length} symbol changes found (format change?)`);
    if (parsed.badRows) ctx.log.warn("some symbol changes couldn't be read", { badRows: parsed.badRows });
    writeSymbolChanges(ctx.db, parsed.rows);
    return { count: parsed.rows.length };
  });
}
