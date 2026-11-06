import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Priority } from "../src/broker/budget.js";
import { BrokerError } from "../src/broker/errors.js";
import type { Bar, HistoryResult, Resolution } from "../src/broker/fyers.js";
import { HistoryService, type HistoryBroker } from "../src/history/service.js";
import { cancelJob, enqueueBackfill, getJob, maxYears, nextRunnableJob, recoverJobs, resumeTime, runBackfill, validateBackfill } from "../src/jobs/backfill.js";
import { createLogger } from "../src/log.js";
import { acquireOwner, ownerPid } from "../src/owner.js";
import { DAY_MS, isWeekday } from "../src/time.js";
import { ist, makeHub, type TestHub } from "./support/hub.js";

const quiet = createLogger({ level: "error", secrets: [], write: () => {} });

class CountingBroker implements HistoryBroker {
  calls: string[] = [];
  failFor = new Map<string, BrokerError>();
  async history(symbol: string, resolution: Resolution, fromDay: number, toDay: number, priority: Priority): Promise<HistoryResult> {
    expect(priority).toBe("background");
    this.calls.push(symbol);
    const failure = this.failFor.get(symbol);
    if (failure) throw failure;
    const bars: Bar[] = [];
    for (let day = fromDay; day <= toDay; day += DAY_MS) if (isWeekday(day)) bars.push({ t: day, o: 1, h: 1, l: 1, c: 1, v: 1 });
    return { bars, coveredFromDay: fromDay, complete: true };
  }
}

describe("backfill jobs", () => {
  const opened: TestHub[] = [];
  let t: TestHub;
  afterEach(() => opened.splice(0).forEach((hub) => hub.cleanup()));
  const setup = (now: number) => {
    t = makeHub();
    opened.push(t);
    const broker = new CountingBroker();
    const clock = () => now;
    const history = new HistoryService({ db: t.db, broker, log: quiet, fetchWaitMs: 1_000, clock });
    return { broker, deps: { db: t.db, history, log: quiet, clock } };
  };

  it("validates its parameters against the broker's window", () => {
    expect(validateBackfill({ tf: "1d", years: 5, symbols: null })).toBeNull();
    expect(validateBackfill({ tf: "15m", years: 2, symbols: null })).toMatch(/at most 1 year/);
    expect(validateBackfill({ tf: "1h" as never, years: 1, symbols: null })).toMatch(/--tf/);
    expect(maxYears("1d")).toBe(5);
  });

  it("runs to the end at background priority and skips what's stored on a re-run", async () => {
    const { broker, deps } = setup(ist(2026, 11, 4, 20));
    const job = enqueueBackfill(t.db, { tf: "1d", years: 1, symbols: ["SBIN", "INFY"] });
    const done = await runBackfill(deps, job.id);
    expect(done).toMatchObject({ state: "done", done: 2, total: 2, failed: 0 });
    expect(broker.calls.sort()).toEqual(["INFY", "SBIN"]);
    const again = await runBackfill(deps, enqueueBackfill(t.db, { tf: "1d", years: 1, symbols: ["SBIN", "INFY", "TCS"] }).id);
    expect(again).toMatchObject({ state: "done", done: 3, total: 3 });
    expect(broker.calls.filter((s) => s === "SBIN")).toHaveLength(1);
  });

  it("defaults to the F&O universe plus the main indices", async () => {
    const { broker, deps } = setup(ist(2026, 11, 4, 20));
    const done = await runBackfill(deps, enqueueBackfill(t.db, { tf: "1d", years: 1, symbols: null }).id);
    expect(done.total).toBeGreaterThan(150);
    expect(broker.calls).toEqual(expect.arrayContaining(["NIFTY", "BANKNIFTY", "FINNIFTY", "SBIN"]));
  });

  it("pauses in market hours and resumes after the close", async () => {
    const { broker, deps } = setup(ist(2026, 11, 4, 11));
    const job = enqueueBackfill(t.db, { tf: "1d", years: 1, symbols: ["SBIN"] });
    const paused = await runBackfill(deps, job.id);
    expect(paused).toMatchObject({ state: "paused", resumeAfter: ist(2026, 11, 4, 15, 35) });
    expect(paused.message).toMatch(/market hours/);
    expect(broker.calls).toEqual([]);
    expect(nextRunnableJob(t.db, ist(2026, 11, 4, 15))).toBeNull();
    expect(nextRunnableJob(t.db, ist(2026, 11, 4, 15, 40))?.id).toBe(job.id);
    // Asking again for the same backfill reuses the paused job.
    expect(enqueueBackfill(t.db, { tf: "1d", years: 1, symbols: ["SBIN"] }).id).toBe(job.id);
  });

  it("pauses until tomorrow when the budget is spent, and carries on past a bad symbol", async () => {
    const { broker, deps } = setup(ist(2026, 11, 4, 20));
    broker.failFor.set("NOSUCH", new BrokerError("unknown", "bad_symbol"));
    broker.failFor.set("INFY", new BrokerError("Today's broker data budget is used up.", "budget"));
    const job = await runBackfill(deps, enqueueBackfill(t.db, { tf: "1d", years: 1, symbols: ["NOSUCH", "INFY", "SBIN", "TCS"] }).id);
    expect(job.state).toBe("paused");
    expect(job.message).toMatch(/budget/);
    expect(job.resumeAfter).toBe(resumeTime("budget", ist(2026, 11, 4, 20)));
    expect(job.resumeAfter).toBe(ist(2026, 11, 5, 0, 5));
    expect(job.failed).toBe(1);
  });

  it("can be cancelled, and jobs left running by a dead process are queued again", () => {
    t = makeHub();
    opened.push(t);
    const job = enqueueBackfill(t.db, { tf: "1d", years: 1, symbols: ["SBIN"] });
    t.db.prepare("update jobs set state = 'running' where id = ?").run(job.id);
    recoverJobs(t.db);
    expect(getJob(t.db, job.id)!.state).toBe("queued");
    expect(cancelJob(t.db, job.id)).toBe(true);
    expect(nextRunnableJob(t.db, Date.now())).toBeNull();
  });
});

describe("owner lock", () => {
  it("lets one process own the broker, and takes over a stale lock", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hub-owner-"));
    try {
      const release = acquireOwner(dir)!;
      expect(release).toBeTypeOf("function");
      expect(ownerPid(dir)).toBe(process.pid);
      release();
      expect(ownerPid(dir)).toBeNull();

      // Another live process (our parent) holds it.
      writeFileSync(path.join(dir, "owner.lock"), String(process.ppid));
      expect(acquireOwner(dir)).toBeNull();

      // A crashed process's lock (no such pid) is taken over.
      writeFileSync(path.join(dir, "owner.lock"), "999999");
      const again = acquireOwner(dir);
      expect(again).toBeTypeOf("function");
      again!();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
