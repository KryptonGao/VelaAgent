import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { runGit } from "../src/git-run.ts";

// 源码内部使用无扩展名导入(tsc/bundler 解析),node --experimental-strip-types
// 需要显式扩展名;这里注册一个只影响本测试进程的解析钩子。
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && !specifier.endsWith(".ts") && !specifier.endsWith(".js")) {
      try {
        return nextResolve(`${specifier}.ts`, context);
      } catch {
        // 回退到默认解析
      }
    }
    return nextResolve(specifier, context);
  },
});

const { GitService } = await import("../src/git-service.ts");
const { listTags, createTag, deleteTag, getReleaseNotesScope } = await import("../src/git-tag-release.ts");

const tempDirs: string[] = [];

after(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await runGit(cwd, args);
  assert.equal(result.code, 0, `git ${args.join(" ")} 失败: ${result.stderr}`);
  return result.stdout;
}

async function createTempDir(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

async function createRepo(): Promise<string> {
  const root = await createTempDir("vela-p2-repo-");
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.name", "Vela Test"]);
  await git(root, ["config", "user.email", "test@vela.local"]);
  await git(root, ["config", "commit.gpgsign", "false"]);
  return root;
}

async function createBareRepo(): Promise<string> {
  const root = await createTempDir("vela-p2-bare-");
  await git(root, ["init", "--bare", "-b", "main"]);
  return root;
}

async function writeRepoFile(root: string, relativePath: string, content: string): Promise<void> {
  const full = join(root, relativePath);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content);
}

async function commitFile(
  root: string,
  relativePath: string,
  content: string,
  message: string,
): Promise<string> {
  await writeRepoFile(root, relativePath, content);
  await git(root, ["add", "--", relativePath]);
  await git(root, ["commit", "-q", "-m", message]);
  return (await git(root, ["rev-parse", "HEAD"])).trim();
}

async function head(root: string): Promise<string> {
  return (await git(root, ["rev-parse", "HEAD"])).trim();
}

async function subject(root: string, ref = "HEAD"): Promise<string> {
  return (await git(root, ["log", "-1", "--format=%s", ref])).trim();
}

async function withService<T>(
  root: string,
  task: (service: InstanceType<typeof GitService>) => Promise<T>,
): Promise<T> {
  const service = new GitService();
  try {
    await service.attach(root);
    return await task(service);
  } finally {
    await service.attach(null);
  }
}

/** 克隆一个本地仓库并在其中提交,用于验证同步与强推。 */
async function cloneRepo(bare: string, prefix: string): Promise<string> {
  const dir = await createTempDir(prefix);
  await git(dir, ["clone", bare, "."]);
  await git(dir, ["config", "user.name", "Vela Test"]);
  await git(dir, ["config", "user.email", "test@vela.local"]);
  await git(dir, ["config", "commit.gpgsign", "false"]);
  return dir;
}

describe("createBranchAt (HI-02)", () => {
  it("从历史提交创建分支且不改变 HEAD 与未提交内容", async () => {
    const root = await createRepo();
    const first = await commitFile(root, "a.txt", "one\n", "first");
    await commitFile(root, "a.txt", "two\n", "second");
    await writeRepoFile(root, "a.txt", "dirty\n");

    await withService(root, async (service) => {
      const before = await head(root);
      const result = await service.createBranchAt({ name: "from-first", startPoint: first, checkout: false });
      assert.equal(result.ok, true);
      assert.equal(result.checkedOut, false);
      assert.equal(result.currentHead, before);
      assert.equal(result.worktreeUntouched, true);
      assert.equal(result.changeCount, 1);

      const branchSha = (await git(root, ["rev-parse", "from-first"])).trim();
      assert.equal(branchSha, first);
      assert.equal(await head(root), before);
      const status = await git(root, ["status", "--porcelain"]);
      assert.match(status, /a\.txt/, "未提交改动必须保留");
    });
  });

  it("分支已存在时拒绝创建", async () => {
    const root = await createRepo();
    const first = await commitFile(root, "a.txt", "one\n", "first");
    await withService(root, async (service) => {
      await service.createBranchAt({ name: "dup", startPoint: first, checkout: false });
      await assert.rejects(() => service.createBranchAt({ name: "dup", startPoint: first, checkout: false }));
    });
  });
});

describe("revert / cherry-pick (HI-03/HI-04)", () => {
  it("revert 预览显示范围并创建撤销提交", async () => {
    const root = await createRepo();
    await commitFile(root, "a.txt", "one\n", "first");
    const target = await commitFile(root, "a.txt", "two\n", "second");

    await withService(root, async (service) => {
      const preview = await service.previewHistoryOp({ action: "revert", sha: target, mainline: null });
      assert.equal(preview.ok, true);
      assert.equal(preview.fileCount, 1);
      assert.equal(preview.files[0]?.path, "a.txt");
      assert.equal(preview.alreadyApplied, false);

      const result = await service.runHistoryOp({ action: "revert", sha: target, mainline: null });
      assert.equal(result.ok, true, result.message);
      assert.notEqual(result.sha, target);
      assert.equal((await readFile(join(root, "a.txt"), "utf8")), "one\n");
      assert.match(await subject(root), /^Revert/);

      const again = await service.previewHistoryOp({ action: "revert", sha: target, mainline: null });
      assert.equal(again.alreadyApplied, true, "已存在撤销提交时应标记");
    });
  });

  it("cherry-pick 把提交拣选到当前分支", async () => {
    const root = await createRepo();
    await commitFile(root, "base.txt", "base\n", "base");
    await git(root, ["checkout", "-q", "-b", "feature"]);
    const picked = await commitFile(root, "feature.txt", "feature\n", "add feature");
    await git(root, ["checkout", "-q", "main"]);

    await withService(root, async (service) => {
      const preview = await service.previewHistoryOp({ action: "cherry-pick", sha: picked, mainline: null });
      assert.equal(preview.ok, true);
      assert.equal(preview.files[0]?.path, "feature.txt");

      const result = await service.runHistoryOp({ action: "cherry-pick", sha: picked, mainline: null });
      assert.equal(result.ok, true, result.message);
      assert.equal(await subject(root), "add feature");
      assert.equal((await readFile(join(root, "feature.txt"), "utf8")), "feature\n");
    });
  });

  it("cherry-pick 冲突时保留可继续或中止的操作状态", async () => {
    const root = await createRepo();
    await commitFile(root, "a.txt", "base\n", "base");
    await git(root, ["checkout", "-q", "-b", "feature"]);
    const picked = await commitFile(root, "a.txt", "from feature\n", "feature change");
    await git(root, ["checkout", "-q", "main"]);
    await commitFile(root, "a.txt", "from main\n", "main change");

    await withService(root, async (service) => {
      const result = await service.runHistoryOp({ action: "cherry-pick", sha: picked, mainline: null });
      assert.equal(result.ok, false);
      assert.equal(result.conflicted, true);
      assert.ok(result.conflictedPaths.includes("a.txt"));
      assert.equal(result.operation?.kind, "cherry-pick");

      const aborted = await service.controlOperation("abort");
      assert.equal(aborted.ok, true, aborted.message);
      assert.equal((await readFile(join(root, "a.txt"), "utf8")), "from main\n");
    });
  });

  it("revert 合并提交时必须选择父提交", async () => {
    const root = await createRepo();
    await commitFile(root, "a.txt", "base\n", "base");
    await git(root, ["checkout", "-q", "-b", "side"]);
    await commitFile(root, "side.txt", "side\n", "side");
    await git(root, ["checkout", "-q", "main"]);
    await commitFile(root, "main.txt", "main\n", "main");
    await git(root, ["merge", "--no-ff", "-q", "-m", "merge side", "side"]);
    const mergeSha = await head(root);

    await withService(root, async (service) => {
      const preview = await service.previewHistoryOp({ action: "revert", sha: mergeSha, mainline: null });
      assert.equal(preview.ok, false);
      assert.match(preview.reason ?? "", /合并提交/);

      const withMainline = await service.previewHistoryOp({ action: "revert", sha: mergeSha, mainline: 1 });
      assert.equal(withMainline.ok, true);
      assert.equal(withMainline.isMerge, true);
      assert.equal(withMainline.parents.length, 2);

      const result = await service.runHistoryOp({ action: "revert", sha: mergeSha, mainline: 1 });
      assert.equal(result.ok, true, result.message);
    });
  });
});

describe("fixup / squash (CT-06)", () => {
  it("fixup 把提交并入目标并重放后续提交", async () => {
    const root = await createRepo();
    await commitFile(root, "a.txt", "base\n", "base");
    const target = await commitFile(root, "b.txt", "b\n", "add b");
    const source = await commitFile(root, "c.txt", "c\n", "add c");

    await withService(root, async (service) => {
      const preview = await service.previewRewrite({ action: "fixup", sourceSha: source, targetSha: target });
      assert.equal(preview.ok, true, preview.reason ?? preview.error ?? "");
      assert.equal(preview.rewrittenCount, 2);
      assert.equal(preview.pushedCount, 0);
      assert.equal(preview.dirty, false);

      const before = Number.parseInt((await git(root, ["rev-list", "--count", "HEAD"])).trim(), 10);
      const result = await service.runRewrite({ action: "fixup", sourceSha: source, targetSha: target });
      assert.equal(result.ok, true, result.message);
      const after = Number.parseInt((await git(root, ["rev-list", "--count", "HEAD"])).trim(), 10);
      assert.equal(after, before - 1);
      assert.equal(await subject(root), "add b");
      assert.equal((await readFile(join(root, "c.txt"), "utf8")), "c\n");
      assert.equal(result.pushedCount, 0);
    });
  });

  it("squash 支持自定义提交信息,并重放 source 之后的提交", async () => {
    const root = await createRepo();
    await commitFile(root, "a.txt", "base\n", "base");
    const target = await commitFile(root, "b.txt", "b\n", "add b");
    const source = await commitFile(root, "c.txt", "c\n", "add c");
    const later = await commitFile(root, "d.txt", "d\n", "add d");

    await withService(root, async (service) => {
      const result = await service.runRewrite({
        action: "squash",
        sourceSha: source,
        targetSha: target,
        message: "b and c together",
      });
      assert.equal(result.ok, true, result.message);
      const log = await git(root, ["log", "--format=%s", "-n", "3"]);
      const lines = log.split("\n").filter(Boolean);
      assert.equal(lines[0], "add d", "source 之后的提交必须重放");
      assert.equal(lines[1], "b and c together");
      const rewrittenTarget = (await git(root, ["rev-parse", "HEAD~1"])).trim();
      assert.notEqual(rewrittenTarget, target);
      assert.ok(later !== (await head(root)));
      assert.equal((await readFile(join(root, "c.txt"), "utf8")), "c\n");
    });
  });

  it("工作区不干净或有分叉时拒绝整理", async () => {
    const root = await createRepo();
    await commitFile(root, "a.txt", "base\n", "base");
    const target = await commitFile(root, "b.txt", "b\n", "add b");
    const source = await commitFile(root, "c.txt", "c\n", "add c");
    // 已跟踪文件的未提交改动必须阻止整理历史。
    await writeRepoFile(root, "a.txt", "dirty\n");

    await withService(root, async (service) => {
      const preview = await service.previewRewrite({ action: "fixup", sourceSha: source, targetSha: target });
      assert.equal(preview.ok, false);
      assert.equal(preview.dirty, true);
      const result = await service.runRewrite({ action: "fixup", sourceSha: source, targetSha: target });
      assert.equal(result.ok, false);
      assert.equal(await head(root), source, "历史必须保持不变");
    });
  });

  it("包含已推送提交时报告需要另行同步", async () => {
    const bare = await createBareRepo();
    const root = await createRepo();
    await git(root, ["remote", "add", "origin", bare]);
    await commitFile(root, "a.txt", "base\n", "base");
    const target = await commitFile(root, "b.txt", "b\n", "add b");
    await git(root, ["push", "-q", "-u", "origin", "main"]);
    const source = await commitFile(root, "c.txt", "c\n", "add c");

    await withService(root, async (service) => {
      const preview = await service.previewRewrite({ action: "fixup", sourceSha: source, targetSha: target });
      assert.equal(preview.ok, true);
      assert.equal(preview.pushedCount, 1, "目标提交已推送,重写需要另行同步");
      const result = await service.runRewrite({ action: "fixup", sourceSha: source, targetSha: target });
      assert.equal(result.ok, true);
      assert.equal(result.pushedCount, 1);
      assert.match(result.message, /强推/);
    });
  });
});

describe("reflog 与恢复 (HI-06)", () => {
  it("列出 Reflog 并标注可达性与引用", async () => {
    const root = await createRepo();
    await commitFile(root, "a.txt", "one\n", "first");
    const second = await commitFile(root, "a.txt", "two\n", "second");
    await commitFile(root, "a.txt", "three\n", "third");
    await git(root, ["reset", "-q", "--hard", "HEAD~1"]);

    await withService(root, async (service) => {
      const snapshot = await service.reflog({ limit: 20 });
      assert.equal(snapshot.error, null);
      assert.ok(snapshot.entries.length >= 3);
      const third = snapshot.entries.find((entry) => entry.message.includes("third"));
      assert.ok(third, "应该能找到被 reset 掉的提交");
      assert.equal(third.reachable, false);
      assert.equal(third.id.startsWith("HEAD@{"), true);

      const current = snapshot.entries.find((entry) => entry.current);
      assert.equal(current?.sha, second);
      assert.equal(current?.reachable, true);
    });
  });

  it("恢复为分支时不移动当前引用", async () => {
    const root = await createRepo();
    await commitFile(root, "a.txt", "one\n", "first");
    await commitFile(root, "a.txt", "two\n", "second");
    const third = await commitFile(root, "a.txt", "three\n", "third");
    await git(root, ["reset", "-q", "--hard", "HEAD~1"]);
    const before = await head(root);

    await withService(root, async (service) => {
      const snapshot = await service.reflog({ limit: 10 });
      const entry = snapshot.entries.find((item) => item.sha === third);
      assert.ok(entry);

      const preview = await service.previewRecovery({
        target: entry.id,
        mode: "branch",
        branchName: "recovered",
      });
      assert.equal(preview.ok, true, preview.reason ?? preview.error ?? "");
      assert.equal(preview.requiresConfirm, false);
      assert.match(preview.keepNote, /不会改变/);

      const result = await service.runRecovery({ target: entry.id, mode: "branch", branchName: "recovered" });
      assert.equal(result.ok, true, result.message);
      assert.equal(result.createdBranch, "recovered");
      assert.equal(await head(root), before, "当前分支不能被移动");
      assert.equal((await git(root, ["rev-parse", "recovered"])).trim(), third);
    });
  });

  it("reset-soft 恢复把被丢弃提交的改动保留在索引", async () => {
    const root = await createRepo();
    await commitFile(root, "a.txt", "one\n", "first");
    const second = await commitFile(root, "a.txt", "two\n", "second");
    await commitFile(root, "a.txt", "three\n", "third");

    await withService(root, async (service) => {
      const preview = await service.previewRecovery({
        target: second,
        mode: "reset-soft",
        branchName: null,
      });
      assert.equal(preview.ok, true, preview.reason ?? preview.error ?? "");
      assert.equal(preview.requiresConfirm, true);
      assert.equal(preview.discarded.length, 1);
      assert.match(preview.keepNote, /索引/);

      const result = await service.runRecovery({ target: second, mode: "reset-soft", branchName: null });
      assert.equal(result.ok, true, result.message);
      assert.equal(await head(root), second);
      const staged = await git(root, ["diff", "--cached", "--name-only"]);
      assert.match(staged, /a\.txt/, "改动应保留在索引中");
    });
  });

  it("分支模式要求新分支名且不能重名", async () => {
    const root = await createRepo();
    const first = await commitFile(root, "a.txt", "one\n", "first");
    await withService(root, async (service) => {
      const missing = await service.previewRecovery({ target: first, mode: "branch", branchName: null });
      assert.equal(missing.ok, false);
      await service.createBranchAt({ name: "taken", startPoint: first, checkout: false });
      const taken = await service.previewRecovery({ target: first, mode: "branch", branchName: "taken" });
      assert.equal(taken.ok, false);
      assert.match(taken.reason ?? "", /已经存在/);
    });
  });
});

describe("同步策略 (SY-03)", () => {
  it("ff-only 在分叉时停止,merge 策略生成合并提交", async () => {
    const bare = await createBareRepo();
    const origin = await cloneRepo(bare, "vela-p2-origin-");
    await commitFile(origin, "a.txt", "base\n", "base");
    await git(origin, ["push", "-q", "-u", "origin", "main"]);

    const local = await cloneRepo(bare, "vela-p2-local-");
    await commitFile(origin, "remote.txt", "remote\n", "remote change");
    await git(origin, ["push", "-q", "origin", "main"]);
    await commitFile(local, "local.txt", "local\n", "local change");

    await withService(local, async (service) => {
      const ff = await service.pullWithStrategy({ strategy: "ff-only" });
      assert.equal(ff.outcome, "diverged");
      assert.equal(ff.ok, false);
      assert.equal(ff.strategy, "ff-only");

      const merged = await service.pullWithStrategy({ strategy: "merge" });
      assert.equal(merged.ok, true, merged.message);
      assert.equal(merged.outcome, "merged");
      const parents = (await git(local, ["log", "-1", "--format=%P"])).trim().split(" ");
      assert.equal(parents.length, 2, "merge 策略应生成合并提交");
    });
  });

  it("rebase 策略把本地提交重放到上游之上", async () => {
    const bare = await createBareRepo();
    const origin = await cloneRepo(bare, "vela-p2-origin2-");
    await commitFile(origin, "a.txt", "base\n", "base");
    await git(origin, ["push", "-q", "-u", "origin", "main"]);

    const local = await cloneRepo(bare, "vela-p2-local2-");
    await commitFile(origin, "remote.txt", "remote\n", "remote change");
    await git(origin, ["push", "-q", "origin", "main"]);
    await commitFile(local, "local.txt", "local\n", "local change");

    await withService(local, async (service) => {
      const rebased = await service.pullWithStrategy({ strategy: "rebase" });
      assert.equal(rebased.ok, true, rebased.message);
      assert.equal(rebased.outcome, "rebased");
      const log = await git(local, ["log", "--format=%s", "-n", "2"]);
      const lines = log.split("\n").filter(Boolean);
      assert.equal(lines[0], "local change");
      assert.equal(lines[1], "remote change");
      assert.equal((await git(local, ["log", "-1", "--format=%P"])).trim().split(" ").length, 1);
    });
  });

  it("工作区不干净时停止且不改用其他策略", async () => {
    const bare = await createBareRepo();
    const origin = await cloneRepo(bare, "vela-p2-origin3-");
    await commitFile(origin, "a.txt", "base\n", "base");
    await git(origin, ["push", "-q", "-u", "origin", "main"]);

    const local = await cloneRepo(bare, "vela-p2-local3-");
    await commitFile(origin, "remote.txt", "remote\n", "remote change");
    await git(origin, ["push", "-q", "origin", "main"]);
    await writeRepoFile(local, "a.txt", "dirty\n");

    await withService(local, async (service) => {
      const result = await service.pullWithStrategy({ strategy: "rebase" });
      assert.equal(result.outcome, "dirty");
      assert.equal(result.ok, false);
      assert.match(result.message, /Stash/);
      const status = await git(local, ["status", "--porcelain"]);
      assert.match(status, /a\.txt/);
    });
  });
});

describe("安全强推 (SY-04)", () => {
  it("预览列出会被覆盖的提交,核对过的远程引用可以推送", async () => {
    const bare = await createBareRepo();
    const local = await cloneRepo(bare, "vela-p2-force-");
    await commitFile(local, "a.txt", "one\n", "first");
    await git(local, ["push", "-q", "-u", "origin", "main"]);
    await commitFile(local, "a.txt", "two\n", "second");
    await git(local, ["push", "-q", "origin", "main"]);
    await git(local, ["commit", "-q", "--amend", "-m", "second rewritten"]);

    await withService(local, async (service) => {
      const preview = await service.previewForcePush("origin", "main");
      assert.equal(preview.ok, true);
      assert.equal(preview.fastForward, false);
      assert.equal(preview.overwritten.length, 1);
      assert.equal(preview.ahead.length, 1);
      assert.match(preview.message, /覆盖/);

      const stale = await service.forcePush({
        remote: "origin",
        branch: "main",
        expectedRemoteSha: "0".repeat(40),
      });
      assert.equal(stale.ok, false);
      assert.equal(stale.stale, true, "远程引用不一致时必须拒绝覆盖");

      const pushed = await service.forcePush({
        remote: "origin",
        branch: "main",
        expectedRemoteSha: preview.remoteSha ?? "",
      });
      assert.equal(pushed.ok, true, pushed.message);
      const remoteHead = (await git(bare, ["rev-parse", "main"])).trim();
      assert.equal(remoteHead, await head(local));
    });
  });

  it("远程在预览之后变化时拒绝覆盖", async () => {
    const bare = await createBareRepo();
    const local = await cloneRepo(bare, "vela-p2-force2-");
    const other = await cloneRepo(bare, "vela-p2-force-other-");
    await commitFile(local, "a.txt", "one\n", "first");
    await git(local, ["push", "-q", "-u", "origin", "main"]);

    await withService(local, async (service) => {
      const preview = await service.previewForcePush("origin", "main");
      assert.equal(preview.ok, true);
      // 另一个克隆在预览之后推送了新的提交。
      await git(other, ["fetch", "-q", "origin"]);
      await git(other, ["reset", "-q", "--hard", "origin/main"]);
      await commitFile(other, "b.txt", "other\n", "other change");
      await git(other, ["push", "-q", "origin", "main"]);

      const result = await service.forcePush({
        remote: "origin",
        branch: "main",
        expectedRemoteSha: preview.remoteSha ?? "",
      });
      assert.equal(result.ok, false);
      assert.equal(result.stale, true);
      assert.match(result.message, /已经变化|不存在/);
      assert.equal((await git(bare, ["log", "-1", "--format=%s", "main"])).trim(), "other change");
    });
  });
});

describe("Tag 与发布区间 (RL-01/AI-12)", () => {
  it("创建标签并识别推送状态", async () => {
    const bare = await createBareRepo();
    const root = await createRepo();
    await git(root, ["remote", "add", "origin", bare]);
    await commitFile(root, "a.txt", "one\n", "first");

    const created = await createTag(root, {
      name: "v1.0.0",
      target: null,
      message: "first release",
      push: true,
      remote: "origin",
    });
    assert.equal(created.ok, true, created.message);
    assert.equal(created.pushed, true);
    assert.equal(created.tag?.annotated, true);
    assert.equal(created.tag?.pushed, true);

    const lightweight = await createTag(root, {
      name: "v0.9.0",
      target: null,
      message: null,
      push: false,
      remote: null,
    });
    assert.equal(lightweight.ok, true, lightweight.message);
    assert.equal(lightweight.tag?.annotated, false);
    assert.equal(lightweight.tag?.pushed, false);

    const listed = await listTags(root);
    assert.equal(listed.ok, true);
    assert.equal(listed.total, 2);
    assert.equal(listed.tags.find((tag) => tag.name === "v1.0.0")?.remotes.includes("origin"), true);

    const duplicate = await createTag(root, { name: "v1.0.0", target: null });
    assert.equal(duplicate.ok, false);
    assert.match(duplicate.message, /已经存在/);

    // 删除远程标签后推送状态应变为未推送。
    await git(root, ["push", "-q", "origin", ":refs/tags/v1.0.0"]);
    const afterRemoteDelete = await listTags(root);
    assert.equal(afterRemoteDelete.tags.find((tag) => tag.name === "v1.0.0")?.pushed, false);

    const deleted = await deleteTag(root, "v0.9.0", null);
    assert.equal(deleted.ok, true, deleted.message);
    assert.equal((await listTags(root)).tags.some((tag) => tag.name === "v0.9.0"), false);
  });

  it("发布说明区间只覆盖指定版本", async () => {
    const root = await createRepo();
    const first = await commitFile(root, "a.txt", "one\n", "first");
    await createTag(root, { name: "v1.0.0", target: first, message: "release one", push: false });
    await commitFile(root, "b.txt", "two\n", "second");
    const third = await commitFile(root, "c.txt", "three\n", "third");

    const scope = await getReleaseNotesScope(root, "v1.0.0", "HEAD");
    assert.equal(scope.error, null);
    assert.equal(scope.baseTag, "v1.0.0");
    assert.equal(scope.baseSha, first);
    assert.equal(scope.headSha, third);
    assert.equal(scope.commitCount, 2);
    assert.deepEqual(
      scope.commits.map((commit) => commit.subject).sort(),
      ["second", "third"],
    );
    assert.equal(scope.contributors.includes("Vela Test"), true);
    assert.equal(scope.diffTruncated, false);
    assert.match(scope.diff, /c\.txt/);
  });

  it("版本区间起点不存在时返回明确错误", async () => {
    const root = await createRepo();
    await commitFile(root, "a.txt", "one\n", "first");
    const scope = await getReleaseNotesScope(root, "v9.9.9", "HEAD");
    assert.match(scope.error ?? "", /找不到版本区间起点/);
    assert.equal(scope.commitCount, 0);
  });
});
