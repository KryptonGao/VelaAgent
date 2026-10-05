import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it, type TestContext } from "node:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from "@earendil-works/pi-ai";
import { memoryFileMaxBytes, type MemoryLoadReport } from "@vela/shared";
import { AgentRuntime } from "../src/runtime.ts";
import { MemorySettings } from "../src/memory-settings.ts";
import { selectForkMessages, type AgentSessionRequest } from "../src/agent-control.ts";

const marker = (text: string) => `__MEMORY_${text}__`;

interface Internals {
  conversations: Map<string, { session: AgentSession }>;
  createChildSession(entry: unknown, input: AgentSessionRequest): Promise<AgentSession>;
}

interface Fixture {
  readonly runtime: AgentRuntime;
  readonly root: string;
  readonly agentDir: string;
  readonly workspace: string;
  readonly other: string;
  readonly id: string;
  internals(): Internals;
  session(conversationId?: string): AgentSession;
  prompt(conversationId: string, text: string, mode?: "steer" | "queue"): Promise<void>;
  /** 关闭后重建 runtime，模拟应用重启后的会话恢复。 */
  restore(conversationId: string): Promise<AgentRuntime>;
  writeMemory(workspace: string, content: string): Promise<void>;
  writeGlobal(content: string): Promise<void>;
  requests: Context[];
  script(replies: Array<string | (() => Promise<string>)>, session: AgentSession): () => void;
}

async function eventually<T>(read: () => T, accept: (value: T) => boolean, message: string, timeout = 6000): Promise<T> {
  const until = Date.now() + timeout;
  let last: T | undefined;
  do {
    last = read();
    if (accept(last)) return last;
    await delay(10);
  } while (Date.now() < until);
  assert.fail(`${message}: ${JSON.stringify(last)}`);
}

function effectiveSystemText(context: Context): string {
  let content = "";
  const sections = new Map<string, string>();
  for (const message of context.messages) {
    if (message.role !== "system") continue;
    if (typeof message.content === "string") content = content ? `${content}\n${message.content}` : message.content;
    else content = [content, ...message.content.map((part) => part.text)].filter((text) => text.length > 0).join("\n");
    // 后续 system 消息只带变化的分区；按顺序覆盖才能还原当前生效的提示词。
    for (const [name, value] of Object.entries(message.sections ?? {})) {
      if (value === null) sections.delete(name);
      else sections.set(name, value);
    }
  }
  return [content, ...sections.values()].filter((text) => text.length > 0).join("\n");
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

async function fixture(t: TestContext): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "vela-memory-runtime-"));
  const agentDir = join(root, "agent");
  const workspace = join(root, "alpha");
  const other = join(root, "beta");
  await mkdir(agentDir);
  await mkdir(workspace);
  await mkdir(other);
  const runtimeOptions = { cwd: workspace, agentDir };
  let current = new AgentRuntime(runtimeOptions);
  const runtimes: AgentRuntime[] = [current];
  t.after(async () => {
    for (const value of runtimes) await value.dispose();
    await rm(root, { recursive: true, force: true });
  });
  await current.createConversation(workspace);
  const id = current.activeConversationId!;
  await current.addModel({
    providerId: "memory-fixture", providerName: "Local memory fixture", modelId: "fixture-model",
    modelName: "Local memory fixture", api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1",
    apiKey: "synthetic-memory-fixture-key", reasoning: false, contextWindow: 32768, maxTokens: 4096,
  });
  await current.saveAgentSettings({
    ...await current.getAgentSettings(), provider: "memory-fixture", modelId: "fixture-model", thinkingLevel: "off",
  });

  const internals = () => current as unknown as Internals;
  const requests: Context[] = [];
  const writeMemory = async (target: string, content: string): Promise<void> => {
    await mkdir(join(target, ".vela"), { recursive: true });
    await writeFile(join(target, ".vela", "MEMORY.md"), content, "utf8");
  };
  const writeGlobal = async (content: string): Promise<void> => {
    await writeFile(join(agentDir, "MEMORY.md"), content, "utf8");
  };
  const script = (replies: Array<string | (() => Promise<string>)>, session: AgentSession): (() => void) => {
    let invocation = 0;
    const stream: StreamFn = (model, context) => {
      requests.push(structuredClone(context) as unknown as Context);
      const reply = replies[invocation++];
      assert.ok(reply !== undefined, "unexpected extra model request; no real provider may be used");
      const message: AssistantMessage = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: [{ type: "text", text: "" }], stopReason: "stop", timestamp: Date.now(),
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      const output = createAssistantMessageEventStream();
      output.push({ type: "start", partial: message });
      void (async () => {
        const text = typeof reply === "function" ? await reply() : reply;
        message.content = [{ type: "text", text }];
        output.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
        output.push({ type: "done", reason: "stop", message });
      })();
      return output;
    };
    session.agent.streamFunction = stream as unknown as AgentSession["agent"]["streamFunction"];
    return () => assert.equal(invocation, replies.length, "the scripted model must consume exactly its fixture replies");
  };

  return {
    get runtime() { return current; },
    root, agentDir, workspace, other, id, internals, requests, script, writeMemory, writeGlobal,
    session: (conversationId = id) => internals().conversations.get(conversationId)!.session,
    prompt: (conversationId, text, mode) => current.prompt(conversationId, text, undefined, mode),
    restore: async (conversationId) => {
      await current.dispose();
      current = new AgentRuntime(runtimeOptions);
      runtimes.push(current);
      await current.switchConversation(conversationId);
      return current;
    },
  };
}

function statusOf(sources: MemoryLoadReport[], scope: "global" | "project"): MemoryLoadReport | undefined {
  return sources.find((source) => source.scope === scope);
}

describe("AgentRuntime 记忆加载", { timeout: 30_000 }, () => {
  it("运行中关闭后，steering 触发的后续模型请求不再携带记忆", async (t) => {
    const f = await fixture(t);
    await f.writeMemory(f.workspace, `${marker("LIVE_SWITCH")}\n`);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const check = f.script([async () => { await gate; return "第一条"; }, "第二条"], f.session());
    const running = f.prompt(f.id, "任务");
    await eventually(() => f.requests.length, (value) => value === 1, "没有发出模型请求");
    f.runtime.setMemoryEnabled(false);
    await f.prompt(f.id, "继续", "steer");
    release();
    await running;
    check();
    assert.match(effectiveSystemText(f.requests[0]!), new RegExp(marker("LIVE_SWITCH")));
    assert.doesNotMatch(effectiveSystemText(f.requests[1]!), new RegExp(marker("LIVE_SWITCH")));
    assert.doesNotMatch(effectiveSystemText(f.requests[1]!), /自动写入：/);
    assert.ok(!f.session().getActiveToolNames().includes("memory_read"));
  });

  it("关闭后停止加载并停用工具，文件保留；重启保持关闭，重新开启后恢复", async (t) => {
    const f = await fixture(t);
    await f.writeGlobal(`${marker("SWITCH_GLOBAL")}\n`);
    await f.writeMemory(f.workspace, `${marker("SWITCH_PROJECT")}\n`);
    assert.deepEqual(f.runtime.getMemorySettings(), { enabled: true });
    const check = f.script(["开启", "关闭", "重新开启"], f.session());
    await f.prompt(f.id, "第一次");
    assert.match(effectiveSystemText(f.requests[0]!), new RegExp(marker("SWITCH_PROJECT")));

    f.runtime.setMemoryEnabled(false);
    assert.ok(!f.session().getActiveToolNames().some((name) => name.startsWith("memory_")));
    assert.deepEqual(f.runtime.getMemoryStatus(f.id), []);
    await f.prompt(f.id, "第二次");
    const disabled = effectiveSystemText(f.requests[1]!);
    assert.doesNotMatch(disabled, /__MEMORY_SWITCH_/);
    assert.doesNotMatch(disabled, /自动写入：/);
    assert.match(disabled, /长期记忆已关闭/);
    assert.equal(await readFile(join(f.agentDir, "MEMORY.md"), "utf8"), `${marker("SWITCH_GLOBAL")}\n`);
    assert.equal(await readFile(join(f.workspace, ".vela", "MEMORY.md"), "utf8"), `${marker("SWITCH_PROJECT")}\n`);

    f.runtime.setMemoryEnabled(true);
    await f.prompt(f.id, "第三次");
    check();
    assert.match(effectiveSystemText(f.requests[2]!), new RegExp(marker("SWITCH_PROJECT")));
    assert.ok(f.session().getActiveToolNames().includes("memory_update"));
    f.runtime.setMemoryEnabled(false);
    await f.restore(f.id);
    assert.deepEqual(f.runtime.getMemorySettings(), { enabled: false });
    const restored = f.script(["恢复"], f.session());
    await f.prompt(f.id, "重启后");
    restored();
    assert.doesNotMatch(effectiveSystemText(f.requests[3]!), /__MEMORY_SWITCH_/);
  });

  it("关闭时新建的子代理不读取记忆，也不提供记忆工具", async (t) => {
    const f = await fixture(t);
    await f.writeMemory(f.workspace, `${marker("DISABLED_CHILD")}\n`);
    f.runtime.setMemoryEnabled(false);
    const child = await f.internals().createChildSession(f.internals().conversations.get(f.id), {
      agentId: "disabled-child", parentId: f.id, parentPath: "/root", parentSession: f.session(), kind: "general",
      name: "general", path: "/root/general", forkMessages: [], customTools: [], sessionFile: null,
    });
    assert.ok(!child.getActiveToolNames().includes("memory_read"));
    const check = f.script(["完成"], child);
    await child.prompt("子任务");
    check();
    assert.doesNotMatch(effectiveSystemText(f.requests[0]!), new RegExp(marker("DISABLED_CHILD")));
    assert.deepEqual(f.runtime.getMemoryStatus(f.id, "disabled-child"), []);
    f.runtime.setMemoryEnabled(true);
    assert.ok(child.getActiveToolNames().includes("memory_read"));
    assert.ok(!child.getActiveToolNames().includes("memory_update"));
  });

  it("每次执行注入全局和所属项目记忆，项目之间互不泄漏", async (t) => {
    const f = await fixture(t);
    await f.writeGlobal(`# 全局\n${marker("GLOBAL")}\n`);
    await f.writeMemory(f.workspace, `# 项目 A\n${marker("ALPHA")}\n`);
    await f.writeMemory(f.other, `# 项目 B\n${marker("BETA")}\n`);

    // 后台会话：创建 B 之后 A 不再是界面当前会话，A 仍要读取自己的工作区。
    await f.runtime.createConversation(f.other);
    const backgroundId = f.runtime.activeConversationId!;
    const check = f.script(["A 完成"], f.session());
    await f.prompt(f.id, "项目 A 的任务");
    check();

    assert.equal(f.runtime.activeConversationId, backgroundId, "后台执行不应切换界面项目");
    const system = effectiveSystemText(f.requests[0]!);
    assert.match(system, new RegExp(marker("GLOBAL")));
    assert.match(system, new RegExp(marker("ALPHA")));
    assert.doesNotMatch(system, new RegExp(marker("BETA")), "其他项目正文不能进入当前上下文");
    assert.equal(count(system, '<memory scope="project"'), 1);

    const status = f.runtime.getMemoryStatus(f.id);
    assert.deepEqual(status.map((source) => [source.scope, source.status]), [
      ["global", "loaded"],
      ["project", "loaded"],
    ]);
    assert.ok(status.every((source) => !("content" in source)), "状态不能携带正文");
    assert.equal(statusOf(status, "project")?.bytes, Buffer.byteLength(`# 项目 A\n${marker("ALPHA")}\n`));

    // 同一项目的另一个会话复用同一份记忆，仍然看不到项目 B。
    await f.runtime.createConversation(f.workspace);
    const secondId = f.runtime.activeConversationId!;
    const checkSecond = f.script(["A2 完成"], f.session(secondId));
    await f.prompt(secondId, "项目 A 的第二个会话");
    checkSecond();
    const secondSystem = effectiveSystemText(f.requests[1]!);
    assert.match(secondSystem, new RegExp(marker("GLOBAL")));
    assert.match(secondSystem, new RegExp(marker("ALPHA")));
    assert.doesNotMatch(secondSystem, new RegExp(marker("BETA")));
  });

  it("外部编辑在下一次执行生效，新建、恢复和 worktree 各读自己的文件", async (t) => {
    const f = await fixture(t);
    await f.writeGlobal(`全局 ${marker("GLOBAL")}\n`);
    await f.writeMemory(f.workspace, `主工作树 ${marker("MAIN_V1")}\n`);
    const check = f.script(["第一次", "第二次"], f.session());

    await f.prompt(f.id, "第一轮");
    assert.match(effectiveSystemText(f.requests[0]!), new RegExp(marker("MAIN_V1")));

    // 外部编辑器改文件：已打开的会话在下一次执行看到新内容，不需要重建。
    await f.writeMemory(f.workspace, `主工作树 ${marker("MAIN_V2")}\n`);
    await f.prompt(f.id, "第二轮");
    check();
    assert.match(effectiveSystemText(f.requests[1]!), new RegExp(marker("MAIN_V2")));
    assert.doesNotMatch(effectiveSystemText(f.requests[1]!), new RegExp(marker("MAIN_V1")));

    // worktree 按实际 checkout 隔离：另一个工作树有自己的 .vela/MEMORY.md。
    const worktree = join(f.root, "alpha-worktree");
    await mkdir(worktree, { recursive: true });
    await f.writeMemory(worktree, `worktree ${marker("WORKTREE")}\n`);
    await f.runtime.createConversation(worktree);
    const worktreeId = f.runtime.activeConversationId!;
    const checkWorktree = f.script(["worktree 完成"], f.session(worktreeId));
    await f.prompt(worktreeId, "worktree 任务");
    checkWorktree();
    const worktreeSystem = effectiveSystemText(f.requests[2]!);
    assert.match(worktreeSystem, new RegExp(marker("WORKTREE")));
    assert.doesNotMatch(worktreeSystem, new RegExp(marker("MAIN_V2")), "worktree 不能回退读取主工作树的记忆");
  });

  for (const mode of ["steer", "queue"] as const) {
    it(`运行中的 ${mode} 指令沿用本次执行快照，下一条消息读取最新文件`, async (t) => {
      const f = await fixture(t);
      await f.writeMemory(f.workspace, `${marker("SNAPSHOT_V1")}\n`);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const check = f.script([
        async () => { await gate; return "第一次回复"; },
        "第二次回复",
        "第三次回复",
      ], f.session());

      const running = f.prompt(f.id, "第一轮");
      await eventually(() => f.requests.length, (value) => value >= 1, "第一个模型请求没有发出");
      await eventually(() => f.session().isStreaming, (value) => value, "会话没有进入流式状态");
      await f.prompt(f.id, "调整当前任务", mode);
      // 同一执行期间的外部编辑不能改变已经固定的快照。
      await f.writeMemory(f.workspace, `${marker("SNAPSHOT_V2")}\n`);
      release();
      await running;
      assert.equal(f.requests.length, 2, "排队/调整消息应在同一次执行里被消费");
      assert.match(effectiveSystemText(f.requests[1]!), new RegExp(marker("SNAPSHOT_V1")));
      assert.doesNotMatch(effectiveSystemText(f.requests[1]!), new RegExp(marker("SNAPSHOT_V2")));

      await f.prompt(f.id, "下一轮");
      check();
      assert.match(effectiveSystemText(f.requests[2]!), new RegExp(marker("SNAPSHOT_V2")), "新执行必须重新读取文件");
    });
  }

  it("fork 历史不重复携带注入的记忆，子代理读取所属根会话的项目", async (t) => {
    const f = await fixture(t);
    await f.writeMemory(f.workspace, `${marker("FORK")}\n`);
    const check = f.script(["根任务完成"], f.session());
    await f.prompt(f.id, "根任务");
    check();

    const root = f.session();
    const child = await f.internals().createChildSession(f.internals().conversations.get(f.id), {
      agentId: "general-1", parentId: f.id, parentPath: "/root", parentSession: root, kind: "general",
      name: "general", path: "/root/general", forkMessages: selectForkMessages(root.messages, "all"),
      customTools: [], sessionFile: null,
    });
    const childRequests: Context[] = [];
    let childInvocations = 0;
    const childStream: StreamFn = (model, context) => {
      childRequests.push(structuredClone(context) as unknown as Context);
      childInvocations += 1;
      const message: AssistantMessage = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: [{ type: "text", text: "子任务完成" }], stopReason: "stop", timestamp: Date.now(),
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      const output = createAssistantMessageEventStream();
      output.push({ type: "start", partial: message });
      output.push({ type: "text_delta", contentIndex: 0, delta: "子任务完成", partial: message });
      output.push({ type: "done", reason: "stop", message });
      return output;
    };
    child.agent.streamFunction = childStream as unknown as AgentSession["agent"]["streamFunction"];
    await child.prompt("子任务");
    assert.equal(childInvocations, 1);

    const childSystem = effectiveSystemText(childRequests[0]!);
    assert.equal(count(childSystem, marker("FORK")), 1, "fork 不能重复注入同一记忆");
    assert.equal(count(childSystem, '<memory scope="project"'), 1);
    const nonSystem = JSON.stringify(childRequests[0]!.messages.filter((message) => message.role !== "system"));
    assert.doesNotMatch(nonSystem, new RegExp(marker("FORK")), "fork 历史不能携带记忆正文");

    const status = f.runtime.getMemoryStatus(f.id, "general-1");
    assert.deepEqual(status.map((source) => [source.scope, source.status]), [
      ["global", "missing"],
      ["project", "loaded"],
    ]);
  });

  it("恢复的会话在下一次执行重新加载最新记忆", async (t) => {
    const f = await fixture(t);
    await f.writeMemory(f.workspace, `${marker("RESTORE_V1")}\n`);
    const check = f.script(["第一次"], f.session());
    await f.prompt(f.id, "第一轮");
    check();

    await f.writeMemory(f.workspace, `${marker("RESTORE_V2")}\n`);
    await f.restore(f.id);
    const checkRestored = f.script(["恢复完成"], f.session(f.id));
    await f.prompt(f.id, "恢复后的第一轮");
    checkRestored();

    const system = effectiveSystemText(f.requests[1]!);
    assert.match(system, new RegExp(marker("RESTORE_V2")));
    assert.doesNotMatch(system, new RegExp(marker("RESTORE_V1")), "恢复后不能沿用旧快照");
    assert.deepEqual(f.runtime.getMemoryStatus(f.id).map((source) => [source.scope, source.status]), [
      ["global", "missing"],
      ["project", "loaded"],
    ]);
  });

  it("无工作区会话只加载全局记忆，缺失文件不产生副作用", async (t) => {
    const f = await fixture(t);
    await f.writeGlobal(`${marker("GLOBAL_ONLY")}\n`);
    await f.writeMemory(f.workspace, `${marker("PROJECT_SECRET")}\n`);
    await f.runtime.createConversation(f.workspace, { hasWorkspace: false });
    const id = f.runtime.activeConversationId!;
    const check = f.script(["完成"], f.session(id));
    await f.prompt(id, "无工作区任务");
    check();

    const system = effectiveSystemText(f.requests[0]!);
    assert.match(system, new RegExp(marker("GLOBAL_ONLY")));
    assert.doesNotMatch(system, new RegExp(marker("PROJECT_SECRET")), "无工作区会话不能读取项目记忆");
    assert.deepEqual(f.runtime.getMemoryStatus(id).map((source) => source.scope), ["global"]);
    assert.equal(await readFile(join(f.workspace, ".vela", "MEMORY.md"), "utf8"), `${marker("PROJECT_SECRET")}\n`);

    // 全新工作区没有记忆：读取不创建 .vela，也不影响聊天。
    const fresh = join(f.root, "fresh");
    await mkdir(fresh, { recursive: true });
    await f.runtime.createConversation(fresh);
    const freshId = f.runtime.activeConversationId!;
    const checkFresh = f.script(["照常对话"], f.session(freshId));
    await f.prompt(freshId, "普通任务");
    checkFresh();
    assert.equal(existsSync(join(fresh, ".vela")), false, "读取记忆不能创建目录");
    assert.deepEqual(f.runtime.getMemoryStatus(freshId).map((source) => [source.scope, source.status]), [
      ["global", "loaded"],
      ["project", "missing"],
    ]);
  });

  it("项目文件损坏时保留现场并继续聊天，全局记忆独立加载", async (t) => {
    const f = await fixture(t);
    await f.writeGlobal(`${marker("GLOBAL_HEALTHY")}\n`);
    await mkdir(join(f.workspace, ".vela"), { recursive: true });
    await writeFile(join(f.workspace, ".vela", "MEMORY.md"), Buffer.from("x".repeat(memoryFileMaxBytes + 1)));

    const check = f.script(["继续工作"], f.session());
    await f.prompt(f.id, "读取损坏记忆的任务");
    check();
    const system = effectiveSystemText(f.requests[0]!);
    assert.match(system, new RegExp(marker("GLOBAL_HEALTHY")));
    assert.doesNotMatch(system, /xxxxxxxxxx/);
    const status = f.runtime.getMemoryStatus(f.id);
    assert.equal(statusOf(status, "global")?.status, "loaded");
    assert.equal(statusOf(status, "project")?.status, "failed");
    assert.equal(statusOf(status, "project")?.error, "content-too-large");
    assert.equal((await readFile(join(f.workspace, ".vela", "MEMORY.md"))).byteLength, memoryFileMaxBytes + 1);
  });
});

describe("记忆开关持久化", () => {
  it("无配置默认开启，损坏的已有配置保持关闭，保存失败不改变当前状态", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "vela-memory-settings-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const settings = new MemorySettings(root);
    assert.equal(settings.enabled, true);
    settings.setEnabled(false);
    assert.equal(new MemorySettings(root).enabled, false);
    await writeFile(join(root, "memory-settings.json"), "invalid json");
    assert.equal(new MemorySettings(root).enabled, false);
    const unusable = join(root, "file");
    await writeFile(unusable, "not a directory");
    const unavailable = new MemorySettings(unusable);
    assert.equal(unavailable.enabled, false);
    assert.throws(() => unavailable.setEnabled(true));
    assert.equal(unavailable.enabled, false);
  });
});
