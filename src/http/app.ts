import { statSync } from "node:fs";
import { Hono } from "hono";
import { verifyKey } from "../auth/keys.js";
import { RateLimiter } from "../auth/rateLimit.js";
import type { Db } from "../db.js";
import { hubHealth } from "../health.js";
import type { Hub } from "../hub.js";
import type { Logger } from "../log.js";
import { brokerStatus, dataFreshness, recentJobs } from "../status.js";
import { errorBody, type HubEnv } from "./common.js";
import { candleRoutes } from "./routes/candles.js";
import { liveRoutes, liveStatus, type LiveDeps } from "./routes/live.js";
import { referenceRoutes } from "./routes/reference.js";

export { errorBody, requireScope, type HubEnv } from "./common.js";

// The HTTP surface. Everything under /v1 needs an API key (Authorization:
// Bearer mdh_…); /healthz is open so the container and tunnel can check the
// process is alive, and says nothing else. Error bodies are always
// { error, code } and never echo request headers or configuration. Data routes
// live in ./routes; they read the hub's store and services.

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
    const health = hubHealth(deps.hub, liveNow.feed);
    const strict = ["1", "true"].includes(c.req.query("strict") ?? "");
    const unhealthy = strict && !health.healthy ? { ...errorBody(`Unhealthy: ${health.problems.join(" ")}`, "unhealthy") } : {};
    return c.json({
      ...unhealthy,
      ...health,
      service: "market-data-hub",
      version: deps.version,
      time: Date.now(),
      uptimeSec: Math.round((Date.now() - deps.startedAt) / 1000),
      key: { name: c.get("apiKey").name, scopes: c.get("apiKey").scopes },
      broker: brokerStatus(deps.hub),
      data: { dbBytes, ...dataFreshness(deps.db) },
      jobs: recentJobs(deps.db),
      live: { ...liveNow, ...deps.hub.live.status() },
    }, strict && !health.healthy ? 503 : 200);
  });

  candleRoutes(app, deps.hub);
  referenceRoutes(app, deps.hub);
  // The live routes share one fan-out per hub (keyed on hub.live.deps); the hub closes their streams at shutdown.
  deps.hub.live.attach(liveRoutes(app, live));

  app.notFound((c) => c.json(errorBody("Not found.", "not_found"), 404));
  app.onError((error, c) => {
    deps.log.error("request failed", { path: c.req.path, error });
    return c.json(errorBody("Internal error.", "internal"), 500);
  });

  return app;
}
