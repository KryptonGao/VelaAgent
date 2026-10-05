import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type ToolCall } from "@earendil-works/pi-ai";
import { AgentRuntime } from "../src/runtime.ts";
import { memoryRevision } from "../src/memory.ts";
import { memoryReadToolName, memoryUpdateToolName } from "../src/memory-tools.ts";
import { selectForkMessages, type AgentSessionRequest } from "../src/agent-control.ts";
import { defaultToolPolicy } from "../src/interaction.ts";

interface ConversationInternals {
  session: AgentSession;
  recipeExecution?: unknown;
  scheduledTaskConversation?: boolean;
}

interface Internals {
  conversations: Map<string, ConversationInternals>;
  applyActiveTools(entry: ConversationInternals): void;
  createChildSession(entry: ConversationInternals, input: AgentSessionRequest): Promise<AgentSession>;
}

interface Fixture {
  runtime: AgentRuntime;
  root: string;
  workspace: string;
  agentDir: string;
  id: string;
  approvals: string[];
  internals(): Internals;
  session(conversationId?: string): AgentSession;
  projectFile(): string;
}

async function fixture(t: TestContext, options: { hasWorkspace?: boolean; allow?: boolean } = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "vela-memory-tools-runtime-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "profile");
  await mkdir(workspace);
  await mkdir(agentDir);
  const approvals: string[] = [];
  const runtime = new AgentRuntime({
    cwd: workspace,
    agentDir,
    memoryPermission: { request: async (input) => { approvals.push(input.path); return options.allow !== false; } },
  });
  t.after(async () => {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  });
  await runtime.createConversation(workspace, { hasWorkspace: options.hasWorkspace });
  const id = runtime.activeConversationId!;
  await runtime.addModel({
    providerId: "memory-tools-fixture", providerName: "Memory tools fixture", modelId: "fixture-model",
    modelName: "Memory tools fixture", api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1",
    apiKey: "synthetic-memory-tools-key", reasoning: false, contextWindow: 32768, maxTokens: 4096,
  });
  await runtime.saveAgentSettings({
    ...await runtime.getAgentSettings(), provider: "memory-tools-fixture", modelId: "fixture-model", thinkingLevel: "off",
  });
  const internals = () => runtime as unknown as Internals;
  const projectFile = async (): Promise<string> => join(await realpath(workspace), ".vela", "MEMORY.md");
  return {
    runtime, root, workspace, agentDir, id, approvals, internals,
    session: (conversationId = id) => internals().conversations.get(conversationId)!.session,
    projectFile,
  };
}

function scripted(session: AgentSession, replies: Array<string | ToolCall[]>, observe?: (system: string) => void): () => void {
  let index = 0;
  session.agent.streamFunction = (model, context) => {
    observe?.(effectiveSystemText(context as unknown as Context));
    const reply = replies[index++];
    assert.notEqual(reply, undefined, "No real model request may escape the fixture");
    const message: AssistantMessage = {
      role: "assistant", api: model.api, provider: model.provider, model: model.id,
      content: typeof reply === "string" ? [{ type: "text", text: reply }] : reply,
      stopReason: typeof reply === "string" ? "stop" : "toolUse", timestamp: Date.now(),
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    const output = createAssistantMessageEventStream();
    output.push({ type: "start", partial: message });
    if (typeof reply === "string") output.push({ type: "text_delta", contentIndex: 0, delta: reply, partial: message });
    else reply.forEach((toolCall, contentIndex) => output.push({ type: "toolcall_end", contentIndex, toolCall, partial: message }));
    output.push({ type: "done", reason: typeof reply === "string" ? "stop" : "toolUse", message });
    return output;
  };
  return () => assert.equal(index, replies.length, "the scripted model must consume exactly its fixture replies");
}

function effectiveSystemText(context: Context): string {
  let content = "";
  const sections = new Map<string, string>();
  for (const message of context.messages) {
    if (message.role !== "system") continue;
    if (typeof message.content === "string") content = content ? `${content}\n${message.content}` : message.content;
    else content = [content, ...message.content.map((part) => part.text)].filter((text) => text.length > 0).join("\n");
    for (const [name, value] of Object.entries(message.sections ?? {})) {
      if (value === null) sections.delete(name);
      else sections.set(name, value);
    }
  }
  return [content, ...sections.values()].filter((text) => text.length > 0).join("\n");
}

function toolResult(session: AgentSession, toolCallId: string) {
  const message = session.messages.find((value) => value.role === "toolResult" && value.toolCallId === toolCallId);
  assert.ok(message?.role === "toolResult", `missing tool result ${toolCallId}`);
  return message;
}

async function writeProjectMemory(f: Fixture, content: string): Promise<void> {
  await mkdir(join(f.workspace, ".vela"), { recursive: true });
  await writeFile(join(f.workspace, ".vela", "MEMORY.md"), content, "utf8");
}

it("模型在真实会话里读取记忆后按 revision 保存项目记忆", async (t) => {
  const f = await fixture(t);
  await writeProjectMemory(f, "项目约定：旧命令\n");
  const revision = memoryRevision("项目约定：旧命令\n");
  let system = "";
  const check = scripted(f.session(), [
    [{ type: "toolCall", id: "read-memory", name: memoryReadToolName, arguments: { scope: "project" } }],
    [{ type: "toolCall", id: "update-memory", name: memoryUpdateToolName, arguments: {
      scope: "project", content: "项目约定：旧命令\n项目约定：新命令\n", expectedRevision: revision,
    } }],
    "已经记住新命令",
  ], (value) => { system = value; });
  await f.runtime.prompt(f.id, "这个项目记住测试命令");
  check();

  assert.match(system, /memory_update/, "系统提示要包含记忆写入规则");
  assert.equal(toolResult(f.session(), "read-memory").isError, false);
  assert.equal(toolResult(f.session(), "update-memory").isError, false);
  assert.equal(await readFile(await f.projectFile(), "utf8"), "项目约定：旧命令\n项目约定：新命令\n");
  assert.deepEqual(f.approvals, [await f.projectFile()], "项目写入走沙箱写权限且在工作区内");
});

// 使用脚本模型验证工具、持久化及下一轮加载；信息选择由生产模型按系统提示执行。
for (const scenario of [
  { scope: "project", hasWorkspace: true, input: "这个项目统一使用 pnpm，测试先跑受影响的模块。", content: "# 项目约定\n- 使用 pnpm。\n- 测试先跑受影响的模块。\n" },
  { scope: "global", hasWorkspace: true, input: "我平时喜欢中文回答，解释尽量简洁。", content: "# 回复偏好\n- 默认用中文，解释简洁。\n" },
  { scope: "global", hasWorkspace: false, input: "我平时喜欢中文回答，解释尽量简洁。", content: "# 回复偏好\n- 默认用中文，解释简洁。\n" },
] as const) {
  it(`无需“记住”指令即可通过工具保存 ${scenario.scope} 记忆并在下一轮加载（工作区=${scenario.hasWorkspace}）`, async (t) => {
    const f = await fixture(t, scenario);
    const check = scripted(f.session(), [
      [{ type: "toolCall", id: "auto-read", name: memoryReadToolName, arguments: { scope: scenario.scope } }],
      [{ type: "toolCall", id: "auto-save", name: memoryUpdateToolName, arguments: {
        scope: scenario.scope, content: scenario.content, expectedRevision: "absent",
      } }],
      "已保存长期偏好或约定。",
    ], (system) => {
      assert.match(system, /不需要等待用户说“记住”/);
      assert.match(system, /没有值得长期保存的新信息时不调用写入工具/);
      assert.match(system, /不要自动保存/);
      assert.match(system, /敏感个人信息不自动写入/);
    });
    await f.runtime.prompt(f.id, scenario.input);
    check();
    assert.equal(toolResult(f.session(), "auto-save").isError, false);
    const path = scenario.scope === "project" ? await f.projectFile() : join(f.agentDir, "MEMORY.md");
    assert.equal(await readFile(path, "utf8"), scenario.content);
    assert.deepEqual(f.approvals, [path]);

    let nextSystem = "";
    const next = scripted(f.session(), ["按已保存的约定继续。"], (system) => { nextSystem = system; });
    await f.runtime.prompt(f.id, "继续");
    next();
    assert.ok(nextSystem.includes(scenario.content.trim()), "下一轮自动加载新保存的记忆");
    assert.equal(f.runtime.getMemoryStatus(f.id).find((source) => source.scope === scenario.scope)?.status, "loaded");
    if (!scenario.hasWorkspace) {
      assert.equal(await readFile(await f.projectFile(), "utf8").catch(() => null), null);
    }
  });
}

it("自动保存被拒绝时不创建记忆文件", async (t) => {
  const f = await fixture(t, { allow: false });
  const check = scripted(f.session(), [
    [{ type: "toolCall", id: "auto-read", name: memoryReadToolName, arguments: { scope: "project" } }],
    [{ type: "toolCall", id: "auto-denied", name: memoryUpdateToolName, arguments: {
      scope: "project", content: "项目统一使用 pnpm\n", expectedRevision: "absent",
    } }],
    "本轮使用 pnpm；记忆写入被拒绝，文件没有变化。",
  ]);
  await f.runtime.prompt(f.id, "项目统一使用 pnpm。");
  check();
  assert.equal(toolResult(f.session(), "auto-denied").isError, true);
  assert.equal(await readFile(await f.projectFile(), "utf8").catch(() => null), null);
  assert.deepEqual(f.approvals, [await f.projectFile()]);
});

it("版本冲突时工具报错、保留原文件且不请求审批", async (t) => {
  const f = await fixture(t);
  await writeProjectMemory(f, "项目约定：旧命令\n");
  const stale = memoryRevision("项目约定：旧命令\n");
  // 外部编辑造成 revision 变化。
  await writeFile(await f.projectFile(), "外部编辑\n", "utf8");

  const check = scripted(f.session(), [
    [{ type: "toolCall", id: "update-conflict", name: memoryUpdateToolName, arguments: {
      scope: "project", content: "覆盖内容\n", expectedRevision: stale,
    } }],
    "冲突后没有保存",
  ]);
  await f.runtime.prompt(f.id, "更新记忆");
  check();

  const result = toolResult(f.session(), "update-conflict");
  assert.equal(result.isError, true, "冲突必须作为工具错误反馈给模型");
  assert.match(JSON.stringify(result.content), /conflict/);
  assert.equal(await readFile(await f.projectFile(), "utf8"), "外部编辑\n");
  assert.deepEqual(f.approvals, [], "冲突在权限审批之前发现");
});

it("Plan 模式只激活 memory_read，写入被策略拒绝且没有文件副作用", async (t) => {
  const f = await fixture(t);
  await f.runtime.setMode(f.id, "plan");
  const active = f.session().getActiveToolNames();
  assert.ok(active.includes(memoryReadToolName));
  assert.equal(active.includes(memoryUpdateToolName), false, "Plan 模式不能激活 memory_update");
  assert.equal(defaultToolPolicy.authorizeCall({ mode: "plan", toolName: memoryReadToolName, input: {} }).allowed, true);
  assert.equal(defaultToolPolicy.authorizeCall({ mode: "plan", toolName: memoryUpdateToolName, input: {} }).allowed, false);

  // 模型直接调用已注册但未激活的工具时，运行时的执行前校验会拦住。
  const check = scripted(f.session(), [
    [{ type: "toolCall", id: "plan-write", name: memoryUpdateToolName, arguments: {
      scope: "project", content: "不应写入\n", expectedRevision: "absent",
    } }],
    "计划中列出拟保存内容",
  ]);
  await f.runtime.prompt(f.id, "先做个计划");
  check();
  assert.equal(toolResult(f.session(), "plan-write").isError, true);
  assert.equal(await readFile(await f.projectFile(), "utf8").catch(() => null), null, "Plan 模式不能创建记忆文件");
  assert.deepEqual(f.approvals, []);
});

it("explore 与 general 子代理只注册 memory_read", async (t) => {
  const f = await fixture(t);
  await writeProjectMemory(f, "项目约定：只读可见\n");
  const entry = f.internals().conversations.get(f.id)!;
  const root = f.session();
  for (const kind of ["explore", "general"] as const) {
    const child = await f.internals().createChildSession(entry, {
      agentId: `${kind}-1`, parentId: f.id, parentPath: "/root", parentSession: root, kind,
      name: kind, path: `/root/${kind}`, forkMessages: selectForkMessages(root.messages, "all"),
      customTools: [], sessionFile: null,
    });
    const registered = child.getAllTools().map((tool) => tool.name);
    assert.ok(registered.includes(memoryReadToolName), `${kind} 应能读取记忆`);
    assert.equal(registered.includes(memoryUpdateToolName), false, `${kind} 不能注册 memory_update`);
    assert.ok(child.getActiveToolNames().includes(memoryReadToolName));
  }
});

it("定时任务和配方执行的根会话只激活 memory_read", async (t) => {
  const f = await fixture(t);
  assert.ok(f.session().getActiveToolNames().includes(memoryUpdateToolName));
  const entry = f.internals().conversations.get(f.id)!;

  entry.scheduledTaskConversation = true;
  f.internals().applyActiveTools(entry);
  assert.deepEqual(
    f.session().getActiveToolNames().filter((name) => name.startsWith("memory_")),
    [memoryReadToolName],
  );
  // 后台会话直接调用已注册的 memory_update 也被执行前校验拦住。
  const check = scripted(f.session(), [
    [{ type: "toolCall", id: "background-write", name: memoryUpdateToolName, arguments: {
      scope: "project", content: "后台不应写入\n", expectedRevision: "absent",
    } }],
    "后台任务完成",
  ]);
  await f.runtime.prompt(f.id, "后台任务");
  check();
  assert.equal(toolResult(f.session(), "background-write").isError, true);
  assert.deepEqual(f.approvals, [], "后台执行在权限审批前就被拒绝");
  assert.equal(await readFile(await f.projectFile(), "utf8").catch(() => null), null);

  entry.scheduledTaskConversation = false;
  entry.recipeExecution = { model: { provider: "memory-tools-fixture", id: "fixture-model" }, thinkingLevel: "off", sandboxMode: "ask" };
  f.internals().applyActiveTools(entry);
  assert.deepEqual(
    f.session().getActiveToolNames().filter((name) => name.startsWith("memory_")),
    [memoryReadToolName],
  );

  // 配方只读阶段沿用 Plan 工具集，读取保留。
  entry.recipeStageSideEffect = "read_only";
  f.internals().applyActiveTools(entry);
  assert.deepEqual(
    f.session().getActiveToolNames().filter((name) => name.startsWith("memory_")),
    [memoryReadToolName],
  );
  f.runtime.setMemoryEnabled(false);
  assert.deepEqual(f.session().getActiveToolNames().filter((name) => name.startsWith("memory_")), []);
  f.runtime.setMemoryEnabled(true);
  assert.deepEqual(f.session().getActiveToolNames().filter((name) => name.startsWith("memory_")), [memoryReadToolName]);
});
