import { useMemo } from "react";
import { parseUnifiedDiff, splitDiffRows, type DiffRow } from "./diff-rows";
import { tokenStyle, useDiffHighlight, type HighlightedDiff } from "./diff-highlight";
import type { ThemedToken } from "./preview/highlighter";
import { parseToolDiff } from "./tool-diff";
import { tr } from "../locale";

/** mode 只影响展示:unified 单列,split 并排;不改变任何提交内容。 */
export type DiffViewMode = "unified" | "split";

export function DiffPane({
  path,
  diff,
  mode = "unified",
  format = "unified",
  showLineNumbers = false,
}: {
  path: string;
  diff: string;
  mode?: DiffViewMode;
  format?: "unified" | "tool";
  showLineNumbers?: boolean;
}) {
  const parsed = useMemo(() => format === "tool" ? parseToolDiff(diff) : parseUnifiedDiff(diff), [diff, format]);
  const highlight = useDiffHighlight(path, parsed.oldLines, parsed.newLines);

  if (mode === "split") {
    return <SplitDiff rows={parsed.rows} highlight={highlight} showLineNumbers={showLineNumbers} />;
  }

  return (
    <pre className="changes-diff-body diff-content-enter">
      {parsed.rows.map((row, index) => (
        <DiffLine key={index} row={row} highlight={highlight} showLineNumbers={showLineNumbers} />
      ))}
    </pre>
  );
}

function SplitDiff({ rows, highlight, showLineNumbers }: { rows: DiffRow[]; highlight: HighlightedDiff | null; showLineNumbers: boolean }) {
  const split = useMemo(() => splitDiffRows(rows), [rows]);
  return (
    <pre className="changes-diff-body diff-content-enter diff-split">
      {split.map((row, index) => {
        if (row.full) {
          return (
            <div key={index} className={`diff-split-full diff-line ${row.full.kind}`}>
              {rowText(row.full)}
            </div>
          );
        }
        return (
          <div key={index} className="diff-split-row">
            <SplitCell row={row.left} highlight={highlight} side="old" showLineNumbers={showLineNumbers} />
            <SplitCell row={row.right} highlight={highlight} side="new" showLineNumbers={showLineNumbers} />
          </div>
        );
      })}
    </pre>
  );
}

function SplitCell({
  row,
  highlight,
  side,
  showLineNumbers,
}: {
  row: DiffRow | null;
  highlight: HighlightedDiff | null;
  side: "old" | "new";
  showLineNumbers: boolean;
}) {
  if (!row) return <span className="diff-split-cell diff-split-empty" aria-hidden="true" />;
  const tokens = rowTokens(row, highlight);
  return (
    <span className={`diff-split-cell diff-line ${row.kind}`}>
      {showLineNumbers ? <span className="diff-line-number" aria-hidden="true">{side === "old" ? row.oldLineNumber : row.newLineNumber}</span> : null}
      <span className="diff-code"><span className="diff-sign" aria-hidden={showLineNumbers || undefined}>{row.sign}</span>{tokens
        ? tokens.map((token, index) => (
            <span key={index} style={tokenStyle(token)}>
              {token.content}
            </span>
          ))
        : row.text || " "}</span>
    </span>
  );
}

function DiffLine({ row, highlight, showLineNumbers }: { row: DiffRow; highlight: HighlightedDiff | null; showLineNumbers: boolean }) {
  if (row.kind !== "add" && row.kind !== "del" && row.kind !== "ctx") {
    return <div className={`diff-line ${row.kind}`}>{rowText(row)}</div>;
  }
  const tokens = rowTokens(row, highlight);
  return (
    <div className={`diff-line ${row.kind}`}>
      {showLineNumbers && <><span className="diff-line-number" aria-hidden="true">{row.oldLineNumber ?? ''}</span><span className="diff-line-number" aria-hidden="true">{row.newLineNumber ?? ''}</span></>}
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

function rowText(row: DiffRow): string {
  return row.omitted ? tr("未修改的行已省略", "Unchanged lines omitted") : row.text || " ";
}

/** 上下文行取新侧 token;两侧内容一致,缺哪侧用哪侧兜底。 */
function rowTokens(row: DiffRow, highlight: HighlightedDiff | null): ThemedToken[] | null {
  if (!highlight) return null;
  if (row.kind === "add") return highlight.new?.[row.newIndex] ?? null;
  if (row.kind === "del") return highlight.old?.[row.oldIndex] ?? null;
  return highlight.new?.[row.newIndex] ?? highlight.old?.[row.oldIndex] ?? null;
}
