import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

// One SQLite file holds everything: API keys, candles, NSE datasets, hub state.
// WAL mode lets the API read while background jobs write. Migrations are an
// ordered list; each runs once and is recorded. Never edit a shipped one —
// append a new one.
//
//   0  api_keys
//   1  series + candles        broker history per (symbol, base timeframe); see src/history/store.ts
//   2  NSE datasets            nse_days, cash_bhav, fo_futures, lot_sizes, fo_ban, results_events, datasets
//   3  hub state               kv (broker budget), jobs (queued backfills)
//   4  live prices             live_quotes, live_bars_1m, live_subscriptions; see src/live/store.ts
//   5  ticker renames          symbol_changes, isin_symbols, isin_days; see src/reference/renames.ts
//   6  index closes            index_closes (NSE's ind_close_all); see src/nse/store.ts
//   7  adjustments             corporate_actions, corporate_action_days, adjustment_factors; see src/history/adjustments.ts
//   8  data quality            quality_findings, quality_checked; datasets.failures; see src/quality/store.ts

export type Db = Database.Database;

// A hole (undefined) is a number reserved by work still in review: it's skipped,
// not recorded, so it runs when it lands even after later ones have run.
const MIGRATIONS: Array<string | undefined> = [
  `create table api_keys (
     id text primary key,
     name text not null,
     hash text not null unique,
     scopes text not null,
     created_at integer not null,
     last_used_at integer,
     revoked_at integer
   )`,
  // Coverage is one contiguous range per series: every final bar with
  // covered_from <= t < covered_to is stored (null = nothing yet). Bars are keyed
  // by start time (daily bars by IST day key).
  `create table series (
     symbol text not null,
     tf text not null,
     covered_from integer,
     covered_to integer,
     synced_at integer not null default 0,
     count integer not null default 0,
     first_t integer,
     last_t integer,
     primary key (symbol, tf)
   ) without rowid;
   create table candles (
     symbol text not null,
     tf text not null,
     t integer not null,
     o real not null, h real not null, l real not null, c real not null, v real not null,
     primary key (symbol, tf, t)
   ) without rowid;`,
  `create table nse_days (
     dataset text not null,
     day integer not null,
     status text not null,
     rows integer not null default 0,
     checked_at integer not null,
     note text,
     primary key (dataset, day)
   ) without rowid;
   create table cash_bhav (
     symbol text not null,
     day integer not null,
     series text not null,
     prev_close real not null,
     o real not null, h real not null, l real not null, c real not null, v real not null,
     deliv_pct real,
     primary key (symbol, day)
   ) without rowid;
   create index cash_bhav_day on cash_bhav (day);
   create table fo_futures (
     day integer not null,
     symbol text not null,
     nse_symbol text not null,
     expiries integer not null,
     lot real,
     underlying real,
     near_expiry integer not null,
     near_close real not null,
     near_settle real not null,
     near_prev_close real not null,
     near_volume real not null,
     near_oi real not null,
     near_chg_oi real not null,
     next_expiry integer,
     next_close real,
     next_settle real,
     next_prev_close real,
     next_volume real,
     next_oi real,
     next_chg_oi real,
     oi real not null,
     chg_oi real not null,
     primary key (day, symbol)
   ) without rowid;
   create index fo_futures_symbol on fo_futures (symbol, day);
   create table lot_sizes (symbol text primary key, lot integer not null);
   create table fo_ban (trade_date integer primary key, symbols text not null, fetched_at integer not null);
   create table results_events (
     symbol text not null,
     date integer not null,
     company text not null,
     purpose text not null,
     primary key (symbol, date)
   ) without rowid;
   create table datasets (
     name text primary key,
     last_attempt_at integer,
     last_success_at integer,
     last_error text,
     info text
   );`,
  `create table kv (key text primary key, value text not null, updated_at integer not null);
   create table jobs (
     id integer primary key autoincrement,
     kind text not null,
     params text not null,
     state text not null,
     done integer not null default 0,
     total integer not null default 0,
     failed integer not null default 0,
     message text not null default '',
     resume_after integer,
     created_at integer not null,
     started_at integer,
     finished_at integer,
     updated_at integer not null
   );`,
  // Live prices (H2). live_quotes: the last tick per symbol, so quotes survive a
  // restart. live_bars_1m: ticks folded into minute bars ('live') or minutes
  // downloaded to repair a gap ('broker', authoritative — a live write never
  // replaces one). The primary key serves (symbol, t) range reads; the index on t
  // serves the retention sweep. live_subscriptions: symbols kept subscribed
  // across restarts ('config' from HUB_LIVE_SYMBOLS, 'pin' from the API).
  `create table live_quotes (
     symbol text primary key,
     ltp real not null,
     ch real not null,
     chp real not null,
     open real not null,
     high real not null,
     low real not null,
     prev_close real not null,
     volume real not null,
     ltt integer not null,
     ts integer not null,
     source text not null,
     updated_at integer not null
   ) without rowid;
   create table live_bars_1m (
     symbol text not null,
     t integer not null,
     o real not null, h real not null, l real not null, c real not null, v real not null,
     source text not null check (source in ('live', 'broker')),
     primary key (symbol, t)
   ) without rowid;
   create index live_bars_1m_t on live_bars_1m (t);
   create table live_subscriptions (
     symbol text primary key,
     added_at integer not null,
     origin text not null check (origin in ('config', 'pin'))
   ) without rowid;`,
  // Ticker renames. symbol_changes: NSE's symbolchange.csv as downloaded (day =
  // the effective date, the first session under new_symbol). isin_symbols: which
  // ticker each ISIN traded under, and over which stored days (from the cash
  // bhavcopy's ISIN column, in NSE's old-format files from 2011 to 5 Jul 2024);
  // a change of ticker under one ISIN is a rename too. isin_days: old-format
  // cash days whose ISINs were read, so they're never asked for again.
  `create table symbol_changes (
     old_symbol text not null,
     new_symbol text not null,
     day integer not null,
     company text not null,
     primary key (old_symbol, day)
   ) without rowid;
   create index symbol_changes_new on symbol_changes (new_symbol, day);
   create table isin_symbols (
     isin text not null,
     symbol text not null,
     first_day integer not null,
     last_day integer not null,
     primary key (isin, symbol)
   ) without rowid;
   create index isin_symbols_symbol on isin_symbols (symbol);
   create table isin_days (day integer primary key, isins integer not null);`,
  // NSE's daily index file, every row as printed (name as NSE spelled it that
  // day). symbol is the hub ticker the name maps to (src/reference/indices.ts),
  // null for indices the hub doesn't serve; re-mapped when the list changes.
  `create table index_closes (
     day integer not null,
     name text not null,
     symbol text,
     o real, h real, l real,
     c real not null,
     points_change real,
     change_pct real,
     volume real,
     turnover_cr real,
     pe real, pb real, div_yield real,
     primary key (day, name)
   ) without rowid;
   create index index_closes_symbol on index_closes (symbol, day);`,
  // Split and bonus adjustment. corporate_actions: the PR zip's bc file, every
  // equity row as NSE wrote it (symbol = the ticker that day), with what the
  // purpose means for prices; first_day/last_day = the PR days that listed it.
  // corporate_action_days: PR days whose bc file was read. adjustment_factors:
  // one row per ex-date found in the cash bhavcopies — prices before `day`
  // times `factor` (volumes divided) give prices comparable with `day` on;
  // raw prices stay as they are in cash_bhav.
  `create table corporate_actions (
     symbol text not null,
     ex_day integer not null,
     purpose text not null,
     series text not null,
     company text not null,
     record_day integer,
     kinds text not null,
     ratio real,
     first_day integer not null,
     last_day integer not null,
     primary key (symbol, ex_day, purpose)
   ) without rowid;
   create index corporate_actions_ex on corporate_actions (ex_day);
   create table corporate_action_days (day integer primary key, rows integer not null);
   create table adjustment_factors (
     symbol text not null,
     day integer not null,
     factor real not null,
     source text not null,
     prev_day integer not null,
     prev_c real not null,
     prev_close real not null,
     o real not null,
     c real not null,
     action text,
     renamed_from text,
     primary key (symbol, day)
   ) without rowid;
   create index adjustment_factors_day on adjustment_factors (day);`,
  // Data-quality checks (src/quality): one row per finding, keyed by what it's
  // about (check, trade day, subject: a dataset, a symbol, or "fo"), kept after
  // it's resolved (resolved_at). quality_checked: the trade days each per-day
  // check has looked at, so the evening run and archive downloads check only
  // new days. datasets.failures / failing_since: refresh attempts failed in a
  // row and since when (health reports a dataset that keeps failing).
  `create table quality_findings (
     check_name text not null,
     day integer not null,
     subject text not null,
     severity text not null check (severity in ('problem', 'warning', 'info')),
     message text not null,
     detail text,
     first_seen_at integer not null,
     last_seen_at integer not null,
     resolved_at integer,
     primary key (check_name, day, subject)
   ) without rowid;
   create index quality_findings_open on quality_findings (resolved_at, day);
   create table quality_checked (
     check_name text not null,
     day integer not null,
     checked_at integer not null,
     primary key (check_name, day)
   ) without rowid;
   alter table datasets add column failures integer not null default 0;
   alter table datasets add column failing_since integer;`,
  // Re-check the days NSE history marked "mismatch" because of parser bugs
  // (market-data-hub#41, #42, #45): index files that print their date month
  // first (6 Apr 2023 as "04-06-2023", read as 4 Jun) and files whose date
  // couldn't be read at all (the 13 Jul 2020 cash bhavcopy's "13-Jul-20").
  // Without an nse_days row, the next `hub data nse-history` run asks for them again.
  `delete from nse_days where status = 'mismatch' and (
     note = 'file is for no date'
     or (dataset = 'index_close' and note = 'file is for ' || strftime('%Y-%d-%m', day / 1000, 'unixepoch'))
   );`,
];

/** Small JSON values the hub keeps between restarts (e.g. the broker budget). */
export function readKv<T>(db: Db, key: string): T | null {
  const row = db.prepare("select value from kv where key = ?").get(key) as { value: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

export function writeKv(db: Db, key: string, value: unknown, now = Date.now()) {
  db.prepare("insert into kv (key, value, updated_at) values (?, ?, ?) on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at").run(key, JSON.stringify(value), now);
}

export function openDb(dataDir: string, file = "hub.db"): Db {
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, file));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}

export function migrate(db: Db) {
  db.exec("create table if not exists _migrations (id integer primary key, applied_at integer not null)");
  const done = new Set((db.prepare("select id from _migrations").all() as { id: number }[]).map((row) => row.id));
  MIGRATIONS.forEach((sql, i) => {
    if (sql === undefined || done.has(i)) return;
    db.transaction(() => {
      db.exec(sql);
      db.prepare("insert into _migrations (id, applied_at) values (?, ?)").run(i, Date.now());
    })();
  });
}
