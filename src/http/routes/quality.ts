import type { Hono } from "hono";
import type { Hub } from "../../hub.js";
import { CHECK_HELP, findingJson, qualitySummary } from "../../quality/summary.js";
import { CHECKS, readFindings, type CheckName, type FindingQuery, type Severity } from "../../quality/store.js";
import { errorBody, requireScope, type HubEnv } from "../common.js";
import { ParamError, parseTime } from "../params.js";

// GET /v1/quality (history scope): the data-quality checks' findings
// (src/quality), newest trade day first, with the same summary as /v1/status.
//   check     one of CHECKS
//   severity  problem | warning | info: that severity and worse
//   subject   a symbol, a dataset (cash_bhav, fo_bhav, index_close, pr), "fo", "lots" or "calendar"
//   from, to  trade dates (YYYY-MM-DD)
//   status    open (default) | resolved | all
//   limit     1–1000 (default 200)

export const MAX_FINDINGS = 1000;
const SEVERITIES: readonly Severity[] = ["problem", "warning", "info"];
const STATUSES = ["open", "resolved", "all"] as const;

export function qualityRoutes(app: Hono<HubEnv>, hub: Hub) {
  app.get("/v1/quality", requireScope("history"), (c) => {
    const query: FindingQuery = {};
    try {
      const check = c.req.query("check");
      if (check !== undefined) {
        if (!CHECKS.includes(check as CheckName)) throw new ParamError(`check must be one of ${CHECKS.join(", ")}.`);
        query.check = check as CheckName;
      }
      const severity = c.req.query("severity");
      if (severity !== undefined) {
        if (!SEVERITIES.includes(severity as Severity)) throw new ParamError("severity must be problem, warning or info.");
        query.severity = severity as Severity;
      }
      const status = c.req.query("status");
      if (status !== undefined) {
        if (!STATUSES.includes(status as (typeof STATUSES)[number])) throw new ParamError("status must be open, resolved or all.");
        query.status = status as FindingQuery["status"];
      }
      const subject = c.req.query("subject")?.trim();
      if (subject) query.subject = /^[a-z_]+$/.test(subject) ? subject : subject.toUpperCase();
      query.from = parseTime("from", c.req.query("from"), "start", true);
      query.to = parseTime("to", c.req.query("to"), "end", true);
      if (query.from !== undefined && query.to !== undefined && query.from > query.to) throw new ParamError("from must not be after to.");
      const limit = c.req.query("limit");
      if (limit !== undefined) {
        const value = Number(limit);
        if (!Number.isInteger(value) || value < 1 || value > MAX_FINDINGS) throw new ParamError(`limit must be a whole number from 1 to ${MAX_FINDINGS}.`);
        query.limit = value;
      }
    } catch (error) {
      if (error instanceof ParamError) return c.json(errorBody(error.message, "bad_request"), 400);
      throw error;
    }
    const findings = readFindings(hub.db, query).map(findingJson);
    return c.json({ summary: qualitySummary(hub.db, hub.clock()), checks: CHECK_HELP, count: findings.length, findings });
  });
}
