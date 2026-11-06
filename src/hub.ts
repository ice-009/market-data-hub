import type { Config } from "./config.js";
import { brokerConfigured } from "./config.js";
import type { Db } from "./db.js";
import { BrokerError } from "./broker/errors.js";
import { FyersClient } from "./broker/fyers.js";
import { FyersAuth } from "./broker/fyersAuth.js";
import { BrokerGate } from "./broker/gate.js";
import { HistoryService } from "./history/service.js";
import { Scheduler } from "./jobs/scheduler.js";
import type { Logger } from "./log.js";
import { NseClient } from "./nse/client.js";
import type { NseContext } from "./nse/datasets.js";

// The hub's services, wired once per process from the config. `owner` says
// whether this process holds the owner lock (src/owner.ts): only the owner may
// call the broker or NSE. A non-owner (a CLI command while the server runs)
// still reads the store; requests that would need the broker get a clear error.

export interface Hub {
  config: Config;
  db: Db;
  log: Logger;
  owner: boolean;
  gate: BrokerGate | null;
  auth: FyersAuth | null;
  history: HistoryService;
  nse: NseContext;
  scheduler: Scheduler;
}

export interface HubOptions {
  config: Config;
  db: Db;
  log: Logger;
  owner: boolean;
  /** Injected in tests (mock broker / NSE servers or fakes). */
  fetch?: typeof fetch;
  clock?: () => number;
}

export function createHub(options: HubOptions): Hub {
  const { config, db, log } = options;
  const clock = options.clock ?? Date.now;
  let gate: BrokerGate | null = null;
  let auth: FyersAuth | null = null;
  let client: FyersClient | null = null;
  if (brokerConfigured(config.secrets)) {
    gate = new BrokerGate(db, config.fyers.plan, clock);
    auth = new FyersAuth({ secrets: config.secrets, fyers: config.fyers, dataDir: config.dataDir, log, fetch: options.fetch, clock });
    client = new FyersClient({ fyers: config.fyers, secrets: config.secrets, auth, gate, log, fetch: options.fetch });
  }
  // `owner` can change while running (the server takes the lock once a CLI backfill exits).
  const hub = { config, db, log, owner: options.owner, gate, auth } as Hub;
  hub.history = new HistoryService({
    db,
    broker: client,
    blocked: () => (hub.owner ? null : new BrokerError("Another hub process owns the broker connection; try again when it's done.", "not_owner")),
    log,
    fetchWaitMs: config.fetchWaitMs,
    clock,
  });
  hub.nse = { db, nse: new NseClient({ log, fetch: options.fetch, clock }), log, urls: config.nse, clock } satisfies NseContext;
  hub.scheduler = new Scheduler({ nse: hub.nse, backfill: { db, history: hub.history, log, clock }, log });
  return hub;
}
