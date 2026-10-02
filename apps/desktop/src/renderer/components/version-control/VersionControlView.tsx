import { useEffect, useMemo, useState } from "react";
import type { GitCommitSummary, SessionSnapshot } from "@vela/shared";
import { tr, useAppLocale } from "../../locale";
import type { ProjectApi } from "../../hooks/useProject";
import { useVersionControl } from "../../hooks/useVersionControl";
import { useDismissable } from "../../hooks/useDismissable";
import { useSlidingTabIndicator } from "../useSlidingTabIndicator";
import { AlertIcon, ArrowDownIcon, ArrowUpIcon, BranchIcon, ChevronDownIcon, CloudIcon, FolderIcon, MonitorIcon, PrIcon, RefreshIcon, StackIcon, TagIcon } from "../icons";
import { BranchMenu } from "./BranchMenu";
import { BranchPanel } from "./BranchPanel";
import { ChangesPage } from "./ChangesPage";
import { splitUpstream } from "./CommitComposer";
import { CompareDialog } from "./CompareDialog";
import { HistoryOpsPanel } from "./HistoryOpsPanel";
import { HistoryPage } from "./HistoryPage";
import { OperationLogPanel } from "./OperationLogPanel";
import { PullRequestPage } from "./PullRequestPage";
import { PushDialog } from "./PushDialog";
import { ReflogPanel } from "./ReflogPanel";
import { RemotePanel } from "./RemotePanel";
import { StashPanel } from "./StashPanel";
import { SyncDialog } from "./SyncDialog";
import { TagReleasePanel } from "./TagReleasePanel";
import { WorktreePanel } from "./WorktreePanel";
import { formatRelativeTime } from "./time-format";

type VersionControlPage = "changes" | "history" | "pr";

/** 版本控制页:改动 / 历史 / Pull Request,共享当前工作区的实时 Git 状态。 */
export function VersionControlView({
  project,
  session,
  hidden,
  pendingInteraction,
  onOpenConversation,
  onAbort,
  onOpenFile,
}: {
  project: ProjectApi;
  session: SessionSnapshot | null;
  hidden: boolean;
  pendingInteraction: boolean;
  onOpenConversation(): void;
  onAbort(): void;
  onOpenFile(absolutePath: string): void;
}) {
  const locale = useAppLocale();
  const agentStreaming = session?.status === "streaming";
  const api = useVersionControl(project, agentStreaming);
  const status = project.git;
  const [page, setPage] = useState<VersionControlPage>("changes");
  const [publishOpen, setPublishOpen] = useState(false);
  const [opsOpen, setOpsOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [branchesOpen, setBranchesOpen] = useState(false);
  const [remotesOpen, setRemotesOpen] = useState(false);
  const [stashOpen, setStashOpen] = useState(false);
  const [worktreesOpen, setWorktreesOpen] = useState(false);
  const [compare, setCompare] = useState<{ base: string; head: string } | null>(null);
  const [syncMode, setSyncMode] = useState<"pull" | "force-push" | null>(null);
  const [tagsOpen, setTagsOpen] = useState(false);
  const [reflogOpen, setReflogOpen] = useState(false);
  const [historyCommit, setHistoryCommit] = useState<GitCommitSummary | null>(null);
  const statusRef = useDismissable<HTMLDivElement>(statusOpen, () => setStatusOpen(false));

  const workspace = project.workspace?.current ?? null;
  const repo = status?.repo ?? null;

  const branch = status?.branch ?? null;
  const upstream = status?.upstream ?? null;
  const remotes = useMemo(() => status?.remotes.map((remote) => remote.name) ?? [], [status?.remotes]);
  const prSummary = api.pr?.pr ?? null;

  const changeCount = status?.files.length ?? 0;
  const pageTabs = useSlidingTabIndicator({ activeKey: page });

  // 工作区切换后重新加载历史/PR,避免展示上一工作区的旧结果。
  useEffect(() => {
    setOpsOpen(false);
    setStatusOpen(false);
    setBranchesOpen(false);
    setRemotesOpen(false);
    setStashOpen(false);
    setWorktreesOpen(false);
    setCompare(null);
    setSyncMode(null);
    setTagsOpen(false);
    setReflogOpen(false);
    setHistoryCommit(null);
  }, [workspace]);

  if (!workspace) {
    return (
      <div className="vc-empty" hidden={hidden}>
        <FolderIcon size={22} />
        <h2>{tr("还没有选择工作区", "No workspace selected")}</h2>
        <p>{tr("选择工作区后可以审阅改动、提交、推送并创建 Pull Request。", "Choose a workspace to review changes, commit, push and create pull requests.")}</p>
        <button type="button" className="vc-btn vc-btn-primary" onClick={() => void project.openWorkspaceDialog()}>
          {tr("选择工作区", "Choose workspace")}
        </button>
      </div>
    );
  }

  if (!status || !repo) {
    return (
      <div className="vc-empty" hidden={hidden}>
        <FolderIcon size={22} />
        <h2>{tr("当前目录不是 Git 仓库", "This folder is not a Git repository")}</h2>
        <p>{tr("本地 Git 功能需要仓库支持；首期不提供初始化或克隆。若 Git 未安装，请先安装并配置。", "Version control needs a Git repository. Initializing or cloning is not part of this release. If Git is missing, install and configure it first.")}</p>
        <div className="vc-empty-path">{workspace}</div>
      </div>
    );
  }

  const onPush = () => {
    if (!branch) return;
    if (upstream) {
      const target = splitUpstream(upstream, remotes);
      if (target) {
        void api.push(target);
        return;
      }
    }
    setPublishOpen(true);
  };

  return (
    <div className="vc-root" hidden={hidden}>
      <section className="vc-repo-bar" aria-label={tr("仓库状态与操作", "Repository status and actions")}>
        <div className="vc-repo-info">
          <div className="vc-repo-title">
            <FolderIcon size={14} />
            <b>{repo.name}</b>
            <span className="vc-badge vc-badge-muted">{tr("Git 仓库", "Git repository")}</span>
            {repo.subdir ? <span className="vc-badge vc-badge-muted">{tr(`子目录 · ${repo.subdir}`, `subdir · ${repo.subdir}`)}</span> : null}
          </div>
          <div className="vc-repo-path" title={repo.root}>{repo.root}</div>
        </div>
        <div className="vc-controls">
          <BranchMenu
            branches={project.branches}
            current={branch}
            disabled={api.busy !== null || api.guard?.agentRunning === true}
            onSwitch={(name) => void project.switchBranch(name)}
            onCreate={(name) => void project.createBranch(name)}
          />
          <button type="button" className="vc-btn" disabled={api.busy !== null} onClick={() => void api.fetch(null)}>
            <RefreshIcon size={12} /> {api.busy === "fetch" ? tr("Fetch 中…", "Fetching…") : tr("Fetch", "Fetch")}
          </button>
          <button type="button" className="vc-btn" disabled={api.busy !== null || !upstream || api.guard?.agentRunning === true} title={upstream ? undefined : tr("没有 upstream，先发布分支", "No upstream; publish the branch first")} onClick={() => void api.pull()}>
            {api.busy === "pull" ? tr("Pull 中…", "Pulling…") : tr("Pull", "Pull")}
          </button>
          <button type="button" className="vc-btn" disabled={api.busy !== null || !branch} onClick={onPush}>
            <CloudIcon size={12} />
            {upstream ? tr("Push", "Push") : tr("发布分支", "Publish branch")}
            {status.ahead > 0 ? <b className="vc-ahead">↑{status.ahead}</b> : null}
          </button>
          <button type="button" className={`vc-btn${page === "pr" ? " active" : ""}`} onClick={() => setPage("pr")}>
            <PrIcon size={12} />
            {prSummary ? `#${prSummary.number}` : tr("Pull Request", "Pull request")}
          </button>
          <button type="button" className={`vc-btn${branchesOpen ? " active" : ""}`} aria-expanded={branchesOpen} onClick={() => setBranchesOpen((value) => !value)}>
            <BranchIcon size={12} /> {tr("分支", "Branches")}
          </button>
          <button type="button" className={`vc-btn${remotesOpen ? " active" : ""}`} aria-expanded={remotesOpen} onClick={() => setRemotesOpen((value) => !value)}>
            <CloudIcon size={12} /> {tr("远程", "Remotes")}
          </button>
          <button type="button" className={`vc-btn${stashOpen ? " active" : ""}`} aria-expanded={stashOpen} onClick={() => setStashOpen((value) => !value)}>
            <StackIcon size={12} /> {tr("Stash", "Stash")}
          </button>
          <button type="button" className={`vc-btn${worktreesOpen ? " active" : ""}`} aria-expanded={worktreesOpen} onClick={() => setWorktreesOpen((value) => !value)}>
            <MonitorIcon size={12} /> {tr("Worktree", "Worktree")}
          </button>
          <button
            type="button"
            className={`vc-btn${syncMode === "pull" ? " active" : ""}`}
            title={tr("选择 Merge 或 Rebase 同步策略；默认仍为仅快进", "Choose a merge or rebase sync strategy; fast-forward stays the default")}
            onClick={() => setSyncMode((value) => (value === "pull" ? null : "pull"))}
          >
            <ArrowDownIcon size={12} /> {tr("同步策略", "Sync strategy")}
          </button>
          {branch && !status.detached && status.ahead > 0 ? (
            <button
              type="button"
              className={`vc-btn${syncMode === "force-push" ? " active" : ""}`}
              title={tr("用 --force-with-lease 覆盖远程分支，需要先核对影响范围", "Overwrite the remote branch with --force-with-lease after checking the scope")}
              onClick={() => setSyncMode((value) => (value === "force-push" ? null : "force-push"))}
            >
              <ArrowUpIcon size={12} /> {tr("安全强推", "Force push")}
            </button>
          ) : null}
          <button
            type="button"
            className={`vc-btn${tagsOpen ? " active" : ""}`}
            aria-expanded={tagsOpen}
            title={tr("标签、Release 与发布说明", "Tags, releases and release notes")}
            onClick={() => setTagsOpen((value) => !value)}
          >
            <TagIcon size={12} /> {tr("标签 / 发布", "Tags / releases")}
          </button>
          <button type="button" className="vc-btn vc-btn-ghost" onClick={() => setOpsOpen((value) => !value)}>
            {tr("操作记录", "Operations")}
          </button>
          <div className="vc-sync" ref={statusRef}>
            <button type="button" className="vc-sync-summary" onClick={() => setStatusOpen((value) => !value)} aria-expanded={statusOpen}>
              {upstream ? (
                <>
                  <span className="vc-ahead">↑ {status.ahead} {tr("待推送", "to push")}</span>
                  <span className="vc-behind">↓ {status.behind} {tr("待拉取", "to pull")}</span>
                </>
              ) : (
                <span>{tr("尚未发布分支", "Branch not published")}</span>
              )}
              <span>{status.lastFetchAt ? tr(`Fetch ${formatRelativeTime(status.lastFetchAt, locale)}`, `Fetched ${formatRelativeTime(status.lastFetchAt, locale)}`) : tr("尚未 Fetch", "Never fetched")}</span>
              <ChevronDownIcon size={10} />
            </button>
            {statusOpen ? (
              <div className="vc-popover vc-status-popover">
                <div className="vc-status-row">
                  <span>{tr("上游", "Upstream")}</span>
                  <b>{upstream ?? tr("无", "None")}</b>
                </div>
                <div className="vc-status-row">
                  <span>{tr("作者身份", "Author identity")}</span>
                  <b>{status.identity.configured ? `${status.identity.name} <${status.identity.email}>` : tr("未配置", "Not configured")}</b>
                </div>
                <div className="vc-status-row">
                  <span>{tr("远程", "Remotes")}</span>
                  <b>{remotes.length > 0 ? remotes.join(", ") : tr("无", "None")}</b>
                </div>
                <div className="vc-status-row">
                  <span>{tr("GitHub CLI", "GitHub CLI")}</span>
                  <b>
                    {api.pr
                      ? api.pr.ghAvailable
                        ? tr("可用", "Available")
                        : tr("不可用", "Unavailable")
                      : tr("未检查", "Not checked")}
                  </b>
                </div>
                {status.operation ? (
                  <div className="vc-status-row vc-status-warn">
                    <AlertIcon size={12} />
                    <span>{tr(`进行中的操作：${status.operation.kind}`, `Operation in progress: ${status.operation.kind}`)}</span>
                  </div>
                ) : null}
                <div className="vc-status-row">
                  <span>{tr("仓库范围", "Repository scope")}</span>
                  <b>{tr("文件读写使用仓库根语义", "File operations use the repository root")}</b>
                </div>
              </div>
            ) : null}
          </div>
        </div>
        <div className="vc-panel-host">
        <BranchPanel
          open={branchesOpen}
          onClose={() => setBranchesOpen(false)}
          branches={project.branches}
          current={branch}
          api={api}
          locale={locale}
          onSwitch={(name) => void project.switchBranch(name)}
          onCompare={(base, head) => setCompare({ base, head })}
        />

        <RemotePanel
          open={remotesOpen}
          onClose={() => setRemotesOpen(false)}
          remotes={status.remotes}
          onAdd={api.addRemote}
          onSetUrl={api.setRemoteUrl}
          onRemove={api.removeRemote}
          onRename={api.renameRemote}
          locale={locale}
        />

        <StashPanel open={stashOpen} onClose={() => setStashOpen(false)} api={api} locale={locale} />

        <SyncDialog
          open={syncMode !== null}
          mode={syncMode ?? "pull"}
          onClose={() => setSyncMode(null)}
          api={api}
          status={status}
          locale={locale}
        />

        <TagReleasePanel
          open={tagsOpen}
          onClose={() => setTagsOpen(false)}
          api={api}
          status={status}
          defaultBase={api.tags.find((tag) => !tag.name.includes("-"))?.name ?? null}
          onChanged={() => {
            void project.refreshBranches();
            api.refreshGraph();
          }}
          locale={locale}
        />

        <ReflogPanel open={reflogOpen} onClose={() => setReflogOpen(false)} api={api} locale={locale} />

        <HistoryOpsPanel
          open={historyCommit !== null}
          onClose={() => setHistoryCommit(null)}
          api={api}
          commit={historyCommit}
          commits={api.graph?.commits ?? []}
          branch={branch}
          locale={locale}
          onOpenConflict={() => {
            setHistoryCommit(null);
            setPage("changes");
          }}
          onChanged={() => {
            api.refreshGraph();
            void project.refreshBranches();
          }}
        />

        <WorktreePanel
          open={worktreesOpen}
          onClose={() => setWorktreesOpen(false)}
          api={api}
          workspace={workspace}
          locale={locale}
          onSwitch={(path) => {
            setWorktreesOpen(false);
            void project.selectRecentWorkspace(path);
          }}
        />

        </div>

      </section>

      {agentStreaming || pendingInteraction ? (
        <div className="vc-run-banner" role="status">
          <span className="vc-spinner" aria-hidden="true" />
          <span>
            {agentStreaming
              ? tr("Agent 正在执行；暂存、丢弃、提交等改动操作暂时受限，仍可查看和生成文案。", "The agent is running; staging, discarding and committing are paused while viewing and AI text stay available.")
              : tr("有审批或问题待回答，请回到对话处理。", "An approval or question is waiting; return to the chat.")}
          </span>
          {agentStreaming ? <button type="button" className="vc-link" onClick={onAbort}>{tr("停止", "Stop")}</button> : null}
          <button type="button" className="vc-link" onClick={onOpenConversation}>{tr("返回对话", "Back to chat")}</button>
        </div>
      ) : null}

      {api.error ? (
        <div className="vc-error-banner" role="alert">
          <AlertIcon size={13} />
          <span>{api.error}</span>
          <button type="button" className="vc-link" onClick={api.clearError}>{tr("关闭", "Dismiss")}</button>
        </div>
      ) : null}
      {api.notice ? (
        <div className="vc-notice-banner" role="status">
          <span>{api.notice}</span>
          <button type="button" className="vc-link" onClick={api.clearNotice}>{tr("关闭", "Dismiss")}</button>
        </div>
      ) : null}

      <div className="vc-page-tabs">
        <nav className="vc-subtabs" role="tablist" aria-label={tr("版本控制页面", "Version control pages")}
          ref={pageTabs.navRef} onPointerMove={pageTabs.onPointerMove} onPointerLeave={pageTabs.onPointerLeave}>
          <button role="tab" data-tab-key="changes" ref={pageTabs.registerTab("changes")} aria-selected={page === "changes"} className={page === "changes" ? "active" : ""} onClick={() => setPage("changes")}>
            {tr("改动", "Changes")} {changeCount > 0 ? <span className="vc-pill">{changeCount}</span> : null}
          </button>
          <button role="tab" data-tab-key="history" ref={pageTabs.registerTab("history")} aria-selected={page === "history"} className={page === "history" ? "active" : ""} onClick={() => setPage("history")}>
            {tr("历史", "History")}
          </button>
          <button role="tab" data-tab-key="pr" ref={pageTabs.registerTab("pr")} aria-selected={page === "pr"} className={page === "pr" ? "active" : ""} onClick={() => setPage("pr")}>
            {tr("Pull Request", "Pull request")}
          </button>
          {pageTabs.indicator}
        </nav>
        <div className="vc-scope-note">
          {status.detached
            ? tr("Detached HEAD · 请创建或切换分支", "Detached HEAD · create or switch to a branch")
            : tr(`工作区 ${branch ?? ""}`, `Workspace ${branch ?? ""}`)}
        </div>
      </div>

      <div className="vc-host">
        {page === "changes" ? (
          <ChangesPage
            project={project}
            api={api}
            status={status}
            goal={session?.goal ?? null}
            locale={locale}
            workspace={workspace}
            onOpenHistory={() => setPage("history")}
            onOpenFile={onOpenFile}
          />
        ) : null}
        {page === "history" ? (
          <HistoryPage
            api={api}
            repoRoot={repo.root}
            upstream={upstream}
            onOpenFile={onOpenFile}
            onCompare={(base, head) => setCompare({ base, head })}
            onOpenHistoryOps={(commit) => setHistoryCommit(commit)}
            onOpenReflog={() => setReflogOpen(true)}
            locale={locale}
          />
        ) : null}
        {page === "pr" ? (
          <PullRequestPage
            api={api}
            status={status}
            goal={session?.goal ?? null}
            locale={locale}
            workspace={workspace}
            onOpenConversation={onOpenConversation}
          />
        ) : null}
      </div>

      {page === "changes" && changeCount === 0 && status.ahead > 0 && !status.detached ? (
        <div className="vc-push-hint" role="status">
          <BranchIcon size={12} />
          <span>{tr(`有 ${status.ahead} 个提交待推送。`, `${status.ahead} commits are waiting to be pushed.`)}</span>
          <button type="button" className="vc-link" onClick={onPush}>{tr("仅推送", "Push only")}</button>
        </div>
      ) : null}

      <PushDialog
        open={publishOpen}
        remotes={remotes}
        defaultBranch={branch ?? ""}
        title={tr("发布分支", "Publish branch")}
        confirmLabel={tr("发布", "Publish")}
        onClose={() => setPublishOpen(false)}
        onConfirm={(target) => {
          setPublishOpen(false);
          void api.push(target);
        }}
      />

      <OperationLogPanel
        open={opsOpen}
        onClose={() => setOpsOpen(false)}
        operations={api.operations}
        onRefreshOperation={(id) => void api.refreshOperation(id)}
        onRefresh={api.refreshOperations}
        onSearch={api.searchOperations}
        onOpenCommit={(sha) => {
          setPage("history");
          setOpsOpen(false);
          api.selectCommit(sha);
        }}
        onOpenPullRequest={() => {
          setPage("pr");
          setOpsOpen(false);
        }}
        locale={locale}
      />

      <CompareDialog
        open={compare !== null}
        onClose={() => setCompare(null)}
        api={api}
        branches={project.branches}
        recentCommits={api.graph?.commits ?? []}
        initialBase={compare?.base ?? ""}
        initialHead={compare?.head ?? branch ?? ""}
        locale={locale}
      />
    </div>
  );
}
