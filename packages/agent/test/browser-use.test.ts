import assert from "node:assert/strict";
import { it } from "node:test";
import { createBrowserTools, type BrowserReplService } from "../src/browser-use.ts";
import { defaultToolPolicy } from "../src/interaction.ts";
import { activityFromExecution } from "../src/tool-activity.ts";
import { transcriptFromMessages } from "../src/transcript.ts";

function harness() {
  const calls: Parameters<BrowserReplService["execute"]>[0][] = [];
  const resets: Parameters<BrowserReplService["reset"]>[0][] = [];
  const content = [{ type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" }];
  const service: BrowserReplService = {
    async execute(input) { calls.push(input); return { content }; },
    async reset(input) { resets.push(input); },
  };
  let allowed = true;
  let approved = true;
  const requests: unknown[] = [];
  const tools = createBrowserTools({ service, conversationId: "conversation", agentId: "child", cwd: "/repo",
    turnId: () => "turn", allowed: () => allowed,
    permission: { async request(input) { requests.push(input); return approved; } },
  });
  const execute = (params: unknown, signal?: AbortSignal) => tools[0]!.execute("call", params, signal, undefined, {} as never);
  return { calls, resets, content, service, tools, execute, requests, deny: () => { approved = false; }, plan: () => { allowed = false; } };
}

it("passes trusted child identity, cancellation, defaults and real image content", async () => {
  const h = harness();
  const signal = new AbortController().signal;
  const result = await h.execute({ code: "await tab.screenshot()" }, signal);
  assert.deepEqual(result.content, h.content);
  assert.deepEqual(h.calls[0], { conversationId: "conversation", agentId: "child", turnId: "turn", invocationId: "call", code: "await tab.screenshot()", timeoutMs: 30000, cwd: "/repo", signal });
  assert.deepEqual(h.requests[0], { kind: "browser_repl", command: "await tab.screenshot()", cwd: "/repo", workspace: "/repo", signal });
});

it("denies missing/rejected permissions and mode changes before service execution", async () => {
  const h = harness(); h.deny();
  await assert.rejects(h.execute({ code: "1" }), /permission denied/);
  h.plan();
  await assert.rejects(h.execute({ code: "1" }), /Plan/);
  const tools = createBrowserTools({ service: h.service, conversationId: "c", agentId: "c", cwd: "/repo", turnId: () => "t", allowed: () => true });
  await assert.rejects(tools[0]!.execute("id", { code: "1" }, undefined, undefined, {} as never), /permission denied/);
  assert.equal(h.calls.length, 0);
});

it("rejects aborted calls and invalid timeouts, resets only the current agent", async () => {
  const h = harness(); const controller = new AbortController(); controller.abort();
  await assert.rejects(h.execute({ code: "1" }, controller.signal));
  await assert.rejects(h.execute({ code: "1", timeoutMs: 120001 }), /timeoutMs/);
  await h.tools[1]!.execute("reset", {}, undefined, undefined, {} as never);
  assert.deepEqual(h.resets, [{ conversationId: "conversation", agentId: "child", signal: undefined }]);
  assert.equal(h.requests.length, 0);
});

it("Plan policy rejects both REPL tools and screenshot previews survive activity creation", () => {
  for (const toolName of ["browser_repl", "browser_repl_reset"]) {
    assert.equal(defaultToolPolicy.authorizeCall({ mode: "plan", toolName, input: {} }).allowed, false);
    assert.equal(defaultToolPolicy.availableTools("plan", false).includes(toolName), false);
  }
  const activity = activityFromExecution("browser_repl", { code: "await tab.screenshot()" }, { content: [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }] }, false);
  assert.equal(activity.command, "await tab.screenshot()");
  assert.match(activity.body!, /data:image\/png;base64,aGVsbG8=/);
});


it("restored transcripts retain browser code and image previews", () => {
  const messages = [
    { role: "assistant", content: [{ type: "toolCall", id: "call", name: "browser_repl", arguments: { code: "await tab.screenshot()" } }], timestamp: 1 },
    { role: "toolResult", toolCallId: "call", toolName: "browser_repl", isError: false, content: [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }], timestamp: 2 },
  ];
  const transcript = transcriptFromMessages(messages as Parameters<typeof transcriptFromMessages>[0]);
  assert.equal(transcript[0]?.tools[0]?.activity?.command, "await tab.screenshot()");
  assert.match(transcript[0]?.tools[0]?.activity?.body ?? "", /data:image\/png;base64,aGVsbG8=/);
});

it("runtime activates browser tools only with a host in execution mode and invalidates Goal evidence", async t => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { AgentRuntime } = await import("../src/runtime.ts");
  const root = await mkdtemp(join(tmpdir(), "vela-browser-runtime-"));
  const h = harness();
  const runtime = new AgentRuntime({ cwd: root, agentDir: root, browserRepl: h.service });
  const bare = new AgentRuntime({ cwd: root, agentDir: join(root, "bare") });
  t.after(async () => { runtime.dispose(); bare.dispose(); await rm(root, { recursive: true, force: true }); });
  await runtime.createConversation(root);
  await bare.createConversation(root);
  type Entry = { id: string; session: { setActiveToolsByName(names: string[]): void } | null; snapshot: { mode: "agent" | "plan" | "goal"; tools: string[]; goal: any; executionPlan: null } };
  type Internals = { conversations: Map<string, Entry>; applyActiveTools(entry: Entry): void; handlePiEvent(id: string, event: any): void; browserTools(entry: Entry, agentId: string, kind?: "general" | "explore"): import("@earendil-works/pi-coding-agent").ToolDefinition[] };
  const events: any[] = [];
  runtime.subscribe(event => events.push(event));
  const internals = runtime as unknown as Internals;
  const entry = internals.conversations.get(runtime.activeConversationId!)!;
  assert.deepEqual(internals.browserTools(entry, entry.id).map(tool => tool.name), ["browser_repl", "browser_repl_reset"]);
  assert.deepEqual(internals.browserTools(entry, "child", "general").map(tool => tool.name), ["browser_repl", "browser_repl_reset"]);
  assert.deepEqual(internals.browserTools(entry, "reader", "explore"), []);
  const active: string[][] = [];
  entry.session = { setActiveToolsByName: names => active.push(names) };
  internals.applyActiveTools(entry);
  assert.ok(active.at(-1)?.includes("browser_repl"));
  entry.snapshot.mode = "plan"; internals.applyActiveTools(entry);
  assert.equal(active.at(-1)?.includes("browser_repl"), false);
  entry.snapshot.mode = "goal";
  entry.snapshot.goal = { id: "goal", status: "active", objective: "test", workRevision: 1, validation: { workRevision: 1 }, createdAt: 1, updatedAt: 1 };
  internals.handlePiEvent(entry.id, { type: "tool_execution_start", toolCallId: "browser-call", toolName: "browser_repl", args: { code: "1" } });
  assert.equal(entry.snapshot.goal.workRevision, 2);
  internals.handlePiEvent(entry.id, { type: "tool_execution_end", toolCallId: "browser-call", toolName: "browser_repl", isError: false, result: { content: [{ type: "text", text: "tab closed" }], details: { isError: true } } });
  assert.equal(events.find(event => event.type === "tool_end")?.isError, true);
  const bareInternals = bare as unknown as Internals;
  const bareEntry = bareInternals.conversations.get(bare.activeConversationId!)!;
  bareInternals.applyActiveTools(bareEntry);
  assert.equal(bareEntry.snapshot.tools.includes("browser_repl"), false);
  assert.deepEqual(bareInternals.browserTools(bareEntry, bareEntry.id), []);
  entry.session = null;
});


it("marks normalized host failures as failed tools", async () => {
  const h = harness();
  h.service.execute = async () => ({ content: [{ type: "text", text: "SyntaxError: Unexpected token" }], isError: true });
  await assert.rejects(h.execute({ code: "(" }), /SyntaxError/);
});

it("general children permit browser tools while explore exposes neither and blocks direct calls", async () => {
  const { agentToolNamesFor, createExploreGuardExtension } = await import("../src/subagent.ts");
  assert.equal(agentToolNamesFor("explore").includes("browser_repl"), false);
  let handler: any;
  createExploreGuardExtension()({ on: (_event: string, callback: any) => { handler = callback; } } as never);
  for (const toolName of ["browser_repl", "browser_repl_reset"]) {
    assert.equal((await handler({ toolName, input: {} })).block, true);
  }
  assert.equal(defaultToolPolicy.authorizeCall({ mode: "agent", toolName: "browser_repl", input: {} }).allowed, true);
});


it("details-only failures reach the model as errors and restore with error status", async () => {
  const h = harness();
  h.service.execute = async () => ({ content: [{ type: "text", text: "TypeError: tab closed" }], details: { isError: true, error: { name: "TypeError", message: "tab closed", code: "TAB_CLOSED" } } });
  await assert.rejects(h.execute({ code: "tab.url()" }), /tab closed/);
  const messages = [
    { role: "assistant", content: [{ type: "toolCall", id: "call", name: "browser_repl", arguments: { code: "tab.url()" } }], timestamp: 1 },
    { role: "toolResult", toolCallId: "call", toolName: "browser_repl", isError: false, content: [{ type: "text", text: "TypeError: tab closed" }], details: { isError: true }, timestamp: 2 },
  ];
  const transcript = transcriptFromMessages(messages as Parameters<typeof transcriptFromMessages>[0]);
  assert.equal(transcript[0]?.tools[0]?.status, "error");
  assert.match(transcript[0]?.tools[0]?.activity?.body ?? "", /tab closed/);
});
