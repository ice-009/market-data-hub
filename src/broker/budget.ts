// Request budget for a rate-limited data API (Fyers Data APIs).
//
// Fyers limits (from 16 Oct 2026), Data APIs — quotes, history, depth, option chain:
//   Standard:   5 / second,  50 / minute,    5,000 / day; 50 symbols per quote call;  100 socket symbols
//   Prime:     10 / second, 500 / minute, 5,00,000 / day; 1,000 symbols per quote call; 5,000 socket symbols
// Going over a per-minute limit more than 3 times in a day blocks the account
// for the rest of the day, so this budget stays well inside every limit and
// treats a single 429 as a strike that pauses everything.
//
// Windows are counted by what Fyers can see, not by when we sent: a call takes
// a slot from the moment it's sent until one window-length after its response.
// Counting send times alone isn't enough — the first calls on a cold connection
// are held up by the TLS handshake and reach Fyers together with the next
// second's calls (that's how a 4/s send rate produced 429s at startup). With
// in-flight + recently-finished calls under the cap, no 1-second (or 1-minute)
// window at Fyers' end can hold more than the cap, whatever the latency.
//
// Callers ask by priority:
//   user        — something a person is waiting on right now
//   refresh     — keeping live things current (quotes, from H2)
//   background  — history fetches and backfills
// Lower priorities may use only a share of each window, so a background sweep can
// never starve a chart, and the last part of the day is kept for the user.
//
// Pure: time is passed in. src/broker/gate.ts keeps one instance per process and
// persists `state` in the hub database. (Ported from Tradex, MIT.)

export type Priority = "user" | "refresh" | "background";

export interface PlanLimits {
  perSecond: number;
  perMinute: number;
  perDay: number;
  /** Symbols per quotes request. */
  quoteBatch: number;
  /** Symbols across all data-socket connections. */
  socketSymbols: number;
}

export const FYERS_PLANS: Record<"standard" | "prime", PlanLimits> = {
  standard: { perSecond: 5, perMinute: 50, perDay: 5_000, quoteBatch: 50, socketSymbols: 100 },
  prime: { perSecond: 10, perMinute: 500, perDay: 500_000, quoteBatch: 1_000, socketSymbols: 5_000 },
};

/** Fraction of each official limit we allow ourselves. */
export const HEADROOM = { second: 0.6, minute: 0.8, day: 0.95 };

/** After a 429 today, the rest of the day runs this much slower (fewer chances of a 4th strike). */
export const AFTER_STRIKE = { perSecond: 1, minuteFactor: 0.5 };

/** Share of the (headroom-adjusted) minute and day windows each priority may fill. */
export const PRIORITY_SHARE: Record<Priority, { minute: number; day: number }> = {
  user: { minute: 1, day: 1 },
  refresh: { minute: 0.75, day: 0.85 },
  background: { minute: 0.5, day: 0.7 },
};

/** After a 429, nothing is sent for this long (the rolling minute must clear). */
export const COOLDOWN_MS = 61_000;

/**
 * Strikes after which the hub sends no more data calls until the next IST day.
 * Fyers blocks the account on the 4th; stopping at 2 leaves a margin for a
 * strike caused by something outside the hub (another app on the same account).
 */
export const MAX_STRIKES_PER_DAY = 2;

export interface BudgetState {
  /** IST day key the day counters belong to. */
  day: number;
  usedToday: number;
  byPriority: Record<Priority, number>;
  /** 429s received today. */
  strikes: number;
  cooldownUntil: number;
}

export type Decision = { ok: true } | { ok: false; waitMs: number; reason: "second" | "minute" | "cooldown" } | { ok: false; denied: "day" | "strikes" };

/** A sent call; `done` is set when its response arrives. */
export interface Slot {
  at: number;
  done: number | null;
}

export interface BudgetSnapshot {
  limits: PlanLimits;
  day: number;
  usedToday: number;
  /** Our own daily ceiling (limits.perDay × headroom). */
  dayCap: number;
  usedThisMinute: number;
  minuteCap: number;
  /** Calls waiting for a response right now. */
  inFlight: number;
  /** True after a 429 today: running at the slower after-strike rate. */
  slowed: boolean;
  byPriority: Record<Priority, number>;
  strikes: number;
  cooldownUntil: number;
}

const emptyByPriority = (): Record<Priority, number> => ({ user: 0, refresh: 0, background: 0 });

export function emptyBudgetState(day: number): BudgetState {
  return { day, usedToday: 0, byPriority: emptyByPriority(), strikes: 0, cooldownUntil: 0 };
}

export class RateBudget {
  /** Calls in flight or finished within the last minute. */
  private slots: Slot[] = [];

  constructor(
    readonly limits: PlanLimits,
    public state: BudgetState,
    /** Maps a timestamp to its IST day key (injected so this stays pure). */
    private readonly dayOf: (time: number) => number,
    /** Response times of calls finished before a restart (still inside their minute). */
    recentDone: number[] = [],
  ) {
    this.slots = recentDone.map((done) => ({ at: done, done }));
  }

  get slowed() {
    return this.state.strikes > 0;
  }

  get secondCap() {
    const normal = Math.max(1, Math.floor(this.limits.perSecond * HEADROOM.second));
    return this.slowed ? Math.min(normal, AFTER_STRIKE.perSecond) : normal;
  }

  get minuteCap() {
    const normal = Math.max(1, Math.floor(this.limits.perMinute * HEADROOM.minute));
    return this.slowed ? Math.max(1, Math.floor(normal * AFTER_STRIKE.minuteFactor)) : normal;
  }

  get dayCap() {
    return Math.floor(this.limits.perDay * HEADROOM.day);
  }

  /** Calls `priority` may still make today. */
  remainingToday(priority: Priority, now: number): number {
    this.rollDay(now);
    return Math.max(0, Math.floor(this.dayCap * PRIORITY_SHARE[priority].day) - this.state.usedToday);
  }

  /** Calls per minute `priority` may make. */
  minuteShare(priority: Priority): number {
    return Math.max(1, Math.floor(this.minuteCap * PRIORITY_SHARE[priority].minute));
  }

  /** May one call of `priority` go now? Otherwise how long to wait, or denied for the day. */
  check(priority: Priority, now: number): Decision {
    this.rollDay(now);
    this.prune(now);
    if (this.state.strikes >= MAX_STRIKES_PER_DAY) return { ok: false, denied: "strikes" };
    if (now < this.state.cooldownUntil) return { ok: false, waitMs: this.state.cooldownUntil - now, reason: "cooldown" };
    if (this.remainingToday(priority, now) < 1) return { ok: false, denied: "day" };

    const second = this.wait(1_000, this.secondCap, now);
    if (second !== null) return { ok: false, waitMs: second, reason: "second" };

    // A priority's minute share counts every call in the window, not only its own,
    // so lower priorities stop early and leave the rest of the minute free.
    const minute = this.wait(60_000, this.minuteShare(priority), now);
    if (minute !== null) return { ok: false, waitMs: minute, reason: "minute" };
    return { ok: true };
  }

  /** Count a call that is being sent. Pass the returned slot to `finish` when its response arrives. */
  record(priority: Priority, now: number): Slot {
    this.rollDay(now);
    const slot: Slot = { at: now, done: null };
    this.slots.push(slot);
    this.state.usedToday += 1;
    this.state.byPriority[priority] += 1;
    return slot;
  }

  /** The call's response (or failure) arrived. */
  finish(slot: Slot, now: number) {
    slot.done ??= now;
  }

  /**
   * The API answered 429: stop everything until the minute clears, and run slower
   * for the rest of the day. 429s that arrive during the pause come from the same
   * burst (calls already in flight) and don't count as another strike.
   */
  rateLimited(now: number) {
    this.rollDay(now);
    if (now >= this.state.cooldownUntil) this.state.strikes += 1;
    this.state.cooldownUntil = now + COOLDOWN_MS;
  }

  /** Response times of calls that still occupy the minute window (to persist across a restart). */
  recentDone(now: number): number[] {
    this.prune(now);
    return this.slots.flatMap((slot) => (slot.done !== null ? [slot.done] : []));
  }

  /** Calls occupying a window ending now: in flight, or answered within the window. */
  private occupying(windowMs: number, now: number) {
    return this.slots.filter((slot) => slot.done === null || now - slot.done < windowMs);
  }

  /** null when another call fits in the window; otherwise ms until a slot frees up. */
  private wait(windowMs: number, cap: number, now: number): number | null {
    const occupying = this.occupying(windowMs, now);
    if (occupying.length < cap) return null;
    // Finished calls leave the window `windowMs` after their response; in-flight ones are unknown, so poll.
    const done = occupying.flatMap((slot) => (slot.done !== null ? [slot.done] : [])).sort((a, b) => a - b);
    const freeing = occupying.length - cap; // this many must leave first (0-based index into finished ones)
    return freeing < done.length ? Math.max(20, done[freeing] + windowMs - now + 5) : 50;
  }

  snapshot(now: number): BudgetSnapshot {
    this.rollDay(now);
    this.prune(now);
    return {
      limits: this.limits,
      day: this.state.day,
      usedToday: this.state.usedToday,
      dayCap: this.dayCap,
      usedThisMinute: this.occupying(60_000, now).length,
      minuteCap: this.minuteCap,
      inFlight: this.slots.filter((slot) => slot.done === null).length,
      slowed: this.slowed,
      byPriority: { ...this.state.byPriority },
      strikes: this.state.strikes,
      cooldownUntil: this.state.cooldownUntil,
    };
  }

  private prune(now: number) {
    this.slots = this.slots.filter((slot) => slot.done === null || now - slot.done < 60_000);
  }

  private rollDay(now: number) {
    const day = this.dayOf(now);
    if (day !== this.state.day) this.state = emptyBudgetState(day);
  }
}
