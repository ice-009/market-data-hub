import { readdirSync, readFileSync } from "node:fs";
import { DAY_MS, SESSION_CLOSE_MIN, SESSION_OPEN_MIN, istParts, isoDay, isWeekday, parseIsoDay } from "../time.js";

// The NSE trading calendar (cash and F&O share it): which IST dates have a
// session, at what hours, and which are holidays, by name. Four sources, the
// first that knows a day wins:
//   override  a person's word, from `hub data calendar` (table calendar_days,
//             ./store.ts): a holiday announced late, a special session, a correction.
//   archive   what NSE's archive showed for a past day (nse_days): a session when
//             the cash, F&O or index file of that day is stored; a holiday when a
//             weekday has none of them and NSE answered 404 for at least one.
//   nse_list  NSE's yearly holiday circular and its special sessions (Budget days,
//             Muhurat trading, DR drills), checked in as reference/holidays/<year>.json.
//   rule      weekdays trade, weekends don't.
// So past days follow the archive (what really happened) and future days the
// published list. Years without a checked-in list only learn their holidays
// from the archive, the evening after: /v1/status warns in December when next
// year's list is missing. The calendar is pure; the hub keeps one current
// instance (calendar()), refreshed from the database by syncCalendar (./store.ts).

/** Session hours, minutes after IST midnight: trading runs over [open, close). */
export interface SessionHours {
  open: number;
  close: number;
}

export const REGULAR_HOURS: Readonly<SessionHours> = Object.freeze({ open: SESSION_OPEN_MIN, close: SESSION_CLOSE_MIN });

/** regular: a normal session; special: one on a weekend or a listed holiday (or with its own hours). */
export type DayKind = "regular" | "special" | "holiday" | "weekend";
export type DaySource = "override" | "archive" | "nse_list" | "rule";

export interface DayInfo {
  day: number;
  trading: boolean;
  kind: DayKind;
  /** The holiday's or special session's name, when known. */
  name: string | null;
  source: DaySource;
  /** Null when there's no session. */
  hours: SessionHours | null;
}

/** A day named in a year's list. */
export interface ListedDay {
  day: number;
  name: string;
  /** A special session's hours when they differ from the regular 09:15–15:30. */
  hours?: SessionHours;
  /** The circular that announced it, when not the year's main one. */
  source?: string;
}

/** One reference/holidays/<year>.json. */
export interface YearList {
  year: number;
  /** Where the list comes from (circular numbers). */
  source: string;
  url?: string;
  /** NSE's trading holidays (weekend ones too, for their names); null when the year's list isn't checked in. */
  holidays: ListedDay[] | null;
  /** Special sessions: weekend or holiday sessions, Muhurat trading. */
  sessions: ListedDay[];
}

export interface Override {
  day: number;
  kind: "holiday" | "session";
  name: string | null;
  /** A session's hours; null = the regular ones. */
  hours: SessionHours | null;
  updatedAt: number;
}

/** What NSE's archive showed for a past day (only days that say something: weekday holidays and sessions). */
export type ArchiveDay = "session" | "holiday";

/** "14:20" → minutes after midnight, or null. */
export function parseHhmm(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return Number(match[1]) < 24 && Number(match[2]) < 60 ? minutes : null;
}

export const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/** "14:20-15:30" → hours, or null. */
export function parseHours(value: string): SessionHours | null {
  const [open, close] = value.split("-").map(parseHhmm);
  return open != null && close != null && open < close ? { open, close } : null;
}

interface RawDay {
  date: string;
  name: string;
  open?: string;
  close?: string;
  source?: string;
}

/** Read and check one year's JSON. Throws with the file's name on anything malformed. */
export function parseYearList(text: string, file: string): YearList {
  const raw = JSON.parse(text) as { year?: unknown; source?: unknown; url?: unknown; holidays?: RawDay[]; sessions?: RawDay[] };
  const year = Number(raw.year);
  if (!Number.isInteger(year)) throw new Error(`${file}: "year" must be a number`);
  const read = (entry: RawDay, what: string): ListedDay => {
    const day = parseIsoDay(String(entry?.date ?? ""));
    if (day === null || new Date(day).getUTCFullYear() !== year) throw new Error(`${file}: ${what} date "${entry?.date}" isn't a date in ${year}`);
    if (typeof entry.name !== "string" || !entry.name.trim()) throw new Error(`${file}: ${what} ${entry.date} has no name`);
    const out: ListedDay = { day, name: entry.name.trim() };
    if (entry.open !== undefined || entry.close !== undefined) {
      const hours = parseHours(`${entry.open ?? hhmm(SESSION_OPEN_MIN)}-${entry.close ?? hhmm(SESSION_CLOSE_MIN)}`);
      if (!hours) throw new Error(`${file}: ${what} ${entry.date} has bad hours`);
      out.hours = hours;
    }
    if (entry.source) out.source = String(entry.source);
    return out;
  };
  return {
    year,
    source: String(raw.source ?? ""),
    ...(raw.url ? { url: String(raw.url) } : {}),
    holidays: Array.isArray(raw.holidays) ? raw.holidays.map((entry) => read(entry, "holiday")) : null,
    sessions: Array.isArray(raw.sessions) ? raw.sessions.map((entry) => read(entry, "session")) : [],
  };
}

/** reference/holidays/, from src/calendar (tsx, tests) and dist/calendar (the build) alike. */
export const HOLIDAYS_DIR = new URL("../../reference/holidays/", import.meta.url);

/** The checked-in lists (reference/holidays/*.json), oldest year first. */
export function loadYearLists(dir: URL = HOLIDAYS_DIR): YearList[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((name) => /^\d{4}\.json$/.test(name));
  } catch {
    return [];
  }
  return files.map((name) => parseYearList(readFileSync(new URL(name, dir), "utf8"), name)).sort((a, b) => a.year - b.year);
}

/** Longest run of closed days the calendar walks before giving up (no real calendar comes close). */
const MAX_CLOSED_RUN = 400;

export class Calendar {
  /** Listed holidays and special sessions, by day. */
  readonly listedHolidays = new Map<number, ListedDay>();
  readonly listedSessions = new Map<number, ListedDay>();
  /** Years whose holiday list is known: checked in, or holidays added with `hub data calendar`. */
  readonly listedYears: ReadonlySet<number>;

  constructor(
    readonly lists: readonly YearList[] = [],
    readonly overrides: ReadonlyMap<number, Override> = new Map(),
    readonly archive: ReadonlyMap<number, ArchiveDay> = new Map(),
  ) {
    const years = new Set<number>();
    for (const list of lists) {
      if (list.holidays) {
        years.add(list.year);
        for (const holiday of list.holidays) this.listedHolidays.set(holiday.day, holiday);
      }
      for (const session of list.sessions) this.listedSessions.set(session.day, session);
    }
    for (const override of overrides.values()) if (override.kind === "holiday") years.add(new Date(override.day).getUTCFullYear());
    this.listedYears = years;
  }

  /** A new calendar with the same lists and other overrides / archive days. */
  with(parts: { overrides?: ReadonlyMap<number, Override>; archive?: ReadonlyMap<number, ArchiveDay> }): Calendar {
    return new Calendar(this.lists, parts.overrides ?? this.overrides, parts.archive ?? this.archive);
  }

  info(day: number): DayInfo {
    const weekday = isWeekday(day);
    const listedHoliday = this.listedHolidays.get(day);
    const listedSession = this.listedSessions.get(day);
    const override = this.overrides.get(day);
    if (override) {
      if (override.kind === "holiday") return { day, trading: false, kind: "holiday", name: override.name ?? listedHoliday?.name ?? null, source: "override", hours: null };
      const hours = override.hours ?? listedSession?.hours ?? REGULAR_HOURS;
      const regular = weekday && !listedHoliday && hours.open === REGULAR_HOURS.open && hours.close === REGULAR_HOURS.close;
      return { day, trading: true, kind: regular ? "regular" : "special", name: override.name ?? listedSession?.name ?? null, source: "override", hours };
    }
    const archived = this.archive.get(day);
    if (archived === "session") {
      const regular = weekday && !listedHoliday && !listedSession;
      return {
        day,
        trading: true,
        kind: regular ? "regular" : "special",
        name: listedSession?.name ?? (regular ? null : "Session (in NSE's archive)"),
        source: listedSession ? "nse_list" : "archive",
        hours: listedSession?.hours ?? REGULAR_HOURS,
      };
    }
    if (archived === "holiday" && weekday) return { day, trading: false, kind: "holiday", name: listedHoliday?.name ?? null, source: listedHoliday ? "nse_list" : "archive", hours: null };
    if (listedSession) return { day, trading: true, kind: "special", name: listedSession.name, source: "nse_list", hours: listedSession.hours ?? REGULAR_HOURS };
    if (listedHoliday) return { day, trading: false, kind: weekday ? "holiday" : "weekend", name: listedHoliday.name, source: "nse_list", hours: null };
    return weekday ? { day, trading: true, kind: "regular", name: null, source: "rule", hours: REGULAR_HOURS } : { day, trading: false, kind: "weekend", name: null, source: "rule", hours: null };
  }

  isTradingDay(day: number): boolean {
    return this.info(day).trading;
  }

  /** The day's session hours, or null when it has none. */
  hours(day: number): SessionHours | null {
    return this.info(day).hours;
  }

  /** Inside a session at `time`. */
  isOpen(time: number): boolean {
    const { day, minutes } = istParts(time);
    const hours = this.hours(day);
    return hours !== null && minutes >= hours.open && minutes < hours.close;
  }

  /** The first trading day after `day`. */
  next(day: number): number {
    let d = day + DAY_MS;
    for (let i = 0; i < MAX_CLOSED_RUN && !this.isTradingDay(d); i += 1) d += DAY_MS;
    return d;
  }

  /** The last trading day before `day`. */
  previous(day: number): number {
    return this.onOrBefore(day - DAY_MS);
  }

  /** `day` when it trades, else the last trading day before it. */
  onOrBefore(day: number): number {
    let d = day;
    for (let i = 0; i < MAX_CLOSED_RUN && !this.isTradingDay(d); i += 1) d -= DAY_MS;
    return d;
  }

  /** Trading days from..to (day keys, inclusive), oldest first. */
  tradingDays(from: number, to: number): number[] {
    const out: number[] = [];
    for (let day = from; day <= to; day += DAY_MS) if (this.isTradingDay(day)) out.push(day);
    return out;
  }

  /** A stable string of what the hub was told (lists and overrides, not the archive): changes when either does. */
  signature(): string {
    const lists = this.lists.map((list) => `${list.year}:${list.holidays?.map((h) => h.day).join(",") ?? "-"}:${list.sessions.map((s) => `${s.day}${s.hours ? `@${s.hours.open}-${s.hours.close}` : ""}`).join(",")}`);
    const overrides = [...this.overrides.values()].sort((a, b) => a.day - b.day).map((o) => `${o.day}${o.kind[0]}${o.hours ? `@${o.hours.open}-${o.hours.close}` : ""}`);
    return `${lists.join(";")}|${overrides.join(",")}`;
  }
}

let current = new Calendar(loadYearLists());

/** The hub's current calendar (the checked-in lists until syncCalendar adds the database's overrides and archive). */
export const calendar = (): Calendar => current;

/** Replace the current calendar (syncCalendar, and tests). */
export function setCalendar(next: Calendar): Calendar {
  current = next;
  return next;
}

/** Inside a session (09:15–15:30 IST on a trading day, or a special session's hours) at `time`. */
export const isMarketOpen = (time: number = Date.now()) => current.isOpen(time);

export const isTradingDay = (day: number) => current.isTradingDay(day);

/** `day` when it trades, else the last trading day before it. */
export const tradingDayOnOrBefore = (day: number) => current.onOrBefore(day);

export const nextTradingDay = (day: number) => current.next(day);

/** The day's session hours, the regular ones on a day without a session (for callers that need an axis). */
export const sessionHoursOf = (day: number): SessionHours => current.hours(day) ?? REGULAR_HOURS;

/** The latest trading day whose session has started by `now`. */
export function latestSessionDay(now: number): number {
  const { day, minutes } = istParts(now);
  const hours = current.hours(day);
  return hours && minutes >= hours.open ? day : current.previous(day);
}

/** Minutes, as "HH:MM", for JSON. */
const hoursJson = (hours: SessionHours | null) => (hours ? { open: hhmm(hours.open), close: hhmm(hours.close) } : null);

/** One day as the API serves it. */
export function dayJson(info: DayInfo) {
  return { date: isoDay(info.day), day: info.day, trading: info.trading, kind: info.kind, name: info.name, source: info.source, session: hoursJson(info.hours) };
}

/** `calendar` in /v1/status: is today a trading day, a holiday (and which), the next and previous trading days. */
export function calendarStatus(now: number, cal: Calendar = current) {
  const { day } = istParts(now);
  const info = cal.info(day);
  const year = new Date(day).getUTCFullYear();
  return {
    today: isoDay(day),
    tradingDay: info.trading,
    kind: info.kind,
    holiday: info.kind === "holiday" ? { name: info.name, source: info.source } : null,
    session: hoursJson(info.hours),
    marketOpen: cal.isOpen(now),
    nextTradingDay: isoDay(cal.next(day)),
    previousTradingDay: isoDay(cal.previous(day)),
    /** Years whose NSE holiday list the hub has (checked in or added): other years learn holidays from the archive only. */
    listedYears: [...cal.listedYears].sort((a, b) => a - b),
    nextYearListed: cal.listedYears.has(year + 1),
  };
}

/** From this month (0-based: December) next year's list should be in the hub; NSE publishes it in mid-December. */
export const NEXT_YEAR_WARN_MONTH = 11;

/** Warnings about the calendar's coverage at `now`. */
export function calendarWarnings(now: number, cal: Calendar = current): string[] {
  const date = new Date(istParts(now).day);
  const year = date.getUTCFullYear();
  const out: string[] = [];
  const how = (y: number) => `add reference/holidays/${y}.json from NSE's circular, or each day with \`hub data calendar holiday YYYY-MM-DD "name"\``;
  if (!cal.listedYears.has(year)) out.push(`Calendar: no NSE holiday list for ${year}, so a holiday is only known from NSE's archive the evening after (until then it looks like missing files); ${how(year)}.`);
  else if (date.getUTCMonth() >= NEXT_YEAR_WARN_MONTH && !cal.listedYears.has(year + 1)) out.push(`Calendar: NSE's holiday list for ${year + 1} isn't in the hub yet (NSE publishes it in December); ${how(year + 1)}.`);
  return out;
}
