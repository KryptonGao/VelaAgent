import { useEffect, useRef, useState } from "react";
import type { AppLocale, PrReviewComment, PrReviewEvent, PrReviewState, PrReviewSummary, PrSummary } from "@vela/shared";
import { tr, trf } from "../../locale";
import type { VersionControlApi } from "../../hooks/useVersionControl";
import { AlertIcon, PrIcon, RefreshIcon } from "../icons";
import { formatRelativeTime } from "./time-format";

/** 线程列表筛选;全部为默认,其余按本地数据过滤。 */
type ReviewFilter = "all" | "unresolved" | "resolved" | "outdated";

/** 面板内的写入结果;页面级提示仍由 useVersionControl 的 notice 承担。 */
type PanelMessage = { ok: boolean; message: string };

/** 审阅结论状态文案;unknown 明确显示为未知,不当作批准。 */
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

/** 列表统一显示 7 位短 SHA,便于与 GitHub 上的代码版本对照。 */
function shortSha(sha: string | null): string | null {
  return sha ? sha.slice(0, 7) : null;
}

/**
 * 当前批准数:每个作者只取最后一条结论,且必须未过期并针对当前 head。
 * 过期批准或被新审阅取代的结论都不算当前批准。
 */
function currentApprovalCount(reviews: PrReviewSummary[], headSha: string | null): number {
  const latestByAuthor = new Map<string, PrReviewSummary>();
  for (const review of reviews) latestByAuthor.set(review.author ?? "", review);
  let count = 0;
  for (const review of latestByAuthor.values()) {
    if (review.state !== "approved" || review.outdated) continue;
    if (headSha !== null && review.commitSha !== headSha) continue;
    count += 1;
  }
  return count;
}

/** 正文默认折叠到 3 行;内容不足 3 行时不给展开入口。 */
function CollapsibleText({ text, className }: { text: string; className: string }) {
  const [expanded, setExpanded] = useState(false);
  if (!text.trim()) return null;
  const lines = text.split("\n");
  const collapsible = lines.length > 3;
  const visible = expanded || !collapsible ? text : lines.slice(0, 3).join("\n");
  return (
    <>
      <p className={className}>{visible}</p>
      {collapsible ? (
        <button
          type="button"
          className="vc-link"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? tr("收起", "Collapse") : tr("展开", "Expand")}
        </button>
      ) : null}
    </>
  );
}

/** 一条评论:作者、时间、正文与可展开的代码片段;回复缩进显示。 */
function CommentItem({
  comment,
  locale,
  isReply = false,
}: {
  comment: PrReviewComment;
  locale: AppLocale;
  isReply?: boolean;
}) {
  const [showHunk, setShowHunk] = useState(false);
  return (
    <div className={`vc-p2-comment${isReply ? " is-reply" : ""}`}>
      <div className="vc-p2-meta">
        <b>{comment.author ?? tr("未知作者", "Unknown author")}</b>
        {comment.createdAt ? <span>{formatRelativeTime(comment.createdAt, locale)}</span> : null}
        {comment.path ? (
          <span>{comment.line === null ? comment.path : `${comment.path}:${comment.line}`}</span>
        ) : null}
        {comment.outdated ? <span className="vc-badge vc-badge-pending">{tr("已过期", "Outdated")}</span> : null}
      </div>
      <CollapsibleText text={comment.body} className="vc-p2-comment-body" />
      {comment.diffHunk ? (
        <>
          <button
            type="button"
            className="vc-link"
            aria-expanded={showHunk}
            onClick={() => setShowHunk((value) => !value)}
          >
            {showHunk ? tr("收起代码", "Hide code") : tr("查看代码", "View code")}
          </button>
          {showHunk ? <pre className="vc-p2-hunk">{comment.diffHunk}</pre> : null}
        </>
      ) : null}
      {comment.replies.map((reply) => (
        <CommentItem key={reply.id} comment={reply} locale={locale} isReply />
      ))}
    </div>
  );
}

/**
 * PR 评论与审阅(PR-06):审阅结论、审阅线程、参与讨论与提交审阅。
 * 每条结论与线程都显示对应代码版本;过期结论单独标记,不能算作当前批准。
 */
export function PrReviewPanel({
  open,
  onClose,
  api,
  pr,
  locale,
}: {
  open: boolean;
  onClose(): void;
  api: VersionControlApi;
  pr: PrSummary;
  locale: AppLocale;
}) {
  const [filter, setFilter] = useState<ReviewFilter>("all");
  const [commentBody, setCommentBody] = useState("");
  const [commentResult, setCommentResult] = useState<PanelMessage | null>(null);
  const [reviewBody, setReviewBody] = useState("");
  const [reviewResult, setReviewResult] = useState<PanelMessage | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const startedRef = useRef(false);

  // 打开面板或切换 PR 时重新取数;api 每次渲染都是新对象,放进依赖会重复请求。
  useEffect(() => {
    if (!open) return;
    startedRef.current = false;
    setLoadFailed(false);
    setFilter("all");
    setCommentBody("");
    setCommentResult(null);
    setReviewBody("");
    setReviewResult(null);
    api.refreshReviewThreads(pr.number);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pr.number]);

  // 只有本轮请求结束且仍没有数据时才算读取失败;不把上一次操作的错误当成本次失败。
  useEffect(() => {
    if (api.reviewThreadsLoading) {
      startedRef.current = true;
      return;
    }
    if (!startedRef.current) return;
    startedRef.current = false;
    setLoadFailed(api.reviewThreads === null);
  }, [api.reviewThreadsLoading, api.reviewThreads]);

  if (!open) return null;

  const data = api.reviewThreads;
  const ready = data?.ok === true;
  const busy = api.busy !== null;
  const headSha = data?.headSha ?? null;
  const reviews = data?.reviews ?? [];
  const allThreads = data?.threads ?? [];
  const approvals = currentApprovalCount(reviews, headSha);
  const threads = allThreads.filter((thread) => {
    if (filter === "unresolved") return !thread.resolved;
    if (filter === "resolved") return thread.resolved;
    if (filter === "outdated") return thread.outdated;
    return true;
  });
  const filters: { key: ReviewFilter; label: string }[] = [
    { key: "all", label: tr("全部", "All") },
    { key: "unresolved", label: tr("未解决", "Unresolved") },
    { key: "resolved", label: tr("已解决", "Resolved") },
    { key: "outdated", label: tr("已过期", "Outdated") },
  ];
  const retry = () => api.refreshReviewThreads(pr.number);

  const submitComment = () => {
    const body = commentBody.trim();
    if (!body || busy) return;
    void api.commentPr({ number: pr.number, body }).then((result) => {
      if (!result) return;
      setCommentResult({ ok: result.ok, message: result.message });
      if (result.ok) setCommentBody("");
    });
  };

  const submitReview = (event: PrReviewEvent) => {
    const body = reviewBody.trim();
    // 请求修改必须说明原因;按钮已禁用,这里再拦一次,避免空说明写入 GitHub。
    if (busy || (event === "request-changes" && !body)) return;
    void api
      .reviewPr({ number: pr.number, event, body: body || null, commitSha: headSha })
      .then((result) => {
        if (!result) return;
        setReviewResult({ ok: result.ok, message: result.message });
        if (result.ok) setReviewBody("");
      });
  };

  return (
    <div className="vc-popover vc-p2-review" role="dialog" aria-label={tr("评论与审阅", "Comments and reviews")}>
      <div className="vc-ops-head">
        <b>
          <PrIcon size={12} /> {trf("PR #{0} 评论与审阅", "PR #{0} comments and reviews", pr.number)}
        </b>
        {api.reviewThreadsLoading ? <span className="vc-spinner" aria-hidden="true" /> : null}
        <button
          type="button"
          className="vc-icon-btn"
          title={tr("刷新", "Refresh")}
          aria-label={tr("刷新评论与审阅", "Refresh comments and reviews")}
          onClick={retry}
        >
          <RefreshIcon size={11} />
        </button>
        <button type="button" className="vc-link" onClick={onClose}>{tr("关闭", "Close")}</button>
      </div>

      <div className="vc-p2-body">
        {!data && !loadFailed ? (
          <div className="vc-state">
            <span className="vc-spinner" aria-hidden="true" />
            {tr("正在读取评论与审阅…", "Loading comments and reviews…")}
          </div>
        ) : null}
        {!data && loadFailed ? (
          <div className="vc-state vc-state-error" role="alert">
            <AlertIcon size={13} />
            <span>{api.error ?? tr("读取评论与审阅失败", "Could not load comments and reviews")}</span>
            <button type="button" className="vc-link" onClick={retry}>{tr("重试", "Retry")}</button>
          </div>
        ) : null}
        {data && !data.ok ? (
          <div className="vc-state vc-state-error" role="alert">
            <AlertIcon size={13} />
            <span>{data.message || tr("读取评论与审阅失败", "Could not load comments and reviews")}</span>
            <button type="button" className="vc-link" onClick={retry}>{tr("重试", "Retry")}</button>
          </div>
        ) : null}

        {ready && data ? (
          <div className="vc-p2-meta">
            <span>{tr("审阅结论", "Review decision")} <b>{data.reviewDecision ?? tr("无", "None")}</b></span>
            <span>{tr("当前批准", "Current approvals")} <b>{approvals}</b></span>
            <span>
              {tr("head 代码版本", "Head code version")}{" "}
              <b>{shortSha(headSha) ?? tr("未知", "Unknown")}</b>
            </span>
            <span>
              {tr("未提交结论的审阅者", "Reviewers without a decision")}{" "}
              <b>{data.pendingReviewers.length > 0 ? data.pendingReviewers.join(", ") : tr("无", "None")}</b>
            </span>
          </div>
        ) : null}

        {ready && data ? (
          <section className="vc-p2-section">
            <div className="vc-p2-label">{tr("审阅结论", "Reviews")}</div>
            {reviews.length === 0 ? (
              <div className="vc-p2-note">{tr("还没有审阅结论", "No reviews yet")}</div>
            ) : (
              <div className="vc-p2-review-list">
                {reviews.map((review, index) => (
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
                      {review.rawState ? <span>{review.rawState}</span> : null}
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
                        <b>{tr("该审阅已过期", "This review is outdated")}</b>
                        <span>
                          {tr(
                            "该审阅针对的是较早的代码版本，不能算作当前批准。",
                            "This review targets an older code version and cannot count as a current approval.",
                          )}
                        </span>
                      </div>
                    ) : null}
                    <CollapsibleText text={review.body} className="vc-p2-review-body" />
                  </div>
                ))}
              </div>
            )}
          </section>
        ) : null}

        {ready && data ? (
          <section className="vc-p2-section">
            <div className="vc-p2-label">{tr("审阅线程", "Review threads")}</div>
            <div className="vc-p2-row">
              {filters.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className={`vc-chip${filter === item.key ? " active" : ""}`}
                  aria-pressed={filter === item.key}
                  onClick={() => setFilter(item.key)}
                >
                  {item.label}
                </button>
              ))}
            </div>
            {allThreads.length === 0 ? (
              <div className="vc-state">{tr("还没有评论", "No comments yet")}</div>
            ) : threads.length === 0 ? (
              <div className="vc-state">{tr("当前筛选下没有审阅线程", "No review threads match this filter")}</div>
            ) : (
              <div className="vc-p2-thread-list">
                {threads.map((thread) => (
                  <div key={thread.id} className={`vc-p2-thread${thread.resolved ? " resolved" : ""}`}>
                    <div className="vc-p2-row">
                      <b>
                        {thread.path
                          ? thread.line === null
                            ? thread.path
                            : `${thread.path}:${thread.line}`
                          : tr("会话评论", "Conversation comment")}
                      </b>
                      {thread.commitSha ? <code className="vc-sha">{shortSha(thread.commitSha)}</code> : null}
                      {thread.outdated ? (
                        <span className="vc-badge vc-badge-pending">{tr("已过期", "Outdated")}</span>
                      ) : null}
                      <span className={`vc-badge ${thread.resolved ? "vc-badge-muted" : "vc-badge-pending"}`}>
                        {thread.resolved ? tr("已解决", "Resolved") : tr("未解决", "Unresolved")}
                      </span>
                      {thread.resolved && thread.resolvedBy ? (
                        <span className="vc-p2-note">
                          {trf("由 {0} 解决", "Resolved by {0}", thread.resolvedBy)}
                        </span>
                      ) : null}
                    </div>
                    {thread.comments.map((comment) => (
                      <CommentItem key={comment.id} comment={comment} locale={locale} />
                    ))}
                    <div className="vc-p2-row">
                      <button
                        type="button"
                        className="vc-btn vc-btn-ghost"
                        disabled={!thread.resolvable || busy}
                        onClick={() =>
                          void api.resolvePrThread({ threadId: thread.id, resolved: !thread.resolved })
                        }
                      >
                        {thread.resolved ? tr("重新打开", "Reopen") : tr("解决", "Resolve")}
                      </button>
                      {!thread.resolvable ? (
                        <span className="vc-p2-note">
                          {tr(
                            "该线程当前不可解决（缺少权限或讨论已锁定）。",
                            "This thread cannot be resolved here (missing permission or locked discussion).",
                          )}
                        </span>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        ) : null}

        <section className="vc-p2-section">
          <div className="vc-p2-label">{tr("参与讨论", "Join the discussion")}</div>
          <textarea
            className="vc-input vc-p2-textarea"
            aria-label={tr("评论内容", "Comment body")}
            placeholder={tr("写下评论…", "Write a comment…")}
            value={commentBody}
            onChange={(event) => setCommentBody(event.target.value)}
          />
          <div className="vc-p2-foot">
            {commentResult ? (
              <span className={commentResult.ok ? "vc-p2-note" : "vc-p2-error"} role="status">
                {commentResult.message}
              </span>
            ) : null}
            <button
              type="button"
              className="vc-btn vc-btn-primary"
              disabled={busy || !commentBody.trim()}
              onClick={submitComment}
            >
              {api.busy === "pr-comment" ? tr("发表中…", "Posting…") : tr("发表评论", "Comment")}
            </button>
          </div>
        </section>

        <section className="vc-p2-section">
          <div className="vc-p2-label">{tr("提交审阅", "Submit a review")}</div>
          <div className="vc-p2-meta">
            <span>
              {tr("审阅代码版本", "Review code version")}{" "}
              <code className="vc-sha">{shortSha(headSha) ?? tr("未知", "Unknown")}</code>
            </span>
            <span>{tr("审阅结果按该代码版本记录", "The review is recorded against this code version")}</span>
          </div>
          <textarea
            className="vc-input vc-p2-textarea"
            aria-label={tr("审阅说明", "Review note")}
            placeholder={tr("审阅说明（可选）", "Review note (optional)")}
            value={reviewBody}
            onChange={(event) => setReviewBody(event.target.value)}
          />
          {!reviewBody.trim() ? (
            <div className="vc-p2-note">{tr("请求修改必须填写说明。", "Requesting changes requires a note.")}</div>
          ) : null}
          <div className="vc-p2-foot">
            {reviewResult ? (
              <span className={reviewResult.ok ? "vc-p2-note" : "vc-p2-error"} role="status">
                {reviewResult.message}
              </span>
            ) : null}
            <button type="button" className="vc-btn" disabled={busy} onClick={() => submitReview("approve")}>
              {api.busy === "pr-review" ? tr("提交中…", "Submitting…") : tr("批准", "Approve")}
            </button>
            <button
              type="button"
              className="vc-btn"
              disabled={busy || !reviewBody.trim()}
              onClick={() => submitReview("request-changes")}
            >
              {tr("请求修改", "Request changes")}
            </button>
            <button
              type="button"
              className="vc-btn vc-btn-ghost"
              disabled={busy}
              onClick={() => submitReview("comment")}
            >
              {tr("仅评论", "Comment only")}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
