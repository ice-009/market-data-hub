import { statSync } from "node:fs";
import { Hono, type MiddlewareHandler } from "hono";
import type { ApiKey, Scope } from "../auth/keys.js";
import { verifyKey } from "../auth/keys.js";
import { RateLimiter } from "../auth/rateLimit.js";
import type { Db } from "../db.js";
import type { Logger } from "../log.js";

// The HTTP surface. Everything under /v1 needs an API key (Authorization:
// Bearer mdh_…); /healthz is open so the container and tunnel can check the
// process is alive, and says nothing else. Error bodies are always
// { error, code } and never echo request headers or configuration.

export interface AppDeps {
  db: Db;
  dbPath: string;
  log: Logger;
  version: string;
  startedAt: number;
  keyRatePerMinute: number;
  brokerConfigured: boolean;
}

export type HubEnv = { Variables: { apiKey: ApiKey } };

export const errorBody = (error: string, code: string) => ({ error, code });

/** Route guard: the calling key must hold `scope` (admin holds every scope). */
export const requireScope =
  (scope: Scope): MiddlewareHandler<HubEnv> =>
  async (c, next) => {
    const key = c.get("apiKey");
    if (!key.scopes.includes(scope) && !key.scopes.includes("admin")) return c.json(errorBody(`This key lacks the "${scope}" scope.`, "forbidden"), 403);
    await next();
  };

export function createApp(deps: AppDeps) {
  const app = new Hono<HubEnv>();
  const limiter = new RateLimiter(deps.keyRatePerMinute);

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

  app.get("/v1/status", (c) => {
    let dbBytes: number | null;
    try {
      dbBytes = statSync(deps.dbPath).size;
    } catch {
      dbBytes = null;
    }
    return c.json({
      service: "market-data-hub",
      version: deps.version,
      time: Date.now(),
      uptimeSec: Math.round((Date.now() - deps.startedAt) / 1000),
      key: { name: c.get("apiKey").name, scopes: c.get("apiKey").scopes },
      broker: { configured: deps.brokerConfigured, connected: false },
      data: { dbBytes },
    });
  });

  app.notFound((c) => c.json(errorBody("Not found.", "not_found"), 404));
  app.onError((error, c) => {
    deps.log.error("request failed", { path: c.req.path, error });
    return c.json(errorBody("Internal error.", "internal"), 500);
  });

  return app;
}
