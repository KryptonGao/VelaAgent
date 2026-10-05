/** Deterministic browser fixture for the version control page. Not imported by production. */
import React, { useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import type {
  BranchSummary,
  GitCommitDetail,
  GitCommitSummary,
  GitForcePushPreview,
  GitGraphSlice,
  GitHistoryOpPreview,
  GitOperationSnapshot,
  GitRecoveryPreview,
  GitReflogSnapshot,
  GitReleaseListResult,
  GitReleaseNotesScope,
  GitRewritePreview,
  GitStatusSnapshot,
  GitTagInfo,
  PrCompareScope,
  PrMergePreview,
  PrReviewThreadsResult,
  PrSummary,
  PullRequestInfo,
  SessionSnapshot,
  VelaApi,
  WorkspaceFileContent,
} from "@vela/shared";
import { VersionControlView } from "../src/renderer/components/version-control/VersionControlView";
import type { ProjectApi } from "../src/renderer/hooks/useProject";
import "../src/renderer/styles.css";
import "../src/renderer/version-control.css";

const now = Date.now();

const git: GitStatusSnapshot = {
  repo: { root: "/Users/chenkaigao/Documents/Program/VelaHarness", name: "VelaHarness", remoteUrl: "git@github.com:KryptonGao/VelaHarness.git", subdir: null, empty: false },
  branch: "feature/version-control-ui",
  upstream: "origin/feature/version-control-ui",
  ahead: 2,
  behind: 0,
  detached: false,
  files: [
    { path: "packages/workspace/src/git-service.ts", oldPath: null, status: "modified", indexStatus: "modified", worktreeStatus: null, addedLines: 18, deletedLines: 3, indexAddedLines: 18, indexDeletedLines: 3, worktreeAddedLines: 0, worktreeDeletedLines: 0 },
    { path: "apps/desktop/src/renderer/components/ChatView.tsx", oldPath: null, status: "modified", indexStatus: "modified", worktreeStatus: "modified", addedLines: 12, deletedLines: 2, indexAddedLines: 9, indexDeletedLines: 1, worktreeAddedLines: 3, worktreeDeletedLines: 1 },
    { path: "apps/desktop/src/renderer/styles.css", oldPath: null, status: "modified", indexStatus: null, worktreeStatus: "modified", addedLines: 8, deletedLines: 0, indexAddedLines: 0, indexDeletedLines: 0, worktreeAddedLines: 8, worktreeDeletedLines: 0 },
    { path: "packages/workspace/src/pull-request-service.ts", oldPath: null, status: "added", indexStatus: null, worktreeStatus: "added", addedLines: 26, deletedLines: 0, indexAddedLines: 0, indexDeletedLines: 0, worktreeAddedLines: 26, worktreeDeletedLines: 0 },
    { path: "docs/old-notes.md", oldPath: "docs/notes.md", status: "renamed", indexStatus: "renamed", worktreeStatus: null, addedLines: 2, deletedLines: 1, indexAddedLines: 2, indexDeletedLines: 1, worktreeAddedLines: 0, worktreeDeletedLines: 0 },
    { path: "scripts/legacy.mjs", oldPath: null, status: "deleted", indexStatus: null, worktreeStatus: "deleted", addedLines: 0, deletedLines: 40, indexAddedLines: 0, indexDeletedLines: 0, worktreeAddedLines: 0, worktreeDeletedLines: 40 },
    { path: "packages/agent/src/conflict.ts", oldPath: null, status: "conflicted", indexStatus: "conflicted", worktreeStatus: "conflicted", addedLines: 6, deletedLines: 6, indexAddedLines: 6, indexDeletedLines: 6, worktreeAddedLines: 6, worktreeDeletedLines: 6 },
  ],
  addedLines: 60,
  deletedLines: 52,
  lastFetchAt: now - 8 * 60_000,
  operation: null,
  identity: { name: "Chenkai Gao", email: "chenkai@example.com", configured: true },
  remotes: [
    { name: "origin", fetchUrl: "git@github.com:KryptonGao/VelaHarness.git", pushUrl: "git@github.com:KryptonGao/VelaHarness.git", slug: "KryptonGao/VelaHarness" },
  ],
};

const branches: BranchSummary[] = [
  { name: "feature/version-control-ui", current: true, remote: false, upstream: "origin/feature/version-control-ui", worktreePath: null, lastCommitSha: "e4a91c2", lastCommitAt: now - 12 * 60_000 },
  { name: "main", current: false, remote: false, upstream: "origin/main", worktreePath: null, lastCommitSha: "92fc1a8", lastCommitAt: now - 26 * 60 * 60_000 },
  { name: "feature/review-summary", current: false, remote: false, upstream: null, worktreePath: "/tmp/worktrees/review", lastCommitSha: "7bd38fe", lastCommitAt: now - 3 * 86_400_000 },
  { name: "origin/main", current: false, remote: true, upstream: null, worktreePath: null, lastCommitSha: "92fc1a8", lastCommitAt: now - 26 * 60 * 60_000 },
  { name: "origin/feature/version-control-ui", current: false, remote: true, upstream: null, worktreePath: null, lastCommitSha: "7bd38fe", lastCommitAt: now - 46 * 60_000 },
];

function commit(sha: string, shortSha: string, parents: string[], subject: string, authorName: string, minutesAgo: number, refs: GitCommitSummary["refs"], pushed: boolean | null, boundary = false): GitCommitSummary {
  return {
    sha, shortSha, parents, subject, authorName,
    authorEmail: "dev@example.com",
    authorAt: now - minutesAgo * 60_000,
    committerName: authorName,
    committerAt: now - minutesAgo * 60_000,
    refs, pushed, boundary,
  };
}

const graphCommits: GitCommitSummary[] = [
  commit("e4a91c2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "e4a91c2", ["7bd38feaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"], "feat: add version control workspace", "Chenkai Gao", 12, [{ name: "HEAD -> feature/version-control-ui", kind: "head" }, { name: "feature/version-control-ui", kind: "local" }], false),
  commit("7bd38feaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "7bd38fe", ["92fc1a8aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"], "feat: generate commit message from staged changes", "Chenkai Gao", 46, [{ name: "origin/feature/version-control-ui", kind: "remote" }], true),
  commit("92fc1a8aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "92fc1a8", ["204ab91aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "1c830daaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"], "Merge branch 'feature/review-summary'", "Mei Lin", 26 * 60, [{ name: "main", kind: "local" }, { name: "origin/main", kind: "remote" }, { name: "v0.1.0", kind: "tag" }], true),
  commit("204ab91aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "204ab91", ["1c830daaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"], "fix: refresh worktree status after switching", "Chenkai Gao", 26 * 60 + 40, [], true),
  commit("1c830daaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "1c830da", ["0a11b22aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"], "refactor: centralize workspace git status", "Mei Lin", 2 * 24 * 60, [], true),
  commit("0a11b22aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "0a11b22", ["9f7e001aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"], "chore: bump dependencies", "Mei Lin", 4 * 24 * 60, [], true),
  commit("9f7e001aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "9f7e001", [], "chore: initial commit", "Mei Lin", 30 * 24 * 60, [], true),
];

const graphSlice: GitGraphSlice = {
  snapshotId: "fixture-snapshot",
  commits: graphCommits,
  hasMore: true,
  pendingParents: ["9f7e001aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
  shallowBoundary: [],
};

const commitDetail: GitCommitDetail = {
  commit: graphCommits[0]!,
  body: "Adds the version control workspace: changes review, commit composer, history graph and pull request creation.",
  files: [
    { path: "apps/desktop/src/renderer/components/version-control/VersionControlView.tsx", oldPath: null, status: "added", addedLines: 66, deletedLines: 0 },
    { path: "apps/desktop/src/renderer/components/ChatView.tsx", oldPath: null, status: "modified", addedLines: 52, deletedLines: 4 },
    { path: "apps/desktop/src/renderer/styles.css", oldPath: null, status: "modified", addedLines: 14, deletedLines: 0 },
  ],
  diff: [
    "diff --git a/apps/desktop/src/renderer/components/ChatView.tsx b/apps/desktop/src/renderer/components/ChatView.tsx",
    "--- a/apps/desktop/src/renderer/components/ChatView.tsx",
    "+++ b/apps/desktop/src/renderer/components/ChatView.tsx",
    "@@ -496,3 +496,6 @@ return (",
    "       <nav className=\"conversation-view-tabs\">",
    "-        <button role=\"tab\">轨迹</button>",
    "+        <button role=\"tab\">轨迹</button>",
    "+        <button role=\"tab\">版本控制</button>",
    "       </nav>",
    "diff --git a/apps/desktop/src/renderer/components/version-control/VersionControlView.tsx b/apps/desktop/src/renderer/components/version-control/VersionControlView.tsx",
    "--- /dev/null",
    "+++ b/apps/desktop/src/renderer/components/version-control/VersionControlView.tsx",
    "@@ -0,0 +1,4 @@",
    "+export function VersionControlView() {",
    "+  return <div className=\"vc-root\" />;",
    "+}",
  ].join("\n"),
  parentSha: "7bd38feaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  isRoot: false,
  parents: ["7bd38feaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
};

const diffText = [
  "diff --git a/apps/desktop/src/renderer/components/ChatView.tsx b/apps/desktop/src/renderer/components/ChatView.tsx",
  "--- a/apps/desktop/src/renderer/components/ChatView.tsx",
  "+++ b/apps/desktop/src/renderer/components/ChatView.tsx",
  "@@ -184,8 +184,10 @@ export function ChatView(...) {",
  "   const streaming = session?.status === \"streaming\";",
  "   const activeAssistantId = streaming",
  "-    ? [...messages].reverse().find((message) => message.role === \"assistant\")?.id",
  "+    ? [...messages].reverse().find((message) => message.role === \"assistant\")?.id",
  "     : undefined;",
  "+  const elapsed = streaming ? getActiveTurnElapsed(session) : null;",
  "   const title = session?.title || tr(\"新对话\", \"New chat\");",
].join("\n");

const prInfo: PullRequestInfo = {
  status: "no-pr",
  ghAvailable: true,
  reason: null,
  stale: false,
  checkedAt: now,
  pr: null,
  otherBranchPrs: [],
  checks: [],
  repo: { owner: "KryptonGao", name: "VelaHarness", host: "github.com", baseRepo: "KryptonGao/VelaHarness" },
  defaultBase: "main",
  baseOptions: ["main", "develop", "feature/version-control-ui"],
  headRemote: "origin",
  fork: null,
};

const scope: PrCompareScope = {
  base: "main",
  head: "feature/version-control-ui",
  baseRepo: "KryptonGao/VelaHarness",
  headRepo: "KryptonGao/VelaHarness",
  commits: graphCommits.slice(0, 3).map((entry) => ({ sha: entry.sha, subject: entry.subject, authorName: entry.authorName })),
  fileCount: 8,
  addedLines: 132,
  deletedLines: 27,
  headPushed: true,
  unpushedCount: 1,
  pushTarget: { remote: "origin", branch: "feature/version-control-ui" },
  empty: false,
  diff: diffText,
  diffTruncated: false,
  error: null,
};

const operations: GitOperationSnapshot = {
  running: [],
  recent: [
    {
      id: "op-1",
      type: "commit-push",
      workspace: git.repo!.root,
      repoRoot: git.repo!.root,
      branch: "feature/version-control-ui",
      expectedHead: "7bd38feaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      status: "partial",
      steps: [
        { id: "commit", label: "创建提交", status: "success", detail: "e4a91c2" },
        { id: "push", label: "推送到 origin/feature/version-control-ui", status: "failed", detail: "远程分支已变化" },
      ],
      startedAt: now - 10 * 60_000,
      completedAt: now - 9 * 60_000,
      resultSha: "e4a91c2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      resultUrl: null,
      prNumber: null,
      error: "远程分支已变化，请先 Fetch 后重试",
    },
    {
      id: "op-2",
      type: "pr-create",
      workspace: git.repo!.root,
      repoRoot: git.repo!.root,
      branch: "feature/version-control-ui",
      expectedHead: "e4a91c2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      status: "unconfirmed",
      steps: [{ id: "create", label: "创建 Pull Request", status: "failed", detail: "请求超时" }],
      startedAt: now - 3 * 60_000,
      completedAt: now - 2 * 60_000,
      resultSha: null,
      resultUrl: null,
      prNumber: null,
      error: "请求超时，结果待确认",
    },
  ],
};

const session = {
  id: "chat-1",
  title: "版本控制工作流设计",
  status: "ready",
  cwd: git.repo!.root,
  model: "gpt-5",
  modelProvider: "openai",
  modelId: "gpt-5",
  modelReady: true,
  thinkingLevel: "medium",
  thinkingLevels: ["off", "low", "medium", "high"],
  tools: [],
  mode: "agent",
  proposedPlan: null,
  planRevisions: [],
  executionPlan: null,
  goal: { id: "goal-1", objective: "在「对话」「轨迹」之后新增「版本控制」标签页", status: "active", note: null, workRevision: 0, validation: null, updatedAt: now },
  error: null,
} as SessionSnapshot;

const project = {
  workspace: { current: git.repo!.root, recents: [] },
  environment: { kind: "local", label: "本地", path: git.repo!.root, available: true },
  environments: [],
  git,
  branches,
  pr: prInfo,
  sandboxMode: "ask",
  approval: null,
  error: null,
  clearError: () => undefined,
  openWorkspaceDialog: () => Promise.resolve({ current: git.repo!.root, recents: [] }),
  selectRecentWorkspace: () => Promise.resolve({ current: git.repo!.root, recents: [] }),
  closeWorkspace: () => Promise.resolve({ current: null, recents: [] }),
  removeRecentWorkspace: () => Promise.resolve({ current: git.repo!.root, recents: [] }),
  switchBranch: () => Promise.resolve(true),
  createBranch: () => Promise.resolve(true),
  stageFiles: () => Promise.resolve(true),
  unstageFiles: () => Promise.resolve(true),
  discardFiles: () => Promise.resolve(true),
  openFile: () => Promise.resolve(true),
  fileDiff: () => Promise.resolve(diffText),
  refreshPullRequest: () => Promise.resolve(true),
  openPullRequest: () => Promise.resolve(true),
  createPullRequest: () => Promise.resolve(true),
  setSandboxMode: () => Promise.resolve("ask"),
  setEnvironment: () => Promise.resolve(null),
  replyApproval: () => Promise.resolve(),
} as unknown as ProjectApi;

const readWorkspaceFile = (path: string): Promise<WorkspaceFileContent> => Promise.resolve({
  path,
  absolutePath: `${git.repo!.root}/${path}`,
  kind: "text",
  content: "export const fixture = true;\n",
  size: 26,
  truncated: false,
});

const tag = (name: string, annotated: boolean, pushed: boolean | null, daysAgo: number, subject: string): GitTagInfo => ({
  name,
  sha: "e4a91c2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  shortSha: "e4a91c2",
  annotated,
  taggerName: annotated ? "Chenkai Gao" : null,
  at: now - daysAgo * 86_400_000,
  subject,
  message: annotated ? subject : null,
  targetSubject: subject,
  pushed,
  remotes: pushed ? ["origin"] : [],
});

const tags: GitTagInfo[] = [
  tag("v1.1.0", true, true, 1, "发布 1.1.0"),
  tag("v1.0.0", true, true, 21, "发布 1.0.0"),
  tag("v0.9.0", false, false, 40, "转到 0.9.0"),
];

const releases: GitReleaseListResult = {
  ok: true,
  message: "共 1 条发布记录",
  ghAvailable: true,
  releases: [
    {
      tagName: "v1.0.0",
      name: "Vela 1.0.0",
      url: "https://github.com/KryptonGao/VelaHarness/releases/tag/v1.0.0",
      draft: false,
      prerelease: false,
      isLatest: true,
      createdAt: now - 22 * 86_400_000,
      publishedAt: now - 21 * 86_400_000,
      body: "## 新增\n- 版本控制页面\n\n## 修复\n- 修正 Diff 滚动位置",
      author: "KryptonGao",
    },
  ],
  tagsWithoutRelease: ["v1.1.0", "v0.9.0"],
};

const releaseScope: GitReleaseNotesScope = {
  baseTag: "v1.0.0",
  targetTag: "v1.1.0",
  baseSha: "92fc1a8bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  headSha: "e4a91c2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  commits: graphCommits.slice(1, 4).map((entry) => ({
    sha: entry.sha,
    shortSha: entry.shortSha,
    subject: entry.subject,
    authorName: entry.authorName,
    authorAt: entry.authorAt,
    merge: false,
  })),
  commitCount: 3,
  pullRequests: [{ number: 128, title: "Add review threads and merge controls", author: "KryptonGao", url: "https://github.com/KryptonGao/VelaHarness/pull/128", mergedAt: now - 2 * 86_400_000 }],
  contributors: ["Chenkai Gao", "KryptonGao"],
  fileCount: 12,
  addedLines: 320,
  deletedLines: 48,
  diff: diffText,
  diffTruncated: false,
  previousNotes: "## 新增\n- 版本控制页面",
  manualNotes: null,
  error: null,
};

const reflog: GitReflogSnapshot = {
  entries: [
    { id: "HEAD@{0}", index: 0, sha: "e4a91c2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", shortSha: "e4a91c2", action: "commit", message: "commit: feat: review threads", at: now - 12 * 60_000, reachable: true, current: true, refs: ["feature/version-control-ui", "origin/feature/version-control-ui"] },
    { id: "HEAD@{1}", index: 1, sha: "7bd38feaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", shortSha: "7bd38fe", action: "reset", message: "reset: moving to HEAD~2", at: now - 40 * 60_000, reachable: false, current: false, refs: [] },
    { id: "HEAD@{2}", index: 2, sha: "92fc1a8bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", shortSha: "92fc1a8", action: "commit", message: "commit: feat: version control workspace", at: now - 3 * 86_400_000, reachable: true, current: false, refs: ["main"] },
  ],
  total: 3,
  truncated: false,
  head: "e4a91c2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  branch: "feature/version-control-ui",
  error: null,
};

const recoveryPreview: GitRecoveryPreview = {
  target: reflog.entries[1]!,
  mode: "branch",
  branchName: "recover-7bd38fe",
  head: "e4a91c2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  branch: "feature/version-control-ui",
  refName: "refs/heads/recover-7bd38fe",
  discarded: [],
  changeCount: 4,
  keepNote: "从 7bd38fe 新建分支 recover-7bd38fe；当前分支、HEAD、工作区与未提交内容都不会改变",
  requiresConfirm: false,
  ok: true,
  reason: null,
  error: null,
};

const historyPreview: GitHistoryOpPreview = {
  action: "revert",
  commit: { sha: "92fc1a8bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", shortSha: "92fc1a8", subject: "feat: version control workspace", authorName: "Chenkai Gao", authorAt: now - 3 * 86_400_000 },
  branch: "feature/version-control-ui",
  head: "e4a91c2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  isMerge: false,
  parents: ["6a1f0c3aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
  files: [{ path: "packages/workspace/src/git-service.ts", oldPath: null, status: "modified", addedLines: 18, deletedLines: 3 }],
  fileCount: 1,
  addedLines: 18,
  deletedLines: 3,
  dirty: false,
  alreadyApplied: false,
  ok: true,
  reason: null,
  error: null,
};

const rewritePreview: GitRewritePreview = {
  action: "fixup",
  source: { sha: "7bd38feaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", shortSha: "7bd38fe", subject: "fix: review thread state", authorName: "Chenkai Gao", authorAt: now - 2 * 86_400_000 },
  target: { sha: "92fc1a8bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", shortSha: "92fc1a8", subject: "feat: version control workspace", authorName: "Chenkai Gao", authorAt: now - 3 * 86_400_000 },
  branch: "feature/version-control-ui",
  head: "e4a91c2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  rewritten: [
    { sha: "92fc1a8bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", shortSha: "92fc1a8", subject: "feat: version control workspace", authorName: "Chenkai Gao", authorAt: now - 3 * 86_400_000 },
    { sha: "7bd38feaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", shortSha: "7bd38fe", subject: "fix: review thread state", authorName: "Chenkai Gao", authorAt: now - 2 * 86_400_000 },
    { sha: "e4a91c2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", shortSha: "e4a91c2", subject: "feat: review threads", authorName: "Chenkai Gao", authorAt: now - 12 * 60_000 },
  ],
  rewrittenCount: 3,
  pushedCount: 2,
  dirty: false,
  ok: true,
  reason: null,
  expectedCount: 12,
  error: null,
};

const forcePushPreview: GitForcePushPreview = {
  ok: true,
  remote: "origin",
  branch: "feature/version-control-ui",
  localSha: "e4a91c2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  localShortSha: "e4a91c2",
  remoteSha: "7bd38feaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  ahead: [{ sha: "e4a91c2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", shortSha: "e4a91c2", subject: "feat: review threads", authorName: "Chenkai Gao", authorAt: now - 12 * 60_000 }],
  overwritten: [{ sha: "3c9d1e5aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", shortSha: "3c9d1e5", subject: "chore: drop old fixture", authorName: "KryptonGao", authorAt: now - 26 * 60 * 60_000 }],
  fastForward: false,
  stale: false,
  upstream: "origin/feature/version-control-ui",
  message: "强推会用本地 e4a91c2 覆盖远程 7bd38fe，远程上有 1 个提交会从分支上移除（最新一条：3c9d1e5 chore: drop old fixture）",
  error: null,
};

const openPr: PrSummary = {
  number: 128,
  title: "Add review threads and merge controls",
  url: "https://github.com/KryptonGao/VelaHarness/pull/128",
  state: "open",
  isDraft: false,
  reviewDecision: "REVIEW_REQUIRED",
  approvals: 1,
  checks: "passing",
  baseRefName: "main",
  headRefName: "feature/version-control-ui",
  baseRepo: "KryptonGao/VelaHarness",
  headRepo: "KryptonGao/VelaHarness",
  author: "KryptonGao",
  labels: ["version-control"],
  reviewers: ["teammate"],
  assignees: [],
  closingIssues: [],
  updatedAt: now - 12 * 60_000,
  additions: 132,
  deletions: 27,
  changedFiles: 8,
  body: "## Summary\n\nAdds review threads, approvals and merge checks.",
};

const reviewThreads: PrReviewThreadsResult = {
  ok: true,
  message: "PR #128 有 2 个审阅线程(1 个未解决)、2 条审阅结论",
  threads: [
    {
      id: "PRRT_fixture",
      path: "packages/workspace/src/git-service.ts",
      line: 412,
      commitSha: "e4a91c2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      outdated: false,
      resolved: false,
      resolvable: true,
      resolvedBy: null,
      comments: [
        { id: "c1", author: "teammate", body: "这里应该复用已有的 mutationChain，避免并发写索引。", createdAt: now - 30 * 60_000, url: null, path: "packages/workspace/src/git-service.ts", line: 412, commitSha: "e4a91c2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", outdated: false, diffHunk: "@@ -410,6 +410,8 @@\n   async merge() {\n+    await this.runExclusive(task);", isReview: true, state: "changes_requested", replies: [
          { id: "c2", author: "KryptonGao", body: "已改为通过 runMutation 执行。", createdAt: now - 20 * 60_000, url: null, path: "packages/workspace/src/git-service.ts", line: 412, commitSha: "e4a91c2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", outdated: false, diffHunk: null, isReview: false, state: null, replies: [] },
        ] },
      ],
    },
    {
      id: "PRRT_fixture_2",
      path: "apps/desktop/src/renderer/components/version-control/PrMergePanel.tsx",
      line: 120,
      commitSha: "92fc1a8bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      outdated: true,
      resolved: true,
      resolvable: true,
      resolvedBy: "teammate",
      comments: [
        { id: "c3", author: "teammate", body: "合并前必须核对 head。", createdAt: now - 2 * 86_400_000, url: null, path: "apps/desktop/src/renderer/components/version-control/PrMergePanel.tsx", line: 120, commitSha: "92fc1a8bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", outdated: true, diffHunk: null, isReview: true, state: "commented", replies: [] },
      ],
    },
  ],
  reviews: [
    { author: "teammate", state: "changes_requested", rawState: "CHANGES_REQUESTED", body: "请先处理并发写入的问题。", submittedAt: now - 30 * 60_000, url: null, commitSha: "e4a91c2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", outdated: false },
    { author: "reviewer2", state: "approved", rawState: "APPROVED", body: "看了旧版本，没问题。", submittedAt: now - 2 * 86_400_000, url: null, commitSha: "92fc1a8bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", outdated: true },
  ],
  reviewDecision: "REVIEW_REQUIRED",
  pendingReviewers: ["teammate"],
  headSha: "e4a91c2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  previousHeadSha: "92fc1a8bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
};

const mergePreview: PrMergePreview = {
  ok: true,
  message: "PR #128：暂不能合并：仍需要审阅批准（REVIEW_REQUIRED）",
  number: 128,
  url: openPr.url,
  state: "open",
  isDraft: false,
  baseRefName: "main",
  headRefName: "feature/version-control-ui",
  headSha: "e4a91c2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  expectedHeadSha: "e4a91c2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  headMatches: true,
  mergeable: "mergeable",
  mergeStateStatus: "BLOCKED",
  allowedMethods: ["merge", "squash"],
  defaultMethod: "squash",
  reviewDecision: "REVIEW_REQUIRED",
  approvals: 1,
  reviews: reviewThreads.reviews,
  checks: "passing",
  blockers: ["仍需要审阅批准（REVIEW_REQUIRED）", "合并状态为 BLOCKED，GitHub 当前规则不允许合并"],
  canMerge: false,
  rulesNote: "合并可行性来自 GitHub 当前的合并规则与当前 head 核对；检查全绿只说明检查通过，不代表可以合并，合并时会再次以预期 head 校验。",
};

/** ?pr=open 时让 PR 详情页可见,便于手动检查审阅与合并面板。 */
let prFixture: PullRequestInfo = prInfo;

const vela = {
  platform: "darwin",
  getGitGuard: () => Promise.resolve({ agentRunning: false, conversationId: null, reason: null }),
  getOperationRecords: () => Promise.resolve(operations),
  refreshOperation: () => Promise.resolve(null),
  getPullRequestDetail: () => Promise.resolve(prFixture),
  getCommitGraph: () => Promise.resolve(graphSlice),
  getCommitDetail: () => Promise.resolve(commitDetail),
  searchCommits: () => Promise.resolve({ commits: graphCommits.slice(1, 3), hasMore: false }),
  getStagedDiff: () => Promise.resolve(diffText),
  getPrScope: () => Promise.resolve(scope),
  listPrTemplates: () => Promise.resolve([{ path: ".github/PULL_REQUEST_TEMPLATE.md", name: "PULL_REQUEST_TEMPLATE", body: "## Summary\n\n## Validation\n- [ ] Describe checks run for this change" }]),
  createPullRequestNative: () => Promise.resolve({ ok: true, step: "create", pushed: false, pr: null, url: "https://github.com/KryptonGao/VelaHarness/pull/1", number: 1, message: "已创建 PR #1", unconfirmed: false }),
  commit: () => Promise.resolve({ ok: true, sha: "abc1234", shortSha: "abc1234", branch: "feature/version-control-ui", message: "提交成功", output: "" }),
  commitAndPush: () => Promise.resolve({ commit: { ok: true, sha: "abc1234", shortSha: "abc1234", branch: "feature/version-control-ui", message: "提交成功", output: "" }, push: { outcome: "ok", ok: true, message: "已推送", confirmed: true, remote: "origin", branch: "feature/version-control-ui" } }),
  pushBranch: () => Promise.resolve({ outcome: "ok", ok: true, message: "已推送", confirmed: true, remote: "origin", branch: "feature/version-control-ui" }),
  fetchRemote: () => Promise.resolve({ ok: true, remote: "origin", at: Date.now(), message: "Fetch 完成" }),
  pullLatest: () => Promise.resolve({ outcome: "up-to-date", ok: true, message: "已经是最新版本" }),
  generateTextAssist: () => Promise.resolve({ requestId: "ai-1", title: "feat: add version control workspace", body: "Adds changes review, commit and history graph.", modelLabel: "GPT-5", scopeLabel: "依据已暂存的 2 个文件", snapshotKey: "commit||feature/version-control-ui|e4a91c2|apps/desktop/src/renderer/components/ChatView.tsx,packages/workspace/src/git-service.ts|", cancelled: false }),
  cancelTextAssist: () => Promise.resolve(),
  setGitIdentity: () => Promise.resolve(git),
  readWorkspaceFile,
  openPullRequest: () => Promise.resolve(),
  createPullRequest: () => Promise.resolve(),
  // ---- P2:历史操作、恢复、同步、Tag/Release、PR 审阅与合并 ----
  previewHistoryOp: () => Promise.resolve(historyPreview),
  runHistoryOp: () => Promise.resolve({ ok: true, action: "revert", message: "已创建撤销提交 e4a91c2", sha: "e4a91c2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", shortSha: "e4a91c2", conflicted: false, conflictedPaths: [], operation: null, output: "" }),
  createBranchAt: () => Promise.resolve({ ok: true, message: "已从 7bd38fe 创建分支 hotfix/1.0.1，当前分支与未提交内容保持不变", branch: "hotfix/1.0.1", startPoint: "7bd38fe", startShortSha: "7bd38fe", checkedOut: false, currentBranch: "feature/version-control-ui", currentHead: "e4a91c2", worktreeUntouched: true, changeCount: 4 }),
  previewRewrite: () => Promise.resolve(rewritePreview),
  runRewrite: () => Promise.resolve({ ok: true, action: "fixup", message: "已把 7bd38fe 并入 92fc1a8；重写包含已推送提交，需要另行用安全强推同步（不会自动执行）", head: "e4a91c2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", shortHead: "e4a91c2", rewrittenCount: 3, pushedCount: 2, output: "" }),
  getReflog: () => Promise.resolve(reflog),
  previewRecovery: () => Promise.resolve(recoveryPreview),
  runRecovery: () => Promise.resolve({ ok: true, mode: "branch", message: "已从 7bd38fe 新建分支 recovered，当前分支与工作区未改变", head: "e4a91c2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", shortHead: "e4a91c2", branch: "feature/version-control-ui", createdBranch: "recovered", changeCount: 4, conflictedPaths: [], output: "" }),
  pullWithStrategy: () => Promise.resolve({ outcome: "up-to-date", ok: true, message: "已经是最新版本", strategy: "ff-only" }),
  previewForcePush: () => Promise.resolve(forcePushPreview),
  forcePushBranch: () => Promise.resolve({ ok: true, outcome: "ok", message: "已安全强推 feature/version-control-ui 到 origin", remote: "origin", branch: "feature/version-control-ui", remoteSha: "e4a91c2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", stale: false, confirmed: true }),
  listTags: () => Promise.resolve({ ok: true, message: "共 3 个标签", tags, total: 3, truncated: false }),
  createTag: () => Promise.resolve({ ok: true, message: "已创建附注标签 v1.1.0 → e4a91c2，并已推送到 origin", tag: tags[0]!, pushed: true, output: "" }),
  deleteTag: () => Promise.resolve({ ok: true, message: "已删除本地标签 v0.9.0", tag: null, pushed: false, output: "" }),
  listReleases: () => Promise.resolve(releases),
  createRelease: () => Promise.resolve({ ok: true, message: "已创建发布 v1.1.0", release: releases.releases[0]! }),
  getReleaseNotesScope: () => Promise.resolve(releaseScope),
  getPullRequestReviewThreads: () => Promise.resolve(reviewThreads),
  commentPullRequest: () => Promise.resolve({ ok: true, message: "已在 PR #128 发表评论", review: null, threads: reviewThreads.threads, reviews: reviewThreads.reviews, reviewDecision: reviewThreads.reviewDecision }),
  reviewPullRequest: () => Promise.resolve({ ok: true, message: "已提交审阅（approve）", review: reviewThreads.reviews[0]!, threads: reviewThreads.threads, reviews: reviewThreads.reviews, reviewDecision: "APPROVED" }),
  resolvePullRequestThread: () => Promise.resolve({ ok: true, message: "审阅线程已标记为已解决", threadId: "PRRT_fixture", resolved: true }),
  getPullRequestMergePreview: () => Promise.resolve(mergePreview),
  mergePullRequest: () => Promise.resolve({ ok: true, message: "PR #128 已合并（方式：squash）", merged: true, blocked: false, pr: openPr }),
  closePullRequest: () => Promise.resolve({ ok: true, message: "PR #128 已关闭", pr: openPr }),
} as unknown as VelaApi;
(window as unknown as { vela: VelaApi }).vela = vela;

function Fixture({ page, select }: { page: string | null; select: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!page) return;
    const index = page === "history" ? 1 : page === "pr" ? 2 : 0;
    const timer = window.setTimeout(() => {
      const buttons = ref.current?.querySelectorAll<HTMLButtonElement>(".vc-subtabs button");
      buttons?.[index]?.click();
      if (select) {
        window.setTimeout(() => {
          ref.current?.querySelector<HTMLElement>(".vc-commit-row")?.click();
        }, 300);
      }
    }, 200);
    return () => window.clearTimeout(timer);
  }, [page, select]);
  return (
    <div className="fixture" ref={ref}>
      <VersionControlView
        project={project}
        session={session}
        hidden={false}
        pendingInteraction={false}
        onOpenConversation={() => undefined}
        onAbort={() => undefined}
        onOpenFile={() => undefined}
      />
    </div>
  );
}

const params = new URLSearchParams(location.search);
if (params.get("pr") === "open") {
  prFixture = {
    ...prInfo,
    status: "ok",
    reason: null,
    stale: false,
    pr: openPr,
    checks: [
      { name: "build", workflow: "CI", state: "passing", link: null, description: null },
      { name: "typecheck", workflow: "CI", state: "passing", link: null, description: null },
    ],
  };
}
const page = params.get("page");
const select = params.get("select") === "1";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Fixture page={page} select={select} />
  </React.StrictMode>,
);
