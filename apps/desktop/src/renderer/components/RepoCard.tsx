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
  none: "无 Checks",
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
  const name = repo?.name ?? currentWorkspace?.split("/").filter(Boolean).pop() ?? "工作区";
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
            title="更多操作"
            aria-label="更多操作"
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
                <span>在{fileManagerName(window.vela?.platform ?? "darwin")}中打开</span>
              </button>
              <button type="button" className="workspace-action-row" onClick={copyPath}>
                <FolderIcon />
                <span>复制路径</span>
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
              title="切换分支"
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
              title="查看工作区变更"
              onClick={onOpenChanges}
            >
              {hasChanges ? (
                <>
                  <span className="repo-diff-added">+{formatCount(git.addedLines)}</span>
                  <span className="repo-diff-deleted">−{formatCount(git.deletedLines)}</span>
                </>
              ) : (
                <span className="repo-diff-clean">无变更</span>
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
              <span>现有 Pull Request</span>
            </span>
            {pr ? (
              <button type="button" className="repo-pr-link" onClick={() => void project.openPullRequest(pr.url)}>
                打开
              </button>
            ) : project.pr?.ghAvailable ? (
              <button type="button" className="repo-pr-link" onClick={() => void project.createPullRequest()}>
                创建
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
              {project.pr?.reason ?? "当前分支暂无 Pull Request"}
            </div>
          )}

          <button
            type="button"
            className={`repo-changes-entry${activeChanges ? " active" : ""}`}
            onClick={onOpenChanges}
          >
            <span>
              {git.files.length > 0 ? `${git.files.length} 个变更` : "工作区无变更"}
            </span>
            <span className="repo-changes-arrow">›</span>
          </button>
        </>
      ) : (
        <div className="repo-card-empty">
          {currentWorkspace
            ? "未检测到 Git 仓库"
            : "尚未选择工作区"}
        </div>
      )}

      <div className="repo-sources">
        <div className="repo-sources-header">
          <span>来源</span>
          <button
            type="button"
            className="repo-sources-add"
            title="打开其他文件夹"
            aria-label="打开其他文件夹"
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
            <span>{sourcesOpen ? "收起来源列表" : `查看全部(${recents.length})`}</span>
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
