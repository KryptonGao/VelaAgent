import { useEffect, useState } from "react";
import type { AppLocale, GitWorktreeInfo } from "@vela/shared";
import { tr } from "../../locale";
import type { VersionControlApi } from "../../hooks/useVersionControl";
import { AlertIcon, CheckIcon, FolderIcon, MonitorIcon, PlusIcon, RefreshIcon, TrashIcon } from "../icons";

/**
 * Worktree 管理(WT-01):列表(分支/路径/改动)、创建、切换与清理。
 * 目录里有未保存内容时必须显式确认才删除。
 */
export function WorktreePanel({
  open,
  onClose,
  api,
  workspace,
  locale,
  onSwitch,
}: {
  open: boolean;
  onClose(): void;
  api: VersionControlApi;
  workspace: string | null;
  locale: AppLocale;
  onSwitch(path: string): void;
}) {
  const [creating, setCreating] = useState(false);
  const [branch, setBranch] = useState("");
  const [newBranch, setNewBranch] = useState(true);
  const [startPoint, setStartPoint] = useState("");
  const [path, setPath] = useState("");
  const [confirmRemove, setConfirmRemove] = useState<GitWorktreeInfo | null>(null);
  const [force, setForce] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) api.refreshWorktrees();
  }, [open, api]);

  useEffect(() => {
    if (open) {
      setCreating(false);
      setBranch("");
      setStartPoint("");
      setPath("");
      setConfirmRemove(null);
      setForce(false);
      setError(null);
    }
  }, [open]);

  if (!open) return null;

  const submitCreate = async () => {
    if (!branch.trim()) return;
    setError(null);
    const result = await api.createWorktree({
      branch: branch.trim(),
      newBranch,
      startPoint: newBranch && startPoint.trim() ? startPoint.trim() : null,
      path: path.trim() ? path.trim() : null,
    });
    if (!result) return;
    if (result.ok) {
      setCreating(false);
      setBranch("");
      setStartPoint("");
      setPath("");
    } else {
      setError(result.message);
    }
  };

  const submitRemove = async () => {
    if (!confirmRemove) return;
    const result = await api.removeWorktree({ path: confirmRemove.path, force });
    if (result?.ok) {
      setConfirmRemove(null);
      setForce(false);
    } else if (result) {
      setError(result.message);
      setConfirmRemove({ ...confirmRemove, changeCount: result.changeCount });
    }
  };

  return (
    <div className="vc-popover vc-worktree-popover" role="dialog" aria-label={tr("Worktree 管理", "Worktrees")}>
      <div className="vc-ops-head">
        <b><MonitorIcon size={12} /> {tr("Worktree", "Worktrees")}</b>
        <button type="button" className="vc-link" onClick={() => setCreating((value) => !value)}>
          <PlusIcon size={11} /> {tr("新建", "New")}
        </button>
        <button type="button" className="vc-icon-btn" title={tr("刷新", "Refresh")} aria-label={tr("刷新 worktree 列表", "Refresh worktrees")} onClick={api.refreshWorktrees}>
          <RefreshIcon size={12} />
        </button>
        <button type="button" className="vc-link" onClick={onClose}>{tr("关闭", "Close")}</button>
      </div>
      <p className="vc-hint">
        {tr(
          "每个 worktree 是同一仓库的独立检出，改动与索引互不影响；切换工作区后对话与终端都使用该目录。",
          "Each worktree is a separate checkout of the same repository; switching the workspace points chats and terminals at that directory.",
        )}
      </p>

      {creating ? (
        <div className="vc-worktree-form">
          <input
            className="vc-input"
            placeholder={tr("分支名", "Branch name")}
            aria-label={tr("分支名", "Branch name")}
            value={branch}
            onChange={(event) => setBranch(event.target.value)}
          />
          <label className="vc-radio">
            <input type="checkbox" checked={newBranch} onChange={(event) => setNewBranch(event.target.checked)} />
            {tr("创建新分支", "Create a new branch")}
          </label>
          {newBranch ? (
            <input
              className="vc-input"
              placeholder={tr("起点（可选，默认当前提交）", "Start point (optional, defaults to HEAD)")}
              aria-label={tr("起点", "Start point")}
              value={startPoint}
              onChange={(event) => setStartPoint(event.target.value)}
            />
          ) : null}
          <input
            className="vc-input"
            placeholder={tr("目标路径（可选，默认 Vela 的 worktrees 目录）", "Target path (optional; defaults to Vela's worktrees directory)")}
            aria-label={tr("目标路径", "Target path")}
            value={path}
            onChange={(event) => setPath(event.target.value)}
          />
          {error ? <div className="vc-error-banner" role="alert"><AlertIcon size={12} />{error}</div> : null}
          <div className="vc-dialog-actions">
            <button type="button" className="vc-btn vc-btn-ghost" onClick={() => setCreating(false)}>{tr("取消", "Cancel")}</button>
            <button type="button" className="vc-btn vc-btn-primary" disabled={!branch.trim() || api.busy !== null} onClick={() => void submitCreate()}>
              <CheckIcon size={12} /> {tr("创建 worktree", "Create worktree")}
            </button>
          </div>
        </div>
      ) : null}

      {api.worktreesLoading && api.worktrees.length === 0 ? <div className="vc-state">{tr("正在读取…", "Loading…")}</div> : null}
      <div className="vc-worktree-list">
        {api.worktrees.map((entry) => (
          <div key={entry.path} className={`vc-worktree-row${entry.current ? " current" : ""}`}>
            <div className="vc-worktree-copy">
              <div className="vc-worktree-title">
                <FolderIcon size={12} />
                <b>{entry.branch ?? (entry.detached ? tr("Detached", "Detached") : tr("（bare）", "(bare)"))}</b>
                {entry.current ? <span className="vc-badge vc-badge-ok">{tr("当前工作区", "Current")}</span> : null}
                {entry.managed ? <span className="vc-badge vc-badge-muted">{tr("Vela 管理", "Managed")}</span> : null}
                {entry.locked ? <span className="vc-badge vc-badge-pending">{tr("已锁定", "Locked")}</span> : null}
                {entry.missing ? <span className="vc-badge vc-badge-pending">{tr("目录已缺失", "Missing")}</span> : null}
              </div>
              <div className="vc-worktree-path" title={entry.path}>{entry.path}</div>
              <div className="vc-worktree-meta">
                {entry.shortHead ? <code className="vc-sha">{entry.shortHead}</code> : null}
                {entry.changeCount === null ? null : entry.changeCount === 0 ? (
                  <span className="vc-hint">{tr("没有未保存改动", "No unsaved changes")}</span>
                ) : (
                  <span className="vc-badge vc-badge-pending">
                    {tr(`${entry.changeCount} 个文件未保存（含 ${entry.untrackedCount ?? 0} 个未跟踪）`, `${entry.changeCount} unsaved files (${entry.untrackedCount ?? 0} untracked)`)}
                  </span>
                )}
              </div>
            </div>
            <div className="vc-worktree-actions">
              {!entry.current && !entry.missing ? (
                <button type="button" className="vc-btn vc-btn-ghost" onClick={() => onSwitch(entry.path)}>
                  {tr("切换到这里", "Switch here")}
                </button>
              ) : null}
              {confirmRemove?.path === entry.path ? null : !entry.current && !entry.bare ? (
                <button
                  type="button"
                  className="vc-icon-btn vc-danger"
                  title={entry.missing ? tr("删除失效记录", "Remove stale record") : tr("删除 worktree", "Remove worktree")}
                  aria-label={tr("删除 worktree", "Remove worktree")}
                  onClick={() => {
                    setForce(false);
                    setError(null);
                    setConfirmRemove(entry);
                  }}
                >
                  <TrashIcon size={11} />
                </button>
              ) : null}
            </div>
            {confirmRemove?.path === entry.path ? (
              <div className="vc-worktree-confirm" role="alertdialog" aria-label={tr("确认删除 worktree", "Confirm worktree removal")}>
                <p>
                  {entry.missing
                    ? tr("目录已不存在，删除会清理该 worktree 的记录。", "The directory is gone; removing cleans up its record.")
                    : tr(
                        `将删除目录 ${entry.path} 及其中的未保存内容（提交与分支会保留）。`,
                        `Deletes ${entry.path} including unsaved content (commits and branches stay).`,
                      )}
                </p>
                {(entry.changeCount ?? 0) > 0 ? (
                  <label className="vc-radio">
                    <input type="checkbox" checked={force} onChange={(event) => setForce(event.target.checked)} />
                    {tr(
                      `确认删除 ${entry.changeCount} 个未保存文件（含 ${entry.untrackedCount ?? 0} 个未跟踪）`,
                      `Delete ${entry.changeCount} unsaved files (${entry.untrackedCount ?? 0} untracked)`,
                    )}
                  </label>
                ) : null}
                {error ? <div className="vc-error-banner" role="alert"><AlertIcon size={12} />{error}</div> : null}
                <div className="vc-dialog-actions">
                  <button type="button" className="vc-btn vc-btn-ghost" onClick={() => setConfirmRemove(null)}>{tr("取消", "Cancel")}</button>
                  <button
                    type="button"
                    className="vc-btn vc-btn-danger"
                    disabled={api.busy !== null || ((entry.changeCount ?? 0) > 0 && !force)}
                    onClick={() => void submitRemove()}
                  >
                    {tr("删除", "Delete")}
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        ))}
        {!api.worktreesLoading && api.worktrees.length === 0 ? <div className="vc-state">{tr("没有 worktree 记录", "No worktrees")}</div> : null}
      </div>

      <div className="vc-worktree-foot">
        <button
          type="button"
          className="vc-btn vc-btn-ghost"
          disabled={api.busy !== null}
          onClick={() => void api.pruneWorktrees()}
        >
          {tr("清理失效记录", "Prune stale records")}
        </button>
        <span className="vc-hint">
          {workspace ? tr(`当前工作区：${workspace}`, `Current workspace: ${workspace}`) : ""}
        </span>
      </div>
      <p className="vc-hint">
        {locale === "en" ? "Removing a worktree never deletes commits or branches." : "删除 worktree 不会删除提交或分支。"}
      </p>
    </div>
  );
}
