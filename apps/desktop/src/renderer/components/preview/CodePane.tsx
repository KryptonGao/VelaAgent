import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useContentArrival } from "../BatchMotion";
import { useFilePreview } from "./FilePreviewContext";
import { localizeError, tr, trf } from "../../locale";
import { highlightDocument, type ThemedToken } from "./highlighter";

/** 超大文件只渲染前若干行,避免一次性创建过多 DOM。 */
const maxRenderRows = 8000;

const fontStyleMask = { italic: 1, bold: 2, underline: 4 } as const;

interface CodeRow {
  line: number;
  text: string;
  tokens: ThemedToken[] | null;
}

export function CodePane({ onOpenExternal }: { onOpenExternal: (absolutePath: string) => void }) {
  const preview = useFilePreview();
  const tab = preview?.activeTab ?? null;
  const content = preview?.activeContent ?? null;

  const [highlight, setHighlight] = useState<{ tabId: string; source: string; lines: ThemedToken[][] } | null>(null);
  const [activeLine, setActiveLine] = useState<{ tabId: string; line: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const arrivalRef = useContentArrival(`${tab?.id ?? "empty"}:${content?.kind ?? (preview?.contentLoading ? "loading" : "empty")}`);
  const sourceText = content?.kind === "text" ? content.content ?? "" : "";
  const plainLines = useMemo(() => splitLines(sourceText), [sourceText]);

  // 切换标签时清掉选中行与高亮;内容更新交给高亮 effect 按文本判断,不清空以免闪成纯文本。
  useEffect(() => {
    setActiveLine(null);
    setHighlight(null);
  }, [tab?.id]);

  // 读取完成后异步高亮;只有文本变化才重新分词,主题色由 CSS 变量决定。
  useEffect(() => {
    if (!tab || !sourceText) return;
    const tabId = tab.id;
    let active = true;
    void highlightDocument(tabId, sourceText).then((result) => {
      if (active) setHighlight(result ? { tabId, source: sourceText, lines: result.lines } : null);
    });
    return () => {
      active = false;
    };
  }, [tab?.id, sourceText]);

  // 行数与高亮结果对齐时才使用 token,否则退回纯文本。
  const rows = useMemo<CodeRow[]>(() => {
    const highlightLines =
      highlight && highlight.tabId === tab?.id && highlight.source === sourceText ? highlight.lines : null;
    if (highlightLines) {
      // shiki 对结尾换行会多算一个空行,先与文本行数对齐。
      const aligned =
        highlightLines.length === plainLines.length
          ? highlightLines
          : highlightLines.length === plainLines.length + 1 && isBlankLine(highlightLines[highlightLines.length - 1])
            ? highlightLines.slice(0, plainLines.length)
            : null;
      if (aligned) {
        return aligned.slice(0, maxRenderRows).map((tokens, index) => ({
          line: index + 1,
          text: plainLines[index] ?? "",
          tokens,
        }));
      }
    }
    return plainLines.slice(0, maxRenderRows).map((text, index) => ({
      line: index + 1,
      text,
      tokens: null,
    }));
  }, [plainLines, sourceText, highlight, tab?.id]);

  // 恢复该标签的上次滚动位置;行数/内容变化后要重新应用,
  // 否则异步读入内容或文件变短时浏览器会把 scrollTop 夹回顶部。
  // 用 layout effect 在绘制前完成,避免先画在顶部再跳回去。
  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (!container || !tab) return;
    // 内容还没渲染出来时容器是塌的,此时写 scrollTop 会被夹成 0,等内容出来再恢复。
    if (container.scrollHeight <= container.clientHeight) return;
    const saved = preview?.getTabScroll(tab.id) ?? 0;
    if (Math.abs(container.scrollTop - saved) > 1) container.scrollTop = saved;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab?.id, rows]);

  // 搜索结果/引用跳转:滚动到目标行并高亮。
  useLayoutEffect(() => {
    const line = tab?.jumpLine;
    const container = scrollRef.current;
    if (!tab || !line || !container) return;
    const target = container.querySelector<HTMLElement>(`[data-line="${line}"]`);
    if (target) {
      target.scrollIntoView({ block: "center" });
      setActiveLine({ tabId: tab.id, line });
      preview?.consumeJump();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab?.jumpLine, rows]);

  if (!preview || !tab) return null;

  const tabId = tab.id;

  return (
    <div className="preview-code-pane" ref={arrivalRef}>
      {content?.kind === "image" ? (
        <div className="preview-image-wrap">
          <img src={content.content ?? undefined} alt={tab.name} />
        </div>
      ) : (
        <div
          ref={scrollRef}
          className="code-scroll"
          onScroll={(event) => {
            const node = event.currentTarget;
            // 容器塌陷(还没内容/正在换行)时的 0 不是用户滚出来的,不能覆盖已记录的位置。
            if (node.scrollHeight <= node.clientHeight) return;
            preview.setTabScroll(tab.id, node.scrollTop);
          }}
        >
          {renderBody()}
        </div>
      )}
    </div>
  );

  function renderBody() {
    if (!content) {
      if (preview?.contentLoading) {
        return <div className="code-state">{tr("正在读取文件…", "Reading file…")}</div>;
      }
      if (preview?.contentError) {
        return <div className="code-state error">{localizeError(preview.contentError)}</div>;
      }
      return <div className="code-state">{tr("选择一个文件开始预览", "Select a file to preview")}</div>;
    }
    if (content.kind === "missing") {
      return (
        <CodeNotice
          title={tr("文件不存在", "File not found")}
          detail={tr("文件已被删除或尚未创建。", "The file was deleted or has not been created yet.")}
          absolutePath={content.absolutePath}
          onOpenExternal={onOpenExternal}
        />
      );
    }
    if (content.kind === "binary") {
      return (
        <CodeNotice
          title={tr("二进制文件", "Binary file")}
          detail={tr("该文件类型不支持在侧栏预览。", "This file type cannot be previewed in the sidebar.")}
          absolutePath={content.absolutePath}
          onOpenExternal={onOpenExternal}
        />
      );
    }
    if (content.kind === "too-large") {
      return (
        <CodeNotice
          title={tr("文件过大", "File is too large")}
          detail={trf("文件大小为 {0}，不支持在侧栏预览。", "File size is {0}. Sidebar preview is not supported.", formatSize(content.size))}
          absolutePath={content.absolutePath}
          onOpenExternal={onOpenExternal}
        />
      );
    }
    if (content.kind === "text" && plainLines.length === 0) {
      return <CodeNotice title={tr("空文件", "Empty file")} detail={tr("该文件没有任何内容。", "This file has no contents.")} />;
    }
    return (
      <>
        <div className="code-rows">
          {rows.map((row) => (
            <div
              className={`code-row${activeLine?.tabId === tabId && activeLine.line === row.line ? " active" : ""}`}
              key={row.line}
              data-line={row.line}
              onClick={() => setActiveLine({ tabId, line: row.line })}
            >
              <span className="code-row-gutter">{row.line}</span>
              <span className="code-row-content">
                {row.tokens
                  ? row.tokens.map((token, index) => (
                      <span key={index} style={tokenStyle(token)}>
                        {token.content}
                      </span>
                    ))
                  : row.text || "\u00A0"}
              </span>
            </div>
          ))}
        </div>
        {plainLines.length > maxRenderRows ? (
          <div className="code-note">
            {trf("文件较长，仅显示前 {0} 行（共 {1} 行）。", "File is long. Showing the first {0} of {1} lines.", maxRenderRows.toLocaleString(), plainLines.length.toLocaleString())}
          </div>
        ) : null}
        {content?.truncated ? <div className="code-note">{tr("文件超过 1 MB，仅显示开头部分。", "File exceeds 1 MB. Showing the beginning only.")}</div> : null}
      </>
    );
  }
}

function CodeNotice({
  title,
  detail,
  absolutePath,
  onOpenExternal,
}: {
  title: string;
  detail: string;
  absolutePath?: string;
  onOpenExternal?: (absolutePath: string) => void;
}) {
  return (
    <div className="code-notice">
      <p className="code-notice-title">{title}</p>
      <p className="code-notice-detail">{detail}</p>
      {absolutePath && onOpenExternal ? (
        <button className="code-notice-action" type="button" onClick={() => onOpenExternal(absolutePath)}>
          {tr("在外部打开", "Open externally")}
        </button>
      ) : null}
    </div>
  );
}

function tokenStyle(token: ThemedToken): { color?: string; fontStyle?: "italic" } {
  const style: { color?: string; fontStyle?: "italic" } = {};
  if (token.color) style.color = token.color;
  if (token.fontStyle && token.fontStyle & fontStyleMask.italic) style.fontStyle = "italic";
  return style;
}

function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function isBlankLine(tokens: ThemedToken[] | undefined): boolean {
  if (!tokens) return false;
  return tokens.every((token) => token.content === "");
}

export function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
