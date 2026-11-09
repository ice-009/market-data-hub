# Market Data Hub — plan

One private service that owns the broker connection and serves Indian market data (NSE stocks,
F&O, indices) to all of your projects — Tradex, the Pine Lab, and anything else — over a small
authenticated API. Free to run; secrets never leave it.

Status (2026-11-09): **H0, H1, H2 and H4 done** — server and keys, history and reference data, live
prices (one socket, SSE stream, restart-proof storage and gap repair; design and the few details
still to confirm on a live account in [h2-design.md](h2-design.md)), and operations: backups,
health monitoring, the [Oracle VM guide](oracle.md) and the [Tradex data import](migrate-tradex.md).
In progress: H3 (the Tradex `hub` data source).

---

## 1. Why

- **One broker login.** Today every app logs in to Fyers on its own, each with its own rate
  limiter. Two copies running at once caused rate-limit strikes (a 4th strike in a day blocks the
  account). The hub is the only thing that talks to Fyers; everything else talks to the hub.
- **Fetch once, use everywhere.** History, end-of-day files, F&O open interest, lot sizes, the ban
  list and the results calendar are downloaded once and shared.
- **Secrets in one place.** Client apps get a hub URL and an API key — never the broker's app
  secret, PIN, TOTP seed or access tokens.
- **Free.** Runs on your Mac (or any always-on box) behind a free Cloudflare Tunnel.

## 2. Ground rules

- **Code public (MIT), data private.** Market data from the broker is licensed to your account for
  your own use, and NSE licenses redistribution of its data
  ([NSE data policy](https://www.nseindia.com/market-data/nse-data-policy)). The hub is a
  **private API for your own projects** — never an open, keyless data service. Anyone who
  self-hosts the code brings their own broker account.
- **No open ports.** The hub listens on `127.0.0.1`; the only way in is the Cloudflare Tunnel.
- **Data only.** No order placement. (Fyers' SEBI rules from April 2026 require a whitelisted
  static IP for orders but not for data-only apps —
  [Fyers notice](https://fyers.in/notice-board/new-sebi-framework-for-retail-algo-trading-from-april-01-2026/).)

## 3. Architecture

```
                 ┌──────────────────── Market Data Hub ────────────────────┐
 Fyers API  ───▶ │ the only Fyers login (TOTP) · rate limiter · one socket │
 NSE archives ─▶ │ daily jobs: cash + F&O bhavcopy, OI, lots, ban, results  │
                 │ store: SQLite (WAL) — candles, F&O, reference data       │
                 │ API: REST /v1 + SSE stream · API keys · per-key limits   │
                 └───────────────────────────▲──────────────────────────────┘
                        Cloudflare Tunnel (HTTPS, no open ports)
                         ▲               ▲                 ▲
                      Tradex         Pine Lab        other projects
```

- **Runtime**: Node 22 + TypeScript, a small HTTP framework (Hono or Fastify), `better-sqlite3`,
  no Next.js. One process; background jobs in-process.
- **Packaging**: Docker image + `docker compose` (hub + `cloudflared`). Also runs with plain
  `npm start` for development.
- **Storage**: one SQLite file in a mounted volume, WAL mode, nightly backup copy (`HUB_BACKUP_DIR`).
  Size estimate: 5 years daily × ~250 symbols ≈ 0.3 M rows; 1 year of 15-minute ≈ 1.4 M rows;
  1 year of 5-minute ≈ 4 M rows — a few hundred MB.

### What moves from Tradex (already written and tested there)
- Fyers client, TOTP auto-login, token cache, history chunking, quote batching.
- Request budget (per-second / per-minute / per-day caps, priorities, 429 strike handling).
- HSM live socket via `fyers-api-v3` and the tick relay.
- Candle database (`candleDb`) and history planning (what's stored, what's missing).
- NSE cash bhavcopy (prices, delivery %) and F&O bhavcopy (OI, combined OI, point-in-time
  membership, renames), lot sizes, F&O ban list, results calendar, universes (F&O, NIFTY 50/100/200/500).

## 4. API (v1)

All endpoints need `Authorization: Bearer <key>`. JSON responses; times in epoch ms (IST trade
date at UTC midnight for daily bars, as Tradex does).

| Endpoint | Returns | Notes |
|---|---|---|
| `GET /v1/candles?symbol&tf=1d\|1w\|1h\|15m\|5m&from&to` | OHLCV (+ delivery % on daily) | From the store; missing ranges are fetched from Fyers at background priority |
| `GET /v1/quotes?symbols=…` | last price, change, OHLC, volume | Cached a few seconds: many clients cost one broker call |
| `GET /v1/stream?symbols=…` | SSE: `status`, `snapshot`, `bars` replay, `tick` events | All clients share one upstream socket; falls back to polling; resumes with `Last-Event-ID`, across hub restarts too |
| `POST`/`DELETE /v1/live/pin` | the persistent live set | Kept subscribed (and recorded minute by minute) across restarts |
| `GET /v1/universe/{fno\|nifty50\|…}` | symbols, names, sectors | |
| `GET /v1/fo/oi?symbol&from&to` | near/next futures, combined OI and change, buildup class | From NSE F&O bhavcopy |
| `GET /v1/fo/members?date` | F&O list on that date | Point-in-time, for survivorship-free backtests |
| `GET /v1/fo/ban`, `GET /v1/lots` | today's ban list, lot sizes | |
| `GET /v1/results-calendar` | upcoming / recent results dates | |
| `GET /v1/market/regime` | NIFTY vs 50/200-day, breadth | |
| `GET /v1/status` | data freshness, broker connected, budget used, strikes | No secrets, ever |

Errors are explicit (`{ error, code }`); a request that would need the broker while it's
unavailable gets `503` with what's stored instead of a hang.

## 5. Security

- **Secrets**: broker app ID/secret, login ID, PIN, TOTP seed live only in the hub's environment
  (`.env` with `chmod 600`, or Docker secrets). Access tokens stay in the hub's data volume.
  Nothing in the API, logs or error messages contains them (a log scrubber redacts known secret
  values as defence in depth).
- **API keys**: generated by a CLI (`hub keys create tradex --scopes history,live,fo`), shown once,
  stored as SHA-256 hashes. Scopes per key; per-key rate limits; revoke anytime; last-used time.
- **Network**: bind `127.0.0.1`; Cloudflare Tunnel gives HTTPS without opening router ports.
  Optional Cloudflare Access (free for small teams) adds a login or service-token check in front.
- **Broker safety**: the request budget is global — no client can exhaust the daily quota or push
  the account into rate-limit strikes; bulk history downloads run at background priority and pause
  in market hours.
- **Repo hygiene**: `.env*`, the data volume and backups are gitignored; CI runs a secret scanner.

## 6. Clients

- **`market-data-client`** (TypeScript, in this repo under `packages/client`): typed calls for
  every endpoint, SSE helper with reconnect, retries with backoff.
- **Tradex**: a new `hub` data source in its data engine (next to `fyers`, `eod`, `sample`). With
  `HUB_URL` + `HUB_KEY` set, Tradex stops talking to Fyers and needs no broker credentials. Without
  them, Tradex keeps working standalone (for people who self-host only Tradex).
- **Pine Lab**: uses the client from day one instead of its own data plumbing.
- **Anything else**: plain HTTPS + the API key.

## 7. Hosting

| Stage | Where | Cost | Live streaming |
|---|---|---|---|
| Now | Your Mac + Docker + Cloudflare Tunnel | Free | While the Mac is on |
| Later (optional) | Oracle Cloud Always Free ARM VM, Hyderabad or Mumbai | Free | Always on |
| Not suitable | Vercel / Cloudflare Workers alone | Free | No (can't hold the broker socket) |

Oracle notes: needs a card at signup; Indian regions are often out of ARM capacity; the free ARM
allowance was reportedly cut to 2 OCPU / 12 GB in 2026 — still plenty for this hub. Same Docker
setup on any host.

Open question to test early: whether NSE's archive site accepts requests from the chosen host's IP
(datacenter IPs are sometimes blocked); the Mac has no such problem.

## 8. Milestones

| # | Deliverable | Effort |
|---|---|---|
| **H0** ✅ | Repo skeleton, Docker + compose (hub + cloudflared), config, API-key CLI and auth, `/v1/status`, tunnel guide for the Mac | 1–2 days |
| **H1** ✅ | History + reference data: candle store and fetch planning, Fyers history (background priority), NSE cash + F&O bhavcopy jobs, universes, lots, ban list, results calendar, regime | 3–4 days |
| **H2** ✅ | Live: quotes cache, SSE stream from one Fyers socket with polling fallback, global budget and strike protection, TOTP login and daily refresh; restart-proof storage (last quotes, 1-minute bars, persistent subscriptions) and gap repair from broker 1-minute history | 2–3 days |
| **H3** | `market-data-client` package; Tradex `hub` data source (Fyers optional in Tradex) | 2 days |
| **H4** ✅ | Backups, freshness monitoring (status page + optional alert), Oracle VM guide, migration of existing Tradex `.cache/market.db` into the hub | 1–2 days |

### H4 as built

- **Import** (`hub data import-tradex`): candles keep Tradex's coverage honestly (from
  `covered_from` to the last bar that was final when Tradex synced; forming bars left out), merge
  into existing hub series only where the ranges touch, and skip series whose closes disagree
  (split adjusted on one side). Cached cash bhavcopies are checked against daily closes because
  Tradex never checked the date inside NSE's file — on a real install this caught two holidays NSE
  had answered with the previous day's file. F&O days are copied as they are. Idempotent, one
  transaction per series/day, refuses while a server owns the data directory.
- **Alerts** are pull-based: `/v1/status?strict=1` answers 503 when unhealthy, so any uptime checker
  can alert; the hub sends nothing itself.

Total ≈ 2 weeks. Tests: unit tests for parsers, budget and auth; an end-to-end test with a mock
broker server (Tradex already supports overriding Fyers endpoints for this).

## 9. Decisions made

- Separate repo; code public (MIT), data private.
- Runs first on the Mac behind Cloudflare Tunnel; Docker so it can move to a free VM later.
- Data-only; no order placement.
