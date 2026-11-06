import path from "node:path";

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
  secrets: Secrets;
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
