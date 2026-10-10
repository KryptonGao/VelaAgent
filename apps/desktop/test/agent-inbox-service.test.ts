import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import type { AgentInboxChange, AskUserQuestionRequest, SandboxApprovalRequest } from "@vela/shared";
import { AgentInboxService, type AgentInboxEvent, type AgentInboxResolver } from "../src/main/agent-inbox-service.ts";

function resolver() {
  const calls: string[] = [];
  const live = new Set<string>();
  const impl: AgentInboxResolver = {
    approve: (id, allowed) => { calls.push(`approve:${id}:${allowed}`); return live.delete(id); },
    answer: (id, answer) => { calls.push(`answer:${id}:${answer}`); return live.delete(id); },
  };
  return { calls, live, impl };
}

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "vela-inbox-"));
  const file = join(dir, "agent-inbox.json");
  let now = 1_000_000;
  const r = resolver();
  const service = new AgentInboxService(file, r.impl, () => now);
  service.init();
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, file, r, service, tick: (ms = 1000) => { now += ms; return now; }, reopen: () => { const next = new AgentInboxService(file, r.impl, () => now); next.init(); return next; } };
}

const approvalRequest = (id: string): SandboxApprovalRequest => ({ id, kind: "bash", command: "rm -rf build", path: null, cwd: "/work", createdAt: 1, conversationId: "c1" });
const approval = (id: string, extra: Partial<AgentInboxEvent> = {}): AgentInboxEvent => ({
  sourceEventId: `approval:${id}`, type: "approval", origin: "sandbox", title: "chat", summary: "rm -rf build",
  detail: { kind: "approval", request: approvalRequest(id) }, requestId: id, conversationId: "c1", ...extra,
});
const questionRequest: AskUserQuestionRequest = { id: "q1", conversationId: "c1", toolCallId: "t1", question: "Which API?", options: [{ label: "v1" }, { label: "v2" }], allowFreeText: false, createdAt: 1 };
const question = (extra: Partial<AgentInboxEvent> = {}): AgentInboxEvent => ({
  sourceEventId: "question:q1", type: "question", origin: "question", title: "chat", summary: "Which API?", requestId: "q1", conversationId: "c1",
  detail: { kind: "question", toolCallId: "t1", question: questionRequest.question, options: questionRequest.options, allowFreeText: false }, ...extra,
});
const decide = (itemId: string, expectedRevision: number, decision: "approve" | "deny" | "answer" | "skip" | "acknowledge", clientActionId: string, answer?: string) =>
  ({ itemId, expectedRevision, decision, clientActionId, ...(answer === undefined ? {} : { answer }) });

it("creates one item per source event and counts only pending items in the badge", async t => {
  const f = await fixture(t);
  const first = f.service.upsert(approval("a1"));
  const again = f.service.upsert(approval("a1", { title: "different" }));
  assert.equal(again.id, first.id);
  assert.equal(f.service.list().items.length, 1);
  assert.equal(first.status, "pending");
  assert.deepEqual(first.actions, ["approve", "deny"]);
  f.service.upsert({ sourceEventId: "turn:c2:1", type: "result", origin: "turn", title: "done", summary: "ok", detail: { kind: "text", text: "ok" } });
  const list = f.service.list();
  assert.equal(list.badge, 1);
  assert.equal(list.items.find(item => item.type === "result")?.status, "resolved");
  assert.deepEqual(list.items.find(item => item.type === "result")?.actions, []);
});

it("approves through the host and only marks the item resolved after the host accepts", async t => {
  const f = await fixture(t);
  f.r.live.add("a1");
  const item = f.service.upsert(approval("a1"));
  const result = f.service.decide(decide(item.id, item.revision, "approve", "act-1"));
  assert.equal(result.ok, true);
  assert.deepEqual(f.r.calls, ["approve:a1:true"]);
  assert.equal(f.service.get(item.id)?.status, "resolved");
  assert.equal(f.service.get(item.id)?.outcome, "approved");
  assert.equal(f.service.list().badge, 0);
});

it("marks the item invalidated and never claims approval when the host wait point is gone", async t => {
  const f = await fixture(t);
  const item = f.service.upsert(approval("gone"));
  const result = f.service.decide(decide(item.id, item.revision, "approve", "act-1"));
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, "invalidated");
  assert.equal(f.service.get(item.id)?.status, "invalidated");
  assert.notEqual(f.service.get(item.id)?.outcome, "approved");
});

it("lets exactly one of two concurrent decisions win and replays a repeated clientActionId", async t => {
  const f = await fixture(t);
  f.r.live.add("a1");
  const item = f.service.upsert(approval("a1"));
  const approve = f.service.decide(decide(item.id, item.revision, "approve", "act-1"));
  const deny = f.service.decide(decide(item.id, item.revision, "deny", "act-2"));
  assert.equal(approve.ok, true);
  assert.equal(deny.ok, false);
  assert.equal(!deny.ok && deny.reason, "stale");
  assert.deepEqual(f.r.calls, ["approve:a1:true"], "the host is only called once");
  const replay = f.service.decide(decide(item.id, item.revision, "approve", "act-1"));
  assert.equal(replay.ok, true);
  assert.equal(f.r.calls.length, 1, "a repeated clientActionId does not call the host again");
});

it("converges when the chat answers first: the Inbox decision is stale and cannot override the outcome", async t => {
  const f = await fixture(t);
  const item = f.service.upsert(question());
  f.service.settle("question:q1", { status: "resolved", outcome: "answered" });
  const result = f.service.decide(decide(item.id, item.revision, "answer", "act-1", "v1"));
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, "stale");
  assert.deepEqual(f.r.calls, []);
  const settledAgain = f.service.settle("question:q1", { status: "cancelled", outcome: "skipped" });
  assert.equal(settledAgain?.outcome, "answered", "a later host event does not overwrite an earlier result");
});

it("validates answers against the stored options and free-text permission", async t => {
  const f = await fixture(t);
  f.r.live.add("q1");
  const item = f.service.upsert(question());
  assert.equal(f.service.decide(decide(item.id, item.revision, "answer", "a", "v3")).ok, false);
  assert.equal(f.service.decide(decide(item.id, item.revision, "answer", "b")).ok, false);
  assert.equal(f.service.decide(decide(item.id, item.revision, "approve", "c")).ok, false);
  assert.deepEqual(f.r.calls, []);
  const ok = f.service.decide(decide(item.id, item.revision, "answer", "d", "v2"));
  assert.equal(ok.ok, true);
  assert.deepEqual(f.r.calls, ["answer:q1:v2"]);
  const stored = f.service.get(item.id)!;
  assert.equal(stored.detail.kind === "question" && stored.detail.answer, "v2");
});

it("skipping a question answers the host with null", async t => {
  const f = await fixture(t);
  f.r.live.add("q1");
  const item = f.service.upsert(question());
  assert.equal(f.service.decide(decide(item.id, item.revision, "skip", "a")).ok, true);
  assert.deepEqual(f.r.calls, ["answer:q1:null"]);
  assert.equal(f.service.get(item.id)?.status, "cancelled");
});

it("archiving and reading never change the business status or the badge", async t => {
  const f = await fixture(t);
  const item = f.service.upsert(approval("a1"));
  f.service.markRead(item.id);
  const archived = f.service.archive(item.id, true)!;
  assert.equal(archived.status, "pending");
  assert.equal(archived.revision, item.revision);
  assert.equal(f.service.list().badge, 1);
  assert.equal(f.service.list().items.length, 0);
  assert.equal(f.service.list({ archived: true }).items.length, 1);
  assert.deepEqual(f.r.calls, []);
});

it("invalidates pending approvals and questions on restart but keeps acknowledgeable errors", async t => {
  const f = await fixture(t);
  f.service.upsert(approval("a1"));
  f.service.upsert(question());
  f.service.upsert({ sourceEventId: "turn:c2:1", type: "error", origin: "turn", title: "x", summary: "boom", detail: { kind: "text", text: "boom" } });
  const reopened = f.reopen();
  const items = reopened.list().items;
  assert.equal(items.find(item => item.type === "approval")?.status, "invalidated");
  assert.equal(items.find(item => item.type === "question")?.status, "invalidated");
  assert.equal(items.find(item => item.type === "error")?.status, "pending");
  assert.deepEqual(items.find(item => item.type === "approval")?.actions, []);
  assert.equal(reopened.list().badge, 1);
  const stale = items.find(item => item.type === "approval")!;
  assert.equal(reopened.decide(decide(stale.id, stale.revision, "approve", "x")).ok, false);
  assert.deepEqual(f.r.calls, []);
});

it("persists before notifying listeners", async t => {
  const f = await fixture(t);
  const seen: string[] = [];
  f.service.subscribe((change: AgentInboxChange) => {
    const onDisk = JSON.parse(readFileSync(f.file, "utf8")) as { revision: number; items: Array<{ id: string }> };
    seen.push(`${change.revision}:${onDisk.revision}:${onDisk.items.some(item => change.upserts.some(up => up.id === item.id))}`);
  });
  f.service.upsert(approval("a1"));
  assert.deepEqual(seen, ["1:1:true"]);
});

it("quarantines a corrupt store instead of overwriting it", async t => {
  const f = await fixture(t);
  await writeFile(f.file, "{not json");
  const service = new AgentInboxService(f.file, f.r.impl, () => 5);
  service.init();
  assert.match(service.getError() ?? "", /已损坏/);
  assert.equal(service.list().items.length, 0);
  const files = await readdir(f.dir);
  assert.ok(files.some(name => name.startsWith("agent-inbox.json.corrupt-")));
  service.upsert(approval("a1"));
  assert.equal(JSON.parse(readFileSync(f.file, "utf8")).items.length, 1);
});

it("caps stored items by removing the oldest finished items first and never pending ones", async t => {
  const f = await fixture(t);
  const pending = f.service.upsert(approval("keep"));
  for (let index = 0; index < 1005; index += 1) {
    f.tick();
    f.service.upsert({ sourceEventId: `turn:c:${index}`, type: "result", origin: "turn", title: "t", summary: "s", detail: { kind: "text", text: "s" } });
  }
  const all = [...f.service.list({ limit: 200 }).items];
  assert.ok(f.service.get(pending.id));
  assert.equal(f.service.getBySource("turn:c:0"), null);
  assert.ok(f.service.getBySource("turn:c:1004"));
  assert.ok(all.length <= 200);
});

it("remembers the scheduled-run cursor across restarts", async t => {
  const f = await fixture(t);
  assert.equal(f.service.getCursors().scheduledRunsAt, null);
  f.service.setCursor("scheduledRunsAt", 42);
  assert.equal(f.reopen().getCursors().scheduledRunsAt, 42);
});

it("acknowledges errors without involving the host", async t => {
  const f = await fixture(t);
  const item = f.service.upsert({ sourceEventId: "turn:c:1", type: "error", origin: "turn", title: "t", summary: "boom", detail: { kind: "text", text: "boom" } });
  assert.equal(f.service.list().badge, 1);
  assert.equal(f.service.decide(decide(item.id, item.revision, "acknowledge", "a")).ok, true);
  assert.equal(f.service.list().badge, 0);
  assert.deepEqual(f.r.calls, []);
  await readdir(f.dir);
});
