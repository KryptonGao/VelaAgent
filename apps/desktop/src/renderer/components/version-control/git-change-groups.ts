import type { GitChangeScope, GitFileChange, GitFileStatus } from "@vela/shared";

export type ChangeGroupKey = "conflicted" | "unstaged" | "staged";

/** 文件列表里的一行:同一文件可同时出现在已暂存与未暂存两组。 */
export interface ChangeGroupRow {
  file: GitFileChange;
  scope: GitChangeScope | "conflict";
  key: string;
}

export interface ChangeGroups {
  conflicted: ChangeGroupRow[];
  unstaged: ChangeGroupRow[];
  staged: ChangeGroupRow[];
}

/** 按索引/工作区两部分把文件分组;冲突文件单独成组,不重复出现在其他组。 */
export function groupChanges(files: GitFileChange[]): ChangeGroups {
  const conflicted: ChangeGroupRow[] = [];
  const unstaged: ChangeGroupRow[] = [];
  const staged: ChangeGroupRow[] = [];
  for (const file of files) {
    if (file.status === "conflicted") {
      conflicted.push({ file, scope: "conflict", key: `conflict:${file.path}` });
      continue;
    }
    if (file.indexStatus) staged.push({ file, scope: "index", key: `index:${file.path}` });
    if (file.worktreeStatus) unstaged.push({ file, scope: "worktree", key: `worktree:${file.path}` });
  }
  return { conflicted, unstaged, staged };
}

export function matchesChangeFilter(file: GitFileChange, filter: string): boolean {
  const query = filter.trim().toLowerCase();
  if (!query) return true;
  return file.path.toLowerCase().includes(query)
    || (file.oldPath?.toLowerCase().includes(query) ?? false);
}

export function scopeStatus(file: GitFileChange, scope: GitChangeScope | "conflict"): GitFileStatus {
  if (scope === "index") return file.indexStatus ?? file.status;
  if (scope === "worktree") return file.worktreeStatus ?? file.status;
  return "conflicted";
}

export function scopeStats(
  file: GitFileChange,
  scope: GitChangeScope | "conflict",
): { added: number; deleted: number } {
  if (scope === "index") return { added: file.indexAddedLines, deleted: file.indexDeletedLines };
  if (scope === "worktree") return { added: file.worktreeAddedLines, deleted: file.worktreeDeletedLines };
  return { added: file.addedLines, deleted: file.deletedLines };
}

/** 暂存/取消暂存时应传的路径列表。 */
export function pathsForRows(rows: ChangeGroupRow[]): string[] {
  return [...new Set(rows.map((row) => row.file.path))];
}
