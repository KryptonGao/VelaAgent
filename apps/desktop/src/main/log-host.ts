import { app, BrowserWindow, dialog, ipcMain, shell, type WebContents } from "electron";
import { buildLogEntry, createLogger, isLogLevel, LogsIpc, serializeError, writeLogEntry, type LogExportOptions, type LogExportResult } from "@vela/shared";
import { writeFile } from "node:fs/promises";
import { arch, cpus, freemem, platform, release, totalmem, type as osType, uptime } from "node:os";
import { join } from "node:path";
import { buildDiagnosticsBundle, diagnosticsFileName } from "./log-export";
import type { LogService } from "./log-service";

const log = createLogger("logs");
const crashLog = createLogger("crash");
const maxMessage = 4 * 1024;
const maxData = 16 * 1024;
const rendererBudgetPerSecond = 50;

export interface LogHostOptions {
  home: string;
  agentDir: string;
  activeConversationId: () => string | null;
  mcpCatalog?: () => Promise<unknown>;
  locale?: () => string;
}

export function systemInfo(locale?: string): Record<string, unknown> {
  const cpu = cpus();
  return {
    app: { name: app.getName(), version: app.getVersion(), packaged: app.isPackaged, locale: locale ?? app.getLocale() },
    versions: { ...process.versions },
    os: { platform: platform(), type: osType(), release: release(), arch: arch(), systemVersion: process.getSystemVersion?.() },
    cpu: { model: cpu[0]?.model, cores: cpu.length },
    memory: { totalBytes: totalmem(), freeBytes: freemem() },
    uptimeSeconds: { system: Math.round(uptime()), process: Math.round(process.uptime()) },
  };
}

/** Uncaught errors in Main and crashes of renderer/child processes are written to the log before anything else happens. */
export function installCrashHandlers(service: LogService): void {
  process.on("uncaughtException", (error, origin) => {
    crashLog.error(`uncaught exception (${origin})`, error);
    service.flush();
    // A listener suppresses Electron's default error box; keep showing it.
    dialog.showErrorBox("A JavaScript error occurred in the main process", `Uncaught Exception:\n${error?.stack ?? String(error)}`);
  });
  process.on("unhandledRejection", reason => {
    crashLog.error("unhandled promise rejection", reason instanceof Error ? reason : { reason: String(reason) });
    service.flush();
  });
  app.on("render-process-gone", (_event, contents, details) => {
    crashLog.error("render process gone", { url: safeUrl(contents), reason: details.reason, exitCode: details.exitCode });
    service.flush();
  });
  app.on("child-process-gone", (_event, details) => {
    crashLog.error("child process gone", { type: details.type, name: details.name, serviceName: details.serviceName, reason: details.reason, exitCode: details.exitCode });
    service.flush();
  });
  app.on("web-contents-created", (_event, contents) => {
    contents.on("unresponsive", () => crashLog.warn("web contents unresponsive", { url: safeUrl(contents) }));
    contents.on("responsive", () => crashLog.info("web contents responsive again", { url: safeUrl(contents) }));
  });
}

function safeUrl(contents: WebContents): string | undefined {
  try {
    const url = new URL(contents.getURL());
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return undefined;
  }
}

export class LogHost {
  private window = { start: 0, count: 0, dropped: 0 };

  constructor(private readonly service: LogService, private readonly options: LogHostOptions) {}

  register(): void {
    ipcMain.on(LogsIpc.write, (_event, raw) => this.writeRendererEntry(raw));
    ipcMain.handle(LogsIpc.getSettings, () => this.service.settings());
    ipcMain.handle(LogsIpc.setLevel, (_event, level) => {
      const settings = this.service.setLevel(level);
      log.info("log level changed", { level: settings.level });
      return settings;
    });
    ipcMain.handle(LogsIpc.openFolder, () => this.openFolder());
    ipcMain.handle(LogsIpc.export, (event, options) => {
      const includeTrace = !!(options as Partial<LogExportOptions> | null)?.includeTrace;
      return this.exportBundle(BrowserWindow.fromWebContents(event.sender), { includeTrace });
    });
  }

  async openFolder(): Promise<void> {
    this.service.flush();
    const error = await shell.openPath(this.service.dir);
    if (error) throw new Error(error);
  }

  async exportBundle(win: BrowserWindow | null, options: LogExportOptions): Promise<LogExportResult | null> {
    const dialogOptions = {
      defaultPath: join(app.getPath("downloads"), diagnosticsFileName()),
      filters: [{ name: "ZIP", extensions: ["zip"] }],
    };
    const selection = win ? await dialog.showSaveDialog(win, dialogOptions) : await dialog.showSaveDialog(dialogOptions);
    if (selection.canceled || !selection.filePath) return null;
    log.info("exporting diagnostics bundle", { includeTrace: options.includeTrace });
    this.service.flush();
    const bundle = await buildDiagnosticsBundle({
      home: this.options.home,
      agentDir: this.options.agentDir,
      logFiles: this.service.file.files(),
      systemInfo: systemInfo(this.options.locale?.()),
      includeTrace: options.includeTrace,
      conversationId: this.options.activeConversationId(),
      mcpCatalog: this.options.mcpCatalog,
    });
    await writeFile(selection.filePath, bundle, { mode: 0o600 });
    shell.showItemInFolder(selection.filePath);
    return { path: selection.filePath };
  }

  /** Renderer entries are untrusted: validate shape, cap size and rate. */
  writeRendererEntry(raw: unknown, now = Date.now()): void {
    if (!raw || typeof raw !== "object") return;
    const input = raw as Record<string, unknown>;
    if (!isLogLevel(input.level) || typeof input.msg !== "string") return;
    if (now - this.window.start >= 1000) {
      if (this.window.dropped > 0) {
        writeLogEntry(buildLogEntry("warn", "renderer", `dropped ${this.window.dropped} log entries (rate limit)`, undefined, "renderer"));
      }
      this.window = { start: now, count: 0, dropped: 0 };
    }
    if (++this.window.count > rendererBudgetPerSecond) { this.window.dropped++; return; }
    const scope = typeof input.scope === "string" && input.scope ? `renderer:${input.scope.slice(0, 64)}` : "renderer";
    const entry = buildLogEntry(input.level, scope, truncate(input.msg, maxMessage), input.data, "renderer");
    if (entry.data !== undefined) {
      const text = JSON.stringify(entry.data);
      if (text.length > maxData) entry.data = truncate(text, maxData);
    }
    if (input.err !== undefined) {
      const err = serializeError(Object.assign(new Error(), normalizeRendererError(input.err)));
      err.message = truncate(err.message, maxMessage);
      if (err.stack) err.stack = truncate(err.stack, maxData);
      entry.err = err;
    }
    writeLogEntry(entry);
  }

  dispose(): void {
    ipcMain.removeAllListeners(LogsIpc.write);
    for (const channel of [LogsIpc.getSettings, LogsIpc.setLevel, LogsIpc.openFolder, LogsIpc.export]) ipcMain.removeHandler(channel);
  }
}

function normalizeRendererError(value: unknown): { name: string; message: string; stack: string } {
  const input = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return {
    name: typeof input.name === "string" ? input.name.slice(0, 200) : "Error",
    message: typeof input.message === "string" ? input.message : String(value),
    stack: typeof input.stack === "string" ? input.stack : "",
  };
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…[truncated ${text.length - limit}]` : text;
}
