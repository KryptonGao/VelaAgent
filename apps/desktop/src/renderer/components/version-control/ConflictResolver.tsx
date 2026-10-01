import { useCallback, useEffect, useState } from "react";
import type { GitConflictFile, GitInProgressOperation } from "@vela/shared";
import { tr } from "../../locale";
import type { VersionControlApi } from "../../hooks/useVersionControl";
import { AlertIcon, CheckIcon, RefreshIcon } from "../icons";

const operationLabels: Record<GitInProgressOperation, [string, string]> = {
  merge: ["合并", "Merge"],
  rebase: ["变基", "Rebase"],
  "cherry-pick": ["拣选", "Cherry-pick"],
  revert: ["回退", "Revert"],
};

export function operationLabel(kind: GitInProgressOperation): string {
  const [chinese, english] = operationLabels[kind];
  return tr(chinese, english);
}

/**
 * 冲突编辑器(CF-01):展示共同祖先、当前分支与传入版本,
 * 编辑合并结果并暂存;未解决完所有文件时 continue 会被服务端拒绝。
 */
export function ConflictResolver({
  api,
  path,
  disabled,
  onResolved,
}: {
  api: VersionControlApi;
  path: string;
  disabled: boolean;
  onResolved(): void;
}) {
  const [file, setFile] = useState<GitConflictFile | null>(null);
  const [loading, setLoading] = useState(false);
  const [content, setContent] = useState("");
  const [dirty, setDirty] = useState(false);
  const [showBase, setShowBase] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setMessage(null);
    const next = await api.conflictFile(path);
    setLoading(false);
    if (!next) {
      setError(tr("无法读取冲突内容，请刷新后重试。", "Could not read the conflict; refresh and try again."));
      return;
    }
    setFile(next);
    setContent(next.merged);
    setDirty(false);
  }, [api, path]);

  useEffect(() => {
    void load();
  }, [load]);

  const hasMarkers = /^(<{7}|={7}|>{7})/m.test(content);
  const applySide = (side: "ours" | "theirs") => {
    if (!file) return;
    const source = side === "ours" ? file.ours : file.theirs;
    if (source === null) {
      setError(tr("这一侧没有内容（可能是新增或删除文件）。", "That side has no content (added or deleted file)."));
      return;
    }
    setContent(source);
    setDirty(true);
    setError(null);
  };

  const save = async () => {
    if (!file) return;
    setError(null);
    const result = await api.resolveConflict(file.path, content);
    if (!result) return;
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setMessage(result.message);
    setDirty(false);
    onResolved();
  };

  if (loading && !file) {
    return <div className="vc-state">{tr("正在读取冲突内容…", "Loading the conflict…")}</div>;
  }
  if (!file) {
    return (
      <div className="vc-state vc-state-error" role="alert">
        <AlertIcon size={13} />
        <span>{error ?? tr("无法读取冲突内容", "Could not read the conflict")}</span>
        <button type="button" className="vc-link" onClick={() => void load()}>{tr("重试", "Retry")}</button>
      </div>
    );
  }
  if (file.binary) {
    return (
      <div className="vc-state">
        {tr("二进制冲突，请在终端或外部工具中处理后再刷新。", "Binary conflict; resolve it in a terminal or external tool, then refresh.")}
      </div>
    );
  }

  return (
    <div className="vc-conflict">
      <div className="vc-conflict-bar">
        <span className={`vc-badge ${hasMarkers ? "vc-badge-pending" : "vc-badge-ok"}`}>
          {hasMarkers ? tr("仍有冲突标记", "Conflict markers remain") : tr("可以保存", "Ready to save")}
        </span>
        <button type="button" className="vc-link" onClick={() => applySide("ours")}>{tr("采用当前分支版本", "Take current branch")}</button>
        <button type="button" className="vc-link" onClick={() => applySide("theirs")}>{tr("采用传入版本", "Take incoming")}</button>
        <button type="button" className="vc-link" onClick={() => setShowBase((value) => !value)}>
          {showBase ? tr("隐藏共同祖先", "Hide common ancestor") : tr("查看共同祖先", "Show common ancestor")}
        </button>
        <button type="button" className="vc-link" onClick={() => void load()}>
          <RefreshIcon size={11} /> {tr("重新读取", "Reload")}
        </button>
      </div>

      <div className={`vc-conflict-columns${showBase ? " with-base" : ""}`}>
        <ConflictSide title={tr("当前分支（ours）", "Current branch (ours)")} text={file.ours} />
        {showBase ? <ConflictSide title={tr("共同祖先（base）", "Common ancestor (base)")} text={file.base} /> : null}
        <ConflictSide title={tr("传入版本（theirs）", "Incoming (theirs)")} text={file.theirs} />
      </div>

      <div className="vc-conflict-edit">
        <div className="vc-changed-title">
          <span>{tr("合并结果（编辑后保存）", "Merged result (edit and save)")}</span>
          {dirty ? <span className="vc-badge vc-badge-pending">{tr("未保存", "Unsaved")}</span> : null}
        </div>
        <textarea
          className="vc-input vc-conflict-textarea"
          aria-label={tr("合并结果", "Merged result")}
          value={content}
          spellCheck={false}
          disabled={disabled}
          onChange={(event) => {
            setContent(event.target.value);
            setDirty(true);
          }}
        />
      </div>

      {hasMarkers ? (
        <div className="vc-inline-notice" role="status">
          {tr("内容里仍有冲突标记；保存后 Git 会把它当作已解决，请先确认结果。", "Conflict markers are still present. Saving marks the file resolved, so confirm the result first.")}
        </div>
      ) : null}
      {message ? <div className="vc-inline-notice" role="status">{message}</div> : null}
      {error ? <div className="vc-error-banner" role="alert"><AlertIcon size={12} />{error}</div> : null}

      <div className="vc-dialog-actions">
        <button type="button" className="vc-btn vc-btn-primary" disabled={disabled || !dirty} onClick={() => void save()}>
          <CheckIcon size={12} /> {tr("保存并标记为已解决", "Save and mark resolved")}
        </button>
      </div>
    </div>
  );
}

function ConflictSide({ title, text }: { title: string; text: string | null }) {
  return (
    <div className="vc-conflict-side">
      <div className="vc-conflict-side-head">{title}</div>
      {text === null ? (
        <div className="vc-state">{tr("不存在", "Not present")}</div>
      ) : (
        <pre className="vc-conflict-side-body">{text || tr("（空）", "(empty)")}</pre>
      )}
    </div>
  );
}
