import { statSync, statfsSync } from "node:fs";
import path from "node:path";

// Free disk space. A full disk makes SQLite fail writes, so the hub watches the
// volumes it writes to: /v1/status warns under HUB_DISK_WARN_GB and reports a
// problem under HUB_DISK_MIN_GB, and the two big writers — `hub data
// nse-history` and backups — refuse to start, or stop, below HUB_DISK_MIN_GB.
// Messages give sizes only, never paths (they end up in /v1/status).

export const GB = 1e9;

/** Bytes free (for an unprivileged process) on the volume holding `dir`, or null when it can't be read. */
export function freeBytes(dir: string): number | null {
  // The directory may not exist yet (a fresh HUB_BACKUP_DIR): ask about the nearest parent that does.
  for (let at = path.resolve(dir); ; at = path.dirname(at)) {
    try {
      const stats = statfsSync(at);
      return Number(stats.bavail) * Number(stats.bsize);
    } catch {
      if (path.dirname(at) === at) return null;
    }
  }
}

/** "1.4 GB", "23 GB", "310 MB" — for messages. */
export const gb = (bytes: number) => (bytes < GB ? `${Math.round(bytes / 1e6)} MB` : `${(bytes / GB).toFixed(bytes < 10 * GB ? 1 : 0)} GB`);

/** What a writer checks before and while it writes: a volume and the least it must leave free. */
export interface DiskFloor {
  dir: string;
  /** 0 turns the check off. */
  minFreeBytes: number;
  /** Injected in tests. */
  free?: (dir: string) => number | null;
}

export class DiskSpaceError extends Error {
  constructor(
    message: string,
    readonly free: number,
    readonly need: number,
  ) {
    super(message);
  }
}

/**
 * Null when `extra` bytes can be written to the floor's volume and still leave
 * its minimum free; otherwise why not (sizes only). Unknown free space passes.
 */
export function shortOfSpace(floor: DiskFloor, extra = 0): { free: number; need: number; message: string } | null {
  if (floor.minFreeBytes <= 0) return null;
  const free = (floor.free ?? freeBytes)(floor.dir);
  if (free === null) return null;
  const need = floor.minFreeBytes + Math.max(0, extra);
  if (free >= need) return null;
  const message = extra > 0
    ? `only ${gb(free)} free on the disk; this needs about ${gb(extra)} plus the ${gb(floor.minFreeBytes)} kept free (HUB_DISK_MIN_GB)`
    : `only ${gb(free)} free on the disk, under the ${gb(floor.minFreeBytes)} kept free (HUB_DISK_MIN_GB)`;
  return { free, need, message };
}

/** The device a directory (or its nearest existing parent) is on, or null. */
function deviceOf(dir: string): number | null {
  for (let at = path.resolve(dir); ; at = path.dirname(at)) {
    try {
      return statSync(at).dev;
    } catch {
      if (path.dirname(at) === at) return null;
    }
  }
}

export interface Volume {
  /** What the hub keeps there, for messages: "the database", "backups", "the database and backups". */
  holds: string;
  freeBytes: number | null;
}

/** Free space where the database and (when set) backups live — one entry when they share a disk. */
export function hubVolumes(dataDir: string, backupDir: string | null, free: (dir: string) => number | null = freeBytes): Volume[] {
  if (backupDir === null) return [{ holds: "the database", freeBytes: free(dataDir) }];
  const same = deviceOf(dataDir) !== null && deviceOf(dataDir) === deviceOf(backupDir);
  if (same) return [{ holds: "the database and backups", freeBytes: free(dataDir) }];
  return [
    { holds: "the database", freeBytes: free(dataDir) },
    { holds: "backups", freeBytes: free(backupDir) },
  ];
}
