# Market Data Hub

[![CI](https://github.com/ice-009/market-data-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/ice-009/market-data-hub/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**A private API for Indian market data — NSE stocks, F&O and indices.** One small service owns the
broker connection and the downloads; every project you build (a trading terminal, a backtester, a
notebook, a bot) asks the hub for data with an API key instead of talking to the broker itself.

```
 Fyers API ─┐                                             ┌─▶ Tradex (terminal)
            ├─▶  Market Data Hub  ──  HTTPS + API key  ───┼─▶ Pine Lab (backtester)
 NSE files ─┘   (your machine)                            └─▶ notebooks, scripts, bots
```

- **One broker login.** Fyers limits API calls per second, minute and day, and blocks an account for
  the day after repeated rate-limit violations. When two apps each log in and keep their own rate
  limiter, they can trip that together. The hub is the only thing that talks to the broker.
- **Download once, use everywhere.** History, NSE's daily files, F&O open interest, lot sizes, the
  ban list and the results calendar are fetched once, stored, and shared.
- **Secrets stay in one place.** Broker credentials never leave the machine that runs the hub.
  Your apps get a URL and an API key — nothing else.
- **Free to run.** On your own computer (or a free cloud VM), reachable over HTTPS through a free
  Cloudflare Tunnel, with no open ports.
- **Code public, data private.** The code is MIT. The data belongs to *your* broker subscription
  and NSE's terms — so this is a private API for your own projects, not a public data service.

> **Status:** milestones **H0** (server, keys, Docker, tunnel), **H1** (history and reference data)
> and **H2** (live quotes, one shared broker socket, a Server-Sent Events stream that survives hub
> restarts) are done. Next: a TypeScript client and the Tradex data source (H3). See the
> [roadmap](#roadmap). Endpoints below are marked ✅ (works today) or 🚧 (planned).

---

## Contents

- [How it works](#how-it-works)
- [Data, licences and what you may do with them](#data-licences-and-what-you-may-do-with-them)
- [Quick start](#quick-start)
- [Run it with Docker](#run-it-with-docker)
- [Reach it from other machines (Cloudflare Tunnel)](#reach-it-from-other-machines-cloudflare-tunnel)
- [Connect a project](#connect-a-project)
- [API keys and scopes](#api-keys-and-scopes)
- [API reference](#api-reference)
- [Live prices and restarts](#live-prices-and-restarts)
- [Configuration](#configuration)
- [Security model](#security-model)
- [Running it day to day](#running-it-day-to-day)
- [Project layout](#project-layout)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [FAQ](#faq)
- [Roadmap](#roadmap)
- [License and disclaimer](#license-and-disclaimer)

---

## How it works

```
                 ┌──────────────────────── Market Data Hub ────────────────────────┐
                 │                                                                  │
 Fyers API  ───▶ │  broker layer   · one login (TOTP, unattended)             ✅    │
                 │                 · request budget: per-second/minute/day caps,    │
                 │                   priorities, rate-limit strike protection       │
                 │                 · one live socket, shared by every client  ✅    │
                 │                   (REST polling as the fallback)                 │
                 │                                                                  │
 NSE archives ─▶ │  daily jobs     · cash bhavcopy (prices, delivery %)       ✅    │
                 │                 · F&O bhavcopy (open interest, membership)       │
                 │                 · lot sizes, ban list, results calendar          │
                 │                                                                  │
                 │  store          · one SQLite file (WAL), in ./data         ✅    │
                 │                 · candles, NSE datasets, last quotes,            │
                 │                   1-minute bars, the live subscription set       │
                 │                                                                  │
                 │  HTTP API       · /v1/* behind API keys with scopes        ✅    │
                 │                 · per-key rate limits                      ✅    │
                 │                 · secrets scrubbed from every log line     ✅    │
                 └───────────────────────────────▲──────────────────────────────────┘
                                                 │ 127.0.0.1:8787
                                    Cloudflare Tunnel (optional, HTTPS)
                                                 │
                              your apps, anywhere, with an API key
```

**Request path.** A client sends `Authorization: Bearer mdh_…`. The hub hashes the key, looks it
up, checks the key's scopes and its per-minute allowance, then serves the request — from its own
store whenever possible. Only data the store doesn't have yet causes a broker call, and those calls
go through one shared budget, so no client can push the broker account over its limits.

**Built with:** Node.js 22, TypeScript, [Hono](https://hono.dev) (HTTP), better-sqlite3 (storage),
Vitest (tests), Docker, Cloudflare Tunnel.

---

## Data, licences and what you may do with them

Please read this before deploying.

- **Broker data is for your own use.** Market data delivered through your Fyers API subscription is
  licensed to your account. The hub exists so *your* projects can share it — not to serve it to
  other people.
- **NSE licenses redistribution of its data.** See NSE's
  [data policy](https://www.nseindia.com/market-data/nse-data-policy). Running a public, open data
  API from NSE data would need a licence from NSE. This project doesn't do that and isn't meant to.
- **NSE archive files** (bhavcopies, ban lists, results calendars) are downloaded politely — at most
  about one request per second, with back-off — and stored for your own analysis.
- **Anyone who runs this code uses their own broker account and their own credentials.** Nothing in
  this repository contains data or keys.
- **Data only.** The hub never places orders. (Since 1 April 2026, Fyers requires a whitelisted
  static IP for API *orders*, not for data-only apps —
  [Fyers notice](https://fyers.in/notice-board/new-sebi-framework-for-retail-algo-trading-from-april-01-2026/).)

---

## Quick start

**You need:** Node.js 22 or newer, and npm. (Docker is optional — see the next section.)

```bash
git clone https://github.com/ice-009/market-data-hub.git
cd market-data-hub
npm install
cp .env.example .env        # without broker credentials: NSE datasets and stored data only
npm run dev                 # starts on http://127.0.0.1:8787 and reloads on changes
```

In a second terminal, create an API key and call the hub:

```bash
npm run hub -- keys create my-laptop --scopes history,live,fo
# Created key_1a2b3c4d5e6f "my-laptop" with scopes history, live, fo.
#
# API key (shown once — store it in the client's .env):
#
#   mdh_Zm9vYmFyLi4u…

curl -H "Authorization: Bearer mdh_Zm9vYmFyLi4u…" http://127.0.0.1:8787/v1/status
```

```json
{
  "service": "market-data-hub",
  "version": "0.1.0",
  "time": 1793944324209,
  "uptimeSec": 2,
  "key": { "name": "my-laptop", "scopes": ["history", "live", "fo"] },
  "broker": { "configured": false, "connected": false },
  "data": { "dbBytes": 4096 }
}
```

The key is shown **once**. The hub stores only its hash, so if you lose it, revoke it and create a
new one.

For production-style runs without Docker:

```bash
npm run build     # compiles to dist/
npm start         # node dist/server.js
```

---

## Run it with Docker

```bash
cp .env.example .env
docker compose up -d                 # builds the image, starts the hub
docker compose logs -f hub           # JSON log lines
docker compose exec hub node dist/cli.js keys create tradex --scopes history,live,fo
```

- The image runs as the unprivileged `node` user, keeps all data in the `./data` folder (mounted at
  `/data`), and has a health check on `/healthz`.
- Compose publishes the port on **`127.0.0.1:8787` only** — not on your network. Inside the
  container the server listens on `0.0.0.0` so the port mapping and the tunnel container can reach it.
- `restart: unless-stopped` brings it back after a reboot (enable "Start Docker Desktop when you
  sign in" on a Mac).

Stop it with `docker compose down`; your data stays in `./data`.

---

## Reach it from other machines (Cloudflare Tunnel)

The hub never opens a port on your router. To use it from another computer or from a deployed app,
run a **Cloudflare Tunnel**: `cloudflared` makes an outbound connection to Cloudflare, and
Cloudflare forwards HTTPS requests for your hostname down that connection.

- **Quick test, no account:** `cloudflared tunnel --url http://127.0.0.1:8787` prints a temporary
  `https://….trycloudflare.com` address.
- **Permanent, your own hostname:** create a tunnel in the Cloudflare Zero Trust dashboard, put its
  token in `.env` as `TUNNEL_TOKEN`, and run `docker compose --profile tunnel up -d`.
- **Extra lock (optional):** put Cloudflare Access in front with a service token, so a request needs
  the Cloudflare credentials *and* a hub key.

Step-by-step instructions: **[docs/tunnel.md](docs/tunnel.md)**.

---

## Connect a project

Every request needs the header `Authorization: Bearer <your key>`. Give each project its own key
with only the scopes it needs, and keep the key in that project's `.env`, never in code.

**curl**

```bash
curl -H "Authorization: Bearer $HUB_KEY" "$HUB_URL/v1/status"
```

**JavaScript / TypeScript (Node 18+, browsers via your own backend)**

```ts
const res = await fetch(`${process.env.HUB_URL}/v1/status`, {
  headers: { Authorization: `Bearer ${process.env.HUB_KEY}` },
});
if (!res.ok) throw new Error((await res.json()).error);
const status = await res.json();
```

**Python**

```python
import os, requests
r = requests.get(f"{os.environ['HUB_URL']}/v1/status",
                 headers={"Authorization": f"Bearer {os.environ['HUB_KEY']}"}, timeout=10)
r.raise_for_status()
print(r.json())
```

> Don't call the hub directly from browser code that other people can load — the key would be
> visible in the page. Call it from your app's server side.

**Planned:** a typed TypeScript client (`packages/client`) with retries and live-stream support,
and a `hub` data source in Tradex so it runs without any broker credentials of its own (🚧 H3).

---

## API keys and scopes

Keys are managed with the CLI on the machine that runs the hub. There is deliberately no remote
admin API.

| Command | What it does |
|---|---|
| `npm run hub -- keys create <name> --scopes history,live,fo` | Create a key; prints it once |
| `npm run hub -- keys list` | Id, name, scopes, created, last used, revoked |
| `npm run hub -- keys revoke <id>` | Revoke immediately |

In Docker, use `docker compose exec hub node dist/cli.js keys …`.

| Scope | Allows |
|---|---|
| `history` | Candles, universes, lot sizes, results calendar, market regime |
| `live` | Quotes and the live stream |
| `fo` | F&O open interest and point-in-time F&O membership |
| `admin` | Everything (implies all scopes) |

`GET /v1/status` works with any valid key.

**How keys are stored:** a key is `mdh_` followed by 32 random bytes (base64url). Only its SHA-256
hash is saved in the database, together with its name, scopes, creation time, last-use time and
revocation time. A copy of the database therefore doesn't contain usable keys.

**Rate limits:** each key may make `HUB_KEY_RATE_PER_MINUTE` requests a minute (default 600), with
bursts up to that number. Over the limit, the hub answers `429` with a `Retry-After` header.

---

## API reference

Base URL: `http://127.0.0.1:8787` locally, or your tunnel hostname. All responses are JSON unless
noted.

### Authentication and errors

```
Authorization: Bearer mdh_…
```

Errors always look like this and never echo your headers or the hub's configuration:

```json
{ "error": "Missing or invalid API key.", "code": "unauthorized" }
```

| Status | `code` | Meaning |
|---|---|---|
| 401 | `unauthorized` | No key, a wrong key, or a revoked key |
| 403 | `forbidden` | The key lacks the scope this endpoint needs |
| 404 | `not_found` | Unknown path |
| 429 | `rate_limited` | Over the key's per-minute limit — see `Retry-After` |
| 500 | `internal` | Unexpected error (details go to the hub's scrubbed log only) |
| 503 | `broker_unavailable` | The broker is needed but not connected; stored data is returned where possible |

### Endpoints

| Endpoint | Scope | Status | Description |
|---|---|---|---|
| `GET /healthz` | — | ✅ | Plain-text `ok` if the process is up. No key needed; says nothing else. |
| `GET /v1/status` | any | ✅ | Version, uptime, the calling key, the broker connection and today's budget, data freshness, recent jobs, and a `live` section (feed mode, persistent symbols, streams, gap repair). |
| `GET /v1/candles?symbol=SBIN&tf=1d&from=…&to=…` | history | ✅ | OHLCV bars. `tf`: `1d`, `1w`, `1h`, `15m`, `5m`. Daily bars include delivery %. Served from the store; missing ranges are fetched from the broker; the newest bar is brought up to the minute from live prices (`liveThrough`). |
| `GET /v1/universe/{fno\|nifty50\|nifty100\|nifty200\|nifty500}` | history | ✅ | Symbols with names and sectors. |
| `GET /v1/fo/oi?symbol=SBIN&from=…&to=…` | fo | ✅ | Near/next-month futures, combined open interest and its change, buildup class. |
| `GET /v1/fo/members?date=…` | fo | ✅ | The F&O list on a past date (for backtests without survivorship bias). |
| `GET /v1/fo/ban` | fo | ✅ | Today's F&O ban list. |
| `GET /v1/lots` | history | ✅ | Futures lot sizes. |
| `GET /v1/results-calendar` | history | ✅ | Upcoming and recent results dates. |
| `GET /v1/market/regime` | history | ✅ | NIFTY vs its 50- and 200-day averages, breadth. |
| `GET /v1/quotes?symbols=SBIN,TCS` | live | ✅ | Last price, change, OHLC, volume, with `ageMs`, `source` and `stale`. From the live feed when fresh, else one batched broker call (cached 3 s), else the last stored quote — never an error because the broker is down. |
| `GET /v1/stream?symbols=SBIN,TCS` | live | ✅ | Server-Sent Events: `status`, a `snapshot` of last quotes, a `bars` replay of 1-minute bars (resumes from `Last-Event-ID`), then `tick` events from one shared broker socket. |
| `POST` / `DELETE /v1/live/pin` | admin | ✅ | Add or remove symbols kept subscribed across restarts (on top of `HUB_LIVE_SYMBOLS`). |

Full request/response details: **[docs/api.md](docs/api.md)**.

Conventions (all endpoints): times are epoch milliseconds; a daily bar's time is the trading date at
00:00 UTC; symbols are plain NSE tickers (`SBIN`, `NIFTY`, `BANKNIFTY`).

---

## Live prices and restarts

One broker socket feeds every client. The symbols in `HUB_LIVE_SYMBOLS` plus any pinned through
`POST /v1/live/pin` (the *persistent set*) are always subscribed, whether or not a client is
connected, and every tick is saved: the last quote per symbol and 1-minute bars, written in batches
about once a second. Streams subscribe their own symbols on top, for as long as they're open.

Symbols beyond the plan's socket capacity (100 on Fyers Standard), and socket symbols while the
socket is down or silent, are polled with batched REST quotes every 15 s through the same request
budget as everything else — polling stops for the day before it could cause a rate-limit strike.
Outside market hours the socket is closed and quotes come from the store.

**When the hub goes down and comes back up, it carries on by itself:**

1. **Subscriptions resume.** The persistent set is in the database; at start it is subscribed
   upstream before any client connects.
2. **Last quotes are served at once.** `/v1/quotes` and the stream's `snapshot` answer from the
   stored last quotes (`source: "store"`, `stale: true`) until fresh ticks arrive.
3. **Missed minutes are repaired.** The store remembers when the previous run last saw a tick. The
   hub plans the session minutes from there to now (today's session, and the previous one if it was
   down across it) and downloads them from the broker's 1-minute history in the background: one
   call per symbol per day, 4 s apart, at background priority, after the restart minute has closed.
   Downloaded minutes replace the tick-built ones. The plan is saved, so a second restart mid-repair
   just continues it, and a repair stopped by the budget is retried later. The same repair runs
   whenever the socket reconnects after a silent spell.
4. **Clients catch up.** A stream client that reconnects (an `EventSource` does it by itself, sending
   `Last-Event-ID`) gets a snapshot, then the 1-minute bars since the last tick it saw — the repaired
   ones included — then live ticks.
5. **Candles stay current.** `/v1/candles` folds the stored minutes into the newest bar of every
   timeframe, so a chart is right to the minute after a restart too.

A crash (power cut, `kill -9`) loses at most the last few seconds of ticks (quotes are written every
second, the forming minute every 5 s); those minutes are repaired from broker history like the rest
of the gap. A clean stop (`Ctrl-C`, `docker compose down`) ends
the streams, closes the socket and writes everything first.

When another hub process holds the broker connection (a CLI backfill run while no server was up),
the server serves stored quotes and bars with the feed reported `down`, and starts the live feed as
soon as it takes the connection over (checked every minute). Without broker credentials, or with
`HUB_LIVE=off`, the same read-only behaviour applies.

---

## Configuration

All settings come from environment variables (a `.env` file in development; the container
environment in Docker). Copy [.env.example](.env.example) to start.

| Variable | Default | Description |
|---|---|---|
| `HUB_HOST` | `127.0.0.1` | Address to listen on. Keep loopback; use the tunnel for remote access. |
| `HUB_PORT` | `8787` | Port. |
| `HUB_DATA_DIR` | `./data` | Folder for the SQLite database, the broker token cache and the broker SDK's logs. |
| `HUB_LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. |
| `HUB_KEY_RATE_PER_MINUTE` | `600` | Requests per minute allowed per API key. |
| `HUB_JOBS` | `on` | Background jobs: NSE files in the evening IST, queued backfills. `off` = none. |
| `HUB_FETCH_WAIT_MS` | `20000` | How long `/v1/candles` waits for missing data from the broker before answering 503 with what is stored. |
| `HUB_LIVE` | `on` | Live prices (socket, polling, gap repair). Only runs with a broker configured; `off` = stored quotes and bars only. |
| `HUB_LIVE_SYMBOLS` | `NIFTY,BANKNIFTY` | Symbols always subscribed (comma-separated, at most 100), on top of those pinned through the API. Empty = none. |
| `HUB_LIVE_RETENTION_DAYS` | `30` | Days of 1-minute live bars kept (last quotes are kept forever, one row per symbol). |
| `FYERS_CLIENT_ID` | — | Fyers app ID, e.g. `ABCD1234EF-100`. |
| `FYERS_SECRET_KEY` | — | Fyers app secret. |
| `FYERS_FY_ID` | — | Your Fyers login ID. |
| `FYERS_PIN` | — | Your 4-digit PIN. |
| `FYERS_TOTP_SECRET` | — | The base32 TOTP seed from enabling external 2FA (not a 6-digit code). |
| `FYERS_PLAN` | `standard` | `standard` or `prime`: sets the request budget, quote batch size and socket capacity. |
| `FYERS_REDIRECT_URL` | `http://localhost:3000/api/broker/callback` | The redirect URL registered for your Fyers app. |
| `TUNNEL_TOKEN` | — | Cloudflare Tunnel token, only for `docker compose --profile tunnel`. |

Invalid values stop the hub at start-up with a message naming the variable.

---

## Security model

**What it protects**

| Asset | Protection |
|---|---|
| Broker credentials and token | Only in the hub's environment and data folder. No endpoint returns them. Every log line passes through a scrubber that removes them, plus bearer tokens and hub keys, even inside third-party error messages. |
| API keys | Shown once; stored as SHA-256 hashes; scoped; rate-limited; revocable; last-use recorded. |
| The machine | Listens on `127.0.0.1` only. Remote access goes through an outbound Cloudflare Tunnel — no open router ports. Docker image runs as a non-root user. |
| The broker account | One shared request budget for all clients — history, quote polling and gap repair alike — with strike protection, so no app can push the account into a block. One live socket for everyone. |
| The repository | `.env` and `data/` are gitignored; CI runs a secret scanner (gitleaks); GitHub secret scanning and push protection are on; `main` only changes through reviewed pull requests with CI green. |

**What it doesn't protect against**

- Someone with access to the machine running the hub (they can read `.env`). Use your OS account
  security and disk encryption.
- A client leaking its own key. Revoke it (`keys revoke`) and issue a new one.
- Publishing your tunnel hostname with a key embedded in a public web page. Keep keys server-side.

**Checklist**

- [ ] `.env` exists only on the hub machine, with `chmod 600 .env`.
- [ ] One key per project, minimum scopes; revoke unused keys (`keys list` shows last use).
- [ ] Hub bound to `127.0.0.1`; remote access only through the tunnel (optionally with Cloudflare Access).
- [ ] Back up `data/` somewhere private.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

---

## Running it day to day

- **Logs** are JSON lines on stdout (`docker compose logs -f hub`). Set `HUB_LOG_LEVEL=debug` when
  investigating. Secrets are scrubbed before anything is written.
- **Data** lives in `HUB_DATA_DIR` (default `./data`): `hub.db` plus SQLite's `-wal`/`-shm` files.
  Back it up with the hub stopped, or with `sqlite3 data/hub.db ".backup backup.db"` while running.
- **Updating:** `git pull && npm install && npm run build` (or `docker compose up -d --build`).
  Database migrations run automatically at start-up.
- **Status at a glance:** `npm run hub -- data status` (or `GET /v1/status`) shows the broker
  connection and today's budget, dataset freshness, and a live line: the persistent symbols, when
  the last tick arrived and whether a gap repair is queued or stopped.
- **Live prices:** the socket opens at 09:15 IST and closes after 15:30 on weekdays. In
  `/v1/status`, `live.feed.mode` is `socket` when all is well, `polling`/`mixed` when the socket is
  down or over capacity, `idle` outside market hours, and `down` when this process isn't running the
  feed. `live.recovery.last` is the latest gap repair (calls, bars, any error).
- **Restarting is safe at any time,** market hours included: see
  [Live prices and restarts](#live-prices-and-restarts). Restarting during the session costs one
  broker call per persistent symbol to repair the gap.
- **Pin what you follow:** `POST /v1/live/pin` with an admin key keeps a symbol recording 1-minute
  bars all session, so charts and replays have every minute even when no client is connected.
- **On a Mac:** the hub serves data only while the Mac is awake. During market hours, prevent sleep
  (System Settings → Energy) or move the same Docker setup to an always-on machine later. If it
  slept, the minutes it missed are repaired from broker history when it wakes up and reconnects.
- **Free always-on option:** an Oracle Cloud Always Free ARM VM in an Indian region runs the same
  compose file. A step-by-step guide is planned for H4.

---

## Project layout

```
market-data-hub/
├─ src/
│  ├─ server.ts          # entry point: config → database → HTTP server, graceful shutdown
│  ├─ cli.ts             # admin CLI (API keys, backfills, data status)
│  ├─ config.ts          # environment parsing; broker secrets kept apart for the scrubber
│  ├─ log.ts             # JSON logger + secret scrubber (the only way the server logs)
│  ├─ db.ts              # SQLite (WAL) + ordered migrations
│  ├─ auth/
│  │  ├─ keys.ts         # create / verify / list / revoke; SHA-256 hashes; scopes
│  │  └─ rateLimit.ts    # per-key token bucket
│  ├─ owner.ts           # owner lock: one process at a time talks to the broker and NSE
│  ├─ hub.ts             # wires the services below for one process
│  ├─ broker/            # Fyers: login, request budget, history + quotes, the data socket
│  ├─ history/           # candle store, fetch planning, resampling
│  ├─ nse/               # NSE daily files: parsers, downloads, store
│  ├─ live/              # live prices: feed, store (quotes, 1-minute bars), gap repair,
│  │                     #   candle merge, stream fan-out, and service.ts wiring them
│  ├─ jobs/              # scheduler and backfill jobs
│  └─ http/
│     ├─ app.ts          # Hono app: /healthz, auth middleware, requireScope, /v1/status, errors
│     └─ routes/         # candles, reference data, live (quotes, stream, pins)
├─ test/                 # Vitest tests (fake credentials only)
├─ docs/
│  ├─ api.md             # API and CLI reference
│  ├─ h2-design.md       # live prices: design, restart recovery, what's unverified
│  ├─ plan.md            # design and milestones
│  └─ tunnel.md          # Cloudflare Tunnel guide
├─ Dockerfile            # multi-stage, non-root, /data volume, health check
├─ compose.yaml          # hub (+ optional tunnel profile), published on loopback only
├─ .env.example          # every setting, documented
└─ .github/workflows/ci.yml
```

---

## Development

```bash
npm install
npm run dev          # watch mode
npm run check        # typecheck + lint + tests
npm run build        # compile to dist/
npm test             # tests only
```

**Conventions**

- Server code never uses `console` (ESLint enforces it) — use the logger from `src/log.ts`, which
  scrubs secrets. Only `src/cli.ts` prints to the terminal.
- Errors returned to clients are `{ error, code }` with a plain message; details go to the log.
- New endpoints declare their scope with `requireScope(...)`.
- Tests use fake credentials and never call the real broker; broker code is tested against a local
  mock server.
- Schema changes are new entries appended to the migration list in `src/db.ts` — never edit an old one.

**Workflow**

`main` is protected. Work on a branch, open a pull request, and merge once the required **`check`**
job is green (typecheck, lint, tests, build, gitleaks). A second CI job builds the Docker image and
smoke-tests it.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `EADDRINUSE` on start | Something else uses port 8787: set `HUB_PORT`, or stop the other process (`lsof -i :8787`). |
| `401 unauthorized` | Check the header is exactly `Authorization: Bearer mdh_…`, and that the key isn't revoked (`keys list`). |
| `403 forbidden` | The key lacks the endpoint's scope. Create a key with that scope. |
| `429 rate_limited` | Wait for `Retry-After` seconds, or raise `HUB_KEY_RATE_PER_MINUTE`. |
| Stream `status` says `down`, quotes are `stale` | This process isn't running the live feed: no broker configured, `HUB_LIVE=off`, or another hub process (a CLI backfill) holds the broker connection — the server takes over within a minute of it exiting. `/v1/status` → `broker.ownsConnection`. |
| `live.recovery.last.error` mentions the budget | Gap repair stopped to protect the account; the work is kept and retried every 5 minutes (and at the next start). |
| `better-sqlite3` fails to install | Use Node 22; on Linux install build tools (`python3 make g++`), or use Docker. |
| `Cannot connect to the Docker daemon` | Start Docker Desktop. |
| Tunnel URL returns 502 | The hub isn't running, or the tunnel points to the wrong address (`http://hub:8787` in compose, `http://127.0.0.1:8787` otherwise). |
| `EPERM … uv_cwd` from npm on macOS | Your terminal lost access to its folder: `cd ~ && cd path/to/market-data-hub`, and allow Terminal under System Settings → Privacy & Security → Files and Folders. |

---

## FAQ

**Is this a free market-data service I can share?** No. It's software for running *your own*
private data API on top of *your* broker subscription. Sharing the data with others would break the
broker's and the exchange's terms.

**Why not call the broker from each app?** Rate limits are per account. Several apps with their own
limiters can exceed them together and get the account blocked for the day. One hub, one budget.

**Does it place orders?** No — data only.

**Which broker?** Fyers API v3 first. The broker layer is separate from the API, so others can be
added.

**Can I run it in the cloud for free?** Yes, on an Oracle Cloud Always Free VM, with the same
Docker setup. Serverless hosts (Vercel, Cloudflare Workers) can't keep the live broker connection open.

**Where does history come from?** The broker for intraday and recent daily data (Fyers keeps about
1 year of intraday and 5 years of daily), and NSE's daily files for end-of-day prices, delivery %,
F&O open interest and membership.

---

## Roadmap

| Milestone | What | Status |
|---|---|---|
| **H0** | Server, API keys with scopes and rate limits, status, scrubbed logging, SQLite, Docker, tunnel guide, CI | ✅ done |
| **H1** | History and reference data: broker login and request budget, candle store, NSE cash and F&O bhavcopy, universes, lots, ban list, results calendar, regime | ✅ done |
| **H2** | Live: quotes cache, one shared broker socket with polling fallback, Server-Sent Events stream, restart-proof storage and gap repair | ✅ done (a few broker details still to confirm on a live account — see [docs/h2-design.md](docs/h2-design.md#not-yet-verified-against-a-live-account)) |
| **H3** | TypeScript client package; a `hub` data source in Tradex | 🚧 |
| **H4** | Backups, freshness monitoring, Oracle Cloud guide, importing Tradex's stored data | 🚧 |

Design details: [docs/plan.md](docs/plan.md).

---

## License and disclaimer

[MIT](LICENSE). This project is not affiliated with, endorsed by or connected to NSE, Fyers or
TradingView. It does not provide investment advice; market data can be delayed, incomplete or wrong
— verify before you trade.
