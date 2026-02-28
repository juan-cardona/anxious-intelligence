/**
 * Structured Logging — production-grade logging with levels, context, and output formatting.
 *
 * Features:
 * - Structured JSON output for machine parsing
 * - Human-readable console output for development
 * - Log levels: debug, info, warn, error, fatal
 * - Contextual metadata (module, belief_id, session_id, etc.)
 * - Ring buffer for recent logs (accessible via API)
 * - Performance timing helpers
 */

export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  fatal: 4,
};

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: "\x1b[90m",   // gray
  info: "\x1b[36m",    // cyan
  warn: "\x1b[33m",    // yellow
  error: "\x1b[31m",   // red
  fatal: "\x1b[35;1m", // bold magenta
};

const RESET = "\x1b[0m";

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  module: string;
  message: string;
  data?: Record<string, any>;
  error?: { message: string; stack?: string };
  duration_ms?: number;
}

// ── Configuration ─────────────────────────────────────────────────

const MIN_LEVEL: LogLevel = (process.env.LOG_LEVEL as LogLevel) ?? "info";
const JSON_OUTPUT = process.env.LOG_FORMAT === "json";
const MAX_RING_SIZE = 500;

// ── Ring Buffer ───────────────────────────────────────────────────

const ringBuffer: LogEntry[] = [];

export function getRecentLogs(count = 100, minLevel: LogLevel = "info"): LogEntry[] {
  const minPriority = LEVEL_PRIORITY[minLevel];
  return ringBuffer
    .filter((e) => LEVEL_PRIORITY[e.level] >= minPriority)
    .slice(-count);
}

// ── Core Logger ───────────────────────────────────────────────────

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[MIN_LEVEL];
}

function emit(entry: LogEntry): void {
  // Add to ring buffer
  ringBuffer.push(entry);
  if (ringBuffer.length > MAX_RING_SIZE) {
    ringBuffer.splice(0, ringBuffer.length - MAX_RING_SIZE);
  }

  if (!shouldLog(entry.level)) return;

  if (JSON_OUTPUT) {
    const obj: any = { ...entry };
    if (entry.error) {
      obj.error = { message: entry.error.message, stack: entry.error.stack };
    }
    process.stderr.write(JSON.stringify(obj) + "\n");
  } else {
    const color = LEVEL_COLORS[entry.level];
    const lvl = entry.level.toUpperCase().padEnd(5);
    const mod = entry.module.padEnd(16);
    let line = `${color}${lvl}${RESET} ${"\x1b[90m"}${mod}${RESET} ${entry.message}`;
    if (entry.duration_ms !== undefined) {
      line += ` ${"\x1b[90m"}(${entry.duration_ms}ms)${RESET}`;
    }
    if (entry.data && Object.keys(entry.data).length > 0) {
      line += ` ${"\x1b[90m"}${JSON.stringify(entry.data)}${RESET}`;
    }
    if (entry.error) {
      line += `\n  ${"\x1b[31m"}${entry.error.message}${RESET}`;
      if (entry.error.stack && entry.level !== "warn") {
        line += `\n${entry.error.stack.split("\n").slice(1, 4).join("\n")}`;
      }
    }
    console.error(line);
  }
}

// ── Logger Factory ────────────────────────────────────────────────

export interface Logger {
  debug(msg: string, data?: Record<string, any>): void;
  info(msg: string, data?: Record<string, any>): void;
  warn(msg: string, data?: Record<string, any>): void;
  error(msg: string, err?: Error | unknown, data?: Record<string, any>): void;
  fatal(msg: string, err?: Error | unknown, data?: Record<string, any>): void;
  time(label: string): () => number; // returns stop function that returns duration_ms
  child(submodule: string): Logger;
}

export function createLogger(module: string): Logger {
  function makeEntry(level: LogLevel, msg: string, data?: Record<string, any>, err?: Error | unknown): LogEntry {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      module,
      message: msg,
    };
    if (data && Object.keys(data).length > 0) entry.data = data;
    if (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      entry.error = { message: e.message, stack: e.stack };
    }
    return entry;
  }

  return {
    debug(msg, data) { emit(makeEntry("debug", msg, data)); },
    info(msg, data) { emit(makeEntry("info", msg, data)); },
    warn(msg, data) { emit(makeEntry("warn", msg, data)); },
    error(msg, err, data) { emit(makeEntry("error", msg, data, err)); },
    fatal(msg, err, data) { emit(makeEntry("fatal", msg, data, err)); },
    time(label) {
      const start = performance.now();
      return () => {
        const duration_ms = Math.round(performance.now() - start);
        emit({ ...makeEntry("debug", label), duration_ms });
        return duration_ms;
      };
    },
    child(submodule) {
      return createLogger(`${module}:${submodule}`);
    },
  };
}
