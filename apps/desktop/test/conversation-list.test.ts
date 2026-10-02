import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { AgentRuntime } from "../../../packages/agent/src/runtime.ts";
import { groupActivityConversations } from "../src/renderer/components/conversation-activity.ts";
import { searchActiveConversations } from "../src/renderer/components/conversation-search.ts";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "vela-conversation-list-"));
  const cwd = join(root, "workspace");
  await mkdir(cwd);
  const runtime = new AgentRuntime({ cwd, agentDir: root });
  const runtimes = [runtime];
  t.after(async () => {
    for (const instance of runtimes) instance.dispose();
    await rm(root, { recursive: true, force: true });
  });
  await runtime.createConversation(cwd);
  return { runtime, runtimes, cwd, root, id: runtime.activeConversationId! };
}

function visibleIds(runtime: AgentRuntime) {
  const conversations = runtime.listConversations();
  const search = searchActiveConversations(conversations, "", "新对话").map(item => item.id).sort();
  const activity = groupActivityConversations(conversations).flatMap(group => group.conversations.map(item => item.id)).sort();
  assert.deepEqual(activity, search);
  return search;
}

describe("conversation list lifecycle", () => {
  it("hides repeated blank chats and lists the submitted chat before any reply, including after restart", async t => {
    const { runtime, runtimes, cwd, root, id } = await fixture(t);
    assert.equal(runtime.listConversations().find(item => item.id === id)?.messageCount, 0);
    assert.deepEqual(visibleIds(runtime), []);
    await runtime.renameConversation(id, "未发送的草稿");
    assert.deepEqual(visibleIds(runtime), []);
    await runtime.createConversation(cwd);
    const sentId = runtime.activeConversationId!;
    assert.deepEqual(visibleIds(runtime), []);
    // SessionHost counts every submitted user message, including image-only input,
    // before prompting the agent. No assistant reply is needed to enter the list.
    runtime.addUsage(sentId, 1, 0);
    assert.deepEqual(runtime.getMessages(sentId), []);
    assert.deepEqual(visibleIds(runtime), [sentId]);
    runtime.dispose();
    const restored = new AgentRuntime({ cwd, agentDir: root });
    runtimes.push(restored);
    await restored.switchConversation(sentId);
    assert.deepEqual(visibleIds(restored), [sentId]);
    await restored.archiveConversation(sentId);
    assert.deepEqual(visibleIds(restored), []);
    await restored.unarchiveConversation(sentId);
    assert.deepEqual(visibleIds(restored), [sentId]);
  });

  it("lists branched conversations immediately because they already contain user history", async t => {
    const { runtime, id } = await fixture(t);
    const internals = runtime as unknown as { conversations: Map<string, { sessionManager: SessionManager }> };
    const manager = internals.conversations.get(id)!.sessionManager;
    manager.appendMessage({ role: "user", content: "first turn", timestamp: Date.now() });
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "first reply" }],
      timestamp: Date.now(), stopReason: "stop" } as never);
    runtime.addUsage(id, 1, 0);
    await runtime.branchConversation(id, 0);
    const branchId = runtime.activeConversationId!;
    assert.equal(runtime.listConversations().find(item => item.id === branchId)?.messageCount, 1);
    assert.deepEqual(visibleIds(runtime), [id, branchId].sort());
  });
});
