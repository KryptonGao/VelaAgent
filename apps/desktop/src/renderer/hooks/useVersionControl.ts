import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  GitBranchAtInput,
  GitBranchAtResult,
  GitBranchDeleteInput,
  GitBranchDeleteResult,
  GitBranchDetail,
  GitForcePushInput,
  GitForcePushPreview,
  GitForcePushResult,
  GitHistoryOpInput,
  GitHistoryOpPreview,
  GitHistoryOpResult,
  GitPullInput,
  GitPullStrategy,
  GitRecoveryPreview,
  GitRecoveryPreviewInput,
  GitRecoveryResult,
  GitReflogQuery,
  GitReflogSnapshot,
  GitReleaseCreateInput,
  GitReleaseCreateResult,
  GitReleaseListResult,
  GitReleaseNotesScope,
  GitRewriteInput,
  GitRewritePreview,
  GitRewritePreviewInput,
  GitRewriteResult,
  GitTagCreateInput,
  GitTagCreateResult,
  GitTagInfo,
  GitCommitDetail,
  GitCommitInput,
  GitCommitResult,
  GitCommitSearchResult,
  GitCompareResult,
  GitConflictFile,
  GitConflictResolveResult,
  GitDiffOptions,
  GitFetchResult,
  GitGraphQuery,
  GitGraphScope,
  GitGraphSlice,
  GitGuardState,
  GitHunkAction,
  GitOperationControlAction,
  GitOperationControlResult,
  GitOperationQuery,
  GitOperationRecord,
  GitOperationSnapshot,
  GitPullResult,
  GitPushInput,
  GitRemoteChange,
  GitRemoteInput,
  GitStashApplyResult,
  GitStashCreateInput,
  GitStashCreateResult,
  GitStashEntry,
  GitSyncResult,
  GitUndoCommitMode,
  GitUndoCommitResult,
  GitUpstreamInput,
  GitWorktreeCreateInput,
  GitWorktreeCreateResult,
  GitWorktreeInfo,
  GitWorktreeRemoveInput,
  GitWorktreeRemoveResult,
  PrCompareScope,
  PrCreateInput,
  PrCreateResult,
  PrCloseInput,
  PrCloseResult,
  PrCommentInput,
  PrEditOptions,
  PrIssueLinkInput,
  PrMergeInput,
  PrMergePreview,
  PrMergeResult,
  PrReviewInput,
  PrReviewMutationResult,
  PrReviewThreadsResult,
  PrTemplateInfo,
  PrThreadResolveInput,
  PrThreadResolveResult,
  PrUpdateInput,
  PrUpdateResult,
  PullRequestInfo,
} from "@vela/shared";
import { tr, trf } from "../locale";
import { cleanErrorMessage, type ProjectApi } from "./useProject";
import type { DiffViewMode } from "../components/DiffPane";

const graphPageSize = 100;

export interface VersionControlApi {
  guard: GitGuardState | null;
  operations: GitOperationSnapshot | null;
  error: string | null;
  notice: string | null;
  busy: string | null;
  clearError(): void;
  clearNotice(): void;

  graph: GitGraphSlice | null;
  graphScope: GitGraphScope;
  graphLoading: boolean;
  graphError: string | null;
  setGraphScope(scope: GitGraphScope): void;
  refreshGraph(): void;
  loadMoreGraph(): void;
  selectCommit(sha: string | null): void;
  selectedSha: string | null;
  detail: GitCommitDetail | null;
  detailLoading: boolean;
  detailError: string | null;
  detailParent: string | null;
  setDetailParent(parent: string | null): void;

  searchQuery: string;
  searchResult: GitCommitSearchResult | null;
  searchLoading: boolean;
  runSearch(query: string): void;
  clearSearch(): void;

  pr: PullRequestInfo | null;
  prLoading: boolean;
  templates: PrTemplateInfo[];
  templatesLoaded: boolean;
  loadTemplates(): void;
  refreshPr(): void;
  loadScope(base: string, head?: string | null): Promise<PrCompareScope | null>;
  createPr(input: PrCreateInput): Promise<PrCreateResult | null>;

  stagedDiff(): Promise<string>;
  commit(input: GitCommitInput): Promise<GitCommitResult | null>;
  commitAndPush(input: GitCommitInput, target: GitPushInput): Promise<{ commit: GitCommitResult; push: GitSyncResult | null } | null>;
  fetch(remote?: string | null): Promise<GitFetchResult | null>;
  pull(): Promise<GitPullResult | null>;
  push(target: GitPushInput): Promise<GitSyncResult | null>;
  refreshOperations(): void;
  refreshOperation(id: string): Promise<GitOperationRecord | null>;
  ensureMutable(): Promise<boolean>;

  // ---- P1 ----
  diffMode: DiffViewMode;
  setDiffMode(mode: DiffViewMode): void;
  ignoreWhitespace: boolean;
  setIgnoreWhitespace(value: boolean): void;
  diffOptions: GitDiffOptions;
  /** 按代码块暂存/取消暂存/丢弃;补丁过期时由服务端拒绝并给出提示。 */
  applyHunks(path: string, action: GitHunkAction, patch: string): Promise<boolean>;
  undoCommit(mode: GitUndoCommitMode): Promise<GitUndoCommitResult | null>;
  branchDetail(name: string): Promise<GitBranchDetail | null>;
  renameBranch(name: string, nextName: string): Promise<boolean>;
  deleteBranch(input: GitBranchDeleteInput): Promise<GitBranchDeleteResult | null>;
  setUpstream(input: GitUpstreamInput): Promise<boolean>;
  compareRefs(base: string, head: string): Promise<GitCompareResult | null>;
  addRemote(input: GitRemoteInput): Promise<GitRemoteChange | null>;
  setRemoteUrl(name: string, url: string, pushUrl?: string | null): Promise<GitRemoteChange | null>;
  removeRemote(name: string): Promise<GitRemoteChange | null>;
  renameRemote(name: string, nextName: string): Promise<GitRemoteChange | null>;
  conflictFile(path: string): Promise<GitConflictFile | null>;
  resolveConflict(path: string, content: string): Promise<GitConflictResolveResult | null>;
  controlOperation(action: GitOperationControlAction): Promise<GitOperationControlResult | null>;
  stashes: GitStashEntry[];
  stashesLoading: boolean;
  refreshStashes(): void;
  createStash(input: GitStashCreateInput): Promise<GitStashCreateResult | null>;
  applyStash(id: string, mode: "apply" | "pop"): Promise<GitStashApplyResult | null>;
  dropStash(id: string): Promise<boolean>;
  stashDiff(id: string): Promise<string>;
  worktrees: GitWorktreeInfo[];
  worktreesLoading: boolean;
  refreshWorktrees(): void;
  createWorktree(input: GitWorktreeCreateInput): Promise<GitWorktreeCreateResult | null>;
  removeWorktree(input: GitWorktreeRemoveInput): Promise<GitWorktreeRemoveResult | null>;
  pruneWorktrees(): Promise<boolean>;
  searchOperations(query: GitOperationQuery | null): void;
  updatePr(input: PrUpdateInput): Promise<PrUpdateResult | null>;
  markPrReady(number: number): Promise<PrUpdateResult | null>;
  linkPrIssues(input: PrIssueLinkInput): Promise<PrUpdateResult | null>;
  loadPrEditOptions(): Promise<PrEditOptions | null>;

  // ---- P2:历史操作、提交整理与恢复 (HI-02–HI-04/HI-06/CT-06) ----
  createBranchAt(input: GitBranchAtInput): Promise<GitBranchAtResult | null>;
  previewHistoryOp(input: GitHistoryOpInput): Promise<GitHistoryOpPreview | null>;
  runHistoryOp(input: GitHistoryOpInput): Promise<GitHistoryOpResult | null>;
  previewRewrite(input: GitRewritePreviewInput): Promise<GitRewritePreview | null>;
  runRewrite(input: GitRewriteInput): Promise<GitRewriteResult | null>;
  reflog: GitReflogSnapshot | null;
  reflogLoading: boolean;
  refreshReflog(query?: GitReflogQuery | null): void;
  previewRecovery(input: GitRecoveryPreviewInput): Promise<GitRecoveryPreview | null>;
  runRecovery(input: GitRecoveryPreviewInput): Promise<GitRecoveryResult | null>;

  // ---- P2:高级同步与安全强推 (SY-03/SY-04) ----
  pullWithStrategy(strategy: GitPullStrategy): Promise<GitPullResult | null>;
  previewForcePush(remote: string, branch: string): Promise<GitForcePushPreview | null>;
  forcePush(input: GitForcePushInput): Promise<GitForcePushResult | null>;

  // ---- P2:Tag 与 Release (RL-01/AI-12) ----
  tags: GitTagInfo[];
  tagsLoading: boolean;
  tagsError: string | null;
  refreshTags(): void;
  createTag(input: GitTagCreateInput): Promise<GitTagCreateResult | null>;
  deleteTag(name: string, remote?: string | null): Promise<GitTagCreateResult | null>;
  releases: GitReleaseListResult | null;
  releasesLoading: boolean;
  refreshReleases(): void;
  createRelease(input: GitReleaseCreateInput): Promise<GitReleaseCreateResult | null>;
  loadReleaseScope(baseTag: string | null, targetTag: string): Promise<GitReleaseNotesScope | null>;

  // ---- P2:审阅协作、合并与关闭 (PR-06/PR-07) ----
  reviewThreads: PrReviewThreadsResult | null;
  reviewThreadsLoading: boolean;
  refreshReviewThreads(number?: number | null): void;
  commentPr(input: PrCommentInput): Promise<PrReviewMutationResult | null>;
  reviewPr(input: PrReviewInput): Promise<PrReviewMutationResult | null>;
  resolvePrThread(input: PrThreadResolveInput): Promise<PrThreadResolveResult | null>;
  mergePreview: PrMergePreview | null;
  mergePreviewLoading: boolean;
  refreshMergePreview(number?: number | null): void;
  mergePr(input: PrMergeInput): Promise<PrMergeResult | null>;
  closePr(input: PrCloseInput): Promise<PrCloseResult | null>;
}

/**
 * 版本控制页的数据与操作。Git 状态与分支来自 useProject(与右侧变更面板共享),
 * 提交历史、PR、操作记录由本 hook 维护。每个异步动作固定当前工作区目标,
 * 完成后刷新真实状态而不是依赖本地推断。
 */
export function useVersionControl(project: ProjectApi, agentStreaming: boolean): VersionControlApi {
  const repoRoot = project.git?.repo?.root ?? null;
  const branch = project.git?.branch ?? null;
  const upstream = project.git?.upstream ?? null;
  const headKey = `${branch ?? ""}|${upstream ?? ""}|${project.git?.ahead ?? 0}|${project.git?.behind ?? 0}`;

  const [guard, setGuard] = useState<GitGuardState | null>(null);
  const [operations, setOperations] = useState<GitOperationSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const busyRef = useRef<string | null>(null);

  const [graph, setGraph] = useState<GitGraphSlice | null>(null);
  const [graphScope, setGraphScope] = useState<GitGraphScope>("current");
  const [graphLoading, setGraphLoading] = useState(false);
  const [graphError, setGraphError] = useState<string | null>(null);
  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  const [detail, setDetail] = useState<GitCommitDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailParent, setDetailParent] = useState<string | null>(null);

  const [searchQuery, setSearchQuery] = useState("");
  const [searchResult, setSearchResult] = useState<GitCommitSearchResult | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);

  const [pr, setPr] = useState<PullRequestInfo | null>(null);
  const [prLoading, setPrLoading] = useState(false);
  const [templates, setTemplates] = useState<PrTemplateInfo[]>([]);
  const [templatesLoaded, setTemplatesLoaded] = useState(false);

  const [diffMode, setDiffMode] = useState<DiffViewMode>("unified");
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(false);
  const [stashes, setStashes] = useState<GitStashEntry[]>([]);
  const [stashesLoading, setStashesLoading] = useState(false);
  const [worktrees, setWorktrees] = useState<GitWorktreeInfo[]>([]);
  const [worktreesLoading, setWorktreesLoading] = useState(false);

  // ---- P2 ----
  const [reflog, setReflog] = useState<GitReflogSnapshot | null>(null);
  const [reflogLoading, setReflogLoading] = useState(false);
  const [tags, setTags] = useState<GitTagInfo[]>([]);
  const [tagsLoading, setTagsLoading] = useState(false);
  const [tagsError, setTagsError] = useState<string | null>(null);
  const [releases, setReleases] = useState<GitReleaseListResult | null>(null);
  const [releasesLoading, setReleasesLoading] = useState(false);
  const [reviewThreads, setReviewThreads] = useState<PrReviewThreadsResult | null>(null);
  const [reviewThreadsLoading, setReviewThreadsLoading] = useState(false);
  const [mergePreview, setMergePreview] = useState<PrMergePreview | null>(null);
  const [mergePreviewLoading, setMergePreviewLoading] = useState(false);
  const reflogSeq = useRef(0);
  const reviewsSeq = useRef(0);
  const mergeSeq = useRef(0);

  const graphSeq = useRef(0);
  const detailSeq = useRef(0);
  /** 提交详情读取时的 Diff 选项;忽略空白切换后需要重新取数。 */
  const diffOptionsRef = useRef<GitDiffOptions>({});
  const prSeq = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const run = useCallback(async <T,>(id: string, task: () => Promise<T>): Promise<T | null> => {
    if (busyRef.current) return null;
    busyRef.current = id;
    setBusy(id);
    setError(null);
    try {
      return await task();
    } catch (caught) {
      if (mountedRef.current) setError(cleanErrorMessage(caught));
      return null;
    } finally {
      busyRef.current = null;
      if (mountedRef.current) setBusy(null);
    }
  }, []);

  const refreshGuard = useCallback(async () => {
    const api = window.vela;
    if (!api) return null;
    const next = await api.getGitGuard().catch(() => null);
    if (mountedRef.current) setGuard(next);
    return next;
  }, []);

  const refreshOperations = useCallback(() => {
    const api = window.vela;
    if (!api) return;
    void api
      .getOperationRecords()
      .then((snapshot) => {
        if (mountedRef.current) setOperations(snapshot);
      })
      .catch(() => undefined);
  }, []);

  // 工作区/仓库/分支变化时重置历史与 PR;同一次会话里切换分支也必须重新取数。
  useEffect(() => {
    setGraph(null);
    setGraphError(null);
    setSelectedSha(null);
    setDetail(null);
    setDetailError(null);
    setSearchQuery("");
    setSearchResult(null);
    setStashes([]);
    setWorktrees([]);
    setReflog(null);
    setTags([]);
    setTagsError(null);
    setReleases(null);
    setReviewThreads(null);
    setMergePreview(null);
    if (!repoRoot) {
      setPr(null);
      setOperations(null);
      setGuard(null);
      return;
    }
    void refreshGuard();
    refreshOperations();
    void (async () => {
      const seq = ++prSeq.current;
      setPrLoading(true);
      const api = window.vela;
      if (!api) return;
      const next = await api.getPullRequestDetail().catch(() => null);
      if (seq !== prSeq.current || !mountedRef.current) return;
      setPr(next);
      setPrLoading(false);
    })();
    // headKey 覆盖分支内 HEAD 前进导致的上游计数变化。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoRoot, headKey, refreshGuard, refreshOperations]);

  const loadGraph = useCallback(
    async (options: { scope: GitGraphScope; skip: number; snapshotId: string | null; append: boolean }) => {
      const api = window.vela;
      if (!api || !repoRoot) return;
      const seq = ++graphSeq.current;
      setGraphLoading(true);
      setGraphError(null);
      try {
        const query: GitGraphQuery = {
          scope: options.scope,
          skip: options.skip,
          limit: graphPageSize,
          snapshotId: options.snapshotId,
        };
        const slice = await api.getCommitGraph(query);
        if (seq !== graphSeq.current || !mountedRef.current) return;
        setGraph((current) => {
          if (!options.append || !current || current.snapshotId !== slice.snapshotId) return slice;
          return {
            ...slice,
            commits: [...current.commits, ...slice.commits],
          };
        });
        if (!options.append) {
          setSelectedSha((current) => (slice.commits.some((commit) => commit.sha === current) ? current : null));
        }
      } catch (caught) {
        if (seq === graphSeq.current && mountedRef.current) setGraphError(cleanErrorMessage(caught));
      } finally {
        if (seq === graphSeq.current && mountedRef.current) setGraphLoading(false);
      }
    },
    [repoRoot],
  );

  // 首次加载与 scope 切换;分支/仓库变化会通过依赖重建。
  useEffect(() => {
    if (!repoRoot) return;
    void loadGraph({ scope: graphScope, skip: 0, snapshotId: null, append: false });
  }, [repoRoot, graphScope, loadGraph]);

  const refreshGraph = useCallback(() => {
    void loadGraph({ scope: graphScope, skip: 0, snapshotId: null, append: false });
  }, [graphScope, loadGraph]);

  const loadMoreGraph = useCallback(() => {
    if (!graph || !graph.hasMore || graphLoading) return;
    void loadGraph({
      scope: graphScope,
      skip: graph.commits.length,
      snapshotId: graph.snapshotId,
      append: true,
    });
  }, [graph, graphLoading, graphScope, loadGraph]);

  const selectCommit = useCallback(
    (sha: string | null) => {
      setSelectedSha(sha);
      setDetail(null);
      setDetailError(null);
      setDetailParent(null);
      if (!sha) return;
      const seq = ++detailSeq.current;
      setDetailLoading(true);
      const api = window.vela;
      if (!api) return;
      void api
        .getCommitDetail(sha, null, diffOptionsRef.current)
        .then((next) => {
          if (seq !== detailSeq.current || !mountedRef.current) return;
          setDetail(next);
        })
        .catch((caught) => {
          if (seq === detailSeq.current && mountedRef.current) setDetailError(cleanErrorMessage(caught));
        })
        .finally(() => {
          if (seq === detailSeq.current && mountedRef.current) setDetailLoading(false);
        });
    },
    [],
  );

  const changeDetailParent = useCallback(
    (parent: string | null) => {
      if (!selectedSha) return;
      const seq = ++detailSeq.current;
      setDetailParent(parent);
      setDetailLoading(true);
      setDetailError(null);
      const api = window.vela;
      if (!api) return;
      void api
        .getCommitDetail(selectedSha, parent, diffOptionsRef.current)
        .then((next) => {
          if (seq !== detailSeq.current || !mountedRef.current) return;
          setDetail(next);
        })
        .catch((caught) => {
          if (seq === detailSeq.current && mountedRef.current) setDetailError(cleanErrorMessage(caught));
        })
        .finally(() => {
          if (seq === detailSeq.current && mountedRef.current) setDetailLoading(false);
        });
    },
    [selectedSha],
  );

  // 忽略空白是展示选项,切换后同一提交需要重新生成 Diff。
  useEffect(() => {
    if (!selectedSha) return;
    const seq = ++detailSeq.current;
    setDetailLoading(true);
    const api = window.vela;
    if (!api) return;
    void api
      .getCommitDetail(selectedSha, detailParent, diffOptionsRef.current)
      .then((next) => {
        if (seq !== detailSeq.current || !mountedRef.current) return;
        setDetail(next);
      })
      .catch(() => undefined)
      .finally(() => {
        if (seq === detailSeq.current && mountedRef.current) setDetailLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ignoreWhitespace]);

  const runSearch = useCallback(
    (query: string) => {
      setSearchQuery(query);
      const trimmed = query.trim();
      if (!trimmed) {
        setSearchResult(null);
        setSearchLoading(false);
        return;
      }
      const api = window.vela;
      if (!api) return;
      setSearchLoading(true);
      void api
        .searchCommits(trimmed, graphScope, 100)
        .then((result) => {
          if (mountedRef.current) setSearchResult(result);
        })
        .catch((caught) => {
          if (mountedRef.current) {
            setSearchResult(null);
            setError(cleanErrorMessage(caught));
          }
        })
        .finally(() => {
          if (mountedRef.current) setSearchLoading(false);
        });
    },
    [graphScope],
  );

  const clearSearch = useCallback(() => {
    setSearchQuery("");
    setSearchResult(null);
  }, []);

  const refreshPr = useCallback(() => {
    const api = window.vela;
    if (!api) return;
    const seq = ++prSeq.current;
    setPrLoading(true);
    void api
      .getPullRequestDetail()
      .then((next) => {
        if (seq === prSeq.current && mountedRef.current) setPr(next);
      })
      .catch((caught) => {
        if (seq === prSeq.current && mountedRef.current) setError(cleanErrorMessage(caught));
      })
      .finally(() => {
        if (seq === prSeq.current && mountedRef.current) setPrLoading(false);
      });
  }, []);

  const loadTemplates = useCallback(() => {
    const api = window.vela;
    if (!api || templatesLoaded) return;
    setTemplatesLoaded(true);
    void api
      .listPrTemplates()
      .then((list) => {
        if (mountedRef.current) setTemplates(list);
      })
      .catch(() => {
        if (mountedRef.current) setTemplates([]);
      });
  }, [templatesLoaded]);

  const loadScope = useCallback(
    async (base: string, head: string | null = null) => {
      const api = window.vela;
      if (!api) return null;
      try {
        return await api.getPrScope(base, head);
      } catch (caught) {
        setError(cleanErrorMessage(caught));
        return null;
      }
    },
    [],
  );

  const ensureMutable = useCallback(async () => {
    const current = await refreshGuard();
    const streaming = agentStreaming || current?.agentRunning === true;
    if (streaming) {
      setError(tr(
        "Agent 正在这个工作树执行，暂时不能改动文件或索引。",
        "The agent is running in this worktree; file and index changes are paused.",
      ));
      return false;
    }
    if (project.git?.operation) {
      setError(tr(
        "仓库里有进行中的操作，请先处理冲突或在终端完成/中止。",
        "A Git operation is in progress. Resolve it or finish/abort it in a terminal first.",
      ));
      return false;
    }
    return true;
  }, [agentStreaming, refreshGuard, project.git?.operation]);

  const stagedDiff = useCallback(async () => {
    const api = window.vela;
    if (!api) return "";
    return api.getStagedDiff().catch(() => "");
  }, []);

  const commit = useCallback(
    async (input: GitCommitInput) => {
      return run("commit", async () => {
        if (!(await ensureMutable())) return null;
        const api = window.vela;
        if (!api) return null;
        const result = await api.commit(input);
        if (result.ok) {
          setNotice(trf("已提交 {0}", "Committed {0}", result.shortSha ?? ""));
          setSelectedSha(result.sha);
          refreshGraph();
          refreshOperations();
        } else {
          setError(result.message || tr("提交失败", "Commit failed"));
          refreshOperations();
        }
        return result;
      });
    },
    [run, ensureMutable, refreshGraph, refreshOperations],
  );

  const commitAndPush = useCallback(
    async (input: GitCommitInput, target: GitPushInput) => {
      return run("commit-push", async () => {
        if (!(await ensureMutable())) return null;
        const api = window.vela;
        if (!api) return null;
        const result = await api.commitAndPush(input, target);
        if (result.commit.ok) {
          setSelectedSha(result.commit.sha);
          refreshGraph();
        }
        if (!result.commit.ok) {
          setError(result.commit.message || tr("提交失败", "Commit failed"));
        } else if (result.push && !result.push.ok) {
          setError(trf("提交成功，但推送未完成：{0}", "Committed, but push did not finish: {0}", result.push.message));
        } else {
          setNotice(tr("提交并推送完成", "Committed and pushed"));
        }
        refreshOperations();
        refreshPr();
        return result;
      });
    },
    [run, ensureMutable, refreshGraph, refreshOperations, refreshPr],
  );

  const fetch = useCallback(
    async (remote: string | null = null) => {
      return run("fetch", async () => {
        const api = window.vela;
        if (!api) return null;
        const result = await api.fetchRemote(remote);
        setNotice(result.ok ? trf("已 Fetch {0}", "Fetched {0}", result.remote) : result.message);
        refreshOperations();
        refreshGraph();
        return result;
      });
    },
    [run, refreshOperations, refreshGraph],
  );

  const pull = useCallback(async () => {
    return run("pull", async () => {
      if (!(await ensureMutable())) return null;
      const api = window.vela;
      if (!api) return null;
      const result = await api.pullLatest();
      setNotice(result.message);
      refreshOperations();
      refreshGraph();
      return result;
    });
  }, [run, ensureMutable, refreshOperations, refreshGraph]);

  const push = useCallback(
    async (target: GitPushInput) => {
      return run("push", async () => {
        const api = window.vela;
        if (!api) return null;
        const result = await api.pushBranch(target);
        if (result.ok) setNotice(trf("已推送到 {0}/{1}", "Pushed to {0}/{1}", result.remote, result.branch));
        else setError(result.message);
        refreshOperations();
        refreshGraph();
        refreshPr();
        return result;
      });
    },
    [run, refreshOperations, refreshGraph, refreshPr],
  );

  const createPr = useCallback(
    async (input: PrCreateInput) => {
      return run("pr-create", async () => {
        const api = window.vela;
        if (!api) return null;
        const result = await api.createPullRequestNative(input);
        if (result.ok) {
          setNotice(result.message || trf("已创建 PR #{0}", "Created PR #{0}", result.number ?? ""));
        } else {
          setError(result.message || tr("创建 PR 失败", "Could not create the pull request"));
        }
        refreshOperations();
        refreshPr();
        refreshGraph();
        return result;
      });
    },
    [run, refreshOperations, refreshPr, refreshGraph],
  );

  const refreshOperation = useCallback(
    async (id: string) => {
      const api = window.vela;
      if (!api) return null;
      const record = await api.refreshOperation(id).catch(() => null);
      refreshOperations();
      return record;
    },
    [refreshOperations],
  );

  const clearError = useCallback(() => setError(null), []);
  const clearNotice = useCallback(() => setNotice(null), []);

  const refreshBranchList = project.refreshBranches;

  const diffOptions = useMemo<GitDiffOptions>(
    () => (ignoreWhitespace ? { ignoreWhitespace: true } : {}),
    [ignoreWhitespace],
  );
  diffOptionsRef.current = diffOptions;

  /** 只读查询:不占用 busy,不阻塞其他动作。 */
  const query = useCallback(
    async <T,>(task: () => Promise<T>, fallbackMessage: string): Promise<T | null> => {
      try {
        return await task();
      } catch (caught) {
        if (mountedRef.current) setError(cleanErrorMessage(caught) || fallbackMessage);
        return null;
      }
    },
    [],
  );

  const applyHunks = useCallback(
    async (path: string, action: GitHunkAction, patch: string) => {
      const done = await run("hunk", async () => {
        if (!(await ensureMutable())) return false;
        const api = window.vela;
        if (!api) return false;
        await api.applyHunks({ path, action, patch });
        return true;
      });
      if (done) refreshOperations();
      return done === true;
    },
    [run, ensureMutable, refreshOperations],
  );

  const undoCommit = useCallback(
    async (mode: GitUndoCommitMode) => {
      return run("undo-commit", async () => {
        if (!(await ensureMutable())) return null;
        const api = window.vela;
        if (!api) return null;
        const result = await api.undoLastCommit({ mode });
        if (result.ok) {
          setNotice(result.message);
          setSelectedSha(null);
          setDetail(null);
          refreshGraph();
        } else {
          setError(result.message);
        }
        refreshOperations();
        return result;
      });
    },
    [run, ensureMutable, refreshGraph, refreshOperations],
  );

  const branchDetail = useCallback(
    (name: string) => query(() => window.vela!.getBranchDetail(name), tr("读取分支状态失败", "Could not read the branch")),
    [query],
  );

  const renameBranch = useCallback(
    async (name: string, nextName: string) => {
      const done = await run("branch", async () => {
        if (!(await ensureMutable())) return false;
        const api = window.vela;
        if (!api) return false;
        await api.renameBranch(name, nextName);
        return true;
      });
      if (done === true) {
        setNotice(trf("已重命名分支 {0} → {1}", "Renamed {0} → {1}", name, nextName));
        await refreshBranchList();
        refreshGraph();
        refreshOperations();
      }
      return done === true;
    },
    [run, ensureMutable, refreshBranchList, refreshGraph, refreshOperations],
  );

  const deleteBranch = useCallback(
    async (input: GitBranchDeleteInput) => {
      return run("branch", async () => {
        if (!(await ensureMutable())) return null;
        const api = window.vela;
        if (!api) return null;
        const result = await api.deleteBranch(input);
        if (result.ok) setNotice(result.message);
        else setError(result.message);
        await refreshBranchList();
        refreshOperations();
        return result;
      });
    },
    [run, ensureMutable, refreshBranchList, refreshOperations],
  );

  const setUpstream = useCallback(
    async (input: GitUpstreamInput) => {
      const done = await run("upstream", async () => {
        if (!(await ensureMutable())) return false;
        const api = window.vela;
        if (!api) return false;
        await api.setUpstream(input);
        return true;
      });
      if (done === true) {
        setNotice(
          input.upstream
            ? trf("已设置 {0} 跟踪 {1}", "{0} now tracks {1}", input.branch, input.upstream)
            : trf("已清除 {0} 的跟踪关系", "Cleared tracking for {0}", input.branch),
        );
        await refreshBranchList();
        refreshOperations();
      }
      return done === true;
    },
    [run, ensureMutable, refreshBranchList, refreshOperations],
  );

  const compareRefs = useCallback(
    (base: string, head: string) =>
      query(() => window.vela!.compareRefs(base, head, diffOptions), tr("比较失败", "Comparison failed")),
    [query, diffOptions],
  );

  const remoteMutation = useCallback(
    async (
      label: string,
      task: (api: NonNullable<typeof window.vela>) => Promise<GitRemoteChange>,
    ): Promise<GitRemoteChange | null> => {
      const result = await run("remote", async () => {
        if (!(await ensureMutable())) return null;
        const api = window.vela;
        if (!api) return null;
        return task(api);
      });
      if (result) {
        setNotice(result.message || label);
        await refreshBranchList();
        refreshOperations();
      }
      return result;
    },
    [run, ensureMutable, refreshBranchList, refreshOperations],
  );

  const addRemote = useCallback(
    (input: GitRemoteInput) =>
      remoteMutation(trf("已添加远程 {0}", "Added remote {0}", input.name), (api) => api.addRemote(input)),
    [remoteMutation],
  );
  const setRemoteUrl = useCallback(
    (name: string, url: string, pushUrl?: string | null) =>
      remoteMutation(trf("已更新远程 {0}", "Updated remote {0}", name), (api) => api.setRemoteUrl(name, url, pushUrl)),
    [remoteMutation],
  );
  const removeRemote = useCallback(
    (name: string) => remoteMutation(trf("已删除远程 {0}", "Removed remote {0}", name), (api) => api.removeRemote(name)),
    [remoteMutation],
  );
  const renameRemote = useCallback(
    (name: string, nextName: string) =>
      remoteMutation(
        trf("已重命名远程 {0} → {1}", "Renamed remote {0} → {1}", name, nextName),
        (api) => api.renameRemote(name, nextName),
      ),
    [remoteMutation],
  );

  const conflictFile = useCallback(
    (path: string) => query(() => window.vela!.getConflictFile(path), tr("读取冲突内容失败", "Could not read the conflict")),
    [query],
  );

  const resolveConflict = useCallback(
    async (path: string, content: string) => {
      return run("conflict", async () => {
        if (!(await ensureMutable())) return null;
        const api = window.vela;
        if (!api) return null;
        const result = await api.resolveConflict({ path, content });
        if (result.ok) setNotice(result.message);
        else setError(result.message);
        refreshOperations();
        return result;
      });
    },
    [run, ensureMutable, refreshOperations],
  );

  const controlOperation = useCallback(
    async (action: GitOperationControlAction) => {
      return run("conflict", async () => {
        if (!(await ensureMutable())) return null;
        const api = window.vela;
        if (!api) return null;
        const result = await api.controlGitOperation(action);
        if (result.ok) setNotice(result.message);
        else setError(result.message);
        refreshGraph();
        refreshOperations();
        return result;
      });
    },
    [run, ensureMutable, refreshGraph, refreshOperations],
  );

  const refreshStashes = useCallback(() => {
    const api = window.vela;
    if (!api) return;
    setStashesLoading(true);
    void api
      .listStashes()
      .then((list) => {
        if (mountedRef.current) setStashes(list);
      })
      .catch(() => undefined)
      .finally(() => {
        if (mountedRef.current) setStashesLoading(false);
      });
  }, []);

  const createStash = useCallback(
    async (input: GitStashCreateInput) => {
      return run("stash", async () => {
        if (!(await ensureMutable())) return null;
        const api = window.vela;
        if (!api) return null;
        const result = await api.createStash(input);
        if (result.ok) setNotice(result.message);
        else setError(result.message);
        refreshStashes();
        refreshOperations();
        return result;
      });
    },
    [run, ensureMutable, refreshStashes, refreshOperations],
  );

  const applyStash = useCallback(
    async (id: string, mode: "apply" | "pop") => {
      const result = await run("stash", async () => {
        if (!(await ensureMutable())) return null;
        const api = window.vela;
        if (!api) return null;
        const outcome = await api.applyStash({ id, mode });
        if (outcome.ok) setNotice(outcome.message);
        else setError(outcome.message);
        refreshStashes();
        refreshOperations();
        return outcome;
      });
      if (result) refreshGraph();
      return result;
    },
    [run, ensureMutable, refreshStashes, refreshOperations, refreshGraph],
  );

  const dropStash = useCallback(
    async (id: string) => {
      const done = await run("stash", async () => {
        if (!(await ensureMutable())) return false;
        const api = window.vela;
        if (!api) return false;
        const result = await api.dropStash(id);
        if (result.ok) {
          setStashes(result.stashes);
          setNotice(result.message);
        } else {
          setError(result.message);
        }
        refreshOperations();
        return result.ok;
      });
      return done === true;
    },
    [run, ensureMutable, refreshOperations],
  );

  const stashDiff = useCallback(
    async (id: string) => (await query(() => window.vela!.getStashDiff(id), tr("读取 Stash 差异失败", "Could not read the stash diff"))) ?? "",
    [query],
  );

  const refreshWorktrees = useCallback(() => {
    const api = window.vela;
    if (!api) return;
    setWorktreesLoading(true);
    void api
      .listWorktrees()
      .then((list) => {
        if (mountedRef.current) setWorktrees(list);
      })
      .catch(() => undefined)
      .finally(() => {
        if (mountedRef.current) setWorktreesLoading(false);
      });
  }, []);

  const createWorktree = useCallback(
    async (input: GitWorktreeCreateInput) => {
      const result = await run("worktree", async () => {
        const api = window.vela;
        if (!api) return null;
        const outcome = await api.createWorktree(input);
        if (outcome.ok) setNotice(outcome.message);
        else setError(outcome.message);
        refreshWorktrees();
        refreshOperations();
        return outcome;
      });
      if (result?.ok) await refreshBranchList();
      return result;
    },
    [run, refreshWorktrees, refreshOperations, refreshBranchList],
  );

  const removeWorktree = useCallback(
    async (input: GitWorktreeRemoveInput) => {
      const result = await run("worktree", async () => {
        const api = window.vela;
        if (!api) return null;
        const outcome = await api.removeWorktree(input);
        if (outcome.ok) setNotice(outcome.message);
        else setError(outcome.message);
        refreshWorktrees();
        refreshOperations();
        return outcome;
      });
      if (result?.ok) await refreshBranchList();
      return result;
    },
    [run, refreshWorktrees, refreshOperations, refreshBranchList],
  );

  const pruneWorktrees = useCallback(async () => {
    const done = await run("worktree", async () => {
      const api = window.vela;
      if (!api) return false;
      const result = await api.pruneWorktrees();
      if (result.ok) setNotice(result.message);
      else setError(result.message);
      refreshWorktrees();
      refreshOperations();
      return result.ok;
    });
    return done === true;
  }, [run, refreshWorktrees, refreshOperations]);

  const searchOperations = useCallback((nextQuery: GitOperationQuery | null) => {
    const api = window.vela;
    if (!api) return;
    void api
      .getOperationRecords(nextQuery ?? undefined)
      .then((snapshot) => {
        if (mountedRef.current) setOperations(snapshot);
      })
      .catch(() => undefined);
  }, []);

  const applyPrUpdate = useCallback(
    async (task: (api: NonNullable<typeof window.vela>) => Promise<PrUpdateResult>) => {
      return run("pr-update", async () => {
        const api = window.vela;
        if (!api) return null;
        const result = await task(api);
        if (result.ok) setNotice(result.message);
        else setError(result.message);
        refreshOperations();
        refreshPr();
        return result;
      });
    },
    [run, refreshOperations, refreshPr],
  );

  const updatePr = useCallback(
    (input: PrUpdateInput) => applyPrUpdate((api) => api.updatePullRequest(input)),
    [applyPrUpdate],
  );
  const markPrReady = useCallback(
    (number: number) => applyPrUpdate((api) => api.markPullRequestReady(number)),
    [applyPrUpdate],
  );
  const linkPrIssues = useCallback(
    (input: PrIssueLinkInput) => applyPrUpdate((api) => api.linkPullRequestIssues(input)),
    [applyPrUpdate],
  );
  const loadPrEditOptions = useCallback(
    () => query(() => window.vela!.getPullRequestEditOptions(), tr("读取仓库选项失败", "Could not read repository options")),
    [query],
  );

  // ---------- P2:历史操作、提交整理与恢复 ----------

  const previewHistoryOp = useCallback(
    (input: GitHistoryOpInput) =>
      query(() => window.vela!.previewHistoryOp(input), tr("读取操作范围失败", "Could not read the operation scope")),
    [query],
  );

  const runHistoryOp = useCallback(
    async (input: GitHistoryOpInput) => {
      return run(`history-${input.action}`, async () => {
        if (!(await ensureMutable())) return null;
        const api = window.vela;
        if (!api) return null;
        const result = await api.runHistoryOp(input);
        if (result.ok) setNotice(result.message);
        else setError(result.message);
        setSelectedSha(null);
        setDetail(null);
        refreshGraph();
        refreshOperations();
        return result;
      });
    },
    [run, ensureMutable, refreshGraph, refreshOperations],
  );

  const createBranchAt = useCallback(
    async (input: GitBranchAtInput) => {
      const result = await run("branch", async () => {
        if (!(await ensureMutable())) return null;
        const api = window.vela;
        if (!api) return null;
        const outcome = await api.createBranchAt(input);
        if (outcome.ok) setNotice(outcome.message);
        else setError(outcome.message);
        refreshOperations();
        return outcome;
      });
      if (result?.ok) await refreshBranchList();
      return result;
    },
    [run, ensureMutable, refreshBranchList, refreshOperations],
  );

  const previewRewrite = useCallback(
    (input: GitRewritePreviewInput) =>
      query(() => window.vela!.previewRewrite(input), tr("读取整理范围失败", "Could not read the rewrite scope")),
    [query],
  );

  const runRewrite = useCallback(
    async (input: GitRewriteInput) => {
      return run("rewrite", async () => {
        if (!(await ensureMutable())) return null;
        const api = window.vela;
        if (!api) return null;
        const result = await api.runRewrite(input);
        if (result.ok) setNotice(result.message);
        else setError(result.message);
        setSelectedSha(null);
        setDetail(null);
        refreshGraph();
        refreshOperations();
        return result;
      });
    },
    [run, ensureMutable, refreshGraph, refreshOperations],
  );

  const refreshReflog = useCallback((nextQuery?: GitReflogQuery | null) => {
    const api = window.vela;
    if (!api) return;
    const seq = ++reflogSeq.current;
    setReflogLoading(true);
    void api
      .getReflog(nextQuery ?? undefined)
      .then((snapshot) => {
        if (seq === reflogSeq.current && mountedRef.current) setReflog(snapshot);
      })
      .catch((caught) => {
        if (seq === reflogSeq.current && mountedRef.current) setError(cleanErrorMessage(caught));
      })
      .finally(() => {
        if (seq === reflogSeq.current && mountedRef.current) setReflogLoading(false);
      });
  }, []);

  const previewRecovery = useCallback(
    (input: GitRecoveryPreviewInput) =>
      query(() => window.vela!.previewRecovery(input), tr("读取恢复范围失败", "Could not read the recovery scope")),
    [query],
  );

  const runRecovery = useCallback(
    async (input: GitRecoveryPreviewInput) => {
      const result = await run("recover", async () => {
        if (!(await ensureMutable())) return null;
        const api = window.vela;
        if (!api) return null;
        const outcome = await api.runRecovery(input);
        if (outcome.ok) setNotice(outcome.message);
        else setError(outcome.message);
        refreshReflog();
        refreshGraph();
        refreshOperations();
        return outcome;
      });
      if (result?.ok) await refreshBranchList();
      return result;
    },
    [run, ensureMutable, refreshReflog, refreshGraph, refreshOperations, refreshBranchList],
  );

  // ---------- P2:高级同步与安全强推 ----------

  const pullWithStrategy = useCallback(
    async (strategy: GitPullStrategy) => {
      return run("pull", async () => {
        if (!(await ensureMutable())) return null;
        const api = window.vela;
        if (!api) return null;
        const input: GitPullInput = { strategy };
        const result = await api.pullWithStrategy(input);
        if (result.ok) setNotice(result.message);
        else setError(result.message);
        refreshOperations();
        refreshGraph();
        return result;
      });
    },
    [run, ensureMutable, refreshOperations, refreshGraph],
  );

  const previewForcePush = useCallback(
    (remote: string, branch: string) =>
      query(
        () => window.vela!.previewForcePush(remote, branch),
        tr("读取远程引用失败", "Could not read the remote reference"),
      ),
    [query],
  );

  const forcePush = useCallback(
    async (input: GitForcePushInput) => {
      return run("force-push", async () => {
        if (!(await ensureMutable())) return null;
        const api = window.vela;
        if (!api) return null;
        const result = await api.forcePushBranch(input);
        if (result.ok) setNotice(result.message);
        else setError(result.message);
        refreshOperations();
        refreshGraph();
        refreshPr();
        return result;
      });
    },
    [run, ensureMutable, refreshOperations, refreshGraph, refreshPr],
  );

  // ---------- P2:Tag 与 Release ----------

  const refreshTags = useCallback(() => {
    const api = window.vela;
    if (!api) return;
    setTagsLoading(true);
    setTagsError(null);
    void api
      .listTags()
      .then((result) => {
        if (!mountedRef.current) return;
        setTags(result.tags);
        if (!result.ok) setTagsError(result.message);
      })
      .catch((caught) => {
        if (mountedRef.current) setTagsError(cleanErrorMessage(caught));
      })
      .finally(() => {
        if (mountedRef.current) setTagsLoading(false);
      });
  }, []);

  const createTag = useCallback(
    async (input: GitTagCreateInput) => {
      const result = await run("tag", async () => {
        const api = window.vela;
        if (!api) return null;
        const outcome = await api.createTag(input);
        if (outcome.ok) setNotice(outcome.message);
        else setError(outcome.message);
        refreshTags();
        refreshOperations();
        refreshGraph();
        return outcome;
      });
      return result;
    },
    [run, refreshTags, refreshOperations, refreshGraph],
  );

  const deleteTag = useCallback(
    async (name: string, remote?: string | null) => {
      const result = await run("tag", async () => {
        const api = window.vela;
        if (!api) return null;
        const outcome = await api.deleteTag(name, remote ?? null);
        if (outcome.ok) setNotice(outcome.message);
        else setError(outcome.message);
        refreshTags();
        refreshOperations();
        return outcome;
      });
      return result;
    },
    [run, refreshTags, refreshOperations],
  );

  const refreshReleases = useCallback(() => {
    const api = window.vela;
    if (!api) return;
    setReleasesLoading(true);
    void api
      .listReleases()
      .then((result) => {
        if (mountedRef.current) setReleases(result);
      })
      .catch(() => undefined)
      .finally(() => {
        if (mountedRef.current) setReleasesLoading(false);
      });
  }, []);

  const createRelease = useCallback(
    async (input: GitReleaseCreateInput) => {
      return run("release", async () => {
        const api = window.vela;
        if (!api) return null;
        const result = await api.createRelease(input);
        if (result.ok) setNotice(result.message);
        else setError(result.message);
        refreshReleases();
        refreshTags();
        refreshOperations();
        return result;
      });
    },
    [run, refreshReleases, refreshTags, refreshOperations],
  );

  const loadReleaseScope = useCallback(
    (baseTag: string | null, targetTag: string) =>
      query(
        () => window.vela!.getReleaseNotesScope(baseTag, targetTag),
        tr("读取版本区间失败", "Could not read the version range"),
      ),
    [query],
  );

  // ---------- P2:审阅协作、合并与关闭 ----------

  const refreshReviewThreads = useCallback((number?: number | null) => {
    const api = window.vela;
    if (!api) return;
    const seq = ++reviewsSeq.current;
    setReviewThreadsLoading(true);
    void api
      .getPullRequestReviewThreads(number ?? null)
      .then((result) => {
        if (seq === reviewsSeq.current && mountedRef.current) setReviewThreads(result);
      })
      .catch((caught) => {
        if (seq === reviewsSeq.current && mountedRef.current) setError(cleanErrorMessage(caught));
      })
      .finally(() => {
        if (seq === reviewsSeq.current && mountedRef.current) setReviewThreadsLoading(false);
      });
  }, []);

  const applyReviewMutation = useCallback(
    async (
      busyId: string,
      task: (api: NonNullable<typeof window.vela>) => Promise<PrReviewMutationResult>,
      after?: (result: PrReviewMutationResult) => void,
    ) => {
      return run(busyId, async () => {
        const api = window.vela;
        if (!api) return null;
        const result = await task(api);
        if (result.ok) setNotice(result.message);
        else setError(result.message);
        if (result.threads || result.reviews) {
          setReviewThreads((current) => ({
            ok: result.ok,
            message: result.message,
            threads: result.threads ?? current?.threads ?? [],
            reviews: result.reviews ?? current?.reviews ?? [],
            reviewDecision: result.reviewDecision ?? current?.reviewDecision ?? null,
            pendingReviewers: current?.pendingReviewers ?? [],
            headSha: current?.headSha ?? null,
            previousHeadSha: current?.previousHeadSha ?? null,
          }));
        }
        refreshReviewThreads();
        refreshOperations();
        after?.(result);
        return result;
      });
    },
    [run, refreshReviewThreads, refreshOperations],
  );

  const commentPr = useCallback(
    (input: PrCommentInput) => applyReviewMutation("pr-comment", (api) => api.commentPullRequest(input)),
    [applyReviewMutation],
  );
  const reviewPr = useCallback(
    (input: PrReviewInput) =>
      applyReviewMutation("pr-review", (api) => api.reviewPullRequest(input), () => refreshPr()),
    [applyReviewMutation, refreshPr],
  );
  const resolvePrThread = useCallback(
    (input: PrThreadResolveInput) =>
      run("pr-thread", async () => {
        const api = window.vela;
        if (!api) return null;
        const result = await api.resolvePullRequestThread(input);
        if (result.ok) setNotice(result.message);
        else setError(result.message);
        refreshReviewThreads();
        refreshOperations();
        return result;
      }),
    [run, refreshReviewThreads, refreshOperations],
  );

  const refreshMergePreview = useCallback((number?: number | null) => {
    const api = window.vela;
    if (!api) return;
    const seq = ++mergeSeq.current;
    setMergePreviewLoading(true);
    void api
      .getPullRequestMergePreview(number ?? null)
      .then((result) => {
        if (seq === mergeSeq.current && mountedRef.current) setMergePreview(result);
      })
      .catch((caught) => {
        if (seq === mergeSeq.current && mountedRef.current) setError(cleanErrorMessage(caught));
      })
      .finally(() => {
        if (seq === mergeSeq.current && mountedRef.current) setMergePreviewLoading(false);
      });
  }, []);

  const mergePr = useCallback(
    async (input: PrMergeInput) => {
      return run("pr-merge", async () => {
        const api = window.vela;
        if (!api) return null;
        const result = await api.mergePullRequest(input);
        if (result.ok) setNotice(result.message);
        else setError(result.message);
        refreshPr();
        refreshMergePreview(input.number);
        refreshOperations();
        return result;
      });
    },
    [run, refreshPr, refreshMergePreview, refreshOperations],
  );

  const closePr = useCallback(
    async (input: PrCloseInput) => {
      return run("pr-close", async () => {
        const api = window.vela;
        if (!api) return null;
        const result = await api.closePullRequest(input);
        if (result.ok) setNotice(result.message);
        else setError(result.message);
        refreshPr();
        refreshMergePreview(input.number);
        refreshOperations();
        return result;
      });
    },
    [run, refreshPr, refreshMergePreview, refreshOperations],
  );

  const effectiveGuard = useMemo<GitGuardState | null>(() => {
    if (agentStreaming) {
      return guard ?? { agentRunning: true, conversationId: null, reason: null };
    }
    return guard;
  }, [guard, agentStreaming]);

  return {
    guard: effectiveGuard,
    operations,
    error,
    notice,
    busy,
    clearError,
    clearNotice,
    graph,
    graphScope,
    graphLoading,
    graphError,
    setGraphScope,
    refreshGraph,
    loadMoreGraph,
    selectCommit,
    selectedSha,
    detail,
    detailLoading,
    detailError,
    detailParent,
    setDetailParent: changeDetailParent,
    searchQuery,
    searchResult,
    searchLoading,
    runSearch,
    clearSearch,
    pr,
    prLoading,
    templates,
    templatesLoaded,
    loadTemplates,
    refreshPr,
    loadScope,
    createPr,
    stagedDiff,
    commit,
    commitAndPush,
    fetch,
    pull,
    push,
    refreshOperations,
    refreshOperation,
    ensureMutable,
    diffMode,
    setDiffMode,
    ignoreWhitespace,
    setIgnoreWhitespace,
    diffOptions,
    applyHunks,
    undoCommit,
    branchDetail,
    renameBranch,
    deleteBranch,
    setUpstream,
    compareRefs,
    addRemote,
    setRemoteUrl,
    removeRemote,
    renameRemote,
    conflictFile,
    resolveConflict,
    controlOperation,
    stashes,
    stashesLoading,
    refreshStashes,
    createStash,
    applyStash,
    dropStash,
    stashDiff,
    worktrees,
    worktreesLoading,
    refreshWorktrees,
    createWorktree,
    removeWorktree,
    pruneWorktrees,
    searchOperations,
    updatePr,
    markPrReady,
    linkPrIssues,
    loadPrEditOptions,
    createBranchAt,
    previewHistoryOp,
    runHistoryOp,
    previewRewrite,
    runRewrite,
    reflog,
    reflogLoading,
    refreshReflog,
    previewRecovery,
    runRecovery,
    pullWithStrategy,
    previewForcePush,
    forcePush,
    tags,
    tagsLoading,
    tagsError,
    refreshTags,
    createTag,
    deleteTag,
    releases,
    releasesLoading,
    refreshReleases,
    createRelease,
    loadReleaseScope,
    reviewThreads,
    reviewThreadsLoading,
    refreshReviewThreads,
    commentPr,
    reviewPr,
    resolvePrThread,
    mergePreview,
    mergePreviewLoading,
    refreshMergePreview,
    mergePr,
    closePr,
  };
}
