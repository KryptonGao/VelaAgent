import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { AgentRuntime } from "../src/runtime.ts";
import { normalizeManualConversationTitle } from "../src/conversation-title.ts";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "vela-rename-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(cwd);
  const runtime = new AgentRuntime({ cwd, agentDir });
  const runtimes = [runtime];
  t.after(async () => {
    for (const instance of runtimes) instance.dispose();
    await rm(root, { recursive: true, force: true });
  });
  await runtime.createConversation(cwd);
  return { runtime, id: runtime.activeConversationId!, cwd, agentDir, runtimes };
}

describe("manual conversation rename", () => {
  it("validates IPC input, normalizes whitespace, and preserves names longer than generated titles", () => {
    assert.equal(normalizeManualConversationTitle("  项目\n  设计\t讨论  "), "项目 设计 讨论");
    assert.equal(normalizeManualConversationTitle("a".repeat(120)).length, 120);
    for (const value of [null, 1, {}, "\n\t ", "a".repeat(121)]) assert.throws(() => normalizeManualConversationTitle(value));
  });
  it("renames an inactive streaming chat without activation, reordering, or changing its messages", async t => {
    const { runtime, id, cwd } = await fixture(t);
    await runtime.createConversation(cwd);
    const activeId = runtime.activeConversationId;
    const before = runtime.listConversations().find(item => item.id === id)!;
    const internals = runtime as unknown as { conversations: Map<string, { driving: boolean; snapshot: { status: string } }> };
    const entry = internals.conversations.get(id)!;
    entry.driving = true;
    entry.snapshot.status = "streaming";
    const events: string[] = [];
    const unsubscribe = runtime.subscribe(event => events.push(event.type));
    await runtime.renameConversation(id, "  自定义名称  ");
    unsubscribe();
    entry.driving = false;
    assert.equal(runtime.activeConversationId, activeId);
    assert.deepEqual(runtime.listConversations().find(item => item.id === id), { ...before, title: "自定义名称", status: "streaming" });
    assert.deepEqual(runtime.getMessages(id), []);
    assert.ok(events.includes("status"));
    await assert.rejects(runtime.renameConversation("missing", "合法名称"), /不存在/);
    await assert.rejects(runtime.renameConversation(id, "  "), /不能为空/);
    assert.equal(runtime.listConversations().find(item => item.id === id)!.title, "自定义名称");
  });
  it("persists the manual marker through restart, including an archived chat named 新对话", async t => {
    const { runtime, id, cwd, agentDir, runtimes } = await fixture(t);
    await runtime.renameConversation(id, "新对话");
    await runtime.archiveConversation(id);
    runtime.dispose();
    const payload = JSON.parse(await readFile(join(agentDir, "conversations.json"), "utf8"));
    assert.equal(payload.conversations[0].titleManuallySet, true);
    const restored = new AgentRuntime({ cwd, agentDir });
    runtimes.push(restored);
    await restored.unarchiveConversation(id);
    await restored.switchConversation(id);
    assert.equal(restored.getSnapshot().title, "新对话");
    const internals = restored as unknown as {
      drive: () => Promise<void>;
      requireIdle: (id: string) => unknown;
      conversations: Map<string, { snapshot: { title: string }; session: { prompt: () => Promise<void> } }>;
      runSinglePrompt: (entry: unknown, text: string, images: undefined, options: { rename: boolean; release: boolean }) => Promise<string>;
    };
    // Capture the public first-prompt title decision without making a model request.
    internals.drive = async () => {};
    internals.requireIdle = id => internals.conversations.get(id)!;
    await restored.prompt(id, "这条消息不能改名");
    assert.equal(restored.getSnapshot().title, "新对话");
    const entry = internals.conversations.get(id)!;
    entry.session.prompt = async () => {};
    assert.equal(await internals.runSinglePrompt(entry, "兜底标题也不能覆盖", undefined, { rename: true, release: true }), "ok");
    assert.equal(restored.getSnapshot().title, "新对话");
  });
  it("keeps a manual name when an in-flight generated title returns, even when renamed back to the fallback", async t => {
    const { runtime, id } = await fixture(t);
    const internals = runtime as unknown as {
      conversations: Map<string, { snapshot: { title: string } }>;
      generateConversationTitle: (entry: unknown, text: string, fallback: string, model: Model<Api>, directory: unknown) => Promise<void>;
    };
    const entry = internals.conversations.get(id)!;
    entry.snapshot.title = "fallback";
    let complete!: (value: unknown) => void;
    const response = new Promise(resolve => { complete = resolve; });
    const directory = { runtime: { completeSimple: () => response } };
    const request = internals.generateConversationTitle(entry, "first prompt", "fallback", { provider: "test", id: "test" } as Model<Api>, directory);
    await runtime.renameConversation(id, "manual");
    await runtime.renameConversation(id, "fallback");
    complete({ content: [{ type: "text", text: "automatic title" }], stopReason: "stop" });
    await request;
    assert.equal(runtime.getSnapshot().title, "fallback");
  });
  it("loads old indexes without the manual marker and still allows automatic titles", async t => {
    const { runtime, id, cwd, agentDir, runtimes } = await fixture(t);
    runtime.dispose();
    const file = join(agentDir, "conversations.json");
    const payload = JSON.parse(await readFile(file, "utf8"));
    for (const entry of payload.conversations) delete entry.titleManuallySet;
    await writeFile(file, JSON.stringify(payload));
    const restored = new AgentRuntime({ cwd, agentDir });
    runtimes.push(restored);
    await restored.switchConversation(id);
    const internals = restored as unknown as {
      drive: () => Promise<void>;
      requireIdle: (id: string) => unknown;
      conversations: Map<string, unknown>;
    };
    internals.drive = async () => {};
    internals.requireIdle = id => internals.conversations.get(id)!;
    await restored.prompt(id, "兼容旧版标题生成");
    assert.equal(restored.getSnapshot().title, "兼容旧版标题生成");
  });
});
