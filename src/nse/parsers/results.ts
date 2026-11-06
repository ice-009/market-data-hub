// NSE event-calendar JSON → financial-results events. Pure: no I/O.
// The download lives in src/nse/datasets.ts. (Ported from Tradex, MIT.)

export interface ResultsEvent {
  symbol: string;
  company: string;
  /** UTC midnight of the IST date, ms. */
  date: number;
  purpose: string;
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

/** Keep rows that are about financial results; tolerate the field-name variants NSE has used. */
export function parseCalendar(json: unknown): ResultsEvent[] {
  const rows = Array.isArray(json) ? json : Array.isArray((json as { data?: unknown })?.data) ? (json as { data: unknown[] }).data : [];
  const events: ResultsEvent[] = [];
  for (const raw of rows) {
    const row = raw as Record<string, unknown>;
    const symbol = typeof row.symbol === "string" ? row.symbol.trim().toUpperCase() : "";
    const purpose = String(row.purpose ?? row.bm_purpose ?? row.bm_desc ?? "");
    const date = parseNseDate(row.date ?? row.bm_date ?? row.meetingDate);
    if (!symbol || date === null || !/result/i.test(purpose)) continue;
    events.push({ symbol, company: String(row.company ?? row.sm_name ?? symbol), date, purpose: purpose.slice(0, 120) });
  }
  return dedupeEvents(events);
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

