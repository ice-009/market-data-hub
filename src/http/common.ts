import type { MiddlewareHandler } from "hono";
import type { ApiKey, Scope } from "../auth/keys.js";

// Shared by the app and its route modules: the error body shape and the scope guard.

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
