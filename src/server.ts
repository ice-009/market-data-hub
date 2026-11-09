import { readFileSync } from "node:fs";
import path from "node:path";
import { serve } from "@hono/node-server";
import { ConfigError, brokerConfigured, loadConfig, secretValues } from "./config.js";
import { openDb } from "./db.js";
import { createApp } from "./http/app.js";
import { createHub } from "./hub.js";
import { createLogger } from "./log.js";
import { acquireOwner, ownerPid } from "./owner.js";

const version = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

function main() {
  const config = loadConfig();
  const log = createLogger({ level: config.logLevel, secrets: secretValues(config.secrets) });
  const db = openDb(config.dataDir);
  // Only the owner-lock holder talks to the broker and NSE. Normally that's the
  // server; if a CLI backfill holds it, serve the store and take over when it exits.
  let release = acquireOwner(config.dataDir);
  const hub = createHub({ config, db, log, owner: release !== null });
  // Owner-only work: background jobs and live prices (which resume their subscriptions and repair
  // the minutes missed while the hub was down — see src/live/service.ts).
  const startJobs = () => {
    if (config.jobsEnabled) hub.scheduler.start();
    hub.live.start();
  };
  let ownerRetry: ReturnType<typeof setInterval> | null = null;
  if (release) startJobs();
  else {
    log.warn("another hub process owns the broker/NSE connection; serving stored data until it exits", { pid: ownerPid(config.dataDir) });
    ownerRetry = setInterval(() => {
      release = acquireOwner(config.dataDir);
      if (!release) return;
      hub.owner = true;
      clearInterval(ownerRetry!);
      log.info("took over the broker/NSE connection");
      startJobs();
    }, 60_000);
    ownerRetry.unref();
  }
  const app = createApp({
    db,
    dbPath: path.join(config.dataDir, "hub.db"),
    log,
    version,
    startedAt: Date.now(),
    keyRatePerMinute: config.keyRatePerMinute,
    hub,
  });

  const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
    log.info("listening", {
      host: config.host,
      port: info.port,
      version,
      broker: brokerConfigured(config.secrets) ? "configured" : "not configured",
      jobs: config.jobsEnabled ? "on" : "off",
      live: hub.live.running ? "on" : config.liveEnabled && brokerConfigured(config.secrets) ? "waiting for the owner lock" : "off",
    });
  });

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info("shutting down", { signal });
    setTimeout(() => process.exit(1), 10_000).unref();
    if (ownerRetry) clearInterval(ownerRetry);
    // Live first: end the streams (so server.close isn't held open by them), close the
    // broker socket, then write the buffered quotes and minute bars.
    void hub.live
      .stop()
      .catch((error: unknown) => log.error("live shutdown failed", { error }))
      .finally(() => {
        hub.scheduler.stop();
        hub.gate?.flush();
        server.close(() => {
          release?.();
          db.close();
          process.exit(0);
        });
      });
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
