import { mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { Db } from "./db.js";
import { MINUTE_MS, istParts, isWeekday } from "./time.js";

// Backups of the hub database: `hub data backup` and, when HUB_BACKUP_DIR is
// set, a nightly one from the server's scheduler. SQLite's online backup API
// copies a consistent snapshot page by page while the server keeps reading and
// writing, so the hub never has to stop. A copy is written under a temporary
// name, checked, and only then renamed into place, so a half-written file is
// never mistaken for a backup; the newest `keep` are kept.
//
// Restoring: stop the hub, copy a backup over HUB_DATA_DIR/hub.db, delete
// hub.db-wal and hub.db-shm next to it, start the hub (docs/migrate-tradex.md
// and README → Backups).

export const DEFAULT_KEEP = 7;
const NAME = /^hub-(\d{8})-(\d{6})\.db$/;

/** "hub-20261109-183000.db" for an instant (UTC, so names sort by time). */
export function backupName(now: number): string {
  const iso = new Date(now).toISOString();
  return `hub-${iso.slice(0, 10).replaceAll("-", "")}-${iso.slice(11, 19).replaceAll(":", "")}.db`;
}

/** Backups in a directory, newest first (only files named by backupName). */
export function listBackups(dir: string): Array<{ file: string; at: number; bytes: number }> {
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
      return { file: path.join(dir, name), at, bytes: statSync(path.join(dir, name)).size };
    })
    .filter((entry): entry is { file: string; at: number; bytes: number } => entry !== null)
    .sort((a, b) => b.at - a.at);
}

/** Which backups rotation removes: all but the newest `keep`. Pure. */
export const toPrune = <T extends { at: number }>(backups: readonly T[], keep: number): T[] => [...backups].sort((a, b) => b.at - a.at).slice(Math.max(1, keep));

export interface BackupResult {
  file: string;
  bytes: number;
  removed: string[];
}

/** Snapshot `db` into `dir`, check the copy, then rotate. */
export async function backupDb(db: Db, dir: string, keep = DEFAULT_KEEP, now = Date.now()): Promise<BackupResult> {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, backupName(now));
  const partial = `${file}.partial`;
  const clean = () => ["", "-wal", "-shm"].forEach((suffix) => rmSync(`${partial}${suffix}`, { force: true }));
  clean();
  try {
    await db.backup(partial);
    // The copy keeps the source's WAL mode; switch it to a plain single file so it
    // can be copied around (and restored) on its own, then check it.
    const copy = new Database(partial);
    try {
      copy.pragma("journal_mode = DELETE");
      const check = copy.pragma("quick_check", { simple: true });
      if (check !== "ok") throw new Error(`the copy failed SQLite's quick_check: ${String(check)}`);
    } finally {
      copy.close();
    }
    renameSync(partial, file);
  } catch (error) {
    clean();
    throw error;
  }
  const removed = toPrune(listBackups(dir), keep).map((old) => old.file);
  for (const old of removed) rmSync(old, { force: true });
  return { file, bytes: statSync(file).size, removed };
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
