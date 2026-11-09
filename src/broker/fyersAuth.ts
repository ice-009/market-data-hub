import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { brokerConfigured, secretValues, type FyersConfig, type Secrets } from "../config.js";
import { redact, type Logger } from "../log.js";
import { DAY_MS, IST_OFFSET_MS } from "../time.js";
import { BrokerError } from "./errors.js";
import { totp } from "./totp.js";

// Unattended Fyers login via TOTP, and the access-token cache.
//
// Fyers no longer renews tokens with a refresh token, so the hub replays the
// login server-side (ported from Tradex, where it was verified against a live
// account):
//   vagator send_login_otp → verify_otp (TOTP) → verify_pin → /token (auth_code)
//   → validate-authcode (access token)
// fy_id and pin go as plain text; the login service is on api-t2 while data and
// auth are on api-t1; /token answers 308 with the auth_code inside JSON `Url`.
//
// The token is cached in the data directory (fyers-token.json, mode 600) and is
// good until the next 06:00 IST. A failed login is not retried for
// LOGIN_RETRY_MS — repeated wrong-PIN attempts can lock a Fyers account — and
// the failure time is saved, so a restart loop can't retry faster either.

export const LOGIN_RETRY_MS = 15 * 60_000;
const TOKEN_FILE = "fyers-token.json";

interface TokenFile {
  accessToken?: string;
  fetchedAt?: number;
  lastAttemptAt?: number;
  lastError?: string | null;
}

export interface AuthStatus {
  configured: boolean;
  /** A token is held that the broker hasn't rejected and that hasn't expired. */
  connected: boolean;
  lastLoginAt: number | null;
  lastLoginError: string | null;
  /** When a failed login may be tried again. */
  retryAfter: number | null;
}

export const appIdHash = (clientId: string, secretKey: string) => createHash("sha256").update(`${clientId}:${secretKey}`).digest("hex");

/** Fyers tokens expire around 06:00 IST: the first 06:00 IST after `fetchedAt`. */
export function tokenExpiry(fetchedAt: number): number {
  const ist = new Date(fetchedAt + IST_OFFSET_MS);
  let expiry = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), 6, 0, 0) - IST_OFFSET_MS;
  if (expiry <= fetchedAt) expiry += DAY_MS;
  return expiry;
}

export interface FyersAuthOptions {
  secrets: Secrets;
  fyers: FyersConfig;
  dataDir: string;
  log: Logger;
  fetch?: typeof fetch;
  clock?: () => number;
}

export class FyersAuth {
  private file: TokenFile;
  /** Freshly issued tokens rejected in a row. */
  private freshRejects = 0;
  private inFlight: Promise<string> | null = null;
  private readonly fetch: typeof fetch;
  private readonly clock: () => number;
  private readonly filePath: string;

  constructor(private readonly options: FyersAuthOptions) {
    this.fetch = options.fetch ?? fetch;
    this.clock = options.clock ?? Date.now;
    this.filePath = path.join(options.dataDir, TOKEN_FILE);
    this.file = this.read();
    if (this.file.accessToken) options.log.addSecret(this.file.accessToken);
  }

  get configured() {
    return brokerConfigured(this.options.secrets);
  }

  status(): AuthStatus {
    const now = this.clock();
    const failedRecently = Boolean(this.file.lastError && this.file.lastAttemptAt && now - this.file.lastAttemptAt < LOGIN_RETRY_MS);
    return {
      configured: this.configured,
      connected: this.fresh(now),
      lastLoginAt: this.file.fetchedAt ?? null,
      lastLoginError: this.file.lastError ?? null,
      retryAfter: failedRecently ? this.file.lastAttemptAt! + LOGIN_RETRY_MS : null,
    };
  }

  /** A valid access token, logging in when needed. Concurrent callers share one login. */
  async token(): Promise<string> {
    if (!this.configured) throw new BrokerError("No broker credentials are configured.", "not_configured");
    const now = this.clock();
    if (this.fresh(now)) return this.file.accessToken!;
    if (this.inFlight) return this.inFlight;
    const status = this.status();
    if (status.retryAfter) throw new BrokerError(`Broker login failed recently (${status.lastLoginError}); next attempt after ${new Date(status.retryAfter).toISOString()}.`, "auth");
    this.inFlight = this.login().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** The broker rejected the token (401): drop it so the next call logs in again. */
  invalidate() {
    if (!this.file.accessToken) return;
    const now = this.clock();
    // One rejection may be an expired token: log in again. A second freshly issued
    // token rejected too means logging in again won't help: back off.
    const justIssued = this.file.fetchedAt !== undefined && now - this.file.fetchedAt < 5 * 60_000;
    this.freshRejects = justIssued ? this.freshRejects + 1 : 0;
    const giveUp = this.freshRejects >= 2;
    this.file = { ...this.file, accessToken: undefined, ...(giveUp ? { lastAttemptAt: now, lastError: "the broker rejected freshly issued tokens twice" } : {}) };
    this.write();
    this.options.log.warn("broker token rejected; will log in again");
  }

  private fresh(now: number) {
    return Boolean(this.file.accessToken && this.file.fetchedAt && now < tokenExpiry(this.file.fetchedAt));
  }

  private async login(): Promise<string> {
    const attemptAt = this.clock();
    try {
      const accessToken = await this.loginSteps();
      this.options.log.addSecret(accessToken);
      this.file = { accessToken, fetchedAt: this.clock(), lastAttemptAt: attemptAt, lastError: null };
      this.write();
      this.options.log.info("broker login ok");
      return accessToken;
    } catch (error) {
      const message = redact(error instanceof Error ? error.message : "login failed", secretValues(this.options.secrets));
      this.file = { ...this.file, accessToken: undefined, lastAttemptAt: attemptAt, lastError: message };
      this.write();
      this.options.log.warn("broker login failed", { error: message, retryInMin: LOGIN_RETRY_MS / 60_000 });
      throw new BrokerError(`Broker login failed: ${message}`, "auth");
    }
  }

  private async loginSteps(): Promise<string> {
    const { secrets, fyers } = this.options;
    const origin = new URL(fyers.apiUrl).origin;
    const vagator = `${origin.replace("api-t1", "api-t2")}/vagator/v2`;
    const [appId, appType] = secrets.fyersClientId.split("-");

    const otp = await this.post(`${vagator}/send_login_otp`, { fy_id: secrets.fyersLoginId, app_id: "2" });
    const requestKey = otp.json.request_key;
    if (typeof requestKey !== "string") throw new Error(`send_login_otp failed (HTTP ${otp.status})`);

    // Retry across the 30-second boundary in case the clocks disagree a little.
    let verifiedKey: string | undefined;
    for (const skew of [0, -1, 1]) {
      const verified = await this.post(`${vagator}/verify_otp`, { request_key: requestKey, otp: totp(secrets.fyersTotpSecret, this.clock(), skew) });
      if (typeof verified.json.request_key === "string") {
        verifiedKey = verified.json.request_key;
        break;
      }
    }
    if (!verifiedKey) throw new Error("TOTP verification failed (check FYERS_TOTP_SECRET and the clock)");

    const pin = await this.post(`${vagator}/verify_pin`, { request_key: verifiedKey, identity_type: "pin", identifier: secrets.fyersPin });
    const loginToken = (pin.json.data as { access_token?: unknown } | undefined)?.access_token;
    if (typeof loginToken !== "string") throw new Error(`verify_pin failed (HTTP ${pin.status})`);

    const tokenRes = await this.post(
      `${fyers.apiUrl}/token`,
      { fyers_id: secrets.fyersLoginId, app_id: appId, redirect_uri: fyers.redirectUrl, appType, code_challenge: "", state: "hub", scope: "", nonce: "", response_type: "code", create_cookie: true },
      { Authorization: `Bearer ${loginToken}` },
    );
    const redirectUrl = tokenRes.json.Url ?? tokenRes.json.url;
    let authCode: string | null;
    try {
      authCode = typeof redirectUrl === "string" ? new URL(redirectUrl).searchParams.get("auth_code") : null;
    } catch {
      authCode = null;
    }
    if (!authCode) throw new Error(`no auth_code from /token (HTTP ${tokenRes.status}; check FYERS_REDIRECT_URL)`);

    const final = await this.post(`${fyers.apiUrl}/validate-authcode`, { grant_type: "authorization_code", appIdHash: appIdHash(secrets.fyersClientId, secrets.fyersSecretKey), code: authCode });
    if (typeof final.json.access_token !== "string" || !final.json.access_token) throw new Error(`validate-authcode returned no token (HTTP ${final.status})`);
    return final.json.access_token;
  }

  private async post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: Record<string, unknown> }> {
    let response: Response;
    try {
      response = await this.fetch(url, {
        method: "POST",
        redirect: "manual",
        headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new Error(`couldn't reach ${new URL(url).pathname}`);
    }
    const text = await response.text();
    try {
      const json = JSON.parse(text) as unknown;
      return { status: response.status, json: json && typeof json === "object" ? (json as Record<string, unknown>) : {} };
    } catch {
      return { status: response.status, json: {} };
    }
  }

  private read(): TokenFile {
    try {
      return JSON.parse(readFileSync(this.filePath, "utf8")) as TokenFile;
    } catch {
      return {};
    }
  }

  private write() {
    try {
      mkdirSync(this.options.dataDir, { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(this.file), { mode: 0o600 });
      chmodSync(this.filePath, 0o600);
    } catch (error) {
      this.options.log.warn("couldn't save the broker token cache", { error });
    }
  }
}
