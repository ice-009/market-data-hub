import { readFileSync } from "node:fs";
import path from "node:path";
import { serve } from "@hono/node-server";
import { ConfigError, brokerConfigured, loadConfig, secretValues } from "./config.js";
import { openDb } from "./db.js";
import { createApp } from "./http/app.js";
import { createLogger } from "./log.js";

const version = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

function main() {
  const config = loadConfig();
  const log = createLogger({ level: config.logLevel, secrets: secretValues(config.secrets) });
  const db = openDb(config.dataDir);
  const app = createApp({
    db,
    dbPath: path.join(config.dataDir, "hub.db"),
    log,
    version,
    startedAt: Date.now(),
    keyRatePerMinute: config.keyRatePerMinute,
    brokerConfigured: brokerConfigured(config.secrets),
  });

  const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
    log.info("listening", { host: config.host, port: info.port, version, broker: brokerConfigured(config.secrets) ? "configured" : "not configured" });
  });

  const stop = (signal: string) => {
    log.info("shutting down", { signal });
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
}

try {
  main();
} catch (error) {
  // Config errors are ours and safe to print; anything else gets a generic line.
  process.stderr.write(`${error instanceof ConfigError ? error.message : "Failed to start the hub."}\n`);
  process.exit(1);
}
