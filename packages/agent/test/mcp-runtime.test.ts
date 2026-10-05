import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { describe, it, type TestContext } from "node:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type ToolCall } from "@earendil-works/pi-ai";
import type { McpCatalog, McpServerConfig, McpToolSnapshot, SandboxApprovalEvent, SandboxMode } from "@vela/shared";
import { AgentRuntime, type RuntimeEvent } from "../src/runtime.ts";
import type { AgentSessionRequest } from "../src/agent-control.ts";
import type { McpSessionBridge } from "../src/mcp-session.ts";
import type { TraceRecorder } from "../src/trace.ts";
import { SandboxPermissionManager } from "../../workspace/src/sandbox-permission-manager.ts";

const serverScript = fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url));
const call = (id: string, name: string, args: ToolCall["arguments"] = {}): ToolCall => ({ type: "toolCall", id, name, arguments: args });
const validation = {
  risk: "low", checks: [], knownIssues: [],
  skipped: ["diff", "test", "build", "typecheck", "regression"].map(category => ({ category, reason: "Protocol fixture exercise; no workspace files changed." })),
};

interface Internals {
  conversations: Map<string, { session: AgentSession }>;
  mcpBridges: Map<AgentSession, McpSessionBridge>;
  mcpManagement: Map<string, AgentSession>;
  mcpManagementStarting: Map<string, Promise<McpSessionBridge>>;
  createChildSession(entry: unknown, input: AgentSessionRequest): Promise<AgentSession>;
  closeSession(session: AgentSession): Promise<void>;
  trace(id: string): TraceRecorder;
}

async function eventually<T>(read: () => T | Promise<T>, accept: (value: T) => boolean, message: string, timeout = 6000): Promise<T> {
  const until = Date.now() + timeout;
  let last: T | undefined;
  do {
    last = await read();
    if (accept(last)) return last;
    await delay(15);
  } while (Date.now() < until);
  assert.fail(`${message}: ${JSON.stringify(last)}`);
}

async function within<T>(work: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); })]);
  } finally { clearTimeout(timer); }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function fixture(t: TestContext, options: { mode?: SandboxMode; permission?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "vela-mcp-runtime-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(cwd); await mkdir(agentDir);
  const permission = new SandboxPermissionManager(join(root, "sandbox.json"));
  await permission.setMode(options.mode ?? "ask");
  const approvals: SandboxApprovalEvent[] = [];
  let approvalDecision: boolean | null = false;
  permission.subscribe(event => {
    approvals.push(event);
    if (event.type === "request" && approvalDecision !== null) permission.reply(event.request.id, approvalDecision);
  });
  const runtimeOptions = { cwd, agentDir, ...(options.permission === false ? {} : { mcpPermission: permission }) };
  let runtime = new AgentRuntime(runtimeOptions);
  const runtimes = [runtime];
  const pids = new Set<number>();
  const traceFiles = new Set<string>();
  const events: RuntimeEvent[] = [];
  const statusEvents: McpCatalog[] = [];
  const observe = (value: AgentRuntime) => {
    value.subscribe(event => events.push(event));
    value.subscribeMcp(event => statusEvents.push(event.catalog));
  };
  observe(runtime);
  t.after(async () => {
    for (const event of approvals) if (event.type === "request") permission.reply(event.request.id, false);
    for (const value of runtimes) {
      await value.dispose();
      // Also clean up directly-created children if disposal coverage exposes an ownership bug.
      const internals = value as unknown as Internals;
      await Promise.all([...internals.mcpBridges.keys()].map(session => internals.closeSession(session)));
    }
    await eventually(() => [...pids].filter(alive), remaining => remaining.length === 0, "fixture processes leaked during cleanup");
    await rm(root, { recursive: true, force: true });
  });
  await runtime.createConversation(cwd);
  const id = runtime.activeConversationId!;
  await runtime.renameConversation(id, "MCP runtime fixture");
  await runtime.addModel({ providerId: "mcp-runtime-fixture", providerName: "Local scripted fixture", modelId: "fixture-model",
    modelName: "Local scripted fixture", api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1",
    apiKey: "synthetic-mcp-runtime-key", reasoning: false, contextWindow: 32768, maxTokens: 4096 });
  await runtime.saveAgentSettings({ ...await runtime.getAgentSettings(), provider: "mcp-runtime-fixture", modelId: "fixture-model", thinkingLevel: "off" });

  const internals = () => runtime as unknown as Internals;
  const session = () => internals().conversations.get(id)!.session;
  const target = { cwd, conversationId: id };
  const catalog = (child?: AgentSession) => child
    ? Promise.resolve(internals().mcpBridges.get(child)!.catalog())
    : runtime.getMcpCatalog(target);
  const tracePath = (name = "fixture") => join(root, `${name}.trace`);
  async function trace(name = "fixture"): Promise<string> {
    try {
      const text = await readFile(tracePath(name), "utf8");
      const pid = Number(text.split("\n")[0]);
      if (Number.isInteger(pid) && pid > 0) pids.add(pid);
      return text;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    }
  }
  const executions = async (name = "fixture") => (await trace(name)).split("\n").filter(line => line === "tools/call").length;
  async function connected(name = "fixture", child?: AgentSession): Promise<McpCatalog> {
    const result = await eventually(() => catalog(child), value => value.servers.some(server => server.name === name && server.connectionStatus === "connected" && server.tools.length > 0), `${name} did not connect`);
    await trace(name);
    return result;
  }
  function config(name = "fixture", exposure: "direct" | "deferred" = "direct", timeout = 10): McpServerConfig {
    traceFiles.add(name);
    return { command: process.execPath, args: [serverScript, "normal", tracePath(name)], exposure, timeout,
      env: { PRIVATE_CONFIG_TOKEN: "synthetic-secret-never-render" } };
  }
  async function save(name = "fixture", scope: "global" | "project" = "global", exposure: "direct" | "deferred" = "direct", timeout = 10) {
    return runtime.saveMcpServer({ ...target, scope, name, config: config(name, exposure, timeout) });
  }
  async function tool(raw: string, name = "fixture", child?: AgentSession): Promise<McpToolSnapshot & { registeredName: string }> {
    const snapshot = await connected(name, child);
    const found = snapshot.servers.find(server => server.name === name)!.tools.find(entry => entry.name === raw);
    assert.ok(found?.registeredName, `protocol tool ${name}/${raw} must have a registered name`);
    return { ...found, registeredName: found.registeredName };
  }
  async function grant(raw: string, readOnly = true, name = "fixture") {
    const info = await tool(raw, name);
    await runtime.setMcpToolReadOnly({ ...target, server: name, tool: raw, configDigest: info.configDigest, toolDigest: info.toolDigest, readOnly });
    // Revocation reloads the session; wait for the replacement fixture process before
    // reading its per-process trace so a reset is not mistaken for an execution delta.
    return connected(name);
  }
  const requests: Context[] = [];
  function script(replies: Array<string | ToolCall[]>, child?: AgentSession, beforeStep?: (step: number) => void) {
    const current = child ?? session();
    let invocation = 0;
    const stream: StreamFn = (model, context) => {
      beforeStep?.(invocation);
      requests.push(structuredClone(context));
      const reply = replies[invocation++];
      assert.ok(reply !== undefined, "unexpected extra model request; no real provider may be used");
      const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: typeof reply === "string" ? [{ type: "text", text: reply }] : reply,
        stopReason: typeof reply === "string" ? "stop" : "toolUse", timestamp: Date.now(),
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const output = createAssistantMessageEventStream();
      output.push({ type: "start", partial: message });
      if (typeof reply === "string") output.push({ type: "text_delta", contentIndex: 0, delta: reply, partial: message });
      else reply.forEach((toolCall, contentIndex) => output.push({ type: "toolcall_end", contentIndex, toolCall, partial: message }));
      output.push({ type: "done", reason: message.stopReason === "stop" ? "stop" : "toolUse", message });
      return output;
    };
    current.agent.streamFunction = child ? stream : internals().trace(id).wrapStream(stream);
    return () => assert.equal(invocation, replies.length, "the scripted model must consume exactly its fixture replies");
  }
  function result(callId: string, child?: AgentSession) {
    const found = (child ?? session()).messages.find(message => message.role === "toolResult" && message.toolCallId === callId);
    assert.ok(found?.role === "toolResult", `missing real Pi tool result for ${callId}`);
    return found;
  }
  let nextCall = 0;
  async function invoke(raw: string, args: ToolCall["arguments"] = {}, child?: AgentSession, name = "fixture") {
    const info = await tool(raw, name, child);
    const callId = `fixture-call-${++nextCall}`;
    const check = script([[call(callId, info.registeredName, args)], "MCP fixture report"], child);
    if (child) await child.prompt("Run the fixture MCP tool");
    else await runtime.prompt(id, "Run the fixture MCP tool");
    check();
    return result(callId, child);
  }
  async function child(kind: "general" | "explore", sessionFile?: string) {
    return internals().createChildSession(internals().conversations.get(id), {
      agentId: `${kind}-${nextCall++}`, parentId: id, parentPath: "/root", parentSession: session(), kind,
      name: `${kind}-fixture`, path: `/root/${kind}-fixture`, forkMessages: [], customTools: [], sessionFile,
    });
  }
  async function restore(concurrent = false) {
    for (const name of traceFiles) await trace(name);
    await runtime.dispose();
    runtime = new AgentRuntime(runtimeOptions);
    runtimes.push(runtime); observe(runtime);
    if (concurrent) await Promise.all([runtime.switchConversation(id), runtime.getMcpCatalog(target), runtime.getMcpCatalog(target)]);
    else await runtime.switchConversation(id);
    return runtime;
  }
  return { root, cwd, agentDir, id, target, permission, approvals, pids, events, statusEvents, requests,
    get runtime() { return runtime; }, session, catalog, connected, config, save, tool, grant, script, result, invoke, child, restore, trace, tracePath, executions,
    decision(value: boolean | null) { approvalDecision = value; } };
}

// Each test starts real stdio/HTTP fixtures. The suite budget must absorb parallel full-suite CPU contention.
describe("AgentRuntime MCP integration", { timeout: 60_000 }, () => {
  it("uses protocol registered names and denies unknown MCP calls despite server readonly hints", async t => {
    const f = await fixture(t, { mode: "smart" });
    const riskInputs: unknown[] = [];
    f.permission.setRiskEvaluator(async input => { riskInputs.push(input); return "unknown"; });
    await f.save();
    const info = await f.tool("read-data");
    assert.equal(info.readOnly, false);
    assert.ok(f.session().getActiveToolNames().includes(info.registeredName));
    assert.ok(f.runtime.getSnapshot().tools.includes(info.registeredName));
    const secrets = ["synthetic-secret-never-render", "synthetic-argument-only-token", "synthetic-nested-password"];
    const denied = await f.invoke("read-data", { token: secrets[0], access_token: secrets[1], nested: { password: secrets[2] }, preview: secrets[0], id: 7 });
    assert.equal(denied.isError, true);
    assert.equal(await f.executions(), 0, "denied calls must never reach tools/call");
    assert.equal(riskInputs.length, 1);
    const approval = f.approvals.find(event => event.type === "request");
    assert.ok(approval?.type === "request");
    assert.equal(approval.request.kind, "mcp");
    assert.equal(approval.request.mcp?.server, "fixture");
    assert.equal(approval.request.mcp?.tool, "read-data");
    assert.match(approval.request.mcp?.description ?? "", /Read fixture data/);
    const trace = f.runtime.getTrace(f.id);
    assert.ok(trace.requests.length > 0, "assert redaction on actual captured model requests");
    const messages = f.runtime.getMessages(f.id);
    assert.ok(messages.some(message => message.tools?.some(tool => tool.name === info.registeredName)), "assert redaction on a restored MCP tool activity");
    for (const secret of secrets) {
      assert.equal(JSON.stringify(approval).includes(secret), false, "approval leaked a credential");
      assert.equal(JSON.stringify(riskInputs).includes(secret), false, "risk context leaked a credential");
      assert.equal(JSON.stringify(trace).includes(secret), false, "getTrace leaked a credential");
      assert.equal(JSON.stringify(messages).includes(secret), false, "getMessages leaked a credential");
      assert.equal(JSON.stringify(f.events).includes(secret), false, "runtime events leaked a credential");
    }
    assert.ok(JSON.stringify(approval).includes("••••••••"));
    f.decision(true);
    assert.equal((await f.invoke("read-data")).isError, false);
    assert.equal(await f.executions(), 1);
    const toolNodes = f.runtime.getTrace(f.id).nodes.filter(node => node.toolName === info.registeredName);
    assert.ok(toolNodes.length >= 2, "tool call and result nodes must both carry the registered name");
    for (const node of toolNodes) assert.deepEqual(node.mcp, { server: "fixture", tool: "read-data" });
    assert.equal(riskInputs.length, 2, "runtime must re-evaluate identical MCP calls");
    assert.equal((await f.tool("read-data")).readOnly, false, "a model verdict or one-shot approval must never grant readonly trust");
  });

  it("fails closed without an injected permission manager", async t => {
    const f = await fixture(t, { permission: false });
    await f.save();
    assert.equal((await f.invoke("write_data")).isError, true);
    assert.equal(await f.executions(), 0);
    assert.deepEqual(f.approvals, []);
  });

  it("an explicit standalone readonly grant bypasses ask without a model or one-shot approval", async t => {
    const f = await fixture(t);
    await f.save(); await f.connected();
    const managementInput = { cwd: f.cwd, conversationId: null };
    const management = await eventually(() => f.runtime.getMcpCatalog(managementInput), value => value.servers.some(server => server.connectionStatus === "connected" && server.tools.length > 0), "standalone management server did not connect");
    await f.trace();
    assert.equal(management.conversationId, null);
    const tool = management.servers.find(server => server.name === "fixture")!.tools.find(tool => tool.name === "read-data")!;
    await f.runtime.setMcpToolReadOnly({ ...managementInput, server: "fixture", tool: "read-data", configDigest: tool.configDigest, toolDigest: tool.toolDigest, readOnly: true });
    assert.equal((await f.tool("read-data")).readOnly, true);
    let evaluations = 0;
    f.permission.setRiskEvaluator(async () => { evaluations++; return "risky"; });
    f.decision(null);
    for (let attempt = 0; attempt < 2; attempt++) assert.equal((await within(f.invoke("read-data"), 2000, "readonly invocation unexpectedly waited for ask approval")).isError, false);
    assert.equal(await f.executions(), 2);
    assert.equal(evaluations, 0);
    assert.deepEqual(f.approvals, []);
    f.decision(false);
    assert.equal((await f.invoke("write_data")).isError, true);
    assert.equal(await f.executions(), 2);
    assert.equal(f.approvals.filter(event => event.type === "request").length, 1);
  });

  it("a readonly grant is not reapplied by the poll as an external change", async t => {
    const f = await fixture(t);
    await f.save(); await f.connected();
    const pid = Number((await f.trace()).split("\n")[0]);
    assert.ok(pid > 0);
    await f.grant("read-data");
    // The runtime polls configuration every second. An owned policy write must not look like an
    // outside edit: before the fingerprint fix this suspended the server and replaced the process.
    await delay(1300);
    await f.connected();
    assert.equal(Number((await f.trace()).split("\n")[0]), pid, "readonly grant must not replace the healthy fixture process");
    assert.equal((await f.invoke("read-data")).isError, false);
    assert.equal(await f.executions(), 1);
  });

  it("Plan filters unknown tools before execution and permits only explicit readonly grants", async t => {
    const f = await fixture(t);
    await f.save();
    const read = await f.tool("read-data");
    const write = await f.tool("write_data");
    await f.runtime.setMode(f.id, "plan");
    assert.equal(f.session().getActiveToolNames().includes(read.registeredName), false, "readOnlyHint alone cannot expose a Plan tool");
    assert.equal(f.session().getActiveToolNames().includes(write.registeredName), false);
    // A forged active loadout still has to pass the final extension authorization boundary.
    f.session().setActiveToolsByName([...f.session().getActiveToolNames(), write.registeredName]);
    const check = f.script([[call("plan-forged-write", write.registeredName)], "Plan inspection complete"]);
    await f.runtime.prompt(f.id, "Plan without external writes"); check();
    assert.equal(f.result("plan-forged-write").isError, true);
    assert.equal(await f.executions(), 0);
    assert.deepEqual(f.approvals, []);
    await f.grant("read-data");
    assert.ok(f.session().getActiveToolNames().includes(read.registeredName));
    const readResult = await f.invoke("read-data");
    assert.equal(readResult.isError, false);
    assert.equal(await f.executions(), 1, `Plan readonly execution trace: ${await f.trace()}; result: ${JSON.stringify(readResult)}`);
    assert.deepEqual(f.approvals, [], "explicit readonly calls bypass ask approval");
    await f.runtime.setMode(f.id, "agent");
    await f.grant("read-data", false);
    const before = await f.executions();
    assert.equal((await f.invoke("read-data")).isError, true);
    assert.equal(await f.executions(), before);
  });

  it("binds project trust to reviewed bytes and revocation never revives readonly grants", async t => {
    const f = await fixture(t);
    const initial = await f.save("fixture", "project");
    assert.equal(initial.projectTrust.trusted, false);
    assert.equal(initial.servers.find(server => server.name === "fixture")?.status, "untrusted");
    assert.equal(await f.trace(), "", "untrusted project entries must never start a process");
    await assert.rejects(f.runtime.setMcpProjectTrust({ ...f.target, trusted: true, digest: "0".repeat(64) }), /changed|review/i);
    await f.runtime.setMcpProjectTrust({ ...f.target, trusted: true, digest: initial.projectTrust.digest });
    await f.connected();
    await f.grant("read-data");
    assert.equal((await f.invoke("read-data")).isError, false);
    await f.runtime.setMcpProjectTrust({ ...f.target, trusted: false });
    const revoked = await f.catalog();
    assert.equal(revoked.projectTrust.trusted, false);
    assert.equal(f.session().getActiveToolNames().some(name => name.startsWith("mcp__")), false);
    await assert.rejects(f.runtime.reconnectMcpServer({ ...f.target, scope: "project", name: "fixture" }), /untrusted|disabled/i);
    await f.runtime.setMcpProjectTrust({ ...f.target, trusted: true, digest: revoked.projectTrust.digest });
    const current = await f.tool("read-data");
    assert.equal(current.readOnly, false);
    assert.equal((await f.invoke("read-data")).isError, true);
    assert.equal(await f.executions(), 0);
  });

  it("config changes invalidate grants and reject stale approvals through runtime APIs", async t => {
    const f = await fixture(t);
    await f.save();
    await f.grant("read-data");
    const old = await f.tool("read-data");
    await f.runtime.saveMcpServer({ ...f.target, scope: "global", name: "fixture", config: { ...f.config(), description: "Reviewed configuration changed" } });
    const current = await f.tool("read-data");
    assert.notEqual(current.configDigest, old.configDigest);
    assert.equal(current.readOnly, false);
    await assert.rejects(f.runtime.setMcpToolReadOnly({ ...f.target, server: "fixture", tool: "read-data", configDigest: old.configDigest, toolDigest: old.toolDigest, readOnly: true }), /changed|review/i);
    assert.equal((await f.invoke("read-data")).isError, true);
    assert.equal(await f.executions(), 0);
    await f.grant("read-data");
    assert.equal((await f.invoke("read-data")).isError, false);
    assert.equal(await f.executions(), 1);
  });

  it("changed protocol tool definitions invalidate grants without changing configuration", async t => {
    const f = await fixture(t, { mode: "full" });
    await f.save();
    await f.grant("read-data");
    const old = await f.tool("read-data");
    assert.equal((await f.invoke("change_tools")).isError, false);
    await eventually(() => f.catalog(), catalog => catalog.servers.some(server => server.tools.some(tool => tool.name === "new_read")), "tools/list_changed must reach AgentRuntime");
    const changed = await f.tool("read-data");
    assert.notEqual(changed.toolDigest, old.toolDigest, "fixture change_tools must change the existing read-data definition");
    assert.equal(changed.configDigest, old.configDigest);
    assert.equal(changed.readOnly, false);
    await assert.rejects(f.runtime.setMcpToolReadOnly({ ...f.target, server: "fixture", tool: "read-data", configDigest: old.configDigest, toolDigest: old.toolDigest, readOnly: true }), /changed|review/i);
    await f.permission.setMode("ask");
    const before = await f.executions();
    assert.equal((await f.invoke("read-data")).isError, true);
    assert.equal(await f.executions(), before);
    await f.grant("read-data");
    assert.equal((await f.invoke("read-data")).isError, false);
    assert.equal(await f.executions(), before + 1);
  });

  it("general/explore use independent real bridges and restored child histories", async t => {
    const f = await fixture(t, { mode: "full" });
    await f.save();
    await f.grant("read-data");
    const general = await f.child("general");
    await f.connected("fixture", general);
    const explore = await f.child("explore");
    await f.connected("fixture", explore);
    assert.notEqual(general, f.session());
    assert.notEqual(explore, general);
    const read = await f.tool("read-data", "fixture", explore);
    const write = await f.tool("write_data", "fixture", explore);
    assert.ok(explore.getActiveToolNames().includes(read.registeredName));
    assert.equal(explore.getActiveToolNames().includes(write.registeredName), false);
    assert.equal((await f.invoke("read-data", {}, explore)).isError, false);
    const before = await f.executions();
    explore.setActiveToolsByName([...explore.getActiveToolNames(), write.registeredName]);
    assert.equal((await f.invoke("write_data", {}, explore)).isError, true);
    assert.equal(await f.executions(), before);
    assert.equal((await f.invoke("write_data", {}, general)).isError, false);
    assert.equal(await f.executions(), before + 1);
    assert.equal((await f.invoke("change_tools")).isError, false);
    await eventually(() => f.catalog(), catalog => catalog.servers.some(server => server.tools.some(tool => tool.name === "new_read")), "root list-change notification missing");
    for (const child of [general, explore]) assert.equal((await f.catalog(child)).servers.some(server => server.tools.some(tool => tool.name === "new_read")), false, "one MCP process's state must not leak into another session");
    const sessionFile = explore.sessionManager.getSessionFile();
    assert.ok(sessionFile);
    await (f.runtime as unknown as Internals).closeSession(explore);
    const restored = await f.child("explore", sessionFile);
    await f.connected("fixture", restored);
    assert.equal(restored.sessionId, explore.sessionId);
    assert.match(JSON.stringify(restored.messages), /MCP fixture report/);
    assert.ok(restored.getActiveToolNames().includes(read.registeredName));
    assert.equal(restored.getActiveToolNames().includes(write.registeredName), false);
  });

  it("restores real history, loaded deferred tools and direct exposure with readonly policy", async t => {
    const f = await fixture(t);
    await f.save();
    await f.save("deferred", "global", "deferred");
    await f.grant("read-data");
    await f.grant("read-data", true, "deferred");
    const deferred = await f.tool("read-data", "deferred");
    const unloaded = await f.tool("write_data", "deferred");
    assert.equal(f.session().getActiveToolNames().includes(deferred.registeredName), false);
    assert.ok(f.runtime.getSnapshot().tools.includes("tool_search"));
    const discover = f.script([[call("discover-deferred", "tool_search", { query: "Read fixture data", limit: 1 })], "Discovery fixture report"]);
    await f.runtime.prompt(f.id, "Discover the deferred read tool"); discover();
    assert.ok(JSON.stringify(f.result("discover-deferred")).includes(deferred.registeredName));
    assert.ok(f.session().getActiveToolNames().includes(deferred.registeredName));
    assert.equal(f.session().getActiveToolNames().includes(unloaded.registeredName), false);
    assert.equal((await f.invoke("read-data", {}, undefined, "deferred")).isError, false);
    assert.equal(await f.executions("deferred"), 1);
    assert.equal((await f.invoke("read-data")).isError, false);
    const sessionId = f.session().sessionId;
    await f.restore();
    await f.connected(); await f.connected("deferred");
    assert.equal(f.session().sessionId, sessionId);
    assert.match(JSON.stringify(f.session().messages), /Discovery fixture report/);
    const direct = await f.tool("read-data");
    assert.equal(direct.readOnly, true);
    assert.ok(f.runtime.getSnapshot().tools.includes(direct.registeredName));
    assert.ok(f.runtime.getSnapshot().tools.includes("tool_search"));
    assert.ok(f.session().getActiveToolNames().includes(deferred.registeredName), `loaded deferred tool ${deferred.registeredName} must survive reopen`);
    assert.ok(f.runtime.getSnapshot().tools.includes(deferred.registeredName));
    assert.equal(f.session().getActiveToolNames().includes(unloaded.registeredName), false, "reopen must not promote unloaded deferred tools");
    assert.equal((await f.invoke("read-data")).isError, false);
    assert.equal((await f.invoke("read-data", {}, undefined, "deferred")).isError, false);
    assert.deepEqual(f.approvals, []);
    assert.equal(await f.executions(), 1);
    assert.equal(await f.executions("deferred"), 1);
  });

  it("restores MCP result cards after the server configuration is removed", async t => {
    const f = await fixture(t, { mode: "full" });
    await f.save();
    const info = await f.tool("read-data");
    await f.invoke("read-data");
    await f.runtime.removeMcpServer({ ...f.target, scope: "global", name: "fixture" });
    await f.restore();
    assert.equal((await f.catalog()).servers.some(server => server.name === "fixture"), false);
    const tool = f.runtime.getMessages(f.id).flatMap(message => message.tools).find(tool => tool.name === info.registeredName);
    assert.ok(tool);
    assert.equal(tool.status, "done");
    assert.deepEqual(tool.activity.mcp, { server: "fixture", tool: "read-data" });
    assert.ok(tool.activity.body);
  });

  it("explicit null conversationId creates a management bridge distinct from the active conversation", async t => {
    const f = await fixture(t, { mode: "full" });
    await f.save(); await f.connected();
    const rootPid = Number((await f.trace()).split("\n")[0]);
    const managementInput = { cwd: f.cwd, conversationId: null };
    const management = await eventually(() => f.runtime.getMcpCatalog(managementInput), value => value.servers.some(server => server.connectionStatus === "connected"), "explicit null management bridge did not connect");
    assert.equal(management.conversationId, null, "null must not fall back to the active conversation");
    const managementPid = Number((await f.trace()).split("\n")[0]);
    assert.notEqual(managementPid, rootPid);
    assert.equal((await f.invoke("change_tools")).isError, false);
    await eventually(() => f.catalog(), value => value.servers.some(server => server.tools.some(tool => tool.name === "new_read")), "root tool change did not propagate");
    const independent = await f.runtime.getMcpCatalog(managementInput);
    assert.equal(independent.conversationId, null);
    assert.equal(independent.servers.some(server => server.tools.some(tool => tool.name === "new_read")), false);
    assert.equal(f.runtime.activeConversationId, f.id);
  });

  it("simultaneous restored-root startup shares one session and one MCP bridge", async t => {
    const f = await fixture(t, { mode: "full" });
    await f.save(); await f.connected();
    assert.equal((await f.invoke("read-data")).isError, false);
    const sessionId = f.session().sessionId;
    await f.restore(true);
    await f.connected();
    const internals = f.runtime as unknown as Internals;
    assert.equal(internals.mcpBridges.size, 1, "concurrent catalog and conversation startup must not create duplicate root bridges");
    assert.equal(f.session().sessionId, sessionId);
    assert.match(JSON.stringify(f.session().messages), /MCP fixture report/);
    assert.equal((await f.invoke("read-data")).isError, false);
    assert.equal(await f.executions(), 1);
  });

  it("busy config changes defer reload and apply the latest revision once the turn is idle", async t => {
    const f = await fixture(t, { mode: "full" });
    await f.save();
    const read = await f.tool("read-data");
    const oldPid = Number((await f.trace()).split("\n")[0]);
    let executionCountBeforeReload = -1;
    const check = f.script([[call("busy-read", read.registeredName)], "Busy reload fixture report"], undefined, step => {
      if (step === 1) executionCountBeforeReload = readFileSync(f.tracePath(), "utf8").split("\n").filter(line => line === "tools/call").length;
    });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let arrived!: () => void;
    const firstRequest = new Promise<void>(resolve => { arrived = resolve; });
    const original = f.session().agent.streamFunction;
    let first = true;
    f.session().agent.streamFunction = (model, context, options) => {
      const output = original(model, context, options);
      if (!first) return output;
      first = false;
      const gated = createAssistantMessageEventStream();
      arrived();
      void held.then(async () => { for await (const event of await output) gated.push(event); });
      return gated;
    };
    const running = f.runtime.prompt(f.id, "Hold the model response while MCP configuration changes");
    try {
      await within(firstRequest, 2000, "fixture model request did not start");
      assert.equal(f.session().isStreaming, true);
      const initial = await f.runtime.saveMcpServer({ ...f.target, scope: "global", name: "added", config: f.config("added", "deferred") });
      assert.equal(initial.pendingApply, true);
      const latest = await f.runtime.saveMcpServer({ ...f.target, scope: "global", name: "added", config: { ...f.config("added", "direct"), description: "Latest reviewed revision" } });
      assert.equal(latest.pendingApply, true);
      assert.equal(latest.servers.find(server => server.name === "added")?.config.description, "Latest reviewed revision");
      assert.equal(latest.servers.find(server => server.name === "added")?.tools.length, 0, "busy sessions must not partially load a new registry");
      assert.equal(Number((await f.trace()).split("\n")[0]), oldPid);
      assert.equal(alive(oldPid), true);
    } finally { release(); }
    await within(running, 3000, "idle turn failed to apply pending MCP config"); check();
    assert.equal(f.result("busy-read").isError, false, "adding another server must not revoke an unchanged existing call");
    assert.equal(executionCountBeforeReload, 1, "the existing server must execute through the real protocol before idle reload");
    const ready = await f.connected("added"); await f.connected();
    const current = await eventually(() => f.catalog(), catalog => !catalog.pendingApply, "latest busy config revision never settled");
    assert.equal(current.servers.find(server => server.name === "added")?.config.description, "Latest reviewed revision");
    const added = ready.servers.find(server => server.name === "added")!.tools.find(tool => tool.name === "read-data")!;
    assert.equal(added.exposure, "direct");
    assert.ok(f.session().getActiveToolNames().includes(added.registeredName!));
    // MCP 刷新重算激活集合时，内置记忆工具仍按权限矩阵保留。
    assert.ok(f.session().getActiveToolNames().includes("memory_read"));
    assert.ok(f.session().getActiveToolNames().includes("memory_update"));
    assert.equal((await f.invoke("read-data", {}, undefined, "added")).isError, false);
    assert.equal(await f.executions("added"), 1);
    await eventually(() => alive(oldPid), value => !value, "idle reload leaked the old process");
  });

  it("parent mode changes refresh both child loadouts and enforce a final readonly guard", async t => {
    const f = await fixture(t, { mode: "full" });
    await f.save();
    await f.grant("read-data");
    const general = await f.child("general"); await f.connected("fixture", general);
    const explore = await f.child("explore"); await f.connected("fixture", explore);
    const write = await f.tool("write_data", "fixture", general);
    const read = await f.tool("read-data", "fixture", general);
    assert.ok(general.getActiveToolNames().includes(write.registeredName));
    await f.runtime.setMode(f.id, "plan");
    assert.equal(general.getActiveToolNames().includes(write.registeredName), false, "a general child must inherit the parent's new Plan gate immediately");
    assert.ok(general.getActiveToolNames().includes(read.registeredName));
    general.setActiveToolsByName([...general.getActiveToolNames(), write.registeredName]);
    const before = await f.executions();
    assert.equal((await f.invoke("write_data", {}, general)).isError, true);
    assert.equal(await f.executions(), before);
    await f.runtime.setMode(f.id, "agent");
    assert.ok(general.getActiveToolNames().includes(write.registeredName));
    assert.equal(explore.getActiveToolNames().includes(write.registeredName), false);
    assert.equal((await f.invoke("write_data", {}, general)).isError, false);
    assert.equal(await f.executions(), before + 1);
  });

  it("switching the parent to Plan revokes a child's pending unknown-tool approval", async t => {
    const f = await fixture(t);
    await f.save();
    const general = await f.child("general"); await f.connected("fixture", general);
    const write = await f.tool("write_data", "fixture", general);
    f.decision(null);
    let requested!: (id: string) => void;
    const approval = new Promise<string>(resolve => { requested = resolve; });
    f.permission.subscribe(event => { if (event.type === "request") requested(event.request.id); });
    const check = f.script([[call("child-mode-race", write.registeredName)], "Child Plan guard fixture report"], general);
    const running = general.prompt("Wait for approval of the fixture write");
    const approvalId = await within(approval, 2000, "child did not request MCP approval");
    await f.runtime.setMode(f.id, "plan");
    f.permission.reply(approvalId, true);
    await within(running, 2000, "mode change did not settle the pending child call"); check();
    assert.equal(f.result("child-mode-race", general).isError, true);
    assert.equal(await f.executions(), 0, "an approval from the old mode must not authorize a Plan write");
  });

  it("rechecks externally edited configuration after an approval and before protocol execution", async t => {
    const f = await fixture(t);
    await f.save();
    f.decision(null);
    const path = join(f.agentDir, "mcp.json");
    const document = JSON.parse(await readFile(path, "utf8"));
    f.permission.subscribe(event => {
      if (event.type !== "request") return;
      document.mcpServers.fixture.enabled = false;
      writeFileSync(path, JSON.stringify(document));
      f.permission.reply(event.request.id, true);
    });
    assert.equal((await f.invoke("write_data")).isError, true);
    assert.equal(await f.executions(), 0, "the one-second poll is not the authorization boundary");
    assert.equal(f.approvals.filter(event => event.type === "request").length, 1);
    await eventually(() => f.session().getActiveToolNames(), names => !names.some(name => name.startsWith("mcp__")), "external disable must also withdraw active tools");
  });

  it("rechecks externally revoked readonly policy even with a stale active loadout", async t => {
    const f = await fixture(t);
    await f.save();
    await f.grant("read-data");
    const info = await f.tool("read-data");
    const path = join(f.agentDir, "mcp-policy.json");
    const policy = JSON.parse(await readFile(path, "utf8"));
    policy.readOnly = [];
    writeFileSync(path, JSON.stringify(policy));
    const check = f.script([[call("external-policy-revocation", info.registeredName)], "Revocation fixture report"]);
    await f.runtime.prompt(f.id, "Recheck the readonly decision"); check();
    assert.equal(f.result("external-policy-revocation").isError, true);
    assert.equal(await f.executions(), 0);
    assert.equal(f.approvals.filter(event => event.type === "request").length, 1);
  });

  it("disable immediately cancels an in-flight protocol call and withdraws tools", async t => {
    const f = await fixture(t, { mode: "full" });
    await f.save();
    const info = await f.tool("delayed");
    const check = f.script([[call("disable-running", info.registeredName, { delayMs: 4000 })], "Cancellation fixture report"]);
    const running = f.runtime.prompt(f.id, "Run until the server is disabled");
    await eventually(() => f.executions(), count => count === 1, "fixture must receive the in-flight call");
    const pid = Number((await f.trace()).split("\n")[0]);
    const disabled = await within(f.runtime.setMcpEnabled({ ...f.target, scope: "global", name: "fixture", enabled: false }), 2000, "disable waited for the MCP tool timeout");
    assert.equal(disabled.servers.find(server => server.name === "fixture")?.enabled, false);
    await within(running, 2000, "in-flight MCP call was not cancelled by disable"); check();
    assert.equal(f.result("disable-running").isError, true);
    assert.equal(f.session().getActiveToolNames().some(name => name.startsWith("mcp__")), false);
    await eventually(() => alive(pid), value => !value, "disabled server process survived");
    assert.equal((await f.trace()).includes("completed:delayed"), false, "disable must kill the fixture before delayed completion");
    await assert.rejects(f.runtime.reconnectMcpServer({ ...f.target, scope: "global", name: "fixture" }), /disabled/i);
    await assert.rejects(f.runtime.loginMcpServer({ ...f.target, scope: "global", name: "fixture" }), /disabled/i);
  });

  it("reconnect replaces the process and does not lose valid readonly authorization", async t => {
    const f = await fixture(t);
    await f.save();
    await f.grant("read-data");
    const oldPid = Number((await f.trace()).split("\n")[0]);
    await f.runtime.reconnectMcpServer({ ...f.target, scope: "global", name: "fixture" });
    await f.connected();
    const newPid = Number((await f.trace()).split("\n")[0]);
    assert.notEqual(newPid, oldPid);
    await eventually(() => alive(oldPid), value => !value, "reconnect leaked its previous process");
    assert.equal((await f.tool("read-data")).readOnly, true);
    assert.equal((await f.invoke("read-data")).isError, false);
    assert.equal(await f.executions(), 1);
    assert.deepEqual(f.approvals, []);
    assert.ok(f.statusEvents.some(catalog => catalog.conversationId === f.id && catalog.servers.some(server => server.connectionStatus === "connected")));
  });

  it("an unexpected server exit is reported and the next call reconnects", async t => {
    const f = await fixture(t);
    await f.save();
    await f.grant("read-data");
    const info = await f.tool("read-data");
    const pid = Number((await f.trace()).split("\n")[0]);
    assert.ok(pid > 0);
    process.kill(pid, "SIGKILL");
    await eventually(() => f.catalog(), value => value.servers.some(server => server.name === "fixture" && server.connectionStatus !== "connected" && server.connectionStatus !== "connecting"), "unexpected exit was not reported");
    const callId = "recover-after-exit";
    const check = f.script([[call(callId, info.registeredName)], "Recovery report"]);
    await f.runtime.prompt(f.id, "Recover the fixture connection"); check();
    assert.equal(f.result(callId).isError, false, JSON.stringify(f.result(callId)));
    await f.connected();
    const nextPid = Number((await f.trace()).split("\n")[0]);
    assert.notEqual(nextPid, pid, "the next call must reconnect with a fresh process");
    assert.equal(await f.executions(), 1);
  });

  it("a request timeout returns an error result without retrying the call", async t => {
    const f = await fixture(t);
    await f.save("fixture", "global", "direct", 1);
    await f.grant("delayed");
    const info = await f.tool("delayed");
    const callId = "timeout-call";
    const check = f.script([[call(callId, info.registeredName, { delayMs: 3000 })], "Timeout report"]);
    await f.runtime.prompt(f.id, "Call the delayed fixture tool"); check();
    const result = f.result(callId);
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result), /timed out/i);
    assert.equal(await f.executions(), 1, "a timed-out MCP call must not be retried");
  });

  it("revoking readonly permission cancels a running Plan MCP call immediately", async t => {
    const f = await fixture(t);
    await f.save();
    await f.grant("hang");
    const info = await f.tool("hang");
    await f.runtime.setMode(f.id, "plan");
    const check = f.script([[call("readonly-running", info.registeredName)], "Readonly revocation fixture report"]);
    const running = f.runtime.prompt(f.id, "Read until readonly authorization is revoked");
    await eventually(() => f.executions(), count => count === 1, "readonly call never reached the protocol fixture");
    const pid = Number((await f.trace()).split("\n")[0]);
    await within(f.runtime.setMcpToolReadOnly({ ...f.target, server: "fixture", tool: "hang", configDigest: info.configDigest, toolDigest: info.toolDigest, readOnly: false }), 2000, "revocation waited for the tool timeout");
    await within(running, 2000, "revocation failed to cancel the active readonly call"); check();
    assert.equal(f.result("readonly-running").isError, true);
    assert.deepEqual(f.approvals, []);
    assert.equal(f.session().getActiveToolNames().includes(info.registeredName), false);
    await eventually(() => alive(pid), value => !value, "revoked server process survived");
  });

  it("revoking project trust cancels a running protocol call immediately", async t => {
    const f = await fixture(t, { mode: "full" });
    const untrusted = await f.save("fixture", "project");
    await f.runtime.setMcpProjectTrust({ ...f.target, trusted: true, digest: untrusted.projectTrust.digest });
    const info = await f.tool("hang");
    const check = f.script([[call("project-running", info.registeredName)], "Project revocation fixture report"]);
    const running = f.runtime.prompt(f.id, "Call the trusted project server");
    await eventually(() => f.executions(), count => count === 1, "project call never reached the fixture");
    const pid = Number((await f.trace()).split("\n")[0]);
    await within(f.runtime.setMcpProjectTrust({ ...f.target, trusted: false }), 2000, "trust revocation waited for the tool timeout");
    await within(running, 2000, "trust revocation failed to cancel the call"); check();
    assert.equal(f.result("project-running").isError, true);
    assert.equal((await f.catalog()).projectTrust.trusted, false);
    assert.equal(f.session().getActiveToolNames().some(name => name.startsWith("mcp__")), false);
    await eventually(() => alive(pid), value => !value, "untrusted project process survived");
  });

  for (const readonly of [true, false]) {
    it(`Goal ${readonly ? "readonly calls preserve" : "unknown calls invalidate"} delivery validation`, async t => {
      const f = await fixture(t, { mode: "full" });
      await f.save();
      const raw = readonly ? "read-data" : "write_data";
      if (readonly) await f.grant(raw);
      const info = await f.tool(raw);
      await f.runtime.setMode(f.id, "goal");
      const snapshots: Array<ReturnType<AgentRuntime["getSnapshot"]>["goal"]> = [];
      const replies: Array<string | ToolCall[]> = [
        [call("initial-validation", "record_goal_validation", validation)],
        [call("goal-mcp-operation", info.registeredName)],
        [call("first-completion", "update_goal", { status: "complete" })],
        ...(!readonly ? [
          [call("fresh-validation", "record_goal_validation", validation)],
          [call("final-completion", "update_goal", { status: "complete" })],
        ] : []),
        "Goal fixture complete",
      ];
      const check = f.script(replies, undefined, step => { if (step === 1 || step === 2) snapshots.push(f.runtime.getSnapshot().goal); });
      await f.runtime.prompt(f.id, "Validate the fixture goal and complete it"); check();
      assert.equal(f.result("initial-validation").isError, false);
      assert.equal(f.result("goal-mcp-operation").isError, false);
      assert.equal(await f.executions(), 1);
      assert.equal(snapshots[0]?.validation?.workRevision, 0);
      assert.equal(snapshots[1]?.workRevision, readonly ? 0 : 1);
      assert.equal(snapshots[1]?.validation?.workRevision, 0);
      assert.equal(f.result("first-completion").isError, !readonly);
      if (!readonly) assert.match(JSON.stringify(f.result("first-completion").content), /过期|重新/);
      const goal = f.runtime.getSnapshot().goal;
      assert.equal(goal?.status, "complete");
      assert.equal(goal?.validation?.workRevision, goal?.workRevision);
      const ended = f.events.find(event => event.type === "tool_end" && event.toolCallId === "goal-mcp-operation");
      assert.ok(ended?.type === "tool_end");
      assert.equal(ended.activity.mutated, !readonly);
    });
  }

  it("dispose during management creation closes concurrent callers and cannot leak a late session", async t => {
    const f = await fixture(t, { mode: "full" });
    await f.save(); await f.connected();
    const internals = f.runtime as unknown as Internals;
    const input = { cwd: f.cwd, conversationId: null };
    const opening = [f.runtime.getMcpCatalog(input), f.runtime.getMcpCatalog(input), f.runtime.getMcpCatalog(input)];
    const settled = Promise.allSettled(opening);
    for (let step = 0; step < 40 && internals.mcpManagementStarting.size === 0; step++) await Promise.resolve();
    assert.equal(internals.mcpManagementStarting.size, 1, "concurrent calls must share one genuinely pending management creation");
    const closing = f.runtime.dispose();
    const results = await settled;
    await closing;
    await f.trace();
    assert.ok(results.every(result => result.status === "rejected"), "a disposed runtime must not publish a late management catalog");
    assert.equal(internals.mcpManagementStarting.size, 0);
    assert.equal(internals.mcpManagement.size, 0);
    assert.equal(internals.mcpBridges.size, 0);
    await eventually(() => [...f.pids].filter(alive), remaining => remaining.length === 0, "management creation raced past dispose and leaked a process");
  });

  it("dispose closes root, management and directly-created child bridges without surviving processes", async t => {
    const f = await fixture(t, { mode: "full" });
    await f.save(); await f.connected();
    const general = await f.child("general");
    await f.connected("fixture", general);
    const explore = await f.child("explore");
    await f.connected("fixture", explore);
    const otherCwd = join(f.root, "management-workspace");
    await mkdir(otherCwd);
    await eventually(() => f.runtime.getMcpCatalog({ cwd: otherCwd }), catalog => catalog.servers.some(server => server.connectionStatus === "connected"), "management bridge failed to connect");
    await f.trace();
    assert.equal(f.pids.size, 4, "each session must own a distinct fixture process");
    await f.runtime.dispose();
    await eventually(() => [...f.pids].filter(alive), remaining => remaining.length === 0, "AgentRuntime.dispose left MCP child processes alive", 2000);
    for (const session of [general, explore]) assert.equal(session.getActiveToolNames().some(name => name.startsWith("mcp__")), false);
    await assert.rejects(f.runtime.getMcpCatalog(f.target), /closed/i);
    await f.runtime.dispose();
  });
});
