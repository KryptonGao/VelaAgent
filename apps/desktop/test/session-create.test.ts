import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, mock } from "node:test";
import { AgentRuntime } from "../../../packages/agent/src/runtime.ts";
import { IpcChannel, type AppState } from "@vela/shared";
import { WorkspaceManager } from "../../../packages/workspace/src/workspace-manager.ts";

type CreateHandler = (event: unknown, cwd?: unknown) => Promise<AppState>;
const handlers = new Map<string, CreateHandler>();
mock.module("electron", {
  namedExports: {
    ipcMain: { handle: (channel: string, handler: CreateHandler) => handlers.set(channel, handler) },
    BrowserWindow: { getAllWindows: () => [] },
    shell: {},
    dialog: {},
  },
});
const { SessionHost } = await import("../src/main/session-host.ts");
mock.module("../src/main/menu.ts", { namedExports: { getApplicationLocale: () => "zh-CN" } });
const { ProjectHost } = await import("../src/main/project-host.ts");

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
  new SessionHost(runtime, { currentCwd: () => second, currentWorkspace: () => null }).register();
  const create = handlers.get(IpcChannel.sessionCreate)!;

  const selected = await create(null, first);
  assert.equal(selected.session.cwd, first);
  assert.notEqual(selected.activeConversationId, firstId);
  assert.notEqual(selected.activeConversationId, secondId);
  assert.equal(activeCwds.at(-1), first);
  assert.equal(selected.conversations.find(chat => chat.id === firstId)?.title, "Keep first chat");
  assert.equal(selected.conversations.find(chat => chat.id === secondId)?.cwd, second);
  assert.equal(selected.conversations.find(chat => chat.id === firstId)?.hasWorkspace, true);
  assert.equal(selected.conversations.find(chat => chat.id === secondId)?.hasWorkspace, true);

  const defaultChat = await create(null);
  assert.equal(defaultChat.session.cwd, second);
  assert.equal(defaultChat.conversations.find(chat => chat.id === defaultChat.activeConversationId)?.hasWorkspace, false);
  assert.notEqual(defaultChat.activeConversationId, secondId);
  assert.equal(activeCwds.at(-1), second);

  const activeId = runtime.activeConversationId;
  for (const invalid of [null, 42, {}, "", join(root, "unknown")]) {
    await assert.rejects(create(null, invalid), /工作区不存在/);
    assert.equal(runtime.activeConversationId, activeId);
  }
});

it("keeps a selected workspace assigned even when its path equals the default execution directory", async t => {
  const root = await mkdtemp(join(tmpdir(), "vela-workspace-association-"));
  const runtime = new AgentRuntime({ cwd: root, agentDir: join(root, "agent") });
  t.after(async () => { await runtime.dispose(); await rm(root, { recursive: true, force: true }); });
  let workspace: string | null = null;
  new SessionHost(runtime, { currentCwd: () => root, currentWorkspace: () => workspace }).register();
  const create = handlers.get(IpcChannel.sessionCreate)!;
  const standalone = await create(null);
  const standaloneId = standalone.activeConversationId!;
  assert.equal(standalone.conversations.find(chat => chat.id === standaloneId)?.hasWorkspace, false);

  workspace = root;
  const selected = await create(null);
  const selectedId = selected.activeConversationId!;
  assert.equal(selected.conversations.find(chat => chat.id === selectedId)?.hasWorkspace, true);
  runtime.addUsage(selectedId, 1, 0);
  await runtime.renameConversation(selectedId, "Hello");
  const state = new SessionHost(runtime, { currentCwd: () => root, currentWorkspace: () => workspace }).currentState();
  assert.equal(state.conversations.find(chat => chat.id === selectedId)?.hasWorkspace, true);
  assert.equal(state.conversations.find(chat => chat.id === standaloneId)?.hasWorkspace, false);
});

it("synchronizes selected and unassigned conversations sharing one cwd without switching to a different chat", async t => {
  const root = await mkdtemp(join(tmpdir(), "vela-workspace-sync-"));
  const workspaceManager = new WorkspaceManager(join(root, "workspaces.json"));
  await workspaceManager.init(root);
  const pending: Promise<void>[] = [];
  let project: InstanceType<typeof ProjectHost>;
  const runtime = new AgentRuntime({ cwd: root, agentDir: join(root, "agent"),
    onActiveCwd: (cwd, assigned) => pending.push(project.syncConversationWorkspace(cwd, assigned)) });
  const attached: Array<string | null> = [];
  project = new ProjectHost({
    workspaceManager, runtime, fallbackCwd: root,
    git: { subscribe: () => {}, attach: async (cwd: string | null) => { attached.push(cwd); } },
    sandbox: { subscribe: () => {} },
    env: { setWorkspace: async () => {}, getActive: () => null },
  } as unknown as ConstructorParameters<typeof ProjectHost>[0]);
  t.after(async () => { project.dispose(); await runtime.dispose(); await rm(root, { recursive: true, force: true }); });
  const settle = async () => {
    await Promise.all(pending.splice(0));
    await (project as unknown as { switchChain: Promise<void> }).switchChain;
  };
  await runtime.createConversation(root, { hasWorkspace: false });
  const standaloneId = runtime.activeConversationId!;
  await settle();
  assert.equal(workspaceManager.getState().current, null);
  assert.equal(runtime.activeConversationId, standaloneId);

  await workspaceManager.select(root);
  await settle();
  const firstAssignedId = runtime.activeConversationId!;
  assert.notEqual(firstAssignedId, standaloneId);
  assert.equal(runtime.listConversations().find(chat => chat.id === firstAssignedId)?.hasWorkspace, true);
  await runtime.createConversation(root);
  const newerAssignedId = runtime.activeConversationId!;
  assert.notEqual(newerAssignedId, firstAssignedId);
  await settle();

  await runtime.switchConversation(standaloneId);
  await settle();
  assert.equal(workspaceManager.getState().current, null);
  assert.equal(runtime.activeConversationId, standaloneId);
  await runtime.switchConversation(firstAssignedId);
  await settle();
  assert.equal(workspaceManager.getState().current, root);
  assert.equal(runtime.activeConversationId, firstAssignedId);
  assert.deepEqual(attached, [null, root, null, root]);
});
