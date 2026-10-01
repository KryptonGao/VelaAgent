import { useMemo } from "react";
import { parseUnifiedDiff, splitDiffRows, type DiffRow } from "./diff-rows";
import { tokenStyle, useDiffHighlight, type HighlightedDiff } from "./diff-highlight";
import type { ThemedToken } from "./preview/highlighter";

/** mode 只影响展示:unified 单列,split 并排;不改变任何提交内容。 */
export type DiffViewMode = "unified" | "split";

export function DiffPane({
  path,
  diff,
  mode = "unified",
}: {
  path: string;
  diff: string;
  mode?: DiffViewMode;
}) {
  const parsed = useMemo(() => parseUnifiedDiff(diff), [diff]);
  const highlight = useDiffHighlight(path, parsed.oldLines, parsed.newLines);

  if (mode === "split") {
    return <SplitDiff rows={parsed.rows} highlight={highlight} />;
  }

  return (
    <pre className="changes-diff-body diff-content-enter">
      {parsed.rows.map((row, index) => (
        <DiffLine key={index} row={row} highlight={highlight} />
      ))}
    </pre>
  );
}

function SplitDiff({ rows, highlight }: { rows: DiffRow[]; highlight: HighlightedDiff | null }) {
  const split = useMemo(() => splitDiffRows(rows), [rows]);
  return (
    <pre className="changes-diff-body diff-content-enter diff-split">
      {split.map((row, index) => {
        if (row.full) {
          return (
            <div key={index} className={`diff-split-full diff-line ${row.full.kind}`}>
              {row.full.text || " "}
            </div>
          );
        }
        return (
          <div key={index} className="diff-split-row">
            <SplitCell row={row.left} highlight={highlight} />
            <SplitCell row={row.right} highlight={highlight} />
          </div>
        );
      })}
    </pre>
  );
}

function SplitCell({
  row,
  highlight,
}: {
  row: DiffRow | null;
  highlight: HighlightedDiff | null;
}) {
  if (!row) return <span className="diff-split-cell diff-split-empty" aria-hidden="true" />;
  const tokens = rowTokens(row, highlight);
  return (
    <span className={`diff-split-cell diff-line ${row.kind}`}>
      <span className="diff-sign">{row.sign}</span>
      {tokens
        ? tokens.map((token, index) => (
            <span key={index} style={tokenStyle(token)}>
              {token.content}
            </span>
          ))
        : row.text || " "}
    </span>
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
