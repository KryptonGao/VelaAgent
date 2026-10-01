import type { ToolTrace } from "@vela/shared";

/** 可折叠进紧凑摘要的工具种类,与 ToolCard 的 ToolKind 对齐(不含 other)。 */
export type CompactKind = "bash" | "read" | "edit" | "write";

export function toolCompactKind(name: string): CompactKind | null {
  if (name === "bash" || name === "read" || name === "edit" || name === "write") return name;
  return null;
}

/** 摘要里的一段动作统计,如「已编辑 2 个文件」。 */
export interface CompactSummaryPart {
  kind: CompactKind;
  count: number;
}

/** 把一组工具按首次出现的种类聚合计数,忽略计划、提问等不可折叠工具。 */
export function compactSummaryParts(tools: ToolTrace[]): CompactSummaryPart[] {
  const order: CompactKind[] = [];
  const counts = new Map<CompactKind, number>();
  const seenFiles = new Set<string>();
  for (const tool of tools) {
    const kind = toolCompactKind(tool.name);
    if (!kind) continue;
    if (kind !== "bash") {
      const path = tool.activity?.path?.trim().replaceAll("\\", "/");
      if (path) {
        const key = `${kind}:${path}`;
        if (seenFiles.has(key)) continue;
        seenFiles.add(key);
      }
    }
    if (!counts.has(kind)) order.push(kind);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return order.map((kind) => ({ kind, count: counts.get(kind) ?? 0 }));
}

export interface DiffStat {
  added: number;
  removed: number;
}

/** 统计一条展示 diff 的增删行数;行首是 +、- 或空格,+++/--- 是文件头不算。 */
export function diffStat(diff: string | undefined): DiffStat | null {
  if (!diff) return null;
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
  }
  if (added === 0 && removed === 0) return null;
  return { added, removed };
}

/** 展示 diff 的一行;gap 是省略的上下文,不占两侧内容索引。 */
export interface DisplayDiffRow {
  kind: "add" | "del" | "ctx" | "gap";
  /** 行号列;gap 行为空串。 */
  gutter: string;
  text: string;
  /** 该行在旧文件中的索引;不存在时为 -1。 */
  oldIndex: number;
  /** 该行在新文件中的索引;不存在时为 -1。 */
  newIndex: number;
}

export interface ParsedDisplayDiff {
  rows: DisplayDiffRow[];
  /** 旧/新两侧按行拼接的内容,供 shiki 整体分词后把 token 贴回对应行。 */
  oldLines: string[];
  newLines: string[];
}

/** 行首是 +、- 或空格,随后是行号和内容。 */
const displayDiffLine = /^([+\- ]) *(\d+) (.*)$/;

/** 解析 edit / write 的展示 diff(形如 `+ 12 new line`);省略的上下文是一行 `...`。 */
export function parseDisplayDiff(diff: string): ParsedDisplayDiff {
  const rows: DisplayDiffRow[] = [];
  const oldLines: string[] = [];
  const newLines: string[] = [];
  if (!diff) return { rows, oldLines, newLines };

  const lines = diff.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();

  const pushAdd = (text: string, gutter = "") => {
    rows.push({ kind: "add", gutter, text, oldIndex: -1, newIndex: newLines.length });
    newLines.push(text);
  };
  const pushDel = (text: string, gutter = "") => {
    rows.push({ kind: "del", gutter, text, oldIndex: oldLines.length, newIndex: -1 });
    oldLines.push(text);
  };
  const pushCtx = (text: string, gutter = "") => {
    rows.push({ kind: "ctx", gutter, text, oldIndex: oldLines.length, newIndex: newLines.length });
    oldLines.push(text);
    newLines.push(text);
  };

  for (const line of lines) {
    if (line.trim() === "..." || line.trim() === "…") {
      rows.push({ kind: "gap", gutter: "", text: "…", oldIndex: -1, newIndex: -1 });
      continue;
    }
    if (line.startsWith("…") || line.startsWith("@@")) {
      rows.push({ kind: "gap", gutter: "", text: line, oldIndex: -1, newIndex: -1 });
      continue;
    }
    const matched = displayDiffLine.exec(line);
    if (matched) {
      const text = matched[3] ?? "";
      const gutter = matched[2] ?? "";
      if (matched[1] === "+") pushAdd(text, gutter);
      else if (matched[1] === "-") pushDel(text, gutter);
      else pushCtx(text, gutter);
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) pushAdd(line.slice(1));
    else if (line.startsWith("-") && !line.startsWith("---")) pushDel(line.slice(1));
    else if (line.startsWith(" ")) pushCtx(line.slice(1));
    else pushCtx(line);
  }

  return { rows, oldLines, newLines };
}

/** 汇总一组工具的 diff 增删行数,全部为空时返回 null。 */
export function totalDiffStat(tools: ToolTrace[]): DiffStat | null {
  let added = 0;
  let removed = 0;
  for (const tool of tools) {
    const stat = diffStat(tool.activity?.diff);
    if (stat) {
      added += stat.added;
      removed += stat.removed;
    }
  }
  if (added === 0 && removed === 0) return null;
  return { added, removed };
}

/** 把文件路径拆成文件名和目录;没有目录部分时 dir 为空。 */
export function splitPath(path: string): { name: string; dir: string } {
  const normalized = path.replaceAll("\\", "/");
  const index = normalized.lastIndexOf("/");
  if (index <= 0) return { name: path, dir: "" };
  return { name: normalized.slice(index + 1), dir: normalized.slice(0, index) };
}
