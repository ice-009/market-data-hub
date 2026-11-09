// Shared contract for milestone H2 (live prices). Three parts are built against
// these types and wired together in src/hub.ts:
//
//   feed     (src/live/feed.ts, src/broker/fyersSocket.ts, FyersClient.quotes)
//            one upstream broker socket + polling fallback → emits Tick
//   store    (src/live/store.ts, aggregate.ts, recovery.ts, merge.ts)
//            persists last quotes, 1-minute bars and the subscription set, so a
//            restart resumes where it stopped; repairs gaps from broker history
//   api      (src/http/routes/live.ts)
//            GET /v1/quotes and GET /v1/stream (SSE: snapshot → replay → live)
//
// Conventions: symbols are hub tickers (SBIN, NIFTY — see src/broker/symbols.ts);
// times are epoch ms; minute bars start on the minute (IST and UTC agree on
// minute boundaries); `volume` on a tick is the cumulative volume for the day.

/** One price update for one symbol. */
export interface Tick {
  symbol: string;
  /** Last traded price. */
  ltp: number;
  /** Change and % change from the previous close. */
  ch: number;
  chp: number;
  open: number;
  high: number;
  low: number;
  prevClose: number;
  /** Cumulative volume traded today. */
  volume: number;
  /** Exchange time of the last trade (ms). */
  ltt: number;
  /** When the hub received it (ms). */
  ts: number;
  /** "socket": pushed by the broker; "poll": from a REST quote (fallback); "store": replayed from the database. */
  source: "socket" | "poll" | "store";
}

/** The latest known quote for a symbol (a Tick plus how old it is). */
export type Quote = Tick;

/** A 1-minute bar built from ticks or downloaded from the broker. */
export interface MinuteBar {
  symbol: string;
  /** Minute start (ms). */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** Volume traded within the minute. */
  v: number;
  /** "live": built from ticks (may miss trades); "broker": downloaded history (authoritative). */
  source: "live" | "broker";
}

export type FeedMode = "socket" | "polling" | "mixed" | "idle" | "down";

export interface FeedStatus {
  mode: FeedMode;
  /** Socket connection state. */
  socket: "connected" | "connecting" | "disconnected" | "disabled";
  /** Symbols currently served by the socket / by polling. */
  socketSymbols: number;
  polledSymbols: number;
  /** Socket symbol capacity for the plan (100 on Fyers Standard). */
  capacity: number;
  lastTickAt: number | null;
  reconnects: number;
}

/** The live feed (implemented by src/live/feed.ts). */
export interface LiveFeed {
  /** Start receiving ticks for these symbols. Reference-counted per `owner` (a client id or "persistent"). */
  subscribe(owner: string, symbols: string[]): void;
  /** Drop `owner`'s interest; symbols nobody wants any more are unsubscribed upstream. */
  unsubscribe(owner: string, symbols?: string[]): void;
  /** All symbols currently wanted by anyone. */
  symbols(): string[];
  /** Register a tick listener; returns an unsubscribe function. */
  onTick(listener: (tick: Tick) => void): () => void;
  /** Called after the upstream socket (re)connects — the store uses it to repair gaps. */
  onReconnect(listener: (downtime: { from: number; to: number }) => void): () => void;
  status(): FeedStatus;
  start(): void;
  stop(): Promise<void>;
}

/** Batched REST quotes (implemented by FyersClient.quotes in src/broker/fyers.ts). */
export interface QuoteFetcher {
  /** Up to the plan's batch size per call; callers batch larger lists. Throws BrokerError. */
  quotes(symbols: string[], priority: "user" | "refresh" | "background"): Promise<Tick[]>;
}

/** Minute history from the broker for gap repair (implemented with FyersClient.history, resolution "1"). */
export type MinuteHistoryFetcher = (symbol: string, fromMs: number, toMs: number) => Promise<MinuteBar[]>;

/** Live persistence (implemented by src/live/store.ts). */
export interface LiveStore {
  /** Record ticks: updates last quotes and folds into 1-minute bars (writes are batched). */
  record(ticks: Tick[]): void;
  /** Last stored quote per symbol (survives restarts). */
  lastQuotes(symbols: string[]): Map<string, Quote>;
  /** 1-minute bars for a symbol in [from, to), broker bars winning over live ones. */
  minuteBars(symbol: string, from: number, to: number): MinuteBar[];
  /** Symbols to keep subscribed across restarts, with their owners. */
  persistentSymbols(): string[];
  setPersistentSymbols(symbols: string[]): void;
  /** Write anything buffered (shutdown). */
  flush(): void;
}
