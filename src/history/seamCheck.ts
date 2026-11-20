import type { Bar } from "../broker/fyers.js";
import type { Db } from "../db.js";
import { getUniverse } from "../reference/universe.js";
import { DAY_MS, isoDay, istDayKey } from "../time.js";
import { archiveContext, archiveDaily } from "./fromArchive.js";
import { archivePartOrNull, brokerSeam, handover, storedReference } from "./longDaily.js";
import { readBars } from "./store.js";

// `hub data history --check` (#22, ice-009/tradex-public#16): what /v1/candles
// serves for every current F&O stock over its whole history — the archive
// before the broker's window, the stored series inside it — checked for the
// three ways joining can go wrong:
//
//   seam     the adjusted archive and the stored series disagree at the
//            hand-over: after the scale (src/history/longDaily.ts), their closes
//            over the next CHECK_SESSIONS sessions both have must match within
//            the tolerance (a missed split inside the window, or a bad bar,
//            shows here);
//   jump     the move from the last archive close to the first stored open is
//            beyond JUMP_LIMIT (a price band never allows it; a missing factor does);
//   gap      a stored cash session in which the listing traded (a row under the
//            name it had that day) is missing from the served series — across a
//            rename this is the join failing.
//
// Meaningful against a broker's series; in end-of-day mode both sides are the
// archive with the same factors and agree by construction.

export const CHECK_SESSIONS = 20;
/** The largest open-to-previous-close move NSE's bands allow is 20%; beyond 35% is no market move. */
export const JUMP_LIMIT = Math.log(1.35);

export interface SeamRow {
  symbol: string;
  /** The tickers the archive part was read under. */
  names: string[];
  archiveFrom: string | null;
  handover: string;
  /** The scale applied to the archive (1: the hub's factors as they are), and the median ratio measured. */
  scale: number;
  gapPct: number | null;
  /** Sessions compared after scaling, and the largest difference among them (%). */
  compared: number;
  maxDiffPct: number | null;
  /** Last archive close → first stored open (%). */
  jumpPct: number | null;
  /** Sessions the listing traded that the served series lacks. */
  missing: string[];
  problems: Array<"seam" | "jump" | "gap">;
}

export interface SeamReport {
  seam: string;
  tolerance: number;
  symbols: number;
  checked: number;
  /** Stocks whose archive was scaled to the broker's level, and how far (median |gap|, %). */
  scaled: number;
  medianAbsGapPct: number | null;
  /** Stocks joined across a rename. */
  renamed: number;
  problems: { seam: number; jump: number; gap: number };
  rows: SeamRow[];
}

const pct = (value: number) => Math.round(value * 1e4) / 100;

export function checkSeams(db: Db, now: number, options: { symbols?: readonly string[]; tolerance?: number } = {}): SeamReport {
  const tolerance = options.tolerance ?? 0.01;
  const seam = brokerSeam(now);
  const today = istDayKey(now);
  const symbols = options.symbols?.length ? [...options.symbols] : getUniverse(db, "fno", now).members.map((member) => member.symbol);
  const context = archiveContext(db);
  const sessions = [...context.statuses].filter(([, status]) => status === "ok").map(([day]) => day).sort((a, b) => a - b);
  const report: SeamReport = { seam: isoDay(seam), tolerance, symbols: symbols.length, checked: 0, scaled: 0, medianAbsGapPct: null, renamed: 0, problems: { seam: 0, jump: 0, gap: 0 }, rows: [] };
  const gaps: number[] = [];
  for (const symbol of symbols) {
    const until = handover(db, symbol, seam);
    const reference = storedReference(db, symbol, until);
    const part = archivePartOrNull(db, symbol, Number.MIN_SAFE_INTEGER / 2, until, reference, { adjusted: true, today, context });
    if (!part?.bars.length) continue;
    report.checked += 1;
    const names = part.span?.names ?? [symbol];
    if (names.length > 1) report.renamed += 1;
    if (part.fit.scale !== 1) report.scaled += 1;
    if (part.fit.gap !== null) gaps.push(Math.abs(part.fit.gap));

    // After scaling: the archive against the stored series over the next sessions.
    const stored = readBars(db, symbol, "1d", until, until + 3 * CHECK_SESSIONS * DAY_MS);
    const after = archiveDaily(db, symbol, until, until + 3 * CHECK_SESSIONS * DAY_MS, { context, listingDay: today });
    const archiveAt = new Map(after.bars.map((bar) => [bar.t, bar.c * part.fit.scale]));
    let compared = 0;
    let maxDiff: number | null = null;
    for (const bar of stored) {
      const c = archiveAt.get(bar.t);
      if (c === undefined || !(c > 0) || !(bar.c > 0)) continue;
      const diff = Math.abs(Math.log(bar.c / c));
      maxDiff = Math.max(maxDiff ?? 0, diff);
      if ((compared += 1) >= CHECK_SESSIONS) break;
    }
    const last: Bar = part.bars[part.bars.length - 1];
    const first = stored[0];
    const jump = first && last.c > 0 && first.o > 0 ? Math.log(first.o / last.c) : null;

    // Sessions the listing traded (a cash row under any of its names) missing from what's served.
    const served = new Set(part.bars.map((bar) => bar.t));
    const traded = new Set(archiveDaily(db, symbol, part.bars[0].t, until - DAY_MS, { adjusted: false, context, listingDay: today }).bars.map((bar) => bar.t));
    const missing = sessions.filter((day) => day >= part.bars[0].t && day < until && traded.has(day) && !served.has(day));

    const problems: SeamRow["problems"] = [];
    if (maxDiff !== null && maxDiff > Math.log(1 + tolerance)) problems.push("seam");
    if (jump !== null && Math.abs(jump) > JUMP_LIMIT) problems.push("jump");
    if (missing.length) problems.push("gap");
    for (const problem of problems) report.problems[problem] += 1;
    report.rows.push({
      symbol,
      names,
      archiveFrom: isoDay(part.bars[0].t),
      handover: isoDay(until),
      scale: Math.round(part.fit.scale * 1e6) / 1e6,
      gapPct: part.fit.gap === null ? null : pct(part.fit.gap),
      compared,
      maxDiffPct: maxDiff === null ? null : pct(Math.exp(maxDiff) - 1),
      jumpPct: jump === null ? null : pct(Math.exp(jump) - 1),
      missing: missing.slice(0, 10).map(isoDay),
      problems,
    });
  }
  const sorted = gaps.sort((a, b) => a - b);
  report.medianAbsGapPct = sorted.length ? pct(sorted[sorted.length >> 1]) : null;
  return report;
}
