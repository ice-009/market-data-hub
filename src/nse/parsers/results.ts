// NSE's board-meetings file → financial-results events. Pure: no I/O.
// The file is bmDDMMYYYY.txt (BmDDMMYY.txt in older zips) inside the daily PR
// zip; the download lives in src/nse/datasets.ts. It lists the board meetings
// companies told NSE about that day — not the whole calendar — so the calendar
// is the union of recent days' files. Since 2010 the layout has been:
//
//   COMPANY NAME    SYMBOL     : BM DATE    : BM PURPOSE
//   Indusind Bank Limited INDUSINDBK : 23-OCT-2026 : Financial Results To consider and approve …
//   Meghmani Organics Limited    MEGH       : 29-OCT-2010 : Un-audited Financial Results To consider, …
//
// The symbol is the last word before the first " : ". A long purpose can run
// onto lines of its own (no symbol or date): those are skipped.

export interface ResultsEvent {
  symbol: string;
  company: string;
  /** UTC midnight of the IST date, ms. */
  date: number;
  purpose: string;
}

export interface BoardMeeting {
  symbol: string;
  company: string;
  /** The meeting's date: UTC midnight of the IST date, ms. */
  date: number;
  /** NSE's text: the purposes ("Financial Results/Dividend") followed by the company's description. */
  purpose: string;
}

export interface BoardMeetingsParse {
  meetings: BoardMeeting[];
  /** Rows whose date couldn't be read (like 12-ABC-2026). */
  badRows: number;
}

const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/** "09-Oct-2026" or "2026-10-09" → UTC midnight ms. */
export function parseNseDate(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const dmy = value.trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
  if (dmy) {
    const month = MONTHS[dmy[2].toLowerCase()];
    return month === undefined ? null : Date.UTC(Number(dmy[3]), month, Number(dmy[1]));
  }
  const iso = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  return iso ? Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])) : null;
}

/** "bm17112026.txt" or "Bm100718.txt" → the day it's for (UTC midnight ms), or null. */
export function boardMeetingsFileDay(name: string): number | null {
  const match = name.match(/^bm(\d{2})(\d{2})(\d{4}|\d{2})\.txt$/i);
  if (!match) return null;
  const year = match[3].length === 2 ? 2000 + Number(match[3]) : Number(match[3]);
  const day = Date.UTC(year, Number(match[2]) - 1, Number(match[1]));
  return new Date(day).getUTCDate() === Number(match[1]) ? day : null;
}

const ROW = /^(.*?)\s+(\S+)\s+:\s+(\d{1,2}-[A-Za-z]{3}-\d{4})\s+:\s?(.*)$/;

export function parseBoardMeetings(text: string): BoardMeetingsParse {
  const meetings: BoardMeeting[] = [];
  let badRows = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^COMPANY NAME\s/i.test(line)) continue;
    const row = line.match(ROW);
    if (!row) continue; // a purpose's continuation line
    const date = parseNseDate(row[3]);
    if (date === null) {
      badRows += 1;
      continue;
    }
    meetings.push({ symbol: row[2].toUpperCase(), company: row[1], date, purpose: row[4].trim() });
  }
  return { meetings, badRows };
}

/** The meetings that are about financial results, one event per symbol and date. */
export function resultsEvents(meetings: BoardMeeting[]): ResultsEvent[] {
  return dedupeEvents(meetings.filter((meeting) => /result/i.test(meeting.purpose)).map((meeting) => ({ ...meeting, purpose: meeting.purpose.slice(0, 120) })));
}

/**
 * NSE lists some companies more than once for the same meeting (e.g. "Financial Results" and
 * "Financial Results/Dividend" as separate rows). Keep one event per symbol and date, joining
 * the distinct purposes.
 */
export function dedupeEvents(events: ResultsEvent[]): ResultsEvent[] {
  const byKey = new Map<string, ResultsEvent>();
  for (const event of events) {
    const key = `${event.symbol}|${event.date}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...event });
      continue;
    }
    const purposes = new Set([...existing.purpose.split(" · "), event.purpose].map((purpose) => purpose.trim()).filter(Boolean));
    existing.purpose = [...purposes].join(" · ").slice(0, 160);
  }
  return [...byKey.values()].sort((a, b) => a.date - b.date || a.symbol.localeCompare(b.symbol));
}
