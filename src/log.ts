// JSON-lines logger with a scrubber. Every line passes through `redact`, which
// removes the configured secret values, bearer tokens and hub API keys wherever
// they appear — including inside error messages from libraries we don't control.

export type Level = "debug" | "info" | "warn" | "error";
const RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Hub API keys look like `mdh_` + 43 base64url characters. */
const KEY_PATTERN = /mdh_[A-Za-z0-9_-]{20,}/g;
const BEARER_PATTERN = /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;

export function redact(text: string, secrets: string[]): string {
  let out = text.replace(KEY_PATTERN, "mdh_[redacted]").replace(BEARER_PATTERN, "$1[redacted]");
  // Longest first, so a secret that contains another is removed whole.
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) out = out.split(secret).join("[redacted]");
  return out;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export function createLogger(options: { level: Level; secrets: string[]; write?: (line: string) => void }): Logger {
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const emit = (level: Level, msg: string, fields?: Record<string, unknown>) => {
    if (RANK[level] < RANK[options.level]) return;
    const entry = { time: new Date().toISOString(), level, msg, ...fields };
    const json = JSON.stringify(entry, (_key, value: unknown) => (value instanceof Error ? { name: value.name, message: value.message } : value));
    write(redact(json, options.secrets));
  };
  return {
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
  };
}
