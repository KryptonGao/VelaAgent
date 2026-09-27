import { useState } from "react";
import type { ProjectApi } from "../hooks/useProject";
import { useDismissable } from "../hooks/useDismissable";
import { fileManagerName } from "../platform";
import { formatCount, BranchPickerContent } from "./composer/BranchChip";
import {
  BranchIcon,
  FolderIcon,
  GithubIcon,
  GridIcon,
  MoreIcon,
  PrIcon,
} from "./icons";
import type { PrSummary } from "@vela/shared";
import { localizeError, tr } from "../locale";

const prStateLabels: Record<PrSummary["state"], string> = {
  open: "Open",
  draft: "Draft",
  closed: "Closed",
  merged: "Merged",
};

const checksLabels: Record<PrSummary["checks"], string> = {
  passing: "Checks passing",
  failing: "Checks failing",
  pending: "Checks pending",
  none: "No checks",
};

export function RepoCard({
  project,
  onOpenChanges,
  activeChanges,
}: {
  project: ProjectApi;
  onOpenChanges: () => void;
  activeChanges: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [branchOpen, setBranchOpen] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const menuRef = useDismissable<HTMLDivElement>(menuOpen, () => setMenuOpen(false));
  const branchRef = useDismissable<HTMLDivElement>(branchOpen, () => setBranchOpen(false));

  const git = project.git;
  const repo = git?.repo ?? null;
  const currentWorkspace = project.workspace?.current ?? null;
  const recents = project.workspace?.recents ?? [];
  const name = repo?.name ?? currentWorkspace?.split("/").filter(Boolean).pop() ?? tr("工作区", "Workspace");
  const hasChanges = (git?.files.length ?? 0) > 0;
  const pr = project.pr?.pr ?? null;

  function copyPath(): void {
    setMenuOpen(false);
    const path = repo?.root ?? currentWorkspace;
    if (path) void navigator.clipboard.writeText(path);
  }

  function revealRoot(): void {
    setMenuOpen(false);
    const path = repo?.root ?? currentWorkspace;
    if (path) void project.openFile(path);
  }

  return (
    <div className="repo-card">
      <div className="repo-card-header">
        <span className="repo-card-title" title={repo?.root ?? currentWorkspace ?? undefined}>
          {name}
        </span>
        <div className="repo-card-more-anchor" ref={menuRef}>
          <button
            type="button"
            className="repo-card-more"
            title={tr("更多操作", "More actions")}
            aria-label={tr("更多操作", "More actions")}
            aria-haspopup="true"
            aria-expanded={menuOpen}
            disabled={!repo?.root && !currentWorkspace}
            onClick={() => setMenuOpen((v) => !v)}
          >
            <MoreIcon size={13} />
          </button>
          {menuOpen ? (
            <div className="dock-popover composer-popover repo-menu">
              <button type="button" className="workspace-action-row" onClick={revealRoot}>
                <FolderIcon />
                <span>{tr("在", "Open in ")}{fileManagerName(window.vela?.platform ?? "darwin")}{tr("中打开", "")}</span>
              </button>
              <button type="button" className="workspace-action-row" onClick={copyPath}>
                <FolderIcon />
                <span>{tr("复制路径", "Copy path")}</span>
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {repo && git ? (
        <>
          <div className="repo-branch-row" ref={branchRef}>
            <button
              type="button"
              className="repo-branch-btn"
              title={tr("切换分支", "Switch branch")}
              aria-haspopup="true"
              aria-expanded={branchOpen}
              onClick={() => setBranchOpen((v) => !v)}
            >
              <BranchIcon />
              <span className="repo-branch-name">{git.branch ?? "HEAD"}</span>
            </button>
            <button
              type="button"
              className="repo-diff-stats"
              title={tr("查看工作区变更", "View workspace changes")}
              onClick={onOpenChanges}
            >
              {hasChanges ? (
                <>
                  <span className="repo-diff-added">+{formatCount(git.addedLines)}</span>
                  <span className="repo-diff-deleted">−{formatCount(git.deletedLines)}</span>
                </>
              ) : (
                <span className="repo-diff-clean">{tr("无变更", "No changes")}</span>
              )}
            </button>
            {branchOpen ? (
              <div className="dock-popover composer-popover repo-branch-popover">
                <BranchPickerContent
                  project={project}
                  onClose={() => {
                    setBranchOpen(false);
                  }}
                />
              </div>
            ) : null}
          </div>

          <div className="repo-pr-row">
            <span className="repo-pr-lead">
              <GithubIcon />
              <span>{tr("Pull Request", "Pull request")}</span>
            </span>
            {pr ? (
              <button type="button" className="repo-pr-link" onClick={() => void project.openPullRequest(pr.url)}>
                {tr("打开", "Open")}
              </button>
            ) : project.pr?.ghAvailable ? (
              <button type="button" className="repo-pr-link" onClick={() => void project.createPullRequest()}>
                {tr("创建", "Create")}
              </button>
            ) : null}
          </div>

          {pr ? (
            <button type="button" className="repo-pr-detail" onClick={() => void project.openPullRequest(pr.url)}>
              <span className="repo-pr-detail-icon">
                <PrIcon />
              </span>
              <span className="repo-pr-detail-text">
                <span className="repo-pr-title">{pr.title}</span>
                <span className="repo-pr-meta">
                  #{pr.number} · {prStateLabels[pr.state]} · {checksLabels[pr.checks]}
                  {pr.approvals > 0 ? ` · ${pr.approvals} approvals` : ""}
                </span>
              </span>
            </button>
          ) : (
            <div className="repo-pr-hint">
                {project.pr?.reason ? localizeError(project.pr.reason) : tr("当前分支暂无 Pull Request", "No pull request for this branch")}
            </div>
          )}

          <button
            type="button"
            className={`repo-changes-entry${activeChanges ? " active" : ""}`}
            onClick={onOpenChanges}
          >
            <span>
              {git.files.length > 0 ? tr(`${git.files.length} 个变更`, `${git.files.length} changes`) : tr("工作区无变更", "Workspace is clean")}
            </span>
            <span className="repo-changes-arrow">›</span>
          </button>
        </>
      ) : (
        <div className="repo-card-empty">
          {currentWorkspace
            ? tr("未检测到 Git 仓库", "No Git repository detected")
            : tr("尚未选择工作区", "No workspace selected")}
        </div>
      )}

      <div className="repo-sources">
        <div className="repo-sources-header">
          <span>{tr("来源", "Workspaces")}</span>
          <button
            type="button"
            className="repo-sources-add"
            title={tr("打开其他文件夹", "Open another folder")}
            aria-label={tr("打开其他文件夹", "Open another folder")}
            onClick={() => void project.openWorkspaceDialog()}
          >
            +
          </button>
        </div>
        {recents.length > 0 ? (
          <button
            type="button"
            className="repo-source-row"
            aria-expanded={sourcesOpen}
            onClick={() => setSourcesOpen((value) => !value)}
          >
            <GridIcon />
            <span>{sourcesOpen ? tr("收起列表", "Hide list") : tr(`查看全部(${recents.length})`, `View all (${recents.length})`)}</span>
          </button>
        ) : null}
        {sourcesOpen
          ? recents.map((recent) => (
              <button
                type="button"
                className={`repo-source-recent${recent.path === currentWorkspace ? " active" : ""}`}
                key={recent.path}
                title={recent.path}
                onClick={() => {
                  if (recent.path !== currentWorkspace) void project.selectRecentWorkspace(recent.path);
                }}
              >
                <FolderIcon />
                <span>{recent.name}</span>
              </button>
            ))
          : null}
      </div>
    </div>
  );
}
