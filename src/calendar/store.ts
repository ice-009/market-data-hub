import type { Db } from "../db.js";
import { isWeekday } from "../time.js";
import { calendar, setCalendar, type ArchiveDay, type Calendar, type Override, type SessionHours } from "./calendar.js";

// The calendar's database side (migration 11): the overrides people add with
// `hub data calendar`, and what NSE's archive (nse_days) shows about past days.
// syncCalendar folds both into the hub's current calendar.

/**
 * nse_days note of a day the evening run (or an NSE history download) didn't
 * ask NSE for because the calendar lists it as a holiday. Such rows aren't
 * evidence from the archive, and are forgotten when the day stops being a
 * listed holiday, so NSE is asked after all.
 */
export const CALENDAR_NOTE = "listed exchange holiday: not asked";

interface OverrideRow {
  day: number;
  kind: "holiday" | "session";
  name: string | null;
  open_min: number | null;
  close_min: number | null;
  updated_at: number;
}

export function readOverrides(db: Db): Map<number, Override> {
  const rows = db.prepare("select day, kind, name, open_min, close_min, updated_at from calendar_days").all() as OverrideRow[];
  return new Map(rows.map((row) => [row.day, { day: row.day, kind: row.kind, name: row.name, hours: row.open_min !== null && row.close_min !== null ? { open: row.open_min, close: row.close_min } : null, updatedAt: row.updated_at }]));
}

/** Add or replace a day's override. A session override forgets the day's "not asked" rows, so its files are fetched. */
export function setOverride(db: Db, entry: { day: number; kind: "holiday" | "session"; name: string | null; hours?: SessionHours | null }, now = Date.now()) {
  db.transaction(() => {
    db.prepare(
      `insert into calendar_days (day, kind, name, open_min, close_min, updated_at) values (?, ?, ?, ?, ?, ?)
       on conflict(day) do update set kind = excluded.kind, name = excluded.name, open_min = excluded.open_min, close_min = excluded.close_min, updated_at = excluded.updated_at`,
    ).run(entry.day, entry.kind, entry.name, entry.hours?.open ?? null, entry.hours?.close ?? null, now);
    if (entry.kind === "session") db.prepare("delete from nse_days where day = ? and note = ?").run(entry.day, CALENDAR_NOTE);
  })();
  syncCalendar(db, true);
}

/** Remove a day's override; false when it had none. */
export function removeOverride(db: Db, day: number): boolean {
  const removed = db.prepare("delete from calendar_days where day = ?").run(day).changes > 0;
  forgetUnlistedHolidays(db, syncCalendar(db, true));
  return removed;
}

/**
 * What the archive says per day: "session" when a cash, F&O or index file of
 * the day is stored; "holiday" for a weekday with none of them, whose cash
 * bhavcopy NSE didn't have, where NSE answered 404 for at least one file (a
 * file for another date alone doesn't confirm a holiday).
 */
export function archiveDays(db: Db): Map<number, ArchiveDay> {
  const rows = db
    .prepare(
      `select day,
         max(status = 'ok' and dataset in ('cash_bhav', 'fo_bhav', 'index_close')) as session,
         max(dataset = 'cash_bhav' and status <> 'ok') as noCash,
         max(status = 'holiday' and coalesce(note, '') <> ?) as notFound
       from nse_days group by day`,
    )
    .all(CALENDAR_NOTE) as Array<{ day: number; session: number; noCash: number; notFound: number }>;
  const out = new Map<number, ArchiveDay>();
  for (const row of rows) {
    if (row.session) out.set(row.day, "session");
    else if (row.noCash && row.notFound && isWeekday(row.day)) out.set(row.day, "holiday");
  }
  return out;
}

const cache = new WeakMap<Db, { signature: string; calendar: Calendar }>();

function dbSignature(db: Db): string {
  const days = db.prepare("select count(*) as n, max(checked_at) as at from nse_days").get() as { n: number; at: number | null };
  const overrides = db.prepare("select count(*) as n, max(updated_at) as at from calendar_days").get() as { n: number; at: number | null };
  return `${days.n}|${days.at ?? 0}|${overrides.n}|${overrides.at ?? 0}`;
}

/**
 * Make the hub's current calendar this database's: the checked-in lists plus
 * its overrides and archive. Cheap when nothing changed (two count queries);
 * `force` rebuilds anyway. Returns the calendar.
 */
export function syncCalendar(db: Db, force = false): Calendar {
  const signature = dbSignature(db);
  const cached = cache.get(db);
  if (!force && cached?.signature === signature) {
    if (calendar() !== cached.calendar) setCalendar(cached.calendar);
    return cached.calendar;
  }
  const next = calendar().with({ overrides: readOverrides(db), archive: archiveDays(db) });
  cache.set(db, { signature, calendar: next });
  return setCalendar(next);
}

/** Forget "not asked" rows of days that are no longer listed holidays, so the next run asks NSE for them. Returns how many. */
export function forgetUnlistedHolidays(db: Db, cal: Calendar = calendar()): number {
  const rows = db.prepare("select distinct day from nse_days where note = ?").all(CALENDAR_NOTE) as Array<{ day: number }>;
  const stale = rows.map((row) => row.day).filter((day) => !isListedHoliday(cal, day));
  const remove = db.prepare("delete from nse_days where day = ? and note = ?");
  db.transaction(() => {
    for (const day of stale) remove.run(day, CALENDAR_NOTE);
  })();
  return stale.length;
}

/** The calendar names this day a holiday on the word of NSE's list or a person (not just the archive). */
export function isListedHoliday(cal: Calendar, day: number): boolean {
  const override = cal.overrides.get(day);
  if (override) return override.kind === "holiday";
  return cal.listedHolidays.has(day) && !cal.listedSessions.has(day);
}
