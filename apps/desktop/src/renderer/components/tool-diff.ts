import type { DiffRow, ParsedDiff } from "./diff-rows";

/** 工具保存的是带行号的展示记录，不是 Git patch，也不是完整文件快照。 */
export function parseToolDiff(diff: string): ParsedDiff {
  const rows: DiffRow[] = [];
  const oldLines: string[] = [];
  const newLines: string[] = [];
  let offset = 0;
  let canInfer = true;
  const lines = diff ? diff.split("\n") : [];
  if (lines.at(-1) === "") lines.pop();
  for (const source of lines) {
    const line = source.replace(/\r$/, "");
    const match = /^([ +\-])\s*(\d+) (.*)$/.exec(line);
    const number = match ? Number(match[2]) : 0;
    if (match && Number.isSafeInteger(number) && number > 0) {
      const sign = match[1];
      const text = match[3];
      const kind = sign === "+" ? "add" : sign === "-" ? "del" : "ctx";
      const oldIndex = kind === "add" ? -1 : oldLines.push(text) - 1;
      const newIndex = kind === "del" ? -1 : newLines.push(text) - 1;
      rows.push({
        kind, text, sign, oldIndex, newIndex,
        ...(kind !== "add" ? { oldLineNumber: number } : {}),
        ...(kind === "add" ? { newLineNumber: number }
          : kind === "ctx" && canInfer && number + offset > 0 ? { newLineNumber: number + offset } : {}),
      });
      if (kind === "add") offset += 1;
      if (kind === "del") offset -= 1;
    } else {
      const omitted = /^ +\.\.\.$/.test(line);
      rows.push({ kind: "note", text: line, sign: "", oldIndex: -1, newIndex: -1, ...(omitted ? { omitted: true } : {}) });
      // 省略标记只省略未修改行；未知/截断记录则无法保证后续新侧上下文行号。
      if (!omitted) canInfer = false;
    }
  }
  return { rows, oldLines, newLines, oldText: oldLines.join("\n"), newText: newLines.join("\n") };
}
