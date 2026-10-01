import { useMemo, useState } from "react";
import type { BranchSummary } from "@vela/shared";
import { tr } from "../../locale";
import { useDismissable } from "../../hooks/useDismissable";
import { BranchIcon, CheckIcon, ChevronDownIcon, SearchIcon } from "../icons";

/**
 * 分支选择:搜索本地/远程分支,标记当前分支、upstream 与 worktree 占用,
 * 并支持基于当前提交创建分支。
 */
export function BranchMenu({
  branches,
  current,
  disabled,
  onSwitch,
  onCreate,
}: {
  branches: BranchSummary[];
  current: string | null;
  disabled: boolean;
  onSwitch(name: string): void;
  onCreate(name: string): void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [newName, setNewName] = useState("");
  const ref = useDismissable<HTMLDivElement>(open, () => setOpen(false));

  const filtered = useMemo(() => {
    const value = query.trim().toLowerCase();
    return branches
      .filter((branch) => !value || branch.name.toLowerCase().includes(value))
      .sort((a, b) => Number(a.remote) - Number(b.remote) || a.name.localeCompare(b.name));
  }, [branches, query]);

  const localCount = filtered.filter((branch) => !branch.remote).length;

  return (
    <div className="vc-branch-menu" ref={ref}>
      <button
        type="button"
        className="vc-btn vc-branch-btn"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <BranchIcon size={12} />
        <span className="vc-branch-name">{current ?? tr("Detached HEAD", "Detached HEAD")}</span>
        <ChevronDownIcon size={11} />
      </button>
      {open ? (
        <div className="vc-popover vc-branch-popover" role="listbox" aria-label={tr("选择分支", "Choose a branch")}>
          <label className="vc-search">
            <SearchIcon size={12} />
            <input
              autoFocus
              aria-label={tr("搜索分支", "Search branches")}
              placeholder={tr("搜索分支", "Search branches")}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <div className="vc-branch-list">
            {filtered.length === 0 ? <div className="vc-state">{tr("没有匹配的分支", "No matching branches")}</div> : null}
            {filtered.map((branch, index) => (
              <div key={`${branch.remote ? "r" : "l"}:${branch.name}`}>
                {index === localCount && localCount > 0 && filtered.some((entry) => entry.remote) ? (
                  <div className="vc-branch-sep">{tr("远程分支", "Remote branches")}</div>
                ) : null}
                <button
                  type="button"
                  role="option"
                  aria-selected={branch.current}
                  className={`vc-branch-item${branch.current ? " current" : ""}`}
                  disabled={disabled}
                  onClick={() => {
                    setOpen(false);
                    if (!branch.current) onSwitch(branch.name);
                  }}
                >
                  <span className="vc-branch-item-name">
                    {branch.current ? <CheckIcon size={11} /> : null}
                    {branch.name}
                  </span>
                  <span className="vc-branch-item-meta">
                    {branch.upstream ? <span title={branch.upstream}>{tr("跟踪", "tracks")} {branch.upstream}</span> : null}
                    {branch.worktreePath ? <span className="vc-badge vc-badge-muted">{tr("其他 worktree", "other worktree")}</span> : null}
                    {branch.remote ? <span className="vc-badge vc-badge-muted">{tr("远程", "remote")}</span> : null}
                  </span>
                </button>
              </div>
            ))}
          </div>
          <div className="vc-branch-create">
            <input
              className="vc-input"
              placeholder={tr("新分支名称（基于当前提交）", "New branch name (from current commit)")}
              aria-label={tr("新分支名称", "New branch name")}
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && newName.trim()) {
                  setOpen(false);
                  onCreate(newName.trim());
                  setNewName("");
                }
              }}
            />
            <button
              type="button"
              className="vc-btn"
              disabled={!newName.trim() || disabled}
              onClick={() => {
                setOpen(false);
                onCreate(newName.trim());
                setNewName("");
              }}
            >
              {tr("创建", "Create")}
            </button>
          </div>
          <p className="vc-hint">{tr("切换分支会保留未提交改动；可能被覆盖时 Git 会停止切换。", "Uncommitted changes are kept when switching; Git stops if they would be overwritten.")}</p>
        </div>
      ) : null}
    </div>
  );
}
