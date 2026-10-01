import type { GitFileChange, GitFileStatus, WorkspaceFileContent } from "@vela/shared";
import { useEffect, useState } from "react";
import { useEscapeKey } from "../hooks/useDismissable";
import type { ProjectApi } from "../hooks/useProject";
import { ExternalIcon, EyeIcon, FileIcon } from "./icons";
import { DiffPane } from "./DiffPane";
import { useFilePreview } from "./preview/FilePreviewContext";
import { MarkdownPane } from "./preview/MarkdownPane";
import { isMarkdownPath } from "./preview/markdown-path";
import { tr } from "../locale";

const statusLetters: Record<GitFileStatus, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  untracked: "U",
  conflicted: "C",
};

function statusLabel(status: GitFileStatus): string {
  const labels: Record<GitFileStatus, [string, string]> = {
    modified: ["修改", "Modified"],
    added: ["新增", "Added"],
    deleted: ["删除", "Deleted"],
    renamed: ["重命名", "Renamed"],
    untracked: ["未跟踪", "Untracked"],
    conflicted: ["冲突", "Conflicted"],
  };
  const [chinese, english] = labels[status];
  return tr(chinese, english);
}

/** 与文件路径绑定的 Markdown 预览内容,避免切换文件时闪现上一份内容。 */
interface MarkdownPreviewState {
  path: string;
  content: WorkspaceFileContent | null;
  loading: boolean;
}

export function ChangesView({
  project,
  onClose,
  initialPath = null,
  initialPathRequestKey = 0,
  selectedPath: selectedPathProp,
  onSelectedPathChange,
  onPreviewFile,
  visible = true,
}: {
  project: ProjectApi;
  /** 关闭当前宿主标签；仅 Escape 会从内容视图调用。 */
  onClose: () => void;
  /** 外部(如文件预览)请求选中的文件路径 */
  initialPath?: string | null;
  /** 同一路径重复请求时也重新选中对应差异。 */
  initialPathRequestKey?: number;
  /** 宿主按工作区保存所选差异文件；不提供时使用组件内状态。 */
  selectedPath?: string | null;
  onSelectedPathChange?: (path: string | null) => void;
  onPreviewFile?: (path: string) => void;
  /** 非活动标签保持挂载但隐藏，且不响应 Escape。 */
  visible?: boolean;
}) {
  const git = project.git;
  const preview = useFilePreview();
  const files = git?.files ?? [];
  const [localSelectedPath, setLocalSelectedPath] = useState<string | null>(null);
  const selectedPath = selectedPathProp === undefined ? localSelectedPath : selectedPathProp;
  const setSelectedPath = onSelectedPathChange ?? setLocalSelectedPath;
  const [diffResult, setDiffResult] = useState<{ key: string; text: string } | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState<string | null>(null);
  const [view, setView] = useState<"diff" | "preview">("diff");
  const [markdownPreview, setMarkdownPreview] = useState<MarkdownPreviewState | null>(null);
  const contentRef = useEscapeKey<HTMLDivElement>(visible, () => {
    if (confirmDiscard) setConfirmDiscard(null);
    else onClose();
  });

  useEffect(() => {
    if (!visible) setConfirmDiscard(null);
  }, [visible]);

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
  }, [initialPath, initialPathRequestKey, files]);

  const selectedKey = selected ? `${selected.status}-${selected.path}-${selected.indexStatus ?? ""}-${selected.worktreeStatus ?? ""}` : "";
  const diff = diffResult?.key === selectedKey ? diffResult.text : "";
  const diffLoading = Boolean(selected) && diffResult?.key !== selectedKey;
  const fileDiff = project.fileDiff;
  const previewRevision = preview?.revision ?? 0;

  useEffect(() => {
    if (!selected) {
      setDiffResult(null);
      return;
    }
    let active = true;
    // 同一文件同时有两部分改动时,快速面板展示工作区改动(索引内容在版本控制页)。
    const scope = selected.worktreeStatus ? "worktree" : "index";
    void fileDiff(selected.path, scope)
      .then((text) => {
        if (active) setDiffResult({ key: selectedKey, text });
      })
      .catch(() => {
        if (active) setDiffResult({ key: selectedKey, text: "" });
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey, fileDiff, previewRevision]);

  const canPreviewMarkdown = Boolean(
    selected && selected.status !== "deleted" && isMarkdownPath(selected.path),
  );
  const showMarkdownPreview = view === "preview" && canPreviewMarkdown;
  const selectedFilePath = selected?.path ?? "";

  // Markdown 预览读取工作区当前内容;同一文件的 git 事件只刷新内容,不回到加载态。
  useEffect(() => {
    if (!showMarkdownPreview || !selectedFilePath) return;
    const api = window.vela;
    if (!api) return;
    let active = true;
    setMarkdownPreview((current) =>
      current?.path === selectedFilePath
        ? { ...current, loading: true }
        : { path: selectedFilePath, content: null, loading: true },
    );
    api
      .readWorkspaceFile(selectedFilePath)
      .then((content) => {
        if (active) setMarkdownPreview({ path: selectedFilePath, content, loading: false });
      })
      .catch(() => {
        if (active) setMarkdownPreview({ path: selectedFilePath, content: null, loading: false });
      });
    return () => {
      active = false;
    };
  }, [showMarkdownPreview, selectedFilePath, previewRevision]);

  const markdown = markdownPreview?.path === selectedFilePath ? markdownPreview : null;
  const markdownText = markdown?.content?.kind === "text" ? markdown.content : null;

  if (!git?.repo) return null;

  return (
      <div
        ref={contentRef}
        className="changes-sheet"
        role="region"
        aria-hidden={!visible}
        inert={!visible ? true : undefined}
        aria-labelledby="changes-sheet-title"
        style={{ display: visible ? undefined : "none" }}
      >
        <header className="changes-header">
          <div className="changes-header-title">
            <FileIcon size={14} />
            <span id="changes-sheet-title">{tr("工作区变更", "Workspace changes")}</span>
            <span className="changes-count">{files.length > 0 ? tr(`${files.length} 个文件`, `${files.length} files`) : tr("无变更", "No changes")}</span>
          </div>
          <div className="changes-header-actions">
            <button
              type="button"
              className="changes-action"
              disabled={files.every((file) => file.indexStatus !== null) || files.length === 0}
              onClick={() => void project.stageFiles(files.filter((f) => f.worktreeStatus !== null).map((f) => f.path))}
            >
              {tr("全部暂存", "Stage all")}
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
                  if (file.indexStatus !== null && file.worktreeStatus === null) void project.unstageFiles([file.path]);
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
            {files.length === 0 ? <div className="changes-empty">{tr("工作区是干净的", "Workspace is clean")}</div> : null}
          </div>
          <div className="changes-diff">
            {selected ? (
              <>
                <div className="changes-diff-head" title={selected.path}>
                  <span className={`diff-status-badge diff-status-${selected.status}`}>
                    {statusLetters[selected.status]}
                  </span>
                  <span className="changes-diff-path">{selected.path}</span>
                  {canPreviewMarkdown ? (
                    <div
                      className="preview-view-toggle"
                      role="group"
                      aria-label={tr("文件显示方式", "File view mode")}
                    >
                      <button
                        type="button"
                        aria-pressed={!showMarkdownPreview}
                        className={showMarkdownPreview ? "" : "active"}
                        onClick={() => setView("diff")}
                      >
                        {tr("差异", "Diff")}
                      </button>
                      <button
                        type="button"
                        aria-pressed={showMarkdownPreview}
                        className={showMarkdownPreview ? "active" : ""}
                        onClick={() => setView("preview")}
                      >
                        {tr("预览", "Preview")}
                      </button>
                    </div>
                  ) : null}
                  {onPreviewFile ? (
                    <button
                      type="button"
                      className="changes-file-btn diff-preview-btn"
                      title={tr("在侧栏预览", "Preview in sidebar")}
                      onClick={() => onPreviewFile(selected.path)}
                    >
                      <EyeIcon size={12} />
                    </button>
                  ) : null}
                </div>
                {showMarkdownPreview ? (
                  <div className="changes-preview">
                    {!markdown || (markdown.loading && !markdown.content) ? (
                      <div className="changes-preview-state">{tr("正在读取文件…", "Reading file…")}</div>
                    ) : markdownText?.content != null ? (
                      <MarkdownPane
                        text={markdownText.content}
                        documentPath={selectedFilePath}
                        truncated={markdownText.truncated}
                        revision={previewRevision}
                      />
                    ) : (
                      <div className="changes-preview-state">
                        {markdown.content?.kind === "too-large"
                          ? tr("文件过大，无法预览。", "File is too large to preview.")
                          : tr("无法预览该文件。", "This file cannot be previewed.")}
                      </div>
                    )}
                  </div>
                ) : diff ? (
                  <DiffPane key={selectedKey} path={selected.path} diff={diff} />
                ) : (
                  <pre className="changes-diff-body">
                    <div className="diff-line">{diffLoading ? tr("正在读取差异…", "Reading diff…") : tr("没有可显示的差异", "No diff to display")}</div>
                  </pre>
                )}
              </>
            ) : (
              <div className="changes-empty">{tr("选择一个文件查看差异", "Select a file to view its diff")}</div>
            )}
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
  const status = statusLabel(file.status);
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
      <span className={`diff-status-badge diff-status-${file.status}`} title={status} aria-label={status}>
        {statusLetters[file.status]}
      </span>
      <div className="changes-file-text">
        <span className="changes-file-name" title={file.path}>
          {file.oldPath && file.status === "renamed" ? `${file.oldPath} → ${name}` : name}
        </span>
        {directory ? <span className="changes-file-dir">{directory}</span> : null}
      </div>
      {file.indexStatus !== null ? <span className="changes-staged-tag">{tr("已暂存", "Staged")}</span> : null}
      <div className="changes-file-actions" onClick={(event) => event.stopPropagation()}>
        <button
          type="button"
          className="changes-file-btn"
          title={file.indexStatus !== null && file.worktreeStatus === null ? tr("取消暂存", "Unstage") : tr("暂存", "Stage")}
          aria-label={file.indexStatus !== null && file.worktreeStatus === null ? `${tr("取消暂存", "Unstage")} ${name}` : `${tr("暂存", "Stage")} ${name}`}
          onClick={onToggleStage}
        >
          {file.indexStatus !== null && file.worktreeStatus === null ? "−" : "+"}
        </button>
        <button type="button" className="changes-file-btn" title={tr("用默认应用打开", "Open with default app")} aria-label={`${tr("打开", "Open")} ${name}`} onClick={onOpen}>
          <ExternalIcon size={12} />
        </button>
        {onPreview ? (
          <button type="button" className="changes-file-btn" title={tr("在侧栏预览", "Preview in sidebar")} aria-label={`${tr("预览", "Preview")} ${name}`} onClick={onPreview}>
            <EyeIcon size={12} />
          </button>
        ) : null}
        {confirmDiscard ? (
          <span className="changes-confirm">
            <button type="button" className="changes-file-btn danger" onClick={onDiscard}>
              {tr("确认放弃", "Discard changes")}
            </button>
            <button type="button" className="changes-file-btn" onClick={onCancelDiscard}>
              {tr("取消", "Cancel")}
            </button>
          </span>
        ) : (
          <button type="button" className="changes-file-btn" title={tr("放弃改动", "Discard changes")} aria-label={`${tr("放弃", "Discard")} ${name}`} onClick={onDiscard}>
            ↺
          </button>
        )}
      </div>
    </div>
  );
}
