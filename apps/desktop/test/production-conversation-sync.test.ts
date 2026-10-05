import assert from "node:assert/strict";
import { appendFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "node:test";
import { AgentRuntime } from "../../../packages/agent/src/runtime.ts";
import { createPersistedSession } from "../../../packages/agent/src/session-persistence.ts";
import { syncProductionConversations } from "../src/main/production-conversation-sync.ts";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "vela-production-sync-"));
  const source = join(root, "production"), destination = join(root, "development");
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await mkdir(source);
  const runtime = new AgentRuntime({ cwd: workspace, agentDir: destination });
  const runtimes = [runtime];
  t.after(async () => { for (const runtime of runtimes) await runtime.dispose(); await rm(root, { recursive: true, force: true }); });
  await runtime.createConversation(workspace);
  const active = runtime.activeConversationId!;
  async function conversation(title = "Production chat") {
    const manager = createPersistedSession(workspace, join(source, "sessions"));
    manager.appendMessage({ role: "user", content: "Production history", timestamp: 1000 });
    return {
      id: manager.getSessionId(), cwd: workspace, hasWorkspace: true, title,
      createdAt: 1000, updatedAt: 2000, messageCount: 1, toolCallCount: 0,
      sessionFile: manager.getSessionFile()!, instructions: "", mode: "agent",
      plans: [], executionPlans: [], latestProposedPlanId: null, activeExecutionPlanId: null,
      goal: null, archivedAt: null,
    };
  }
  async function index(entries: unknown[]) {
    await writeFile(join(source, "conversations.json"), JSON.stringify({ version: 2, conversations: entries }));
  }
  return { root, source, destination, workspace, runtime, runtimes, active, conversation, index };
}

it("imports live history into the sidebar without switching chats; deduplicates and retains independent copies after restart", async t => {
  const f = await fixture(t);
  const entry = await f.conversation();
  await f.index([entry]);
  const original = await readFile(entry.sessionFile, "utf8");
  const sourceIndex = await readFile(join(f.source, "conversations.json"), "utf8");
  const events: string[] = [];
  f.runtime.subscribe(event => events.push(event.type));
  assert.deepEqual(await syncProductionConversations(f.runtime, f.source, f.destination), { imported: 1, existing: 0, unavailable: 0 });
  assert.equal(f.runtime.activeConversationId, f.active);
  assert.equal(f.runtime.listConversations().find(chat => chat.id === entry.id)?.title, entry.title);
  assert.ok(events.includes("status"), "sidebar receives updated app state");
  const stored = JSON.parse(await readFile(join(f.destination, "conversations.json"), "utf8"));
  const imported = stored.conversations.find((chat: { id: string }) => chat.id === entry.id);
  assert.ok(imported.sessionFile.startsWith(join(f.destination, "sessions")));
  assert.notEqual(imported.sessionFile, entry.sessionFile);
  assert.equal(await readFile(imported.sessionFile, "utf8"), original);
  await f.runtime.switchConversation(entry.id);
  assert.equal(f.runtime.getMessages(entry.id)[0]?.text, "Production history");
  await f.runtime.renameConversation(entry.id, "Development edit");
  assert.deepEqual(await syncProductionConversations(f.runtime, f.source, f.destination), { imported: 0, existing: 1, unavailable: 0 });
  assert.equal(f.runtime.listConversations().find(chat => chat.id === entry.id)?.title, "Development edit");
  assert.equal(await readFile(entry.sessionFile, "utf8"), original);
  assert.equal(await readFile(join(f.source, "conversations.json"), "utf8"), sourceIndex);
  await f.runtime.dispose();
  const restored = new AgentRuntime({ cwd: f.workspace, agentDir: f.destination });
  f.runtimes.push(restored);
  await restored.switchConversation(entry.id);
  assert.equal(restored.getMessages(entry.id)[0]?.text, "Production history");
  assert.equal(restored.listConversations().find(chat => chat.id === entry.id)?.title, "Development edit");
});

it("copies subagent sessions, traces and checkpoint paths; imported goals and agents do not resume production work", async t => {
  const f = await fixture(t);
  const entry = await f.conversation();
  const child = createPersistedSession(f.workspace, join(f.source, "subagents", entry.id));
  child.appendMessage({ role: "user", content: "Child history", timestamp: 1000 });
  const agent = { id: "child", parentId: null, path: "/root/child", name: "Child", kind: "explore", status: "running",
    task: "Inspect", steps: [], mutated: false, finalText: null, error: null, createdAt: 1, updatedAt: 2, sessionFile: child.getSessionFile() };
  await f.index([{ ...entry, archivedAt: 50, agents: [agent],
    mode: "goal", goal: { id: "production-goal", objective: "Production task", status: "active", note: null, workRevision: 0, validation: null, updatedAt: 2 },
    recipeRunId: "production-recipe",
    recipeExecution: { sandboxMode: "full" } }]);
  await mkdir(join(f.source, "traces"));
  await writeFile(join(f.source, "traces", `${entry.id}.jsonl`), '{"type":"fixture"}\n');
  const checkpoint = join(f.source, "checkpoints", entry.id, "point.json");
  await mkdir(dirname(checkpoint), { recursive: true });
  await writeFile(checkpoint, JSON.stringify({ metadata: { agents: [agent] } }));
  assert.equal((await syncProductionConversations(f.runtime, f.source, f.destination)).imported, 1);
  const stored = JSON.parse(await readFile(join(f.destination, "conversations.json"), "utf8"));
  const copied = stored.conversations.find((chat: { id: string }) => chat.id === entry.id);
  assert.equal(copied.recipeExecution, undefined);
  assert.equal(copied.recipeRunId, undefined);
  assert.equal(copied.agents[0].status, "aborted");
  assert.equal(copied.goal.status, "paused");
  assert.ok(copied.agents[0].sessionFile.startsWith(f.destination));
  assert.equal(f.runtime.getAgentMessages(entry.id, "child")[0]?.text, "Child history");
  assert.equal(f.runtime.listConversations().find(chat => chat.id === entry.id)?.archivedAt, 50);
  assert.equal(await readFile(join(f.destination, "traces", `${entry.id}.jsonl`), "utf8"), '{"type":"fixture"}\n');
  const point = JSON.parse(await readFile(join(f.destination, "checkpoints", entry.id, "point.json"), "utf8"));
  assert.equal(point.metadata.agents[0].sessionFile, copied.agents[0].sessionFile);
});

it("skips missing or malformed sessions and snapshots a complete prefix while production is appending a message", async t => {
  const f = await fixture(t);
  const entry = await f.conversation();
  await appendFile(entry.sessionFile, '{"type":"message"');
  await f.index([entry, { ...entry, id: "missing", sessionFile: join(f.source, "sessions", "missing.jsonl") }, { id: "bad" }, { ...entry, id: "../unsafe" }]);
  assert.deepEqual(await syncProductionConversations(f.runtime, f.source, f.destination), { imported: 1, existing: 0, unavailable: 3 });
  await f.runtime.switchConversation(entry.id);
  assert.equal(f.runtime.getMessages(entry.id)[0]?.text, "Production history");
  const next = await f.conversation();
  await writeFile(next.sessionFile, "broken\n");
  await f.index([next]);
  assert.deepEqual(await syncProductionConversations(f.runtime, f.source, f.destination), { imported: 0, existing: 0, unavailable: 1 });
});

it("rejects missing, unsupported or corrupt source indices and same-directory aliases without altering existing chats", async t => {
  const f = await fixture(t);
  const before = await readFile(join(f.destination, "conversations.json"), "utf8");
  await assert.rejects(syncProductionConversations(f.runtime, f.source, f.destination), /没有找到正式版会话/);
  await writeFile(join(f.source, "conversations.json"), "corrupt");
  await assert.rejects(syncProductionConversations(f.runtime, f.source, f.destination), /索引损坏/);
  await writeFile(join(f.source, "conversations.json"), '{"version":99,"conversations":[]}');
  await assert.rejects(syncProductionConversations(f.runtime, f.source, f.destination), /格式不受支持/);
  const alias = join(f.root, "alias");
  await symlink(f.destination, alias);
  await assert.rejects(syncProductionConversations(f.runtime, alias, f.destination), /无需同步/);
  assert.equal(await readFile(join(f.destination, "conversations.json"), "utf8"), before);
  assert.equal(f.runtime.activeConversationId, f.active);
});

it("rolls back copied files and in-memory records when publishing the destination index fails", async t => {
  const f = await fixture(t);
  const entry = await f.conversation();
  await f.index([entry]);
  const file = join(f.destination, "conversations.json");
  await f.runtime.importConversations(async () => []);
  await writeFile(file, "destination corruption");
  await assert.rejects(syncProductionConversations(f.runtime, f.source, f.destination), SyntaxError);
  assert.equal(f.runtime.listConversations().some(chat => chat.id === entry.id), false);
  assert.equal(await readFile(file, "utf8"), "destination corruption");
  assert.equal((await readdir(f.destination)).some(name => name.startsWith(".conversation-sync-")), false);
  const imports = join(f.destination, "sessions", "production-sync");
  assert.deepEqual(await readdir(imports), []);
});

it("serializes simultaneous clicks and excludes symlinked history outside the production home", async t => {
  const f = await fixture(t);
  const entry = await f.conversation();
  await f.index([entry]);
  const results = await Promise.all([syncProductionConversations(f.runtime, f.source, f.destination), syncProductionConversations(f.runtime, f.source, f.destination)]);
  assert.deepEqual(results.map(result => result.imported).sort(), [0, 1]);
  assert.equal(f.runtime.listConversations().filter(chat => chat.id === entry.id).length, 1);
  const outside = await f.conversation();
  const escaped = join(f.root, "outside.jsonl");
  await writeFile(escaped, await readFile(outside.sessionFile));
  await rm(outside.sessionFile);
  await symlink(escaped, outside.sessionFile);
  await f.index([outside]);
  assert.deepEqual(await syncProductionConversations(f.runtime, f.source, f.destination), { imported: 0, existing: 0, unavailable: 1 });
  assert.ok((await lstat(outside.sessionFile)).isSymbolicLink());
});
