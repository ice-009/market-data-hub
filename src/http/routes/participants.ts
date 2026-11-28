import type { Hono } from "hono";
import type { Hub } from "../../hub.js";
import { PARTICIPANTS, netPositions, type ParticipantPositions } from "../../nse/parsers/participantOi.js";
import { participantGaps, participantNotes, participantSpan, readParticipants } from "../../nse/participantStore.js";
import { isoDay } from "../../time.js";
import { errorBody, requireScope, type HubEnv } from "../common.js";
import { ParamError, parseRange } from "../params.js";

// Participant-wise F&O open interest (market-data-hub#28), from NSE's
// fao_participant_oi file (src/nse/participantStore.ts):
//   GET /v1/fo/participants[?from&to]   fo   per trade day, each participant type's long
//                                            and short positions and its net, in contracts
// A day's file describes positions at that day's close and is published that
// evening: a day's row never depends on a later file.

/** Default range: this many calendar days up to `to`. */
export const PARTICIPANT_DEFAULT_DAYS = 365;

const round = (value: number) => Number(value.toFixed(4));

/** One participant type's positions as served: NSE's figures, then the nets (long − short). */
export function positionsJson(p: ParticipantPositions) {
  const net = netPositions(p);
  return {
    indexFuturesLong: p.futIdxLong,
    indexFuturesShort: p.futIdxShort,
    indexFuturesNet: round(net.futIdx),
    // The share of the participant's index-futures positions that are long (the "long–short ratio" often quoted for FIIs).
    indexFuturesLongShare: p.futIdxLong + p.futIdxShort > 0 ? round(p.futIdxLong / (p.futIdxLong + p.futIdxShort)) : null,
    stockFuturesLong: p.futStkLong,
    stockFuturesShort: p.futStkShort,
    stockFuturesNet: round(net.futStk),
    indexCallLong: p.optIdxCallLong,
    indexCallShort: p.optIdxCallShort,
    indexCallNet: round(net.optIdxCall),
    indexPutLong: p.optIdxPutLong,
    indexPutShort: p.optIdxPutShort,
    indexPutNet: round(net.optIdxPut),
    stockCallLong: p.optStkCallLong,
    stockCallShort: p.optStkCallShort,
    stockCallNet: round(net.optStkCall),
    stockPutLong: p.optStkPutLong,
    stockPutShort: p.optStkPutShort,
    stockPutNet: round(net.optStkPut),
    totalLong: p.totalLong,
    totalShort: p.totalShort,
    totalNet: round(net.total),
  };
}

export function participantRoutes(app: Hono<HubEnv>, hub: Hub) {
  app.get("/v1/fo/participants", requireScope("fo"), (c) => {
    let range: { from: number; to: number };
    try {
      range = parseRange({ from: c.req.query("from"), to: c.req.query("to") }, true, PARTICIPANT_DEFAULT_DAYS, hub.clock());
    } catch (error) {
      if (error instanceof ParamError) return c.json(errorBody(error.message, "bad_request"), 400);
      throw error;
    }
    const span = participantSpan(hub.db);
    if (span.first === null || span.last === null) {
      return c.json(errorBody("No participant-wise OI is stored yet: the hub fetches NSE's file in the evening, and `hub data nse-history --only participants` reads the archive (from 2 Jan 2012).", "not_ready"), 503);
    }
    const notes = participantNotes(hub.db, range.from, range.to);
    const days = readParticipants(hub.db, range.from, range.to).map(({ day, rows }) => ({
      date: isoDay(day),
      day,
      ...(notes.has(day) ? { note: notes.get(day) } : {}),
      participants: Object.fromEntries(PARTICIPANTS.filter((who) => rows.has(who)).map((who) => [who, positionsJson(rows.get(who)!)])),
      total: rows.has("total") ? positionsJson(rows.get("total")!) : null,
    }));
    const missing = participantGaps(hub.db, Math.max(range.from, span.first), range.to).map((gap) => ({ date: isoDay(gap.day), day: gap.day, reason: gap.reason }));
    return c.json({
      from: isoDay(range.from),
      to: isoDay(range.to),
      unit: "contracts",
      knownFrom: isoDay(span.first),
      knownFromDay: span.first,
      lastDate: isoDay(span.last),
      lastDay: span.last,
      days,
      missing,
    });
  });
}
