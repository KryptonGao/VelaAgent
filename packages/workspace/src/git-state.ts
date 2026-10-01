import { access, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { GitFileStatus, GitInProgressOperation, GitOperationState } from "@vela/shared";
import { gitDir, gitQuery, runGit } from "./git-run";

/** GitService、Stash、Worktree、冲突处理共用的低层 Git 查询。 */

export async function resolveRepoRoot(cwd: string): Promise<string | null> {
  try {
    const result = await runGit(cwd, ["--no-optional-locks", "rev-parse", "--show-toplevel"]);
    if (result.code !== 0) return null;
    const root = result.stdout.trim();
    return root || null;
  } catch {
    return null;
  }
}

export async function resolveGitDir(cwd: string): Promise<string | null> {
  try {
    const dir = await gitDir(cwd);
    return dir || null;
  } catch {
    return null;
  }
}

export async function hasHead(cwd: string): Promise<boolean> {
  const result = await runGit(cwd, ["--no-optional-locks", "rev-parse", "--verify", "--quiet", "HEAD"]);
  return result.code === 0;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function readLastFetchAt(gitDirPath: string): Promise<number | null> {
  try {
    const info = await stat(join(gitDirPath, "FETCH_HEAD"));
    return info.mtimeMs;
  } catch {
    return null;
  }
}

export async function detectOperation(gitDirPath: string): Promise<GitOperationState | null> {
  const checks: Array<{ kind: GitInProgressOperation; markers: string[] }> = [
    { kind: "merge", markers: ["MERGE_HEAD"] },
    { kind: "rebase", markers: ["rebase-merge", "rebase-apply"] },
    { kind: "cherry-pick", markers: ["CHERRY_PICK_HEAD"] },
    { kind: "revert", markers: ["REVERT_HEAD"] },
  ];
  for (const check of checks) {
    for (const marker of check.markers) {
      if (await pathExists(join(gitDirPath, marker))) {
        return { kind: check.kind, conflictedPaths: [] };
      }
    }
  }
  return null;
}

/** 未合并(冲突)文件列表,供冲突编辑器与 continue 前检查使用。 */
export async function listConflictedPaths(cwd: string): Promise<string[]> {
  try {
    const stdout = await gitQuery(cwd, ["diff", "--name-only", "--diff-filter=U", "-z"]);
    return stdout.split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

export async function readHeadSha(cwd: string): Promise<string | null> {
  const result = await runGit(cwd, ["--no-optional-locks", "rev-parse", "--verify", "--quiet", "HEAD"]);
  if (result.code !== 0) return null;
  const sha = result.stdout.trim();
  return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
}

export async function readShortSha(cwd: string): Promise<string | null> {
  const result = await runGit(cwd, ["--no-optional-locks", "rev-parse", "--short", "HEAD"]);
  if (result.code !== 0) return null;
  const sha = result.stdout.trim();
  return sha || null;
}

export async function readCurrentBranch(cwd: string): Promise<string | null> {
  try {
    const stdout = await gitQuery(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const branch = stdout.trim();
    return branch && branch !== "HEAD" ? branch : null;
  } catch {
    return null;
  }
}

export async function resolveUpstream(cwd: string): Promise<string | null> {
  try {
    const stdout = await gitQuery(cwd, [
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{upstream}",
    ]);
    const value = stdout.trim();
    return value || null;
  } catch {
    return null;
  }
}

export async function resolveCommit(cwd: string, value: string): Promise<string | null> {
  const result = await runGit(cwd, [
    "--no-optional-locks",
    "rev-parse",
    "--verify",
    "--quiet",
    `${value}^{commit}`,
  ]);
  if (result.code !== 0) return null;
  const sha = result.stdout.trim();
  return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
}

export async function isShallowRepository(cwd: string): Promise<boolean> {
  try {
    const stdout = await gitQuery(cwd, ["rev-parse", "--is-shallow-repository"]);
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

export async function objectExists(cwd: string, sha: string): Promise<boolean> {
  const result = await runGit(cwd, ["--no-optional-locks", "cat-file", "-e", `${sha}^{commit}`]);
  return result.code === 0;
}

/** 判断路径是否已存在于索引(已跟踪);未跟踪/忽略文件返回 false。 */
export async function isTrackedPath(cwd: string, path: string): Promise<boolean> {
  const result = await runGit(cwd, [
    "--no-optional-locks",
    "ls-files",
    "--error-unmatch",
    "-z",
    "--",
    path,
  ]);
  return result.code === 0;
}

export async function listRemoteNames(cwd: string): Promise<string[]> {
  try {
    const stdout = await gitQuery(cwd, ["remote"]);
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function parseNumstatZ(stdout: string): Map<string, { added: number; deleted: number }> {
  const result = new Map<string, { added: number; deleted: number }>();
  const records = stdout.split("\0");
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    const tabs = record.split("\t");
    if (tabs.length < 3) continue;
    const added = tabs[0] === "-" ? 0 : Number(tabs[0]) || 0;
    const deleted = tabs[1] === "-" ? 0 : Number(tabs[1]) || 0;
    let path = tabs.slice(2).join("\t");
    if (path === "") {
      // rename/copy:-z 格式里路径字段为空,随后是 old\0new\0。
      const newPath = records[index + 2];
      index += 2;
      if (newPath === undefined) break;
      path = newPath;
    }
    if (path) result.set(path, { added, deleted });
  }
  return result;
}

export async function readNumstat(
  cwd: string,
  args: string[],
): Promise<Map<string, { added: number; deleted: number }>> {
  try {
    const stdout = await gitQuery(cwd, args);
    return parseNumstatZ(stdout);
  } catch {
    return new Map();
  }
}

export function parseNameStatusZ(stdout: string): Array<{
  path: string;
  oldPath: string | null;
  status: GitFileStatus;
}> {
  const entries: Array<{ path: string; oldPath: string | null; status: GitFileStatus }> = [];
  const records = stdout.split("\0");
  for (let index = 0; index < records.length; index += 1) {
    const code = records[index];
    if (!code) continue;
    const letter = code[0]?.toUpperCase();
    if (letter === "R" || letter === "C") {
      const oldPath = records[index + 1];
      const path = records[index + 2];
      index += 2;
      if (!path || !oldPath) continue;
      entries.push({ path, oldPath, status: "renamed" });
    } else {
      const path = records[index + 1];
      index += 1;
      if (!path) continue;
      entries.push({ path, oldPath: null, status: mapDiffStatus(letter) });
    }
  }
  return entries;
}

export function mapDiffStatus(letter: string | undefined): GitFileStatus {
  switch (letter) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
    case "C":
      return "renamed";
    case "M":
    case "T":
    default:
      return "modified";
  }
}

/** 读取文本文件内容;不存在或不可读返回 null。 */
export async function readFileIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}
