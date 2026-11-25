import type { Hono } from "hono";
import { calendarStatus, hhmm } from "../../calendar/calendar.js";
import { syncCalendar } from "../../calendar/store.js";
import type { Hub } from "../../hub.js";
import { DAY_MS, isoDay, istParts, isWeekday } from "../../time.js";
import { errorBody, requireScope, type HubEnv } from "../common.js";
import { ParamError, parseTime } from "../params.js";

// The NSE trading calendar (src/calendar):
//   GET /v1/calendar[?from&to]   history   trading days, holidays (named) and special sessions
// Dates are IST trade dates. Without from/to: the current calendar year.

/** Most calendar days one request may span (40 years: the whole archive). */
export const MAX_CALENDAR_DAYS = 40 * 366;

export function calendarRoutes(app: Hono<HubEnv>, hub: Hub) {
  app.get("/v1/calendar", requireScope("history"), (c) => {
    const now = hub.clock();
    const year = new Date(istParts(now).day).getUTCFullYear();
    let from: number;
    let to: number;
    try {
      from = parseTime("from", c.req.query("from"), "start", true) ?? Date.UTC(year, 0, 1);
      to = parseTime("to", c.req.query("to"), "end", true) ?? Date.UTC(year, 11, 31);
      if (from > to) throw new ParamError("from must not be after to.");
      if ((to - from) / DAY_MS > MAX_CALENDAR_DAYS) throw new ParamError(`from..to may span at most ${MAX_CALENDAR_DAYS} days.`);
    } catch (error) {
      if (error instanceof ParamError) return c.json(errorBody(error.message, "bad_request"), 400);
      throw error;
    }
    const cal = syncCalendar(hub.db);
    const tradingDays: string[] = [];
    const holidays: Array<{ date: string; day: number; name: string | null; source: string; weekend: boolean }> = [];
    const specialSessions: Array<{ date: string; day: number; name: string | null; source: string; session: { open: string; close: string } }> = [];
    for (let day = from; day <= to; day += DAY_MS) {
      const info = cal.info(day);
      if (info.trading) {
        tradingDays.push(isoDay(day));
        if (info.kind === "special" && info.hours) specialSessions.push({ date: isoDay(day), day, name: info.name, source: info.source, session: { open: hhmm(info.hours.open), close: hhmm(info.hours.close) } });
      } else if (info.kind === "holiday" || info.name !== null) holidays.push({ date: isoDay(day), day, name: info.name, source: info.source, weekend: !isWeekday(day) });
    }
    const fromYear = new Date(from).getUTCFullYear();
    const toYear = new Date(to).getUTCFullYear();
    const lists = cal.lists.filter((list) => list.holidays && list.year >= fromYear && list.year <= toYear).map((list) => ({ year: list.year, source: list.source, url: list.url ?? null }));
    const status = calendarStatus(now, cal);
    return c.json({
      from: isoDay(from),
      to: isoDay(to),
      today: status.today,
      tradingToday: status.tradingDay,
      nextTradingDay: status.nextTradingDay,
      previousTradingDay: status.previousTradingDay,
      listedYears: status.listedYears,
      lists,
      tradingDays,
      holidays,
      specialSessions,
    });
  });
}
