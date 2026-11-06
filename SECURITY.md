# Security

## What the hub protects

- **Broker credentials** (app ID and secret, login ID, PIN, TOTP seed) and the broker access token.
  They exist only in the hub's environment (`.env` / container env) and its data volume. No
  endpoint returns them, and every log line is scrubbed of them (plus bearer tokens and API keys).
- **API keys**: shown once at creation; only SHA-256 hashes are stored. Each key has scopes and a
  per-minute limit, and can be revoked (`npm run hub -- keys revoke <id>`).
- **Network**: the server binds `127.0.0.1`. Remote access goes through a Cloudflare Tunnel (no
  open router ports); Cloudflare Access can add a second check in front.
- **The broker account**: a global request budget (from milestone H1) keeps all clients together
  inside the broker's rate limits.

## Operating it safely

- Keep `.env` private (`chmod 600 .env`) and out of git (it's in `.gitignore`).
- Give each project its own key with only the scopes it needs; revoke keys you no longer use.
- Back up `data/` privately — it contains the token cache and key hashes.
- The repository runs a secret scanner in CI, and GitHub push protection is enabled.

## Reporting a vulnerability

Please open a [private security advisory](https://github.com/ice-009/market-data-hub/security/advisories/new)
rather than a public issue.
