import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import fs, { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMcpConfig, validateMcpServerConfig } from "@earendil-works/pi-coding-agent";
import { MCP_REDACTED, McpConfigService, configuredSecrets, hashMcpTool, redactMcpText } from "../src/mcp-config.ts";
import {
  isMcpApprovalHash, isMcpApprovalReply, isMcpApprovalRequest, matchesMcpApproval,
  type McpToolDefinition,
} from "../../shared/src/mcp.ts";

const tool: McpToolDefinition = {
  name: "lookup", description: "Look up a synthetic document.",
  inputSchema: { type: "object", properties: { query: { type: "string" } } },
  annotations: { readOnlyHint: true },
};

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "vela-mcp-config-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  mkdirSync(agentDir);
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const service = new McpConfigService({ agentDir });
  const globalFile = join(agentDir, "mcp.json");
  const projectFile = join(cwd, ".pi", "mcp.json");
  const policyFile = join(agentDir, "mcp-policy.json");
  const put = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
  const get = (file: string) => JSON.parse(readFileSync(file, "utf8"));
  return { root, agentDir, cwd, service, globalFile, projectFile, policyFile, put, get };
}

async function grant(f: ReturnType<typeof fixture>, server: string, raw = tool) {
  const entry = f.service.listSync(f.cwd).servers.find(item => item.effective && item.name === server)!;
  const input = { cwd: f.cwd, server, tool: raw.name, configDigest: entry.configDigest!, toolDigest: hashMcpTool(raw), readOnly: true };
  await f.service.setReadOnly(input, raw);
  return input;
}

describe("McpConfigService: isolated configuration and policy", () => {
  it("initializes empty directories and keeps sync guard reads synchronous", async t => {
    const f = fixture(t);
    const catalog = await f.service.init(f.cwd);
    assert.equal(catalog.cwd, realpathSync(f.cwd));
    assert.equal(catalog.conversationId, null);
    assert.equal(catalog.projectTrust.trusted, false);
    assert.deepEqual(catalog.servers, []);
    assert.deepEqual(catalog.errors, []);
    assert.deepEqual(f.service.loadConfigSync(f.cwd), { servers: [], autoEnableCodemode: false, errors: [] });
    assert.equal(f.service.isReadOnlySync(f.cwd, "missing", tool), false);
    assert.equal(f.service.checkChanges(f.cwd).changed, false);
    assert.equal(f.service.listSync(f.cwd, "conversation").conversationId, "conversation");
    assert.deepEqual(readdirSync(f.agentDir), []);
  });

  it("reads the two standard mcpServers files and normalizes every codemode exposure", async t => {
    const f = fixture(t);
    f.put(f.globalFile, { autoEnableCodemode: true, mcpServers: {
      default: { command: "node" },
      legacy: { command: "node", exposure: "codemode-deferred", toolExposure: { lookup: "codemode", "get_*": "direct", get_token: "direct", other: "hidden" } },
      disabled: { url: "https://synthetic.example/mcp", enabled: false },
    } });
    const loaded = await f.service.loadConfig(f.cwd);
    assert.equal(loaded.autoEnableCodemode, false);
    assert.ok(!JSON.stringify(loaded).includes('"codemode"'));
    assert.equal(loaded.servers[0].config.exposure, "deferred");
    assert.deepEqual(loaded.servers[1].config.toolExposure, { lookup: "deferred", "get_*": "direct", get_token: "direct", other: "hidden" });
    assert.deepEqual(f.service.listSync(f.cwd).servers[1].config.toolExposure, loaded.servers[1].config.toolExposure);
    assert.equal(f.service.listSync(f.cwd).servers.find(item => item.name === "disabled")?.status, "disabled");
    assert.equal(f.get(f.globalFile).autoEnableCodemode, true);
  });

  it("delegates validation and loading to the patched Pi helpers with canonical cwd", async t => {
    const f = fixture(t);
    const calls: unknown[] = [];
    const service = new McpConfigService({ agentDir: f.agentDir, helpers: {
      validateMcpServerConfig(name, raw) { calls.push(name); return validateMcpServerConfig(name, raw); },
      loadMcpConfig(options) { calls.push(options); return loadMcpConfig(options); },
    } });
    await service.save({ cwd: f.cwd, scope: "global", name: "one", config: { command: "node" } });
    assert.ok(calls.includes("one"));
    assert.ok(calls.some(value => typeof value === "object" && value !== null && "cwd" in value && value.cwd === realpathSync(f.cwd) && "projectTrusted" in value && value.projectTrusted === false));
  });

  it("uses global entries until project trust, then project overrides the same name", async t => {
    const f = fixture(t);
    f.put(f.globalFile, { mcpServers: { one: { command: "global-bin" }, two: { command: "second-bin" } } });
    f.put(f.projectFile, { mcpServers: { one: { command: "project-bin", enabled: false }, local: { command: "local-bin" } } });
    assert.deepEqual(f.service.loadConfigSync(f.cwd).servers.map(item => item.name), ["one", "two"]);
    const before = f.service.listSync(f.cwd);
    assert.equal(before.servers.find(item => item.scope === "project")?.status, "untrusted");
    const after = await f.service.setTrust({ cwd: f.cwd, trusted: true, digest: before.projectTrust.digest });
    assert.equal(after.projectTrust.trusted, true);
    assert.equal(after.servers.find(item => item.name === "one" && item.scope === "global")?.status, "shadowed");
    assert.equal(after.servers.find(item => item.name === "one" && item.scope === "project")?.status, "disabled");
    assert.equal(f.service.loadConfigSync(f.cwd).servers.find(item => item.name === "one")?.config.enabled, false);
    assert.equal(f.get(f.policyFile).trustedProjects[realpathSync(f.cwd)], before.projectTrust.digest);
    const restarted = new McpConfigService({ agentDir: f.agentDir });
    assert.equal(restarted.listSync(f.cwd).projectTrust.trusted, true);
    await restarted.remove({ cwd: f.cwd, scope: "project", name: "one" });
    assert.equal(restarted.listSync(f.cwd).projectTrust.trusted, false);
    const restored = restarted.loadConfigSync(f.cwd).servers.find(item => item.name === "one")!.config;
    assert.ok("command" in restored);
    assert.equal(restored.command, "global-bin");
  });

  it("binds trust to canonical cwd and exact project bytes, including whitespace edits", async t => {
    const f = fixture(t);
    f.put(f.projectFile, { mcpServers: { one: { command: "node" } } });
    const alias = join(f.root, "project-alias");
    symlinkSync(f.cwd, alias, "dir");
    const before = f.service.listSync(alias);
    await f.service.setTrust({ cwd: alias, trusted: true, digest: before.projectTrust.digest });
    assert.equal(f.service.listSync(f.cwd).projectTrust.trusted, true);
    await assert.rejects(f.service.setTrust({ cwd: f.cwd, trusted: true }), /review/);
    writeFileSync(f.projectFile, readFileSync(f.projectFile, "utf8") + " ");
    assert.equal(f.service.listSync(alias).projectTrust.trusted, false);
    await assert.rejects(f.service.setTrust({ cwd: f.cwd, trusted: true, digest: before.projectTrust.digest }), /changed/);
    const other = join(f.root, "other");
    mkdirSync(join(other, ".pi"), { recursive: true });
    writeFileSync(join(other, ".pi", "mcp.json"), readFileSync(f.projectFile));
    assert.equal(f.service.listSync(other).projectTrust.trusted, false);
    unlinkSync(f.projectFile);
    assert.equal(f.service.listSync(f.cwd).projectTrust.trusted, false);
  });

  it("preserves unrelated latest JSON, indentation, and file privacy through CRUD", async t => {
    const f = fixture(t);
    writeFileSync(f.globalFile, JSON.stringify({ custom: { keep: [1, 2] }, autoEnableCodemode: true, mcpServers: { untouched: { command: "keep", vendor: { yes: true } } } }, null, "\t") + "\n");
    await f.service.init(f.cwd);
    const latest = f.get(f.globalFile);
    latest.external = "new content";
    f.put(f.globalFile, latest);
    const saved = await f.service.save({ cwd: f.cwd, conversationId: "conversation", scope: "global", name: "added", config: { command: "node", vendor: { nested: 42 } } });
    assert.equal(saved.conversationId, "conversation");
    assert.deepEqual(f.get(f.globalFile).custom, { keep: [1, 2] });
    assert.equal(f.get(f.globalFile).external, "new content");
    assert.deepEqual(f.get(f.globalFile).mcpServers.untouched, latest.mcpServers.untouched);
    assert.equal(statSync(f.globalFile).mode & 0o777, 0o600);
    await f.service.setEnabled({ cwd: f.cwd, scope: "global", name: "added", enabled: false });
    assert.equal(f.get(f.globalFile).mcpServers.added.enabled, false);
    assert.deepEqual(f.get(f.globalFile).mcpServers.added.vendor, { nested: 42 });
    await f.service.remove({ cwd: f.cwd, scope: "global", name: "added" });
    assert.equal(f.get(f.globalFile).mcpServers.added, undefined);
    assert.equal(f.get(f.globalFile).autoEnableCodemode, true);
    const text = readFileSync(f.globalFile, "utf8");
    await f.service.remove({ cwd: f.cwd, scope: "global", name: "absent" });
    assert.equal(readFileSync(f.globalFile, "utf8"), text);
    assert.deepEqual(readdirSync(f.agentDir), ["mcp.json"]);
    writeFileSync(f.globalFile, text.replace(/^ +/gm, "\t"));
    await f.service.setEnabled({ cwd: f.cwd, scope: "global", name: "untouched", enabled: false });
    assert.match(readFileSync(f.globalFile, "utf8"), /\n\t"custom"/);
  });

  it("records its own writes so the runtime poll does not reapply them as external changes", async t => {
    const f = fixture(t);
    f.put(f.globalFile, { mcpServers: { one: { command: "node" } } });
    f.put(f.projectFile, { mcpServers: { local: { command: "node" } } });
    await f.service.init(f.cwd);
    const before = f.service.listSync(f.cwd);
    await f.service.setTrust({ cwd: f.cwd, trusted: true, digest: before.projectTrust.digest });
    assert.equal(f.service.checkChanges(f.cwd).changed, false, "trust write must not look external");
    await f.service.save({ cwd: f.cwd, scope: "global", name: "two", config: { command: "node" } });
    assert.equal(f.service.checkChanges(f.cwd).changed, false, "save write must not look external");
    await f.service.setEnabled({ cwd: f.cwd, scope: "global", name: "two", enabled: false });
    assert.equal(f.service.checkChanges(f.cwd).changed, false, "enable write must not look external");
    const approval = await grant(f, "one");
    assert.equal(f.service.checkChanges(f.cwd).changed, false, "read-only grant must not look external");
    await f.service.setReadOnly({ ...approval, readOnly: false }, tool);
    assert.equal(f.service.checkChanges(f.cwd).changed, false, "read-only revocation must not look external");
    await f.service.remove({ cwd: f.cwd, scope: "project", name: "local" });
    assert.equal(f.service.checkChanges(f.cwd).changed, false, "removal must not look external");
    // A genuine outside edit is still detected exactly once after an owned write.
    writeFileSync(f.globalFile, readFileSync(f.globalFile, "utf8").replace("node", "other-node"));
    assert.equal(f.service.checkChanges(f.cwd).changed, true);
    assert.equal(f.service.checkChanges(f.cwd).changed, false);
  });

  it("rejects Pi-invalid configs, namespace clashes, and project provider credentials without writes", async t => {
    const f = fixture(t);
    for (const config of [
      { command: "node", args: [1] }, { url: "file:///tmp/example" }, { type: "sse", url: "https://synthetic.example" },
      { command: "node", timeout: 0 }, { command: "node", enabled: "false" },
      { url: "https://synthetic.example", oauth: { callbackUrl: "https://remote.example/callback" } },
      { url: "http://remote.example", auth: { provider: "synthetic" } },
    ]) await assert.rejects(f.service.save({ cwd: f.cwd, scope: "global", name: "bad", config }), /Pi validation/);
    await assert.rejects(f.service.save({ cwd: f.cwd, scope: "global", name: "bad name", config: { command: "node" } }), /target/);
    await assert.rejects(f.service.save({ cwd: f.cwd, scope: "project", name: "auth", config: { url: "https://synthetic.example", auth: { provider: "synthetic" } } }), /Pi validation/);
    assert.deepEqual(readdirSync(f.agentDir), []);
    await f.service.save({ cwd: f.cwd, scope: "global", name: "a-b", config: { command: "node" } });
    await assert.rejects(f.service.save({ cwd: f.cwd, scope: "global", name: "a_b", config: { command: "node" } }), /namespace/);
    await assert.rejects(f.service.save({ cwd: f.cwd, scope: "project", name: "a_b", config: { command: "node" } }), /namespace/);
    await assert.rejects(f.service.setEnabled({ cwd: f.cwd, scope: "global", name: "missing", enabled: true }), /exist/);
  });

  it("shows reviewable commands/endpoints while redacting synthetic credentials and repeated copies", async t => {
    const f = fixture(t);
    const secrets = ["synthetic-env-secret", "synthetic-header-secret", "synthetic-client-secret", "synthetic-argv-secret", "synthetic-url-secret", "synthetic-user", "synthetic-pass"];
    f.put(f.projectFile, { mcpServers: {
      stdio: { command: "node", cwd: "./tools", args: ["server.js", "--token", secrets[3], "--public", "ok"], env: { TOKEN: secrets[0] }, description: `Tool: ${secrets[0]}` },
      remote: { url: `https://${secrets[5]}:${secrets[6]}@synthetic.example/mcp?token=${secrets[4]}&page=2`, headers: { Authorization: secrets[1] }, oauth: { clientId: "public-client", clientSecret: secrets[2] } },
    } });
    const catalog = f.service.listSync(f.cwd);
    const serialized = JSON.stringify(catalog);
    for (const secret of secrets) assert.ok(!serialized.includes(secret), secret);
    const stdio = catalog.servers.find(item => item.name === "stdio")!;
    assert.equal(stdio.config.command, "node");
    assert.equal(stdio.config.cwd, "./tools");
    assert.deepEqual(stdio.config.args, ["server.js", "--token", MCP_REDACTED, "--public", "ok"]);
    assert.ok(stdio.secretFields.includes("/env/TOKEN"));
    assert.ok(stdio.secretFields.includes("/args/2"));
    assert.equal(catalog.projectTrust.review[0].config.command, "node");
    const remote = catalog.servers.find(item => item.name === "remote")!;
    assert.ok(String(remote.config.url).includes("synthetic.example/mcp"));
    assert.ok(String(remote.config.url).includes("page=2"));
    assert.deepEqual(remote.config.oauth, { clientId: "public-client", clientSecret: MCP_REDACTED });
    const scrubbed = f.service.redactForDisplay(f.cwd, { message: secrets.join(" "), password: "unconfigured-password", Authorization: "unconfigured-header" });
    for (const secret of [...secrets, "unconfigured-password", "unconfigured-header"]) assert.ok(!JSON.stringify(scrubbed).includes(secret));
    await f.service.setTrust({ cwd: f.cwd, trusted: true, digest: catalog.projectTrust.digest });
    const rawStdio = f.service.loadConfigSync(f.cwd).servers.find(item => item.name === "stdio")!.config;
    assert.ok("command" in rawStdio);
    assert.equal(rawStdio.env?.TOKEN, secrets[0]);
  });

  it("restores masked fields during edits and supports explicit replacement/removal", async t => {
    const f = fixture(t);
    f.put(f.globalFile, { mcpServers: { one: {
      url: "https://synthetic.example/mcp?token=synthetic-url-secret", headers: { Authorization: "synthetic-header-secret" },
      oauth: { clientSecret: "synthetic-client-secret" }, description: "Original description",
    } } });
    const display = f.service.listSync(f.cwd).servers[0].config;
    await f.service.save({ cwd: f.cwd, scope: "global", name: "one", config: { ...display, url: String(display.url).replace("synthetic.example", "new.example"), description: "Edited description" } });
    const saved = f.get(f.globalFile).mcpServers.one;
    assert.equal(saved.url, "https://new.example/mcp?token=synthetic-url-secret");
    assert.equal(saved.headers.Authorization, "synthetic-header-secret");
    assert.equal(saved.oauth.clientSecret, "synthetic-client-secret");
    assert.equal(saved.description, "Edited description");
    await f.service.save({ cwd: f.cwd, scope: "global", name: "one", config: { url: saved.url, headers: {} } });
    assert.deepEqual(f.get(f.globalFile).mcpServers.one.headers, {});
    assert.equal(f.get(f.globalFile).mcpServers.one.oauth, undefined);
    await assert.rejects(f.service.save({ cwd: f.cwd, scope: "global", name: "new", config: { command: MCP_REDACTED } }), /masked/);
    assert.ok(!readFileSync(f.globalFile, "utf8").includes(MCP_REDACTED));
  });

  it("never includes parser or helper error text that can quote secret-bearing input", async t => {
    const f = fixture(t);
    const secret = "synthetic-parser-secret";
    writeFileSync(f.globalFile, `{"mcpServers":{"one":{"env":{"TOKEN":"${secret}"}}} BROKEN`);
    const text = readFileSync(f.globalFile, "utf8");
    assert.ok(!JSON.stringify(f.service.listSync(f.cwd)).includes(secret));
    await assert.rejects(f.service.save({ cwd: f.cwd, scope: "global", name: "one", config: { command: "node" } }), error => error instanceof Error && !error.message.includes(secret));
    assert.equal(readFileSync(f.globalFile, "utf8"), text);
    const service = new McpConfigService({ agentDir: f.agentDir, helpers: {
      validateMcpServerConfig() { throw new Error(secret); }, loadMcpConfig() { throw new Error(secret); },
    } });
    assert.ok(!JSON.stringify(service.listSync(f.cwd)).includes(secret));
    f.put(f.globalFile, { mcpServers: { one: { command: "node", toolExposure: { [secret]: "invalid" } } } });
    assert.ok(!JSON.stringify(f.service.loadConfigSync(f.cwd)).includes(secret));
  });

  it("binds read-only grants to current server config, raw tool metadata, workspace and tool identity", async t => {
    const f = fixture(t);
    f.put(f.globalFile, { mcpServers: { one: { command: "node", env: { TOKEN: "synthetic-first-secret" } } } });
    assert.equal(await f.service.isReadOnly(f.cwd, "one", tool), false);
    const approval = await grant(f, "one");
    assert.equal(f.service.isReadOnlySync(f.cwd, "one", tool), true);
    const restarted = new McpConfigService({ agentDir: f.agentDir });
    assert.equal(restarted.isReadOnlySync(f.cwd, "one", tool), true);
    assert.equal(f.service.isReadOnlySync(f.cwd, "one", { ...tool, description: "Changed description" }), false);
    assert.equal(f.service.isReadOnlySync(f.cwd, "one", { ...tool, inputSchema: { type: "string" } }), false);
    assert.equal(f.service.isReadOnlySync(f.cwd, "one", { ...tool, annotations: { readOnlyHint: false } }), false);
    assert.equal(f.service.isReadOnlySync(f.cwd, "two", tool), false);
    const other = join(f.root, "another");
    mkdirSync(other);
    assert.equal(f.service.isReadOnlySync(other, "one", tool), false);
    const changed = f.get(f.globalFile);
    changed.mcpServers.one.env.TOKEN = "synthetic-second-secret";
    f.put(f.globalFile, changed);
    assert.equal(f.service.isReadOnlySync(f.cwd, "one", tool), false);
    await assert.rejects(f.service.setReadOnly(approval, tool), /changed/);
    await f.service.setReadOnly({ ...approval, readOnly: false }, tool);
    assert.deepEqual(f.get(f.policyFile).readOnly, []);
    assert.ok(!readFileSync(f.policyFile, "utf8").includes("synthetic-first-secret"));
  });

  it("rejects read-only approvals with invalid or stale hashes and ignores server annotations as authority", async t => {
    const f = fixture(t);
    f.put(f.globalFile, { mcpServers: { one: { command: "node" } } });
    const digest = f.service.listSync(f.cwd).servers[0].configDigest!;
    const input = { cwd: f.cwd, server: "one", tool: tool.name, configDigest: digest, toolDigest: hashMcpTool(tool), readOnly: true };
    assert.equal(f.service.isReadOnlySync(f.cwd, "one", tool), false);
    await assert.rejects(f.service.setReadOnly({ ...input, configDigest: "anything" }, tool), /Invalid/);
    await assert.rejects(f.service.setReadOnly({ ...input, toolDigest: "a".repeat(64) }, tool), /changed/);
    await assert.rejects(f.service.setReadOnly({ ...input, tool: "other" }, tool), /changed/);
    assert.deepEqual(readdirSync(f.agentDir), ["mcp.json"]);
    await grant(f, "one");
    await f.service.setEnabled({ cwd: f.cwd, scope: "global", name: "one", enabled: false });
    assert.equal(f.service.isReadOnlySync(f.cwd, "one", tool), false);
  });

  it("revokes project grants on trust revocation and preserves unrelated policy content", async t => {
    const f = fixture(t);
    f.put(f.policyFile, { custom: { keep: true }, trustedProjects: { "/synthetic-unrelated": "a".repeat(64) }, readOnly: [{ vendor: "keep" }] });
    f.put(f.projectFile, { mcpServers: { one: { command: "node" } } });
    const digest = f.service.listSync(f.cwd).projectTrust.digest;
    await f.service.setTrust({ cwd: f.cwd, trusted: true, digest });
    await grant(f, "one");
    await f.service.setTrust({ cwd: f.cwd, trusted: false });
    assert.equal(f.service.isReadOnlySync(f.cwd, "one", tool), false);
    await f.service.setTrust({ cwd: f.cwd, trusted: true, digest });
    assert.equal(f.service.isReadOnlySync(f.cwd, "one", tool), false);
    assert.deepEqual(f.get(f.policyFile).custom, { keep: true });
    assert.equal(f.get(f.policyFile).trustedProjects["/synthetic-unrelated"], "a".repeat(64));
    assert.deepEqual(f.get(f.policyFile).readOnly, [{ vendor: "keep" }]);
    assert.equal(statSync(f.policyFile).mode & 0o777, 0o600);
  });

  it("fails closed on a corrupt policy and never overwrites its contents", async t => {
    const f = fixture(t);
    f.put(f.globalFile, { mcpServers: { one: { command: "node" } } });
    const input = await grant(f, "one");
    const text = '{"readOnly":"synthetic-policy-secret"';
    writeFileSync(f.policyFile, text);
    assert.equal(f.service.isReadOnlySync(f.cwd, "one", tool), false);
    assert.ok(!JSON.stringify(f.service.listSync(f.cwd)).includes("synthetic-policy-secret"));
    await assert.rejects(f.service.setReadOnly(input, tool), /policy/);
    await assert.rejects(f.service.setTrust({ cwd: f.cwd, trusted: false }), /policy/);
    assert.equal(readFileSync(f.policyFile, "utf8"), text);
  });

  it("hashes effective wildcard order and raw description/schema rather than their displays", async t => {
    const f = fixture(t);
    f.put(f.globalFile, { mcpServers: { one: { command: "node", toolExposure: { "get_*": "direct", "*": "hidden" } } } });
    const initial = f.service.listSync(f.cwd).servers[0].configDigest;
    const changed = f.get(f.globalFile);
    changed.mcpServers.one.toolExposure = { "*": "hidden", "get_*": "direct" };
    f.put(f.globalFile, changed);
    assert.notEqual(f.service.listSync(f.cwd).servers[0].configDigest, initial);
    const raw = { ...tool, description: "synthetic-tool-secret" };
    assert.notEqual(hashMcpTool(raw), hashMcpTool({ ...raw, description: MCP_REDACTED }));
    assert.equal(hashMcpTool(tool), hashMcpTool({ ...tool, inputSchema: { properties: { query: { type: "string" } }, type: "object" } }));
  });

  it("detects external config/policy creation, edits, deletions and identical-mtime edits", async t => {
    const f = fixture(t);
    await f.service.init(f.cwd);
    f.put(f.globalFile, { mcpServers: { one: { command: "node" } } });
    let changes = f.service.checkChanges(f.cwd);
    assert.equal(changes.changed, true);
    assert.equal(changes.configChanged, true);
    assert.equal(changes.policyChanged, false);
    assert.equal(f.service.checkChanges(f.cwd).changed, false);
    const before = statSync(f.globalFile);
    f.put(f.globalFile, { mcpServers: { one: { command: "deno" } } });
    utimesSync(f.globalFile, before.atime, before.mtime);
    assert.equal(f.service.checkChanges(f.cwd).configChanged, true);
    f.put(f.policyFile, { trustedProjects: {} });
    changes = f.service.checkChanges(f.cwd);
    assert.equal(changes.policyChanged, true);
    assert.equal(changes.configChanged, false);
    f.put(f.projectFile, { mcpServers: {} });
    assert.equal(f.service.checkChanges(f.cwd).configChanged, true);
    unlinkSync(f.projectFile);
    assert.equal(f.service.checkChanges(f.cwd).configChanged, true);
    unlinkSync(f.policyFile);
    assert.equal(f.service.checkChanges(f.cwd).policyChanged, true);
  });

  it("observes externally revoked trust and read-only grants synchronously without polling", async t => {
    const f = fixture(t);
    f.put(f.projectFile, { mcpServers: { one: { command: "node" } } });
    await f.service.setTrust({ cwd: f.cwd, trusted: true, digest: f.service.listSync(f.cwd).projectTrust.digest });
    await grant(f, "one");
    const granted = f.get(f.policyFile);
    assert.equal(f.service.isReadOnlySync(f.cwd, "one", tool), true);
    f.put(f.policyFile, { ...granted, readOnly: [] });
    assert.equal(f.service.isReadOnlySync(f.cwd, "one", tool), false);
    assert.equal(f.service.listSync(f.cwd).projectTrust.trusted, true);
    f.put(f.policyFile, granted);
    assert.equal(f.service.isReadOnlySync(f.cwd, "one", tool), true);
    f.put(f.policyFile, { ...granted, trustedProjects: {} });
    assert.equal(f.service.isReadOnlySync(f.cwd, "one", tool), false);
    assert.equal(f.service.listSync(f.cwd).projectTrust.trusted, false);
    assert.deepEqual(f.service.loadConfigSync(f.cwd).servers, []);
  });

  it("invalidates grants after external disable/removal or a same-config project override", async t => {
    const f = fixture(t);
    f.put(f.globalFile, { mcpServers: { one: { command: "node" } } });
    await grant(f, "one");
    f.put(f.globalFile, { mcpServers: { one: { command: "node", enabled: false } } });
    assert.equal(f.service.isReadOnlySync(f.cwd, "one", tool), false);
    f.put(f.globalFile, { mcpServers: {} });
    assert.equal(f.service.isReadOnlySync(f.cwd, "one", tool), false);
    f.put(f.globalFile, { mcpServers: { one: { command: "node" } } });
    assert.equal(f.service.isReadOnlySync(f.cwd, "one", tool), true);
    f.put(f.projectFile, { mcpServers: { one: { command: "node" } } });
    await f.service.setTrust({ cwd: f.cwd, trusted: true, digest: f.service.listSync(f.cwd).projectTrust.digest });
    assert.equal(f.service.isReadOnlySync(f.cwd, "one", tool), false);
    await grant(f, "one");
    assert.equal(f.service.isReadOnlySync(f.cwd, "one", tool), true);
  });

  it("does not authorize a project replaced while the Pi loader re-reads it", async t => {
    const f = fixture(t);
    f.put(f.projectFile, { mcpServers: { one: { command: "reviewed-bin" } } });
    await f.service.setTrust({ cwd: f.cwd, trusted: true, digest: f.service.listSync(f.cwd).projectTrust.digest });
    const racing = new McpConfigService({ agentDir: f.agentDir, helpers: {
      validateMcpServerConfig,
      loadMcpConfig(options) {
        f.put(f.projectFile, { mcpServers: { one: { command: "unreviewed-bin" } } });
        return loadMcpConfig(options);
      },
    } });
    assert.deepEqual(racing.loadConfigSync(f.cwd).servers, []);
    assert.equal(racing.listSync(f.cwd).projectTrust.trusted, false);
  });

  it("cleans temporary files and preserves the original if serialization fails", async t => {
    const f = fixture(t);
    f.put(f.globalFile, { mcpServers: { one: { command: "node" } } });
    const before = readFileSync(f.globalFile, "utf8");
    const cyclic: Record<string, unknown> = { command: "node" };
    cyclic.self = cyclic;
    await assert.rejects(f.service.save({ cwd: f.cwd, scope: "global", name: "one", config: cyclic }), /Invalid/);
    assert.equal(readFileSync(f.globalFile, "utf8"), before);
    assert.deepEqual(readdirSync(f.agentDir), ["mcp.json"]);
  });

  it("removes the private temporary file and sanitizes errors when atomic rename fails", async t => {
    const f = fixture(t);
    f.put(f.globalFile, { mcpServers: { one: { command: "node", env: { TOKEN: "synthetic-file-secret" } } } });
    const before = readFileSync(f.globalFile, "utf8");
    const fault = t.mock.method(fs, "renameSync", () => { throw new Error("synthetic-write-error-secret"); });
    syncBuiltinESMExports();
    try {
      await assert.rejects(f.service.save({ cwd: f.cwd, scope: "global", name: "one", config: { command: "deno" } }), error => {
        return error instanceof Error && error.message === "Cannot save MCP document; refresh and retry.";
      });
    } finally {
      fault.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(readFileSync(f.globalFile, "utf8"), before);
    assert.deepEqual(readdirSync(f.agentDir), ["mcp.json"]);
  });

  it("masks nested vendor credentials and bearer token bodies, including display metadata", async t => {
    const f = fixture(t);
    const config = { command: "node", vendor: { credential: { nested: "synthetic-nested-secret" } }, headers: { Authorization: "Bearer synthetic-bearer-secret" } };
    f.put(f.globalFile, { mcpServers: { one: config } });
    const display = f.service.listSync(f.cwd).servers[0].config;
    assert.ok(!JSON.stringify(display).includes("synthetic-nested-secret"));
    assert.ok(!JSON.stringify(display).includes("synthetic-bearer-secret"));
    assert.deepEqual(f.service.redactForDisplay(f.cwd, {
      description: "Token synthetic-bearer-secret and synthetic-nested-secret",
      vendor: { password: { nested: "unconfigured-secret" } },
    }), { description: `Token ${MCP_REDACTED} and ${MCP_REDACTED}`, vendor: { password: MCP_REDACTED } });
    assert.deepEqual(f.service.redactForDisplay(f.cwd, { "synthetic-bearer-secret": "public" }), { [MCP_REDACTED]: MCP_REDACTED });
    await f.service.save({ cwd: f.cwd, scope: "global", name: "one", config: display });
    assert.deepEqual(f.get(f.globalFile).mcpServers.one.vendor, config.vendor);
  });
});

describe("MCP boundary helpers", () => {
  it("validates hash-bearing approval payloads at runtime and matches the pending identity", () => {
    const request = { id: "one", cwd: "/synthetic", serverName: "server", toolName: "tool", configDigest: "a".repeat(64), toolDigest: "b".repeat(64) };
    assert.equal(isMcpApprovalHash(request.configDigest), true);
    for (const value of [null, 123, {}, "", "A".repeat(64), "a".repeat(63), "a".repeat(65)]) assert.equal(isMcpApprovalHash(value), false);
    assert.equal(isMcpApprovalRequest(request), true);
    assert.equal(isMcpApprovalReply(request), false);
    const reply = { ...request, allowed: true };
    assert.equal(isMcpApprovalReply(reply), true);
    assert.equal(matchesMcpApproval(reply, request), true);
    assert.equal(matchesMcpApproval({ ...reply, allowed: false }, request), true);
    for (const field of ["id", "cwd", "serverName", "toolName", "configDigest", "toolDigest"]) {
      assert.equal(matchesMcpApproval({ ...reply, [field]: "changed" }, request), false);
    }
    assert.equal(isMcpApprovalReply({ ...reply, allowed: "yes" }), false);
  });

  it("collects synthetic URL/argv/config credentials without resolving or executing them", () => {
    const config = { command: "node", args: ["--api-key=synthetic-key", "--password", "synthetic-password", "--custom-token", "synthetic-custom-token", "-H", "Authorization: Bearer synthetic-argv-auth"], env: { TOKEN: "${SYNTHETIC_TOKEN}", COMMAND: "!synthetic-command" }, headers: { Authorization: "Bearer synthetic-auth" }, url: "https://user:pass@synthetic.example/mcp?access_token=a%2Fb&public=ok" };
    const values = configuredSecrets(config);
    for (const expected of ["synthetic-key", "synthetic-password", "synthetic-custom-token", "synthetic-argv-auth", "${SYNTHETIC_TOKEN}", "!synthetic-command", "Bearer synthetic-auth", "user", "pass", "a/b", "a%2Fb"]) assert.ok(values.includes(expected), expected);
    assert.equal(redactMcpText("one two", ["one", "one two"]), MCP_REDACTED);
  });
});
