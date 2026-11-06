# Market Data Hub

A private API for Indian market data (NSE stocks, F&O, indices). One service owns the broker
connection; all your projects — a trading terminal, a backtester, notebooks — get data from it
with an API key.

- **One broker login.** Only the hub talks to the broker, so several apps can't push the account
  into rate-limit strikes.
- **Secrets stay put.** Broker credentials live only on the machine running the hub. Clients get a
  URL and an API key.
- **Free to run.** Your own computer (or a free cloud VM) behind a free Cloudflare Tunnel.
- **Code public, data private.** The code is MIT. The data is licensed to *your* broker account for
  your own use, and NSE licenses redistribution — so the hub is a private API for your projects,
  never an open data service. Anyone running this code brings their own broker account.

> Status: **early** — milestone H0 (server, API keys, status). Data endpoints arrive in H1–H2.
> See [docs/plan.md](docs/plan.md).

## Quick start (development)

Requires Node.js 22+.

```bash
npm install
cp .env.example .env          # broker keys are optional until H1
npm run dev                   # http://127.0.0.1:8787

# create a key for a client (shown once — put it in that client's .env)
npm run hub -- keys create tradex --scopes history,live,fo

curl -H "Authorization: Bearer mdh_…" http://127.0.0.1:8787/v1/status
```

Key management: `npm run hub -- keys list`, `npm run hub -- keys revoke <id>`.

## Run with Docker

```bash
cp .env.example .env
docker compose up -d                       # hub on http://127.0.0.1:8787 (loopback only)
docker compose exec hub node dist/cli.js keys create tradex --scopes history,live,fo
```

To reach it from other machines or a deployed app, add a Cloudflare Tunnel:
[docs/tunnel.md](docs/tunnel.md).

## API (v1)

Every `/v1` request needs `Authorization: Bearer <key>`. Errors are `{ "error", "code" }`.

| Endpoint | Scope | Status |
|---|---|---|
| `GET /healthz` | none | ✅ liveness only |
| `GET /v1/status` | any | ✅ version, uptime, broker configured, DB size |
| `GET /v1/candles` | history | H1 |
| `GET /v1/universe/*`, `/v1/fo/*`, `/v1/lots`, `/v1/results-calendar`, `/v1/market/regime` | history / fo | H1 |
| `GET /v1/quotes`, `GET /v1/stream` (SSE) | live | H2 |

Scopes: `history`, `live`, `fo`, `admin` (admin implies all).

## Configuration

See [.env.example](.env.example). The server listens on `127.0.0.1` by default; only the Docker
image binds `0.0.0.0` inside its container, and compose publishes it on the host's loopback.

## Development

```bash
npm run check   # typecheck + lint + tests
npm run build   # compile to dist/
```

`main` is protected: changes land through pull requests with CI green (typecheck, lint, tests,
build, secret scan).

## Security

See [SECURITY.md](SECURITY.md). Never commit `.env` or the `data/` folder.

## License

MIT — see [LICENSE](LICENSE). Not affiliated with NSE, Fyers or TradingView.
