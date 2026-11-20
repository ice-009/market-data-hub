# Market Data Hub — API and admin CLI

Every `/v1` request needs `Authorization: Bearer <key>` (create keys with `npm run hub -- keys
create …`). Responses are JSON; errors are `{ "error": "…", "code": "…" }` with a fitting status.

**Times.** Epoch milliseconds. Daily and weekly bars are stamped at **UTC midnight of the IST trade
date** (so `new Date(t).toISOString().slice(0, 10)` is the trade date); intraday bars at the
instant they start. Query dates are `YYYY-MM-DD` (IST) or epoch ms. For intraday data `from` means
the start of that IST day and `to` its end.

**Scopes.** `history`: candles, universes, lots, results calendar, regime, ticker renames, data quality. `fo`: everything under
`/v1/fo`. `live`: quotes and the price stream. `admin` holds every scope (and alone may pin live
symbols).

| Endpoint | Scope | Source |
|---|---|---|
| `GET /v1/status` | any | the hub |
| `GET /v1/candles?symbol&tf&from&to` | history | store; missing ranges from the broker |
| `GET /v1/candles/batch?symbols&tf&from&to` | history | store; missing series queued for a background download |
| `GET /v1/universe/{fno\|nifty50\|nifty100\|nifty200\|nifty500}` | history | snapshots; F&O list from the latest NSE F&O bhavcopy |
| `GET /v1/fo/oi?symbol&from&to` | fo | NSE F&O bhavcopy |
| `GET /v1/fo/oi/day[?date]` | fo | NSE F&O bhavcopy |
| `GET /v1/fo/members?date` / `?from&to` | fo | NSE F&O bhavcopy |
| `GET /v1/fo/contracts?symbol` | fo | NSE F&O bhavcopy |
| `GET /v1/fo/ban` | fo | NSE `fo_secban.csv` |
| `GET /v1/lots[?symbol]` | history | NSE `fo_mktlots.csv` (fallback: F&O bhavcopy lots) |
| `GET /v1/results-calendar?from&to[&symbol]` | history | board meetings from NSE's daily PR zip |
| `GET /v1/market/regime[?universe]` | history | stored daily candles + cash bhavcopy |
| `GET /v1/indices` | history | NSE index file (`ind_close_all`); synthetic baskets from the cash bhavcopy |
| `GET /v1/quality[?check&severity&subject&from&to&status&limit]` | history | the data-quality checks' findings |
| `GET /v1/symbols/history?symbol[&date]` | history | NSE `symbolchange.csv` + ISINs in the cash bhavcopy |
| `GET /v1/symbols/changes[?symbol][&from&to]` | history | NSE `symbolchange.csv` + ISINs in the cash bhavcopy |
| `GET /v1/quotes?symbols` | live | live feed; broker quotes; last stored quote |
| `GET /v1/stream?symbols[&since]` | live | Server-Sent Events: stored snapshot + minute-bar replay, then live ticks |
| `POST` / `DELETE /v1/live/pin` | admin | the persistent live symbol set |

Common error codes: `bad_request` (400), `unauthorized` (401), `forbidden` (403, scope),
`not_found` / `no_data` / `unknown_symbol` (404), `rate_limited` / `too_many_streams` (429, per key),
`too_many_symbols` (400),
`broker_unavailable` / `fetch_pending` / `not_ready` (503; `not_ready` is 404 on `/v1/fo/oi/day` and
`/v1/fo/contracts`, where it means no F&O bhavcopy is stored yet), `not_configured` (503, no
`Retry-After`: the request needs a broker and none is configured — see below; don't retry).

## End-of-day mode (no broker configured)

Without Fyers credentials the hub starts and serves in **end-of-day mode**. `/v1/status` says so at
the top:

```json
{ "mode": "end_of_day", "modeLabel": "End-of-day only",
  "modeNote": "No broker is configured: daily candles, F&O data, lot sizes, the ban list and results dates come from NSE's end-of-day files and archive. Live quotes, the price stream and intraday candles answer not_configured.",
  "features": { "dailyCandles": true, "indexCandles": false, "intradayCandles": false, "liveQuotes": false, "stream": false, "fo": true },
  "broker": { "configured": false, "connected": false, … }, … }
```

(With a broker: `"mode": "broker"`, `"modeNote": null`, every feature `true`.)

| Endpoint | In end-of-day mode |
|---|---|
| `/v1/candles?tf=1d\|1w`, `/v1/candles/batch` | Stocks, from the stored NSE cash bhavcopies (the evening files plus the archive), adjusted for splits and bonuses with the hub's factors ([Split and bonus adjustment](#split-and-bonus-adjustment)), or as traded with `adjust=none`; delivery % as usual, renamed tickers joined, back to 1994 ([Before the broker's window](#before-the-brokers-window); `sources` say `archive` throughout). The batch endpoint fills each stock in place (nothing is `queued`). Days the archive doesn't hold yet are simply missing (`complete: false`, still `200`). |
| `/v1/candles?tf=1d\|1w` for indices | From NSE's index file (`ind_close_all`, stored from Feb 2012; downloaded with the archive in this mode). Earlier days, or none stored yet: `503 not_configured` with whatever is stored. |
| `/v1/candles` for futures contracts | `503 not_configured` (with whatever is stored): they aren't in NSE's cash file. |
| `/v1/candles?tf=1h\|15m\|5m\|1m` | `503 not_configured`. |
| `/v1/quotes`, `/v1/stream`, `/v1/live/pin` | `503 not_configured`. |
| `/v1/market/regime` | From NIFTY's index-file history; `503 not_configured` until 200 sessions of it are stored. |
| `/v1/fo/*`, `/v1/lots`, `/v1/results-calendar`, `/v1/universe/*` | As always: these are NSE files. |

```json
503
{ "error": "Live prices need a broker: this hub has none configured and serves NSE end-of-day data only.", "code": "not_configured", "mode": "end_of_day" }
```

On start, an end-of-day server queues an NSE history job for the last `HUB_EOD_HISTORY_YEARS`
years (default 2; `0` = none; cash, F&O, PR zip — its corporate actions give the split factors — and index files) unless every day of that window was already
asked for, so daily candles reach back that far within about 45 minutes (one file per 1.1 s, paused
in market hours).
`hub data nse-history --from …` downloads more. `hub data backfill` (a broker download) refuses to
run.

## GET /v1/candles

`symbol` is a plain NSE ticker (`SBIN`, `BAJAJ-AUTO`, `M%26M` for M&M), an index (`NIFTY`,
`BANKNIFTY`, `FINNIFTY`, `MIDCPNIFTY`, `NIFTYNXT50`, `NIFTYIT`, `INDIAVIX`; daily only: `NIFTY500`,
`NIFTYAUTO` and the other indices in [`/v1/indices`](#get-v1indices)), a synthetic basket (`EW-IT`…,
daily only, below) or a futures contract (below). Index and basket answers carry `synthetic`
(`false` for an NSE index, `true` for a basket). `tf` is `1d` (default), `1w`, `1h`, `15m`, `5m` or `1m`. Defaults: `to` = now; `from` =
1 year (1d), 5 years (1w), 90 days (1h), 30 days (15m), 7 days (5m), 5 days (1m) before `to`.

- Served from the store. Only ranges the store doesn't cover are fetched from the broker, at
  background priority; the request waits up to `HUB_FETCH_WAIT_MS` (default 20 s).
- `1w` is resampled from `1d` (weeks start Monday, stamped with Monday's date); `1h` from `15m`
  (or `5m` when only that is stored), in session hours 09:15, 10:15 … 15:15 IST.
- Daily bars carry `dp`, the delivery % from NSE's bhavcopy (`null` when not stored).
- **`adjust`**: `split` (default) — stock prices adjusted for splits, bonuses and the like (the
  broker's adjusted history; in end-of-day mode NSE's files × the hub's
  [factors](#split-and-bonus-adjustment)); `none` — a stock's daily or weekly bars **as traded**,
  straight from NSE's stored cash bhavcopies (the archive back to 1994 where downloaded), in either
  mode, never fetched from the broker (`complete` says whether every session of the range is
  stored). Index and futures prices are never adjusted, so both give the same bars; `adjust=none`
  with an intraday `tf` is `400`. The answer says which it is (`"adjust": "split"`).
- The broker serves about 5 years of daily and 1 year of intraday history. Intraday `from` values
  earlier than that are clamped. **Daily and weekly history reaches back to 1994** — see
  [Before the broker's window](#before-the-brokers-window) below. `complete` says every final bar
  of the range is stored (for a stock before the window: every session is in the archive or a
  holiday).
- `sources` (daily and weekly) says where each stretch of bars came from, oldest first:
  `{ "source": "archive" | "broker" | "index_file" | "basket", "from", "to" }` (`from`/`to` are
  the first and last bar's `t`); archive stretches add `names` (the tickers read, more than one
  across a rename) and, when the archive was lined up with the broker's level, `scale`.
- **Current to the minute.** The newest candle is brought up to date from the hub's 1-minute live
  bars (built from ticks, or downloaded from the broker where a gap was repaired) and later
  buckets — today's daily bar, the hours since the last sync — are built from them; today's daily
  bar takes its open/high/low/close/volume from the latest quote. `liveThrough` is the start of the
  newest minute used (`null` when none). This needs live prices for the symbol (a pinned symbol, or
  one a client is streaming); the 503 answer below gets it too.
- Stored daily series move forward from NSE's cash bhavcopy each evening without broker calls.
  When the evening's session is an ex-date (a [factor](#split-and-bonus-adjustment) that day, an
  adjusted `PREV_CLOSE`, or the broker's history changing), the symbol's stored series are dropped
  and downloaded again, adjusted. (Stocks and indices only:
  futures contracts are neither extended from the cash file nor reset.)
- **`1m`** comes from broker 1-minute history (resolution `1`), stored like the other timeframes,
  plus the hub's own 1-minute live bars after the newest stored minute (`liveThrough`). Only the
  **last 30 days** are served (earlier `from` values are clamped) and kept (older minutes are
  deleted after each download). Fyers accepts up to 100 days of a minute resolution per request
  (the hub asks for ≤ 90), so a cold 30-day series is one broker call; how far back Fyers' 1-minute
  history actually reaches hasn't been checked on a live account. While the session is open a `1m`
  request refreshes the stored tail at most once a minute per symbol (as `5m` and `15m` do); to
  follow a chart live, use `/v1/stream` (bars replay, then ticks) rather than polling candles.

### Before the broker's window

A daily or weekly request whose `from` is before the broker's window (today − 1,822 days: about
five years) is answered in two parts, joined by day (`src/history/longDaily.ts`):

| Days | Stock | Index |
|---|---|---|
| before the hand-over | NSE's stored cash bhavcopies (`hub data nse-history`, back to 3 Nov 1994), adjusted with the hub's [factors](#split-and-bonus-adjustment) (`adjust=split`) or as traded (`adjust=none`), with delivery % | NSE's index file (stored from Feb 2012, [/v1/indices](#get-v1indices)); nothing earlier |
| from the hand-over | as before: the broker's adjusted bars (end-of-day mode: the archive again) | as before |

- **Renamed tickers are joined** ([/v1/symbols](#ticker-renames-v1symbols)): INFY's history includes
  INFOSYSTCH's before June 2011, COFORGE's NIITTECH's — point in time: `INFOSYSTCH` asked for 2005 is
  the 2005 ticker, and a ticker later taken by another company is read only for its own listing's
  days. `adjust=none` joins them too.
- **The hand-over** is the window's first day, or the broker series' first bar when it starts later
  (Fyers' ANGELONE begins 29 Nov 2021 although the window starts on the 24th; the archive covers
  the days between).
- **No jump at the seam.** The broker adjusts its history its own way — splits and bonuses, but also
  dividends, and actions the hub's factors miss — so the adjusted archive is **scaled to the
  broker's level**: the median ratio of the two closes over the first 5 sessions both have from the
  hand-over on. Within 0.5% the hub's factors are kept as they are (the archive then equals
  `adjust=none` × the factors); otherwise the archive stretch in `sources` carries `scale`. On the
  live store (20 Nov 2026, 200 F&O stocks with archive history before the seam): 185 needed no
  scale; 15 did — dividend-sized (HINDUNILVR ×0.984, UPL ×0.959, VEDL ×0.936…) or a corporate
  action inside the window that the broker adjusted for and the factors lack (CONCOR ×0.8, PFC ×0.8,
  KARURVYSYA ×0.833, TMPV ×0.606 for the 2025 demerger). After scaling, the next 20 sessions agree
  within 0.4% and no step across the seam is above 2.8%. `hub data history --check` reports this.
- A ticker the broker doesn't know (delisted, renamed away) is served from the archive alone.
- A hub without the archive's older days answers as before (the window only).

```json
GET /v1/candles?symbol=CONCOR&tf=1d&from=2021-10-01&to=2022-01-31
200
{ "symbol": "CONCOR", "tf": "1d", "adjust": "split", "complete": true,
  "coverage": { "from": 1633046400000, "to": 1643673600000 },
  "sources": [
    { "source": "archive", "from": 1633046400000, "to": 1637625600000, "names": ["CONCOR"], "scale": 0.8 },
    { "source": "broker", "from": 1637712000000, "to": 1643587200000 } ],
  "candles": [ … ] }
```

**Futures contracts.** A stock (or index) future is named as the broker names it without the
exchange: underlying + 2-digit year + month + `FUT` — `SBIN26NOVFUT`, `M%26M26NOVFUT`,
`BAJAJ-AUTO26DECFUT`, `NIFTY26NOVFUT`. Fyers' own form `NSE:SBIN26NOVFUT` is accepted too and
answered as `SBIN26NOVFUT` (for stocks and indices only the plain ticker is accepted). They work
everywhere a symbol does — `/v1/candles` (every `tf`), `/v1/quotes`, `/v1/stream`, pins. Daily bars
have `dp: null` (delivery is a cash-market figure). `/v1/fo/contracts` lists a stock's current
contracts. After expiry the broker may no longer serve a contract (`404 unknown_symbol`); what
was stored stays.
```json
GET /v1/candles?symbol=SBIN&tf=1d&from=2026-11-04&to=2026-11-05
200
{
  "symbol": "SBIN", "tf": "1d", "adjust": "split", "from": 1793750400000, "to": 1793836800000, "complete": true,
  "coverage": { "from": 1792972800000, "to": 1793923200000 }, "liveThrough": null,
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

`reason` is one of `not_owner`, `auth`, `budget`, `rate_limited`, `upstream`, `network`. (Without
a broker the answer is `503 not_configured` instead — see [End-of-day mode](#end-of-day-mode-no-broker-configured).) A fetch still running after the wait gives `503 fetch_pending` (`Retry-After: 10`) with
the stored candles; it continues in the background. A symbol the broker doesn't know gives `404
unknown_symbol`.

## GET /v1/candles/batch

Daily (`tf=1d`, default) or weekly (`tf=1w`) candles for up to **300** symbols in one request — for
screeners. `from`/`to` as for `/v1/candles` (dates or epoch ms); defaults: `to` = today, `from` = 400
days (1d) or 5 years (1w) before it.

- **Never waits for the broker.** Each symbol is answered from the store at once. A symbol whose
  range isn't fully stored (`complete: false`) is queued for a background download at background
  priority and listed in `queued`; ask again later (a few seconds per symbol, paced by the broker
  budget) and it is served from the store. The queue is shared by every request and deduplicated —
  asking again, or from several clients, never fetches a series twice — and lives in memory (a
  restart forgets it; the next request queues again).
- `unknown` lists what the hub won't fetch: strings that aren't valid tickers (as sent), and
  symbols the broker said it doesn't know (remembered for a day). They have no `series` entry. A
  malformed symbol never fails the whole request.
- `series[symbol]` is `{ complete, coverage, candles }` as in `/v1/candles`: daily bars carry `dp`
  (delivery %), and the newest bar is brought up to date from live prices when the hub has them.
- In the evening, between the close and NSE's cash bhavcopy (16:00 → ~18:00 IST), a **stock**
  missing only the day's session is *not* queued: the bhavcopy job adds that bar to every stored
  stock for free, where queueing would cost one broker call per symbol. It shows `complete: false`
  until the file arrives. (Indices and futures aren't in the cash file and are queued as usual;
  with `HUB_JOBS=off` this exception is off.)
- When the broker can't be used (not configured, another process owns it, today's budget spent)
  nothing is queued and the answer — still `200` — adds `warning` and `reason` (as `/v1/quotes`).
- `adjust` as for `/v1/candles`: with `adjust=none` stocks are answered as traded from NSE's
  stored bhavcopies and never queued (a ticker no stored file lists is in `unknown`).
- **Before the broker's window** each series is joined from the archive exactly as in
  [`/v1/candles`](#before-the-brokers-window) (renames joined, scaled to the stored broker bars at
  the seam; only the window's part is ever queued), and carries `sources`. A stock the broker said
  it doesn't know is then answered from the archive alone instead of being listed in `unknown`. One
  archive read (day statuses, renames) is shared by the whole request: 218 F&O stocks over the
  six years the live store held on 20 Nov 2026 took 1.2 s and 27 MB of JSON — ask long ranges in
  smaller groups of symbols.
- `400 too_many_symbols` over 300 symbols; `400 bad_request` for an empty list, a `tf` other than
  `1d`/`1w`, an `adjust` other than `split`/`none`, or bad dates.

```json
GET /v1/candles/batch?symbols=SBIN,INFY,NEWCO,bad$&tf=1d&from=2026-11-04&to=2026-11-05
200
{ "tf": "1d", "adjust": "split", "from": 1793750400000, "to": 1793836800000,
  "series": {
    "SBIN": { "complete": true, "coverage": { "from": 1762128000000, "to": 1793923200000 },
      "candles": [ { "t": 1793750400000, "o": 1001, "h": 1012, "l": 998.5, "c": 1006.6, "v": 11873400, "dp": 52.3 },
                   { "t": 1793836800000, "o": 1006, "h": 1010.5, "l": 983.2, "c": 1008.1, "v": 12873400, "dp": 54.1 } ] },
    "INFY": { "complete": false, "coverage": null, "candles": [] },
    "NEWCO": { "complete": false, "coverage": null, "candles": [] } },
  "queued": ["INFY", "NEWCO"],
  "unknown": ["bad$"] }
```

(Had the broker answered that `NEWCO` doesn't exist, the next request would list it in `unknown`.)

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

## GET /v1/fo/oi/day[?date=YYYY-MM-DD]

Every stock's futures on one trade day — an OI column for a screener in one request. Without
`date`, the newest stored day; with it, exactly that trade day (no fallback to an earlier one:
`404 no_data` when it isn't stored — a holiday, or today before NSE's evening file). `404
not_ready` when no F&O bhavcopy is stored at all. Each row is a `/v1/fo/oi` item plus `symbol`,
sorted by symbol.

```json
GET /v1/fo/oi/day
{ "date": "2026-11-05", "day": 1793836800000, "rows": [
    { "symbol": "360ONE", "date": "2026-11-05", "day": 1793836800000, "nseSymbol": "360ONE", "expiries": 3, "lot": 500, … },
    { "symbol": "SBIN", "date": "2026-11-05", "day": 1793836800000, "nseSymbol": "SBIN", "expiries": 3, "lot": 750, "underlying": 1006.56,
      "near": { "expiry": "2026-11-23", … }, "next": { "expiry": "2026-12-29", … },
      "oi": 108122250, "chgOi": -705000, "oiChangePct": -0.648, "pricePct": 2.533, "buildup": "short-covering", "basisPct": 0.153 }, … ] }
```

## GET /v1/fo/members

`?date=YYYY-MM-DD`: the F&O list on the newest stored trade day on or before `date` (default today)
— for survivorship-free backtests. `404 no_data` when nothing that old is stored.

```json
{ "date": "2026-11-06", "tradeDate": "2026-11-05", "count": 218, "symbols": ["360ONE", "ABB", …] }
```

`?from=YYYY-MM-DD&to=YYYY-MM-DD`: the list on **every stored trade day** in the range, oldest
first — one request instead of one per day. At most 400 days per request (`400 bad_request`
beyond; ask in pieces). `to` defaults to today and `from` to 30 days before `to`. Days with no
stored file (holidays, days before the hub's first download) are simply absent; an empty range is
`200` with `days: []`. `date` together with `from`/`to` is a `400`.

```json
GET /v1/fo/members?from=2026-11-04&to=2026-11-06
{ "from": "2026-11-04", "to": "2026-11-06", "days": [
    { "date": "2026-11-04", "day": 1793750400000, "symbols": ["360ONE", "ABB", …] },
    { "date": "2026-11-05", "day": 1793836800000, "symbols": ["360ONE", "ABB", …] } ] }
```

## GET /v1/fo/contracts?symbol=SBIN

A stock's futures contracts as hub tickers, for `/v1/candles`, `/v1/quotes` and `/v1/stream`.
From the newest stored F&O bhavcopy (`asOf`), which carries the near and next month; a contract
that has expired since that file is left out (so right after an expiry, before the evening's file,
only one contract — then `near` — is listed). The ticker is the underlying as NSE wrote it in the
file, plus the expiry's year and month: NSE's own instrument name (`SBIN25NOVFUT`), which is also
Fyers'. `lot` is the near month's lot from the file (else the lot-size table). `404 not_ready`
when no F&O bhavcopy is stored; `404 not_found` when the stock had no futures in it.

```json
GET /v1/fo/contracts?symbol=SBIN
{ "symbol": "SBIN", "asOf": "2026-11-05", "lot": 750, "contracts": [
    { "ticker": "SBIN26NOVFUT", "expiry": "2026-11-24", "kind": "near" },
    { "ticker": "SBIN26DECFUT", "expiry": "2026-12-29", "kind": "next" } ] }
```

## GET /v1/fo/ban

```json
{ "tradeDate": "2026-11-06", "symbols": ["KAYNES"], "fetchedAt": 1793946082535, "current": true }
```

`current` is false while the stored list is for an earlier session than the one ahead (NSE
publishes the next session's list in the evening). `503 not_ready` until the first download.

`?date=YYYY-MM-DD` answers exactly that trade date's stored list (same shape), or `404 no_data` with
`knownFrom` (the first stored trade date) — never a nearby day's list. The hub has each day's list
from when it started downloading it; older lists aren't in its store.

### GET /v1/fo/ban/history[?from&to]

Every stored trade date's list in the range, oldest first. A trade date that isn't listed is
unknown (the hub didn't download it), not "nobody banned"; a day with nobody banned has `[]`.

```json
{ "knownFrom": "2026-11-10", "knownFromDay": 1794268800000,
  "days": [ { "date": "2026-11-10", "day": 1794268800000, "symbols": ["ABFRL"], "fetchedAt": 1794227000000 } ] }
```

## GET /v1/lots

```json
GET /v1/lots?symbol=SBIN   →  { "symbol": "SBIN", "lot": 750, "source": "nse_mktlots", "fetchedAt": 1793946083654 }
GET /v1/lots               →  { "source": "nse_mktlots", "fetchedAt": …, "count": 224, "lots": { "360ONE": 500, "ABB": 125, … } }
```

### GET /v1/lots/history[?symbol=SBIN][&from&to]

Lot per stock as it was on each stored F&O day, from the F&O bhavcopy's lot column, as change
points: each stock's first stored day in the range, then every day its lot differs from the day
before. Lots are as traded that day (not adjusted for later splits). NSE's files have the column
from 8 Jul 2024 (`knownFrom`); older (old-format) files don't, so earlier lots are unknown and
nothing is returned for them. `lastDate` is the newest stored F&O day. `503 not_ready` before the
first F&O file.

```json
GET /v1/lots/history?symbol=SBIN
{ "from": null, "to": "2026-11-20", "knownFrom": "2024-07-08", "knownFromDay": 1720396800000,
  "lastDate": "2026-11-19", "lastDay": 1795046400000,
  "lots": { "SBIN": [ { "date": "2024-07-08", "day": 1720396800000, "lot": 1500 },
                      { "date": "2024-12-27", "day": 1735257600000, "lot": 750 } ] } }
```

## GET /v1/results-calendar

Board meetings about financial results. Default range: 7 days ago to 60 days ahead.

```json
GET /v1/results-calendar?from=2026-10-23&to=2026-10-23
{ "from": "2026-10-23", "to": "2026-10-23", "asOf": "2026-10-22", "fetchedAt": 1792677000000, "events": [
    { "symbol": "CRISIL", "date": "2026-10-23", "day": 1792713600000, "company": "Crisil Limited",
      "purpose": "Financial Results/Dividend To consider and approve the financial results for the period ended September 30, 2026 and div" }, … ] }
```

The dates come from NSE's archive, not its website: each session's PR zip
(`archives/equities/bhavcopy/pr/PRDDMMYY.zip`) has a board-meetings file (`bmDDMMYYYY.txt`) listing
the meetings companies announced that day, and every meeting whose purpose mentions results is an
event. So the calendar is everything announced in the PR zips the hub has read — the last 60 days'
by the evening run, back to 2010 with [`data nse-history`](#data-nse-history).

- `asOf`: the newest session whose PR zip is stored (a meeting announced after it isn't in yet);
  `fetchedAt`: the last time the hub read PR zips without an error. `503 not_ready` until the first.
- `purpose` is NSE's text — the purposes ("Financial Results/Dividend") and then the company's own
  description — cut at 120 characters. A meeting listed twice joins both texts with ` · `.
- A meeting announced again for the same date replaces the earlier row. A meeting **moved** to
  another date shows on both dates: the announcement of the new date doesn't say which meeting it
  replaces.

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
NIFTY's daily candles come from NSE's index file when it is stored (below), so the regime needs no
broker.

## GET /v1/indices

Every index and synthetic basket with daily candles, how far back each one's stored history
reaches, and the NIFTY 500 industries mapped to sector indices and baskets.

**Indices** come from NSE's daily index file, `content/indices/ind_close_all_DDMMYYYY.csv`: every
index NSE computes, with open/high/low/close, volume, P/E, P/B and dividend yield (stored as
printed in `index_closes`). The archive has it from **late Feb 2012** (15 Feb 2012: no file; 1 Mar
2012: there). The evening run fetches it after 18:00 IST and extends the index candles;
`hub data nse-history` downloads the archive. NSE renamed the indices over the years ("S&P CNX
Nifty" until 2013, "CNX Nifty" until Nov 2015, then "Nifty 50"; "CNX IT" → "Nifty IT"); each symbol
knows every name it has had (`src/reference/indices.ts`). A symbol's coverage is the unbroken run of
sessions ending at its newest day, so an index's history starts where NSE first printed it (sector
indices launched recently — Capital Goods, Chemicals, Power… — start then). `NIFTY`, `BANKNIFTY`,
`FINNIFTY`, `MIDCPNIFTY`, `NIFTYNXT50`, `NIFTYIT` and `INDIAVIX` are also served by the broker
(`intraday: true`: intraday candles, live quotes); the others are daily-only from NSE's file, never
asked of the broker (`15m` etc. answer `404 unknown_symbol`).

**Synthetic baskets** (`EW-NIFTY50`, `EW-NIFTY500`, and one per NIFTY 500 industry: `EW-IT`,
`EW-AUTO`, `EW-FINANCIAL`…) stand in where no NSE index history exists: before 2012, and before a
sector index launched. **They are not NSE indices**: each is the equal-weight average of today's
members' daily moves (close / NSE's `PREV_CLOSE` − 1, so splits and bonuses don't show), chained
from 1000 on the first session with at least 3 members priced. Members are today's (the NIFTY 500
snapshot), so older history has **survivorship bias**. They are rebuilt from the cash bhavcopy —
back to 1994 once `hub data nse-history` has run — and every answer labels them `synthetic: true`.
Volume is 0.

Before 2012 no other source was found reliable enough to import unattended: niftyindices.com
(NSE's index arm) has older index history, but only through a Cloudflare-protected web form, not
an archive file.

```json
{ "indices": [ { "symbol": "NIFTY", "name": "Nifty 50", "synthetic": false, "source": "nse_index_file", "intraday": true,
                 "firstSession": "2012-03-01", "lastSession": "2026-11-17", "sessions": 3640,
                 "coverage": { "from": "2012-03-01", "to": "2026-11-17" } }, … ],
  "baskets": [ { "symbol": "EW-IT", "name": "Equal-weight Information Technology basket (synthetic)", "synthetic": true,
                 "source": "equal_weight_basket", "universe": "nifty500", "industry": "Information Technology",
                 "standsFor": "NIFTYIT", "members": 25, "firstSession": "1994-11-04", … }, … ],
  "sectors": [ { "industry": "Information Technology", "indices": ["NIFTYIT"], "basket": "EW-IT" }, … ],
  "basketMethod": "Equal-weight average of today's members' daily moves …",
  "indexFile": { "firstSession": "2012-03-01", "lastSession": "2026-11-17", "sessions": 3640, "unmappedNames": ["Nifty Alpha 50", …] } }
```

`sectors[].indices` lists the NSE indices for an industry, best first: use the first whose history
covers the window, else the basket. `unmappedNames` are indices in NSE's newest file the hub
stores but doesn't serve as candles.

## Split and bonus adjustment

NSE's files carry prices **as traded**: a 1:10 split looks like a 90% crash. The hub keeps them so
(`cash_bhav`) and derives, separately, one **adjustment factor** per ex-date
(`adjustment_factors`; `src/history/adjustments.ts`): prices before the ex-date × `factor`
(volumes ÷ `factor`) are comparable with prices from it on. Both are served: adjusted daily candles
by default, raw with [`/v1/candles?adjust=none`](#get-v1candles), the factors with
`/v1/adjustments` and NSE's corporate actions with `/v1/corporate-actions`.

**NSE's `PREV_CLOSE` is not adjusted for splits and bonuses.** On an ordinary ex-date it is just the
previous close: TATASTEEL's 1:10 split (28 Jul 2022, old cash file: `PREVCLOSE` 959.4, open 98.1),
ANGELONE's (26 Feb 2026, in `sec_bhavdata_full` and the UDiFF bhavcopy alike: 2489.9, open 251), CUB's
1:3 bonus (12 Jun 2026: 256.8, open 197.4). Of 587,000 consecutive pairs in 2026's files, one had
`PREV_CLOSE` ≠ the previous close. NSE adjusts it only now and then — some rights issues
(WANBURY, TAKE in 2025), a consolidation after a suspension (CCAVENUE, Oct 2026). So each pair of
consecutive sessions of a ticker gets a factor from the first of these that applies:

| `source` | When | Factor |
|---|---|---|
| `prev_close` | the file's `PREV_CLOSE` differs from the previous close by over 1.5%, the open bears it out, and the sessions are at most 15 days apart | `PREV_CLOSE / close(d−1)` (NSE's own adjustment) |
| `corporate_action` | NSE's corporate-actions file (the PR zip's `bc` file, from 2010) lists, for that ticker and ex-date, a bonus, split or consolidation | its ratio (`BONUS 1:1` → 0.5, `FV SPLIT RS.10 TO RE.1` → 0.1), when the opening gap bears it out |
| | … a `DEMERGER` | the opening gap `open(d) / close(d−1)` (NSE prices what is left in a special pre-open session) |
| | … a rights issue with its price (`RIGHTS 3:25@PRM RS 1799`) | the theoretical ex-rights price over the last close |
| `price_gap` | no `bc` file was read for the week before (before 2010, or PR zips not downloaded), and the opening gap is nearest a standard ratio (1/10, 1/6, 1/5, 1/4, 1/3, 2/5, 1/2, 2/3, 3/4, 2, 5, 10): within 12% of it with the close within 25% for a halving or more (or a doubling) — no market move — and within 6% / 20% for 2/3 and 3/4 | that ratio |

Sessions are consecutive only when every trading day between them was checked (stored or a known
holiday). Where a `bc` file was read and lists nothing, a gap is a gap (no guess); rights
entitlements (`-RE`) and prices under ₹2 are never guessed at. **Renames** (`/v1/symbols`): no pair
is formed across a rename of its ticker (it may have passed to another company); the last session
under the old name and the first under the new one form a pair of their own, kept under the new
ticker with `renamedFrom`, that only `prev_close` and `corporate_action` can turn into a factor — the
change of name is no action. Factors are read per listing, so they **follow the company across its
names** (INFY's include INFOSYSTCH's).

Factors are derived on start (once, and again after the derivation changes), for each evening's
cash file before it extends stored series (an ex-date that evening drops the symbol's stored series,
as before — now caught from the factors, which `PREV_CLOSE` alone missed), and for everything when a
[`data nse-history`](#data-nse-history) run stops. In end-of-day mode, stored daily series of tickers
whose factors changed are dropped and rebuilt on the next request. `hub data adjustments --check`
compares them with the broker's adjusted daily history ([below](#data-adjustments)).

### GET /v1/adjustments?symbol=INFY[&from&to]

A listing's factors, oldest first. `cumulative` is what a bar on the session before the ex-date is
multiplied by (this factor and every later one); `symbol` is the ticker that day.

```json
GET /v1/adjustments?symbol=KOTAKBANK
{ "symbol": "KOTAKBANK", "current": "KOTAKBANK", "names": [ { "symbol": "KOTAKBANK", "from": null, "until": null } ],
  "derivedAt": 1795100000000,
  "factors": [ { "date": "2026-01-14", "day": 1768348800000, "symbol": "KOTAKBANK", "factor": 0.2, "cumulative": 0.2,
      "source": "price_gap", "prevDate": "2026-01-13", "prevClose": 2132.6, "filePrevClose": 2132.6,
      "open": 426, "close": 421, "action": null, "renamedFrom": null } ] }
```

### GET /v1/adjustments/batch?symbols=INFY,SBIN

Up to 300 listings' factors in one request (for readers that adjust many stocks, e.g. to a past
day). Per symbol: the listing's ticker today and its factors oldest first, as `/v1/adjustments`
gives them (`cumulative` included); a stock with no factors has `[]`.

```json
{ "derivedAt": 1795100000000,
  "series": { "KOTAKBANK": { "current": "KOTAKBANK", "factors": [ { "date": "2026-01-14", "day": 1768348800000,
      "symbol": "KOTAKBANK", "factor": 0.2, "cumulative": 0.2, "source": "price_gap", "action": null } ] },
              "SBIN": { "current": "SBIN", "factors": [] } } }
```

### GET /v1/corporate-actions?[symbol=…&]from&to

NSE's corporate actions as its PR zips list them (the `bc` file: bonus, split, rights, dividend,
demerger, buy-back… with record and ex-dates), equity rows only. With `symbol`, every one of the
listing's names (default range: all); without, every ticker, at most 400 days (default: 30 days
either side of today). `kinds` and `ratio` are what the hub reads from `purpose` (`ratio`: the price
factor of a bonus, split or consolidation, else `null`). `asOf` is the newest PR day whose `bc` file
was read; `503 not_ready` before the first. Each day's file lists the actions near their ex-date, so
the calendar is the union of the files read — every evening's, and back to 2010 with
`data nse-history`.

```json
GET /v1/corporate-actions?symbol=SIEMENS&from=2025-04-01&to=2025-04-30
{ "symbol": "SIEMENS", "names": [ … ], "asOf": "2026-11-18",
  "actions": [ { "symbol": "SIEMENS", "exDate": "2025-04-07", "exDay": 1743984000000, "recordDate": "2025-04-07",
      "purpose": "DEMERGER", "kinds": ["demerger"], "ratio": null, "series": "EQ", "company": "Siemens Ltd" } ] }
```

## Ticker renames: /v1/symbols

NSE renames a company's ticker now and then (TELCO → TATAMOTORS on 26 Dec 2003 → TMPV on 24 Oct
2025; INFOSYSTCH → INFY on 29 Jun 2011), and its files are written under whatever the ticker was
that day. The hub joins the names from two sources:

- **NSE's `content/equities/symbolchange.csv`** (on the archive): every rename since 1999 with its
  effective date — the first session under the new ticker (INFOSYSTCH's last bhavcopy row is 28 Jun
  2011, INFY's first 29 Jun). Downloaded on start and once each evening, replacing the stored list
  (a file with under 100 rows is refused and the stored list kept).
- **ISINs** in NSE's old-format cash bhavcopy (the column exists from 2011 to 5 Jul 2024): one ISIN
  traded under ticker A, then, after A's last day, under B, is a rename too. These add renames NSE's
  list lacks; where the list has the same change (the same pair, or the same old or new ticker within
  31 days) NSE's row wins. `hub data nse-history` records ISINs as it stores those days, and reads
  them once from days stored before the hub kept them.

A **listing** is one company's names, oldest first. Lookups are **point in time**: `symbol` is a
ticker as it was on `date` (default today), so `INFOSYSTCH` on 2005-01-03 and `INFY` today are the
same listing, and a ticker renamed away and later taken by another company resolves by date.
Renames chained on one day (GBNOV23 → SBNOV23 → SGBNOV23) count as one.

### GET /v1/symbols/history?symbol=INFY[&date=YYYY-MM-DD]

```json
GET /v1/symbols/history?symbol=INFOSYSTCH&date=2005-01-03
{ "symbol": "INFOSYSTCH", "date": "2005-01-03", "match": "exact", "onDate": "INFOSYSTCH", "current": "INFY",
  "names": [
    { "symbol": "INFOSYSTCH", "from": null, "to": "2011-06-28", "stored": { "first": "2011-06-28", "last": "2011-06-28", "sessions": 1 } },
    { "symbol": "INFY", "from": "2011-06-29", "to": null, "stored": { "first": "2011-06-29", "last": "2011-06-29", "sessions": 1 } } ],
  "changes": [ { "date": "2011-06-29", "day": 1309305600000, "oldSymbol": "INFOSYSTCH", "newSymbol": "INFY",
      "company": "Infosys Limited", "source": "nse", "isin": null, "continuous": true } ],
  "fetchedAt": 1795010799626 }
```

(From NSE's real `symbolchange.csv` and the 28/29 Jun 2011 bhavcopies.)

- `names[]`: each ticker with the days it was in use, inclusive (`from: null` — since before any
  record; `to: null` — still in use), and `stored`: the cash-bhavcopy sessions stored under it in that
  span (`null` when none). `current` is the last name; `onDate` the name on `date`.
- `match`: `exact` — the listing had `symbol` on `date`; `later` — nobody had it on `date` (and no row
  is stored under it then), so this is the listing that took it later (`INFY` asked for 2005);
  `earlier` — it had been renamed away by `date` and nothing has traded under it since, so this is
  the listing that last had it (`INFOSYSTCH` asked for today). A ticker with no renames is its own
  listing (`names` is one entry with `from` and `to` null).
- `changes[i]` took `names[i]` to `names[i + 1]`; `source` is `nse` or `isin` (with the ISIN).
  `continuous`: the old ticker's last stored session and the new one's first are consecutive stored
  sessions — the history runs on across the rename; `false` shows a gap (a session missing on both
  sides: a suspension, or NSE's effective date off from the files); `null` when either side has
  nothing stored.
- `503 not_ready` until NSE's list has been downloaded once; `400` for a missing or malformed
  `symbol` (old tickers may contain `+` and `.`) or a bad `date`.

### GET /v1/symbols/changes[?symbol=…][&from=…&to=…]

Every known rename, oldest first, optionally those with an effective date in `from`..`to` and those
whose old or new ticker is `symbol`. `from`/`to` are `null` in the answer when not given.

```json
GET /v1/symbols/changes?symbol=TMPV
{ "from": null, "to": null, "fetchedAt": 1795010799626, "count": 1, "changes": [
    { "date": "2025-10-24", "day": 1761264000000, "oldSymbol": "TATAMOTORS", "newSymbol": "TMPV",
      "company": "Tata Motors Passenger Vehicles Limited", "source": "nse", "isin": null } ] }
```

## Live prices

One broker socket feeds every client. Symbols are hub tickers as for candles (`SBIN`, `M%26M`,
`NIFTY`, futures such as `SBIN26NOVFUT`); lists are comma-separated, at most 100 per request. A live **quote** is a tick:

```json
{ "symbol": "SBIN", "ltp": 1008.1, "ch": 24.9, "chp": 2.53, "open": 985, "high": 1010.5, "low": 983.2,
  "prevClose": 983.2, "volume": 12873400, "ltt": 1794200401000, "ts": 1794200401230, "source": "socket" }
```

`volume` is the day's cumulative volume; `ltt` the exchange time of the last trade; `ts` when the hub
received it; `source` is `socket` (pushed by the broker), `poll` (a REST quote — the fallback for
symbols beyond the socket's capacity, and for `/v1/quotes` misses) or `store` (the last quote saved
in the database, e.g. outside market hours or right after a restart).

### GET /v1/quotes?symbols=A,B

For each symbol, in order of preference:

1. the latest tick from the live feed, when it is under 5 s old;
2. otherwise a broker quote — every such symbol in one batched call at user priority, cached for
   3 s and shared by concurrent requests (ten clients asking at once cost one call);
3. otherwise (broker failing, out of budget or slower than 10 s, or another process owning it) the
   last stored quote, with `stale: true`.

With no broker configured at all, `/v1/quotes` and `/v1/stream` answer `503 not_configured` (see
[End-of-day mode](#end-of-day-mode-no-broker-configured)).

Every quote carries `ageMs` (now − `ts`) and `stale`. Symbols with no quote anywhere are listed in
`missing`. A broker problem never turns the answer into an error: it is still `200`, with what is
available plus `warning` and `reason` (`not_configured`, `not_owner`, `auth`, `budget`,
`rate_limited`, `upstream`, `network`, or `pending` when the broker was slow — the call continues
and fills the cache). When the day's budget is spent, `budget` says why (`day` or `strikes`).

```json
GET /v1/quotes?symbols=SBIN,INFY,NEWCO
200
{ "quotes": [
    { "symbol": "SBIN", "ltp": 1008.1, …, "source": "socket", "ageMs": 412, "stale": false },
    { "symbol": "INFY", "ltp": 1490.5, …, "source": "store", "ageMs": 3600000, "stale": true } ],
  "missing": ["NEWCO"],
  "warning": "The broker is unavailable (Today's broker data budget is used up.); showing stored quotes for the rest.",
  "reason": "budget" }
```

### GET /v1/stream?symbols=A,B[&since=…]

[Server-Sent Events](https://html.spec.whatwg.org/multipage/server-sent-events.html)
(`text/event-stream`). On connect the hub subscribes the symbols on the live feed, then sends:

| Order | Event | `data` |
|---|---|---|
| 1 | `status` | the feed status: `{ mode: socket\|polling\|mixed\|idle\|down, socket, socketSymbols, polledSymbols, capacity, lastTickAt, reconnects }` (the first frame also sets `retry: 3000`) |
| 2 | `snapshot` | `{ quotes: [quote + ageMs + stale], missing: [...] }` — the last stored quote per symbol, so a client has prices immediately, even right after a hub restart or outside market hours |
| 3 | `bars` (one per symbol) | `{ symbol, from, to, truncated, bars: [{ t, o, h, l, c, v, source }] }` — stored 1-minute bars in `[from, to)`; `source` is `live` (built from ticks) or `broker` (downloaded history, authoritative) |
| 4… | `tick` | a quote, with `id: <ms>` |
| any time | `status` | sent again when the feed's mode or socket state changes |
| every 15 s | comment `: ping <ms>` | heartbeat (keeps proxies and tunnels from closing an idle stream) |

```
retry: 3000
event: status
data: {"mode":"socket","socket":"connected","socketSymbols":42,"polledSymbols":0,"capacity":100,"lastTickAt":1794200401230,"reconnects":0}

event: snapshot
data: {"quotes":[{"symbol":"SBIN","ltp":1007.9,…,"source":"store","ageMs":5230,"stale":true}],"missing":[]}

event: bars
data: {"symbol":"SBIN","from":1794196800000,"to":1794200402000,"truncated":false,"bars":[{"t":1794196800000,"o":985,"h":990,"l":983.2,"c":988,"v":120300,"source":"broker"},…]}

id: 1794200401000
event: tick
data: {"symbol":"SBIN","ltp":1008.1,…,"ltt":1794200401000,"ts":1794200401230,"source":"socket"}

: ping 1794200416000
```

**Replay and resume.** Bars are replayed from the start of the minute containing the first of:
the `Last-Event-ID` header (sent automatically by a reconnecting `EventSource`), the `since`
parameter (epoch ms or `YYYY-MM-DD`), or the start of today's session (09:15 IST). `Last-Event-ID`
wins because a reconnecting `EventSource` repeats the original URL, `since` included. Replay goes back
at most 4 days and at most 20 000 bars per stream (split evenly across its symbols, newest kept;
`truncated: true` when cut). A tick's `id` is its exchange time (`ltt`, or `ts` without one) and never
decreases on a stream, so after a dropped connection — or a hub restart — the client gets the
minutes it missed as `bars` and then live ticks again. Bars are keyed by `t`; replace, don't append,
when one arrives that you already hold (the minute at the resume point is sent again).

**Slow clients.** Each stream buffers at most one tick per symbol: if the client reads slower than
ticks arrive, older ticks for a symbol are replaced by the newest (its `open`/`high`/`low` and
cumulative `volume` still describe the whole day). Memory per stream stays bounded.

**Limits.** At most 100 symbols per stream (`400 too_many_symbols`) and 5 open streams per key
(`429 too_many_streams`) — put many symbols on one stream rather than opening one per symbol.
Closing the connection unsubscribes its symbols.

Browser:

```js
// EventSource can't send headers; use a small proxy that adds the key, or the Node example below.
const es = new EventSource("/hub/v1/stream?symbols=SBIN,INFY");
es.addEventListener("snapshot", (e) => render(JSON.parse(e.data).quotes));
es.addEventListener("bars", (e) => mergeBars(JSON.parse(e.data)));     // replace by t
es.addEventListener("tick", (e) => update(JSON.parse(e.data)));        // reconnects resume via Last-Event-ID
es.addEventListener("status", (e) => showFeed(JSON.parse(e.data).mode));
```

Node 22 (no dependencies; resumes with `Last-Event-ID` itself):

```js
let lastId;
async function follow(symbols, onEvent) {
  for (;;) {
    try {
      const res = await fetch(`${HUB}/v1/stream?symbols=${symbols.join(",")}`, {
        headers: { authorization: `Bearer ${process.env.HUB_KEY}`, ...(lastId ? { "last-event-id": lastId } : {}) },
      });
      if (!res.ok) throw new Error(`${res.status} ${(await res.json()).code}`);
      let buffer = "";
      for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
        buffer += chunk;
        const frames = buffer.split("\n\n");
        buffer = frames.pop();
        for (const frame of frames) {
          const field = (name) => frame.match(new RegExp(`^${name}: (.*)$`, "m"))?.[1];
          if (field("id")) lastId = field("id");
          if (field("event")) onEvent(field("event"), JSON.parse(field("data")));
        }
      }
    } catch (error) {
      console.error("stream dropped:", error.message);
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}
```

### POST /v1/live/pin, DELETE /v1/live/pin (admin)

Pinned symbols stay subscribed whether or not a client is connected, and across restarts (with
`HUB_LIVE_SYMBOLS`), so their minute bars are always being recorded. At most 100 (the socket's
capacity; more would be polled against the broker budget). A newly pinned symbol's session so far
is downloaded from broker 1-minute history in the background (one call), so its bars start at 09:15.
Symbols listed in `HUB_LIVE_SYMBOLS` can't be unpinned through the API: they come back in `kept`.

```json
POST /v1/live/pin     { "symbols": ["SBIN", "INFY"] }
200 { "persistentSymbols": ["NIFTY", "INFY", "SBIN"], "added": ["SBIN", "INFY"] }

DELETE /v1/live/pin   { "symbols": ["SBIN", "NIFTY"] }
200 { "persistentSymbols": ["NIFTY", "INFY"], "removed": ["SBIN"], "kept": ["NIFTY"] }
```

## GET /v1/status

Health first, then the mode (`mode`, `modeLabel`, `modeNote`, `features` — see
[End-of-day mode](#end-of-day-mode-no-broker-configured)), version, uptime, the calling key, the broker connection and today's budget,
data freshness per dataset, recent jobs and a `live` section. Never credentials, tokens or keys.

**Health** (for people and uptime checkers): `healthy` (no problems), `problems` (strings: something
is stale or down — worth an alert) and `warnings` (worth knowing, not an alert). `?strict=1` answers
**503** with `code: "unhealthy"` when `healthy` is false, for checkers that only look at the status
code. A problem is raised when:

| Check | Problem when |
|---|---|
| Cash / F&O bhavcopy, PR zip (results calendar) | a trading day's file isn't stored after 20:00 IST that day (days NSE had no file for — `holiday`/`mismatch` — don't count), or nothing is stored at all. Today's file missing with no sign of a session today (no live minutes, no daily bar) is only a *warning*: it may be an exchange holiday, which the hub learns from NSE the next day |
| Lot sizes, ban list | never fetched, or last fetched over 4 days ago |
| Broker | configured, and the login is failing (in its retry wait), or calls are stopped for today (budget spent / strikes). Cooling down after a rate-limit warning, or another process owning the connection, is a warning |
| Live feed | during market hours (09:15–15:30 IST, weekdays) the feed isn't running or is `down` (no socket, no polling). Socket down but polling is a warning |
| Backups | `HUB_BACKUP_DIR` is set and it holds no backup, or the newest is over 2 days old |
| Disk | free space where the database (or, on another disk, the backups) lives is under `HUB_DISK_MIN_GB` (default 2 GB) — NSE history and backups have stopped by then, and SQLite writes are next. Under `HUB_DISK_WARN_GB` (default 5 GB) is a warning |
| A refresh that keeps failing | any dataset (cash / F&O bhavcopy, index file, PR zip, lots, ban list, ticker renames) whose refreshes have failed for a day: the last attempts failed in a row since then, with the last error. Three failures in a row (an hour and a half of the evening run) are a *warning* first, before the data counts as stale |

`HUB_JOBS=off` adds a warning (NSE files then go stale by design). Open data-quality *problems* about the last 14 days' data
add one warning (`Data quality: …`; see [GET /v1/quality](#get-v1quality)) — never a problem: a bad file is worth knowing
about, but the hub is still serving.

`quality`: the [data-quality checks](#get-v1quality)' state — `lastRunAt`, `pendingDays` (stored days not checked yet) and
`waitingDays` (of those, the ones waiting for the sessions before them, during an NSE history download), `open`
(`{ problem, warning, info }` counts), `checks` (per check and severity: `count`, `newestDate`) and `recent`: the open findings
about the last 30 days' trade dates (at most 50, newest first; the same objects as `/v1/quality`'s).

`disk`: `volumes` (one entry per disk: `holds` is `the database`, `backups` or `the database and
backups`, `freeBytes` null when it can't be read), the thresholds `warnBelowBytes` and
`minFreeBytes`, and `backups` (`count`, total `bytes`, `newestBytes`; null without
`HUB_BACKUP_DIR`). No paths. Expected sizes: [Disk space](#disk-space).

```bash
# An uptime checker (Uptime Kuma, Healthchecks, a cron + curl) with a key of its own:
npm run hub -- keys create uptime --scopes history
curl -fsS -H "Authorization: Bearer mdh_…" "https://data.example.com/v1/status?strict=1" > /dev/null || echo "hub unhealthy"
```

`live`: `enabled` (a broker is configured and `HUB_LIVE` isn't off), `running` (this process runs
the feed — false while another process owns the broker connection), `feed` (the stream's `status`
object plus `pollingStopped: "budget" | null`), `persistentSymbols` and `persistent` (with origin
`config` or `pin` and when added), `streams`, `quotesCached`, `recovery` (`{ running, pending,
last }`: the latest gap repair — reason `start` / `gap` / `symbols` / `resume`, calls, bars,
skipped, failed, pending, error) and `store` (buffered writes, `lastTickAt`, and `previousRun`:
the last tick and heartbeat the previous run left, which is where restart recovery starts).

```json
{ "healthy": true, "problems": [], "warnings": [],
  "service": "market-data-hub", "version": "0.1.0", "uptimeSec": 20, "key": { "name": "smoke", "scopes": ["history", "fo"] },
  "broker": { "configured": true, "connected": true, "ownsConnection": true, "lastLoginAt": 1793946107241, "lastLoginError": null, "loginRetryAfter": null,
    "budget": { "plan": "standard", "usedToday": 4, "dayCap": 4750, "usedThisMinute": 4, "minuteCap": 40,
      "byPriority": { "user": 0, "refresh": 0, "background": 4 }, "strikes": 0, "slowed": false, "coolingDown": false, "stoppedForToday": false } },
  "data": { "dbBytes": 487424,
    "cashBhav": { "lastSession": "2026-11-05", "firstSession": "1994-11-03", "sessions": …, "lastSuccessAt": …, "lastAttemptAt": …, "lastError": null },
    "foBhav": { "lastSession": "2026-11-05", "firstSession": "2001-11-09", "sessions": …, … }, "lots": { "count": 224, "source": "nse_mktlots", … },
    "foBan": { "tradeDate": "2026-11-06", … },
    "resultsCalendar": { "upcoming": 41, "lastSession": "2026-11-05", "firstSession": "2026-09-08", "sessions": 42, "lastSuccessAt": …, "lastAttemptAt": …, "lastError": null },
    "symbolChanges": { "count": 1071, "isins": { "pairs": 1484, "days": 2 }, "lastSuccessAt": …, … },
    "candles": [ { "tf": "1d", "series": 2, "candles": 310, "lastSession": "2026-11-06" } ] },
  "disk": { "volumes": [ { "holds": "the database and backups", "freeBytes": 41870000000 } ], "warnBelowBytes": 5000000000, "minFreeBytes": 2000000000,
    "backups": { "count": 7, "bytes": 2650000000, "newestBytes": 380000000 } },
  "jobs": [],
  "live": { "enabled": true, "running": true,
    "feed": { "mode": "socket", "socket": "connected", "socketSymbols": 3, "polledSymbols": 0, "capacity": 100, "lastTickAt": 1794200401230, "reconnects": 0, "pollingStopped": null },
    "persistentSymbols": ["NIFTY", "BANKNIFTY", "SBIN"], "persistent": [ { "symbol": "NIFTY", "origin": "config", "addedAt": 1794196500000 }, … ],
    "streams": 1, "quotesCached": 0,
    "recovery": { "running": false, "pending": 0, "last": { "reason": "start", "startedAt": 1794200100000, "finishedAt": 1794200173000, "planned": 3, "calls": 3, "bars": 21, "skipped": 0, "failed": 0, "pending": 0 } },
    "store": { "bufferedQuotes": 0, "bufferedBars": 2, "symbolsSeen": 3, "lastTickAt": 1794200401230, "lastPruneAt": 1794200100000,
      "previousRun": { "lastTickAt": 1794199680000, "aliveAt": 1794199690000 } } } }
```

## GET /v1/quality

Data-quality checks on what the hub has stored, run after every evening import and NSE history
run, newest trade day first. Each finding is about one trade day and one subject (a dataset —
`cash_bhav`, `fo_bhav`, `index_close`, `pr` —, a symbol, `fo`, `lots` or `calendar`); it is
refreshed while the data still shows it and **resolved** (`resolvedAt`) once it doesn't, e.g. when
NSE's next file confirms a holiday or the day is downloaded again. Severity: `problem` (a file is
missing or wrong: worth an alert), `warning` (worth a look) or `info` (a change worth knowing).

| Check | Finds | Severity |
|---|---|---|
| `missing_session` | a session (another NSE file of that day is stored: cash, F&O or index) whose file NSE answered with 404 or another day's file. The hub has no holiday list ([#17](https://github.com/ice-009/market-data-hub/issues/17)): a day with any of those files stored is a session. A known gap in NSE's archive (`ARCHIVE_GAPS` in `src/nse/datasets.ts`: the F&O bhavcopy of 30 Mar 2021) is info | problem (info for a known gap) |
| `unlisted_session` | a weekend session (cash/F&O files stored) that `WEEKEND_SESSIONS` doesn't list, so the evening run won't ask for its files and the next session's cash file extends stored daily series past it (add it to the list; the next `hub data nse-history` run fills the skipped bars from the stored bhavcopy) | warning (info over a year back) |
| `wrong_date` | NSE served another day's file for a weekday and no other dataset confirms a holiday (resolved once one does) | warning |
| `repeated_file` | a cash bhavcopy whose OHLCV repeats the previous session's for half or more of the stocks the two share (at least 50): the previous file under a new date | problem |
| `candle_gap` | stored daily candles (broker history) lacking sessions the stock traded inside their coverage; one finding per symbol | warning |
| `price_outlier` | a close-to-close move of 10× the stock's volatility (the standard deviation of its last 60 daily log returns, at least 20 of them, taken as at least 1%) and at least 10%, that no corporate action explains: the corporate-action hook (the adjustment table, [#20](https://github.com/ice-009/market-data-hub/issues/20), once it lands), NSE's `PREV_CLOSE` off the stored close by over 1.5%, or an F&O lot change matching the move. The message says when the move matches a common split/bonus ratio (1/2, 1/5, 1/10, 2/3…) | warning beyond NSE's widest price band (20%), else info |
| `broker_mismatch` | stored daily closes against the bhavcopy's (pluggable price adjuster; none yet), in stretches of one steady ratio. A stretch that ends where the stored history moves smoothly and NSE's raw close jumps is a corporate action the broker adjusted for and the archive isn't adjusted for yet | info; warning when nothing explains it |
| `lot_change` | lot sizes that changed between two consecutive F&O sessions (one finding per day, `detail.changes`) | info |
| `fo_list_change` | stocks that joined or left the F&O list (`detail.added`, `detail.removed`) | info; problem when a tenth or more (≥ 10) leave at once, not counting stocks whose last contract expired the session before (NSE drops stocks from F&O after an expiry: 34 on 28 Jun 2019) — a cut-off file |
| `lot_file_mismatch` | NSE's `fo_mktlots.csv` (what `/v1/lots` serves) disagreeing with the newest F&O bhavcopy's lots | warning |

The session checks are recomputed whenever `nse_days` changes; the per-day ones (outliers, repeated
files, lots and the F&O list) look at each stored day once, newest first, in runs of 100 sessions —
during an NSE history download a day waits until the sessions before it are stored (`waitingDays`
in `/v1/status`) — and again if the day's file is stored again; stored candles are compared at most
every 30 minutes, when they or the bhavcopy changed. `hub data quality --full` checks everything again.

Query: `check`, `severity` (that severity and worse), `subject`, `from` / `to` (trade dates), `status`
(`open` — the default —, `resolved`, `all`), `limit` (1–1000, default 200).

```json
200 { "summary": { "lastRunAt": 1795100000000, "pendingDays": 0, "waitingDays": 0, "open": { "problem": 0, "warning": 2, "info": 3 }, "checks": [ … ], "recent": [ … ] },
      "checks": { "missing_session": "A session … whose file NSE answered with 404 or with another day's file.", … },
      "count": 1,
      "findings": [ { "check": "candle_gap", "date": "2026-11-08", "day": 1794096000000, "subject": "ABB", "severity": "warning",
        "message": "ABB: stored daily candles lack 1 session it traded (Sun 8 Nov 2026).", "detail": { "missing": 1, "days": ["2026-11-08"] },
        "firstSeenAt": 1795100000000, "lastSeenAt": 1795100000000, "resolvedAt": null } ] }
```

## After a restart

What the hub does by itself when it starts again (details in [h2-design.md](h2-design.md)):

1. The persistent set (`HUB_LIVE_SYMBOLS` + pins) is subscribed upstream before any client connects.
2. `/v1/quotes` and stream snapshots answer from the stored last quotes (`source: "store"`) at once.
3. The session minutes since the previous run's last tick are downloaded from broker 1-minute
   history in the background (one call per symbol per day, 4 s apart, through the request budget),
   once the current minute has closed. They replace any tick-built minutes.
4. A stream client that reconnects with `Last-Event-ID` gets the snapshot, the bars it missed (the
   repaired ones once the repair has run; reconnect again or re-request candles if it hasn't yet),
   then live ticks. `/v1/candles` includes the repaired minutes.

## Background jobs (in the server)

- **NSE files**, in the evening IST: cash bhavcopy (after 17:30) and F&O bhavcopy (after 18:00)
  for any of the last 10 trading days not stored yet — on start that is the catch-up — then lots,
  the ban list (from 18:00 the next session's) and NSE's ticker renames (`symbolchange.csv`) once
  each evening (and on start when never fetched or over two days old), then the PR zip (after 17:30)
  for any of the last **60** days not stored yet: its board meetings are the results calendar, and
  meetings are announced weeks ahead (a new hub reads ~40 zips once, about a minute); its
  corporate-actions file adds to `/v1/corporate-actions` and the split factors. Each dataset
  is retried at most every 30 minutes.
  All NSE requests share one client: at most one per 1.1 s, browser headers, back-off on 403/429.
  Everything comes from NSE's archive host (`nsearchives.nseindia.com`); nothing from
  `www.nseindia.com`, whose JSON API hangs behind bot protection.
  The trade date inside each file (for the PR zip, in its board-meetings file's name) must match the
  day asked for; a file for another date is recorded as `mismatch` and asked for again in the
  evening (the PR zip: within the last 10 days). Some index files print their date month first
  (6 Apr 2023 as `04-06-2023`); a date that reads as the day asked for either way is that day.
- **Queued jobs** from the CLI, one at a time: broker backfills and NSE history downloads.
- **Data-quality checks** every minute and right after the evening import or an NSE history run: whatever changed
  since the last round (see [GET /v1/quality](#get-v1quality)), within 1.5 s a round (0.25 s in market hours); new
  findings go to the log (`data-quality finding`, a warning for problems and warnings).
- **Nightly backup** when `HUB_BACKUP_DIR` is set: once a day (at least 22 hours apart), never
  between 08:45 and 16:00 IST on weekdays, keeping the newest `HUB_BACKUP_KEEP` (default 7). Without
  the disk space for it ([data backup](#data-backup)) it is skipped with one warning in the log and
  tried again an hour later.

`HUB_JOBS=off` disables all of these (`hub data quality` still runs the checks on demand).

## Admin CLI

```bash
npm run hub -- data backfill --tf 1d --years 5                  # F&O stocks + NIFTY/BANKNIFTY/FINNIFTY
npm run hub -- data backfill --tf 15m --years 1 --symbols SBIN,INFY
npm run hub -- data nse-history                                 # NSE's archive since 1994 (cash), 2001 (F&O), 2010 (PR zip), 2012 (indices)
npm run hub -- data nse-history --from 2015-01-01 --only cash
npm run hub -- data nse-history --only indices                  # just the index file (~3,900 requests, 70 minutes)
npm run hub -- data status
npm run hub -- data symbols                                     # every F&O stock's history across its renames
npm run hub -- data symbols INFY TMPV [--date 2005-01-03] [--refresh]
npm run hub -- data adjustments [INFY …]                       # split/bonus factors: counts, or a listing's
npm run hub -- data adjustments --check [--symbols A,B] [--tolerance 0.005] [--json] [--rebuild]
npm run hub -- data history --check [--symbols A,B] [--tolerance 0.01] [--json]  # archive ↔ broker seam, renames
npm run hub -- data cancel <job id>
npm run hub -- data backup [--to ./backups] [--keep 7]
npm run hub -- data import-tradex --db <Tradex .cache/market.db> [--screener <Tradex .cache/screener>] [--dry-run]
npm run hub -- data quality [--full] [--check price_outlier] [--all] [--resolved] [--limit 40]
```

(In Docker: `docker compose exec hub node dist/cli.js data status`.)

- `--tf` is `1d`, `15m` or `5m` (`1m` is only fetched on demand, for its 30-day window); `--years` defaults to the most the broker serves (5 for daily, 1
  for intraday).
- Only one process calls the broker: whoever holds `data/owner.lock`. If the server is running,
  the CLI **queues** the backfill and the server runs it; otherwise the CLI runs it itself
  (Ctrl-C stops it).
- Background priority, so it never crowds out API requests. **Resumable**: symbols already stored
  are skipped, so re-running continues where it stopped. It **pauses in market hours**
  (09:15–15:30 IST) and when the day's background budget is spent; the server resumes paused jobs
  after the close or the next day.
- `data status` starts with the same health check as `/v1/status` (without the live feed, which
  only the server can see), then shows the owner process, broker login and today's budget, each NSE dataset's last
  session, candle counts, how much of the F&O universe is stored per timeframe, live prices (the
  persistent symbols, the last tick, queued or stopped gap repair) and recent jobs.

### data history

`hub data history --check [--symbols A,B,…] [--tolerance 0.01] [--json]`: what
[`/v1/candles` serves before the broker's window](#before-the-brokers-window), for every current F&O
stock (or the ones named), checked for the three ways the join can go wrong — **seam** (after
scaling, the archive's closes over the 20 sessions after the hand-over differ from the stored
series' by more than the tolerance), **jump** (last archive close → first stored open beyond 35%:
no market move) and **gap** (a session the listing traded, under the name it had that day, missing
from what is served: across a rename this is the join failing). Lists the stocks joined across a
rename or scaled; exits 1 on any problem. Meaningful against a broker's series (in end-of-day mode
both sides are the archive).

### data nse-history

Downloads NSE's archive files for every session in a range into the same tables the evening run
fills: the cash bhavcopy (`cash_bhav`) back to NSE's first session on **3 Nov 1994**, with delivery %
from **2002**, the F&O bhavcopy (`fo_futures`, so `/v1/fo/members` and `/v1/fo/oi`) back to the
first stock futures on **9 Nov 2001**, the PR zip's board meetings (`results_events`, so past
results dates in `/v1/results-calendar`) and corporate actions (`corporate_actions`) back to
**2010** (2008 and 2009 answer 404), and NSE's index file (`index_closes`, so index candles —
[`/v1/indices`](#get-v1indices)) back to its start in **Feb 2012**. No broker calls. When a run
stops, the index candles and the synthetic baskets are rebuilt from what is stored, and every
[split and bonus factor](#split-and-bonus-adjustment) is derived again.

- `--from` defaults to 1994-11-03, `--to` to yesterday (IST); `--only cash`, `--only fo`,
  `--only pr` or `--only indices` for one dataset. Days already checked (`nse_days`) are never asked for again, so a later run only fills
  what's missing: run it once for the whole archive, then again whenever you like.
- NSE changed formats on **8 Jul 2024**. Before that the hub reads the old files:
  `cmDDMONYYYYbhav.csv.zip` + `MTO_DDMMYYYY.DAT` (delivery %) for cash, `foDDMONYYYYbhav.csv.zip`
  for F&O. The old F&O file has no previous close, lot or underlying price: those days' records
  have `prevClose` 0, `lot` and `underlying` null, and no OI buildup class.
- **Raw prices.** Bhavcopy prices are as traded: a split or bonus shows as a gap, and NSE's
  `prev_close` on the ex-date is usually just the previous close (not adjusted); the factors are kept
  apart ([Split and bonus adjustment](#split-and-bonus-adjustment)). Delisted stocks are included
  (nothing is filtered to today's list). Old tickers stay as NSE wrote them (`INFOSYSTCH` before
  2011, `TELCO` before 2004); `/v1/symbols/history` joins them to today's ticker. `/v1/candles`
  serves these rows with `adjust=none` (one ticker at a time), and in end-of-day mode adjusted.
- **ISINs.** Old-format cash days from 2011 carry each security's ISIN, recorded as the day is stored
  (`isin_symbols`, for renames). Stored days whose ISINs weren't read — downloaded before the hub kept
  them — have just their cash file read again, once, whenever the cash market is included: about 3,400
  requests (an hour) for 2011 to 5 Jul 2024. Prices and delivery % already stored are left alone.
- **Corporate actions.** Likewise stored PR days whose `bc` file wasn't read (downloaded before the
  hub kept it) have their PR zip read again, once, whenever the PR zip is included: about 4,200
  requests (1.3 hours) for 2010 on. Results already stored are left alone.
- Every weekend day is asked for in the cash market: NSE held Budget-day, Muhurat and special
  sessions on weekends (e.g. 1 Feb 2020, 12 Nov 2023, 20 Jan 2024). F&O, the PR zip and the index
  file are asked for the weekend days the cash market traded.
- One request per 1.1 s, like every NSE request: the whole archive is about 32,000 requests,
  **nine to ten hours** (PR zips are 0.3–0.7 MB each; only their results rows are kept), and about
  **1.5 GB** in `hub.db` (~0.5 GB per gzipped backup; [Disk space](#disk-space)). Years go newest
  first.
- Same rules as backfills: queued for the server when one is running, run here otherwise (Ctrl-C
  stops it); **pauses in market hours** and for 15 minutes after NSE refuses three days in a row;
  resumes on its own. History runs aren't recorded as the evening run's attempts, so they never
  delay it.
- **Disk:** the CLI refuses to start (or queue) it while free space on the database's disk is under
  `HUB_DISK_MIN_GB` (default 2 GB), and a running job checks before every file and **pauses** below
  it with a message saying so; the server retries every 30 minutes, so it carries on once space is
  freed. Leave room for what it adds ([Disk space](#disk-space)).

### data symbols

Ticker renames from the store (see [/v1/symbols](#ticker-renames-v1symbols)). With tickers, each
one's listing as of `--date` (default today): its names, the stored cash sessions under each, and
whether the history runs on across each rename. Without, the same for **every current F&O stock that
was ever renamed**, with a count of those continuous across every rename, with a gap, and not stored
on both sides; it exits 1 when any has a gap. `--refresh` downloads NSE's `symbolchange.csv` first
(when no hub server owns the NSE connection; the server refreshes it each evening). Read-only
otherwise, so it may run alongside the server.

### data adjustments

The [split and bonus factors](#split-and-bonus-adjustment). Without arguments: how many, by source,
for how many tickers, and how many corporate actions are stored. With tickers: each one's listing and
its factors (date, ticker that day, factor, source, the closes and `PREV_CLOSE` behind it, NSE's
purpose). `--rebuild` derives every factor again first (in end-of-day mode it drops the stored daily
series whose factors changed).

`--check` compares them with the **broker's adjusted daily history** — every stored daily stock
series (Fyers adjusts its ~5 years for splits, bonuses, demergers and rights issues), joined to NSE's
raw closes across renames. For consecutive overlapping sessions the broker's factor is
`(B(t1)/R(t1)) / (B(t2)/R(t2))` (B its close, R NSE's) and ours the product of the factors between;
every step where they differ by more than `--tolerance` (default 0.005 = 0.5%) is listed with a
reason, from the corporate actions within 5 days:

| Reason | Meaning |
|---|---|
| `data_error` | one bar differs and the next session agrees again (a bad bar on one side) |
| `broker_stale` | the stored broker series was downloaded before the ex-date and extended from the bhavcopy since, so never adjusted |
| `dividend` | only a dividend near the date (the broker adjusted for it; split factors don't) |
| `rights` | a rights issue whose price NSE doesn't give (`RIGHTS 5:9`) or that one side doesn't adjust for |
| `demerger` | a demerger or scheme of arrangement |
| `unexplained` | none of these (often: no `bc` file stored for those days) |

It also reports how many overlapping sessions' adjusted closes match the broker's (relative to the
newest one) and how many ex-dates agree. Exit code 1 when anything is `unexplained`. `--json` prints
the whole report. In end-of-day mode the stored series are built from the factors themselves, so the
check says so; it is meant for a hub with a broker. Read-only (unless `--rebuild`), so it may run
alongside the server.

### data quality

Runs the [data-quality checks](#get-v1quality) on what is stored — only new or changed days, or every
stored day again with `--full` (about 10 to 60 s for eight years of sessions, depending on how much of the database is cached) — then
prints the open findings per check and lists the problems and warnings (`--all` adds info, `--check`
picks one check, `--resolved` lists resolved ones). It only reads and writes the database, so it can
run while the server does. `data nse-history`, when it runs in the CLI, checks the days it
downloaded at the end; `data status` prints the open counts.

### data backup

A consistent snapshot through SQLite's online backup API — **safe while the server runs**. The copy
is written under a temporary name, switched to a single self-contained file (no `-wal`/`-shm`),
checked with `quick_check`, **gzipped** to `hub-YYYYMMDD-HHMMSS.db.gz` (UTC), read back (gzip's
checksum, and the size must match), and only then renamed into place; the uncompressed copy is
deleted. Older ones beyond `--keep` (default `HUB_BACKUP_KEEP`, 7) are deleted — uncompressed
`hub-*.db` backups from before compression count and rotate out the same way. `--to` defaults to
`HUB_BACKUP_DIR`, else `./backups`.

Only compressed backups are kept: an uncompressed newest copy would save one `gunzip` at restore
time (a couple of seconds per GB) at the cost of the whole database's size again on disk.

- **Disk:** while it runs a backup needs room for the uncompressed copy next to the gzip. It
  doesn't start unless about **1.5 × the database** plus `HUB_DISK_MIN_GB` is free on the backup
  disk, and it stops and removes its files if free space falls under `HUB_DISK_MIN_GB` while it
  writes (checked every 64 MB). Leftovers of a backup that died (`*.partial`, over 6 hours old) are
  removed by the next one.
- Time: about 40 s for a 1.5 GB database on a laptop (copy, check, gzip, read-back); the nightly
  one runs outside market hours and never blocks requests.

**Restore:** stop the hub; unzip the backup over `hub.db` in `HUB_DATA_DIR`
(`gunzip -c backups/hub-20261109-183000.db.gz > data/hub.db`); delete `hub.db-wal` and `hub.db-shm`
next to it; start the hub. An older uncompressed `hub-*.db` is copied over as it is. (The broker
token file isn't in the backup; the hub logs in again.) Keep a copy off the machine too — see
[oracle.md](oracle.md#backups).

### data import-tradex

Brings a Tradex install's stored data into the hub, without broker or NSE calls. Step by step:
[migrate-tradex.md](migrate-tradex.md).

- **Refuses while a hub server owns the data directory** (`owner.lock`); stop the server first.
  `--dry-run` only reads, so it may run alongside it.
- **Candles** from Tradex's `series`/`candles`: `NSE:SBIN-EQ:D|15|5` → `SBIN` `1d|15m|5m`;
  `NSE:NIFTY50-INDEX` → `NIFTY` (and the other indices the hub knows). Other resolutions, BSE and
  non-equity keys are skipped and listed. Coverage claimed = from Tradex's `covered_from` (rounded up
  to a bar) to the end of its newest bar, but never past the bars that were final when Tradex synced
  — a bar stored mid-session is left out and fetched by the hub like any tail. A series with a
  malformed bar is skipped whole. When the hub already has the series: already covered → unchanged;
  ranges touch or overlap → only bars outside the hub's coverage are added and the coverage grows
  (the hub's own bars win); a gap between them → skipped; overlapping closes differ by over 1 %
  (split/bonus adjusted on one side only) → skipped.
- **Cash bhavcopy** (delivery %) from `screener/bhav/DDMMYYYY.json`. Tradex never checked the date
  inside NSE's file, so each day is checked against stored daily closes (≥ 90 % of the symbols
  within 0.5 % when at least 5 can be compared); a day with no session in the candles, or a file
  identical to its neighbour's that the candles can't place, is skipped. Imported days are marked
  `ok` in `nse_days` with note `imported from Tradex`, and `series` is recorded as `EQ/BE` (Tradex's
  cache doesn't say which). `null` files become `holiday` unless the candles show a session.
  `screener/daily/*.json` isn't imported (no coverage record); the report counts what it holds.
- **F&O bhavcopy**: `fo_bhav_days` + `fo_futures` copied as they are (same parser and columns). A
  day the hub already has stays; a stored file replaces a hub `holiday`/`mismatch`; a day whose row
  count doesn't match its record is skipped.
- Each series and day is its own transaction; anything already in the hub is left alone, so a
  second run changes nothing and an interrupted run can simply be run again.

## Disk space

Measured on a synthetic database shaped like the real thing (`hub.db` page sizes from SQLite's
`dbstat`, backups made with the hub's own `backupDb`): random-walk prices on NSE's 0.05 tick, so
they compress *less* than real prices — treat the backup sizes as an upper bound.

| What | Rows | In `hub.db` | One backup (gzipped) |
|---|---|---|---|
| Empty hub, keys, reference files, a few weeks of evening runs | — | a few MB | under 1 MB |
| NSE history, cash bhavcopy (`cash_bhav` + its day index), 3 Nov 1994 → Nov 2026 | 12.1 M (7,809 sessions, ~800 → ~2,300 a day) | 1.35 GB | |
| NSE history, F&O futures (`fo_futures` + index), 9 Nov 2001 → Nov 2026 | 0.78 M (~40 → ~215 underlyings a day) | 0.14 GB | |
| **NSE history, both** (`hub data nse-history`) | | **1.49 GB** | **0.52 GB** (2.9×) |
| Broker candles for the F&O universe + indices (230 series: 1d × 5 y, 15m × 1 y, 5m × 1 y) | 6.3 M | 0.44 GB | 0.12 GB (3.7×) |
| Live 1-minute bars (`HUB_LIVE_RETENTION_DAYS` 30: ~21 sessions × 375 minutes per symbol) | ~7,900 per symbol | ~0.7 MB per symbol kept live (estimate, not measured) | |
| Each further year of evening runs (cash ~2,300 + F&O ~215 rows a session) | ~0.6 M | ~75 MB | ~25 MB |

**A full history run plus a week of backups**, with broker candles too (~1.9 GB database, ~0.64 GB
per backup):

| | Space |
|---|---|
| `hub.db` (plus a WAL of up to a few MB) | 1.9 GB |
| 7 nightly backups (`HUB_BACKUP_KEEP=7`) | 4.5 GB |
| While a backup runs: the uncompressed copy + the new gzip (before the oldest rotates out) | +2.6 GB |
| **Peak** | **≈ 9 GB**, plus `HUB_DISK_MIN_GB` (2 GB) kept free → **plan for 11–12 GB** |

Before compression the same week needed ~17 GB (eight full copies at the peak). NSE history alone
(no broker candles): ~1.5 GB database, ~0.52 GB per backup, ~7 GB at the peak.

How the hub protects the disk: `/v1/status` **warns** under `HUB_DISK_WARN_GB` (5 GB) and reports a
**problem** under `HUB_DISK_MIN_GB` (2 GB) free, for the database's disk and the backups' (if
separate); `hub data nse-history` won't start below the floor and a running one pauses there;
a backup won't start without ~1.5 × the database plus the floor free, and stops (removing its files)
if it drops under the floor. `HUB_DISK_MIN_GB=0` turns the floor off. `hub data status` prints the
free space and what the backups take.

## Schema (SQLite, `data/hub.db`)

| Table | Contents |
|---|---|
| `api_keys` | key hashes, scopes, last use (H0) |
| `series` | per (symbol, tf ∈ 1d/15m/5m/1m): coverage `[covered_from, covered_to)` of final bars, `synced_at`, count, first/last bar |
| `candles` | (symbol, tf, t) → o, h, l, c, v |
| `nse_days` | per (dataset ∈ cash_bhav/fo_bhav/pr, day): `ok` / `holiday` / `mismatch`, rows (for `pr`: results events), checked time, note (`imported from Tradex` for imported days) |
| `cash_bhav` | (symbol, day) → series (`EQ`/`BE`; `EQ/BE` on days imported from Tradex), prev close, OHLC, volume, delivery % |
| `fo_futures` | (day, symbol) → near/next month close, settle, prev close, volume, OI, ΔOI; combined OI and ΔOI; lot; underlying |
| `lot_sizes` | symbol → lot |
| `fo_ban` | trade date → symbols |
| `results_events` | (symbol, meeting date) → company, purpose; from the PR zips' board meetings |
| `corporate_actions` | (symbol, ex-date, purpose) → series, company, record date, kinds, price ratio, first/last PR day that listed it; from the PR zips' `bc` files |
| `corporate_action_days` | PR days whose `bc` file was read, with how many rows |
| `adjustment_factors` | (symbol, ex-date) → factor, source (`prev_close` / `corporate_action` / `price_gap`), the previous session, its close, the file's `PREV_CLOSE`, open, close, NSE's purpose, `renamed_from` |
| `symbol_changes` | NSE's `symbolchange.csv`: (old symbol, effective date) → new symbol, company |
| `isin_symbols` | (ISIN, symbol) → first and last stored day it traded under that ticker (old-format cash files, 2011–2024) |
| `isin_days` | old-format cash days whose ISINs were read, with how many |
| `datasets` | per dataset: last attempt, last success, last error, info; failures in a row and since when |
| `kv` | small hub state: the broker budget (today's counts, strikes, cooldown), the live heartbeat (`live.heartbeat`: when the last run was known alive) and the gap-repair queue (`live.recovery`) |
| `jobs` | queued jobs (`backfill`, `nse_history`): params, state, progress, resume time |
| `live_quotes` | symbol → the last tick (ltp, change, day OHLC, cumulative volume, trade and receive times, source) |
| `live_bars_1m` | (symbol, t) → o, h, l, c, v, source `live` (from ticks) or `broker` (repaired; never replaced by a live write). Kept `HUB_LIVE_RETENTION_DAYS` |
| `live_subscriptions` | the persistent set: symbol → origin `config` (`HUB_LIVE_SYMBOLS`) or `pin` (API), added time |
| `quality_findings` | (check, trade day, subject) → severity, message, detail (JSON), first / last seen, resolved (migration 8; 7 is held for split/bonus factors, market-data-hub#20) |
| `quality_checked` | (check, trade day) → when the per-day checks looked at it |

Other files in the data directory: `fyers-token.json` (mode 600, the broker access token),
`owner.lock` (pid of the process that owns the broker/NSE connection) and `fyers-sdk/` (mode 700,
the broker socket SDK's own log files).
