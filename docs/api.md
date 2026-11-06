# Market Data Hub — API and admin CLI

Every `/v1` request needs `Authorization: Bearer <key>` (create keys with `npm run hub -- keys
create …`). Responses are JSON; errors are `{ "error": "…", "code": "…" }` with a fitting status.

**Times.** Epoch milliseconds. Daily and weekly bars are stamped at **UTC midnight of the IST trade
date** (so `new Date(t).toISOString().slice(0, 10)` is the trade date); intraday bars at the
instant they start. Query dates are `YYYY-MM-DD` (IST) or epoch ms. For intraday data `from` means
the start of that IST day and `to` its end.

**Scopes.** `history`: candles, universes, lots, results calendar, regime. `fo`: everything under
`/v1/fo`. `admin` holds every scope.

| Endpoint | Scope | Source |
|---|---|---|
| `GET /v1/status` | any | the hub |
| `GET /v1/candles?symbol&tf&from&to` | history | store; missing ranges from the broker |
| `GET /v1/universe/{fno\|nifty50\|nifty100\|nifty200\|nifty500}` | history | snapshots; F&O list from the latest NSE F&O bhavcopy |
| `GET /v1/fo/oi?symbol&from&to` | fo | NSE F&O bhavcopy |
| `GET /v1/fo/members?date` | fo | NSE F&O bhavcopy |
| `GET /v1/fo/ban` | fo | NSE `fo_secban.csv` |
| `GET /v1/lots[?symbol]` | history | NSE `fo_mktlots.csv` (fallback: F&O bhavcopy lots) |
| `GET /v1/results-calendar?from&to[&symbol]` | history | NSE event calendar |
| `GET /v1/market/regime[?universe]` | history | stored daily candles + cash bhavcopy |

Common error codes: `bad_request` (400), `unauthorized` (401), `forbidden` (403, scope),
`not_found` / `no_data` / `unknown_symbol` (404), `rate_limited` (429, per key),
`broker_unavailable` / `fetch_pending` / `not_ready` (503).

## GET /v1/candles

`symbol` is a plain NSE ticker (`SBIN`, `BAJAJ-AUTO`, `M%26M` for M&M) or an index (`NIFTY`,
`BANKNIFTY`, `FINNIFTY`, `MIDCPNIFTY`, `NIFTYNXT50`, `NIFTYIT`, `INDIAVIX`). `tf` is `1d`
(default), `1w`, `1h`, `15m` or `5m`. Defaults: `to` = now; `from` = 1 year (1d), 5 years (1w),
90 days (1h), 30 days (15m), 7 days (5m) before `to`.

- Served from the store. Only ranges the store doesn't cover are fetched from the broker, at
  background priority; the request waits up to `HUB_FETCH_WAIT_MS` (default 20 s).
- `1w` is resampled from `1d` (weeks start Monday, stamped with Monday's date); `1h` from `15m`
  (or `5m` when only that is stored), in session hours 09:15, 10:15 … 15:15 IST.
- Daily bars carry `dp`, the delivery % from NSE's bhavcopy (`null` when not stored).
- The broker serves about 5 years of daily and 1 year of intraday history; earlier `from` values
  are clamped. `complete` says every final bar of the (clamped) range is stored.
- Stored daily series move forward from NSE's cash bhavcopy each evening without broker calls.
  When a split or bonus is detected (NSE's `PREV_CLOSE`, or the broker's history changing), the
  symbol's stored series are dropped and downloaded again, adjusted.

```json
GET /v1/candles?symbol=SBIN&tf=1d&from=2026-11-04&to=2026-11-05
200
{
  "symbol": "SBIN", "tf": "1d", "from": 1793750400000, "to": 1793836800000, "complete": true,
  "coverage": { "from": 1792972800000, "to": 1793923200000 },
  "candles": [
    { "t": 1793750400000, "o": 348.9, "h": 351.9, "l": 347.9, "c": 349.9, "v": 1000, "dp": null },
    { "t": 1793836800000, "o": 349, "h": 352, "l": 348, "c": 350, "v": 1000, "dp": 54.1 }
  ]
}
```

(Prices above came from the mock broker used in testing; `dp` from NSE's real 5 Nov 2026 file.)

When the broker is needed but can't help (not configured, login failing, budget spent, rate
limited, another process owns the connection), the answer is **503 with what is stored**, never a
hang:

```json
503  Retry-After: 60
{ "error": "The broker is unavailable (…); showing what is stored.", "code": "broker_unavailable",
  "reason": "budget", "symbol": "SBIN", "tf": "1d", "complete": false, "coverage": {…}, "candles": [ … ] }
```

`reason` is one of `not_configured`, `not_owner`, `auth`, `budget`, `rate_limited`, `upstream`,
`network`. A fetch still running after the wait gives `503 fetch_pending` (`Retry-After: 10`) with
the stored candles; it continues in the background. A symbol the broker doesn't know gives `404
unknown_symbol`.

## GET /v1/universe/:name

```json
GET /v1/universe/fno
{ "name": "fno", "source": "nse_fo_bhavcopy", "asOf": "2026-11-05", "count": 218,
  "members": [ { "symbol": "360ONE", "name": "360 ONE WAM Ltd.", "industry": "Financial Services" }, … ] }
```

Index lists (`nifty50`, `nifty100`, `nifty200`, `nifty500`) are snapshots in `reference/universe/`
(`source: "snapshot"`). The F&O list is every stock with futures in the newest stored F&O
bhavcopy (within 10 days), else the `fno.txt` snapshot.

## GET /v1/fo/oi

Stock futures per trade day from NSE's F&O bhavcopy: near and next month, open interest combined
across all listed months and its change (the sum of each month's own change, so an expiry roll
isn't read as unwinding), and the buildup class (price change of the near month × combined OI
change). Default range: the last 30 days.

```json
GET /v1/fo/oi?symbol=SBIN&from=2026-11-01&to=2026-11-05
{ "symbol": "SBIN", "from": "2026-11-01", "to": "2026-11-05", "days": [ {
    "date": "2026-11-05", "day": 1793836800000, "nseSymbol": "SBIN", "expiries": 3, "lot": 750, "underlying": 1006.56,
    "near": { "expiry": "2026-11-23", "close": 1008.1, "settle": 1008.1, "prevClose": 983.2, "volume": 29243, "oi": 94479750, "chgOi": -1059750 },
    "next": { "expiry": "2026-12-29", "close": 1015, "settle": 1015, "prevClose": 990.05, "volume": 2218, "oi": 13161750, "chgOi": 276750 },
    "oi": 108122250, "chgOi": -705000, "oiChangePct": -0.648, "pricePct": 2.533, "buildup": "short-covering", "basisPct": 0.153 } ] }
```

Volumes are contracts; OI is shares. Tickers NSE renamed (LTIM → LTM, TATAMOTORS → TMPV,
ICICIPRULI → ICICILIFE) are filed under the new name. Buildup is information, not a signal.

## GET /v1/fo/members?date=YYYY-MM-DD

The F&O list on the newest stored trade day on or before `date` (default today) — for
survivorship-free backtests. `404 no_data` when nothing that old is stored.

```json
{ "date": "2026-11-06", "tradeDate": "2026-11-05", "count": 218, "symbols": ["360ONE", "ABB", …] }
```

## GET /v1/fo/ban

```json
{ "tradeDate": "2026-11-06", "symbols": ["KAYNES"], "fetchedAt": 1793946082535, "current": true }
```

`current` is false while the stored list is for an earlier session than the one ahead (NSE
publishes the next session's list in the evening). `503 not_ready` until the first download.

## GET /v1/lots

```json
GET /v1/lots?symbol=SBIN   →  { "symbol": "SBIN", "lot": 750, "source": "nse_mktlots", "fetchedAt": 1793946083654 }
GET /v1/lots               →  { "source": "nse_mktlots", "fetchedAt": …, "count": 224, "lots": { "360ONE": 500, "ABB": 125, … } }
```

## GET /v1/results-calendar

Financial-results dates from NSE's event calendar. Default range: 7 days ago to 60 days ahead.

```json
GET /v1/results-calendar?from=2026-11-06&to=2026-11-07
{ "from": "2026-11-06", "to": "2026-11-07", "fetchedAt": 1793946085857, "events": [
    { "symbol": "AASTHA", "date": "2026-11-07", "day": 1794009600000, "company": "Aastha Spintex Limited", "purpose": "Financial Results" }, … ] }
```

## GET /v1/market/regime

NIFTY against its 50- and 200-day averages (daily candles; fetched if missing) and breadth: the
share of `universe` (default `nifty500`) above its own 50-day average, from stored data only (NSE
cash bhavcopy closes and stored daily candles). `healthy` / `caution` / `risk-off` as in Tradex.

```json
{ "state": "caution", "label": "Caution", "reasons": ["NIFTY above its 200-day average", "NIFTY above its 50-day average", "— of stocks above their 50-day average"],
  "niftyAbove200": true, "niftyAbove50": true, "breadth50": null, "niftyClose": 350.1, "niftySma200": 336.25, "day": "2026-11-06",
  "nifty": { "close": 350.1, "sma50": 346.75, "sma200": 336.25, "bars": 301 },
  "breadth": { "universe": "nifty500", "above50": 0, "counted": 0, "members": 501 } }
```

`counted` is how many members had 50 sessions of stored closes; breadth is `null` until some do.

## GET /v1/status

Version, uptime, the calling key, the broker connection and today's budget, data freshness per
dataset, and recent jobs. Never credentials, tokens or keys.

```json
{ "service": "market-data-hub", "version": "0.1.0", "uptimeSec": 20, "key": { "name": "smoke", "scopes": ["history", "fo"] },
  "broker": { "configured": true, "connected": true, "ownsConnection": true, "lastLoginAt": 1793946107241, "lastLoginError": null, "loginRetryAfter": null,
    "budget": { "plan": "standard", "usedToday": 4, "dayCap": 4750, "usedThisMinute": 4, "minuteCap": 40,
      "byPriority": { "user": 0, "refresh": 0, "background": 4 }, "strikes": 0, "slowed": false, "coolingDown": false, "stoppedForToday": false } },
  "data": { "dbBytes": 487424,
    "cashBhav": { "lastSession": "2026-11-05", "lastSuccessAt": …, "lastAttemptAt": …, "lastError": null },
    "foBhav": { "lastSession": "2026-11-05", … }, "lots": { "count": 224, "source": "nse_mktlots", … },
    "foBan": { "tradeDate": "2026-11-06", … }, "resultsCalendar": { "events": 462, … },
    "candles": [ { "tf": "1d", "series": 2, "candles": 310, "lastSession": "2026-11-06" } ] },
  "jobs": [] }
```

## Background jobs (in the server)

- **NSE files**, in the evening IST: cash bhavcopy (after 17:30) and F&O bhavcopy (after 18:00)
  for any of the last 10 trading days not stored yet — on start that is the catch-up — then lots,
  the ban list (from 18:00 the next session's) and the results calendar once each evening (and on
  start when never fetched or over two days old). Each dataset is retried at most every 30 minutes.
  All NSE requests share one client: at most one per 1.1 s, browser headers, back-off on 403/429.
  The trade date inside each file must match the day asked for; a file for another date is
  recorded as `mismatch` and asked for again in the evening.
- **Queued backfills** from the CLI, one at a time.

`HUB_JOBS=off` disables both.

## Admin CLI

```bash
npm run hub -- data backfill --tf 1d --years 5                  # F&O stocks + NIFTY/BANKNIFTY/FINNIFTY
npm run hub -- data backfill --tf 15m --years 1 --symbols SBIN,INFY
npm run hub -- data status
npm run hub -- data cancel <job id>
```

(In Docker: `docker compose exec hub node dist/cli.js data status`.)

- `--tf` is `1d`, `15m` or `5m`; `--years` defaults to the most the broker serves (5 for daily, 1
  for intraday).
- Only one process calls the broker: whoever holds `data/owner.lock`. If the server is running,
  the CLI **queues** the backfill and the server runs it; otherwise the CLI runs it itself
  (Ctrl-C stops it).
- Background priority, so it never crowds out API requests. **Resumable**: symbols already stored
  are skipped, so re-running continues where it stopped. It **pauses in market hours**
  (09:15–15:30 IST) and when the day's background budget is spent; the server resumes paused jobs
  after the close or the next day.
- `data status` shows the owner process, broker login and today's budget, each NSE dataset's last
  session, candle counts, how much of the F&O universe is stored per timeframe, and recent jobs.

## Schema (SQLite, `data/hub.db`)

| Table | Contents |
|---|---|
| `api_keys` | key hashes, scopes, last use (H0) |
| `series` | per (symbol, tf ∈ 1d/15m/5m): coverage `[covered_from, covered_to)` of final bars, `synced_at`, count, first/last bar |
| `candles` | (symbol, tf, t) → o, h, l, c, v |
| `nse_days` | per (dataset ∈ cash_bhav/fo_bhav, day): `ok` / `holiday` / `mismatch`, rows, checked time |
| `cash_bhav` | (symbol, day) → series, prev close, OHLC, volume, delivery % |
| `fo_futures` | (day, symbol) → near/next month close, settle, prev close, volume, OI, ΔOI; combined OI and ΔOI; lot; underlying |
| `lot_sizes` | symbol → lot |
| `fo_ban` | trade date → symbols |
| `results_events` | (symbol, date) → company, purpose |
| `datasets` | per dataset: last attempt, last success, last error, info |
| `kv` | small hub state (the broker budget: today's counts, strikes, cooldown) |
| `jobs` | backfill jobs: params, state, progress, resume time |

Other files in the data directory: `fyers-token.json` (mode 600, the broker access token) and
`owner.lock` (pid of the process that owns the broker/NSE connection).
