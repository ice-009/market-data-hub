import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, secretValues } from "../../src/config.js";
import { openDb, type Db } from "../../src/db.js";
import { createApp } from "../../src/http/app.js";
import { createHub, type Hub } from "../../src/hub.js";
import { createLogger } from "../../src/log.js";

// A throwaway hub for one test: its own data dir and database, jobs off,
// logs captured so tests can check nothing secret was written.

export interface TestHub {
  dir: string;
  db: Db;
  hub: Hub;
  lines: string[];
  app: () => ReturnType<typeof createApp>;
  cleanup: () => void;
}

export function makeHub(options: { env?: Record<string, string>; clock?: () => number; fetch?: typeof fetch; keyRatePerMinute?: number } = {}): TestHub {
  const dir = mkdtempSync(path.join(tmpdir(), "hub-test-"));
  const config = loadConfig({ HUB_DATA_DIR: dir, HUB_JOBS: "off", HUB_FETCH_WAIT_MS: "5000", ...options.env });
  const lines: string[] = [];
  const log = createLogger({ level: "debug", secrets: secretValues(config.secrets), write: (line) => lines.push(line) });
  const db = openDb(dir);
  const hub = createHub({ config, db, log, owner: true, clock: options.clock, fetch: options.fetch });
  const app = () => createApp({ db, dbPath: path.join(dir, "hub.db"), log, version: "0.0.0-test", startedAt: Date.now(), keyRatePerMinute: options.keyRatePerMinute ?? 600, hub });
  return {
    dir,
    db,
    hub,
    lines,
    app,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** IST wall-clock time as epoch ms: ist(2026, 11, 4, 20, 0) is 4 Nov 2026 20:00 IST. */
export const ist = (year: number, month: number, day: number, hour = 0, minute = 0) => Date.UTC(year, month - 1, day, hour, minute) - 5.5 * 3_600_000;
