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
