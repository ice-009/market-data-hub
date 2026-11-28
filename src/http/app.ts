import { statSync } from "node:fs";
import { Hono } from "hono";
import { verifyKey } from "../auth/keys.js";
import { RateLimiter } from "../auth/rateLimit.js";
import type { Db } from "../db.js";
import { calendarStatus } from "../calendar/calendar.js";
import { hubHealth } from "../health.js";
import type { Hub } from "../hub.js";
import type { Logger } from "../log.js";
import { brokerStatus, dataFreshness, dataMode, dataQuality, diskStatus, recentJobs } from "../status.js";
import { errorBody, type HubEnv } from "./common.js";
import { adjustmentRoutes } from "./routes/adjustments.js";
import { calendarRoutes } from "./routes/calendar.js";
import { candleRoutes } from "./routes/candles.js";
import { optionRoutes } from "./routes/options.js";
import { participantRoutes } from "./routes/participants.js";
import { pointInTimeRoutes } from "./routes/pointInTime.js";
import { qualityRoutes } from "./routes/quality.js";
import { liveRoutes, liveStatus, type LiveDeps } from "./routes/live.js";
import { referenceRoutes } from "./routes/reference.js";
import { symbolRoutes } from "./routes/symbols.js";

export { errorBody, requireScope, type HubEnv } from "./common.js";

// The HTTP surface. Everything under /v1 needs an API key (Authorization:
// Bearer mdh_…); /healthz is open so the container and tunnel can check the
// process is alive, and says nothing else. Error bodies are always
// { error, code } and never echo request headers or configuration. Data routes
// live in ./routes; they read the hub's store and services.
//
// In end-of-day mode (no broker configured) the live routes — quotes, the
// stream, pins — answer 503 { code: "not_configured" } at once: there is no
// live price to give, and a client shouldn't retry or wait for one.

export interface AppDeps {
  db: Db;
  dbPath: string;
  log: Logger;
  version: string;
  startedAt: number;
  keyRatePerMinute: number;
  hub: Hub;
  /** Live routes' dependencies; default the hub's (tests pass fakes). */
  live?: LiveDeps;
}

export function createApp(deps: AppDeps) {
  const app = new Hono<HubEnv>();
  const limiter = new RateLimiter(deps.keyRatePerMinute);
  const live = deps.live ?? deps.hub.live.deps;

  app.get("/healthz", (c) => c.text("ok"));

  app.use("/v1/*", async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    const key = match ? verifyKey(deps.db, match[1]) : null;
    if (!key) return c.json(errorBody("Missing or invalid API key.", "unauthorized"), 401, { "WWW-Authenticate": "Bearer" });
    const waitMs = limiter.take(key.id);
    if (waitMs > 0) return c.json(errorBody("Too many requests for this key.", "rate_limited"), 429, { "Retry-After": String(Math.ceil(waitMs / 1000)) });
    c.set("apiKey", key);
    await next();
  });

  // `?strict=1` answers 503 when unhealthy, for uptime checkers that only look at the status code.
  app.get("/v1/status", (c) => {
    let dbBytes: number | null;
    try {
      dbBytes = statSync(deps.dbPath).size;
    } catch {
      dbBytes = null;
    }
    const liveNow = liveStatus(live);
    const now = deps.hub.clock();
    const health = hubHealth(deps.hub, liveNow.feed, now);
    const strict = ["1", "true"].includes(c.req.query("strict") ?? "");
    const unhealthy = strict && !health.healthy ? { ...errorBody(`Unhealthy: ${health.problems.join(" ")}`, "unhealthy") } : {};
    return c.json({
      ...unhealthy,
      ...health,
      ...dataMode(deps.hub),
      service: "market-data-hub",
      version: deps.version,
      time: Date.now(),
      uptimeSec: Math.round((Date.now() - deps.startedAt) / 1000),
      key: { name: c.get("apiKey").name, scopes: c.get("apiKey").scopes },
      // hubHealth synced the calendar with the database just now.
      calendar: calendarStatus(now),
      broker: brokerStatus(deps.hub),
      data: { dbBytes, ...dataFreshness(deps.db) },
      quality: dataQuality(deps.db),
      disk: diskStatus(deps.hub.config),
      jobs: recentJobs(deps.db),
      live: { ...liveNow, ...deps.hub.live.status() },
    }, strict && !health.healthy ? 503 : 200);
  });

  if (deps.hub.mode === "end_of_day") {
    const noLive = { ...errorBody("Live prices need a broker: this hub has none configured and serves NSE end-of-day data only.", "not_configured"), mode: "end_of_day" };
    for (const path of ["/v1/quotes", "/v1/stream", "/v1/live/*"]) app.use(path, async (c) => c.json(noLive, 503));
  }

  candleRoutes(app, deps.hub);
  pointInTimeRoutes(app, deps.hub);
  adjustmentRoutes(app, deps.hub);
  referenceRoutes(app, deps.hub);
  calendarRoutes(app, deps.hub);
  symbolRoutes(app, deps.hub);
  qualityRoutes(app, deps.hub);
  optionRoutes(app, deps.hub);
  participantRoutes(app, deps.hub);
  // The live routes share one fan-out per hub (keyed on hub.live.deps); the hub closes their streams at shutdown.
  deps.hub.live.attach(liveRoutes(app, live));

  app.notFound((c) => c.json(errorBody("Not found.", "not_found"), 404));
  app.onError((error, c) => {
    deps.log.error("request failed", { path: c.req.path, error });
    return c.json(errorBody("Internal error.", "internal"), 500);
  });

  return app;
}
