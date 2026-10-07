import assert from "node:assert/strict";
import { setLogSinks, type LogEntry } from "@vela/shared";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { AgentRuntime } from "../src/runtime.ts";
import { ConversationStore, type StoredConversation } from "../src/conversation-store.ts";
import type { SessionManager } from "@earendil-works/pi-coding-agent";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "vela-conversation-persist-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "conversations.json");
  return { root, file };
}

function stored(id = "chat-a"): StoredConversation {
  return { id, cwd: "/tmp/workspace", title: "测试对话", createdAt: 1, updatedAt: 2,
    messageCount: 0, toolCallCount: 0, sessionFile: null, instructions: "", mode: "agent",
    plans: [], latestProposedPlanId: null, executionPlans: [], activeExecutionPlanId: null,
    goal: null, archivedAt: null };
}

describe("conversation persistence", () => {
  it("keeps workspace association distinct for the same cwd through updates, switching and restart", async t => {
    const { root, file } = await fixture(t);
    const notifications: Array<[string, boolean]> = [];
    const runtime = new AgentRuntime({ cwd: root, agentDir: root, onActiveCwd: (cwd, assigned) => notifications.push([cwd, assigned]) });
    t.after(() => runtime.dispose());
    await runtime.createConversation(root, { hasWorkspace: false });
    const standaloneId = runtime.activeConversationId!;
    runtime.addUsage(standaloneId, 1, 0);
    await runtime.createConversation(root, { hasWorkspace: true });
    const selectedId = runtime.activeConversationId!;
    runtime.addUsage(selectedId, 1, 0);
    await runtime.renameConversation(selectedId, "Hello");
    assert.equal(runtime.listConversations().find(chat => chat.id === selectedId)?.hasWorkspace, true);
    assert.equal(runtime.listConversations().find(chat => chat.id === standaloneId)?.hasWorkspace, false);
    await runtime.switchWorkspace(root, false);
    assert.equal(runtime.activeConversationId, standaloneId);
    assert.deepEqual(notifications.at(-1), [root, false]);
    await runtime.switchWorkspace(root, true);
    assert.equal(runtime.activeConversationId, selectedId);
    assert.deepEqual(notifications.at(-1), [root, true]);
    await runtime.dispose();
    const disk = JSON.parse(await readFile(file, "utf8")).conversations as StoredConversation[];
    assert.equal(disk.find(chat => chat.id === standaloneId)?.hasWorkspace, false);
    assert.equal(disk.find(chat => chat.id === selectedId)?.hasWorkspace, true);
    const restored = new AgentRuntime({ cwd: root, agentDir: root, isWorkspaceCwd: () => false });
    t.after(() => restored.dispose());
    await restored.switchWorkspace(root, true);
    assert.equal(restored.activeConversationId, selectedId);
    assert.equal(restored.listConversations().find(chat => chat.id === selectedId)?.hasWorkspace, true);
    await restored.switchWorkspace(root, false);
    assert.equal(restored.activeConversationId, standaloneId);
    assert.equal(restored.listConversations().find(chat => chat.id === standaloneId)?.hasWorkspace, false);
  });

  it("inherits unassigned workspace association when branching a conversation", async t => {
    const { root } = await fixture(t);
    const runtime = new AgentRuntime({ cwd: root, agentDir: root });
    t.after(() => runtime.dispose());
    await runtime.createConversation(root, { hasWorkspace: false });
    const sourceId = runtime.activeConversationId!;
    const manager = (runtime as unknown as { conversations: Map<string, { sessionManager: SessionManager }> }).conversations.get(sourceId)!.sessionManager;
    manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Hello" }], timestamp: Date.now(), stopReason: "stop" } as never);
    runtime.addUsage(sourceId, 1, 0);
    await runtime.branchConversation(sourceId, 0);
    assert.notEqual(runtime.activeConversationId, sourceId);
    assert.equal(runtime.listConversations().find(chat => chat.id === runtime.activeConversationId)?.hasWorkspace, false);
  });

  it("migrates legacy workspace association once and preserves explicit saved values", async t => {
    const { root, file } = await fixture(t);
    const standalone = join(root, "Contents");
    await mkdir(standalone);
    const runtime = new AgentRuntime({ cwd: root, agentDir: root });
    t.after(() => runtime.dispose());
    await runtime.createConversation(root);
    const selectedId = runtime.activeConversationId!;
    await runtime.createConversation(standalone, { hasWorkspace: false });
    const standaloneId = runtime.activeConversationId!;
    await runtime.createConversation(root, { hasWorkspace: false });
    const explicitId = runtime.activeConversationId!;
    await runtime.dispose();
    const payload = JSON.parse(await readFile(file, "utf8"));
    for (const chat of payload.conversations) if (chat.id !== explicitId) delete chat.hasWorkspace;
    await writeFile(file, JSON.stringify(payload));
    const restored = new AgentRuntime({ cwd: root, agentDir: root, isWorkspaceCwd: cwd => cwd === root });
    t.after(() => restored.dispose());
    await restored.switchConversation(selectedId);
    assert.equal(restored.listConversations().find(chat => chat.id === selectedId)?.hasWorkspace, true);
    assert.equal(restored.listConversations().find(chat => chat.id === standaloneId)?.hasWorkspace, false);
    assert.equal(restored.listConversations().find(chat => chat.id === explicitId)?.hasWorkspace, false);
    const disk = JSON.parse(await readFile(file, "utf8")).conversations as StoredConversation[];
    assert.equal(disk.find(chat => chat.id === selectedId)?.hasWorkspace, true);
    assert.equal(disk.find(chat => chat.id === standaloneId)?.hasWorkspace, false);
    assert.equal(disk.find(chat => chat.id === explicitId)?.hasWorkspace, false);
  });

  it("finishes a debounced write before shutdown can skip it", async t => {
    const { file } = await fixture(t);
    const store = new ConversationStore(file);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    store.put(stored());
    t.mock.timers.tick(400);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).conversations[0].id, "chat-a");
    store.update("chat-a", { archivedAt: 100 });
    store.flushSync();
    assert.equal(JSON.parse(readFileSync(file, "utf8")).conversations[0].archivedAt, 100);
  });

  it("retries a failed save at shutdown without needing another change", async t => {
    const { file } = await fixture(t);
    const store = new ConversationStore(file);
    await mkdir(file);
    const errors: LogEntry[] = [];
    setLogSinks([]);
    setLogSinks([{ write: entry => { if (entry.level === "error") errors.push(entry); } }]);
    t.after(() => setLogSinks([]));
    store.put(stored());
    store.flushSync();
    assert.equal(errors.length, 1);
    await rm(file, { recursive: true });
    store.flushSync();
    assert.equal(JSON.parse(await readFile(file, "utf8")).conversations[0].id, "chat-a");
  });

  it("does not let a stale instance undo another instance's archive or remove its new chats", async t => {
    const { file } = await fixture(t);
    const first = new ConversationStore(file);
    first.put(stored()); first.flushSync();
    const second = new ConversationStore(file);
    await second.load();
    first.update("chat-a", { archivedAt: 100 }); first.flushSync();
    first.put(stored("chat-b")); first.flushSync();
    second.update("chat-a", { title: "新标题" }); second.flushSync();
    second.update("chat-a", { messageCount: 2 }); second.flushSync();
    const restored = new ConversationStore(file);
    await restored.load();
    assert.equal(restored.get("chat-a")?.archivedAt, 100);
    assert.equal(restored.get("chat-a")?.title, "新标题");
    assert.equal(restored.get("chat-a")?.messageCount, 2);
    assert.ok(restored.get("chat-b"));
  });

  it("preserves a corrupt index instead of overwriting it with defaults", async t => {
    const { file } = await fixture(t);
    await writeFile(file, "damaged index");
    const store = new ConversationStore(file);
    await store.load();
    t.mock.method(console, "error", () => {});
    store.put(stored()); store.flushSync();
    assert.equal(await readFile(file, "utf8"), "damaged index");
  });

  it("does not apply restart normalization to an active goal during a later save", async t => {
    const { file } = await fixture(t);
    const store = new ConversationStore(file);
    store.put(stored()); store.flushSync();
    const payload = JSON.parse(await readFile(file, "utf8"));
    payload.conversations[0].goal = { id: "goal-a", status: "active" };
    await writeFile(file, JSON.stringify(payload));
    store.update("chat-a", { title: "更新标题" }); store.flushSync();
    assert.equal(JSON.parse(await readFile(file, "utf8")).conversations[0].goal.status, "active");
  });

  it("archives and unarchives on disk before returning, without relying on dispose", async t => {
    const { root, file } = await fixture(t);
    const cwd = join(root, "workspace"); await mkdir(cwd);
    const runtime = new AgentRuntime({ cwd, agentDir: root });
    t.after(() => runtime.dispose());
    await runtime.createConversation(cwd);
    const id = runtime.activeConversationId!;
    await runtime.archiveConversation(id);
    const archived = JSON.parse(await readFile(file, "utf8")).conversations.find((entry: StoredConversation) => entry.id === id);
    assert.ok(archived.archivedAt > 0);
    const restored = new AgentRuntime({ cwd, agentDir: root });
    t.after(() => restored.dispose());
    await restored.createConversation(cwd);
    assert.equal(restored.listConversations().find(entry => entry.id === id)?.archivedAt, archived.archivedAt);
    await restored.unarchiveConversation(id);
    assert.equal(JSON.parse(await readFile(file, "utf8")).conversations.find((entry: StoredConversation) => entry.id === id).archivedAt, null);
  });
});
