import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage, type ToolCall } from "@earendil-works/pi-ai";
import { AgentRuntime } from "../src/runtime.ts";
import { createScheduledTaskTools, scheduledTaskToolNames } from "../src/scheduled-task-tools.ts";
import { ScheduledTaskScheduler } from "../../../apps/desktop/src/main/scheduled-task-service.ts";
import { createSandboxedToolDefinitions } from "../../workspace/src/sandbox-tools.ts";
import { SandboxPermissionManager } from "../../workspace/src/sandbox-permission-manager.ts";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "vela-task-runtime-"));
  const cwd = join(root, "workspace"), other = join(root, "other"); await mkdir(cwd); await mkdir(other);
  let runtime!: AgentRuntime;
  const scheduler = new ScheduledTaskScheduler(join(root, "tasks.json"), (task, link) => runtime.runScheduledTask(task.workspace, task.prompt, link, task)); scheduler.init();
  const permission = new SandboxPermissionManager(join(root, "settings.json"));
  permission.subscribe(event => { if (event.type === "request") permission.reply(event.request.id, false); });
  runtime = new AgentRuntime({ cwd, agentDir: root, scheduledTasks: scheduler,
    toolFactory: (cwd, context) => createSandboxedToolDefinitions({ cwd, workspace: cwd, permission, ...context }) });
  t.after(async () => { scheduler.stop(); await runtime.dispose(); await scheduler.drain(); await rm(root, { recursive: true, force: true }); });
  await runtime.createConversation(cwd);
  await runtime.addModel({ providerId: "task-fixture", providerName: "Task fixture", modelId: "fixture", modelName: "Fixture", api: "openai-completions",
    baseUrl: "http://127.0.0.1:1/v1", apiKey: "synthetic-test-key", reasoning: false, contextWindow: 32768, maxTokens: 4096 });
  await runtime.saveAgentSettings({ ...await runtime.getAgentSettings(), provider: "task-fixture", modelId: "fixture", thinkingLevel: "off" });
  const chats = (runtime as unknown as { conversations: Map<string, { session: AgentSession }> }).conversations;
  return { runtime, scheduler, permission, cwd, other, root, session: (id: string) => chats.get(id)!.session };
}
function scripted(session: AgentSession, replies: Array<string | ToolCall[]>, observe?: (prompt: string) => void) {
  let index = 0;
  session.agent.streamFunction = (model, context) => {
    observe?.(JSON.stringify(context));
    const reply = replies[index++]; assert.notEqual(reply, undefined, "No real model request may escape the fixture");
    const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
      content: typeof reply === "string" ? [{ type: "text", text: reply }] : reply,
      stopReason: typeof reply === "string" ? "stop" : "toolUse", timestamp: Date.now(),
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const output = createAssistantMessageEventStream(); output.push({ type: "start", partial: message });
    if (typeof reply === "string") output.push({ type: "text_delta", contentIndex: 0, delta: reply, partial: message });
    else reply.forEach((toolCall, contentIndex) => output.push({ type: "toolcall_end", contentIndex, toolCall, partial: message }));
    output.push({ type: "done", reason: typeof reply === "string" ? "stop" : "toolUse", message });
    return output;
  };
  return () => assert.equal(index, replies.length);
}

it("natural-language chat reaches the real Pi tool registry and creates a persistent task", async t => {
  const f = await fixture(t); const id = f.runtime.activeConversationId!; let prompt = "";
  for (const name of scheduledTaskToolNames) assert.ok(f.session(id).getAllTools().some(tool => tool.name === name));
  const check = scripted(f.session(id), [[{ type: "toolCall", id: "create-task", name: "create_scheduled_task", arguments: {
    title: "复习英语", prompt: "提醒我复习英语", sandboxMode: "ask", model: { provider: "task-fixture", id: "fixture" }, thinkingLevel: "off", schedule: { kind: "daily", time: "22:00", timezone: "Asia/Taipei" },
  } }], "已创建任务"], value => { prompt = value; });
  await f.runtime.prompt(id, "每天晚上 10 点提醒我复习英语"); check();
  assert.equal(f.scheduler.list().tasks.length, 1);
  assert.equal(f.scheduler.list().tasks[0].workspace, f.cwd);
  assert.equal(f.scheduler.list().tasks[0].schedule.kind, "daily");
  assert.equal(f.scheduler.list().tasks[0].sandboxMode, "ask");
  assert.equal(f.scheduler.list().tasks[0].thinkingLevel, "off");
  assert.deepEqual(f.scheduler.list().tasks[0].model, { provider: "task-fixture", id: "fixture" });
  assert.match(prompt, /任务时间上下文/); assert.match(prompt, /Scheduled Tasks/);
  const toolResult = f.session(id).messages.find(message => message.role === "toolResult" && message.toolCallId === "create-task");
  assert.ok(toolResult?.role === "toolResult" && !toolResult.isError);
  await f.runtime.setMode(id, "plan");
  assert.ok(f.runtime.getSnapshot().tools.includes("list_scheduled_tasks"));
  assert.ok(!f.runtime.getSnapshot().tools.includes("create_scheduled_task"));
  // A model trying to invoke a registered but inactive mutating tool is blocked by the runtime guard.
  const blocked = scripted(f.session(id), [[{ type: "toolCall", id: "blocked-task", name: "create_scheduled_task", arguments: {
    title: "blocked", prompt: "blocked", schedule: { kind: "daily", time: "10:00", timezone: "UTC" },
  } }], "Plan report"]);
  await f.runtime.prompt(id, "查看任务"); blocked(); assert.equal(f.scheduler.list().tasks.length, 1);
});
it("background execution creates a separate persisted chat in its workspace without changing the selection", async t => {
  const f = await fixture(t); const active = f.runtime.activeConversationId!;
  const actualPrompt = f.runtime.prompt.bind(f.runtime);
  let calledText = "", backgroundId = "";
  f.runtime.prompt = async (id, text) => { backgroundId = id; calledText = text; const check = scripted(f.session(id), ["Scheduled reply"]); await actualPrompt(id, text); check(); };
  const task = await f.scheduler.create({ title: "Reminder", prompt: "Review English", workspace: f.other, schedule: { kind: "daily", time: "22:00", timezone: "Asia/Taipei" } });
  f.scheduler.start(); await f.scheduler.runNow(task.id); await f.scheduler.drain();
  assert.equal(calledText, task.prompt); assert.notEqual(backgroundId, active);
  assert.equal(f.runtime.activeConversationId, active); assert.equal(f.runtime.getSnapshot().cwd, f.cwd);
  assert.equal(f.runtime.listConversations().find(chat => chat.id === backgroundId)?.cwd, f.other);
  assert.equal(f.scheduler.list().runs[0].status, "success"); assert.equal(f.scheduler.list().runs[0].conversationId, backgroundId);
  assert.ok(f.runtime.getMessages(backgroundId).some(message => message.role === "user" && message.text === task.prompt));
});
it("records model/runtime failures even when the ordinary prompt method catches an error internally", async t => {
  const f = await fixture(t);
  await f.runtime.selectModel("task-fixture", "fixture");
  const actualPrompt = f.runtime.prompt.bind(f.runtime);
  f.runtime.prompt = async (id, text) => {
    f.session(id).agent.streamFunction = () => { throw new Error("Scripted provider failure"); };
    await actualPrompt(id, text);
  };
  const task = await f.scheduler.create({ title: "Fail", prompt: "Prompt", workspace: f.cwd, schedule: { kind: "daily", time: "22:00", timezone: "UTC" } });
  f.scheduler.start(); await f.scheduler.runNow(task.id); await f.scheduler.drain();
  assert.equal(f.scheduler.list().runs[0].status, "failed");
  assert.match(f.scheduler.list().runs[0].error!, /Scripted provider failure/);
});
it("tools query/update/delete only their bound workspace and disallow mutations in Plan mode", async t => {
  const f = await fixture(t); const task = await f.scheduler.create({ title: "Own", prompt: "Own", workspace: f.cwd, schedule: { kind: "daily", time: "22:00", timezone: "UTC" } });
  let allowed = true;
  const tools = createScheduledTaskTools(f.scheduler, f.cwd, () => allowed);
  const other = createScheduledTaskTools(f.scheduler, f.other, () => true);
  await assert.rejects(other.find(tool => tool.name === "update_scheduled_task")!.execute("call", { id: task.id, title: "forged" }), /当前工作区/);
  const update = tools.find(tool => tool.name === "update_scheduled_task")!;
  await update.execute("call", { id: task.id, title: "Edited", status: "paused" });
  assert.equal(f.scheduler.list(f.cwd).tasks[0].title, "Edited");
  // Extra model-supplied fields must not move a task across workspace boundaries.
  await update.execute("call", { id: task.id, workspace: f.other, title: "Still scoped" });
  assert.equal(f.scheduler.list(f.cwd).tasks[0].workspace, f.cwd);
  allowed = false; await assert.rejects(update.execute("call", { id: task.id, status: "active" }), /Plan/);
  assert.ok((await tools.find(tool => tool.name === "list_scheduled_tasks")!.execute("call", {})).content.length);
  allowed = true; await tools.find(tool => tool.name === "delete_scheduled_task")!.execute("call", { id: task.id });
  assert.equal(f.scheduler.list().tasks.length, 0);
});
it("sandboxed background writes use the task workspace boundary rather than the selected workspace", async t => {
  const f = await fixture(t); const active = f.runtime.activeConversationId!;
  const actualPrompt = f.runtime.prompt.bind(f.runtime);
  f.runtime.prompt = async (id, text) => {
    const check = scripted(f.session(id), [[{ type: "toolCall", id: "write-reminder", name: "write", arguments: { path: "reminder.txt", content: "复习英语" } }], "Written"]);
    await actualPrompt(id, text); check();
    const result = f.session(id).messages.find(message => message.role === "toolResult" && message.toolCallId === "write-reminder");
    assert.ok(result?.role === "toolResult" && !result.isError);
  };
  const task = await f.scheduler.create({ title: "Write reminder", prompt: "Write reminder.txt", workspace: f.other, schedule: { kind: "daily", time: "22:00", timezone: "UTC" } });
  f.scheduler.start(); await f.scheduler.runNow(task.id); await f.scheduler.drain();
  assert.equal(f.scheduler.list().runs[0].status, "success");
  assert.equal(await readFile(join(f.other, "reminder.txt"), "utf8"), "复习英语");
  await assert.rejects(readFile(join(f.cwd, "reminder.txt"), "utf8"));
  assert.equal(f.runtime.activeConversationId, active);
});

it("uses saved task model and effort without changing the active chat or defaults", async t => {
  const f = await fixture(t);
  await f.runtime.selectModel("task-fixture", "fixture");
  const active = f.runtime.activeConversationId!;
  await f.runtime.addModel({ providerId: "task-fixture", providerName: "Task fixture", modelId: "reasoner", modelName: "Reasoner", api: "openai-completions",
    baseUrl: "http://127.0.0.1:1/v1", apiKey: "synthetic-test-key", reasoning: true, contextWindow: 32768, maxTokens: 4096 });
  await f.runtime.selectModel("task-fixture", "fixture");
  const defaults = await f.runtime.getAgentSettings();
  const actualPrompt = f.runtime.prompt.bind(f.runtime);
  f.runtime.prompt = async (id, text) => {
    assert.equal(f.session(id).model?.id, "reasoner");
    assert.equal(f.session(id).thinkingLevel, "high");
    const check = scripted(f.session(id), ["Task reply"]); await actualPrompt(id, text); check();
  };
  const task = await f.scheduler.create({ title: "Reasoned task", prompt: "Think", workspace: f.other,
    schedule: { kind: "daily", time: "22:00", timezone: "UTC" }, model: { provider: "task-fixture", id: "reasoner" }, thinkingLevel: "high" });
  f.scheduler.start(); await f.scheduler.runNow(task.id); await f.scheduler.drain();
  assert.equal(f.scheduler.list().runs[0].status, "success");
  assert.equal(f.runtime.activeConversationId, active);
  assert.equal(f.session(active).model?.id, "fixture");
  assert.equal(f.session(active).thinkingLevel, "off");
  assert.deepEqual(await f.runtime.getAgentSettings(), defaults);
});
it("records an unavailable explicit task model as failure instead of falling back", async t => {
  const f = await fixture(t);
  let prompts = 0; f.runtime.prompt = async () => { prompts++; };
  const task = await f.scheduler.create({ title: "Unavailable", prompt: "Run", workspace: f.cwd,
    schedule: { kind: "daily", time: "22:00", timezone: "UTC" }, model: { provider: "missing", id: "missing" } });
  f.scheduler.start(); await f.scheduler.runNow(task.id); await f.scheduler.drain();
  const run = f.scheduler.list().runs[0];
  assert.equal(run.status, "failed"); assert.ok(run.error); assert.ok(run.conversationId);
  assert.equal(prompts, 0);
  assert.equal(f.runtime.listConversations().find(chat => chat.id === run.conversationId)?.status, "error");
});
it("task permissions isolate terminal approval from the active chat", async t => {
  const f = await fixture(t); const active = f.runtime.activeConversationId!;
  const actualPrompt = f.runtime.prompt.bind(f.runtime);
  f.runtime.prompt = async (id, text) => {
    const check = scripted(f.session(id), [[{ type: "toolCall", id: "bash-task", name: "bash", arguments: { command: "printf task-permissions" } }], "Done"]);
    await actualPrompt(id, text); check();
  };
  const input = { title: "Permissions", prompt: "Check permissions", workspace: f.cwd, schedule: { kind: "daily" as const, time: "22:00", timezone: "UTC" } };
  const full = await f.scheduler.create({ ...input, sandboxMode: "full" });
  const ask = await f.scheduler.create({ ...input, sandboxMode: "ask" });
  f.scheduler.start(); await f.scheduler.runNow(full.id); await f.scheduler.drain();
  await f.scheduler.runNow(ask.id); await f.scheduler.drain();
  const runs = f.scheduler.list().runs;
  const result = (id: string) => f.session(runs.find(run => run.taskId === id)!.conversationId!).messages.find(message => message.role === "toolResult" && message.toolCallId === "bash-task");
  assert.equal(result(full.id)?.isError, false);
  assert.equal(result(ask.id)?.isError, true);
  assert.equal(f.permission.getMode(), "ask"); assert.equal(f.runtime.activeConversationId, active);
  await f.runtime.prompt(active, "Check active permissions");
  const activeResult = f.session(active).messages.find(message => message.role === "toolResult" && message.toolCallId === "bash-task");
  assert.equal(activeResult?.isError, true);
});
