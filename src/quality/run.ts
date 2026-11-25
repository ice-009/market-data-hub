import { isFuture } from "../broker/symbols.js";
import { readKv, writeKv, type Db } from "../db.js";
import type { Calendar } from "../calendar/calendar.js";
import { CALENDAR_NOTE, isListedHoliday, syncCalendar } from "../calendar/store.js";
import { ARCHIVE_FROM, ARCHIVE_GAPS } from "../nse/datasets.js";
import { lastOkDay, readLots, readRuns, type DayDataset } from "../nse/store.js";
import type { Logger } from "../log.js";
import { DAY_MS, MINUTE_MS, isoDay, isWeekday, istParts } from "../time.js";
import { CashScanner, VOL_WINDOW, brokerFindings, calendarFindings, candleGapFindings, foFindings, lotFileFindings, type CashRow, type ComparedDay, type CorporateActionHook, type DayRecord, type PriceAdjuster } from "./checks.js";
import { checkedQualityDays, forgetQualityDays, markQualityDays, saveFindings, type CheckName, type Finding } from "./store.js";

// Runs the data-quality checks (./checks.ts) over what's stored, cheaply and
// incrementally, so it can run after every evening import and every few
// seconds of an archive download without holding up the API (better-sqlite3
// is synchronous: work is cut into chunks and stops once `budgetMs` is spent;
// the next call carries on):
//   - the session calendar (missing_session, unlisted_session, wrong_date) is
//     recomputed from nse_days whenever nse_days changes (tens of ms, even for the
//     whole archive);
//   - cash days (price_outlier, repeated_file) and F&O days (lot_change,
//     fo_list_change) are checked once each, newest stored first, in runs of
//     consecutive sessions that load their warm-up window once. A day waits
//     until the sessions before it are known (an archive download fills years
//     newest first), and is checked again if its file is stored again;
//   - stored candles against the bhavcopy (broker_mismatch, candle_gap) and the
//     lot file (lot_file_mismatch) are recomputed when what they read changes,
//     the candles at most every CANDLES_EVERY_MS.
// `hub data quality --full` forgets what was checked and checks everything again.

export interface QualityHooks {
  /** Known corporate actions. Default: the stored split/bonus factors (adjustment_factors, src/history/adjustments.ts). */
  corporateAction?: CorporateActionHook;
  /** Adjustment factors for the raw archive's closes, for comparing them with the broker's adjusted history. */
  adjust?: PriceAdjuster;
}

export interface QualityOptions {
  clock?: () => number;
  /** Stop starting new chunks after this long (ms). Default: no limit. */
  budgetMs?: number;
  hooks?: QualityHooks;
  /** Check everything again (forget checked days, ignore what changed). */
  full?: boolean;
}

export interface QualityResult {
  /** Findings seen for the first time in this run. */
  fresh: Finding[];
  /** Cash and F&O days checked in this run. */
  checkedDays: number;
  /** Stored days not checked yet (including those waiting for earlier sessions). */
  pendingDays: number;
  /** Of those, days waiting for the sessions before them to be stored. */
  waitingDays: number;
  /** Nothing left to do that can be done now. */
  done: boolean;
  ms: number;
}

export interface QualityState {
  lastRunAt?: number;
  calendar?: string;
  lotFile?: string;
  candles?: { signature: string; at: number };
  pendingDays?: number;
  waitingDays?: number;
}

export const STATE_KEY = "quality.state";
/** Sessions per chunk of the per-day checks. */
export const CHUNK_DAYS = 100;
/** Stored candles are compared with the bhavcopy at most this often (unless the candles themselves changed). */
export const CANDLES_EVERY_MS = 30 * MINUTE_MS;
/** A cash day is checked once the days this far back (calendar days, enough for VOL_WINDOW sessions) are known. */
export const CASH_LOOKBACK_DAYS = 100;
/** The first stored F&O day is checked once this far back is known to have no file. */
export const FO_LOOKBACK_DAYS = 14;
/** Without an NSE history job, days older than this don't wait for unasked days before them. */
export const RECENT_GAP_DAYS = 14;
/** Weekend sessions further back than this are info, not warnings. */
const UNLISTED_RECENT_DAYS = 365;

const DATASETS: readonly DayDataset[] = ["cash_bhav", "fo_bhav", "pr", "index_close"];
/** The hub's own calendar: a change (a holiday, session or archive gap added) recomputes the calendar findings. */
const calendarVersion = (cal: Calendar) => [cal.signature(), ...Object.entries(ARCHIVE_GAPS).map(([dataset, days]) => `${dataset}:${days.join(",")}`)].join("|");

/** What the calendar lists (NSE's list, `hub data calendar`) for calendarFindings. */
function listedCalendar(cal: Calendar) {
  const holidays = new Map<number, string>();
  for (const day of new Set([...cal.listedHolidays.keys(), ...cal.overrides.keys()])) if (isListedHoliday(cal, day)) holidays.set(day, cal.info(day).name ?? "holiday");
  const sessions = new Set([...cal.listedSessions.keys(), ...[...cal.overrides.values()].filter((o) => o.kind === "session").map((o) => o.day)]);
  return { holidays, years: cal.listedYears, weekendSessions: [...sessions].filter((day) => !isWeekday(day)).sort((a, b) => a - b) };
}

export function readQualityState(db: Db): QualityState {
  return readKv<QualityState>(db, STATE_KEY) ?? {};
}

type Records = Record<DayDataset, Map<number, DayRecord & { checkedAt: number }>>;

function readRecords(db: Db): { records: Records; signature: string } {
  const records = Object.fromEntries(DATASETS.map((dataset) => [dataset, new Map()])) as Records;
  const rows = db.prepare("select dataset, day, status, note, checked_at from nse_days").all() as Array<{ dataset: DayDataset; day: number; status: DayRecord["status"]; note: string | null; checked_at: number }>;
  let newest = 0;
  for (const row of rows) {
    records[row.dataset]?.set(row.day, { status: row.status, note: row.note, checkedAt: row.checked_at });
    newest = Math.max(newest, row.checked_at);
  }
  return { records, signature: `${rows.length}|${newest}` };
}

const okDays = (records: Map<number, DayRecord>) => [...records].filter(([, record]) => record.status === "ok").map(([day]) => day).sort((a, b) => a - b);
/** Every trading day (src/calendar) from `from` (exclusive) to `to` (exclusive) has an answer from NSE. */
function known(records: ReadonlyMap<number, DayRecord>, from: number, to: number, cal: Calendar): boolean {
  for (let day = from + DAY_MS; day < to; day += DAY_MS) if (cal.isTradingDay(day) && !records.has(day)) return false;
  return true;
}

interface Pending {
  /** Indices into the dataset's ok days, ready to check, ascending. */
  ready: number[];
  waiting: number;
}

function pendingDays(days: readonly number[], records: Map<number, DayRecord & { checkedAt: number }>, checked: ReadonlyMap<number, number>, isReady: (index: number) => boolean): Pending {
  const out: Pending = { ready: [], waiting: 0 };
  days.forEach((day, index) => {
    const at = checked.get(day);
    if (at !== undefined && at >= (records.get(day)?.checkedAt ?? 0)) return;
    if (isReady(index)) out.ready.push(index);
    else out.waiting += 1;
  });
  return out;
}

/** Consecutive indices in runs of at most CHUNK_DAYS, newest run first (recent days matter most). */
function chunks(indices: readonly number[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let start = -1;
  let prev = -2;
  for (const index of indices) {
    if (index !== prev + 1 || index - start >= CHUNK_DAYS) {
      if (start >= 0) out.push([start, prev]);
      start = index;
    }
    prev = index;
  }
  if (start >= 0) out.push([start, prev]);
  return out.reverse();
}

/** Old lot / new lot by `${symbol}|${day}` on F&O days from..to whose lot changed. */
function lotFactors(db: Db, foOk: readonly number[], from: number, to: number): Map<string, number> {
  const out = new Map<string, number>();
  const start = foOk.filter((day) => day < from).pop() ?? from;
  const rows = db.prepare("select day, symbol, lot from fo_futures where day between ? and ? and lot is not null order by day").all(start, to) as Array<{ day: number; symbol: string; lot: number }>;
  const last = new Map<string, number>();
  for (const row of rows) {
    const before = last.get(row.symbol);
    if (before !== undefined && before !== row.lot && row.lot > 0) out.set(`${row.symbol}|${row.day}`, before / row.lot);
    last.set(row.symbol, row.lot);
  }
  return out;
}

function checkCashChunk(db: Db, days: readonly number[], foOk: readonly number[], [a, b]: [number, number], hooks: QualityHooks): Finding[] {
  const warm = days[Math.max(0, a - VOL_WINDOW - 1)];
  const scanner = new CashScanner({ sessions: days, corporateAction: hooks.corporateAction, lotFactors: lotFactors(db, foOk, days[a], days[b]) });
  // Stock by stock along the primary key (symbol, day): sequential reads, where
  // reading day by day through the day index jumps all over a large archive.
  const symbols = (db.prepare("select distinct symbol from cash_bhav where day between ? and ?").all(days[a], days[b]) as Array<{ symbol: string }>).map((row) => row.symbol);
  const statement = db.prepare("select symbol, day, prev_close as prevClose, o, h, l, c, v from cash_bhav where symbol = ? and day between ? and ? order by day");
  const from = days[a];
  const findings: Finding[] = [];
  for (const symbol of symbols) findings.push(...scanner.symbol(statement.all(symbol, warm, days[b]) as CashRow[], (day) => day >= from));
  findings.push(...scanner.repeated(days.slice(a, b + 1)));
  return findings;
}

function checkFoChunk(db: Db, days: readonly number[], [a, b]: [number, number]): Finding[] {
  const from = a > 0 ? days[a - 1] : days[a];
  const byDay = new Map<number, Map<string, number | null>>();
  /** Per day, the stocks whose last listed contract (near, with no next month) expired that day. */
  const expired = new Map<number, Set<string>>();
  for (const row of db.prepare("select day, symbol, lot, near_expiry as nearExpiry, next_expiry as nextExpiry from fo_futures where day between ? and ?").iterate(from, days[b]) as Iterable<{ day: number; symbol: string; lot: number | null; nearExpiry: number; nextExpiry: number | null }>) {
    let lots = byDay.get(row.day);
    if (!lots) byDay.set(row.day, (lots = new Map()));
    lots.set(row.symbol, row.lot);
    if (row.nearExpiry === row.day && row.nextExpiry === null) {
      let set = expired.get(row.day);
      if (!set) expired.set(row.day, (set = new Set()));
      set.add(row.symbol);
    }
  }
  const findings: Finding[] = [];
  for (let i = Math.max(a, 1); i <= b; i += 1) {
    const previous = byDay.get(days[i - 1]) ?? new Map();
    const current = byDay.get(days[i]) ?? new Map();
    // An F&O day stored with no stock futures (a format change) says nothing about the list.
    if (!previous.size || !current.size) continue;
    findings.push(...foFindings({ day: days[i - 1], lots: previous, expired: expired.get(days[i - 1]) }, { day: days[i], lots: current }));
  }
  return findings;
}

function candleChecks(db: Db, adjust: PriceAdjuster | undefined, cash: ReadonlyMap<number, DayRecord>, cal: Calendar): { broker: Finding[]; gaps: Finding[] } {
  const broker: Finding[] = [];
  const gaps: Finding[] = [];
  const series = db.prepare("select symbol, covered_from as coveredFrom, covered_to as coveredTo from series where tf = '1d' and covered_from is not null").all() as Array<{ symbol: string; coveredFrom: number; coveredTo: number }>;
  const compared = db.prepare("select k.t as day, k.c as stored, b.c as nse from candles k join cash_bhav b on b.symbol = k.symbol and b.day = k.t where k.symbol = ? and k.tf = '1d' order by k.t");
  const missing = db.prepare("select c.day from cash_bhav c where c.symbol = ? and c.day >= ? and c.day < ? and not exists (select 1 from candles k where k.symbol = c.symbol and k.tf = '1d' and k.t = c.day) order by c.day");
  for (const entry of series) {
    if (isFuture(entry.symbol)) continue;
    broker.push(...brokerFindings(entry.symbol, compared.all(entry.symbol) as ComparedDay[], adjust, (from, to) => known(cash, from, to, cal)));
    gaps.push(...candleGapFindings(entry.symbol, (missing.all(entry.symbol, entry.coveredFrom, entry.coveredTo) as Array<{ day: number }>).map((row) => row.day)));
  }
  return { broker, gaps };
}

/** A move on a stored ex-date (adjustment_factors, keyed by the ticker that day) is a corporate action, not an outlier. */
export function storedFactors(db: Db): CorporateActionHook {
  const lookup = db.prepare("select factor, source from adjustment_factors where symbol = ? and day = ?");
  return (symbol, day) => (lookup.get(symbol, day) as { factor: number; source: string } | undefined) ?? null;
}

/** Run the checks that are due (see the top of this file). Never throws for bad data; SQLite errors propagate. */
export function runQuality(db: Db, options: QualityOptions = {}): QualityResult {
  const clock = options.clock ?? Date.now;
  const started = clock();
  const budget = options.budgetMs ?? Number.POSITIVE_INFINITY;
  const hooks = { corporateAction: storedFactors(db), ...options.hooks };
  const state = options.full ? {} : readQualityState(db);
  if (options.full) forgetQualityDays(db);
  const fresh: Finding[] = [];
  const save = (check: CheckName, scope: { days: readonly number[] } | null, findings: readonly Finding[]) => fresh.push(...saveFindings(db, check, scope, findings.filter((finding) => finding.check === check), clock()));

  const { records, signature } = readRecords(db);
  const today = istParts(started).day;
  const cal = syncCalendar(db);

  // The session calendar: cheap, recomputed whenever nse_days (or the hub's own calendar) changes.
  const calendarSignature = `${signature}|${calendarVersion(cal)}`;
  if (state.calendar !== calendarSignature) {
    const listed = listedCalendar(cal);
    const findings = calendarFindings({ days: records, weekendSessions: listed.weekendSessions, recentFrom: today - UNLISTED_RECENT_DAYS * DAY_MS, archiveGaps: ARCHIVE_GAPS, listed, calendarNote: CALENDAR_NOTE });
    for (const check of ["missing_session", "unlisted_session", "calendar_mismatch", "wrong_date"] as const) save(check, null, findings);
    state.calendar = calendarSignature;
  }

  // NSE's lot file against the newest F&O bhavcopy.
  const lastFo = lastOkDay(db, "fo_bhav");
  const lotSignature = `${readRuns(db).get("lots")?.lastSuccessAt ?? 0}|${lastFo ?? 0}`;
  if (state.lotFile !== lotSignature) {
    const foLots = lastFo === null ? null : { day: lastFo, lots: new Map((db.prepare("select symbol, lot from fo_futures where day = ?").all(lastFo) as Array<{ symbol: string; lot: number | null }>).map((row) => [row.symbol, row.lot])) };
    save("lot_file_mismatch", null, lotFileFindings(readLots(db), foLots));
    state.lotFile = lotSignature;
  }

  // Stored candles against the bhavcopy: when the candles or the bhavcopy changed, at most every CANDLES_EVERY_MS.
  const candleRow = db.prepare("select count(*) as n, max(synced_at) as synced, max(covered_to) as covered from series where tf = '1d'").get() as { n: number; synced: number | null; covered: number | null };
  const cashOk = okDays(records.cash_bhav);
  const candleSignature = `${candleRow.n}|${candleRow.synced ?? 0}|${candleRow.covered ?? 0}|${cashOk.length}|${cashOk[cashOk.length - 1] ?? 0}`;
  if (state.candles?.signature !== candleSignature && (!state.candles || started - state.candles.at >= CANDLES_EVERY_MS)) {
    const { broker, gaps } = candleChecks(db, hooks.adjust, records.cash_bhav, cal);
    save("broker_mismatch", null, broker);
    save("candle_gap", null, gaps);
    state.candles = { signature: candleSignature, at: started };
  }

  // Per-day checks, in chunks, until the budget is spent.
  const foOk = okDays(records.fo_bhav);
  // A day waits for the sessions before it while an NSE history job may still
  // download them; with none open, gaps older than RECENT_GAP_DAYS stay as they are.
  const historyOpen = Boolean(db.prepare("select 1 from jobs where kind = 'nse_history' and state in ('queued', 'paused', 'running') limit 1").get());
  const settled = (records: ReadonlyMap<number, DayRecord>, previous: number | undefined, day: number) => !historyOpen && (day < today - RECENT_GAP_DAYS * DAY_MS || known(records, previous ?? day - RECENT_GAP_DAYS * DAY_MS, day, cal));
  const cashPending = pendingDays(cashOk, records.cash_bhav, checkedQualityDays(db, "price_outlier"), (index) => {
    const day = cashOk[index];
    return known(records.cash_bhav, Math.max(day - CASH_LOOKBACK_DAYS * DAY_MS, ARCHIVE_FROM.cash_bhav - DAY_MS), day, cal) || settled(records.cash_bhav, cashOk[index - 1], day);
  });
  const foPending = pendingDays(foOk, records.fo_bhav, checkedQualityDays(db, "lot_change"), (index) => {
    const day = foOk[index];
    const before = index > 0 ? known(records.fo_bhav, foOk[index - 1], day, cal) : known(records.fo_bhav, Math.max(day - FO_LOOKBACK_DAYS * DAY_MS, ARCHIVE_FROM.fo_bhav - DAY_MS), day, cal);
    return before || settled(records.fo_bhav, foOk[index - 1], day);
  });
  let checkedDays = 0;
  let remaining = cashPending.ready.length + foPending.ready.length;
  const work: Array<() => number> = [
    ...chunks(foPending.ready).map((range) => () => {
      const days = foOk.slice(range[0], range[1] + 1);
      const findings = checkFoChunk(db, foOk, range);
      save("lot_change", { days }, findings);
      save("fo_list_change", { days }, findings);
      markQualityDays(db, "lot_change", days, clock());
      return days.length;
    }),
    ...chunks(cashPending.ready).map((range) => () => {
      const days = cashOk.slice(range[0], range[1] + 1);
      const findings = checkCashChunk(db, cashOk, foOk, range, hooks);
      save("price_outlier", { days }, findings);
      save("repeated_file", { days }, findings);
      markQualityDays(db, "price_outlier", days, clock());
      return days.length;
    }),
  ];
  // At least one chunk per run, so a small budget still makes progress.
  for (const step of work) {
    if (checkedDays > 0 && clock() - started >= budget) break;
    const count = step();
    checkedDays += count;
    remaining -= count;
  }

  state.lastRunAt = clock();
  state.waitingDays = cashPending.waiting + foPending.waiting;
  state.pendingDays = remaining + state.waitingDays;
  writeKv(db, STATE_KEY, state, clock());
  return { fresh, checkedDays, pendingDays: state.pendingDays, waitingDays: state.waitingDays, done: remaining === 0, ms: clock() - started };
}

/** Log what a run found for the first time: each finding when there are a few, a tally when there are many (an archive scan). */
export function logFindings(log: Logger, fresh: readonly Finding[], limit = 10) {
  if (!fresh.length) return;
  if (fresh.length <= limit) {
    for (const finding of fresh) {
      const fields = { check: finding.check, day: isoDay(finding.day), subject: finding.subject, severity: finding.severity, finding: finding.message };
      if (finding.severity === "info") log.info("data-quality finding", fields);
      else log.warn("data-quality finding", fields);
    }
    return;
  }
  const tally: Record<string, number> = {};
  for (const finding of fresh) tally[`${finding.check}:${finding.severity}`] = (tally[`${finding.check}:${finding.severity}`] ?? 0) + 1;
  const problems = fresh.filter((finding) => finding.severity === "problem").slice(0, 3).map((finding) => finding.message);
  if (problems.length) log.warn("data-quality findings", { count: fresh.length, tally, problems });
  else log.info("data-quality findings", { count: fresh.length, tally });
}
