import assert from "node:assert/strict";
import { runToolCall, type AgentToolCall } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { startMcpHttpFixture } from "./fixtures/mcp-http-server.mjs";
import { test, type TestContext } from "node:test";
import {
  createAgentSession, createMcpExtension, createToolSearchExtension, DefaultResourceLoader,
  ModelRuntime, SessionManager, SettingsManager, FileAuthStorageBackend,
  McpOAuthCredentialStore, McpSignInCancelledError, signInMcpServer,
  loadMcpConfig, validateMcpServerConfig,
  type ExtensionAPI, type ExtensionFactory, type McpController, type McpExtensionOptions,
  type McpServerEntry, type McpSnapshot,
} from "@earendil-works/pi-coding-agent";

const serverScript = fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url));
async function eventually<T>(read: () => T | Promise<T>, accept: (value: T) => boolean): Promise<T> {
  const until = Date.now() + 5000;
  let last: unknown;
  while (Date.now() < until) {
    const value = await read();
    last = value;
    if (accept(value)) return value;
    await delay(10);
  }
  assert.fail(`MCP fixture did not reach expected state: ${JSON.stringify(last)}`);
}
async function fixture(t: TestContext, exposures: Array<"direct" | "deferred"> = ["direct"], overrides: McpExtensionOptions = {}, extra?: ExtensionFactory, searchFactory?: (controller: () => McpController) => ExtensionFactory) {
  const root = await mkdtemp(join(tmpdir(), "vela-mcp-pi-"));
  const cwd = join(root, "cwd");
  const agentDir = join(root, "agent");
  await mkdir(cwd); await mkdir(agentDir);
  const entries: McpServerEntry[] = exposures.map((exposure, index) => ({
    name: `fixture${index}`, source: join(agentDir, "mcp.json"), scope: "global",
    config: { command: process.execPath, args: [serverScript, "normal", join(root, `trace${index}`)], exposure, timeout: 2, env: { PRIVATE_CONFIG_TOKEN: "synthetic-secret-not-for-snapshots" } },
  }));
  let controller!: McpController;
  const changes: McpSnapshot[] = [];
  const settingsManager = SettingsManager.inMemory({});
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [searchFactory?.(() => controller) ?? createToolSearchExtension(), createMcpExtension({ agentDir, loadConfig: () => ({ servers: entries, errors: [] }), ...overrides,
      onController: value => { controller = value; controller.subscribe(snapshot => changes.push(snapshot)); } }), ...(extra ? [extra] : [])],
  });
  await resourceLoader.reload();
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  const { session } = await createAgentSession({ cwd, agentDir, resourceLoader, modelRuntime, settingsManager, sessionManager: SessionManager.inMemory(cwd), noTools: "builtin" });
  t.after(async () => { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); await rm(root, { recursive: true, force: true }); });
  await session.extensionRunner.emit({ type: "session_start", reason: "startup" });
  session.agent.state.messages = [{ role: "assistant", api: "openai-completions", provider: "fixture", model: "fixture", content: [], stopReason: "toolUse", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }];
  const ready = () => eventually(() => controller.getSnapshot(), s => s.length >= entries.length && s.every(server => server.state === "connected"));
  const toolName = (server: string, raw: string) => controller.getSnapshot().find(s => s.name === server)!.tools.find(tool => tool.name === raw)!.registeredName;
  const call = (name: string, args: AgentToolCall["arguments"] = {}, signal?: AbortSignal) => {
    // tool_search has model-only exposure, so invoke it through the model tool pipeline.
    if (name === "tool_search") return runToolCall({ type: "toolCall", id: "fixture-search", name, arguments: args }, {
      tools: session.agent.state.tools, assistantMessage: session.agent.state.messages[0] as AssistantMessage,
      context: { messages: session.agent.state.messages, tools: session.agent.state.tools }, signal,
    });
    return session.extensionRunner.createToolContext("fixture-parent", signal).executeTool(name, args, { signal });
  };
  return { root, cwd, agentDir, entries, controller, changes, session, ready, toolName, call };
}

test("Pi MCP patch exports config validation and uses agentDir for config, auth and logs", async t => {
  const f = await fixture(t, [], { loadConfig: undefined });
  await writeFile(join(f.agentDir, "mcp.json"), JSON.stringify({ mcpServers: { local: { command: process.execPath, args: [serverScript], exposure: "direct" } } }));
  assert.equal(loadMcpConfig({ agentDir: f.agentDir, cwd: f.cwd, projectTrusted: false }).servers[0]?.name, "local");
  assert.equal(typeof validateMcpServerConfig("local", { command: process.execPath }), "object");
  assert.equal(typeof validateMcpServerConfig("bad name", {}), "string");
  await f.session.extensionRunner.emit({ type: "session_start", reason: "startup" });
  await eventually(() => f.controller.getSnapshot(), s => s[0]?.state === "connected");
  assert.equal(f.controller.getSnapshot()[0]?.source, join(f.agentDir, "mcp.json"));
  // Default backend and refresh lock reside together in the supplied directory.
  const credentials = new McpOAuthCredentialStore(new FileAuthStorageBackend(join(f.agentDir, "mcp-auth.json")), f.agentDir);
  await credentials.forServer("local", "https://example.invalid/mcp").save({ serverUrl: "https://example.invalid/mcp", tokens: { access_token: "synthetic", token_type: "Bearer" } });
  assert.match(await readFile(join(f.agentDir, "mcp-auth.json"), "utf8"), /synthetic/);
  assert.equal(JSON.stringify(f.controller.getSnapshot()).includes("synthetic"), false);
});

test("direct/deferred tools and resources keep raw metadata and hide denied tools from search", async t => {
  let readonly = true;
  const f = await fixture(t, ["direct", "deferred"], { allowTool: (_entry, raw) => !readonly || raw.annotations?.readOnlyHint === true });
  await f.ready();
  const read = f.toolName("fixture0", "read-data");
  const write = f.toolName("fixture0", "write_data");
  const deferred = f.toolName("fixture1", "read-data");
  const snapshot = f.controller.getSnapshot()[0]!;
  assert.match(await readFile(join(f.agentDir, "mcp.log"), "utf8"), /fixture server started/);
  assert.equal(snapshot.oauth, false);
  assert.equal(snapshot.authenticated, false);
  assert.equal(snapshot.resources, 1);
  assert.equal(snapshot.resourceTemplates, 1);
  assert.equal(snapshot.tools.find(tool => tool.registeredName === read)?.rawTool, "read-data");
  assert.deepEqual(snapshot.tools.find(tool => tool.registeredName === read)?.inputSchema, { type: "object", properties: {} });
  assert.equal(snapshot.tools.find(tool => tool.registeredName === write)?.exposure, "hidden");
  assert.ok(f.session.getActiveToolNames().includes(read));
  assert.equal(f.session.getActiveToolNames().includes(write), false);
  assert.equal(f.session.getActiveToolNames().includes(deferred), false);
  assert.ok(f.session.getActiveToolNames().includes("tool_search"));
  const searched = await f.call("tool_search", { query: "write fixture data" });
  assert.equal(searched.isError, false);
  assert.equal(JSON.stringify(searched).includes(write), false);
  assert.match(JSON.stringify(await f.call("list_mcp_resources", { server: "fixture0" })), /fixture:\/\/data/);
  assert.match(JSON.stringify(await f.call("read_mcp_resource", { server: "fixture1", uri: "fixture://data" })), /fixture resource/);
  const detached = f.controller.getSnapshot(); detached[0]!.tools[0]!.name = "mutated";
  assert.equal(f.controller.getSnapshot()[0]!.tools[0]!.name, "read-data");
  assert.equal(JSON.stringify(f.controller.getSnapshot()).includes("synthetic-secret-not-for-snapshots"), false);
  readonly = false; f.controller.refreshTools();
  assert.ok(f.session.getActiveToolNames().includes(write));
  f.session.setActiveToolsByName([...f.session.getActiveToolNames(), deferred]);
  readonly = true; f.controller.refreshTools();
  assert.equal(f.session.getActiveToolNames().includes(write), false);
  assert.ok(f.session.getActiveToolNames().includes(deferred), "permitted active deferred tool must survive refresh");
});

test("tools/list_changed emits snapshots and reapplies host filtering", async t => {
  const f = await fixture(t, ["direct"], { allowTool: (_entry, raw) => raw.name !== "new_read" });
  await f.ready();
  const before = f.changes.length;
  await f.call(f.toolName("fixture0", "change_tools"));
  await eventually(() => f.changes.slice(before), snapshots => snapshots.some(snapshot => snapshot[0]?.tools.some(tool => tool.name === "new_read")));
  assert.equal(f.controller.getSnapshot()[0]!.tools.find(tool => tool.name === "new_read")?.exposure, "hidden");
  assert.equal(f.session.getActiveToolNames().includes(f.toolName("fixture0", "new_read")), false);
});

test("live policy revocation guards tools/resources; suspend cancels in-flight work without saving config", async t => {
  let allowed = true;
  const f = await fixture(t, ["direct"], { allowServer: () => allowed });
  await f.ready();
  const before = JSON.stringify(f.entries);
  const call = f.call(f.toolName("fixture0", "hang"));
  const resource = f.call("read_mcp_resource", { server: "fixture0", uri: "fixture://hang" });
  await eventually(() => readFile(join(f.root, "trace0"), "utf8"), value => value.includes("resources/read") && value.includes("tools/call"));
  const results = Promise.allSettled([call, resource]);
  await f.controller.suspend("fixture0");
  const settled = await results;
  assert.ok(settled.every(result => result.status === "rejected" || result.value.isError));
  assert.equal(JSON.stringify(f.entries), before);
  assert.equal(f.controller.getSnapshot()[0]?.suspended, true);
  assert.equal(f.controller.getSnapshot()[0]?.state, "disabled");
  assert.equal(f.session.getActiveToolNames().some(name => name.startsWith("mcp__fixture0__")), false);
  const unavailable = await f.call("read_mcp_resource", { server: "fixture0", uri: "fixture://data" });
  assert.equal(unavailable.isError, true);
  await f.controller.reconnect("fixture0");
  await f.ready();
  allowed = false;
  const revoked = await f.call(f.toolName("fixture0", "read-data"));
  assert.equal(revoked.isError, true);
  f.controller.refreshTools();
  assert.ok(f.controller.getSnapshot()[0]!.tools.every(tool => tool.exposure === "hidden"));
  await assert.rejects(f.controller.reconnect("fixture0"), /no longer permitted/);
});

test("dynamic registered servers default deferred, retain filtering, and withdraw cleanly", async t => {
  let pi!: ExtensionAPI;
  const f = await fixture(t, [], { allowTool: (_entry, raw) => raw.annotations?.readOnlyHint === true }, api => { pi = api; });
  pi.registerMcpServer("dynamic", { command: process.execPath, args: [serverScript] });
  await eventually(() => f.controller.getSnapshot(), s => s[0]?.state === "connected");
  assert.equal(f.controller.getSnapshot()[0]?.exposure, "deferred");
  const denied = f.toolName("dynamic", "write_data");
  assert.equal(f.controller.getSnapshot()[0]?.tools.find(tool => tool.registeredName === denied)?.exposure, "hidden");
  pi.unregisterMcpServer("dynamic");
  await eventually(() => f.controller.getSnapshot(), s => s.length === 0);
  assert.equal(f.session.getActiveToolNames().some(name => name.startsWith("mcp__dynamic__")), false);
});

test("resource cancellation, server/tool errors, and stderr are structured", async t => {
  const f = await fixture(t);
  await f.ready();
  assert.equal((await f.call(f.toolName("fixture0", "fail"))).isError, true);
  assert.equal((await f.call("read_mcp_resource", { server: "fixture0", uri: "fixture://error" })).isError, true);
  const abort = new AbortController();
  const running = f.call("read_mcp_resource", { server: "fixture0", uri: "fixture://hang" }, abort.signal);
  const settled = Promise.allSettled([running]);
  abort.abort();
  const result = (await settled)[0]!;
  assert.ok(result.status === "rejected" || result.value.isError);
  f.entries[0]!.config = { command: process.execPath, args: [serverScript, "fail"], exposure: "direct", timeout: 1 };
  await f.controller.close();
  await f.session.extensionRunner.emit({ type: "session_start", reason: "startup" });
  await eventually(() => f.controller.getSnapshot(), s => s[0]?.state === "failed");
  assert.match(f.controller.getSnapshot()[0]!.stderr ?? "", /fixture stderr failure/);
});

test("shutdown while initialize is pending closes the process and is idempotent", async t => {
  const f = await fixture(t, ["direct"], { loadConfig: ctx => ({ servers: [{ name: "slow", source: "fixture", config: { command: process.execPath, args: [serverScript, "slow", join(ctx.cwd, "..", "trace-slow")], exposure: "direct", timeout: 20 } }], errors: [] }) });
  await eventually(() => f.controller.getSnapshot(), s => s[0]?.state === "connecting");
  const trace = await eventually(() => readFile(join(f.root, "trace-slow"), "utf8").catch(() => ""), text => text.includes("initialize"));
  const pid = Number(trace.split("\n")[0]);
  process.kill(pid, 0);
  const started = Date.now();
  const closing = f.controller.close();
  assert.equal(f.controller.close(), closing);
  await closing;
  assert.ok(Date.now() - started < 3000, "close must interrupt pending initialize rather than await its timeout");
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  assert.deepEqual(f.controller.getSnapshot(), []);
  assert.equal(f.session.getActiveToolNames().some(name => name.startsWith("mcp__slow__")), false);
});

test("immediate shutdown drops late runtime loads and cannot publish tools", async t => {
  const f = await fixture(t);
  await f.controller.close();
  await delay(50);
  assert.deepEqual(f.controller.getSnapshot(), []);
  assert.equal(f.session.getActiveToolNames().some(name => name.startsWith("mcp__")), false);
  await assert.rejects(readFile(join(f.root, "trace0")), { code: "ENOENT" });
});

test("OAuth cancellation works before discovery and interrupts discovery requests", async t => {
  const root = await mkdtemp(join(tmpdir(), "vela-mcp-oauth-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const credentials = new McpOAuthCredentialStore(new FileAuthStorageBackend(join(root, "mcp-auth.json")), root);
  const aborted = new AbortController(); aborted.abort();
  let shown = false;
  await assert.rejects(signInMcpServer({ serverUrl: "http://127.0.0.1:1/mcp", store: credentials.forServer("pre", "http://127.0.0.1:1/mcp"), settings: {}, signal: aborted.signal,
    prompt: { showAuthorizationUrl: () => { shown = true; }, promptForRedirectUrl: async () => undefined } }), McpSignInCancelledError);
  assert.equal(shown, false);
  let requested!: () => void;
  const request = new Promise<void>(resolve => { requested = resolve; });
  const server = createServer((_req, _res) => requested());
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/mcp`;
  const abort = new AbortController();
  const running = signInMcpServer({ serverUrl: url, store: credentials.forServer("discovery", url), settings: {}, signal: abort.signal,
    prompt: { showAuthorizationUrl: () => { shown = true; }, promptForRedirectUrl: async () => undefined } });
  const rejection = assert.rejects(running, McpSignInCancelledError);
  await request; abort.abort(); await rejection;
  assert.equal(shown, false);
});

async function oauthServer(t: TestContext) {
  const fixture = await startMcpHttpFixture();
  t.after(() => fixture.close());
  return fixture;
}

test("controller OAuth uses explicit URL/promise callbacks, agentDir credentials, and logout", async t => {
  const oauth = await oauthServer(t);
  const entry: McpServerEntry = { name: "oauth", scope: "global", source: "fixture", config: { url: `${oauth.origin}/mcp`, oauth: { clientId: "fixture-client", authServerMetadataUrl: `${oauth.origin}/metadata` } } };
  const f = await fixture(t, [], { loadConfig: () => ({ servers: [entry], errors: [] }) });
  await eventually(() => f.controller.getSnapshot(), snapshot => snapshot[0]?.state === "needs-auth");
  assert.equal(f.controller.getSnapshot()[0]?.oauth, true);
  assert.equal(f.controller.getSnapshot()[0]?.authenticated, false);
  let shown!: string;
  let promptAborted = false;
  await f.controller.login("oauth", {
    onUrl: url => { shown = url; },
    promptForRedirectUrl: async signal => {
      signal.addEventListener("abort", () => { promptAborted = true; }, { once: true });
      const auth = new URL(shown);
      const redirect = new URL(auth.searchParams.get("redirect_uri")!);
      redirect.searchParams.set("state", auth.searchParams.get("state")!);
      redirect.searchParams.set("code", "fixture-code");
      return redirect.href;
    },
  });
  assert.equal(f.controller.getSnapshot()[0]?.state, "connected");
  assert.equal(f.controller.getSnapshot()[0]?.oauth, true);
  assert.equal(f.controller.getSnapshot()[0]?.authenticated, true);
  assert.ok(shown.startsWith(`${oauth.origin}/authorize`));
  assert.equal(promptAborted, true);
  assert.match(await readFile(join(f.agentDir, "mcp-auth.json"), "utf8"), /controller-test-access/);
  assert.equal(JSON.stringify(f.controller.getSnapshot()).includes("controller-test-access"), false);
  assert.equal(await f.controller.logout("oauth"), true);
  assert.equal(f.controller.getSnapshot()[0]?.state, "needs-auth");
  assert.equal(f.controller.getSnapshot()[0]?.oauth, true);
  assert.equal(f.controller.getSnapshot()[0]?.authenticated, false);
  assert.equal((await readFile(join(f.agentDir, "mcp-auth.json"), "utf8")).includes("controller-test-access"), false);
});

test("OAuth refreshes a stored refresh token without opening the browser", async t => {
  const oauth = await oauthServer(t);
  const entry: McpServerEntry = { name: "oauth", scope: "global", source: "fixture", config: { url: `${oauth.origin}/mcp`, oauth: { clientId: "fixture-client", authServerMetadataUrl: `${oauth.origin}/metadata` } } };
  const f = await fixture(t, [], { loadConfig: () => ({ servers: [entry], errors: [] }) });
  await eventually(() => f.controller.getSnapshot(), snapshot => snapshot[0]?.state === "needs-auth");
  const credentials = new McpOAuthCredentialStore(new FileAuthStorageBackend(join(f.agentDir, "mcp-auth.json")), f.agentDir);
  await credentials.forServer("oauth", `${oauth.origin}/mcp`).save({ serverUrl: `${oauth.origin}/mcp`,
    tokens: { access_token: "expired-fixture-access", token_type: "Bearer", expires_in: 1, refresh_token: "fixture-refresh" } });
  let shown = false;
  await f.controller.login("oauth", { onUrl: () => { shown = true; } });
  assert.equal(shown, false, "a stored refresh token must refresh without the browser flow");
  assert.deepEqual(oauth.tokenRequests, ["refresh_token"]);
  assert.equal(f.controller.getSnapshot()[0]?.state, "connected");
  assert.equal(f.controller.getSnapshot()[0]?.authenticated, true);
  const stored = await readFile(join(f.agentDir, "mcp-auth.json"), "utf8");
  assert.match(stored, /controller-test-refreshed/);
  assert.equal(stored.includes("expired-fixture-access"), false, "the rotated access token replaces the old one");
});

test("controller cancels login before discovery, during discovery, and when closing", async t => {
  const oauth = await oauthServer(t);
  const entry: McpServerEntry = { name: "oauth", scope: "global", source: "fixture", config: { url: `${oauth.origin}/mcp`, oauth: { clientId: "fixture-client", authServerMetadataUrl: `${oauth.origin}/metadata` } } };
  const f = await fixture(t, [], { loadConfig: () => ({ servers: [entry], errors: [] }) });
  await eventually(() => f.controller.getSnapshot(), snapshot => snapshot[0]?.state === "needs-auth");
  let shown = 0;
  const early = f.controller.login("oauth", { onUrl: () => { shown++; } });
  const cancelled = assert.rejects(early, McpSignInCancelledError);
  f.controller.cancelLogin("oauth"); await cancelled;
  assert.equal(shown, 0);
  assert.equal(f.controller.getSnapshot()[0]?.loginPending, false);
  oauth.hang();
  const discovered = oauth.discovered();
  const abort = new AbortController();
  const external = f.controller.login("oauth", { signal: abort.signal });
  const externalCancelled = assert.rejects(external, McpSignInCancelledError);
  await discovered; abort.abort(); await externalCancelled;
  const nextDiscovery = oauth.discovered();
  const closingLogin = f.controller.login("oauth");
  const shutdownCancelled = assert.rejects(closingLogin, McpSignInCancelledError);
  await nextDiscovery;
  await f.controller.close(); await shutdownCancelled;
  assert.deepEqual(f.controller.getSnapshot(), []);
});

test("exposure refresh removes former direct tools and keeps previously activated deferred tools", async t => {
  const f = await fixture(t, ["direct", "deferred"]);
  await f.ready();
  const formerDirect = f.toolName("fixture0", "read-data");
  const loadedDeferred = f.toolName("fixture1", "read-data");
  f.session.setActiveToolsByName([...f.session.getActiveToolNames(), loadedDeferred]);
  f.entries[0]!.config.exposure = "deferred";
  f.controller.refreshTools();
  assert.equal(f.session.getActiveToolNames().includes(formerDirect), false);
  assert.equal(f.session.getActiveToolNames().includes(loadedDeferred), true);
  assert.equal(f.session.getActiveToolNames().includes("list_mcp_resources"), false);
  const search = await f.call("tool_search", { query: "read fixture data" });
  assert.equal(search.isError, false);
  assert.ok(f.session.getActiveToolNames().includes(formerDirect));
});

test("withdrawing an extension server during initialize closes its pending connection", async t => {
  let pi!: ExtensionAPI;
  const f = await fixture(t, [], {}, api => { pi = api; });
  const trace = join(f.root, "dynamic-slow");
  pi.registerMcpServer("slow", { command: process.execPath, args: [serverScript, "slow", trace], timeout: 20 });
  const started = await eventually(() => readFile(trace, "utf8").catch(() => ""), text => text.includes("initialize"));
  const pid = Number(started.split("\n")[0]);
  pi.unregisterMcpServer("slow");
  await eventually(() => f.controller.getSnapshot(), s => s.length === 0);
  await eventually(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, closed => closed);
  assert.equal(f.session.getActiveToolNames().some(name => name.startsWith("mcp__slow__")), false);
});

test("OAuth loopback callback works without a text prompt; a nonresponsive prompt still cancels", async t => {
  const oauth = await oauthServer(t);
  const f = await fixture(t, [], { loadConfig: () => ({ servers: [{ name: "oauth", source: "fixture", config: { url: `${oauth.origin}/mcp`, oauth: { clientId: "fixture-client", authServerMetadataUrl: `${oauth.origin}/metadata` } } }], errors: [] }) });
  await eventually(() => f.controller.getSnapshot(), s => s[0]?.state === "needs-auth");
  let callbackRequest!: Promise<Response>;
  await f.controller.login("oauth", { onUrl: value => {
    const auth = new URL(value);
    const redirect = new URL(auth.searchParams.get("redirect_uri")!);
    redirect.searchParams.set("state", auth.searchParams.get("state")!);
    redirect.searchParams.set("code", "fixture-code");
    callbackRequest = fetch(redirect);
  } });
  assert.equal((await callbackRequest).status, 200);
  assert.equal(f.controller.getSnapshot()[0]?.state, "connected");
  await f.controller.logout("oauth");
  let opened!: () => void;
  const shown = new Promise<void>(resolve => { opened = resolve; });
  const pending = f.controller.login("oauth", { onUrl: () => opened(), promptForRedirectUrl: () => new Promise(() => {}) });
  const cancelled = assert.rejects(pending, McpSignInCancelledError);
  await shown;
  await assert.rejects(f.controller.login("oauth"), /pending sign-in/);
  await f.controller.suspend("oauth"); await cancelled;
  assert.equal(f.controller.getSnapshot()[0]?.loginPending, false);
});

test("real MCP image and large structured results preserve media and save untruncated output", async t => {
  const f = await fixture(t);
  await f.ready();
  const image = await f.call(f.toolName("fixture0", "image_data"));
  assert.equal(image.isError, false);
  const media = image.result.content.find(block => block.type === "image");
  assert.ok(media && media.type === "image");
  assert.equal(media.mimeType, "image/png");
  assert.equal(Buffer.from(media.data, "base64").subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  const large = await f.call(f.toolName("fixture0", "large_result"));
  assert.equal(large.isError, false);
  const structured = large.result.structuredContent as { content: Array<{ type: string; text: string }>; structuredContent: { text: string; size: number }; _meta?: unknown };
  assert.ok(structured.structuredContent.size > 48000);
  assert.equal(structured.structuredContent.text.length, structured.structuredContent.size);
  assert.equal(structured.content[0]!.text, structured.structuredContent.text);
  assert.equal(structured._meta, undefined);
  const details = large.result.details as { fullOutputPath?: string };
  assert.ok(details.fullOutputPath);
  t.after(() => rm(details.fullOutputPath!, { force: true }));
  assert.equal(await readFile(details.fullOutputPath, "utf8"), structured.structuredContent.text);
  const modelText = large.result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
  assert.ok(modelText.length < structured.structuredContent.text.length);
  assert.match(modelText, /START fixture large result/);
  assert.match(modelText, /END fixture large result/);
  assert.ok(modelText.includes(details.fullOutputPath));
});

test("public tool-search API wrapper restricts metadata discovery without changing session introspection", async t => {
  const foreign = "foreign_deferred";
  const spoof = "mcp__spoof__foreign";
  const f = await fixture(t, ["deferred"], {}, pi => {
    for (const name of [foreign, spoof]) pi.registerTool({ name, label: name, exposure: "deferred",
      description: "private unrelated extension metadata",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ content: [{ type: "text", text: "foreign tool" }], details: {} }),
    });
  }, getController => pi => createToolSearchExtension()({ ...pi,
    getAllTools: () => {
      const admitted = new Set(getController().getSnapshot().flatMap(server => server.tools.map(tool => tool.registeredName)));
      // Vela's native loadout can be added here; this fixture only exercises MCP candidates.
      return pi.getAllTools().filter(tool => admitted.has(tool.name));
    },
  }));
  await f.ready();
  assert.ok(f.session.getAllTools().some(tool => tool.name === foreign), "search wrapper must leave public session introspection intact");
  const denied = await f.call("tool_search", { query: "private unrelated extension metadata", limit: 20 });
  assert.equal(denied.isError, false);
  assert.equal(JSON.stringify(denied).includes(foreign), false);
  assert.equal(JSON.stringify(denied).includes(spoof), false);
  const permitted = await f.call("tool_search", { query: "read fixture data", limit: 20 });
  assert.equal(permitted.isError, false);
  const loaded = (permitted.result.details as { loaded: string[] }).loaded;
  assert.ok(loaded.includes(f.toolName("fixture0", "read-data")));
  assert.equal(f.session.getActiveToolNames().includes(foreign), false);
  assert.equal(f.session.getActiveToolNames().includes(spoof), false);
});
