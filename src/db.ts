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

export type Db = Database.Database;

const MIGRATIONS: string[] = [
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
    if (done.has(i)) return;
    db.transaction(() => {
      db.exec(sql);
      db.prepare("insert into _migrations (id, applied_at) values (?, ?)").run(i, Date.now());
    })();
  });
}
