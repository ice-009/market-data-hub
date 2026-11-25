import type { DayDataset, DayStatus } from "../nse/store.js";
import { DAY_MS, isoDay, isWeekday } from "../time.js";
import type { Finding } from "./store.js";

// The data-quality checks, as pure functions of what's stored (the runner,
// ./run.ts, reads the tables and saves the findings). Each finding names the
// trade day and the subject it's about, in words a person can act on.
//
//   missing_session   a session (another NSE file of that day is stored) whose file
//                     NSE answered with 404 or with another day's file; info
//                     for a known gap in NSE's archive (ARCHIVE_GAPS)       problem / info
//   unlisted_session  a weekend session the hub's calendar (reference/holidays,
//                     `hub data calendar`) doesn't list, so the evening run
//                     won't expect its files                                warning
//   calendar_mismatch NSE's archive disagrees with the holiday list: files for a
//                     listed holiday, or none for a weekday of a listed year
//                     that the list doesn't name                            warning
//   wrong_date        NSE served another day's file for a weekday and nothing
//                     confirms it was a holiday                             warning
//   repeated_file     a cash bhavcopy whose prices repeat the previous session's  problem
//   candle_gap        stored daily candles lack a session the stock traded  warning
//   price_outlier     a close-to-close move over OUTLIER_SIGMAS times the stock's
//                     recent volatility that no corporate action explains;
//                     a warning beyond NSE's widest price band (20%), else info  warning / info
//   broker_mismatch   stored (broker) daily closes differ from NSE's bhavcopy;
//                     info when the difference is a corporate action the broker
//                     adjusted for and the raw archive isn't yet            warning / info
//   lot_change        lot sizes that changed between two F&O sessions       info
//   fo_list_change    stocks that joined or left the F&O list; a list that
//                     loses a tenth or more at once, other than stocks whose
//                     last contract just expired (a cut-off file)         info / problem
//   lot_file_mismatch NSE's lot file disagrees with the newest F&O bhavcopy  warning

export const DATASET_LABEL: Record<DayDataset, string> = { cash_bhav: "Cash bhavcopy", fo_bhav: "F&O bhavcopy", pr: "PR zip", index_close: "Index file" };

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Thu 15 Jan 2026". */
export function dayName(day: number): string {
  const date = new Date(day);
  return `${WEEKDAYS[date.getUTCDay()]} ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}
const thousands = (value: number) => value.toLocaleString("en-IN");
const list = (items: string[], max = 8) => `${items.slice(0, max).join(", ")}${items.length > max ? ` and ${items.length - max} more` : ""}`;
const plural = (count: number, one: string, many = `${one}s`) => `${thousands(count)} ${count === 1 ? one : many}`;

// ------------------------------------------------------------------ the session calendar

export interface DayRecord {
  status: DayStatus;
  note: string | null;
}

export interface CalendarInput {
  /** Every asked day per dataset (nse_days). */
  days: Record<DayDataset, ReadonlyMap<number, DayRecord>>;
  /** Weekend days the hub knows NSE traded on (WEEKEND_SESSIONS). */
  weekendSessions: readonly number[];
  /** Weekend sessions older than this are reported as info, not warnings (the evening run is long past them). */
  recentFrom: number;
  /** Sessions NSE's archive has no file for, per dataset (ARCHIVE_GAPS): reported as info. */
  archiveGaps?: Partial<Record<DayDataset, readonly number[]>>;
  /**
   * The holiday list (src/calendar): holidays named by NSE's list or a person
   * (without a special session that day), by day; and the years whose list is known.
   */
  listed?: { holidays: ReadonlyMap<number, string>; years: ReadonlySet<number> };
  /** nse_days note of a holiday recorded from the list without asking NSE: not evidence from the archive. */
  calendarNote?: string;
}

/** Datasets whose "ok" proves a day was a session. The PR zip isn't one (it's a bundle of notices). */
const SESSION_EVIDENCE: readonly DayDataset[] = ["cash_bhav", "fo_bhav", "index_close"];
const CALENDAR_DATASETS: readonly DayDataset[] = ["cash_bhav", "fo_bhav", "index_close", "pr"];

/**
 * missing_session, unlisted_session, calendar_mismatch and wrong_date, from
 * the days NSE was asked for. A day is a session when any of the cash, F&O or
 * index files is stored for it, and a holiday when NSE has no file for it (404)
 * — a weekday file "for another date" counts as a holiday once another
 * dataset's 404, or the holiday list, confirms it.
 */
export function calendarFindings(input: CalendarInput): Finding[] {
  const out: Finding[] = [];
  const allDays = new Set<number>();
  for (const dataset of CALENDAR_DATASETS) for (const day of input.days[dataset].keys()) allDays.add(day);
  for (const day of [...allDays].sort((a, b) => a - b)) {
    const evidence = SESSION_EVIDENCE.filter((dataset) => input.days[dataset].get(day)?.status === "ok");
    const listed = isWeekday(day) || input.weekendSessions.includes(day);
    const listedHoliday = input.listed?.holidays.get(day);
    if (evidence.length && listedHoliday !== undefined) {
      out.push({
        check: "calendar_mismatch",
        day,
        subject: "calendar",
        severity: "warning",
        message: `NSE's archive has files for ${dayName(day)} (${evidence.map((dataset) => DATASET_LABEL[dataset]).join(" and ")}), which the hub's calendar lists as a holiday (${listedHoliday}): a special session? If so, add it with \`hub data calendar session ${isoDay(day)} "name"\`.`,
        detail: { evidence, holiday: listedHoliday },
      });
    }
    if (evidence.length) {
      if (!listed) {
        out.push({
          check: "unlisted_session",
          day,
          subject: "calendar",
          severity: day >= input.recentFrom ? "warning" : "info",
          message: `NSE held a session on ${dayName(day)} (${evidence.map((dataset) => DATASET_LABEL[dataset]).join(" and ")} stored), which the hub's calendar doesn't list (reference/holidays, \`hub data calendar session\`): the evening run won't ask for that day's files.`,
          detail: { evidence },
        });
      }
      for (const dataset of CALENDAR_DATASETS) {
        const record = input.days[dataset].get(day);
        if (!record || record.status === "ok") continue;
        const knownGap = record.status === "holiday" && (input.archiveGaps?.[dataset]?.includes(day) ?? false);
        const answered = record.status === "holiday" ? `NSE had no file for it (404)${knownGap ? ", a known gap in its archive" : ""}` : `NSE served another day's file (${record.note ?? "wrong date"})`;
        out.push({
          check: "missing_session",
          day,
          subject: dataset,
          severity: knownGap ? "info" : "problem",
          message: `${DATASET_LABEL[dataset]}: nothing stored for ${dayName(day)}, a session (the ${evidence.filter((other) => other !== dataset).map((other) => DATASET_LABEL[other]).join(" and ")} has it): ${answered}.`,
          detail: { dataset, status: record.status, note: record.note, evidence, ...(knownGap ? { knownGap } : {}) },
        });
      }
      continue;
    }
    if (!listed) continue; // NSE's archive answers weekend URLs with Friday's file: expected.
    if (listedHoliday !== undefined) continue; // the list says so: no file is expected
    const noFile = CALENDAR_DATASETS.filter((dataset) => {
      const record = input.days[dataset].get(day);
      return record?.status === "holiday" && (input.calendarNote === undefined || record.note !== input.calendarNote);
    });
    if (noFile.length) {
      const year = new Date(day).getUTCFullYear();
      if (isWeekday(day) && input.days.cash_bhav.has(day) && input.listed?.years.has(year)) {
        out.push({
          check: "calendar_mismatch",
          day,
          subject: "calendar",
          severity: "warning",
          message: `NSE had no files for ${dayName(day)} (${noFile.map((dataset) => DATASET_LABEL[dataset]).join(" and ")}: 404), a weekday the hub's holiday list for ${year} doesn't name: an unlisted holiday? If so, add it with \`hub data calendar holiday ${isoDay(day)} "name"\`.`,
          detail: { noFile },
        });
      }
      continue;
    }
    for (const dataset of CALENDAR_DATASETS) {
      const record = input.days[dataset].get(day);
      if (record?.status !== "mismatch") continue;
      out.push({
        check: "wrong_date",
        day,
        subject: dataset,
        severity: "warning",
        message: `${DATASET_LABEL[dataset]}: asked for ${dayName(day)}, NSE served another day's file (${record.note ?? "wrong date"}). Nothing confirms it was a holiday yet: the session may be missing.`,
        detail: { dataset, note: record.note },
      });
    }
  }
  return out;
}

// ------------------------------------------------------------------ cash days: outliers and repeated files

/** A move this many times the stock's recent volatility (and at least OUTLIER_MIN_MOVE) is an outlier. */
export const OUTLIER_SIGMAS = 10;
/** Smallest close-to-close move worth flagging, whatever the volatility: 10%. */
export const OUTLIER_MIN_MOVE = 0.1;
/** Volatility is the standard deviation of the last VOL_WINDOW daily log returns… */
export const VOL_WINDOW = 60;
/** …and needs at least this many of them. */
export const VOL_MIN_RETURNS = 20;
/** Volatility is taken as at least 1% a day (ETFs and liquid funds barely move). */
export const SIGMA_FLOOR = 0.01;
/** A stock that last traded longer ago than this (calendar days) isn't judged on its first day back. */
export const MAX_GAP_DAYS = 21;
/** NSE's PREV_CLOSE differing from the stored previous close by more than this is a corporate action (src/history/fromBhav.ts). */
export const PREV_CLOSE_TOLERANCE = 0.015;
/** A lot change explains a move when the two agree within this (log difference). */
export const LOT_AGREEMENT = 0.05;
/** NSE's daily price bands (5%, 10%, 20%); a close within BAND_SLACK of one off NSE's PREV_CLOSE hit its band. */
export const PRICE_BANDS = [0.02, 0.05, 0.1, 0.2] as const;
export const PRICE_BAND_MAX = 0.2;
export const BAND_SLACK = 0.003;
/** A move to within BAND_SLACK of a price band (off NSE's own PREV_CLOSE): a circuit, so most likely real. */
const atPriceBand = (row: { prevClose: number; c: number }) => row.prevClose > 0 && PRICE_BANDS.some((band) => Math.abs(Math.abs(row.c / row.prevClose - 1) - band) <= BAND_SLACK);
/** Half or more of the stocks shared with the previous session repeating its OHLCV exactly: a repeated file. */
export const REPEATED_SHARE = 0.5;
export const REPEATED_MIN_STOCKS = 50;

/**
 * A corporate action known for (symbol, ex-date): `factor` is what the
 * previous close is multiplied by to compare with this day's (0.5 for a 1:2
 * split or 1:1 bonus). The adjustment table (market-data-hub#20) plugs in here;
 * until then the hub uses NSE's PREV_CLOSE and F&O lot changes.
 */
export type CorporateActionHook = (symbol: string, day: number) => { factor: number; source: string } | null;

export interface CashRow {
  symbol: string;
  day: number;
  prevClose: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}


/**
 * Price ratios of common corporate actions: splits (1:2, 1:5, 1:10, 2:5…), bonuses
 * (1:1 → 1/2, 1:2 → 2/3, 2:1 → 1/3, 1:3 → 3/4) and consolidations (2×, 5×, 10×).
 */
const ACTION_RATIOS: ReadonlyArray<[number, string]> = [
  [1 / 2, "1/2"], [1 / 3, "1/3"], [2 / 3, "2/3"], [1 / 4, "1/4"], [3 / 4, "3/4"], [1 / 5, "1/5"], [2 / 5, "2/5"],
  [1 / 6, "1/6"], [1 / 8, "1/8"], [1 / 10, "1/10"], [1 / 20, "1/20"], [2, "2×"], [5, "5×"], [10, "10×"],
];

/**
 * The common corporate-action ratio a big move matches, or null. Deep cuts
 * (half or less) leave room for the day's own move (9%); 2/3 and 3/4 are
 * close to ordinary crashes, so they must match within 1.5%. Exported for tests.
 */
export function actionLike(ratio: number): string | null {
  if (!(ratio > 0) || (ratio > 0.76 && ratio < 1.9)) return null;
  let best: { label: string; off: number } | null = null;
  for (const [candidate, label] of ACTION_RATIOS) {
    const off = Math.abs(Math.log(ratio / candidate));
    const tolerance = candidate <= 0.55 || candidate >= 2 ? 0.09 : 0.015;
    if (off <= tolerance && (!best || off < best.off)) best = { label, off };
  }
  return best?.label ?? null;
}

const stdev = (values: readonly number[]) => {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1));
};

const pct = (ratio: number) => `${ratio >= 1 ? "+" : ""}${((ratio - 1) * 100).toFixed(1)}%`;

/** A price_outlier finding: a warning beyond NSE's widest price band, info within it. */
function outlier(row: CashRow, prev: CashRow, move: number, sigma: number, sigmas: number, action: { factor: number; source: string } | null, like: string | null): Finding {
  const band = Math.abs(move - 1) > PRICE_BAND_MAX + BAND_SLACK ? "beyond" : atPriceBand(row) ? "at" : null;
  const adjusted = action ? `, after a ×${action.factor.toFixed(3)} ${action.source} adjustment` : "";
  const widest = `NSE's widest price band (${PRICE_BAND_MAX * 100}%)`;
  const why =
    band === "beyond" && like
      ? ` Beyond ${widest} and a ${like} price ratio: most likely a split, bonus or other corporate action not adjusted for yet.`
      : band === "beyond"
        ? ` Beyond ${widest}: a corporate action not on record, or a bad price.`
        : band === "at"
          ? " It closed at its price band: most likely a real move."
          : like
            ? ` A ${like} price ratio: possibly a corporate action not adjusted for yet.`
            : "";
  return {
    check: "price_outlier",
    day: row.day,
    subject: row.symbol,
    severity: band === "beyond" ? "warning" : "info",
    message: `${row.symbol}: ${pct(move)} close to close on ${dayName(row.day)} (${prev.c} → ${row.c}${adjusted}), ${sigmas.toFixed(0)}× its daily volatility of ${(sigma * 100).toFixed(1)}%${action ? "" : ", with no corporate action on record"}.${why}`,
    detail: { prevDay: isoDay(prev.day), prevClose: prev.c, close: row.c, nsePrevClose: row.prevClose, move: Number((move - 1).toFixed(4)), sigma: Number(sigma.toFixed(4)), sigmas: Number(sigmas.toFixed(1)), actionLike: like, priceBand: band, adjustedBy: action?.source ?? null },
  };
}

/**
 * Reads the cash bhavcopy one stock at a time (each stock's rows oldest first:
 * the table's own order, so the database reads it sequentially) and reports
 * price outliers on the sessions `report` accepts; earlier sessions only warm
 * up the stock's volatility. Repeated files are counted along the way and
 * reported by `repeated()` once every stock has been read. Pure.
 */
export class CashScanner {
  private readonly counts = new Map<number, { shared: number; repeated: number }>();
  private readonly previousSession = new Map<number, number>();

  constructor(
    private readonly options: {
      /** The stored cash sessions, oldest first (what "the previous session" means). */
      sessions: readonly number[];
      /** Known corporate actions (ex-dates); null where none is known. */
      corporateAction?: CorporateActionHook;
      /** F&O lot factors by `${symbol}|${day}` (old lot / new lot) on days the lot changed. */
      lotFactors?: ReadonlyMap<string, number>;
    },
  ) {
    options.sessions.forEach((day, i) => {
      if (i > 0) this.previousSession.set(day, options.sessions[i - 1]);
    });
  }

  /** One stock's rows, oldest first; its outliers on the days `report` accepts. */
  symbol(rows: readonly CashRow[], report: (day: number) => boolean): Finding[] {
    const out: Finding[] = [];
    const returns: number[] = [];
    let prev: CashRow | null = null;
    for (const row of rows) {
      const last = prev;
      prev = row;
      if (!last) continue;
      const reported = report(row.day);
      if (reported && last.day === this.previousSession.get(row.day)) {
        const count = this.counts.get(row.day) ?? { shared: 0, repeated: 0 };
        count.shared += 1;
        if (last.o === row.o && last.h === row.h && last.l === row.l && last.c === row.c && last.v === row.v) count.repeated += 1;
        this.counts.set(row.day, count);
      }
      if (!(last.c > 0) || !(row.c > 0)) continue;
      const raw = row.c / last.c;
      const action = this.explain(row, last, raw);
      const move = action ? raw / action.factor : raw;
      const logMove = Math.log(move);
      let flagged = false;
      if (reported && returns.length >= VOL_MIN_RETURNS && row.day - last.day <= MAX_GAP_DAYS * DAY_MS) {
        const sigma = Math.max(stdev(returns), SIGMA_FLOOR);
        const sigmas = Math.abs(logMove) / sigma;
        if (sigmas >= OUTLIER_SIGMAS && Math.abs(move - 1) >= OUTLIER_MIN_MOVE) {
          flagged = true;
          out.push(outlier(row, last, move, sigma, sigmas, action, action ? null : actionLike(raw)));
        }
      }
      // Outliers stay out of the volatility, so one bad print doesn't hide the next.
      if (!flagged && !(action === null && actionLike(raw))) {
        returns.push(logMove);
        if (returns.length > VOL_WINDOW) returns.shift();
      }
    }
    return out;
  }

  /** repeated_file for `days`, once every stock has been read. */
  repeated(days: readonly number[]): Finding[] {
    const out: Finding[] = [];
    for (const day of days) {
      const count = this.counts.get(day);
      const previous = this.previousSession.get(day);
      if (!count || previous === undefined || count.shared < REPEATED_MIN_STOCKS || count.repeated / count.shared < REPEATED_SHARE) continue;
      out.push({
        check: "repeated_file",
        day,
        subject: "cash_bhav",
        severity: "problem",
        message: `Cash bhavcopy for ${dayName(day)} repeats ${dayName(previous)}'s prices for ${plural(count.repeated, "stock")} of ${thousands(count.shared)}: probably the previous session's file under a new date.`,
        detail: { previousDay: isoDay(previous), repeated: count.repeated, shared: count.shared },
      });
    }
    return out;
  }

  /** The corporate action behind a move, if any: the hook, NSE's PREV_CLOSE, or an F&O lot change that agrees with it. */
  private explain(row: CashRow, prev: CashRow, raw: number): { factor: number; source: string } | null {
    const hooked = this.options.corporateAction?.(row.symbol, row.day);
    if (hooked && hooked.factor > 0) return hooked;
    if (row.prevClose > 0 && Math.abs(row.prevClose / prev.c - 1) > PREV_CLOSE_TOLERANCE) return { factor: row.prevClose / prev.c, source: "PREV_CLOSE" };
    const lot = this.options.lotFactors?.get(`${row.symbol}|${row.day}`);
    if (lot && Math.abs(Math.log(raw) - Math.log(lot)) <= LOT_AGREEMENT) return { factor: lot, source: "F&O lot change" };
    return null;
  }
}

// ------------------------------------------------------------------ F&O days: lots and the F&O list

/** A list that loses at least this share of its stocks at once (and FO_DROP_MIN) looks cut off. */
export const FO_DROP_SHARE = 0.1;
export const FO_DROP_MIN = 10;

/** lot_change and fo_list_change between two consecutive stored F&O sessions. Pure. */
export function foFindings(
  previous: { day: number; lots: ReadonlyMap<string, number | null>; /** Stocks whose last listed contract expired that day: leaving the list next is expected. */ expired?: ReadonlySet<string> },
  current: { day: number; lots: ReadonlyMap<string, number | null> },
): Finding[] {
  const out: Finding[] = [];
  const added = [...current.lots.keys()].filter((symbol) => !previous.lots.has(symbol)).sort();
  const removed = [...previous.lots.keys()].filter((symbol) => !current.lots.has(symbol)).sort();
  if (added.length || removed.length) {
    // Stocks dropped from F&O leave after their last expiry (34 at once on 28 Jun 2019): only other departures look like a cut-off file.
    const unexpected = removed.filter((symbol) => !previous.expired?.has(symbol)).length;
    const cutOff = unexpected >= FO_DROP_MIN && unexpected >= previous.lots.size * FO_DROP_SHARE;
    const parts = [added.length ? `${plural(added.length, "stock")} added (${list(added)})` : "", removed.length ? `${plural(removed.length, "stock")} removed (${list(removed)})` : ""].filter(Boolean);
    out.push({
      check: "fo_list_change",
      day: current.day,
      subject: "fo",
      severity: cutOff ? "problem" : "info",
      message: cutOff
        ? `F&O list on ${dayName(current.day)}: ${thousands(current.lots.size)} stocks, down from ${thousands(previous.lots.size)} on ${dayName(previous.day)} — probably a cut-off F&O bhavcopy. ${parts.join("; ")}.`
        : `F&O list on ${dayName(current.day)}: ${parts.join("; ")}; ${thousands(current.lots.size)} stocks.`,
      detail: { previousDay: isoDay(previous.day), added, removed, count: current.lots.size },
    });
  }
  const changes = [...current.lots]
    .map(([symbol, lot]) => ({ symbol, from: previous.lots.get(symbol) ?? null, to: lot }))
    .filter((change): change is { symbol: string; from: number; to: number } => change.from !== null && change.to !== null && change.from !== change.to)
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
  if (changes.length) {
    out.push({
      check: "lot_change",
      day: current.day,
      subject: "fo",
      severity: "info",
      message: `Lot sizes changed for ${plural(changes.length, "stock")} on ${dayName(current.day)}: ${list(changes.map((change) => `${change.symbol} ${thousands(change.from)}→${thousands(change.to)}`), 6)}.`,
      detail: { previousDay: isoDay(previous.day), changes },
    });
  }
  return out;
}

/** lot_file_mismatch: NSE's lot file (lot_sizes) against the newest F&O bhavcopy's lots. Pure. */
export function lotFileFindings(fileLots: Readonly<Record<string, number>>, fo: { day: number; lots: ReadonlyMap<string, number | null> } | null): Finding[] {
  if (!fo || !Object.keys(fileLots).length) return [];
  const differ = Object.entries(fileLots)
    .map(([symbol, lot]) => ({ symbol, file: lot, bhavcopy: fo.lots.get(symbol) ?? null }))
    .filter((entry): entry is { symbol: string; file: number; bhavcopy: number } => entry.bhavcopy !== null && entry.bhavcopy !== entry.file)
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
  if (!differ.length) return [];
  return [
    {
      check: "lot_file_mismatch",
      day: fo.day,
      subject: "lots",
      severity: "warning",
      message: `NSE's lot file and the F&O bhavcopy of ${dayName(fo.day)} disagree for ${plural(differ.length, "stock")}: ${list(differ.map((entry) => `${entry.symbol} ${thousands(entry.file)} vs ${thousands(entry.bhavcopy)}`), 6)}. /v1/lots serves the lot file's.`,
      detail: { differ },
    },
  ];
}

// ------------------------------------------------------------------ stored candles against the bhavcopy

/** A stored close differing from NSE's by more than this is a mismatch (0.5%). */
export const BROKER_TOLERANCE = 0.005;
/** Ratios within this of each other (0.5%) make a steady run, one adjustment factor. */
export const STEADY_TOLERANCE = 0.005;

/**
 * What the archive's raw close for (symbol, day) is multiplied by to be
 * comparable with adjusted history (1 = unadjusted). The adjustment table
 * (market-data-hub#20) plugs in here; none yet.
 */
export type PriceAdjuster = (symbol: string, day: number) => number;

export interface ComparedDay {
  day: number;
  /** The stored daily candle's close (broker history, or the bhavcopy itself on days it extended the series). */
  stored: number;
  /** NSE's bhavcopy close that day. */
  nse: number;
}

/** More unexplained stretches than this for one symbol are reported as one finding. */
export const MAX_BROKER_FINDINGS = 5;

/**
 * broker_mismatch for one symbol, from its stored candles joined with the
 * bhavcopy (oldest first). The days are cut into stretches of one steady ratio
 * (stored / NSE). Where a stretch off 1 ends, either the stored history moves
 * smoothly while NSE's raw close jumps — a corporate action the broker
 * adjusted its history for and the archive isn't adjusted for yet (info) — or
 * it doesn't: an unexplained difference (warning), as is any difference on the
 * newest stored days. A stretch that ends where the archive has days not yet
 * downloaded (`continuous` false) isn't judged until they are. Pure.
 */
export function brokerFindings(symbol: string, days: readonly ComparedDay[], adjust: PriceAdjuster = () => 1, continuous: (from: number, to: number) => boolean = () => true): Finding[] {
  const usable = days.filter((entry) => entry.nse > 0 && entry.stored > 0);
  const ratio = (entry: ComparedDay) => entry.stored / (entry.nse * adjust(symbol, entry.day));
  const stretches: Array<{ from: number; to: number; ratio: number }> = [];
  usable.forEach((entry, index) => {
    const value = Math.abs(ratio(entry) - 1) <= BROKER_TOLERANCE ? 1 : ratio(entry);
    const last = stretches[stretches.length - 1];
    if (last && Math.abs(value / last.ratio - 1) <= STEADY_TOLERANCE) last.to = index;
    else stretches.push({ from: index, to: index, ratio: value });
  });
  const info: Finding[] = [];
  const warnings: Array<{ first: ComparedDay; last: ComparedDay; sessions: number; ratio: number; newest: boolean }> = [];
  stretches.forEach((stretch, k) => {
    if (stretch.ratio === 1) return;
    const first = usable[stretch.from];
    const last = usable[stretch.to];
    const following = stretches[k + 1];
    const next = following ? usable[following.from] : null;
    const sessions = stretch.to - stretch.from + 1;
    if (next && !continuous(last.day, next.day)) return;
    if (next && following && Math.abs(Math.log(next.stored / last.stored)) < Math.abs(Math.log(next.nse / last.nse))) {
      const factor = stretch.ratio / following.ratio;
      info.push({
        check: "broker_mismatch",
        day: next.day,
        subject: symbol,
        severity: "info",
        message: `${symbol}: the stored (broker) daily history is adjusted for a ×${factor.toFixed(3)} corporate action effective ${dayName(next.day)}; NSE's raw archive isn't yet (${plural(sessions, "stored session")} before it differ by that factor).`,
        detail: { from: isoDay(first.day), to: isoDay(last.day), sessions, ratio: Number(stretch.ratio.toFixed(4)), factor: Number(factor.toFixed(4)), exDate: isoDay(next.day) },
      });
    } else warnings.push({ first, last, sessions, ratio: stretch.ratio, newest: next === null });
  });
  const span = (first: ComparedDay, last: ComparedDay) => (first.day === last.day ? dayName(first.day) : `${dayName(first.day)} to ${dayName(last.day)}`);
  if (warnings.length > MAX_BROKER_FINDINGS) {
    const first = warnings[0].first;
    const last = warnings[warnings.length - 1].last;
    const sessions = warnings.reduce((sum, entry) => sum + entry.sessions, 0);
    const ratios = warnings.map((entry) => entry.ratio);
    return [
      ...info,
      {
        check: "broker_mismatch",
        day: first.day,
        subject: symbol,
        severity: "warning",
        message: `${symbol}: stored daily closes differ from NSE's bhavcopy on ${plural(sessions, "session")} in ${thousands(warnings.length)} stretches (${span(first, last)}), by ×${Math.min(...ratios).toFixed(3)} to ×${Math.max(...ratios).toFixed(3)}.`,
        detail: { from: isoDay(first.day), to: isoDay(last.day), sessions, stretches: warnings.length },
      },
    ];
  }
  return [
    ...info,
    ...warnings.map(
      (entry): Finding => ({
        check: "broker_mismatch",
        day: entry.first.day,
        subject: symbol,
        severity: "warning",
        message: `${symbol}: stored daily closes differ from NSE's bhavcopy by ×${entry.ratio.toFixed(3)} on ${plural(entry.sessions, "session")} (${span(entry.first, entry.last)})${entry.newest ? ", through the newest stored day" : ""}, and no corporate action explains it.`,
        detail: { from: isoDay(entry.first.day), to: isoDay(entry.last.day), sessions: entry.sessions, ratio: Number(entry.ratio.toFixed(4)), newest: entry.newest },
      }),
    ),
  ];
}

/** candle_gap for one symbol: sessions it traded (bhavcopy rows) inside its stored coverage with no candle. Pure. */
export function candleGapFindings(symbol: string, missing: readonly number[]): Finding[] {
  if (!missing.length) return [];
  const sorted = [...missing].sort((a, b) => a - b);
  const newest = sorted[sorted.length - 1];
  return [
    {
      check: "candle_gap",
      day: newest,
      subject: symbol,
      severity: "warning",
      message: `${symbol}: stored daily candles lack ${plural(sorted.length, "session")} it traded (${list(sorted.map(dayName), 4)}).`,
      detail: { missing: sorted.length, days: sorted.slice(-20).map(isoDay) },
    },
  ];
}
