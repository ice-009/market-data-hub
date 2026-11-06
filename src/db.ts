import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

// One SQLite file holds everything (keys now; candles, F&O and reference data in
// later milestones). WAL mode lets the API read while background jobs write.
// Migrations are an ordered list; each runs once and is recorded.

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
];

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
