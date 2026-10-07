import { readFile, stat } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";
import { AgentRuntime } from "@vela/agent";
import {
  IpcChannel,
  type AttachmentPickKind,
  type FileAttachmentPayload,
  type GitBranchAtInput,
  type GitBranchDeleteInput,
  type GitChangeScope,
  type GitCommitInput,
  type GitConflictResolveInput,
  type GitDiffOptions,
  type GitEvent,
  type GitForcePushInput,
  type GitGraphQuery,
  type GitHistoryAction,
  type GitHistoryOpInput,
  type GitHunkApplyInput,
  type GitOperationQuery,
  type GitOperationRecord,
  type GitOperationStatus,
  type GitOperationType,
  type GitPullInput,
  type GitPullStrategy,
  type GitPushInput,
  type GitRecoveryMode,
  type GitRecoveryPreviewInput,
  type GitReflogQuery,
  type GitReleaseCreateInput,
  type GitRemoteInput,
  type GitRewriteAction,
  type GitRewritePreviewInput,
  type GitStashApplyInput,
  type GitStashCreateInput,
  type GitTagCreateInput,
  type GitUndoCommitInput,
  type GitUpstreamInput,
  type GitWorktreeCreateInput,
  type GitWorktreeRemoveInput,
  type PrCloseInput,
  type PrCommentInput,
  type PrCreateInput,
  type PrIssueLinkInput,
  type PrMergeInput,
  type PrMergeMethod,
  type PrReviewEvent,
  type PrReviewInput,
  type PrThreadResolveInput,
  type PrUpdateInput,
  type SandboxApprovalEvent,
  type SandboxMode,
  type SelectableEnvironmentKind,
  type WorkspaceEvent,
  type WorkspaceState,
} from "@vela/shared";
import {
  ExecutionEnvironmentManager,
  GitOperationLog,
  GitService,
  PullRequestService,
  SandboxPermissionManager,
  WorkspaceFileService,
  WorkspaceManager,
  type WorkspaceRoots,
} from "@vela/workspace";
import { BrowserWindow, dialog, ipcMain, shell } from "electron";
import { getApplicationLocale } from "./menu";
import { createLogger } from "@vela/shared";

const log = createLogger("project");

const agentMutationDebounceMs = 800;
const maxAttachmentCount = 20;
const maxImageBytes = 10 * 1024 * 1024;
const imageMimeByExt: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export interface ProjectHostOptions {
  workspaceManager: WorkspaceManager;
  git: GitService;
  files: WorkspaceFileService;
  pr: PullRequestService;
  sandbox: SandboxPermissionManager;
  env: ExecutionEnvironmentManager;
  runtime: AgentRuntime;
  operations: GitOperationLog;
  fallbackCwd: string;
}

/**
 * 装配 Workspace / Git / PR / Sandbox 服务并注册它们的 IPC。
 * 工作区变化时统一编排:重挂 git → 刷新环境 → 重建 Agent 会话 → 推送事件。
 */
export class ProjectHost {
  private switchChain: Promise<void> = Promise.resolve();
  private mutationTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: ProjectHostOptions) {
    this.options.git.subscribe(() => {
      this.broadcast(IpcChannel.gitEvent, { type: "status-changed" } satisfies GitEvent);
    });
    this.options.sandbox.subscribe((event) => {
      this.broadcast(IpcChannel.sandboxApprovalEvent, event satisfies SandboxApprovalEvent);
    });
    this.options.workspaceManager.subscribe((workspace) => {
      this.switchChain = this.switchChain.then(() => this.onWorkspaceChanged(workspace));
    });
  }

  register(): void {
    ipcMain.handle(IpcChannel.workspaceOpenDialog, async (event) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      const english = getApplicationLocale() === "en";
      const dialogOptions = {
        title: english ? "Choose a workspace folder" : "选择工作区文件夹",
        buttonLabel: english ? "Choose" : "选择",
        properties: ["openDirectory", "createDirectory"] as ("openDirectory" | "createDirectory")[],
      };
      const result = win
        ? await dialog.showOpenDialog(win, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);
      if (result.canceled || result.filePaths.length === 0) {
        return this.options.workspaceManager.getState();
      }
      return this.options.workspaceManager.select(result.filePaths[0]);
    });
    ipcMain.handle(IpcChannel.workspaceGetState, () => this.options.workspaceManager.getState());
    ipcMain.handle(IpcChannel.workspaceSelect, (_event, raw: unknown) => {
      return this.options.workspaceManager.select(parsePath(raw, "工作区路径"));
    });
    ipcMain.handle(IpcChannel.workspaceClose, () => this.options.workspaceManager.close());
    ipcMain.handle(IpcChannel.workspaceRemoveRecent, (_event, raw: unknown) => {
      return this.options.workspaceManager.removeRecent(parsePath(raw, "工作区路径"));
    });
    ipcMain.handle(IpcChannel.envGet, () => this.options.env.getActive());
    ipcMain.handle(IpcChannel.envList, () => this.options.env.list());
    ipcMain.handle(IpcChannel.envSet, async (_event, raw: unknown) => {
      const kind = parseEnvironmentKind(raw);
      const target = await this.options.env.resolve(kind);
      await this.options.workspaceManager.select(target);
      return this.options.env.getActive();
    });

    ipcMain.handle(IpcChannel.gitGetStatus, () => this.options.git.getSnapshot());
    ipcMain.handle(IpcChannel.gitListBranches, () => this.options.git.listBranches());
    ipcMain.handle(IpcChannel.gitSwitchBranch, async (_event, raw: unknown, rawOptions: unknown) => {
      this.assertMutable();
      return this.options.git.switchBranch(parseBranchName(raw), parseTrackingOptions(rawOptions));
    });
    ipcMain.handle(IpcChannel.gitCreateBranch, async (_event, raw: unknown, rawStartPoint: unknown) => {
      this.assertMutable();
      return this.options.git.createBranch(parseBranchName(raw), parseOptionalBranchName(rawStartPoint));
    });
    ipcMain.handle(IpcChannel.gitFileDiff, async (_event, rawPath: unknown, rawScope: unknown, rawOptions: unknown) => {
      return this.options.git.fileDiff(parseRelativePath(rawPath), parseChangeScope(rawScope), parseDiffOptions(rawOptions));
    });
    ipcMain.handle(IpcChannel.gitApplyHunks, async (_event, raw: unknown) => {
      this.assertMutable();
      const input = parseHunkApplyInput(raw);
      const type: GitOperationType =
        input.action === "stage" ? "stage" : input.action === "unstage" ? "unstage" : "discard";
      return this.recordOperation(
        type,
        input.action === "stage" ? "暂存代码块" : input.action === "unstage" ? "取消暂存代码块" : "丢弃代码块",
        () => this.options.git.applyHunks(input),
        () => ({ status: "success", detail: input.path }),
      );
    });
    ipcMain.handle(IpcChannel.gitUndoCommit, async (_event, raw: unknown) => {
      this.assertMutable();
      const input = parseUndoCommitInput(raw);
      return this.recordOperation(
        "undo-commit",
        input.mode === "keep-index" ? "撤销最近的提交（保留到索引）" : "撤销最近的提交（保留到工作区）",
        () => this.options.git.undoLastCommit(input),
        (result) => ({
          status: result.ok ? "success" : "failed",
          error: result.ok ? null : result.message,
          detail: result.subject ?? result.message,
        }),
      );
    });
    ipcMain.handle(IpcChannel.gitBranchDetail, (_event, raw: unknown) => {
      return this.options.git.branchDetail(parseBranchName(raw));
    });
    ipcMain.handle(IpcChannel.gitRenameBranch, async (_event, raw: unknown, rawNext: unknown) => {
      this.assertMutable();
      const name = parseBranchName(raw);
      const nextName = parseBranchName(rawNext);
      return this.recordOperation(
        "branch",
        `重命名分支 ${name} → ${nextName}`,
        () => this.options.git.renameBranch(name, nextName),
        () => ({ status: "success", detail: nextName }),
        name,
      );
    });
    ipcMain.handle(IpcChannel.gitDeleteBranch, async (_event, raw: unknown) => {
      this.assertMutable();
      const input = parseBranchDeleteInput(raw);
      return this.recordOperation(
        "branch",
        input.remote ? `删除分支 ${input.name} 与远程分支` : `删除分支 ${input.name}`,
        () => this.options.git.deleteBranch(input),
        (result) => ({ status: result.ok ? "success" : "failed", error: result.ok ? null : result.message, detail: result.message }),
        input.name,
      );
    });
    ipcMain.handle(IpcChannel.gitCompareRefs, (_event, rawBase: unknown, rawHead: unknown, rawOptions: unknown) => {
      return this.options.git.compareRefs(parseRefInput(rawBase), parseRefInput(rawHead), parseDiffOptions(rawOptions));
    });
    ipcMain.handle(IpcChannel.gitRemoteAdd, async (_event, raw: unknown) => {
      this.assertMutable();
      const input = parseRemoteInput(raw);
      return this.recordOperation(
        "remote",
        `添加远程 ${input.name}`,
        () => this.options.git.addRemote(input),
        (result) => ({ status: "success", detail: result.message }),
      );
    });
    ipcMain.handle(IpcChannel.gitRemoteSetUrl, async (_event, rawName: unknown, rawUrl: unknown, rawPush: unknown) => {
      this.assertMutable();
      const name = parseRemoteName(rawName);
      const url = parseRemoteUrl(rawUrl);
      const pushUrl = rawPush === null || rawPush === undefined || rawPush === "" ? null : parseRemoteUrl(rawPush);
      return this.recordOperation(
        "remote",
        `修改远程 ${name} 的地址`,
        () => this.options.git.setRemoteUrl(name, url, pushUrl),
        (result) => ({ status: "success", detail: result.message }),
      );
    });
    ipcMain.handle(IpcChannel.gitRemoteRemove, async (_event, raw: unknown) => {
      this.assertMutable();
      const name = parseRemoteName(raw);
      return this.recordOperation(
        "remote",
        `删除远程 ${name}`,
        () => this.options.git.removeRemote(name),
        (result) => ({ status: "success", detail: result.message }),
      );
    });
    ipcMain.handle(IpcChannel.gitRemoteRename, async (_event, raw: unknown, rawNext: unknown) => {
      this.assertMutable();
      const name = parseRemoteName(raw);
      const nextName = parseRemoteName(rawNext);
      return this.recordOperation(
        "remote",
        `重命名远程 ${name} → ${nextName}`,
        () => this.options.git.renameRemote(name, nextName),
        (result) => ({ status: "success", detail: result.message }),
      );
    });
    ipcMain.handle(IpcChannel.gitSetUpstream, async (_event, raw: unknown) => {
      this.assertMutable();
      const input = parseUpstreamInput(raw);
      return this.recordOperation(
        "branch",
        input.upstream ? `设置 ${input.branch} 跟踪 ${input.upstream}` : `清除 ${input.branch} 的跟踪关系`,
        () => this.options.git.setUpstream(input),
        () => ({ status: "success", detail: input.upstream ?? input.branch }),
        input.branch,
      );
    });
    ipcMain.handle(IpcChannel.gitConflictFile, (_event, raw: unknown) => {
      return this.options.git.conflictFile(parseRelativePath(raw));
    });
    ipcMain.handle(IpcChannel.gitConflictResolve, async (_event, raw: unknown) => {
      this.assertMutable();
      const input = parseConflictResolveInput(raw);
      return this.recordOperation(
        "conflict",
        `解决冲突 ${input.path}`,
        () => this.options.git.resolveConflict(input),
        (result) => ({ status: result.ok ? "success" : "failed", error: result.ok ? null : result.message, detail: result.message }),
      );
    });
    ipcMain.handle(IpcChannel.gitOperationControl, async (_event, raw: unknown) => {
      this.assertMutable();
      const action = raw === "abort" ? "abort" : raw === "continue" ? "continue" : null;
      if (!action) throw new Error("操作类型不正确");
      return this.recordOperation(
        "conflict",
        action === "continue" ? "继续进行中的 Git 操作" : "中止进行中的 Git 操作",
        () => this.options.git.controlOperation(action),
        (result) => ({
          status: result.ok ? "success" : "failed",
          error: result.ok ? null : result.message,
          detail: result.message,
        }),
      );
    });
    ipcMain.handle(IpcChannel.gitStashList, () => this.options.git.stashes());
    ipcMain.handle(IpcChannel.gitStashCreate, async (_event, raw: unknown) => {
      this.assertMutable();
      const input = parseStashCreateInput(raw);
      return this.recordOperation(
        "stash",
        input.message.trim() ? `保存 Stash：${input.message.trim()}` : "保存 Stash",
        () => this.options.git.stashCreate(input),
        (result) => ({
          status: result.ok ? "success" : "failed",
          error: result.ok ? null : result.message,
          detail: result.stash?.id ?? result.message,
        }),
      );
    });
    ipcMain.handle(IpcChannel.gitStashApply, async (_event, raw: unknown) => {
      this.assertMutable();
      const input = parseStashApplyInput(raw);
      return this.recordOperation(
        "stash",
        input.mode === "pop" ? `恢复并移除 ${input.id}` : `应用 ${input.id}`,
        () => this.options.git.stashApply(input),
        (result) => ({ status: result.ok ? "success" : "failed", error: result.ok ? null : result.message, detail: result.message }),
      );
    });
    ipcMain.handle(IpcChannel.gitStashDrop, async (_event, raw: unknown) => {
      this.assertMutable();
      const id = parseStashId(raw);
      return this.recordOperation(
        "stash",
        `删除 ${id}`,
        () => this.options.git.stashDrop(id),
        (result) => ({ status: result.ok ? "success" : "failed", error: result.ok ? null : result.message, detail: result.message }),
      );
    });
    ipcMain.handle(IpcChannel.gitStashDiff, (_event, raw: unknown) => {
      return this.options.git.stashDiff(parseStashId(raw));
    });
    ipcMain.handle(IpcChannel.gitWorktreeList, () => this.options.git.worktrees());
    ipcMain.handle(IpcChannel.gitWorktreeCreate, async (_event, raw: unknown) => {
      const input = parseWorktreeCreateInput(raw);
      return this.recordOperation(
        "worktree",
        `创建 worktree（${input.branch}）`,
        () => this.options.git.worktreeCreate(input),
        (result) => ({
          status: result.ok ? "success" : "failed",
          error: result.ok ? null : result.message,
          detail: result.path ?? result.message,
        }),
      );
    });
    ipcMain.handle(IpcChannel.gitWorktreeRemove, async (_event, raw: unknown) => {
      const input = parseWorktreeRemoveInput(raw);
      return this.recordOperation(
        "worktree",
        `删除 worktree ${basename(input.path)}`,
        () => this.options.git.worktreeRemove(input),
        (result) => ({
          status: result.ok ? "success" : "failed",
          error: result.ok ? null : result.message,
          detail: result.message,
        }),
      );
    });
    ipcMain.handle(IpcChannel.gitWorktreePrune, async () => {
      return this.recordOperation(
        "worktree",
        "清理失效 worktree 记录",
        () => this.options.git.worktreePrune(),
        (result) => ({
          status: result.ok ? "success" : "failed",
          error: result.ok ? null : result.message,
          detail: result.pruned.join("、") || result.message,
        }),
      );
    });
    ipcMain.handle(IpcChannel.gitStagedDiff, () => this.options.git.stagedDiff());
    ipcMain.handle(IpcChannel.gitSetIdentity, async (_event, rawName: unknown, rawEmail: unknown) => {
      return this.options.git.setIdentity(parseIdentityName(rawName), parseIdentityEmail(rawEmail));
    });
    ipcMain.handle(IpcChannel.gitStage, async (_event, raw: unknown) => {
      this.assertMutable();
      return this.options.git.stage(parsePathList(raw));
    });
    ipcMain.handle(IpcChannel.gitUnstage, async (_event, raw: unknown) => {
      this.assertMutable();
      return this.options.git.unstage(parsePathList(raw));
    });
    ipcMain.handle(IpcChannel.gitDiscard, async (_event, raw: unknown, rawOptions: unknown) => {
      this.assertMutable();
      const paths = parsePathList(raw);
      const options = parseDiscardOptions(rawOptions);
      const record = this.options.operations.begin({
        type: "discard",
        workspace: this.currentWorkspace(),
        repoRoot: this.options.git.getSnapshot()?.repo?.root ?? null,
        branch: this.options.git.getSnapshot()?.branch ?? null,
        expectedHead: null,
        steps: [{ id: "discard", label: `丢弃 ${paths.length} 个文件` }],
      });
      try {
        const snapshot = await this.options.git.discard(paths, options);
        this.options.operations.finish(record.id, {
          status: "success",
          steps: [{ id: "discard", label: `丢弃 ${paths.length} 个文件`, status: "success", detail: null }],
        });
        return snapshot;
      } catch (error) {
        this.options.operations.finish(record.id, {
          status: "failed",
          error: errorMessage(error),
          steps: [{ id: "discard", label: `丢弃 ${paths.length} 个文件`, status: "failed", detail: errorMessage(error) }],
        });
        throw error;
      }
    });
    ipcMain.handle(IpcChannel.gitCommit, async (_event, raw: unknown) => {
      this.assertMutable();
      return this.commitWithRecord(parseCommitInput(raw));
    });
    ipcMain.handle(IpcChannel.gitGuard, () => this.gitGuard());
    ipcMain.handle(IpcChannel.gitFetch, async (_event, rawRemote: unknown) => {
      const remote = parseOptionalRemote(rawRemote);
      const record = this.options.operations.begin({
        type: "fetch",
        workspace: this.currentWorkspace(),
        repoRoot: this.options.git.getSnapshot()?.repo?.root ?? null,
        branch: this.options.git.getSnapshot()?.branch ?? null,
        expectedHead: null,
        steps: [{ id: "fetch", label: remote ? `Fetch ${remote}` : "Fetch" }],
      });
      const result = await this.options.git.fetch(remote);
      this.options.operations.finish(record.id, {
        status: result.ok ? "success" : "failed",
        error: result.ok ? null : result.message,
        steps: [{ id: "fetch", label: result.remote, status: result.ok ? "success" : "failed", detail: result.message || null }],
      });
      return result;
    });
    ipcMain.handle(IpcChannel.gitPull, async () => {
      this.assertMutable();
      const record = this.options.operations.begin({
        type: "pull",
        workspace: this.currentWorkspace(),
        repoRoot: this.options.git.getSnapshot()?.repo?.root ?? null,
        branch: this.options.git.getSnapshot()?.branch ?? null,
        expectedHead: await this.options.git.headSha(),
        steps: [{ id: "pull", label: "仅快进 Pull" }],
      });
      const result = await this.options.git.pull();
      this.options.operations.finish(record.id, {
        status: result.ok ? "success" : "failed",
        error: result.ok ? null : result.message,
        steps: [{ id: "pull", label: "仅快进 Pull", status: result.ok ? "success" : "failed", detail: result.message || null }],
      });
      return result;
    });
    ipcMain.handle(IpcChannel.gitPush, async (_event, raw: unknown) => {
      return this.pushWithRecord(parsePushInput(raw));
    });
    ipcMain.handle(IpcChannel.gitCommitAndPush, async (_event, rawInput: unknown, rawTarget: unknown) => {
      this.assertMutable();
      const input = parseCommitInput(rawInput);
      const target = parsePushInput(rawTarget);
      const record = this.options.operations.begin({
        type: "commit-push",
        workspace: this.currentWorkspace(),
        repoRoot: this.options.git.getSnapshot()?.repo?.root ?? null,
        branch: this.options.git.getSnapshot()?.branch ?? null,
        expectedHead: await this.options.git.headSha(),
        steps: [
          { id: "commit", label: "创建提交" },
          { id: "push", label: `推送到 ${target.remote}/${target.branch}` },
        ],
      });
      const commit = await this.options.git.commit(input);
      if (!commit.ok) {
        this.options.operations.finish(record.id, {
          status: "failed",
          error: commit.message,
          steps: [
            { id: "commit", label: "创建提交", status: "failed", detail: commit.message },
            { id: "push", label: `推送到 ${target.remote}/${target.branch}`, status: "skipped", detail: null },
          ],
        });
        return { commit, push: null };
      }
      const push = await this.options.git.push(target);
      this.options.operations.finish(record.id, {
        status: push.ok ? "success" : push.confirmed ? "partial" : "unconfirmed",
        resultSha: commit.sha,
        error: push.ok ? null : push.message,
        steps: [
          { id: "commit", label: "创建提交", status: "success", detail: commit.shortSha },
          { id: "push", label: `推送到 ${target.remote}/${target.branch}`, status: push.ok ? "success" : "failed", detail: push.message || null },
        ],
      });
      return { commit, push };
    });
    ipcMain.handle(IpcChannel.gitGraph, (_event, raw: unknown) => {
      return this.options.git.graph(parseGraphQuery(raw));
    });
    ipcMain.handle(IpcChannel.gitCommitDetail, (_event, rawSha: unknown, rawParent: unknown, rawOptions: unknown) => {
      return this.options.git.commitDetail(parseSha(rawSha), parseOptionalSha(rawParent), parseDiffOptions(rawOptions));
    });
    ipcMain.handle(IpcChannel.gitSearchCommits, (_event, rawQuery: unknown, rawScope: unknown, rawLimit: unknown) => {
      return this.options.git.searchCommits(parseSearchQuery(rawQuery), parseGraphScope(rawScope), parseLimit(rawLimit));
    });
    ipcMain.handle(IpcChannel.gitOperations, (_event, raw: unknown) => {
      return this.options.operations.snapshot(this.currentWorkspace(), parseOperationQuery(raw));
    });
    ipcMain.handle(IpcChannel.gitOperationRefresh, (_event, rawId: unknown) => {
      return this.refreshOperationRecord(parseId(rawId, "操作记录"));
    });
    ipcMain.handle(IpcChannel.prUpdate, async (_event, raw: unknown) => {
      const input = parsePrUpdateInput(raw);
      return this.recordOperation(
        "pr-update",
        `更新 PR #${input.number}`,
        () => this.options.pr.update(input),
        (result) => ({
          status: result.ok ? "success" : "failed",
          error: result.ok ? null : result.message,
          resultUrl: result.pr?.url ?? null,
          prNumber: input.number,
          detail: result.changes.join("、") || result.message,
        }),
      );
    });
    ipcMain.handle(IpcChannel.prReady, async (_event, raw: unknown) => {
      const number = parsePrNumber(raw);
      return this.recordOperation(
        "pr-update",
        `PR #${number} 转为 Ready`,
        () => this.options.pr.markReady(number),
        (result) => ({
          status: result.ok ? "success" : "failed",
          error: result.ok ? null : result.message,
          resultUrl: result.pr?.url ?? null,
          prNumber: number,
          detail: result.message,
        }),
      );
    });
    ipcMain.handle(IpcChannel.prLinkIssues, async (_event, raw: unknown) => {
      const input = parsePrIssueLinkInput(raw);
      return this.recordOperation(
        "pr-update",
        input.mode === "close" ? `关联并自动关闭 Issue（PR #${input.number}）` : `关联 Issue（PR #${input.number}）`,
        () => this.options.pr.linkIssues(input),
        (result) => ({
          status: result.ok ? "success" : "failed",
          error: result.ok ? null : result.message,
          resultUrl: result.pr?.url ?? null,
          prNumber: input.number,
          detail: result.changes.join("、") || result.message,
        }),
      );
    });
    ipcMain.handle(IpcChannel.prEditOptions, () => this.options.pr.getEditOptions());

    // ---------- P2:审阅协作、合并与关闭 (PR-06/PR-07) ----------
    ipcMain.handle(IpcChannel.prReviewThreads, (_event, raw: unknown) => {
      return this.options.pr.getReviewThreads(parseOptionalPrNumber(raw));
    });
    ipcMain.handle(IpcChannel.prComment, async (_event, raw: unknown) => {
      const input = parsePrCommentInput(raw);
      return this.recordOperation(
        "pr-review",
        `评论 PR #${input.number}`,
        () => this.options.pr.comment(input),
        (result) => ({
          status: result.ok ? "success" : "failed",
          error: result.ok ? null : result.message,
          prNumber: input.number,
          detail: result.message,
        }),
      );
    });
    ipcMain.handle(IpcChannel.prReview, async (_event, raw: unknown) => {
      const input = parsePrReviewInput(raw);
      const label =
        input.event === "approve"
          ? `批准 PR #${input.number}`
          : input.event === "request-changes"
            ? `请求修改 PR #${input.number}`
            : `审阅评论 PR #${input.number}`;
      return this.recordOperation(
        "pr-review",
        label,
        () => this.options.pr.review(input),
        (result) => ({
          status: result.ok ? "success" : "failed",
          error: result.ok ? null : result.message,
          prNumber: input.number,
          detail: result.message,
        }),
      );
    });
    ipcMain.handle(IpcChannel.prResolveThread, async (_event, raw: unknown) => {
      const input = parseThreadResolveInput(raw);
      return this.recordOperation(
        "pr-review",
        input.resolved ? "解决审阅线程" : "重新打开审阅线程",
        () => this.options.pr.resolveThread(input),
        (result) => ({
          status: result.ok ? "success" : "failed",
          error: result.ok ? null : result.message,
          detail: result.message,
        }),
      );
    });
    ipcMain.handle(IpcChannel.prMergePreview, (_event, raw: unknown) => {
      return this.options.pr.getMergePreview(parseOptionalPrNumber(raw));
    });
    ipcMain.handle(IpcChannel.prMerge, async (_event, raw: unknown) => {
      const input = parsePrMergeInput(raw);
      return this.recordOperation(
        "pr-merge",
        `合并 PR #${input.number}`,
        () => this.options.pr.merge(input),
        (result) => ({
          status: result.ok ? "success" : "failed",
          error: result.ok ? null : result.message,
          resultUrl: result.pr?.url ?? null,
          prNumber: input.number,
          detail: result.message,
        }),
      );
    });
    ipcMain.handle(IpcChannel.prClose, async (_event, raw: unknown) => {
      const input = parsePrCloseInput(raw);
      return this.recordOperation(
        "pr-merge",
        `关闭 PR #${input.number}`,
        () => this.options.pr.close(input),
        (result) => ({
          status: result.ok ? "success" : "failed",
          error: result.ok ? null : result.message,
          resultUrl: result.pr?.url ?? null,
          prNumber: input.number,
          detail: result.message,
        }),
      );
    });

    // ---------- P2:历史操作、提交整理与恢复 (HI-02–HI-04/HI-06/CT-06) ----------
    ipcMain.handle(IpcChannel.gitCreateBranchAt, async (_event, raw: unknown) => {
      this.assertMutable();
      const input = parseBranchAtInput(raw);
      return this.recordOperation(
        "branch",
        `从 ${input.startPoint.slice(0, 7)} 创建分支 ${input.name}`,
        () => this.options.git.createBranchAt(input),
        (result) => ({
          status: result.ok ? "success" : "failed",
          error: result.ok ? null : result.message,
          detail: result.message,
        }),
        input.name,
      );
    });
    ipcMain.handle(IpcChannel.gitHistoryOpPreview, (_event, raw: unknown) => {
      return this.options.git.previewHistoryOp(parseHistoryOpInput(raw));
    });
    ipcMain.handle(IpcChannel.gitHistoryOp, async (_event, raw: unknown) => {
      this.assertMutable();
      const input = parseHistoryOpInput(raw);
      return this.recordOperation(
        input.action === "revert" ? "revert" : "cherry-pick",
        input.action === "revert" ? `撤销提交 ${input.sha.slice(0, 7)}` : `拣选提交 ${input.sha.slice(0, 7)}`,
        () => this.options.git.runHistoryOp(input),
        (result) => ({
          status: result.ok ? "success" : result.conflicted ? "partial" : "failed",
          error: result.ok ? null : result.message,
          resultSha: result.sha,
          detail: result.message,
        }),
      );
    });
    ipcMain.handle(IpcChannel.gitRewritePreview, (_event, raw: unknown) => {
      return this.options.git.previewRewrite(parseRewriteInput(raw));
    });
    ipcMain.handle(IpcChannel.gitRewrite, async (_event, raw: unknown) => {
      this.assertMutable();
      const input = parseRewriteInput(raw);
      return this.recordOperation(
        "history-rewrite",
        `${input.action === "fixup" ? "Fixup" : "Squash"} ${input.sourceSha.slice(0, 7)} → ${input.targetSha.slice(0, 7)}`,
        () => this.options.git.runRewrite(input),
        (result) => ({
          status: result.ok ? "success" : "failed",
          error: result.ok ? null : result.message,
          resultSha: result.head,
          detail: result.message,
        }),
      );
    });
    ipcMain.handle(IpcChannel.gitReflog, (_event, raw: unknown) => {
      return this.options.git.reflog(parseReflogQuery(raw));
    });
    ipcMain.handle(IpcChannel.gitRecoveryPreview, (_event, raw: unknown) => {
      return this.options.git.previewRecovery(parseRecoveryInput(raw));
    });
    ipcMain.handle(IpcChannel.gitRecovery, async (_event, raw: unknown) => {
      this.assertMutable();
      const input = parseRecoveryInput(raw);
      return this.recordOperation(
        "reflog-recover",
        `恢复 ${input.target}（${input.mode}）`,
        () => this.options.git.runRecovery(input),
        (result) => ({
          status: result.ok ? "success" : "failed",
          error: result.ok ? null : result.message,
          resultSha: result.head,
          detail: result.message,
        }),
      );
    });

    // ---------- P2:高级同步与安全强推 (SY-03/SY-04) ----------
    ipcMain.handle(IpcChannel.gitPullWithStrategy, async (_event, raw: unknown) => {
      this.assertMutable();
      const input = parsePullInput(raw);
      const label =
        input.strategy === "merge" ? "Merge 同步" : input.strategy === "rebase" ? "Rebase 同步" : "仅快进 Pull";
      return this.recordOperation(
        "pull",
        label,
        () => this.options.git.pullWithStrategy(input),
        (result) => ({
          status: result.ok ? "success" : result.conflicted ? "partial" : "failed",
          error: result.ok ? null : result.message,
          detail: result.message,
        }),
      );
    });
    ipcMain.handle(IpcChannel.gitForcePush, async (_event, raw: unknown) => {
      this.assertMutable();
      const input = parseForcePushInput(raw);
      return this.recordOperation(
        "force-push",
        `安全强推到 ${input.remote}/${input.branch}`,
        () => this.options.git.forcePush(input),
        (result) => ({
          status: result.ok ? "success" : result.confirmed ? "failed" : "unconfirmed",
          error: result.ok ? null : result.message,
          detail: result.message,
        }),
        input.branch,
      );
    });

    // ---------- P2:Tag 与 Release (RL-01) ----------
    ipcMain.handle(IpcChannel.gitTagList, () => this.options.git.tags());
    ipcMain.handle(IpcChannel.gitTagCreate, async (_event, raw: unknown) => {
      const input = parseTagCreateInput(raw);
      return this.recordOperation(
        "tag",
        `创建标签 ${input.name}`,
        () => this.options.git.tagCreate(input),
        (result) => ({
          status: result.ok ? "success" : "failed",
          error: result.ok ? null : result.message,
          resultSha: result.tag?.sha ?? null,
          detail: result.message,
        }),
      );
    });
    ipcMain.handle(IpcChannel.gitTagDelete, async (_event, rawName: unknown, rawRemote: unknown) => {
      const name = parsePath(rawName, "标签名");
      const remote = parseOptionalRemote(rawRemote);
      return this.recordOperation(
        "tag",
        `删除标签 ${name}`,
        () => this.options.git.tagDelete(name, remote),
        (result) => ({
          status: result.ok ? "success" : "failed",
          error: result.ok ? null : result.message,
          detail: result.message,
        }),
      );
    });
    ipcMain.handle(IpcChannel.gitReleaseList, () => this.options.git.releases());
    ipcMain.handle(IpcChannel.gitReleaseCreate, async (_event, raw: unknown) => {
      const input = parseReleaseCreateInput(raw);
      return this.recordOperation(
        "release",
        `创建发布 ${input.tagName}`,
        () => this.options.git.releaseCreate(input),
        (result) => ({
          status: result.ok ? "success" : "failed",
          error: result.ok ? null : result.message,
          resultUrl: result.release?.url ?? null,
          detail: result.message,
        }),
      );
    });
    ipcMain.handle(IpcChannel.gitReleaseScope, (_event, rawBase: unknown, rawTarget: unknown) => {
      const base = typeof rawBase === "string" && rawBase.trim() ? rawBase.trim() : null;
      const target = parsePath(rawTarget, "发布版本");
      return this.options.git.releaseNotesScope(base, target);
    });
    ipcMain.handle(IpcChannel.aiText, async (_event, raw: unknown) => {
      return this.options.runtime.generateTextAssist(raw);
    });
    ipcMain.handle(IpcChannel.aiTextCancel, (_event, raw: unknown) => {
      this.options.runtime.cancelTextAssist(raw);
    });
    ipcMain.handle(IpcChannel.gitOpenFile, async (_event, raw: unknown) => {
      // 只调用系统默认程序打开,不向渲染进程返回任何文件内容,
      // 因此不限制在仓库/工作区边界内(预览面板对工作区外文件也提供此操作)。
      const absolutePath = parseAbsolutePath(raw);
      const message = await shell.openPath(absolutePath);
      if (message) throw new Error(message);
    });

    ipcMain.handle(IpcChannel.workspaceFileRead, async (_event, rawPath: unknown) => {
      return this.options.files.read(this.workspaceRoots(), parseFlexiblePath(rawPath));
    });
    ipcMain.handle(IpcChannel.workspaceFileList, () => {
      return this.options.files.listFiles(this.workspaceRoots());
    });
    ipcMain.handle(IpcChannel.workspaceSearch, async (_event, rawQuery: unknown) => {
      return this.options.files.search(this.workspaceRoots(), parsePath(rawQuery, "搜索词"));
    });

    ipcMain.handle(IpcChannel.prGet, () => this.options.pr.getForCurrentBranch());
    ipcMain.handle(IpcChannel.prDetail, () => this.options.pr.getDetail());
    ipcMain.handle(IpcChannel.prTemplates, () => this.options.pr.listTemplates());
    ipcMain.handle(IpcChannel.prScope, (_event, rawBase: unknown, rawHead: unknown) => {
      return this.options.pr.getScope(parseBranchName(rawBase), parseOptionalBranchName(rawHead));
    });
    ipcMain.handle(IpcChannel.prCreateNative, (_event, raw: unknown) => {
      return this.createPullRequestWithRecord(parsePrCreateInput(raw));
    });
    ipcMain.handle(IpcChannel.prOpen, (_event, raw: unknown) => {
      return this.options.pr.openPr(parseUrl(raw));
    });
    ipcMain.handle(IpcChannel.prCreate, () => this.options.pr.createPr());

    ipcMain.handle(IpcChannel.sandboxGetMode, () => this.options.sandbox.getMode());
    ipcMain.handle(IpcChannel.sandboxSetMode, (_event, raw: unknown) => {
      return this.options.sandbox.setMode(parseSandboxMode(raw));
    });
    ipcMain.handle(IpcChannel.sandboxApprovalReply, (_event, rawId: unknown, rawAllowed: unknown) => {
      if (typeof rawAllowed !== "boolean") throw new Error("审批回复不正确");
      this.options.sandbox.reply(parseId(rawId, "审批请求"), rawAllowed);
    });

    ipcMain.handle(IpcChannel.appPickAttachments, async (event, rawKind: unknown) => {
      const kind: AttachmentPickKind = rawKind === "image" ? "image" : "file";
      const win = BrowserWindow.fromWebContents(event.sender);
      const options = {
        title: getApplicationLocale() === "en"
          ? kind === "image" ? "Choose an image" : "Choose a file"
          : kind === "image" ? "选择图片" : "选择文件",
        properties: ["openFile", "multiSelections"] as ("openFile" | "multiSelections")[],
        ...(kind === "image"
          ? { filters: [{ name: getApplicationLocale() === "en" ? "Images" : "图片", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }] }
          : {}),
      };
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options);
      if (result.canceled || result.filePaths.length === 0) return [];
      return this.hydrateAttachments(result.filePaths);
    });
    ipcMain.handle(IpcChannel.appHydrateAttachments, (_event, raw: unknown) => {
      if (!Array.isArray(raw)) throw new Error("附件路径不正确");
      const paths = raw.map((entry) => parseAbsolutePath(entry));
      if (paths.length > maxAttachmentCount) throw new Error("附件过多");
      return this.hydrateAttachments(paths);
    });
  }

  /** SessionHost 在 agent 的 bash/edit/write 工具结束后调用,防抖刷新 git 状态。 */
  notifyAgentMutation(): void {
    if (this.mutationTimer) clearTimeout(this.mutationTimer);
    this.mutationTimer = setTimeout(() => {
      this.mutationTimer = null;
      void this.options.git.refresh().catch(() => undefined);
    }, agentMutationDebounceMs);
  }

  private currentWorkspace(): string | null {
    return this.options.workspaceManager.getState().current;
  }

  /** Agent 在同一工作树执行时,首期阻止改动文件/索引的操作;主进程侧同样拦截。 */
  private assertMutable(): void {
    const running = this.options.runtime.findRunningAgent(this.currentWorkspace());
    if (running) {
      throw new Error("Agent 正在这个工作树执行，暂时不能改动文件或索引");
    }
  }

  private gitGuard() {
    const conversationId = this.options.runtime.findRunningAgent(this.currentWorkspace());
    return {
      agentRunning: conversationId !== null,
      conversationId,
      reason: conversationId ? "Agent 正在这个工作树执行" : null,
    };
  }

  private async commitWithRecord(input: GitCommitInput) {
    const snapshot = this.options.git.getSnapshot();
    const label = input.amend ? "修正最近提交" : "创建提交";
    const record = this.options.operations.begin({
      type: input.amend ? "amend" : "commit",
      workspace: this.currentWorkspace(),
      repoRoot: snapshot?.repo?.root ?? null,
      branch: snapshot?.branch ?? null,
      expectedHead: await this.options.git.headSha(),
      steps: [{ id: "commit", label }],
    });
    const result = await this.options.git.commit(input);
    this.options.operations.finish(record.id, {
      status: result.ok ? "success" : "failed",
      resultSha: result.sha,
      error: result.ok ? null : result.message,
      steps: [{ id: "commit", label, status: result.ok ? "success" : "failed", detail: result.ok ? result.shortSha : result.message }],
    });
    return result;
  }

  /**
   * 统一记录一次写操作:开始时固定目标,结束后写入真实结果;
   * 抛错也写失败记录后再抛出,保证记录与恢复入口不丢。
   */
  private async recordOperation<T>(
    type: GitOperationType,
    label: string,
    task: () => Promise<T>,
    settle: (result: T) => {
      status: GitOperationStatus;
      error?: string | null;
      resultSha?: string | null;
      resultUrl?: string | null;
      prNumber?: number | null;
      detail?: string | null;
    },
    branch?: string | null,
  ): Promise<T> {
    const snapshot = this.options.git.getSnapshot();
    const record = this.options.operations.begin({
      type,
      workspace: this.currentWorkspace(),
      repoRoot: snapshot?.repo?.root ?? null,
      branch: branch ?? snapshot?.branch ?? null,
      expectedHead: await this.options.git.headSha().catch(() => null),
      steps: [{ id: "main", label }],
    });
    try {
      const result = await task();
      const outcome = settle(result);
      this.options.operations.finish(record.id, {
        status: outcome.status,
        error: outcome.error ?? null,
        resultSha: outcome.resultSha ?? null,
        resultUrl: outcome.resultUrl ?? null,
        prNumber: outcome.prNumber ?? null,
        steps: [
          {
            id: "main",
            label,
            status: outcome.status === "success" ? "success" : "failed",
            detail: outcome.detail ?? outcome.error ?? null,
          },
        ],
      });
      return result;
    } catch (error) {
      const message = errorMessage(error);
      this.options.operations.finish(record.id, {
        status: "failed",
        error: message,
        steps: [{ id: "main", label, status: "failed", detail: message }],
      });
      throw error;
    }
  }

  private async pushWithRecord(target: GitPushInput) {
    const snapshot = this.options.git.getSnapshot();
    const record = this.options.operations.begin({
      type: "push",
      workspace: this.currentWorkspace(),
      repoRoot: snapshot?.repo?.root ?? null,
      branch: target.branch,
      expectedHead: await this.options.git.headSha(),
      steps: [{ id: "push", label: `推送到 ${target.remote}/${target.branch}` }],
    });
    const result = await this.options.git.push(target);
    this.options.operations.finish(record.id, {
      status: result.ok ? "success" : result.confirmed ? "failed" : "unconfirmed",
      error: result.ok ? null : result.message,
      steps: [{ id: "push", label: `推送到 ${target.remote}/${target.branch}`, status: result.ok ? "success" : "failed", detail: result.message || null }],
    });
    return result;
  }

  private async createPullRequestWithRecord(input: PrCreateInput) {
    const snapshot = this.options.git.getSnapshot();
    const scope = await this.options.pr.getScope(input.base, input.head).catch(() => null);
    const steps = input.pushFirst
      ? [{ id: "push", label: "推送来源分支" }, { id: "create", label: "创建 Pull Request" }]
      : [{ id: "create", label: "创建 Pull Request" }];
    const record = this.options.operations.begin({
      type: "pr-create",
      workspace: this.currentWorkspace(),
      repoRoot: snapshot?.repo?.root ?? null,
      branch: input.head,
      expectedHead: await this.options.git.headSha(),
      steps,
    });

    let pushed = false;
    if (input.pushFirst && !scope?.headPushed) {
      const target = scope?.pushTarget;
      if (!target) {
        const message = "没有可用的远程，无法推送来源分支";
        this.options.operations.finish(record.id, {
          status: "failed",
          error: message,
          steps: steps.map((step) => ({ ...step, status: step.id === "push" ? "failed" : "skipped", detail: step.id === "push" ? message : null })),
        });
        return { ok: false, step: "push" as const, pushed: false, pr: null, url: null, number: null, message, unconfirmed: false };
      }
      const push = await this.options.git.push({
        remote: target.remote,
        branch: target.branch,
        setUpstream: !snapshot?.upstream,
      });
      if (!push.ok) {
        this.options.operations.finish(record.id, {
          status: push.confirmed ? "failed" : "unconfirmed",
          error: push.message,
          steps: [
            { id: "push", label: "推送来源分支", status: "failed", detail: push.message },
            { id: "create", label: "创建 Pull Request", status: "skipped", detail: null },
          ],
        });
        return { ok: false, step: "push" as const, pushed: false, pr: null, url: null, number: null, message: push.message, unconfirmed: !push.confirmed };
      }
      pushed = true;
    }

    const result = await this.options.pr.create(input);
    this.options.operations.finish(record.id, {
      status: result.ok ? "success" : result.unconfirmed ? "unconfirmed" : "failed",
      resultUrl: result.url,
      prNumber: result.number,
      error: result.ok ? null : result.message,
      steps: steps.map((step) => ({
        ...step,
        status: step.id === "push" ? "success" : result.ok ? "success" : "failed",
        detail: step.id === "push" ? (pushed ? "已推送" : "无需推送") : result.message || null,
      })),
    });
    return { ...result, pushed: result.pushed || pushed };
  }

  /** 超时/取消后重新核对实际结果,而不是重放写操作。 */
  private async refreshOperationRecord(id: string): Promise<GitOperationRecord | null> {
    const record = this.options.operations.get(id);
    if (!record) return null;
    try {
      if (record.type === "push" || (record.type === "commit-push" && record.resultSha)) {
        const remote = record.steps.find((step) => step.id === "push")?.label.match(/推送到 ([^/]+)\//)?.[1] ?? null;
        const branch = record.branch;
        const head = await this.options.git.headSha();
        if (remote && branch && head) {
          const remoteSha = await this.options.git.remoteRefSha(remote, branch);
          if (remoteSha && remoteSha === head) {
            return this.options.operations.finish(record.id, { status: "success", error: null });
          }
        }
      }
      if (record.type === "commit" || record.type === "commit-push") {
        if (record.resultSha) {
          const exists = await this.options.git
            .commitDetail(record.resultSha)
            .then(() => true)
            .catch(() => false);
          if (exists) return this.options.operations.finish(record.id, { status: "success", error: null });
        }
      }
      if (record.type === "pr-create") {
        const info = await this.options.pr.getDetail();
        if (info.pr) {
          return this.options.operations.finish(record.id, {
            status: "success",
            resultUrl: info.pr.url,
            prNumber: info.pr.number,
            error: null,
          });
        }
      }
      if (record.type === "fetch" || record.type === "pull") {
        await this.options.git.refresh();
        return this.options.operations.finish(record.id, { status: "success", error: null });
      }
    } catch {
      // 核对失败时保持待确认状态,由用户再次核对。
    }
    return record;
  }

  /**
   * 让工作区选择跟随激活会话,保证输入区的工作区/环境/仓库卡片
   * 与会话目录(Context 面板)一致。会话目录不存在时保持原工作区。
   */
  async syncConversationWorkspace(cwd: string, hasWorkspace = true): Promise<void> {
    if (!hasWorkspace) {
      if (this.options.workspaceManager.getState().current !== null) await this.options.workspaceManager.close();
      return;
    }
    if (!cwd || cwd === this.options.workspaceManager.getState().current) return;
    if (!(await isDirectory(cwd))) return;
    try {
      await this.options.workspaceManager.select(cwd);
    } catch {
      // 目录不可访问等原因导致选择失败时,保持原工作区。
    }
  }

  dispose(): void {
    if (this.mutationTimer) {
      clearTimeout(this.mutationTimer);
      this.mutationTimer = null;
    }
  }

  /** 把文件路径转成附件:图片读取为 base64(限大小),其余仅带路径由 agent 自行读取。 */
  private async hydrateAttachments(paths: string[]): Promise<FileAttachmentPayload[]> {
    const results: FileAttachmentPayload[] = [];
    for (const path of paths.slice(0, maxAttachmentCount)) {
      const name = basename(path);
      const mimeType = imageMimeByExt[extname(path).toLowerCase()];
      if (mimeType) {
        try {
          const info = await stat(path);
          if (info.isFile() && info.size > 0 && info.size <= maxImageBytes) {
            const data = (await readFile(path)).toString("base64");
            results.push({
              path,
              name,
              kind: "image",
              image: { type: "image", data, mimeType },
            });
            continue;
          }
        } catch {
          // 读取失败时退化为普通文件附件。
        }
      }
      results.push({ path, name, kind: "file", image: null });
    }
    return results;
  }

  private async onWorkspaceChanged(workspace: WorkspaceState): Promise<void> {
    log.debug("workspace changed", { workspace: workspace.current });
    await this.options.env.setWorkspace(workspace.current);
    const environment = this.options.env.getActive();
    this.broadcast(IpcChannel.workspaceEvent, {
      type: "changed",
      workspace,
      environment,
    } satisfies WorkspaceEvent);
    await this.options.git.attach(workspace.current);
    const cwd = workspace.current ?? this.options.fallbackCwd;
    const hasWorkspace = workspace.current !== null;
    const active = this.options.runtime.listConversations().find(conversation => conversation.id === this.options.runtime.activeConversationId);
    // 工作区事件也可能来自切换会话后的同步，保留用户已经选中的会话。
    if (active?.cwd !== cwd || active.hasWorkspace !== hasWorkspace) {
      await this.options.runtime.switchWorkspace(cwd, hasWorkspace);
    }
  }

  /** 文件预览的路径边界与解析根:仓库根优先,相对路径先按工作区解析。 */
  private workspaceRoots(): WorkspaceRoots {
    const repoRoot = this.options.git.getSnapshot()?.repo?.root ?? null;
    const workspaceRoot = this.options.workspaceManager.getState().current;
    const baseRoot = repoRoot ?? workspaceRoot ?? this.options.fallbackCwd;
    const preferRoots = [...new Set([workspaceRoot, repoRoot, baseRoot].filter((root): root is string => Boolean(root)))];
    return { baseRoot, preferRoots };
  }

  private broadcast(channel: string, payload: unknown): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
      win.webContents.send(channel, payload);
    }
  }
}

function parsePath(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 1024) {
    throw new Error(`${label}不正确`);
  }
  return value.trim();
}

function parseId(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f-]{8,64}$/i.test(value)) {
    throw new Error(`${label}不正确`);
  }
  return value;
}

function parseBranchName(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().startsWith("-") || value.trim().length > 200) {
    throw new Error("分支名不正确");
  }
  return value.trim();
}

function parseRelativePath(value: unknown): string {
  const path = parsePath(value, "文件路径");
  if (isAbsolute(path) || path.split("/").includes("..")) throw new Error("文件路径不正确");
  return path;
}

function parseAbsolutePath(value: unknown): string {
  const path = parsePath(value, "文件路径");
  if (!isAbsolute(path)) throw new Error("需要绝对路径");
  return path;
}

/** 文件预览允许相对或绝对路径,真正的边界校验在 WorkspaceFileService 里做。 */
function parseFlexiblePath(value: unknown): string {
  const path = parsePath(value, "文件路径");
  if (path.includes("\0")) throw new Error("文件路径不正确");
  return path;
}

function parsePathList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 500) {
    throw new Error("文件列表不正确");
  }
  return value.map((entry) => parseRelativePath(entry));
}

function parseUrl(value: unknown): string {
  const url = parsePath(value, "链接");
  if (!/^https:\/\/github\.com\//.test(url)) throw new Error("链接不正确");
  return url;
}

function parseChangeScope(value: unknown): GitChangeScope {
  return value === "index" ? "index" : "worktree";
}

function parseTrackingOptions(value: unknown): { createTracking?: boolean } {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  return record.createTracking === true ? { createTracking: true } : {};
}

function parseOptionalBranchName(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  return parseBranchName(value);
}

function parseOptionalRemote(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const remote = parsePath(value, "远程名称");
  if (remote.startsWith("-") || remote.length > 200 || /\s/.test(remote)) throw new Error("远程名称不正确");
  return remote;
}

function parseIdentityName(value: unknown): string {
  const name = parsePath(value, "姓名");
  if (name.length > 200 || /[\r\n\0]/.test(name)) throw new Error("姓名不正确");
  return name;
}

function parseIdentityEmail(value: unknown): string {
  const email = parsePath(value, "邮箱");
  if (email.length > 320 || !email.includes("@") || /[\r\n\0\s]/.test(email)) throw new Error("邮箱不正确");
  return email;
}

function parseCommitInput(value: unknown): GitCommitInput {
  if (!value || typeof value !== "object") throw new Error("提交内容不正确");
  const record = value as Record<string, unknown>;
  if (typeof record.title !== "string") throw new Error("提交标题不正确");
  const title = record.title.trim();
  if (!title || title.length > 300) throw new Error("提交标题不正确");
  if (typeof record.body !== "string" || record.body.length > 20_000) throw new Error("提交正文不正确");
  let stagePaths: string[] | null = null;
  if (record.stagePaths !== null && record.stagePaths !== undefined) {
    stagePaths = parsePathList(record.stagePaths);
  }
  return { title, body: record.body, stagePaths };
}

function parsePushInput(value: unknown): GitPushInput {
  if (!value || typeof value !== "object") throw new Error("推送目标不正确");
  const record = value as Record<string, unknown>;
  const remote = parseOptionalRemote(record.remote);
  if (!remote) throw new Error("推送远程不正确");
  const branch = parseBranchName(record.branch);
  return { remote, branch, setUpstream: record.setUpstream === true };
}

function parseGraphQuery(value: unknown): GitGraphQuery {
  if (!value || typeof value !== "object") throw new Error("历史查询不正确");
  const record = value as Record<string, unknown>;
  return {
    scope: parseGraphScope(record.scope),
    limit: parseLimit(record.limit),
    skip: Math.max(0, Math.min(100_000, typeof record.skip === "number" && Number.isFinite(record.skip) ? Math.floor(record.skip) : 0)),
    snapshotId: typeof record.snapshotId === "string" && record.snapshotId.length <= 100 ? record.snapshotId : null,
  };
}

function parseGraphScope(value: unknown): "current" | "all-local" {
  return value === "all-local" ? "all-local" : "current";
}

function parseLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 100;
  return Math.max(1, Math.min(500, Math.floor(value)));
}

function parseSha(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{4,40}$/i.test(value)) throw new Error("提交 SHA 不正确");
  return value;
}

function parseOptionalSha(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  return parseSha(value);
}

function parseSearchQuery(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 500) throw new Error("搜索内容不正确");
  return value.trim();
}

function parseDiscardOptions(value: unknown): { untracked?: boolean } {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  return record.untracked === true ? { untracked: true } : {};
}

function parseDiffOptions(value: unknown): GitDiffOptions {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  return record.ignoreWhitespace === true ? { ignoreWhitespace: true } : {};
}

function parseHunkApplyInput(value: unknown): GitHunkApplyInput {
  if (!value || typeof value !== "object") throw new Error("代码块内容不正确");
  const record = value as Record<string, unknown>;
  const action = record.action;
  if (action !== "stage" && action !== "unstage" && action !== "discard") {
    throw new Error("代码块操作不正确");
  }
  if (typeof record.patch !== "string" || record.patch.length === 0) {
    throw new Error("代码块补丁不正确");
  }
  return {
    path: parseRelativePath(record.path),
    action,
    patch: record.patch,
  };
}

function parseUndoCommitInput(value: unknown): GitUndoCommitInput {
  if (!value || typeof value !== "object") throw new Error("撤销参数不正确");
  const record = value as Record<string, unknown>;
  if (record.mode !== "keep-index" && record.mode !== "keep-worktree") {
    throw new Error("请选择改动保留位置");
  }
  return { mode: record.mode };
}

function parseBranchDeleteInput(value: unknown): GitBranchDeleteInput {
  if (!value || typeof value !== "object") throw new Error("删除分支参数不正确");
  const record = value as Record<string, unknown>;
  return {
    name: parseBranchName(record.name),
    force: record.force === true,
    remote: record.remote === null || record.remote === undefined || record.remote === "" ? null : parseRemoteName(record.remote),
  };
}

/** 分支名、标签或提交 SHA;拒绝选项注入与空白。 */
function parseRefInput(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 300) {
    throw new Error("比较目标不正确");
  }
  const ref = value.trim();
  if (ref.startsWith("-") || /[\s\u0000-\u001f\u007f]/.test(ref)) throw new Error("比较目标不正确");
  return ref;
}

function parseRemoteName(value: unknown): string {
  if (typeof value !== "string") throw new Error("远程名不正确");
  const name = value.trim();
  if (!name || name.startsWith("-") || name.length > 200 || /[\s\0]/.test(name)) {
    throw new Error("远程名不正确");
  }
  return name;
}

function parseRemoteUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("远程地址不正确");
  const url = value.trim();
  if (!url || url.startsWith("-") || url.length > 2000 || /[\s\0]/.test(url)) {
    throw new Error("远程地址不正确");
  }
  return url;
}

function parseRemoteInput(value: unknown): GitRemoteInput {
  if (!value || typeof value !== "object") throw new Error("远程配置不正确");
  const record = value as Record<string, unknown>;
  const pushUrl = record.pushUrl === null || record.pushUrl === undefined || record.pushUrl === ""
    ? null
    : parseRemoteUrl(record.pushUrl);
  return { name: parseRemoteName(record.name), url: parseRemoteUrl(record.url), pushUrl };
}

function parseUpstreamInput(value: unknown): GitUpstreamInput {
  if (!value || typeof value !== "object") throw new Error("跟踪关系不正确");
  const record = value as Record<string, unknown>;
  const upstream = record.upstream === null || record.upstream === undefined || record.upstream === ""
    ? null
    : parseRefInput(record.upstream);
  return { branch: parseBranchName(record.branch), upstream };
}

function parseConflictResolveInput(value: unknown): GitConflictResolveInput {
  if (!value || typeof value !== "object") throw new Error("解决内容不正确");
  const record = value as Record<string, unknown>;
  if (typeof record.content !== "string" || record.content.length > 5 * 1024 * 1024) {
    throw new Error("解决内容不正确");
  }
  return { path: parseRelativePath(record.path), content: record.content };
}

function parseStashId(value: unknown): string {
  if (typeof value !== "string" || !/^(stash@\{\d+\}|\d+)$/.test(value.trim())) {
    throw new Error("Stash 记录不正确");
  }
  return value.trim();
}

function parseStashCreateInput(value: unknown): GitStashCreateInput {
  if (!value || typeof value !== "object") throw new Error("Stash 内容不正确");
  const record = value as Record<string, unknown>;
  const message = typeof record.message === "string" ? record.message.slice(0, 200) : "";
  let paths: string[] | null = null;
  if (Array.isArray(record.paths) && record.paths.length > 0) {
    paths = record.paths.slice(0, 500).map((entry) => parseRelativePath(entry));
  }
  return { message, includeUntracked: record.includeUntracked === true, paths };
}

function parseStashApplyInput(value: unknown): GitStashApplyInput {
  if (!value || typeof value !== "object") throw new Error("Stash 参数不正确");
  const record = value as Record<string, unknown>;
  return {
    id: parseStashId(record.id),
    mode: record.mode === "pop" ? "pop" : "apply",
  };
}

function parseWorktreeCreateInput(value: unknown): GitWorktreeCreateInput {
  if (!value || typeof value !== "object") throw new Error("worktree 参数不正确");
  const record = value as Record<string, unknown>;
  const startPoint = record.startPoint === null || record.startPoint === undefined || record.startPoint === ""
    ? null
    : parseRefInput(record.startPoint);
  let path: string | null = null;
  if (typeof record.path === "string" && record.path.trim()) {
    const candidate = record.path.trim();
    if (!isAbsolute(candidate) || candidate.includes("\0")) throw new Error("worktree 路径需要绝对路径");
    path = candidate;
  }
  return {
    branch: parseBranchName(record.branch),
    newBranch: record.newBranch === true,
    startPoint,
    path,
  };
}

function parseWorktreeRemoveInput(value: unknown): GitWorktreeRemoveInput {
  if (!value || typeof value !== "object") throw new Error("worktree 路径不正确");
  const record = value as Record<string, unknown>;
  const path = parsePath(record.path, "worktree 路径");
  if (!isAbsolute(path) || path.includes("\0")) throw new Error("worktree 路径不正确");
  return { path, force: record.force === true };
}

function parseOperationQuery(value: unknown): GitOperationQuery | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const text = typeof record.text === "string" && record.text.trim() ? record.text.trim().slice(0, 200) : null;
  const types = Array.isArray(record.types)
    ? (record.types.filter((entry): entry is GitOperationType => typeof entry === "string") as GitOperationType[])
    : null;
  const statuses = Array.isArray(record.statuses)
    ? (record.statuses.filter((entry): entry is GitOperationStatus => typeof entry === "string") as GitOperationStatus[])
    : null;
  const since = typeof record.since === "number" && Number.isFinite(record.since) ? record.since : null;
  const until = typeof record.until === "number" && Number.isFinite(record.until) ? record.until : null;
  const limit = typeof record.limit === "number" && Number.isFinite(record.limit) ? record.limit : null;
  if (!text && !types?.length && !statuses?.length && since === null && until === null && limit === null) {
    return null;
  }
  return { text, types, statuses, since, until, limit };
}

function parsePrNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > 100_000_000) {
    throw new Error("PR 编号不正确");
  }
  return value;
}

function parseOptionalPrNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return parsePrNumber(value);
}

// ---------- P2 输入校验 ----------

function parsePullInput(value: unknown): GitPullInput {
  if (!value || typeof value !== "object") throw new Error("同步策略不正确");
  const record = value as Record<string, unknown>;
  const strategy: GitPullStrategy =
    record.strategy === "merge" ? "merge" : record.strategy === "rebase" ? "rebase" : "ff-only";
  return { strategy };
}

function parseForcePushInput(value: unknown): GitForcePushInput {
  if (!value || typeof value !== "object") throw new Error("强推目标不正确");
  const record = value as Record<string, unknown>;
  const expectedRemoteSha = parseSha(record.expectedRemoteSha);
  return {
    remote: parseRemoteName(record.remote),
    branch: parseBranchName(record.branch),
    expectedRemoteSha,
  };
}

function parseHistoryOpInput(value: unknown): GitHistoryOpInput {
  if (!value || typeof value !== "object") throw new Error("历史操作参数不正确");
  const record = value as Record<string, unknown>;
  const action: GitHistoryAction = record.action === "revert" ? "revert" : "cherry-pick";
  const mainline =
    typeof record.mainline === "number" && Number.isInteger(record.mainline) && record.mainline > 0
      ? record.mainline
      : null;
  return { action, sha: parseSha(record.sha), mainline };
}

function parseRewriteInput(value: unknown): GitRewritePreviewInput {
  if (!value || typeof value !== "object") throw new Error("提交整理参数不正确");
  const record = value as Record<string, unknown>;
  const action: GitRewriteAction = record.action === "squash" ? "squash" : "fixup";
  const message = typeof record.message === "string" ? record.message.slice(0, 20_000) : null;
  return {
    action,
    sourceSha: parseSha(record.sourceSha),
    targetSha: parseSha(record.targetSha),
    message,
  };
}

function parseReflogQuery(value: unknown): GitReflogQuery | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const text = typeof record.text === "string" && record.text.trim() ? record.text.trim().slice(0, 200) : null;
  const limit = typeof record.limit === "number" && Number.isFinite(record.limit) ? record.limit : null;
  if (!text && limit === null) return null;
  return { text, limit };
}

function parseRecoveryInput(value: unknown): GitRecoveryPreviewInput {
  if (!value || typeof value !== "object") throw new Error("恢复参数不正确");
  const record = value as Record<string, unknown>;
  const mode: GitRecoveryMode =
    record.mode === "reset-soft" ? "reset-soft" : record.mode === "reset-mixed" ? "reset-mixed" : "branch";
  const branchName = typeof record.branchName === "string" && record.branchName.trim()
    ? parseBranchName(record.branchName)
    : null;
  return { target: parsePath(record.target, "恢复目标").slice(0, 300), mode, branchName };
}

function parseBranchAtInput(value: unknown): GitBranchAtInput {
  if (!value || typeof value !== "object") throw new Error("创建分支参数不正确");
  const record = value as Record<string, unknown>;
  return {
    name: parseBranchName(record.name),
    startPoint: parseSha(record.startPoint),
    checkout: record.checkout === true,
  };
}

function parseTagCreateInput(value: unknown): GitTagCreateInput {
  if (!value || typeof value !== "object") throw new Error("标签参数不正确");
  const record = value as Record<string, unknown>;
  const message = typeof record.message === "string" ? record.message.slice(0, 20_000) : null;
  return {
    name: parsePath(record.name, "标签名").slice(0, 200),
    target: parseOptionalSha(record.target),
    message,
    push: record.push === true,
    remote: parseOptionalRemote(record.remote),
  };
}

function parseReleaseCreateInput(value: unknown): GitReleaseCreateInput {
  if (!value || typeof value !== "object") throw new Error("发布参数不正确");
  const record = value as Record<string, unknown>;
  const name = typeof record.name === "string" && record.name.trim() ? record.name.trim().slice(0, 300) : null;
  return {
    tagName: parsePath(record.tagName, "标签名").slice(0, 200),
    name,
    body: typeof record.body === "string" ? record.body.slice(0, 100_000) : "",
    draft: record.draft === true,
    prerelease: record.prerelease === true,
    target: parseOptionalSha(record.target),
  };
}

function parsePrCommentInput(value: unknown): PrCommentInput {
  if (!value || typeof value !== "object") throw new Error("评论内容不正确");
  const record = value as Record<string, unknown>;
  const body = typeof record.body === "string" ? record.body.trim() : "";
  if (!body) throw new Error("评论内容不能为空");
  return { number: parsePrNumber(record.number), body: body.slice(0, 100_000) };
}

function parsePrReviewInput(value: unknown): PrReviewInput {
  if (!value || typeof value !== "object") throw new Error("审阅参数不正确");
  const record = value as Record<string, unknown>;
  const event: PrReviewEvent =
    record.event === "approve" ? "approve" : record.event === "request-changes" ? "request-changes" : "comment";
  const body = typeof record.body === "string" && record.body.trim() ? record.body.slice(0, 100_000) : null;
  return {
    number: parsePrNumber(record.number),
    event,
    body,
    commitSha: parseOptionalSha(record.commitSha),
  };
}

function parseThreadResolveInput(value: unknown): PrThreadResolveInput {
  if (!value || typeof value !== "object") throw new Error("审阅线程参数不正确");
  const record = value as Record<string, unknown>;
  const threadId = parsePath(record.threadId, "线程 id").slice(0, 200);
  return { threadId, resolved: record.resolved !== false };
}

function parsePrMergeInput(value: unknown): PrMergeInput {
  if (!value || typeof value !== "object") throw new Error("合并参数不正确");
  const record = value as Record<string, unknown>;
  const method: PrMergeMethod =
    record.method === "squash" ? "squash" : record.method === "rebase" ? "rebase" : "merge";
  const subject = typeof record.subject === "string" && record.subject.trim() ? record.subject.slice(0, 300) : null;
  const body = typeof record.body === "string" && record.body.trim() ? record.body.slice(0, 100_000) : null;
  return {
    number: parsePrNumber(record.number),
    method,
    expectedHeadSha: parseSha(record.expectedHeadSha),
    deleteBranch: record.deleteBranch === true,
    subject,
    body,
  };
}

function parsePrCloseInput(value: unknown): PrCloseInput {
  if (!value || typeof value !== "object") throw new Error("关闭参数不正确");
  const record = value as Record<string, unknown>;
  const comment = typeof record.comment === "string" && record.comment.trim() ? record.comment.slice(0, 100_000) : null;
  return {
    number: parsePrNumber(record.number),
    comment,
    deleteBranch: record.deleteBranch === true,
  };
}

function parsePrUpdateInput(value: unknown): PrUpdateInput {
  if (!value || typeof value !== "object") throw new Error("PR 更新内容不正确");
  const record = value as Record<string, unknown>;
  const number = parsePrNumber(record.number);
  const title = typeof record.title === "string" ? record.title.slice(0, 300) : null;
  const body = typeof record.body === "string" ? record.body.slice(0, 100_000) : null;
  const names = (input: unknown): string[] => {
    if (!Array.isArray(input)) return [];
    return input
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0 && entry.length <= 200)
      .slice(0, 50);
  };
  return {
    number,
    title,
    body,
    addReviewers: names(record.addReviewers),
    removeReviewers: names(record.removeReviewers),
    addLabels: names(record.addLabels),
    removeLabels: names(record.removeLabels),
  };
}

function parsePrIssueLinkInput(value: unknown): PrIssueLinkInput {
  if (!value || typeof value !== "object") throw new Error("Issue 关联内容不正确");
  const record = value as Record<string, unknown>;
  const issues = Array.isArray(record.issues)
    ? record.issues
        .filter((entry): entry is number => typeof entry === "number" && Number.isInteger(entry) && entry > 0)
        .slice(0, 50)
    : [];
  if (issues.length === 0) throw new Error("请提供要关联的 Issue 编号");
  return {
    number: parsePrNumber(record.number),
    issues,
    mode: record.mode === "close" ? "close" : "reference",
  };
}

function parsePrCreateInput(value: unknown): PrCreateInput {
  if (!value || typeof value !== "object") throw new Error("PR 内容不正确");
  const record = value as Record<string, unknown>;
  const stringField = (key: string, max: number, label: string): string => {
    const entry = record[key];
    if (typeof entry !== "string" || entry.length > max) throw new Error(`${label}不正确`);
    return entry.trim();
  };
  const base = parseBranchName(record.base);
  const head = parseBranchName(record.head);
  const title = stringField("title", 300, "PR 标题");
  if (!title) throw new Error("PR 标题不正确");
  const body = typeof record.body === "string" && record.body.length <= 100_000 ? record.body : "";
  const baseRepo = stringField("baseRepo", 200, "目标仓库");
  const headRepo = stringField("headRepo", 200, "来源仓库");
  const templatePath = record.templatePath === null || record.templatePath === undefined
    ? null
    : stringField("templatePath", 500, "模板路径");
  return {
    baseRepo,
    base,
    headRepo,
    head,
    title,
    body,
    draft: record.draft === true,
    pushFirst: record.pushFirst === true,
    templatePath,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "操作失败";
}

function parseSandboxMode(value: unknown): SandboxMode {
  if (value === "ask" || value === "smart" || value === "full") return value;
  throw new Error("权限模式不正确");
}

function parseEnvironmentKind(value: unknown): SelectableEnvironmentKind {
  if (value === "local" || value === "worktree") return value;
  throw new Error("不支持这个执行环境");
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
