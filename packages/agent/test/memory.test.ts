import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { memoryAbsentRevision, memoryFileMaxBytes, type MemoryErrorCode, type MemoryTarget } from "@vela/shared";
import { MemoryError, MemoryService } from "../src/memory.ts";

interface Fixture {
  root: string;
  agentDir: string;
  workspace: string;
  other: string;
  service: MemoryService;
  project: MemoryTarget;
  global: MemoryTarget;
  projectDir: string;
  projectFile: string;
  globalFile: string;
}

async function fixture(t: TestContext): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "vela-memory-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const agentDir = join(root, "profile");
  const workspace = join(root, "project");
  const other = join(root, "other");
  await mkdir(workspace);
  await mkdir(other);
  const projectDir = join(await realpath(workspace), ".vela");
  return {
    root,
    agentDir,
    workspace,
    other,
    service: new MemoryService({ agentDir }),
    project: { scope: "project", workspace },
    global: { scope: "global", workspace: null },
    projectDir,
    projectFile: join(projectDir, "MEMORY.md"),
    globalFile: join(agentDir, "MEMORY.md"),
  };
}

async function expectMemoryError(promise: Promise<unknown>, code: MemoryErrorCode): Promise<MemoryError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof MemoryError, `期望 MemoryError，实际为 ${String(error)}`);
    assert.equal(error.code, code, error.message);
    return error;
  }
  assert.fail(`期望 ${code} 错误，但调用成功了`);
}

describe("记忆存储", () => {
  it("缺失的记忆读取为 missing 且不创建目录或文件", async (t) => {
    const f = await fixture(t);

    const project = await f.service.read(f.project);
    assert.equal(project.exists, false);
    assert.equal(project.content, "");
    assert.equal(project.revision, memoryAbsentRevision);
    assert.equal(project.path, f.projectFile);
    assert.equal(project.workspace, await realpath(f.workspace));

    const global = await f.service.read(f.global);
    assert.equal(global.exists, false);
    assert.equal(global.revision, memoryAbsentRevision);
    assert.equal(global.path, f.globalFile);

    assert.equal(existsSync(f.agentDir), false, "读取全局记忆不应创建资料目录");
    assert.equal(existsSync(f.projectDir), false, "读取项目记忆不应创建 .vela");

    const load = await f.service.load(f.project);
    assert.equal(load.status, "missing");
    assert.equal(load.error, null);
    assert.equal(load.path, f.projectFile);

    // 删除本来就不存在的记忆同样不产生副作用。
    await f.service.remove(f.project, memoryAbsentRevision);
    assert.equal(existsSync(f.projectDir), false);
  });

  it("区分缺失文件和空文件，并能保存与清空内容", async (t) => {
    const f = await fixture(t);

    const empty = await f.service.save(f.project, "", memoryAbsentRevision);
    assert.equal(empty.exists, true);
    assert.equal(empty.content, "");
    assert.notEqual(empty.revision, memoryAbsentRevision);

    const reread = await f.service.read(f.project);
    assert.equal(reread.exists, true);
    assert.equal(reread.content, "");
    assert.equal(reread.revision, empty.revision);

    const load = await f.service.load(f.project);
    assert.equal(load.status, "loaded");
    assert.equal(load.bytes, 0);
    assert.equal(load.revision, empty.revision);

    const next = await f.service.save(f.project, "# 约定\n- 测试命令：pnpm test\n", reread.revision);
    assert.equal(next.content, "# 约定\n- 测试命令：pnpm test\n");
    assert.notEqual(next.revision, reread.revision);
    assert.equal(await readFile(f.projectFile, "utf8"), next.content);

    const cleared = await f.service.save(f.project, "", next.revision);
    assert.equal(cleared.content, "");
    assert.equal(await readFile(f.projectFile, "utf8"), "");
  });

  it("首次保存全局记忆时才创建资料目录", async (t) => {
    const f = await fixture(t);
    await f.service.read(f.global);
    assert.equal(existsSync(f.agentDir), false);

    const document = await f.service.save(f.global, "# 偏好\n- 默认中文回复\n", memoryAbsentRevision);
    assert.equal(document.exists, true);
    assert.equal(document.path, f.globalFile);
    assert.equal(document.workspace, null);
    assert.equal(await readFile(f.globalFile, "utf8"), document.content);
    assert.equal((await f.service.read(f.global)).revision, document.revision);
  });

  it("外部编辑后旧 revision 保存被拒绝，外部内容保留", async (t) => {
    const f = await fixture(t);
    const saved = await f.service.save(f.project, "版本一\n", memoryAbsentRevision);
    await writeFile(f.projectFile, "外部编辑\n", "utf8");

    const error = await expectMemoryError(f.service.save(f.project, "版本二\n", saved.revision), "conflict");
    assert.equal(error.path, f.projectFile);
    assert.equal(await readFile(f.projectFile, "utf8"), "外部编辑\n", "冲突不能覆盖外部内容");

    const current = await f.service.read(f.project);
    assert.equal(current.content, "外部编辑\n");
    assert.notEqual(current.revision, saved.revision);
    assert.equal((await f.service.save(f.project, "版本二\n", current.revision)).content, "版本二\n");
  });

  it("同进程并发写入串行执行，旧版本被拒绝", async (t) => {
    const f = await fixture(t);
    const results = await Promise.allSettled([
      f.service.save(f.project, "A\n", memoryAbsentRevision),
      f.service.save(f.project, "B\n", memoryAbsentRevision),
    ]);
    const fulfilled: string[] = [];
    const failures: unknown[] = [];
    for (const result of results) {
      if (result.status === "fulfilled") fulfilled.push(result.value.content);
      else failures.push(result.reason);
    }
    assert.equal(fulfilled.length, 1);
    assert.equal(failures.length, 1);
    assert.ok(failures[0] instanceof MemoryError);
    assert.equal(failures[0].code, "conflict");
    const content = await readFile(f.projectFile, "utf8");
    assert.equal(content, fulfilled[0]);
    assert.deepEqual((await readdir(f.projectDir)).sort(), ["MEMORY.md"]);
  });

  it("检测到其他进程的锁时返回 busy，并保留锁现场", async (t) => {
    const f = await fixture(t);
    await mkdir(f.projectDir, { recursive: true });
    const lockFile = `${f.projectFile}.lock`;
    await writeFile(lockFile, JSON.stringify({ version: 1, pid: 4242, token: "other", startedAt: "2026-10-05T00:00:00.000Z" }));

    const error = await expectMemoryError(f.service.save(f.project, "新的\n", memoryAbsentRevision), "busy");
    assert.equal(error.path, lockFile);
    assert.match(error.message, /4242/);
    assert.equal(existsSync(f.projectFile), false);
    assert.equal(existsSync(lockFile), true, "不能自动移除异常残留锁");

    await rm(lockFile);
    assert.equal((await f.service.save(f.project, "新的\n", memoryAbsentRevision)).content, "新的\n");
    assert.equal(existsSync(lockFile), false);
  });

  it("删除需要当前 revision，缺失文件用 absent 幂等", async (t) => {
    const f = await fixture(t);
    const saved = await f.service.save(f.project, "待删除\n", memoryAbsentRevision);

    await expectMemoryError(f.service.remove(f.project, memoryAbsentRevision), "conflict");
    assert.equal(existsSync(f.projectFile), true);

    await f.service.remove(f.project, saved.revision);
    assert.equal(existsSync(f.projectFile), false);
    assert.equal((await f.service.read(f.project)).exists, false);

    await expectMemoryError(f.service.remove(f.project, saved.revision), "conflict");
    await f.service.remove(f.project, memoryAbsentRevision);
  });

  it("删除与保存竞争时按串行顺序处理，另一个操作看到最新版本后被拒", async (t) => {
    const f = await fixture(t);
    const saved = await f.service.save(f.project, "初始\n", memoryAbsentRevision);
    const results = await Promise.allSettled([
      f.service.remove(f.project, saved.revision),
      f.service.save(f.project, "并发保存\n", saved.revision),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    assert.equal(fulfilled.length, 1, "两个操作共享同一个 revision，只能有一个成功");
    assert.equal(failures.length, 1);
    assert.equal((failures[0]!.reason as MemoryError).code, "conflict");
    const current = await f.service.read(f.project);
    if (current.exists) assert.equal(current.content, "并发保存\n");
    assert.deepEqual((await readdir(f.projectDir)).sort(), current.exists ? ["MEMORY.md"] : [], "不能留下临时文件或锁");
  });

  it("按 UTF-8 字节限制拒绝超限内容且保留原文件", async (t) => {
    const f = await fixture(t);
    const exact = await f.service.save(f.project, "a".repeat(memoryFileMaxBytes), memoryAbsentRevision);
    assert.equal(exact.content.length, memoryFileMaxBytes);

    const error = await expectMemoryError(
      f.service.save(f.project, "b".repeat(memoryFileMaxBytes + 1), exact.revision),
      "content-too-large",
    );
    assert.equal(error.path, null);
    assert.equal((await readFile(f.projectFile, "utf8")).length, memoryFileMaxBytes);

    // 多字节字符按字节而不是字符计数。
    const multibyte = "记".repeat(Math.floor(memoryFileMaxBytes / 3) + 1);
    await expectMemoryError(f.service.save(f.project, multibyte, exact.revision), "content-too-large");
    assert.equal((await readFile(f.projectFile, "utf8")).length, memoryFileMaxBytes);
  });

  it("已有超限文件读取失败并保留现场", async (t) => {
    const f = await fixture(t);
    await mkdir(f.projectDir, { recursive: true });
    await writeFile(f.projectFile, Buffer.from("x".repeat(memoryFileMaxBytes + 1)));

    const error = await expectMemoryError(f.service.read(f.project), "content-too-large");
    assert.equal(error.path, f.projectFile);
    const load = await f.service.load(f.project);
    assert.equal(load.status, "failed");
    assert.equal(load.error, "content-too-large");
    assert.equal(load.revision, null);
    assert.equal((await readFile(f.projectFile)).byteLength, memoryFileMaxBytes + 1);
  });

  it("无效 UTF-8 文件跳过加载并保留内容", async (t) => {
    const f = await fixture(t);
    await mkdir(f.projectDir, { recursive: true });
    await writeFile(f.projectFile, Buffer.from([0xff, 0xfe, 0x00, 0x41]));

    await expectMemoryError(f.service.read(f.project), "invalid-encoding");
    const load = await f.service.load(f.project);
    assert.equal(load.error, "invalid-encoding");
    assert.equal((await readFile(f.projectFile)).byteLength, 4);
  });

  it("保留 UTF-8 BOM，指纹与磁盘内容一致", async (t) => {
    const f = await fixture(t);
    await mkdir(f.projectDir, { recursive: true });
    await writeFile(f.projectFile, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("# 记忆\n", "utf8")]));

    const document = await f.service.read(f.project);
    assert.equal(document.content, "\uFEFF# 记忆\n");
    const saved = await f.service.save(f.project, document.content, document.revision);
    assert.equal(saved.revision, document.revision, "同一内容重新保存不应产生版本变化");
  });

  it("拒绝符号链接和非普通文件", async (t) => {
    const f = await fixture(t);
    const outside = join(f.root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "MEMORY.md"), "外部\n");

    // .vela 是符号链接时不跟随。
    await symlink(outside, f.projectDir, "dir");
    await expectMemoryError(f.service.read(f.project), "unsafe-path");
    await expectMemoryError(f.service.save(f.project, "新的\n", memoryAbsentRevision), "unsafe-path");
    assert.equal(await readFile(join(outside, "MEMORY.md"), "utf8"), "外部\n");
    await rm(f.projectDir);

    // MEMORY.md 是符号链接时同样拒绝。
    await mkdir(f.projectDir);
    await symlink(join(outside, "MEMORY.md"), f.projectFile, "file");
    await expectMemoryError(f.service.read(f.project), "unsafe-path");
    await expectMemoryError(f.service.save(f.project, "新的\n", memoryAbsentRevision), "unsafe-path");
    await expectMemoryError(f.service.remove(f.project, memoryAbsentRevision), "unsafe-path");

    // 目录占位不是普通文件。
    await rm(f.projectFile);
    await mkdir(f.projectFile);
    await expectMemoryError(f.service.read(f.project), "not-a-file");
  });

  it("拒绝无效目标和不可用工作区", async (t) => {
    const f = await fixture(t);

    await expectMemoryError(f.service.read({ scope: "project", workspace: null }), "invalid-target");
    await expectMemoryError(f.service.read({ scope: "project", workspace: "relative/path" }), "invalid-target");
    await expectMemoryError(f.service.read({ scope: "project", workspace: "/" }), "invalid-target");
    await expectMemoryError(f.service.read({ scope: "global", workspace: f.workspace }), "invalid-target");
    await expectMemoryError(f.service.read({ scope: "project", workspace: join(f.root, "missing") }), "unavailable");
    await expectMemoryError(f.service.save(f.project, 42 as unknown as string, memoryAbsentRevision), "invalid-content");
    await expectMemoryError(f.service.save(f.project, "内容", ""), "invalid-content");
    await expectMemoryError(f.service.remove(f.project, ""), "invalid-content");

    const load = await f.service.load({ scope: "project", workspace: join(f.root, "missing") });
    assert.equal(load.status, "failed");
    assert.equal(load.error, "unavailable");
    assert.equal(load.scope, "project");
  });

  it("不同工作区各自读写自己的项目记忆", async (t) => {
    const f = await fixture(t);
    const otherProject: MemoryTarget = { scope: "project", workspace: f.other };
    await f.service.save(f.project, "项目 A\n", memoryAbsentRevision);
    await f.service.save(otherProject, "项目 B\n", memoryAbsentRevision);
    assert.equal((await f.service.read(f.project)).content, "项目 A\n");
    assert.equal((await f.service.read(otherProject)).content, "项目 B\n");
    assert.equal((await f.service.read(f.global)).exists, false);
  });

  it("写入后不留下临时文件和锁", async (t) => {
    const f = await fixture(t);
    const saved = await f.service.save(f.project, "内容\n", memoryAbsentRevision);
    assert.deepEqual((await readdir(f.projectDir)).sort(), ["MEMORY.md"]);

    await expectMemoryError(f.service.save(f.project, "冲突\n", `${saved.revision}-stale`), "conflict");
    assert.deepEqual((await readdir(f.projectDir)).sort(), ["MEMORY.md"]);
    assert.equal(await readFile(f.projectFile, "utf8"), "内容\n");

    await f.service.remove(f.project, saved.revision);
    assert.deepEqual((await readdir(dirname(f.projectFile))).sort(), []);
  });
});
