import { useEffect, useMemo, useState } from "react";
import type {
  AppLocale,
  GitForcePushPreview,
  GitPullResult,
  GitPullStrategy,
  GitStatusSnapshot,
} from "@vela/shared";
import { tr, trf } from "../../locale";
import type { VersionControlApi } from "../../hooks/useVersionControl";
import { AlertIcon } from "../icons";
import { formatAbsoluteTime, formatRelativeTime } from "./time-format";

/** 同步策略:与 P0 的仅快进 Pull 区分,逐项说明对历史的影响(SY-03)。 */
const pullStrategies: Array<{ value: GitPullStrategy; label: [string, string]; hint: [string, string] }> = [
  {
    value: "ff-only",
    label: ["仅快进（默认）", "Fast-forward only (default)"],
    hint: ["分叉时停止，不自动合并", "Stops when the histories diverge; never merges automatically"],
  },
  {
    value: "merge",
    label: ["Merge", "Merge"],
    hint: ["生成合并提交，保留两条历史", "Creates a merge commit and keeps both histories"],
  },
  {
    value: "rebase",
    label: ["Rebase", "Rebase"],
    hint: ["把本地提交重放到上游之上，会重写本地历史", "Replays local commits on top of upstream and rewrites local history"],
  },
];

/** 预览只返回完整 SHA,列表里统一显示前 7 位。 */
function shortShaOf(sha: string | null): string {
  return sha ? sha.slice(0, 7) : "-";
}

/**
 * 高级同步(SY-03)与安全强推(SY-04):显式选择 Merge/Rebase 策略,
 * 强推前必须核对远程引用与覆盖范围;远程引用已变化时拒绝覆盖并要求重新核对。
 */
export function SyncDialog({
  open,
  onClose,
  api,
  mode,
  status,
  locale,
}: {
  open: boolean;
  onClose(): void;
  api: VersionControlApi;
  mode: "pull" | "force-push";
  status: GitStatusSnapshot;
  locale: AppLocale;
}) {
  const remotes = useMemo(() => status.remotes.map((item) => item.name), [status.remotes]);

  // 默认远程:优先 upstream 指向的远程,其次 origin,最后第一个远程。
  const defaultRemote = useMemo(() => {
    const upstreamRemote = status.upstream ? status.upstream.split("/")[0] : "";
    if (upstreamRemote && remotes.includes(upstreamRemote)) return upstreamRemote;
    if (remotes.includes("origin")) return "origin";
    return remotes[0] ?? "";
  }, [status.upstream, remotes]);

  const [strategy, setStrategy] = useState<GitPullStrategy>("ff-only");
  const [pullResult, setPullResult] = useState<GitPullResult | null>(null);
  const [remote, setRemote] = useState("");
  const [branch, setBranch] = useState("");
  const [preview, setPreview] = useState<GitForcePushPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [forceMessage, setForceMessage] = useState<string | null>(null);
  /** 远程引用在核对之后发生变化:必须先重新核对,才能再次强推。 */
  const [stale, setStale] = useState(false);

  // 打开时按当前状态初始化;面板打开期间的刷新不重置用户已做的选择。
  useEffect(() => {
    if (!open) return;
    setStrategy("ff-only");
    setPullResult(null);
    setRemote(defaultRemote);
    setBranch(status.branch ?? "");
    setPreview(null);
    setPreviewing(false);
    setConfirmed(false);
    setForceMessage(null);
    setStale(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 已跟踪文件的未提交改动会让同步先停止,提前说明而不是等命令失败。
  const hasTrackedChanges = status.files.some(
    (file) => file.status !== "untracked" && (file.indexStatus !== null || file.worktreeStatus !== null),
  );

  const runPull = () => {
    setPullResult(null);
    void api.pullWithStrategy(strategy).then((result) => {
      if (result) setPullResult(result);
    });
  };

  const runForcePreview = () => {
    if (!remote || !branch.trim()) return;
    setPreviewing(true);
    setConfirmed(false);
    setForceMessage(null);
    void api.previewForcePush(remote, branch.trim()).then((next) => {
      setPreviewing(false);
      if (!next) return;
      setPreview(next);
      // 刚刚重新核对过,解除上一次「远程已变化」的锁定。
      setStale(false);
    });
  };

  const runForcePush = () => {
    if (!preview || !preview.ok || preview.fastForward || preview.stale || stale) return;
    if (!confirmed || !branch.trim()) return;
    setForceMessage(null);
    void api.forcePush({ remote, branch: branch.trim(), expectedRemoteSha: preview.remoteSha ?? "" }).then((result) => {
      if (!result) return;
      setForceMessage(result.message);
      if (result.stale) {
        // 远程引用在核对之后变了:必须重新核对,不能直接重试。
        setStale(true);
        setConfirmed(false);
        return;
      }
      if (result.ok) {
        onClose();
        return;
      }
      setConfirmed(false);
    });
  };

  const changeTarget = (nextRemote: string, nextBranch: string) => {
    setRemote(nextRemote);
    setBranch(nextBranch);
    setPreview(null);
    setConfirmed(false);
    setForceMessage(null);
    setStale(false);
  };

  if (!open) return null;

  const title = mode === "pull" ? tr("高级同步", "Advanced sync") : tr("安全强推", "Safe force push");

  return (
    <div className="vc-popover vc-p2-sync" role="dialog" aria-label={title}>
      <div className="vc-ops-head">
        <b>{title}</b>
        <button type="button" className="vc-link" onClick={onClose}>{tr("关闭", "Close")}</button>
      </div>

      {mode === "pull" ? (
        <div className="vc-p2-body">
          <div className="vc-p2-section">
            <div className="vc-p2-meta">
              {tr("当前分支", "Current branch")}
              <b>{status.branch ?? (status.detached ? tr("Detached HEAD", "Detached HEAD") : "-")}</b>
            </div>
            <div className="vc-p2-meta">
              {tr("上游", "Upstream")}
              {status.upstream ?? tr("尚未发布分支", "Not published yet")}
            </div>
            <div className="vc-p2-meta">
              {trf("领先 {0} 个提交，落后 {1} 个提交", "{0} ahead, {1} behind", status.ahead, status.behind)}
            </div>
            {hasTrackedChanges ? (
              <div className="vc-p2-warn" role="status">
                <AlertIcon size={12} />
                {tr(
                  "工作区有未提交改动，同步会先停止；请先提交或保存到 Stash。",
                  "The working tree has uncommitted changes; the sync stops first. Commit them or save them to a stash.",
                )}
              </div>
            ) : null}
          </div>

          <div className="vc-p2-section">
            <div className="vc-p2-label">{tr("同步策略", "Sync strategy")}</div>
            <div className="vc-p2-tabs" role="group" aria-label={tr("同步策略", "Sync strategy")}>
              {pullStrategies.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={`vc-chip${strategy === option.value ? " active" : ""}`}
                  aria-pressed={strategy === option.value}
                  onClick={() => setStrategy(option.value)}
                >
                  {tr(option.label[0], option.label[1])}
                </button>
              ))}
            </div>
            {pullStrategies.map((option) => (
              <div key={option.value} className="vc-p2-meta">
                <b>{tr(option.label[0], option.label[1])}</b>
                {tr(option.hint[0], option.hint[1])}
              </div>
            ))}
            <div className="vc-p2-foot">
              <button type="button" className="vc-btn vc-btn-primary" disabled={api.busy !== null} onClick={runPull}>
                {api.busy === "pull" ? tr("同步中…", "Syncing…") : tr("执行同步", "Sync now")}
              </button>
            </div>
          </div>

          {pullResult ? (
            <div className="vc-p2-section">
              <div className={pullResult.ok ? "vc-p2-note" : "vc-p2-error"} role="status">{pullResult.message}</div>
              {pullResult.conflicted ? (
                <>
                  <div className="vc-p2-label">{tr("冲突文件", "Conflicted files")}</div>
                  <div className="vc-p2-files">
                    {(pullResult.conflictedPaths ?? []).map((path) => (
                      <div key={path} className="vc-p2-file">{path}</div>
                    ))}
                  </div>
                  <div className="vc-p2-warn" role="status">
                    {tr(
                      "Merge/Rebase 仍在进行中，需要到「改动」页继续或中止这次操作。",
                      "The merge/rebase is still in progress; continue or abort it on the Changes page.",
                    )}
                  </div>
                  <div className="vc-p2-foot">
                    <button type="button" className="vc-btn" onClick={onClose}>{tr("去处理", "Resolve")}</button>
                  </div>
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="vc-p2-body">
          {remotes.length === 0 ? (
            <div className="vc-state vc-state-error" role="alert">
              {tr("当前仓库没有配置远程，无法强推。", "No remote is configured, so a force push is not possible.")}
            </div>
          ) : (
            <>
              <div className="vc-p2-section">
                <label className="vc-p2-label">
                  {tr("远程", "Remote")}
                  <select
                    className="vc-select"
                    aria-label={tr("远程", "Remote")}
                    value={remote}
                    onChange={(event) => changeTarget(event.target.value, branch)}
                  >
                    {remotes.map((name) => <option key={name} value={name}>{name}</option>)}
                  </select>
                </label>
                <label className="vc-p2-label">
                  {tr("目标分支", "Target branch")}
                  <input
                    className="vc-input"
                    aria-label={tr("目标分支", "Target branch")}
                    value={branch}
                    onChange={(event) => changeTarget(remote, event.target.value)}
                  />
                </label>
                <button
                  type="button"
                  className="vc-btn"
                  disabled={api.busy !== null || previewing || !remote || !branch.trim()}
                  onClick={runForcePreview}
                >
                  {previewing
                    ? tr("核对中…", "Checking…")
                    : stale
                      ? tr("重新核对", "Re-check")
                      : tr("核对远程引用", "Check the remote reference")}
                </button>
                <p className="vc-p2-note">
                  {tr(
                    "核对会重新 Fetch 并读出远程当前引用，返回值作为 --force-with-lease 的预期 SHA。",
                    "Checking re-fetches and reads the current remote reference; its SHA is used as the --force-with-lease expectation.",
                  )}
                </p>
              </div>

              {stale ? (
                <div className="vc-p2-danger" role="alert">
                  {forceMessage ?? tr("远程引用已变化。", "The remote reference changed.")}{" "}
                  {tr("请先重新核对远程引用，再决定是否强推。", "Re-check the remote reference before deciding on another force push.")}
                </div>
              ) : null}

              {!stale && preview ? (
                <div className="vc-p2-section">
                  <div className="vc-p2-meta">
                    {tr("本地", "Local")}
                    <code className="vc-sha">{preview.localShortSha ?? shortShaOf(preview.localSha)}</code>
                    {tr("远程", "Remote")}
                    <code className="vc-sha">{shortShaOf(preview.remoteSha)}</code>
                  </div>
                  {preview.upstream ? (
                    <div className="vc-p2-meta">
                      {tr("跟踪", "Upstream")}
                      {preview.upstream}
                    </div>
                  ) : null}

                  {preview.ahead.length > 0 ? (
                    <>
                      <div className="vc-p2-label">
                        {trf("推送后新增的提交（{0}）", "Commits added to the remote ({0})", preview.ahead.length)}
                      </div>
                      {preview.ahead.slice(0, 10).map((commit) => (
                        <div key={commit.sha} className="vc-p2-commit">
                          <code className="vc-sha">{commit.shortSha}</code>
                          <span>{commit.subject}</span>
                        </div>
                      ))}
                    </>
                  ) : null}

                  {preview.overwritten.length > 0 ? (
                    <div className="vc-p2-danger" role="alert">
                      <div className="vc-p2-label">
                        {trf("远程 {0}/{1} 上这 {2} 个提交会被移除：", "{2} commits on {0}/{1} will be removed:", preview.remote, preview.branch, preview.overwritten.length)}
                      </div>
                      {preview.overwritten.slice(0, 10).map((commit) => (
                        <div key={commit.sha} className="vc-p2-commit">
                          <code className="vc-sha" title={commit.sha}>{commit.shortSha}</code>
                          <code className="vc-sha">{commit.sha}</code>
                          <span>{commit.subject}</span>
                          <span className="vc-p2-meta" title={formatAbsoluteTime(commit.authorAt, locale)}>
                            {commit.authorName} · {formatRelativeTime(commit.authorAt, locale)}
                          </span>
                        </div>
                      ))}
                      {preview.overwritten.length > 10 ? (
                        <div className="vc-p2-meta">
                          {trf("另有 {0} 个提交未列出。", "{0} more commits are not listed.", preview.overwritten.length - 10)}
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  {preview.message ? <div className="vc-p2-note">{preview.message}</div> : null}
                  {!preview.ok ? (
                    <div className="vc-p2-error" role="alert">{preview.error ?? preview.message}</div>
                  ) : null}
                  {preview.stale ? (
                    <div className="vc-p2-danger" role="alert">
                      {tr(
                        "远程引用在核对后已经变化，当前预览不再适用；请重新核对。",
                        "The remote reference changed after this check, so the preview no longer applies; check again.",
                      )}
                    </div>
                  ) : null}
                  {preview.fastForward ? (
                    <div className="vc-p2-note">
                      {tr(
                        "远程可以直接快进，不需要强推；请改用普通 Push。",
                        "The remote can fast-forward, so no force push is needed; use the regular Push instead.",
                      )}
                    </div>
                  ) : null}

                  <label className="vc-p2-label">
                    <input
                      id="vc-p2-force-confirm"
                      type="checkbox"
                      checked={confirmed}
                      disabled={!preview.ok || preview.fastForward || preview.stale}
                      onChange={(event) => setConfirmed(event.target.checked)}
                    />
                    {tr("我已核对待覆盖的提交", "I have reviewed the commits that will be overwritten")}
                  </label>

                  <p className="vc-p2-warn">
                    {tr(
                      "强推会用本地历史覆盖远程分支上列出的提交，这个操作不保证可以撤销；请先确认这些提交在别处保留。",
                      "A force push overwrites the listed commits on the remote branch with local history. It is not guaranteed to be undoable, so make sure those commits are kept elsewhere first.",
                    )}
                  </p>

                  <div className="vc-p2-foot">
                    <button
                      type="button"
                      className="vc-btn vc-btn-danger"
                      disabled={api.busy !== null || !preview.ok || preview.fastForward || preview.stale || !confirmed}
                      onClick={runForcePush}
                    >
                      {api.busy === "force-push"
                        ? tr("推送中…", "Pushing…")
                        : tr("安全强推（--force-with-lease）", "Safe force push (--force-with-lease)")}
                    </button>
                  </div>
                </div>
              ) : null}

              {!stale && forceMessage ? (
                <div className="vc-p2-error" role="alert">{forceMessage}</div>
              ) : null}
            </>
          )}
        </div>
      )}
    </div>
  );
}
