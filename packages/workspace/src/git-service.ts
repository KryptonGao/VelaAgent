import { randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative } from "node:path";
import type {
  BranchSummary,
  GitBranchAtInput,
  GitBranchAtResult,
  GitBranchDeleteInput,
  GitBranchDeleteResult,
  GitBranchDetail,
  GitChangeScope,
  GitCommitDetail,
  GitCommitFileChange,
  GitCommitInput,
  GitCommitResult,
  GitCommitSearchResult,
  GitCommitSummary,
  GitCompareCommit,
  GitCompareFile,
  GitCompareResult,
  GitConflictFile,
  GitConflictResolveInput,
  GitConflictResolveResult,
  GitDiffOptions,
  GitFetchResult,
  GitFileChange,
  GitFileStatus,
  GitForcePushCommitRef,
  GitForcePushInput,
  GitForcePushPreview,
  GitForcePushResult,
  GitGraphQuery,
  GitGraphScope,
  GitGraphSlice,
  GitHistoryOpInput,
  GitHistoryOpPreview,
  GitHistoryOpResult,
  GitHunkApplyInput,
  GitIdentity,
  GitInProgressOperation,
  GitOperationControlAction,
  GitOperationControlResult,
  GitPullInput,
  GitPullResult,
  GitPullStrategy,
  GitPushInput,
  GitPushOutcome,
  GitRecoveryPreview,
  GitRecoveryPreviewInput,
  GitRecoveryResult,
  GitReflogQuery,
  GitReflogSnapshot,
  GitRefLabel,
  GitReleaseCreateInput,
  GitReleaseCreateResult,
  GitReleaseListResult,
  GitReleaseNotesScope,
  GitRemote,
  GitRemoteChange,
  GitRemoteInput,
  GitRewritePreview,
  GitRewritePreviewInput,
  GitRewriteResult,
  GitStashApplyInput,
  GitStashApplyResult,
  GitStashCreateInput,
  GitStashCreateResult,
  GitStashEntry,
  GitStatusSnapshot,
  GitSyncResult,
  GitTagCreateInput,
  GitTagCreateResult,
  GitTagListResult,
  GitUndoCommitInput,
  GitUndoCommitMode,
  GitUndoCommitResult,
  GitUpstreamInput,
  GitWorktreeCreateInput,
  GitWorktreeCreateResult,
  GitWorktreeInfo,
  GitWorktreePruneResult,
  GitWorktreeRemoveInput,
  GitWorktreeRemoveResult,
} from "@vela/shared";
import { buildPatchFromHunks, missingHunkIndexes, parsePatchSection } from "./diff-hunks";
import { controlOperation, readConflictFile, resolveConflictFile } from "./git-conflict";
import {
  createBranchAt,
  listReflog,
  previewHistoryOp,
  previewRecovery,
  previewRewrite,
  runHistoryOp,
  runRecovery,
  runRewrite,
} from "./git-history-ops";
import { createRelease, createTag, deleteTag, getReleaseNotesScope, listReleases, listTags } from "./git-tag-release";
import {
  remoteAdd,
  remoteChange,
  remoteRemove,
  remoteRename,
  remoteSetUrl,
  readRemotes,
} from "./git-remote";
import { assertSafeName, assertValidRefName, gitMutate, gitQuery, runGit, type GitRunResult } from "./git-run";
import { applyStash, createStash, dropStash, listStashes, stashDiff } from "./git-stash";
import {
  detectOperation,
  hasHead,
  isShallowRepository,
  isTrackedPath,
  listConflictedPaths,
  listRemoteNames,
  objectExists,
  parseNameStatusZ,
  parseNumstatZ,
  readCurrentBranch,
  readHeadSha,
  readLastFetchAt,
  readNumstat,
  readShortSha,
  resolveCommit,
  resolveGitDir,
  resolveRepoRoot,
  resolveUpstream,
} from "./git-state";
import {
  createWorktree,
  listWorktrees,
  pruneWorktrees,
  removeWorktree,
} from "./git-worktree";

const refreshDebounceMs = 600;
const maxUntrackedSampleBytes = 2 * 1024 * 1024;
const maxCompareDiffLength = 400_000;
const emptyTreeSha = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const maxGraphSnapshots = 8;
const fieldSeparator = "\x1f";
const recordSeparator = "\x1e";
const commitLogFormat = [
  "%H",
  "%h",
  "%P",
  "%s",
  "%an",
  "%ae",
  "%at",
  "%cn",
  "%ct",
  "%D",
].join(fieldSeparator) + recordSeparator;
const commitDetailFormat = [
  "%H",
  "%h",
  "%P",
  "%s",
  "%an",
  "%ae",
  "%at",
  "%cn",
  "%ct",
  "%D",
  "%b",
].join(fieldSeparator) + recordSeparator;

type StatusListener = (snapshot: GitStatusSnapshot | null) => void;

interface GraphSnapshotMeta {
  scope: GitGraphScope;
  startRef: string | null;
  startedAt: number;
}

interface BoundaryInfo {
  pendingParents: string[];
  shallowBoundary: string[];
  boundaryParents: Set<string>;
}

/**
 * 基于 git CLI 的工作树状态服务。所有命令以工作区为 cwd 运行,
 * git 自行向上查找仓库根,因此工作区可以是仓库的子目录。
 */
export class GitService {
  private readonly worktreeRoot: string | null;
  private workspacePath: string | null = null;
  private snapshot: GitStatusSnapshot | null = null;
  private readonly listeners = new Set<StatusListener>();
  private readonly watchers: FSWatcher[] = [];
  private refreshTimer: NodeJS.Timeout | null = null;
  private refreshSeq = 0;
  private mutationChain: Promise<void> = Promise.resolve();
  private readonly graphSnapshots = new Map<string, GraphSnapshotMeta>();

  constructor(options?: { worktreeRoot?: string | null }) {
    this.worktreeRoot = options?.worktreeRoot ?? null;
  }

  subscribe(listener: StatusListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): GitStatusSnapshot | null {
    return this.snapshot;
  }

  getWorkspace(): string | null {
    return this.workspacePath;
  }

  /** 绑定工作区(null 解绑),立即刷新并启动文件监听。 */
  async attach(workspacePath: string | null): Promise<GitStatusSnapshot | null> {
    this.stopWatching();
    this.workspacePath = workspacePath;
    const snapshot = await this.refresh();
    this.startWatching();
    return snapshot;
  }

  async refresh(): Promise<GitStatusSnapshot | null> {
    const seq = ++this.refreshSeq;
    const next = this.workspacePath ? await collectStatus(this.workspacePath) : null;
    if (seq !== this.refreshSeq) return this.snapshot;
    this.snapshot = next;
    for (const listener of this.listeners) listener(next);
    return next;
  }

  async listBranches(): Promise<BranchSummary[]> {
    const cwd = this.workspacePath;
    if (!cwd) return [];
    const format =
      "%(refname:short)\t%(objectname:short)\t%(committerdate:unix)\t%(upstream:short)\t%(HEAD)\t%(refname)";
    let stdout: string;
    try {
      stdout = await gitQuery(cwd, ["for-each-ref", `--format=${format}`, "refs/heads", "refs/remotes"]);
    } catch {
      return [];
    }
    const worktrees = await collectWorktreeBranches(cwd);
    const branches: BranchSummary[] = [];
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      const [shortName, sha, unix, upstream, head, fullRef] = line.split("\t");
      if (!shortName || !fullRef) continue;
      const remote = fullRef.startsWith("refs/remotes/");
      if (remote && shortName.endsWith("/HEAD")) continue;
      const seconds = Number(unix);
      branches.push({
        name: shortName,
        current: head === "*",
        remote,
        upstream: !remote && upstream ? upstream : null,
        worktreePath: remote ? null : worktrees.get(shortName) ?? null,
        lastCommitSha: sha || null,
        lastCommitAt: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null,
      });
    }
    return branches;
  }

  async switchBranch(
    name: string,
    options?: { createTracking?: boolean },
  ): Promise<GitStatusSnapshot | null> {
    void options;
    return this.mutateAndRefresh(async (cwd) => {
      await assertValidRefName(cwd, name);
      if (await refExists(cwd, `refs/heads/${name}`)) {
        await gitMutate(cwd, ["switch", name]);
        return;
      }
      if (await refExists(cwd, `refs/remotes/${name}`)) {
        const localName = await localNameForRemoteBranch(cwd, name);
        if (await refExists(cwd, `refs/heads/${localName}`)) {
          await gitMutate(cwd, ["switch", localName]);
        } else {
          await gitMutate(cwd, ["switch", "--create", localName, "--track", name]);
        }
        return;
      }
      throw new Error(`本地和远程都没有分支 ${name}`);
    });
  }

  async createBranch(name: string, startPoint?: string | null): Promise<GitStatusSnapshot | null> {
    return this.mutateAndRefresh(async (cwd) => {
      await assertValidRefName(cwd, name);
      const args = ["switch", "--create", name];
      if (startPoint) {
        assertSafeRevision(startPoint);
        args.push(startPoint);
      }
      await gitMutate(cwd, args);
    });
  }

  async fileDiff(path: string, scope: GitChangeScope, options?: GitDiffOptions): Promise<string> {
    const workspace = this.workspacePath;
    if (!workspace) return "";
    assertRepoRelativePath(path);
    const cwd = this.repoCwd();
    const whitespaceArgs = options?.ignoreWhitespace ? ["--ignore-all-space"] : [];
    // 未跟踪文件不在 HEAD 中,`git diff` 不会输出内容,需要按「全部新增」单独生成。
    // 索引范围(例如已暂存的删除)始终走 git diff --cached,不能用这个兜底。
    const untrackedInWorktree = scope === "worktree" && !(await isTrackedPath(cwd, path));
    if (untrackedInWorktree) {
      const result = await runGit(cwd, [
        "--no-optional-locks",
        "diff",
        "--no-color",
        ...whitespaceArgs,
        "--no-index",
        "--",
        "/dev/null",
        path,
      ]);
      return result.stdout;
    }
    const args = ["diff", "--no-color", ...whitespaceArgs];
    if (scope === "index") args.push("--cached");
    args.push("--", path);
    try {
      return await gitQuery(cwd, args);
    } catch {
      return "";
    }
  }

  /**
   * 按代码块暂存/取消暂存/丢弃。补丁必须与最新 Diff 完全一致,
   * 任一代码块已变化就整体拒绝,避免把基于旧内容的选择应用到新状态。
   */
  async applyHunks(input: GitHunkApplyInput): Promise<GitStatusSnapshot | null> {
    const path = assertRepoRelativePath(input.path);
    if (input.patch.length === 0 || input.patch.length > 4_000_000) throw new Error("代码块补丁不正确");
    const action: GitHunkApplyInput["action"] = input.action;
    return this.mutateAndRefresh(async (cwd) => {
      const scopeArgs = action === "unstage" ? ["--cached"] : [];
      const currentDiff = await gitQuery(cwd, ["diff", "--no-color", ...scopeArgs, "--", path]).catch(() => "");
      if (!currentDiff.trim()) {
        throw new Error("该文件当前没有可操作的差异，请刷新后重试");
      }
      const current = parsePatchSection(currentDiff, path);
      const selected = parsePatchSection(input.patch, path);
      if (!current || !selected) throw new Error("无法解析当前差异，请刷新后重试");
      const missing = missingHunkIndexes(input.patch, current);
      if (missing === null) throw new Error("代码块补丁不正确");
      if (missing.length > 0) {
        throw new Error(`有 ${missing.length} 个代码块的内容已变化，请刷新差异后重新选择`);
      }
      // 用最新 Diff 的文件头拼补丁,保证路径与模式信息来自真实仓库状态。
      const patch = buildPatchFromHunks(current.header, selected.hunks);
      const args = ["apply", "--whitespace=nowarn"];
      if (action === "unstage") args.push("--cached", "--reverse");
      else if (action === "stage") args.push("--cached");
      else args.push("--reverse");
      args.push("-");
      const result = await runGit(cwd, args, 60_000, patch);
      if (result.code !== 0) {
        throw new Error(firstNonEmptyLine(result.stderr) ?? firstNonEmptyLine(result.stdout) ?? "应用代码块失败");
      }
    });
  }

  /** 暂存区全部改动,用于提交面板预览;空仓库时相对空树输出,失败返回空字符串。 */
  async stagedDiff(): Promise<string> {
    const workspace = this.workspacePath;
    if (!workspace) return "";
    try {
      return await gitQuery(this.repoCwd(), ["diff", "--cached", "--no-color"]);
    } catch {
      return "";
    }
  }

  /** 写入仓库级提交身份(仅 --local,绝不写全局配置),完成后刷新快照。 */
  async setIdentity(name: string, email: string): Promise<void> {
    const nextName = name.trim();
    const nextEmail = email.trim();
    if (!nextName || nextName.length > 200) throw new Error("用户名不正确");
    if (!nextEmail || nextEmail.length > 320 || !nextEmail.includes("@")) {
      throw new Error("邮箱不正确");
    }
    await this.mutateAndRefresh(async (cwd) => {
      await gitMutate(cwd, ["config", "--local", "user.name", nextName]);
      await gitMutate(cwd, ["config", "--local", "user.email", nextEmail]);
    });
  }

  async stage(paths: string[]): Promise<GitStatusSnapshot | null> {
    const safe = paths.map((path) => assertRepoRelativePath(path));
    return this.mutateAndRefresh(async (cwd) => {
      if (safe.length === 0) return;
      await gitMutate(cwd, ["add", "--", ...safe]);
    });
  }

  async unstage(paths: string[]): Promise<GitStatusSnapshot | null> {
    const safe = paths.map((path) => assertRepoRelativePath(path));
    return this.mutateAndRefresh(async (cwd) => {
      if (safe.length === 0) return;
      const result = await runGit(cwd, ["reset", "-q", "HEAD", "--", ...safe]);
      if (result.code !== 0) {
        // 初始提交(HEAD 尚不存在)时回退为直接移出暂存区。
        await gitMutate(cwd, ["rm", "--cached", "-q", "--", ...safe]);
      }
    });
  }

  async discard(
    paths: string[],
    options?: { untracked?: boolean },
  ): Promise<GitStatusSnapshot | null> {
    const safe = paths.map((path) => assertRepoRelativePath(path));
    const allowUntracked = options?.untracked === true;
    return this.mutateAndRefresh(async (cwd) => {
      const current = await collectStatus(cwd);
      const tracked: string[] = [];
      const untracked: string[] = [];
      for (const path of safe) {
        const file = current?.files.find((entry) => entry.path === path);
        if (!file) continue;
        // 冲突文件的索引包含冲突阶段,checkout 会失败,保持现状交给用户处理。
        if (file.worktreeStatus === "conflicted" || file.status === "conflicted") continue;
        if (file.status === "untracked" || file.worktreeStatus === "untracked") {
          if (allowUntracked) untracked.push(path);
          continue;
        }
        // 只有工作区有改动时才需要还原;索引改动保持不动。
        if (file.worktreeStatus !== null) tracked.push(path);
      }
      if (tracked.length > 0) {
        await gitMutate(cwd, ["checkout", "--", ...tracked]);
      }
      if (untracked.length > 0) {
        await gitMutate(cwd, ["clean", "-qf", "--", ...untracked]);
      }
    });
  }

  async commit(input: GitCommitInput): Promise<GitCommitResult> {
    const title = input.title.trim();
    if (!title) throw new Error("提交标题不能为空");
    if (title.length > 300) throw new Error("提交标题过长");
    const body = input.body ?? "";
    if (body.length > 20_000) throw new Error("提交说明过长");
    const amend = input.amend === true;
    const stagePaths = input.stagePaths?.map((path) => assertRepoRelativePath(path)) ?? null;
    const message = body ? `${title}\n\n${body}` : title;
    return this.runMutation(async (cwd) => {
      // Amend 前记录被修正的提交与其推送状态,供界面提示「已推送需另行同步」。
      const amendedSha = amend ? await readHeadSha(cwd) : null;
      const amendedPushed = amend ? await this.headPushed(cwd) : null;
      if (stagePaths && stagePaths.length > 0) {
        await gitMutate(cwd, ["add", "--", ...stagePaths]);
      }
      const args = ["commit"];
      if (amend) args.push("--amend");
      args.push("--file", "-");
      const result = await runGit(cwd, args, 180_000, `${message}\n`);
      const output = combineOutput(result.stdout, result.stderr);
      if (result.code !== 0) {
        return {
          ok: false,
          sha: null,
          shortSha: null,
          branch: await readCurrentBranch(cwd),
          message: firstNonEmptyLine(result.stderr) ?? firstNonEmptyLine(result.stdout) ?? (amend ? "修正提交失败" : "提交失败"),
          output,
          amendedSha,
          amendedPushed,
        };
      }
      const sha = await readHeadSha(cwd);
      const shortSha = await readShortSha(cwd);
      return {
        ok: true,
        sha,
        shortSha: shortSha ?? sha?.slice(0, 7) ?? null,
        branch: await readCurrentBranch(cwd),
        message: firstNonEmptyLine(result.stderr) ?? "提交成功",
        output,
        amendedSha,
        amendedPushed,
      };
    });
  }

  /** 撤销最近一次未推送的提交;文件变化按 mode 保留在索引或工作区。 */
  async undoLastCommit(input: GitUndoCommitInput): Promise<GitUndoCommitResult> {
    const mode: GitUndoCommitMode = input.mode === "keep-index" ? "keep-index" : "keep-worktree";
    return this.runMutation(async (cwd) => {
      const sha = await readHeadSha(cwd);
      if (!sha) {
        return { ok: false, sha: null, shortSha: null, subject: null, mode, message: "当前分支还没有提交" };
      }
      const pushed = await this.headPushed(cwd);
      if (pushed === true) {
        return {
          ok: false,
          sha,
          shortSha: sha.slice(0, 7),
          subject: null,
          mode,
          message: "该提交已经推送，不能在这里撤销；如需回退已发布内容，请使用独立的回退提交。",
        };
      }
      const parents = (await gitQuery(cwd, ["rev-list", "--parents", "-n", "1", "HEAD"]).catch(() => ""))
        .trim()
        .split(/\s+/)
        .slice(1)
        .filter(Boolean);
      if (parents.length === 0) {
        return {
          ok: false,
          sha,
          shortSha: sha.slice(0, 7),
          subject: null,
          mode,
          message: "这是分支的第一个提交，撤销会清空全部历史；请手动处理或改用其他方式。",
        };
      }
      const subject =
        (await gitQuery(cwd, ["log", "-1", "--format=%s", "HEAD"]).catch(() => "")).trim() || null;
      await gitMutate(cwd, ["reset", mode === "keep-index" ? "--soft" : "--mixed", "HEAD~1"]);
      return {
        ok: true,
        sha,
        shortSha: sha.slice(0, 7),
        subject,
        mode,
        message:
          mode === "keep-index"
            ? "已撤销该提交，改动保留在索引中"
            : "已撤销该提交，改动保留在工作区（未暂存）",
      };
    });
  }

  /** HEAD 是否已经在 upstream 上(即没有未推送提交);没有 upstream 时为 null。 */
  private async headPushed(cwd: string): Promise<boolean | null> {
    const upstream = await resolveUpstream(cwd);
    if (!upstream) return null;
    const count = await gitQuery(cwd, ["rev-list", "--count", `${upstream}..HEAD`]).catch(() => null);
    if (count === null) return null;
    const parsed = Number.parseInt(count.trim(), 10);
    return Number.isFinite(parsed) ? parsed === 0 : null;
  }

  async fetch(remote?: string | null): Promise<GitFetchResult> {
    return this.runMutation((cwd) => this.performFetch(cwd, remote ?? null));
  }

  async pull(): Promise<GitPullResult> {
    return this.runMutation(async (cwd) => {
      const before = await collectStatus(cwd);
      if (!before?.repo) {
        return { outcome: "failed", ok: false, message: "当前工作区不是 Git 仓库" };
      }
      if (before.operation) {
        return {
          outcome: "failed",
          ok: false,
          message: `存在进行中的 ${operationLabel(before.operation.kind)} 操作，请先完成或取消`,
        };
      }
      const dirty = before.files.filter(
        (file) =>
          file.status !== "untracked" && (file.indexStatus !== null || file.worktreeStatus !== null),
      );
      if (dirty.length > 0) {
        const names = dirty
          .slice(0, 3)
          .map((file) => file.path)
          .join("、");
        const suffix = dirty.length > 3 ? ` 等 ${dirty.length} 个文件` : "";
        return {
          outcome: "dirty",
          ok: false,
          message: `工作区有未提交的改动：${names}${suffix}`,
        };
      }
      if (!before.upstream) {
        return { outcome: "failed", ok: false, message: "当前分支没有上游分支，无法拉取" };
      }
      const fetched = await this.performFetch(cwd, null);
      if (!fetched.ok) {
        return { outcome: "failed", ok: false, message: fetched.message };
      }
      const after = await collectStatus(cwd);
      if (!after?.upstream) {
        return { outcome: "failed", ok: false, message: "上游分支已不可用" };
      }
      if (after.ahead > 0 && after.behind > 0) {
        return {
          outcome: "diverged",
          ok: false,
          message: `本地与 ${after.upstream} 已分叉（领先 ${after.ahead}、落后 ${after.behind} 个提交），请手动合并`,
        };
      }
      if (after.behind === 0) {
        return { outcome: "up-to-date", ok: true, message: "已经是最新版本" };
      }
      let result: GitRunResult;
      try {
        result = await runGit(cwd, ["merge", "--ff-only", after.upstream], 120_000);
      } catch (error) {
        return {
          outcome: "failed",
          ok: false,
          message: error instanceof Error ? error.message : "快进合并失败",
        };
      }
      if (result.code !== 0) {
        return {
          outcome: "failed",
          ok: false,
          message: firstNonEmptyLine(result.stderr) ?? "快进合并失败",
        };
      }
      return { outcome: "fast-forward", ok: true, message: `已快进到 ${after.upstream}` };
    });
  }

  async push(input: GitPushInput): Promise<GitSyncResult> {
    const remote = input.remote.trim();
    const branch = input.branch.trim();
    if (!remote) throw new Error("请选择远程");
    assertSafeName(remote, "远程名");
    if (!branch) throw new Error("请选择分支");
    const workspace = this.workspacePath;
    if (!workspace) throw new Error("未选择工作区");
    const remotes = await listRemoteNames(this.repoCwd());
    if (!remotes.includes(remote)) throw new Error(`远程 ${remote} 不存在`);
    return this.runMutation(async (cwd) => {
      await assertValidRefName(cwd, branch);
      const args = ["push", "--porcelain"];
      if (input.setUpstream) args.push("--set-upstream");
      args.push(remote, input.setUpstream ? branch : `${branch}:${branch}`);
      let result: GitRunResult;
      try {
        result = await runGit(cwd, args, 120_000);
      } catch (error) {
        return this.confirmPushAfterTimeout(cwd, remote, branch, error);
      }
      const combined = `${result.stderr}\n${result.stdout}`;
      if (result.code === 0) {
        const upToDate =
          /everything up-to-date/i.test(combined) || /\[up to date\]/i.test(combined);
        return {
          outcome: upToDate ? "up-to-date" : "ok",
          ok: true,
          confirmed: true,
          remote,
          branch,
          message: upToDate ? "远程分支已是最新" : `已推送 ${branch} 到 ${remote}`,
        };
      }
      const outcome = classifyPushFailure(combined);
      return {
        outcome,
        ok: false,
        confirmed: true,
        remote,
        branch,
        message: pushFailureMessage(outcome, result.stderr, result.stdout),
      };
    });
  }

  async headSha(): Promise<string | null> {
    const cwd = this.workspacePath;
    if (!cwd) return null;
    return readHeadSha(cwd);
  }

  // ---------- P2:同步策略与安全强推 (SY-03/SY-04) ----------

  /**
   * SY-03:显式选择同步策略。ff-only 保持 P0 行为;merge/rebase 只在用户
   * 明确选择时使用,冲突时保留进行中的操作交给冲突流程处理。
   */
  async pullWithStrategy(input: GitPullInput): Promise<GitPullResult> {
    const strategy: GitPullStrategy =
      input.strategy === "merge" || input.strategy === "rebase" ? input.strategy : "ff-only";
    if (strategy === "ff-only") {
      const result = await this.pull();
      return { ...result, strategy: "ff-only" };
    }
    return this.runMutation(async (cwd) => {
      const before = await collectStatus(cwd);
      if (!before?.repo) {
        return { outcome: "failed", ok: false, message: "当前工作区不是 Git 仓库", strategy };
      }
      if (before.operation) {
        return {
          outcome: "in-progress",
          ok: false,
          message: `存在进行中的 ${operationLabel(before.operation.kind)} 操作，请先完成或中止`,
          strategy,
          operation: before.operation,
        };
      }
      const dirty = before.files.filter(
        (file) => file.status !== "untracked" && (file.indexStatus !== null || file.worktreeStatus !== null),
      );
      if (dirty.length > 0) {
        const names = dirty.slice(0, 3).map((file) => file.path).join("、");
        const suffix = dirty.length > 3 ? ` 等 ${dirty.length} 个文件` : "";
        return {
          outcome: "dirty",
          ok: false,
          message: `工作区有未提交的改动：${names}${suffix}；请先提交或保存到 Stash，不会自动处理`,
          strategy,
        };
      }
      if (!before.upstream) {
        return { outcome: "failed", ok: false, message: "当前分支没有上游分支，无法拉取", strategy };
      }
      const fetched = await this.performFetch(cwd, null);
      if (!fetched.ok) {
        return { outcome: "failed", ok: false, message: fetched.message, strategy };
      }
      const after = await collectStatus(cwd);
      if (!after?.upstream) {
        return { outcome: "failed", ok: false, message: "上游分支已不可用", strategy };
      }
      const diverged = after.ahead > 0 && after.behind > 0;
      if (after.behind === 0) {
        return { outcome: "up-to-date", ok: true, message: "已经是最新版本", strategy };
      }
      const args =
        strategy === "merge"
          ? ["merge", "--no-edit", after.upstream]
          : ["rebase", after.upstream];
      let result: GitRunResult;
      try {
        result = await runGit(cwd, args, 180_000, {
          env: { GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true" },
        });
      } catch (error) {
        return {
          outcome: "in-progress",
          ok: false,
          message: error instanceof Error ? `${error.message}，请刷新后核对实际状态` : "同步结果未确认",
          strategy,
        };
      }
      const gitDirPath = await resolveGitDir(cwd);
      const operation = gitDirPath ? await detectOperation(gitDirPath) : null;
      const conflictedPaths = operation ? await listConflictedPaths(cwd) : [];
      if (result.code !== 0 && operation) {
        return {
          outcome: "conflicted",
          ok: false,
          message:
            strategy === "merge"
              ? `合并遇到 ${conflictedPaths.length} 个冲突文件，请解决后继续或中止`
              : `Rebase 遇到冲突（${conflictedPaths.length} 个文件），请解决后继续或中止`,
          strategy,
          conflicted: true,
          conflictedPaths,
          operation,
        };
      }
      if (result.code !== 0) {
        return {
          outcome: "failed",
          ok: false,
          message: firstNonEmptyLine(result.stderr) ?? (strategy === "merge" ? "合并失败" : "Rebase 失败"),
          strategy,
        };
      }
      return {
        outcome: strategy === "merge" ? "merged" : "rebased",
        ok: true,
        message: diverged
          ? strategy === "merge"
            ? `已合并 ${after.upstream}`
            : `已在 ${after.upstream} 上重放本地提交`
          : `已快进到 ${after.upstream}`,
        strategy,
      };
    });
  }

  /** SY-04:强推前重新读取远程引用,列出会被覆盖的提交。 */
  async previewForcePush(remoteInput: string, branchInput: string): Promise<GitForcePushPreview> {
    const remote = remoteInput.trim();
    const branch = branchInput.trim();
    if (!remote) throw new Error("请选择远程");
    assertSafeName(remote, "远程名");
    if (!branch) throw new Error("请选择分支");
    const cwd = this.repoCwd();
    if (!cwd) throw new Error("未选择工作区");
    const remotes = await listRemoteNames(cwd);
    if (!remotes.includes(remote)) throw new Error(`远程 ${remote} 不存在`);
    await assertValidRefName(cwd, branch);

    const branchSha = await resolveCommit(cwd, branch);
    const localSha = branchSha ?? (await readHeadSha(cwd));
    const upstream = await resolveUpstream(cwd);
    const remoteSha = await readRemoteBranchSha(cwd, remote, branch);
    const ahead = localSha
      ? await readCommitRefs(cwd, await revList(cwd, remoteSha ? `${remoteSha}..${localSha}` : localSha))
      : [];
    const overwritten = localSha && remoteSha
      ? await readCommitRefs(cwd, await revList(cwd, `${localSha}..${remoteSha}`))
      : [];
    const fastForward = overwritten.length === 0;
    return {
      ok: true,
      remote,
      branch,
      localSha,
      localShortSha: localSha?.slice(0, 7) ?? null,
      remoteSha,
      ahead,
      overwritten,
      fastForward,
      stale: false,
      upstream,
      message: buildForcePushMessage({ remote, branch, remoteSha, localSha, ahead, overwritten }),
      error: null,
    };
  }

  /**
   * SY-04:显式安全强推。使用 --force-with-lease 并在推送前核对远程引用,
   * 远程已经变化时拒绝覆盖,不自动改用普通推送。
   */
  async forcePush(input: GitForcePushInput): Promise<GitForcePushResult> {
    const remote = input.remote.trim();
    const branch = input.branch.trim();
    const expected = input.expectedRemoteSha.trim();
    if (!remote) throw new Error("请选择远程");
    assertSafeName(remote, "远程名");
    if (!branch) throw new Error("请选择分支");
    if (!expected) throw new Error("缺少核对过的远程引用，请先刷新");
    const cwd = this.repoCwd();
    if (!cwd) throw new Error("未选择工作区");
    const remotes = await listRemoteNames(cwd);
    if (!remotes.includes(remote)) throw new Error(`远程 ${remote} 不存在`);
    return this.runMutation(async () => {
      await assertValidRefName(cwd, branch);
      const current = await readRemoteBranchSha(cwd, remote, branch);
      if (current !== expected) {
        return {
          ok: false,
          outcome: "stale" as GitPushOutcome,
          message:
            current === null
              ? "远程分支已经不存在，已拒绝覆盖；请刷新后重新核对"
              : `远程分支已经变化（${current.slice(0, 7)} ≠ ${expected.slice(0, 7)}），已拒绝覆盖；请刷新后重新核对`,
          remote,
          branch,
          remoteSha: current,
          stale: true,
          confirmed: true,
        };
      }
      const args = [
        "push",
        "--porcelain",
        `--force-with-lease=${branch}:${expected}`,
        remote,
        `${branch}:${branch}`,
      ];
      let result: GitRunResult;
      try {
        result = await runGit(cwd, args, 120_000);
      } catch (error) {
        const after = await readRemoteBranchSha(cwd, remote, branch).catch(() => null);
        const local = await resolveCommit(cwd, branch);
        const confirmed = Boolean(after && local && after === local);
        return {
          ok: confirmed,
          outcome: confirmed ? ("ok" as GitPushOutcome) : ("unconfirmed" as GitPushOutcome),
          message: confirmed
            ? "推送结果已通过远程引用核对"
            : error instanceof Error
              ? `${error.message}，推送结果未确认`
              : "推送结果未确认",
          remote,
          branch,
          remoteSha: after,
          stale: false,
          confirmed,
        };
      }
      const combined = `${result.stderr}\n${result.stdout}`;
      const after = await readRemoteBranchSha(cwd, remote, branch).catch(() => null);
      if (result.code === 0) {
        const upToDate = /everything up-to-date/i.test(combined) || /\[up to date\]/i.test(combined);
        return {
          ok: true,
          outcome: upToDate ? ("up-to-date" as GitPushOutcome) : ("ok" as GitPushOutcome),
          message: upToDate ? "远程分支已是最新，无需强推" : `已安全强推 ${branch} 到 ${remote}`,
          remote,
          branch,
          remoteSha: after,
          stale: false,
          confirmed: true,
        };
      }
      const outcome = classifyPushFailure(combined);
      return {
        ok: false,
        outcome,
        message: pushFailureMessage(outcome, result.stderr, result.stdout),
        remote,
        branch,
        remoteSha: after,
        stale: outcome === "stale",
        confirmed: true,
      };
    });
  }

  // ---------- P2:历史操作、提交整理与恢复 (HI-02–HI-04/HI-06/CT-06) ----------

  /** HI-02:从指定历史提交创建分支;默认不切换,不改变未提交内容。 */
  async createBranchAt(input: GitBranchAtInput): Promise<GitBranchAtResult> {
    return this.runMutation((cwd) => createBranchAt(cwd, input));
  }

  /** HI-03/HI-04:执行前的范围预览。 */
  async previewHistoryOp(input: GitHistoryOpInput): Promise<GitHistoryOpPreview> {
    const cwd = this.repoCwd();
    if (!cwd) throw new Error("未选择工作区");
    return previewHistoryOp(cwd, input);
  }

  /** HI-03/HI-04:执行 Revert / Cherry-pick。 */
  async runHistoryOp(input: GitHistoryOpInput): Promise<GitHistoryOpResult> {
    return this.runMutation((cwd) => runHistoryOp(cwd, input));
  }

  /** CT-06:Fixup / Squash 的范围预览。 */
  async previewRewrite(input: GitRewritePreviewInput): Promise<GitRewritePreview> {
    const cwd = this.repoCwd();
    if (!cwd) throw new Error("未选择工作区");
    return previewRewrite(cwd, input);
  }

  /** CT-06:执行 Fixup / Squash;不自动推送重写后的历史。 */
  async runRewrite(input: GitRewritePreviewInput): Promise<GitRewriteResult> {
    return this.runMutation((cwd) => runRewrite(cwd, input));
  }

  /** HI-06:读取 HEAD reflog。 */
  async reflog(query?: GitReflogQuery | null): Promise<GitReflogSnapshot> {
    const cwd = this.repoCwd();
    if (!cwd) throw new Error("未选择工作区");
    return listReflog(cwd, query);
  }

  /** HI-06:恢复前的预览。 */
  async previewRecovery(input: GitRecoveryPreviewInput): Promise<GitRecoveryPreview> {
    const cwd = this.repoCwd();
    if (!cwd) throw new Error("未选择工作区");
    return previewRecovery(cwd, input);
  }

  /** HI-06:执行恢复。 */
  async runRecovery(input: GitRecoveryPreviewInput): Promise<GitRecoveryResult> {
    return this.runMutation((cwd) => runRecovery(cwd, input));
  }

  // ---------- P2:Tag 与 Release (RL-01) ----------

  /** RL-01:标签列表(含推送状态)。 */
  async tags(): Promise<GitTagListResult> {
    const cwd = this.repoCwd();
    if (!cwd) throw new Error("未选择工作区");
    return listTags(cwd);
  }

  /** RL-01:创建标签。 */
  async tagCreate(input: GitTagCreateInput): Promise<GitTagCreateResult> {
    return this.runMutation((cwd) => createTag(cwd, input));
  }

  /** RL-01:删除标签;远程删除必须显式指定远程。 */
  async tagDelete(name: string, remote?: string | null): Promise<GitTagCreateResult> {
    return this.runMutation((cwd) => deleteTag(cwd, name, remote));
  }

  /** RL-01:Release 列表与尚无 Release 的标签。 */
  async releases(): Promise<GitReleaseListResult> {
    const cwd = this.repoCwd();
    if (!cwd) throw new Error("未选择工作区");
    return listReleases(cwd);
  }

  /** RL-01:创建 Release。 */
  async releaseCreate(input: GitReleaseCreateInput): Promise<GitReleaseCreateResult> {
    const cwd = this.repoCwd();
    if (!cwd) throw new Error("未选择工作区");
    return createRelease(cwd, input);
  }

  /** AI-12:发布说明的版本区间数据。 */
  async releaseNotesScope(baseTag: string | null, targetTag: string): Promise<GitReleaseNotesScope> {
    const cwd = this.repoCwd();
    if (!cwd) throw new Error("未选择工作区");
    return getReleaseNotesScope(cwd, baseTag, targetTag);
  }

  // ---------- 分支维护与比较 (BR-02/BR-03/HI-01) ----------

  /** 删除/重命名前核对:合并状态、worktree 占用、未推送提交与远程分支。 */
  async branchDetail(name: string): Promise<GitBranchDetail> {
    const cwd = this.workspacePath;
    if (!cwd) throw new Error("未选择工作区");
    await assertValidRefName(cwd, name);
    const currents = await collectStatus(cwd);
    const current = currents?.branch === name;
    const upstream = await this.readBranchUpstream(cwd, name);
    const worktrees = await collectWorktreeBranches(cwd);
    const last = await gitQuery(cwd, ["log", "-1", "--format=%H%x1f%ct%x1f%s", name])
      .then((stdout) => stdout.trim().split("\x1f"))
      .catch(() => [] as string[]);
    const commitCount = Number.parseInt(
      (await gitQuery(cwd, ["rev-list", "--count", name]).catch(() => "0")).trim(),
      10,
    );
    const remotes = await listRemoteNames(cwd);
    const remoteBranch = await this.findRemoteBranch(cwd, name, upstream, remotes);
    const unpushedCount = await this.countUnpushed(cwd, name, upstream, remoteBranch);
    // 只有当前分支不能与自身比较合并状态;其余分支相对 upstream 或 HEAD 判断。
    const mergedInto = await this.resolveMergedInto(cwd, name, current ? upstream : upstream ?? "HEAD");
    return {
      name,
      current,
      upstream,
      worktreePath: worktrees.get(name) ?? null,
      mergedInto,
      unpushedCount,
      remoteBranch,
      lastCommitSha: last[0] ?? null,
      lastCommitAt: Number(last[1]) > 0 ? Number(last[1]) * 1000 : null,
      rootCommit: commitCount === 1,
      subject: last[2] ?? null,
    };
  }

  async renameBranch(name: string, nextName: string): Promise<GitStatusSnapshot | null> {
    return this.mutateAndRefresh(async (cwd) => {
      await assertValidRefName(cwd, name);
      await assertValidRefName(cwd, nextName);
      await gitMutate(cwd, ["branch", "-m", name, nextName]);
    });
  }

  async deleteBranch(input: GitBranchDeleteInput): Promise<GitBranchDeleteResult> {
    const name = input.name.trim();
    const result: GitBranchDeleteResult = {
      ok: false,
      message: "",
      deletedLocal: false,
      deletedRemote: false,
    };
    return this.runMutation(async (cwd) => {
      await assertValidRefName(cwd, name);
      const detail = await this.branchDetail(name);
      if (detail.current) {
        return { ...result, message: "不能删除当前检出的分支，请先切换到其他分支。" };
      }
      if (detail.worktreePath) {
        return { ...result, message: `该分支已被 worktree 检出：${detail.worktreePath}，请先处理该工作树。` };
      }
      if (input.remote) {
        const remote = assertSafeName(input.remote.trim(), "远程名");
        if (!(await listRemoteNames(cwd)).includes(remote)) {
          return { ...result, message: `远程 ${remote} 不存在` };
        }
        const remoteBranch = detail.remoteBranch?.branch ?? name;
        const push = await runGit(cwd, ["push", remote, "--delete", remoteBranch], 120_000);
        if (push.code !== 0) {
          return { ...result, message: firstNonEmptyLine(push.stderr) ?? "删除远程分支失败" };
        }
        result.deletedRemote = true;
      }
      const args = ["branch", input.force ? "-D" : "-d", name];
      const local = await runGit(cwd, args);
      if (local.code !== 0) {
        const message = firstNonEmptyLine(local.stderr) ?? "删除分支失败";
        return {
          ...result,
          message: input.force ? message : `${message}（如确认放弃该分支的未合并提交，请使用强制删除）`,
        };
      }
      result.deletedLocal = true;
      result.ok = true;
      result.message = result.deletedRemote ? `已删除本地与远程分支 ${name}` : `已删除分支 ${name}`;
      return result;
    });
  }

  /** 比较任意两个 ref(分支或提交 SHA);方向固定为 base → head。 */
  async compareRefs(baseInput: string, headInput: string, options?: GitDiffOptions): Promise<GitCompareResult> {
    const base = baseInput.trim();
    const head = headInput.trim();
    const cwd = this.workspacePath;
    const empty = (error: string): GitCompareResult => ({
      base,
      head,
      baseSha: null,
      headSha: null,
      mergeBase: null,
      commits: [],
      files: [],
      fileCount: 0,
      addedLines: 0,
      deletedLines: 0,
      diff: "",
      diffTruncated: false,
      error,
    });
    if (!cwd) return empty("未选择工作区");
    if (!isSafeRefInput(base) || !isSafeRefInput(head)) return empty("比较目标不正确");
    const baseSha = await resolveCommit(cwd, base);
    if (!baseSha) return empty(`无法解析 ${base}`);
    const headSha = await resolveCommit(cwd, head);
    if (!headSha) return empty(`无法解析 ${head}`);
    const mergeBase = (await gitQuery(cwd, ["merge-base", baseSha, headSha]).catch(() => "")).trim() || null;

    const whitespaceArgs = options?.ignoreWhitespace ? ["--ignore-all-space"] : [];
    const logOutput = await gitQuery(cwd, [
      "log",
      "--reverse",
      "--format=%H%x1f%h%x1f%s%x1f%an%x1f%at",
      `${baseSha}..${headSha}`,
    ]).catch(() => "");
    const commits: GitCompareCommit[] = [];
    for (const line of logOutput.split("\n")) {
      if (!line.trim()) continue;
      const [sha, shortSha, subject, authorName, at] = line.split("\x1f");
      if (!sha) continue;
      commits.push({
        sha,
        shortSha: shortSha ?? sha.slice(0, 7),
        subject: subject ?? "",
        authorName: authorName ?? "",
        authorAt: Number(at) > 0 ? Number(at) * 1000 : 0,
      });
    }

    const diffBase = mergeBase ?? baseSha;
    const [numstatOut, nameStatusOut, rawDiff] = await Promise.all([
      gitQuery(cwd, ["diff", "--numstat", "-z", "-M", ...whitespaceArgs, diffBase, headSha]).catch(() => ""),
      gitQuery(cwd, ["diff", "--name-status", "-z", "-M", ...whitespaceArgs, diffBase, headSha]).catch(() => ""),
      gitQuery(cwd, ["diff", "--no-color", "-M", ...whitespaceArgs, diffBase, headSha]).catch(() => ""),
    ]);
    const stats = parseNumstatZ(numstatOut);
    const files: GitCompareFile[] = parseNameStatusZ(nameStatusOut).map((entry) => {
      const stat = stats.get(entry.path) ?? { added: 0, deleted: 0 };
      return {
        path: entry.path,
        oldPath: entry.status === "renamed" ? entry.oldPath : null,
        status: entry.status,
        addedLines: stat.added,
        deletedLines: stat.deleted,
      };
    });
    const truncated = rawDiff.length > maxCompareDiffLength;
    return {
      base,
      head,
      baseSha,
      headSha,
      mergeBase,
      commits,
      files,
      fileCount: files.length,
      addedLines: files.reduce((sum, file) => sum + file.addedLines, 0),
      deletedLines: files.reduce((sum, file) => sum + file.deletedLines, 0),
      diff: truncated ? rawDiff.slice(0, maxCompareDiffLength) : rawDiff,
      diffTruncated: truncated,
      error: null,
    };
  }

  // ---------- 远程管理 (SY-01) ----------

  async addRemote(input: GitRemoteInput): Promise<GitRemoteChange> {
    await this.mutateAndRefresh(() => remoteAdd(this.repoCwd(), input));
    return remoteChange(this.repoCwd(), `已添加远程 ${input.name.trim()}`);
  }

  async setRemoteUrl(name: string, url: string, pushUrl?: string | null): Promise<GitRemoteChange> {
    await this.mutateAndRefresh(() => remoteSetUrl(this.repoCwd(), name, url, pushUrl));
    return remoteChange(this.repoCwd(), `已更新远程 ${name.trim()} 的地址`);
  }

  async removeRemote(name: string): Promise<GitRemoteChange> {
    await this.mutateAndRefresh(() => remoteRemove(this.repoCwd(), name));
    return remoteChange(this.repoCwd(), `已删除远程 ${name.trim()}`);
  }

  async renameRemote(name: string, nextName: string): Promise<GitRemoteChange> {
    await this.mutateAndRefresh(() => remoteRename(this.repoCwd(), name, nextName));
    return remoteChange(this.repoCwd(), `已重命名远程 ${name.trim()} → ${nextName.trim()}`);
  }

  /** 设置或清除分支的上游跟踪关系。 */
  async setUpstream(input: GitUpstreamInput): Promise<GitStatusSnapshot | null> {
    const branch = input.branch.trim();
    const upstream = input.upstream?.trim() ?? null;
    return this.mutateAndRefresh(async (cwd) => {
      await assertValidRefName(cwd, branch);
      if (upstream) {
        if (!isSafeRefInput(upstream)) throw new Error("上游分支不正确");
        if (!(await resolveCommit(cwd, upstream))) throw new Error(`无法解析上游分支 ${upstream}`);
        await gitMutate(cwd, ["branch", `--set-upstream-to=${upstream}`, branch]);
      } else {
        await gitMutate(cwd, ["branch", "--unset-upstream", branch]);
      }
    });
  }

  // ---------- 冲突处理 (CF-01) ----------

  async conflictFile(path: string): Promise<GitConflictFile> {
    const cwd = this.workspacePath;
    if (!cwd) throw new Error("未选择工作区");
    return readConflictFile(this.repoCwd(), path);
  }

  async resolveConflict(input: GitConflictResolveInput): Promise<GitConflictResolveResult> {
    const result = await this.runMutation(() => resolveConflictFile(this.repoCwd(), input));
    if (!result.ok) return result;
    const remaining = (await listConflictedPaths(this.repoCwd())).length;
    return { ...result, remaining };
  }

  async controlOperation(action: GitOperationControlAction): Promise<GitOperationControlResult> {
    return this.runMutation(() => controlOperation(this.repoCwd(), action));
  }

  // ---------- Stash (ST-01) ----------

  async stashes(): Promise<GitStashEntry[]> {
    const cwd = this.workspacePath;
    if (!cwd) return [];
    return listStashes(this.repoCwd());
  }

  async stashCreate(input: GitStashCreateInput): Promise<GitStashCreateResult> {
    return this.runMutation(() => createStash(this.repoCwd(), input));
  }

  async stashApply(input: GitStashApplyInput): Promise<GitStashApplyResult> {
    return this.runMutation(() => applyStash(this.repoCwd(), input));
  }

  async stashDrop(id: string): Promise<{ ok: boolean; message: string; stashes: GitStashEntry[] }> {
    return this.runMutation(() => dropStash(this.repoCwd(), id));
  }

  async stashDiff(id: string): Promise<string> {
    const cwd = this.workspacePath;
    if (!cwd) return "";
    return stashDiff(this.repoCwd(), id);
  }

  // ---------- Worktree (WT-01) ----------

  async worktrees(): Promise<GitWorktreeInfo[]> {
    const cwd = this.workspacePath;
    if (!cwd) return [];
    return listWorktrees(this.repoCwd(), {
      managedRoot: this.worktreeRoot,
      currentWorkspace: this.workspacePath,
    });
  }

  async worktreeCreate(input: GitWorktreeCreateInput): Promise<GitWorktreeCreateResult> {
    return this.runMutation(() => createWorktree(this.repoCwd(), input, this.worktreeRoot));
  }

  async worktreeRemove(input: GitWorktreeRemoveInput): Promise<GitWorktreeRemoveResult> {
    return this.runMutation(() => removeWorktree(this.repoCwd(), input, this.workspacePath));
  }

  async worktreePrune(): Promise<GitWorktreePruneResult> {
    return this.runMutation(() =>
      pruneWorktrees(this.repoCwd(), {
        managedRoot: this.worktreeRoot,
        currentWorkspace: this.workspacePath,
      }),
    );
  }

  private async readBranchUpstream(cwd: string, name: string): Promise<string | null> {
    const stdout = await gitQuery(cwd, ["for-each-ref", "--format=%(upstream:short)", `refs/heads/${name}`])
      .catch(() => "");
    return stdout.trim() || null;
  }

  private async findRemoteBranch(
    cwd: string,
    name: string,
    upstream: string | null,
    remotes: string[],
  ): Promise<{ remote: string; branch: string } | null> {
    if (upstream) {
      const remote = remotes.find((entry) => upstream.startsWith(`${entry}/`));
      if (remote) return { remote, branch: upstream.slice(remote.length + 1) };
    }
    for (const remote of remotes) {
      const exists = await runGit(cwd, [
        "--no-optional-locks",
        "show-ref",
        "--verify",
        "--quiet",
        `refs/remotes/${remote}/${name}`,
      ]);
      if (exists.code === 0) return { remote, branch: name };
    }
    return null;
  }

  private async countUnpushed(
    cwd: string,
    name: string,
    upstream: string | null,
    remoteBranch: { remote: string; branch: string } | null,
  ): Promise<number | null> {
    const target = upstream ?? (remoteBranch ? `${remoteBranch.remote}/${remoteBranch.branch}` : null);
    if (!target) return null;
    const count = await gitQuery(cwd, ["rev-list", "--count", `${target}..${name}`]).catch(() => null);
    if (count === null) return null;
    const parsed = Number.parseInt(count.trim(), 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private async resolveMergedInto(
    cwd: string,
    name: string,
    target: string | null,
  ): Promise<string | null> {
    if (!target) return null;
    if (target === name) return null;
    if (!(await resolveCommit(cwd, target))) return null;
    const count = await gitQuery(cwd, ["rev-list", "--count", `${target}..${name}`]).catch(() => null);
    if (count === null) return null;
    return Number.parseInt(count.trim(), 10) === 0 ? target : null;
  }

  async remoteRefSha(remote: string, branch: string): Promise<string | null> {
    const cwd = this.workspacePath;
    if (!cwd) return null;
    try {
      assertSafeName(remote, "远程名");
      assertSafeName(branch, "分支名");
      const stdout = await gitQuery(cwd, ["ls-remote", remote, `refs/heads/${branch}`], 30_000);
      const line = stdout.split("\n").find((entry) => entry.trim());
      if (!line) return null;
      const [sha] = line.trim().split(/\s+/);
      return sha && /^[0-9a-f]{7,64}$/i.test(sha) ? sha : null;
    } catch {
      return null;
    }
  }

  async graph(query: GitGraphQuery): Promise<GitGraphSlice> {
    if (query.limit > 500 || query.limit < 1) throw new Error("limit 超出范围");
    if (query.skip < 0) throw new Error("skip 不能为负数");
    const cwd = this.workspacePath;
    if (!cwd) throw new Error("未选择工作区");

    const requestedId = query.snapshotId ?? null;
    const requested = requestedId ? this.graphSnapshots.get(requestedId) : undefined;
    let snapshotId: string;
    let startRef: string | null;
    if (requested && requestedId && requested.scope === query.scope) {
      requested.startedAt = Date.now();
      snapshotId = requestedId;
      startRef = requested.startRef;
    } else {
      snapshotId = randomUUID();
      startRef = await readHeadSha(cwd);
      this.graphSnapshots.set(snapshotId, {
        scope: query.scope,
        startRef,
        startedAt: Date.now(),
      });
      this.evictGraphSnapshots();
    }
    if (!startRef) {
      return { snapshotId, commits: [], hasMore: false, pendingParents: [], shallowBoundary: [] };
    }
    const scopeArgs =
      query.scope === "all-local"
        ? ["--branches", "--tags", "--remotes", startRef]
        : [startRef];
    let stdout: string;
    try {
      stdout = await gitQuery(cwd, [
        "log",
        "--topo-order",
        `--format=${commitLogFormat}`,
        "-n",
        String(query.limit + 1),
        "--skip",
        String(query.skip),
        ...scopeArgs,
      ]);
    } catch {
      return { snapshotId, commits: [], hasMore: false, pendingParents: [], shallowBoundary: [] };
    }
    const remoteNames = await listRemoteNames(cwd);
    const rows = parseCommitLog(stdout, remoteNames);
    const hasMore = rows.length > query.limit;
    const commits = rows.slice(0, query.limit);
    await enrichCommits(cwd, commits);
    const boundary = await computeBoundaryInfo(cwd, commits);
    for (const commit of commits) {
      if (boundary.boundaryParents.has(commit.sha)) commit.boundary = true;
    }
    return {
      snapshotId,
      commits,
      hasMore,
      pendingParents: boundary.pendingParents,
      shallowBoundary: boundary.shallowBoundary,
    };
  }

  async commitDetail(sha: string, parentSha?: string | null, options?: GitDiffOptions): Promise<GitCommitDetail> {
    const cwd = this.workspacePath;
    if (!cwd) throw new Error("未选择工作区");
    assertCommitSha(sha);
    if (parentSha) assertCommitSha(parentSha);
    let stdout: string;
    try {
      stdout = await gitQuery(cwd, ["show", "-s", `--format=${commitDetailFormat}`, sha]);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : "无法读取该提交");
    }
    const remoteNames = await listRemoteNames(cwd);
    const parsed = parseCommitDetail(stdout, remoteNames);
    const commit = parsed.commit;
    await enrichCommits(cwd, [commit]);
    if (commit.parents.length > 0 && (await isShallowRepository(cwd))) {
      for (const parent of commit.parents) {
        if (!(await objectExists(cwd, parent))) {
          commit.boundary = true;
          break;
        }
      }
    }
    const isRoot = commit.parents.length === 0;
    let base: string;
    let effectiveParent: string | null = null;
    if (isRoot) {
      base = emptyTreeSha;
    } else {
      effectiveParent =
        parentSha && commit.parents.includes(parentSha) ? parentSha : commit.parents[0];
      base = effectiveParent;
    }
    let diff = "";
    let files: GitCommitFileChange[] = [];
    try {
      const whitespaceArgs = options?.ignoreWhitespace ? ["--ignore-all-space"] : [];
      diff = await gitQuery(cwd, ["diff", "--no-color", "-M", ...whitespaceArgs, base, sha]);
      files = await readCommitFiles(cwd, base, sha);
    } catch {
      // 某些对象缺失(浅克隆)时保留空 diff,元数据仍可用。
    }
    return {
      commit,
      body: parsed.body,
      files,
      diff,
      parentSha: effectiveParent,
      isRoot,
      parents: commit.parents,
    };
  }

  async searchCommits(
    query: string,
    scope: GitGraphScope,
    limit = 100,
  ): Promise<GitCommitSearchResult> {
    const trimmed = query.trim();
    if (!trimmed) return { commits: [], hasMore: false };
    const cwd = this.workspacePath;
    if (!cwd) return { commits: [], hasMore: false };
    const capped = Math.min(Math.max(limit, 1), 500);
    const remoteNames = await listRemoteNames(cwd);
    let rows: GitCommitSummary[] = [];
    if (/^[0-9a-f]{4,40}$/i.test(trimmed)) {
      const resolved = await resolveCommit(cwd, trimmed);
      if (resolved) {
        const stdout = await gitQuery(cwd, [
          "log",
          "--topo-order",
          `--format=${commitLogFormat}`,
          "-n",
          String(capped + 1),
          resolved,
        ]).catch(() => "");
        rows = parseCommitLog(stdout, remoteNames);
      }
    }
    if (rows.length === 0) {
      const scopeArgs = scope === "all-local" ? ["--branches", "--tags", "--remotes", "HEAD"] : ["HEAD"];
      const [byMessage, byAuthor] = await Promise.all([
        gitQuery(cwd, [
          "log",
          "--topo-order",
          "--fixed-strings",
          "--regexp-ignore-case",
          `--grep=${trimmed}`,
          `--format=${commitLogFormat}`,
          "-n",
          String(capped + 1),
          ...scopeArgs,
        ]).catch(() => ""),
        gitQuery(cwd, [
          "log",
          "--topo-order",
          "--regexp-ignore-case",
          `--author=${escapeRegex(trimmed)}`,
          `--format=${commitLogFormat}`,
          "-n",
          String(capped + 1),
          ...scopeArgs,
        ]).catch(() => ""),
      ]);
      const merged = new Map<string, GitCommitSummary>();
      for (const commit of [
        ...parseCommitLog(byMessage, remoteNames),
        ...parseCommitLog(byAuthor, remoteNames),
      ]) {
        if (!merged.has(commit.sha)) merged.set(commit.sha, commit);
      }
      rows = [...merged.values()].sort((left, right) => right.committerAt - left.committerAt);
    }
    const hasMore = rows.length > capped;
    const commits = rows.slice(0, capped);
    await enrichCommits(cwd, commits);
    const boundary = await computeBoundaryInfo(cwd, commits);
    for (const commit of commits) {
      if (boundary.boundaryParents.has(commit.sha)) commit.boundary = true;
    }
    return { commits, hasMore };
  }

  private async performFetch(cwd: string, remoteArg: string | null): Promise<GitFetchResult> {
    // 没有可用远程属于调用错误,直接抛出;网络类错误返回 ok:false。
    const remote = await resolveRemoteForFetch(cwd, remoteArg);
    let result: GitRunResult;
    try {
      result = await runGit(cwd, ["fetch", "--prune", remote], 120_000);
    } catch (error) {
      return {
        ok: false,
        remote,
        at: Date.now(),
        message: error instanceof Error ? error.message : "获取远程更新失败",
      };
    }
    if (result.code !== 0) {
      return {
        ok: false,
        remote,
        at: Date.now(),
        message: firstNonEmptyLine(result.stderr) ?? "获取远程更新失败",
      };
    }
    return { ok: true, remote, at: Date.now(), message: `已获取 ${remote} 的最新提交` };
  }

  private async confirmPushAfterTimeout(
    cwd: string,
    remote: string,
    branch: string,
    error: unknown,
  ): Promise<GitSyncResult> {
    const local = await readHeadSha(cwd);
    const remoteSha = await this.remoteRefSha(remote, branch);
    if (local && remoteSha && local === remoteSha) {
      return {
        outcome: "ok",
        ok: true,
        confirmed: true,
        remote,
        branch,
        message: "推送结果已确认",
      };
    }
    return {
      outcome: "unconfirmed",
      ok: false,
      confirmed: false,
      remote,
      branch,
      message: error instanceof Error ? `${error.message}，推送结果未确认` : "推送结果未确认",
    };
  }

  private repoCwd(): string {
    return this.snapshot?.repo?.root ?? this.workspacePath ?? "";
  }

  private async mutateAndRefresh(task: (cwd: string) => Promise<void>): Promise<GitStatusSnapshot | null> {
    await this.runMutation(task);
    return this.snapshot;
  }

  private runMutation<T>(task: (cwd: string) => Promise<T>): Promise<T> {
    if (!this.workspacePath) throw new Error("未选择工作区");
    const cwd = this.repoCwd();
    return this.runExclusive(async () => {
      try {
        return await task(cwd);
      } finally {
        await this.refresh().catch(() => undefined);
      }
    });
  }

  private runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const next = this.mutationChain.then(task, task);
    this.mutationChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private evictGraphSnapshots(): void {
    while (this.graphSnapshots.size > maxGraphSnapshots) {
      let oldestKey: string | null = null;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [key, meta] of this.graphSnapshots) {
        if (meta.startedAt < oldestAt) {
          oldestAt = meta.startedAt;
          oldestKey = key;
        }
      }
      if (!oldestKey) return;
      this.graphSnapshots.delete(oldestKey);
    }
  }

  private startWatching(): void {
    if (!this.workspacePath) return;
    try {
      const watcher = watch(this.workspacePath, { recursive: true }, (_event, file) => {
        this.scheduleRefresh(file);
      });
      watcher.on("error", () => this.stopWatching());
      this.watchers.push(watcher);
    } catch {
      // 平台不支持递归监听时退化为仅靠 agent 工具事件触发刷新。
    }
  }

  private stopWatching(): void {
    for (const watcher of this.watchers) {
      try {
        watcher.close();
      } catch {
        // watcher 可能已关闭
      }
    }
    this.watchers.length = 0;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private scheduleRefresh(file: string | Buffer | null): void {
    const changed = typeof file === "string" ? file : "";
    if (isNoise(changed)) return;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh().catch(() => undefined);
    }, refreshDebounceMs);
  }
}

function isNoise(relativeFile: string): boolean {
  if (!relativeFile) return false;
  const segments = relativeFile.split("/");
  return segments.some(
    (segment) =>
      segment === "node_modules" ||
      (segment === ".git" &&
        segments.indexOf(segment) !== segments.length - 1 &&
        segments.length - 1 - segments.indexOf(segment) > 1),
  );
}

/** 采集工作区对应的仓库状态;工作区不在仓库内时返回 null。 */
export async function collectStatus(cwd: string): Promise<GitStatusSnapshot | null> {
  const root = await resolveRepoRoot(cwd);
  if (!root) return null;

  const resolvedGitDir = await resolveGitDir(cwd);
  const remotes = await readRemotes(cwd);
  const snapshot: GitStatusSnapshot = {
    repo: {
      root,
      name: basename(root),
      remoteUrl: pickRemoteUrl(remotes),
      subdir: resolveSubdir(root, cwd),
      empty: !(await hasHead(cwd)),
    },
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    detached: false,
    files: [],
    addedLines: 0,
    deletedLines: 0,
    lastFetchAt: resolvedGitDir ? await readLastFetchAt(resolvedGitDir) : null,
    operation: resolvedGitDir ? await detectOperation(resolvedGitDir) : null,
    identity: await readIdentity(cwd),
    remotes,
  };

  let porcelain: string;
  try {
    porcelain = await gitQuery(cwd, ["status", "--porcelain=v2", "--branch"]);
  } catch {
    return snapshot;
  }

  const untracked: string[] = [];
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("# branch.head ")) {
      const head = line.slice("# branch.head ".length).trim();
      snapshot.detached = head === "(detached)";
      snapshot.branch = snapshot.detached ? null : head;
    } else if (line.startsWith("# branch.upstream ")) {
      snapshot.upstream = line.slice("# branch.upstream ".length).trim();
    } else if (line.startsWith("# branch.ab ")) {
      const match = /\+(\d+)\s+-(\d+)/.exec(line);
      if (match) {
        snapshot.ahead = Number(match[1]);
        snapshot.behind = Number(match[2]);
      }
    } else if (line.startsWith("1 ")) {
      const entry = parseStatusEntry(line, 1);
      if (entry) snapshot.files.push(entry);
    } else if (line.startsWith("2 ")) {
      const entry = parseStatusEntry(line, 2);
      if (entry) snapshot.files.push(entry);
    } else if (line.startsWith("u ")) {
      const entry = parseUnmergedEntry(line);
      if (entry) snapshot.files.push(entry);
    } else if (line.startsWith("? ")) {
      const path = unquote(line.slice(2));
      if (path) untracked.push(path);
    }
  }

  const [indexStats, worktreeStats] = await Promise.all([
    readNumstat(cwd, ["diff", "--cached", "--numstat", "-z"]),
    readNumstat(cwd, ["diff", "--numstat", "-z"]),
  ]);
  for (const file of snapshot.files) {
    const indexStat = indexStats.get(file.path);
    const worktreeStat = worktreeStats.get(file.path);
    if (indexStat) {
      file.indexAddedLines = indexStat.added;
      file.indexDeletedLines = indexStat.deleted;
    }
    if (worktreeStat) {
      file.worktreeAddedLines = worktreeStat.added;
      file.worktreeDeletedLines = worktreeStat.deleted;
    }
    file.addedLines = file.indexAddedLines + file.worktreeAddedLines;
    file.deletedLines = file.indexDeletedLines + file.worktreeDeletedLines;
  }

  if (untracked.length > 0) {
    const counts = await countUntrackedLines(root, untracked);
    for (const path of untracked) {
      const lines = counts.get(path) ?? 0;
      snapshot.files.push({
        path,
        oldPath: null,
        status: "untracked",
        indexStatus: null,
        worktreeStatus: "untracked",
        addedLines: lines,
        deletedLines: 0,
        indexAddedLines: 0,
        indexDeletedLines: 0,
        worktreeAddedLines: lines,
        worktreeDeletedLines: 0,
      });
    }
  }

  if (snapshot.operation) {
    snapshot.operation.conflictedPaths = snapshot.files
      .filter((file) => file.status === "conflicted")
      .map((file) => file.path);
  }
  snapshot.addedLines = snapshot.files.reduce((sum, file) => sum + file.addedLines, 0);
  snapshot.deletedLines = snapshot.files.reduce((sum, file) => sum + file.deletedLines, 0);
  return snapshot;
}

function pickRemoteUrl(remotes: GitRemote[]): string | null {
  const origin = remotes.find((remote) => remote.name === "origin");
  if (origin) return origin.fetchUrl || origin.pushUrl || null;
  const first = remotes[0];
  if (!first) return null;
  return first.fetchUrl || first.pushUrl || null;
}

function resolveSubdir(root: string, cwd: string): string | null {
  const rel = relative(root, cwd);
  if (!rel || rel === ".") return null;
  return rel.split("\\").join("/");
}

async function readIdentity(cwd: string): Promise<GitIdentity> {
  const [name, email] = await Promise.all([
    readGitConfig(cwd, "user.name"),
    readGitConfig(cwd, "user.email"),
  ]);
  return { name, email, configured: Boolean(name && email) };
}

async function readGitConfig(cwd: string, key: string): Promise<string | null> {
  try {
    const stdout = await gitQuery(cwd, ["config", "--get", key]);
    const value = stdout.trim();
    return value || null;
  } catch {
    return null;
  }
}

function parseStatusEntry(line: string, kind: 1 | 2): GitFileChange | null {
  const parts = line.split(" ");
  const xy = parts[1] ?? "";
  if (xy.length !== 2) return null;
  // kind 1:<path> 从第 9 列开始;kind 2:<path>\t<origPath>,先还原整段再按 tab 拆分。
  const rest = parts.slice(kind === 2 ? 9 : 8).join(" ");
  if (!rest) return null;
  let path: string;
  let oldPath: string | null = null;
  if (kind === 2) {
    const tab = rest.indexOf("\t");
    if (tab < 0) return null;
    path = unquote(rest.slice(0, tab));
    oldPath = unquote(rest.slice(tab + 1));
  } else {
    path = unquote(rest);
  }
  if (!path) return null;

  const indexStatus = statusFromCode(xy[0]);
  const worktreeStatus = statusFromCode(xy[1]);
  const status = combineStatus(indexStatus, worktreeStatus);
  return {
    path,
    oldPath: status === "renamed" ? oldPath : null,
    status,
    indexStatus,
    worktreeStatus,
    addedLines: 0,
    deletedLines: 0,
    indexAddedLines: 0,
    indexDeletedLines: 0,
    worktreeAddedLines: 0,
    worktreeDeletedLines: 0,
  };
}

function parseUnmergedEntry(line: string): GitFileChange | null {
  // 形如:u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
  // 去掉 "u " 与 XY 后 path 位于第 9 列(索引 8),用 split/join 兼容含空格路径。
  const rest = line.slice("u ".length + 3);
  const path = unquote(rest.split(" ").slice(8).join(" "));
  if (!path) return null;
  return {
    path,
    oldPath: null,
    status: "conflicted",
    indexStatus: "conflicted",
    worktreeStatus: "conflicted",
    addedLines: 0,
    deletedLines: 0,
    indexAddedLines: 0,
    indexDeletedLines: 0,
    worktreeAddedLines: 0,
    worktreeDeletedLines: 0,
  };
}

function statusFromCode(code: string): GitFileStatus | null {
  switch (code) {
    case ".":
    case "?":
      return null;
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
    case "C":
      return "renamed";
    case "U":
      return "conflicted";
    case "M":
    case "T":
      return "modified";
    default:
      return "modified";
  }
}

const statusPriority: GitFileStatus[] = [
  "conflicted",
  "untracked",
  "added",
  "deleted",
  "renamed",
  "modified",
];

function combineStatus(
  indexStatus: GitFileStatus | null,
  worktreeStatus: GitFileStatus | null,
): GitFileStatus {
  for (const candidate of statusPriority) {
    if (indexStatus === candidate || worktreeStatus === candidate) return candidate;
  }
  return "modified";
}

function unquote(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  return value;
}

async function countUntrackedLines(root: string, paths: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  await Promise.all(
    paths.map(async (path) => {
      try {
        const buffer = await readFile(join(root, path));
        counts.set(path, buffer.byteLength > maxUntrackedSampleBytes ? 0 : countLines(buffer));
      } catch {
        counts.set(path, 0);
      }
    }),
  );
  return counts;
}

function countLines(buffer: Buffer): number {
  let lines = 0;
  for (const byte of buffer) {
    if (byte === 0x0a) lines += 1;
  }
  if (buffer.length > 0 && buffer[buffer.length - 1] !== 0x0a) lines += 1;
  return lines;
}

/**
 * 分支 → 检出它的 worktree 路径。当前工作区所在的 worktree 会被排除,
 * 只保留「其他 worktree 正在使用」的分支,避免把本工作树也算成占用。
 */
async function collectWorktreeBranches(cwd: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  try {
    const stdout = await gitQuery(cwd, ["worktree", "list", "--porcelain"]);
    let path: string | null = null;
    for (const line of stdout.split("\n")) {
      if (line.startsWith("worktree ")) {
        path = line.slice("worktree ".length).trim();
      } else if (line.startsWith("branch refs/heads/") && path) {
        if (!isPathInside(cwd, path)) {
          result.set(line.slice("branch refs/heads/".length).trim(), path);
        }
      }
    }
  } catch {
    // 旧版本 git 不支持 worktree list 时忽略。
  }
  return result;
}

async function refExists(cwd: string, ref: string): Promise<boolean> {
  const result = await runGit(cwd, ["--no-optional-locks", "show-ref", "--verify", "--quiet", ref]);
  return result.code === 0;
}

async function localNameForRemoteBranch(cwd: string, name: string): Promise<string> {
  const remotes = await listRemoteNames(cwd);
  let matchedRemote: string | null = null;
  for (const remote of remotes) {
    if (name === remote || name.startsWith(`${remote}/`)) {
      if (!matchedRemote || remote.length > matchedRemote.length) matchedRemote = remote;
    }
  }
  if (matchedRemote) {
    const localName = name.slice(matchedRemote.length + 1);
    if (localName) return localName;
  }
  const slash = name.indexOf("/");
  return slash >= 0 ? name.slice(slash + 1) : name;
}

async function resolveRemoteForFetch(cwd: string, remoteArg: string | null): Promise<string> {
  const remotes = await listRemoteNames(cwd);
  if (remoteArg && remoteArg.trim()) {
    return assertSafeName(remoteArg.trim(), "远程名");
  }
  const upstream = await resolveUpstream(cwd);
  if (upstream) {
    const name = upstream.split("/")[0];
    if (remotes.includes(name)) return name;
  }
  if (remotes.includes("origin")) return "origin";
  const first = remotes[0];
  if (first) return first;
  throw new Error("没有可用的远程");
}

async function readUnpushedShas(cwd: string, upstream: string): Promise<Set<string>> {
  const stdout = await gitQuery(cwd, ["rev-list", `${upstream}..HEAD`]).catch(() => "");
  return new Set(
    stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  );
}

async function enrichCommits(cwd: string, commits: GitCommitSummary[]): Promise<void> {
  if (commits.length === 0) return;
  const upstream = await resolveUpstream(cwd);
  const unpushed = upstream ? await readUnpushedShas(cwd, upstream) : null;
  for (const commit of commits) {
    commit.pushed = unpushed ? !unpushed.has(commit.sha) : null;
  }
}

async function computeBoundaryInfo(
  cwd: string,
  commits: GitCommitSummary[],
): Promise<BoundaryInfo> {
  const pageShas = new Set(commits.map((commit) => commit.sha));
  const candidates = new Set<string>();
  for (const commit of commits) {
    for (const parent of commit.parents) {
      if (!pageShas.has(parent)) candidates.add(parent);
    }
  }
  if (candidates.size === 0) {
    return { pendingParents: [], shallowBoundary: [], boundaryParents: new Set() };
  }
  const shallow = await isShallowRepository(cwd);
  const pendingParents: string[] = [];
  const shallowBoundary: string[] = [];
  const boundaryParents = new Set<string>();
  for (const parent of candidates) {
    if (shallow && !(await objectExists(cwd, parent))) {
      shallowBoundary.push(parent);
      boundaryParents.add(parent);
    } else {
      pendingParents.push(parent);
    }
  }
  return { pendingParents, shallowBoundary, boundaryParents };
}

function parseCommitLog(stdout: string, remoteNames: string[]): GitCommitSummary[] {
  const commits: GitCommitSummary[] = [];
  for (const rawRecord of stdout.split(recordSeparator)) {
    const record = rawRecord.replace(/^\n+/, "");
    if (!record.trim()) continue;
    const fields = record.split(fieldSeparator);
    if (fields.length < 10) continue;
    commits.push(commitFromFields(fields, remoteNames));
  }
  return commits;
}

function parseCommitDetail(
  stdout: string,
  remoteNames: string[],
): { commit: GitCommitSummary; body: string } {
  const raw = stdout.split(recordSeparator)[0] ?? "";
  const fields = raw.replace(/^\n+/, "").split(fieldSeparator);
  const commit = commitFromFields(fields, remoteNames);
  const body = fields.slice(10).join(fieldSeparator).replace(/\n+$/, "");
  return { commit, body };
}

function commitFromFields(fields: string[], remoteNames: string[]): GitCommitSummary {
  const [
    sha,
    shortSha,
    parentsRaw,
    subject,
    authorName,
    authorEmail,
    authorAt,
    committerName,
    committerAt,
    refsRaw,
  ] = fields;
  return {
    sha: sha ?? "",
    shortSha: shortSha ?? "",
    parents: parentsRaw ? parentsRaw.split(" ").filter(Boolean) : [],
    subject: subject ?? "",
    authorName: authorName ?? "",
    authorEmail: authorEmail ?? "",
    authorAt: (Number(authorAt) || 0) * 1000,
    committerName: committerName ?? "",
    committerAt: (Number(committerAt) || 0) * 1000,
    refs: parseRefLabels(refsRaw ?? "", remoteNames),
    pushed: null,
    boundary: false,
  };
}

function parseRefLabels(raw: string, remoteNames: string[]): GitRefLabel[] {
  if (!raw.trim()) return [];
  const labels: GitRefLabel[] = [];
  for (const part of raw.split(", ")) {
    const name = part.trim();
    if (!name) continue;
    if (name.startsWith("HEAD -> ")) {
      labels.push({ name, kind: "head" });
      labels.push({ name: name.slice("HEAD -> ".length), kind: "local" });
    } else if (name.startsWith("tag: ")) {
      labels.push({ name: name.slice("tag: ".length), kind: "tag" });
    } else if (name === "HEAD") {
      labels.push({ name, kind: "head" });
    } else if (remoteNames.some((remote) => name === remote || name.startsWith(`${remote}/`))) {
      labels.push({ name, kind: "remote" });
    } else {
      labels.push({ name, kind: "local" });
    }
  }
  return labels;
}

async function readCommitFiles(
  cwd: string,
  base: string,
  sha: string,
): Promise<GitCommitFileChange[]> {
  const [numstatOut, nameStatusOut] = await Promise.all([
    gitQuery(cwd, ["diff", "--numstat", "-z", "-M", base, sha]).catch(() => ""),
    gitQuery(cwd, ["diff", "--name-status", "-z", "-M", base, sha]).catch(() => ""),
  ]);
  const stats = parseNumstatZ(numstatOut);
  const entries = parseNameStatusZ(nameStatusOut);
  return entries.map((entry) => {
    const stat = stats.get(entry.path) ?? { added: 0, deleted: 0 };
    return {
      path: entry.path,
      oldPath: entry.status === "renamed" ? entry.oldPath : null,
      status: entry.status,
      addedLines: stat.added,
      deletedLines: stat.deleted,
    };
  });
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function classifyPushFailure(text: string): GitPushOutcome {
  const value = text.toLowerCase();
  if (
    /could not resolve host|could not resolve|connection refused|connection timed out|connection reset|timed out|timeout|network is unreachable|failed to connect|unable to access/.test(
      value,
    )
  ) {
    return "network";
  }
  if (
    /authentication failed|could not read username|permission to .+ denied|invalid username or password|terminal prompts disabled/.test(
      value,
    )
  ) {
    return "auth";
  }
  if (/\b403\b|forbidden|write access|permission denied/.test(value)) {
    return "permission";
  }
  if (/protected branch|gh006|pre-receive hook declined|push declined due to/.test(value)) {
    return "protected";
  }
  if (
    /non-fast-forward|fetch first|stale info|rejected|updates were rejected|tip of your current branch is behind/.test(
      value,
    )
  ) {
    return "stale";
  }
  return "failed";
}

function pushFailureMessage(outcome: GitPushOutcome, stderr: string, stdout: string): string {
  const detail = firstNonEmptyLine(stderr) ?? firstNonEmptyLine(stdout);
  switch (outcome) {
    case "network":
      return detail ? `网络连接失败：${detail}` : "网络连接失败，请检查网络后重试";
    case "auth":
      return detail ? `认证失败：${detail}` : "认证失败，请检查凭据";
    case "permission":
      return detail ? `没有推送权限：${detail}` : "没有推送权限";
    case "protected":
      return detail ? `分支受保护，推送被拒绝：${detail}` : "分支受保护，推送被拒绝";
    case "stale":
      return detail ? `远程有新的提交，请先拉取：${detail}` : "远程有新的提交，请先拉取";
    default:
      return detail ?? "推送失败";
  }
}

function operationLabel(kind: GitInProgressOperation): string {
  switch (kind) {
    case "merge":
      return "合并";
    case "rebase":
      return "变基";
    case "cherry-pick":
      return "拣选";
    case "revert":
      return "回退";
    default:
      return "Git";
  }
}

function combineOutput(stdout: string, stderr: string): string {
  const out = stdout.trimEnd();
  const err = stderr.trimEnd();
  if (out && err) return `${out}\n${err}`;
  return out || err;
}

/** 读取远程分支当前的 SHA;分支不存在返回 null,读取失败抛错。 */
async function readRemoteBranchSha(
  cwd: string,
  remote: string,
  branch: string,
): Promise<string | null> {
  const result = await runGit(cwd, ["ls-remote", remote, `refs/heads/${branch}`], 20_000);
  if (result.code !== 0) {
    throw new Error(firstNonEmptyLine(result.stderr) ?? `无法读取 ${remote}/${branch} 的远程引用`);
  }
  for (const line of result.stdout.split("\n")) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (sha && ref === `refs/heads/${branch}`) return sha;
  }
  return null;
}

/** 解析 rev-list 输出为提交 SHA 列表;空输入返回空数组。 */
async function revList(cwd: string, range: string): Promise<string[]> {
  if (!range.trim()) return [];
  return gitQuery(cwd, ["rev-list", "--max-count=200", range])
    .then((stdout) => stdout.split("\n").map((line) => line.trim()).filter(Boolean))
    .catch(() => []);
}

async function readCommitRefs(cwd: string, shas: string[]): Promise<GitForcePushCommitRef[]> {
  const refs: GitForcePushCommitRef[] = [];
  for (const sha of shas) {
    const raw = await gitQuery(cwd, [
      "log",
      "-1",
      `--format=%H${fieldSeparator}%h${fieldSeparator}%s${fieldSeparator}%an${fieldSeparator}%at`,
      sha,
    ]).catch(() => "");
    const [full = sha, short = sha.slice(0, 7), subject = "", authorName = "", at = "0"] = raw
      .trim()
      .split(fieldSeparator);
    refs.push({
      sha: full,
      shortSha: short,
      subject,
      authorName,
      authorAt: (Number.parseInt(at, 10) || 0) * 1000,
    });
  }
  return refs;
}

function buildForcePushMessage(input: {
  remote: string;
  branch: string;
  remoteSha: string | null;
  localSha: string | null;
  ahead: GitForcePushCommitRef[];
  overwritten: GitForcePushCommitRef[];
}): string {
  if (!input.localSha) return "当前分支没有可推送的提交";
  if (!input.remoteSha) {
    return `远程 ${input.remote} 上还没有 ${input.branch}，使用普通推送即可建立分支`;
  }
  if (input.overwritten.length === 0) {
    return `远程 ${input.remote}/${input.branch} 可以直接快进（本地领先 ${input.ahead.length} 个提交），
不需要强推`.replace(/\n/g, "");
  }
  const first = input.overwritten[0]!;
  return `强推会用本地 ${input.localSha.slice(0, 7)} 覆盖远程 ${input.remoteSha.slice(0, 7)}，远程上有 ${input.overwritten.length} 个提交会从分支上移除（最新一条：${first.shortSha} ${first.subject}）`;
}

function firstNonEmptyLine(text: string): string | null {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function assertRepoRelativePath(path: string): string {
  if (!path || path.startsWith("-") || isAbsolute(path) || path.includes("\0")) {
    throw new Error("路径不正确");
  }
  const segments = path.split(/[\\/]/);
  if (segments.some((segment) => segment === "..")) {
    throw new Error("路径不正确");
  }
  return path;
}

function assertSafeRevision(value: string): string {
  if (!value || value.startsWith("-") || /\s/.test(value) || value.includes("\0")) {
    throw new Error("起始引用不正确");
  }
  return value;
}

/** 用户输入的 ref(分支名或 SHA)校验:拒绝选项注入、空白与控制字符。 */
function isSafeRefInput(value: string): boolean {
  if (!value || value.startsWith("-") || value.length > 300) return false;
  return !/[\s\u0000-\u001f\u007f]/.test(value);
}

function assertCommitSha(value: string): void {
  if (!/^[0-9a-f]{4,40}$/i.test(value)) {
    throw new Error("提交 SHA 不合法");
  }
}

export function isPathInside(target: string, boundary: string): boolean {
  const rel = relative(boundary, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
