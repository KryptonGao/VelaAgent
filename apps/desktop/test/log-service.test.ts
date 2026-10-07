import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { createLogger, getLogLevel, setLogLevel, setLogSinks, type LogEntry } from "@vela/shared";
import { FileLogSink, LogService } from "../src/main/log-service.ts";

const roots: string[] = [];
function tempDir(): string {
  const root = mkdtempSync(join(tmpdir(), "vela-logs-"));
  roots.push(root);
  return root;
}
function entry(msg: string, level: LogEntry["level"] = "info"): LogEntry {
  return { ts: new Date().toISOString(), level, scope: "test", msg, proc: "main" };
}

describe("FileLogSink", () => {
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  it("batches lines into a local-date JSONL file and flushes errors immediately", () => {
    const dir = tempDir();
    const sink = new FileLogSink({ dir, now: () => new Date(2026, 9, 7, 12), homeDir: "/Users/someone" });
    sink.write(entry("queued at /Users/someone/project"));
    const file = join(dir, "vela-2026-10-07.log");
    assert.throws(() => statSync(file), "info is batched");
    sink.write(entry("boom", "error"));
    const lines = readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line) as LogEntry);
    assert.deepEqual(lines.map(line => line.msg), ["queued at ~/project", "boom"]);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    sink.dispose();
  });

  it("rotates a file that would exceed the size cap", () => {
    const dir = tempDir();
    const sink = new FileLogSink({ dir, maxFileBytes: 300, flushBatch: 1, now: () => new Date(2026, 9, 7) });
    for (let index = 0; index < 6; index++) sink.write(entry(`line ${index} ${"x".repeat(60)}`));
    const names = readdirSync(dir).sort();
    assert.ok(names.includes("vela-2026-10-07.log"));
    assert.ok(names.includes("vela-2026-10-07.1.log"));
    for (const name of names) assert.ok(statSync(join(dir, name)).size <= 300, name);
    const total = names.flatMap(name => readFileSync(join(dir, name), "utf8").trim().split("\n"));
    assert.equal(total.length, 6);
  });

  it("removes files past retention and beyond the total budget, keeping today's file", () => {
    const dir = tempDir();
    const now = new Date(2026, 9, 7);
    const old = join(dir, "vela-2026-09-01.log");
    writeFileSync(old, "old\n");
    utimesSync(old, new Date(2026, 8, 1), new Date(2026, 8, 1));
    for (const day of ["05", "06"]) {
      const path = join(dir, `vela-2026-10-${day}.log`);
      writeFileSync(path, "y".repeat(400));
      utimesSync(path, new Date(2026, 9, Number(day)), new Date(2026, 9, Number(day)));
    }
    writeFileSync(join(dir, "vela-2026-10-07.log"), "z".repeat(400));
    writeFileSync(join(dir, "notes.txt"), "untouched");
    new FileLogSink({ dir, now: () => now, maxTotalBytes: 900 });
    assert.deepEqual(readdirSync(dir).sort(), ["notes.txt", "vela-2026-10-06.log", "vela-2026-10-07.log"]);
  });

  it("files() lists newest first", () => {
    const dir = tempDir();
    const sink = new FileLogSink({ dir, now: () => new Date(2026, 9, 7) });
    writeFileSync(join(dir, "vela-2026-10-01.log"), "a");
    utimesSync(join(dir, "vela-2026-10-01.log"), new Date(2026, 9, 1), new Date(2026, 9, 1));
    sink.write(entry("x", "error"));
    assert.deepEqual(sink.files().map(path => path.slice(dir.length + 1)), ["vela-2026-10-07.log", "vela-2026-10-01.log"]);
  });
});

describe("LogService", () => {
  afterEach(() => {
    setLogSinks([]); setLogLevel("info");
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("persists the level and installs the file sink", () => {
    const home = tempDir();
    const service = new LogService({ home, console: false, debug: false });
    assert.deepEqual(service.settings(), { level: "info", locked: false, dir: join(home, "logs") });
    service.setLevel("debug");
    assert.equal(getLogLevel(), "debug");
    createLogger("svc").debug("written");
    service.flush();
    assert.match(readFileSync(service.file.currentFile(), "utf8"), /"msg":"written"/);
    service.dispose();
    const reopened = new LogService({ home, console: false, debug: false });
    assert.equal(reopened.settings().level, "debug");
    assert.throws(() => reopened.setLevel("verbose"), /无效的日志级别/);
  });

  it("VELA_DEBUG locks the level to debug", () => {
    const home = tempDir();
    const service = new LogService({ home, console: false, debug: true });
    assert.deepEqual(service.setLevel("error"), { level: "debug", locked: true, dir: join(home, "logs") });
    assert.equal(getLogLevel(), "debug");
  });
});
