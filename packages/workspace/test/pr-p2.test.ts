import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { GitStatusSnapshot } from "@vela/shared";

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

const { PullRequestService } = await import("../src/pull-request-service.ts");
const { runGit } = await import("../src/git-run.ts");

const tempDirs: string[] = [];
const originalPath = process.env.PATH ?? "";

after(async () => {
  process.env.PATH = originalPath;
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

async function createTempDir(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

/** 用假 gh 拦住所有网络调用:按子命令返回固定 JSON,并记录 argv 与 stdin。 */
/** 服务需要通过本地远程识别 owner/repo,所以给每个用例准备一个真实仓库。 */
async function createCwd(prefix = "vela-pr-cwd-"): Promise<string> {
  const dir = await createTempDir(prefix);
  await runGit(dir, ["init", "-b", "main"]);
  await runGit(dir, ["remote", "add", "origin", "git@github.com:owner/repo.git"]);
  return dir;
}

async function installFakeGh(fixtures: Record<string, string>): Promise<{
  calls: () => Promise<string[]>;
  stdin: () => Promise<string>;
}> {
  const binDir = await createTempDir("vela-pr-bin-");
  const fixtureDir = await createTempDir("vela-pr-fixture-");
  const logPath = join(fixtureDir, "calls.log");
  const stdinPath = join(fixtureDir, "stdin.txt");
  await writeFile(logPath, "", "utf8");
  await writeFile(stdinPath, "", "utf8");
  for (const [key, body] of Object.entries(fixtures)) {
    await writeFile(join(fixtureDir, `${key}.json`), body, "utf8");
  }
  const script = `#!/bin/sh
cat >> "${logPath}" <<EOF
$*
EOF
printf '\n--- stdin ---\n' >> "${stdinPath}"
cat >> "${stdinPath}"
case "$1 $2" in
  "api graphql")
    case "$*" in
      *unresolveReviewThread*) cat "${fixtureDir}/graphql-unresolve.json" ;;
      *resolveReviewThread*) cat "${fixtureDir}/graphql-resolve.json" ;;
      *) cat "${fixtureDir}/graphql.json" ;;
    esac ;;
  "pr view") cat "${fixtureDir}/pr-view.json" ;;
  "repo view") cat "${fixtureDir}/repo-view.json" ;;
  "pr merge") cat "${fixtureDir}/merge.json" ;;
  "pr comment") cat "${fixtureDir}/comment.json" ;;
  "pr review") cat "${fixtureDir}/review.json" ;;
  "pr close") cat "${fixtureDir}/close.json" ;;
  "pr list") echo "[]" ;;
  *) echo "" ;;
esac
exit 0
`;
  const ghPath = join(binDir, "gh");
  await writeFile(ghPath, script, "utf8");
  await chmod(ghPath, 0o755);
  process.env.PATH = `${binDir}:${originalPath}`;
  return {
    calls: async () => (await readFile(logPath, "utf8")).split("\n").filter(Boolean),
    stdin: async () => readFile(stdinPath, "utf8"),
  };
}

function graphPayload(headSha: string): string {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          headRefOid: headSha,
          reviewDecision: "REVIEW_REQUIRED",
          reviewRequests: { nodes: [{ requestedReviewer: { login: "teammate" } }] },
          reviews: {
            nodes: [
              {
                author: { login: "reviewer2" },
                state: "APPROVED",
                body: "看了旧版本",
                submittedAt: "2026-09-30T10:00:00Z",
                url: "https://github.com/o/r/pull/128#pullrequestreview-1",
                commit: { oid: "b".repeat(40) },
              },
            ],
          },
          reviewThreads: {
            nodes: [
              {
                id: "PRRT_fixture",
                isResolved: false,
                isOutdated: false,
                path: "packages/workspace/src/git-service.ts",
                line: 412,
                viewerCanResolve: true,
                viewerCanUnresolve: false,
                resolvedBy: null,
                comments: {
                  nodes: [
                    {
                      id: "c1",
                      author: { login: "teammate" },
                      body: "这里要串行执行",
                      createdAt: "2026-10-02T09:00:00Z",
                      url: "https://github.com/o/r/pull/128#discussion_r1",
                      diffHunk: "@@ -1 +1 @@",
                      outdated: false,
                      path: "packages/workspace/src/git-service.ts",
                      line: 412,
                      originalCommit: { oid: headSha },
                      commit: { oid: headSha },
                      replyTo: null,
                      pullRequestReview: { state: "CHANGES_REQUESTED" },
                    },
                    {
                      id: "c2",
                      author: { login: "author" },
                      body: "已修复",
                      createdAt: "2026-10-02T09:10:00Z",
                      url: null,
                      diffHunk: null,
                      outdated: false,
                      path: "packages/workspace/src/git-service.ts",
                      line: 412,
                      originalCommit: { oid: headSha },
                      commit: { oid: headSha },
                      replyTo: { id: "c1" },
                      pullRequestReview: null,
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    },
  });
}

function prViewPayload(headSha: string): string {
  return JSON.stringify({
    number: 128,
    url: "https://github.com/o/r/pull/128",
    state: "OPEN",
    isDraft: false,
    baseRefName: "main",
    headRefName: "feature/x",
    headRefOid: headSha,
    mergeable: "MERGEABLE",
    mergeStateStatus: "BLOCKED",
    reviewDecision: "REVIEW_REQUIRED",
    statusCheckRollup: [{ conclusion: "SUCCESS", status: "COMPLETED", name: "build" }],
    reviews: {
      nodes: [
        {
          author: { login: "reviewer2" },
          state: "APPROVED",
          body: "看了旧版本",
          submittedAt: "2026-09-30T10:00:00Z",
          commit: { oid: "b".repeat(40) },
        },
      ],
    },
  });
}

const repoViewPayload = JSON.stringify({
  mergeCommitAllowed: true,
  squashMergeAllowed: true,
  rebaseMergeAllowed: false,
  viewerDefaultMergeMethod: "SQUASH",
});

const headSha = "a".repeat(40);

function createService(cwd: string): InstanceType<typeof PullRequestService> {
  // gh repo view 只返回请求的字段,仓库识别走本地远程快照,因此这里提供真实形状的快照。
  const snapshot: GitStatusSnapshot = {
    repo: { root: cwd, name: "repo", remoteUrl: "git@github.com:owner/repo.git", subdir: null, empty: false },
    branch: "feature/x",
    upstream: "origin/feature/x",
    ahead: 1,
    behind: 0,
    detached: false,
    files: [],
    addedLines: 0,
    deletedLines: 0,
    lastFetchAt: null,
    operation: null,
    identity: { name: null, email: null, configured: false },
    remotes: [{ name: "origin", fetchUrl: "git@github.com:owner/repo.git", pushUrl: "git@github.com:owner/repo.git", slug: "owner/repo" }],
  };
  const service = new PullRequestService(() => snapshot, () => undefined);
  service.setCwdProvider(() => cwd);
  return service;
}

describe("PR 评论与审阅线程 (PR-06)", () => {
  it("映射线程、回复与过期审阅,并保留代码版本", async () => {
    const cwd = await createCwd("vela-pr-06-");
    await installFakeGh({ graphql: graphPayload(headSha), "pr-view": prViewPayload(headSha), "repo-view": repoViewPayload });
    const service = createService(cwd);

    const result = await service.getReviewThreads(128);
    assert.equal(result.ok, true, result.message);
    assert.equal(result.headSha, headSha);
    assert.equal(result.threads.length, 1);
    const thread = result.threads[0]!;
    assert.equal(thread.id, "PRRT_fixture");
    assert.equal(thread.resolved, false);
    assert.equal(thread.resolvable, true);
    assert.equal(thread.path, "packages/workspace/src/git-service.ts");
    assert.equal(thread.comments.length, 2);
    assert.equal(thread.comments[1]!.author, "author");
    assert.equal(thread.comments[0]!.state, "changes_requested");
    assert.equal(thread.outdated, false);

    assert.equal(result.reviews.length, 1);
    // 审阅针对的是较早的提交,不能算作当前批准。
    assert.equal(result.reviews[0]!.outdated, true);
    assert.equal(result.reviews[0]!.commitSha, "b".repeat(40));
    assert.deepEqual(result.pendingReviewers, ["teammate"]);
  });

  it("评论正文经 stdin 传入,审阅事件与线程 id 作为参数传递", async () => {
    const cwd = await createCwd("vela-pr-06b-");
    const fake = await installFakeGh({
      graphql: graphPayload(headSha),
      "graphql-resolve": JSON.stringify({ data: { resolveReviewThread: { thread: { id: "PRRT_fixture", isResolved: true } } } }),
      "graphql-unresolve": JSON.stringify({ data: { unresolveReviewThread: { thread: { id: "PRRT_fixture", isResolved: false } } } }),
      "pr-view": prViewPayload(headSha),
      "repo-view": repoViewPayload,
      merge: "{}",
      comment: "",
      review: "",
      close: "{}",
    });
    const service = createService(cwd);

    const commented = await service.comment({ number: 128, body: "第一行\n第二行" });
    assert.equal(commented.ok, true, commented.message);
    assert.match(await fake.stdin(), /第一行\n第二行/, "评论正文必须经 stdin 传入");

    const reviewed = await service.review({ number: 128, event: "approve", body: "LGTM", commitSha: headSha });
    assert.equal(reviewed.ok, true, reviewed.message);

    const resolved = await service.resolveThread({ threadId: "PRRT_fixture", resolved: true });
    assert.equal(resolved.ok, true, resolved.message);
    assert.equal(resolved.resolved, true);

    const calls = await fake.calls();
    assert.ok(calls.some((line) => line.startsWith("pr comment 128 --body-file -")), calls.join("\n"));
    assert.ok(calls.some((line) => line.includes("pr review 128 --approve")), calls.join("\n"));
    // mutation 模板本身是多行的,合并后再检查变量。
    assert.ok(
      calls.join("\n").includes("id=PRRT_fixture"),
      "线程 id 必须作为 GraphQL 变量传入",
    );
  });

  it("审阅指定版本与当前 head 不一致时拒绝提交", async () => {
    const cwd = await createCwd("vela-pr-06c-");
    await installFakeGh({
      graphql: graphPayload(headSha),
      "pr-view": prViewPayload(headSha),
      "repo-view": repoViewPayload,
      review: "",
    });
    const service = createService(cwd);
    const result = await service.review({ number: 128, event: "approve", body: null, commitSha: "c".repeat(40) });
    assert.equal(result.ok, false);
    assert.match(result.message, /新提交|最新版本/);
  });
});

describe("PR 合并与关闭 (PR-07)", () => {
  it("预览列出阻止条件,检查通过也不等于可合并", async () => {
    const cwd = await createCwd("vela-pr-07-");
    await installFakeGh({ graphql: graphPayload(headSha), "pr-view": prViewPayload(headSha), "repo-view": repoViewPayload });
    const service = createService(cwd);

    const preview = await service.getMergePreview(128);
    assert.equal(preview.ok, true, preview.message);
    assert.equal(preview.headSha, headSha);
    assert.equal(preview.headMatches, true, "首次核对应以当前 head 建立基线");
    assert.equal(preview.checks, "passing");
    assert.equal(preview.canMerge, false, "检查通过不代表可以合并");
    assert.ok(preview.blockers.some((item) => item.includes("REVIEW_REQUIRED")));
    assert.ok(preview.blockers.some((item) => item.includes("BLOCKED")));
    assert.deepEqual(preview.allowedMethods, ["merge", "squash"]);
    assert.equal(preview.defaultMethod, "squash");
    assert.match(preview.rulesNote ?? "", /检查全绿/);
  });

  it("head 变化时拒绝合并且不调用 gh pr merge", async () => {
    const cwd = await createCwd("vela-pr-07b-");
    const fake = await installFakeGh({
      graphql: graphPayload(headSha),
      "pr-view": prViewPayload(headSha),
      "repo-view": repoViewPayload,
      merge: "{}",
    });
    const service = createService(cwd);
    await service.getMergePreview(128);

    const result = await service.merge({
      number: 128,
      method: "squash",
      expectedHeadSha: "c".repeat(40),
      deleteBranch: false,
    });
    assert.equal(result.ok, false);
    assert.equal(result.blocked, true);
    assert.match(result.message, /新提交/);
    const calls = await fake.calls();
    assert.equal(calls.some((line) => line.startsWith("pr merge")), false, "head 不一致时不能执行合并");
  });

  it("核对通过后使用 --match-head-commit 合并,并在仓库规则不允许时拒绝", async () => {
    const cwd = await createCwd("vela-pr-07c-");
    const fake = await installFakeGh({
      graphql: graphPayload(headSha),
      "pr-view": prViewPayload(headSha),
      "repo-view": repoViewPayload,
      merge: "{}",
    });
    const service = createService(cwd);
    const preview = await service.getMergePreview(128);
    assert.equal(preview.expectedHeadSha, headSha);

    const merged = await service.merge({
      number: 128,
      method: "squash",
      expectedHeadSha: headSha,
      deleteBranch: true,
      subject: "Add review threads",
      body: "Body",
    });
    assert.equal(merged.ok, true, merged.message);
    const calls = await fake.calls();
    const mergeCall = calls.find((line) => line.startsWith("pr merge"));
    assert.ok(mergeCall, calls.join("\n"));
    assert.match(mergeCall!, /--squash/);
    assert.match(mergeCall!, new RegExp(`--match-head-commit ${headSha}`));
    assert.match(mergeCall!, /--delete-branch/);

    // 仓库只允许 merge/squash,rebase 必须在调用 gh pr merge 之前被拒绝。
    const rejected = await service.merge({
      number: 128,
      method: "rebase",
      expectedHeadSha: headSha,
      deleteBranch: false,
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.blocked, true);
    assert.match(rejected.message, /不允许/);
    const mergeCalls = (await fake.calls()).filter((line) => line.startsWith("pr merge"));
    assert.equal(mergeCalls.length, 1, "被拒绝的合并不能执行 gh pr merge");
  });

  it("关闭 PR 只调用 gh pr close,并带上说明", async () => {
    const cwd = await createCwd("vela-pr-07d-");
    const fake = await installFakeGh({
      graphql: graphPayload(headSha),
      "pr-view": prViewPayload(headSha),
      "repo-view": repoViewPayload,
      close: "{}",
    });
    const service = createService(cwd);
    const result = await service.close({ number: 128, comment: "改为在下一个版本处理", deleteBranch: false });
    assert.equal(result.ok, true, result.message);
    const calls = await fake.calls();
    assert.ok(calls.some((line) => line.startsWith("pr close 128") && line.includes("--comment 改为在下一个版本处理")), calls.join("\n"));
    assert.equal(calls.some((line) => line.includes("--delete-branch")), false);
  });

  it("读取失败时返回明确错误而不是抛出", async () => {
    const cwd = await createCwd("vela-pr-07e-");
    await installFakeGh({ graphql: "", "pr-view": "", "repo-view": "" });
    const service = createService(cwd);
    const preview = await service.getMergePreview(128);
    assert.equal(preview.ok, false);
    assert.ok(preview.message.length > 0);

    const threads = await service.getReviewThreads(128);
    assert.equal(threads.ok, false);
    assert.equal(threads.threads.length, 0);
  });
});
