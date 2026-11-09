import path from "node:path";
import { normalizeSymbol } from "./broker/symbols.js";

// Configuration comes from the environment (a `.env` file in development, the
// container's environment in Docker). Broker credentials are kept apart in
// `secrets` so they can be handed to the logger's scrubber and never end up in
// a response or a log line.

export interface Secrets {
  fyersClientId: string;
  fyersSecretKey: string;
  fyersLoginId: string;
  fyersPin: string;
  fyersTotpSecret: string;
}

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  logLevel: "debug" | "info" | "warn" | "error";
  /** Requests per minute allowed for each API key. */
  keyRatePerMinute: number;
  /** Background jobs (NSE files, queued backfills). Off for one-off tools and tests. */
  jobsEnabled: boolean;
  /** How long a /v1/candles request waits for missing data from the broker before answering 503. */
  fetchWaitMs: number;
  /** Live prices (H2): on unless HUB_LIVE=off; only runs when a broker is configured. */
  liveEnabled: boolean;
  /** Symbols kept subscribed from start (HUB_LIVE_SYMBOLS), on top of those pinned through the API. */
  liveSymbols: string[];
  /** Days of 1-minute live bars kept. */
  liveRetentionDays: number;
  /** Nightly backups go here (HUB_BACKUP_DIR); null = no scheduled backups. */
  backupDir: string | null;
  /** Backups kept (newest first) by the nightly backup and `hub data backup`. */
  backupKeep: number;
  fyers: FyersConfig;
  /** NSE hosts (overridable for testing against a local server). */
  nse: { archiveUrl: string; wwwUrl: string };
  secrets: Secrets;
}

/** Non-secret broker settings. URLs are overridable so tests can point at a mock server. */
export interface FyersConfig {
  apiUrl: string;
  dataUrl: string;
  /** Must match the redirect URL registered for the Fyers app (the login flow sends it). */
  redirectUrl: string;
  plan: "standard" | "prime";
}

export class ConfigError extends Error {}

const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

function int(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new ConfigError(`${name} must be a whole number from ${min} to ${max} (got "${raw}").`);
  return value;
}

function onOff(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = (env[name] ?? "").trim().toLowerCase();
  if (raw === "") return fallback;
  if (raw === "on") return true;
  if (raw === "off") return false;
  throw new ConfigError(`${name} must be on or off (got "${env[name]}").`);
}

/** HUB_LIVE_SYMBOLS: comma-separated hub tickers (SBIN, NIFTY…); empty means none. */
function symbolList(env: NodeJS.ProcessEnv, name: string, fallback: string): string[] {
  const raw = env[name] ?? fallback;
  const parts = raw.split(",").map((part) => part.trim()).filter(Boolean);
  const bad = parts.filter((part) => !normalizeSymbol(part));
  if (bad.length) throw new ConfigError(`${name} must be comma-separated NSE tickers such as NIFTY,SBIN (not: ${bad.slice(0, 3).join(", ")}).`);
  const symbols = [...new Set(parts.map((part) => normalizeSymbol(part)!))];
  if (symbols.length > 100) throw new ConfigError(`${name} may list at most 100 symbols (got ${symbols.length}).`);
  return symbols;
}

function fyersConfig(env: NodeJS.ProcessEnv): FyersConfig {
  const apiUrl = (env.FYERS_API_URL || "https://api-t1.fyers.in/api/v3").replace(/\/+$/, "");
  let origin: string;
  try {
    origin = new URL(apiUrl).origin;
  } catch {
    throw new ConfigError("FYERS_API_URL must be a URL.");
  }
  const plan = (env.FYERS_PLAN || "standard").toLowerCase();
  if (plan !== "standard" && plan !== "prime") throw new ConfigError("FYERS_PLAN must be standard or prime.");
  return {
    apiUrl,
    // Market data (history, quotes) lives under <origin>/data, not under /api/v3.
    dataUrl: (env.FYERS_DATA_URL || `${origin}/data`).replace(/\/+$/, ""),
    redirectUrl: env.FYERS_REDIRECT_URL || "http://localhost:3000/api/broker/callback",
    plan,
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const logLevel = (env.HUB_LOG_LEVEL ?? "info") as Config["logLevel"];
  if (!LOG_LEVELS.includes(logLevel)) throw new ConfigError(`HUB_LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")}.`);
  return {
    // Loopback by default: the only way in from outside is the Cloudflare Tunnel.
    host: env.HUB_HOST || "127.0.0.1",
    port: int(env, "HUB_PORT", 8787, 1, 65535),
    dataDir: path.resolve(env.HUB_DATA_DIR || "data"),
    logLevel,
    keyRatePerMinute: int(env, "HUB_KEY_RATE_PER_MINUTE", 600, 1, 100_000),
    jobsEnabled: (env.HUB_JOBS ?? "on").toLowerCase() !== "off",
    fetchWaitMs: int(env, "HUB_FETCH_WAIT_MS", 20_000, 0, 300_000),
    liveEnabled: onOff(env, "HUB_LIVE", true),
    liveSymbols: symbolList(env, "HUB_LIVE_SYMBOLS", "NIFTY,BANKNIFTY"),
    liveRetentionDays: int(env, "HUB_LIVE_RETENTION_DAYS", 30, 1, 3650),
    backupDir: env.HUB_BACKUP_DIR ? path.resolve(env.HUB_BACKUP_DIR) : null,
    backupKeep: int(env, "HUB_BACKUP_KEEP", 7, 1, 365),
    fyers: fyersConfig(env),
    nse: {
      archiveUrl: (env.NSE_ARCHIVE_URL || "https://nsearchives.nseindia.com").replace(/\/+$/, ""),
      wwwUrl: (env.NSE_WWW_URL || "https://www.nseindia.com").replace(/\/+$/, ""),
    },
    secrets: {
      fyersClientId: env.FYERS_CLIENT_ID ?? "",
      fyersSecretKey: env.FYERS_SECRET_KEY ?? "",
      fyersLoginId: env.FYERS_FY_ID ?? "",
      fyersPin: env.FYERS_PIN ?? "",
      fyersTotpSecret: env.FYERS_TOTP_SECRET ?? "",
    },
  };
}

/** Is a broker account configured? (Says nothing about whether it's connected.) */
export const brokerConfigured = (secrets: Secrets) => Boolean(secrets.fyersClientId && secrets.fyersSecretKey && secrets.fyersLoginId && secrets.fyersPin && secrets.fyersTotpSecret);

/** Values the logger must never print. */
export const secretValues = (secrets: Secrets) => Object.values(secrets).filter((value) => value.length >= 4);
