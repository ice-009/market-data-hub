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

## As built (integration notes)

Status: done — the three parts merged into `feat/h2-live` and wired in `src/live/service.ts`.

**Wiring.** `createHub` builds one `LiveService` per process: the SQLite store, the Fyers feed (only
with a broker configured and `HUB_LIVE` not `off`), gap repair, and the `LiveDeps` the routes and
`/v1/status` share. Building it has no side effects, because CLI commands build a hub too. Only the
process holding the owner lock calls `start()` (the server at start-up, or when it takes the lock
over from a CLI backfill — the 60 s retry in `src/server.ts`):

1. `HUB_LIVE_SYMBOLS` replace the `config` part of `live_subscriptions` (pins are kept), and the
   whole persistent set is subscribed on the feed — before any client.
2. The store's batched writes start (every 1 s: changed quotes and closed minutes; the forming
   minute every 5 s; a heartbeat every 30 s; retention hourly).
3. The feed starts: socket in market hours, polling fallback, watchdog.
4. `recovery.recoverOnStart(persistent)` plans from what the store found when it opened (the
   previous run's last tick per symbol and its heartbeat) and runs in the background.
5. Feed reconnects → `recovery.recoverGap`; new pins → `recovery.recoverSymbols`; an unfinished
   repair (budget or strike stop) is retried every 5 minutes.

Shutdown (`LiveService.stop`, called first by the server's signal handler): end the streams →
`feed.stop()` → `recovery.stop()` → `store.close()` (final flush) → then the existing shutdown
(scheduler, budget flush, HTTP server, owner lock, database).

**Deviations from the plan above.**
- `LiveStore` gained `pin` / `unpin`; the pin route uses them, so `DELETE /v1/live/pin` of a
  `HUB_LIVE_SYMBOLS` symbol leaves it subscribed and reports it in `kept` (it used to drop it from
  the feed while the store kept it). New pins are passed to recovery through `LiveDeps.onPinned`.
- The store's own timer is off; the service drives `flushDue()` only in the owner, so a CLI process
  or a waiting server never writes quotes or a heartbeat (which would fake "alive" for recovery).
- The feed's `resumeFrom` isn't used: start-up repair has one path, `recoverOnStart`, which also
  handles symbols that went quiet before the hub stopped and work a crashed repair left queued.
- `LiveRecovery.stop()` was added so a repair in progress never writes to a closing database.
- A process that isn't running the feed reports it `down` (`socket: "disabled"` without a broker,
  `"disconnected"` while waiting for the owner lock); `/v1/quotes` there answers from the store with
  `reason: "not_configured"` or `"not_owner"` and makes no broker call.
- Start-up repair covers the persistent set. Symbols only a stream client follows are repaired
  after socket reconnects (those use every followed symbol), not after a restart — pin them to
  have every minute.
- `/v1/candles` responses gained `liveThrough`; the merge is applied to 503 answers too.
- Pins added in one request share a timestamp, so `persistentSymbols` lists them alphabetically
  after older entries.

**Tests.** `test/live-feed.test.ts`, `test/live-store.test.ts`, `test/live-api.test.ts` per part;
`test/live-e2e.test.ts` end to end: two hub instances in turn on one data directory against the mock
Fyers HTTP server, a fake socket and virtual time — after a clean stop and after a crash, the
persistent set is resubscribed with no client, stored quotes are served before the feed runs,
recovery downloads the missed minutes at resolution `1` through the request budget, a stream
reconnecting with `Last-Event-ID` gets the snapshot, the repaired gap and then live ticks, and
`/v1/candles` (5m, 15m, 1h, 1d, 1w) includes the repaired and live minutes. Also covered: a
process without a broker (read-only) and a server taking the owner lock over later.

## Not yet verified against a live account

Everything above runs against mocks; these broker behaviours are taken from Tradex or the Fyers docs
and need a session on the real account to confirm (none can be tested without risking the
account's rate limits, so check them deliberately, during market hours, with few symbols):

- **SDK symbol lookups vs the rate limit.** `fyers-api-v3` looks symbols up over HTTPS before it
  subscribes (batches of 500). Whether those lookups count against the Data API per-second/minute
  limits — and so should go through the request budget — is unknown. The feed batches subscription
  changes (200 ms) to keep them rare.
- **Expired-token error text on the socket.** The wrapper treats errors matching
  `valid token | token invalid/expired | unauthorized | -15` as auth failures (reopen with a fresh
  token). The exact text Fyers sends after the morning token change hasn't been seen by the hub.
- **1-minute history.** Gap repair asks `/data/history` for resolution `"1"`, one whole day per
  call. That this resolution is served for today's session while it is still trading (and how soon
  a closed minute appears — recovery waits 5 s after the minute) is assumed, not observed.
- **One unknown symbol in a quote batch.** `FyersClient.quotes` expects per-symbol errors inside an
  `ok` response; if Fyers instead fails the whole batch for one bad symbol, polling and `/v1/quotes`
  lose the other 49 symbols of that batch.
- **Pre-open volume in the 09:15 bar.** Tick-built bars put the volume traded before 09:15 (the
  pre-open auction) into the 09:15 minute, as NSE charts do. Whether the broker's 1-minute 09:15 bar
  does the same is unknown, so a repaired 09:15 bar may differ in volume from a tick-built one.
