import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, it, mock } from "node:test";
import { LogsIpc, setLogSinks, type LogEntry } from "@vela/shared";
import { unzipSync } from "fflate";

const listeners = new Map<string, (event: unknown, ...args: unknown[]) => void>();
const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
let saveResult: { canceled: boolean; filePath?: string } = { canceled: true };
const shown: string[] = [];
mock.module("electron", { namedExports: {
  app: { getPath: () => tmpdir(), getName: () => "Vela", getVersion: () => "1.0.1", isPackaged: false, getLocale: () => "en", on: () => undefined },
  BrowserWindow: { fromWebContents: () => null },
  dialog: { showSaveDialog: async () => saveResult, showErrorBox: () => undefined },
  ipcMain: {
    on: (channel: string, listener: (event: unknown, ...args: unknown[]) => void) => listeners.set(channel, listener),
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel),
    removeAllListeners: (channel: string) => listeners.delete(channel),
  },
  shell: { openPath: async () => "", showItemInFolder: (path: string) => shown.push(path) },
} });
const { LogHost } = await import("../src/main/log-host.ts");
const { LogService } = await import("../src/main/log-service.ts");

const home = mkdtempSync(join(tmpdir(), "vela-log-host-"));
after(() => rmSync(home, { recursive: true, force: true }));
afterEach(() => setLogSinks([]));

function setup() {
  const service = new LogService({ home, console: false, debug: false });
  const host = new LogHost(service, { home, agentDir: home, activeConversationId: () => null });
  host.register();
  return { service, host };
}

it("returns null when the save dialog is cancelled and writes a zip otherwise", async () => {
  setup();
  saveResult = { canceled: true };
  assert.equal(await handlers.get(LogsIpc.export)!({ sender: {} }, { includeTrace: false }), null);
  const target = join(home, "out.zip");
  saveResult = { canceled: false, filePath: target };
  assert.deepEqual(await handlers.get(LogsIpc.export)!({ sender: {} }, { includeTrace: false }), { path: target });
  assert.ok(Object.keys(unzipSync(readFileSync(target))).includes("manifest.json"));
  assert.deepEqual(shown, [target]);
});

it("validates, truncates and rate-limits renderer entries", () => {
  const { host } = setup();
  const entries: LogEntry[] = [];
  setLogSinks([{ write: entry => entries.push(entry) }]);
  host.writeRendererEntry({ level: "nope", msg: "x" }, 0);
  host.writeRendererEntry({ level: "info" }, 0);
  host.writeRendererEntry({ level: "error", scope: "ui", msg: "m".repeat(10_000), data: { blob: "d".repeat(40_000) }, err: { name: "TypeError", message: "bad", stack: "TypeError: bad\n at x" } }, 0);
  assert.equal(entries.length, 1);
  const [first] = entries;
  assert.equal(first.proc, "renderer");
  assert.equal(first.scope, "renderer:ui");
  assert.ok(first.msg.length < 5000);
  assert.ok(JSON.stringify(first.data).length < 17_000);
  assert.equal(first.err?.name, "TypeError");
  for (let index = 0; index < 60; index++) host.writeRendererEntry({ level: "info", msg: `burst ${index}` }, 10);
  assert.equal(entries.length, 50, "50 per second including the first entry");
  host.writeRendererEntry({ level: "info", msg: "next second" }, 1100);
  assert.deepEqual(entries.slice(-2).map(entry => entry.msg), ["dropped 11 log entries (rate limit)", "next second"]);
});

it("rejects invalid levels and removes handlers on dispose", async () => {
  const { host } = setup();
  assert.throws(() => handlers.get(LogsIpc.setLevel)!({}, "loud"), /无效的日志级别/);
  assert.equal((await handlers.get(LogsIpc.setLevel)!({}, "warn") as { level: string }).level, "warn");
  host.dispose();
  assert.equal(handlers.has(LogsIpc.export), false);
  assert.equal(listeners.has(LogsIpc.write), false);
});
