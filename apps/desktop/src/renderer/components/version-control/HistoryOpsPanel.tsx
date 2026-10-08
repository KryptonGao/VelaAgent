import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AppLocale,
  GitBranchAtResult,
  GitCommitFileChange,
  GitCommitSummary,
  GitFileStatus,
  GitHistoryAction,
  GitHistoryOpPreview,
  GitHistoryOpResult,
  GitRewriteAction,
  GitRewritePreview,
  GitRewriteResult,
} from "@vela/shared";
import { tr, trf } from "../../locale";
import type { VersionControlApi } from "../../hooks/useVersionControl";
import { AlertIcon, BranchIcon, CheckIcon, CommitIcon, DiffIcon, RefreshIcon } from "../icons";
import { formatAbsoluteTime, formatRelativeTime } from "./time-format";

type HistoryOpsTab = "history" | "rewrite" | "branch";

/** 整理预览默认直接展示的提交行数,其余折叠。 */
const rewriteRowLimit = 8;
/** 整理预览的防抖时间(毫秒),避免输入提交信息时每次按键都取数。 */
const rewriteDebounceMs = 250;

/** 提交短 SHA;列表里已有该提交时优先沿用列表给出的 shortSha。 */
function shortShaOf(sha: string): string {
  return sha.slice(0, 7);
}

/** 文件状态的中英文案,用于状态字母的 title 与 aria-label。 */
function statusText(status: GitFileStatus): string {
  if (status === "added") return tr("新增", "Added");
  if (status === "deleted") return tr("删除", "Deleted");
  if (status === "renamed") return tr("重命名", "Renamed");
  if (status === "untracked") return tr("未跟踪", "Untracked");
  if (status === "conflicted") return tr("冲突", "Conflicted");
  return tr("修改", "Modified");
}

/** 预览文件行:状态字母、路径(重命名显示旧路径)与行数增减。 */
function PreviewFileRow({ file }: { file: GitCommitFileChange }) {
  const letter = file.status.slice(0, 1).toUpperCase();
  const statusLabel = statusText(file.status);
  return (
    <div className="vc-p2-file">
      <span className={`vc-status vc-status-${file.status}`} title={statusLabel} aria-label={statusLabel}>
        {letter}
      </span>
      <span className="vc-p2-path" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>
        {file.oldPath && file.status === "renamed" ? `${file.oldPath} → ${file.path}` : file.path}
      </span>
      <span className="vc-stats">
        <b className="vc-plus">+{file.addedLines}</b> <b className="vc-minus">−{file.deletedLines}</b>
      </span>
    </div>
  );
}

/**
 * 历史节点操作面板:P2 的三个入口合并在一个浮层里。
 * HI-03/HI-04:撤销或拣选所选提交,先预览范围,合并提交必须选定对比父提交;
 * CT-06:fixup/squash 整理,展示会被重写的提交与已推送数量,从不自动推送;
 * HI-02:从所选提交创建分支,默认只写引用、不动 HEAD 与未提交内容。
 * 所有写操作都通过 api 执行,并用 api.busy 禁用按钮,服务端返回什么就展示什么。
 */
export function HistoryOpsPanel({
  open,
  onClose,
  api,
  commit,
  commits,
  branch,
  locale,
  onOpenConflict,
  onChanged,
}: {
  open: boolean;
  onClose(): void;
  api: VersionControlApi;
  commit: GitCommitSummary | null;
  commits: GitCommitSummary[];
  branch: string | null;
  locale: AppLocale;
  onOpenConflict(): void;
  onChanged(): void;
}) {
  const [tab, setTab] = useState<HistoryOpsTab>("history");
  // ---- HI-03/HI-04:撤销 / 拣选 ----
  const [action, setAction] = useState<GitHistoryAction>("revert");
  const [mainline, setMainline] = useState<number | null>(null);
  const [historyPreview, setHistoryPreview] = useState<GitHistoryOpPreview | null>(null);
  const [historyPreviewLoading, setHistoryPreviewLoading] = useState(false);
  const [historyResult, setHistoryResult] = useState<GitHistoryOpResult | null>(null);
  // ---- CT-06:提交整理 ----
  const [rewriteAction, setRewriteAction] = useState<GitRewriteAction>("fixup");
  const [targetSha, setTargetSha] = useState<string | null>(null);
  const [rewriteMessage, setRewriteMessage] = useState("");
  const [rewritePreview, setRewritePreview] = useState<GitRewritePreview | null>(null);
  const [rewritePreviewLoading, setRewritePreviewLoading] = useState(false);
  const [rewriteResult, setRewriteResult] = useState<GitRewriteResult | null>(null);
  const [rewriteExpanded, setRewriteExpanded] = useState(false);
  // ---- HI-02:从该提交创建分支 ----
  const [branchName, setBranchName] = useState("");
  const [checkout, setCheckout] = useState(false);
  const [branchResult, setBranchResult] = useState<GitBranchAtResult | null>(null);
  // 只读预览的刷新序号:预览不占用 api.busy,用序号丢弃过期结果。
  const [historyNonce, setHistoryNonce] = useState(0);
  const [rewriteNonce, setRewriteNonce] = useState(0);
  const historySeq = useRef(0);
  const rewriteSeq = useRef(0);
  const apiRef = useRef(api);
  apiRef.current = api;

  const sourceSha = commit?.sha ?? null;
  const parentCount = commit?.parents.length ?? 0;
  const isMerge = parentCount > 1;
  const commitBySha = useMemo(() => new Map(commits.map((item) => [item.sha, item])), [commits]);

  // 整理目标必须早于 source(服务端要求 target 是 source 的祖先)。
  // commits 新的在前,所以候选是 source 之后的那些提交,默认取紧随 source 的更早提交。
  const sourceIndex = useMemo(
    () => (sourceSha ? commits.findIndex((item) => item.sha === sourceSha) : -1),
    [commits, sourceSha],
  );
  const olderTargets = useMemo(
    () => (sourceIndex >= 0 ? commits.slice(sourceIndex + 1) : []),
    [commits, sourceIndex],
  );
  const defaultTargetSha = olderTargets[0]?.sha ?? "";
  const effectiveTargetSha =
    targetSha && olderTargets.some((item) => item.sha === targetSha) ? targetSha : defaultTargetSha;

  // 打开面板或切换所选提交时重置全部本地状态,避免上一个提交的预览与结果串到新目标。
  useEffect(() => {
    if (!open) return;
    historySeq.current += 1;
    rewriteSeq.current += 1;
    setTab("history");
    setAction("revert");
    setMainline(null);
    setHistoryPreview(null);
    setHistoryPreviewLoading(false);
    setHistoryResult(null);
    setRewriteAction("fixup");
    setTargetSha(null);
    setRewriteMessage("");
    setRewritePreview(null);
    setRewritePreviewLoading(false);
    setRewriteResult(null);
    setRewriteExpanded(false);
    setBranchName("");
    setCheckout(false);
    setBranchResult(null);
    setHistoryNonce(0);
    setRewriteNonce(0);
  }, [open, sourceSha]);

  // 撤销 / 拣选的范围预览:动作、父提交选择或手动刷新时重新取数。
  useEffect(() => {
    if (!open || tab !== "history" || !sourceSha) return;
    if (isMerge && mainline === null) {
      // 合并提交必须先选定对比父提交,未选择前不发起预览。
      setHistoryPreview(null);
      setHistoryPreviewLoading(false);
      return;
    }
    let cancelled = false;
    const seq = ++historySeq.current;
    setHistoryPreviewLoading(true);
    void apiRef.current
      .previewHistoryOp({ action, sha: sourceSha, mainline: isMerge ? mainline : null })
      .then((preview) => {
        if (cancelled || seq !== historySeq.current) return;
        setHistoryPreview(preview);
        setHistoryPreviewLoading(false);
      });
    return () => {
      cancelled = true;
      setHistoryPreviewLoading(false);
    };
  }, [open, tab, sourceSha, isMerge, action, mainline, historyNonce]);

  // 整理范围预览:动作 / 目标 / 提交信息变化后防抖取数,序号保证只有最后一次生效。
  useEffect(() => {
    if (!open || tab !== "rewrite" || !sourceSha || !effectiveTargetSha) {
      setRewritePreviewLoading(false);
      return;
    }
    let cancelled = false;
    setRewritePreviewLoading(true);
    const timer = window.setTimeout(() => {
      const seq = ++rewriteSeq.current;
      void apiRef.current
        .previewRewrite({
          action: rewriteAction,
          sourceSha,
          targetSha: effectiveTargetSha,
          message: rewriteAction === "squash" ? rewriteMessage.trim() || null : null,
        })
        .then((preview) => {
          if (cancelled || seq !== rewriteSeq.current) return;
          setRewritePreview(preview);
          setRewritePreviewLoading(false);
        });
    }, rewriteDebounceMs);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      setRewritePreviewLoading(false);
    };
  }, [open, tab, sourceSha, rewriteAction, effectiveTargetSha, rewriteMessage, rewriteNonce]);

  // 换目标或换动作后收起提交列表。
  useEffect(() => {
    setRewriteExpanded(false);
  }, [rewriteAction, effectiveTargetSha, sourceSha]);

  if (!open) return null;

  // 只有与当前动作一致的预览才允许执行,避免用过期预览做出决定。
  const activeHistoryPreview = historyPreview && historyPreview.action === action ? historyPreview : null;
  const activeRewritePreview =
    rewritePreview && rewritePreview.action === rewriteAction && rewritePreview.target.sha === effectiveTargetSha
      ? rewritePreview
      : null;

  const refreshPreview = () => {
    if (tab === "history") setHistoryNonce((value) => value + 1);
    else if (tab === "rewrite") setRewriteNonce((value) => value + 1);
  };

  const runHistory = () => {
    if (!sourceSha) return;
    void api
      .runHistoryOp({ action, sha: sourceSha, mainline: isMerge ? mainline : null })
      .then((result) => {
        setHistoryResult(result);
        if (result?.ok) onChanged();
      });
  };

  const runRewriteOp = () => {
    if (!sourceSha || !effectiveTargetSha) return;
    void api
      .runRewrite({
        action: rewriteAction,
        sourceSha,
        targetSha: effectiveTargetSha,
        message: rewriteAction === "squash" ? rewriteMessage.trim() || null : null,
      })
      .then((result) => {
        setRewriteResult(result);
        if (result?.ok) onChanged();
      });
  };

  const createBranchAtCommit = () => {
    if (!commit) return;
    const name = branchName.trim();
    if (!name) return;
    void api.createBranchAt({ name, startPoint: commit.sha, checkout }).then((result) => {
      setBranchResult(result);
      if (result?.ok) {
        setBranchName("");
        onChanged();
      }
    });
  };

  const selectCommitHint = <div className="vc-state">{tr("先在上方选择一个提交", "Select a commit first")}</div>;

  return (
    <div className="vc-popover vc-p2-history" role="dialog" aria-label={tr("历史操作", "History actions")}>
      <div className="vc-ops-head">
        <b>
          <CommitIcon size={12} /> {tr("历史操作", "History actions")}
        </b>
        {tab === "branch" ? null : (
          <button
            type="button"
            className="vc-icon-btn"
            title={tr("刷新预览", "Refresh preview")}
            aria-label={tr("刷新预览", "Refresh preview")}
            onClick={refreshPreview}
          >
            <RefreshIcon size={12} />
          </button>
        )}
        <button type="button" className="vc-link" onClick={onClose}>
          {tr("关闭", "Close")}
        </button>
      </div>

      <div className="vc-p2-tabs" role="tablist" aria-label={tr("历史操作分类", "History action tabs")}>
        <button
          type="button"
          role="tab"
          className={tab === "history" ? "vc-chip active" : "vc-chip"}
          aria-selected={tab === "history"}
          onClick={() => setTab("history")}
        >
          {tr("撤销 / 拣选", "Revert / Cherry-pick")}
        </button>
        <button
          type="button"
          role="tab"
          className={tab === "rewrite" ? "vc-chip active" : "vc-chip"}
          aria-selected={tab === "rewrite"}
          onClick={() => setTab("rewrite")}
        >
          {tr("提交整理", "Rewrite commits")}
        </button>
        <button
          type="button"
          role="tab"
          className={tab === "branch" ? "vc-chip active" : "vc-chip"}
          aria-selected={tab === "branch"}
          onClick={() => setTab("branch")}
        >
          {tr("从该提交创建分支", "Create branch here")}
        </button>
      </div>

      <div className="vc-p2-body">
        {tab === "history" ? (
          <>
            {commit ? (
              <>
                <div className="vc-p2-section">
                  <div className="vc-p2-label">{tr("操作", "Action")}</div>
                  <div className="vc-p2-tabs" role="group" aria-label={tr("选择历史操作", "Choose a history action")}>
                    <button
                      type="button"
                      className={action === "revert" ? "vc-chip active" : "vc-chip"}
                      aria-pressed={action === "revert"}
                      onClick={() => {
                        setAction("revert");
                        setHistoryResult(null);
                      }}
                    >
                      {tr("撤销该提交", "Revert this commit")}
                    </button>
                    <button
                      type="button"
                      className={action === "cherry-pick" ? "vc-chip active" : "vc-chip"}
                      aria-pressed={action === "cherry-pick"}
                      onClick={() => {
                        setAction("cherry-pick");
                        setHistoryResult(null);
                      }}
                    >
                      {tr("拣选到当前分支", "Cherry-pick onto the current branch")}
                    </button>
                  </div>
                  <div className="vc-p2-meta">
                    <span>
                      {tr("提交", "Commit")} <code className="vc-sha">{commit.shortSha}</code> {commit.subject}
                    </span>
                  </div>
                </div>

                {isMerge ? (
                  <div className="vc-p2-section">
                    <div className="vc-p2-label">{tr("对比父提交", "Compare against parent")}</div>
                    <select
                      className="vc-select"
                      aria-label={tr("对比父提交", "Compare against parent")}
                      value={mainline ?? ""}
                      onChange={(event) => {
                        setMainline(event.target.value ? Number.parseInt(event.target.value, 10) : null);
                        setHistoryResult(null);
                      }}
                    >
                      <option value="">{tr("请选择父提交", "Choose a parent commit")}</option>
                      {commit.parents.map((parent, index) => {
                        const known = commitBySha.get(parent);
                        return (
                          <option key={parent} value={index + 1}>
                            {`${index + 1} · ${known?.shortSha ?? shortShaOf(parent)}`}
                            {known ? ` · ${known.subject}` : ""}
                          </option>
                        );
                      })}
                    </select>
                    <p className="vc-hint">
                      {trf("这是合并提交，共有 {0} 个父提交，必须选定一个作为对比依据。", "This is a merge commit with {0} parents; choose the one to compare against.", parentCount)}
                    </p>
                  </div>
                ) : null}

                <div className="vc-p2-section">
                  <div className="vc-p2-label">
                    <DiffIcon size={11} /> {tr("影响范围", "Impact")}
                  </div>
                  {historyPreviewLoading ? (
                    <div className="vc-state">{tr("正在读取操作范围…", "Loading the operation scope…")}</div>
                  ) : null}
                  {!historyPreviewLoading && !activeHistoryPreview ? (
                    <div className="vc-state">
                      {isMerge && mainline === null
                        ? tr("选择对比父提交后显示预览", "Choose a parent commit to see the preview")
                        : tr("暂时无法读取操作范围", "The operation scope is not available")}
                    </div>
                  ) : null}
                  {activeHistoryPreview ? (
                    <>
                      <div className="vc-p2-meta">
                        <span>
                          {tr("操作", "Action")}{" "}
                          <b>
                            {activeHistoryPreview.action === "revert"
                              ? tr("撤销", "Revert")
                              : tr("拣选", "Cherry-pick")}
                          </b>
                        </span>
                        <span>
                          {tr("目标分支", "Target branch")}{" "}
                          <b>{activeHistoryPreview.branch ?? tr("detached HEAD", "detached HEAD")}</b>
                        </span>
                        <span>
                          {tr("文件", "Files")} <b>{activeHistoryPreview.fileCount}</b>
                        </span>
                        <span className="vc-stats">
                          <b className="vc-plus">+{activeHistoryPreview.addedLines}</b>{" "}
                          <b className="vc-minus">−{activeHistoryPreview.deletedLines}</b>
                        </span>
                      </div>
                      {activeHistoryPreview.branch === null ? (
                        <div className="vc-p2-warn" role="alert">
                          <span>
                            <AlertIcon size={11} />{" "}
                            {tr(
                              "当前处于 detached HEAD，没有可用的目标分支，请先切换或创建分支。",
                              "HEAD is detached, so there is no target branch. Switch to or create a branch first.",
                            )}
                          </span>
                        </div>
                      ) : null}
                      {activeHistoryPreview.dirty ? (
                        <div className="vc-p2-warn" role="alert">
                          <span>
                            <AlertIcon size={11} />{" "}
                            {tr(
                              "工作区有未提交改动，执行前请先提交或暂存。",
                              "The working tree has uncommitted changes; commit or stash them first.",
                            )}
                          </span>
                        </div>
                      ) : null}
                      {activeHistoryPreview.alreadyApplied ? (
                        <div className="vc-p2-note" role="status">
                          {activeHistoryPreview.action === "revert"
                            ? tr(
                                "已存在撤销提交，重复执行会再产生一个撤销提交。",
                                "A revert commit already exists; running again creates another one.",
                              )
                            : tr(
                                "该提交已在当前分支历史中，重复拣选可能产生空提交或冲突。",
                                "This commit is already in the current branch history; picking it again may create an empty commit or a conflict.",
                              )}
                        </div>
                      ) : null}
                      {activeHistoryPreview.reason || activeHistoryPreview.error ? (
                        <div className="vc-p2-error" role="alert">
                          {activeHistoryPreview.reason ?? activeHistoryPreview.error}
                        </div>
                      ) : null}
                      {activeHistoryPreview.files.length === 0 ? (
                        <div className="vc-state">{tr("没有文件变化", "No file changes")}</div>
                      ) : (
                        <div className="vc-p2-files">
                          {activeHistoryPreview.files.map((file) => (
                            <PreviewFileRow key={file.path} file={file} />
                          ))}
                        </div>
                      )}
                      <div className="vc-p2-foot">
                        <span className="vc-hint">
                          {action === "revert"
                            ? tr(
                                "Revert 会生成一个新的撤销提交，不改写已有历史。",
                                "Revert creates a new commit; existing history is not rewritten.",
                              )
                            : tr(
                                "Cherry-pick 会把该提交的改动应用到当前分支。",
                                "Cherry-pick applies this commit's changes to the current branch.",
                              )}
                        </span>
                        <button
                          type="button"
                          className="vc-btn vc-btn-primary"
                          disabled={
                            api.busy !== null ||
                            historyPreviewLoading ||
                            !activeHistoryPreview.ok ||
                            activeHistoryPreview.branch === null
                          }
                          onClick={runHistory}
                        >
                          {api.busy === `history-${action}`
                            ? tr("执行中…", "Running…")
                            : action === "revert"
                              ? tr("撤销提交", "Revert commit")
                              : tr("拣选提交", "Cherry-pick commit")}
                        </button>
                      </div>
                    </>
                  ) : null}
                </div>
              </>
            ) : null}

            {historyResult ? (
              <div className="vc-p2-section">
                <div className="vc-p2-label">
                  {historyResult.ok ? <CheckIcon size={11} /> : <AlertIcon size={11} />}
                  {tr("执行结果", "Result")}
                </div>
                <div className={historyResult.ok ? "vc-p2-note" : "vc-p2-error"} role={historyResult.ok ? "status" : "alert"}>
                  {historyResult.message}
                  {historyResult.ok && historyResult.shortSha
                    ? ` · ${tr("新提交", "New commit")} ${historyResult.shortSha}`
                    : ""}
                </div>
                {historyResult.conflicted ? (
                  <>
                    <div className="vc-p2-warn" role="alert">
                      <span>
                        <AlertIcon size={11} />{" "}
                        {trf("有 {0} 个冲突文件：解决后在改动页继续或中止该操作，然后刷新历史。", "{0} conflicted files: resolve them, then continue or abort the operation in the Changes page and refresh the history.", historyResult.conflictedPaths.length)}
                      </span>
                    </div>
                    <div className="vc-p2-files">
                      {historyResult.conflictedPaths.map((path) => (
                        <div className="vc-p2-file" key={path}>
                          <span
                            className="vc-status vc-status-conflicted"
                            title={statusText("conflicted")}
                            aria-label={statusText("conflicted")}
                          >
                            C
                          </span>
                          <span className="vc-p2-path" title={path}>
                            {path}
                          </span>
                        </div>
                      ))}
                    </div>
                    <div className="vc-p2-foot">
                      <button type="button" className="vc-link" onClick={onOpenConflict}>
                        {tr("去改动页处理冲突", "Resolve conflicts in the Changes page")}
                      </button>
                    </div>
                  </>
                ) : null}
              </div>
            ) : null}

            {!commit && !historyResult ? selectCommitHint : null}
          </>
        ) : null}

        {tab === "rewrite" ? (
          <>
            {commit ? (
              <>
                <div className="vc-p2-section">
                  <div className="vc-p2-label">{tr("整理方式", "Rewrite action")}</div>
                  <div className="vc-p2-tabs" role="group" aria-label={tr("选择整理方式", "Choose a rewrite action")}>
                    <button
                      type="button"
                      className={rewriteAction === "fixup" ? "vc-chip active" : "vc-chip"}
                      aria-pressed={rewriteAction === "fixup"}
                      onClick={() => {
                        setRewriteAction("fixup");
                        setRewriteResult(null);
                      }}
                    >
                      {tr("合并进目标提交", "Fixup into the target")}
                    </button>
                    <button
                      type="button"
                      className={rewriteAction === "squash" ? "vc-chip active" : "vc-chip"}
                      aria-pressed={rewriteAction === "squash"}
                      onClick={() => {
                        setRewriteAction("squash");
                        setRewriteResult(null);
                      }}
                    >
                      {tr("压缩为一个提交", "Squash into one commit")}
                    </button>
                  </div>
                  <div className="vc-p2-meta">
                    <span>
                      {tr("被整理", "Source")} <code className="vc-sha">{commit.shortSha}</code> {commit.subject}
                    </span>
                  </div>
                </div>

                <div className="vc-p2-section">
                  <div className="vc-p2-label">{tr("目标提交", "Target commit")}</div>
                  {olderTargets.length === 0 ? (
                    <div className="vc-p2-note" role="status">
                      {tr("没有可选的更早目标提交", "No earlier target commit is available")}
                    </div>
                  ) : (
                    <select
                      className="vc-select"
                      aria-label={tr("目标提交", "Target commit")}
                      value={effectiveTargetSha}
                      onChange={(event) => {
                        setTargetSha(event.target.value);
                        setRewriteResult(null);
                      }}
                    >
                      {olderTargets.map((item) => (
                        <option key={item.sha} value={item.sha}>{`${item.shortSha} · ${item.subject}`}</option>
                      ))}
                    </select>
                  )}
                  <p className="vc-hint">
                    {tr(
                      "整理会把所选提交并入更早的目标提交，目标提交保留。",
                      "The rewrite folds the source commit into the earlier target commit, which is kept.",
                    )}
                  </p>
                </div>

                {rewriteAction === "squash" ? (
                  <div className="vc-p2-section">
                    <div className="vc-p2-label">{tr("提交信息", "Commit message")}</div>
                    <textarea
                      className="vc-input vc-p2-textarea"
                      aria-label={tr("整理后的提交信息", "Commit message after rewriting")}
                      placeholder={tr("留空则沿用目标提交信息", "Leave empty to keep the target commit message")}
                      value={rewriteMessage}
                      onChange={(event) => setRewriteMessage(event.target.value)}
                    />
                  </div>
                ) : null}
              </>
            ) : null}

            {commit && effectiveTargetSha ? (
              <div className="vc-p2-section">
                <div className="vc-p2-label">
                  <DiffIcon size={11} /> {tr("整理范围", "Rewrite scope")}
                </div>
                {rewritePreviewLoading ? (
                  <div className="vc-state">{tr("正在读取整理范围…", "Loading the rewrite scope…")}</div>
                ) : null}
                {!rewritePreviewLoading && !activeRewritePreview ? (
                  <div className="vc-state">{tr("暂时无法读取整理范围", "The rewrite scope is not available")}</div>
                ) : null}
                {activeRewritePreview ? (
                  <>
                    <div className="vc-p2-meta">
                      <span>
                        {tr("被整理", "Source")} <code className="vc-sha">{activeRewritePreview.source.shortSha}</code>{" "}
                        {activeRewritePreview.source.subject}
                      </span>
                      <span>
                        {tr("目标", "Target")} <code className="vc-sha">{activeRewritePreview.target.shortSha}</code>{" "}
                        {activeRewritePreview.target.subject}
                      </span>
                      <span>
                        {tr("会被重写的提交", "Commits rewritten")}{" "}
                        <b>{activeRewritePreview.rewrittenCount}</b>
                      </span>
                      <span>
                        {tr("整理后提交数", "Commits after rewrite")} <b>{activeRewritePreview.expectedCount}</b>
                      </span>
                    </div>
                    {activeRewritePreview.pushedCount > 0 ? (
                      <div className="vc-p2-warn" role="alert">
                        <span>
                          <AlertIcon size={11} />{" "}
                          {trf("其中 {0} 个提交已推送，整理后需要另行安全强推，应用不会自动推送", "{0} of these commits are already pushed; after rewriting you must force-push safely yourself — the app never pushes automatically", activeRewritePreview.pushedCount)}
                        </span>
                      </div>
                    ) : null}
                    {activeRewritePreview.dirty ? (
                      <div className="vc-p2-warn" role="alert">
                        <span>
                          <AlertIcon size={11} />{" "}
                          {tr(
                            "工作区有未提交改动，请先提交或暂存后再整理历史。",
                            "The working tree has uncommitted changes; commit or stash them before rewriting history.",
                          )}
                        </span>
                      </div>
                    ) : null}
                    {activeRewritePreview.reason || activeRewritePreview.error ? (
                      <div className="vc-p2-error" role="alert">
                        {activeRewritePreview.reason ?? activeRewritePreview.error}
                      </div>
                    ) : null}
                    <div className="vc-p2-label">{tr("会被重写的提交", "Commits to rewrite")}</div>
                    <div className="vc-p2-commit-list">
                      {(rewriteExpanded
                        ? activeRewritePreview.rewritten
                        : activeRewritePreview.rewritten.slice(0, rewriteRowLimit)
                      ).map((item) => (
                        <div className="vc-p2-commit" key={item.sha} title={formatAbsoluteTime(item.authorAt, locale)}>
                          <code className="vc-sha">{item.shortSha}</code>
                          <span className="vc-p2-commit-subject" title={item.subject}>
                            {item.subject}
                          </span>
                          <span className="vc-hint">
                            {item.authorName} · {formatRelativeTime(item.authorAt, locale)}
                          </span>
                        </div>
                      ))}
                    </div>
                    {activeRewritePreview.rewritten.length > rewriteRowLimit ? (
                      <button type="button" className="vc-link" onClick={() => setRewriteExpanded((value) => !value)}>
                        {rewriteExpanded
                          ? tr("收起", "Collapse")
                          : trf("展开其余 {0} 个提交", "Show {0} more commits", activeRewritePreview.rewritten.length - rewriteRowLimit)}
                      </button>
                    ) : null}
                    <div className="vc-p2-foot">
                      <span className="vc-hint">
                        {tr(
                          "整理不会自动推送重写后的历史。",
                          "Rewritten history is never pushed automatically.",
                        )}
                      </span>
                      <button
                        type="button"
                        className="vc-btn vc-btn-primary"
                        disabled={api.busy !== null || rewritePreviewLoading || !activeRewritePreview.ok}
                        onClick={runRewriteOp}
                      >
                        {api.busy === "rewrite" ? tr("整理中…", "Rewriting…") : tr("执行整理", "Apply rewrite")}
                      </button>
                    </div>
                  </>
                ) : null}
              </div>
            ) : null}

            {rewriteResult ? (
              <div className="vc-p2-section">
                <div className="vc-p2-label">
                  {rewriteResult.ok ? <CheckIcon size={11} /> : <AlertIcon size={11} />}
                  {tr("执行结果", "Result")}
                </div>
                <div className={rewriteResult.ok ? "vc-p2-note" : "vc-p2-error"} role={rewriteResult.ok ? "status" : "alert"}>
                  {rewriteResult.message}
                  {rewriteResult.ok && rewriteResult.shortHead ? (
                    <span>
                      {" · "}
                      {tr("新 HEAD", "New HEAD")} <code className="vc-sha">{rewriteResult.shortHead}</code>
                    </span>
                  ) : null}
                </div>
                {rewriteResult.ok && rewriteResult.pushedCount > 0 ? (
                  <div className="vc-p2-warn" role="alert">
                    <span>
                      <AlertIcon size={11} />{" "}
                      {trf("其中 {0} 个提交已推送，需要另行安全强推，应用不会自动推送。", "{0} of the rewritten commits were already pushed; force-push them safely yourself — the app never pushes automatically.", rewriteResult.pushedCount)}
                    </span>
                  </div>
                ) : null}
              </div>
            ) : null}

            {!commit ? selectCommitHint : null}
          </>
        ) : null}

        {tab === "branch" ? (
          <>
            {commit ? (
              <>
                <div className="vc-p2-section">
                  <div className="vc-p2-label">{tr("新分支名", "New branch name")}</div>
                  <input
                    className="vc-input"
                    aria-label={tr("新分支名", "New branch name")}
                    placeholder={tr("例如 feature/from-commit", "e.g. feature/from-commit")}
                    value={branchName}
                    onChange={(event) => {
                      setBranchName(event.target.value);
                      setBranchResult(null);
                    }}
                  />
                  <label className="vc-p2-check">
                    <input
                      type="checkbox"
                      checked={checkout}
                      onChange={(event) => {
                        setCheckout(event.target.checked);
                        setBranchResult(null);
                      }}
                    />
                    {tr("创建后切换过去", "Check out the new branch")}
                  </label>
                  <p className="vc-hint">
                    {tr(
                      "默认只创建引用，不改变 HEAD 与未提交内容。",
                      "By default only a reference is created; HEAD and uncommitted changes stay untouched.",
                    )}
                  </p>
                </div>

                <div className="vc-p2-section">
                  <div className="vc-p2-label">
                    <BranchIcon size={11} /> {tr("起点", "Start point")}
                  </div>
                  <div className="vc-p2-meta">
                    <span>
                      <code className="vc-sha">{commit.shortSha}</code> {commit.subject}
                    </span>
                    <span>
                      {tr("当前分支", "Current branch")} <b>{branch ?? tr("detached HEAD", "detached HEAD")}</b>
                    </span>
                  </div>
                  <div className="vc-p2-foot">
                    <button
                      type="button"
                      className="vc-btn vc-btn-primary"
                      disabled={api.busy !== null || branchName.trim().length === 0}
                      onClick={createBranchAtCommit}
                    >
                      {api.busy === "branch" ? tr("创建中…", "Creating…") : tr("创建分支", "Create branch")}
                    </button>
                  </div>
                </div>
              </>
            ) : null}

            {branchResult ? (
              <div className="vc-p2-section">
                <div className="vc-p2-label">
                  {branchResult.ok ? <CheckIcon size={11} /> : <AlertIcon size={11} />}
                  {tr("执行结果", "Result")}
                </div>
                <div className={branchResult.ok ? "vc-p2-note" : "vc-p2-error"} role={branchResult.ok ? "status" : "alert"}>
                  {branchResult.message}
                </div>
                {branchResult.ok && !branchResult.checkedOut ? (
                  <div className="vc-p2-note" role="status">
                    {tr(
                      "当前分支与未提交内容保持不变",
                      "The current branch and uncommitted changes are unchanged",
                    )}
                    {" · "}
                    {branchResult.worktreeUntouched
                      ? tr("工作区未改动", "Worktree untouched")
                      : trf("未提交改动 {0} 处仍保留", "{0} uncommitted changes were kept", branchResult.changeCount)}
                  </div>
                ) : null}
              </div>
            ) : null}

            {!commit ? selectCommitHint : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
