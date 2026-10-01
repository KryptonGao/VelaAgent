import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  GitConflictFile,
  GitConflictResolveInput,
  GitConflictResolveResult,
  GitInProgressOperation,
  GitOperationControlAction,
  GitOperationControlResult,
} from "@vela/shared";
import { assertRepoRelativePath, runGit } from "./git-run";
import {
  detectOperation,
  listConflictedPaths,
  resolveGitDir,
  resolveRepoRoot,
} from "./git-state";

const maxConflictFileBytes = 5 * 1024 * 1024;

/**
 * 冲突处理:读取三方内容、写入解决结果,以及继续/中止进行中的
 * merge/rebase/cherry-pick/revert。continue 使用非交互编辑器,
 * 执行后重新读取真实状态,不把「命令返回 0」当作已完成。
 */
export async function readConflictFile(cwd: string, path: string): Promise<GitConflictFile> {
  assertRepoRelativePath(path);
  const [base, ours, theirs] = await Promise.all([
    showStage(cwd, 1, path),
    showStage(cwd, 2, path),
    showStage(cwd, 3, path),
  ]);
  const mergedBuffer = await readWorktreeBuffer(cwd, path);
  const sideBinary = [base, ours, theirs].some((text) => text !== null && text.includes("\0"));
  const binary = sideBinary || (mergedBuffer?.includes(0) ?? false);
  const merged = binary ? "" : mergedBuffer?.toString("utf8") ?? "";
  return {
    path,
    base: binary ? null : base,
    ours: binary ? null : ours,
    theirs: binary ? null : theirs,
    merged,
    hasMarkers: !binary && /^(<{7}|={7}|>{7})/m.test(merged),
    binary,
    error: null,
  };
}

export async function resolveConflictFile(
  cwd: string,
  input: GitConflictResolveInput,
): Promise<GitConflictResolveResult> {
  const path = assertRepoRelativePath(input.path);
  if (input.content.length > maxConflictFileBytes) {
    return { ok: false, message: "解决内容过大，请在编辑器中处理", remaining: 0 };
  }
  const root = (await resolveRepoRoot(cwd)) ?? cwd;
  const target = join(root, ...path.split("/"));
  try {
    await writeFile(target, input.content, "utf8");
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "写入文件失败",
      remaining: 0,
    };
  }
  const result = await runGit(cwd, ["add", "--", path], 30_000);
  if (result.code !== 0) {
    return { ok: false, message: firstLine(result.stderr) ?? "暂存解决结果失败", remaining: 0 };
  }
  const remaining = await listConflictedPaths(cwd);
  return {
    ok: true,
    message: remaining.length > 0 ? `已暂存解决结果，仍有 ${remaining.length} 个冲突文件` : "已解决并暂存该文件",
    remaining: remaining.length,
  };
}

export async function controlOperation(
  cwd: string,
  action: GitOperationControlAction,
): Promise<GitOperationControlResult> {
  const gitDirPath = await resolveGitDir(cwd);
  const operation = gitDirPath ? await detectOperation(gitDirPath) : null;
  if (!operation) {
    return {
      ok: false,
      action,
      message: "当前没有进行中的 Git 操作",
      operation: null,
      conflictedPaths: [],
    };
  }
  const conflictedBefore = await listConflictedPaths(cwd);
  if (action === "continue" && conflictedBefore.length > 0) {
    return {
      ok: false,
      action,
      message: `仍有 ${conflictedBefore.length} 个冲突文件未解决，请先全部标记为已解决`,
      operation,
      conflictedPaths: conflictedBefore,
    };
  }

  const args = [operationArgs(operation.kind), action === "continue" ? "--continue" : "--abort"];
  const result = await runGit(cwd, args, 180_000, {
    env: { GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true" },
  });
  if (result.code !== 0) {
    const afterFailure = gitDirPath ? await detectOperation(gitDirPath) : null;
    return {
      ok: false,
      action,
      message: firstLine(result.stderr) ?? firstLine(result.stdout) ?? "操作未完成",
      operation: afterFailure,
      conflictedPaths: await listConflictedPaths(cwd),
    };
  }

  const nextGitDir = await resolveGitDir(cwd);
  const next = nextGitDir ? await detectOperation(nextGitDir) : null;
  const conflictedAfter = next ? await listConflictedPaths(cwd) : [];
  if (next) {
    return {
      ok: false,
      action,
      message:
        action === "continue"
          ? "操作仍在进行中，请检查剩余冲突或输出后重试"
          : "中止未完成，操作仍在进行中",
      operation: next,
      conflictedPaths: conflictedAfter,
    };
  }
  return {
    ok: true,
    action,
    message: action === "continue" ? "已继续并完成该操作" : "已中止该操作，工作区恢复到操作前状态",
    operation: null,
    conflictedPaths: [],
  };
}

function operationArgs(kind: GitInProgressOperation): string {
  switch (kind) {
    case "merge":
      return "merge";
    case "rebase":
      return "rebase";
    case "cherry-pick":
      return "cherry-pick";
    case "revert":
      return "revert";
    default:
      return "merge";
  }
}

async function showStage(cwd: string, stage: 1 | 2 | 3, path: string): Promise<string | null> {
  const result = await runGit(cwd, ["show", `:${stage}:${path}`], 30_000);
  if (result.code !== 0) return null;
  return result.stdout;
}

async function readWorktreeBuffer(cwd: string, path: string): Promise<Buffer | null> {
  const root = (await resolveRepoRoot(cwd)) ?? cwd;
  try {
    return await readFile(join(root, ...path.split("/")));
  } catch {
    return null;
  }
}

function firstLine(text: string): string | null {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return null;
}
