import { createLogger, formatLogEntry, setLogLevel, setLogProcess, setLogSinks, type LogEntry, type LogLevel } from "@vela/shared";

export { createLogger };

const consoleMethods: Record<LogLevel, "debug" | "info" | "warn" | "error"> = { debug: "debug", info: "info", warn: "warn", error: "error" };
let installed = false;

/** Route renderer logs to the main-process log file (and to DevTools in dev builds); capture uncaught errors. */
export function installRendererLogging(): void {
  if (installed) return;
  installed = true;
  setLogProcess("renderer");
  const api = window.vela?.logs;
  setLogSinks([{
    write(entry: LogEntry) {
      if (import.meta.env.DEV || !api) console[consoleMethods[entry.level]](formatLogEntry(entry));
      try { api?.write({ level: entry.level, scope: entry.scope, msg: entry.msg, data: entry.data, err: entry.err }); } catch { /* window closing */ }
    },
  }]);
  void api?.getSettings().then(settings => setLogLevel(settings.level)).catch(() => undefined);

  const log = createLogger("window");
  window.addEventListener("error", event => {
    log.error(`uncaught error: ${event.message}`, event.error ?? { source: event.filename, line: event.lineno, column: event.colno });
  });
  window.addEventListener("unhandledrejection", event => {
    const reason: unknown = event.reason;
    log.error("unhandled promise rejection", reason instanceof Error ? reason : { reason: String(reason) });
  });
}

/** Keep the renderer's local threshold in step with the level chosen in Settings. */
export function applyRendererLogLevel(level: LogLevel): void {
  setLogLevel(level);
}
