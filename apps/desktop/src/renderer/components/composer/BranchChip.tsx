import type { ProjectApi } from "../../hooks/useProject";
import { useDismissable } from "../../hooks/useDismissable";
import { ArrowDownIcon, ArrowUpIcon, BranchIcon, PlusIcon, SearchIcon } from "../icons";
import { useMemo, useState } from "react";
import { tr } from "../../locale";

function formatCount(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

export function BranchAheadBehind({ ahead, behind }: { ahead: number; behind: number }) {
  if (ahead <= 0 && behind <= 0) return null;
  return (
    <span className="branch-ahead-behind">
      {ahead > 0 ? (
        <span className="branch-ahead">
          <ArrowUpIcon /> {ahead}
        </span>
      ) : null}
      {behind > 0 ? (
        <span className="branch-behind">
          <ArrowDownIcon /> {behind}
        </span>
      ) : null}
    </span>
  );
}

/**
 * 分支选择面板,Composer 的分支 chip 与右侧 Repo 卡片共用。
 */
export function BranchPickerContent({
  project,
  onClose,
}: {
  project: ProjectApi;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [newName, setNewName] = useState("");
  const git = project.git;
  const branches = project.branches;
  const filtered = useMemo(() => {
    const text = query.trim().toLowerCase();
    const list = text ? branches.filter((branch) => branch.name.toLowerCase().includes(text)) : branches;
    return {
      local: list.filter((branch) => !branch.remote),
      remote: list.filter((branch) => branch.remote),
    };
  }, [branches, query]);

  function switchTo(name: string): void {
    onClose();
    void project.switchBranch(name);
  }

  return (
    <div className="branch-picker">
      <div className="branch-current-row">
        <BranchIcon size={15} />
        <span className="branch-current-name" title={git?.upstream ?? undefined}>
          {git?.branch ?? "HEAD"}
        </span>
        <BranchAheadBehind ahead={git?.ahead ?? 0} behind={git?.behind ?? 0} />
      </div>
      {git?.upstream ? <div className="branch-upstream-row">{git.upstream}</div> : null}

      <div className="branch-create-row">
        <input
          className="branch-create-input"
          placeholder={tr("基于当前分支新建分支", "Create a branch from the current branch")}
          aria-label={tr("新分支名称", "New branch name")}
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && newName.trim()) {
              onClose();
              void project.createBranch(newName.trim());
            }
          }}
        />
        <button
          type="button"
          className="branch-create-btn"
          title={tr("新建分支", "Create branch")}
          aria-label={tr("新建分支", "Create branch")}
          disabled={!newName.trim()}
          onClick={() => {
            onClose();
            void project.createBranch(newName.trim());
          }}
        >
          <PlusIcon size={12} />
        </button>
      </div>

      <div className="branch-search-row">
        <SearchIcon />
        <input
          className="branch-search-input"
          placeholder={tr("搜索分支", "Search branches")}
          aria-label={tr("搜索分支", "Search branches")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      <div className="branch-list">
        {filtered.local.length > 0 ? <div className="composer-popover-section">{tr("本地", "Local")}</div> : null}
        {filtered.local.map((branch) => (
          <button
            type="button"
            key={branch.name}
            className={`branch-item${branch.current ? " active" : ""}`}
            onClick={() => switchTo(branch.name)}
          >
            <BranchIcon size={12} />
            <span className="branch-item-name">{branch.name}</span>
            {branch.current ? <span className="branch-item-tag">{tr("当前", "Current")}</span> : null}
          </button>
        ))}
        {filtered.remote.length > 0 ? <div className="composer-popover-section">{tr("远程", "Remote")}</div> : null}
        {filtered.remote.map((branch) => (
          <button type="button" key={branch.name} className="branch-item remote" onClick={() => switchTo(branch.name)}>
            <BranchIcon size={12} />
            <span className="branch-item-name">{branch.name}</span>
          </button>
        ))}
        {filtered.local.length === 0 && filtered.remote.length === 0 ? (
          <div className="branch-empty">{tr("没有匹配的分支", "No matching branches")}</div>
        ) : null}
      </div>
      <div className="composer-popover-footnote">{tr("切换分支会保留工作区改动，Git 冲突时由 git 提示", "Switching branches keeps workspace changes. Git will warn you about conflicts.")}</div>
    </div>
  );
}

export function BranchChip({ project }: { project: ProjectApi }) {
  const [open, setOpen] = useState(false);
  const ref = useDismissable<HTMLDivElement>(open, () => setOpen(false));
  const branch = project.git?.branch;
  if (!project.git?.repo || !branch) return null;

  return (
    <div className="composer-chip-anchor" ref={ref}>
      <button
        type="button"
        className="composer-chip"
        title={`${tr("分支", "Branch")} ${branch}`}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <BranchIcon />
        <span>{branch}</span>
        <BranchAheadBehind ahead={project.git.ahead} behind={project.git.behind} />
      </button>
      {open ? (
        <div className="dock-popover composer-popover up">
          <BranchPickerContent project={project} onClose={() => setOpen(false)} />
        </div>
      ) : null}
    </div>
  );
}

export { formatCount };
