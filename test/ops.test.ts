import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createKey, verifyKey } from "../src/auth/keys.js";
import { BACKUP_EVERY_MS, backupDb, backupDue, backupName, listBackups, toPrune } from "../src/backup.js";
import { DiskSpaceError, gb, hubVolumes, shortOfSpace } from "../src/disk.js";
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
    expect(backupName(Date.UTC(2026, 10, 9, 18, 30, 5))).toBe("hub-20261109-183005.db.gz");
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
    expect(path.basename(result.file)).toBe("hub-20261109-180000.db.gz");
    // A single gzipped file: no uncompressed copy, no -wal/-shm, no leftover partial.
    expect(readdirSync(out)).toEqual(["hub-20261109-180000.db.gz"]);
    expect(result.bytes).toBeLessThan(result.dbBytes / 3);

    // Restore: stop, gunzip over hub.db, drop -wal/-shm, start.
    const restored = mkdtempSync(path.join(tmpdir(), "hub-restored-"));
    try {
      const unzipped = gunzipSync(readFileSync(result.file));
      expect(unzipped.length).toBe(result.dbBytes);
      writeFileSync(path.join(restored, "hub.db"), unzipped);
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

  it("the nightly backup skips a night without disk space, says so once, and tries again an hour later", async () => {
    let now = ist(2026, 11, 9, 23, 0);
    let free = 1e9;
    const scheduled = makeHub({ env: { HUB_BACKUP_DIR: out, HUB_DISK_MIN_GB: "2" }, clock: () => now });
    try {
      const backup = scheduled.hub.scheduler["deps"].backup!;
      expect(backup.minFreeBytes).toBe(2e9);
      backup.free = () => free;
      await scheduled.hub.scheduler["backupRound"]();
      now += 5 * 60_000;
      await scheduled.hub.scheduler["backupRound"]();
      expect(listBackups(out)).toHaveLength(0);
      const skipped = scheduled.lines.filter((line) => line.includes("nightly backup skipped"));
      expect(skipped).toHaveLength(1);
      expect(JSON.parse(skipped[0])).toMatchObject({ level: "warn", reason: expect.stringMatching(/^Backup not started: only 1.0 GB free/) });
      free = 50e9;
      await scheduled.hub.scheduler["backupRound"]();
      expect(listBackups(out)).toHaveLength(0); // still waiting out the hour
      now += 60 * 60_000;
      await scheduled.hub.scheduler["backupRound"]();
      expect(listBackups(out)).toHaveLength(1);
    } finally {
      scheduled.cleanup();
    }
  });

  it("keeps the newest N, rotating out uncompressed backups from before gzip, and ignores other files", async () => {
    writeFileSync(path.join(out, "notes.txt"), "mine");
    writeFileSync(path.join(out, "hub-20261031-200000.db"), "an old uncompressed backup");
    expect(listBackups(out)).toEqual([expect.objectContaining({ at: Date.UTC(2026, 9, 31, 20, 0, 0), compressed: false })]);
    for (let i = 0; i < 4; i += 1) await backupDb(h.db, out, 2, Date.UTC(2026, 10, 1 + i, 20, 0, 0));
    expect(listBackups(out).map((b) => path.basename(b.file))).toEqual(["hub-20261104-200000.db.gz", "hub-20261103-200000.db.gz"]);
    expect(listBackups(out).every((b) => b.compressed)).toBe(true);
    expect(readdirSync(out).sort()).toEqual(["hub-20261103-200000.db.gz", "hub-20261104-200000.db.gz", "notes.txt"]);
  });

  it("removes what a dead backup left behind, but not one that may still be running", async () => {
    const now = Date.UTC(2026, 10, 9, 18, 0, 0);
    const stale = path.join(out, "hub-20261101-200000.db.partial");
    const recent = path.join(out, "hub-20261109-174500.db.gz.partial");
    for (const file of [stale, `${stale}-wal`, recent]) writeFileSync(file, "x");
    for (const file of [stale, `${stale}-wal`]) utimesSync(file, new Date(now - 7 * 3_600_000), new Date(now - 7 * 3_600_000));
    utimesSync(recent, new Date(now - 15 * 60_000), new Date(now - 15 * 60_000));
    await backupDb(h.db, out, 7, now);
    expect(readdirSync(out).sort()).toEqual(["hub-20261109-174500.db.gz.partial", "hub-20261109-180000.db.gz"]);
  });

  /** Enough rows that the copy takes many steps (and the check runs during it). */
  const fill = () => {
    const bars = Array.from({ length: 20_000 }, (_, i) => ({ t: d("2000-01-01") + i * DAY_MS, o: 1 + i, h: 2 + i, l: 0.5 + i, c: 1.5 + i, v: 10 * i }));
    writeBars(h.db, "SBIN", "1d", bars, { from: bars[0].t, to: bars.at(-1)!.t + DAY_MS }, 1);
  };

  it("doesn't start without room for the copy plus HUB_DISK_MIN_GB, and leaves nothing behind", async () => {
    fill();
    const dbBytes = Number(h.db.pragma("page_count", { simple: true })) * Number(h.db.pragma("page_size", { simple: true }));
    const attempt = backupDb(h.db, out, 7, Date.now(), { minFreeBytes: 2e9, free: () => 2e9 + dbBytes });
    await expect(attempt).rejects.toBeInstanceOf(DiskSpaceError);
    await expect(attempt).rejects.toThrow(/^Backup not started: only 2.0 GB free on the disk; this needs about \d+ MB plus the 2.0 GB kept free \(HUB_DISK_MIN_GB\)\.$/);
    expect(readdirSync(out)).toEqual([]);
    // With room for 1.5× the database on top of the floor it runs.
    await backupDb(h.db, out, 7, Date.now(), { minFreeBytes: 2e9, free: () => 2e9 + dbBytes * 1.5 + 1 });
    expect(listBackups(out)).toHaveLength(1);
  });

  it("stops and cleans up when free space falls under the floor while copying or gzipping", async () => {
    fill();
    // Room at the start, then none during the copy.
    let calls = 0;
    await expect(backupDb(h.db, out, 7, Date.UTC(2026, 10, 9, 18, 0, 0), { minFreeBytes: 2e9, free: () => (++calls === 1 ? 50e9 : 1e9), checkEveryBytes: 100_000 })).rejects.toThrow(
      "Backup stopped and removed: only 1.0 GB free on the disk, under the 2.0 GB kept free (HUB_DISK_MIN_GB).",
    );
    expect(calls).toBeGreaterThan(1);
    expect(readdirSync(out)).toEqual([]);
    // Room until the gzip is being written.
    const gzipping = path.join(out, "hub-20261109-180000.db.gz.partial");
    await expect(backupDb(h.db, out, 7, Date.UTC(2026, 10, 9, 18, 0, 0), { minFreeBytes: 2e9, free: () => (existsSync(gzipping) ? 1e9 : 50e9), checkEveryBytes: 4096 })).rejects.toBeInstanceOf(DiskSpaceError);
    expect(readdirSync(out)).toEqual([]);
  });
});

// ------------------------------------------------------------------ health

const healthy = (now: number): HealthInput => ({
  now,
  sessionToday: true,
  jobsEnabled: true,
  // Sun 8 Nov 2026 was a session (Muhurat).
  nse: { cash_bhav: { lastOk: d("2026-11-08"), checked: new Map() }, fo_bhav: { lastOk: d("2026-11-08"), checked: new Map() }, pr: { lastOk: d("2026-11-08"), checked: new Map() } },
  refreshed: { lots: now - DAY_MS, fo_ban: now - DAY_MS },
  broker: { configured: true, owner: true, loginFailing: null, stoppedForToday: false, coolingDown: false },
  live: { enabled: true, running: true, feed: { mode: "socket", socket: "connected" } },
  backup: null,
  disk: { volumes: [{ holds: "the database", freeBytes: 100e9 }], warnBytes: 5e9, minBytes: 2e9 },
});

describe("health", () => {
  it("knows which sessions' NSE files are due", () => {
    // Monday 9 Nov before 20:00: Sunday's (Muhurat, a listed weekend session) is the newest due.
    expect(missingSessions(ist(2026, 11, 9, 19, 0), d("2026-11-08"), new Map())).toEqual([]);
    expect(missingSessions(ist(2026, 11, 9, 19, 0), d("2026-11-06"), new Map())).toEqual([d("2026-11-08")]);
    expect(missingSessions(ist(2026, 11, 9, 20, 30), d("2026-11-08"), new Map())).toEqual([d("2026-11-09")]);
    expect(missingSessions(ist(2026, 11, 11, 21, 0), d("2026-11-08"), new Map([[d("2026-11-10"), "holiday"]]))).toEqual([d("2026-11-11"), d("2026-11-09")]);
    // An unlisted weekend day is never due.
    expect(missingSessions(ist(2026, 11, 16, 19, 0), d("2026-11-13"), new Map())).toEqual([]);
    expect(missingSessions(ist(2026, 11, 8, 12, 0), d("2026-11-05"), new Map([[d("2026-11-06"), "mismatch"]]))).toEqual([]);
  });

  it("is healthy when everything is fresh", () => {
    expect(assessHealth(healthy(ist(2026, 11, 9, 11, 0)))).toEqual({ healthy: true, problems: [], warnings: [] });
  });

  it("flags stale NSE files after 20:00 IST, and today's only as a warning without a session", () => {
    const late = ist(2026, 11, 9, 20, 30);
    const today = assessHealth(healthy(late));
    expect(today.healthy).toBe(false);
    expect(today.problems).toEqual([expect.stringMatching(/^Cash bhavcopy is stale: last session stored 2026-11-08, missing 2026-11-09/), expect.stringMatching(/^F&O bhavcopy is stale/), expect.stringMatching(/^PR zip \(results calendar\) is stale/)]);
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
      refreshed: { lots: null, fo_ban: now - 5 * DAY_MS },
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

  it("warns under HUB_DISK_WARN_GB and flags a problem under HUB_DISK_MIN_GB, per disk", () => {
    const now = ist(2026, 11, 9, 11, 0);
    const disk = (volumes: Array<{ holds: string; freeBytes: number | null }>) => assessHealth({ ...healthy(now), disk: { volumes, warnBytes: 5e9, minBytes: 2e9 } });
    expect(disk([{ holds: "the database and backups", freeBytes: 4.2e9 }])).toEqual({ healthy: true, problems: [], warnings: ["Disk: 4.2 GB free for the database and backups (under 5.0 GB)."] });
    expect(disk([{ holds: "the database", freeBytes: 30e9 }, { holds: "backups", freeBytes: 1.4e9 }])).toEqual({
      healthy: false,
      problems: ["Disk: only 1.4 GB free for backups (under 2.0 GB): NSE history downloads and backups won't run, and database writes may soon fail."],
      warnings: [],
    });
    expect(disk([{ holds: "the database", freeBytes: null }]).healthy).toBe(true); // unknown: say nothing
    expect(assessHealth({ ...healthy(now), disk: { volumes: [{ holds: "the database", freeBytes: 1e9 }], warnBytes: 0, minBytes: 0 } }).healthy).toBe(true); // thresholds off
  });

  it("reads disk thresholds and free space", () => {
    expect(loadConfig({})).toMatchObject({ diskWarnBytes: 5e9, diskMinBytes: 2e9 });
    expect(loadConfig({ HUB_DISK_MIN_GB: "0.5", HUB_DISK_WARN_GB: "1.5" })).toMatchObject({ diskWarnBytes: 1.5e9, diskMinBytes: 0.5e9 });
    expect(loadConfig({ HUB_DISK_MIN_GB: "8" })).toMatchObject({ diskWarnBytes: 8e9, diskMinBytes: 8e9 }); // the warning follows a raised floor
    expect(() => loadConfig({ HUB_DISK_MIN_GB: "3", HUB_DISK_WARN_GB: "2" })).toThrow(/HUB_DISK_WARN_GB must be at least HUB_DISK_MIN_GB/);
    expect(() => loadConfig({ HUB_DISK_MIN_GB: "lots" })).toThrow(/HUB_DISK_MIN_GB must be a number of GB/);
    expect(() => loadConfig({ HUB_DISK_WARN_GB: "-1" })).toThrow(/HUB_DISK_WARN_GB/);

    expect([gb(310e6), gb(1.44e9), gb(23.4e9)]).toEqual(["310 MB", "1.4 GB", "23 GB"]);
    const dir = mkdtempSync(path.join(tmpdir(), "hub-disk-"));
    try {
      // A backup directory that doesn't exist yet is on its parent's disk.
      expect(hubVolumes(dir, path.join(dir, "backups", "nightly"))).toEqual([{ holds: "the database and backups", freeBytes: expect.any(Number) }]);
      expect(hubVolumes(dir, null)[0].freeBytes).toBeGreaterThan(0);
      expect(shortOfSpace({ dir, minFreeBytes: 0 })).toBeNull();
      expect(shortOfSpace({ dir, minFreeBytes: 1e18 })?.message).toMatch(/^only .+ free on the disk, under the 1000000000 GB kept free/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("/v1/status reports free disk and backup sizes, and low disk as a problem", async () => {
    const backups = mkdtempSync(path.join(tmpdir(), "hub-backups-"));
    const h = makeHub({ env: { HUB_BACKUP_DIR: backups, HUB_DISK_MIN_GB: "1000000" } });
    try {
      await backupDb(h.db, backups, 7, Date.now());
      const { key } = createKey(h.db, "uptime", ["history"]);
      const body = (await (await h.app().request("/v1/status", { headers: { Authorization: `Bearer ${key}` } })).json()) as { problems: string[]; disk: unknown };
      expect(body.problems).toContainEqual(expect.stringMatching(/^Disk: only .+ free for the database and backups \(under 1000000 GB\)/));
      expect(body.disk).toEqual({
        volumes: [{ holds: "the database and backups", freeBytes: expect.any(Number) }],
        warnBelowBytes: 1e15,
        minFreeBytes: 1e15,
        backups: { count: 1, bytes: listBackups(backups)[0].bytes, newestBytes: listBackups(backups)[0].bytes },
      });
      // Nothing about where things are.
      expect(JSON.stringify(body)).not.toContain(backups);
      expect(JSON.stringify(body)).not.toContain(h.dir);
    } finally {
      h.cleanup();
      rmSync(backups, { recursive: true, force: true });
    }
  });

  it("/v1/status reports health; ?strict=1 answers 503 when unhealthy", async () => {
    const h = makeHub();
    try {
      const { key } = createKey(h.db, "uptime", ["history"]);
      const get = (query = "") => h.app().request(`/v1/status${query}`, { headers: { Authorization: `Bearer ${key}` } });
      const empty = (await (await get()).json()) as { healthy: boolean; problems: string[] };
      expect(empty.healthy).toBe(false);
      expect(empty.problems).toContain("Cash bhavcopy: nothing stored yet.");
      expect(empty.problems).toContain("PR zip (results calendar): nothing stored yet.");
      const strict = await get("?strict=1");
      expect(strict.status).toBe(503);
      expect(await strict.json()).toMatchObject({ code: "unhealthy", healthy: false });

      // Fresh everything (relative to the real clock: these checks run on "now").
      const now = Date.now();
      const today = parseIsoDay(new Date(now + 5.5 * 3_600_000).toISOString().slice(0, 10))!;
      for (let day = today - 10 * DAY_MS; day <= today; day += DAY_MS) {
        markDay(h.db, "cash_bhav", day, "ok", 1, now);
        writeFoDay(h.db, day, [], now);
        markDay(h.db, "pr", day, "ok", 0, now);
      }
      for (const name of ["lots", "fo_ban"] as const) recordRun(h.db, name, { at: now, ok: true });
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
