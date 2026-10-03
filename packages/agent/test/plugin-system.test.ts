import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { it, type TestContext } from "node:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { BuiltInPlugin } from "@vela/shared";
import { AgentRuntime } from "../src/runtime";
import { PluginRegistry } from "../src/mcp/plugin-registry";
import { MemoryCredentialStore, PluginCredentialStore } from "../src/mcp/credentials";
import { PluginMCPManager } from "../src/mcp/manager";
import { McpConfigService } from "../src/mcp-config";

function temporary(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "vela-plugins-"));
  const agentDir = join(root, "agent"); const cwd = join(root, "workspace");
  mkdirSync(agentDir); mkdirSync(cwd);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, agentDir, cwd };
}
const plugin = (url = "https://example.com/mcp", id = "fixture"): BuiltInPlugin => ({
  id, name: id, description: "OAuth MCP fixture", icon: "fixture", mcpUrl: url, transport: "streamable-http", authType: "oauth2",
});
async function eventually<T>(read: () => T | Promise<T>, accept: (value: T) => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) { const value = await read(); if (accept(value)) return value; await delay(15); }
  assert.fail("Timed out waiting for plugin state");
}

/** Complete provider fixture: discovery, DCR, PKCE, callback, rotation and Streamable HTTP. */
async function provider(t: TestContext) {
  let origin = "";
  let access = ""; let refresh = "";
  const clients = new Map<string, string[]>();
  const codes = new Map<string, URLSearchParams>();
  const methods: string[] = []; const grants: string[] = []; const authorizations: URL[] = [];
  let discoveries = 0; let registrations = 0; let mutations = 0;
  const server = createServer(async (req, res) => {
    const reply = (value: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    try {
      const url = new URL(req.url!, origin);
      if (url.pathname === "/.well-known/oauth-protected-resource" || url.pathname === "/.well-known/oauth-protected-resource/mcp") {
        discoveries++; return reply({ resource: `${origin}/mcp`, authorization_servers: [origin] });
      }
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        discoveries++; return reply({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], token_endpoint_auth_methods_supported: ["none"], code_challenge_methods_supported: ["S256"] });
      }
      let body = ""; for await (const chunk of req) body += chunk;
      if (url.pathname === "/register") {
        registrations++; const input = JSON.parse(body); const id = randomUUID();
        assert.equal(input.token_endpoint_auth_method, "none");
        assert.ok(input.redirect_uris.every((uri: string) => new URL(uri).hostname === "127.0.0.1" || new URL(uri).hostname === "localhost"));
        clients.set(id, input.redirect_uris); return reply({ ...input, client_id: id }, 201);
      }
      if (url.pathname === "/authorize") {
        assert.equal(url.searchParams.get("response_type"), "code");
        assert.equal(url.searchParams.get("code_challenge_method"), "S256");
        assert.ok(url.searchParams.get("state"));
        assert.ok(clients.get(url.searchParams.get("client_id")!)?.includes(url.searchParams.get("redirect_uri")!));
        authorizations.push(url); const code = randomUUID(); codes.set(code, url.searchParams);
        const redirect = new URL(url.searchParams.get("redirect_uri")!);
        redirect.searchParams.set("code", code); redirect.searchParams.set("state", url.searchParams.get("state")!);
        res.writeHead(302, { location: redirect.href }); return res.end();
      }
      if (url.pathname === "/token") {
        const params = new URLSearchParams(body); const grant = params.get("grant_type")!;
        grants.push(grant);
        if (grant === "authorization_code") {
          const auth = codes.get(params.get("code")!); assert.ok(auth);
          assert.equal(createHash("sha256").update(params.get("code_verifier")!).digest("base64url"), auth.get("code_challenge"));
          assert.equal(params.get("redirect_uri"), auth.get("redirect_uri"));
          codes.delete(params.get("code")!);
        } else {
          assert.equal(grant, "refresh_token");
          if (params.get("refresh_token") !== refresh) return reply({ error: "invalid_grant" }, 400);
          // Make overlapping refreshes observable: only one may consume the rotating token.
          refresh = "consumed"; await delay(35);
        }
        access = `fixture-access-${randomUUID()}`; refresh = `fixture-refresh-${randomUUID()}`;
        return reply({ access_token: access, refresh_token: refresh, token_type: "Bearer", expires_in: 3600 });
      }
      if (url.pathname !== "/mcp") return reply({}, 404);
      if (!access || req.headers.authorization !== `Bearer ${access}`) {
        res.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"` }); return res.end();
      }
      if (req.method === "DELETE") { res.writeHead(204); return res.end(); }
      if (req.method !== "POST") { res.writeHead(405); return res.end(); }
      const rpc = JSON.parse(body); methods.push(rpc.method);
      if (rpc.id === undefined) { res.writeHead(202); return res.end(); }
      const result = (value: unknown) => reply({ jsonrpc: "2.0", id: rpc.id, result: value });
      if (rpc.method === "initialize") return result({ protocolVersion: rpc.params.protocolVersion, serverInfo: { name: "fixture", version: "1" }, capabilities: { tools: {} } });
      if (rpc.method === "tools/list") return result({ tools: [
        { name: "read", description: `Read fixture ${access}`, inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
        { name: "write", description: "Edit fixture", inputSchema: { type: "object", properties: {} } },
      ] });
      if (rpc.method === "tools/call") { if (rpc.params.name === "write") mutations++; return result({ content: [{ type: "text", text: "fixture success" }] }); }
      return reply({ jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "Unknown method" } });
    } catch { reply({ error: "fixture validation failed" }, 400); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  return { origin, methods, grants, authorizations,
    get discoveries() { return discoveries; }, get registrations() { return registrations; }, get mutations() { return mutations; },
    get access() { return access; }, get refresh() { return refresh; },
    rejectAccess() { access = "expired-by-provider"; },
    async authorize(url: string) {
      const response = await fetch(url, { redirect: "manual" }); assert.equal(response.status, 302);
      const callback = await fetch(response.headers.get("location")!); assert.equal(callback.status, 200);
    },
  };
}

it("PluginRegistry registers Notion, persists enablement, merges user servers and reserves namespaces", async t => {
  const f = temporary(t);
  const registry = new PluginRegistry(join(f.agentDir, "integrations.json"));
  assert.equal(registry.get("notion").mcpUrl, "https://mcp.notion.com/mcp");
  assert.equal(registry.entries()[0].config.enabled, false);
  registry.setEnabled("notion", true);
  const again = new PluginRegistry(join(f.agentDir, "integrations.json"));
  assert.equal(again.isEnabled("notion"), true);
  assert.throws(() => registry.register(plugin("https://example.com", "notion")));
  assert.throws(() => registry.register(plugin("https://example.com", "../bad")));
  const user = { name: "custom", source: "user", config: { url: "https://example.com" } };
  assert.deepEqual(registry.merge([user]).map(entry => entry.name), ["custom", "builtin_notion"]);
  const config = new McpConfigService({ agentDir: f.agentDir, plugins: registry });
  writeFileSync(join(f.agentDir, "mcp.json"), JSON.stringify({ mcpServers: { builtin_notion: { url: "https://hostile.example/mcp" } } }));
  assert.equal((config.loadConfigSync(f.cwd).servers[0].config as { url: string }).url, "https://mcp.notion.com/mcp");
  assert.equal(config.listSync(f.cwd).servers.filter(server => server.effective).length, 1);
  await assert.rejects(config.save({ cwd: f.cwd, scope: "global", name: "builtin-notion", config: { url: "https://hostile.example" } }));
});

it("credential rotation locks serialize every session; revoked providers cannot restore tokens", async t => {
  const f = temporary(t); const backend = new MemoryCredentialStore();
  const credentials = new PluginCredentialStore(backend, name => name.startsWith("builtin_"), f.agentDir);
  const first = credentials.forServer("builtin_fixture", "https://example.com/mcp");
  const second = credentials.forServer("builtin_fixture", "https://example.com/mcp");
  let active = 0; let maximum = 0;
  await Promise.all([first, second, first].map(store => store.withRefreshLock(async () => {
    maximum = Math.max(maximum, ++active); await delay(10); active--;
  })));
  assert.equal(maximum, 1);
  await first.save({ tokens: { access_token: "secret", refresh_token: "rotation", token_type: "Bearer" } });
  assert.equal(credentials.tokens("builtin_fixture", "https://example.com/mcp")?.access_token, "secret");
  assert.equal(existsSync(join(f.agentDir, "mcp-auth.json")), false);
  credentials.remove("builtin_fixture", "https://example.com/mcp");
  assert.throws(() => first.save({ tokens: { access_token: "old", token_type: "Bearer" } }), /revoked/);
});

it("plugin lifecycle coalesces connect, cancels authorization, and serializes reconnect after disconnect", async t => {
  const f = temporary(t); const registry = new PluginRegistry(join(f.agentDir, "integrations.json"), [plugin()]);
  const calls: string[] = [];
  const manager = new PluginMCPManager(registry, {
    activate: async (_id, _cwd, signal) => { calls.push("connect"); await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })); signal.throwIfAborted(); },
    deactivate: async () => { calls.push("disconnect"); await delay(10); },
  });
  const first = manager.connect("fixture", f.cwd); const same = manager.connect("fixture", f.cwd);
  assert.equal(first, same);
  await delay(1); await manager.disconnect("fixture", f.cwd); await first;
  assert.deepEqual(calls, ["connect", "disconnect"]);
  const disconnect = manager.disconnect("fixture", f.cwd);
  const reconnect = manager.connect("fixture", f.cwd);
  await disconnect; await delay(1); await manager.disconnect("fixture", f.cwd); await reconnect;
  assert.deepEqual(calls, ["connect", "disconnect", "disconnect", "connect", "disconnect"]);
});

it("disconnect failures stay visible even after disabling; observer failures cannot interrupt cleanup", async t => {
  const f = temporary(t); const registry = new PluginRegistry(join(f.agentDir, "integrations.json"), [plugin()]);
  let cleanup = false;
  const manager = new PluginMCPManager(registry, {
    activate: async () => undefined,
    deactivate: async () => { registry.setEnabled("fixture", false); cleanup = true; throw new Error("private storage error"); },
  });
  manager.subscribe(() => { throw new Error("observer failed"); });
  await assert.rejects(manager.disconnect("fixture", f.cwd), /Disconnect failed/);
  assert.equal(cleanup, true);
  const catalog = new McpConfigService({ agentDir: f.agentDir, plugins: registry }).listSync(f.cwd);
  assert.equal(manager.snapshots(catalog)[0].status, "error");
});

it("built-in OAuth plugin discovers, registers, uses PKCE, connects tools, rotates once and disconnects all sessions", async t => {
  const f = temporary(t); const server = await provider(t); const storage = new MemoryCredentialStore();
  const browser: Promise<void>[] = [];
  let permission = false;
  const runtime = new AgentRuntime({ ...f, pluginCredentialStore: storage, builtInPlugins: [plugin(`${server.origin}/mcp`)],
    // Real consent takes longer than the config poll; an owned enable write must not cancel it.
    mcpOpenUrl: url => { const work = delay(1600).then(() => server.authorize(url)); browser.push(work); void work.catch(() => undefined); },
    mcpPermission: { request: async () => permission },
  });
  t.after(() => runtime.dispose());
  const initial = await runtime.getPlugins({ cwd: f.cwd }); assert.equal(initial.plugins[0].status, "disconnected");
  const connected = await runtime.connectPlugin({ cwd: f.cwd, id: "fixture" });
  await Promise.all(browser);
  assert.equal(connected.plugins[0].status, "connected"); assert.equal(connected.plugins[0].toolCount, 2);
  assert.ok(server.discoveries >= 2); assert.equal(server.registrations, 1);
  assert.deepEqual(server.grants, ["authorization_code"]);
  assert.ok(server.methods.includes("initialize")); assert.ok(server.methods.includes("tools/list"));
  assert.equal(existsSync(join(f.agentDir, "mcp-auth.json")), false);
  assert.equal(JSON.stringify(connected).includes(server.access), false);
  assert.equal(JSON.stringify(connected).includes(server.refresh), false);
  assert.equal(readFileSync(join(f.agentDir, "integrations.json"), "utf8").includes("token"), false);
  await runtime.createConversation(f.cwd);
  const id = runtime.activeConversationId!;
  await runtime.addModel({ providerId: "plugin-fixture", providerName: "Local scripted fixture", modelId: "fixture-model", modelName: "Fixture", api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", apiKey: "fixture-key", reasoning: false, contextWindow: 32768, maxTokens: 4096 });
  await runtime.saveAgentSettings({ ...await runtime.getAgentSettings(), provider: "plugin-fixture", modelId: "fixture-model", thinkingLevel: "off" });
  const catalog = await eventually(() => runtime.getMcpCatalog({ cwd: f.cwd, conversationId: id }), value => value.servers.some(server => server.pluginId === "fixture" && server.connectionStatus === "connected"));
  const internals = runtime as unknown as { conversations: Map<string, { session: AgentSession }> };
  const session = internals.conversations.get(id)!.session;
  const write = catalog.servers.find(server => server.pluginId === "fixture")!.tools.find(tool => tool.name === "write")!;
  assert.ok(session.getAllTools().some(tool => tool.name === write.registeredName));
  const invoke = async (callId: string) => {
    let step = 0;
    const stream: StreamFn = model => {
      const content: AssistantMessage["content"] = step++ === 0 ? [{ type: "toolCall", id: callId, name: write.registeredName!, arguments: {} }] : [{ type: "text", text: "Fixture done" }];
      const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content, stopReason: content[0].type === "toolCall" ? "toolUse" : "stop", timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const output = createAssistantMessageEventStream(); output.push({ type: "start", partial: message }); output.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message }); return output;
    };
    session.agent.streamFunction = stream;
    session.setActiveToolsByName([...session.getActiveToolNames(), write.registeredName!]);
    await session.prompt("Run the fixture MCP tool");
    const result = session.messages.find(message => message.role === "toolResult" && message.toolCallId === callId);
    assert.ok(result?.role === "toolResult"); return result;
  };
  const denied = await invoke("denied-plugin");
  assert.ok(denied.isError); assert.equal(server.mutations, 0);
  permission = true;
  const allowed = await invoke("allowed-plugin");
  assert.equal(allowed.isError, false); assert.equal(server.mutations, 1);
  // Both live connections hit 401 with the same access token; only one rotation may occur.
  server.rejectAccess();
  const target = { cwd: f.cwd, scope: "global" as const, name: "builtin_fixture" };
  await Promise.all([runtime.reconnectMcpServer({ ...target, conversationId: null }), runtime.reconnectMcpServer({ ...target, conversationId: id })]);
  assert.equal(server.grants.filter(grant => grant === "refresh_token").length, 1);
  assert.equal(browser.length, 1);
  assert.equal(JSON.stringify(await runtime.getMcpCatalog({ cwd: f.cwd, conversationId: null })).includes(server.access), false);
  // Expiry without a 401 also refreshes automatically, without opening the browser.
  const credentials = (runtime as unknown as { oauthMcp: { credentials: PluginCredentialStore } }).oauthMcp.credentials;
  const state = credentials.forServer("builtin_fixture", `${server.origin}/mcp`);
  await state.save({ ...await state.load(), tokensExpireAt: Date.now() - 1 });
  await runtime.reconnectMcpServer({ ...target, conversationId: null });
  assert.equal(server.grants.filter(grant => grant === "refresh_token").length, 2);
  assert.equal(browser.length, 1);
  const disconnected = await runtime.disconnectPlugin({ cwd: f.cwd, id: "fixture" });
  assert.equal(disconnected.plugins[0].status, "disconnected");
  const after = await runtime.getMcpCatalog({ cwd: f.cwd, conversationId: id });
  assert.equal(after.servers.find(server => server.pluginId === "fixture")!.enabled, false);
  assert.equal(JSON.stringify(storage.withLock(current => ({ result: current }))).includes("fixture-refresh"), false);
  const blocked = await invoke("revoked-plugin");
  assert.ok(blocked.isError); assert.equal(server.mutations, 1);
});

it("disconnect during browser authorization cancels the callback and never revives credentials", async t => {
  const f = temporary(t); const server = await provider(t); const storage = new MemoryCredentialStore();
  let authUrl = "";
  const runtime = new AgentRuntime({ ...f, pluginCredentialStore: storage, builtInPlugins: [plugin(`${server.origin}/mcp`)], mcpOpenUrl: url => { authUrl = url; } });
  t.after(() => runtime.dispose());
  const connecting = runtime.connectPlugin({ cwd: f.cwd, id: "fixture" });
  await eventually(() => authUrl, Boolean);
  await runtime.disconnectPlugin({ cwd: f.cwd, id: "fixture" }); await connecting;
  assert.equal((await runtime.getPlugins({ cwd: f.cwd })).plugins[0].status, "disconnected");
  assert.equal(server.grants.length, 0);
  assert.equal(JSON.stringify(storage.withLock(current => ({ result: current }))).includes("client_id"), false);
});

it("a locked credential backend fails closed while preserving reviewable plugin error status", async t => {
  const f = temporary(t); const server = await provider(t);
  class LockedStore extends MemoryCredentialStore {
    override withLock<T>(_fn: (current: string | undefined) => { result: T; next?: string }): T {
      throw new Error("synthetic-keychain-secret");
    }
  }
  const runtime = new AgentRuntime({ ...f, builtInPlugins: [plugin(`${server.origin}/mcp`)], pluginCredentialStore: new LockedStore() });
  t.after(() => runtime.dispose());
  const result = await runtime.connectPlugin({ cwd: f.cwd, id: "fixture" });
  assert.equal(result.plugins[0].status, "error");
  assert.equal(JSON.stringify(result).includes("synthetic-keychain-secret"), false);
  assert.equal(server.methods.length, 0);
});
