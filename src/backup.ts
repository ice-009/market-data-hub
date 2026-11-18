import { createReadStream, createWriteStream, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { constants as zlib, createGunzip, createGzip } from "node:zlib";
import Database from "better-sqlite3";
import type { Db } from "./db.js";
import { DiskSpaceError, shortOfSpace, type DiskFloor } from "./disk.js";
import { MINUTE_MS, istParts, isWeekday } from "./time.js";

// Backups of the hub database: `hub data backup` and, when HUB_BACKUP_DIR is
// set, a nightly one from the server's scheduler. SQLite's online backup API
// copies a consistent snapshot page by page while the server keeps reading and
// writing, so the hub never has to stop. The copy is written under a temporary
// name and checked, then gzipped (SQLite files shrink several times), the
// gzip read back, and only then renamed into place, so a half-written file is
// never mistaken for a backup; the newest `keep` are kept. Only compressed
// copies are kept — the uncompressed one exists for the minutes the backup
// takes. Older uncompressed `hub-*.db` backups still count and rotate out.
//
// A backup needs room for the uncompressed copy while it runs: it doesn't
// start without that plus HUB_DISK_MIN_GB free, and stops (cleaning up) if free
// space falls under HUB_DISK_MIN_GB while it writes.
//
// Restoring: stop the hub, unzip a backup over HUB_DATA_DIR/hub.db
// (`gunzip -c hub-….db.gz > data/hub.db`), delete hub.db-wal and hub.db-shm
// next to it, start the hub (README → Backups, docs/api.md#data-backup).

export const DEFAULT_KEEP = 7;
const NAME = /^hub-(\d{8})-(\d{6})\.db(\.gz)?$/;
/** Leftovers of a backup that died (`*.partial`, with -wal/-shm) older than this are removed. */
const STALE_PARTIAL_MS = 6 * 60 * MINUTE_MS;
/** How often (bytes written) a running backup looks at free space again. */
const CHECK_EVERY_BYTES = 64 * 2 ** 20;
/**
 * Room a backup asks for up front, as a share of the database: the uncompressed
 * copy plus the gzip being written next to it (SQLite files gzip to well under half).
 */
export const BACKUP_ROOM = 1.5;

/** "hub-20261109-183000.db.gz" for an instant (UTC, so names sort by time). */
export function backupName(now: number): string {
  const iso = new Date(now).toISOString();
  return `hub-${iso.slice(0, 10).replaceAll("-", "")}-${iso.slice(11, 19).replaceAll(":", "")}.db.gz`;
}

export interface BackupEntry {
  file: string;
  at: number;
  bytes: number;
  /** Gzipped (current backups) or a plain SQLite file (before compression was added). */
  compressed: boolean;
}

/** Backups in a directory, newest first (only files named by backupName, or older uncompressed ones). */
export function listBackups(dir: string): BackupEntry[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .map((name) => {
      const match = NAME.exec(name);
      if (!match) return null;
      const [d, t] = [match[1], match[2]];
      const at = Date.UTC(Number(d.slice(0, 4)), Number(d.slice(4, 6)) - 1, Number(d.slice(6, 8)), Number(t.slice(0, 2)), Number(t.slice(2, 4)), Number(t.slice(4, 6)));
      try {
        return { file: path.join(dir, name), at, bytes: statSync(path.join(dir, name)).size, compressed: match[3] === ".gz" };
      } catch {
        return null; // removed meanwhile (rotation in another process)
      }
    })
    .filter((entry): entry is BackupEntry => entry !== null)
    .sort((a, b) => b.at - a.at);
}

/** Which backups rotation removes: all but the newest `keep`. Pure. */
export const toPrune = <T extends { at: number }>(backups: readonly T[], keep: number): T[] => [...backups].sort((a, b) => b.at - a.at).slice(Math.max(1, keep));

export interface BackupResult {
  file: string;
  /** Size of the gzipped backup. */
  bytes: number;
  /** Size of the database it holds (uncompressed). */
  dbBytes: number;
  removed: string[];
}

/** Remove what a backup that died left behind (old enough not to be another one still running). */
function removeStalePartials(dir: string, now: number) {
  for (const name of readdirSync(dir)) {
    if (!/^hub-\d{8}-\d{6}\.db(\.gz)?\.partial(-wal|-shm)?$/.test(name)) continue;
    const file = path.join(dir, name);
    try {
      if (now - statSync(file).mtimeMs > STALE_PARTIAL_MS) rmSync(file, { force: true });
    } catch {
      // gone already
    }
  }
}

/** A pass-through that calls `check` every `every` bytes (throwing from it fails the pipeline). */
function meter(check: () => void, every: number) {
  let sinceCheck = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      sinceCheck += chunk.length;
      if (sinceCheck >= every) {
        sinceCheck = 0;
        try {
          check();
        } catch (error) {
          done(error as Error);
          return;
        }
      }
      done(null, chunk);
    },
  });
}

/** The bytes a gzip file unzips to (reading it through checks its CRC). */
async function gunzippedBytes(file: string): Promise<number> {
  let bytes = 0;
  await pipeline(createReadStream(file), createGunzip(), new Writable({ write: (chunk: Buffer, _encoding, done) => ((bytes += chunk.length), done()) }));
  return bytes;
}

/**
 * Snapshot `db` into `dir`, check the copy, gzip it, then rotate. `disk` is the
 * free space to leave on the backup volume (0 / absent = no check); a backup
 * that would go under it throws a DiskSpaceError and leaves nothing behind.
 */
export async function backupDb(db: Db, dir: string, keep = DEFAULT_KEEP, now = Date.now(), disk?: Omit<DiskFloor, "dir"> & { checkEveryBytes?: number }): Promise<BackupResult> {
  mkdirSync(dir, { recursive: true });
  removeStalePartials(dir, now);
  const file = path.join(dir, backupName(now));
  const copyFile = `${file.slice(0, -".gz".length)}.partial`;
  const gzFile = `${file}.partial`;
  const clean = () => [...["", "-wal", "-shm"].map((suffix) => `${copyFile}${suffix}`), gzFile].forEach((name) => rmSync(name, { force: true }));
  const floor: DiskFloor = { dir, minFreeBytes: disk?.minFreeBytes ?? 0, free: disk?.free };
  const checkEvery = disk?.checkEveryBytes ?? CHECK_EVERY_BYTES;
  const pageSize = Number(db.pragma("page_size", { simple: true }));
  const dbBytes = Number(db.pragma("page_count", { simple: true })) * pageSize;
  const before = shortOfSpace(floor, Math.ceil(dbBytes * BACKUP_ROOM));
  if (before) throw new DiskSpaceError(`Backup not started: ${before.message}.`, before.free, before.need);
  const stillRoom = () => {
    const short = shortOfSpace(floor);
    if (short) throw new DiskSpaceError(`Backup stopped and removed: ${short.message}.`, short.free, short.need);
  };

  clean();
  try {
    let checkedAt = dbBytes;
    await db.backup(copyFile, {
      progress: ({ remainingPages }) => {
        const remaining = remainingPages * pageSize;
        if (checkedAt - remaining >= checkEvery) {
          checkedAt = remaining;
          stillRoom(); // throwing here aborts the copy
        }
        return 100; // pages per step (better-sqlite3's default)
      },
    });
    // The copy keeps the source's WAL mode; switch it to a plain single file so it
    // can be copied around (and restored) on its own, then check it.
    const copy = new Database(copyFile);
    try {
      copy.pragma("journal_mode = DELETE");
      const check = copy.pragma("quick_check", { simple: true });
      if (check !== "ok") throw new Error(`the copy failed SQLite's quick_check: ${String(check)}`);
    } finally {
      copy.close();
    }
    const copied = statSync(copyFile).size;
    await pipeline(createReadStream(copyFile), createGzip({ level: zlib.Z_DEFAULT_COMPRESSION }), meter(stillRoom, checkEvery), createWriteStream(gzFile));
    const unzipped = await gunzippedBytes(gzFile);
    if (unzipped !== copied) throw new Error(`the gzipped backup reads back as ${unzipped} bytes, not ${copied}`);
    renameSync(gzFile, file);
    rmSync(copyFile, { force: true });
  } catch (error) {
    clean();
    throw error;
  }
  const removed = toPrune(listBackups(dir), keep).map((old) => old.file);
  for (const old of removed) rmSync(old, { force: true });
  return { file, bytes: statSync(file).size, dbBytes, removed };
}

/** Space nightly backups this far apart at least. */
export const BACKUP_EVERY_MS = 22 * 60 * MINUTE_MS;

/**
 * Is a scheduled backup due? Once a day, never during the trading day (08:45–16:00
 * IST on weekdays), so the copy doesn't compete with live prices. Pure.
 */
export function backupDue(now: number, lastAt: number | null): boolean {
  if (lastAt !== null && now - lastAt < BACKUP_EVERY_MS) return false;
  const { day, minutes } = istParts(now);
  return !(isWeekday(day) && minutes >= 8 * 60 + 45 && minutes < 16 * 60);
}
