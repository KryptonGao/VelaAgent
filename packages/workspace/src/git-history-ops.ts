import type {
  GitBranchAtInput,
  GitBranchAtResult,
  GitCommitFileChange,
  GitHistoryCommitRef,
  GitHistoryOpInput,
  GitHistoryOpPreview,
  GitHistoryOpResult,
  GitRecoveryMode,
  GitRecoveryPreview,
  GitRecoveryPreviewInput,
  GitRecoveryResult,
  GitReflogEntry,
  GitReflogQuery,
  GitReflogSnapshot,
  GitRewriteCommitRef,
  GitRewritePreview,
  GitRewritePreviewInput,
  GitRewriteResult,
} from "@vela/shared";
import { assertSafeRevision, assertValidRefName, gitMutate, gitQuery, runGit } from "./git-run";
import {
  detectOperation,
  listConflictedPaths,
  parseNameStatusZ,
  parseNumstatZ,
  readCurrentBranch,
  readHeadSha,
  readShortSha,
  resolveCommit,
  resolveGitDir,
} from "./git-state";

const emptyTreeSha = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const fieldSeparator = "\x1f";
const recordSeparator = "\x1e";
const defaultReflogLimit = 50;
const maxReflogLimit = 200;
const maxRecoveryDiscarded = 100;
const commitRefFormat =
  ["%H", "%h", "%s", "%an", "%at", "%P"].join(fieldSeparator) + recordSeparator;

interface CommitRefWithParents extends GitHistoryCommitRef {
  parents: string[];
}

/** 历史操作与恢复:revert / cherry-pick / fixup / squash / reflog。 */

// ---------- HI-02:从指定提交创建分支 ----------

/**
 * HI-02:在指定历史提交上创建分支。默认只写引用、不切换,
 * 因此当前 HEAD 与未提交内容都不受影响。
 */
export async function createBranchAt(
  cwd: string,
  input: GitBranchAtInput,
): Promise<GitBranchAtResult> {
  const name = input.name.trim();
  await assertValidRefName(cwd, name);
  const startPoint = assertSafeRevision(input.startPoint.trim());
  const startSha = await resolveCommit(cwd, startPoint);
  if (!startSha) throw new Error("找不到指定的提交");
  const exists = await runGit(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`]);
  if (exists.code === 0) throw new Error(`分支 ${name} 已存在`);

  const before = await worktreeState(cwd);
  if (input.checkout === true) {
    // 切换分支由 git 自行判断是否覆盖未提交内容;拒绝时不会强制切换。
    await gitMutate(cwd, ["switch", "--create", name, startSha]);
  } else {
    await gitMutate(cwd, ["branch", name, startSha]);
  }
  const after = await worktreeState(cwd);
  const currentBranch = await readCurrentBranch(cwd);
  const currentHead = await readHeadSha(cwd);
  const checkedOut = currentBranch === name;
  return {
    ok: true,
    message: checkedOut
      ? `已从 ${startSha.slice(0, 7)} 创建并切换到分支 ${name}`
      : `已从 ${startSha.slice(0, 7)} 创建分支 ${name}，当前分支与未提交内容保持不变`,
    branch: name,
    startPoint,
    startShortSha: startSha.slice(0, 7),
    checkedOut,
    currentBranch,
    currentHead,
    worktreeUntouched: before.status === after.status && before.head === after.head,
    changeCount: before.changeCount,
  };
}

// ---------- HI-03 / HI-04:Revert 与 Cherry-pick ----------

/** HI-03/HI-04:执行前展示范围:改哪些文件、落在哪个分支、是否需要处理冲突。 */
export async function previewHistoryOp(
  cwd: string,
  input: GitHistoryOpInput,
): Promise<GitHistoryOpPreview> {
  const action = input.action;
  const commit = await readCommitRef(cwd, input.sha);
  const isMerge = commit.parents.length > 1;
  const mainline = normalizeMainline(input.mainline, commit.parents.length);
  const branch = await readCurrentBranch(cwd);
  const head = await readHeadSha(cwd);
  const dirtyCount = await trackedChangeCount(cwd);
  const base = {
    action,
    commit,
    branch,
    head,
    isMerge,
    parents: commit.parents,
  };

  if (isMerge && mainline === null) {
    return {
      ...base,
      files: [],
      fileCount: 0,
      addedLines: 0,
      deletedLines: 0,
      dirty: dirtyCount > 0,
      alreadyApplied: false,
      ok: false,
      reason: "该提交是合并提交，撤销时必须选择要对比的父提交",
      error: null,
    };
  }
  if (!isMerge && input.mainline !== null && input.mainline !== undefined) {
    return {
      ...base,
      files: [],
      fileCount: 0,
      addedLines: 0,
      deletedLines: 0,
      dirty: dirtyCount > 0,
      alreadyApplied: false,
      ok: false,
      reason: "该提交不是合并提交，不需要指定父提交",
      error: null,
    };
  }
  if (!branch) {
    return {
      ...base,
      files: [],
      fileCount: 0,
      addedLines: 0,
      deletedLines: 0,
      dirty: dirtyCount > 0,
      alreadyApplied: false,
      ok: false,
      reason: "当前处于 detached HEAD，请先创建或切换分支再执行历史操作",
      error: null,
    };
  }

  try {
    const parentSha = isMerge ? commit.parents[mainline! - 1] ?? null : commit.parents[0] ?? null;
    const files = await diffFiles(cwd, parentSha, commit.sha);
    const alreadyApplied =
      action === "cherry-pick"
        ? (await isAncestor(cwd, commit.sha, "HEAD"))
        : await hasRevertCommit(cwd, commit.sha);
    const addedLines = files.reduce((sum, file) => sum + file.addedLines, 0);
    const deletedLines = files.reduce((sum, file) => sum + file.deletedLines, 0);
    const empty = files.length === 0;
    return {
      ...base,
      files,
      fileCount: files.length,
      addedLines,
      deletedLines,
      dirty: dirtyCount > 0,
      alreadyApplied,
      ok: !empty,
      reason: empty
        ? action === "revert"
          ? "该提交相对所选父提交没有文件变化，没有可撤销的内容"
          : "该提交没有可拣选的内容"
        : alreadyApplied && action === "cherry-pick"
          ? "该提交已经在当前分支历史中"
          : null,
      error: null,
    };
  } catch (error) {
    return {
      ...base,
      files: [],
      fileCount: 0,
      addedLines: 0,
      deletedLines: 0,
      dirty: dirtyCount > 0,
      alreadyApplied: false,
      ok: false,
      reason: null,
      error: error instanceof Error ? error.message : "读取提交范围失败",
    };
  }
}

/** HI-03/HI-04:执行 Revert 或 Cherry-pick;冲突时保留可继续/中止的操作状态。 */
export async function runHistoryOp(
  cwd: string,
  input: GitHistoryOpInput,
): Promise<GitHistoryOpResult> {
  const action = input.action;
  const sha = await resolveCommit(cwd, assertSafeRevision(input.sha.trim()));
  if (!sha) throw new Error("找不到指定的提交");
  const inProgress = await currentOperation(cwd);
  if (inProgress) {
    return {
      ok: false,
      action,
      message: `已有进行中的 ${inProgress} 操作，请先完成或中止`,
      sha: null,
      shortSha: null,
      conflicted: false,
      conflictedPaths: await listConflictedPaths(cwd),
      operation: inProgress,
      output: "",
    };
  }
  const parents = await readParents(cwd, sha);
  const isMerge = parents.length > 1;
  const mainline = normalizeMainline(input.mainline, parents.length);
  if (isMerge && mainline === null) {
    return {
      ok: false,
      action,
      message: "撤销合并提交时必须选择要对比的父提交",
      sha: null,
      shortSha: null,
      conflicted: false,
      conflictedPaths: [],
      operation: null,
      output: "",
    };
  }
  if (!isMerge && input.mainline !== null && input.mainline !== undefined) {
    return {
      ok: false,
      action,
      message: "该提交不是合并提交，不需要指定父提交",
      sha: null,
      shortSha: null,
      conflicted: false,
      conflictedPaths: [],
      operation: null,
      output: "",
    };
  }

  const args = action === "revert" ? ["revert", "--no-edit"] : ["cherry-pick"];
  if (action === "revert" && isMerge) args.push("-m", String(mainline));
  args.push(sha);
  const result = await runGit(cwd, args, 180_000, {
    env: { GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true" },
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  const operation = await currentOperation(cwd);
  const conflictedPaths = operation ? await listConflictedPaths(cwd) : [];
  if (result.code === 0 && !operation) {
    const head = await readHeadSha(cwd);
    const shortSha = await readShortSha(cwd);
    return {
      ok: true,
      action,
      message:
        action === "revert"
          ? `已创建撤销提交 ${shortSha ?? ""}`
          : `已拣选 ${sha.slice(0, 7)} 到 ${await readCurrentBranch(cwd) ?? "当前分支"}`,
      sha: head,
      shortSha,
      conflicted: false,
      conflictedPaths: [],
      operation: null,
      output,
    };
  }
  if (operation) {
    return {
      ok: false,
      action,
      message:
        conflictedPaths.length > 0
          ? `遇到 ${conflictedPaths.length} 个冲突文件，请解决后继续或中止该操作`
          : "操作仍在进行中，请检查输出后继续或中止",
      sha: null,
      shortSha: null,
      conflicted: true,
      conflictedPaths,
      operation,
      output,
    };
  }
  return {
    ok: false,
    action,
    message: firstLine(result.stderr) ?? firstLine(result.stdout) ?? (action === "revert" ? "撤销失败" : "拣选失败"),
    sha: null,
    shortSha: null,
    conflicted: false,
    conflictedPaths: [],
    operation: null,
    output,
  };
}

// ---------- CT-06:Fixup / Squash ----------

/** CT-06:预览会把哪些提交合并、影响多少个提交、是否包含已推送提交。 */
export async function previewRewrite(
  cwd: string,
  input: GitRewritePreviewInput,
): Promise<GitRewritePreview> {
  const action = input.action;
  const source = await readCommitRef(cwd, input.sourceSha);
  const target = await readCommitRef(cwd, input.targetSha);
  const branch = await readCurrentBranch(cwd);
  const head = await readHeadSha(cwd);
  const dirtyCount = await trackedChangeCount(cwd);
  const empty = {
    action,
    source,
    target,
    branch,
    head,
    rewritten: [],
    rewrittenCount: 0,
    pushedCount: 0,
    dirty: dirtyCount > 0,
    ok: false,
    reason: null as string | null,
    expectedCount: 0,
    error: null as string | null,
  };

  if (source.sha === target.sha) {
    return { ...empty, reason: "目标提交与被整理的提交不能相同" };
  }
  if (!(await isAncestor(cwd, target.sha, "HEAD"))) {
    return { ...empty, reason: "目标提交不在当前分支历史上" };
  }
  if (!(await isAncestor(cwd, target.sha, source.sha))) {
    return { ...empty, reason: "被整理的提交必须在目标提交之后" };
  }
  if (dirtyCount > 0) {
    return { ...empty, reason: "工作区有未提交改动，请先提交或暂存后再整理历史" };
  }
  try {
    const window = await linearWindow(cwd, target.sha);
    if (!window) {
      return { ...empty, reason: "目标提交到 HEAD 之间不是线性历史，请改用交互式 Rebase（P3）" };
    }
    const rewritten = await readCommitRefs(cwd, window);
    const total = Number.parseInt(
      (await gitQuery(cwd, ["rev-list", "--count", "HEAD"])).trim(),
      10,
    );
    const unpushed = await unpushedCount(cwd);
    const pushedCount = unpushed === null ? 0 : Math.max(0, rewritten.length - unpushed);
    return {
      action,
      source,
      target,
      branch,
      head,
      rewritten,
      rewrittenCount: rewritten.length,
      pushedCount,
      dirty: false,
      ok: true,
      reason: null,
      expectedCount: Number.isFinite(total) ? Math.max(1, total - 1) : rewritten.length - 1,
      error: null,
    };
  } catch (error) {
    return { ...empty, error: error instanceof Error ? error.message : "读取整理范围失败" };
  }
}

/**
 * CT-06:把 source 提交并入 target。不自动推送重写后的历史,
 * 已推送提交只提示需要另行处理。
 */
export async function runRewrite(
  cwd: string,
  input: GitRewritePreviewInput,
): Promise<GitRewriteResult> {
  const preview = await previewRewrite(cwd, input);
  const fail = (message: string, output = ""): GitRewriteResult => ({
    ok: false,
    action: input.action,
    message,
    head: preview.head,
    shortHead: preview.head?.slice(0, 7) ?? null,
    rewrittenCount: 0,
    pushedCount: preview.pushedCount,
    output,
  });
  if (!preview.ok) return fail(preview.reason ?? preview.error ?? "无法整理该提交");

  const savedHead = preview.head;
  const before = await worktreeState(cwd);
  // 与预览一致:只把已跟踪文件的未提交改动视为阻塞;未跟踪文件由 git 自行判断。
  if (!savedHead || before.changeCount > 0) {
    return fail("工作区有未提交改动，请先处理后再整理历史");
  }
  const source = preview.source.sha;
  const target = preview.target.sha;
  const output: string[] = [];
  const run = async (args: string[], stdin?: string): Promise<number> => {
    const result = await runGit(cwd, args, 180_000, {
      input: stdin,
      env: { GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true" },
    });
    output.push(`$ git ${args.join(" ")}\n${[result.stderr, result.stdout].filter(Boolean).join("\n").trim()}`);
    return result.code;
  };
  const restore = async (): Promise<void> => {
    await runGit(cwd, ["reset", "--hard", savedHead], 60_000).catch(() => undefined);
    await runGit(cwd, ["cherry-pick", "--abort"], 30_000).catch(() => undefined);
  };

  if ((await run(["reset", "--hard", target])) !== 0) {
    await restore();
    return fail("无法移动到目标提交，历史未改变", output.join("\n"));
  }
  if ((await run(["cherry-pick", "-n", source])) !== 0) {
    await restore();
    return fail("被整理的提交无法应用到目标提交（内容冲突），历史未改变", output.join("\n"));
  }
  const message = input.message?.trim() ?? "";
  const amendArgs = ["commit", "--amend"];
  if (input.action === "squash" && message) {
    amendArgs.push("--file", "-");
  } else {
    amendArgs.push("--no-edit");
  }
  const amendCode = await run(amendArgs, message ? `${message}\n` : undefined);
  if (amendCode !== 0) {
    await restore();
    return fail("合并提交失败，历史未改变", output.join("\n"));
  }
  const remaining = await gitQuery(cwd, ["rev-list", "--count", `${source}..${savedHead}`])
    .then((stdout) => Number.parseInt(stdout.trim(), 10))
    .catch(() => 0);
  if (Number.isFinite(remaining) && remaining > 0) {
    const replay = await run(["cherry-pick", `${source}..${savedHead}`]);
    if (replay !== 0) {
      await restore();
      return fail("重放后续提交时遇到冲突，历史已恢复到操作前状态", output.join("\n"));
    }
  }
  const head = await readHeadSha(cwd);
  const shortHead = await readShortSha(cwd);
  const pushedNote =
    preview.pushedCount > 0
      ? "；重写包含已推送提交，需要另行用安全强推同步（不会自动执行）"
      : "";
  return {
    ok: true,
    action: input.action,
    message:
      input.action === "fixup"
        ? `已把 ${source.slice(0, 7)} 并入 ${target.slice(0, 7)}${pushedNote}`
        : `已把 ${source.slice(0, 7)} 压缩进 ${target.slice(0, 7)}${pushedNote}`,
    head,
    shortHead,
    rewrittenCount: preview.rewrittenCount,
    pushedCount: preview.pushedCount,
    output: output.join("\n"),
  };
}

// ---------- HI-06:Reflog 查询与恢复 ----------

/** HI-06:读取 HEAD reflog,标注可达性、当前引用与重写后的历史。 */
export async function listReflog(
  cwd: string,
  query?: GitReflogQuery | null,
): Promise<GitReflogSnapshot> {
  const head = await readHeadSha(cwd);
  const branch = await readCurrentBranch(cwd);
  const limit = normalizeReflogLimit(query?.limit);
  let stdout: string;
  try {
    stdout = await gitQuery(cwd, [
      "log",
      "-g",
      "--date=unix",
      `--format=%H${fieldSeparator}%gD${fieldSeparator}%gs`,
      "-n",
      String(limit),
      "HEAD",
    ]);
  } catch (error) {
    return {
      entries: [],
      total: 0,
      truncated: false,
      head,
      branch,
      error: error instanceof Error ? error.message : "读取 Reflog 失败",
    };
  }
  const raw = stdout.split("\n").filter((line) => line.trim());
  const refsBySha = await refsByCommit(cwd);
  const entries: GitReflogEntry[] = await Promise.all(
    raw.map(async (line, index) => {
      const [sha = "", selector = "", subject = ""] = line.split(fieldSeparator);
      return {
        id: `HEAD@{${index}}`,
        index,
        sha,
        shortSha: sha.slice(0, 7),
        action: selectorAction(subject),
        message: subject,
        at: parseReflogTime(selector),
        reachable: head !== null && sha === head ? true : await isAncestor(cwd, sha, "HEAD"),
        current: sha === head,
        refs: refsBySha.get(sha) ?? [],
      };
    }),
  );
  const total = await gitQuery(cwd, ["reflog", "show", "HEAD", "--format=%H"])
    .then((text) => text.split("\n").filter((line) => line.trim()).length)
    .catch(() => entries.length);
  const text = query?.text?.trim().toLowerCase() ?? "";
  const filtered = text
    ? entries.filter((entry) =>
        [entry.id, entry.sha, entry.shortSha, entry.action, entry.message, ...entry.refs]
          .join("\n")
          .toLowerCase()
          .includes(text),
      )
    : entries;
  return {
    entries: filtered,
    total,
    truncated: total > entries.length,
    head,
    branch,
    error: null,
  };
}

/** HI-06:恢复前明确目标与文件/索引影响,优先提供保留现有内容的路径。 */
export async function previewRecovery(
  cwd: string,
  input: GitRecoveryPreviewInput,
): Promise<GitRecoveryPreview> {
  const mode: GitRecoveryMode = input.mode;
  const target = await readReflogEntry(cwd, input.target);
  const head = await readHeadSha(cwd);
  const branch = await readCurrentBranch(cwd);
  const changeCount = await trackedChangeCount(cwd);
  const branchName = input.branchName?.trim() || null;
  const base = {
    target,
    mode,
    branchName,
    head,
    branch,
    refName: branch ?? "HEAD",
    discarded: [] as GitRewriteCommitRef[],
    changeCount,
    keepNote: "",
    requiresConfirm: false,
    ok: true,
    reason: null as string | null,
    error: null as string | null,
  };

  if (!target.sha) {
    return { ...base, ok: false, error: "找不到该 Reflog 目标" };
  }
  if (mode === "branch") {
    if (!branchName) {
      return { ...base, ok: false, reason: "请填写新分支名" };
    }
    try {
      await assertValidRefName(cwd, branchName);
    } catch (error) {
      return { ...base, ok: false, reason: error instanceof Error ? error.message : "分支名不正确" };
    }
    const exists = await runGit(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`]);
    if (exists.code === 0) {
      return { ...base, ok: false, reason: `分支 ${branchName} 已经存在` };
    }
    return {
      ...base,
      refName: `refs/heads/${branchName}`,
      keepNote: `从 ${target.shortSha} 新建分支 ${branchName}；当前分支、HEAD、工作区与未提交内容都不会改变`,
      requiresConfirm: false,
    };
  }

  const soft = mode === "reset-soft";
  const discarded = await readCommitRefs(
    cwd,
    await gitQuery(cwd, ["rev-list", `--max-count=${maxRecoveryDiscarded}`, `${target.sha}..HEAD`])
      .then((text) => text.split("\n").filter((line) => line.trim()))
      .catch(() => []),
  );
  return {
    ...base,
    discarded,
    keepNote: soft
      ? "当前分支会移动到该提交；被丢弃提交的文件变化保留在索引中（未提交）"
      : "当前分支会移动到该提交；被丢弃提交的文件变化保留在工作区（未暂存）",
    requiresConfirm: true,
    reason: null,
  };
}

/** HI-06:执行恢复;branch 模式不移动任何现有引用。 */
export async function runRecovery(
  cwd: string,
  input: GitRecoveryPreviewInput,
): Promise<GitRecoveryResult> {
  const preview = await previewRecovery(cwd, input);
  const before = await worktreeState(cwd);
  const fail = (message: string): GitRecoveryResult => ({
    ok: false,
    mode: input.mode,
    message,
    head: preview.head,
    shortHead: preview.head?.slice(0, 7) ?? null,
    branch: preview.branch,
    createdBranch: null,
    changeCount: before.changeCount,
    conflictedPaths: [],
    output: "",
  });
  if (!preview.ok) return fail(preview.reason ?? preview.error ?? "无法执行恢复");

  if (input.mode === "branch") {
    const name = preview.branchName!;
    const result = await runGit(cwd, ["branch", name, preview.target.sha], 60_000);
    if (result.code !== 0) return fail(firstLine(result.stderr) ?? "创建分支失败");
    const head = await readHeadSha(cwd);
    return {
      ok: true,
      mode: "branch",
      message: `已从 ${preview.target.shortSha} 新建分支 ${name}，当前分支与工作区未改变`,
      head,
      shortHead: head?.slice(0, 7) ?? null,
      branch: await readCurrentBranch(cwd),
      createdBranch: name,
      changeCount: before.changeCount,
      conflictedPaths: [],
      output: result.stdout,
    };
  }

  const args = ["reset", input.mode === "reset-soft" ? "--soft" : "--mixed", preview.target.sha];
  const result = await runGit(cwd, args, 120_000);
  if (result.code !== 0) return fail(firstLine(result.stderr) ?? "恢复失败");
  const head = await readHeadSha(cwd);
  const after = await worktreeState(cwd);
  return {
    ok: true,
    mode: input.mode,
    message:
      input.mode === "reset-soft"
        ? `已移动到 ${preview.target.shortSha}，被丢弃提交的改动保留在索引中`
        : `已移动到 ${preview.target.shortSha}，被丢弃提交的改动保留在工作区`,
    head,
    shortHead: head?.slice(0, 7) ?? null,
    branch: await readCurrentBranch(cwd),
    createdBranch: null,
    changeCount: after.changeCount,
    conflictedPaths: [],
    output: result.stdout,
  };
}

// ---------- 内部工具 ----------

async function readCommitRef(cwd: string, shaInput: string): Promise<CommitRefWithParents> {
  const sha = await resolveCommit(cwd, assertSafeRevision(shaInput.trim()));
  if (!sha) throw new Error("找不到指定的提交");
  const raw = await gitQuery(cwd, ["log", "-1", `--format=${commitRefFormat}`, sha]);
  const fields = raw.split(recordSeparator)[0]?.split(fieldSeparator) ?? [];
  return {
    sha: fields[0] ?? sha,
    shortSha: fields[1] ?? sha.slice(0, 7),
    subject: fields[2] ?? "",
    authorName: fields[3] ?? "",
    authorAt: Number.parseInt(fields[4] ?? "0", 10) * 1000 || 0,
    parents: (fields[5] ?? "").split(" ").filter(Boolean),
  };
}

async function readCommitRefs(cwd: string, shas: string[]): Promise<GitRewriteCommitRef[]> {
  if (shas.length === 0) return [];
  const result: GitRewriteCommitRef[] = [];
  for (const sha of shas) {
    const ref = await readCommitRef(cwd, sha).catch(() => null);
    if (ref) {
      result.push({
        sha: ref.sha,
        shortSha: ref.shortSha,
        subject: ref.subject,
        authorName: ref.authorName,
        authorAt: ref.authorAt,
      });
    }
  }
  return result;
}

async function readParents(cwd: string, sha: string): Promise<string[]> {
  return gitQuery(cwd, ["rev-list", "--parents", "-n", "1", sha])
    .then((stdout) => stdout.trim().split(/\s+/).slice(1).filter(Boolean))
    .catch(() => []);
}

async function readReflogEntry(cwd: string, targetInput: string): Promise<GitReflogEntry> {
  const target = assertSafeRevision(targetInput.trim());
  const sha = await resolveCommit(cwd, target);
  if (!sha) {
    return {
      id: target,
      index: -1,
      sha: "",
      shortSha: "",
      action: "",
      message: "",
      at: null,
      reachable: false,
      current: false,
      refs: [],
    };
  }
  const index = /^HEAD@\{(\d+)\}$/.exec(target);
  const commit = await readCommitRef(cwd, sha).catch(() => null);
  const head = await readHeadSha(cwd);
  return {
    id: target,
    index: index ? Number.parseInt(index[1]!, 10) : -1,
    sha,
    shortSha: sha.slice(0, 7),
    action: "",
    message: commit?.subject ?? "",
    at: commit?.authorAt ?? null,
    reachable: head !== null && (sha === head ? true : await isAncestor(cwd, sha, "HEAD")),
    current: sha === head,
    refs: (await refsByCommit(cwd)).get(sha) ?? [],
  };
}

/** 目标提交到 HEAD 的线性提交窗口;存在分叉时返回 null。 */
async function linearWindow(cwd: string, targetSha: string): Promise<string[] | null> {
  const countText = await gitQuery(cwd, ["rev-list", "--count", `${targetSha}..HEAD`]);
  const count = Number.parseInt(countText.trim(), 10);
  if (!Number.isFinite(count)) return null;
  const stdout = await gitQuery(cwd, [
    "rev-list",
    "--parents",
    "-n",
    String(count + 1),
    "HEAD",
  ]);
  const lines = stdout.split("\n").filter((line) => line.trim());
  if (lines.length !== count + 1) return null;
  const window: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const parts = lines[index]!.trim().split(/\s+/);
    const sha = parts[0]!;
    window.push(sha);
    // 除目标提交本身外,窗口内出现合并提交说明历史不是线性的。
    if (index > 0 && parts.length !== 2) return null;
  }
  return window[window.length - 1] === targetSha ? window : null;
}

async function diffFiles(
  cwd: string,
  parentSha: string | null,
  sha: string,
): Promise<GitCommitFileChange[]> {
  const base = parentSha ?? emptyTreeSha;
  const [nameStatus, numstat] = await Promise.all([
    gitQuery(cwd, ["diff", "--name-status", "-M", "-z", base, sha]),
    gitQuery(cwd, ["diff", "--numstat", "-M", "-z", base, sha]).catch(() => ""),
  ]);
  const stats = parseNumstatZ(numstat);
  return parseNameStatusZ(nameStatus).map((entry) => {
    const stat = stats.get(entry.path) ?? { added: 0, deleted: 0 };
    return {
      path: entry.path,
      oldPath: entry.oldPath,
      status: entry.status,
      addedLines: stat.added,
      deletedLines: stat.deleted,
    };
  });
}

async function hasRevertCommit(cwd: string, sha: string): Promise<boolean> {
  const result = await runGit(cwd, [
    "--no-optional-locks",
    "log",
    "--fixed-strings",
    "--grep",
    `This reverts commit ${sha}.`,
    "--format=%H",
    "-n",
    "1",
    "HEAD",
  ]);
  return result.code === 0 && result.stdout.trim().length > 0;
}

async function isAncestor(cwd: string, sha: string, ref: string): Promise<boolean> {
  const result = await runGit(cwd, ["merge-base", "--is-ancestor", sha, ref]);
  return result.code === 0;
}

async function refsByCommit(cwd: string): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  const stdout = await gitQuery(cwd, [
    "for-each-ref",
    `--format=%(objectname)${"\t"}%(refname:short)`,
    "refs/heads",
    "refs/remotes",
    "refs/tags",
  ]).catch(() => "");
  for (const line of stdout.split("\n")) {
    const [sha, name] = line.split("\t");
    if (!sha || !name) continue;
    const list = map.get(sha) ?? [];
    list.push(name);
    map.set(sha, list);
  }
  return map;
}

async function currentOperation(cwd: string) {
  const gitDirPath = await resolveGitDir(cwd);
  if (!gitDirPath) return null;
  const operation = await detectOperation(gitDirPath);
  if (!operation) return null;
  return { ...operation, conflictedPaths: await listConflictedPaths(cwd) };
}

async function worktreeState(
  cwd: string,
): Promise<{ status: string; head: string | null; changeCount: number }> {
  const status = await gitQuery(cwd, ["status", "--porcelain"]).catch(() => "");
  return {
    status,
    head: await readHeadSha(cwd),
    changeCount: trackedChangeCountFromStatus(status),
  };
}

async function trackedChangeCount(cwd: string): Promise<number> {
  const status = await gitQuery(cwd, ["status", "--porcelain"]).catch(() => "");
  return trackedChangeCountFromStatus(status);
}

function trackedChangeCountFromStatus(status: string): number {
  return status
    .split("\n")
    .filter((line) => line.trim().length > 0 && !line.startsWith("??")).length;
}

async function unpushedCount(cwd: string): Promise<number | null> {
  const upstream = await gitQuery(cwd, [
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{upstream}",
  ]).catch(() => null);
  if (!upstream?.trim()) return null;
  const count = await gitQuery(cwd, ["rev-list", "--count", `${upstream.trim()}..HEAD`]).catch(
    () => null,
  );
  if (count === null) return null;
  const parsed = Number.parseInt(count.trim(), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeMainline(value: number | null | undefined, parentCount: number): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value) || value < 1 || value > parentCount) return null;
  return value;
}

function normalizeReflogLimit(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return defaultReflogLimit;
  return Math.max(1, Math.min(maxReflogLimit, Math.floor(value)));
}

function parseReflogTime(selector: string): number | null {
  const match = /@\{(\d+)/.exec(selector);
  if (!match) return null;
  const seconds = Number.parseInt(match[1]!, 10);
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}

function selectorAction(subject: string): string {
  const colon = subject.indexOf(":");
  return colon > 0 ? subject.slice(0, colon).trim() : "";
}

function firstLine(text: string): string | null {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return null;
}
