# H2 — live prices: design and work split

Goal: live prices for every client from **one** broker socket, with a database that makes restarts
seamless — when the hub goes down and comes back, it resubscribes by itself, repairs the minutes it
missed from broker history, and clients that reconnect get the last quotes and a replay of what
they missed before live ticks resume.

Shared types: [`src/live/types.ts`](../src/live/types.ts). Read it first.

## Data flow

```
 Fyers HSM socket ─▶ LiveFeed ─(Tick)─┬─▶ LiveStore.record ─▶ live_quotes, live_bars_1m (SQLite)
 (one connection)     │  ▲            │
 REST quotes (poll) ──┘  │            └─▶ SSE fan-out ─▶ /v1/stream clients
                         │
        subscriptions: refcounted per owner; "persistent" owner restored from the DB at start
        reconnect / start ─▶ recovery: fetch 1-minute broker history for the gap ─▶ live_bars_1m (source=broker)
```

## Behaviour

**Feed** (`src/live/feed.ts`, `src/broker/fyersSocket.ts`, `FyersClient.quotes`)
- One upstream Fyers data socket (official `fyers-api-v3` SDK, as Tradex uses), only in the owner
  process. Subscriptions are reference-counted per owner; the union is subscribed upstream.
- Socket capacity per plan (Standard 100 symbols): symbols beyond it are **polled**.
- Watchdog in market hours: a socket silent for 60 s is restarted and its symbols polled meanwhile;
  a single symbol silent for 3 min is polled too; polling stops when ticks resume.
- Polling: batched `FyersClient.quotes` (≤ plan batch per call) every 15 s at `refresh` priority
  through the existing `BrokerGate` — polling can never break the budget.
- Reconnect with backoff; emits `onReconnect({from, to})` for the silent period.
- Outside market hours: socket closed, no polling (quotes come from the store).

**Store** (`src/live/store.ts`, `aggregate.ts`, `recovery.ts`, `merge.ts`) — owns the new migration(s)
- `live_quotes(symbol pk, …tick fields, updated_at)`: last tick per symbol, upserted in batches.
- `live_bars_1m(symbol, t, o, h, l, c, v, source, pk(symbol, t))`: ticks fold into minute bars;
  minute volume = change in cumulative day volume; the forming minute is flushed every few seconds.
- `live_subscriptions(symbol pk, added_at)`: the persistent set (config `HUB_LIVE_SYMBOLS` + API-pinned),
  resubscribed at start before any client connects.
- Recovery at start and on `onReconnect`: for each subscribed symbol, find missing minutes of today's
  session (and the previous session if the hub was down across it) and fetch 1-minute broker history
  at `background` priority; broker bars replace live bars for the same minute.
- Retention: 1-minute bars kept `HUB_LIVE_RETENTION_DAYS` (default 30); quotes kept forever (one row each).
- Merge: a pure function folds stored minute bars into the forming bar of 5m/15m/1h/1d candles so
  `/v1/candles` is current to the minute.

**API** (`src/http/routes/live.ts`) — scope `live`
- `GET /v1/quotes?symbols=A,B` — fresh live quote (socket/poll, < 5 s old) if present, else one batched
  REST call (cached 3 s), else last stored quote marked stale. Response includes `ageMs` and `source`.
- `GET /v1/stream?symbols=A,B[&since=ms]` — Server-Sent Events:
  1. `status` (feed status),
  2. `snapshot` — last stored quote per symbol (works right after a restart),
  3. `bars` — replay of 1-minute bars since `since` or the `Last-Event-ID` header (today's session by default),
  4. `tick` events, with `id:` = tick time in ms so a reconnecting EventSource resumes via `Last-Event-ID`.
  Heartbeat comment every 15 s; per-connection symbol cap and per-key connection cap; a slow client
  gets coalesced ticks (latest per symbol) rather than unbounded buffering.
- `POST /v1/live/pin` / `DELETE /v1/live/pin` (scope admin) — add/remove persistent symbols.
- `/v1/status` gains a `live` section (feed status, persistent symbols, last recovery).

## Work split (parallel branches, then one integration PR)

| Branch | Owner | Files (only these) |
|---|---|---|
| `h2/feed` | feed agent | `src/broker/fyersSocket.ts`, `src/broker/fyers.ts` (add `quotes`), `src/live/feed.ts`, `test/live-feed.test.ts`, `package.json` (SDK) |
| `h2/store` | store agent | `src/db.ts` (append migration 4 only), `src/live/store.ts`, `aggregate.ts`, `recovery.ts`, `merge.ts`, `test/live-store.test.ts` |
| `h2/api` | api agent | `src/http/routes/live.ts`, `src/live/fanout.ts`, `test/live-api.test.ts`, `docs/api.md` (live section) |
| `feat/h2-live` | integration | `src/hub.ts`, `src/server.ts`, `src/config.ts`, `src/http/app.ts`, `src/status.ts`, candles merge, end-to-end restart test, README/plan updates |

No real broker calls anywhere: tests use fakes and the existing mock servers in `test/support`.
