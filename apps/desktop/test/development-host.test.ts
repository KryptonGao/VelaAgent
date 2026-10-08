import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, mock } from "node:test";
import { IpcChannel } from "@vela/shared";

const listeners = new Map<string, (event: { returnValue?: unknown }) => void>();
const handlers = new Map<string, (...args: any[]) => unknown>();
const calls: string[] = [];
const windows = new Map<unknown, { isDestroyed(): boolean; webContents: unknown }>();
mock.module("electron", { namedExports: {
  ipcMain: {
    on: (channel: string, listener: (event: { returnValue?: unknown }) => void) => listeners.set(channel, listener),
    handle: (channel: string, handler: (...args: any[]) => unknown) => handlers.set(channel, handler),
  },
  app: {
    getName: () => "Vela Dev", getVersion: () => "9.9.9", getAppPath: () => process.cwd(),
    relaunch: () => calls.push("relaunch"), quit: () => calls.push("quit"),
  },
  BrowserWindow: { fromWebContents: (contents: unknown) => windows.get(contents) ?? null },
} });
const { registerDevelopmentIpc } = await import("../src/main/development-host.ts");

it("hides the feature in packaged builds and rejects direct IPC requests", () => {
  let called = false;
  registerDevelopmentIpc({ importConversations: async () => { called = true; return 0; } }, { isPackaged: true, home: "unused" });
  const event: { returnValue?: unknown } = {};
  listeners.get(IpcChannel.appIsDevelopment)!(event);
  assert.equal(event.returnValue, false);
  assert.throws(() => handlers.get(IpcChannel.appSyncProductionConversations)!(), /仅开发版/);
  assert.equal(called, false);
});

it("exposes development mode and routes sync requests through the runtime import queue", async t => {
  const root = await mkdtemp(join(tmpdir(), "vela-development-host-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "production"), destination = join(root, "development");
  await mkdir(source);
  await writeFile(join(source, "conversations.json"), '{"version":2,"conversations":[]}');
  let called = false;
  registerDevelopmentIpc({ importConversations: async load => {
    called = true;
    assert.deepEqual(await load(new Set()), []);
    return 0;
  } }, { isPackaged: false, home: destination, productionHome: source });
  const event: { returnValue?: unknown } = {};
  listeners.get(IpcChannel.appIsDevelopment)!(event);
  assert.equal(event.returnValue, true);
  assert.deepEqual(await handlers.get(IpcChannel.appSyncProductionConversations)!(), { imported: 0, existing: 0, unavailable: 0 });
  assert.equal(called, true);
});

function appWindow() {
  const webContents = {
    mainFrame: {},
    openDevTools: (options: unknown) => calls.push(`devtools:${JSON.stringify(options)}`),
    devToolsWebContents: { focus: () => calls.push("focus-devtools") },
    reload: () => calls.push("reload"),
  };
  windows.set(webContents, { isDestroyed: () => false, webContents });
  return { sender: webContents, senderFrame: webContents.mainFrame };
}

const runtime = { importConversations: async () => 0, removeConversations: async () => 0, flushPersistence: () => calls.push("flush") };

it("rejects every development tool in packaged builds", async () => {
  registerDevelopmentIpc(runtime, { isPackaged: true, home: "unused" });
  for (const channel of [IpcChannel.appDevInfo, IpcChannel.appDevOpenDevTools, IpcChannel.appDevReloadWindow, IpcChannel.appDevRestartMain]) {
    assert.throws(() => handlers.get(channel)!(appWindow()), /仅开发版/, channel);
  }
  for (const channel of [IpcChannel.appSyncPreview, IpcChannel.appSyncRun, IpcChannel.appSyncBatches, IpcChannel.appSyncRollback]) {
    assert.throws(() => handlers.get(channel)!({}, ["settings"]), /仅开发版/, channel);
  }
  assert.equal(calls.length, 0);
});

it("opens DevTools and reloads only for the app's own window", async () => {
  calls.length = 0;
  registerDevelopmentIpc(runtime, { isPackaged: false, home: "unused" });
  const event = appWindow();
  await handlers.get(IpcChannel.appDevOpenDevTools)!(event);
  await handlers.get(IpcChannel.appDevReloadWindow)!(event);
  assert.deepEqual(calls, ['devtools:{"mode":"detach"}', "focus-devtools", "reload"]);
  const guest = { sender: {}, senderFrame: {} };
  assert.throws(() => handlers.get(IpcChannel.appDevReloadWindow)!(guest), /应用窗口/);
  const subframe = { sender: event.sender, senderFrame: {} };
  assert.throws(() => handlers.get(IpcChannel.appDevOpenDevTools)!(subframe), /应用窗口/);
  assert.equal(calls.length, 3);
});

it("reports version information and relaunches after flushing the session index", async () => {
  calls.length = 0;
  const previous = process.env.ELECTRON_RENDERER_URL;
  delete process.env.ELECTRON_RENDERER_URL;
  try {
    registerDevelopmentIpc(runtime, { isPackaged: false, home: "/tmp/vela-dev" });
    const info = await handlers.get(IpcChannel.appDevInfo)!(appWindow()) as Record<string, unknown>;
    assert.equal(info.version, "9.9.9");
    assert.equal(info.electron, process.versions.electron ?? "unknown");
    assert.equal(info.node, process.versions.node);
    assert.equal(info.home, "/tmp/vela-dev");
    await handlers.get(IpcChannel.appDevRestartMain)!(appWindow());
    assert.deepEqual(calls, ["flush", "relaunch", "quit"]);
  } finally {
    if (previous === undefined) delete process.env.ELECTRON_RENDERER_URL;
    else process.env.ELECTRON_RENDERER_URL = previous;
  }
});

it("routes scoped sync requests and validates the batch id", async t => {
  const root = await mkdtemp(join(tmpdir(), "vela-development-scope-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "production"), destination = join(root, "development");
  await mkdir(source);
  await writeFile(join(source, "MEMORY.md"), "memory");
  registerDevelopmentIpc(runtime, { isPackaged: false, home: destination, productionHome: source });
  const preview = await handlers.get(IpcChannel.appSyncPreview)!({}, ["memory"]) as { total: number };
  assert.equal(preview.total, 1);
  const result = await handlers.get(IpcChannel.appSyncRun)!({}, ["memory"]) as { batch: string; total: number };
  assert.equal(result.total, 1);
  const batches = await handlers.get(IpcChannel.appSyncBatches)!({}) as Array<{ id: string }>;
  assert.deepEqual(batches.map(batch => batch.id), [result.batch]);
  assert.throws(() => handlers.get(IpcChannel.appSyncRollback)!({}, { batch: 1 }), /不存在/);
  const reverted = await handlers.get(IpcChannel.appSyncRollback)!({}, result.batch) as { reverted: number };
  assert.equal(reverted.reverted, 1);
});
