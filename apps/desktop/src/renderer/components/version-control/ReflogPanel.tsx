import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AppLocale,
  GitRecoveryMode,
  GitRecoveryPreview,
  GitRecoveryPreviewInput,
  GitRecoveryResult,
  GitReflogEntry,
} from "@vela/shared";
import { tr, trf } from "../../locale";
import type { VersionControlApi } from "../../hooks/useVersionControl";
import { AlertIcon, RefreshIcon } from "../icons";
import { formatAbsoluteTime, formatRelativeTime } from "./time-format";

/** 恢复方式:文案直接说明对当前分支与文件/索引的影响(HI-06)。 */
const recoveryModes: Array<{ value: GitRecoveryMode; label: [string, string] }> = [
  { value: "branch", label: ["新建分支（保留现状）", "New branch (keep current state)"] },
  { value: "reset-soft", label: ["移动分支到该提交，改动留在索引", "Move the branch; changes stay staged"] },
  { value: "reset-mixed", label: ["移动分支到该提交，改动留在工作区", "Move the branch; changes stay in the working tree"] },
];

/**
 * Reflog 查询与恢复(HI-06):按说明、动作或 SHA 检索 HEAD 引用日志;
 * 选中记录后先预览恢复方式对引用与未提交改动的影响,再显式执行。
 * 优先提供不移动现有引用的新建分支路径,移动分支必须勾选确认。
 */
export function ReflogPanel({
  open,
  onClose,
  api,
  locale,
}: {
  open: boolean;
  onClose(): void;
  api: VersionControlApi;
  locale: AppLocale;
}) {
  const { refreshReflog, reflog, reflogLoading } = api;
  const [text, setText] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<GitRecoveryMode>("branch");
  const [branchName, setBranchName] = useState("");
  const [preview, setPreview] = useState<GitRecoveryPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [result, setResult] = useState<GitRecoveryResult | null>(null);
  /** 已发起过的查询文本:避免打开面板时的首次读取与输入防抖重复触发。 */
  const lastQueryRef = useRef("");

  const entries = reflog?.entries ?? [];
  const reflogError = reflog?.error ?? null;
  const selected = entries.find((entry) => entry.id === selectedId) ?? null;

  // 打开时读取完整列表,并清空上一次的检索、选择与预览。
  useEffect(() => {
    if (!open) return;
    lastQueryRef.current = "";
    setText("");
    setSelectedId(null);
    setMode("branch");
    setBranchName("");
    setPreview(null);
    setPreviewFailed(false);
    setConfirmed(false);
    setResult(null);
    refreshReflog();
  }, [open, refreshReflog]);

  // 停止输入 300ms 后再查询;清空输入时回到完整列表。
  useEffect(() => {
    if (!open) return;
    const trimmed = text.trim();
    if (trimmed === lastQueryRef.current) return;
    const timer = window.setTimeout(() => {
      lastQueryRef.current = trimmed;
      if (trimmed) refreshReflog({ text: trimmed });
      else refreshReflog();
    }, 300);
    return () => window.clearTimeout(timer);
  }, [open, text, refreshReflog]);

  // 恢复方式变化后,之前读取的预览不再对应当前输入。
  useEffect(() => {
    setPreview(null);
    setPreviewFailed(false);
    setConfirmed(false);
  }, [mode]);

  /** 刷新与重试都按当前输入重新查询,保证搜索框与列表始终对应。 */
  const reload = useCallback(() => {
    const trimmed = text.trim();
    lastQueryRef.current = trimmed;
    if (trimmed) refreshReflog({ text: trimmed });
    else refreshReflog();
  }, [text, refreshReflog]);

  const selectEntry = (entry: GitReflogEntry) => {
    setSelectedId(entry.id);
    setMode("branch");
    setBranchName(`recover-${entry.shortSha}`);
    setPreview(null);
    setPreviewFailed(false);
    setConfirmed(false);
    setResult(null);
  };

  const recoveryInput = (entry: GitReflogEntry): GitRecoveryPreviewInput => ({
    target: entry.id,
    mode,
    branchName: mode === "branch" ? branchName.trim() : null,
  });

  const runPreview = () => {
    if (!selected) return;
    setPreviewing(true);
    setPreview(null);
    setPreviewFailed(false);
    setConfirmed(false);
    void api.previewRecovery(recoveryInput(selected)).then((next) => {
      setPreviewing(false);
      if (next) setPreview(next);
      else setPreviewFailed(true);
    });
  };

  const runRecoveryNow = () => {
    if (!selected) return;
    setResult(null);
    void api.runRecovery(recoveryInput(selected)).then((outcome) => {
      if (!outcome) return;
      setResult(outcome);
      if (outcome.ok) {
        // 恢复会新建分支或移动当前分支:重新读取 Reflog,并丢弃已过期的预览。
        setPreview(null);
        setConfirmed(false);
        refreshReflog();
      }
    });
  };

  // 预览必须对应当前选中的记录、恢复方式与分支名,才允许执行。
  const canRun =
    preview !== null &&
    preview.ok &&
    selected !== null &&
    preview.target.id === selected.id &&
    preview.mode === mode &&
    (mode !== "branch" || preview.branchName === branchName.trim()) &&
    api.busy === null &&
    (!preview.requiresConfirm || confirmed);

  if (!open) return null;

  return (
    <div className="vc-popover" role="dialog" aria-label={tr("Reflog 查询与恢复", "Reflog search and recovery")}>
      <div className="vc-ops-head">
        <b>{tr("Reflog", "Reflog")}</b>
        <button
          type="button"
          className="vc-icon-btn"
          title={tr("刷新 Reflog", "Refresh the reflog")}
          aria-label={tr("刷新 Reflog", "Refresh the reflog")}
          onClick={reload}
        >
          <RefreshIcon size={12} />
        </button>
        <button type="button" className="vc-link" onClick={onClose}>{tr("关闭", "Close")}</button>
      </div>

      <div className="vc-p2-body">
        <input
          className="vc-input vc-search"
          aria-label={tr("搜索 Reflog 说明、动作或 SHA", "Search the reflog by message, action or SHA")}
          placeholder={tr("搜索说明、动作或 SHA", "Search message, action or SHA")}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />

        {reflogLoading && entries.length === 0 ? <div className="vc-state">{tr("正在读取 Reflog…", "Loading the reflog…")}</div> : null}
        {reflogError ? (
          <div className="vc-state vc-state-error" role="alert">
            {reflogError}
            <button type="button" className="vc-link" onClick={reload}>{tr("重试", "Retry")}</button>
          </div>
        ) : null}
        {!reflogLoading && !reflogError && reflog !== null && entries.length === 0 ? (
          <div className="vc-state">{tr("没有匹配的 Reflog 记录", "No matching reflog entries")}</div>
        ) : null}
        {reflog?.truncated ? (
          <div className="vc-p2-note">
            {trf("共 {0} 条记录，这里显示前 {1} 条。", "{0} entries matched; showing the first {1}.", reflog.total, entries.length)}
          </div>
        ) : null}

        <div className="vc-p2-reflog-list">
          {entries.map((entry) => (
            <div
              key={entry.id}
              className={`vc-p2-reflog${selectedId === entry.id ? " selected" : ""}`}
              role="button"
              tabIndex={0}
              aria-pressed={selectedId === entry.id}
              onClick={() => selectEntry(entry)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  selectEntry(entry);
                }
              }}
            >
              <code className="vc-sha">{entry.id}</code>
              <code className="vc-sha">{entry.shortSha}</code>
              <span className="vc-badge vc-badge-muted">{entry.action}</span>
              <span className="vc-p2-meta" title={entry.at ? formatAbsoluteTime(entry.at, locale) : undefined}>
                {entry.at ? formatRelativeTime(entry.at, locale) : ""}
              </span>
              <span className="vc-p2-meta">{entry.message}</span>
              {entry.refs.length > 0 ? (
                <span className="vc-refs">
                  {entry.refs.map((ref) => <span key={ref} className="vc-ref">{ref}</span>)}
                </span>
              ) : null}
              {entry.current ? <span className="vc-badge">{tr("当前", "Current")}</span> : null}
              {!entry.reachable ? <span className="vc-badge vc-badge-muted">{tr("已不可达", "Unreachable")}</span> : null}
            </div>
          ))}
        </div>

        {selected ? (
          <div className="vc-p2-section">
            <div className="vc-p2-label">
              {tr("恢复目标", "Recovery target")}
              <code className="vc-sha">{selected.id}</code>
              <code className="vc-sha">{selected.shortSha}</code>
            </div>
            <p className="vc-p2-meta">{selected.message}</p>

            <div className="vc-p2-tabs" role="group" aria-label={tr("恢复方式", "Recovery mode")}>
              {recoveryModes.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={`vc-chip${mode === option.value ? " active" : ""}`}
                  aria-pressed={mode === option.value}
                  onClick={() => setMode(option.value)}
                >
                  {tr(option.label[0], option.label[1])}
                </button>
              ))}
            </div>

            {mode === "branch" ? (
              <label className="vc-p2-label">
                {tr("新分支名", "New branch name")}
                <input
                  className="vc-input"
                  aria-label={tr("新分支名", "New branch name")}
                  value={branchName}
                  onChange={(event) => setBranchName(event.target.value)}
                />
              </label>
            ) : (
              <div className="vc-p2-warn" role="status">
                {tr(
                  "移动分支会改变 HEAD，请先预览影响，确认会被丢弃的提交。",
                  "Moving the branch changes HEAD; preview the impact and check which commits are dropped first.",
                )}
              </div>
            )}

            <button
              type="button"
              className="vc-btn"
              disabled={api.busy !== null || previewing || (mode === "branch" && !branchName.trim())}
              onClick={runPreview}
            >
              {previewing ? tr("读取中…", "Reading…") : tr("预览影响", "Preview impact")}
            </button>

            {previewFailed ? (
              <div className="vc-p2-error" role="alert">
                {tr("读取恢复范围失败，请重试。", "Could not read the recovery scope; please retry.")}
              </div>
            ) : null}

            {preview ? (
              preview.ok ? (
                <div className="vc-p2-section">
                  <div className="vc-p2-meta">
                    {tr("恢复后的引用", "Reference after recovery")}
                    <code className="vc-sha">{preview.refName}</code>
                  </div>
                  <p className="vc-p2-note">{preview.keepNote}</p>
                  <p className="vc-p2-meta">
                    {trf("未提交改动 {0} 个文件。", "{0} files with uncommitted changes.", preview.changeCount)}
                  </p>
                  {preview.discarded.length > 0 ? (
                    <>
                      <div className="vc-p2-label">
                        {trf("会被丢弃的提交（{0}）", "Commits that will be dropped ({0})", preview.discarded.length)}
                      </div>
                      {preview.discarded.slice(0, 10).map((commit) => (
                        <div key={commit.sha} className="vc-p2-commit">
                          <code className="vc-sha">{commit.shortSha}</code>
                          <span>{commit.subject}</span>
                        </div>
                      ))}
                      {preview.discarded.length > 10 ? (
                        <div className="vc-p2-meta">
                          {trf("另有 {0} 个提交未列出。", "{0} more commits are not listed.", preview.discarded.length - 10)}
                        </div>
                      ) : null}
                    </>
                  ) : (
                    <p className="vc-p2-meta">
                      {tr("按这次预览的数据，不会丢弃任何提交。", "According to this preview, no commit will be dropped.")}
                    </p>
                  )}
                  {preview.requiresConfirm ? (
                    <label className="vc-p2-label">
                      <input
                        id="vc-p2-confirm"
                        type="checkbox"
                        checked={confirmed}
                        onChange={(event) => setConfirmed(event.target.checked)}
                      />
                      {tr("我确认移动当前分支", "I confirm moving the current branch")}
                    </label>
                  ) : null}
                </div>
              ) : (
                <div className="vc-p2-error" role="alert">
                  {preview.reason ?? preview.error ?? tr("当前不能执行这个恢复方式。", "This recovery cannot run right now.")}
                </div>
              )
            ) : null}

            <div className="vc-p2-foot">
              <button
                type="button"
                className={mode === "branch" ? "vc-btn vc-btn-primary" : "vc-btn vc-btn-danger"}
                disabled={!canRun}
                onClick={runRecoveryNow}
              >
                {api.busy === "recover"
                  ? tr("处理中…", "Working…")
                  : mode === "branch"
                    ? tr("新建分支，保留当前内容", "Create branch, keep current content")
                    : tr("移动分支到该提交", "Move the branch to this commit")}
              </button>
            </div>

            {result ? (
              <div className={result.ok ? "vc-inline-notice" : "vc-p2-error"} role="status">
                <AlertIcon size={12} /> {result.message}
              </div>
            ) : null}
            {result?.ok && result.conflictedPaths.length > 0 ? (
              <div className="vc-p2-warn" role="status">
                {tr("恢复后有冲突文件，请到「改动」页处理。", "Some files conflicted; resolve them on the Changes page.")}
                <div className="vc-p2-files">
                  {result.conflictedPaths.map((path) => <div key={path} className="vc-p2-file">{path}</div>)}
                </div>
              </div>
            ) : null}
          </div>
        ) : entries.length > 0 ? (
          <div className="vc-state">{tr("选择一条记录以查看可用的恢复方式。", "Select an entry to see the recovery options.")}</div>
        ) : null}
      </div>
    </div>
  );
}
