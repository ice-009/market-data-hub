import { chmodSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import type { Tick } from "../live/types.js";
import type { Logger } from "../log.js";
import { epochMs } from "./fyers.js";
import type { FyersAuth } from "./fyersAuth.js";
import { fromFyersSymbol, toFyersSymbol } from "./symbols.js";

// The upstream live-data socket: Fyers' HSM socket through the official
// `fyers-api-v3` SDK (ported from Tradex, where it ran against a live account).
//
// The SDK is untyped, obfuscated CommonJS, so it is touched only in this file,
// behind the small `DataSocket` interface the feed (src/live/feed.ts) uses; tests
// give the feed a fake socket instead. What the wrapper adds:
//   - hub tickers in and out (SBIN ↔ NSE:SBIN-EQ, SBIN26NOVFUT ↔ NSE:SBIN26NOVFUT), normalised ticks with
//     source "socket";
//   - the subscription set is kept here and replayed on every connect;
//   - a closed wrapper ignores late events from its SDK socket;
//   - no automatic reconnect inside the SDK: the feed owns reconnects (with
//     backoff and gap repair), so two retry loops can't fight;
//   - the SDK's own log files go to a private directory, never stdout. It is
//     handed the access token, so its directory is created with mode 700.
//
// SDK quirks (verified in Tradex with fyers-api-v3 2.0.0):
//   - `getInstance` caches one socket per process whatever token it's given, so
//     the cache is cleared before each new socket, or a reconnect after the
//     morning token change would reuse the old, expired one;
//   - the constructor throws when the token isn't a Fyers JWT (no `hsm_key`);
//   - `subscribe` looks symbols up over HTTPS (in batches of 500) before
//     sending them, so the feed batches subscription changes;
//   - its HSM parser can throw inside the SDK's own WebSocket handler (seen
//     live: "Cannot read properties of undefined (reading 'prepareData')" in
//     hslib.js right after a reconnect with 42 symbols). Nothing here can catch
//     that, so it reaches the process as an uncaught exception and took the hub
//     down. `guardSdkErrors` turns exactly those into a closed socket — the
//     feed reconnects with backoff and repairs the gap — and leaves every other
//     uncaught exception fatal, as before.

export interface DataSocketEvents {
  /** The socket is open; the current subscriptions have been sent. */
  connect: () => void;
  message: (tick: Tick) => void;
  /** `auth`: the broker rejected the token (the feed restarts the socket). */
  error: (error: { message: string; auth: boolean }) => void;
  close: () => void;
}

/** One upstream data connection. Symbols are hub tickers. */
export interface DataSocket {
  connect(): void;
  /** Add symbols (sent now if connected, else on connect). */
  subscribe(symbols: string[]): void;
  unsubscribe(symbols: string[]): void;
  /** Close for good; no events are delivered afterwards. */
  close(): void;
  on<E extends keyof DataSocketEvents>(event: E, listener: DataSocketEvents[E]): void;
}

/** Opens a new, not yet connected socket (fetches a token first). */
export type DataSocketFactory = () => Promise<DataSocket>;

// Fyers symbol → hub ticker lives with the forward mapping (./symbols.ts); re-exported for the socket's callers.
export { fromFyersSymbol };

interface RawTick {
  symbol?: unknown;
  ltp?: unknown;
  ch?: unknown;
  chp?: unknown;
  vol_traded_today?: unknown;
  open_price?: unknown;
  high_price?: unknown;
  low_price?: unknown;
  prev_close_price?: unknown;
  last_traded_time?: unknown;
  exch_feed_time?: unknown;
}

const finite = (value: unknown, fallback = 0) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

/**
 * An SDK message → a tick, or null for acks and control frames (no symbol or
 * price) and symbols that don't map to a hub ticker. Index ticks carry no volume
 * or trade time: volume 0, `ltt` from the feed time. Pure.
 */
export function toSocketTick(payload: unknown, now: number): Tick | null {
  if (!payload || typeof payload !== "object") return null;
  const raw = payload as RawTick;
  if (typeof raw.symbol !== "string" || typeof raw.ltp !== "number" || !Number.isFinite(raw.ltp)) return null;
  const symbol = fromFyersSymbol(raw.symbol);
  if (!symbol) return null;
  return {
    symbol,
    ltp: raw.ltp,
    ch: finite(raw.ch),
    chp: finite(raw.chp),
    open: finite(raw.open_price),
    high: finite(raw.high_price),
    low: finite(raw.low_price),
    prevClose: finite(raw.prev_close_price),
    volume: finite(raw.vol_traded_today),
    ltt: epochMs(raw.last_traded_time) ?? epochMs(raw.exch_feed_time) ?? now,
    ts: now,
    source: "socket",
  };
}

/** Errors that mean the token was rejected (the socket must be reopened with a fresh one). */
const AUTH_ERROR = /valid token|token (is )?(invalid|expired)|unauthori[sz]ed|(?<!\d)-15(?!\d)/i;

/** An SDK error payload (string, Error or object) → a short message. */
export function describeSocketError(payload: unknown): { message: string; auth: boolean } {
  let text: string;
  if (typeof payload === "string") text = payload;
  else if (payload instanceof Error) text = payload.message;
  else {
    try {
      text = JSON.stringify(payload) ?? String(payload);
    } catch {
      text = String(payload);
    }
  }
  text = text.slice(0, 300);
  return { message: text, auth: AUTH_ERROR.test(text) };
}

// --- the SDK ------------------------------------------------------------------

/** The parts of the SDK socket used here (exported for tests' fakes). */
export interface SdkSocket {
  readonly FullMode: unknown;
  on(event: "connect" | "message" | "error" | "close", listener: (payload: unknown) => void): void;
  subscribe(symbols: string[]): void;
  unsubscribe(symbols: string[]): void;
  mode(mode: unknown): void;
  connect(): void;
  close(): void;
}

export interface SdkDataSocketClass {
  /** (`APPID:token`, log directory, flag) — Tradex passes `false` as the third argument. */
  getInstance(accessToken: string, logPath?: string, flag?: boolean): SdkSocket;
}

let sdkClass: SdkDataSocketClass | null = null;

/** The SDK is CommonJS and loaded lazily, so processes that never stream don't load it. */
function sdk(): SdkDataSocketClass {
  sdkClass ??= (createRequire(import.meta.url)("fyers-api-v3") as { fyersDataSocket: SdkDataSocketClass }).fyersDataSocket;
  return sdkClass;
}

/** Drop the SDK's cached socket (stored on a static property) so getInstance builds a new one. */
function clearSdkCache(cls: SdkDataSocketClass) {
  const statics = cls as unknown as Record<string, unknown>;
  statics.instance = undefined;
  // The property name is obfuscated in some builds: clear any static that holds an instance.
  for (const key of Object.getOwnPropertyNames(cls)) {
    if (key === "prototype" || key === "length" || key === "name") continue;
    const value = statics[key];
    if (value && typeof value === "object" && typeof (value as { subscribe?: unknown }).subscribe === "function") statics[key] = undefined;
  }
}

/** Is this uncaught error from inside the Fyers SDK (not from hub code)? */
export function isSdkError(error: unknown): boolean {
  const stack = error instanceof Error ? (error.stack ?? "") : "";
  const frames = stack.split("\n").slice(1).map((line) => line.trim());
  // The throwing frame (the first) must be inside the SDK package.
  return frames.length > 0 && /[\\/]node_modules[\\/]fyers-api-v3[\\/]/.test(frames[0]);
}

const openSockets = new Set<FyersDataSocket>();
const guarded = new WeakSet<object>();

/**
 * Install (once per process) the handler that keeps a Fyers SDK bug from
 * killing the hub. SDK errors close the open sockets so the feed reconnects;
 * anything else is printed and exits with code 1, like Node's default.
 */
export function guardSdkErrors(log: Logger, target: Pick<NodeJS.Process, "on"> = process) {
  if (guarded.has(target)) return;
  guarded.add(target);
  target.on("uncaughtException", (error: Error) => {
    if (isSdkError(error)) {
      log.error("broker SDK threw inside its socket handler; reconnecting", { error });
      for (const socket of [...openSockets]) socket.failFromSdk();
      return;
    }
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exit(1);
  });
}

class FyersDataSocket implements DataSocket {
  private readonly wanted = new Set<string>();
  private readonly listeners: { [E in keyof DataSocketEvents]: Array<DataSocketEvents[E]> } = { connect: [], message: [], error: [], close: [] };
  private connected = false;
  private closed = false;

  constructor(
    private readonly socket: SdkSocket,
    private readonly log: Logger,
    private readonly clock: () => number,
    /** The access token: removed from error text before it leaves this wrapper. */
    private readonly token: string,
  ) {
    openSockets.add(this);
    socket.on("connect", () => {
      if (this.closed) return;
      this.connected = true;
      this.send("subscribe", [...this.wanted]);
      this.emit("connect");
    });
    socket.on("message", (payload) => {
      if (this.closed) return;
      // Messages are one object per symbol; accept a list too.
      for (const item of Array.isArray(payload) ? payload : [payload]) {
        const tick = toSocketTick(item, this.clock());
        if (tick && this.wanted.has(tick.symbol)) this.emit("message", tick);
      }
    });
    socket.on("error", (payload) => {
      if (this.closed) return;
      const error = describeSocketError(payload);
      this.emit("error", { ...error, message: this.token ? error.message.replaceAll(this.token, "[redacted]") : error.message });
    });
    socket.on("close", () => {
      if (this.closed) return;
      this.connected = false;
      this.emit("close");
    });
  }

  connect() {
    this.socket.connect();
  }

  subscribe(symbols: string[]) {
    const fresh = symbols.filter((symbol) => !this.wanted.has(symbol));
    fresh.forEach((symbol) => this.wanted.add(symbol));
    if (this.connected && fresh.length) this.send("subscribe", fresh);
  }

  unsubscribe(symbols: string[]) {
    const gone = symbols.filter((symbol) => this.wanted.delete(symbol));
    if (this.connected && gone.length) this.send("unsubscribe", gone);
  }

  /** The SDK threw inside this socket's handler: report it closed (the feed reconnects), then drop it. */
  failFromSdk() {
    if (this.closed) return;
    this.connected = false;
    this.emit("close");
    this.close();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.connected = false;
    openSockets.delete(this);
    try {
      this.socket.close();
    } catch {
      // already closed
    }
  }

  on<E extends keyof DataSocketEvents>(event: E, listener: DataSocketEvents[E]) {
    this.listeners[event].push(listener);
  }

  private emit<E extends keyof DataSocketEvents>(event: E, ...args: Parameters<DataSocketEvents[E]>) {
    for (const listener of this.listeners[event]) {
      try {
        (listener as (...a: Parameters<DataSocketEvents[E]>) => void)(...args);
      } catch (error) {
        this.log.error("live socket listener failed", { event, error });
      }
    }
  }

  private send(action: "subscribe" | "unsubscribe", symbols: string[]) {
    if (!symbols.length) return;
    try {
      const fyers = symbols.map(toFyersSymbol);
      if (action === "subscribe") {
        this.socket.subscribe(fyers);
        this.socket.mode(this.socket.FullMode);
      } else {
        this.socket.unsubscribe(fyers);
      }
    } catch (error) {
      // A failed unsubscribe only wastes a little bandwidth; a failed subscribe shows up as silence (the watchdog polls).
      this.log.warn(`live socket ${action} failed`, { symbols: symbols.length, error });
    }
  }
}

export interface FyersSocketOptions {
  auth: FyersAuth;
  /** Fyers app ID (`ABCD1234EF-100`): the SDK wants `APPID:token`. */
  clientId: string;
  /** Where the SDK may write its log files (inside the hub's data directory). */
  logDir: string;
  log: Logger;
  clock?: () => number;
  /** Stand-in for the SDK's `fyersDataSocket` (tests); default: the real SDK, loaded on first use. */
  sdk?: SdkDataSocketClass;
}

/** Factory for real Fyers sockets. Each call fetches a valid token and builds a fresh SDK socket. */
export function createFyersSocketFactory(options: FyersSocketOptions): DataSocketFactory {
  const clock = options.clock ?? Date.now;
  return async () => {
    const token = await options.auth.token();
    mkdirSync(options.logDir, { recursive: true, mode: 0o700 });
    chmodSync(options.logDir, 0o700);
    const cls = options.sdk ?? sdk();
    // Only around the real SDK: tests pass a fake and keep their own process handlers.
    if (!options.sdk) guardSdkErrors(options.log);
    clearSdkCache(cls);
    let socket: SdkSocket;
    try {
      socket = cls.getInstance(`${options.clientId}:${token}`, options.logDir, false);
    } catch (error) {
      // The message may quote the token; the logger scrubs it, but don't pass it on
      // either — and no `cause`, which would carry the original text along.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(`couldn't create the broker data socket: ${describeSocketError(error).message.replaceAll(token, "[redacted]")}`);
    }
    return new FyersDataSocket(socket, options.log, clock, token);
  };
}
