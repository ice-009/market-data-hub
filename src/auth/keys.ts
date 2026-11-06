import { createHash, randomBytes } from "node:crypto";
import type { Db } from "../db.js";

// API keys. A key is shown once when it's created; only its SHA-256 hash is
// stored, so a copy of the database doesn't give anyone access. Each key carries
// scopes that say which endpoints it may call.

export const SCOPES = ["history", "live", "fo", "admin"] as const;
export type Scope = (typeof SCOPES)[number];

export interface ApiKey {
  id: string;
  name: string;
  scopes: Scope[];
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

interface Row {
  id: string;
  name: string;
  scopes: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

const KEY_PREFIX = "mdh_";
const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");
const toKey = (row: Row): ApiKey => ({
  id: row.id,
  name: row.name,
  scopes: row.scopes.split(",").filter(Boolean) as Scope[],
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at,
  revokedAt: row.revoked_at,
});

export function parseScopes(raw: string): Scope[] {
  const scopes = [...new Set(raw.split(",").map((scope) => scope.trim()).filter(Boolean))];
  const unknown = scopes.filter((scope) => !(SCOPES as readonly string[]).includes(scope));
  if (unknown.length) throw new Error(`Unknown scope(s): ${unknown.join(", ")}. Choose from ${SCOPES.join(", ")}.`);
  if (!scopes.length) throw new Error(`Give at least one scope (${SCOPES.join(", ")}).`);
  return scopes as Scope[];
}

/** Create a key. The returned `key` is the only time the secret exists in clear text. */
export function createKey(db: Db, name: string, scopes: Scope[], now = Date.now()): { key: string; record: ApiKey } {
  if (!name.trim()) throw new Error("A key needs a name (e.g. the project that will use it).");
  const key = KEY_PREFIX + randomBytes(32).toString("base64url");
  const id = `key_${randomBytes(6).toString("hex")}`;
  db.prepare("insert into api_keys (id, name, hash, scopes, created_at) values (?, ?, ?, ?, ?)").run(id, name.trim(), hashKey(key), scopes.join(","), now);
  return { key, record: { id, name: name.trim(), scopes, createdAt: now, lastUsedAt: null, revokedAt: null } };
}

/** The active key matching a presented secret, or null. Records when it was last used. */
export function verifyKey(db: Db, presented: string, now = Date.now()): ApiKey | null {
  if (!presented.startsWith(KEY_PREFIX)) return null;
  const row = db.prepare("select * from api_keys where hash = ? and revoked_at is null").get(hashKey(presented)) as Row | undefined;
  if (!row) return null;
  db.prepare("update api_keys set last_used_at = ? where id = ?").run(now, row.id);
  return toKey({ ...row, last_used_at: now });
}

export function listKeys(db: Db): ApiKey[] {
  return (db.prepare("select * from api_keys order by created_at").all() as Row[]).map(toKey);
}

/** Revoke by id; returns false when there's no such active key. */
export function revokeKey(db: Db, id: string, now = Date.now()): boolean {
  return db.prepare("update api_keys set revoked_at = ? where id = ? and revoked_at is null").run(now, id).changes > 0;
}
