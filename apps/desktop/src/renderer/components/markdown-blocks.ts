import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";

const parser = unified().use(remarkParse).use(remarkGfm);

export interface MarkdownBlock {
  offset: number;
  text: string;
}

export interface MarkdownPartition {
  text: string;
  /** Prefix whose block boundaries can no longer be changed by an append. */
  stable: readonly MarkdownBlock[];
  tailOffset: number;
  blocks: readonly MarkdownBlock[];
  wholeDocument: boolean;
}

export function wholeMarkdown(text: string): MarkdownPartition {
  return { text, stable: [], tailOffset: 0, blocks: text ? [{ offset: 0, text }] : [], wholeDocument: true };
}

/** 文档以段落结尾时返回该段落的结束偏移(相对入参文本);以其它节点结尾时返回 undefined。 */
export function trailingParagraphEnd(text: string): number | undefined {
  const last = parser.parse(text).children.at(-1);
  return last?.type === "paragraph" ? last.position?.end.offset : undefined;
}

/** Parse only the mutable suffix. Keep two trailing nodes: a partial line may
 * still become a setext heading, table delimiter, list marker or HTML block.
 * Definitions and footnotes have document-wide scope, so use the original
 * whole-document renderer for those rather than break links or duplicate IDs.
 */
export function partitionMarkdown(text: string, previous?: MarkdownPartition): MarkdownPartition {
  if (previous?.text === text) return previous;
  if (/\[[^\]\n]+\]:|\[\^/.test(text)) {
    return wholeMarkdown(text);
  }
  const append = previous && !previous.wholeDocument && text.startsWith(previous.text);
  const stable = append ? previous.stable : [];
  const offset = append ? previous.tailOffset : 0;
  const suffix = text.slice(offset);
  const nodes = parser.parse(suffix).children;
  const mutableIndex = Math.max(0, nodes.length - 2);
  const pieces = nodes.map((node, index) => {
    const start = index === 0 ? 0 : node.position!.start.offset!;
    const end = nodes[index + 1]?.position?.start.offset ?? suffix.length;
    return { offset: offset + start, text: suffix.slice(start, end) };
  });
  // Empty/whitespace-only content must remain available to subsequent appends.
  const tailOffset = pieces[mutableIndex]?.offset ?? offset;
  return {
    text, stable: [...stable, ...pieces.slice(0, mutableIndex)], tailOffset,
    blocks: [...stable, ...pieces], wholeDocument: false,
  };
}
