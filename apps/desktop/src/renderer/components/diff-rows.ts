/**
 * Git 统一差异(`git diff --no-color`)的解析结果。
 * 逐行保留类型与两侧行索引,并按旧/新文件两个视角拼出整段文本,
 * 供 shiki 高亮后把 token 贴回对应行(块注释、模板字符串等跨行语法才不会串色)。
 */

export type DiffRowKind = "add" | "del" | "ctx" | "hunk" | "meta" | "note";

export interface DiffRow {
  kind: DiffRowKind;
  /** 不含 +/-/空格前缀的行内容。 */
  text: string;
  /** `+`、`-` 或空格;元信息与提示行为空串。 */
  sign: string;
  /** 该行在旧文件中的行索引;不存在时为 -1。 */
  oldIndex: number;
  /** 该行在新文件中的行索引;不存在时为 -1。 */
  newIndex: number;
}

export interface ParsedDiff {
  rows: DiffRow[];
  oldLines: string[];
  newLines: string[];
  /** 旧/新两侧按行拼接的文本,不含结尾换行。 */
  oldText: string;
  newText: string;
}

/** 差异头部与文件级元信息:`diff --git`、`index`、`---`/`+++` 等。 */
function isDiffMeta(line: string): boolean {
  return (
    line.startsWith("diff ") ||
    line.startsWith("index ") ||
    line.startsWith("--- ") ||
    line.startsWith("+++ ") ||
    line.startsWith("new file") ||
    line.startsWith("deleted file") ||
    line.startsWith("old mode") ||
    line.startsWith("new mode") ||
    line.startsWith("similarity index") ||
    line.startsWith("dissimilarity index") ||
    line.startsWith("rename from") ||
    line.startsWith("rename to") ||
    line.startsWith("copy from") ||
    line.startsWith("copy to") ||
    line.startsWith("Binary files")
  );
}

export function parseUnifiedDiff(diff: string): ParsedDiff {
  const rows: DiffRow[] = [];
  const oldLines: string[] = [];
  const newLines: string[] = [];
  if (!diff) return { rows, oldLines, newLines, oldText: "", newText: "" };

  const lines = diff.split("\n");
  // git 输出以换行结尾,split 会多出一个空元素;差异正文里的空行总带前缀,不会为空串。
  if (lines[lines.length - 1] === "") lines.pop();

  for (const line of lines) {
    if (line.startsWith("@@")) {
      rows.push({ kind: "hunk", text: line, sign: "", oldIndex: -1, newIndex: -1 });
      continue;
    }
    if (isDiffMeta(line)) {
      rows.push({ kind: "meta", text: line, sign: "", oldIndex: -1, newIndex: -1 });
      continue;
    }
    if (line.startsWith("\\")) {
      // `\ No newline at end of file` 之类的提示。
      rows.push({ kind: "note", text: line, sign: "", oldIndex: -1, newIndex: -1 });
      continue;
    }
    const sign = line[0] ?? " ";
    if (sign === "+") {
      const text = line.slice(1);
      const newIndex = newLines.length;
      newLines.push(text);
      rows.push({ kind: "add", text, sign, oldIndex: -1, newIndex });
    } else if (sign === "-") {
      const text = line.slice(1);
      const oldIndex = oldLines.length;
      oldLines.push(text);
      rows.push({ kind: "del", text, sign, oldIndex, newIndex: -1 });
    } else if (sign === " ") {
      const text = line.slice(1);
      const oldIndex = oldLines.length;
      const newIndex = newLines.length;
      oldLines.push(text);
      newLines.push(text);
      rows.push({ kind: "ctx", text, sign, oldIndex, newIndex });
    } else {
      // hunk 之外无法识别的前缀行(例如 `Binary files ... differ`),按元信息展示。
      rows.push({ kind: "meta", text: line, sign: "", oldIndex: -1, newIndex: -1 });
    }
  }

  return { rows, oldLines, newLines, oldText: oldLines.join("\n"), newText: newLines.join("\n") };
}

/** 并排显示的一行:两侧各自的内容;full 表示跨两列显示的 hunk 头与元信息。 */
export interface SplitDiffRow {
  left: DiffRow | null;
  right: DiffRow | null;
  full: DiffRow | null;
}

/**
 * 把统一差异按「删除块 → 新增块」成对拆到左右两列。
 * 这是展示层配对,不做词级对齐:删除多于新增时多余的删除只占左列,反之亦然。
 */
export function splitDiffRows(rows: DiffRow[]): SplitDiffRow[] {
  const result: SplitDiffRow[] = [];
  let pendingDeleted: DiffRow[] = [];
  let pendingAdded: DiffRow[] = [];

  const flush = (): void => {
    const count = Math.max(pendingDeleted.length, pendingAdded.length);
    for (let index = 0; index < count; index += 1) {
      result.push({ left: pendingDeleted[index] ?? null, right: pendingAdded[index] ?? null, full: null });
    }
    pendingDeleted = [];
    pendingAdded = [];
  };

  for (const row of rows) {
    if (row.kind === "del") {
      pendingDeleted.push(row);
      continue;
    }
    if (row.kind === "add") {
      pendingAdded.push(row);
      continue;
    }
    flush();
    if (row.kind === "ctx") {
      result.push({ left: row, right: row, full: null });
    } else {
      result.push({ left: null, right: null, full: row });
    }
  }
  flush();
  return result;
}
