import type { Logger } from "../log.js";
import { sleep as realSleep } from "../time.js";

// The one way the hub talks to NSE's public sites (archives, the website's JSON
// API). NSE has no API agreement for this, so the hub behaves like one careful
// browser:
//   - at most one request every MIN_GAP_MS across all jobs (they share this client);
//   - browser-like headers, as Tradex uses;
//   - a 403/429/5xx, timeout or network error is retried after 5 s and 20 s
//     (60 s after a 429), and a 403/429 also pauses every NSE request for a
//     minute — NSE answers 403 when it thinks it's being scraped;
//   - a 404 is an answer (no file for that day), not an error.
// Callers stop a run after a few failures in a row instead of hammering NSE.

export const MIN_GAP_MS = 1_100;
const RETRY_WAITS_MS = [5_000, 20_000];
const RATE_LIMIT_WAIT_MS = 60_000;
const BLOCKED_PAUSE_MS = 60_000;
const TIMEOUT_MS = 30_000;

export const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
  "Accept-Language": "en-IN,en;q=0.9",
  Referer: "https://www.nseindia.com/",
};

export class NseError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "NseError";
  }
}

export interface NseResponse {
  status: number;
  body: Buffer;
  setCookies: string[];
}

export interface NseClientOptions {
  log: Logger;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  clock?: () => number;
  minGapMs?: number;
}

export class NseClient {
  private next = 0;
  private pausedUntil = 0;
  private chain: Promise<void> = Promise.resolve();
  /** Requests sent (for status and tests). */
  sent = 0;
  private readonly fetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly clock: () => number;
  private readonly minGapMs: number;

  constructor(private readonly options: NseClientOptions) {
    this.fetch = options.fetch ?? fetch;
    this.sleep = options.sleep ?? realSleep;
    this.clock = options.clock ?? Date.now;
    this.minGapMs = options.minGapMs ?? MIN_GAP_MS;
  }

  /** GET with retries. Resolves with any 2xx or 404; throws NseError otherwise. */
  async get(url: string, headers: Record<string, string> = {}): Promise<NseResponse> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.once(url, headers);
      } catch (error) {
        const failure = error instanceof NseError ? error : new NseError((error as Error).message, null, true);
        if (!failure.retryable || attempt >= RETRY_WAITS_MS.length) throw failure;
        this.options.log.debug("NSE request failed; retrying", { url, status: failure.status, attempt: attempt + 1 });
        await this.sleep(failure.status === 429 ? RATE_LIMIT_WAIT_MS : RETRY_WAITS_MS[attempt]);
      }
    }
  }

  /** Wait for our turn: ≥ minGapMs since the previous request, and past any pause. */
  private turn(): Promise<void> {
    const turn = this.chain.then(async () => {
      const wait = Math.max(this.next, this.pausedUntil) - this.clock();
      if (wait > 0) await this.sleep(wait);
      this.next = this.clock() + this.minGapMs;
    });
    this.chain = turn.catch(() => undefined);
    return turn;
  }

  private async once(url: string, headers: Record<string, string>): Promise<NseResponse> {
    await this.turn();
    this.sent += 1;
    let response: Response;
    try {
      response = await this.fetch(url, { headers: { ...BROWSER_HEADERS, Accept: "*/*", ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (error) {
      throw new NseError((error as Error).name === "TimeoutError" ? "NSE timed out" : "NSE unreachable", null, true);
    }
    if (response.status === 403 || response.status === 429) {
      this.pausedUntil = this.clock() + BLOCKED_PAUSE_MS;
      this.options.log.warn("NSE refused a request; pausing NSE requests", { status: response.status, pauseSec: BLOCKED_PAUSE_MS / 1000 });
    }
    if (response.status !== 404 && !response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new NseError(`NSE answered ${response.status}`, response.status, response.status === 403 || response.status === 429 || response.status >= 500);
    }
    const body = Buffer.from(await response.arrayBuffer());
    return { status: response.status, body, setCookies: response.headers.getSetCookie?.() ?? [] };
  }
}
