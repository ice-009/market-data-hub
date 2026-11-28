import { calendar } from "../calendar/calendar.js";
import { CALENDAR_NOTE, isListedHoliday } from "../calendar/store.js";
import type { Db } from "../db.js";
import { DAY_MS, isWeekday, isoDay } from "../time.js";
import { ARCHIVE_FROM, EMPTY_FILE_NOTE, foBhavUrl, unzipped, type DayOutcome, type NseContext } from "./datasets.js";
import { summarizeFoCsv } from "./optionFile.js";
import { markOptionDay, optionDaysRead, writeOptionDay } from "./optionStore.js";
import { checkedDays } from "./store.js";

// Option summaries of F&O days the hub stored before it kept them
// (`hub data nse-history --only options`): each day's F&O bhavcopy is
// downloaded again and only its option rows are read — fo_futures and nse_days
// aren't touched. Plus the months before the first stock futures: NSE's index
// options began on 4 Jun 2001 and stock options on 2 Jul 2001, stock futures
// (where the F&O history starts) on 9 Nov 2001, so those days are asked for here.
// About 6,300 files for 2001 → 2026, one per 1.1 s: ~2 hours.

/** The first F&O session with options (index options; stock options from 2 Jul 2001). */
export const OPTIONS_FROM = Date.UTC(2001, 5, 4);

/**
 * Days from..to whose options haven't been read, oldest first: stored F&O days,
 * and the weekdays between OPTIONS_FROM and the F&O archive's start.
 */
export function optionDays(db: Db, from: number, to: number): number[] {
  const start = Math.max(from, OPTIONS_FROM);
  if (start > to) return [];
  const read = optionDaysRead(db, start);
  const days = [...checkedDays(db, "fo_bhav", start)].filter(([day, status]) => status === "ok" && day <= to && !read.has(day)).map(([day]) => day);
  for (let day = start; day < Math.min(to + DAY_MS, ARCHIVE_FROM.fo_bhav); day += DAY_MS) if (isWeekday(day) && !read.has(day)) days.push(day);
  return [...new Set(days)].sort((a, b) => a - b);
}

/** Download one day's F&O bhavcopy and store its option summaries. Throws NseError when NSE won't serve it. */
export async function importOptions(ctx: NseContext, day: number): Promise<DayOutcome> {
  if (isListedHoliday(calendar(), day)) {
    markOptionDay(ctx.db, day, "holiday", 0, ctx.clock(), CALENDAR_NOTE);
    return "holiday";
  }
  const response = await ctx.nse.get(foBhavUrl(ctx.urls.archiveUrl, day));
  if (response.status === 404 || !response.body.length) {
    markOptionDay(ctx.db, day, "holiday", 0, ctx.clock(), response.status === 404 ? null : EMPTY_FILE_NOTE);
    return "holiday";
  }
  const read = summarizeFoCsv(day, unzipped(response.body));
  if (read.kind === "mismatch") {
    ctx.log.warn("NSE served an F&O file for another date; its options weren't read", { day: isoDay(day), note: read.note });
    markOptionDay(ctx.db, day, "mismatch", 0, ctx.clock(), read.note);
    return "mismatch";
  }
  writeOptionDay(ctx.db, day, read.summaries, ctx.clock());
  if (read.badRows) ctx.log.warn("some option rows couldn't be read", { day: isoDay(day), badRows: read.badRows });
  return "ok";
}
