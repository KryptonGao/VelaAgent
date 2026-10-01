import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { AgentRuntime } from "../src/runtime.ts";
import { ConversationStore, type StoredConversation } from "../src/conversation-store.ts";

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
    const errors: unknown[][] = [];
    t.mock.method(console, "error", (...args: unknown[]) => errors.push(args));
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
