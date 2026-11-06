import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { COOLDOWN_MS, FYERS_PLANS, MAX_STRIKES_PER_DAY, RateBudget, emptyBudgetState, type Priority } from "../src/broker/budget.js";
import { BrokerError } from "../src/broker/errors.js";
import { FyersClient, planChunks, toBars } from "../src/broker/fyers.js";
import { FyersAuth, LOGIN_RETRY_MS, tokenExpiry } from "../src/broker/fyersAuth.js";
import { BrokerGate, BudgetExhaustedError } from "../src/broker/gate.js";
import { normalizeSymbol, toFyersSymbol } from "../src/broker/symbols.js";
import { totp } from "../src/broker/totp.js";
import { loadConfig, secretValues } from "../src/config.js";
import { openDb, type Db } from "../src/db.js";
import { createLogger } from "../src/log.js";
import { DAY_MS, isoDay, parseIsoDay } from "../src/time.js";
import { ACCESS_TOKEN, FAKE_SECRETS, startMockFyers, type MockFyers } from "./support/mockFyers.js";
import { ist } from "./support/hub.js";

const DAY = 86_400_000;
const dayOf = (time: number) => Math.floor(time / DAY) * DAY;
const fresh = () => new RateBudget(FYERS_PLANS.standard, emptyBudgetState(0), dayOf);

/** Send as many calls as the budget allows at one instant; each answers `latency` ms later. */
function burst(budget: RateBudget, priority: Priority, at: number, latency = 0) {
  let sent = 0;
  while (budget.check(priority, at).ok) {
    const slot = budget.record(priority, at);
    budget.finish(slot, at + latency);
    sent += 1;
  }
  return sent;
}

// Ported from Tradex's budget tests: the policy is unchanged.
describe("request budget (Fyers Standard)", () => {
  it("allows 3 per second and keeps a slow call's slot until a second after its response", () => {
    expect(burst(fresh(), "user", 1_000)).toBe(3);
    const budget = fresh();
    const slots = [0, 1, 2].map(() => budget.record("user", 0));
    expect(budget.check("user", 1_500).ok).toBe(false);
    slots.forEach((slot) => budget.finish(slot, 1_500));
    expect(budget.check("user", 2_000).ok).toBe(false);
    expect(budget.check("user", 2_510).ok).toBe(true);
  });

  it("gives background only half the minute, leaving the rest for the user", () => {
    const budget = fresh();
    let background = 0;
    for (let t = 0; t < 30_000; t += 1_000) background += burst(budget, "background", t);
    expect(background).toBe(20);
    let user = 0;
    for (let t = 30_000; t < 40_000; t += 1_000) user += burst(budget, "user", t);
    expect(user).toBe(20);
  });

  it("caps the day per priority and keeps the end of the day for the user", () => {
    const budget = new RateBudget(FYERS_PLANS.standard, { ...emptyBudgetState(0), usedToday: 3_325 }, dayOf);
    expect(budget.check("background", 1)).toEqual({ ok: false, denied: "day" });
    expect(budget.check("refresh", 1).ok).toBe(true);
    budget.state.usedToday = 4_750;
    expect(budget.check("user", 2)).toEqual({ ok: false, denied: "day" });
  });

  it("pauses after a 429, counts one strike per burst, and runs slower for the rest of the day", () => {
    const budget = fresh();
    budget.rateLimited(5_000);
    budget.rateLimited(5_200);
    expect(budget.check("user", 5_001)).toMatchObject({ ok: false, reason: "cooldown" });
    expect(budget.snapshot(6_000)).toMatchObject({ strikes: 1, slowed: true, minuteCap: 20 });
    expect(burst(budget, "user", 5_200 + COOLDOWN_MS)).toBe(1);
  });

  it(`stops every call for the day after ${MAX_STRIKES_PER_DAY} strikes, and starts afresh the next day`, () => {
    const budget = fresh();
    budget.rateLimited(1_000);
    budget.rateLimited(1_000 + COOLDOWN_MS + 1);
    expect(budget.check("user", 10 * COOLDOWN_MS)).toEqual({ ok: false, denied: "strikes" });
    expect(budget.check("user", DAY + 1).ok).toBe(true);
    expect(budget.snapshot(DAY + 1)).toMatchObject({ strikes: 0, usedToday: 0 });
  });

  it("remembers calls answered just before a restart", () => {
    const budget = new RateBudget(FYERS_PLANS.standard, emptyBudgetState(0), dayOf, [900, 950, 990]);
    expect(budget.check("user", 1_000).ok).toBe(false);
  });
});

describe("broker gate", () => {
  let dir: string;
  let db: Db;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "hub-gate-"));
    db = openDb(dir);
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists today's count and strikes, so a restart doesn't reset them", async () => {
    const gate = new BrokerGate(db, "standard");
    const release = await gate.acquire("background");
    release();
    gate.rateLimited();
    gate.flush();
    const again = new BrokerGate(db, "standard");
    expect(again.snapshot()).toMatchObject({ usedToday: 1, strikes: 1, coolingDown: true, byPriority: { background: 1 } });
  });

  it("refuses calls once the day is stopped after strikes", async () => {
    const gate = new BrokerGate(db, "standard");
    gate.budget.state.strikes = MAX_STRIKES_PER_DAY;
    await expect(gate.acquire("user")).rejects.toBeInstanceOf(BudgetExhaustedError);
    expect(gate.snapshot().stoppedForToday).toBe(true);
  });

  it("forgets yesterday's counts", () => {
    const gate = new BrokerGate(db, "standard", () => ist(2026, 11, 4, 12));
    gate.budget.state.usedToday = 100;
    gate.flush();
    expect(new BrokerGate(db, "standard", () => ist(2026, 11, 5, 9)).snapshot().usedToday).toBe(0);
  });
});

describe("TOTP, symbols and chunks (pure)", () => {
  it("matches the RFC 6238 SHA-1 test vector", () => {
    // Secret "12345678901234567890"; T = 59 s → 94287082 (8 digits) → 287082.
    expect(totp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 59_000)).toBe("287082");
    expect(totp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 1_111_111_109_000)).toBe("081804");
  });

  it("maps plain NSE tickers and indices to Fyers symbols", () => {
    expect(toFyersSymbol("SBIN")).toBe("NSE:SBIN-EQ");
    expect(toFyersSymbol("M&M")).toBe("NSE:M&M-EQ");
    expect(toFyersSymbol("NIFTY")).toBe("NSE:NIFTY50-INDEX");
    expect(toFyersSymbol("BANKNIFTY")).toBe("NSE:NIFTYBANK-INDEX");
    expect(normalizeSymbol(" bajaj-auto ")).toBe("BAJAJ-AUTO");
    expect(normalizeSymbol("NSE:SBIN-EQ")).toBeNull();
    expect(normalizeSymbol("")).toBeNull();
  });

  it("splits a range into ≤ max-day chunks, newest first, without gaps or overlaps", () => {
    const from = parseIsoDay("2021-11-06")!;
    const to = parseIsoDay("2026-11-05")!;
    const chunks = planChunks(from, to, 365);
    expect(chunks).toHaveLength(5);
    expect(isoDay(chunks[0].to)).toBe("2026-11-05");
    expect(isoDay(chunks.at(-1)!.from)).toBe("2021-11-06");
    for (const [i, chunk] of chunks.entries()) {
      expect((chunk.to - chunk.from) / DAY_MS).toBeLessThanOrEqual(365);
      if (i > 0) expect(chunks[i - 1].from - chunk.to).toBe(DAY_MS);
    }
    expect(planChunks(to, to, 90)).toEqual([{ from: to, to }]);
  });

  it("turns Fyers candles into bars (daily stamps → IST day keys) and skips junk", () => {
    const istMidnight = (parseIsoDay("2025-10-29")! - 5.5 * 3_600_000) / 1000;
    expect(toBars([[istMidnight, 1, 2, 0.5, 1.5, 10], ["x"], null], true)).toEqual([{ t: parseIsoDay("2025-10-29"), o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }]);
    expect(toBars("nope", false)).toEqual([]);
  });

  it("treats a token as fresh until the next 06:00 IST", () => {
    expect(tokenExpiry(ist(2026, 11, 4, 20))).toBe(ist(2026, 11, 5, 6));
    expect(tokenExpiry(ist(2026, 11, 5, 5))).toBe(ist(2026, 11, 5, 6));
  });
});

describe("Fyers client against a mock server (no network)", () => {
  let mock: MockFyers;
  let dir: string;
  let db: Db;
  let lines: string[];
  beforeAll(async () => {
    mock = await startMockFyers();
  });
  afterAll(() => mock.close());
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "hub-fyers-"));
    db = openDb(dir);
    lines = [];
    mock.history.length = 0;
    mock.logins = 0;
    mock.wrongPin = false;
    mock.windowStart = null;
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const build = () => {
    const config = loadConfig({ ...mock.env, HUB_DATA_DIR: dir });
    const log = createLogger({ level: "debug", secrets: secretValues(config.secrets), write: (line) => lines.push(line) });
    const gate = new BrokerGate(db, "standard");
    const auth = new FyersAuth({ secrets: config.secrets, fyers: config.fyers, dataDir: dir, log });
    return { gate, auth, client: new FyersClient({ fyers: config.fyers, secrets: config.secrets, auth, gate, log }) };
  };

  it("logs in with TOTP, caches the token (mode 600) and fetches daily history in ≤ 366-day chunks", async () => {
    const { client, gate } = build();
    const from = parseIsoDay("2024-01-01")!;
    const to = parseIsoDay("2025-12-31")!;
    const result = await client.history("SBIN", "D", from, to, "background");
    expect(mock.logins).toBe(1);
    expect(mock.history.map((h) => [h.symbol, h.resolution, h.from, h.to])).toEqual([
      ["NSE:SBIN-EQ", "D", "2024-12-31", "2025-12-31"],
      ["NSE:SBIN-EQ", "D", "2024-01-01", "2024-12-30"],
    ]);
    expect(result.complete).toBe(true);
    expect(result.coveredFromDay).toBe(from);
    expect(result.bars[0].t).toBe(from); // 1 Jan 2024 was a Monday
    expect(result.bars.every((bar, i) => i === 0 || bar.t > result.bars[i - 1].t)).toBe(true);
    expect(gate.snapshot().byPriority.background).toBe(2);

    const file = path.join(dir, "fyers-token.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8")).accessToken).toBe(ACCESS_TOKEN);
    // A second client (a restart) reuses the cached token: no new login.
    await build().client.history("SBIN", "D", to, to, "background");
    expect(mock.logins).toBe(1);
  });

  it("fetches intraday in 90-day chunks", async () => {
    const { client } = build();
    const result = await client.history("INFY", "15", parseIsoDay("2026-05-01")!, parseIsoDay("2026-10-31")!, "background");
    expect(mock.history.map((h) => [h.from, h.to])).toEqual([
      ["2026-08-02", "2026-10-31"],
      ["2026-05-03", "2026-08-01"],
      ["2026-05-01", "2026-05-02"],
    ]);
    expect(result.bars.length).toBeGreaterThan(1000);
  });

  it("stops at the plan's window (422) and reports the rest as complete", async () => {
    mock.windowStart = parseIsoDay("2024-06-01")!;
    const { client } = build();
    const result = await client.history("SBIN", "D", parseIsoDay("2023-01-01")!, parseIsoDay("2025-12-31")!, "background");
    expect(result.complete).toBe(true);
    expect(mock.history.map((h) => h.status)).toEqual([200, 422]);
  });

  it("counts a 429 as a strike, pauses, and never retries it", async () => {
    const { client, gate } = build();
    mock.failNext(429);
    const error = await client.history("SBIN", "D", parseIsoDay("2025-12-01")!, parseIsoDay("2025-12-31")!, "background").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BrokerError);
    expect((error as BrokerError).kind).toBe("rate_limited");
    expect(mock.history).toHaveLength(1);
    expect(gate.snapshot()).toMatchObject({ strikes: 1, coolingDown: true });
  });

  it("keeps what arrived when a later chunk fails", async () => {
    const { client } = build();
    // First chunk ok (0 = no failure), second fails with a server error.
    mock.failNext(0);
    mock.failNext(500);
    const result = await client.history("SBIN", "D", parseIsoDay("2024-01-01")!, parseIsoDay("2025-12-31")!, "background");
    expect(result.complete).toBe(false);
    expect(isoDay(result.coveredFromDay)).toBe("2024-12-31");
  });

  it("logs in again once when the token is rejected", async () => {
    const { client, auth } = build();
    await client.history("SBIN", "D", parseIsoDay("2025-12-01")!, parseIsoDay("2025-12-05")!, "background");
    mock.failNext(401);
    await client.history("SBIN", "D", parseIsoDay("2025-12-08")!, parseIsoDay("2025-12-12")!, "background");
    expect(mock.logins).toBe(2);
    expect(auth.status().connected).toBe(true);
  });

  it("maps an unknown symbol to bad_symbol", async () => {
    const { client } = build();
    await expect(client.history("NOSUCH", "D", parseIsoDay("2025-12-01")!, parseIsoDay("2025-12-05")!, "background")).rejects.toMatchObject({ kind: "bad_symbol" });
  });

  it("backs off after a failed login and never logs or reports a secret", async () => {
    mock.wrongPin = true;
    const { client, auth } = build();
    await expect(client.history("SBIN", "D", parseIsoDay("2025-12-01")!, parseIsoDay("2025-12-05")!, "background")).rejects.toMatchObject({ kind: "auth" });
    // A second request doesn't try to log in again within the back-off.
    await expect(client.history("SBIN", "D", parseIsoDay("2025-12-01")!, parseIsoDay("2025-12-05")!, "background")).rejects.toThrow(/next attempt after/);
    const status = auth.status();
    expect(status.connected).toBe(false);
    expect(status.retryAfter! - Date.now()).toBeGreaterThan(LOGIN_RETRY_MS - 5_000);
    const everything = [...lines, JSON.stringify(status), readFileSync(path.join(dir, "fyers-token.json"), "utf8")].join("\n");
    // (The 4-digit PIN is left out: it could occur by chance inside a timestamp.)
    for (const secret of Object.values(FAKE_SECRETS).filter((value) => value.length > 4)) expect(everything).not.toContain(secret);
    expect(everything).not.toMatch(/Invalid PIN/);
  });
});
