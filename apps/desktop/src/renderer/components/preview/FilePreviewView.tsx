import { useEffect, useMemo, useState } from "react";
import type { ProjectApi } from "../../hooks/useProject";
import { CheckIcon, ExternalIcon, GridIcon } from "../icons";
import { CodePane } from "./CodePane";
import { ExplorerPane } from "./ExplorerPane";
import { tr } from "../../locale";
import { useFilePreview, isAbsolutePathLike } from "./FilePreviewContext";
import { MarkdownPane } from "./MarkdownPane";
import { isMarkdownPath } from "./markdown-path";

export function FilePreviewView({
  project,
  onShowDiff,
}: {
  project: ProjectApi;
  onShowDiff: (path: string) => void;
}) {
  const preview = useFilePreview();
  const [explorerOpen, setExplorerOpen] = useState(true);
  const [markdownMode, setMarkdownMode] = useState<"preview" | "source">("preview");
  const [copied, setCopied] = useState(false);
  const tab = preview?.activeTab ?? null;
  const content = preview?.activeContent ?? null;
  const git = project.git;

  useEffect(() => {
    if (tab?.jumpLine != null) setMarkdownMode("source");
  }, [tab?.id, tab?.jumpLine]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const changedPaths = useMemo(
    () => new Set((git?.files ?? []).map((file) => file.path)),
    [git],
  );

  if (!preview || !tab) return null;

  const rootName = git?.repo?.name ?? basename(preview.fileList?.root) ?? tr("工作区", "Workspace");
  // 工作区外的标签 id 是绝对路径,面包屑不再挂工作区根名。
  const absoluteTab = isAbsolutePathLike(tab.id);
  const canCopy = content?.kind === "text" && Boolean(content.content);
  const canShowDiff = Boolean(git?.repo) && changedPaths.has(tab.id);
  const markdownBody = isMarkdownPath(tab.id) && content?.kind === "text" && Boolean(content.content);
  const showRendered = markdownBody && markdownMode === "preview" && tab.jumpLine == null;

  return (
    <div className="panel-file-preview-view">
      <div className="preview-subbar">
        <div className="preview-breadcrumbs-text" title={tab.id}>
          {absoluteTab ? null : <span>{rootName}</span>}
          {tab.dir
            ? tab.dir.split("/").map((segment) => <span key={segment}>{segment}</span>)
            : null}
          <strong>{tab.name}</strong>
        </div>
        <div className="preview-actions-group">
          <button
            type="button"
            className={`icon-btn-ghost${explorerOpen ? " on" : ""}`}
            title={explorerOpen ? tr("收起文件树", "Hide file tree") : tr("展开文件树", "Show file tree")}
            aria-label={tr("文件树", "File tree")}
            aria-pressed={explorerOpen}
            onClick={() => setExplorerOpen((value) => !value)}
          >
            <GridIcon size={12} />
          </button>
          {markdownBody ? (
            <div className="preview-view-toggle" role="group" aria-label={tr("Markdown 显示方式", "Markdown view mode")}>
              <button
                type="button"
                aria-pressed={showRendered}
                className={showRendered ? "active" : ""}
                onClick={() => setMarkdownMode("preview")}
              >
                {tr("预览", "Preview")}
              </button>
              <button
                type="button"
                aria-pressed={!showRendered}
                className={showRendered ? "" : "active"}
                onClick={() => setMarkdownMode("source")}
              >
                {tr("源码", "Source")}
              </button>
            </div>
          ) : null}
          {canShowDiff ? (
            <button
              type="button"
              className="preview-action-pill"
              title={tr("查看该文件的 Git 差异", "View this file's Git diff")}
              onClick={() => onShowDiff(tab.id)}
            >
              {tr("差异", "Diff")}
            </button>
          ) : null}
          <button
            type="button"
            className="icon-btn-ghost"
            title={tr("重新读取", "Reload")}
            aria-label={tr("重新读取", "Reload")}
            onClick={preview.reloadActive}
          >
            <span className="preview-reload" aria-hidden="true">
              ↻
            </span>
          </button>
          <button
            type="button"
            className="icon-btn-ghost"
            title={copied ? tr("已复制", "Copied") : tr("复制文件内容", "Copy file contents")}
            aria-label={copied ? tr("已复制", "Copied") : tr("复制文件内容", "Copy file contents")}
            disabled={!canCopy}
            onClick={() => {
              if (!content?.content) return;
              void navigator.clipboard.writeText(content.content).then(() => setCopied(true));
            }}
          >
            {copied ? <CheckIcon size={13} /> : <CopyIcon />}
          </button>
          <button
            type="button"
            className="icon-btn-ghost"
            title={tr("用默认应用打开", "Open with default app")}
            aria-label={tr("用默认应用打开", "Open with default app")}
            disabled={!content}
            onClick={() => {
              if (content) project.openFile(content.absolutePath);
            }}
          >
            <ExternalIcon size={13} />
          </button>
        </div>
      </div>

      <div className={`preview-main-split${explorerOpen ? "" : " explorer-hidden"}`}>
        {showRendered && content?.content ? (
          <MarkdownPane
            text={content.content}
            documentPath={tab.id}
            truncated={content.truncated}
            revision={preview.revision}
          />
        ) : (
          <CodePane onOpenExternal={(absolutePath) => project.openFile(absolutePath)} />
        )}
        {explorerOpen ? <ExplorerPane /> : null}
      </div>
    </div>
  );
}

function CopyIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function basename(path: string | null | undefined): string | null {
  if (!path) return null;
  const parts = path.split("/").filter(Boolean);
  return parts.pop() ?? null;
}
