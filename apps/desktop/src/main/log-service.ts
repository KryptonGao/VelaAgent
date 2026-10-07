import { formatLogEntry, isLogLevel, setLogLevel, setLogSinks, type LogEntry, type LogLevel, type LogSettings, type LogSink } from "@vela/shared";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const logFilePattern = /^vela-(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.log$/;
const dayMs = 24 * 60 * 60 * 1000;

export interface FileLogSinkOptions {
  dir: string;
  /** Rotate the day's file to `.N.log` once it would exceed this size. */
  maxFileBytes?: number;
  retentionDays?: number;
  maxTotalBytes?: number;
  flushIntervalMs?: number;
  flushBatch?: number;
  /** Replaced by `~` so exported logs do not carry the account name. */
  homeDir?: string;
  now?: () => Date;
}

function localDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** JSONL day files under `<home>/logs`, batched appends, size rotation and retention cleanup. */
export class FileLogSink implements LogSink {
  readonly dir: string;
  private readonly maxFileBytes: number;
  private readonly retentionDays: number;
  private readonly maxTotalBytes: number;
  private readonly flushIntervalMs: number;
  private readonly flushBatch: number;
  private readonly homeDir: string;
  private readonly now: () => Date;
  private queue: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private currentSize: { file: string; bytes: number } | null = null;
  private failed = false;

  constructor(options: FileLogSinkOptions) {
    this.dir = options.dir;
    this.maxFileBytes = options.maxFileBytes ?? 10 * 1024 * 1024;
    this.retentionDays = options.retentionDays ?? 14;
    this.maxTotalBytes = options.maxTotalBytes ?? 100 * 1024 * 1024;
    this.flushIntervalMs = options.flushIntervalMs ?? 250;
    this.flushBatch = options.flushBatch ?? 50;
    this.homeDir = options.homeDir ?? homedir();
    this.now = options.now ?? (() => new Date());
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.cleanup();
  }

  write(entry: LogEntry): void {
    let line = JSON.stringify(entry);
    if (this.homeDir.length > 1) line = line.split(this.homeDir).join("~");
    this.queue.push(line);
    if (entry.level === "error" || this.queue.length >= this.flushBatch) this.flush();
    else if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.flushIntervalMs);
      this.timer.unref?.();
    }
  }

  /** Synchronous so it is safe from crash handlers and before-quit. */
  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.queue.length === 0) return;
    const text = `${this.queue.join("\n")}\n`;
    this.queue = [];
    try {
      const file = this.currentFile();
      const bytes = Buffer.byteLength(text, "utf8");
      let size = this.sizeOf(file);
      if (size > 0 && size + bytes > this.maxFileBytes) { this.rotate(file); size = 0; }
      appendFileSync(file, text, { encoding: "utf8", mode: 0o600 });
      this.currentSize = { file, bytes: size + bytes };
      this.failed = false;
    } catch (error) {
      // Never throw from logging; report the first failure of a streak to stderr only.
      if (!this.failed) process.stderr.write(`[vela] log write failed: ${(error as Error).message}\n`);
      this.failed = true;
      this.currentSize = null;
    }
  }

  currentFile(): string {
    return join(this.dir, `vela-${localDate(this.now())}.log`);
  }

  /** Log files, newest first. */
  files(): string[] {
    return this.entries().sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name)).map(entry => join(this.dir, entry.name));
  }

  /** Drop files past the retention window, then the oldest until under the size budget. */
  cleanup(): void {
    const current = this.currentFile();
    const cutoff = this.now().getTime() - this.retentionDays * dayMs;
    const entries = this.entries().sort((a, b) => b.mtimeMs - a.mtimeMs);
    let total = 0;
    for (const entry of entries) {
      const path = join(this.dir, entry.name);
      if (path === current) { total += entry.size; continue; }
      if (entry.mtimeMs < cutoff || total + entry.size > this.maxTotalBytes) {
        try { rmSync(path, { force: true }); } catch { /* best effort */ }
        continue;
      }
      total += entry.size;
    }
  }

  dispose(): void {
    this.flush();
  }

  private sizeOf(file: string): number {
    if (this.currentSize?.file === file) return this.currentSize.bytes;
    try { return statSync(file).size; } catch { return 0; }
  }

  private rotate(file: string): void {
    const base = file.slice(0, -".log".length);
    let index = 1;
    while (this.exists(`${base}.${index}.log`)) index++;
    renameSync(file, `${base}.${index}.log`);
    this.currentSize = null;
    this.cleanup();
  }

  private exists(path: string): boolean {
    try { statSync(path); return true; } catch { return false; }
  }

  private entries(): { name: string; size: number; mtimeMs: number }[] {
    let names: string[];
    try { names = readdirSync(this.dir); } catch { return []; }
    return names.filter(name => logFilePattern.test(name)).flatMap(name => {
      try {
        const stat = statSync(join(this.dir, name));
        return [{ name, size: stat.size, mtimeMs: stat.mtimeMs }];
      } catch { return []; }
    });
  }
}

const consoleMethods: Record<LogLevel, "debug" | "info" | "warn" | "error"> = { debug: "debug", info: "info", warn: "warn", error: "error" };

export class ConsoleLogSink implements LogSink {
  write(entry: LogEntry): void {
    console[consoleMethods[entry.level]](formatLogEntry(entry));
  }
}

export interface LogServiceOptions {
  home: string;
  /** Mirror entries to stdout/stderr (source builds and VELA_DEBUG). */
  console: boolean;
  /** VELA_DEBUG: force debug level and ignore the saved preference. */
  debug: boolean;
  homeDir?: string;
}

/** Owns the main-process sinks and the persisted level preference (`<home>/logging-settings.json`). */
export class LogService {
  readonly file: FileLogSink;
  private readonly settingsFile: string;
  private readonly locked: boolean;
  private level: LogLevel;

  constructor(options: LogServiceOptions) {
    this.file = new FileLogSink({ dir: join(options.home, "logs"), homeDir: options.homeDir });
    this.settingsFile = join(options.home, "logging-settings.json");
    this.locked = options.debug;
    this.level = options.debug ? "debug" : this.readLevel();
    setLogLevel(this.level);
    setLogSinks(options.console ? [this.file, new ConsoleLogSink()] : [this.file]);
  }

  get dir(): string {
    return this.file.dir;
  }

  settings(): LogSettings {
    return { level: this.level, locked: this.locked, dir: this.dir };
  }

  setLevel(level: unknown): LogSettings {
    if (!isLogLevel(level)) throw new Error("无效的日志级别");
    if (this.locked) return this.settings();
    this.level = level;
    setLogLevel(level);
    const temporary = `${this.settingsFile}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({ level }), { encoding: "utf8", mode: 0o600 });
      renameSync(temporary, this.settingsFile);
    } finally {
      rmSync(temporary, { force: true });
    }
    return this.settings();
  }

  flush(): void {
    this.file.flush();
  }

  dispose(): void {
    this.file.dispose();
  }

  private readLevel(): LogLevel {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.settingsFile, "utf8"));
      const level = (parsed as { level?: unknown } | null)?.level;
      return isLogLevel(level) ? level : "info";
    } catch {
      return "info";
    }
  }
}
