import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
  AgentControl,
  maxConcurrentAgents,
  selectForkMessages,
  type AgentControlHost,
  type AgentRootMessage,
  type AgentSessionRequest,
} from "../src/agent-control.ts";

/** 只实现控制面用到的会话表面：prompt / subscribe / abort / dispose / messages / errorMessage。 */
class FakeSession {
  sessionFile: string | null = null;
  readonly sessionManager = { getSessionFile: () => this.sessionFile };
  readonly messages: AgentMessage[] = [];
  readonly prompts: string[] = [];
  readonly agent = { state: { errorMessage: undefined as string | undefined } };
  responder: (text: string, session: FakeSession) => Promise<string> = async () => "做完了";
  disposed = false;
  aborted = false;
  private readonly listeners = new Set<(event: AgentSessionEvent) => void>();
  private release: (() => void) | null = null;

  asSession(): AgentSession {
    return this as unknown as AgentSession;
  }

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async prompt(text: string): Promise<void> {
    this.prompts.push(text);
    const reply = await this.responder(text, this);
    this.messages.push({
      role: "assistant",
      content: [{ type: "text", text: reply }],
      timestamp: Date.now(),
    } as unknown as AgentMessage);
    for (const listener of this.listeners) listener({ type: "turn_end" } as AgentSessionEvent);
  }

  async abort(): Promise<void> {
    this.aborted = true;
    this.release?.();
  }

  dispose(): void {
    this.disposed = true;
  }

  /** 让 responder 一直挂起，直到 abort 或测试主动放行。 */
  blockUntilReleased(): Promise<void> {
    return new Promise((resolve) => {
      this.release = resolve;
    });
  }
}

class FakeHost implements AgentControlHost {
  readonly rootMessages: AgentRootMessage[] = [];
  readonly sessions = new Map<string, FakeSession>();
  readonly requests: AgentSessionRequest[] = [];
  readonly agentEvents: Array<{ conversationId: string; agentId: string; event: AgentSessionEvent }> = [];
  sessionFactory: ((input: AgentSessionRequest) => FakeSession) | null = null;

  async createChildSession(input: AgentSessionRequest): Promise<AgentSession> {
    this.requests.push(input);
    const session = this.sessionFactory?.(input) ?? new FakeSession();
    this.sessions.set(input.path, session);
    return session.asSession();
  }

  deliverToRoot(input: { conversationId: string; message: AgentRootMessage }): void {
    this.rootMessages.push(input.message);
  }

  onAgentEvent(input: { conversationId: string; agentId: string; event: AgentSessionEvent }): void {
    this.agentEvents.push(input);
  }
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let index = 0; index < 400; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`等待超时: ${label}`);
}

function createControl(): { control: AgentControl; host: FakeHost; root: FakeSession } {
  const host = new FakeHost();
  const control = new AgentControl({ conversationId: "root-id", host });
  const root = new FakeSession();
  control.registerRoot(root.asSession());
  return { control, host, root };
}

function userMessage(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: 1 } as unknown as AgentMessage;
}

function assistantText(text: string): AgentMessage {
  return { role: "assistant", content: [{ type: "text", text }], timestamp: 2 } as unknown as AgentMessage;
}

function assistantCall(id: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name: "read", arguments: {} }],
    timestamp: 2,
  } as unknown as AgentMessage;
}

function toolResult(id: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: "read",
    content: [{ type: "text", text: "ok" }],
    isError: false,
    timestamp: 3,
  } as unknown as AgentMessage;
}

describe("fork 选择", () => {
  const messages = [
    userMessage("第一轮"),
    assistantText("答一轮"),
    userMessage("第二轮"),
    assistantText("答二轮"),
    userMessage("第三轮"),
    assistantText("答三轮"),
  ];

  it("none 不继承，all 全量", () => {
    assert.deepEqual(selectForkMessages(messages, "none"), []);
    assert.equal(selectForkMessages(messages, "all").length, messages.length);
  });

  it("数字只取最近 N 轮", () => {
    const last = selectForkMessages(messages, 1);
    assert.equal(last.length, 2);
    assert.equal(last[0]?.role, "user");
    assert.equal(selectForkMessages(messages, 2).length, 4);
    assert.equal(selectForkMessages(messages, 0).length, 0);
    assert.equal(selectForkMessages(messages, 99).length, messages.length);
  });

  it("丢掉结尾未配对的工具调用", () => {
    const dangling = [userMessage("改文件"), assistantCall("call-1")];
    assert.deepEqual(selectForkMessages(dangling, "all"), [dangling[0]]);
    const resolved = [userMessage("改文件"), assistantCall("call-1"), toolResult("call-1")];
    assert.equal(selectForkMessages(resolved, "all").length, 3);
  });
});

describe("agent 树", () => {
  it("恢复节点时不自动运行；后续任务沿用历史文件且新代理避开旧路径", async () => {
    const { control, host } = createControl();
    host.sessionFactory = () => {
      const session = new FakeSession();
      session.sessionFile = "/tmp/child-history.jsonl";
      return session;
    };
    const info = control.spawn("root-id", { kind: "explore", task: "查文件", name: "history" });
    await waitFor(() => control.list().find((item) => item.id === info.id)?.status === "completed", "历史代理完成");
    const stored = control.storedAgents();
    assert.equal(stored[0]?.sessionFile, "/tmp/child-history.jsonl");
    control.dispose();

    const restoredHost = new FakeHost();
    const restored = new AgentControl({ conversationId: "root-id", host: restoredHost, restoredAgents: stored });
    restored.registerRoot(new FakeSession().asSession());
    assert.equal(restoredHost.requests.length, 0);
    assert.equal(restored.list().find((item) => item.id === info.id)?.finalText, "做完了");
    await restored.followup("root-id", info.id, "继续检查", undefined);
    assert.equal(restoredHost.requests[0]?.sessionFile, "/tmp/child-history.jsonl");
    assert.deepEqual(restoredHost.requests[0]?.forkMessages, []);
    const next = restored.spawn("root-id", { kind: "explore", task: "新的检查", name: "history" });
    assert.equal(next.path, "/root/history-2");
    await waitFor(() => restored.list().find((item) => item.id === next.id)?.status === "completed", "新代理完成");
    restored.dispose();
  });

  it("spawn 立即返回标识，完成后把结论投递给 root", async () => {
    const { control, host } = createControl();
    const info = control.spawn("root-id", { kind: "explore", task: "查启动流程", name: "startup" });
    assert.equal(info.path, "/root/startup");
    assert.equal(info.depth, 1);
    assert.equal(info.status, "idle");
    assert.equal(control.list().length, 2);

    await waitFor(() => control.list().find((agent) => agent.id === info.id)?.status === "completed", "子代理完成");
    const agent = control.list().find((item) => item.id === info.id);
    assert.equal(agent?.finalText, "做完了");
    assert.equal(host.rootMessages.length, 1);
    assert.equal(host.rootMessages[0]?.kind, "result");
    assert.equal(host.rootMessages[0]?.path, "/root/startup");
    assert.match(host.rootMessages[0]?.text ?? "", /做完了/);
    // 子代理自己的会话事件按 agentId 透出，供右侧 Agent Pane 实时渲染。
    assert.ok(host.agentEvents.some((item) => item.agentId === info.id && item.event.type === "turn_end"));
    assert.ok(host.agentEvents.every((item) => item.conversationId === "root-id"));
    assert.equal(host.requests[0]?.agentId, info.id);
  });

  it("子代理可以继续派子代理，路径逐层累加", async () => {
    const { control, host } = createControl();
    const parent = control.spawn("root-id", { kind: "general", task: "做后端", name: "backend" });
    const child = control.spawn(parent.id, { kind: "explore", task: "查数据库", name: "database" });
    assert.equal(child.path, "/root/backend/database");
    assert.equal(child.depth, 2);
    await waitFor(
      () => control.list().filter((agent) => agent.kind !== "root").every((agent) => agent.status === "completed"),
      "两层子代理完成",
    );
    assert.equal(host.requests.length, 2);
    assert.equal(host.requests[1]?.parentPath, "/root/backend");
  });

  it("超过最大深度和数量时拒绝继续创建", () => {
    const { control } = createControl();
    const first = control.spawn("root-id", { kind: "general", task: "一层", name: "a" });
    const second = control.spawn(first.id, { kind: "general", task: "两层", name: "b" });
    const third = control.spawn(second.id, { kind: "general", task: "三层", name: "c" });
    assert.throws(() => control.spawn(third.id, { kind: "explore", task: "四层" }), /嵌套/);
  });

  it("explore 只能创建和联系 explore", () => {
    const { control } = createControl();
    const explorer = control.spawn("root-id", { kind: "explore", task: "查阅", name: "scan" });
    const editor = control.spawn("root-id", { kind: "general", task: "实现", name: "editor" });
    assert.throws(() => control.spawn(explorer.id, { kind: "general", task: "改文件" }), /explore/);
    assert.throws(() => control.send(explorer.id, editor.path, "帮我改"), /explore/);
  });

  it("按路径、名字和 id 都能寻址", async () => {
    const { control } = createControl();
    const info = control.spawn("root-id", { kind: "general", task: "工作", name: "worker" });
    control.send("root-id", "/root/worker", "按路径");
    control.send("root-id", "worker", "按名字");
    control.send("root-id", info.id, "按 id");
    assert.throws(() => control.send("root-id", "missing", "hi"), /找不到/);
  });
});

describe("消息投递", () => {
  it("followup_task 等待并返回结论，不重复通知父代理", async () => {
    const { control, host } = createControl();
    const info = control.spawn("root-id", { kind: "general", task: "初版", name: "work" });
    const result = await control.followup("root-id", info.id, "再改一次", undefined);
    assert.equal(result.status, "completed");
    assert.match(result.text, /\/root\/work/);
    assert.match(result.text, /做完了/);
    assert.equal(result.agent.status, "completed");
    assert.equal(host.rootMessages.filter((message) => message.kind === "result").length, 1);
  });

  it("send_message 不阻塞，消息排进对方队列", async () => {
    const { control, host } = createControl();
    const parent = control.spawn("root-id", { kind: "general", task: "主任务", name: "app" });
    const child = control.spawn(parent.id, { kind: "general", task: "子任务", name: "db" });
    control.send(child.id, parent.path, "顺便看下索引");
    control.send(child.id, "/root", "报告一下");

    assert.equal(host.rootMessages.at(-1)?.kind, "message");
    assert.equal(host.rootMessages.at(-1)?.path, "/root/app/db");
    await waitFor(
      () => Boolean(host.sessions.get("/root/app")?.prompts.some((text) => text.includes("顺便看下索引"))),
      "父代理收到消息",
    );
  });

  it("并发运行不超过上限，多余任务排队", async () => {
    const { control, host } = createControl();
    let running = 0;
    let maxRunning = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    host.sessionFactory = () => {
      const session = new FakeSession();
      session.responder = async () => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await gate;
        running -= 1;
        return "done";
      };
      return session;
    };
    for (let index = 0; index < maxConcurrentAgents + 1; index += 1) {
      control.spawn("root-id", { kind: "explore", task: `任务 ${index}`, name: `job-${index}` });
    }
    await waitFor(() => running === maxConcurrentAgents, "并发槽位用满");
    assert.equal(maxRunning, maxConcurrentAgents);
    release();
    await waitFor(
      () => control.list().filter((agent) => agent.kind !== "root").every((agent) => agent.status === "completed"),
      "全部完成",
    );
    assert.ok(maxRunning <= maxConcurrentAgents);
  });

  it("abortAll 停止运行中的子代理并清空排队任务", async () => {
    const { control, host } = createControl();
    host.sessionFactory = () => {
      const session = new FakeSession();
      session.responder = async (_text, current) => {
        await current.blockUntilReleased();
        return "没做完";
      };
      return session;
    };
    const info = control.spawn("root-id", { kind: "general", task: "慢任务", name: "slow" });
    await waitFor(() => control.list().find((agent) => agent.id === info.id)?.status === "running", "子代理开始运行");
    control.abortAll();
    await waitFor(() => control.list().find((agent) => agent.id === info.id)?.status === "aborted", "子代理已停止");
    assert.equal(host.rootMessages.filter((message) => message.status === "aborted").length, 0);
  });

  it("dispose 释放子会话并了结等待者", async () => {
    const { control, host } = createControl();
    host.sessionFactory = () => {
      const session = new FakeSession();
      session.responder = async (_text, current) => {
        await current.blockUntilReleased();
        return "没做完";
      };
      return session;
    };
    const info = control.spawn("root-id", { kind: "general", task: "慢任务", name: "slow" });
    await waitFor(() => host.sessions.has("/root/slow"), "子会话已创建");
    const pending = control.followup("root-id", info.id, "追加", undefined);
    // followup 排队后立刻释放整棵树，等待者应该拿到中止结果。
    control.dispose();
    const result = await pending;
    assert.equal(result.status, "aborted");
  });
});


it("Browser Host details-only failures mark child steps failed and potentially mutated", async () => {
  const { control } = createControl();
  const info = control.spawn("root-id", { kind: "general", task: "check UI", name: "browser" });
  await waitFor(() => control.list().find(agent => agent.id === info.id)?.status === "completed", "child complete");
  const internals = control as unknown as { agents: Map<string, unknown>; handleSessionEvent(agent: unknown, event: AgentSessionEvent): void };
  const managed = internals.agents.get(info.id)!;
  internals.handleSessionEvent(managed, { type: "tool_execution_start", toolCallId: "browser-call", toolName: "browser_repl", args: { code: "await tab.url()" } } as AgentSessionEvent);
  internals.handleSessionEvent(managed, { type: "tool_execution_end", toolCallId: "browser-call", toolName: "browser_repl", isError: false, result: { content: [{ type: "text", text: "Tab closed" }], details: { isError: true } } } as AgentSessionEvent);
  const child = control.list().find(agent => agent.id === info.id)!;
  assert.equal(child.steps.find(step => step.id === "browser-call")?.status, "error");
  assert.equal(child.mutated, true);
  control.dispose();
});
