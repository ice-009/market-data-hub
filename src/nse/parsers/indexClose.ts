// NSE's daily index file (content/indices/ind_close_all_DDMMYYYY.csv, from
// early 2012): one row per index NSE computes — Nifty 50, the sector indices,
// India VIX, bond indices… — with the day's open/high/low/close, change,
// volume, turnover and P/E, P/B, dividend yield. Columns are read by position
// (the header has been seen cut short: "…,P/B," with no "Div Yield" in Mar
// 2012). Indices NSE only computes a close for print "-" for open/high/low;
// unknown numbers are null. The file's own trade date (Index Date,
// DD-MM-YYYY) is returned so the caller can reject a file served for another
// day. Some files print it month first instead (6, 10 and 11 Apr 2023 say
// "04-06-2023", "04-10-2023", "04-11-2023"): given the day asked for, a date
// that reads as that day month first is that day. Pure.

export interface IndexCloseRow {
  /** The index's name as NSE printed it that day ("S&P CNX Nifty" in 2012, "Nifty 50" now). */
  name: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  pointsChange: number | null;
  changePct: number | null;
  volume: number | null;
  turnoverCr: number | null;
  pe: number | null;
  pb: number | null;
  divYield: number | null;
}

export interface IndexCloseParse {
  tradeDate: number | null;
  mixedDates: boolean;
  rows: IndexCloseRow[];
  badRows: number;
}

/** Day key of a calendar date (month 1–12), or null when there is no such date. */
function utcDay(year: number, month: number, day: number): number | null {
  const t = Date.UTC(year, month - 1, day);
  const date = new Date(t);
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? t : null;
}

/**
 * "17-11-2026" → day key, or null. With `expected` (the day asked for), a
 * date that is `expected` read month first ("04-06-2023" for 6 Apr 2023) is
 * `expected`; one that is neither reads day first where it can.
 */
export function parseDdMmYyyy(value: string, expected?: number): number | null {
  const match = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(value.trim());
  if (!match) return null;
  const [first, second, year] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const dayFirst = utcDay(year, second, first);
  if (expected === undefined || dayFirst === expected) return dayFirst;
  const monthFirst = utcDay(year, first, second);
  return monthFirst === expected ? monthFirst : (dayFirst ?? monthFirst);
}

/** Split one CSV line, honouring double quotes (no index name has had a comma yet, but one may). */
function cells(line: string): string[] {
  if (!line.includes('"')) return line.split(",");
  const out: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else quoted = !quoted;
    } else if (char === "," && !quoted) {
      out.push(cell);
      cell = "";
    } else cell += char;
  }
  out.push(cell);
  return out;
}

const num = (value: string | undefined): number | null => {
  const text = (value ?? "").trim();
  if (text === "" || text === "-") return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
};

/** Open/high/low/close must be positive to count; anything else is unknown. */
const price = (value: string | undefined): number | null => {
  const n = num(value);
  return n !== null && n > 0 ? n : null;
};

/** `expected`: the day the file was asked for (see parseDdMmYyyy). */
export function parseIndexClose(csv: string, expected?: number): IndexCloseParse {
  const lines = (csv.charCodeAt(0) === 0xfeff ? csv.slice(1) : csv).split(/\r?\n/);
  const header = (lines[0] ?? "").toLowerCase();
  if (!header.startsWith("index name") || !header.includes("closing index value")) return { tradeDate: null, mixedDates: false, rows: [], badRows: 0 };
  const byName = new Map<string, IndexCloseRow>();
  const dates = new Set<number>();
  let badRows = 0;
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const [name, date, open, high, low, close, points, pct, volume, turnover, pe, pb, dy] = cells(line).map((cell) => cell.trim());
    const day = parseDdMmYyyy(date ?? "", expected);
    const closeValue = price(close);
    if (!name || day === null || closeValue === null) {
      badRows += 1;
      continue;
    }
    dates.add(day);
    byName.set(name, {
      name,
      open: price(open),
      high: price(high),
      low: price(low),
      close: closeValue,
      pointsChange: num(points),
      changePct: num(pct),
      volume: num(volume),
      turnoverCr: num(turnover),
      pe: num(pe),
      pb: num(pb),
      divYield: num(dy),
    });
  }
  const sorted = [...dates].sort((a, b) => a - b);
  return { tradeDate: sorted.at(-1) ?? null, mixedDates: sorted.length > 1, rows: [...byName.values()], badRows };
}
