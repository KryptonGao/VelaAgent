import type {
  GitStashApplyInput,
  GitStashApplyResult,
  GitStashCreateInput,
  GitStashCreateResult,
  GitStashEntry,
} from "@vela/shared";
import { assertRepoRelativePath, gitQuery, runGit } from "./git-run";
import { listConflictedPaths } from "./git-state";

const maxStashMessageLength = 200;

/** `stash@{0}` 与纯序号都接受,统一成 `stash@{n}`。 */
export function normalizeStashId(value: string): string {
  const trimmed = value.trim();
  const direct = /^stash@\{(\d+)\}$/.exec(trimmed);
  if (direct) return `stash@{${direct[1]}}`;
  if (/^\d+$/.test(trimmed)) return `stash@{${trimmed}}`;
  throw new Error("Stash 记录不正确");
}

export async function listStashes(cwd: string): Promise<GitStashEntry[]> {
  let stdout: string;
  try {
    stdout = await gitQuery(cwd, ["stash", "list", "--format=%gd%x1f%gs%x1f%ct%x1f%H"]);
  } catch {
    return [];
  }
  const entries: GitStashEntry[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const [id, subject, unix, sha] = line.split("\x1f");
    if (!id) continue;
    const parsed = parseStashSubject(subject ?? "");
    const seconds = Number(unix);
    entries.push({
      id,
      index: stashIndex(id),
      message: parsed.message,
      branch: parsed.branch,
      at: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null,
      sha: sha && /^[0-9a-f]{7,64}$/i.test(sha) ? sha : null,
    });
  }
  return entries;
}

export async function createStash(cwd: string, input: GitStashCreateInput): Promise<GitStashCreateResult> {
  const message = input.message.trim().slice(0, maxStashMessageLength);
  const paths = input.paths?.filter(Boolean).map((path) => assertRepoRelativePath(path)) ?? [];
  const args = ["stash", "push"];
  if (message) args.push("-m", message);
  // 指定路径的 stash 不支持同时包含未跟踪文件,按 Git 语义只保存这些路径。
  if (input.includeUntracked && paths.length === 0) args.push("--include-untracked");
  if (paths.length > 0) args.push("--", ...paths);

  const result = await runGit(cwd, args, 60_000);
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.code !== 0) {
    return { ok: false, message: firstLine(output) ?? "保存 Stash 失败", stash: null, empty: false };
  }
  if (/no local changes to save/i.test(output)) {
    return { ok: true, message: "没有可保存的改动", stash: null, empty: true };
  }
  const stashes = await listStashes(cwd);
  return {
    ok: true,
    message: message ? `已保存 Stash：${message}` : "已保存 Stash",
    stash: stashes[0] ?? null,
    empty: false,
  };
}

export async function applyStash(cwd: string, input: GitStashApplyInput): Promise<GitStashApplyResult> {
  const id = normalizeStashId(input.id);
  const result = await runGit(cwd, ["stash", input.mode, id], 60_000);
  const output = `${result.stdout}\n${result.stderr}`;
  const conflictedPaths = await listConflictedPaths(cwd).catch(() => []);
  const conflicted = conflictedPaths.length > 0;
  if (result.code !== 0 || conflicted) {
    return {
      ok: false,
      message: conflicted
        ? `应用 Stash 时出现冲突（${conflictedPaths.length} 个文件），Stash 记录已保留`
        : firstLine(output) ?? "应用 Stash 失败",
      conflicted,
      conflictedPaths,
      kept: conflicted || input.mode === "apply",
    };
  }
  const dropped = input.mode === "pop" && !/conflict/i.test(output);
  return {
    ok: true,
    message: input.mode === "pop" ? "已恢复并移除该 Stash" : "已应用 Stash（记录保留）",
    conflicted: false,
    conflictedPaths: [],
    kept: !dropped,
  };
}

export async function dropStash(cwd: string, id: string): Promise<{ ok: boolean; message: string; stashes: GitStashEntry[] }> {
  const normalized = normalizeStashId(id);
  const result = await runGit(cwd, ["stash", "drop", normalized], 30_000);
  const ok = result.code === 0;
  return {
    ok,
    message: ok ? "已删除 Stash 记录" : firstLine(result.stderr) ?? "删除 Stash 失败",
    stashes: await listStashes(cwd),
  };
}

export async function stashDiff(cwd: string, id: string): Promise<string> {
  const normalized = normalizeStashId(id);
  try {
    return await gitQuery(cwd, ["stash", "show", "-p", "--no-color", normalized]);
  } catch {
    // 未跟踪文件不在 stash 提交的父提交差异中,补充其内容。
    try {
      return await gitQuery(cwd, ["diff", "--no-color", normalized, `${normalized}^`]);
    } catch {
      return "";
    }
  }
}

/** `WIP on main: abc123 subject` / `On main: 说明` → 分支与说明。 */
function parseStashSubject(subject: string): { branch: string | null; message: string } {
  const wip = /^WIP on ([^:]+): (?:[0-9a-f]+ )?(.*)$/i.exec(subject);
  if (wip) return { branch: wip[1]?.trim() ?? null, message: wip[2]?.trim() ?? "" };
  const on = /^On ([^:]+): (.*)$/i.exec(subject);
  if (on) return { branch: on[1]?.trim() ?? null, message: on[2]?.trim() ?? "" };
  return { branch: null, message: subject.trim() };
}

function stashIndex(id: string): number {
  const match = /\{(\d+)\}/.exec(id);
  return match ? Number(match[1]) : -1;
}

function firstLine(text: string): string | null {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return null;
}
