# Security

## What the hub protects

- **Broker credentials** (app ID and secret, login ID, PIN, TOTP seed) and the broker access token.
  They exist only in the hub's environment (`.env` / container env) and its data volume. No
  endpoint returns them, and every log line is scrubbed of them (plus bearer tokens and API keys).
- **API keys**: shown once at creation; only SHA-256 hashes are stored. Each key has scopes and a
  per-minute limit, and can be revoked (`npm run hub -- keys revoke <id>`).
- **Network**: the server binds `127.0.0.1`. Remote access goes through a Cloudflare Tunnel (no
  open router ports); Cloudflare Access can add a second check in front.
- **The broker account**: a global request budget keeps all clients together inside the broker's
  rate limits (60% of the per-second, 80% of the per-minute and 95% of the daily limit, with
  shares per priority). A 429 is never retried: it pauses every call for a minute and slows the
  rest of the day; after 2 such strikes in an IST day the hub makes no more broker calls until the
  next day (Fyers blocks an account on the 4th). Counts and strikes are saved in the database, so a
  restart doesn't reset them. Only one process — the holder of `data/owner.lock`, normally the
  server — ever calls the broker; a CLI backfill started while the server runs is handed to the
  server instead.
- **Broker login**: unattended TOTP login; the access token is cached in `data/fyers-token.json`
  (mode 600) and is scrubbed from logs. A failed login isn't retried for 15 minutes (repeated
  wrong-PIN attempts can lock an account).
- **NSE**: the hub fetches NSE's public files at most once every 1.1 seconds, backs off on
  403/429, and stops a run after three failed days in a row.

## Operating it safely

- Keep `.env` private (`chmod 600 .env`) and out of git (it's in `.gitignore`).
- Give each project its own key with only the scopes it needs; revoke keys you no longer use.
- Back up `data/` privately — it contains the token cache and key hashes.
- The repository runs a secret scanner in CI, and GitHub push protection is enabled.

## Reporting a vulnerability

Please open a [private security advisory](https://github.com/ice-009/market-data-hub/security/advisories/new)
rather than a public issue.
