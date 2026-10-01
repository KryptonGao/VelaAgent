import { useMemo } from "react";
import { parseUnifiedDiff, type DiffRow } from "./diff-rows";
import { tokenStyle, useDiffHighlight, type HighlightedDiff } from "./diff-highlight";
import type { ThemedToken } from "./preview/highlighter";

export function DiffPane({ path, diff }: { path: string; diff: string }) {
  const parsed = useMemo(() => parseUnifiedDiff(diff), [diff]);
  const highlight = useDiffHighlight(path, parsed.oldLines, parsed.newLines);

  return (
    <pre className="changes-diff-body diff-content-enter">
      {parsed.rows.map((row, index) => (
        <DiffLine key={index} row={row} highlight={highlight} />
      ))}
    </pre>
  );
}

function DiffLine({ row, highlight }: { row: DiffRow; highlight: HighlightedDiff | null }) {
  if (row.kind !== "add" && row.kind !== "del" && row.kind !== "ctx") {
    return <div className={`diff-line ${row.kind}`}>{row.text || " "}</div>;
  }
  const tokens = rowTokens(row, highlight);
  return (
    <div className={`diff-line ${row.kind}`}>
      <span className="diff-sign">{row.sign}</span>
      {tokens
        ? tokens.map((token, index) => (
            <span key={index} style={tokenStyle(token)}>
              {token.content}
            </span>
          ))
        : row.text || " "}
    </div>
  );
}

/** 上下文行取新侧 token;两侧内容一致,缺哪侧用哪侧兜底。 */
function rowTokens(row: DiffRow, highlight: HighlightedDiff | null): ThemedToken[] | null {
  if (!highlight) return null;
  if (row.kind === "add") return highlight.new?.[row.newIndex] ?? null;
  if (row.kind === "del") return highlight.old?.[row.oldIndex] ?? null;
  return highlight.new?.[row.newIndex] ?? highlight.old?.[row.oldIndex] ?? null;
}

