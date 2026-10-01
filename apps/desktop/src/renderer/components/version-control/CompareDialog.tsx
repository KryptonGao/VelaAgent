import { useCallback, useEffect, useMemo, useState } from "react";
import type { BranchSummary, GitCompareResult, GitCompareFile, GitCommitSummary } from "@vela/shared";
import { tr } from "../../locale";
import type { VersionControlApi } from "../../hooks/useVersionControl";
import { AlertIcon, ArrowRightIcon, RefreshIcon } from "../icons";
import { DiffPane } from "../DiffPane";
import { splitCommitDiff } from "./HistoryPage";
import { formatRelativeTime } from "./time-format";
import type { AppLocale } from "@vela/shared";

/**
 * 两个 ref 的比较(BR-03 分支比较 / HI-01 提交比较)。
 * 方向固定显示为 base → head,并明确共同祖先;两侧都可以是分支或提交 SHA。
 */
export function CompareDialog({
  open,
  onClose,
  api,
  branches,
  recentCommits,
  initialBase,
  initialHead,
  locale,
}: {
  open: boolean;
  onClose(): void;
  api: VersionControlApi;
  branches: BranchSummary[];
  recentCommits: GitCommitSummary[];
  initialBase: string;
  initialHead: string;
  locale: AppLocale;
}) {
  const [base, setBase] = useState(initialBase);
  const [head, setHead] = useState(initialHead);
  const [result, setResult] = useState<GitCompareResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setBase(initialBase);
      setHead(initialHead);
      setSelectedFile(null);
    }
  }, [open, initialBase, initialHead]);

  const run = useCallback(async () => {
    if (!base.trim() || !head.trim()) return;
    setLoading(true);
    const next = await api.compareRefs(base.trim(), head.trim());
    setLoading(false);
    setResult(next);
    setSelectedFile(null);
  }, [api, base, head]);

  useEffect(() => {
    if (open) void run();
    // 打开或目标变化时重新比较。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const diffByFile = useMemo(() => (result ? splitCommitDiff(result.diff) : new Map<string, string>()), [result]);
  const currentFile: GitCompareFile | null = useMemo(
    () => result?.files.find((file) => file.path === selectedFile) ?? null,
    [result, selectedFile],
  );
  const fileDiff = currentFile
    ? diffByFile.get(currentFile.path) ?? ""
    : result && result.files.length > 0
      ? diffByFile.get(result.files[0]!.path) ?? ""
      : "";

  if (!open) return null;

  const suggestions = [
    ...branches.map((branch) => branch.name),
    ...recentCommits.slice(0, 20).map((commit) => commit.sha),
  ];

  return (
    <div className="vc-dialog-backdrop" role="dialog" aria-modal="true" aria-label={tr("比较差异", "Compare")}>
      <div className="vc-dialog vc-compare-dialog">
        <div className="vc-dialog-head">
          <b>{tr("比较差异", "Compare")}</b>
          <button type="button" className="vc-link" onClick={onClose}>{tr("关闭", "Close")}</button>
        </div>

        <div className="vc-compare-inputs">
          <label className="vc-field-label">
            {tr("基准（base）", "Base")}
            <input
              className="vc-input"
              list="vc-compare-refs"
              aria-label={tr("基准分支或提交", "Base branch or commit")}
              value={base}
              onChange={(event) => setBase(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="vc-icon-btn"
            title={tr("交换方向", "Swap")}
            aria-label={tr("交换方向", "Swap")}
            onClick={() => {
              setBase(head);
              setHead(base);
            }}
          >
            <ArrowRightIcon size={12} />
          </button>
          <label className="vc-field-label">
            {tr("目标（head）", "Head")}
            <input
              className="vc-input"
              list="vc-compare-refs"
              aria-label={tr("目标分支或提交", "Head branch or commit")}
              value={head}
              onChange={(event) => setHead(event.target.value)}
            />
          </label>
          <datalist id="vc-compare-refs">
            {suggestions.map((value) => <option key={value} value={value} />)}
          </datalist>
          <button type="button" className="vc-btn vc-btn-primary" disabled={loading || !base.trim() || !head.trim()} onClick={() => void run()}>
            {loading ? tr("比较中…", "Comparing…") : tr("比较", "Compare")}
          </button>
          <label className="vc-chip vc-chip-check">
            <input type="checkbox" checked={api.ignoreWhitespace} onChange={(event) => api.setIgnoreWhitespace(event.target.checked)} />
            {tr("忽略空白", "Ignore whitespace")}
          </label>
          <div className="vc-diff-options" role="group" aria-label={tr("差异显示方式", "Diff display options")}>
            <button type="button" className={`vc-chip${api.diffMode === "unified" ? " active" : ""}`} onClick={() => api.setDiffMode("unified")}>{tr("统一", "Unified")}</button>
            <button type="button" className={`vc-chip${api.diffMode === "split" ? " active" : ""}`} onClick={() => api.setDiffMode("split")}>{tr("并排", "Split")}</button>
          </div>
        </div>

        <div className="vc-compare-direction">
          {tr("方向", "Direction")} <code>{base || "?"}</code> → <code>{head || "?"}</code>
          {result?.mergeBase ? <span className="vc-hint">{tr(`共同祖先 ${result.mergeBase.slice(0, 7)}`, `merge base ${result.mergeBase.slice(0, 7)}`)}</span> : null}
          {result ? (
            <span className="vc-hint">
              {tr(
                `${result.commits.length} 个提交 · ${result.fileCount} 个文件 · +${result.addedLines} −${result.deletedLines}`,
                `${result.commits.length} commits · ${result.fileCount} files · +${result.addedLines} −${result.deletedLines}`,
              )}
            </span>
          ) : null}
        </div>

        {result?.error ? (
          <div className="vc-error-banner" role="alert"><AlertIcon size={12} />{result.error}</div>
        ) : null}
        {result?.diffTruncated ? (
          <div className="vc-inline-notice">{tr("差异过大，仅显示前一部分。", "The diff is very large; only the first part is shown.")}</div>
        ) : null}

        {result && !result.error ? (
          <div className="vc-compare-body">
            <div className="vc-compare-side">
              <div className="vc-scope-label">{tr("提交", "Commits")}</div>
              <div className="vc-scope-commits">
                {result.commits.slice(0, 50).map((commit) => (
                  <div key={commit.sha} className="vc-scope-commit">
                    <span className="vc-scope-dot" aria-hidden="true" />
                    <span className="vc-scope-msg" title={commit.subject}>{commit.subject}</span>
                    <code className="vc-sha">{commit.shortSha}</code>
                  </div>
                ))}
                {result.commits.length === 0 ? <div className="vc-hint">{tr("没有额外提交", "No extra commits")}</div> : null}
                {result.commits.length > 50 ? <div className="vc-hint">{tr(`还有 ${result.commits.length - 50} 个提交`, `${result.commits.length - 50} more commits`)}</div> : null}
              </div>
              <div className="vc-scope-label">{tr("文件", "Files")}</div>
              <div className="vc-changed-files">
                {result.files.map((file) => (
                  <button
                    key={file.path}
                    type="button"
                    className={`vc-changed-file${file.path === (selectedFile ?? result.files[0]?.path) ? " selected" : ""}`}
                    onClick={() => setSelectedFile(file.path)}
                  >
                    <span className={`vc-status vc-status-${file.status}`}>{file.status.slice(0, 1).toUpperCase()}</span>
                    <span className="vc-changed-path" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>
                      {file.oldPath && file.status === "renamed" ? `${file.oldPath} → ${file.path}` : file.path}
                    </span>
                    <span className="vc-stats"><b className="vc-plus">+{file.addedLines}</b> <b className="vc-minus">−{file.deletedLines}</b></span>
                  </button>
                ))}
                {result.files.length === 0 ? <div className="vc-hint">{tr("两侧没有文件差异", "No file differences")}</div> : null}
              </div>
            </div>
            <div className="vc-compare-diff">
              <div className="vc-changed-title vc-diff-title">
                <span>{selectedFile ?? result.files[0]?.path ?? tr("差异", "Diff")}</span>
                {result.commits[0] ? (
                  <span className="vc-hint">{tr(`最早 ${formatRelativeTime(result.commits[0].authorAt, locale)}`, `oldest ${formatRelativeTime(result.commits[0].authorAt, locale)}`)}</span>
                ) : null}
              </div>
              <div className="vc-detail-diff">
                {fileDiff ? (
                  <DiffPane key={`${result.headSha}:${selectedFile ?? ""}:${api.ignoreWhitespace ? "w" : ""}`} path={selectedFile ?? result.files[0]?.path ?? ""} diff={fileDiff} mode={api.diffMode} />
                ) : (
                  <div className="vc-state">{tr("没有可显示的差异", "No diff to display")}</div>
                )}
              </div>
            </div>
          </div>
        ) : null}

        <div className="vc-dialog-foot">
          <button type="button" className="vc-icon-btn" title={tr("重新比较", "Re-compare")} aria-label={tr("重新比较", "Re-compare")} onClick={() => void run()}>
            <RefreshIcon size={12} />
          </button>
          <span className="vc-hint">{tr("比较使用共同祖先作为基准，方向和范围以输入为准。", "Comparison uses the merge base; direction follows the inputs.")}</span>
        </div>
      </div>
    </div>
  );
}
