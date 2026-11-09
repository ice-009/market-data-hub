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

> **Status: early.** Milestone **H0** is done: the server, API keys, status endpoint, Docker setup
> and tunnel guide. Market-data endpoints arrive in **H1** (history and reference data) and **H2**
> (live quotes and streaming). See the [roadmap](#roadmap). Endpoints below are marked ✅ (works
> today) or 🚧 (planned).

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
 Fyers API  ───▶ │  broker layer   · one login (TOTP, unattended)            🚧 H1  │
                 │                 · request budget: per-second/minute/day caps,    │
                 │                   priorities, rate-limit strike protection       │
                 │                 · one live socket, shared by every client 🚧 H2  │
                 │                                                                  │
 NSE archives ─▶ │  daily jobs     · cash bhavcopy (prices, delivery %)      🚧 H1  │
                 │                 · F&O bhavcopy (open interest, membership)       │
                 │                 · lot sizes, ban list, results calendar          │
                 │                                                                  │
                 │  store          · one SQLite file (WAL), in ./data         ✅    │
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
cp .env.example .env        # broker credentials are optional until H1
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
| 503 | `broker_unavailable` 🚧 | The broker is needed but not connected; stored data is returned where possible |

### Endpoints

| Endpoint | Scope | Status | Description |
|---|---|---|---|
| `GET /healthz` | — | ✅ | Plain-text `ok` if the process is up. No key needed; says nothing else. |
| `GET /v1/status` | any | ✅ | Version, uptime, the calling key's name and scopes, whether a broker is configured, database size. Freshness, broker connection and budget use are added in H1. |
| `GET /v1/candles?symbol=SBIN&tf=1d&from=…&to=…` | history | 🚧 H1 | OHLCV bars. `tf`: `1d`, `1w`, `1h`, `15m`, `5m`. Daily bars include delivery %. Served from the store; missing ranges are fetched from the broker. |
| `GET /v1/universe/{fno\|nifty50\|nifty100\|nifty200\|nifty500}` | history | 🚧 H1 | Symbols with names and sectors. |
| `GET /v1/fo/oi?symbol=SBIN&from=…&to=…` | fo | 🚧 H1 | Near/next-month futures, combined open interest and its change, buildup class. |
| `GET /v1/fo/members?date=…` | fo | 🚧 H1 | The F&O list on a past date (for backtests without survivorship bias). |
| `GET /v1/fo/ban` | history | 🚧 H1 | Today's F&O ban list. |
| `GET /v1/lots` | history | 🚧 H1 | Futures lot sizes. |
| `GET /v1/results-calendar` | history | 🚧 H1 | Upcoming and recent results dates. |
| `GET /v1/market/regime` | history | 🚧 H1 | NIFTY vs its 50- and 200-day averages, breadth. |
| `GET /v1/quotes?symbols=SBIN,TCS` | live | 🚧 H2 | Last price, change, OHLC, volume. Cached briefly so many clients cost one broker call. |
| `GET /v1/stream?symbols=SBIN,TCS` | live | 🚧 H2 | Server-Sent Events: `status` and `tick` events from one shared broker socket. |

Conventions (all endpoints): times are epoch milliseconds; a daily bar's time is the trading date at
00:00 UTC; symbols are plain NSE tickers (`SBIN`, `NIFTY`, `BANKNIFTY`).

---

## Configuration

All settings come from environment variables (a `.env` file in development; the container
environment in Docker). Copy [.env.example](.env.example) to start.

| Variable | Default | Description |
|---|---|---|
| `HUB_HOST` | `127.0.0.1` | Address to listen on. Keep loopback; use the tunnel for remote access. |
| `HUB_PORT` | `8787` | Port. |
| `HUB_DATA_DIR` | `./data` | Folder for the SQLite database (and, from H1, the broker token cache). |
| `HUB_LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. |
| `HUB_KEY_RATE_PER_MINUTE` | `600` | Requests per minute allowed per API key. |
| `FYERS_CLIENT_ID` | — | Fyers app ID, e.g. `ABCD1234EF-100` (used from H1). |
| `FYERS_SECRET_KEY` | — | Fyers app secret. |
| `FYERS_FY_ID` | — | Your Fyers login ID. |
| `FYERS_PIN` | — | Your 4-digit PIN. |
| `FYERS_TOTP_SECRET` | — | The base32 TOTP seed from enabling external 2FA (not a 6-digit code). |
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
| The broker account | (H1) One shared request budget for all clients, with strike protection, so no app can push the account into a block. |
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
- **On a Mac:** the hub serves data only while the Mac is awake. During market hours, prevent sleep
  (System Settings → Energy) or move the same Docker setup to an always-on machine later.
- **Free always-on option:** an Oracle Cloud Always Free ARM VM in an Indian region runs the same
  compose file. A step-by-step guide is planned for H4.

---

## Project layout

```
market-data-hub/
├─ src/
│  ├─ server.ts          # entry point: config → database → HTTP server, graceful shutdown
│  ├─ cli.ts             # admin CLI (API keys; data jobs from H1)
│  ├─ config.ts          # environment parsing; broker secrets kept apart for the scrubber
│  ├─ log.ts             # JSON logger + secret scrubber (the only way the server logs)
│  ├─ db.ts              # SQLite (WAL) + ordered migrations
│  ├─ auth/
│  │  ├─ keys.ts         # create / verify / list / revoke; SHA-256 hashes; scopes
│  │  └─ rateLimit.ts    # per-key token bucket
│  └─ http/
│     └─ app.ts          # Hono app: /healthz, auth middleware, requireScope, /v1/status, errors
├─ test/                 # Vitest tests (fake credentials only)
├─ docs/
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
| **H1** | History and reference data: broker login and request budget, candle store, NSE cash and F&O bhavcopy, universes, lots, ban list, results calendar, regime | 🚧 in progress |
| **H2** | Live: quotes cache, one shared broker socket, Server-Sent Events stream | 🚧 |
| **H3** | TypeScript client package; a `hub` data source in Tradex | 🚧 |
| **H4** | Backups, freshness monitoring, Oracle Cloud guide, importing Tradex's stored data | 🚧 |

Design details: [docs/plan.md](docs/plan.md).

---

## License and disclaimer

[MIT](LICENSE). This project is not affiliated with, endorsed by or connected to NSE, Fyers or
TradingView. It does not provide investment advice; market data can be delayed, incomplete or wrong
— verify before you trade.
