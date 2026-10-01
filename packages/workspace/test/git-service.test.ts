import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
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

const { GitService, collectStatus } = await import("../src/git-service.ts");

const tempDirs: string[] = [];

after(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await runGit(cwd, args);
  assert.equal(result.code, 0, `git ${args.join(" ")} 失败: ${result.stderr}`);
  return result.stdout;
}

async function gitAllowFailure(cwd: string, args: string[]): Promise<string> {
  const result = await runGit(cwd, args);
  return result.stdout + result.stderr;
}

async function createTempDir(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

async function createRepo(): Promise<string> {
  const root = await createTempDir("vela-git-repo-");
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.name", "Vela Test"]);
  await git(root, ["config", "user.email", "test@vela.local"]);
  return root;
}

async function createBareRepo(): Promise<string> {
  const root = await createTempDir("vela-git-bare-");
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

async function cloneRepo(source: string): Promise<string> {
  const parent = await createTempDir("vela-git-clone-");
  const target = join(parent, "repo");
  await git(parent, ["clone", source, target]);
  const root = await realpath(target);
  await git(root, ["config", "user.name", "Vela Test"]);
  await git(root, ["config", "user.email", "test@vela.local"]);
  return root;
}

describe("collectStatus", () => {
  it("工作区位于仓库子目录时解析仓库根与 subdir", async () => {
    const root = await createRepo();
    await commitFile(root, "sub/inner.txt", "x\n", "base");
    const status = await collectStatus(join(root, "sub"));
    assert.equal(status?.repo?.root, root);
    assert.equal(status?.repo?.subdir, "sub");
    assert.equal(status?.repo?.empty, false);
  });

  it("空仓库标记 empty 且没有文件", async () => {
    const root = await createRepo();
    const status = await collectStatus(root);
    assert.equal(status?.repo?.empty, true);
    assert.equal(status?.branch, "main");
    assert.deepEqual(status?.files, []);
  });

  it("同一文件同时有索引与工作区改动", async () => {
    const root = await createRepo();
    await commitFile(root, "mixed.txt", "base\n", "base");
    await writeRepoFile(root, "mixed.txt", "staged\n");
    await git(root, ["add", "--", "mixed.txt"]);
    await writeRepoFile(root, "mixed.txt", "staged\nworktree\n");

    const status = await collectStatus(root);
    const file = status?.files.find((entry) => entry.path === "mixed.txt");
    assert.equal(file?.indexStatus, "modified");
    assert.equal(file?.worktreeStatus, "modified");
    assert.equal(file?.status, "modified");
    assert.ok((file?.indexAddedLines ?? 0) > 0);
    assert.ok((file?.worktreeAddedLines ?? 0) > 0);
    assert.equal(file?.addedLines, (file?.indexAddedLines ?? 0) + (file?.worktreeAddedLines ?? 0));
  });

  it("未跟踪文件统计行数", async () => {
    const root = await createRepo();
    await commitFile(root, "base.txt", "base\n", "base");
    await writeRepoFile(root, "note name.txt", "a\nb\nc\n");

    const status = await collectStatus(root);
    const file = status?.files.find((entry) => entry.path === "note name.txt");
    assert.equal(file?.status, "untracked");
    assert.equal(file?.indexStatus, null);
    assert.equal(file?.worktreeStatus, "untracked");
    assert.equal(file?.addedLines, 3);
    assert.equal(file?.worktreeAddedLines, 3);
  });

  it("重命名文件保留 oldPath", async () => {
    const root = await createRepo();
    await commitFile(root, "old name.txt", "content\n", "base");
    await git(root, ["mv", "old name.txt", "new name.txt"]);

    const status = await collectStatus(root);
    const file = status?.files.find((entry) => entry.path === "new name.txt");
    assert.equal(file?.oldPath, "old name.txt");
    assert.equal(file?.status, "renamed");
    assert.equal(file?.indexStatus, "renamed");
    assert.equal(file?.worktreeStatus, null);
  });

  it("合并冲突文件标记为 conflicted 并报告进行中的 merge", async () => {
    const root = await createRepo();
    await commitFile(root, "conflict.txt", "base\n", "base");
    await git(root, ["checkout", "-q", "-b", "other"]);
    await commitFile(root, "conflict.txt", "other\n", "other");
    await git(root, ["checkout", "-q", "main"]);
    await commitFile(root, "conflict.txt", "main\n", "main");
    await gitAllowFailure(root, ["merge", "other"]);

    const status = await collectStatus(root);
    assert.equal(status?.operation?.kind, "merge");
    assert.ok(status?.operation?.conflictedPaths.includes("conflict.txt"));
    const file = status?.files.find((entry) => entry.path === "conflict.txt");
    assert.equal(file?.status, "conflicted");
    assert.equal(file?.indexStatus, "conflicted");
    assert.equal(file?.worktreeStatus, "conflicted");
  });

  it("解析身份与远程地址", async () => {
    const root = await createRepo();
    await commitFile(root, "a.txt", "a\n", "base");
    const bare = await createBareRepo();
    await git(root, ["remote", "add", "origin", bare]);

    const status = await collectStatus(root);
    assert.equal(status?.identity.name, "Vela Test");
    assert.equal(status?.identity.email, "test@vela.local");
    assert.equal(status?.identity.configured, true);
    const remote = status?.remotes.find((entry) => entry.name === "origin");
    assert.equal(remote?.fetchUrl, bare);
    assert.equal(remote?.pushUrl, bare);
    assert.equal(status?.repo?.remoteUrl, bare);
    assert.equal(status?.lastFetchAt, null);
  });
});

describe("GitService", () => {
  it("commit 只提交索引内容并保留工作区后续改动", async () => {
    const root = await createRepo();
    await commitFile(root, "tracked.txt", "base\n", "base");
    await writeRepoFile(root, "tracked.txt", "staged\n");
    await git(root, ["add", "--", "tracked.txt"]);
    await writeRepoFile(root, "tracked.txt", "staged\nworktree\n");

    const service = new GitService();
    try {
      await service.attach(root);
      const result = await service.commit({ title: "只提交索引", body: "", stagePaths: null });
      assert.equal(result.ok, true);
      assert.ok(result.shortSha);
      assert.equal(result.branch, "main");
      assert.equal(await git(root, ["show", "HEAD:tracked.txt"]), "staged\n");
      assert.equal(await readFile(join(root, "tracked.txt"), "utf8"), "staged\nworktree\n");
      assert.equal(service.getSnapshot()?.files.some((file) => file.path === "tracked.txt"), true);
    } finally {
      await service.attach(null);
    }
  });

  it("pre-commit hook 失败时返回 ok:false 且索引保持暂存", async () => {
    const root = await createRepo();
    await commitFile(root, "a.txt", "base\n", "base");
    const hookPath = join(root, ".git", "hooks", "pre-commit");
    await writeFile(hookPath, "#!/bin/sh\necho 'hook 拒绝了提交' >&2\nexit 1\n");
    await chmod(hookPath, 0o755);
    await writeRepoFile(root, "b.txt", "staged\n");
    await git(root, ["add", "--", "b.txt"]);

    const service = new GitService();
    try {
      await service.attach(root);
      const result = await service.commit({ title: "会被拒绝", body: "", stagePaths: null });
      assert.equal(result.ok, false);
      assert.match(result.output, /hook 拒绝了提交/);
      const staged = await git(root, ["diff", "--cached", "--name-only"]);
      assert.ok(staged.split("\n").includes("b.txt"));
    } finally {
      await service.attach(null);
    }
  });

  it("discard 只还原工作区,不动索引", async () => {
    const root = await createRepo();
    await commitFile(root, "a.txt", "v1\n", "base");
    await writeRepoFile(root, "a.txt", "v2\n");
    await git(root, ["add", "--", "a.txt"]);
    await writeRepoFile(root, "a.txt", "v3\n");

    const service = new GitService();
    try {
      await service.attach(root);
      await service.discard(["a.txt"]);
      assert.equal(await readFile(join(root, "a.txt"), "utf8"), "v2\n");
      assert.equal(await git(root, ["show", ":a.txt"]), "v2\n");
      const cached = await git(root, ["diff", "--cached", "--name-only"]);
      assert.ok(cached.split("\n").includes("a.txt"));
    } finally {
      await service.attach(null);
    }
  });

  it("discard 默认跳过未跟踪文件,可显式删除", async () => {
    const root = await createRepo();
    await commitFile(root, "a.txt", "v1\n", "base");
    await writeRepoFile(root, "new.txt", "new\n");

    const service = new GitService();
    try {
      await service.attach(root);
      await service.discard(["new.txt"]);
      assert.equal(await readFile(join(root, "new.txt"), "utf8"), "new\n");
      await service.discard(["new.txt"], { untracked: true });
      await assert.rejects(readFile(join(root, "new.txt")));
    } finally {
      await service.attach(null);
    }
  });

  it("fileDiff 对未跟踪文件返回完整新增内容", async () => {
    const root = await createRepo();
    await commitFile(root, "a.txt", "a\n", "base");

    const service = new GitService();
    try {
      await service.attach(root);
      // 快照可能还没包含刚创建的文件,fileDiff 需要自行判断未跟踪。
      await writeRepoFile(root, "new.txt", "hello\n");
      const worktreeDiff = await service.fileDiff("new.txt", "worktree");
      assert.ok(worktreeDiff.includes("+hello"));
      // 索引里没有这个文件,索引范围不应返回与索引不符的内容。
      const indexDiff = await service.fileDiff("new.txt", "index");
      assert.equal(indexDiff.trim(), "");
    } finally {
      await service.attach(null);
    }
  });

  it("fileDiff 索引范围对已暂存删除返回删除差异", async () => {
    const root = await createRepo();
    await commitFile(root, "gone.txt", "one\ntwo\n", "base");
    await rm(join(root, "gone.txt"));
    await git(root, ["add", "--", "gone.txt"]);

    const service = new GitService();
    try {
      await service.attach(root);
      const indexDiff = await service.fileDiff("gone.txt", "index");
      assert.match(indexDiff, /^deleted file mode/m);
      assert.match(indexDiff, /^-one$/m);
    } finally {
      await service.attach(null);
    }
  });

  it("stagedDiff 预览暂存内容,setIdentity 更新仓库级身份", async () => {
    const root = await createRepo();
    await commitFile(root, "a.txt", "a\n", "base");
    await writeRepoFile(root, "a.txt", "b\n");
    await git(root, ["add", "--", "a.txt"]);

    const service = new GitService();
    try {
      await service.attach(root);
      const diff = await service.stagedDiff();
      assert.ok(diff.includes("+b"));
      await service.setIdentity("New Name", "new@example.com");
      assert.equal(service.getSnapshot()?.identity.name, "New Name");
      assert.equal(service.getSnapshot()?.identity.email, "new@example.com");
      assert.equal(service.getSnapshot()?.identity.configured, true);
      await assert.rejects(service.setIdentity("", "a@b"), /用户名/);
      await assert.rejects(service.setIdentity("x".repeat(201), "a@b"), /用户名/);
      await assert.rejects(service.setIdentity("ok", "no-at-sign"), /邮箱/);
      await assert.rejects(service.setIdentity("ok", `${"x".repeat(321)}@b`), /邮箱/);
      // 配置必须写在仓库级(--local),而不是全局。
      assert.equal((await git(root, ["config", "--local", "--get", "user.name"])).trim(), "New Name");
      assert.equal((await git(root, ["config", "--local", "--get", "user.email"])).trim(), "new@example.com");
    } finally {
      await service.attach(null);
    }
  });

  it("stagedDiff 在空仓库返回相对空树的暂存差异", async () => {
    const root = await createRepo();
    await writeRepoFile(root, "first.txt", "hello\n");
    await git(root, ["add", "--", "first.txt"]);

    const service = new GitService();
    try {
      await service.attach(root);
      const diff = await service.stagedDiff();
      assert.ok(diff.includes("+hello"));
    } finally {
      await service.attach(null);
    }
  });

  it("push 建立 upstream 并可确认结果,graph 标记 pushed", async () => {
    const bare = await createBareRepo();
    const root = await createRepo();
    await commitFile(root, "a.txt", "a\n", "base");
    await git(root, ["remote", "add", "origin", bare]);

    const service = new GitService();
    try {
      await service.attach(root);
      const before = await service.graph({ scope: "current", limit: 10, skip: 0 });
      assert.equal(before.commits[0]?.pushed, null);

      const result = await service.push({ remote: "origin", branch: "main", setUpstream: true });
      assert.equal(result.outcome, "ok");
      assert.equal(result.ok, true);
      assert.equal(result.confirmed, true);
      assert.equal(service.getSnapshot()?.upstream, "origin/main");

      const after = await service.graph({ scope: "current", limit: 10, skip: 0 });
      assert.equal(after.commits[0]?.pushed, true);

      const again = await service.push({ remote: "origin", branch: "main", setUpstream: false });
      assert.equal(again.outcome, "up-to-date");
      assert.equal(again.ok, true);
    } finally {
      await service.attach(null);
    }
  });

  it("push 被拒绝时分类为 stale", async () => {
    const bare = await createBareRepo();
    const seed = await createRepo();
    await commitFile(seed, "shared.txt", "base\n", "base");
    await git(seed, ["remote", "add", "origin", bare]);
    await git(seed, ["push", "-q", "--set-upstream", "origin", "main"]);
    const local = await cloneRepo(bare);
    await commitFile(local, "shared.txt", "local\n", "local change");
    await commitFile(seed, "shared.txt", "remote\n", "remote change");
    await git(seed, ["push", "-q", "origin", "main"]);

    const service = new GitService();
    try {
      await service.attach(local);
      const result = await service.push({ remote: "origin", branch: "main", setUpstream: false });
      assert.equal(result.outcome, "stale");
      assert.equal(result.ok, false);
      assert.equal(result.confirmed, true);
    } finally {
      await service.attach(null);
    }
  });

  it("graph 按拓扑序返回提交并支持快照分页", async () => {
    const root = await createRepo();
    const shas: string[] = [];
    for (let index = 1; index <= 5; index += 1) {
      shas.push(await commitFile(root, "log.txt", `${"x".repeat(index)}\n`, `commit ${index}`));
    }
    await git(root, ["branch", "feature", shas[1]]);

    const service = new GitService();
    try {
      await service.attach(root);
      const first = await service.graph({ scope: "current", limit: 3, skip: 0 });
      assert.equal(first.commits.length, 3);
      assert.equal(first.commits[0]?.sha, shas[4]);
      assert.deepEqual(first.commits[0]?.parents, [shas[3]]);
      assert.equal(first.hasMore, true);
      assert.ok(
        first.commits[0]?.refs.some((ref) => ref.name === "HEAD -> main" && ref.kind === "head"),
      );
      assert.ok(first.commits[0]?.refs.some((ref) => ref.name === "main" && ref.kind === "local"));
      assert.ok(first.pendingParents.includes(shas[1]));

      const second = await service.graph({
        scope: "current",
        limit: 3,
        skip: 3,
        snapshotId: first.snapshotId,
      });
      assert.equal(second.snapshotId, first.snapshotId);
      assert.equal(second.hasMore, false);
      assert.deepEqual(
        second.commits.map((commit) => commit.sha),
        [shas[1], shas[0]],
      );
      const firstShas = new Set(first.commits.map((commit) => commit.sha));
      for (const commit of second.commits) assert.equal(firstShas.has(commit.sha), false);

      const all = await service.graph({ scope: "all-local", limit: 10, skip: 0 });
      const refs = all.commits.flatMap((commit) => commit.refs);
      assert.ok(refs.some((ref) => ref.name === "feature" && ref.kind === "local"));
      assert.ok(all.commits.some((commit) => commit.sha === shas[4]));
    } finally {
      await service.attach(null);
    }
  });

  it("commitDetail 支持根提交与合并提交切换父提交", async () => {
    const root = await createRepo();
    const first = await commitFile(root, "a.txt", "a\n", "first");
    await git(root, ["checkout", "-q", "-b", "side"]);
    await commitFile(root, "side.txt", "side\n", "side");
    await git(root, ["checkout", "-q", "main"]);
    await commitFile(root, "main.txt", "main\n", "main");
    await git(root, ["merge", "--no-ff", "side", "-m", "merge side"]);
    const mergeSha = (await git(root, ["rev-parse", "HEAD"])).trim();

    const service = new GitService();
    try {
      await service.attach(root);

      const rootDetail = await service.commitDetail(first);
      assert.equal(rootDetail.isRoot, true);
      assert.equal(rootDetail.parentSha, null);
      assert.deepEqual(rootDetail.parents, []);
      assert.equal(rootDetail.files.length, 1);
      assert.equal(rootDetail.files[0]?.path, "a.txt");
      assert.ok(rootDetail.diff.includes("+a"));

      const mergeDetail = await service.commitDetail(mergeSha);
      assert.equal(mergeDetail.isRoot, false);
      assert.equal(mergeDetail.parents.length, 2);
      assert.equal(mergeDetail.parentSha, mergeDetail.parents[0]);
      assert.ok(mergeDetail.diff.length > 0);

      const secondParent = mergeDetail.parents[1] ?? "";
      const switched = await service.commitDetail(mergeSha, secondParent);
      assert.equal(switched.parentSha, secondParent);
      assert.ok(switched.diff.length > 0);
      assert.notEqual(switched.diff, mergeDetail.diff);
    } finally {
      await service.attach(null);
    }
  });
});

describe("GitService pull", () => {
  async function setupClone(): Promise<{ bare: string; seed: string; local: string }> {
    const bare = await createBareRepo();
    const seed = await createRepo();
    await commitFile(seed, "shared.txt", "base\n", "base");
    await git(seed, ["remote", "add", "origin", bare]);
    await git(seed, ["push", "-q", "--set-upstream", "origin", "main"]);
    const local = await cloneRepo(bare);
    return { bare, seed, local };
  }

  it("diverged 分支返回 diverged 且不合并", async () => {
    const { seed, local } = await setupClone();
    await commitFile(local, "shared.txt", "local\n", "local change");
    const localHead = (await git(local, ["rev-parse", "HEAD"])).trim();
    await commitFile(seed, "shared.txt", "remote\n", "remote change");
    await git(seed, ["push", "-q", "origin", "main"]);

    const service = new GitService();
    try {
      await service.attach(local);
      const result = await service.pull();
      assert.equal(result.outcome, "diverged");
      assert.equal(result.ok, false);
      assert.equal((await git(local, ["rev-parse", "HEAD"])).trim(), localHead);
      assert.equal((await git(local, ["rev-list", "--count", "HEAD"])).trim(), "2");
    } finally {
      await service.attach(null);
    }
  });

  it("存在未提交的已跟踪改动时返回 dirty", async () => {
    const { local } = await setupClone();
    await writeRepoFile(local, "shared.txt", "dirty\n");

    const service = new GitService();
    try {
      await service.attach(local);
      const result = await service.pull();
      assert.equal(result.outcome, "dirty");
      assert.match(result.message, /shared\.txt/);
      assert.equal(await readFile(join(local, "shared.txt"), "utf8"), "dirty\n");
    } finally {
      await service.attach(null);
    }
  });

  it("落后时快进到上游", async () => {
    const { seed, local } = await setupClone();
    await commitFile(seed, "shared.txt", "remote\n", "remote change");
    await git(seed, ["push", "-q", "origin", "main"]);

    const service = new GitService();
    try {
      await service.attach(local);
      const result = await service.pull();
      assert.equal(result.outcome, "fast-forward");
      assert.equal(result.ok, true);
      const localHead = (await git(local, ["rev-parse", "HEAD"])).trim();
      const seedHead = (await git(seed, ["rev-parse", "HEAD"])).trim();
      assert.equal(localHead, seedHead);
    } finally {
      await service.attach(null);
    }
  });
});
