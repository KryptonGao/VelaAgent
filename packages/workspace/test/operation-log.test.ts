import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { GitOperationLog } from "../src/operation-log.ts";

const tempDirs: string[] = [];

after(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

async function createLogPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vela-oplog-"));
  tempDirs.push(dir);
  return join(dir, "git-operations.json");
}

describe("GitOperationLog", () => {
  it("running 记录在重新初始化后变为 unconfirmed", async () => {
    const filePath = await createLogPath();
    const log = new GitOperationLog(filePath);
    await log.init();
    const record = log.begin({
      type: "push",
      workspace: "/workspace/a",
      repoRoot: "/workspace/a",
      branch: "main",
      expectedHead: "abc123",
      steps: [{ id: "push", label: "推送" }],
    });
    assert.equal(record.status, "running");
    assert.equal(record.steps[0]?.status, "pending");

    const reloaded = new GitOperationLog(filePath);
    await reloaded.init();
    const loaded = reloaded.get(record.id);
    assert.equal(loaded?.status, "unconfirmed");
    assert.equal(loaded?.error, "应用在操作完成前退出，结果需要核对");
    assert.equal(typeof loaded?.completedAt, "number");
  });

  it("snapshot 按工作区过滤并区分 running 与最近完成", async () => {
    const log = new GitOperationLog(null);
    await log.init();
    const first = log.begin({
      type: "commit",
      workspace: "/w1",
      repoRoot: "/w1",
      branch: "main",
      expectedHead: null,
      steps: [],
    });
    const second = log.begin({
      type: "push",
      workspace: "/w2",
      repoRoot: "/w2",
      branch: "dev",
      expectedHead: null,
      steps: [],
    });
    log.finish(first.id, { status: "success", resultSha: "sha1" });

    const all = log.snapshot(null);
    assert.equal(all.running.length, 1);
    assert.equal(all.running[0]?.id, second.id);
    assert.equal(all.recent.length, 1);
    assert.equal(all.recent[0]?.resultSha, "sha1");

    const w1 = log.snapshot("/w1");
    assert.equal(w1.running.length, 0);
    assert.equal(w1.recent.length, 1);
    const w2 = log.snapshot("/w2");
    assert.equal(w2.running.length, 1);
    assert.equal(w2.recent.length, 0);
  });

  it("记录数量上限为 200,丢弃最旧的已完成记录", async () => {
    const log = new GitOperationLog(null);
    await log.init();
    const ids: string[] = [];
    for (let index = 0; index < 205; index += 1) {
      const record = log.begin({
        type: "stage",
        workspace: "/w",
        repoRoot: "/w",
        branch: null,
        expectedHead: null,
        steps: [],
      });
      ids.push(record.id);
      log.finish(record.id, { status: "success" });
    }
    assert.equal(log.all().length, 200);
    assert.equal(log.get(ids[0]), null);
    assert.ok(log.get(ids[ids.length - 1]));
  });

  it("损坏的日志文件不会导致初始化失败", async () => {
    const filePath = await createLogPath();
    await writeFile(filePath, "{ not json", "utf8");
    const log = new GitOperationLog(filePath);
    await log.init();
    assert.deepEqual(log.all(), []);
    const record = log.begin({
      type: "fetch",
      workspace: "/w",
      repoRoot: "/w",
      branch: null,
      expectedHead: null,
      steps: [],
    });
    assert.ok(log.get(record.id));
  });

  it("update 持久化 patch,finish 自动补全完成时间", async () => {
    const filePath = await createLogPath();
    const log = new GitOperationLog(filePath);
    await log.init();
    const record = log.begin({
      type: "commit",
      workspace: "/w",
      repoRoot: "/w",
      branch: "main",
      expectedHead: null,
      steps: [{ id: "commit", label: "提交" }],
    });
    const updated = log.update(record.id, {
      steps: [{ id: "commit", label: "提交", status: "success", detail: "done" }],
      resultSha: "deadbeef",
    });
    assert.equal(updated?.resultSha, "deadbeef");
    const finished = log.finish(record.id, { status: "success" });
    assert.equal(finished?.status, "success");
    assert.equal(typeof finished?.completedAt, "number");

    const reloaded = new GitOperationLog(filePath);
    await reloaded.init();
    assert.equal(reloaded.get(record.id)?.status, "success");
    assert.equal(reloaded.get(record.id)?.resultSha, "deadbeef");
  });
});
