import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionSnapshot } from "@vela/shared";
import { AgentRuntime } from "../src/runtime.ts";
import { readTurnTimings, turnTimingEntryType } from "../src/turn-timing.ts";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "vela-turn-timing-"));
  const cwd = join(root, "workspace"); await mkdir(cwd);
  const runtime = new AgentRuntime({ cwd, agentDir: root });
  const runtimes = [runtime];
  t.after(async () => { for (const instance of runtimes) instance.dispose(); await rm(root, { recursive: true, force: true }); });
  await runtime.createConversation(cwd);
  const id = runtime.activeConversationId!;
  const internals = runtime as unknown as {
    conversations: Map<string, { sessionManager: SessionManager }>;
    patchEntry(entry: unknown, patch: Partial<SessionSnapshot>): void;
  };
  const entry = internals.conversations.get(id)!;
  function reply() {
    entry.sessionManager.appendMessage({ role: "assistant", content: [{ type: "thinking", thinking: "inspect" }, { type: "text", text: "done" }], timestamp: Date.now(), stopReason: "stop" } as never);
  }
  function start() { internals.patchEntry(entry, { status: "streaming" }); }
  function finish() { internals.patchEntry(entry, { status: "ready" }); }
  return { root, cwd, runtime, runtimes, id, entry, start, finish, reply };
}

describe("persisted turn timing", () => {
  it("records in the host and restores exactly the same duration after restart", async t => {
    const { root, cwd, runtime, runtimes, id, entry, start, finish, reply } = await fixture(t);
    t.mock.timers.enable({ apis: ["Date"], now: 1000 });
    start();
    entry.sessionManager.appendMessage({ role: "user", content: "go", timestamp: 1000 });
    reply();
    t.mock.timers.tick(2500); finish();
    assert.equal(runtime.getSnapshot().turnStartedAt, 1000);
    assert.equal(runtime.getSnapshot().turnCompletedAt, 3500);
    const before = runtime.getMessages(id).at(-1)!;
    assert.equal(before.turnStartedAt, 1000);
    assert.equal(before.turnCompletedAt, 3500);
    runtime.dispose();
    const restored = new AgentRuntime({ cwd, agentDir: root }); runtimes.push(restored);
    await restored.switchConversation(id);
    const after = restored.getMessages(id).at(-1)!;
    assert.equal(after.turnStartedAt, before.turnStartedAt);
    assert.equal(after.turnCompletedAt, before.turnCompletedAt);
    assert.deepEqual(entry.sessionManager.buildSessionProjection().messages.map(message => message.role), ["user", "assistant"]);
  });

  it("only stamps the final assistant step and preserves timing in a fork", async t => {
    const { runtime, id, entry, start, finish, reply } = await fixture(t);
    start(); entry.sessionManager.appendMessage({ role: "user", content: "go", timestamp: Date.now() });
    reply(); reply(); finish();
    const messages = runtime.getMessages(id);
    assert.equal(messages[1]?.turnStartedAt, undefined);
    assert.ok(messages[2]?.turnCompletedAt);
    const expected = { startedAt: messages[2]?.turnStartedAt, completedAt: messages[2]?.turnCompletedAt };
    await runtime.branchConversation(id, 0);
    const forked = runtime.getMessages(runtime.activeConversationId!).at(-1)!;
    assert.deepEqual({ startedAt: forked.turnStartedAt, completedAt: forked.turnCompletedAt }, expected);
  });

  it("does not assign old replies a new duration when the new request fails before producing a message", async t => {
    const { runtime, id, entry, start, finish, reply } = await fixture(t);
    start(); entry.sessionManager.appendMessage({ role: "user", content: "first", timestamp: Date.now() });
    reply(); finish();
    const old = runtime.getMessages(id).at(-1)!;
    start(); entry.sessionManager.appendMessage({ role: "user", content: "failed", timestamp: Date.now() }); finish();
    const assistant = runtime.getMessages(id).find(message => message.role === "assistant")!;
    assert.equal(assistant.turnCompletedAt, old.turnCompletedAt);
    assert.equal(readTurnTimings(entry.sessionManager.getBranch()).size, 1);
  });

  it("keeps elapsed time for an inactive chat and excludes later time spent in another chat", async t => {
    const { cwd, runtime, id, entry, start, finish, reply } = await fixture(t);
    t.mock.timers.enable({ apis: ["Date"], now: 1000 });
    start(); entry.sessionManager.appendMessage({ role: "user", content: "background", timestamp: 1000 }); reply();
    await runtime.createConversation(cwd);
    t.mock.timers.tick(2000); finish();
    t.mock.timers.tick(9000);
    const background = runtime.listConversations().find(item => item.id === id)!;
    assert.equal(background.turnCompletedAt, 3000);
    await runtime.switchConversation(id);
    assert.equal(runtime.getMessages(id).at(-1)?.turnCompletedAt, 3000);
  });

  it("ignores malformed timings and records outside the selected branch", async t => {
    const { entry, start, finish, reply } = await fixture(t);
    const leaf = entry.sessionManager.appendMessage({ role: "user", content: "before", timestamp: Date.now() });
    start(); reply(); finish();
    assert.equal(readTurnTimings(entry.sessionManager.getBranch()).size, 1);
    entry.sessionManager.branch(leaf);
    entry.sessionManager.appendCustomEntry("vela_rewind", {});
    assert.equal(readTurnTimings(entry.sessionManager.getBranch()).size, 0);
    entry.sessionManager.appendCustomEntry(turnTimingEntryType, { assistantEntryId: "bad", startedAt: 20, completedAt: 10 });
    entry.sessionManager.appendCustomEntry(turnTimingEntryType, { assistantEntryId: "bad", startedAt: "10", completedAt: 20 });
    assert.equal(readTurnTimings(entry.sessionManager.getBranch()).size, 0);
  });
});
