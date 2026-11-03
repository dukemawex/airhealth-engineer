/**
 * Minimal structured (JSON-lines) logger. Vercel captures stdout/stderr, so one
 * JSON object per line is searchable in the Vercel log viewer and any drain.
 * Values under keys that look like secrets are redacted before writing.
 */

type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SECRET_KEY_PATTERN = /(api[-_]?key|token|secret|authorization|password|cookie)/i;

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

function currentLevel(): Level {
  const raw = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  return raw in LEVEL_ORDER ? (raw as Level) : "info";
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth-limit]";
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_PATTERN.test(k) ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

function write(level: Level, msg: string, base: LogFields, fields?: LogFields) {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel()]) return;
  const entry = {
    time: new Date().toISOString(),
    level,
    msg,
    service: "airhealth-engineer",
    ...(redact({ ...base, ...(fields ?? {}) }) as LogFields),
  };
  let line: string;
  try {
    line = JSON.stringify(entry);
  } catch {
    line = JSON.stringify({ time: entry.time, level, msg, note: "unserializable fields" });
  }
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

export function createLogger(base: LogFields = {}): Logger {
  return {
    debug: (m, f) => write("debug", m, base, f),
    info: (m, f) => write("info", m, base, f),
    warn: (m, f) => write("warn", m, base, f),
    error: (m, f) => write("error", m, base, f),
    child: (fields) => createLogger({ ...base, ...fields }),
  };
}

export const logger = createLogger();
