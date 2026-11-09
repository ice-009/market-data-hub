import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createKey, listKeys, parseScopes, revokeKey, verifyKey } from "../src/auth/keys.js";
import { RateLimiter } from "../src/auth/rateLimit.js";
import { ConfigError, brokerConfigured, loadConfig, secretValues } from "../src/config.js";
import { openDb, type Db } from "../src/db.js";
import { createApp } from "../src/http/app.js";
import { createHub } from "../src/hub.js";
import { createLogger, redact } from "../src/log.js";

let dir: string;
let db: Db;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "hub-test-"));
  db = openDb(dir);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const SECRETS = { FYERS_CLIENT_ID: "ABCD1234EF-100", FYERS_SECRET_KEY: "S3cr3tKeyValue", FYERS_FY_ID: "XY12345", FYERS_PIN: "4321", FYERS_TOTP_SECRET: "JBSWY3DPEHPK3PXP" };

describe("config", () => {
  it("defaults to loopback and validates numbers", () => {
    const config = loadConfig({});
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(8787);
    expect(() => loadConfig({ HUB_PORT: "http" })).toThrow(ConfigError);
    expect(() => loadConfig({ HUB_LOG_LEVEL: "loud" })).toThrow(ConfigError);
  });

  it("reads and validates the live settings", () => {
    const defaults = loadConfig({});
    expect(defaults).toMatchObject({ liveEnabled: true, liveSymbols: ["NIFTY", "BANKNIFTY"], liveRetentionDays: 30 });
    expect(loadConfig({ HUB_LIVE: "OFF", HUB_LIVE_SYMBOLS: " sbin, NIFTY ,sbin,", HUB_LIVE_RETENTION_DAYS: "7" })).toMatchObject({ liveEnabled: false, liveSymbols: ["SBIN", "NIFTY"], liveRetentionDays: 7 });
    expect(loadConfig({ HUB_LIVE_SYMBOLS: "" }).liveSymbols).toEqual([]);
    expect(() => loadConfig({ HUB_LIVE: "yes" })).toThrow(ConfigError);
    expect(() => loadConfig({ HUB_LIVE_SYMBOLS: "SBIN,BAD:SYM" })).toThrow(/HUB_LIVE_SYMBOLS/);
    expect(() => loadConfig({ HUB_LIVE_SYMBOLS: Array.from({ length: 101 }, (_, i) => `S${i}`).join(",") })).toThrow(/at most 100/);
    expect(() => loadConfig({ HUB_LIVE_RETENTION_DAYS: "0" })).toThrow(ConfigError);
  });

  it("knows whether a broker is configured without exposing it", () => {
    expect(brokerConfigured(loadConfig({}).secrets)).toBe(false);
    const config = loadConfig(SECRETS);
    expect(brokerConfigured(config.secrets)).toBe(true);
    expect(secretValues(config.secrets)).toContain("JBSWY3DPEHPK3PXP");
  });
});

describe("log scrubber", () => {
  it("removes secrets, bearer tokens and hub keys anywhere in a line", () => {
    const line = redact('{"msg":"login failed for XY12345 pin 4321","auth":"Bearer abc.def","key":"mdh_aaaaaaaaaaaaaaaaaaaaaaaaaaaa"}', ["XY12345", "4321"]);
    expect(line).not.toMatch(/XY12345|4321|abc\.def|mdh_a{20}/);
    expect(line).toContain("[redacted]");
  });

  it("scrubs error messages passed as fields", () => {
    const lines: string[] = [];
    const log = createLogger({ level: "info", secrets: ["S3cr3tKeyValue"], write: (line) => lines.push(line) });
    log.error("broker call failed", { error: new Error("bad secret S3cr3tKeyValue") });
    log.debug("hidden at info level");
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("S3cr3tKeyValue");
  });

  it("scrubs values registered at runtime (the broker token)", () => {
    const lines: string[] = [];
    const log = createLogger({ level: "info", secrets: [], write: (line) => lines.push(line) });
    log.addSecret("runtime-token-123456");
    log.info("call failed with runtime-token-123456");
    expect(lines[0]).not.toContain("runtime-token-123456");
  });
});

describe("api keys", () => {
  it("stores only a hash and verifies the clear-text key", () => {
    const { key, record } = createKey(db, "tradex", ["history", "live"]);
    expect(key.startsWith("mdh_")).toBe(true);
    const stored = db.prepare("select hash from api_keys where id = ?").get(record.id) as { hash: string };
    expect(stored.hash).not.toContain(key);
    expect(verifyKey(db, key)?.name).toBe("tradex");
    expect(verifyKey(db, `${key}x`)).toBeNull();
    expect(verifyKey(db, "not-a-key")).toBeNull();
  });

  it("revokes", () => {
    const { key, record } = createKey(db, "lab", ["history"]);
    expect(revokeKey(db, record.id)).toBe(true);
    expect(revokeKey(db, record.id)).toBe(false);
    expect(verifyKey(db, key)).toBeNull();
    expect(listKeys(db)[0].revokedAt).not.toBeNull();
  });

  it("parses scopes strictly", () => {
    expect(parseScopes("history, fo,history")).toEqual(["history", "fo"]);
    expect(() => parseScopes("history,trade")).toThrow(/Unknown scope/);
    expect(() => parseScopes("")).toThrow(/at least one/);
  });
});

describe("rate limiter", () => {
  it("allows a burst of perMinute, then refills over time", () => {
    const limiter = new RateLimiter(3);
    expect([limiter.take("k", 0), limiter.take("k", 0), limiter.take("k", 0)]).toEqual([0, 0, 0]);
    expect(limiter.take("k", 0)).toBe(20_000);
    expect(limiter.take("k", 20_000)).toBe(0);
    expect(limiter.take("other", 0)).toBe(0);
  });
});

describe("http", () => {
  const app = (overrides: { keyRatePerMinute?: number } = {}) => {
    const log = createLogger({ level: "error", secrets: [], write: () => {} });
    const config = loadConfig({ ...SECRETS, HUB_DATA_DIR: dir, HUB_JOBS: "off" });
    return createApp({
      db,
      dbPath: path.join(dir, "hub.db"),
      log,
      version: "0.0.0-test",
      startedAt: Date.now(),
      keyRatePerMinute: overrides.keyRatePerMinute ?? 600,
      hub: createHub({ config, db, log, owner: true }),
    });
  };
  const auth = (key: string) => ({ headers: { authorization: `Bearer ${key}` } });

  it("serves /healthz without a key", async () => {
    const res = await app().request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("rejects /v1 without a valid key", async () => {
    expect((await app().request("/v1/status")).status).toBe(401);
    const res = await app().request("/v1/status", auth("mdh_wrongwrongwrongwrongwrong"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Missing or invalid API key.", code: "unauthorized" });
  });

  it("returns status without any secret", async () => {
    const { key } = createKey(db, "tradex", ["history"]);
    const res = await app().request("/v1/status", auth(key));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(JSON.parse(body)).toMatchObject({ service: "market-data-hub", key: { name: "tradex" }, broker: { configured: true } });
    for (const secret of [...Object.values(SECRETS), key]) expect(body).not.toContain(secret);
  });

  it("rate-limits per key with Retry-After", async () => {
    const { key } = createKey(db, "busy", ["history"]);
    const limited = app({ keyRatePerMinute: 1 });
    expect((await limited.request("/v1/status", auth(key))).status).toBe(200);
    const res = await limited.request("/v1/status", auth(key));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
  });

  it("answers unknown routes with JSON 404", async () => {
    const { key } = createKey(db, "x", ["history"]);
    const res = await app().request("/v1/nope", auth(key));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "not_found" });
  });
});
