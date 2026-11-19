import type { Config } from "./config.js";
import { brokerConfigured } from "./config.js";
import type { Db } from "./db.js";
import { BrokerError } from "./broker/errors.js";
import { FyersClient } from "./broker/fyers.js";
import { FyersAuth } from "./broker/fyersAuth.js";
import { BrokerGate } from "./broker/gate.js";
import { ArchiveHistory } from "./history/fromArchive.js";
import { HistoryQueue } from "./history/queue.js";
import { HistoryService } from "./history/service.js";
import { Scheduler } from "./jobs/scheduler.js";
import { LiveService, type LiveTestHooks } from "./live/service.js";
import type { Logger } from "./log.js";
import { NseClient } from "./nse/client.js";
import type { NseContext } from "./nse/datasets.js";

// The hub's services, wired once per process from the config. `owner` says
// whether this process holds the owner lock (src/owner.ts): only the owner may
// call the broker or NSE. A non-owner (a CLI command while the server runs)
// still reads the store; requests that would need the broker get a clear error.
// Live prices (`live`) are built here but only started by the owner
// (`hub.live.start()`, from src/server.ts) — see src/live/service.ts.
//
// Without broker credentials the hub runs in end-of-day mode (`mode`):
// daily stock candles come from NSE's stored bhavcopies instead of the broker
// (src/history/fromArchive.ts), F&O data, lots, the ban list and results work
// as always (they're NSE files anyway), and live quotes, the stream and
// intraday candles answer `not_configured`.

/** "broker": a broker account is configured (live prices, intraday). "end_of_day": NSE's end-of-day files only. */
export type HubMode = "broker" | "end_of_day";

export interface Hub {
  config: Config;
  mode: HubMode;
  db: Db;
  log: Logger;
  /** The hub's time source (injected in tests). */
  clock: () => number;
  owner: boolean;
  gate: BrokerGate | null;
  auth: FyersAuth | null;
  history: HistoryService;
  /** Background downloads for the batch candles endpoint (deduplicated, at background priority). */
  historyQueue: HistoryQueue;
  /** Why history can't be fetched from the broker right now, or null when it can. */
  brokerUnavailable: () => BrokerError | null;
  nse: NseContext;
  scheduler: Scheduler;
  live: LiveService;
}

export interface HubOptions {
  config: Config;
  db: Db;
  log: Logger;
  owner: boolean;
  /** Injected in tests (mock broker / NSE servers or fakes). */
  fetch?: typeof fetch;
  clock?: () => number;
  /** Test stand-ins for the live socket, timers and waits. */
  live?: LiveTestHooks;
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
    client = new FyersClient({ fyers: config.fyers, secrets: config.secrets, auth, gate, log, fetch: options.fetch, clock });
  }
  // `owner` can change while running (the server takes the lock once a CLI backfill exits).
  const mode: HubMode = client ? "broker" : "end_of_day";
  const hub = { config, mode, db, log, clock, owner: options.owner, gate, auth } as Hub;
  const blocked = () => (hub.owner ? null : new BrokerError("Another hub process owns the broker connection; try again when it's done.", "not_owner"));
  // End-of-day mode reads the hub's own store, so it isn't limited to the owner process.
  hub.history = client
    ? new HistoryService({ db, broker: client, blocked, log, fetchWaitMs: config.fetchWaitMs, clock })
    : new HistoryService({ db, broker: new ArchiveHistory(db), log, fetchWaitMs: config.fetchWaitMs, clock });
  hub.historyQueue = new HistoryQueue({ history: hub.history, log, clock });
  hub.brokerUnavailable = () => {
    if (!client) return new BrokerError("No broker is configured: this hub serves NSE end-of-day data only.", "not_configured");
    const snapshot = gate?.snapshot();
    if (snapshot?.stoppedForToday) return new BrokerError("Today's broker data budget is used up, or calls are stopped after rate-limit strikes.", "budget");
    return blocked();
  };
  hub.nse = { db, nse: new NseClient({ log, fetch: options.fetch, clock }), log, urls: config.nse, clock, disk: { dir: config.dataDir, minFreeBytes: config.diskMinBytes } } satisfies NseContext;
  hub.scheduler = new Scheduler({ nse: hub.nse, backfill: { db, history: hub.history, log, clock }, log, ...(config.backupDir ? { backup: { db, dir: config.backupDir, keep: config.backupKeep, minFreeBytes: config.diskMinBytes } } : {}) });
  hub.live = new LiveService({ config, db, log, clock, client, auth, test: options.live });
  return hub;
}
