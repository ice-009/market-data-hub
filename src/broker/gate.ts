import type { Db } from "../db.js";
import { readKv, writeKv } from "../db.js";
import { istDayKey, sleep } from "../time.js";
import { FYERS_PLANS, RateBudget, emptyBudgetState, type BudgetSnapshot, type BudgetState, type Priority } from "./budget.js";

// The one gate every broker data call goes through (policy in ./budget.ts).
// The day's counters, strikes and the calls still inside the last minute are
// saved in the hub database, so a restart can neither reset today's count nor
// forget a cooldown. Only one process uses the broker at a time (the owner
// lock, src/owner.ts), so an in-memory budget saved after every change is
// enough — no cross-process counting is needed.
//
// A free slot goes to the most important caller waiting: user before refresh
// before background.

const STATE_KEY = "fyers_budget";
const SAVE_DEBOUNCE_MS = 1_000;

export class BudgetExhaustedError extends Error {
  constructor(readonly reason: "day" | "strikes") {
    super(reason === "day" ? "Today's broker data budget is used up." : "Broker calls are stopped for today after repeated rate-limit strikes.");
    this.name = "BudgetExhaustedError";
  }
}

interface Saved extends BudgetState {
  recentDone?: number[];
}

const RANK: Record<Priority, number> = { user: 0, refresh: 1, background: 2 };

export class BrokerGate {
  readonly budget: RateBudget;
  private waiting: Record<Priority, number> = { user: 0, refresh: 0, background: 0 };
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly db: Db,
    readonly plan: "standard" | "prime",
    private readonly clock: () => number = Date.now,
  ) {
    const now = clock();
    const today = istDayKey(now);
    const saved = readKv<Saved>(db, STATE_KEY);
    let state = emptyBudgetState(today);
    let recent: number[] = [];
    if (saved && saved.day === today && typeof saved.usedToday === "number") {
      const { recentDone, ...rest } = saved;
      state = { ...state, ...rest, byPriority: { ...state.byPriority, ...rest.byPriority } };
      // Calls answered within the last minute before a restart still count against the broker's windows.
      recent = (recentDone ?? []).filter((time) => typeof time === "number" && now - time < 60_000);
    }
    this.budget = new RateBudget(FYERS_PLANS[plan], state, istDayKey, recent);
  }

  /**
   * Wait for a slot at `priority`, then count the call. Call the returned function
   * when the response (or an error) arrives. Throws BudgetExhaustedError when the
   * day's share is spent or broker calls are stopped for the day.
   */
  async acquire(priority: Priority): Promise<() => void> {
    this.waiting[priority] += 1;
    try {
      for (;;) {
        const now = this.clock();
        const decision = this.budget.check(priority, now);
        if (decision.ok && !this.higherWaiting(priority)) {
          const slot = this.budget.record(priority, now);
          // Counted on disk before the call goes out: a crash can't hide a sent call.
          this.flush();
          return () => {
            this.budget.finish(slot, this.clock());
            this.save();
          };
        }
        if (!decision.ok && "denied" in decision) throw new BudgetExhaustedError(decision.denied);
        await sleep(decision.ok ? 25 : Math.max(20, Math.min(decision.waitMs, 5_000)));
      }
    } finally {
      this.waiting[priority] -= 1;
    }
  }

  /** The broker answered 429: pause everything and count a strike. */
  rateLimited() {
    this.budget.rateLimited(this.clock());
    this.flush();
  }

  /** Calls `priority` may still make today. */
  remainingToday(priority: Priority) {
    return this.budget.remainingToday(priority, this.clock());
  }

  snapshot(): BudgetSnapshot & { plan: "standard" | "prime"; coolingDown: boolean; stoppedForToday: boolean } {
    const now = this.clock();
    const snapshot = this.budget.snapshot(now);
    const decision = this.budget.check("user", now);
    return { ...snapshot, plan: this.plan, coolingDown: snapshot.cooldownUntil > now, stoppedForToday: !decision.ok && "denied" in decision };
  }

  /** Write the state now (shutdown, or after a strike). */
  flush() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    writeKv(this.db, STATE_KEY, { ...this.budget.state, recentDone: this.budget.recentDone(this.clock()) } satisfies Saved);
  }

  private save() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        this.flush();
      } catch {
        // database closed during shutdown: the final flush already ran
      }
    }, SAVE_DEBOUNCE_MS);
    this.saveTimer.unref?.();
  }

  private higherWaiting(priority: Priority) {
    return (Object.keys(this.waiting) as Priority[]).some((other) => RANK[other] < RANK[priority] && this.waiting[other] > 0);
  }
}

/** Budget state as last saved, without a live gate (the CLI's status view). */
export function savedBudget(db: Db, now = Date.now()): BudgetState | null {
  const saved = readKv<Saved>(db, STATE_KEY);
  return saved && saved.day === istDayKey(now) ? saved : null;
}
