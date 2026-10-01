import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { AgentRuntime } from "../src/runtime.ts";
import { TurnCheckpoints } from "../src/turn-checkpoints.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "vela-rewind-runtime-"));
  const cwd = join(root, "workspace"), agentDir = join(root, "agent");
  await mkdir(cwd); await mkdir(agentDir);
  const runtime = new AgentRuntime({ cwd, agentDir });
  cleanups.push(async () => { runtime.dispose(); await rm(root, { recursive: true, force: true }); });
  await runtime.createConversation(cwd);
  const id = runtime.activeConversationId!;
  const entry = (runtime as unknown as { conversations: Map<string, { sessionManager: SessionManager; driving: boolean }> }).conversations.get(id)!;
  const metadata = { plans: [], latestProposedPlanId: null, executionPlans: [], activeExecutionPlanId: null, goal: null, agents: [], agentLeaves: {} };
  const checkpoints = new TurnCheckpoints(join(agentDir, "checkpoints", id), cwd, agentDir);
  const file = join(cwd, "a.txt");
  async function turn(text: string, content: string) {
    const point = await checkpoints.begin(entry.sessionManager.getLeafId(), metadata);
    const userId = entry.sessionManager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
    await writeFile(file, content);
    await checkpoints.finish(point, userId);
  }
  return { runtime, id, entry, file, turn, checkpoints, agentDir, cwd };
}

describe("rewind conversation", () => {
  it("keeps the chat id, removes the edited turn and all later content and file changes", async () => {
    const { runtime, id, file, turn, checkpoints, entry, agentDir, cwd } = await fixture();
    await writeFile(file, "existing dirty work");
    await turn("first", "first change"); await turn("second", "second change"); await turn("third", "third change");
    assert.deepEqual(runtime.getMessages(id).map(message => message.text), ["first", "second", "third"]);
    await runtime.rewindConversation(id, 1);
    assert.equal(runtime.activeConversationId, id);
    assert.deepEqual(runtime.getMessages(id).map(message => message.text), ["first"]);
    assert.equal(await readFile(file, "utf8"), "first change");
    assert.equal((await checkpoints.list()).length, 1);
    // The rewind marker survives reopening before a replacement message is sent.
    const reopened = SessionManager.open(entry.sessionManager.getSessionFile()!, join(agentDir, "sessions"), cwd);
    assert.deepEqual(reopened.buildSessionProjection().messages.filter(message => message.role === "user").map(message => message.content), ["first"]);
    entry.sessionManager.appendMessage({ role: "user", content: "edited second", timestamp: Date.now() });
    assert.deepEqual(runtime.getMessages(id).map(message => message.text), ["first", "edited second"]);
  });
  it("can rewind the first message after an application restart", async () => {
    const { runtime, id, file, turn, agentDir, cwd } = await fixture();
    await writeFile(file, "before chat"); await turn("original", "change");
    runtime.dispose();
    const restored = new AgentRuntime({ agentDir, cwd });
    cleanups.push(async () => restored.dispose());
    await restored.switchConversation(id);
    await restored.rewindConversation(id, 0);
    assert.equal(restored.activeConversationId, id);
    assert.deepEqual(restored.getMessages(id), []);
    assert.equal(await readFile(file, "utf8"), "before chat");
  });
  it("leaves history intact on file conflict or invalid turn", async () => {
    const { runtime, id, file, turn } = await fixture();
    await writeFile(file, "before"); await turn("original", "agent change");
    await writeFile(file, "manual change");
    await assert.rejects(runtime.rewindConversation(id, 0), /冲突/);
    assert.deepEqual(runtime.getMessages(id).map(message => message.text), ["original"]);
    assert.equal(await readFile(file, "utf8"), "manual change");
    await assert.rejects(runtime.rewindConversation(id, 9), /找不到/);
    assert.deepEqual(runtime.getMessages(id).map(message => message.text), ["original"]);
  });
  it("refuses to rewind while a workspace task is running", async () => {
    const { runtime, id, entry, file, turn } = await fixture();
    await writeFile(file, "before"); await turn("original", "agent change");
    entry.driving = true;
    await assert.rejects(runtime.rewindConversation(id, 0), /任务运行中/);
    entry.driving = false;
    assert.equal(await readFile(file, "utf8"), "agent change");
  });
});

it("automatically captures checkpoints around a prompt, including aborted or failed work", async () => {
  const { runtime, id, entry, file, checkpoints } = await fixture();
  await writeFile(file, "before model");
  const internals = runtime as unknown as {
    conversations: Map<string, { session: { prompt: () => Promise<void> } }>;
    runSinglePrompt: (entry: unknown, text: string, images: undefined, options: { rename: boolean; release: boolean }) => Promise<string>;
  };
  const session = internals.conversations.get(id)!.session;
  session.prompt = async () => {
    entry.sessionManager.appendMessage({ role: "user", content: "change it", timestamp: Date.now() });
    await writeFile(file, "partial failed work");
    throw new Error("simulated model failure");
  };
  assert.equal(await internals.runSinglePrompt(entry, "change it", undefined, { rename: false, release: true }), "error");
  assert.equal((await checkpoints.list()).length, 1);
  await runtime.rewindConversation(id, 0);
  assert.equal(await readFile(file, "utf8"), "before model");
  assert.deepEqual(runtime.getMessages(id), []);
});
