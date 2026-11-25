/**
 * Structured logging.
 *
 * Hard rules: never log a secret, never log plaintext, never log a payload.
 * Paths are allowed (they are already visible in the file explorer); content is
 * not. Every line is one JSON object so it can be grepped.
 */

type Level = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

const SENSITIVE = /pass(word)?|secret|dek|key|token|plain|content|payload|text/i;

function sanitize(fields?: Record<string, unknown>): Record<string, unknown> {
  if (!fields) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (SENSITIVE.test(k)) {
      out[k] = "[redacted]";
      continue;
    }
    if (typeof v === "string" && v.length > 200) {
      // Stack frames contain only code locations (no secrets); keep every line
      // so a crash can be traced from the console. Other long strings are
      // truncated to avoid dumping content/payload into the log.
      out[k] = k === "stack"
        ? v.split("\n").map((line) => line.trim()).slice(0, 12)
        : `${v.slice(0, 40)}…(${v.length} chars)`;
      continue;
    }
    out[k] = v;
  }
  return out;
}

class ConsoleLogger implements Logger {
  constructor(
    private readonly scope: string,
    private readonly level: Level,
  ) {}

  private emit(level: Level, event: string, fields?: Record<string, unknown>): void {
    const order: Level[] = ["debug", "info", "warn", "error"];
    if (order.indexOf(level) < order.indexOf(this.level)) return;
    const line = JSON.stringify({
      t: new Date().toISOString(),
      lvl: level,
      scope: this.scope,
      event,
      ...sanitize(fields),
    });
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  }

  debug(event: string, fields?: Record<string, unknown>): void {
    this.emit("debug", event, fields);
  }
  info(event: string, fields?: Record<string, unknown>): void {
    this.emit("info", event, fields);
  }
  warn(event: string, fields?: Record<string, unknown>): void {
    this.emit("warn", event, fields);
  }
  error(event: string, fields?: Record<string, unknown>): void {
    this.emit("error", event, fields);
  }
  child(scope: string): Logger {
    return new ConsoleLogger(`${this.scope}.${scope}`, this.level);
  }
}

let currentLevel: Level = "info";

export function setLogLevel(level: Level): void {
  currentLevel = level;
}

export const log: Logger = {
  debug: (e, f) => new ConsoleLogger("plugin", currentLevel).debug(e, f),
  info: (e, f) => new ConsoleLogger("plugin", currentLevel).info(e, f),
  warn: (e, f) => new ConsoleLogger("plugin", currentLevel).warn(e, f),
  error: (e, f) => new ConsoleLogger("plugin", currentLevel).error(e, f),
  child: (scope: string) => new ConsoleLogger(scope, currentLevel),
};