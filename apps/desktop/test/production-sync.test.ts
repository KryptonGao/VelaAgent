import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { AgentRuntime } from "../../../packages/agent/src/runtime.ts";
import { createPersistedSession } from "../../../packages/agent/src/session-persistence.ts";
import {
  listProductionSyncBatches,
  previewProductionSync,
  rollbackProductionSync,
  runProductionSync,
} from "../src/main/production-sync.ts";

const exists = (path: string) => lstat(path).then(() => true, () => false);
const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const put = async (path: string, value: unknown) => {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, typeof value === "string" ? value : JSON.stringify(value));
};

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "vela-sync-scope-"));
  const source = join(root, "production"), destination = join(root, "development");
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await mkdir(source);
  const runtime = new AgentRuntime({ cwd: workspace, agentDir: destination });
  t.after(async () => { await runtime.dispose(); await rm(root, { recursive: true, force: true }); });
  await runtime.createConversation(workspace);
  async function conversation() {
    const manager = createPersistedSession(workspace, join(source, "sessions"));
    manager.appendMessage({ role: "user", content: "Production history", timestamp: 1000 });
    const entry = {
      id: manager.getSessionId(), cwd: workspace, hasWorkspace: true, title: "Production chat",
      createdAt: 1000, updatedAt: 2000, messageCount: 1, toolCallCount: 0,
      sessionFile: manager.getSessionFile()!, instructions: "", mode: "agent",
      plans: [], executionPlans: [], latestProposedPlanId: null, activeExecutionPlanId: null,
      goal: null, archivedAt: null,
    };
    await put(join(source, "conversations.json"), { version: 2, conversations: [entry] });
    return entry;
  }
  async function populate() {
    await put(join(source, "vela-settings.json"), { sandboxMode: "full" });
    await put(join(source, "selection.json"), {
      thinkingLevel: "max", newConversationSelection: "lastUsed", instructions: "Be brief",
      provider: "deepseek", modelId: "deepseek-chat", lastUsed: { provider: "deepseek", modelId: "deepseek-chat", thinkingLevel: "max" },
    });
    await put(join(source, "auth.json"), { deepseek: { type: "api_key", key: "sk-secret-value" }, "openai-codex": { type: "oauth", access: "token", refresh: "refresh" } });
    await put(join(source, "models.json"), { providers: {
      custom: { baseUrl: "https://example.test/v1", api: "openai-completions", apiKey: "sk-literal-secret", headers: { "x-token": "abc", "Content-Type": "application/json" }, models: [{ id: "m1", name: "M1" }] },
      envbased: { baseUrl: "https://env.test", apiKey: "!security find-generic-password -s env" },
    } });
    await put(join(source, "skills", "alpha", "SKILL.md"), "# alpha");
    await put(join(source, "skills", "alpha", "refs", "note.md"), "note");
    await put(join(source, "skills", "beta", "SKILL.md"), "# beta");
    await put(join(source, "skill-preferences.json"), { disabled: ["alpha", "unrelated"] });
    await put(join(source, "mcp.json"), { mcpServers: {
      github: { command: "npx", args: ["-y", "server"], env: { GITHUB_TOKEN: "ghp_literal", NODE_ENV: "production", REF: "${GITHUB_PAT}" } },
      local: { command: "node", args: ["a.js"] },
      remote: { url: "https://mcp.test", headers: { Authorization: "Bearer abc" } },
    } });
    await put(join(source, "MEMORY.md"), "Remember: prefer pnpm.\n");
  }
  return { root, source, destination, workspace, runtime, conversation, populate };
}

const all = ["conversations", "settings", "models", "skills", "mcp", "memory"] as const;
const count = (items: { category: string; imported: number }[], category: string) => items.find(item => item.category === category)?.imported;

it("previews every scope without touching the development profile", async t => {
  const f = await fixture(t);
  await f.populate();
  await f.conversation();
  await put(join(f.destination, "vela-settings.json"), { sandboxMode: "workspace" });
  const before = (await readdir(f.destination)).sort();
  const preview = await previewProductionSync(f.runtime, all, f.source, f.destination);
  assert.deepEqual(preview.categories.map(item => item.category), [...all]);
  assert.equal(preview.categories.find(item => item.error), undefined);
  assert.equal(count(preview.categories, "conversations"), 1);
  assert.equal(count(preview.categories, "settings"), 4);
  assert.equal(count(preview.categories, "models"), 5, "selection keys plus two providers");
  assert.equal(count(preview.categories, "skills"), 2);
  assert.equal(count(preview.categories, "mcp"), 3);
  assert.equal(count(preview.categories, "memory"), 1);
  assert.equal(preview.total, 16);
  // custom provider, github server, remote server, plus deepseek / openai-codex accounts.
  assert.equal(preview.needsCredentials, 5);
  assert.deepEqual((await readdir(f.destination)).sort(), before);
  assert.equal(await exists(join(f.destination, "production-sync")), false);
  assert.deepEqual(await json(join(f.destination, "vela-settings.json")), { sandboxMode: "workspace" });
});

it("imports a batch with sanitized credentials, then rolls the whole batch back", async t => {
  const f = await fixture(t);
  await f.populate();
  const entry = await f.conversation();
  await put(join(f.destination, "vela-settings.json"), { sandboxMode: "workspace" });
  await put(join(f.destination, "skills", "beta", "SKILL.md"), "# dev beta");
  await put(join(f.destination, "mcp.json"), { mcpServers: { local: { command: "dev-node" } } });
  const sourceBefore = await Promise.all(["models.json", "auth.json", "mcp.json", "MEMORY.md"].map(name => readFile(join(f.source, name), "utf8")));

  const result = await runProductionSync(f.runtime, all, f.source, f.destination);
  assert.ok(result.batch);
  assert.equal(result.restartRequired, true);
  assert.equal(count(result.categories, "skills"), 1, "existing development skill is kept");
  assert.equal(count(result.categories, "mcp"), 2);

  // Settings replace differing keys; models.json carries structure only.
  assert.deepEqual(await json(join(f.destination, "vela-settings.json")), { sandboxMode: "full" });
  const selection = await json(join(f.destination, "selection.json"));
  assert.equal(selection.modelId, "deepseek-chat");
  assert.equal(selection.instructions, "Be brief");
  const models = await json(join(f.destination, "models.json"));
  assert.equal(models.providers.custom.baseUrl, "https://example.test/v1");
  assert.equal(models.providers.custom.apiKey, undefined);
  assert.equal(models.providers.custom.headers["x-token"], "");
  assert.equal(models.providers.custom.headers["Content-Type"], "application/json");
  assert.equal(models.providers.envbased.apiKey, "!security find-generic-password -s env");
  assert.deepEqual(Object.keys(await json(join(f.destination, "auth.json"))), [], "credentials are never copied");
  const everything = (await Promise.all([
    readFile(join(f.destination, "models.json"), "utf8"), readFile(join(f.destination, "mcp.json"), "utf8"),
  ])).join("\n");
  for (const secret of ["sk-literal-secret", "ghp_literal", "Bearer abc", "sk-secret-value"]) assert.ok(!everything.includes(secret), secret);

  // Skills, MCP and memory.
  assert.equal(await readFile(join(f.destination, "skills", "alpha", "refs", "note.md"), "utf8"), "note");
  assert.equal(await readFile(join(f.destination, "skills", "beta", "SKILL.md"), "utf8"), "# dev beta");
  assert.deepEqual(await json(join(f.destination, "skill-preferences.json")), { disabled: ["alpha"] });
  const mcp = (await json(join(f.destination, "mcp.json"))).mcpServers;
  assert.equal(mcp.local.command, "dev-node", "existing server is not overwritten");
  assert.equal(mcp.github.enabled, false);
  assert.equal(mcp.github.env.GITHUB_TOKEN, "");
  assert.equal(mcp.github.env.NODE_ENV, "", "literal environment values are always cleared");
  assert.equal(mcp.github.env.REF, "${GITHUB_PAT}");
  assert.equal(mcp.remote.headers.Authorization, "");
  assert.equal(await readFile(join(f.destination, "MEMORY.md"), "utf8"), "Remember: prefer pnpm.\n");

  // Conversations live under the batch directory, and the batch is listed.
  assert.ok(f.runtime.listConversations().some(chat => chat.id === entry.id));
  assert.ok(await exists(join(f.destination, "sessions", "production-sync", result.batch)));
  const batches = await listProductionSyncBatches(f.destination);
  assert.equal(batches.length, 1);
  assert.equal(batches[0]!.id, result.batch);
  assert.equal(batches[0]!.total, result.total);

  // A key changed after the sync is kept; everything else reverts.
  const current = await json(join(f.destination, "selection.json"));
  await put(join(f.destination, "selection.json"), { ...current, instructions: "Changed in development" });
  const rollback = await rollbackProductionSync(f.runtime, result.batch, f.destination);
  assert.equal(rollback.kept, 1);
  assert.equal(rollback.restartRequired, true);
  assert.equal(f.runtime.listConversations().some(chat => chat.id === entry.id), false);
  assert.equal(await exists(join(f.destination, "sessions", "production-sync", result.batch)), false);
  assert.equal((await json(join(f.destination, "conversations.json"))).conversations.some((chat: { id: string }) => chat.id === entry.id), false);
  assert.deepEqual(await json(join(f.destination, "vela-settings.json")), { sandboxMode: "workspace" });
  const restored = await json(join(f.destination, "selection.json"));
  assert.equal(restored.instructions, "Changed in development");
  assert.equal(restored.modelId, undefined);
  assert.equal((await json(join(f.destination, "models.json"))).providers.custom, undefined);
  assert.equal(await exists(join(f.destination, "skills", "alpha")), false);
  assert.equal(await readFile(join(f.destination, "skills", "beta", "SKILL.md"), "utf8"), "# dev beta");
  assert.equal((await json(join(f.destination, "skill-preferences.json"))).disabled, undefined);
  assert.deepEqual(Object.keys((await json(join(f.destination, "mcp.json"))).mcpServers), ["local"]);
  assert.equal(await exists(join(f.destination, "MEMORY.md")), false);
  assert.deepEqual(await listProductionSyncBatches(f.destination), []);
  assert.equal(await exists(join(f.destination, "production-sync", result.batch)), false);
  const after = await Promise.all(["models.json", "auth.json", "mcp.json", "MEMORY.md"].map(name => readFile(join(f.source, name), "utf8")));
  assert.deepEqual(after, sourceBefore, "production data is never modified");
  await assert.rejects(rollbackProductionSync(f.runtime, result.batch, f.destination), /不存在/);
});

it("is idempotent and reports nothing to do on a second run", async t => {
  const f = await fixture(t);
  await f.populate();
  await f.conversation();
  const first = await runProductionSync(f.runtime, all, f.source, f.destination);
  assert.ok(first.total > 0);
  const second = await runProductionSync(f.runtime, all, f.source, f.destination);
  assert.equal(second.total, 0);
  assert.equal(second.batch, null);
  assert.deepEqual(await readdir(join(f.destination, "production-sync")), [first.batch]);
});

it("undoes already-applied scopes when a later scope fails", async t => {
  const f = await fixture(t);
  await f.populate();
  await f.conversation();
  await put(join(f.destination, "vela-settings.json"), { sandboxMode: "workspace" });
  await f.runtime.importConversations(async () => []);
  await writeFile(join(f.destination, "conversations.json"), "destination corruption");
  await assert.rejects(runProductionSync(f.runtime, ["settings", "skills", "memory", "conversations"], f.source, f.destination), SyntaxError);
  assert.deepEqual(await json(join(f.destination, "vela-settings.json")), { sandboxMode: "workspace" });
  assert.equal(await exists(join(f.destination, "skills", "alpha")), false);
  assert.equal(await exists(join(f.destination, "MEMORY.md")), false);
  assert.deepEqual(await listProductionSyncBatches(f.destination), []);
});

it("refuses to roll back while an imported conversation is active", async t => {
  const f = await fixture(t);
  await f.populate();
  const entry = await f.conversation();
  const result = await runProductionSync(f.runtime, ["conversations", "memory"], f.source, f.destination);
  await f.runtime.switchConversation(entry.id);
  await assert.rejects(rollbackProductionSync(f.runtime, result.batch!, f.destination), /切换到其他会话/);
  assert.ok(f.runtime.listConversations().some(chat => chat.id === entry.id));
  assert.equal(await exists(join(f.destination, "MEMORY.md")), true, "nothing changes when the first undo step is refused");
  const other = (await f.runtime.createConversation(f.workspace)).id;
  await f.runtime.switchConversation(other);
  const rolledBack = await rollbackProductionSync(f.runtime, result.batch!, f.destination);
  assert.equal(rolledBack.reverted, 2);
  assert.equal(await exists(join(f.destination, "MEMORY.md")), false);
});

it("keeps development items, skips unsafe skills and reports unreadable sources per scope", async t => {
  const f = await fixture(t);
  await put(join(f.source, "skills", "ok", "SKILL.md"), "ok");
  await mkdir(join(f.source, "skills", "linked"));
  await symlink(join(f.root, "workspace"), join(f.source, "skills", "linked", "escape"));
  await symlink(join(f.root, "workspace"), join(f.source, "skills", "alias"));
  await put(join(f.source, "mcp.json"), "not json");
  await put(join(f.source, "MEMORY.md"), "source memory");
  await put(join(f.destination, "MEMORY.md"), "development memory");
  const preview = await previewProductionSync(f.runtime, ["skills", "mcp", "memory", "models"], f.source, f.destination);
  assert.deepEqual(preview.categories.map(item => [item.category, item.imported, item.existing, item.unavailable]), [
    ["models", 0, 0, 0], ["skills", 1, 0, 2], ["mcp", 0, 0, 1], ["memory", 0, 1, 0],
  ]);
  const result = await runProductionSync(f.runtime, ["skills", "memory"], f.source, f.destination);
  assert.equal(result.total, 1);
  assert.equal(await readFile(join(f.destination, "MEMORY.md"), "utf8"), "development memory");
  assert.equal(await exists(join(f.destination, "skills", "linked")), false);
});

it("reports a scope error in the preview and refuses to sync it", async t => {
  const f = await fixture(t);
  await put(join(f.source, "MEMORY.md"), "memory");
  const preview = await previewProductionSync(f.runtime, ["conversations", "memory"], f.source, f.destination);
  assert.match(preview.categories.find(item => item.category === "conversations")!.error!, /没有找到正式版会话/);
  assert.equal(count(preview.categories, "memory"), 1);
  await assert.rejects(runProductionSync(f.runtime, ["conversations", "memory"], f.source, f.destination), /没有找到正式版会话/);
  assert.equal(await exists(join(f.destination, "MEMORY.md")), false);
});

it("validates the selection and the profile pairing", async t => {
  const f = await fixture(t);
  await assert.rejects(previewProductionSync(f.runtime, [], f.source, f.destination), /至少选择/);
  await assert.rejects(previewProductionSync(f.runtime, ["settings", "everything"], f.source, f.destination), /同步范围不正确/);
  await assert.rejects(previewProductionSync(f.runtime, "settings" as never, f.source, f.destination), /同步范围不正确/);
  await assert.rejects(previewProductionSync(f.runtime, ["settings"], join(f.root, "absent"), f.destination), /没有找到正式版资料目录/);
  await assert.rejects(previewProductionSync(f.runtime, ["settings"], f.destination, f.destination), /无需同步/);
  await assert.rejects(rollbackProductionSync(f.runtime, "../escape", f.destination), /不存在/);
});
