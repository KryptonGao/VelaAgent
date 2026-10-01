import { stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  GitWorktreeCreateInput,
  GitWorktreeCreateResult,
  GitWorktreeInfo,
  GitWorktreePruneResult,
  GitWorktreeRemoveInput,
  GitWorktreeRemoveResult,
} from "@vela/shared";
import { assertSafeRevision, assertValidRefName, gitQuery, runGit } from "./git-run";

/** 并发检查 worktree 改动状态的上限,避免大量 worktree 时拖慢界面。 */
const maxStatusChecks = 12;

export interface WorktreeListOptions {
  /** Vela 受管 worktree 根目录;用于标记 managed */
  managedRoot: string | null;
  /** 当前工作区路径,用于标记 current */
  currentWorkspace: string | null;
}

export async function listWorktrees(cwd: string, options: WorktreeListOptions): Promise<GitWorktreeInfo[]> {
  const stdout = await gitQuery(cwd, ["worktree", "list", "--porcelain"]).catch(() => "");
  const entries: Array<{
    path: string;
    head: string | null;
    branch: string | null;
    bare: boolean;
    detached: boolean;
    locked: boolean;
  }> = [];
  let current: (typeof entries)[number] | null = null;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = {
        path: line.slice("worktree ".length).trim(),
        head: null,
        branch: null,
        bare: false,
        detached: false,
        locked: false,
      };
      entries.push(current);
    } else if (!current) {
      continue;
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length).trim() || null;
    } else if (line.startsWith("branch refs/heads/")) {
      current.branch = line.slice("branch refs/heads/".length).trim() || null;
    } else if (line === "bare") {
      current.bare = true;
    } else if (line === "detached") {
      current.detached = true;
    } else if (line.startsWith("locked")) {
      current.locked = true;
    }
  }

  const results: GitWorktreeInfo[] = [];
  let checks = 0;
  for (const entry of entries) {
    const exists = await isDirectory(entry.path);
    let changeCount: number | null = null;
    let untrackedCount: number | null = null;
    if (exists && !entry.bare && checks < maxStatusChecks) {
      checks += 1;
      const status = await readWorktreeStatus(entry.path);
      changeCount = status?.total ?? null;
      untrackedCount = status?.untracked ?? null;
    }
    results.push({
      path: entry.path,
      current: isSamePath(entry.path, options.currentWorkspace),
      bare: entry.bare,
      detached: entry.detached,
      locked: entry.locked,
      prunable: !exists,
      missing: !exists,
      managed: isInside(entry.path, options.managedRoot),
      head: entry.head,
      shortHead: entry.head ? entry.head.slice(0, 7) : null,
      branch: entry.branch,
      changeCount,
      untrackedCount,
    });
  }
  return results;
}

export async function createWorktree(
  cwd: string,
  input: GitWorktreeCreateInput,
  managedRoot: string | null,
): Promise<GitWorktreeCreateResult> {
  const repoName = basename(await resolveRepoRootForName(cwd));
  const branch = input.branch.trim();
  await assertValidRefName(cwd, branch);
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const suggestedName = `${repoName}-${sanitizeSegment(branch)}-${stamp.slice(2)}`;
  let target: string;
  if (input.path?.trim()) {
    target = resolve(input.path.trim());
    if (!isAbsolute(target)) throw new Error("worktree 路径需要绝对路径");
  } else {
    if (!managedRoot) throw new Error("未配置 worktree 目录");
    target = join(managedRoot, suggestedName);
  }
  if (await pathExists(target)) throw new Error(`目标路径已存在：${target}`);

  const args = ["worktree", "add"];
  if (input.newBranch) args.push("-b", branch);
  args.push(target);
  if (input.newBranch) {
    if (input.startPoint?.trim()) args.push(assertSafeRevision(input.startPoint.trim()));
  } else {
    args.push(branch);
  }
  const result = await runGit(cwd, args, 120_000);
  if (result.code !== 0) {
    return {
      ok: false,
      message: firstLine(result.stderr) ?? "创建 worktree 失败",
      path: null,
      branch: null,
    };
  }
  return { ok: true, message: `已创建 worktree：${target}`, path: target, branch };
}

export async function removeWorktree(
  cwd: string,
  input: GitWorktreeRemoveInput,
  currentWorkspace: string | null,
): Promise<GitWorktreeRemoveResult> {
  const target = resolve(input.path.trim());
  if (isSamePath(target, currentWorkspace)) {
    return { ok: false, message: "不能删除当前工作区所在的 worktree，请先切换工作区。", blocked: true, changeCount: null };
  }
  if (!(await isDirectory(target))) {
    // 目录已经不在时交给 prune 清理记录。
    return { ok: true, message: "目录已不存在，可执行清理移除记录。", blocked: false, changeCount: null };
  }
  const status = await readWorktreeStatus(target);
  const changeCount = status?.total ?? null;
  if (!input.force && changeCount !== null && changeCount > 0) {
    return {
      ok: false,
      message: `该 worktree 还有 ${changeCount} 个文件未保存（含 ${status?.untracked ?? 0} 个未跟踪文件）。确认后会删除目录内容。`,
      blocked: true,
      changeCount,
    };
  }
  const args = ["worktree", "remove"];
  if (input.force) args.push("--force");
  args.push(target);
  const result = await runGit(cwd, args, 60_000);
  if (result.code !== 0) {
    return {
      ok: false,
      message: firstLine(result.stderr) ?? "删除 worktree 失败",
      blocked: false,
      changeCount,
    };
  }
  return { ok: true, message: `已删除 worktree：${target}`, blocked: false, changeCount };
}

export async function pruneWorktrees(
  cwd: string,
  options: WorktreeListOptions,
): Promise<GitWorktreePruneResult> {
  const before = await listWorktrees(cwd, options).catch(() => []);
  const candidates = before.filter((entry) => entry.missing && !entry.bare).map((entry) => entry.path);
  const result = await runGit(cwd, ["worktree", "prune"], 30_000);
  if (result.code !== 0) {
    return { ok: false, message: firstLine(result.stderr) ?? "清理 worktree 失败", pruned: [] };
  }
  return {
    ok: true,
    message: candidates.length > 0 ? `已清理 ${candidates.length} 条 worktree 记录` : "没有需要清理的 worktree 记录",
    pruned: candidates,
  };
}

async function readWorktreeStatus(path: string): Promise<{ total: number; untracked: number } | null> {
  try {
    const stdout = await gitQuery(path, ["status", "--porcelain"]);
    const lines = stdout.split("\n").filter((line) => line.trim().length > 0);
    return {
      total: lines.length,
      untracked: lines.filter((line) => line.startsWith("??")).length,
    };
  } catch {
    return null;
  }
}

async function resolveRepoRootForName(cwd: string): Promise<string> {
  try {
    const stdout = await gitQuery(cwd, ["rev-parse", "--show-toplevel"]);
    return stdout.trim() || cwd;
  } catch {
    return cwd;
  }
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "worktree";
}

function isSamePath(left: string, right: string | null): boolean {
  if (!right) return false;
  const normalize = (path: string): string => resolve(path).replace(new RegExp(`${sep}$`), "");
  return normalize(left) === normalize(right);
}

function isInside(path: string, root: string | null): boolean {
  if (!root) return false;
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function firstLine(text: string): string | null {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return null;
}
