import type { Db } from "../db.js";
import { POSITION_FIELDS, type ParticipantPositions, type ParticipantRow, type PositionField } from "./parsers/participantOi.js";
import { markDay } from "./store.js";

// Storage for NSE's participant-wise open interest (migration 14;
// market-data-hub#28): fo_participants holds each trade day's five rows
// (client, dii, fii, pro and NSE's total) exactly as the file has them, in
// contracts. Each day asked for is in nse_days as dataset `fo_participants`,
// like the other day files: "ok" stored, "holiday" no file, "mismatch" a file
// for another date. Size: ~3,700 trade days since 2012 × 5 rows ≈ 18,500 rows,
// about 2 MB.

const COLUMN: Record<PositionField, string> = {
  futIdxLong: "fut_idx_long",
  futIdxShort: "fut_idx_short",
  futStkLong: "fut_stk_long",
  futStkShort: "fut_stk_short",
  optIdxCallLong: "opt_idx_call_long",
  optIdxPutLong: "opt_idx_put_long",
  optIdxCallShort: "opt_idx_call_short",
  optIdxPutShort: "opt_idx_put_short",
  optStkCallLong: "opt_stk_call_long",
  optStkPutLong: "opt_stk_put_long",
  optStkCallShort: "opt_stk_call_short",
  optStkPutShort: "opt_stk_put_short",
  totalLong: "total_long",
  totalShort: "total_short",
};
const COLUMNS = POSITION_FIELDS.map((field) => COLUMN[field]);

export interface ParticipantDay {
  day: number;
  rows: Map<ParticipantRow, ParticipantPositions>;
}

/** Replace one trade day's rows and record the day as stored (`note`: a correction the hub made, if any). */
export function writeParticipantDay(db: Db, day: number, rows: ReadonlyMap<ParticipantRow, ParticipantPositions>, checkedAt: number, note: string | null = null) {
  const insert = db.prepare(`insert into fo_participants (day, participant, ${COLUMNS.join(", ")}) values (?, ?, ${COLUMNS.map(() => "?").join(", ")})`);
  db.transaction(() => {
    db.prepare("delete from fo_participants where day = ?").run(day);
    for (const [participant, positions] of rows) insert.run(day, participant, ...POSITION_FIELDS.map((field) => positions[field]));
    markDay(db, "fo_participants", day, "ok", rows.size, checkedAt, note);
  })();
}

/** Stored days with from <= day <= to, oldest first. */
export function readParticipants(db: Db, from = Number.MIN_SAFE_INTEGER, to = Number.MAX_SAFE_INTEGER): ParticipantDay[] {
  const rows = db.prepare(`select day, participant, ${COLUMNS.join(", ")} from fo_participants where day between ? and ? order by day`).all(from, to) as Array<Record<string, number | string>>;
  const out: ParticipantDay[] = [];
  for (const row of rows) {
    const day = row.day as number;
    if (out.at(-1)?.day !== day) out.push({ day, rows: new Map() });
    const positions = Object.fromEntries(POSITION_FIELDS.map((field) => [field, row[COLUMN[field]] as number])) as unknown as ParticipantPositions;
    out.at(-1)!.rows.set(row.participant as ParticipantRow, positions);
  }
  return out;
}

/** Notes the hub recorded on stored days (corrections it made to NSE's file), by day. */
export function participantNotes(db: Db, from: number, to: number): Map<number, string> {
  const rows = db.prepare("select day, note from nse_days where dataset = 'fo_participants' and status = 'ok' and note is not null and day between ? and ?").all(from, to) as Array<{ day: number; note: string }>;
  return new Map(rows.map((row) => [row.day, row.note]));
}

/** The first and newest stored day, and how many. */
export function participantSpan(db: Db): { first: number | null; last: number | null; days: number } {
  return db.prepare("select min(day) as first, max(day) as last, count(distinct day) as days from fo_participants").get() as { first: number | null; last: number | null; days: number };
}

/**
 * F&O sessions (stored F&O bhavcopy days) from..to with no stored participant
 * file, and whether NSE was asked for one: "no_file" (its archive has none,
 * or only another day's) or "not_downloaded".
 */
export function participantGaps(db: Db, from: number, to: number): Array<{ day: number; reason: "no_file" | "not_downloaded" }> {
  const rows = db
    .prepare(
      `select f.day, p.status from nse_days f
       left join nse_days p on p.dataset = 'fo_participants' and p.day = f.day
       where f.dataset = 'fo_bhav' and f.status = 'ok' and f.day between ? and ?
         and (p.status is null or p.status != 'ok')
       order by f.day`,
    )
    .all(from, to) as Array<{ day: number; status: string | null }>;
  return rows.map((row) => ({ day: row.day, reason: row.status === null ? "not_downloaded" : "no_file" }));
}

/** A signature of what's stored (for the data-quality runner: recheck when it changes). */
export function participantSignature(db: Db): string {
  const row = db.prepare("select count(*) as n, max(checked_at) as at from nse_days where dataset = 'fo_participants'").get() as { n: number; at: number | null };
  return `${row.n}|${row.at ?? 0}`;
}
