import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";

// One process at a time talks to the broker and to NSE: the one holding
// `owner.lock` in the data directory (normally the server). Two processes with
// their own request budgets is exactly how rate-limit strikes happened before
// the hub existed. A CLI backfill started while the server runs doesn't call
// the broker itself; it queues a job that the server picks up.
//
// The lock file holds the owner's pid. A lock whose pid is no longer alive is
// stale (a crash) and is taken over.

const LOCK_FILE = "owner.lock";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The pid holding the lock, or null when it's free (or stale). */
export function ownerPid(dataDir: string): number | null {
  try {
    const pid = Number(readFileSync(path.join(dataDir, LOCK_FILE), "utf8").trim());
    return Number.isInteger(pid) && pid > 0 && alive(pid) ? pid : null;
  } catch {
    return null;
  }
}

/** Take the lock for this process. Returns a release function, or null when another live process holds it. */
export function acquireOwner(dataDir: string): (() => void) | null {
  const file = path.join(dataDir, LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(file, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          if (readFileSync(file, "utf8").trim() === String(process.pid)) unlinkSync(file);
        } catch {
          // already gone
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = ownerPid(dataDir);
      if (holder !== null && holder !== process.pid) return null;
      try {
        unlinkSync(file); // stale lock (or our own from a previous run of this pid)
      } catch {
        // someone else removed it first
      }
    }
  }
  return null;
}
