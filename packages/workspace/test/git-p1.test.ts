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

const { GitService } = await import("../src/git-service.ts");
const { parsePatchSection, buildPatchFromHunks } = await import("../src/diff-hunks.ts");

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
  const root = await createTempDir("vela-p1-repo-");
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.name", "Vela Test"]);
  await git(root, ["config", "user.email", "test@vela.local"]);
  return root;
}

async function createBareRepo(): Promise<string> {
  const root = await createTempDir("vela-p1-bare-");
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

/** 生成含两个独立代码块的文件内容与修改。 */
function twoHunkBase(): string {
  return Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
}

function twoHunkEdited(): string {
  const lines = twoHunkBase().split("\n");
  lines[1] = "line 2 changed";
  lines[28] = "line 29 changed";
  return lines.join("\n");
}

async function withService<T>(root: string, task: (service: InstanceType<typeof GitService>) => Promise<T>): Promise<T> {
  const service = new GitService();
  try {
    await service.attach(root);
    return await task(service);
  } finally {
    await service.attach(null);
  }
}

describe("applyHunks (VC-15)", () => {
  it("只暂存选中的代码块,其余工作区改动保留", async () => {
    const root = await createRepo();
    await commitFile(root, "multi.txt", twoHunkBase(), "base");
    await writeRepoFile(root, "multi.txt", twoHunkEdited());

    await withService(root, async (service) => {
      const diff = await service.fileDiff("multi.txt", "worktree");
      const section = parsePatchSection(diff, "multi.txt");
      assert.ok(section && section.hunks.length === 2, "应有两个代码块");

      const patch = buildPatchFromHunks(section.header, [section.hunks[0]!]);
      const snapshot = await service.applyHunks({ path: "multi.txt", action: "stage", patch });
      assert.ok(snapshot);

      const cached = await git(root, ["diff", "--cached", "--", "multi.txt"]);
      assert.match(cached, /line 2 changed/);
      assert.doesNotMatch(cached, /line 29 changed/);

      const worktree = await git(root, ["diff", "--", "multi.txt"]);
      assert.doesNotMatch(worktree, /line 2 changed/, "已暂存的代码块不应再出现在工作区差异中");
      assert.match(worktree, /line 29 changed/);
    });
  });

  it("取消暂存选中的代码块,索引其余内容保持", async () => {
    const root = await createRepo();
    await commitFile(root, "multi.txt", twoHunkBase(), "base");
    await writeRepoFile(root, "multi.txt", twoHunkEdited());
    await git(root, ["add", "--", "multi.txt"]);

    await withService(root, async (service) => {
      const diff = await service.fileDiff("multi.txt", "index");
      const section = parsePatchSection(diff, "multi.txt");
      assert.ok(section && section.hunks.length === 2);

      const patch = buildPatchFromHunks(section.header, [section.hunks[1]!]);
      await service.applyHunks({ path: "multi.txt", action: "unstage", patch });

      const cached = await git(root, ["diff", "--cached", "--", "multi.txt"]);
      assert.match(cached, /line 2 changed/);
      assert.doesNotMatch(cached, /line 29 changed/);

      const unstaged = await git(root, ["diff", "--", "multi.txt"]);
      assert.match(unstaged, /line 29 changed/);
    });
  });

  it("丢弃选中的代码块只影响工作区", async () => {
    const root = await createRepo();
    await commitFile(root, "multi.txt", twoHunkBase(), "base");
    await writeRepoFile(root, "multi.txt", twoHunkEdited());

    await withService(root, async (service) => {
      const diff = await service.fileDiff("multi.txt", "worktree");
      const section = parsePatchSection(diff, "multi.txt");
      assert.ok(section && section.hunks.length === 2);

      const patch = buildPatchFromHunks(section.header, [section.hunks[0]!]);
      await service.applyHunks({ path: "multi.txt", action: "discard", patch });

      const content = await readFile(join(root, "multi.txt"), "utf8");
      assert.match(content, /^line 1\nline 2\n/, "丢弃的代码块应恢复为索引内容");
      assert.match(content, /line 29 changed/);
    });
  });

  it("整个文件删除可以按代码块暂存、取消暂存与丢弃", async () => {
    const root = await createRepo();
    await commitFile(root, "gone.txt", "one\ntwo\n", "base");

    await withService(root, async (service) => {
      // 暂存整个删除。
      await rm(join(root, "gone.txt"));
      const worktreeDiff = await service.fileDiff("gone.txt", "worktree");
      const worktreeSection = parsePatchSection(worktreeDiff, "gone.txt");
      assert.ok(worktreeSection && worktreeSection.hunks.length === 1);
      await service.applyHunks({
        path: "gone.txt",
        action: "stage",
        patch: buildPatchFromHunks(worktreeSection.header, worktreeSection.hunks),
      });
      assert.match(await git(root, ["diff", "--cached", "--name-status"]), /^D\s+gone\.txt/m);

      // 取消暂存同一个删除:索引恢复,工作区保持删除。
      const indexDiff = await service.fileDiff("gone.txt", "index");
      const indexSection = parsePatchSection(indexDiff, "gone.txt");
      assert.ok(indexSection && indexSection.hunks.length === 1);
      await service.applyHunks({
        path: "gone.txt",
        action: "unstage",
        patch: buildPatchFromHunks(indexSection.header, indexSection.hunks),
      });
      assert.equal((await git(root, ["diff", "--cached", "--name-status"])).trim(), "");
      assert.match(await git(root, ["status", "--porcelain"]), /^\s?D\s+gone\.txt/m);

      // 丢弃删除:文件恢复到工作区。
      const again = await service.fileDiff("gone.txt", "worktree");
      const againSection = parsePatchSection(again, "gone.txt");
      assert.ok(againSection);
      await service.applyHunks({
        path: "gone.txt",
        action: "discard",
        patch: buildPatchFromHunks(againSection.header, againSection.hunks),
      });
      assert.equal(await readFile(join(root, "gone.txt"), "utf8"), "one\ntwo\n");
    });
  });

  it("补丁与最新内容不一致时拒绝执行", async () => {
    const root = await createRepo();
    await commitFile(root, "multi.txt", twoHunkBase(), "base");
    await writeRepoFile(root, "multi.txt", twoHunkEdited());

    await withService(root, async (service) => {
      const diff = await service.fileDiff("multi.txt", "worktree");
      const section = parsePatchSection(diff, "multi.txt");
      assert.ok(section);
      const patch = buildPatchFromHunks(section.header, [section.hunks[0]!]);

      // 用户选择之后该代码块的内容又被改动:旧补丁必须被拒绝。
      const changed = twoHunkEdited().replace("line 2 changed", "line 2 changed again");
      await writeRepoFile(root, "multi.txt", changed);
      await assert.rejects(
        () => service.applyHunks({ path: "multi.txt", action: "stage", patch }),
        /已变化|刷新/,
      );
    });
  });
});

describe("amend 与撤销提交 (CT-04/CT-05)", () => {
  it("amend 修正最近提交并报告推送状态", async () => {
    const root = await createRepo();
    await commitFile(root, "a.txt", "one\n", "first");
    await writeRepoFile(root, "a.txt", "two\n");
    await git(root, ["add", "--", "a.txt"]);

    await withService(root, async (service) => {
      const before = (await git(root, ["rev-parse", "HEAD"])).trim();
      const result = await service.commit({ title: "first amended", body: "", stagePaths: null, amend: true });
      assert.equal(result.ok, true);
      assert.equal(result.amendedSha, before);
      assert.equal(result.amendedPushed, null, "没有 upstream 时推送状态未知");
      const count = (await git(root, ["rev-list", "--count", "HEAD"])).trim();
      assert.equal(count, "1", "amend 不应新增提交");
      assert.equal(await git(root, ["log", "-1", "--format=%s"]).then((value) => value.trim()), "first amended");
    });
  });

  it("amend 已推送的提交时标记 amendedPushed", async () => {
    const bare = await createBareRepo();
    const root = await createRepo();
    await git(root, ["remote", "add", "origin", bare]);
    await commitFile(root, "a.txt", "one\n", "first");
    await git(root, ["push", "-q", "-u", "origin", "main"]);
    await writeRepoFile(root, "a.txt", "two\n");
    await git(root, ["add", "--", "a.txt"]);

    await withService(root, async (service) => {
      const result = await service.commit({ title: "first amended", body: "", stagePaths: null, amend: true });
      assert.equal(result.ok, true);
      assert.equal(result.amendedPushed, true);
    });
  });

  it("撤销未推送提交并把改动保留在索引", async () => {
    const root = await createRepo();
    await commitFile(root, "a.txt", "one\n", "first");
    await commitFile(root, "b.txt", "two\n", "second");

    await withService(root, async (service) => {
      const result = await service.undoLastCommit({ mode: "keep-index" });
      assert.equal(result.ok, true);
      assert.equal(result.subject, "second");
      const subject = (await git(root, ["log", "-1", "--format=%s"])).trim();
      assert.equal(subject, "first");
      const staged = await git(root, ["diff", "--cached", "--name-only"]);
      assert.ok(staged.split("\n").includes("b.txt"));
    });
  });

  it("撤销时选择保留到工作区", async () => {
    const root = await createRepo();
    await commitFile(root, "a.txt", "one\n", "first");
    await commitFile(root, "b.txt", "two\n", "second");

    await withService(root, async (service) => {
      const result = await service.undoLastCommit({ mode: "keep-worktree" });
      assert.equal(result.ok, true);
      const staged = await git(root, ["diff", "--cached", "--name-only"]);
      assert.equal(staged.trim(), "");
      const status = await git(root, ["status", "--porcelain"]);
      assert.ok(status.includes("?? b.txt"), "撤销的提交内容应保留在工作区");
      assert.equal(await readFile(join(root, "b.txt"), "utf8"), "two\n");
    });
  });

  it("已推送的提交不能在这里撤销", async () => {
    const bare = await createBareRepo();
    const root = await createRepo();
    await git(root, ["remote", "add", "origin", bare]);
    await commitFile(root, "a.txt", "one\n", "first");
    await commitFile(root, "b.txt", "two\n", "second");
    await git(root, ["push", "-q", "-u", "origin", "main"]);

    await withService(root, async (service) => {
      const result = await service.undoLastCommit({ mode: "keep-index" });
      assert.equal(result.ok, false);
      assert.match(result.message, /推送/);
    });
  });

  it("第一个提交不能撤销", async () => {
    const root = await createRepo();
    await commitFile(root, "a.txt", "one\n", "first");
    await withService(root, async (service) => {
      const result = await service.undoLastCommit({ mode: "keep-index" });
      assert.equal(result.ok, false);
      assert.match(result.message, /第一个提交/);
    });
  });
});

describe("分支维护与比较 (BR-02/BR-03/HI-01)", () => {
  it("branchDetail 报告合并状态与 worktree 占用", async () => {
    const root = await createRepo();
    await commitFile(root, "a.txt", "one\n", "first");
    await git(root, ["branch", "feature"]);
    await commitFile(root, "a.txt", "two\n", "second");

    await withService(root, async (service) => {
      const detail = await service.branchDetail("feature");
      assert.equal(detail.current, false);
      assert.ok(detail.mergedInto, "feature 已合入当前分支");
      assert.equal(detail.upstream, null);
      assert.equal(detail.rootCommit, true, "feature 只有第一个提交，撤销会清空历史");
      const current = await service.branchDetail("main");
      assert.equal(current.current, true);
      assert.equal(current.rootCommit, false);
      assert.equal(current.worktreePath, null, "当前工作树不算被其他 worktree 占用");
    });
  });

  it("重命名与删除分支", async () => {
    const root = await createRepo();
    await commitFile(root, "a.txt", "one\n", "first");
    await git(root, ["branch", "feature"]);

    await withService(root, async (service) => {
      await service.renameBranch("feature", "renamed");
      const branches = await git(root, ["branch", "--format=%(refname:short)"]);
      assert.ok(branches.includes("renamed"));

      const renamed = await service.branchDetail("renamed");
      assert.ok(renamed.mergedInto, "同一提交上的分支视为已合入");
      const result = await service.deleteBranch({ name: "renamed" });
      assert.equal(result.ok, true);
      assert.equal(result.deletedLocal, true);
      const after = await git(root, ["branch", "--format=%(refname:short)"]);
      assert.ok(!after.includes("renamed"));
    });
  });

  it("未合入分支默认拒绝删除,强制删除可选", async () => {
    const root = await createRepo();
    await commitFile(root, "a.txt", "one\n", "first");
    await git(root, ["checkout", "-q", "-b", "feature"]);
    await commitFile(root, "b.txt", "feature\n", "feature work");
    await git(root, ["checkout", "-q", "main"]);

    await withService(root, async (service) => {
      const denied = await service.deleteBranch({ name: "feature" });
      assert.equal(denied.ok, false);
      assert.match(denied.message, /强制删除/);
      const forced = await service.deleteBranch({ name: "feature", force: true });
      assert.equal(forced.ok, true);
    });
  });

  it("compareRefs 给出方向明确的提交与文件差异", async () => {
    const root = await createRepo();
    await commitFile(root, "a.txt", "one\n", "first");
    await git(root, ["checkout", "-q", "-b", "feature"]);
    await commitFile(root, "b.txt", "two\n", "feature one");
    await commitFile(root, "b.txt", "three\n", "feature two");
    await git(root, ["checkout", "-q", "main"]);

    await withService(root, async (service) => {
      const result = await service.compareRefs("main", "feature");
      assert.equal(result.error, null);
      assert.equal(result.commits.length, 2);
      assert.equal(result.files.length, 1);
      assert.equal(result.files[0]?.path, "b.txt");
      assert.ok(result.mergeBase);
      assert.match(result.diff, /^\+three$/m);

      const reverse = await service.compareRefs("feature", "main");
      assert.equal(reverse.commits.length, 0);
      assert.equal(reverse.files.length, 0);
      assert.equal(reverse.base, "feature");
    });
  });

  it("compareRefs 支持提交 SHA 与忽略空白", async () => {
    const root = await createRepo();
    const first = await commitFile(root, "a.txt", "one\n", "first");
    await commitFile(root, "a.txt", "one   \n", "whitespace only");

    await withService(root, async (service) => {
      const head = (await git(root, ["rev-parse", "HEAD"])).trim();
      const exact = await service.compareRefs(first, head);
      assert.equal(exact.files.length, 1);
      const ignored = await service.compareRefs(first, head, { ignoreWhitespace: true });
      assert.equal(ignored.files.length, 0, "忽略空白后不应有差异");

      const missing = await service.compareRefs("does-not-exist", head);
      assert.ok(missing.error);
    });
  });

  it("设置与清除上游跟踪", async () => {
    const bare = await createBareRepo();
    const root = await createRepo();
    await git(root, ["remote", "add", "origin", bare]);
    await commitFile(root, "a.txt", "one\n", "first");
    await git(root, ["push", "-q", "origin", "main"]);

    await withService(root, async (service) => {
      const snapshot = await service.setUpstream({ branch: "main", upstream: "origin/main" });
      assert.equal(snapshot?.upstream, "origin/main");
      const cleared = await service.setUpstream({ branch: "main", upstream: null });
      assert.equal(cleared?.upstream, null);
    });
  });
});

describe("远程管理 (SY-01)", () => {
  it("添加、修改、重命名与删除远程", async () => {
    const root = await createRepo();
    await commitFile(root, "a.txt", "one\n", "first");

    await withService(root, async (service) => {
      const added = await service.addRemote({
        name: "origin",
        url: "git@github.com:owner/repo.git",
        pushUrl: "https://github.com/owner/repo.git",
      });
      assert.equal(added.ok, true);
      assert.equal(added.remotes[0]?.slug, "owner/repo");
      assert.equal(added.remotes[0]?.pushUrl, "https://github.com/owner/repo.git");

      const renamed = await service.renameRemote("origin", "upstream");
      assert.equal(renamed.remotes[0]?.name, "upstream");

      const updated = await service.setRemoteUrl("upstream", "https://github.com/other/repo.git");
      assert.equal(updated.remotes[0]?.slug, "other/repo");

      await assert.rejects(() => service.addRemote({ name: "upstream", url: "https://x/y" }), /已存在/);

      const removed = await service.removeRemote("upstream");
      assert.equal(removed.remotes.length, 0);
    });
  });

  it("拒绝不安全的远程名与地址", async () => {
    const root = await createRepo();
    await commitFile(root, "a.txt", "one\n", "first");
    await withService(root, async (service) => {
      await assert.rejects(() => service.addRemote({ name: "-bad", url: "https://x/y" }), /远程名/);
      await assert.rejects(() => service.addRemote({ name: "ok", url: "--upload-pack=evil" }), /远程地址/);
    });
  });
});

describe("冲突处理 (CF-01)", () => {
  async function setupConflict(): Promise<string> {
    const root = await createRepo();
    await commitFile(root, "conflict.txt", "base\n", "base");
    await git(root, ["checkout", "-q", "-b", "other"]);
    await commitFile(root, "conflict.txt", "other\n", "other");
    await git(root, ["checkout", "-q", "main"]);
    await commitFile(root, "conflict.txt", "main\n", "main");
    await gitAllowFailure(root, ["merge", "other"]);
    return root;
  }

  it("读取三方内容并在解决后继续合并", async () => {
    const root = await setupConflict();
    await withService(root, async (service) => {
      const file = await service.conflictFile("conflict.txt");
      assert.equal(file.base, "base\n");
      assert.equal(file.ours, "main\n");
      assert.equal(file.theirs, "other\n");
      assert.equal(file.hasMarkers, true);

      // 未解决完全部冲突时拒绝继续。
      const blocked = await service.controlOperation("continue");
      assert.equal(blocked.ok, false);
      assert.equal(blocked.operation?.kind, "merge");

      const resolved = await service.resolveConflict({ path: "conflict.txt", content: "merged\n" });
      assert.equal(resolved.ok, true);
      assert.equal(resolved.remaining, 0);

      const continued = await service.controlOperation("continue");
      assert.equal(continued.ok, true);
      assert.equal(continued.operation, null);
      assert.equal(await readFile(join(root, "conflict.txt"), "utf8"), "merged\n");
      const subject = (await git(root, ["log", "-1", "--format=%s"])).trim();
      assert.match(subject, /Merge/);
    });
  });

  it("中止合并保留操作前状态", async () => {
    const root = await setupConflict();
    await withService(root, async (service) => {
      const aborted = await service.controlOperation("abort");
      assert.equal(aborted.ok, true);
      assert.equal(aborted.operation, null);
      assert.equal(await readFile(join(root, "conflict.txt"), "utf8"), "main\n");
      const head = (await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
      assert.equal(head, "main");
    });
  });
});

describe("Stash (ST-01)", () => {
  it("保存、列出、应用与删除;命名与未跟踪文件可选", async () => {
    const root = await createRepo();
    await commitFile(root, "a.txt", "one\n", "first");
    await writeRepoFile(root, "a.txt", "two\n");
    await writeRepoFile(root, "untracked.txt", "new\n");

    await withService(root, async (service) => {
      const created = await service.stashCreate({ message: "工作存档", includeUntracked: true });
      assert.equal(created.ok, true);
      assert.ok(created.stash);

      const clean = await git(root, ["status", "--porcelain"]);
      assert.equal(clean.trim(), "");

      const list = await service.stashes();
      assert.equal(list.length, 1);
      assert.equal(list[0]?.message, "工作存档");
      assert.equal(list[0]?.branch, "main");

      const diff = await service.stashDiff(list[0]!.id);
      assert.match(diff, /two/);

      const applied = await service.stashApply({ id: list[0]!.id, mode: "pop" });
      assert.equal(applied.ok, true);
      assert.equal(await readFile(join(root, "a.txt"), "utf8"), "two\n");
      assert.equal(await readFile(join(root, "untracked.txt"), "utf8"), "new\n");
      assert.equal((await service.stashes()).length, 0);
    });
  });

  it("没有改动时报告空结果且不产生记录", async () => {
    const root = await createRepo();
    await commitFile(root, "a.txt", "one\n", "first");
    await withService(root, async (service) => {
      const created = await service.stashCreate({ message: "空" });
      assert.equal(created.ok, true);
      assert.equal(created.empty, true);
      assert.equal((await service.stashes()).length, 0);
    });
  });

  it("应用冲突时保留 Stash 记录", async () => {
    const root = await createRepo();
    await commitFile(root, "a.txt", "one\n", "first");
    await writeRepoFile(root, "a.txt", "stashed\n");
    await withService(root, async (service) => {
      const created = await service.stashCreate({ message: "冲突用" });
      assert.ok(created.stash);
      await writeRepoFile(root, "a.txt", "later\n");
      await git(root, ["add", "--", "a.txt"]);
      await git(root, ["commit", "-q", "-m", "later"]);

      const applied = await service.stashApply({ id: created.stash!.id, mode: "pop" });
      assert.equal(applied.ok, false);
      assert.equal(applied.conflicted, true);
      assert.equal(applied.kept, true);
      assert.equal((await service.stashes()).length, 1, "冲突时记录必须保留");
      await service.controlOperation("abort");
    });
  });
});

describe("Worktree (WT-01)", () => {
  it("创建、列出与删除 worktree", async () => {
    const root = await createRepo();
    await commitFile(root, "a.txt", "one\n", "first");
    const managedRoot = await createTempDir("vela-p1-worktrees-");

    const service = new GitService({ worktreeRoot: managedRoot });
    try {
      await service.attach(root);
      const created = await service.worktreeCreate({ branch: "wt-branch", newBranch: true });
      assert.equal(created.ok, true);
      assert.ok(created.path);

      const list = await service.worktrees();
      const entry = list.find((item) => item.path === created.path);
      assert.ok(entry);
      assert.equal(entry.branch, "wt-branch");
      assert.equal(entry.current, false);
      assert.equal(entry.managed, true);
      assert.equal(entry.changeCount, 0);

      // 有未保存内容时不允许静默删除。
      await writeRepoFile(created.path!, "untracked.txt", "dirty\n");
      const blocked = await service.worktreeRemove({ path: created.path! });
      assert.equal(blocked.ok, false);
      assert.equal(blocked.blocked, true);
      assert.ok((blocked.changeCount ?? 0) > 0);

      const forced = await service.worktreeRemove({ path: created.path!, force: true });
      assert.equal(forced.ok, true);
      assert.ok(!(await service.worktrees()).some((item) => item.path === created.path));
    } finally {
      await service.attach(null);
    }
  });

  it("prune 清理目录已缺失的记录", async () => {
    const root = await createRepo();
    await commitFile(root, "a.txt", "one\n", "first");
    const managedRoot = await createTempDir("vela-p1-worktrees-");

    const service = new GitService({ worktreeRoot: managedRoot });
    try {
      await service.attach(root);
      const created = await service.worktreeCreate({ branch: "gone", newBranch: true });
      assert.ok(created.path);
      await rm(created.path!, { recursive: true, force: true });

      const list = await service.worktrees();
      const entry = list.find((item) => item.path === created.path);
      assert.equal(entry?.missing, true);

      const pruned = await service.worktreePrune();
      assert.equal(pruned.ok, true);
      assert.ok(pruned.pruned.includes(created.path!));
      assert.ok(!(await service.worktrees()).some((item) => item.path === created.path));
    } finally {
      await service.attach(null);
    }
  });

  it("不能删除当前工作区所在的 worktree", async () => {
    const root = await createRepo();
    await commitFile(root, "a.txt", "one\n", "first");
    await withService(root, async (service) => {
      const result = await service.worktreeRemove({ path: root, force: true });
      assert.equal(result.ok, false);
      assert.match(result.message, /当前工作区/);
    });
  });
});

describe("Diff 显示选项 (VC-16)", () => {
  it("忽略空白只影响展示,不改变索引内容", async () => {
    const root = await createRepo();
    await commitFile(root, "a.txt", "one\n", "first");
    await writeRepoFile(root, "a.txt", "one   \n");

    await withService(root, async (service) => {
      const exact = await service.fileDiff("a.txt", "worktree");
      assert.ok(exact.length > 0);
      const relaxed = await service.fileDiff("a.txt", "worktree", { ignoreWhitespace: true });
      assert.equal(relaxed.trim(), "");

      await service.stage(["a.txt"]);
      const staged = await git(root, ["diff", "--cached", "--name-only"]);
      assert.ok(staged.includes("a.txt"), "显示选项不改变暂存内容");
    });
  });
});

describe("操作记录检索 (OP-04)", () => {
  it("按文本、类型、结果与时间过滤", async () => {
    const { GitOperationLog } = await import("../src/operation-log.ts");
    const log = new GitOperationLog(null);
    const first = log.begin({
      type: "commit",
      workspace: "/tmp/repo",
      repoRoot: "/tmp/repo",
      branch: "main",
      expectedHead: null,
      steps: [{ id: "commit", label: "创建提交" }],
    });
    log.finish(first.id, { status: "success", resultSha: "a".repeat(40) });
    const second = log.begin({
      type: "push",
      workspace: "/tmp/repo",
      repoRoot: "/tmp/repo",
      branch: "feature",
      expectedHead: null,
      steps: [{ id: "push", label: "推送到 origin/feature" }],
    });
    log.finish(second.id, { status: "failed", error: "远程拒绝" });

    const others = log.begin({
      type: "commit",
      workspace: "/tmp/other",
      repoRoot: "/tmp/other",
      branch: "main",
      expectedHead: null,
      steps: [{ id: "commit", label: "创建提交" }],
    });
    log.finish(others.id, { status: "success" });

    const byText = log.snapshot("/tmp/repo", { text: "feature" });
    assert.equal(byText.recent.length, 1);
    assert.equal(byText.recent[0]?.type, "push");

    const byType = log.snapshot("/tmp/repo", { types: ["commit"] });
    assert.equal(byType.recent.length, 1);
    assert.equal(byType.recent[0]?.type, "commit");

    const byStatus = log.snapshot("/tmp/repo", { statuses: ["failed"] });
    assert.equal(byStatus.recent.length, 1);
    assert.equal(byStatus.total, 1);

    const byTime = log.snapshot("/tmp/repo", { until: Date.now() - 60_000 });
    assert.equal(byTime.recent.length, 0);

    const all = log.snapshot("/tmp/repo");
    assert.equal(all.recent.length, 2, "其他工作区的记录不混入");
  });
});
