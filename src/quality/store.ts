import type { Db } from "../db.js";

// Storage for the data-quality checks (migration 8; the checks are in ./checks.ts,
// the runner in ./run.ts). A finding is keyed by (check, trade day, subject);
// writing one again refreshes it, and a check that re-examines a day resolves
// the findings it no longer produces (resolved_at), so the table keeps history
// without repeating itself.

export const CHECKS = ["missing_session", "unlisted_session", "calendar_mismatch", "wrong_date", "repeated_file", "candle_gap", "price_outlier", "broker_mismatch", "lot_change", "fo_list_change", "lot_file_mismatch"] as const;
export type CheckName = (typeof CHECKS)[number];
export type Severity = "problem" | "warning" | "info";

export interface Finding {
  check: CheckName;
  /** Day key of the trade date it's about. */
  day: number;
  /** What it's about: a dataset (cash_bhav…), a symbol, "calendar" or "fo". */
  subject: string;
  severity: Severity;
  message: string;
  detail?: Record<string, unknown> | null;
}

export interface StoredFinding extends Finding {
  firstSeenAt: number;
  lastSeenAt: number;
  resolvedAt: number | null;
}

/**
 * Write a check's findings for a scope: each one is inserted or refreshed, and
 * the scope's open findings that weren't produced again are resolved. `scope`
 * picks the rows the check re-examined: a list of days, or every day (null).
 * Returns the findings seen for the first time (or again after being resolved).
 */
export function saveFindings(db: Db, check: CheckName, scope: { days: readonly number[] } | null, findings: readonly Finding[], now: number): Finding[] {
  const fresh: Finding[] = [];
  const existing = db.prepare("select resolved_at from quality_findings where check_name = ? and day = ? and subject = ?");
  const upsert = db.prepare(
    `insert into quality_findings (check_name, day, subject, severity, message, detail, first_seen_at, last_seen_at, resolved_at)
     values (@check, @day, @subject, @severity, @message, @detail, @now, @now, null)
     on conflict(check_name, day, subject) do update set severity = excluded.severity, message = excluded.message, detail = excluded.detail,
       last_seen_at = excluded.last_seen_at, resolved_at = null,
       first_seen_at = case when quality_findings.resolved_at is null then quality_findings.first_seen_at else excluded.first_seen_at end`,
  );
  db.transaction(() => {
    const seen = new Set<string>();
    for (const finding of findings) {
      if (finding.check !== check) throw new Error(`finding for ${finding.check} saved as ${check}`);
      const key = `${finding.day}|${finding.subject}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const before = existing.get(check, finding.day, finding.subject) as { resolved_at: number | null } | undefined;
      if (!before || before.resolved_at !== null) fresh.push(finding);
      upsert.run({ check, day: finding.day, subject: finding.subject, severity: finding.severity, message: finding.message, detail: finding.detail ? JSON.stringify(finding.detail) : null, now });
    }
    const open = (scope === null
      ? db.prepare("select day, subject from quality_findings where check_name = ? and resolved_at is null").all(check)
      : scope.days.flatMap((day) => db.prepare("select day, subject from quality_findings where check_name = ? and day = ? and resolved_at is null").all(check, day))) as Array<{ day: number; subject: string }>;
    const resolve = db.prepare("update quality_findings set resolved_at = ? where check_name = ? and day = ? and subject = ?");
    for (const row of open) if (!seen.has(`${row.day}|${row.subject}`)) resolve.run(now, check, row.day, row.subject);
  })();
  return fresh;
}

/** Days a per-day check has looked at (day → when). */
export function checkedQualityDays(db: Db, check: CheckName): Map<number, number> {
  const rows = db.prepare("select day, checked_at from quality_checked where check_name = ?").all(check) as Array<{ day: number; checked_at: number }>;
  return new Map(rows.map((row) => [row.day, row.checked_at]));
}

export function markQualityDays(db: Db, check: CheckName, days: readonly number[], now: number) {
  const insert = db.prepare("insert into quality_checked (check_name, day, checked_at) values (?, ?, ?) on conflict(check_name, day) do update set checked_at = excluded.checked_at");
  db.transaction(() => {
    for (const day of days) insert.run(check, day, now);
  })();
}

/** Forget which days were checked (`hub data quality --full` checks everything again). */
export function forgetQualityDays(db: Db) {
  db.prepare("delete from quality_checked").run();
}

interface FindingRow {
  check_name: CheckName;
  day: number;
  subject: string;
  severity: Severity;
  message: string;
  detail: string | null;
  first_seen_at: number;
  last_seen_at: number;
  resolved_at: number | null;
}

const toFinding = (row: FindingRow): StoredFinding => ({
  check: row.check_name,
  day: row.day,
  subject: row.subject,
  severity: row.severity,
  message: row.message,
  detail: row.detail ? (JSON.parse(row.detail) as Record<string, unknown>) : null,
  firstSeenAt: row.first_seen_at,
  lastSeenAt: row.last_seen_at,
  resolvedAt: row.resolved_at,
});

export interface FindingQuery {
  check?: CheckName;
  /** Only this severity and worse. */
  severity?: Severity;
  subject?: string;
  from?: number;
  to?: number;
  status?: "open" | "resolved" | "all";
  limit?: number;
}

const WORSE_OR_EQUAL: Record<Severity, Severity[]> = { problem: ["problem"], warning: ["problem", "warning"], info: ["problem", "warning", "info"] };

/** Findings newest trade day first (worst first within a day). */
export function readFindings(db: Db, query: FindingQuery = {}): StoredFinding[] {
  const where: string[] = [];
  const params: unknown[] = [];
  const status = query.status ?? "open";
  if (status === "open") where.push("resolved_at is null");
  else if (status === "resolved") where.push("resolved_at is not null");
  if (query.check) {
    where.push("check_name = ?");
    params.push(query.check);
  }
  if (query.severity) {
    const allowed = WORSE_OR_EQUAL[query.severity];
    where.push(`severity in (${allowed.map(() => "?").join(", ")})`);
    params.push(...allowed);
  }
  if (query.subject) {
    where.push("subject = ?");
    params.push(query.subject);
  }
  if (query.from !== undefined) {
    where.push("day >= ?");
    params.push(query.from);
  }
  if (query.to !== undefined) {
    where.push("day <= ?");
    params.push(query.to);
  }
  const sql = `select * from quality_findings ${where.length ? `where ${where.join(" and ")}` : ""}
    order by day desc, case severity when 'problem' then 0 when 'warning' then 1 else 2 end, check_name, subject limit ?`;
  return (db.prepare(sql).all(...params, query.limit ?? 200) as FindingRow[]).map(toFinding);
}

/** Open findings counted by check and severity. */
export function countOpenFindings(db: Db, from = Number.MIN_SAFE_INTEGER): Array<{ check: CheckName; severity: Severity; count: number; newestDay: number }> {
  const rows = db.prepare("select check_name, severity, count(*) as n, max(day) as newest from quality_findings where resolved_at is null and day >= ? group by check_name, severity").all(from) as Array<{ check_name: CheckName; severity: Severity; n: number; newest: number }>;
  return rows.map((row) => ({ check: row.check_name, severity: row.severity, count: row.n, newestDay: row.newest }));
}
