// NSE's participant-wise open interest (content/nsccl/fao_participant_oi_DDMMYYYY.csv,
// from 2 Jan 2012): the F&O market's open positions at the day's close, split
// by who holds them — Client (retail and other non-institutional accounts),
// DII, FII and Pro (brokers' own books) — plus NSE's TOTAL row. Every figure
// is a number of contracts (not shares, not lots of the underlying), long and
// short separately, in index and stock futures, and index and stock calls and
// puts. Layout:
//   "Participant wise Open Interest (no. of contracts) in Equity Derivatives as on Nov 03, 2025",,,…
//   Client Type,Future Index Long,Future Index Short,Future Stock Long,…,Total Long Contracts,Total Short Contracts
//   Client,179540,86208,2832730,…
//   DII,…  FII,…  Pro,…  TOTAL,…
// What NSE has varied over the years (all seen in real files):
//   - the title's date: "January 02, 2012", "Jun 01, 2016", "Sep 03,2019", "Oct 01
//     2019" (Oct 2019 – Apr 2020), "Mar 01,"2024"""""" (the year in a cell of its
//     own, Mar–Apr 2024); the title is in quotes, doubled quotes
//     (""Participant wise…"", from 2019) or none;
//   - the header: "CLIENT_TYPE" (first week of Jan 2012), stray spaces and tabs
//     after some names ("Future Stock Short       ");
//   - row labels: "FII " with a trailing space, "Total" for "TOTAL", the FII row
//     before the DII row (2 Jan 2012);
//   - numbers: plain integers, "NA" for no position (3 Jan 2012; the row's
//     totals add up with NA as 0), Indian-grouped decimals in quotes
//     ("2,48,292.00", 23 Jan 2012), and fractions of a contract after a lot
//     change ("909608.3333" in Oct 2015, when NIFTY's lot went from 25 to 75:
//     an old contract counts as a third of a new one). Kept as NSE printed them.
// Columns are read by name, so an added column doesn't shift the others; one
// the hub doesn't know is reported (`extraColumns`), not read. Pure.

export const PARTICIPANTS = ["client", "dii", "fii", "pro"] as const;
export type Participant = (typeof PARTICIPANTS)[number];
/** The four participant types and NSE's own TOTAL row. */
export type ParticipantRow = Participant | "total";

/** One participant type's open positions, in contracts (a fraction after some lot changes). */
export interface ParticipantPositions {
  futIdxLong: number;
  futIdxShort: number;
  futStkLong: number;
  futStkShort: number;
  optIdxCallLong: number;
  optIdxPutLong: number;
  optIdxCallShort: number;
  optIdxPutShort: number;
  optStkCallLong: number;
  optStkPutLong: number;
  optStkCallShort: number;
  optStkPutShort: number;
  totalLong: number;
  totalShort: number;
}
export type PositionField = keyof ParticipantPositions;

/** NSE's column names (lowercased, `_` and runs of whitespace as one space) → field. */
const COLUMNS: Record<string, PositionField> = {
  "future index long": "futIdxLong",
  "future index short": "futIdxShort",
  "future stock long": "futStkLong",
  "future stock short": "futStkShort",
  "option index call long": "optIdxCallLong",
  "option index put long": "optIdxPutLong",
  "option index call short": "optIdxCallShort",
  "option index put short": "optIdxPutShort",
  "option stock call long": "optStkCallLong",
  "option stock put long": "optStkPutLong",
  "option stock call short": "optStkCallShort",
  "option stock put short": "optStkPutShort",
  "total long contracts": "totalLong",
  "total short contracts": "totalShort",
};
export const POSITION_FIELDS = Object.values(COLUMNS);
/** The long and short fields that make up each participant's total long and total short. */
export const LONG_FIELDS: readonly PositionField[] = ["futIdxLong", "futStkLong", "optIdxCallLong", "optIdxPutLong", "optStkCallLong", "optStkPutLong"];
export const SHORT_FIELDS: readonly PositionField[] = ["futIdxShort", "futStkShort", "optIdxCallShort", "optIdxPutShort", "optStkCallShort", "optStkPutShort"];

const LABELS: Record<string, ParticipantRow> = { client: "client", dii: "dii", fii: "fii", pro: "pro", total: "total" };

export interface ParticipantOiParse {
  /** The date in the file's title (UTC midnight ms), or null when it has none that can be read. */
  tradeDate: number | null;
  /** Rows found, by participant type, in file order. */
  rows: Map<ParticipantRow, ParticipantPositions>;
  /** Labels in the order the file has them (the swap of 2 Jan 2012 shows here). */
  order: ParticipantRow[];
  /** Known columns the header lacks; non-empty means the rows couldn't be read. */
  missingColumns: PositionField[];
  /** Header names the hub doesn't know (ignored). */
  extraColumns: string[];
  /** Cells "NA" or empty, read as 0. */
  naCells: number;
  /** Rows that couldn't be read: an unknown label, a repeated one, or a cell that isn't a number. */
  badRows: number;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** The title's "as on Nov 03, 2025" (or "January 02, 2012", "Jun 01,2020", "Oct 01 2019") as a day key, or null. */
export function participantTitleDate(line: string): number | null {
  const match = /as\s+on\s+([A-Za-z]{3,9})\.?\s+(\d{1,2})\s*,?\s*(\d{4})/i.exec(line);
  if (!match) return null;
  const month = MONTHS.indexOf(match[1].slice(0, 3).toLowerCase());
  const [day, year] = [Number(match[2]), Number(match[3])];
  if (month < 0) return null;
  const t = Date.UTC(year, month, day);
  return new Date(t).getUTCDate() === day ? t : null;
}

/** Split one CSV line, honouring double quotes ("2,48,292.00"). */
function cells(line: string): string[] {
  if (!line.includes('"')) return line.split(",");
  const out: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else quoted = !quoted;
    } else if (ch === "," && !quoted) {
      out.push(cell);
      cell = "";
    } else cell += ch;
  }
  out.push(cell);
  return out;
}

const normalize = (name: string) => name.replace(/["_]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();

/** A number of contracts: "179540", "2,48,292.00", "909608.3333", "NA" or "" (0, flagged). Null when it isn't a number. */
function contracts(raw: string): { value: number; na: boolean } | null {
  const text = raw.replace(/"/g, "").trim();
  if (text === "" || /^(na|-)$/i.test(text)) return { value: 0, na: true };
  const plain = text.replace(/,/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(plain)) return null;
  return { value: Number(plain), na: false };
}

export function parseParticipantOi(text: string): ParticipantOiParse {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const out: ParticipantOiParse = { tradeDate: null, rows: new Map(), order: [], missingColumns: [], extraColumns: [], naCells: 0, badRows: 0 };
  let header: Array<PositionField | null> | null = null;
  for (const line of lines) {
    if (!line.replace(/[",\s]/g, "")) continue;
    if (out.tradeDate === null && /participant\s+wise/i.test(line)) {
      out.tradeDate = participantTitleDate(line.replace(/"/g, ""));
      continue;
    }
    const row = cells(line);
    const first = normalize(row[0] ?? "");
    if (header === null) {
      if (first !== "client type") continue;
      header = row.slice(1).map((name) => COLUMNS[normalize(name)] ?? null);
      out.extraColumns = row.slice(1).filter((name, i) => header![i] === null && normalize(name) !== "").map((name) => name.trim());
      out.missingColumns = POSITION_FIELDS.filter((field) => !header!.includes(field));
      if (out.missingColumns.length) break;
      continue;
    }
    const label = LABELS[first];
    if (!label || out.rows.has(label)) {
      out.badRows += 1;
      continue;
    }
    const positions = {} as ParticipantPositions;
    let na = 0;
    let ok = true;
    header.forEach((field, i) => {
      if (field === null) return;
      const value = contracts(row[i + 1] ?? "");
      if (!value) ok = false;
      else {
        positions[field] = value.value;
        if (value.na) na += 1;
      }
    });
    if (!ok) {
      out.badRows += 1;
      continue;
    }
    out.naCells += na;
    out.rows.set(label, positions);
    out.order.push(label);
  }
  if (header === null) out.missingColumns = [...POSITION_FIELDS];
  return out;
}

/** Each participant's long positions less its short ones, per instrument (contracts). Pure. */
export function netPositions(p: ParticipantPositions) {
  return {
    futIdx: p.futIdxLong - p.futIdxShort,
    futStk: p.futStkLong - p.futStkShort,
    optIdxCall: p.optIdxCallLong - p.optIdxCallShort,
    optIdxPut: p.optIdxPutLong - p.optIdxPutShort,
    optStkCall: p.optStkCallLong - p.optStkCallShort,
    optStkPut: p.optStkPutLong - p.optStkPutShort,
    total: p.totalLong - p.totalShort,
  };
}
