import type { GitFileChange, GitFileStatus } from "@vela/shared";
import { useEffect, useState } from "react";
import { useEscapeKey } from "../hooks/useDismissable";
import type { ProjectApi } from "../hooks/useProject";
import { CloseIcon, ExternalIcon, EyeIcon, FileIcon } from "./icons";

const statusLabels: Record<GitFileStatus, { letter: string; label: string }> = {
  modified: { letter: "M", label: "修改" },
  added: { letter: "A", label: "新增" },
  deleted: { letter: "D", label: "删除" },
  renamed: { letter: "R", label: "重命名" },
  untracked: { letter: "U", label: "未跟踪" },
};

export function ChangesView({
  project,
  onClose,
  initialPath = null,
  onPreviewFile,
}: {
  project: ProjectApi;
  onClose: () => void;
  /** 外部(如文件预览)请求选中的文件路径 */
  initialPath?: string | null;
  onPreviewFile?: (path: string) => void;
}) {
  const git = project.git;
  const files = git?.files ?? [];
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [diff, setDiff] = useState<string>("");
  const [confirmDiscard, setConfirmDiscard] = useState<string | null>(null);
  const dialogRef = useEscapeKey<HTMLDivElement>(true, () => {
    if (confirmDiscard) setConfirmDiscard(null);
    else onClose();
  });

  useEffect(() => {
    if (files.length === 0) {
      setSelectedPath(null);
      return;
    }
    if (!selectedPath || !files.some((file) => file.path === selectedPath)) {
      setSelectedPath(files[0].path);
    }
  }, [files, selectedPath]);

  const selected = files.find((file) => file.path === selectedPath) ?? null;

  // 预览视图请求查看某个文件的差异时,优先选中它。
  useEffect(() => {
    if (initialPath && files.some((file) => file.path === initialPath)) {
      setSelectedPath(initialPath);
    }
  }, [initialPath, files]);

  const selectedKey = selected ? `${selected.status}-${selected.path}-${selected.staged}` : "";
  const fileDiff = project.fileDiff;

  useEffect(() => {
    if (!selected) {
      setDiff("");
      return;
    }
    let active = true;
    void fileDiff(selected.path, selected.staged)
      .then((text) => {
        if (active) setDiff(text);
      })
      .catch(() => {
        if (active) setDiff("");
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey, fileDiff]);

  if (!git?.repo) return null;

  const stagedFiles = files.filter((file) => file.staged);

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        className="changes-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="changes-sheet-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="changes-header">
          <div className="changes-header-title">
            <FileIcon size={14} />
            <span id="changes-sheet-title">工作区变更</span>
            <span className="changes-count">{files.length > 0 ? `${files.length} 个文件` : "无变更"}</span>
          </div>
          <div className="changes-header-actions">
            <button
              type="button"
              className="changes-action"
              disabled={stagedFiles.length === files.length || files.length === 0}
              onClick={() => void project.stageFiles(files.filter((f) => !f.staged).map((f) => f.path))}
            >
              全部暂存
            </button>
            <button type="button" className="changes-action" title="关闭 (Esc)" aria-label="关闭" onClick={onClose}>
              <CloseIcon size={12} />
            </button>
          </div>
        </header>

        <div className="changes-body">
          <div className="changes-file-list">
            {files.map((file) => (
              <FileRow
                key={`${file.status}-${file.path}`}
                file={file}
                active={file.path === selectedPath}
                confirmDiscard={confirmDiscard === file.path}
                onSelect={() => {
                  setSelectedPath(file.path);
                  setConfirmDiscard(null);
                }}
                onToggleStage={() => {
                  if (file.staged) void project.unstageFiles([file.path]);
                  else void project.stageFiles([file.path]);
                }}
                onDiscard={() => {
                  if (confirmDiscard === file.path) {
                    setConfirmDiscard(null);
                    void project.discardFiles([file.path]);
                  } else {
                    setConfirmDiscard(file.path);
                  }
                }}
                onOpen={() => {
                  const absolute = `${git.repo!.root}/${file.oldPath && file.status === "deleted" ? file.oldPath : file.path}`;
                  void project.openFile(absolute);
                }}
                onPreview={onPreviewFile ? () => onPreviewFile(file.path) : undefined}
                onCancelDiscard={() => setConfirmDiscard(null)}
              />
            ))}
            {files.length === 0 ? <div className="changes-empty">工作区是干净的</div> : null}
          </div>
          <div className="changes-diff">
            {selected ? (
              <>
                <div className="changes-diff-head" title={selected.path}>
                  <span className={`diff-status-badge diff-status-${selected.status}`}>
                    {statusLabels[selected.status].letter}
                  </span>
                  <span className="changes-diff-path">{selected.path}</span>
                  {onPreviewFile ? (
                    <button
                      type="button"
                      className="changes-file-btn diff-preview-btn"
                      title="在侧栏预览"
                      onClick={() => onPreviewFile(selected.path)}
                    >
                      <EyeIcon size={12} />
                    </button>
                  ) : null}
                </div>
                <pre className="changes-diff-body">
                  {diff
                    ? diff.split("\n").map((line, index) => (
                        <div
                          key={index}
                          className={
                            line.startsWith("+") && !line.startsWith("+++")
                              ? "diff-line add"
                              : line.startsWith("-") && !line.startsWith("---")
                                ? "diff-line del"
                                : line.startsWith("@@")
                                  ? "diff-line hunk"
                                  : line.startsWith("diff ") || line.startsWith("index ")
                                    ? "diff-line meta"
                                    : "diff-line"
                          }
                        >
                          {line || " "}
                        </div>
                      ))
                    : "没有可显示的差异"}
                </pre>
              </>
            ) : (
              <div className="changes-empty">选择一个文件查看差异</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function FileRow({
  file,
  active,
  confirmDiscard,
  onSelect,
  onToggleStage,
  onDiscard,
  onOpen,
  onPreview,
  onCancelDiscard,
}: {
  file: GitFileChange;
  active: boolean;
  confirmDiscard: boolean;
  onSelect: () => void;
  onToggleStage: () => void;
  onDiscard: () => void;
  onOpen: () => void;
  onPreview?: () => void;
  onCancelDiscard: () => void;
}) {
  const status = statusLabels[file.status];
  const segments = file.path.split("/");
  const name = segments.pop() ?? file.path;
  const directory = segments.join("/");

  return (
    <div
      className={`changes-file-row${active ? " active" : ""}`}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      aria-current={active ? "true" : undefined}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
    >
      <span className={`diff-status-badge diff-status-${file.status}`} title={status.label} aria-label={status.label}>
        {status.letter}
      </span>
      <div className="changes-file-text">
        <span className="changes-file-name" title={file.path}>
          {file.oldPath && file.status === "renamed" ? `${file.oldPath} → ${name}` : name}
        </span>
        {directory ? <span className="changes-file-dir">{directory}</span> : null}
      </div>
      {file.staged ? <span className="changes-staged-tag">已暂存</span> : null}
      <div className="changes-file-actions" onClick={(event) => event.stopPropagation()}>
        <button
          type="button"
          className="changes-file-btn"
          title={file.staged ? "取消暂存" : "暂存"}
          aria-label={file.staged ? `取消暂存 ${name}` : `暂存 ${name}`}
          onClick={onToggleStage}
        >
          {file.staged ? "−" : "+"}
        </button>
        <button type="button" className="changes-file-btn" title="用默认应用打开" aria-label={`打开 ${name}`} onClick={onOpen}>
          <ExternalIcon size={12} />
        </button>
        {onPreview ? (
          <button type="button" className="changes-file-btn" title="在侧栏预览" aria-label={`预览 ${name}`} onClick={onPreview}>
            <EyeIcon size={12} />
          </button>
        ) : null}
        {confirmDiscard ? (
          <span className="changes-confirm">
            <button type="button" className="changes-file-btn danger" onClick={onDiscard}>
              确认放弃
            </button>
            <button type="button" className="changes-file-btn" onClick={onCancelDiscard}>
              取消
            </button>
          </span>
        ) : (
          <button type="button" className="changes-file-btn" title="放弃改动" aria-label={`放弃 ${name} 的改动`} onClick={onDiscard}>
            ↺
          </button>
        )}
      </div>
    </div>
  );
}
