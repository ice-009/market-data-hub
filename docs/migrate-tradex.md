# Moving Tradex onto the hub

Until now Tradex logged in to Fyers itself and kept its own data in `.cache/market.db`. After this,
the hub is the only thing that talks to Fyers; Tradex asks the hub with an API key. The data Tradex
already downloaded comes along, so the move costs no broker calls.

Allow 15 minutes. Do it **outside market hours** (after 16:00 IST or on a weekend): Tradex's live
prices stop for a few minutes while you switch.

Paths below assume both repos sit next to each other (`~/Desktop/tradex`, `~/Desktop/market-data-hub`);
adjust them to yours.

## 0. Before you start

- The hub is installed and builds (`npm install && npm run build` in `market-data-hub`).
- Tradex is up to date with the `hub` data source (it reads `HUB_URL` and `HUB_KEY`).
- Note what's in Tradex now, to compare later: open a chart or two you know (e.g. SBIN daily, NIFTY
  15m) and remember the last few closes.

## 1. Stop Tradex and take its Fyers credentials away

Two processes logging in to one Fyers account each run their own rate limiter, which is how
rate-limit strikes happened. So Tradex must stop using Fyers *before* the hub starts.

1. Stop Tradex (`Ctrl-C` on `npm run dev`, or stop its service).
2. In Tradex's `.env`, **move** (don't copy) the `FYERS_*` lines out — `FYERS_CLIENT_ID`,
   `FYERS_SECRET_KEY`, `FYERS_FY_ID`, `FYERS_PIN`, `FYERS_TOTP_SECRET`, `FYERS_PLAN`,
   `FYERS_REDIRECT_URL`. The hub uses the same names. Keep them somewhere safe for step 2 only;
   don't paste them into chats, issues or commits.

   Logging in from the hub issues a new Fyers access token; a token Tradex still holds may stop
   working anyway, so there is no point keeping Tradex's copy.

## 2. Start the hub with the Fyers credentials

In `market-data-hub`:

```bash
cp .env.example .env && chmod 600 .env
# paste the FYERS_* lines into .env; set HUB_BACKUP_DIR=./backups for nightly backups
```

Don't start the server yet — the import in step 4 needs the data directory to itself.

## 3. Create a key for Tradex

```bash
npm run hub -- keys create tradex --scopes history,live,fo
```

The key (`mdh_…`) is shown once. Keep it for step 5.

## 4. Import Tradex's data (dry run first)

Work on a copy, so nothing can touch Tradex's own files (Tradex is stopped, so the copy is
consistent; copy the `-wal` and `-shm` files too if they exist — the newest data may be in them):

```bash
mkdir -p data/tradex-import
cp ../tradex/.cache/market.db* data/tradex-import/
cp -R ../tradex/.cache/screener data/tradex-import/screener

npm run hub -- data import-tradex --db data/tradex-import/market.db --screener data/tradex-import/screener --dry-run
```

Read the report (example from a real Tradex install, 9 Nov 2026):

```
Candles: 200 Tradex series
  1d   would import 165 series, 199388 bars, coverage 2021-11-02 → 2026-11-07 (exclusive)
  15m  would import 28 series, 171577 bars, coverage 2025-11-08 04:15 UTC → 2026-11-06 09:30 UTC (exclusive)
  5m   would import 7 series, 33094 bars, coverage 2026-08-05 05:45 UTC → 2026-11-05 06:40 UTC (exclusive)
  already stored in the hub: 0 series
  bars left out (still forming when Tradex stored them): 83

Cash bhavcopy (delivery %): 35 cached files
  would import 33 trading days (96272 rows, 2026-09-21 → 2026-11-06) and 0 holidays
  skipped 2 days:
    2 × no session that day in the stored daily candles (a holiday served with another day's file?): 2026-10-02, 2026-10-20
  screener daily files: 237 (not imported — no coverage record; …)
    symbols with no daily series in market.db: 74 (the hub downloads them on first request or with `hub data backfill`)

F&O bhavcopy: 9 checked days in Tradex
  would import 9 trading days (1957 rows, 2026-10-27 → 2026-11-06), 0 holidays, 0 mismatched files
```

What it means:

- **Candles** — each Tradex series (`NSE:SBIN-EQ:D`, `NSE:NIFTY50-INDEX:15`, …) becomes a hub
  series (`SBIN` 1d, `NIFTY` 15m). The hub only claims the range Tradex really had, complete; a bar
  Tradex stored while it was still forming is left out, and the hub fetches the rest itself. Other
  resolutions (Tradex's 60-minute or 1-minute series) are skipped — the hub builds 1h from 15m.
- **Cash bhavcopy** — gives daily candles their delivery % for the days Tradex cached. Each day is
  checked against the candles first; days NSE answered with another day's file (holidays) are
  skipped.
- **F&O** — open interest and point-in-time membership (`/v1/fo/oi`, `/v1/fo/members`) for the
  days Tradex imported. If Tradex only has a few days, the hub fills older days itself when you need
  them (NSE archive, no broker calls).

Then import for real:

```bash
npm run hub -- data import-tradex --db data/tradex-import/market.db --screener data/tradex-import/screener
```

It refuses to run while a hub server is running (`A hub process (pid …) owns …`): stop it and run
again. It's safe to interrupt and run again, and a second run changes nothing (everything shows as
"already stored"). Delete `data/tradex-import/` afterwards.

## 5. Start the hub and point Tradex at it

```bash
npm start            # or: docker compose up -d   (then use `docker compose exec hub node dist/cli.js …`)
npm run hub -- data status
```

`data status` should show the imported candles and the bhavcopy sessions. Its first line is the
health check: right after an import, "never fetched" for lots, the ban list and the results
calendar is expected — the server fetches them within minutes (they are NSE files, no broker calls).

In Tradex's `.env`:

```bash
HUB_URL=http://127.0.0.1:8787     # or your tunnel hostname, e.g. https://data.example.com
HUB_KEY=mdh_…                     # the key from step 3
```

Start Tradex.

## 6. Verify

- `curl -H "Authorization: Bearer $HUB_KEY" "$HUB_URL/v1/candles?symbol=SBIN&tf=1d&from=2026-10-01"`
  returns bars with `dp` (delivery %) on the imported days, and `complete: true`.
- The charts you noted in step 0 show the same closes.
- During the next session, `GET /v1/status` → `live.feed.mode` is `socket` and `healthy` is true.
- `npm run hub -- keys list` shows `tradex` with a recent "last used".
- Tradex's logs mention no Fyers login.

## Rollback

Nothing in Tradex's own folder was changed, so going back is quick:

1. Stop Tradex. Remove `HUB_URL` and `HUB_KEY` from its `.env`, and put the `FYERS_*` lines back.
2. Stop the hub (`Ctrl-C` / `docker compose down`) — two Fyers logins must not run at once.
3. Start Tradex. It uses its own `.cache/market.db` exactly as before.

To undo just the import while keeping the hub: stop the hub and restore the backup you took before
it (`npm run hub -- data backup` before step 4 if the hub already had data you care about; restore
steps in [api.md](api.md#data-backup)), or start over with an empty `data/` directory.
