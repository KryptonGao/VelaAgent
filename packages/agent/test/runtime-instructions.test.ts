import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { RuntimeEvent } from "../src/runtime.ts";
import { AgentRuntime } from "../src/runtime.ts";

/**
 * 控制运行中指令所需的会话表面：steer / followUp / clearQueue / 队列查询 / 事件订阅。
 * 队列消费用 deliver() 模拟 Pi 在消息边界 splice + queue_update 的行为。
 */
class FakeSession {
  isStreaming = false;
  sessionFile: string | null = null;
  readonly sessionManager = {
    getSessionFile: () => this.sessionFile,
    getLeafId: () => null,
  };
  readonly agent = { streamFunction: (() => undefined) as unknown };
  readonly steered: string[] = [];
  readonly followUps: string[] = [];
  aborted = false;
  disposed = false;
  inputHandler?: (text: string, mode: "steer" | "queue") => Promise<"handled" | "queued">;
  consumeOnEnqueue = false;
  private steeringQueue: string[] = [];
  private followUpQueue: string[] = [];
  private readonly listeners = new Set<(event: AgentSessionEvent) => void>();

  asSession(): AgentSession {
    return this as unknown as AgentSession;
  }

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async steer(text: string): Promise<"handled" | "queued"> {
    if (await this.inputHandler?.(text, "steer") === "handled") return "handled";
    this.steered.push(text);
    this.steeringQueue.push(text);
    this.emitQueue();
    if (this.consumeOnEnqueue) this.deliver("steer");
    return "queued";
  }

  async followUp(text: string): Promise<"handled" | "queued"> {
    if (await this.inputHandler?.(text, "queue") === "handled") return "handled";
    this.followUps.push(text);
    this.followUpQueue.push(text);
    this.emitQueue();
    if (this.consumeOnEnqueue) this.deliver("queue");
    return "queued";
  }

  clearQueue(): { steering: string[]; followUp: string[] } {
    const cleared = { steering: [...this.steeringQueue], followUp: [...this.followUpQueue] };
    this.steeringQueue = [];
    this.followUpQueue = [];
    this.emitQueue();
    return cleared;
  }

  getSteeringMessages(): readonly string[] {
    return [...this.steeringQueue];
  }

  getFollowUpMessages(): readonly string[] {
    return [...this.followUpQueue];
  }

  async abort(): Promise<void> {
    this.aborted = true;
  }

  dispose(): void {
    this.disposed = true;
  }

  /** 模拟 Pi 消费一条指令：从队列移除并广播 queue_update。 */
  deliver(mode: "steer" | "queue"): void {
    if (mode === "steer") this.steeringQueue.shift();
    else this.followUpQueue.shift();
    this.emitQueue();
  }

  private emitQueue(): void {
    for (const listener of this.listeners) {
      listener({ type: "queue_update", steering: [...this.steeringQueue], followUp: [...this.followUpQueue] });
    }
  }
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "vela-instructions-"));
  const cwd = join(root, "workspace");
  await mkdir(cwd);
  const runtime = new AgentRuntime({ cwd, agentDir: root });
  t.after(async () => {
    runtime.dispose();
    await rm(root, { recursive: true, force: true });
  });
  await runtime.createConversation(cwd);
  const id = runtime.activeConversationId!;
  const internals = runtime as unknown as {
    conversations: Map<string, {
      session: AgentSession;
      sessionManager: unknown;
      driving: boolean;
      snapshot: { pendingInstructions: Array<{ id: string; mode: string; text: string }> };
    }>;
    attachEntry: (entry: unknown, session: AgentSession, manager: unknown) => void;
  };
  const entry = internals.conversations.get(id)!;
  const session = new FakeSession();
  session.sessionFile = "fake-session.jsonl";
  internals.attachEntry(entry, session.asSession(), entry.sessionManager);
  const events: RuntimeEvent[] = [];
  const unsubscribe = runtime.subscribe((event) => events.push(event));
  t.after(unsubscribe);
  return { runtime, id, entry, session, events };
}

function pendingTexts(entry: { snapshot: { pendingInstructions: Array<{ text: string }> } }): string[] {
  return entry.snapshot.pendingInstructions.map((instruction) => instruction.text);
}

describe("runtime instructions", () => {
  for (const mode of ["steer", "queue"] as const) {
    it(`does not report ${mode} input consumed by an extension as a user message`, async t => {
      const { runtime, id, entry, session, events } = await fixture(t);
      entry.driving = true;
      session.inputHandler = async () => "handled";
      await runtime.prompt(id, "扩展处理", undefined, mode);
      assert.deepEqual(pendingTexts(entry), []);
      assert.equal(events.some(event => event.type === "user_message"), false);
      assert.equal(runtime.listConversations().find(item => item.id === id)?.messageCount, 0);
    });

    it(`accounts for ${mode} delivery before the queued disposition resolves exactly once`, async t => {
      const { runtime, id, entry, session, events } = await fixture(t);
      entry.driving = true;
      session.consumeOnEnqueue = true;
      await runtime.prompt(id, "立即消费", undefined, mode);
      assert.deepEqual(pendingTexts(entry), []);
      assert.equal(events.filter(event => event.type === "user_message").length, 1);
      assert.equal(runtime.listConversations().find(item => item.id === id)?.messageCount, 1);
    });
  }

  it("does not mistake a pending input handler for delivery when an earlier input is consumed", async t => {
    const { runtime, id, entry, session, events } = await fixture(t);
    entry.driving = true;
    await runtime.prompt(id, "已排队", undefined, "steer");
    let resolveInput!: (result: "handled") => void;
    session.inputHandler = () => new Promise(resolve => { resolveInput = resolve; });
    const submitting = runtime.prompt(id, "被扩展处理", undefined, "steer");
    session.deliver("steer");
    assert.deepEqual(pendingTexts(entry), ["被扩展处理"]);
    resolveInput("handled");
    await submitting;
    assert.deepEqual(pendingTexts(entry), []);
    assert.deepEqual(events.filter(event => event.type === "user_message").map(event => event.text), ["已排队"]);
  });

  it("drops handled input during queue replay without fabricating delivery", async t => {
    const { runtime, id, entry, session, events } = await fixture(t);
    entry.driving = true;
    await runtime.prompt(id, "撤销", undefined, "steer");
    await runtime.prompt(id, "重建时处理", undefined, "steer");
    await runtime.prompt(id, "留下", undefined, "queue");
    session.inputHandler = async text => text === "重建时处理" ? "handled" : "queued";
    await runtime.removeInstruction(id, runtime.getSnapshot().pendingInstructions[0]!.id);
    assert.deepEqual(pendingTexts(entry), ["留下"]);
    assert.equal(events.some(event => event.type === "user_message"), false);
    session.deliver("queue");
    assert.deepEqual(events.filter(event => event.type === "user_message").map(event => event.text), ["留下"]);
  });

  it("removes rejected input without reporting delivery", async t => {
    const { runtime, id, entry, session, events } = await fixture(t);
    entry.driving = true;
    session.inputHandler = async () => { throw new Error("input failed"); };
    await assert.rejects(runtime.prompt(id, "错误输入", undefined, "queue"), /input failed/);
    assert.deepEqual(pendingTexts(entry), []);
    assert.equal(events.some(event => event.type === "user_message"), false);
  });

  it("steers a running session at the next boundary and reports delivery", async t => {
    const { runtime, id, entry, session, events } = await fixture(t);
    entry.driving = true;
    session.isStreaming = true;
    await runtime.prompt(id, "  只修登录问题，先不要重构路由  ", undefined, "steer");
    assert.deepEqual(pendingTexts(entry), ["只修登录问题，先不要重构路由"]);
    assert.deepEqual(session.steered, ["只修登录问题，先不要重构路由"]);
    const pending = runtime.getSnapshot().pendingInstructions;
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.mode, "steer");
    assert.ok(pending[0]!.createdAt > 0);
    assert.equal(events.some(event => event.type === "user_message"), false);

    session.deliver("steer");
    assert.deepEqual(pendingTexts(entry), []);
    assert.equal(runtime.getSnapshot().pendingInstructions.length, 0);
    const users = events.filter(event => event.type === "user_message");
    assert.deepEqual(users.map(event => (event as { text: string }).text), ["只修登录问题，先不要重构路由"]);
    assert.equal(runtime.listConversations().find(item => item.id === id)?.messageCount, 1);
  });

  it("queues a follow-up and only surfaces it when the task finishes it", async t => {
    const { runtime, id, entry, session, events } = await fixture(t);
    entry.driving = true;
    session.isStreaming = true;
    await runtime.prompt(id, "完成后补充使用说明", undefined, "queue");
    assert.deepEqual(session.followUps, ["完成后补充使用说明"]);
    assert.deepEqual(pendingTexts(entry), ["完成后补充使用说明"]);
    assert.equal(runtime.getSnapshot().pendingInstructions[0]!.mode, "queue");

    session.deliver("queue");
    assert.deepEqual(pendingTexts(entry), []);
    const users = events.filter(event => event.type === "user_message");
    assert.deepEqual(users.map(event => (event as { text: string }).text), ["完成后补充使用说明"]);
  });

  it("removes one instruction by rebuilding the Pi queues in order", async t => {
    const { runtime, id, entry, session } = await fixture(t);
    entry.driving = true;
    session.isStreaming = true;
    await runtime.prompt(id, "先看构建", undefined, "steer");
    await runtime.prompt(id, "再看测试", undefined, "steer");
    await runtime.prompt(id, "最后写说明", undefined, "queue");
    const target = runtime.getSnapshot().pendingInstructions.find(instruction => instruction.text === "再看测试")!;

    await runtime.removeInstruction(id, target.id);
    assert.deepEqual(pendingTexts(entry), ["先看构建", "最后写说明"]);
    // 撤销时先清空再回放：steer 队列留下的顺序是 先看构建 -> 再看测试 -> 先看构建。
    assert.deepEqual(session.steered, ["先看构建", "再看测试", "先看构建"]);
    assert.deepEqual(session.followUps, ["最后写说明", "最后写说明"]);
    assert.deepEqual([...session.getSteeringMessages()], ["先看构建"]);
    assert.deepEqual([...session.getFollowUpMessages()], ["最后写说明"]);
    // 撤销不存在的 id 不改变任何状态。
    await runtime.removeInstruction(id, "missing");
    assert.deepEqual(pendingTexts(entry), ["先看构建", "最后写说明"]);
  });

  it("aborts every pending instruction with the existing stop path", async t => {
    const { runtime, id, entry, session, events } = await fixture(t);
    entry.driving = true;
    session.isStreaming = true;
    await runtime.prompt(id, "调整方向", undefined, "steer");
    await runtime.prompt(id, "收尾工作", undefined, "queue");
    assert.equal(runtime.getSnapshot().pendingInstructions.length, 2);

    await runtime.abort(id);
    assert.equal(session.aborted, true);
    assert.deepEqual(pendingTexts(entry), []);
    assert.deepEqual([...session.getSteeringMessages()], []);
    assert.deepEqual([...session.getFollowUpMessages()], []);
    assert.equal(events.some(event => event.type === "user_message"), false);
  });

  it("rejects empty instructions", async t => {
    const { runtime, id, entry, session } = await fixture(t);
    entry.driving = true;
    session.isStreaming = true;
    await assert.rejects(runtime.prompt(id, "   ", undefined, "steer"), /不能为空/);
    assert.deepEqual(pendingTexts(entry), []);
  });
});
