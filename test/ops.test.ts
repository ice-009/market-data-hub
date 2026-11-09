import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createKey, verifyKey } from "../src/auth/keys.js";
import { BACKUP_EVERY_MS, backupDb, backupDue, backupName, listBackups, toPrune } from "../src/backup.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import { assessHealth, missingSessions, type HealthInput } from "../src/health.js";
import { readBars, writeBars } from "../src/history/store.js";
import { markDay, recordRun, writeFoDay } from "../src/nse/store.js";
import { DAY_MS, parseIsoDay } from "../src/time.js";
import { ist, makeHub, type TestHub } from "./support/hub.js";

const d = (iso: string) => parseIsoDay(iso)!;

describe("backups", () => {
  let h: TestHub;
  let out: string;
  beforeEach(() => {
    h = makeHub();
    out = mkdtempSync(path.join(tmpdir(), "hub-backups-"));
  });
  afterEach(() => {
    h.cleanup();
    rmSync(out, { recursive: true, force: true });
  });

  it("names, lists and rotates backups (pure parts)", () => {
    expect(backupName(Date.UTC(2026, 10, 9, 18, 30, 5))).toBe("hub-20261109-183005.db");
    const entries = [1, 5, 3, 4, 2].map((at) => ({ at }));
    expect(toPrune(entries, 3).map((e) => e.at)).toEqual([2, 1]);
    expect(toPrune(entries, 0).map((e) => e.at)).toEqual([4, 3, 2, 1]); // always keeps one
    // Not during the trading day, and not twice within BACKUP_EVERY_MS.
    expect(backupDue(ist(2026, 11, 9, 23, 0), null)).toBe(true);
    expect(backupDue(ist(2026, 11, 9, 11, 0), null)).toBe(false);
    expect(backupDue(ist(2026, 11, 8, 11, 0), null)).toBe(true); // Sunday
    expect(backupDue(ist(2026, 11, 9, 23, 0), ist(2026, 11, 9, 23, 0) - BACKUP_EVERY_MS + 60_000)).toBe(false);
    expect(backupDue(ist(2026, 11, 9, 23, 0), ist(2026, 11, 8, 23, 0))).toBe(true);
  });

  it("round trip: a backup taken while the hub writes restores to the same data", async () => {
    const { key } = createKey(h.db, "tradex", ["history"]);
    writeBars(h.db, "SBIN", "1d", [{ t: d("2026-11-05"), o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }], { from: d("2026-11-05"), to: d("2026-11-06") }, 1);
    const pending = backupDb(h.db, out, 7, Date.UTC(2026, 10, 9, 18, 0, 0));
    // A write racing the backup lands either in it or after it, never half-way.
    writeBars(h.db, "INFY", "1d", [{ t: d("2026-11-05"), o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }], { from: d("2026-11-05"), to: d("2026-11-06") }, 1);
    const result = await pending;
    expect(path.basename(result.file)).toBe("hub-20261109-180000.db");
    // A single self-contained file: no -wal/-shm, no leftover partial.
    expect(readdirSync(out)).toEqual(["hub-20261109-180000.db"]);

    // Restore: stop, copy over hub.db, drop -wal/-shm, start.
    const restored = mkdtempSync(path.join(tmpdir(), "hub-restored-"));
    try {
      copyFileSync(result.file, path.join(restored, "hub.db"));
      const db = openDb(restored);
      expect(verifyKey(db, key)?.name).toBe("tradex");
      expect(readBars(db, "SBIN", "1d", d("2026-11-05"), d("2026-11-06"))).toHaveLength(1);
      db.close();
    } finally {
      rmSync(restored, { recursive: true, force: true });
    }
  });

  it("the server's scheduler backs up nightly into HUB_BACKUP_DIR", async () => {
    let now = ist(2026, 11, 9, 23, 0);
    const scheduled = makeHub({ env: { HUB_BACKUP_DIR: out, HUB_BACKUP_KEEP: "3" }, clock: () => now });
    try {
      expect(scheduled.hub.config).toMatchObject({ backupDir: out, backupKeep: 3 });
      await scheduled.hub.scheduler["backupRound"]();
      expect(listBackups(out)).toHaveLength(1);
      now += 60 * 60_000; // an hour later: not due again
      await scheduled.hub.scheduler["backupRound"]();
      expect(listBackups(out)).toHaveLength(1);
      now = ist(2026, 11, 10, 23, 0);
      await scheduled.hub.scheduler["backupRound"]();
      expect(listBackups(out)).toHaveLength(2);
    } finally {
      scheduled.cleanup();
    }
    expect(() => loadConfig({ HUB_BACKUP_KEEP: "0" })).toThrow(/HUB_BACKUP_KEEP/);
    expect(loadConfig({}).backupDir).toBeNull();
  });

  it("keeps the newest N and ignores other files", async () => {
    writeFileSync(path.join(out, "notes.txt"), "mine");
    for (let i = 0; i < 4; i += 1) await backupDb(h.db, out, 2, Date.UTC(2026, 10, 1 + i, 20, 0, 0));
    expect(listBackups(out).map((b) => path.basename(b.file))).toEqual(["hub-20261104-200000.db", "hub-20261103-200000.db"]);
    expect(existsSync(path.join(out, "notes.txt"))).toBe(true);
  });
});

// ------------------------------------------------------------------ health

const healthy = (now: number): HealthInput => ({
  now,
  sessionToday: true,
  jobsEnabled: true,
  nse: { cash_bhav: { lastOk: d("2026-11-06"), checked: new Map() }, fo_bhav: { lastOk: d("2026-11-06"), checked: new Map() } },
  refreshed: { lots: now - DAY_MS, fo_ban: now - DAY_MS, results: now - DAY_MS },
  broker: { configured: true, owner: true, loginFailing: null, stoppedForToday: false, coolingDown: false },
  live: { enabled: true, running: true, feed: { mode: "socket", socket: "connected" } },
  backup: null,
});

describe("health", () => {
  it("knows which sessions' NSE files are due", () => {
    // Monday 9 Nov before 20:00: Friday's is the newest due.
    expect(missingSessions(ist(2026, 11, 9, 19, 0), d("2026-11-06"), new Map())).toEqual([]);
    expect(missingSessions(ist(2026, 11, 9, 20, 30), d("2026-11-06"), new Map())).toEqual([d("2026-11-09")]);
    expect(missingSessions(ist(2026, 11, 11, 21, 0), d("2026-11-06"), new Map([[d("2026-11-10"), "holiday"]]))).toEqual([d("2026-11-11"), d("2026-11-09")]);
    expect(missingSessions(ist(2026, 11, 8, 12, 0), d("2026-11-05"), new Map([[d("2026-11-06"), "mismatch"]]))).toEqual([]);
  });

  it("is healthy when everything is fresh", () => {
    expect(assessHealth(healthy(ist(2026, 11, 9, 11, 0)))).toEqual({ healthy: true, problems: [], warnings: [] });
  });

  it("flags stale NSE files after 20:00 IST, and today's only as a warning without a session", () => {
    const late = ist(2026, 11, 9, 20, 30);
    const today = assessHealth(healthy(late));
    expect(today.healthy).toBe(false);
    expect(today.problems).toEqual([expect.stringMatching(/^Cash bhavcopy is stale: last session stored 2026-11-06, missing 2026-11-09/), expect.stringMatching(/^F&O bhavcopy is stale/)]);
    const holiday = assessHealth({ ...healthy(late), sessionToday: false });
    expect(holiday.healthy).toBe(true);
    expect(holiday.warnings[0]).toMatch(/holiday/);
    // Two days behind is a problem either way.
    expect(assessHealth({ ...healthy(ist(2026, 11, 10, 21, 0)), sessionToday: false }).healthy).toBe(false);
    expect(assessHealth({ ...healthy(late), nse: { ...healthy(late).nse, fo_bhav: { lastOk: null, checked: new Map() } } }).problems).toContain("F&O bhavcopy: nothing stored yet.");
  });

  it("flags the live feed only during market hours", () => {
    const down = (now: number) => assessHealth({ ...healthy(now), live: { enabled: true, running: true, feed: { mode: "down", socket: "disconnected" } } });
    expect(down(ist(2026, 11, 9, 11, 0)).problems).toEqual(["The live feed is down during market hours (no socket and no polling)."]);
    expect(down(ist(2026, 11, 9, 17, 0)).healthy).toBe(true);
    expect(down(ist(2026, 11, 8, 11, 0)).healthy).toBe(true); // Sunday
    const polling = assessHealth({ ...healthy(ist(2026, 11, 9, 11, 0)), live: { enabled: true, running: true, feed: { mode: "polling", socket: "connecting" } } });
    expect(polling).toMatchObject({ healthy: true, warnings: ["The live socket is connecting; prices come from polling."] });
    expect(assessHealth({ ...healthy(ist(2026, 11, 9, 11, 0)), live: { enabled: true, running: false, feed: { mode: "down", socket: "disconnected" } } }).problems).toEqual(["The live feed isn't running during market hours."]);
  });

  it("flags reference files, broker trouble and backups", () => {
    const now = ist(2026, 11, 9, 11, 0);
    const result = assessHealth({
      ...healthy(now),
      refreshed: { lots: null, fo_ban: now - 5 * DAY_MS, results: now - DAY_MS },
      broker: { configured: true, owner: true, loginFailing: "TOTP rejected", stoppedForToday: true, coolingDown: false },
      backup: { lastAt: now - 3 * DAY_MS },
      jobsEnabled: false,
    });
    expect(result.problems).toEqual([
      "Lot sizes: never fetched.",
      "F&O ban list: last fetched 5 days ago.",
      "Broker login is failing: TOTP rejected",
      "Broker calls are stopped for today (request budget spent or rate-limit strikes).",
      "Backups: the newest is 3 days old.",
    ]);
    expect(result.warnings).toEqual([expect.stringContaining("HUB_JOBS=off")]);
    expect(assessHealth({ ...healthy(now), backup: { lastAt: null } }).problems).toEqual(["Backups: none yet in HUB_BACKUP_DIR."]);
  });

  it("/v1/status reports health; ?strict=1 answers 503 when unhealthy", async () => {
    const h = makeHub();
    try {
      const { key } = createKey(h.db, "uptime", ["history"]);
      const get = (query = "") => h.app().request(`/v1/status${query}`, { headers: { Authorization: `Bearer ${key}` } });
      const empty = (await (await get()).json()) as { healthy: boolean; problems: string[] };
      expect(empty.healthy).toBe(false);
      expect(empty.problems).toContain("Cash bhavcopy: nothing stored yet.");
      const strict = await get("?strict=1");
      expect(strict.status).toBe(503);
      expect(await strict.json()).toMatchObject({ code: "unhealthy", healthy: false });

      // Fresh everything (relative to the real clock: these checks run on "now").
      const now = Date.now();
      const today = parseIsoDay(new Date(now + 5.5 * 3_600_000).toISOString().slice(0, 10))!;
      for (let day = today - 10 * DAY_MS; day <= today; day += DAY_MS) {
        markDay(h.db, "cash_bhav", day, "ok", 1, now);
        writeFoDay(h.db, day, [], now);
      }
      for (const name of ["lots", "fo_ban", "results"] as const) recordRun(h.db, name, { at: now, ok: true });
      const fine = await get("?strict=1");
      const body = (await fine.json()) as { healthy: boolean; problems: string[] };
      // The live feed has no broker here (disabled), so nothing else can be wrong.
      expect(body.problems).toEqual([]);
      expect(fine.status).toBe(200);
      expect(body.healthy).toBe(true);
    } finally {
      h.cleanup();
    }
  });
});
