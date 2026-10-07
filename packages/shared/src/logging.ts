import { redactSensitive } from "./redaction";

/**
 * Process-wide logger facade. Main, the agent runtime and the renderer all log through
 * `createLogger(scope)`; the host process decides where entries go by installing sinks.
 * Entries written before any sink is installed are buffered (bounded) and replayed.
 */
export const logLevels = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof logLevels)[number];
export type LogProcess = "main" | "renderer";

export interface LogError {
  name: string;
  message: string;
  stack?: string;
  code?: string;
  cause?: LogError;
}

export interface LogEntry {
  /** ISO-8601 UTC timestamp. */
  ts: string;
  level: LogLevel;
  scope: string;
  msg: string;
  data?: unknown;
  err?: LogError;
  proc: LogProcess;
}

export interface LogSink {
  write(entry: LogEntry): void;
}

export interface Logger {
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
  child(scope: string): Logger;
}

export interface LogSettings {
  level: LogLevel;
  /** True when VELA_DEBUG forces debug level; the setting cannot be changed from the UI. */
  locked: boolean;
  dir: string;
}

export interface LogExportOptions {
  includeTrace: boolean;
}

export interface LogExportResult {
  path: string;
}

export interface LogsApi {
  write(entry: Pick<LogEntry, "level" | "scope" | "msg" | "data" | "err">): void;
  getSettings(): Promise<LogSettings>;
  setLevel(level: LogLevel): Promise<LogSettings>;
  openFolder(): Promise<void>;
  /** Resolves null when the save dialog is cancelled. */
  export(options: LogExportOptions): Promise<LogExportResult | null>;
}

export const LogsIpc = {
  write: "app:log",
  getSettings: "app:logs-get-settings",
  setLevel: "app:logs-set-level",
  openFolder: "app:logs-open-folder",
  export: "app:logs-export",
} as const;

const bufferLimit = 500;
let sinks: readonly LogSink[] | null = null;
let pending: LogEntry[] = [];
let threshold: LogLevel = "info";
let processName: LogProcess = "main";

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && (logLevels as readonly string[]).includes(value);
}

export function setLogLevel(level: LogLevel): void {
  threshold = level;
}

export function getLogLevel(): LogLevel {
  return threshold;
}

export function setLogProcess(name: LogProcess): void {
  processName = name;
}

export function shouldLog(level: LogLevel): boolean {
  return logLevels.indexOf(level) >= logLevels.indexOf(threshold);
}

/** Install the sinks for this process and replay anything logged before they existed. `null` returns to buffering. */
export function setLogSinks(next: readonly LogSink[] | null): void {
  sinks = next;
  if (!next) return;
  const replay = pending;
  pending = [];
  for (const entry of replay) dispatch(entry);
}

/** Send an already-built entry (e.g. one forwarded from the renderer) to the sinks. */
export function writeLogEntry(entry: LogEntry): void {
  if (!shouldLog(entry.level)) return;
  if (!sinks) {
    pending.push(entry);
    if (pending.length > bufferLimit) pending.splice(0, pending.length - bufferLimit);
    return;
  }
  dispatch(entry);
}

function dispatch(entry: LogEntry): void {
  for (const sink of sinks ?? []) {
    try { sink.write(entry); } catch { /* a failing sink must never break the caller */ }
  }
}

export function createLogger(scope: string): Logger {
  const emit = (level: LogLevel, msg: string, data?: unknown): void => {
    if (!shouldLog(level)) return;
    writeLogEntry(buildLogEntry(level, scope, msg, data, processName));
  };
  return {
    debug: (msg, data) => emit("debug", msg, data),
    info: (msg, data) => emit("info", msg, data),
    warn: (msg, data) => emit("warn", msg, data),
    error: (msg, data) => emit("error", msg, data),
    child: sub => createLogger(`${scope}:${sub}`),
  };
}

export function buildLogEntry(level: LogLevel, scope: string, msg: string, data: unknown, proc: LogProcess): LogEntry {
  const entry: LogEntry = { ts: new Date().toISOString(), level, scope, msg: redactSensitive(String(msg)) as string, proc };
  if (isErrorLike(data)) entry.err = serializeError(data);
  else if (data !== undefined) entry.data = redactSensitive(toLoggable(data));
  return entry;
}

function isErrorLike(value: unknown): value is Error {
  return value instanceof Error
    || (!!value && typeof value === "object" && typeof (value as Error).message === "string" && typeof (value as Error).stack === "string");
}

export function serializeError(error: unknown, depth = 0): LogError {
  if (!isErrorLike(error)) return { name: "NonError", message: redactSensitive(safeString(error)) as string };
  const result: LogError = {
    name: error.name || "Error",
    message: redactSensitive(error.message) as string,
  };
  if (error.stack) result.stack = redactSensitive(error.stack) as string;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" || typeof code === "number") result.code = String(code);
  const cause = (error as { cause?: unknown }).cause;
  if (cause !== undefined && depth < 3) result.cause = serializeError(cause, depth + 1);
  return result;
}

/** JSON-safe copy: drops functions, breaks cycles, bounds depth/width, serializes nested errors. */
export function toLoggable(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.length > 8192 ? `${value.slice(0, 8192)}…[${value.length - 8192} more]` : value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") return undefined;
  if (isErrorLike(value)) return serializeError(value);
  if (seen.has(value)) return "[Circular]";
  if (depth >= 6) return "[Object]";
  seen.add(value);
  if (Array.isArray(value)) {
    const items = value.slice(0, 100).map(item => toLoggable(item, depth + 1, seen));
    if (value.length > 100) items.push(`…[${value.length - 100} more]`);
    return items;
  }
  if (value instanceof Date) return value.toISOString();
  const output: Record<string, unknown> = {};
  let count = 0;
  for (const [key, item] of Object.entries(value)) {
    if (++count > 100) { output["…"] = "[truncated]"; break; }
    const next = toLoggable(item, depth + 1, seen);
    if (next !== undefined) output[key] = next;
  }
  return output;
}

function safeString(value: unknown): string {
  if (typeof value === "string") return value;
  try { return JSON.stringify(toLoggable(value)) ?? String(value); } catch { return String(value); }
}

/** Single-line human form used by console sinks: `[scope] msg {data}`. */
export function formatLogEntry(entry: LogEntry): string {
  let line = `[${entry.scope}] ${entry.msg}`;
  if (entry.data !== undefined) line += ` ${safeString(entry.data)}`;
  if (entry.err) line += `\n${entry.err.stack ?? `${entry.err.name}: ${entry.err.message}`}`;
  return line;
}
