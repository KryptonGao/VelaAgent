import { BrowserIpc, type BrowserWindowState } from "../../../../packages/shared/src/browser";
import {
  IpcChannel,
  PrInboxIpc,
  TaskRecipesIpc,
  ScheduledTasksIpc,
  type ScheduledTasksState,
  type AgentSettings,
  type ConversationSyncResult,
  type McpStatusEvent,
  type PluginStatusEvent,
  type AppLocale,
  type AgentStreamEvent,
  type AppState,
  type AiTextRequest,
  type AiTextResult,
  type AskUserQuestionEvent,
  type AttachmentPickKind,
  type AuthMethodType,
  type BranchSummary,
  type CustomModelInput,
  type ExecutionEnvironment,
  type FileAttachmentPayload,
  type GitBranchDeleteInput,
  type GitBranchDeleteResult,
  type GitBranchDetail,
  type GitBranchAtInput,
  type GitBranchAtResult,
  type GitChangeScope,
  type GitCommitDetail,
  type GitCommitInput,
  type GitCommitResult,
  type GitCommitSearchResult,
  type GitCompareResult,
  type GitConflictFile,
  type GitConflictResolveInput,
  type GitConflictResolveResult,
  type GitDiffOptions,
  type GitFetchResult,
  type GitForcePushInput,
  type GitForcePushPreview,
  type GitForcePushResult,
  type GitGraphQuery,
  type GitGraphScope,
  type GitGraphSlice,
  type GitGuardState,
  type GitHistoryOpInput,
  type GitHistoryOpPreview,
  type GitHistoryOpResult,
  type GitHunkApplyInput,
  type GitOperationControlAction,
  type GitOperationControlResult,
  type GitOperationQuery,
  type GitOperationRecord,
  type GitOperationSnapshot,
  type GitPullInput,
  type GitPullResult,
  type GitPushInput,
  type GitRecoveryPreview,
  type GitRecoveryPreviewInput,
  type GitRecoveryResult,
  type GitReflogQuery,
  type GitReflogSnapshot,
  type GitReleaseCreateInput,
  type GitReleaseCreateResult,
  type GitReleaseListResult,
  type GitReleaseNotesScope,
  type GitRemoteChange,
  type GitRemoteInput,
  type GitRewriteInput,
  type GitRewritePreview,
  type GitRewritePreviewInput,
  type GitRewriteResult,
  type GitStashApplyInput,
  type GitStashApplyResult,
  type GitStashCreateInput,
  type GitStashCreateResult,
  type GitStashEntry,
  type GitStatusSnapshot,
  type GitSyncResult,
  type GitTagCreateInput,
  type GitTagCreateResult,
  type GitTagListResult,
  type GitUndoCommitInput,
  type GitUndoCommitResult,
  type GitUpstreamInput,
  type GitWorktreeCreateInput,
  type GitWorktreeCreateResult,
  type GitWorktreeInfo,
  type GitWorktreePruneResult,
  type GitWorktreeRemoveInput,
  type GitWorktreeRemoveResult,
  type InteractionMode,
  type LoginResult,
  type ModelAuthEvent,
  type ModelCatalog,
  type OpenTarget,
  type PrCloseInput,
  type PrCloseResult,
  type PrCommentInput,
  type PrCompareScope,
  type PrCreateInput,
  type PrCreateResult,
  type PrEditOptions,
  type PrIssueLinkInput,
  type PrMergeInput,
  type PrMergePreview,
  type PrMergeResult,
  type PrReviewInput,
  type PrReviewMutationResult,
  type PrReviewThreadsResult,
  type PrTemplateInfo,
  type PrThreadResolveInput,
  type PrThreadResolveResult,
  type PrUpdateInput,
  type PrUpdateResult,
  type PromptInput,
  type PullRequestInfo,
  type SandboxApprovalEvent,
  type SandboxMode,
  type SelectableEnvironmentKind,
  type ExternalSkillScan,
  type SkillCatalog,
  type SkillMigrationResult,
  type TerminalCreateOptions,
  type TerminalEvent,
  type TerminalSessionInfo,
  type ThinkingLevel,
  type TranscriptMessage,
  type VelaApi,
  type WorkspaceEvent,
  type WorkspaceFileContent,
  type WorkspaceFileList,
  type WorkspaceSearchResult,
  type WorkspaceState,
} from "@vela/shared";
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";

const api: VelaApi = {
  prInbox: {
    list: (query, options) => ipcRenderer.invoke(PrInboxIpc.list, query, options),
    enrich: (targets, options) => ipcRenderer.invoke(PrInboxIpc.enrich, targets, options),
    detail: (target, options) => ipcRenderer.invoke(PrInboxIpc.detail, target, options),
    activity: (target, kind, cursor, headSha, threadId, options) => ipcRenderer.invoke(PrInboxIpc.activity, target, kind, cursor, headSha, threadId, options),
    files: (target, page, headSha, baseSha, options) => ipcRenderer.invoke(PrInboxIpc.files, target, page, headSha, baseSha, options),
    comment: (target, body, options) => ipcRenderer.invoke(PrInboxIpc.comment, target, body, options),
    cancel: id => ipcRenderer.invoke(PrInboxIpc.cancel, id),
    open: (target, url) => ipcRenderer.invoke(PrInboxIpc.open, target, url),
    openTerminal: () => ipcRenderer.invoke(PrInboxIpc.terminal),
  },
  taskRecipes: {
    list: locale => ipcRenderer.invoke(TaskRecipesIpc.list, locale),
    save: (input, id, revision, workspace) => ipcRenderer.invoke(TaskRecipesIpc.save, input, id, revision, workspace),
    delete: (id, fingerprint) => ipcRenderer.invoke(TaskRecipesIpc.delete, id, fingerprint),
    preview: draft => ipcRenderer.invoke(TaskRecipesIpc.preview, draft),
    start: input => ipcRenderer.invoke(TaskRecipesIpc.start, input),
    pickPath: (workspace, kind) => ipcRenderer.invoke(TaskRecipesIpc.pickPath, workspace, kind),
    importFile: () => ipcRenderer.invoke(TaskRecipesIpc.importFile),
    exportFile: recipe => ipcRenderer.invoke(TaskRecipesIpc.exportFile, recipe),
    generate: input => ipcRenderer.invoke(TaskRecipesIpc.generate, input),
    cancelGenerate: id => ipcRenderer.invoke(TaskRecipesIpc.cancelGenerate, id),
    stageEvidence: (id, stageId, attempt, evidenceId) => ipcRenderer.invoke(TaskRecipesIpc.stageEvidence, id, stageId, attempt, evidenceId),
    approveStage: (id, stageId, approved) => ipcRenderer.invoke(TaskRecipesIpc.approveStage, id, stageId, approved),
    retryStage: (id, stageId, requestId) => ipcRenderer.invoke(TaskRecipesIpc.retryStage, id, stageId, requestId),
    rateRun: (id, rating, note) => ipcRenderer.invoke(TaskRecipesIpc.rateRun, id, rating, note),
    connectTeam: (workspace, permission) => ipcRenderer.invoke(TaskRecipesIpc.connectTeam, workspace, permission),
    disconnectTeam: workspace => ipcRenderer.invoke(TaskRecipesIpc.disconnectTeam, workspace),
    saveTeam: (input, workspace, id, revision, fingerprint) => ipcRenderer.invoke(TaskRecipesIpc.saveTeam, input, workspace, id, revision, fingerprint),
    cleanupWorktree: id => ipcRenderer.invoke(TaskRecipesIpc.cleanupWorktree, id),
    subscribe: listener => {
      const handler = () => listener(); ipcRenderer.on(TaskRecipesIpc.state, handler);
      return () => { ipcRenderer.removeListener(TaskRecipesIpc.state, handler); };
    },
  },
  scheduledTasks: {
    list: () => ipcRenderer.invoke(ScheduledTasksIpc.list),
    create: (input) => ipcRenderer.invoke(ScheduledTasksIpc.create, input),
    update: (id, patch) => ipcRenderer.invoke(ScheduledTasksIpc.update, id, patch),
    delete: (id) => ipcRenderer.invoke(ScheduledTasksIpc.delete, id),
    runNow: (id) => ipcRenderer.invoke(ScheduledTasksIpc.runNow, id),
    subscribe: (listener) => {
      const handler = (_event: IpcRendererEvent, state: ScheduledTasksState) => listener(state);
      ipcRenderer.on(ScheduledTasksIpc.state, handler);
      return () => { ipcRenderer.removeListener(ScheduledTasksIpc.state, handler); };
    },
  },
  getPlugins: input => ipcRenderer.invoke("mcp:plugins", input),
  connectPlugin: input => ipcRenderer.invoke("mcp:plugin-connect", input),
  disconnectPlugin: input => ipcRenderer.invoke("mcp:plugin-disconnect", input),
  onPluginStatus: listener => {
    const handler = (_event: IpcRendererEvent, event: PluginStatusEvent) => listener(event);
    ipcRenderer.on("plugins:status", handler);
    return () => { ipcRenderer.removeListener("plugins:status", handler); };
  },
  getMcpCatalog: (input) => ipcRenderer.invoke("mcp:catalog", input),
  saveMcpServer: (input) => ipcRenderer.invoke("mcp:save", input),
  removeMcpServer: (input) => ipcRenderer.invoke("mcp:remove", input),
  setMcpEnabled: (input) => ipcRenderer.invoke("mcp:enabled", input),
  reconnectMcpServer: (input) => ipcRenderer.invoke("mcp:reconnect", input),
  loginMcpServer: (input) => ipcRenderer.invoke("mcp:login", input),
  cancelMcpLogin: (input) => ipcRenderer.invoke("mcp:cancel-login", input),
  logoutMcpServer: (input) => ipcRenderer.invoke("mcp:logout", input),
  setMcpProjectTrust: (input) => ipcRenderer.invoke("mcp:trust", input),
  setMcpToolReadOnly: (input) => ipcRenderer.invoke("mcp:readonly", input),
  onMcpStatus: (listener) => {
    const handler = (_event: IpcRendererEvent, event: McpStatusEvent) => listener(event);
    ipcRenderer.on("mcp:status", handler);
    return () => { ipcRenderer.removeListener("mcp:status", handler); };
  },
  memory: {
    setEnabled: (input) => ipcRenderer.invoke(IpcChannel.memorySetEnabled, input),
    list: (input) => ipcRenderer.invoke(IpcChannel.memoryList, input ?? {}),
    read: (input) => ipcRenderer.invoke(IpcChannel.memoryRead, input),
    save: (input) => ipcRenderer.invoke(IpcChannel.memorySave, input),
    remove: (input) => ipcRenderer.invoke(IpcChannel.memoryRemove, input),
  },
  browser: {
    command: (command) => ipcRenderer.invoke(BrowserIpc.command, command),
    subscribe: (listener) => {
      const handler = (_event: IpcRendererEvent, state: BrowserWindowState) => listener(state);
      ipcRenderer.on(BrowserIpc.state, handler);
      return () => { ipcRenderer.removeListener(BrowserIpc.state, handler); };
    },
  },
  platform: process.platform,
  development: ipcRenderer.sendSync(IpcChannel.appIsDevelopment) ? {
    syncProductionConversations: () => ipcRenderer.invoke(IpcChannel.appSyncProductionConversations) as Promise<ConversationSyncResult>,
  } : undefined,
  uiStorage: {
    getItem: (key) => storageRequest(IpcChannel.appUiStorageGet, key).value,
    setItem: (key, value) => { storageRequest(IpcChannel.appUiStorageSet, key, value); },
    removeItem: (key) => { storageRequest(IpcChannel.appUiStorageSet, key, null); },
  },
  setLocale: (locale: AppLocale) => ipcRenderer.send(IpcChannel.appSetLocale, locale),
  getState: () => ipcRenderer.invoke(IpcChannel.getState) as Promise<AppState>,
  prompt: (text, images, conversationId, deliverAs) =>
    ipcRenderer.invoke(IpcChannel.prompt, {
      text,
      images: images ?? [],
      ...(conversationId ? { conversationId } : {}),
      ...(deliverAs ? { deliverAs } : {}),
    } satisfies PromptInput) as Promise<AppState>,
  removeInstruction: (instructionId: string, conversationId?: string) =>
    ipcRenderer.invoke(IpcChannel.sessionRemoveInstruction, instructionId, conversationId ?? null) as Promise<AppState>,
  abort: (conversationId) =>
    ipcRenderer.invoke(IpcChannel.abort, conversationId ?? null) as Promise<AppState>,
  setInteractionMode: (mode: InteractionMode, conversationId) =>
    ipcRenderer.invoke(IpcChannel.sessionSetMode, mode, conversationId ?? null) as Promise<AppState>,
  executePlan: (conversationId, strategy) =>
    ipcRenderer.invoke(IpcChannel.sessionExecutePlan, conversationId ?? null, strategy ?? "continue") as Promise<AppState>,
  resumeGoal: (conversationId) =>
    ipcRenderer.invoke(IpcChannel.sessionResumeGoal, conversationId ?? null) as Promise<AppState>,
  createConversation: (cwd?: string) => ipcRenderer.invoke(IpcChannel.sessionCreate, cwd) as Promise<AppState>,
  switchConversation: (id: string) =>
    ipcRenderer.invoke(IpcChannel.sessionSwitch, id) as Promise<AppState>,
  renameConversation: (id: string, title: string) =>
    ipcRenderer.invoke(IpcChannel.sessionRename, id, title) as Promise<AppState>,
  archiveConversation: (id: string) =>
    ipcRenderer.invoke(IpcChannel.sessionArchive, id) as Promise<AppState>,
  unarchiveConversation: (id: string) =>
    ipcRenderer.invoke(IpcChannel.sessionUnarchive, id) as Promise<AppState>,
  branchConversation: (conversationId: string, turnIndex: number) =>
    ipcRenderer.invoke(IpcChannel.sessionBranch, conversationId, turnIndex) as Promise<AppState>,
  rewindConversation: (conversationId, turnIndex) =>
    ipcRenderer.invoke(IpcChannel.sessionRewind, conversationId, turnIndex) as Promise<{ state: AppState; messages: TranscriptMessage[] }>,
  getTrace: (conversationId) => ipcRenderer.invoke(IpcChannel.sessionTrace, conversationId),
  getTraceDetails: (conversationId, nodeId) => ipcRenderer.invoke(IpcChannel.sessionTraceDetails, conversationId, nodeId),
  getMessages: (conversationId: string) =>
    ipcRenderer.invoke(IpcChannel.sessionMessages, conversationId) as Promise<TranscriptMessage[]>,
  summarizeThinking: (input) => ipcRenderer.invoke(IpcChannel.sessionSummarizeThinking, input) as Promise<string>,
  getAgentMessages: (conversationId: string, agentId: string) =>
    ipcRenderer.invoke(IpcChannel.sessionAgentMessages, conversationId, agentId) as Promise<TranscriptMessage[]>,
  getCatalog: () => ipcRenderer.invoke(IpcChannel.getCatalog) as Promise<ModelCatalog>,
  selectModel: (provider, id) => ipcRenderer.invoke(IpcChannel.selectModel, provider, id) as Promise<AppState>,
  setThinkingLevel: (level: ThinkingLevel) => ipcRenderer.invoke(IpcChannel.setThinkingLevel, level) as Promise<AppState>,
  addModel: (input: CustomModelInput) => ipcRenderer.invoke(IpcChannel.addModel, input) as Promise<AppState>,
  registerModel: (input: CustomModelInput) =>
    ipcRenderer.invoke(IpcChannel.registerModel, input) as Promise<AppState>,
  getAgentSettings: () => ipcRenderer.invoke(IpcChannel.getAgentSettings) as Promise<AgentSettings>,
  saveAgentSettings: (settings: AgentSettings) =>
    ipcRenderer.invoke(IpcChannel.saveAgentSettings, settings) as Promise<AgentSettings>,
  listSkills: () => ipcRenderer.invoke(IpcChannel.listSkills) as Promise<SkillCatalog>,
  openSkillsDirectory: () => ipcRenderer.invoke(IpcChannel.openSkillsDir) as Promise<void>,
  scanExternalSkills: () => ipcRenderer.invoke(IpcChannel.scanExternalSkills) as Promise<ExternalSkillScan>,
  migrateSkills: (ids) => ipcRenderer.invoke(IpcChannel.migrateSkills, ids) as Promise<SkillMigrationResult>,
  setSkillEnabled: (name, enabled) =>
    ipcRenderer.invoke(IpcChannel.setSkillEnabled, name, enabled) as Promise<SkillCatalog>,
  deleteSkill: (name, location) =>
    ipcRenderer.invoke(IpcChannel.deleteSkill, name, location) as Promise<SkillCatalog>,
  removeModel: (provider, id) => ipcRenderer.invoke(IpcChannel.removeModel, provider, id) as Promise<AppState>,
  logout: (providerId) => ipcRenderer.invoke(IpcChannel.logout, providerId) as Promise<AppState>,
  login: (providerId, type: AuthMethodType) => ipcRenderer.invoke(IpcChannel.login, providerId, type) as Promise<LoginResult>,
  replyLogin: (promptId, value) => ipcRenderer.invoke(IpcChannel.replyLogin, promptId, value) as Promise<void>,
  cancelLogin: () => ipcRenderer.invoke(IpcChannel.cancelLogin) as Promise<void>,
  openWorkspaceDialog: () =>
    ipcRenderer.invoke(IpcChannel.workspaceOpenDialog) as Promise<WorkspaceState>,
  getWorkspaceState: () =>
    ipcRenderer.invoke(IpcChannel.workspaceGetState) as Promise<WorkspaceState>,
  selectWorkspace: (path: string) =>
    ipcRenderer.invoke(IpcChannel.workspaceSelect, path) as Promise<WorkspaceState>,
  closeWorkspace: () => ipcRenderer.invoke(IpcChannel.workspaceClose) as Promise<WorkspaceState>,
  removeRecentWorkspace: (path: string) =>
    ipcRenderer.invoke(IpcChannel.workspaceRemoveRecent, path) as Promise<WorkspaceState>,
  getEnvironment: () => ipcRenderer.invoke(IpcChannel.envGet) as Promise<ExecutionEnvironment | null>,
  listEnvironments: () => ipcRenderer.invoke(IpcChannel.envList) as Promise<ExecutionEnvironment[]>,
  setEnvironment: (kind: SelectableEnvironmentKind) =>
    ipcRenderer.invoke(IpcChannel.envSet, kind) as Promise<ExecutionEnvironment>,
  getGitStatus: () => ipcRenderer.invoke(IpcChannel.gitGetStatus) as Promise<GitStatusSnapshot | null>,
  listBranches: () => ipcRenderer.invoke(IpcChannel.gitListBranches) as Promise<BranchSummary[]>,
  switchBranch: (name: string, options?: { createTracking?: boolean }) =>
    ipcRenderer.invoke(IpcChannel.gitSwitchBranch, name, options ?? null) as Promise<GitStatusSnapshot | null>,
  createBranch: (name: string, startPoint?: string | null) =>
    ipcRenderer.invoke(IpcChannel.gitCreateBranch, name, startPoint ?? null) as Promise<GitStatusSnapshot | null>,
  getFileDiff: (path: string, scope: GitChangeScope, options?: GitDiffOptions) =>
    ipcRenderer.invoke(IpcChannel.gitFileDiff, path, scope, options ?? null) as Promise<string>,
  applyHunks: (input: GitHunkApplyInput) =>
    ipcRenderer.invoke(IpcChannel.gitApplyHunks, input) as Promise<GitStatusSnapshot | null>,
  undoLastCommit: (input: GitUndoCommitInput) =>
    ipcRenderer.invoke(IpcChannel.gitUndoCommit, input) as Promise<GitUndoCommitResult>,
  getBranchDetail: (name: string) =>
    ipcRenderer.invoke(IpcChannel.gitBranchDetail, name) as Promise<GitBranchDetail>,
  renameBranch: (name: string, nextName: string) =>
    ipcRenderer.invoke(IpcChannel.gitRenameBranch, name, nextName) as Promise<GitStatusSnapshot | null>,
  deleteBranch: (input: GitBranchDeleteInput) =>
    ipcRenderer.invoke(IpcChannel.gitDeleteBranch, input) as Promise<GitBranchDeleteResult>,
  compareRefs: (base: string, head: string, options?: GitDiffOptions) =>
    ipcRenderer.invoke(IpcChannel.gitCompareRefs, base, head, options ?? null) as Promise<GitCompareResult>,
  addRemote: (input: GitRemoteInput) =>
    ipcRenderer.invoke(IpcChannel.gitRemoteAdd, input) as Promise<GitRemoteChange>,
  setRemoteUrl: (name: string, url: string, pushUrl?: string | null) =>
    ipcRenderer.invoke(IpcChannel.gitRemoteSetUrl, name, url, pushUrl ?? null) as Promise<GitRemoteChange>,
  removeRemote: (name: string) =>
    ipcRenderer.invoke(IpcChannel.gitRemoteRemove, name) as Promise<GitRemoteChange>,
  renameRemote: (name: string, nextName: string) =>
    ipcRenderer.invoke(IpcChannel.gitRemoteRename, name, nextName) as Promise<GitRemoteChange>,
  setUpstream: (input: GitUpstreamInput) =>
    ipcRenderer.invoke(IpcChannel.gitSetUpstream, input) as Promise<GitStatusSnapshot | null>,
  getConflictFile: (path: string) =>
    ipcRenderer.invoke(IpcChannel.gitConflictFile, path) as Promise<GitConflictFile>,
  resolveConflict: (input: GitConflictResolveInput) =>
    ipcRenderer.invoke(IpcChannel.gitConflictResolve, input) as Promise<GitConflictResolveResult>,
  controlGitOperation: (action: GitOperationControlAction) =>
    ipcRenderer.invoke(IpcChannel.gitOperationControl, action) as Promise<GitOperationControlResult>,
  listStashes: () => ipcRenderer.invoke(IpcChannel.gitStashList) as Promise<GitStashEntry[]>,
  createStash: (input: GitStashCreateInput) =>
    ipcRenderer.invoke(IpcChannel.gitStashCreate, input) as Promise<GitStashCreateResult>,
  applyStash: (input: GitStashApplyInput) =>
    ipcRenderer.invoke(IpcChannel.gitStashApply, input) as Promise<GitStashApplyResult>,
  dropStash: (id: string) =>
    ipcRenderer.invoke(IpcChannel.gitStashDrop, id) as Promise<{ ok: boolean; message: string; stashes: GitStashEntry[] }>,
  getStashDiff: (id: string) =>
    ipcRenderer.invoke(IpcChannel.gitStashDiff, id) as Promise<string>,
  listWorktrees: () => ipcRenderer.invoke(IpcChannel.gitWorktreeList) as Promise<GitWorktreeInfo[]>,
  createWorktree: (input: GitWorktreeCreateInput) =>
    ipcRenderer.invoke(IpcChannel.gitWorktreeCreate, input) as Promise<GitWorktreeCreateResult>,
  removeWorktree: (input: GitWorktreeRemoveInput) =>
    ipcRenderer.invoke(IpcChannel.gitWorktreeRemove, input) as Promise<GitWorktreeRemoveResult>,
  pruneWorktrees: () => ipcRenderer.invoke(IpcChannel.gitWorktreePrune) as Promise<GitWorktreePruneResult>,
  getStagedDiff: () => ipcRenderer.invoke(IpcChannel.gitStagedDiff) as Promise<string>,
  setGitIdentity: (name: string, email: string) =>
    ipcRenderer.invoke(IpcChannel.gitSetIdentity, name, email) as Promise<void>,
  stageFiles: (paths: string[]) => ipcRenderer.invoke(IpcChannel.gitStage, paths) as Promise<GitStatusSnapshot | null>,
  unstageFiles: (paths: string[]) => ipcRenderer.invoke(IpcChannel.gitUnstage, paths) as Promise<GitStatusSnapshot | null>,
  discardFiles: (paths: string[], options?: { untracked?: boolean }) =>
    ipcRenderer.invoke(IpcChannel.gitDiscard, paths, options ?? null) as Promise<GitStatusSnapshot | null>,
  commit: (input: GitCommitInput) => ipcRenderer.invoke(IpcChannel.gitCommit, input) as Promise<GitCommitResult>,
  getGitGuard: () => ipcRenderer.invoke(IpcChannel.gitGuard) as Promise<GitGuardState>,
  fetchRemote: (remote?: string | null) =>
    ipcRenderer.invoke(IpcChannel.gitFetch, remote ?? null) as Promise<GitFetchResult>,
  pullLatest: () => ipcRenderer.invoke(IpcChannel.gitPull) as Promise<GitPullResult>,
  pushBranch: (input: GitPushInput) => ipcRenderer.invoke(IpcChannel.gitPush, input) as Promise<GitSyncResult>,
  commitAndPush: (input: GitCommitInput, target: GitPushInput) =>
    ipcRenderer.invoke(IpcChannel.gitCommitAndPush, input, target) as Promise<{ commit: GitCommitResult; push: GitSyncResult | null }>,
  getCommitGraph: (query: GitGraphQuery) =>
    ipcRenderer.invoke(IpcChannel.gitGraph, query) as Promise<GitGraphSlice>,
  getCommitDetail: (sha: string, parentSha?: string | null, options?: GitDiffOptions) =>
    ipcRenderer.invoke(IpcChannel.gitCommitDetail, sha, parentSha ?? null, options ?? null) as Promise<GitCommitDetail>,
  searchCommits: (query: string, scope: GitGraphScope, limit?: number) =>
    ipcRenderer.invoke(IpcChannel.gitSearchCommits, query, scope, limit ?? 100) as Promise<GitCommitSearchResult>,
  getOperationRecords: (query?: GitOperationQuery) =>
    ipcRenderer.invoke(IpcChannel.gitOperations, query ?? null) as Promise<GitOperationSnapshot>,
  refreshOperation: (id: string) =>
    ipcRenderer.invoke(IpcChannel.gitOperationRefresh, id) as Promise<GitOperationRecord | null>,
  generateTextAssist: (input: AiTextRequest) =>
    ipcRenderer.invoke(IpcChannel.aiText, input) as Promise<AiTextResult>,
  cancelTextAssist: (requestId: string) =>
    ipcRenderer.invoke(IpcChannel.aiTextCancel, requestId) as Promise<void>,
  openFile: (absolutePath: string) => ipcRenderer.invoke(IpcChannel.gitOpenFile, absolutePath) as Promise<void>,
  readWorkspaceFile: (path: string) =>
    ipcRenderer.invoke(IpcChannel.workspaceFileRead, path) as Promise<WorkspaceFileContent>,
  listWorkspaceFiles: () => ipcRenderer.invoke(IpcChannel.workspaceFileList) as Promise<WorkspaceFileList>,
  searchWorkspaceCode: (query: string) =>
    ipcRenderer.invoke(IpcChannel.workspaceSearch, query) as Promise<WorkspaceSearchResult>,
  getPullRequest: () => ipcRenderer.invoke(IpcChannel.prGet) as Promise<PullRequestInfo>,
  getPullRequestDetail: () => ipcRenderer.invoke(IpcChannel.prDetail) as Promise<PullRequestInfo>,
  listPrTemplates: () => ipcRenderer.invoke(IpcChannel.prTemplates) as Promise<PrTemplateInfo[]>,
  getPrScope: (base: string, head?: string | null) =>
    ipcRenderer.invoke(IpcChannel.prScope, base, head ?? null) as Promise<PrCompareScope>,
  createPullRequestNative: (input: PrCreateInput) =>
    ipcRenderer.invoke(IpcChannel.prCreateNative, input) as Promise<PrCreateResult>,
  updatePullRequest: (input: PrUpdateInput) =>
    ipcRenderer.invoke(IpcChannel.prUpdate, input) as Promise<PrUpdateResult>,
  markPullRequestReady: (number: number) =>
    ipcRenderer.invoke(IpcChannel.prReady, number) as Promise<PrUpdateResult>,
  linkPullRequestIssues: (input: PrIssueLinkInput) =>
    ipcRenderer.invoke(IpcChannel.prLinkIssues, input) as Promise<PrUpdateResult>,
  getPullRequestEditOptions: () =>
    ipcRenderer.invoke(IpcChannel.prEditOptions) as Promise<PrEditOptions>,
  getPullRequestReviewThreads: (number?: number | null) =>
    ipcRenderer.invoke(IpcChannel.prReviewThreads, number ?? null) as Promise<PrReviewThreadsResult>,
  commentPullRequest: (input: PrCommentInput) =>
    ipcRenderer.invoke(IpcChannel.prComment, input) as Promise<PrReviewMutationResult>,
  reviewPullRequest: (input: PrReviewInput) =>
    ipcRenderer.invoke(IpcChannel.prReview, input) as Promise<PrReviewMutationResult>,
  resolvePullRequestThread: (input: PrThreadResolveInput) =>
    ipcRenderer.invoke(IpcChannel.prResolveThread, input) as Promise<PrThreadResolveResult>,
  getPullRequestMergePreview: (number?: number | null) =>
    ipcRenderer.invoke(IpcChannel.prMergePreview, number ?? null) as Promise<PrMergePreview>,
  mergePullRequest: (input: PrMergeInput) =>
    ipcRenderer.invoke(IpcChannel.prMerge, input) as Promise<PrMergeResult>,
  closePullRequest: (input: PrCloseInput) =>
    ipcRenderer.invoke(IpcChannel.prClose, input) as Promise<PrCloseResult>,
  createBranchAt: (input: GitBranchAtInput) =>
    ipcRenderer.invoke(IpcChannel.gitCreateBranchAt, input) as Promise<GitBranchAtResult>,
  previewHistoryOp: (input: GitHistoryOpInput) =>
    ipcRenderer.invoke(IpcChannel.gitHistoryOpPreview, input) as Promise<GitHistoryOpPreview>,
  runHistoryOp: (input: GitHistoryOpInput) =>
    ipcRenderer.invoke(IpcChannel.gitHistoryOp, input) as Promise<GitHistoryOpResult>,
  previewRewrite: (input: GitRewritePreviewInput) =>
    ipcRenderer.invoke(IpcChannel.gitRewritePreview, input) as Promise<GitRewritePreview>,
  runRewrite: (input: GitRewriteInput) =>
    ipcRenderer.invoke(IpcChannel.gitRewrite, input) as Promise<GitRewriteResult>,
  getReflog: (query?: GitReflogQuery) =>
    ipcRenderer.invoke(IpcChannel.gitReflog, query ?? null) as Promise<GitReflogSnapshot>,
  previewRecovery: (input: GitRecoveryPreviewInput) =>
    ipcRenderer.invoke(IpcChannel.gitRecoveryPreview, input) as Promise<GitRecoveryPreview>,
  runRecovery: (input: GitRecoveryPreviewInput) =>
    ipcRenderer.invoke(IpcChannel.gitRecovery, input) as Promise<GitRecoveryResult>,
  pullWithStrategy: (input: GitPullInput) =>
    ipcRenderer.invoke(IpcChannel.gitPullWithStrategy, input) as Promise<GitPullResult>,
  previewForcePush: (remote: string, branch: string) =>
    ipcRenderer.invoke(IpcChannel.gitForcePush, remote, branch) as Promise<GitForcePushPreview>,
  forcePushBranch: (input: GitForcePushInput) =>
    ipcRenderer.invoke(IpcChannel.gitForcePush, input) as Promise<GitForcePushResult>,
  listTags: () => ipcRenderer.invoke(IpcChannel.gitTagList) as Promise<GitTagListResult>,
  createTag: (input: GitTagCreateInput) =>
    ipcRenderer.invoke(IpcChannel.gitTagCreate, input) as Promise<GitTagCreateResult>,
  deleteTag: (name: string, remote?: string | null) =>
    ipcRenderer.invoke(IpcChannel.gitTagDelete, name, remote ?? null) as Promise<GitTagCreateResult>,
  listReleases: () => ipcRenderer.invoke(IpcChannel.gitReleaseList) as Promise<GitReleaseListResult>,
  createRelease: (input: GitReleaseCreateInput) =>
    ipcRenderer.invoke(IpcChannel.gitReleaseCreate, input) as Promise<GitReleaseCreateResult>,
  getReleaseNotesScope: (baseTag: string | null, targetTag: string) =>
    ipcRenderer.invoke(IpcChannel.gitReleaseScope, baseTag, targetTag) as Promise<GitReleaseNotesScope>,
  openPullRequest: (url: string) => ipcRenderer.invoke(IpcChannel.prOpen, url) as Promise<void>,
  createPullRequest: () => ipcRenderer.invoke(IpcChannel.prCreate) as Promise<void>,
  getSandboxMode: () => ipcRenderer.invoke(IpcChannel.sandboxGetMode) as Promise<SandboxMode>,
  setSandboxMode: (mode: SandboxMode) =>
    ipcRenderer.invoke(IpcChannel.sandboxSetMode, mode) as Promise<SandboxMode>,
  replyApproval: (id: string, allowed: boolean) =>
    ipcRenderer.invoke(IpcChannel.sandboxApprovalReply, id, allowed) as Promise<void>,
  replyQuestion: (id: string, answer: string | null) =>
    ipcRenderer.invoke(IpcChannel.questionReply, id, answer) as Promise<void>,
  pickAttachments: (kind: AttachmentPickKind) =>
    ipcRenderer.invoke(IpcChannel.appPickAttachments, kind) as Promise<FileAttachmentPayload[]>,
  hydrateAttachments: (paths: string[]) =>
    ipcRenderer.invoke(IpcChannel.appHydrateAttachments, paths) as Promise<FileAttachmentPayload[]>,
  listOpenTargets: () =>
    ipcRenderer.invoke(IpcChannel.appListOpenTargets) as Promise<OpenTarget[]>,
  openInTarget: (targetId: string, path: string) =>
    ipcRenderer.invoke(IpcChannel.appOpenInTarget, targetId, path) as Promise<void>,
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  onEvent: (listener) => {
    const wrapped = (_event: IpcRendererEvent, payload: unknown) => {
      if (!isStreamEvent(payload)) return;
      listener(payload);
    };
    ipcRenderer.on(IpcChannel.event, wrapped);
    return () => {
      ipcRenderer.removeListener(IpcChannel.event, wrapped);
    };
  },
  onModelEvent: (listener) => {
    const wrapped = (_event: IpcRendererEvent, payload: unknown) => {
      if (!isModelEvent(payload)) return;
      listener(payload);
    };
    ipcRenderer.on(IpcChannel.modelEvent, wrapped);
    return () => {
      ipcRenderer.removeListener(IpcChannel.modelEvent, wrapped);
    };
  },
  onWorkspaceEvent: (listener) => {
    const wrapped = (_event: IpcRendererEvent, payload: unknown) => {
      if (!isWorkspaceEvent(payload)) return;
      listener(payload as WorkspaceEvent);
    };
    ipcRenderer.on(IpcChannel.workspaceEvent, wrapped);
    return () => {
      ipcRenderer.removeListener(IpcChannel.workspaceEvent, wrapped);
    };
  },
  onGitEvent: (listener) => {
    const wrapped = (_event: IpcRendererEvent, payload: unknown) => {
      if (!isRecord(payload) || payload.type !== "status-changed") return;
      listener({ type: "status-changed" });
    };
    ipcRenderer.on(IpcChannel.gitEvent, wrapped);
    return () => {
      ipcRenderer.removeListener(IpcChannel.gitEvent, wrapped);
    };
  },
  createTerminal: (options: TerminalCreateOptions) =>
    ipcRenderer.invoke(IpcChannel.terminalCreate, options) as Promise<TerminalSessionInfo>,
  writeTerminal: (id: string, data: string) => {
    ipcRenderer.send(IpcChannel.terminalWrite, id, data);
  },
  resizeTerminal: (id: string, cols: number, rows: number) => {
    ipcRenderer.send(IpcChannel.terminalResize, id, cols, rows);
  },
  closeTerminal: (id: string) => {
    ipcRenderer.send(IpcChannel.terminalClose, id);
  },
  onTerminalEvent: (listener) => {
    const wrapped = (_event: IpcRendererEvent, payload: unknown) => {
      if (!isTerminalEvent(payload)) return;
      listener(payload);
    };
    ipcRenderer.on(IpcChannel.terminalEvent, wrapped);
    return () => {
      ipcRenderer.removeListener(IpcChannel.terminalEvent, wrapped);
    };
  },
  onApprovalEvent: (listener) => {
    const wrapped = (_event: IpcRendererEvent, payload: unknown) => {
      if (!isApprovalEvent(payload)) return;
      listener(payload as SandboxApprovalEvent);
    };
    ipcRenderer.on(IpcChannel.sandboxApprovalEvent, wrapped);
    return () => {
      ipcRenderer.removeListener(IpcChannel.sandboxApprovalEvent, wrapped);
    };
  },
  onQuestionEvent: (listener) => {
    const wrapped = (_event: IpcRendererEvent, payload: unknown) => {
      if (!isQuestionEvent(payload)) return;
      listener(payload as AskUserQuestionEvent);
    };
    ipcRenderer.on(IpcChannel.questionEvent, wrapped);
    return () => {
      ipcRenderer.removeListener(IpcChannel.questionEvent, wrapped);
    };
  },
  onMenuAction: (listener) => {
    const wrapped = (_event: IpcRendererEvent, action: unknown) => {
      if (action !== "new-chat" && action !== "toggle-settings") return;
      listener(action);
    };
    ipcRenderer.on(IpcChannel.appMenuAction, wrapped);
    return () => {
      ipcRenderer.removeListener(IpcChannel.appMenuAction, wrapped);
    };
  },
};

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld("vela", api);
}

// A synchronous acknowledgement ensures a completed save survives an immediate quit.
function storageRequest(channel: string, ...args: unknown[]): { value?: string | null } {
  const result = ipcRenderer.sendSync(channel, ...args) as { value?: string | null; error?: string };
  if (result.error) throw new Error(result.error);
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && "type" in value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isModelEvent(value: unknown): value is ModelAuthEvent {
  if (!isRecord(value)) return false;
  const type = value.type;
  return type === "notice" || type === "prompt" || type === "cleared" || type === "catalog";
}

function isStreamEvent(value: unknown): value is AgentStreamEvent {
  if (!isRecord(value)) return false;
  const type = value.type;
  if (type === "trace") {
    return typeof value.conversationId === "string" && typeof value.version === "number" && Array.isArray(value.nodes) && Array.isArray(value.requests);
  }
  if (type === "user_message") {
    return typeof value.conversationId === "string" && typeof value.text === "string";
  }
  if (type === "agents") {
    return typeof value.conversationId === "string" && Array.isArray(value.agents);
  }
  if (type === "agent_event") {
    return (
      typeof value.conversationId === "string" &&
      typeof value.agentId === "string" &&
      isObject(value.event)
    );
  }
  return (
    type === "state" ||
    type === "text_delta" ||
    type === "thinking_delta" ||
    type === "assistant_start" ||
    type === "tool_start" ||
    type === "tool_output" ||
    type === "tool_end" ||
    type === "error"
  );
}

function isWorkspaceEvent(value: unknown): value is WorkspaceEvent {
  if (!isRecord(value) || value.type !== "changed") return false;
  const workspace = value.workspace;
  return (
    isObject(workspace) &&
    (workspace.current === null || typeof workspace.current === "string") &&
    Array.isArray(workspace.recents)
  );
}

function isApprovalEvent(value: unknown): value is SandboxApprovalEvent {
  if (!isRecord(value)) return false;
  if (value.type === "request") {
    // 注意用 isObject:isRecord 要求对象带 type 字段,而请求对象本身没有。
    const request = value.request;
    return isObject(request) && typeof request.id === "string" && typeof request.kind === "string";
  }
  return value.type === "resolved" && typeof value.id === "string";
}

function isTerminalEvent(value: unknown): value is TerminalEvent {
  if (!isRecord(value) || typeof value.id !== "string") return false;
  if (value.type === "output") return typeof value.data === "string";
  return value.type === "exit" && typeof value.exitCode === "number" && typeof value.signal === "number";
}

function isQuestionEvent(value: unknown): value is AskUserQuestionEvent {
  if (!isRecord(value)) return false;
  if (value.type === "request") {
    // 注意用 isObject:isRecord 要求对象带 type 字段,而问题请求对象本身没有。
    const request = value.request;
    return (
      isObject(request) &&
      typeof request.id === "string" &&
      typeof request.conversationId === "string" &&
      typeof request.toolCallId === "string" &&
      typeof request.question === "string" &&
      Array.isArray(request.options)
    );
  }
  return (
    value.type === "resolved" &&
    typeof value.id === "string" &&
    (value.answer === null || typeof value.answer === "string")
  );
}
