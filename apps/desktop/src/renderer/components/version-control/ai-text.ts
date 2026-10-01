import type {
  AiTextAction,
  AiTextKind,
  AiTextRequest,
  AiTextResult,
  AiTextSnapshot,
  AiTextStyle,
  ConversationGoal,
  GitStatusSnapshot,
  PrCompareScope,
} from "@vela/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { cleanErrorMessage } from "../../hooks/useProject";
import { tr } from "../../locale";

export interface AiTextState {
  running: boolean;
  requestId: string | null;
  action: AiTextAction | null;
  result: AiTextResult | null;
  error: string | null;
  /** 结果对应的依据已过期 */
  stale: boolean;
}

const emptyState: AiTextState = {
  running: false,
  requestId: null,
  action: null,
  result: null,
  error: null,
  stale: false,
};

function nextRequestId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `ai-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  }
}

/** 生成 Commit/PR 文案;结果只是候选,是否采用由调用方决定。 */
export function useAiText() {
  const [state, setState] = useState<AiTextState>(emptyState);
  const seqRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const generate = useCallback(
    async (input: {
      kind: AiTextKind;
      action: AiTextAction;
      snapshot: AiTextSnapshot;
      title: string;
      body: string;
      instruction?: string | null;
    }): Promise<AiTextResult | null> => {
      const api = window.vela;
      if (!api) return null;
      const requestId = nextRequestId();
      const seq = ++seqRef.current;
      setState({ running: true, requestId, action: input.action, result: null, error: null, stale: false });
      const request: AiTextRequest = {
        requestId,
        kind: input.kind,
        action: input.action,
        snapshot: input.snapshot,
        title: input.title,
        body: input.body,
        instruction: input.instruction ?? null,
      };
      try {
        const result = await api.generateTextAssist(request);
        if (seq !== seqRef.current || !mountedRef.current) return null;
        setState({
          running: false,
          requestId: null,
          action: input.action,
          result,
          error: null,
          stale: result.snapshotKey !== input.snapshot.key,
        });
        return result;
      } catch (caught) {
        if (seq !== seqRef.current || !mountedRef.current) return null;
        setState({
          running: false,
          requestId: null,
          action: input.action,
          result: null,
          error: cleanErrorMessage(caught),
          stale: false,
        });
        return null;
      }
    },
    [],
  );

  const cancel = useCallback(() => {
    const current = state.requestId;
    if (!current) return;
    seqRef.current += 1;
    setState((value) => ({ ...value, running: false, requestId: null, action: null }));
    void window.vela?.cancelTextAssist(current).catch(() => undefined);
  }, [state.requestId]);

  const clear = useCallback(() => {
    seqRef.current += 1;
    setState(emptyState);
  }, []);

  const markStale = useCallback((stale: boolean) => {
    setState((value) => (value.stale === stale ? value : { ...value, stale }));
  }, []);

  const dismissResult = useCallback(() => {
    setState((value) => ({ ...value, result: null }));
  }, []);

  return { state, generate, cancel, clear, markStale, dismissResult };
}

/** 快照键:任何影响文案依据的变化都必须改变它。 */
export function commitSnapshotKey(
  workspace: string | null,
  branch: string | null,
  head: string | null,
  stagedPaths: string[],
  plannedPaths: string[],
): string {
  return ["commit", workspace ?? "", branch ?? "", head ?? "", [...stagedPaths].sort().join(","), [...plannedPaths].sort().join(",")].join("|");
}

export function prSnapshotKey(
  workspace: string | null,
  branch: string | null,
  base: string | null,
  headSha: string | null,
): string {
  return ["pr", workspace ?? "", branch ?? "", base ?? "", headSha ?? ""].join("|");
}

export interface CommitSnapshotInput {
  workspace: string | null;
  repoRoot: string | null;
  branch: string | null;
  head: string | null;
  status: GitStatusSnapshot;
  stagedPaths: string[];
  plannedPaths: string[];
  diff: string;
  recentCommitTitles: string[];
  taskGoal: string | null;
  userNote: string | null;
  verificationNotes: string | null;
  locale: "zh-CN" | "en";
  style: AiTextStyle;
}

export function buildCommitSnapshot(input: CommitSnapshotInput): AiTextSnapshot {
  const stats = input.status.files.reduce(
    (sum, file) => ({
      added: sum.added + (input.plannedPaths.length > 0 ? file.addedLines : file.indexAddedLines),
      deleted: sum.deleted + (input.plannedPaths.length > 0 ? file.deletedLines : file.indexDeletedLines),
    }),
    { added: 0, deleted: 0 },
  );
  const paths = input.plannedPaths.length > 0 ? input.plannedPaths : input.stagedPaths;
  return {
    kind: "commit",
    key: commitSnapshotKey(input.workspace, input.branch, input.head, input.stagedPaths, input.plannedPaths),
    workspace: input.workspace,
    repoRoot: input.repoRoot,
    branch: input.branch,
    head: input.head,
    base: null,
    stagedPaths: input.stagedPaths,
    plannedPaths: input.plannedPaths,
    diff: input.diff,
    diffTruncated: false,
    fileCount: paths.length,
    addedLines: stats.added,
    deletedLines: stats.deleted,
    commits: [],
    recentCommitTitles: input.recentCommitTitles,
    template: null,
    taskGoal: input.taskGoal,
    userNote: input.userNote,
    verificationNotes: input.verificationNotes,
    locale: input.locale,
    style: input.style,
  };
}

export interface PrSnapshotInput {
  workspace: string | null;
  repoRoot: string | null;
  branch: string | null;
  head: string | null;
  base: string;
  scope: PrCompareScope;
  template: string | null;
  recentCommitTitles: string[];
  taskGoal: string | null;
  userNote: string | null;
  verificationNotes: string | null;
  locale: "zh-CN" | "en";
  style: AiTextStyle;
}

export function buildPrSnapshot(input: PrSnapshotInput): AiTextSnapshot {
  return {
    kind: "pr",
    key: prSnapshotKey(input.workspace, input.branch, input.base, input.head),
    workspace: input.workspace,
    repoRoot: input.repoRoot,
    branch: input.branch,
    head: input.head,
    base: input.base,
    stagedPaths: [],
    plannedPaths: [],
    diff: input.scope.diff,
    diffTruncated: input.scope.diffTruncated,
    fileCount: input.scope.fileCount,
    addedLines: input.scope.addedLines,
    deletedLines: input.scope.deletedLines,
    commits: input.scope.commits.map((commit) => ({ sha: commit.sha, subject: commit.subject })),
    recentCommitTitles: input.recentCommitTitles,
    template: input.template,
    taskGoal: input.taskGoal,
    userNote: input.userNote,
    verificationNotes: input.verificationNotes,
    locale: input.locale,
    style: input.style,
  };
}

/** 把 Goal 里记录过的验证命令与结果整理成事实说明;没有记录时返回 null。 */
export function verificationNotesFromGoal(goal: ConversationGoal | null): string | null {
  const validation = goal?.validation;
  if (!validation || validation.checks.length === 0) return null;
  const lines = validation.checks.map((check) => {
    const output = check.output.trim().split("\n").slice(-3).join(" ").slice(0, 200);
    return `- ${check.command} → ${check.result === "passed" ? "通过" : "失败"}${output ? `（${output}）` : ""}`;
  });
  return lines.join("\n");
}

export function aiStatusLabel(state: AiTextState): string | null {
  if (state.running) return tr("正在生成…", "Generating…");
  if (state.error) return state.error;
  return null;
}
