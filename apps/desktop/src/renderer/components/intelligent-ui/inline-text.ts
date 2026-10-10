import { safeExternalUrl } from "@vela/shared";

/**
 * 文本组件使用的 Markdown 子集：**粗体**、*斜体*、`代码`、[文字](http 链接)。
 * 只产出数据，没有 HTML：渲染层把每个 token 变成 React 元素，所以模型文字永远不会成为标记。
 */
export type InlineToken =
  | { type: "text"; text: string }
  | { type: "bold"; text: string }
  | { type: "italic"; text: string }
  | { type: "code"; text: string }
  | { type: "link"; text: string; href: string };

const pattern = /\*\*([^*\n]+)\*\*|(?<![*\w])\*(?!\s)([^*\n]*[^*\s])\*(?![*\w])|`([^`\n]+)`|\[([^\]\n]{1,200})\]\(([^)\s]{1,2000})\)/g;

export function tokenizeInline(source: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let last = 0;
  for (const match of source.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) tokens.push({ type: "text", text: source.slice(last, index) });
    if (match[1] !== undefined) tokens.push({ type: "bold", text: match[1] });
    else if (match[2] !== undefined) tokens.push({ type: "italic", text: match[2] });
    else if (match[3] !== undefined) tokens.push({ type: "code", text: match[3] });
    else {
      const href = safeExternalUrl(match[5]);
      // 协议不安全的链接降级为纯文字，不保留 href。
      tokens.push(href ? { type: "link", text: match[4], href } : { type: "text", text: match[0] });
    }
    last = index + match[0].length;
  }
  if (last < source.length) tokens.push({ type: "text", text: source.slice(last) });
  return tokens;
}
