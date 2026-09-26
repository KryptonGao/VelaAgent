import type { WorkspaceSearchResult } from "@vela/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { useFilePreview } from "./FilePreviewContext";
import { ancestorsOf, buildFileTree, filterFilePaths, type FileTreeNode } from "./tree";

type SearchMode = "file" | "code";

export function ExplorerPane() {
  const preview = useFilePreview();
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<SearchMode>("file");
  const [manualExpanded, setManualExpanded] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<WorkspaceSearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const searchError = useRef<string | null>(null);

  const activePath = preview?.activeTab?.id ?? null;
  const files = preview?.fileList?.files ?? null;
  const tree = useMemo(() => (files ? buildFileTree(files) : []), [files]);

  useEffect(() => {
    preview?.ensureFileList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 切换激活文件时自动展开其祖先目录。
  useEffect(() => {
    if (!activePath) return;
    const ancestors = ancestorsOf(activePath);
    if (ancestors.length === 0) return;
    setManualExpanded((current) => {
      const next = new Set(current);
      let changed = false;
      for (const dir of ancestors) {
        if (!next.has(dir)) {
          next.add(dir);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [activePath]);

  // 代码搜索:输入防抖后走 IPC。
  useEffect(() => {
    if (mode !== "code") return;
    const trimmed = query.trim();
    if (!trimmed) {
      setResult(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = setTimeout(() => {
      preview
        ?.searchCode(trimmed)
        .then((value) => {
          searchError.current = null;
          setResult(value);
        })
        .catch((error) => {
          setResult({ query: trimmed, matches: [], truncated: false });
          searchError.current = error instanceof Error ? error.message : "搜索失败";
        })
        .finally(() => setSearching(false));
    }, 350);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, mode]);

  if (!preview) return null;

  const trimmed = query.trim();
  const fileMatches = mode === "file" && trimmed ? filterFilePaths(files ?? [], trimmed) : [];

  return (
    <div className="preview-explorer-pane">
      <div className="explorer-search-row">
        <input
          className="explorer-search-input"
          type="text"
          placeholder={mode === "file" ? "筛选文件…" : "搜索代码…"}
          aria-label={mode === "file" ? "筛选文件" : "搜索代码"}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="explorer-mode-chips" role="group" aria-label="搜索范围">
          <button
            type="button"
            aria-pressed={mode === "file"}
            className={`explorer-mode-chip${mode === "file" ? " active" : ""}`}
            onClick={() => setMode("file")}
          >
            文件
          </button>
          <button
            type="button"
            aria-pressed={mode === "code"}
            className={`explorer-mode-chip${mode === "code" ? " active" : ""}`}
            onClick={() => setMode("code")}
          >
            代码
          </button>
        </div>
      </div>

      <div className="explorer-body">
        {!files && !trimmed ? <div className="explorer-empty">正在加载文件列表…</div> : null}

        {mode === "file" && files && !trimmed ? (
          <FileTree
            nodes={tree}
            expanded={manualExpanded}
            activePath={activePath}
            onToggleDir={(path) => {
              setManualExpanded((current) => {
                const next = new Set(current);
                if (next.has(path)) next.delete(path);
                else next.add(path);
                return next;
              });
            }}
            onOpenFile={(path) => preview.openFile(path)}
          />
        ) : null}

        {mode === "file" && fileMatches.length > 0 ? (
          <div className="explorer-results">
            {fileMatches.map((path) => (
              <button
                type="button"
                className={`explorer-result${path === activePath ? " active" : ""}`}
                key={path}
                onClick={() => preview.openFile(path)}
                title={path}
              >
                <ResultPath path={path} />
              </button>
            ))}
            {preview.fileList?.truncated ? (
              <div className="explorer-note">文件较多,列表已截断。</div>
            ) : null}
          </div>
        ) : null}

        {mode === "file" && files && trimmed && fileMatches.length === 0 ? (
          <div className="explorer-empty">没有匹配的文件</div>
        ) : null}

        {mode === "code" ? (
          <div className="explorer-results">
            {searching ? <div className="explorer-empty">正在搜索…</div> : null}
            {!searching && result && result.matches.length === 0 ? (
              <div className="explorer-empty">{searchError.current ?? "没有匹配的代码"}</div>
            ) : null}
            {result?.matches.map((match, index) => (
              <button
                type="button"
                className="explorer-result code"
                key={`${match.path}:${match.line}:${index}`}
                onClick={() => preview.openFile(match.path, { line: match.line })}
                title={`${match.path}:${match.line}`}
              >
                <span className="explorer-result-head">
                  <ResultPath path={match.path} />
                  <span className="explorer-result-line">:{match.line}</span>
                </span>
                <span className="explorer-result-snippet">{match.text || " "}</span>
              </button>
            ))}
            {result?.truncated ? <div className="explorer-note">匹配较多,结果已截断。</div> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function FileTree({
  nodes,
  expanded,
  activePath,
  onToggleDir,
  onOpenFile,
  depth = 0,
}: {
  nodes: FileTreeNode[];
  expanded: Set<string>;
  activePath: string | null;
  onToggleDir: (path: string) => void;
  onOpenFile: (path: string) => void;
  depth?: number;
}) {
  return (
    <>
      {nodes.map((node) =>
        node.type === "dir" ? (
          <div key={node.path}>
            <button
              type="button"
              className="explorer-tree-item dir"
              style={{ paddingLeft: 6 + depth * 12 }}
              aria-expanded={expanded.has(node.path)}
              onClick={() => onToggleDir(node.path)}
              title={node.path}
            >
              <span className="explorer-caret" aria-hidden="true">{expanded.has(node.path) ? "▾" : "›"}</span>
              <span className="explorer-name">{node.name}</span>
            </button>
            {expanded.has(node.path) && node.children ? (
              <FileTree
                nodes={node.children}
                expanded={expanded}
                activePath={activePath}
                onToggleDir={onToggleDir}
                onOpenFile={onOpenFile}
                depth={depth + 1}
              />
            ) : null}
          </div>
        ) : (
          <button
            type="button"
            className={`explorer-tree-item file${node.path === activePath ? " active" : ""}`}
            style={{ paddingLeft: 6 + depth * 12 }}
            key={node.path}
            onClick={() => onOpenFile(node.path)}
            title={node.path}
          >
            <span className="explorer-caret" aria-hidden="true" />
            <span className="explorer-name">{node.name}</span>
          </button>
        ),
      )}
    </>
  );
}

function ResultPath({ path }: { path: string }) {
  const index = path.lastIndexOf("/");
  const name = index >= 0 ? path.slice(index + 1) : path;
  const dir = index >= 0 ? path.slice(0, index) : "";
  return (
    <>
      {dir ? <span className="explorer-result-dir">{dir}/</span> : null}
      <span className="explorer-result-name">{name}</span>
    </>
  );
}
