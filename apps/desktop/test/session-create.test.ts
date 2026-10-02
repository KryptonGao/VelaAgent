import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, mock } from "node:test";
import { AgentRuntime } from "../../../packages/agent/src/runtime.ts";
import { IpcChannel, type AppState } from "@vela/shared";

type CreateHandler = (event: unknown, cwd?: unknown) => Promise<AppState>;
const handlers = new Map<string, CreateHandler>();
mock.module("electron", {
  namedExports: {
    ipcMain: { handle: (channel: string, handler: CreateHandler) => handlers.set(channel, handler) },
    BrowserWindow: { getAllWindows: () => [] },
    shell: {},
  },
});
const { SessionHost } = await import("../src/main/session-host.ts");

it("creates a fresh chat in the requested workspace while preserving existing chats and the default entry point", async t => {
  const root = await mkdtemp(join(tmpdir(), "vela-session-create-"));
  const first = join(root, "first");
  const second = join(root, "second");
  await mkdir(first);
  await mkdir(second);
  const activeCwds: string[] = [];
  const runtime = new AgentRuntime({ cwd: first, agentDir: root, onActiveCwd: cwd => activeCwds.push(cwd) });
  t.after(async () => { runtime.dispose(); await rm(root, { recursive: true, force: true }); });
  await runtime.createConversation(first);
  const firstId = runtime.activeConversationId!;
  await runtime.renameConversation(firstId, "Keep first chat");
  await runtime.createConversation(second);
  const secondId = runtime.activeConversationId!;
  new SessionHost(runtime, { currentCwd: () => second }).register();
  const create = handlers.get(IpcChannel.sessionCreate)!;

  const selected = await create(null, first);
  assert.equal(selected.session.cwd, first);
  assert.notEqual(selected.activeConversationId, firstId);
  assert.notEqual(selected.activeConversationId, secondId);
  assert.equal(activeCwds.at(-1), first);
  assert.equal(selected.conversations.find(chat => chat.id === firstId)?.title, "Keep first chat");
  assert.equal(selected.conversations.find(chat => chat.id === secondId)?.cwd, second);

  const defaultChat = await create(null);
  assert.equal(defaultChat.session.cwd, second);
  assert.notEqual(defaultChat.activeConversationId, secondId);
  assert.equal(activeCwds.at(-1), second);

  const activeId = runtime.activeConversationId;
  for (const invalid of [null, 42, {}, "", join(root, "unknown")]) {
    await assert.rejects(create(null, invalid), /工作区不存在/);
    assert.equal(runtime.activeConversationId, activeId);
  }
});
