import { useEffect, useMemo, useState } from "react";
import type { ProjectApi } from "../../hooks/useProject";
import { CheckIcon, CloseIcon, ExternalIcon, FileIcon, GridIcon } from "../icons";
import { CodePane } from "./CodePane";
import { ExplorerPane } from "./ExplorerPane";
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

  const rootName = git?.repo?.name ?? basename(preview.fileList?.root) ?? "工作区";
  // 工作区外的标签 id 是绝对路径,面包屑不再挂工作区根名。
  const absoluteTab = isAbsolutePathLike(tab.id);
  const canCopy = content?.kind === "text" && Boolean(content.content);
  const canShowDiff = Boolean(git?.repo) && changedPaths.has(tab.id);
  const markdownBody = isMarkdownPath(tab.id) && content?.kind === "text" && Boolean(content.content);
  const showRendered = markdownBody && markdownMode === "preview" && tab.jumpLine == null;

  return (
    <div className="panel-file-preview-view">
      <div className="preview-tabs-bar">
        <div className="preview-tabs-left">
          {preview.tabs.map((item) => (
            <div
              key={item.id}
              role="button"
              tabIndex={0}
              aria-current={item.id === tab.id ? "true" : undefined}
              className={`preview-tab-item${item.id === tab.id ? " active" : ""}`}
              title={item.id}
              onClick={() => preview.setActiveTab(item.id)}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget) return;
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  preview.setActiveTab(item.id);
                }
              }}
            >
              <FileIcon size={12} />
              <span>{item.name}</span>
              <button
                type="button"
                className="preview-tab-close"
                title="关闭标签"
                aria-label={`关闭 ${item.name}`}
                onClick={(event) => {
                  event.stopPropagation();
                  preview.closeTab(item.id);
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <div className="preview-tabs-right">
          <button
            type="button"
            className={`icon-btn-ghost${explorerOpen ? " on" : ""}`}
            title={explorerOpen ? "收起文件树" : "展开文件树"}
            aria-label="文件树"
            aria-pressed={explorerOpen}
            onClick={() => setExplorerOpen((value) => !value)}
          >
            <GridIcon size={12} />
          </button>
          <button
            type="button"
            className="icon-btn-ghost"
            title="关闭预览,返回上下文面板"
            aria-label="关闭预览"
            onClick={preview.closePreview}
          >
            <CloseIcon size={12} />
          </button>
        </div>
      </div>

      <div className="preview-subbar">
        <div className="preview-breadcrumbs-text" title={tab.id}>
          {absoluteTab ? null : <span>{rootName}</span>}
          {tab.dir
            ? tab.dir.split("/").map((segment) => <span key={segment}>{segment}</span>)
            : null}
          <strong>{tab.name}</strong>
        </div>
        <div className="preview-actions-group">
          {markdownBody ? (
            <div className="preview-view-toggle" role="group" aria-label="Markdown 显示方式">
              <button
                type="button"
                aria-pressed={showRendered}
                className={showRendered ? "active" : ""}
                onClick={() => setMarkdownMode("preview")}
              >
                预览
              </button>
              <button
                type="button"
                aria-pressed={!showRendered}
                className={showRendered ? "" : "active"}
                onClick={() => setMarkdownMode("source")}
              >
                源码
              </button>
            </div>
          ) : null}
          {canShowDiff ? (
            <button
              type="button"
              className="preview-action-pill"
              title="查看该文件的 Git 差异"
              onClick={() => onShowDiff(tab.id)}
            >
              差异
            </button>
          ) : null}
          <button
            type="button"
            className="icon-btn-ghost"
            title="重新读取"
            aria-label="重新读取"
            onClick={preview.reloadActive}
          >
            <span className="preview-reload" aria-hidden="true">
              ↻
            </span>
          </button>
          <button
            type="button"
            className="icon-btn-ghost"
            title={copied ? "已复制" : "复制文件内容"}
            aria-label={copied ? "已复制" : "复制文件内容"}
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
            title="用默认应用打开"
            aria-label="用默认应用打开"
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
