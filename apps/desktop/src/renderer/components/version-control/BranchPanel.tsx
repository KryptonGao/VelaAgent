import { useCallback, useEffect, useMemo, useState } from "react";
import type { AppLocale, BranchSummary, GitBranchDeleteInput, GitBranchDetail } from "@vela/shared";
import { tr, trf } from "../../locale";
import type { VersionControlApi } from "../../hooks/useVersionControl";
import { AlertIcon, BranchIcon, CheckIcon, RefreshIcon, SearchIcon, TrashIcon } from "../icons";

/**
 * 分支管理(BR-02):重命名、删除与跟踪关系;删除前展示合并状态、
 * worktree 占用与未推送提交,本地与远程删除分开确认。
 */
export function BranchPanel({
  open,
  onClose,
  branches,
  current,
  api,
  onSwitch,
  onCompare,
}: {
  open: boolean;
  onClose(): void;
  branches: BranchSummary[];
  current: string | null;
  api: VersionControlApi;
  locale: AppLocale;
  onSwitch(name: string): void;
  onCompare(base: string, head: string): void;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<GitBranchDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [renaming, setRenaming] = useState<{ name: string; next: string } | null>(null);
  const [deleting, setDeleting] = useState<{ detail: GitBranchDetail; force: boolean; remote: string | null } | null>(null);
  const [upstreamFor, setUpstreamFor] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const local = useMemo(
    () => branches.filter((branch) => !branch.remote),
    [branches],
  );
  const remoteCandidates = useMemo(
    () => branches.filter((branch) => branch.remote && !branch.name.endsWith("/HEAD")),
    [branches],
  );
  const filtered = useMemo(() => {
    const value = query.trim().toLowerCase();
    return local.filter((branch) => !value || branch.name.toLowerCase().includes(value));
  }, [local, query]);

  const load = useCallback(
    async (name: string) => {
      setSelected(name);
      setDetail(null);
      setDetailLoading(true);
      setMessage(null);
      const next = await api.branchDetail(name);
      setDetailLoading(false);
      if (next) setDetail(next);
    },
    [api],
  );

  useEffect(() => {
    if (!open) {
      setSelected(null);
      setDetail(null);
      setRenaming(null);
      setDeleting(null);
      setUpstreamFor(null);
      setMessage(null);
    }
  }, [open]);

  if (!open) return null;

  const remove = async () => {
    if (!deleting) return;
    const input: GitBranchDeleteInput = {
      name: deleting.detail.name,
      force: deleting.force,
      remote: deleting.remote,
    };
    const result = await api.deleteBranch(input);
    if (result?.ok) {
      setDeleting(null);
      setSelected(null);
      setDetail(null);
      setMessage(result.message);
    }
  };

  return (
    <div className="vc-popover vc-branch-panel" role="dialog" aria-label={tr("分支管理", "Branches")}>
      <div className="vc-ops-head">
        <b>{tr("分支管理", "Branches")}</b>
        <button type="button" className="vc-link" onClick={onClose}>{tr("关闭", "Close")}</button>
      </div>
      <div className="vc-branch-panel-body">
        <div className="vc-branch-panel-list">
          <label className="vc-search">
            <SearchIcon size={12} />
            <input
              aria-label={tr("搜索本地分支", "Search local branches")}
              placeholder={tr("搜索本地分支", "Search local branches")}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          {filtered.length === 0 ? <div className="vc-state">{tr("没有匹配的分支", "No matching branches")}</div> : null}
          {filtered.map((branch) => (
            <button
              key={branch.name}
              type="button"
              className={`vc-branch-item${branch.name === selected ? " current" : ""}`}
              aria-current={branch.name === selected ? "true" : undefined}
              onClick={() => void load(branch.name)}
            >
              <span className="vc-branch-item-name">
                {branch.current ? <CheckIcon size={11} /> : <BranchIcon size={11} />}
                {branch.name}
              </span>
              <span className="vc-branch-item-meta">
                {branch.upstream ? <span title={branch.upstream}>{tr("跟踪", "tracks")} {branch.upstream}</span> : null}
                {branch.worktreePath ? <span className="vc-badge vc-badge-muted">{tr("worktree 占用", "in worktree")}</span> : null}
              </span>
            </button>
          ))}
        </div>

        <div className="vc-branch-panel-detail">
          {detailLoading ? <div className="vc-state">{tr("正在读取分支状态…", "Loading branch…")}</div> : null}
          {!detailLoading && !detail ? (
            <div className="vc-state">{tr("选择一个分支查看状态与操作", "Select a branch to see its state and actions")}</div>
          ) : null}
          {!detailLoading && detail ? (
            <>
              <div className="vc-branch-detail-head">
                <h3>{detail.name}</h3>
                <div className="vc-branch-flags">
                  {detail.current ? <span className="vc-badge vc-badge-ok">{tr("当前分支", "Current")}</span> : null}
                  {detail.worktreePath ? <span className="vc-badge vc-badge-pending">{trf("worktree：{0}", "Worktree: {0}", detail.worktreePath)}</span> : null}
                  {detail.mergedInto ? (
                    <span className="vc-badge vc-badge-ok">{trf("已合入 {0}", "Merged into {0}", detail.mergedInto)}</span>
                  ) : (
                    <span className="vc-badge vc-badge-pending">{tr("尚未合入", "Not merged")}</span>
                  )}
                  {detail.unpushedCount === null ? null : detail.unpushedCount > 0 ? (
                    <span className="vc-badge vc-badge-pending">{trf("{0} 个未推送提交", "{0} unpushed", detail.unpushedCount)}</span>
                  ) : (
                    <span className="vc-badge vc-badge-muted">{tr("无未推送提交", "Nothing unpushed")}</span>
                  )}
                </div>
                <div className="vc-branch-detail-meta">
                  <span>{tr("上游", "Upstream")} <b>{detail.upstream ?? tr("无", "None")}</b></span>
                  {detail.remoteBranch ? (
                    <span>{tr("远程分支", "Remote branch")} <b>{detail.remoteBranch.remote}/{detail.remoteBranch.branch}</b></span>
                  ) : null}
                  {detail.lastCommitSha ? <span><code className="vc-sha">{detail.lastCommitSha.slice(0, 7)}</code> {detail.subject ?? ""}</span> : null}
                </div>
              </div>

              {renaming?.name === detail.name ? (
                <div className="vc-branch-rename">
                  <input
                    className="vc-input"
                    aria-label={tr("新分支名", "New branch name")}
                    value={renaming.next}
                    autoFocus
                    onChange={(event) => setRenaming({ name: detail.name, next: event.target.value })}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        void api.renameBranch(detail.name, renaming.next.trim()).then(() => {
                          setRenaming(null);
                          setSelected(renaming.next.trim());
                        });
                      }
                      if (event.key === "Escape") setRenaming(null);
                    }}
                  />
                  <button
                    type="button"
                    className="vc-btn vc-btn-primary"
                    onClick={() => {
                      void api.renameBranch(detail.name, renaming.next.trim()).then(() => {
                        setRenaming(null);
                        setSelected(renaming.next.trim());
                      });
                    }}
                  >
                    {tr("重命名", "Rename")}
                  </button>
                  <button type="button" className="vc-btn vc-btn-ghost" onClick={() => setRenaming(null)}>{tr("取消", "Cancel")}</button>
                </div>
              ) : null}

              {deleting ? (
                <div className="vc-branch-delete" role="alertdialog" aria-label={tr("确认删除分支", "Confirm branch deletion")}>
                  <p>
                    {trf("将删除本地分支 {0}。分支上的提交仍会保留在对象库中，除非被清理。", "Deletes local branch {0}. Its commits stay in the object database unless pruned.", deleting.detail.name)}
                  </p>
                  {!deleting.detail.mergedInto ? (
                    <label className="vc-radio">
                      <input
                        type="checkbox"
                        checked={deleting.force}
                        onChange={(event) => setDeleting({ ...deleting, force: event.target.checked })}
                      />
                      {tr("该分支尚未合入，强制删除（会丢失未合并提交的引用）", "Not merged: force delete (the unmerged commits lose their reference)")}
                    </label>
                  ) : null}
                  {deleting.detail.remoteBranch ? (
                    <label className="vc-radio">
                      <input
                        type="checkbox"
                        checked={deleting.remote !== null}
                        onChange={(event) =>
                          setDeleting({ ...deleting, remote: event.target.checked ? deleting.detail.remoteBranch!.remote : null })
                        }
                      />
                      {trf("同时删除远程分支 {0}/{1}", "Also delete remote branch {0}/{1}", deleting.detail.remoteBranch.remote, deleting.detail.remoteBranch.branch)}
                    </label>
                  ) : null}
                  <div className="vc-dialog-actions">
                    <button type="button" className="vc-btn vc-btn-ghost" onClick={() => setDeleting(null)}>{tr("取消", "Cancel")}</button>
                    <button type="button" className="vc-btn vc-btn-danger" disabled={api.busy !== null} onClick={() => void remove()}>
                      {tr("删除分支", "Delete branch")}
                    </button>
                  </div>
                </div>
              ) : null}

              {upstreamFor === detail.name ? (
                <div className="vc-branch-upstream">
                  <div className="vc-stage-all-head">
                    <b>{tr("设置上游跟踪", "Set upstream")}</b>
                    <span>{tr("上游决定 Push/Pull 的默认目标", "Upstream decides the default push/pull target")}</span>
                  </div>
                  <div className="vc-branch-upstream-actions">
                    {remoteCandidates.length === 0 ? <span className="vc-hint">{tr("没有可用的远程分支", "No remote branches")}</span> : null}
                    {remoteCandidates.map((candidate) => (
                      <button
                        key={candidate.name}
                        type="button"
                        className="vc-chip"
                        onClick={() => {
                          void api.setUpstream({ branch: detail.name, upstream: candidate.name }).then(() => {
                            setUpstreamFor(null);
                            void load(detail.name);
                          });
                        }}
                      >
                        {candidate.name}
                      </button>
                    ))}
                  </div>
                  <div className="vc-dialog-actions">
                    {detail.upstream ? (
                      <button
                        type="button"
                        className="vc-btn vc-btn-ghost"
                        onClick={() => {
                          void api.setUpstream({ branch: detail.name, upstream: null }).then(() => {
                            setUpstreamFor(null);
                            void load(detail.name);
                          });
                        }}
                      >
                        {tr("清除跟踪", "Clear tracking")}
                      </button>
                    ) : null}
                    <button type="button" className="vc-btn vc-btn-ghost" onClick={() => setUpstreamFor(null)}>{tr("取消", "Cancel")}</button>
                  </div>
                </div>
              ) : null}

              <div className="vc-branch-actions">
                {!detail.current ? (
                  <button
                    type="button"
                    className="vc-btn"
                    disabled={api.busy !== null || api.guard?.agentRunning === true || Boolean(detail.worktreePath)}
                    title={detail.worktreePath ? tr("已被其他 worktree 检出", "Checked out in another worktree") : undefined}
                    onClick={() => onSwitch(detail.name)}
                  >
                    {tr("切换到该分支", "Switch to branch")}
                  </button>
                ) : null}
                <button type="button" className="vc-btn" onClick={() => { setRenaming({ name: detail.name, next: detail.name }); setDeleting(null); }}>
                  {tr("重命名", "Rename")}
                </button>
                <button type="button" className="vc-btn" onClick={() => { setUpstreamFor(detail.name); setDeleting(null); }}>
                  {tr("设置上游", "Set upstream")}
                </button>
                <button
                  type="button"
                  className="vc-btn"
                  disabled={!current || detail.name === current}
                  title={!current ? tr("当前处于 detached HEAD", "Detached HEAD") : undefined}
                  onClick={() => {
                    onCompare(detail.name, current ?? "");
                    onClose();
                  }}
                >
                  {tr("与当前分支比较", "Compare with current branch")}
                </button>
                <button
                  type="button"
                  className="vc-btn vc-btn-danger"
                  disabled={detail.current}
                  title={detail.current ? tr("不能删除当前分支", "Cannot delete the current branch") : undefined}
                  onClick={() => { setDeleting({ detail, force: false, remote: null }); setRenaming(null); }}
                >
                  <TrashIcon size={12} /> {tr("删除分支", "Delete")}
                </button>
                <button type="button" className="vc-icon-btn" title={tr("刷新", "Refresh")} aria-label={tr("刷新分支状态", "Refresh branch")} onClick={() => void load(detail.name)}>
                  <RefreshIcon size={12} />
                </button>
              </div>
              <p className="vc-hint">
                {tr(
                  "比较方向为：所选分支 → 当前分支。删除前请确认 worktree 占用与未推送提交。",
                  "Comparison direction: selected branch → current branch. Check worktree usage and unpushed commits before deleting.",
                )}
              </p>
            </>
          ) : null}
          {message ? <div className="vc-inline-notice" role="status">{message}</div> : null}
          {api.error ? (
            <div className="vc-error-banner" role="alert">
              <AlertIcon size={12} />
              {api.error}
              <button type="button" className="vc-link" onClick={api.clearError}>{tr("关闭", "Dismiss")}</button>
            </div>
          ) : null}
        </div>
      </div>
      <p className="vc-hint">{tr("这里只维护本地分支；远程分支的删除在确认框里单独勾选。", "Only local branches are listed for maintenance.")}</p>
    </div>
  );
}
