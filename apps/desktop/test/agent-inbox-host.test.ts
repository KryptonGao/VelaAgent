import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, mock, type TestContext } from "node:test";
import { AgentInboxIpc, type AgentInboxChange } from "@vela/shared";

const handlers = new Map<string, (...args: any[]) => any>();
const sent: Array<{ channel: string; payload: unknown }> = [];
let loading = false;
const windows = [{ isDestroyed: () => false, webContents: { isDestroyed: () => false, isLoading: () => loading, send: (channel: string, payload: unknown) => sent.push({ channel, payload }) } }];
mock.module("electron", { namedExports: {
  ipcMain: {
    handle: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn),
    removeHandler: (name: string) => handlers.delete(name),
  },
  BrowserWindow: { fromWebContents: () => ({}), getAllWindows: () => windows },
} });
const { AgentInboxHost } = await import("../src/main/agent-inbox-host.ts");
const { AgentInboxService } = await import("../src/main/agent-inbox-service.ts");

async function fixture(t: TestContext, runtime?: import("../src/main/agent-inbox-host.ts").AgentInboxHostRuntime) {
  const dir = await mkdtemp(join(tmpdir(), "vela-inbox-host-"));
  const calls: string[] = [];
  const live = new Set<string>(["req1"]);
  const service = new AgentInboxService(join(dir, "agent-inbox.json"), {
    approve: (id, allowed) => { calls.push(`approve:${id}:${allowed}`); return live.delete(id); },
    answer: (id, answer) => { calls.push(`answer:${id}:${answer}`); return live.delete(id); },
  });
  service.init();
  const item = service.upsert({
    sourceEventId: "approval:req1", type: "approval", origin: "sandbox", title: "chat", summary: "ls", requestId: "req1",
    detail: { kind: "approval", request: { id: "req1", kind: "bash", command: "ls", path: null, cwd: "/w", createdAt: 1 } },
  });
  const host = new AgentInboxHost(service, runtime);
  host.register();
  const frame = {};
  const sender = Object.assign(new EventEmitter(), { id: 1, mainFrame: frame });
  t.after(async () => { host.dispose(); await rm(dir, { recursive: true, force: true }); });
  return { host, calls, item, service, event: { sender, senderFrame: frame }, invoke: (channel: string, ...args: unknown[]) => handlers.get(channel)!(...args) };
}

it("only the app window main frame may call Agent Inbox, before any service work happens", async t => {
  const f = await fixture(t);
  const foreign = { ...f.event, senderFrame: {} };
  for (const channel of [AgentInboxIpc.list, AgentInboxIpc.get, AgentInboxIpc.decide, AgentInboxIpc.markRead, AgentInboxIpc.archive]) {
    assert.throws(() => f.invoke(channel, foreign, {}), /应用窗口/, channel);
  }
  assert.deepEqual(f.calls, []);
});

it("rejects malformed arguments without reaching the host or the service", async t => {
  const f = await fixture(t);
  const bad: unknown[] = [
    null, "x", [],
    { itemId: "../escape", expectedRevision: 1, decision: "approve", clientActionId: "a" },
    { itemId: f.item.id, expectedRevision: "1", decision: "approve", clientActionId: "a" },
    { itemId: f.item.id, expectedRevision: 1.5, decision: "approve", clientActionId: "a" },
    { itemId: f.item.id, expectedRevision: 1, decision: "submit_to_agent", clientActionId: "a" },
    { itemId: f.item.id, expectedRevision: 1, decision: "approve", clientActionId: "bad id!" },
    { itemId: f.item.id, expectedRevision: 1, decision: "answer", answer: 5, clientActionId: "a" },
    { itemId: f.item.id, expectedRevision: 1, decision: "answer", answer: "x".repeat(5000), clientActionId: "a" },
  ];
  for (const input of bad) assert.throws(() => f.invoke(AgentInboxIpc.decide, f.event, input), undefined, JSON.stringify(input)?.slice(0, 60));
  assert.throws(() => f.invoke(AgentInboxIpc.list, f.event, { limit: 0 }));
  assert.throws(() => f.invoke(AgentInboxIpc.list, f.event, { archived: "yes" }));
  assert.throws(() => f.invoke(AgentInboxIpc.archive, f.event, f.item.id, "yes"));
  assert.throws(() => f.invoke(AgentInboxIpc.get, f.event, "a b"));
  assert.deepEqual(f.calls, []);
  assert.equal(f.service.get(f.item.id)?.status, "pending");
});

it("ignores a renderer-supplied requestId and uses the stored one", async t => {
  const f = await fixture(t);
  const result = f.invoke(AgentInboxIpc.decide, f.event, {
    itemId: f.item.id, expectedRevision: f.item.revision, decision: "approve", clientActionId: "a", requestId: "someone-elses",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(f.calls, ["approve:req1:true"]);
});

it("decide on an already-resolved request reports it and does not call the host again", async t => {
  const f = await fixture(t);
  const request = { itemId: f.item.id, expectedRevision: f.item.revision, decision: "approve", clientActionId: "a" };
  assert.equal(f.invoke(AgentInboxIpc.decide, f.event, request).ok, true);
  const again = f.invoke(AgentInboxIpc.decide, f.event, { ...request, clientActionId: "b" });
  assert.equal(again.ok, false);
  assert.equal(f.calls.length, 1);
});

it("lists, reads, archives and broadcasts changes to every live window", async t => {
  const f = await fixture(t);
  sent.length = 0;
  assert.equal(f.invoke(AgentInboxIpc.list, f.event).badge, 1);
  assert.equal(f.invoke(AgentInboxIpc.get, f.event, f.item.id).id, f.item.id);
  f.invoke(AgentInboxIpc.archive, f.event, f.item.id, true);
  assert.equal(f.invoke(AgentInboxIpc.list, f.event, { archived: true }).items.length, 1);
  const change = sent.find(entry => entry.channel === AgentInboxIpc.change)?.payload as AgentInboxChange;
  assert.equal(change.upserts[0]?.readState, "archived");
  assert.equal(change.badge, 1);
});

it("dispose removes every handler and stops broadcasting", async t => {
  const f = await fixture(t);
  assert.equal(handlers.size, 8);
  f.host.dispose();
  assert.equal(handlers.size, 0);
  sent.length = 0;
  f.service.markRead(f.item.id);
  assert.equal(sent.length, 0);
});

const uiText = "整理好了：\n\n```vela-ui\n{\"op\":\"begin\",\"id\":\"a\",\"version\":1}\n```\n";

it("reads UI content by the stored reference and refuses a changed or missing reply", async t => {
  const messages: Array<{ role: "assistant" | "user"; text: string }> = [{ role: "assistant", text: uiText }];
  const f = await fixture(t, { getMessages: () => messages, promptBackground: async () => {} });
  const { uiContentRef, latestUiReply } = await import("@vela/shared");
  const ref = uiContentRef("c1", latestUiReply(messages)!);
  const item = f.service.upsert({ sourceEventId: "turn:c1:1", type: "result", origin: "turn", title: "t", summary: "s", conversationId: "c1", contentRef: ref, detail: { kind: "text", text: "s" } });
  assert.deepEqual(f.invoke(AgentInboxIpc.content, f.event, item.id), { text: uiText, conversationId: "c1", uiOrdinal: 0 });
  messages[0]!.text += "changed";
  assert.equal(f.invoke(AgentInboxIpc.content, f.event, item.id), null, "a rewritten reply is never shown under the old reference");
  assert.equal(f.invoke(AgentInboxIpc.content, f.event, f.item.id), null, "items without a reference have no content");
  assert.throws(() => f.invoke(AgentInboxIpc.content, { ...f.event, senderFrame: {} }, item.id), /应用窗口/);
});

it("submit goes to the stored conversation, never one chosen by the renderer", async t => {
  const prompts: Array<[string, string]> = [];
  const f = await fixture(t, { getMessages: () => [], promptBackground: async (id, text) => { prompts.push([id, text]); } });
  const item = f.service.upsert({ sourceEventId: "turn:c1:1", type: "result", origin: "turn", title: "t", summary: "s", conversationId: "stored-conversation", detail: { kind: "text", text: "s" } });
  assert.deepEqual(await f.invoke(AgentInboxIpc.submit, f.event, item.id, "go on"), { ok: true });
  assert.deepEqual(prompts, [["stored-conversation", "go on"]]);
  assert.equal((await f.invoke(AgentInboxIpc.submit, f.event, item.id, "   ")).ok, false);
  assert.equal((await f.invoke(AgentInboxIpc.submit, f.event, "missing", "x")).ok, false);
  assert.throws(() => f.invoke(AgentInboxIpc.submit, f.event, item.id, 5));
  assert.equal(prompts.length, 1);
  assert.equal(f.service.get(f.item.id)?.status, "pending", "submitting never decides a request");
});

it("a rejected submit is reported to the caller", async t => {
  const f = await fixture(t, { getMessages: () => [], promptBackground: async () => { throw new Error("没有可用的模型"); } });
  const item = f.service.upsert({ sourceEventId: "turn:c1:1", type: "result", origin: "turn", title: "t", summary: "s", conversationId: "c1", detail: { kind: "text", text: "s" } });
  assert.deepEqual(await f.invoke(AgentInboxIpc.submit, f.event, item.id, "hi"), { ok: false, message: "没有可用的模型" });
});

it("navigation is delivered once to a loaded window and kept for a window that is still loading", async t => {
  const f = await fixture(t);
  sent.length = 0;
  f.host.navigate({ view: "resident" });
  assert.deepEqual(sent.filter(entry => entry.channel === AgentInboxIpc.navigate).map(entry => entry.payload), [{ view: "resident" }]);
  assert.equal(f.invoke(AgentInboxIpc.takeNavigation, f.event), null, "a delivered request is not replayed after a reload");
  loading = true;
  sent.length = 0;
  f.host.navigate({ view: "item", itemId: f.item.id });
  loading = false;
  assert.equal(sent.length, 0);
  assert.deepEqual(f.invoke(AgentInboxIpc.takeNavigation, f.event), { view: "item", itemId: f.item.id });
  assert.equal(f.invoke(AgentInboxIpc.takeNavigation, f.event), null, "taking it consumes it");
});
