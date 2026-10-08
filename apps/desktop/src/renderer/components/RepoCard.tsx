import { useId, useState } from "react";
import type { ProjectApi } from "../hooks/useProject";
import { useDismissable } from "../hooks/useDismissable";
import { fileManagerName } from "../platform";
import { BranchPickerContent } from "./composer/BranchChip";
import { PopoverPresence } from "./MotionPresence";
import { RepoCardPopover } from "./RepoCardPopover";
import {
  ChevronDownIcon,
  BranchIcon,
  FolderIcon,
  GithubIcon,
  GridIcon,
  MoreIcon,
  PlanIcon,
  PrIcon,
} from "./icons";
import type { PrSummary } from "@vela/shared";
import { localizeError, tr, trf } from "../locale";
import type { PlanReferenceModel } from "../plan-draft";

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
  plan = null,
  onOpenPlan,
  collapsed = false,
  onToggle,
}: {
  project: ProjectApi;
  onOpenChanges: () => void;
  activeChanges: boolean;
  plan?: PlanReferenceModel | null;
  onOpenPlan?: (planId: string) => void;
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  const contentId = useId();
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
        {onToggle ? (
          <button type="button" className="repo-card-title environment-toggle" aria-expanded={!collapsed} aria-controls={contentId}
            aria-label={collapsed ? tr("展开环境卡片", "Expand environment card") : tr("折叠环境卡片", "Collapse environment card")}
            title={collapsed ? tr("展开环境卡片", "Expand environment card") : tr("折叠环境卡片", "Collapse environment card")}
            onClick={onToggle}>
            <span className="repo-card-name" title={repo?.root ?? currentWorkspace ?? undefined}>{name}</span>
            <span aria-hidden="true" className={`environment-chevron${collapsed ? " collapsed" : ""}`}><ChevronDownIcon /></span>
          </button>
        ) : <span className="repo-card-title" title={repo?.root ?? currentWorkspace ?? undefined}>
          {name}
        </span>}
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
          <PopoverPresence present={menuOpen}>
            <RepoCardPopover anchor={menuRef} className="repo-menu" label={tr("更多操作", "More actions")}>
              <button type="button" className="workspace-action-row" onClick={revealRoot}>
                <FolderIcon />
                <span>{tr("在", "Open in ")}{fileManagerName(window.vela?.platform ?? "darwin")}{tr("中打开", "")}</span>
              </button>
              <button type="button" className="workspace-action-row" onClick={copyPath}>
                <FolderIcon />
                <span>{tr("复制路径", "Copy path")}</span>
              </button>
            </RepoCardPopover>
          </PopoverPresence>
        </div>
      </div>

      <div id={contentId} className="repo-card-content" hidden={collapsed}>
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
                  <span className="repo-diff-added">+{git.addedLines.toLocaleString("en-US")}</span>
                  <span className="repo-diff-deleted">−{git.deletedLines.toLocaleString("en-US")}</span>
                </>
              ) : (
                <span className="repo-diff-clean">{tr("无变更", "No changes")}</span>
              )}
            </button>
            <PopoverPresence present={branchOpen}>
              <RepoCardPopover anchor={branchRef} className="repo-branch-popover" label={tr("切换分支", "Switch branch")}>
                <BranchPickerContent
                  project={project}
                  onClose={() => {
                    setBranchOpen(false);
                  }}
                />
              </RepoCardPopover>
            </PopoverPresence>
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
              {git.files.length > 0 ? trf("{0} 个变更", "{0} changes", git.files.length) : tr("工作区无变更", "Workspace is clean")}
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

      {plan && onOpenPlan ? (
        <section className="repo-plan">
          <div className="repo-plan-heading">{tr("计划", "Plan")}</div>
          <button
            type="button"
            className="repo-plan-entry"
            title={plan.title || tr("未命名计划", "Untitled plan")}
            aria-label={`${tr("打开计划", "Open plan")}: ${plan.title || tr("未命名计划", "Untitled plan")}`}
            onClick={() => onOpenPlan(plan.id)}
          >
            <span className="repo-plan-icon" aria-hidden="true"><PlanIcon size={16} /></span>
            <span className="repo-plan-title">{plan.title || tr("未命名计划", "Untitled plan")}</span>
            {plan.streaming ? <span className="repo-plan-status">{tr("生成中", "Writing")}</span> : null}
          </button>
        </section>
      ) : null}

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
            <span>{sourcesOpen ? tr("收起列表", "Hide list") : trf("查看全部({0})", "View all ({0})", recents.length)}</span>
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
    </div>
  );
}
