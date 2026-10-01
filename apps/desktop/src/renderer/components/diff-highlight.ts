/**
 * 差异高亮的共享逻辑:按文件语言分别对旧/新两侧整体分词,再把 token 贴回每一行。
 * 单个差异过大时跳过高亮,只渲染纯文本,避免一次创建过多 DOM。
 */
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { highlightSnippet, languageForPath, type ThemedToken } from "./preview/highlighter";

const maxHighlightChars = 400_000;
const fontStyleMask = { italic: 1, bold: 2 } as const;

export type TokenLines = ThemedToken[][];

export interface HighlightedDiff {
  old: TokenLines | null;
  new: TokenLines | null;
}

/**
 * 高亮一段差异的旧/新两侧;语言不支持、内容过大或行数对不齐时对应侧为 null,
 * 调用方退回纯文本渲染。
 */
export function useDiffHighlight(
  path: string | null | undefined,
  oldLines: string[],
  newLines: string[],
): HighlightedDiff | null {
  const oldText = useMemo(() => oldLines.join("\n"), [oldLines]);
  const newText = useMemo(() => newLines.join("\n"), [newLines]);
  const [highlight, setHighlight] = useState<HighlightedDiff | null>(null);

  useEffect(() => {
    setHighlight(null);
    const lang = languageForPath(path ?? "");
    if (!lang) return;
    if (oldText.length + newText.length > maxHighlightChars) return;
    let active = true;
    void Promise.all([
      oldLines.length > 0 ? highlightSnippet(lang, oldText) : Promise.resolve(null),
      newLines.length > 0 ? highlightSnippet(lang, newText) : Promise.resolve(null),
    ]).then(([old, next]) => {
      if (!active) return;
      const alignedOld = alignTokens(old, oldLines.length);
      const alignedNew = alignTokens(next, newLines.length);
      setHighlight(alignedOld || alignedNew ? { old: alignedOld, new: alignedNew } : null);
    });
    return () => {
      active = false;
    };
  }, [path, oldText, newText, oldLines.length, newLines.length]);

  return highlight;
}

/** shiki 对结尾换行可能多算一个空行;行数不匹配时退回纯文本。 */
export function alignTokens(lines: TokenLines | null, count: number): TokenLines | null {
  if (!lines) return null;
  if (lines.length === count) return lines;
  if (lines.length === count + 1 && isBlankLine(lines[count])) {
    return lines.slice(0, count);
  }
  return null;
}

function isBlankLine(tokens: ThemedToken[] | undefined): boolean {
  return Boolean(tokens && tokens.every((token) => token.content === ""));
}

/** shiki token 的样式:颜色用 CSS 变量,切主题时重新高亮才拿得到新值。 */
export function tokenStyle(token: ThemedToken): CSSProperties {
  const style: CSSProperties = {};
  if (token.color) style.color = token.color;
  if (token.fontStyle && token.fontStyle & fontStyleMask.italic) style.fontStyle = "italic";
  if (token.fontStyle && token.fontStyle & fontStyleMask.bold) style.fontWeight = 600;
  return style;
}
