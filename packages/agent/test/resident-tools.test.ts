import assert from "node:assert/strict";
import { it } from "node:test";
import type { ResidentTask } from "@vela/shared";
import { ToolLoadout, type ToolLoadoutConversation } from "../src/runtime-tools.ts";
import { createResidentTools, residentToolNames, type ResidentToolHost } from "../src/resident-tools.ts";

const task = (patch: Partial<ResidentTask> = {}): ResidentTask => ({
  id: "t1", title: "检查", prompt: "SECRET PROMPT", workspace: "/w", source: "agent", status: "running", conversationId: "c1",
  createdAt: 1, startedAt: 2, finishedAt: null, error: null, ...patch,
} as ResidentTask);

function host(patch: Partial<ResidentToolHost> = {}): ResidentToolHost & { delegated: unknown[] } {
  const delegated: unknown[] = [];
  return {
    delegated,
    workspaces: () => ["/w", "/x"],
    tasks: () => [task()],
    inbox: filter => [{ id: "i1", type: "question", status: "pending", title: "t", summary: filter.pendingOnly ? "pending" : "all", updatedAt: 1 }],
    delegate: async input => { delegated.push(input); return { ok: true, taskId: "t9", status: "queued" }; },
    ...patch,
  };
}

const run = async (tools: ReturnType<typeof createResidentTools>, name: string, params: object, signal?: AbortSignal) => {
  const tool = tools.find(item => item.name === name)!;
  const out = await tool.execute("call", params as never, signal, undefined, undefined as never);
  return JSON.parse((out.content[0] as { text: string }).text);
};

it("exposes exactly the four coordination tools", () => {
  assert.deepEqual(createResidentTools(host()).map(tool => tool.name), residentToolNames);
});

it("lists workspaces and tasks from the host's real records without leaking prompts", async () => {
  const tools = createResidentTools(host());
  assert.deepEqual(await run(tools, "list_workspaces", {}), { workspaces: ["/w", "/x"] });
  const { tasks } = await run(tools, "list_background_tasks", {});
  assert.equal(tasks[0].status, "running");
  assert.ok(!JSON.stringify(tasks).includes("SECRET PROMPT"), "task prompts and conversation ids stay out of the model context");
  assert.ok(!("conversationId" in tasks[0]));
});

it("passes inbox filters through with sane defaults", async () => {
  const tools = createResidentTools(host());
  assert.equal((await run(tools, "list_inbox_items", { pendingOnly: true })).items[0].summary, "pending");
  assert.equal((await run(tools, "list_inbox_items", {})).items[0].summary, "all");
});

it("delegation forwards only workspace, title and prompt, and returns the host's verdict", async () => {
  const h = host();
  const tools = createResidentTools(h);
  const controller = new AbortController();
  assert.deepEqual(await run(tools, "delegate_workspace_task", { workspace: "/w", title: "t", prompt: "p", extra: "x" }, controller.signal), { ok: true, taskId: "t9", status: "queued" });
  assert.deepEqual(h.delegated, [{ workspace: "/w", title: "t", prompt: "p", signal: controller.signal }]);
  const denied = createResidentTools(host({ delegate: async () => ({ ok: false, reason: "用户拒绝了这个后台任务" }) }));
  assert.deepEqual(await run(denied, "delegate_workspace_task", { workspace: "/w", title: "t", prompt: "p" }), { ok: false, reason: "用户拒绝了这个后台任务" });
});

it("an aborted turn never reaches the host", async () => {
  const h = host();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(run(createResidentTools(h), "delegate_workspace_task", { workspace: "/w", title: "t", prompt: "p" }, controller.signal));
  assert.equal(h.delegated.length, 0);
});

const conversation = (id: string, mode: "agent" | "plan" = "agent"): ToolLoadoutConversation => ({ id, snapshot: { mode, executionPlan: null } });
const loadout = () => new ToolLoadout({ scheduledTasks: true, browser: true, memoryEnabled: () => true, resident: { isResident: entry => entry.id === "resident" } });

it("the resident conversation only gets coordination tools, whatever else is enabled", () => {
  const l = loadout();
  const expected = ["ask_user_question", ...residentToolNames].sort();
  assert.deepEqual(l.active(conversation("resident")).sort(), expected);
  assert.deepEqual(l.native("agent", false, conversation("resident")).sort(), expected);
  assert.deepEqual(l.active({ ...conversation("resident"), recipeStageSideEffect: "read_only" }).sort(), expected);
  const normal = l.active(conversation("chat"));
  for (const name of residentToolNames) assert.ok(!normal.includes(name), `${name} must not leak into ordinary chats`);
  assert.ok(normal.includes("read") && normal.includes("bash"));
});

it("authorization denies files, commands, MCP and memory for the resident", () => {
  const l = loadout();
  const call = (toolName: string) => l.authorize({ mode: "agent", toolName, input: {} }, conversation("resident"));
  for (const name of ["read", "write", "edit", "bash", "mcp__srv__tool", "memory_update", "create_scheduled_task", "browser_navigate", "agent"]) {
    const result = call(name);
    assert.equal(result.allowed, false, name);
    assert.match(result.allowed ? "" : result.reason, /常驻 Agent/);
  }
  for (const name of ["ask_user_question", ...residentToolNames]) assert.deepEqual(call(name), { allowed: true });
  assert.equal(l.authorize({ mode: "agent", toolName: "delegate_workspace_task", input: {} }, conversation("chat")).allowed, false, "ordinary chats cannot delegate");
});

it("without a resident option nothing is registered and nothing is special-cased", () => {
  const l = new ToolLoadout({ scheduledTasks: false, browser: false, memoryEnabled: () => false });
  for (const name of residentToolNames) assert.ok(!l.registered().includes(name));
  assert.equal(l.isResident(conversation("resident")), false);
  assert.ok(loadout().registered().includes("delegate_workspace_task"));
});
