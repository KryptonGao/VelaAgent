import assert from "node:assert/strict";
import { it } from "node:test";
import type { AgentInboxApi, AgentInboxChange, AgentInboxItem, AgentInboxListResult } from "@vela/shared";
import { agentInboxOverview, agentInboxUnreadCount, agentInboxViewCount, filterAgentInboxItems } from "../src/renderer/components/agent-inbox-model.ts";
import { AgentInboxStore } from "../src/renderer/components/agent-inbox-store.ts";

let counter = 0;
function item(extra: Partial<AgentInboxItem> = {}): AgentInboxItem {
  counter += 1;
  return {
    id: `i${counter}`, schemaVersion: 1, type: "result", origin: "turn", status: "resolved", readState: "unread", priority: "normal",
    title: `title ${counter}`, summary: "summary", sourceEventId: `s${counter}`, revision: 1, createdAt: counter, updatedAt: counter,
    actions: [], detail: { kind: "text", text: "text" }, decisions: {}, ...extra,
  };
}

it("views: archiving a pending item hides it from Overview but never from Needs action", () => {
  const pending = item({ type: "approval", status: "pending", actions: ["approve", "deny"], detail: { kind: "approval", request: { id: "r", kind: "bash", command: "ls", path: null, cwd: null, createdAt: 1 } } });
  const done = item();
  const archivedDone = item({ readState: "archived" });
  const archivedPending = { ...pending, id: "p2", readState: "archived" as const };
  const all = [pending, done, archivedDone, archivedPending];
  assert.equal(agentInboxViewCount(all, "needs_action"), 2, "equals the badge");
  assert.equal(agentInboxViewCount(all, "activity"), 1);
  assert.equal(agentInboxViewCount(all, "archive"), 2);
  assert.equal(agentInboxViewCount(all, "overview"), 3);
});

it("sorts pending approvals and questions ahead of everything else, then by recency", () => {
  const base = { status: "pending" as const };
  const error = item({ ...base, type: "error", updatedAt: 500 });
  const question = item({ ...base, type: "question", updatedAt: 100 });
  const approval = item({ ...base, type: "approval", updatedAt: 50 });
  const newestResult = item({ updatedAt: 900 });
  const rows = filterAgentInboxItems([newestResult, error, question, approval], { view: "overview", type: "all", search: "" });
  assert.deepEqual(rows.map(row => row.type), ["approval", "question", "error", "result"]);
});

it("filters by type and multi-term search across title, summary, command and workspace", () => {
  const bash = item({ type: "approval", status: "pending", title: "Deploy chat", workspaceId: "/work/app", detail: { kind: "approval", request: { id: "r", kind: "bash", command: "npm run build", path: null, cwd: "/work/app", createdAt: 1 } } });
  const other = item({ title: "Nightly check", summary: "all green" });
  const rows = (type: "all" | "approval" | "result", search: string) => filterAgentInboxItems([bash, other], { view: "overview", type, search }).map(row => row.id);
  assert.deepEqual(rows("all", "npm build"), [bash.id]);
  assert.deepEqual(rows("all", "WORK/APP"), [bash.id]);
  assert.deepEqual(rows("result", ""), [other.id]);
  assert.deepEqual(rows("all", "nightly missing"), []);
});

it("overview separates what needs attention from recent activity", () => {
  const pending = item({ type: "question", status: "pending" });
  const recent = Array.from({ length: 10 }, () => item());
  const overview = agentInboxOverview([pending, ...recent, item({ readState: "archived" })], 8);
  assert.deepEqual(overview.attention.map(entry => entry.id), [pending.id]);
  assert.equal(overview.recent.length, 8);
  assert.ok(overview.recent.every(entry => entry.readState !== "archived"));
  assert.equal(agentInboxUnreadCount([pending, ...recent]), 11);
});

function fakeApi(initial: AgentInboxListResult) {
  const listeners = new Set<(change: AgentInboxChange) => void>();
  let list = initial;
  let listCalls = 0;
  const api: AgentInboxApi = {
    list: async query => { listCalls += 1; return query?.archived ? { ...list, items: list.items.filter(entry => entry.readState === "archived") } : { ...list, items: list.items.filter(entry => entry.readState !== "archived") }; },
    get: async id => list.items.find(entry => entry.id === id) ?? null,
    decide: async request => ({ ok: false, reason: "stale", item: list.items.find(entry => entry.id === request.itemId) ?? null }),
    markRead: async id => { const found = list.items.find(entry => entry.id === id); return found ? { ...found, readState: "read" } : null; },
    archive: async (id, archived) => { const found = list.items.find(entry => entry.id === id); return found ? { ...found, readState: archived ? "archived" : "read" } : null; },
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  return {
    api, listeners,
    emit: (change: AgentInboxChange) => { for (const listener of listeners) listener(change); },
    setList: (next: AgentInboxListResult) => { list = next; },
    listCalls: () => listCalls,
  };
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

it("store loads, applies contiguous pushes in place and takes the badge from the host", async () => {
  const a = item({ type: "approval", status: "pending" });
  const fake = fakeApi({ items: [a], nextBefore: null, badge: 1, revision: 5, error: null });
  const store = new AgentInboxStore(fake.api);
  const release = store.attach();
  await flush();
  assert.equal(store.getSnapshot().loaded, true);
  assert.equal(store.getSnapshot().badge, 1);
  const resolved = { ...a, status: "resolved" as const, revision: 2, updatedAt: 99 };
  fake.emit({ revision: 6, upserts: [resolved], badge: 0, error: null });
  assert.equal(store.getSnapshot().badge, 0);
  assert.equal(store.getSnapshot().items[0]?.status, "resolved");
  assert.equal(fake.listCalls(), 1, "no reload for a contiguous push");
  release();
});

it("store reloads on a revision gap and ignores stale or older pushes", async () => {
  const a = item({ type: "approval", status: "pending" });
  const fake = fakeApi({ items: [a], nextBefore: null, badge: 1, revision: 5, error: null });
  const store = new AgentInboxStore(fake.api);
  const release = store.attach();
  await flush();
  fake.emit({ revision: 4, upserts: [{ ...a, status: "rejected", revision: 9 }], badge: 0, error: null });
  assert.equal(store.getSnapshot().items[0]?.status, "pending", "an old push is ignored");
  const b = item({ type: "question", status: "pending" });
  fake.setList({ items: [a, b], nextBefore: null, badge: 2, revision: 9, error: null });
  fake.emit({ revision: 8, upserts: [b], badge: 2, error: null });
  await flush();
  assert.equal(fake.listCalls(), 2, "a gap triggers a full reload");
  assert.equal(store.getSnapshot().items.length, 2);
  assert.equal(store.getSnapshot().badge, 2);
  release();
});

it("store never lets an older business revision overwrite a newer one", async () => {
  const a = item({ type: "approval", status: "pending", revision: 1 });
  const fake = fakeApi({ items: [a], nextBefore: null, badge: 1, revision: 1, error: null });
  const store = new AgentInboxStore(fake.api);
  const release = store.attach();
  await flush();
  fake.emit({ revision: 2, upserts: [{ ...a, status: "resolved", revision: 2 }], badge: 0, error: null });
  const result = await store.decide(a, "approve");
  assert.equal(result.ok, false);
  assert.equal(store.getSnapshot().items[0]?.status, "resolved", "the stale reply (revision 1) did not win");
  release();
});

it("store keeps loaded archived items across reloads and reports load failures", async () => {
  const archived = item({ readState: "archived" });
  const live = item();
  const fake = fakeApi({ items: [live, archived], nextBefore: null, badge: 0, revision: 1, error: null });
  const store = new AgentInboxStore(fake.api);
  const release = store.attach();
  await flush();
  assert.equal(store.getSnapshot().items.length, 1);
  await store.loadArchived();
  assert.equal(store.getSnapshot().items.length, 2);
  await store.reload();
  assert.equal(store.getSnapshot().items.length, 2);
  release();
  const failing = new AgentInboxStore({ ...fake.api, list: async () => { throw new Error("main unavailable"); } });
  const releaseFailing = failing.attach();
  await flush();
  assert.equal(failing.getSnapshot().loadError, "main unavailable");
  releaseFailing();
});

it("store applies pushes that arrive while the first load is still in flight", async () => {
  const a = item({ type: "approval", status: "pending" });
  const b = item({ type: "question", status: "pending" });
  const fake = fakeApi({ items: [a], nextBefore: null, badge: 1, revision: 5, error: null });
  const store = new AgentInboxStore(fake.api);
  const release = store.attach();
  fake.emit({ revision: 6, upserts: [b], badge: 2, error: null });
  await flush();
  assert.deepEqual(store.getSnapshot().items.map(entry => entry.id).sort(), [a.id, b.id].sort());
  assert.equal(store.getSnapshot().badge, 2);
  release();
});
