import { createKey, listKeys, parseScopes, revokeKey } from "./auth/keys.js";
import { loadConfig } from "./config.js";
import { openDb } from "./db.js";

// Admin CLI, run on the machine that hosts the hub (it opens the database
// directly; there is no remote admin API).
//   npm run hub -- keys create tradex --scopes history,live,fo
//   npm run hub -- keys list
//   npm run hub -- keys revoke key_1a2b3c4d5e6f

const USAGE = `Usage:
  hub keys create <name> --scopes history,live,fo[,admin]
  hub keys list
  hub keys revoke <id>`;

const fmt = (ms: number | null) => (ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 19) : "—");

function run(args: string[]): number {
  const [group, action, ...rest] = args;
  if (group !== "keys" || !action) {
    console.log(USAGE);
    return group ? 1 : 0;
  }
  const db = openDb(loadConfig().dataDir);
  try {
    if (action === "create") {
      const name = rest.find((arg) => !arg.startsWith("--")) ?? "";
      const flag = rest.indexOf("--scopes");
      const scopes = parseScopes(flag >= 0 ? (rest[flag + 1] ?? "") : "");
      const { key, record } = createKey(db, name, scopes);
      console.log(`Created ${record.id} "${record.name}" with scopes ${record.scopes.join(", ")}.`);
      console.log("\nAPI key (shown once — store it in the client's .env):\n");
      console.log(`  ${key}\n`);
      return 0;
    }
    if (action === "list") {
      const keys = listKeys(db);
      if (!keys.length) console.log("No keys yet.");
      for (const key of keys) console.log(`${key.id}  ${key.name.padEnd(16)} ${key.scopes.join(",").padEnd(22)} created ${fmt(key.createdAt)}  last used ${fmt(key.lastUsedAt)}${key.revokedAt ? `  REVOKED ${fmt(key.revokedAt)}` : ""}`);
      return 0;
    }
    if (action === "revoke") {
      const ok = revokeKey(db, rest[0] ?? "");
      console.log(ok ? `Revoked ${rest[0]}.` : `No active key with id "${rest[0] ?? ""}".`);
      return ok ? 0 : 1;
    }
    console.log(USAGE);
    return 1;
  } catch (error) {
    console.error((error as Error).message);
    return 1;
  } finally {
    db.close();
  }
}

process.exit(run(process.argv.slice(2)));
