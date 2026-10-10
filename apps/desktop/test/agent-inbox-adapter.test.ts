import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import type { AgentInfo, ScheduledTask, ScheduledTaskRun, ScheduledTasksState } from "@vela/shared";
import { QuestionManager } from "../../../packages/agent/src/question-manager.ts";
import { SandboxPermissionManager, sandboxApprovalTimeoutMs } from "../../../packages/workspace/src/sandbox-permission-manager.ts";
import { AgentInboxAdapter, stripUiFences, type AgentInboxRuntimeEvent, type AgentInboxRuntimeSource, type AgentInboxTaskInfo } from "../src/main/agent-inbox-adapter.ts";
import { AgentInboxService } from "../src/main/agent-inbox-service.ts";

async function fixture(t: TestContext, classify?: (conversationId: string) => AgentInboxTaskInfo | null) {
  const dir = await mkdtemp(join(tmpdir(), "vela-inbox-adapter-"));
  // 审批请求的 createdAt 来自真实时钟，假时钟必须从真实时间起步。
  let now = Date.now();
  const questions = new QuestionManager();
  const sandbox = new SandboxPermissionManager(join(dir, "settings.json"));
  const runtimeListeners = new Set<(event: AgentInboxRuntimeEvent) => void>();
  const schedulerListeners = new Set<(state: ScheduledTasksState) => void>();
  let scheduled: ScheduledTasksState = { tasks: [], runs: [] };
  const messages = new Map<string, Array<{ role: "user" | "assistant"; text: string }>>();
  const runtime: AgentInboxRuntimeSource = {
    subscribe: listener => { runtimeListeners.add(listener); return () => { runtimeListeners.delete(listener); }; },
    subscribeQuestions: listener => questions.subscribe(listener),
    listConversations: () => [
      { id: "active-chat", title: "Active", cwd: "/work/a", hasWorkspace: true },
      { id: "bg", title: "Background", cwd: "/work/b", hasWorkspace: true },
      { id: "sched-chat", title: "Nightly", cwd: "/work/c", hasWorkspace: true },
    ],
    getMessages: id => messages.get(id) ?? [],
  };
  const service = new AgentInboxService(join(dir, "agent-inbox.json"), {
    approve: (id, allowed) => sandbox.reply(id, allowed),
    answer: (id, answer) => questions.reply(id, answer),
  }, () => now);
  service.init();
  const adapter = new AgentInboxAdapter({
    service, runtime, sandbox,
    ...(classify ? { tasks: { classify } } : {}),
    scheduler: { list: () => scheduled, subscribe: listener => { schedulerListeners.add(listener); return () => { schedulerListeners.delete(listener); }; } },
    approvalTimeoutMs: sandboxApprovalTimeoutMs,
    now: () => now,
  });
  adapter.start();
  // 未回复的审批带 5 分钟定时器，测试结束前全部收尾，否则进程不会退出。
  const open = new Set<string>();
  sandbox.subscribe(event => { if (event.type === "request") open.add(event.request.id); else open.delete(event.id); });
  t.after(async () => { adapter.stop(); for (const id of [...open]) sandbox.reply(id, false); questions.cancelAll(); await rm(dir, { recursive: true, force: true }); });
  return {
    service, questions, sandbox, messages,
    advance: (ms: number) => { now += ms; },
    now: () => now,
    emit: (event: AgentInboxRuntimeEvent) => { for (const listener of runtimeListeners) listener(event); },
    publish: (state: ScheduledTasksState) => { scheduled = state; for (const listener of schedulerListeners) listener(state); },
    flush: () => new Promise<void>(resolve => setImmediate(resolve)),
    ask: (conversationId = "bg") => questions.ask(conversationId, { toolCallId: "t1", question: "Which API?", options: [{ label: "v1" }, { label: "v2" }], allowFreeText: false }),
    requestApproval: (conversationId = "bg") => sandbox.request({ conversationId, kind: "bash", command: "npm test", cwd: "/work/b", workspace: "/work/b" }),
  };
}

const task: ScheduledTask = {
  id: "task1", title: "Nightly check", prompt: "p", workspace: "/work/c", schedule: { kind: "daily", time: "03:00", timezone: "UTC" },
  status: "active", missedPolicy: "run-once", nextRunAt: null, createdAt: 1, updatedAt: 1,
};
const run = (id: string, status: ScheduledTaskRun["status"], finishedAt: number | null, extra: Partial<ScheduledTaskRun> = {}): ScheduledTaskRun => ({
  id, taskId: "task1", trigger: "scheduled", scheduledAt: 1, startedAt: 1, finishedAt, status, conversationId: "sched-chat", error: null, ...extra,
});

it("shows a real approval and follows the chat-side decision", async t => {
  const f = await fixture(t);
  const decision = f.requestApproval();
  const [item] = f.service.list().items;
  assert.equal(item?.type, "approval");
  assert.equal(item?.status, "pending");
  assert.equal(item?.title, "Background");
  assert.equal(item?.workspaceId, "/work/b");
  assert.equal(f.service.list().badge, 1);
  f.sandbox.reply(item!.requestId!, true);
  assert.equal(await decision, true);
  assert.equal(f.service.get(item!.id)?.status, "resolved");
  assert.equal(f.service.get(item!.id)?.outcome, "approved");
  assert.equal(f.service.list().badge, 0);
});

it("an Inbox approval reaches the real waiting tool exactly once", async t => {
  const f = await fixture(t);
  const decision = f.requestApproval();
  const item = f.service.list().items[0]!;
  const result = f.service.decide({ itemId: item.id, expectedRevision: item.revision, decision: "approve", clientActionId: "c1" });
  assert.equal(result.ok, true);
  assert.equal(await decision, true);
  const second = f.service.decide({ itemId: item.id, expectedRevision: item.revision, decision: "deny", clientActionId: "c2" });
  assert.equal(second.ok, false);
  assert.equal(f.service.get(item.id)?.outcome, "approved");
});

it("maps denial and timeout to different business states", async t => {
  const f = await fixture(t);
  const denied = f.requestApproval();
  f.advance(1);
  const timedOut = f.requestApproval();
  const [newest, oldest] = f.service.list().items;
  assert.ok(newest && oldest);
  f.sandbox.reply(oldest.requestId!, false);
  f.advance(5 * 60_000 + 1000);
  f.sandbox.reply(newest.requestId!, false);
  assert.equal(await denied, false);
  assert.equal(await timedOut, false);
  assert.equal(f.service.get(oldest.id)?.status, "rejected");
  assert.equal(f.service.get(newest.id)?.status, "expired");
  assert.equal(f.service.get(newest.id)?.outcome, "timed_out");
});

it("keeps several simultaneous approvals instead of overwriting them", async t => {
  const f = await fixture(t);
  void f.requestApproval("bg");
  void f.requestApproval("sched-chat");
  assert.equal(f.service.list().badge, 2);
});

it("tracks a question across chat answer, skip and Inbox answer", async t => {
  const f = await fixture(t);
  const chat = f.ask();
  await f.flush();
  const first = f.service.list().items[0]!;
  assert.equal(first.type, "question");
  f.questions.reply(first.requestId!, "v1");
  assert.equal(await chat, "v1");
  assert.equal(f.service.get(first.id)?.status, "resolved");

  const skipped = f.ask();
  await f.flush();
  const second = f.service.list().items.find(item => item.status === "pending")!;
  f.questions.reply(second.requestId!, null);
  await skipped;
  assert.equal(f.service.get(second.id)?.status, "cancelled");

  const inbox = f.ask();
  await f.flush();
  const third = f.service.list().items.find(item => item.status === "pending")!;
  const result = f.service.decide({ itemId: third.id, expectedRevision: third.revision, decision: "answer", answer: "v2", clientActionId: "c" });
  assert.equal(result.ok, true);
  assert.equal(await inbox, "v2");
  const stored = f.service.get(third.id)!;
  assert.equal(stored.detail.kind === "question" && stored.detail.answer, "v2");
});

it("cancelling a conversation cancels its question item without recording an answer", async t => {
  const f = await fixture(t);
  const pending = f.ask("bg");
  await f.flush();
  f.questions.cancelConversation("bg");
  assert.equal(await pending, null);
  assert.equal(f.service.list().items[0]?.status, "cancelled");
});

it("reports every finished turn, including the conversation the user is looking at, but not stopped ones", async t => {
  const f = await fixture(t);
  f.messages.set("bg", [{ role: "user", text: "go" }, { role: "assistant", text: "All tests pass." }]);
  f.messages.set("active-chat", [{ role: "assistant", text: "Refactor done." }]);
  f.emit({ type: "prompt_end", conversationId: "bg", status: "stopped", planPending: false });
  assert.equal(f.service.list().items.length, 0);
  f.emit({ type: "prompt_end", conversationId: "active-chat", status: "responded", planPending: false });
  const [foreground] = f.service.list().items;
  assert.equal(foreground?.type, "result");
  assert.equal(foreground?.conversationId, "active-chat");
  assert.equal(foreground?.summary, "Refactor done.");
  assert.equal(f.service.list().badge, 0);
  f.advance(1);
  f.emit({ type: "prompt_end", conversationId: "bg", status: "responded", planPending: false });
  const result = f.service.list().items.find(item => item.conversationId === "bg");
  assert.equal(result?.type, "result");
  assert.equal(result?.status, "resolved");
  assert.equal(result?.summary, "All tests pass.");
  assert.equal(f.service.list().badge, 0);
  f.advance(1);
  f.emit({ type: "prompt_end", conversationId: "bg", status: "failed", error: "model unavailable", planPending: false });
  assert.equal(f.service.list().badge, 1);
  assert.equal(f.service.list().items.find(item => item.type === "error")?.summary, "model unavailable");
  f.advance(1);
  f.emit({ type: "prompt_end", conversationId: "bg", status: "responded", planPending: true });
  assert.ok(f.service.list().items.some(item => item.type === "review" && item.status === "pending"));
});

it("leaves scheduled-run conversations to the scheduled-task report", async t => {
  const f = await fixture(t);
  f.publish({ tasks: [task], runs: [run("r0", "running", null)] });
  f.emit({ type: "prompt_end", conversationId: "sched-chat", status: "responded", planPending: false });
  assert.equal(f.service.list().items.length, 0);
});

it("ignores historical scheduled runs and reports new ones once", async t => {
  const f = await fixture(t);
  f.publish({ tasks: [task], runs: [run("old", "success", f.now() - 60_000)] });
  assert.equal(f.service.list().items.length, 0);
  f.messages.set("sched-chat", [{ role: "assistant", text: "Report ready" }]);
  const state: ScheduledTasksState = { tasks: [task], runs: [run("old", "success", f.now() - 60_000), run("new", "success", f.now() + 1000)] };
  f.advance(2000);
  f.publish(state);
  f.publish(state);
  const items = f.service.list().items;
  assert.equal(items.length, 1);
  assert.equal(items[0]?.origin, "scheduled_task");
  assert.equal(items[0]?.title, "Nightly check");
  assert.equal(items[0]?.summary, "Report ready");
  assert.equal(items[0]?.outcome, "success");
  assert.equal(items[0]?.workspaceId, "/work/c");
});

it("turns failed, interrupted and skipped scheduled runs into the right items", async t => {
  const f = await fixture(t);
  f.advance(1000);
  const at = f.now();
  f.publish({ tasks: [task], runs: [
    run("f", "failed", at, { error: "boom" }),
    run("i", "interrupted", at + 1, { error: "应用退出导致任务中断" }),
    run("s", "skipped", at + 2, { conversationId: null, error: "已按策略跳过错过的执行" }),
  ] });
  const byOutcome = Object.fromEntries(f.service.list().items.map(item => [item.outcome, item]));
  assert.equal(byOutcome.failed?.type, "error");
  assert.equal(byOutcome.failed?.status, "pending");
  assert.equal(byOutcome.interrupted?.type, "error");
  assert.equal(byOutcome.skipped?.type, "system");
  assert.equal(byOutcome.skipped?.status, "resolved");
  assert.equal(f.service.list().badge, 2);
});

it("reports only subagents that fail while running", async t => {
  const f = await fixture(t);
  const agent = (status: AgentInfo["status"], extra: Partial<AgentInfo> = {}) => ({ id: "a1", name: "explorer", kind: "explore", status, activeMs: 5, error: null, ...extra }) as AgentInfo;
  f.emit({ type: "agents", conversationId: "bg", agents: [agent("running")] });
  f.emit({ type: "agents", conversationId: "bg", agents: [agent("completed")] });
  assert.equal(f.service.list().items.length, 0);
  f.emit({ type: "agents", conversationId: "bg", agents: [agent("running")] });
  f.emit({ type: "agents", conversationId: "bg", agents: [agent("failed", { error: "context overflow" })] });
  const [item] = f.service.list().items;
  assert.equal(item?.origin, "subagent");
  assert.equal(item?.agentId, "a1");
  assert.equal(item?.summary, "context overflow");
});

it("one failing source cannot break the others", async t => {
  const f = await fixture(t);
  const failing = new Error("disk full");
  const original = f.service.upsert.bind(f.service);
  let first = true;
  f.service.upsert = event => { if (first) { first = false; throw failing; } return original(event); };
  void f.ask();
  await f.flush();
  void f.requestApproval();
  assert.equal(f.service.list().items.length, 1);
});

const uiReply = "整理好了：\n\n```vela-ui\n{\"op\":\"create\",\"id\":\"a\",\"type\":\"text\",\"text\":\"hi\"}\n```\n";

it("labels background-task results by their real origin and carries the task id", async t => {
  const f = await fixture(t, id => id === "bg" ? { isResident: false, origin: "resident", taskId: "task-9", title: "检查依赖" } : null);
  f.messages.set("bg", [{ role: "assistant", text: "没有发现过期依赖。" }]);
  f.emit({ type: "prompt_end", conversationId: "bg", status: "responded", planPending: false });
  const [item] = f.service.list().items;
  assert.equal(item?.origin, "resident");
  assert.equal(item?.taskId, "task-9");
  assert.equal(item?.title, "检查依赖");
  assert.equal(item?.type, "result");
});

it("proactive results become suggestions that explain why they ran", async t => {
  const f = await fixture(t, () => ({ isResident: false, origin: "proactive", suggestion: true, reason: "规则「盯着构建」：文件变化：src/a.ts" }));
  f.messages.set("bg", [{ role: "assistant", text: "建议先修复类型错误。" }]);
  f.emit({ type: "prompt_end", conversationId: "bg", status: "responded", planPending: false });
  const [item] = f.service.list().items;
  assert.equal(item?.type, "suggestion");
  assert.equal(item?.origin, "proactive");
  assert.match(item?.reason ?? "", /盯着构建/);
});

it("the resident's own successful turns stay out of the inbox but its failures do not", async t => {
  const f = await fixture(t, () => ({ isResident: true, origin: "resident" }));
  f.messages.set("bg", [{ role: "assistant", text: "好的。" }]);
  f.emit({ type: "prompt_end", conversationId: "bg", status: "responded", planPending: false });
  assert.equal(f.service.list().items.length, 0);
  f.advance(1);
  f.emit({ type: "prompt_end", conversationId: "bg", status: "failed", error: "模型不可用", planPending: false });
  assert.equal(f.service.list().items[0]?.type, "error");
  assert.equal(f.service.list().items[0]?.origin, "resident");
});

it("a task stopped by its time limit is reported, a task stopped by the user is not", async t => {
  let timedOut = true;
  const f = await fixture(t, () => ({ isResident: false, origin: "resident", get timedOut() { return timedOut; } }));
  f.emit({ type: "prompt_end", conversationId: "bg", status: "stopped", planPending: false });
  const [item] = f.service.list().items;
  assert.equal(item?.type, "error");
  assert.equal(item?.outcome, "timed_out");
  timedOut = false;
  f.advance(1);
  f.emit({ type: "prompt_end", conversationId: "bg", status: "stopped", planPending: false });
  assert.equal(f.service.list().items.length, 1);
});

it("references an Intelligent UI reply instead of copying it, and keeps only the prose in the summary", async t => {
  const f = await fixture(t);
  f.messages.set("bg", [{ role: "assistant", text: "普通回复" }, { role: "assistant", text: uiReply }]);
  f.emit({ type: "prompt_end", conversationId: "bg", status: "responded", planPending: false });
  const [item] = f.service.list().items;
  assert.equal(item?.contentRef?.conversationId, "bg");
  assert.equal(item?.contentRef?.uiOrdinal, 0);
  assert.ok(item?.contentRef?.fingerprint);
  assert.equal(item?.summary, "整理好了：");
  assert.ok(item?.detail.kind === "text" && !item.detail.text.includes("vela-ui"));
});

it("plain replies carry no content reference", async t => {
  const f = await fixture(t);
  f.messages.set("bg", [{ role: "assistant", text: "全部通过。" }]);
  f.emit({ type: "prompt_end", conversationId: "bg", status: "responded", planPending: false });
  assert.equal(f.service.list().items[0]?.contentRef, undefined);
});

it("stripUiFences removes complete and unterminated fences only", () => {
  assert.equal(stripUiFences(uiReply), "整理好了：");
  assert.equal(stripUiFences("前\n```vela-ui\n{\"op\":\"create\"}"), "前");
  assert.equal(stripUiFences("```js\nconst a = 1;\n```"), "```js\nconst a = 1;\n```");
});
