import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, mock } from "node:test";
import { IpcChannel } from "@vela/shared";

const listeners = new Map<string, (event: { returnValue?: unknown }) => void>();
const handlers = new Map<string, () => unknown>();
mock.module("electron", { namedExports: { ipcMain: {
  on: (channel: string, listener: (event: { returnValue?: unknown }) => void) => listeners.set(channel, listener),
  handle: (channel: string, handler: () => unknown) => handlers.set(channel, handler),
} } });
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
