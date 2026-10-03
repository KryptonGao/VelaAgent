import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, mock, type TestContext } from "node:test";
import type { AgentRuntime } from "@vela/agent";
import type { McpCatalog, McpStatusEvent, PluginStatusEvent } from "@vela/shared";

type Handler = (event: unknown, input: unknown) => Promise<unknown>;
const handlers = new Map<string, Handler>();
const removed: string[] = [];
let windows: { isDestroyed(): boolean; webContents: { isDestroyed(): boolean; send(channel: string, event: unknown): void } }[] = [];
mock.module("electron", {
  namedExports: {
    ipcMain: {
      handle(channel: string, handler: Handler) {
        assert.ok(!handlers.has(channel), `duplicate handler: ${channel}`);
        handlers.set(channel, handler);
      },
      removeHandler(channel: string) { removed.push(channel); handlers.delete(channel); },
    },
    BrowserWindow: { getAllWindows: () => windows, fromWebContents: (sender: unknown) => sender ? {} : null },
  },
});
const { McpHost, parseMcpRequest } = await import("../src/main/mcp-host.ts");

const digest = "a".repeat(64);
const toolDigest = "b".repeat(64);
const targets = ["save", "remove", "enabled", "reconnect", "login", "cancel-login", "logout"] as const;
const methods: Record<string, string> = {
  catalog: "getMcpCatalog", save: "saveMcpServer", remove: "removeMcpServer", enabled: "setMcpEnabled",
  reconnect: "reconnectMcpServer", login: "loginMcpServer", "cancel-login": "cancelMcpLogin", logout: "logoutMcpServer",
  trust: "setMcpProjectTrust", readonly: "setMcpToolReadOnly",
  plugins: "getPlugins", "plugin-connect": "connectPlugin", "plugin-disconnect": "disconnectPlugin",
};

function fixture(t: TestContext) {
  handlers.clear();
  removed.length = 0;
  windows = [];
  const root = mkdtempSync(join(tmpdir(), "vela-mcp-host-"));
  const cwd = join(root, "current");
  const other = join(root, "other");
  mkdirSync(cwd);
  mkdirSync(other);
  const calls: { method: string; input: unknown }[] = [];
  const conversations = [{ id: "current-chat", cwd }, { id: "other-chat", cwd: other }];
  const catalog: McpCatalog = {
    cwd, conversationId: null, servers: [], errors: [], pendingApply: false,
    projectTrust: { path: join(cwd, ".pi", "mcp.json"), digest, trusted: false, servers: [], review: [] },
  };
  let listener: ((event: McpStatusEvent) => void) | undefined;
  let pluginListener: ((event: PluginStatusEvent) => void) | undefined;
  let unsubscribed = 0;
  let failure: unknown;
  const runtime = {
    listConversations: () => conversations,
    subscribeMcp(callback: (event: McpStatusEvent) => void) {
      listener = callback;
      return () => { ++unsubscribed; listener = undefined; };
    },
    subscribePlugins(callback: (event: PluginStatusEvent) => void) {
      pluginListener = callback; return () => { pluginListener = undefined; };
    },
    ...Object.fromEntries(Object.values(methods).map(method => [method, async (input: unknown) => {
      calls.push({ method, input });
      if (failure) throw failure;
      return catalog;
    }])),
  };
  const host = new McpHost(runtime as unknown as AgentRuntime, () => cwd);
  host.register();
  const frame = {};
  const event = { sender: { mainFrame: frame }, senderFrame: frame };
  const request = (operation: string, input: unknown) => handlers.get(`mcp:${operation}`)!(event, input);
  const input = (operation: string): Record<string, unknown> => {
    const base = { cwd, conversationId: null };
    if (operation === "catalog" || operation === "plugins") return base;
    if (operation.startsWith("plugin-")) return { ...base, id: "notion" };
    if (operation === "trust") return { ...base, trusted: true, digest };
    if (operation === "readonly") return { ...base, server: "server", tool: "lookup", readOnly: true, configDigest: digest, toolDigest };
    return { ...base, scope: "global", name: "server", ...(operation === "save" ? { config: { command: "node" } } : {}), ...(operation === "enabled" ? { enabled: true } : {}) };
  };
  t.after(() => { host.dispose(); rmSync(root, { recursive: true, force: true }); });
  return { root, cwd, other, calls, conversations, catalog, host, request, input,
    emit(event: McpStatusEvent) { listener?.(event); },
    emitPlugin(event: PluginStatusEvent) { pluginListener?.(event); },
    get unsubscribed() { return unsubscribed; },
    fail(error: unknown) { failure = error; },
  };
}

describe("MCP IPC request validation", () => {
  it("routes every approved channel with null conversationId and preserves host APIs", async t => {
    const f = fixture(t);
    assert.equal(handlers.size, 13);
    for (const [operation, method] of Object.entries(methods)) {
      assert.equal(await f.request(operation, f.input(operation)), f.catalog);
      assert.deepEqual(f.calls.at(-1), { method, input: f.input(operation) });
    }
  });

  it("accepts omitted/null/current conversation IDs and normalizes known workspace paths", async t => {
    const f = fixture(t);
    for (const conversationId of [undefined, null, "current-chat"]) {
      const input = { cwd: join(f.cwd, "sub", ".."), conversationId };
      await f.request("catalog", input);
      assert.deepEqual(f.calls.at(-1)?.input, { cwd: f.cwd, conversationId });
    }
    await f.request("catalog", { cwd: f.other, conversationId: "other-chat" });
    assert.deepEqual(f.calls.at(-1)?.input, { cwd: f.other, conversationId: "other-chat" });
  });

  it("rejects malformed roots and unavailable/relative/traversing/sibling workspaces before runtime", async t => {
    const f = fixture(t);
    for (const input of [null, undefined, [], "text", 42, true, {}, { cwd: 12 }, { cwd: "." },
      { cwd: join(f.root, "unknown") }, { cwd: f.cwd + "-sibling" }, { cwd: join(f.cwd, "..") }, { cwd: f.cwd + "\0" },
    ]) await assert.rejects(f.request("catalog", input));
    assert.equal(f.calls.length, 0);
    assert.throws(() => parseMcpRequest({ cwd: f.cwd }, ["relative/current"]), /workspace/);
  });

  it("rejects unknown conversation IDs and IDs belonging to a different known workspace", async t => {
    const f = fixture(t);
    for (const conversationId of ["missing", "other-chat", "", " ", " current-chat ", false, 123, []]) {
      await assert.rejects(f.request("catalog", { cwd: f.cwd, conversationId }), /conversation/);
    }
    assert.equal(f.calls.length, 0);
  });

  it("rechecks current workspace membership instead of accepting a stale known-workspace list", async t => {
    const f = fixture(t);
    await f.request("catalog", { cwd: f.other, conversationId: null });
    f.conversations.splice(1);
    await assert.rejects(f.request("catalog", { cwd: f.other, conversationId: null }), /workspace/);
    assert.equal(f.calls.length, 1);
  });

  it("requires valid target name and scope for every server operation", async t => {
    const f = fixture(t);
    for (const operation of targets) {
      const valid = f.input(operation);
      for (const field of ["scope", "name"]) {
        const missing = { ...valid };
        delete missing[field];
        await assert.rejects(f.request(operation, missing), /target/);
      }
      for (const name of [null, 123, "", " ", "bad name", "../server", "a.b", "synthetic-secret\nname"]) {
        await assert.rejects(f.request(operation, { ...valid, name }), /server name/);
      }
      for (const scope of [null, false, "extension", "GLOBAL", "../../tmp"]) {
        await assert.rejects(f.request(operation, { ...valid, scope }), /scope/);
      }
    }
    assert.equal(f.calls.length, 0);
  });

  it("requires strict boolean decisions and valid reviewed hashes for trust/read-only", async t => {
    const f = fixture(t);
    for (const [operation, field] of [["enabled", "enabled"], ["trust", "trusted"], ["readonly", "readOnly"]]) {
      for (const value of [undefined, null, 0, 1, "true", "false", [], {}]) {
        await assert.rejects(f.request(operation, { ...f.input(operation), [field]: value }));
      }
      await f.request(operation, { ...f.input(operation), [field]: false });
    }
    for (const operation of ["trust", "readonly"]) {
      for (const field of operation === "trust" ? ["digest"] : ["configDigest", "toolDigest"]) {
        for (const value of [undefined, null, 123, {}, "", "a".repeat(63), "a".repeat(65), "A".repeat(64), "z".repeat(64), "a".repeat(64) + "\n"]) {
          await assert.rejects(f.request(operation, { ...f.input(operation), [field]: value }));
        }
      }
    }
    await f.request("trust", { cwd: f.cwd, trusted: false });
    assert.equal(f.calls.length, 4);
  });

  it("requires real server/tool identities for read-only and never forwards unexpected path fields", async t => {
    const f = fixture(t);
    for (const field of ["server", "tool"]) for (const value of [undefined, null, 12, "", " ", " bad ", "bad\nname", "x".repeat(513)]) {
      if (field === "server" && value === "x".repeat(513)) continue; // Pi names have no separate length limit.
      await assert.rejects(f.request("readonly", { ...f.input("readonly"), [field]: value }));
    }
    for (const operation of Object.keys(methods)) {
      for (const field of ["agentDir", "configPath", "policyPath", "source", "filePath", "__proto__"]) {
        const input = Object.fromEntries([...Object.entries(f.input(operation)), [field, "synthetic-path-secret"]]);
        await assert.rejects(f.request(operation, input), error => error instanceof Error && !error.message.includes("synthetic-path-secret"));
      }
    }
    await assert.rejects(f.request("catalog", { cwd: f.cwd, trusted: true, digest }), /fields/);
    assert.equal(f.calls.length, 0);
  });

  it("validates save config as JSON data without executing custom serialization or accessors", async t => {
    const f = fixture(t);
    for (const config of [undefined, null, [], "node", 123, new Date(), new Map(), { command: "node", timeout: Infinity }, { command: "node", vendor: 1n }, { command: "node", vendor: undefined }]) {
      await assert.rejects(f.request("save", { ...f.input("save"), config }));
    }
    let executed = false;
    const config = { command: "node", toJSON() { executed = true; throw new Error("synthetic-secret"); } };
    await assert.rejects(f.request("save", { ...f.input("save"), config }), error => error instanceof Error && !error.message.includes("synthetic-secret"));
    const accessor = Object.defineProperty({ command: "node" }, "env", { enumerable: true, get() { executed = true; throw new Error("synthetic-secret"); } });
    await assert.rejects(f.request("save", { ...f.input("save"), config: accessor }));
    assert.equal(executed, false);
    assert.equal(f.calls.length, 0);
    const vendor = { command: "node", vendor: { custom: [null, 12, false] }, env: { TOKEN: "synthetic-input-secret" } };
    await f.request("save", { ...f.input("save"), config: vendor });
    assert.deepEqual((f.calls[0].input as { config: unknown }).config, vendor);
  });

  it("rejects cyclic/deep/non-JSON requests and caps payloads by UTF-8 byte size", async t => {
    const f = fixture(t);
    const cyclic: Record<string, unknown> = { command: "node" };
    cyclic.self = cyclic;
    const deeplyNested: Record<string, unknown> = { command: "node" };
    let node = deeplyNested;
    for (let depth = 0; depth < 110; depth++) { node.child = {}; node = node.child as Record<string, unknown>; }
    for (const config of [cyclic, deeplyNested, { command: "node", vendor: "x".repeat(200_000) }, { command: "node", vendor: "汉".repeat(70_000) }]) {
      await assert.rejects(f.request("save", { ...f.input("save"), config }));
    }
    assert.equal(f.calls.length, 0);
  });

  it("returns safe fixed errors when fake runtime rejects with credential-bearing diagnostics", async t => {
    const f = fixture(t);
    f.fail(new Error("Authorization: Bearer synthetic-runtime-secret"));
    for (const operation of Object.keys(methods)) {
      await assert.rejects(f.request(operation, f.input(operation)), error => {
        return error instanceof Error && error.message === "MCP operation failed. Refresh the settings and retry.";
      });
    }
    assert.equal(f.calls.length, 13);
  });

  it("forwards status catalogs only to live windows and unregisters handlers/subscription exactly once", t => {
    const f = fixture(t);
    const sent: { channel: string; event: unknown }[] = [];
    const send = (channel: string, event: unknown) => sent.push({ channel, event });
    windows = [
      { isDestroyed: () => false, webContents: { isDestroyed: () => false, send } },
      { isDestroyed: () => true, webContents: { isDestroyed: () => false, send } },
      { isDestroyed: () => false, webContents: { isDestroyed: () => true, send } },
    ];
    const event: McpStatusEvent = { cwd: f.cwd, conversationId: null, catalog: f.catalog };
    f.emit(event);
    assert.deepEqual(sent, [{ channel: "mcp:status", event }]);
    f.host.register();
    assert.equal(handlers.size, 13);
    f.host.dispose();
    f.host.dispose();
    assert.equal(f.unsubscribed, 1);
    assert.equal(removed.length, 13);
    assert.equal(handlers.size, 0);
    f.emit(event);
    assert.equal(sent.length, 1);
    f.host.register();
    assert.equal(handlers.size, 13);
  });

  it("rejects plugin payload credentials, endpoints, unknown ids and subframe callers before dispatch", async t => {
    const f = fixture(t);
    for (const operation of ["plugin-connect", "plugin-disconnect"]) {
      for (const id of [undefined, "", "../notion", "notion-secret\n", null, 123]) await assert.rejects(f.request(operation, { cwd: f.cwd, id }));
      for (const field of ["url", "accessToken", "refreshToken", "oauth", "config"]) await assert.rejects(f.request(operation, { ...f.input(operation), [field]: "secret" }));
      await assert.rejects(handlers.get(`mcp:${operation}`)!({ sender: { mainFrame: {} }, senderFrame: {} }, f.input(operation)), /unavailable/);
    }
    assert.equal(f.calls.length, 0);
  });
});
