import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, mock, type TestContext } from "node:test";
import { MemoryService, type AgentRuntime } from "@vela/agent";
import { memoryFileMaxBytes, type MemoryCatalog, type MemoryDocument, type MemoryResult } from "@vela/shared";

type Handler = (event: unknown, input: unknown) => Promise<unknown>;
const handlers = new Map<string, Handler>();
const removed: string[] = [];
mock.module("electron", {
  namedExports: {
    ipcMain: {
      handle(channel: string, handler: Handler) {
        assert.ok(!handlers.has(channel), `duplicate handler: ${channel}`);
        handlers.set(channel, handler);
      },
      removeHandler(channel: string) {
        removed.push(channel);
        handlers.delete(channel);
      },
    },
    BrowserWindow: { fromWebContents: (sender: unknown) => (sender ? {} : null) },
  },
});
const { MemoryHost, parseMemoryRequest } = await import("../src/main/memory-host.ts");

interface Fixture {
  root: string;
  agentDir: string;
  alpha: string;
  beta: string;
  missing: string;
  service: MemoryService;
  host: InstanceType<typeof MemoryHost>;
  request: (operation: string, input: unknown) => Promise<unknown>;
  frame: object;
}

function fixture(t: TestContext): Fixture {
  handlers.clear();
  removed.length = 0;
  const root = mkdtempSync(join(tmpdir(), "vela-memory-host-"));
  const agentDir = join(root, "profile");
  const alpha = join(root, "alpha");
  const beta = join(root, "beta");
  const missing = join(root, "missing");
  mkdirSync(alpha, { recursive: true });
  mkdirSync(beta, { recursive: true });
  const service = new MemoryService({ agentDir });
  const conversations = [
    { id: "chat-a", cwd: alpha, hasWorkspace: true },
    { id: "chat-b", cwd: beta, hasWorkspace: true },
    { id: "chat-none", cwd: root, hasWorkspace: false },
  ];
  const runtime = {
    getMemorySettings: () => ({ enabled: runtime.enabled }),
    setMemoryEnabled: (enabled: boolean) => { runtime.enabled = enabled; return { enabled }; },
    enabled: true,
    memory: service,
    listConversations: () => conversations,
    activeConversationId: "chat-a",
  };
  const host = new MemoryHost(runtime as unknown as AgentRuntime, { workspaces: () => [alpha, beta, missing] });
  host.register();
  const frame = {};
  const event = { sender: { mainFrame: frame }, senderFrame: frame };
  t.after(() => {
    host.dispose();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    agentDir,
    alpha,
    beta,
    missing,
    service,
    host,
    frame,
    request: (operation, input) => handlers.get(`memory:${operation}`)!(event, input),
  };
}

function value<T>(result: MemoryResult<T>): T {
  assert.equal(result.ok, true);
  return (result as { ok: true; value: T }).value;
}

function failure(result: MemoryResult<unknown>): { code: string; message: string } {
  assert.equal(result.ok, false);
  return (result as { ok: false; error: { code: string; message: string } }).error;
}

function projectFile(directory: string): string {
  return join(directory, ".vela", "MEMORY.md");
}

describe("记忆管理 IPC 校验", () => {
  it("接受合法请求，拒绝多余字段、相对路径与错误类型", () => {
    assert.deepEqual(parseMemoryRequest({ conversationId: "chat-a" }, "list"), { conversationId: "chat-a" });
    assert.deepEqual(parseMemoryRequest({ enabled: false }, "set-enabled"), { enabled: false });
    assert.throws(() => parseMemoryRequest({ enabled: "false" }, "set-enabled"), /必须是布尔值/);
    assert.throws(() => parseMemoryRequest({}, "set-enabled"), /必须是布尔值/);
    assert.throws(() => parseMemoryRequest({ enabled: false, scope: "global" }, "set-enabled"), /不支持的字段/);
    assert.deepEqual(parseMemoryRequest({ scope: "global" }, "read"), { scope: "global" });
    assert.deepEqual(
      parseMemoryRequest({ scope: "project", workspace: "/tmp/demo" }, "read"),
      { scope: "project", workspace: "/tmp/demo" },
    );
    assert.deepEqual(
      parseMemoryRequest({ scope: "global", content: "", expectedRevision: "absent" }, "save"),
      { scope: "global", content: "", expectedRevision: "absent" },
    );
    assert.throws(() => parseMemoryRequest({ scope: "global", extra: 1 }, "read"), /不支持的字段/);
    assert.throws(() => parseMemoryRequest({ scope: "global", workspace: "/tmp/demo" }, "read"), /不接受工作区路径/);
    assert.throws(() => parseMemoryRequest({ scope: "project" }, "read"), /需要工作区路径/);
    assert.throws(() => parseMemoryRequest({ scope: "project", workspace: "relative/dir" }, "read"), /路径不正确/);
    assert.throws(() => parseMemoryRequest({}, "read"), /需要作用域/);
    assert.throws(() => parseMemoryRequest({ scope: "other" }, "read"), /作用域不正确/);
    assert.throws(() => parseMemoryRequest({ scope: "global", content: 3, expectedRevision: "absent" }, "save"), /必须是文本/);
    assert.throws(() => parseMemoryRequest({ scope: "global", content: "" }, "save"), /需要版本指纹/);
    assert.throws(() => parseMemoryRequest({ scope: "global", content: "", expectedRevision: "" }, "save"), /版本指纹不正确/);
    assert.throws(
      () => parseMemoryRequest({ scope: "global", content: "x".repeat(memoryFileMaxBytes + 1), expectedRevision: "absent" }, "save"),
      /最多 16 KiB/,
    );
  });

  it("注册全部通道，请求完成后释放", async (t) => {
    const f = fixture(t);
    assert.deepEqual([...handlers.keys()].sort(), ["memory:list", "memory:read", "memory:remove", "memory:save", "memory:set-enabled"]);
    assert.equal(value(await f.request("list", {}) as MemoryResult<MemoryCatalog>).projects.length, 3);
    f.host.dispose();
    assert.equal(handlers.size, 0);
    assert.deepEqual(removed.sort(), ["memory:list", "memory:read", "memory:remove", "memory:save", "memory:set-enabled"]);
  });

  it("拒绝非主框架的请求", async (t) => {
    const f = fixture(t);
    const other = { sender: { mainFrame: f.frame }, senderFrame: {} };
    await assert.rejects(handlers.get("memory:list")!(other, {}), /不可用/);
  });
});

describe("记忆管理列表与读写", () => {
  it("关闭开关保留文件，设置页仍可读取和保存", async (t) => {
    const f = fixture(t);
    const original = value(await f.request("save", { scope: "global", content: "kept\n", expectedRevision: "absent" }) as MemoryResult<MemoryDocument>);
    assert.deepEqual(value(await f.request("set-enabled", { enabled: false }) as MemoryResult<unknown>), { enabled: false });
    assert.equal(value(await f.request("list", {}) as MemoryResult<MemoryCatalog>).enabled, false);
    assert.equal(value(await f.request("read", { scope: "global" }) as MemoryResult<MemoryDocument>).content, "kept\n");
    value(await f.request("save", { scope: "global", content: "manual edit\n", expectedRevision: original.revision }) as MemoryResult<MemoryDocument>);
    assert.equal(readFileSync(join(f.agentDir, "MEMORY.md"), "utf8"), "manual edit\n");
  });
  it("列出全局与已登记项目，单项失败不影响其他来源", async (t) => {
    const f = fixture(t);
    mkdirSync(join(f.alpha, ".vela"), { recursive: true });
    writeFileSync(projectFile(f.alpha), "# Alpha\n");
    mkdirSync(join(f.beta, ".vela"), { recursive: true });
    writeFileSync(projectFile(f.beta), Buffer.from([0xff, 0xfe, 0xfd]));

    const catalog = value(await f.request("list", { conversationId: "chat-b" }) as MemoryResult<MemoryCatalog>);
    assert.equal(catalog.global.scope, "global");
    assert.equal(catalog.global.status, "missing");
    assert.equal(catalog.global.exists, false);
    assert.equal(catalog.global.path, join(f.agentDir, "MEMORY.md"));
    assert.equal(existsSync(f.agentDir), false, "列表不应创建资料目录");

    const alpha = catalog.projects.find((entry) => entry.name === "alpha")!;
    assert.equal(alpha.status, "loaded");
    assert.equal("content" in alpha, false);
    assert.equal(alpha.bytes, Buffer.byteLength("# Alpha\n"));
    assert.equal(alpha.revision?.startsWith("sha256:"), true);

    const beta = catalog.projects.find((entry) => entry.name === "beta")!;
    assert.equal(beta.status, "failed");
    assert.equal(beta.error, "invalid-encoding");

    const missing = catalog.projects.find((entry) => entry.name === "missing")!;
    assert.equal(missing.status, "failed");
    assert.equal(missing.error, "unavailable");
    assert.equal(missing.path, join(f.missing, ".vela", "MEMORY.md"));

    assert.equal(catalog.workspaces.find((entry) => entry.workspace === f.missing)?.available, false);
    assert.equal(catalog.workspaces.find((entry) => entry.workspace === f.beta)?.available, true);
    assert.equal(catalog.currentProject, f.beta);
    assert.equal(value(await f.request("list", { conversationId: "chat-none" }) as MemoryResult<MemoryCatalog>).currentProject, null);
  });

  it("读取缺失文件后保存创建文件，冲突保留外部内容", async (t) => {
    const f = fixture(t);
    const missing = value(
      await f.request("read", { scope: "project", workspace: f.alpha }) as MemoryResult<MemoryDocument>,
    );
    assert.equal(missing.exists, false);
    assert.equal(missing.revision, "absent");

    const saved = value(
      await f.request("save", { scope: "project", workspace: f.alpha, content: "hello\n", expectedRevision: "absent" }) as MemoryResult<MemoryDocument>,
    );
    assert.equal(saved.exists, true);
    assert.equal(saved.content, "hello\n");
    assert.equal(readFileSync(projectFile(f.alpha), "utf8"), "hello\n");

    writeFileSync(projectFile(f.alpha), "external\n");
    const conflict = failure(
      await f.request("save", { scope: "project", workspace: f.alpha, content: "mine\n", expectedRevision: saved.revision }) as MemoryResult<MemoryDocument>,
    );
    assert.equal(conflict.code, "conflict");
    assert.equal(readFileSync(projectFile(f.alpha), "utf8"), "external\n");

    const fresh = value(
      await f.request("read", { scope: "project", workspace: f.alpha }) as MemoryResult<MemoryDocument>,
    );
    assert.equal(fresh.content, "external\n");
    const updated = value(
      await f.request("save", { scope: "project", workspace: f.alpha, content: "merged\n", expectedRevision: fresh.revision }) as MemoryResult<MemoryDocument>,
    );
    assert.equal(updated.content, "merged\n");
  });

  it("全局记忆首次保存才创建资料目录，删除需要当前版本", async (t) => {
    const f = fixture(t);
    const saved = value(
      await f.request("save", { scope: "global", content: "global\n", expectedRevision: "absent" }) as MemoryResult<MemoryDocument>,
    );
    assert.equal(readFileSync(join(f.agentDir, "MEMORY.md"), "utf8"), "global\n");

    const conflict = failure(
      await f.request("remove", { scope: "global", expectedRevision: "absent" }) as MemoryResult<null>,
    );
    assert.equal(conflict.code, "conflict");
    assert.equal(readFileSync(join(f.agentDir, "MEMORY.md"), "utf8"), "global\n");

    assert.equal(value(await f.request("remove", { scope: "global", expectedRevision: saved.revision }) as MemoryResult<null>), null);
    assert.equal(existsSync(join(f.agentDir, "MEMORY.md")), false);
    const absent = value(
      await f.request("read", { scope: "global" }) as MemoryResult<MemoryDocument>,
    );
    assert.equal(absent.revision, "absent");
  });

  it("拒绝未登记工作区和任意路径，不产生副作用", async (t) => {
    const f = fixture(t);
    const unregistered = failure(
      await f.request("read", { scope: "project", workspace: f.root }) as MemoryResult<MemoryDocument>,
    );
    assert.equal(unregistered.code, "invalid-target");

    const oversized = failure(
      await f.request("save", { scope: "project", workspace: f.alpha, content: "x".repeat(memoryFileMaxBytes + 1), expectedRevision: "absent" }) as MemoryResult<MemoryDocument>,
    );
    assert.equal(oversized.code, "content-too-large");
    assert.equal(existsSync(join(f.alpha, ".vela")), false);

    const wrongShape = failure(
      await f.request("read", { scope: "global", workspace: f.alpha }) as MemoryResult<MemoryDocument>,
    );
    assert.equal(wrongShape.code, "invalid-target");
  });
});
