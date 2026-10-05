import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { memoryFileMaxBytes } from "@vela/shared";
import { MemoryService } from "../src/memory.ts";
import {
  createMemoryTools,
  memoryReadToolName,
  memoryUpdateToolName,
  type MemoryWritePermission,
} from "../src/memory-tools.ts";

interface Fixture {
  root: string;
  agentDir: string;
  workspace: string;
  service: MemoryService;
  projectFile: string;
  globalFile: string;
  requests: Array<{ kind: string; path: string; insideWorkspace: boolean; workspace: string | null }>;
  permission: MemoryWritePermission;
  tools: ToolDefinition[];
}

async function fixture(t: TestContext, options: { enabled?: () => boolean; hasWorkspace?: boolean; allowUpdate?: () => boolean; update?: boolean; allow?: boolean } = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "vela-memory-tools-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const agentDir = join(root, "profile");
  const workspace = join(root, "project");
  await mkdir(workspace);
  const service = new MemoryService({ agentDir });
  const requests: Fixture["requests"] = [];
  const permission: MemoryWritePermission = {
    request: async (input) => {
      requests.push({ kind: input.kind, path: input.path, insideWorkspace: input.insideWorkspace, workspace: input.workspace });
      return options.allow !== false;
    },
  };
  const tools = createMemoryTools({
    service,
    enabled: options.enabled,
    update: options.update,
    allowUpdate: options.allowUpdate,
    permission,
    conversationId: "conversation",
    workspace: () => ({ cwd: workspace, hasWorkspace: options.hasWorkspace !== false }),
  });
  return {
    root,
    agentDir,
    workspace,
    service,
    projectFile: join(workspace, ".vela", "MEMORY.md"),
    globalFile: join(agentDir, "MEMORY.md"),
    requests,
    permission,
    tools,
  };
}

function tool(f: Fixture, name: string): ToolDefinition {
  const found = f.tools.find((value) => value.name === name);
  assert.ok(found, `缺少工具 ${name}`);
  return found;
}

const text = (result: { content: Array<{ type: string; text?: string }> }): string =>
  result.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");

const call = (f: Fixture, name: string, params: unknown, signal?: AbortSignal) =>
  tool(f, name).execute("call", params as never, signal, undefined, {} as never);

describe("memory_read", () => {
  it("读取期间关闭后不返回记忆正文", async (t) => {
    let enabled = true;
    const f = await fixture(t, { enabled: () => enabled });
    await f.service.save({ scope: "global", workspace: null }, "secret\n", "absent");
    const original = f.service.read.bind(f.service);
    f.service.read = async (target) => {
      const document = await original(target);
      enabled = false;
      return document;
    };
    await assert.rejects(call(f, memoryReadToolName, { scope: "global" }), /记忆已关闭/);
  });

  it("原子提交前关闭后拒绝替换，清理临时文件并保留原内容", async (t) => {
    const f = await fixture(t);
    const target = { scope: "project" as const, workspace: f.workspace };
    const original = await f.service.save(target, "original\n", "absent");
    let checks = 0;
    await assert.rejects(f.service.save(target, "changed\n", original.revision, () => {
      if (++checks === 3) throw new Error("记忆已关闭");
    }), /记忆已关闭/);
    assert.equal(await readFile(f.projectFile, "utf8"), "original\n");
    const { readdir } = await import("node:fs/promises");
    assert.deepEqual(await readdir(join(f.workspace, ".vela")), ["MEMORY.md"]);
  });

  it("关闭时直接调用读写工具也失败，且不触发存储和审批", async (t) => {
    const f = await fixture(t, { enabled: () => false });
    let calls = 0;
    f.service.read = async () => { calls++; throw new Error("不应读取"); };
    f.service.save = async () => { calls++; throw new Error("不应保存"); };
    await assert.rejects(call(f, memoryReadToolName, {}), /记忆已关闭/);
    await assert.rejects(call(f, memoryUpdateToolName, { scope: "global", content: "changed", expectedRevision: "absent" }), /记忆已关闭/);
    assert.equal(calls, 0);
    assert.equal(f.requests.length, 0);
  });

  it("等待审批时关闭记忆，审批通过后仍不能保存", async (t) => {
    let enabled = true;
    const f = await fixture(t, { enabled: () => enabled });
    const target = { scope: "project" as const, workspace: f.workspace };
    const original = await f.service.save(target, "original\n", "absent");
    f.permission.request = async () => { enabled = false; return true; };
    await assert.rejects(call(f, memoryUpdateToolName, { scope: "project", content: "changed\n", expectedRevision: original.revision }), /记忆已关闭/);
    assert.equal(await readFile(f.projectFile, "utf8"), "original\n");
  });

  it("读取全局与项目记忆的全文和 revision；缺失文件返回 absent 且不创建文件", async (t) => {
    const f = await fixture(t);
    await f.service.save({ scope: "project", workspace: f.workspace }, "项目约定：测试命令 pnpm test\n", "absent");

    const project = await call(f, memoryReadToolName, { scope: "project" });
    const projectText = text(project);
    assert.match(projectText, /scope: project/);
    assert.match(projectText, /项目约定：测试命令 pnpm test/);
    assert.match(projectText, /revision: sha256:/);

    const missingGlobal = await call(f, memoryReadToolName, { scope: "global" });
    assert.match(text(missingGlobal), /exists: false/);
    assert.match(text(missingGlobal), /revision: absent/);
    assert.equal(existsSync(f.globalFile), false, "读取不能创建全局记忆");
  });

  it("不传 scope 时读取项目与全局；一个来源失败不影响另一个", async (t) => {
    const f = await fixture(t);
    await f.service.save({ scope: "global", workspace: null }, "全局偏好：中文回复\n", "absent");
    await mkdir(join(f.workspace, ".vela"), { recursive: true });
    await writeFile(f.projectFile, Buffer.from("x".repeat(memoryFileMaxBytes + 1)));

    const result = await call(f, memoryReadToolName, {});
    const output = text(result);
    assert.match(output, /scope: global/);
    assert.match(output, /全局偏好：中文回复/);
    assert.match(output, /scope: project/);
    assert.match(output, /status: failed/);
    assert.match(output, /error: content-too-large/);
    // 项目文件超限时保留现场。
    assert.equal((await readFile(f.projectFile)).byteLength, memoryFileMaxBytes + 1);
  });

  it("无工作区会话不能读取项目记忆", async (t) => {
    const f = await fixture(t, { hasWorkspace: false });
    await assert.rejects(call(f, memoryReadToolName, { scope: "project" }), /没有项目工作区/);
  });
});

describe("memory_update", () => {
  it("用户明确要求后创建项目记忆；空内容清空但保留文件", async (t) => {
    const f = await fixture(t);
    const missing = await call(f, memoryReadToolName, { scope: "project" });
    const revision = text(missing).match(/revision: (.+)/)![1]!.trim();

    const saved = await call(f, memoryUpdateToolName, { scope: "project", content: "# 约定\n测试命令 pnpm test\n", expectedRevision: revision });
    assert.match(text(saved), /已保存 project 记忆/);
    assert.equal(await readFile(f.projectFile, "utf8"), "# 约定\n测试命令 pnpm test\n");
    const realWorkspace = await realpath(f.workspace);
    assert.deepEqual(f.requests, [{ kind: "write", path: join(realWorkspace, ".vela", "MEMORY.md"), insideWorkspace: true, workspace: f.workspace }]);

    const current = await call(f, memoryReadToolName, { scope: "project" });
    const currentRevision = text(current).match(/revision: (.+)/)![1]!.trim();
    const cleared = await call(f, memoryUpdateToolName, { scope: "project", content: "", expectedRevision: currentRevision });
    assert.match(text(cleared), /已清空 project 记忆/);
    assert.equal(existsSync(f.projectFile), true, "清空保留空文件，物理删除由界面完成");
    assert.equal(await readFile(f.projectFile, "utf8"), "");
  });

  it("版本冲突时拒绝写入、保留原内容且不请求审批", async (t) => {
    const f = await fixture(t);
    await f.service.save({ scope: "project", workspace: f.workspace }, "原始内容\n", "absent");
    const revision = text(await call(f, memoryReadToolName, { scope: "project" })).match(/revision: (.+)/)![1]!.trim();
    // 外部编辑器改文件造成版本变化。
    await writeFile(f.projectFile, "外部编辑\n", "utf8");

    await assert.rejects(
      call(f, memoryUpdateToolName, { scope: "project", content: "覆盖内容\n", expectedRevision: revision }),
      /\[conflict\]/,
    );
    assert.equal(await readFile(f.projectFile, "utf8"), "外部编辑\n");
    assert.deepEqual(f.requests, [], "冲突在权限审批之前发现，不产生无意义的审批");

    // 重新读取后基于最新内容重新提交才成功。
    const fresh = text(await call(f, memoryReadToolName, { scope: "project" })).match(/revision: (.+)/)![1]!.trim();
    await call(f, memoryUpdateToolName, { scope: "project", content: "外部编辑\n新增约定\n", expectedRevision: fresh });
    assert.equal(await readFile(f.projectFile, "utf8"), "外部编辑\n新增约定\n");
  });

  it("重复自动保存相同内容不请求审批，也不调用存储写入", async (t) => {
    const f = await fixture(t);
    const document = await f.service.save({ scope: "project", workspace: f.workspace }, "# 约定\n使用 pnpm\n", "absent");
    let saves = 0;
    const tools = createMemoryTools({
      service: { read: (target) => f.service.read(target), save: async () => { saves++; throw new Error("不应写入"); } },
      workspace: () => ({ cwd: f.workspace, hasWorkspace: true }),
      permission: f.permission,
    });
    const update = tools.find((value) => value.name === memoryUpdateToolName)!;
    const result = await update.execute("same", {
      scope: "project", content: document.content, expectedRevision: document.revision,
    } as never, undefined, undefined, {} as never);
    assert.match(text(result), /内容未变化/);
    assert.equal((result.details as { changed: boolean }).changed, false);
    assert.equal(saves, 0);
    assert.deepEqual(f.requests, []);
    assert.equal(await readFile(f.projectFile, "utf8"), document.content);
  });

  it("缺失文件的空内容保存仍创建文件，区别于内容未变化", async (t) => {
    const f = await fixture(t);
    const result = await call(f, memoryUpdateToolName, { scope: "project", content: "", expectedRevision: "absent" });
    assert.equal((result.details as { changed: boolean }).changed, true);
    assert.equal(await readFile(f.projectFile, "utf8"), "");
    assert.equal(f.requests.length, 1);
  });

  it("审批期间进入只读模式后停止写入", async (t) => {
    const f = await fixture(t);
    let allowUpdate = true;
    const tools = createMemoryTools({
      service: f.service,
      workspace: () => ({ cwd: f.workspace, hasWorkspace: true }),
      allowUpdate: () => allowUpdate,
      permission: { request: async () => { allowUpdate = false; return true; } },
    });
    const update = tools.find((value) => value.name === memoryUpdateToolName)!;
    await assert.rejects(update.execute("mode-switch", {
      scope: "project", content: "使用 pnpm\n", expectedRevision: "absent",
    } as never, undefined, undefined, {} as never), /不允许写入长期记忆/);
    assert.equal(existsSync(join(f.workspace, ".vela")), false);
  });

  it("审批期间外部修改文件时不覆盖，即使用户批准", async (t) => {
    const f = await fixture(t);
    const document = await f.service.save({ scope: "project", workspace: f.workspace }, "已有约定\n", "absent");
    const tools = createMemoryTools({
      service: f.service,
      workspace: () => ({ cwd: f.workspace, hasWorkspace: true }),
      permission: { request: async () => { await writeFile(f.projectFile, "外部新约定\n"); return true; } },
    });
    const update = tools.find((value) => value.name === memoryUpdateToolName)!;
    await assert.rejects(update.execute("external-edit", {
      scope: "project", content: "已有约定\n自动提炼的约定\n", expectedRevision: document.revision,
    } as never, undefined, undefined, {} as never), /\[conflict\]/);
    assert.equal(await readFile(f.projectFile, "utf8"), "外部新约定\n");
  });

  it("用户拒绝后没有文件副作用", async (t) => {
    const f = await fixture(t, { allow: false });
    await assert.rejects(
      call(f, memoryUpdateToolName, { scope: "project", content: "不应写入\n", expectedRevision: "absent" }),
      /拒绝/,
    );
    assert.equal(existsSync(f.projectFile), false);
    assert.equal(existsSync(join(f.workspace, ".vela")), false, "拒绝后不创建 .vela 目录");
  });

  it("没有权限入口时失败关闭，不写文件", async (t) => {
    const f = await fixture(t);
    const tools = createMemoryTools({
      service: f.service,
      update: true,
      workspace: () => ({ cwd: f.workspace, hasWorkspace: true }),
    });
    const update = tools.find((value) => value.name === memoryUpdateToolName)!;
    await assert.rejects(
      update.execute("call", { scope: "global", content: "全局\n", expectedRevision: "absent" } as never, undefined, undefined, {} as never),
      /权限校验/,
    );
    assert.equal(existsSync(f.globalFile), false);
  });

  it("执行环境不允许更新时拒绝，读取仍可用", async (t) => {
    const f = await fixture(t, { allowUpdate: () => false });
    const missing = await call(f, memoryReadToolName, { scope: "project" });
    assert.match(text(missing), /revision: absent/);
    await assert.rejects(
      call(f, memoryUpdateToolName, { scope: "project", content: "不应写入\n", expectedRevision: "absent" }),
      /不允许写入长期记忆/,
    );
    assert.equal(existsSync(f.projectFile), false);
  });

  it("update=false 的子代理只注册 memory_read", async (t) => {
    const f = await fixture(t, { update: false });
    assert.deepEqual(f.tools.map((value) => value.name), [memoryReadToolName]);
  });

  it("超限内容拒绝保存并保留原文件", async (t) => {
    const f = await fixture(t);
    await f.service.save({ scope: "project", workspace: f.workspace }, "原始内容\n", "absent");
    const revision = text(await call(f, memoryReadToolName, { scope: "project" })).match(/revision: (.+)/)![1]!.trim();
    await assert.rejects(
      call(f, memoryUpdateToolName, { scope: "project", content: "x".repeat(memoryFileMaxBytes + 1), expectedRevision: revision }),
      /\[content-too-large\]/,
    );
    assert.equal(await readFile(f.projectFile, "utf8"), "原始内容\n");
  });

  it("全局记忆在工作区之外，权限请求标记为越界", async (t) => {
    const f = await fixture(t);
    await call(f, memoryUpdateToolName, { scope: "global", content: "全局偏好\n", expectedRevision: "absent" });
    assert.deepEqual(f.requests, [{ kind: "write", path: f.globalFile, insideWorkspace: false, workspace: null }]);
    assert.equal(await readFile(f.globalFile, "utf8"), "全局偏好\n");
  });

  it("无工作区会话不能写项目记忆", async (t) => {
    const f = await fixture(t, { hasWorkspace: false });
    await assert.rejects(
      call(f, memoryUpdateToolName, { scope: "project", content: "项目\n", expectedRevision: "absent" }),
      /没有项目工作区/,
    );
    assert.equal(existsSync(join(f.workspace, ".vela")), false);
  });
});
