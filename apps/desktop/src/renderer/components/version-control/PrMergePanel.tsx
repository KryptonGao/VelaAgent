import { useEffect, useRef, useState } from "react";
import type {
  AppLocale,
  PrChecksSummary,
  PrMergeMethod,
  PrMergePreview,
  PrReviewState,
  PrState,
  PrSummary,
} from "@vela/shared";
import { tr } from "../../locale";
import type { VersionControlApi } from "../../hooks/useVersionControl";
import { AlertIcon, PrIcon, RefreshIcon } from "../icons";
import { formatRelativeTime } from "./time-format";

/** 面板内的写入结果;页面级提示仍由 useVersionControl 的 notice 承担。 */
type PanelMessage = { ok: boolean; blocked: boolean; message: string };

const prStateLabels: Record<PrState, [string, string]> = {
  open: ["开放", "Open"],
  draft: ["草稿", "Draft"],
  closed: ["已关闭", "Closed"],
  merged: ["已合并", "Merged"],
};

const mergeableLabels: Record<PrMergePreview["mergeable"], [string, string]> = {
  mergeable: ["可合并", "Mergeable"],
  conflicting: ["有冲突", "Conflicting"],
  unknown: ["状态未知", "Unknown"],
};

const checksLabels: Record<PrChecksSummary, [string, string]> = {
  passing: ["通过", "Passing"],
  failing: ["失败", "Failing"],
  pending: ["等待", "Pending"],
  none: ["无检查", "No checks"],
};

const mergeMethodLabels: Record<PrMergeMethod, [string, string]> = {
  merge: ["创建合并提交", "Create a merge commit"],
  squash: ["Squash 合并", "Squash and merge"],
  rebase: ["Rebase 合并", "Rebase and merge"],
};

/** 审阅结论状态文案;过期批准必须能被识别出来。 */
const reviewStateLabels: Record<PrReviewState, [string, string]> = {
  approved: ["已批准", "Approved"],
  changes_requested: ["请求修改", "Changes requested"],
  commented: ["评论", "Commented"],
  dismissed: ["已忽略", "Dismissed"],
  pending: ["待处理", "Pending"],
  unknown: ["未知", "Unknown"],
};

function reviewStateLabel(state: PrReviewState): string {
  const labels = reviewStateLabels[state];
  return tr(labels[0], labels[1]);
}

/** 状态不只靠颜色表达:批准的徽章与需处理/中性的徽章区分。 */
function reviewStateClass(state: PrReviewState): string {
  if (state === "approved") return "vc-badge";
  if (state === "changes_requested") return "vc-badge vc-badge-pending";
  return "vc-badge vc-badge-muted";
}

/** 列表统一显示 7 位短 SHA,便于与 GitHub 上的 head 对照。 */
function shortSha(sha: string | null): string | null {
  return sha ? sha.slice(0, 7) : null;
}

/** 阻止条件里出现冲突或 head 变化时用更醒目的样式。 */
function hasHardBlocker(preview: PrMergePreview): boolean {
  if (preview.mergeable === "conflicting" || !preview.headMatches) return true;
  return preview.blockers.some((blocker) => /冲突|head/i.test(blocker));
}

/**
 * PR 合并与关闭(PR-07):先按 GitHub 当前规则与核对过的 head 展示合并条件,
 * 再允许显式合并;检查全绿或历史批准都不作为可合并的依据。
 */
export function PrMergePanel({
  open,
  onClose,
  api,
  pr,
  locale,
  onChanged,
}: {
  open: boolean;
  onClose(): void;
  api: VersionControlApi;
  pr: PrSummary;
  locale: AppLocale;
  onChanged(): void;
}) {
  const [formOpen, setFormOpen] = useState(false);
  const [method, setMethod] = useState<PrMergeMethod | null>(null);
  const [deleteBranch, setDeleteBranch] = useState(false);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [mergeMessage, setMergeMessage] = useState<PanelMessage | null>(null);
  const [closeComment, setCloseComment] = useState("");
  const [deleteBranchOnClose, setDeleteBranchOnClose] = useState(false);
  const [closeMessage, setCloseMessage] = useState<PanelMessage | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const startedRef = useRef(false);

  // 打开面板或切换 PR 时重新核对;api 每次渲染都是新对象,放进依赖会重复请求。
  useEffect(() => {
    if (!open) return;
    startedRef.current = false;
    setLoadFailed(false);
    setFormOpen(false);
    setMethod(null);
    setDeleteBranch(false);
    setSubject("");
    setBody("");
    setMergeMessage(null);
    setCloseComment("");
    setDeleteBranchOnClose(false);
    setCloseMessage(null);
    api.refreshMergePreview(pr.number);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pr.number]);

  // 只有本轮请求结束且仍没有数据时才算核对失败;不把上一次操作的错误当成本次失败。
  useEffect(() => {
    if (api.mergePreviewLoading) {
      startedRef.current = true;
      return;
    }
    if (!startedRef.current) return;
    startedRef.current = false;
    setLoadFailed(api.mergePreview === null);
  }, [api.mergePreviewLoading, api.mergePreview]);

  if (!open) return null;

  const preview = api.mergePreview;
  const ready = preview?.ok === true;
  const busy = api.busy !== null;
  const state = preview?.state ?? pr.state;
  const canClose = state === "open" || state === "draft";
  const allowedMethods = preview?.allowedMethods ?? [];
  // 用户选择无效(例如规则变化)时回退到默认或首个允许的方式。
  const preferred = method ?? preview?.defaultMethod ?? null;
  const effectiveMethod: PrMergeMethod =
    preferred && allowedMethods.includes(preferred) ? preferred : allowedMethods[0] ?? "merge";
  const outdatedReviews = preview ? preview.reviews.filter((review) => review.outdated).length : 0;
  const retry = () => api.refreshMergePreview(pr.number);

  const submitMerge = () => {
    if (!preview || !preview.canMerge || !preview.headMatches || busy) return;
    const rebase = effectiveMethod === "rebase";
    void api
      .mergePr({
        number: pr.number,
        method: effectiveMethod,
        expectedHeadSha: preview.headSha ?? "",
        deleteBranch,
        subject: rebase ? null : subject.trim() || null,
        body: rebase ? null : body.trim() || null,
      })
      .then((result) => {
        if (!result) return;
        setMergeMessage({ ok: result.ok, blocked: result.blocked, message: result.message });
        if (result.ok && result.merged) {
          // 成功提示由页面级 notice 展示,这里只负责刷新数据并收起面板。
          onChanged();
          onClose();
        }
      });
  };

  const submitClose = () => {
    if (busy || !canClose) return;
    void api
      .closePr({ number: pr.number, comment: closeComment.trim() || null, deleteBranch: deleteBranchOnClose })
      .then((result) => {
        if (!result) return;
        setCloseMessage({ ok: result.ok, blocked: false, message: result.message });
        if (result.ok) {
          onChanged();
          onClose();
        }
      });
  };

  return (
    <div className="vc-popover vc-p2-merge" role="dialog" aria-label={tr("合并与关闭", "Merge and close")}>
      <div className="vc-ops-head">
        <b>
          <PrIcon size={12} /> {tr(`PR #${pr.number} 合并与关闭`, `PR #${pr.number} merge and close`)}
        </b>
        {api.mergePreviewLoading ? <span className="vc-spinner" aria-hidden="true" /> : null}
        <button
          type="button"
          className="vc-icon-btn"
          title={tr("刷新", "Refresh")}
          aria-label={tr("刷新合并条件", "Refresh merge conditions")}
          onClick={retry}
        >
          <RefreshIcon size={11} />
        </button>
        <button type="button" className="vc-link" onClick={onClose}>{tr("关闭", "Close")}</button>
      </div>

      <div className="vc-p2-body">
        {!preview && !loadFailed ? (
          <div className="vc-state">
            <span className="vc-spinner" aria-hidden="true" />
            {tr("正在核对合并条件…", "Checking merge conditions…")}
          </div>
        ) : null}
        {!preview && loadFailed ? (
          <div className="vc-state vc-state-error" role="alert">
            <AlertIcon size={13} />
            <span>{api.error ?? tr("核对合并条件失败", "Could not check the merge conditions")}</span>
            <button type="button" className="vc-link" onClick={retry}>{tr("重试", "Retry")}</button>
          </div>
        ) : null}
        {preview && !preview.ok ? (
          <div className="vc-state vc-state-error" role="alert">
            <AlertIcon size={13} />
            <span>{preview.message || tr("核对合并条件失败", "Could not check the merge conditions")}</span>
            <button type="button" className="vc-link" onClick={retry}>{tr("重试", "Retry")}</button>
          </div>
        ) : null}

        {ready && preview ? (
          <>
            <section className="vc-p2-section">
              <div className="vc-p2-label">{tr("合并条件核对", "Merge conditions")}</div>
              <div className="vc-p2-kv">
                <span>{tr("状态", "State")}</span>
                <b>{tr(prStateLabels[state][0], prStateLabels[state][1])}</b>
                <span>{tr("分支", "Branches")}</span>
                <b>
                  {preview.baseRefName ?? pr.baseRefName} ← {preview.headRefName ?? pr.headRefName}
                </b>
                <span>{tr("GitHub 当前 head", "GitHub head")}</span>
                <b><code className="vc-sha">{shortSha(preview.headSha) ?? tr("未知", "Unknown")}</code></b>
                <span>{tr("本地核对 head", "Checked head")}</span>
                <b>
                  <code className="vc-sha">
                    {shortSha(preview.expectedHeadSha) ?? tr("尚未记录", "Not recorded")}
                  </code>
                </b>
                <span>{tr("head 核对", "Head check")}</span>
                <b>
                  <span className={preview.headMatches ? "vc-badge" : "vc-badge vc-badge-pending"}>
                    {preview.headMatches ? tr("一致", "Matches") : tr("已变化", "Changed")}
                  </span>
                </b>
                <span>{tr("可合并状态", "Mergeable")}</span>
                <b>{tr(mergeableLabels[preview.mergeable][0], mergeableLabels[preview.mergeable][1])}</b>
                <span>{tr("mergeStateStatus", "mergeStateStatus")}</span>
                <b>{preview.mergeStateStatus ?? tr("无", "None")}</b>
                <span>{tr("审阅结论", "Review decision")}</span>
                <b>{preview.reviewDecision ?? tr("无", "None")}</b>
                <span>{tr("当前批准", "Current approvals")}</span>
                <b>{preview.approvals}</b>
                <span>{tr("检查", "Checks")}</span>
                <b>{tr(checksLabels[preview.checks][0], checksLabels[preview.checks][1])}</b>
              </div>
              {!preview.headMatches ? (
                <div className="vc-p2-danger">
                  <b>{tr("head 已变化，不能合并", "The head changed; merging is blocked")}</b>
                  <span>
                    {tr(
                      "GitHub 当前 head 与本次核对的 head 不一致，先重新核对再决定。",
                      "GitHub's current head no longer matches the checked head; re-check before merging.",
                    )}
                  </span>
                </div>
              ) : null}
            </section>

            <section className="vc-p2-section">
              <div className="vc-p2-label">{tr("阻止合并的条件", "Merge blockers")}</div>
              <div className={hasHardBlocker(preview) ? "vc-p2-danger" : "vc-p2-warn"}>
                {preview.blockers.length > 0 ? (
                  <ul className="vc-p2-list">
                    {preview.blockers.map((blocker, index) => (
                      <li key={`${index}:${blocker}`}>{blocker}</li>
                    ))}
                  </ul>
                ) : (
                  <span>{tr("没有已知的阻止条件。", "No known blockers.")}</span>
                )}
              </div>
              <div className="vc-p2-note">
                {preview.rulesNote ??
                  tr(
                    "是否可合并依据 GitHub 当前规则与 head 核对，检查全绿不代表可以合并。",
                    "Whether the PR can merge depends on GitHub's current rules and the head check; green checks alone do not mean it can merge.",
                  )}
              </div>
            </section>

            <section className="vc-p2-section">
              <div className="vc-p2-label">{tr("最近审阅", "Recent reviews")}</div>
              {preview.reviews.length === 0 ? (
                <div className="vc-p2-note">{tr("没有审阅结论", "No reviews")}</div>
              ) : (
                <div className="vc-p2-review-list">
                  {preview.reviews.map((review, index) => (
                    <div
                      key={`${review.author ?? "unknown"}:${review.submittedAt ?? index}`}
                      className="vc-p2-review-item"
                    >
                      <div className="vc-p2-meta">
                        <b>{review.author ?? tr("未知作者", "Unknown author")}</b>
                        <span>
                          {review.submittedAt
                            ? formatRelativeTime(review.submittedAt, locale)
                            : tr("时间未知", "Time unknown")}
                        </span>
                      </div>
                      <div className="vc-p2-row">
                        <span className={reviewStateClass(review.state)}>{reviewStateLabel(review.state)}</span>
                        {review.outdated ? (
                          <span className="vc-badge vc-badge-pending">{tr("已过期", "Outdated")}</span>
                        ) : null}
                        {review.commitSha ? <code className="vc-sha">{shortSha(review.commitSha)}</code> : null}
                      </div>
                      {review.outdated ? (
                        <div className="vc-p2-warn">
                          <span>
                            {tr(
                              "该审阅针对的是较早的代码版本，不能算作当前批准。",
                              "This review targets an older code version and cannot count as a current approval.",
                            )}
                          </span>
                        </div>
                      ) : null}
                      {review.body.trim() ? <p className="vc-p2-review-body">{review.body}</p> : null}
                    </div>
                  ))}
                </div>
              )}
              {outdatedReviews > 0 ? (
                <div className="vc-p2-note">
                  {tr(
                    `有 ${outdatedReviews} 条审阅已过期，未计入当前批准。`,
                    `${outdatedReviews} review(s) are outdated and are not counted as current approvals.`,
                  )}
                </div>
              ) : null}
            </section>

            <section className="vc-p2-section">
              <div className="vc-p2-label">{tr("合并", "Merge")}</div>
              {!formOpen ? (
                <div className="vc-p2-row">
                  <button
                    type="button"
                    className="vc-btn vc-btn-primary"
                    disabled={busy}
                    onClick={() => setFormOpen(true)}
                  >
                    {tr("合并…", "Merge…")}
                  </button>
                  <span className="vc-p2-note">
                    {tr(
                      "合并会按 GitHub 当前规则与核对过的 head 再次校验。",
                      "Merging re-verifies GitHub's current rules and the checked head.",
                    )}
                  </span>
                </div>
              ) : (
                <>
                  {allowedMethods.length === 0 ? (
                    <div className="vc-p2-note">
                      {tr("仓库未允许任何合并方式，无法合并。", "The repository allows no merge method; merging is unavailable.")}
                    </div>
                  ) : (
                    <div className="vc-p2-merge-methods">
                      {allowedMethods.map((item) => (
                        <button
                          key={item}
                          type="button"
                          className={`vc-chip${effectiveMethod === item ? " active" : ""}`}
                          aria-pressed={effectiveMethod === item}
                          onClick={() => setMethod(item)}
                        >
                          {tr(mergeMethodLabels[item][0], mergeMethodLabels[item][1])}
                        </button>
                      ))}
                    </div>
                  )}
                  <label className="vc-p2-check">
                    <input
                      type="checkbox"
                      checked={deleteBranch}
                      onChange={(event) => setDeleteBranch(event.target.checked)}
                    />
                    {tr("合并后删除对应分支（本地与远程）", "Delete the branch locally and remotely after merging")}
                  </label>
                  {effectiveMethod === "rebase" ? (
                    <div className="vc-p2-note">
                      {tr("Rebase 合并不支持自定义标题与说明。", "A rebase merge does not support a custom title or message.")}
                    </div>
                  ) : (
                    <>
                      <input
                        className="vc-input"
                        aria-label={tr("合并提交标题", "Merge commit title")}
                        placeholder={tr("标题（可选）", "Title (optional)")}
                        value={subject}
                        onChange={(event) => setSubject(event.target.value)}
                      />
                      <textarea
                        className="vc-input vc-p2-textarea"
                        aria-label={tr("合并提交说明", "Merge commit message")}
                        placeholder={tr("说明（可选）", "Message (optional)")}
                        value={body}
                        onChange={(event) => setBody(event.target.value)}
                      />
                    </>
                  )}
                  {!preview.headMatches ? (
                    <div className="vc-p2-danger">
                      {tr(
                        "head 已变化：本次核对的是较早的代码版本，禁止合并。",
                        "The head changed: this check is based on an older code version, so merging is disabled.",
                      )}
                    </div>
                  ) : null}
                  {mergeMessage ? (
                    <div className={mergeMessage.ok ? "vc-p2-note" : "vc-p2-error"} role="status">
                      <span>{mergeMessage.message}</span>
                      {mergeMessage.blocked ? (
                        <button type="button" className="vc-link" onClick={retry}>
                          {tr("重新核对", "Re-check")}
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                  {!preview.canMerge ? (
                    <div className="vc-p2-note">
                      {tr("当前条件不允许合并，请先处理上面的阻止条件。", "Merging is not allowed right now; resolve the blockers above first.")}
                    </div>
                  ) : null}
                  <div className="vc-p2-foot">
                    <button type="button" className="vc-btn vc-btn-ghost" onClick={() => setFormOpen(false)}>
                      {tr("收起", "Hide")}
                    </button>
                    <button
                      type="button"
                      className="vc-btn vc-btn-primary"
                      disabled={!preview.canMerge || !preview.headMatches || busy}
                      onClick={submitMerge}
                    >
                      {api.busy === "pr-merge" ? tr("合并中…", "Merging…") : tr("确认合并", "Merge")}
                    </button>
                  </div>
                </>
              )}
            </section>

            <section className="vc-p2-section">
              <div className="vc-p2-label">{tr("关闭 Pull Request", "Close pull request")}</div>
              <textarea
                className="vc-input vc-p2-textarea"
                aria-label={tr("关闭说明", "Closing comment")}
                placeholder={tr("关闭说明（可选）", "Closing comment (optional)")}
                value={closeComment}
                onChange={(event) => setCloseComment(event.target.value)}
              />
              <label className="vc-p2-check">
                <input
                  type="checkbox"
                  checked={deleteBranchOnClose}
                  onChange={(event) => setDeleteBranchOnClose(event.target.checked)}
                />
                {tr("同时删除对应分支（本地与远程）", "Also delete the branch locally and remotely")}
              </label>
              <div className="vc-inline-notice">
                <AlertIcon size={12} />
                {tr(
                  "关闭不会删除任何提交，也不会删除本地分支，并且不能在这里撤销；需要时在 GitHub 上重新打开。",
                  "Closing deletes no commits and keeps the local branch; it cannot be undone here. Reopen it on GitHub if needed.",
                )}
              </div>
              {closeMessage ? (
                <div className={closeMessage.ok ? "vc-p2-note" : "vc-p2-error"} role="status">
                  {closeMessage.message}
                </div>
              ) : null}
              <div className="vc-p2-foot">
                <button
                  type="button"
                  className="vc-btn vc-btn-ghost"
                  disabled={busy || !canClose}
                  onClick={submitClose}
                >
                  {api.busy === "pr-close" ? tr("关闭中…", "Closing…") : tr("关闭 Pull Request", "Close pull request")}
                </button>
              </div>
              {!canClose ? (
                <div className="vc-p2-note">
                  {tr(
                    "该 PR 当前不是开放状态，无法从这里合并或关闭。",
                    "This PR is not open; it cannot be merged or closed from here.",
                  )}
                </div>
              ) : null}
            </section>
          </>
        ) : null}
      </div>
    </div>
  );
}
