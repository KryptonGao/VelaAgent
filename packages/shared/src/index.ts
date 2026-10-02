export * from "./trace";
import type { TraceSnapshot, TraceDetails, TraceUpdate } from "./trace";
export const conversationTitleMaxLength = 120;

export const IpcChannel = {
  getState: "session:get-state",
  prompt: "session:prompt",
  abort: "session:abort",
  sessionCreate: "session:create",
  sessionSwitch: "session:switch",
  sessionArchive: "session:archive",
  sessionRename: "session:rename",
  sessionUnarchive: "session:unarchive",
  sessionBranch: "session:branch",
  sessionRewind: "session:rewind",
  sessionMessages: "session:messages",
  sessionSummarizeThinking: "session:summarize-thinking",
  sessionTrace: "session:trace",
  sessionTraceDetails: "session:trace-details",
  sessionSetMode: "session:set-mode",
  sessionExecutePlan: "session:execute-plan",
  sessionResumeGoal: "session:resume-goal",
  sessionRemoveInstruction: "session:instruction-remove",
  event: "session:event",
  getCatalog: "models:get-catalog",
  selectModel: "models:select",
  setThinkingLevel: "models:thinking",
  addModel: "models:add",
  removeModel: "models:remove",
  logout: "models:logout",
  login: "models:login",
  replyLogin: "models:login-reply",
  cancelLogin: "models:login-cancel",
  modelEvent: "models:event",
  workspaceOpenDialog: "workspace:open-dialog",
  workspaceGetState: "workspace:get-state",
  workspaceSelect: "workspace:select",
  workspaceClose: "workspace:close",
  workspaceRemoveRecent: "workspace:remove-recent",
  workspaceEvent: "workspace:event",
  envGet: "env:get",
  envList: "env:list",
  envSet: "env:set",
  gitGetStatus: "git:get-status",
  gitListBranches: "git:list-branches",
  gitSwitchBranch: "git:switch-branch",
  gitCreateBranch: "git:create-branch",
  gitFileDiff: "git:file-diff",
  gitStage: "git:stage",
  gitUnstage: "git:unstage",
  gitDiscard: "git:discard",
  gitOpenFile: "git:open-file",
  gitEvent: "git:event",
  prGet: "pr:get",
  prOpen: "pr:open",
  prCreate: "pr:create",
  prDetail: "pr:detail",
  prTemplates: "pr:templates",
  prScope: "pr:scope",
  prCreateNative: "pr:create-native",
  gitCommit: "git:commit",
  gitStagedDiff: "git:staged-diff",
  gitSetIdentity: "git:set-identity",
  gitFetch: "git:fetch",
  gitPull: "git:pull",
  gitPush: "git:push",
  gitCommitAndPush: "git:commit-and-push",
  gitGraph: "git:graph",
  gitCommitDetail: "git:commit-detail",
  gitSearchCommits: "git:search-commits",
  gitOperations: "git:operations",
  gitOperationRefresh: "git:operation-refresh",
  gitGuard: "git:guard",
  gitApplyHunks: "git:apply-hunks",
  gitUndoCommit: "git:undo-commit",
  gitBranchDetail: "git:branch-detail",
  gitRenameBranch: "git:rename-branch",
  gitDeleteBranch: "git:delete-branch",
  gitCompareRefs: "git:compare-refs",
  gitRemoteAdd: "git:remote-add",
  gitRemoteSetUrl: "git:remote-set-url",
  gitRemoteRemove: "git:remote-remove",
  gitRemoteRename: "git:remote-rename",
  gitSetUpstream: "git:set-upstream",
  gitConflictFile: "git:conflict-file",
  gitConflictResolve: "git:conflict-resolve",
  gitOperationControl: "git:operation-control",
  gitStashList: "git:stash-list",
  gitStashCreate: "git:stash-create",
  gitStashApply: "git:stash-apply",
  gitStashDrop: "git:stash-drop",
  gitStashDiff: "git:stash-diff",
  gitWorktreeList: "git:worktree-list",
  gitWorktreeCreate: "git:worktree-create",
  gitWorktreeRemove: "git:worktree-remove",
  gitWorktreePrune: "git:worktree-prune",
  prUpdate: "pr:update",
  prReady: "pr:ready",
  prLinkIssues: "pr:link-issues",
  prEditOptions: "pr:edit-options",
  gitPullWithStrategy: "git:pull-strategy",
  gitForcePush: "git:force-push",
  gitHistoryOpPreview: "git:history-op-preview",
  gitHistoryOp: "git:history-op",
  gitRewritePreview: "git:rewrite-preview",
  gitRewrite: "git:rewrite",
  gitReflog: "git:reflog",
  gitRecoveryPreview: "git:recovery-preview",
  gitRecovery: "git:recovery",
  gitCreateBranchAt: "git:create-branch-at",
  gitTagList: "git:tag-list",
  gitTagCreate: "git:tag-create",
  gitTagDelete: "git:tag-delete",
  gitReleaseList: "git:release-list",
  gitReleaseCreate: "git:release-create",
  gitReleaseScope: "git:release-scope",
  prReviewThreads: "pr:review-threads",
  prComment: "pr:comment",
  prReview: "pr:review",
  prResolveThread: "pr:resolve-thread",
  prMergePreview: "pr:merge-preview",
  prMerge: "pr:merge",
  prClose: "pr:close",
  aiText: "ai:text",
  aiTextCancel: "ai:text-cancel",
  sandboxGetMode: "sandbox:get-mode",
  sandboxSetMode: "sandbox:set-mode",
  sandboxApprovalEvent: "sandbox:approval-event",
  sandboxApprovalReply: "sandbox:approval-reply",
  questionEvent: "session:question-event",
  questionReply: "session:question-reply",
  sessionAgentMessages: "session:agent-messages",
  appPickAttachments: "app:pick-attachments",
  appHydrateAttachments: "app:hydrate-attachments",
  appListOpenTargets: "app:list-open-targets",
  appOpenInTarget: "app:open-in-target",
  appMenuAction: "app:menu-action",
  appSetLocale: "app:set-locale",
  appUiStorageGet: "app:ui-storage-get",
  appUiStorageSet: "app:ui-storage-set",
  workspaceFileRead: "workspace:file-read",
  workspaceFileList: "workspace:file-list",
  workspaceSearch: "workspace:code-search",
  getAgentSettings: "agent:get-settings",
  saveAgentSettings: "agent:save-settings",
  listSkills: "skills:list",
  openSkillsDir: "skills:open-dir",
  scanExternalSkills: "skills:scan-external",
  migrateSkills: "skills:migrate",
  setSkillEnabled: "skills:set-enabled",
  deleteSkill: "skills:delete",
  registerModel: "models:register",
  terminalCreate: "terminal:create",
  terminalWrite: "terminal:write",
  terminalResize: "terminal:resize",
  terminalClose: "terminal:close",
  terminalEvent: "terminal:event",
} as const;

export const appLocales = ["zh-CN", "en"] as const;
export type AppLocale = (typeof appLocales)[number];

export interface ThinkingSummaryModel {
  provider: string;
  id: string;
}

/** 独立总结一段已完成的思考，不写入聊天上下文。 */
export interface ThinkingSummaryInput {
  conversationId: string;
  text: string;
  locale: AppLocale;
  /** 不指定时使用该对话当前选定的模型。 */
  model?: ThinkingSummaryModel;
}

export const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ThinkingLevel = (typeof thinkingLevels)[number];

export const thinkingLevelLabel: Record<ThinkingLevel, string> = {
  off: "关闭",
  minimal: "最低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最高",
};

export const skillOrigins = ["user", "project", "agents"] as const;

export type SkillOrigin = (typeof skillOrigins)[number];

export interface SkillSummary {
  name: string;
  description: string;
  /** SKILL.md 的绝对路径。 */
  location: string;
  origin: SkillOrigin;
  /** 为真时模型不会自动选用，只能通过 /skill:名称 展开。 */
  disableModelInvocation: boolean;
  /** 为假时不会被加载，模型和 /skill:名称 都无法使用；可在设置里重新启用。 */
  enabled: boolean;
  /** 为真时可以从设置里删除；只有 Vela 用户 Skill 目录内的 Skill 可删。 */
  canDelete: boolean;
}

export interface SkillDiagnostic {
  type: "warning" | "error" | "collision";
  message: string;
  path: string | null;
}

export interface SkillCatalog {
  /** 用户 Skill 目录，即 ~/.vela/skills。 */
  skillsDir: string;
  skills: SkillSummary[];
  diagnostics: SkillDiagnostic[];
}

export const externalSkillSources = ["codex", "claude"] as const;

export type ExternalSkillSource = (typeof externalSkillSources)[number];

export const externalSkillScopes = ["user", "project"] as const;

export type ExternalSkillScope = (typeof externalSkillScopes)[number];

/** new: 尚未进入 Vela。present: 用户目录已有同名副本。loaded: 已从其他 Vela 会读取的位置加载。 */
export const externalSkillStates = ["new", "present", "loaded"] as const;

export type ExternalSkillState = (typeof externalSkillStates)[number];

export interface ExternalSkillCandidate {
  id: string;
  name: string;
  description: string;
  source: ExternalSkillSource;
  scope: ExternalSkillScope;
  /** 迁移后在 ~/.vela/skills 下使用的目录名。 */
  directoryName: string;
  /** SKILL.md 的绝对路径。 */
  location: string;
  state: ExternalSkillState;
  /** 为 false 时文件已经在 Vela 用户目录中，不能再迁移。 */
  selectable: boolean;
}

export interface ExternalSkillSourceScan {
  source: ExternalSkillSource;
  scope: ExternalSkillScope;
  root: string;
  present: boolean;
}

export interface ExternalSkillScan {
  skills: ExternalSkillCandidate[];
  sources: ExternalSkillSourceScan[];
}

export const skillMigrationSkipReasons = ["not-found", "unsafe", "already-local", "duplicate", "failed"] as const;

export type SkillMigrationSkipReason = (typeof skillMigrationSkipReasons)[number];

export interface SkillMigrationEntry {
  id: string;
  name: string;
  destination: string;
}

export interface SkillMigrationSkip {
  id: string;
  name: string;
  reason: SkillMigrationSkipReason;
  message: string | null;
}

export interface SkillMigrationResult {
  copied: SkillMigrationEntry[];
  replaced: SkillMigrationEntry[];
  skipped: SkillMigrationSkip[];
}

/** 新建对话取用设置里的默认模型,还是沿用上一次在对话中使用的模型与思考强度。 */
export type NewConversationSelection = "default" | "lastUsed";

/** 新建对话使用的模型、思考强度和额外指令。不影响已经打开的对话。 */
export interface AgentSettings {
  provider: string | null;
  modelId: string | null;
  thinkingLevel: ThinkingLevel;
  newConversationSelection: NewConversationSelection;
  instructions: string;
}

export const customModelApis = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
] as const;

export type CustomModelApi = (typeof customModelApis)[number];

export type AuthMethodType = "api_key" | "oauth";

export type AuthSource =
  | "stored"
  | "runtime"
  | "environment"
  | "fallback"
  | "models_json_key"
  | "models_json_command";

export interface ModelSummary {
  provider: string;
  providerName: string;
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  available: boolean;
  custom: boolean;
  thinkingLevels: ThinkingLevel[];
}

export interface AuthMethodSummary {
  type: AuthMethodType;
  label: string;
}

export interface ProviderEndpoint {
  baseUrl: string;
  api: string;
}

export interface ProviderSummary {
  id: string;
  name: string;
  authenticated: boolean;
  stored: boolean;
  custom: boolean;
  authSource: AuthSource | null;
  methods: AuthMethodSummary[];
  endpoint: ProviderEndpoint | null;
  modelCount: number;
}

export interface ModelCatalog {
  providers: ProviderSummary[];
  models: ModelSummary[];
  error: string | null;
}

export interface CustomModelInput {
  providerId: string;
  providerName: string;
  baseUrl: string;
  api: CustomModelApi;
  apiKey: string;
  modelId: string;
  modelName: string;
  reasoning: boolean;
  contextWindow: number | null;
  maxTokens: number | null;
}

export interface AuthLink {
  url: string;
  label?: string;
}

export type AuthNotice =
  | { type: "info"; message: string; links?: AuthLink[] }
  | { type: "auth_url"; url: string; instructions?: string }
  | { type: "device_code"; userCode: string; verificationUri: string; expiresInSeconds?: number }
  | { type: "progress"; message: string };

export type AuthPrompt =
  | { type: "text" | "secret" | "manual_code"; message: string; placeholder?: string }
  | { type: "select"; message: string; options: { id: string; label: string; description?: string }[] };

export interface AuthPromptRequest {
  id: string;
  prompt: AuthPrompt;
}

export type ModelAuthEvent =
  | { type: "notice"; notice: AuthNotice }
  | { type: "prompt"; request: AuthPromptRequest }
  | { type: "cleared" }
  /** 后台从 Pi 远程目录拉到了新的模型清单,界面需要重新读取 catalog。 */
  | { type: "catalog" };

export interface LoginResult {
  state: AppState;
  cancelled: boolean;
}

export type SessionStatus = "starting" | "ready" | "streaming" | "error";

export const interactionModes = ["agent", "plan", "goal"] as const;

export type InteractionMode = (typeof interactionModes)[number];

export function isInteractionMode(value: string): value is InteractionMode {
  return (interactionModes as readonly string[]).includes(value);
}

export const proposedPlanStatuses = ["draft", "approved", "superseded"] as const;

export type ProposedPlanStatus = (typeof proposedPlanStatuses)[number];

/**
 * 一份待实施的完整方案。Plan 是稳定的设计规格，不是执行清单；
 * 每次修改都生成新的 revision，旧 revision 保持原样。
 */
export interface ProposedPlanItem {
  id: string;
  /** 完整的 Markdown 实施方案。 */
  markdown: string;
  /** 从 1 开始的修订号；同一对话内单调递增。 */
  revision: number;
  /** 上一版 revision 的 id；首版为 null。 */
  supersedes: string | null;
  status: ProposedPlanStatus;
  /** 规划开始时用户提出的原始目标，供 fresh 执行上下文使用。 */
  objective: string | null;
  createdAt: number;
  approvedAt: number | null;
}

export const executionItemStatuses = ["pending", "in_progress", "completed"] as const;

export type ExecutionItemStatus = (typeof executionItemStatuses)[number];

export interface ExecutionPlanItem {
  id: string;
  text: string;
  status: ExecutionItemStatus;
}

/** 执行进度清单；绑定它所依据的 ProposedPlan revision，执行中可动态调整。 */
export interface ExecutionPlan {
  id: string;
  sourcePlanId: string;
  items: ExecutionPlanItem[];
  updatedAt: number;
}

/** continue 沿用规划上下文；fresh 用原始目标 + 已批准方案开新的执行上下文。 */
export type PlanExecutionContextStrategy = "continue" | "fresh";

export const goalStatuses = ["active", "paused", "complete"] as const;

export type GoalStatus = (typeof goalStatuses)[number];

export const goalValidationCategories = ["diff", "test", "build", "typecheck", "regression", "other"] as const;

export type GoalValidationCategory = (typeof goalValidationCategories)[number];

export type GoalValidationRisk = "low" | "medium" | "high";

export interface GoalValidationCheck {
  toolCallId: string;
  category: GoalValidationCategory;
  command: string;
  result: "passed" | "failed";
  output: string;
  completedAt: number;
  /** Goal 内 bash 调用的递增序号，用于判断检查后是否还有未记录的命令。 */
  sequence: number;
  /** 该命令执行时的工作区修订序号。 */
  workRevision: number;
}

export interface GoalValidationSkipped {
  category: GoalValidationCategory;
  reason: string;
}

export interface GoalValidationKnownIssue {
  toolCallId: string;
  reason: string;
}

export interface GoalValidation {
  risk: GoalValidationRisk;
  status: "passed" | "known_issues" | "skipped";
  workRevision: number;
  checkedAt: number;
  checks: GoalValidationCheck[];
  skipped: GoalValidationSkipped[];
  knownIssues: GoalValidationKnownIssue[];
}

export interface ConversationGoal {
  id: string;
  objective: string;
  status: GoalStatus;
  /** 进展，或暂停原因。没有时为空。 */
  note: string | null;
  /** 检测到潜在工作区修改时递增，用来识别验证是否已过期。 */
  workRevision: number;
  validation: GoalValidation | null;
  updatedAt: number;
}

/**
 * 运行中追加指令的投递方式:
 * - queue 排队发送:当前任务自然结束、且没有待处理阻塞时执行;
 * - steer 调整当前任务:在最早可达的执行边界注入,优先于下一步工作。
 */
export type RuntimeInstructionMode = "queue" | "steer";

export function isRuntimeInstructionMode(value: unknown): value is RuntimeInstructionMode {
  return value === "queue" || value === "steer";
}

/** 已提交、尚未被模型消费的运行中指令(排队或调整)。 */
export interface RuntimeInstruction {
  id: string;
  mode: RuntimeInstructionMode;
  text: string;
  createdAt: number;
}

export interface SessionSnapshot {
  id: string | null;
  title: string;
  status: SessionStatus;
  cwd: string;
  model: string | null;
  modelProvider: string | null;
  modelId: string | null;
  modelReady: boolean;
  thinkingLevel: ThinkingLevel;
  thinkingLevels: ThinkingLevel[];
  tools: string[];
  mode: InteractionMode;
  /** 最新的 ProposedPlan revision；没有提交过计划时为 null。 */
  proposedPlan: ProposedPlanItem | null;
  /** 全部 revision，按提交顺序排列，供历史查看。 */
  planRevisions: ProposedPlanItem[];
  /** 当前激活的执行计划；执行中才会创建。 */
  executionPlan: ExecutionPlan | null;
  goal: ConversationGoal | null;
  error: string | null;
  /** 用户已提交、等待执行的运行中指令;投递或撤销后从这里移除。 */
  pendingInstructions: RuntimeInstruction[];
  turnStartedAt?: number;
  turnCompletedAt?: number;
}

/** 侧边栏会话列表里的一条对话,绑定创建时的工作区目录。 */
export interface ConversationSummary {
  id: string;
  title: string;
  status: SessionStatus;
  /** 0 表示尚未发送消息，不加入侧边栏；旧数据缺省时仍显示。 */
  messageCount?: number;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  /** 非空表示已归档(不显示在侧边栏),值为归档时间。 */
  archivedAt: number | null;
  turnStartedAt?: number;
  turnCompletedAt?: number;
}

/** 上下文占用的分段，顺序与右侧栏色条一致。 */
export const contextCategories = ["system", "tools", "rules", "skills", "conversation"] as const;

export type ContextCategory = (typeof contextCategories)[number];

export type ContextSegments = Record<ContextCategory, number>;

export interface ContextUsage {
  messageCount: number;
  toolCallCount: number;
  /** 用户消息数，即对话轮数。 */
  turnCount: number;
  /** agent 循环里已经生成的 assistant 消息数，即步数。 */
  stepCount: number;
  /** 当前占用的 token 估计。模型回报过用量时，分段会按这个总量对齐。 */
  tokens: number;
  /** 当前模型的上下文窗口。还没选模型时为空。 */
  contextWindow: number | null;
  /** 占窗口的百分比，0–100 以上都可能。窗口未知时为空。 */
  percent: number | null;
  segments: ContextSegments;
  /** 本次会话累计计费的 token（输入 + 输出 + 缓存读写）。还没产生用量时为空。 */
  sessionTokens: number | null;
  /** 提示词缓存命中率 0–1；提供方既不上报缓存读取也不上报写入时为空。 */
  cacheHitRate: number | null;
  /** 本次运行累计的输出速度（tokens/秒，不含首字等待）；还没测到用量或耗时时为空。 */
  outputSpeed: number | null;
}

export interface AppState {
  session: SessionSnapshot;
  context: ContextUsage;
  conversations: ConversationSummary[];
  activeConversationId: string | null;
  /** 当前对话的 agent 树，供重启或渲染层重载后回填。 */
  agents?: AgentInfo[];
}

export const subagentKinds = ["explore", "general"] as const;

export type SubagentKind = (typeof subagentKinds)[number];

/** agent 树 API 的工具名；root 与子代理共享。 */
export const agentToolNames = ["spawn_agent", "send_message", "followup_task"] as const;

export function isAgentToolName(name: string): boolean {
  return (agentToolNames as readonly string[]).includes(name);
}

export const agentStatuses = ["idle", "running", "completed", "failed", "aborted"] as const;

export type AgentStatus = (typeof agentStatuses)[number];

/** root 是对话主代理；其余是子代理树里的节点。 */
export type AgentKind = SubagentKind | "root";

/** 控制面维护的一个常驻 agent 的快照；子代理是独立会话，完成后仍可继续收消息。 */
export interface AgentInfo {
  /** 旧版未保存独立会话，仅能恢复任务、步骤摘要和结论。 */
  historyIncomplete?: boolean;
  /** agent 标识，也是子代理目标寻址的首选 id。 */
  id: string;
  /** 父 agent 的 id；root 为 null。 */
  parentId: string | null;
  /** 树内路径，如 /root/backend/database。 */
  path: string;
  /** 路径最后一段的展示名。 */
  name: string;
  kind: AgentKind;
  status: AgentStatus;
  /** root 为 0，子代理逐层 +1。 */
  depth: number;
  /** 最近一次任务的目标摘要。 */
  task: string;
  /** 已经跑过的工具步骤；控制面保留最近若干条。 */
  steps: ToolStep[];
  /** 是否可能改动了工作区，供 Git 刷新和 Goal 修订判断。 */
  mutated: boolean;
  /** 最近一次回合的最终结论。 */
  finalText: string | null;
  /** 最近一次失败原因。 */
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ToolStep {
  id: string;
  name: string;
  summary: string;
  status: "running" | "done" | "error";
}

/** update_plan 提交的一条执行项；界面据此渲染图标与引导线。 */
export interface ToolPlanItem {
  text: string;
  status: ExecutionItemStatus;
}

/** 一条工具调用在对话里展示的内容。正文已经截断；steps 只保留最近若干条。 */
export interface ToolActivity {
  /** bash 要执行的命令 */
  command?: string;
  /** read / edit / write 的文件路径 */
  path?: string;
  /** bash 输出、read 的文件正文，或失败原因 */
  body?: string;
  /** edit / write 的展示用 diff。行首是 +、- 或空格，后面跟行号。 */
  diff?: string;
  /** update_plan 的结构化执行清单 */
  plan?: ToolPlanItem[];
  /** task 子代理类型 */
  agent?: SubagentKind;
  /** 常驻子代理的 id 和路径，供界面把卡片关联到 agent 列表。 */
  agentId?: string;
  agentPath?: string;
  /** task 子代理已经跑过的工具步骤 */
  steps?: ToolStep[];
  /** task 是否可能改动了工作区，供 Git 刷新判断 */
  mutated?: boolean;
}

export interface ToolTrace {
  id: string;
  name: string;
  status: "running" | "done" | "error";
  activity: ToolActivity;
}

/** 持久化会话恢复出的历史消息,结构与渲染层 UiMessage 对齐。 */
export interface TranscriptTool {
  id: string;
  name: string;
  status: "done" | "error";
  activity: ToolActivity;
}

export interface TranscriptMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  thinking: string;
  tools: TranscriptTool[];
  /** role 为 user 时随消息发出的图片附件。 */
  images?: ImageAttachment[];
  /** 这条 assistant 消息里 <proposed_plan> 对应的 revision id；用于历史里的 Plan Preview。 */
  planIds?: string[];
  /** 这条消息写入会话文件的时间(毫秒);没有持久化条目时为 null。 */
  timestamp: number | null;
  /** 主进程记录并持久化的整轮处理时间。 */
  turnStartedAt?: number;
  turnCompletedAt?: number;
}

export type AgentStreamEvent =
  | TraceUpdate
  | { type: "state"; state: AppState }
  | { type: "text_delta"; conversationId: string; delta: string }
  | { type: "thinking_delta"; conversationId: string; delta: string }
  /** agent 循环每一步都是一条独立的 assistant 消息;该事件标记一条新消息开始,渲染层据此另起一块。 */
  | { type: "assistant_start"; conversationId: string }
  | { type: "tool_start"; conversationId: string; toolCallId: string; toolName: string; activity: ToolActivity }
  | { type: "tool_output"; conversationId: string; toolCallId: string; activity: ToolActivity }
  | { type: "tool_end"; conversationId: string; toolCallId: string; toolName: string; isError: boolean; activity: ToolActivity }
  /** 常驻 agent 树的完整快照；每次状态、步骤或结论变化时推送。 */
  | { type: "agents"; conversationId: string; agents: AgentInfo[] }
  /** 某个子代理自己的运行流；带 agentId，供右侧 Agent Pane 实时渲染。 */
  | { type: "agent_event"; conversationId: string; agentId: string; event: AgentRuntimeStreamEvent }
  | { type: "user_message"; conversationId: string; text: string }
  /** Plan 模式输出的 <proposed_plan> 块，流式解析成独立事件。 */
  | { type: "proposed_plan_start"; conversationId: string; planId: string; revision: number }
  | { type: "proposed_plan_delta"; conversationId: string; planId: string; delta: string }
  | { type: "proposed_plan_end"; conversationId: string; plan: ProposedPlanItem }
  | { type: "error"; conversationId: string; message: string };

/** 子代理会话的实时事件；形状与主对话一致，只是用 agentId 代替 conversationId。 */
export type AgentRuntimeStreamEvent =
  | { type: "user_message"; text: string }
  | { type: "assistant_start" }
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "tool_start"; toolCallId: string; toolName: string; activity: ToolActivity }
  | { type: "tool_output"; toolCallId: string; activity: ToolActivity }
  | { type: "tool_end"; toolCallId: string; toolName: string; isError: boolean; activity: ToolActivity }
  | { type: "error"; message: string };

// ---------- Workspace ----------

export interface WorkspaceRecent {
  path: string;
  name: string;
  lastUsedAt: number;
}

export interface WorkspaceState {
  current: string | null;
  recents: WorkspaceRecent[];
}

export type ExecutionEnvironmentKind = "local" | "sandbox" | "remote" | "worktree";

/** 当前已实现、可以切换的执行环境(沙箱/远程仍是占位)。 */
export type SelectableEnvironmentKind = "local" | "worktree";

export interface ExecutionEnvironment {
  kind: ExecutionEnvironmentKind;
  label: string;
  path: string;
  available: boolean;
}

export interface WorkspaceEvent {
  type: "changed";
  workspace: WorkspaceState;
  environment: ExecutionEnvironment | null;
}

// ---------- Git ----------

export interface GitRepoInfo {
  /** 仓库根目录,可能与工作区不同(工作区可以是仓库子目录) */
  root: string;
  name: string;
  remoteUrl: string | null;
  /** 工作区相对仓库根的子目录;工作区即仓库根时为 null */
  subdir: string | null;
  /** 仓库是否还没有初始提交 */
  empty: boolean;
}

/** 冲突状态单独表达,便于界面区分文本冲突与其他文件变化。 */
export type GitFileStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked"
  | "conflicted";

/** 改动所在区域:索引(已暂存)或工作区(未暂存)。 */
export type GitChangeScope = "index" | "worktree";

export interface GitFileChange {
  /** 相对仓库根目录的路径 */
  path: string;
  oldPath: string | null;
  /** 综合展示状态,冲突优先 */
  status: GitFileStatus;
  /** 索引区改动状态;没有索引改动时为 null */
  indexStatus: GitFileStatus | null;
  /** 工作区改动状态;没有工作区改动时为 null */
  worktreeStatus: GitFileStatus | null;
  addedLines: number;
  deletedLines: number;
  indexAddedLines: number;
  indexDeletedLines: number;
  worktreeAddedLines: number;
  worktreeDeletedLines: number;
}

export interface GitRemote {
  name: string;
  fetchUrl: string;
  pushUrl: string;
  /** 能识别为 github.com 仓库时的 owner/repo;否则为 null */
  slug: string | null;
}

export interface GitIdentity {
  name: string | null;
  email: string | null;
  /** 姓名和邮箱都能解析到时为真 */
  configured: boolean;
}

/** 进行中的 Git 操作;首期只用于识别并限制普通提交流程。 */
export type GitInProgressOperation = "merge" | "rebase" | "cherry-pick" | "revert";

export interface GitOperationState {
  kind: GitInProgressOperation;
  conflictedPaths: string[];
}

export interface GitStatusSnapshot {
  /** null 表示当前工作区不是 Git 仓库 */
  repo: GitRepoInfo | null;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  detached: boolean;
  files: GitFileChange[];
  addedLines: number;
  deletedLines: number;
  /** 最近一次成功 Fetch 的时间(毫秒);从未成功时为 null */
  lastFetchAt: number | null;
  /** 进行中的 merge/rebase/cherry-pick/revert */
  operation: GitOperationState | null;
  identity: GitIdentity;
  remotes: GitRemote[];
}

export interface BranchSummary {
  name: string;
  current: boolean;
  remote: boolean;
  /** 本地分支的 upstream;远程分支为 null */
  upstream: string | null;
  /** 已被某个 worktree 检出时,该 worktree 的路径 */
  worktreePath: string | null;
  lastCommitSha: string | null;
  lastCommitAt: number | null;
}

export interface GitEvent {
  type: "status-changed";
  /** 状态来源工作区路径;旧事件可能缺失 */
  workspace?: string | null;
}

// ---------- 版本控制:提交与历史 ----------

export type GitRefKind = "head" | "local" | "remote" | "tag";

export interface GitRefLabel {
  name: string;
  kind: GitRefKind;
}

export interface GitCommitSummary {
  sha: string;
  shortSha: string;
  parents: string[];
  subject: string;
  authorName: string;
  authorEmail: string;
  authorAt: number;
  committerName: string;
  committerAt: number;
  refs: GitRefLabel[];
  /** 相对 upstream 是否已推送;没有 upstream 时为 null */
  pushed: boolean | null;
  /** 父提交在本地缺失(浅克隆边界) */
  boundary: boolean;
}

export type GitGraphScope = "current" | "all-local";

export interface GitGraphQuery {
  scope: GitGraphScope;
  limit: number;
  skip: number;
  /** 续页时传入上一页的 snapshotId,保持同一历史快照 */
  snapshotId?: string | null;
}

/** 一次提交图的快照分页;同一 snapshotId 内分页保持拓扑一致。 */
export interface GitGraphSlice {
  snapshotId: string;
  commits: GitCommitSummary[];
  hasMore: boolean;
  /** 页尾仍未加载的父提交,用于延续标记 */
  pendingParents: string[];
  /** 因浅克隆缺失的历史边界 */
  shallowBoundary: string[];
}

export interface GitCommitSearchResult {
  commits: GitCommitSummary[];
  hasMore: boolean;
}

export interface GitCommitFileChange {
  path: string;
  oldPath: string | null;
  status: GitFileStatus;
  addedLines: number;
  deletedLines: number;
}

export interface GitCommitDetail {
  commit: GitCommitSummary;
  body: string;
  files: GitCommitFileChange[];
  diff: string;
  /** 本次 Diff 的相对父提交;根提交为 null */
  parentSha: string | null;
  isRoot: boolean;
  /** 供 Merge 提交切换父提交 */
  parents: string[];
}

// ---------- 版本控制:同步与提交操作 ----------

export interface GitRemoteTarget {
  remote: string;
  branch: string;
}

export interface GitCommitInput {
  title: string;
  body: string;
  /** 为真时先暂存这些路径再提交(「全部暂存并提交」);普通提交为 null */
  stagePaths: string[] | null;
  /** 为真时修正最近一次提交,而不是新建提交(CT-04) */
  amend?: boolean;
}

export interface GitCommitResult {
  ok: boolean;
  sha: string | null;
  shortSha: string | null;
  branch: string | null;
  /** 失败原因或 hook 输出摘要 */
  message: string;
  /** 命令原始输出,供展开查看 */
  output: string;
  /** amend 时被修正的提交 SHA;普通提交为 null */
  amendedSha?: string | null;
  /** amend 时被修正的提交此前是否已推送到 upstream;未知为 null */
  amendedPushed?: boolean | null;
}

/** 撤销最近一次提交时文件变化的保留位置(CT-05)。 */
export type GitUndoCommitMode = "keep-index" | "keep-worktree";

export interface GitUndoCommitInput {
  mode: GitUndoCommitMode;
}

export interface GitUndoCommitResult {
  ok: boolean;
  /** 被撤销的提交 */
  sha: string | null;
  shortSha: string | null;
  subject: string | null;
  mode: GitUndoCommitMode;
  message: string;
}

/** Push 被拒绝时的分类,便于给出具体恢复动作。 */
export type GitPushOutcome =
  | "ok"
  | "up-to-date"
  | "network"
  | "auth"
  | "permission"
  | "protected"
  | "stale"
  | "failed"
  | "unconfirmed";

export interface GitPushInput {
  remote: string;
  branch: string;
  /** 首次发布时建立 upstream */
  setUpstream: boolean;
}

export interface GitSyncResult {
  outcome: GitPushOutcome;
  ok: boolean;
  message: string;
  /** 结果已通过网络/远程引用核对;超时或取消后为 false */
  confirmed: boolean;
  remote: string | null;
  branch: string | null;
}

export interface GitFetchResult {
  ok: boolean;
  remote: string;
  at: number;
  message: string;
}

export type GitPullOutcome =
  | "fast-forward"
  | "up-to-date"
  | "diverged"
  | "dirty"
  | "failed"
  | "merged"
  | "rebased"
  | "conflicted"
  | "in-progress";

export interface GitPullResult {
  outcome: GitPullOutcome;
  ok: boolean;
  message: string;
  /** 实际使用的同步策略;缺省视为 ff-only */
  strategy?: GitPullStrategy;
  /** 出现冲突需要按冲突流程处理 */
  conflicted?: boolean;
  conflictedPaths?: string[];
  /** 命令结束后仍进行中的 Git 操作 */
  operation?: GitOperationState | null;
}

// ---------- 版本控制:代码块暂存与差异显示 (P1) ----------

/** 代码块操作方向:暂存到索引 / 从索引取消暂存 / 丢弃工作区内容。 */
export type GitHunkAction = "stage" | "unstage" | "discard";

export interface GitHunkApplyInput {
  /** 相对仓库根的单个文件路径 */
  path: string;
  action: GitHunkAction;
  /**
   * 由选中代码块组成的单文件补丁(unified diff,含文件头)。
   * 服务端会重新读取该文件的最新 Diff,确认补丁是当前内容的子集后才应用,
   * 内容已变化时拒绝执行并要求刷新。
   */
  patch: string;
}

/** Diff 显示选项:只影响展示与代码块选择,不改变实际提交内容。 */
export interface GitDiffOptions {
  /** 忽略空白差异(展示层使用 git -w 输出) */
  ignoreWhitespace?: boolean;
}

// ---------- 版本控制:远程管理 (P1) ----------

export interface GitRemoteInput {
  name: string;
  url: string;
  /** 仅为 push 单独配置的 URL;为空时与 fetch URL 相同 */
  pushUrl?: string | null;
}

export interface GitRemoteChange {
  ok: boolean;
  message: string;
  remotes: GitRemote[];
}

/** 分支与上游的跟踪关系;清除时 upstream 为 null。 */
export interface GitUpstreamInput {
  branch: string;
  /** 形如 origin/main;null 表示取消跟踪 */
  upstream: string | null;
}

// ---------- 版本控制:分支维护与比较 (P1) ----------

export interface GitBranchDetail {
  name: string;
  current: boolean;
  upstream: string | null;
  /** 已被其他 worktree 检出时的路径 */
  worktreePath: string | null;
  /** 已合入的目标(upstream 或当前 HEAD);未合并为 null */
  mergedInto: string | null;
  /** 相对 upstream 或同名远程分支的未推送提交数;无法判断为 null */
  unpushedCount: number | null;
  /** 同名远程分支(用于分别处理本地/远程删除) */
  remoteBranch: { remote: string; branch: string } | null;
  lastCommitSha: string | null;
  lastCommitAt: number | null;
  /** 只有一个提交且没有父提交(撤销等操作会清空历史) */
  rootCommit: boolean;
  subject: string | null;
}

export interface GitBranchDeleteInput {
  name: string;
  /** 已合并或用户确认后强制删除 */
  force?: boolean;
  /** 同时删除远程同名分支;必须显式指定远程 */
  remote?: string | null;
}

export interface GitBranchDeleteResult {
  ok: boolean;
  message: string;
  deletedLocal: boolean;
  deletedRemote: boolean;
}

export interface GitCompareCommit {
  sha: string;
  shortSha: string;
  subject: string;
  authorName: string;
  authorAt: number;
}

export interface GitCompareFile {
  path: string;
  oldPath: string | null;
  status: GitFileStatus;
  addedLines: number;
  deletedLines: number;
}

/** 任意两个 ref(分支名或提交 SHA)之间的差异;方向固定为 base → head。 */
export interface GitCompareResult {
  base: string;
  head: string;
  baseSha: string | null;
  headSha: string | null;
  mergeBase: string | null;
  commits: GitCompareCommit[];
  files: GitCompareFile[];
  fileCount: number;
  addedLines: number;
  deletedLines: number;
  /** base...head 的完整 Diff,供逐文件查看 */
  diff: string;
  diffTruncated: boolean;
  error: string | null;
}

// ---------- 版本控制:冲突处理 (P1, CF-01) ----------

export interface GitConflictFile {
  path: string;
  /** 共同祖先版本(:1);不存在时为 null */
  base: string | null;
  /** 当前分支版本(:2) */
  ours: string | null;
  /** 合并进来的版本(:3) */
  theirs: string | null;
  /** 工作区当前内容,可能仍带冲突标记 */
  merged: string;
  hasMarkers: boolean;
  binary: boolean;
  /** 编辑结果写入失败等读取状态 */
  error: string | null;
}

export interface GitConflictResolveInput {
  path: string;
  /** 用户确认的合并结果;写入工作区并 git add */
  content: string;
}

export interface GitConflictResolveResult {
  ok: boolean;
  message: string;
  /** 解决后仍未处理的冲突文件数 */
  remaining: number;
}

export type GitOperationControlAction = "continue" | "abort";

export interface GitOperationControlResult {
  ok: boolean;
  action: GitOperationControlAction;
  message: string;
  /** 执行后的真实操作状态:仍进行中(client 需继续处理)或 null(已完成) */
  operation: GitOperationState | null;
  /** 冲突文件数;operation 为 null 时为空数组 */
  conflictedPaths: string[];
}

// ---------- 版本控制:Stash (P1, ST-01) ----------

export interface GitStashEntry {
  /** 形如 stash@{0},可直接作为后续操作的 id */
  id: string;
  index: number;
  message: string;
  /** 创建时所在分支;取不到为 null */
  branch: string | null;
  at: number | null;
  /** 提交对象 SHA,便于定位 */
  sha: string | null;
}

export interface GitStashCreateInput {
  message: string;
  /** 一并保存未跟踪文件 */
  includeUntracked?: boolean;
  /** 只保存指定路径;为空表示全部改动 */
  paths?: string[] | null;
}

export interface GitStashCreateResult {
  ok: boolean;
  message: string;
  stash: GitStashEntry | null;
  /** 没有可保存的改动 */
  empty: boolean;
}

export type GitStashApplyMode = "apply" | "pop";

export interface GitStashApplyInput {
  id: string;
  mode: GitStashApplyMode;
}

export interface GitStashApplyResult {
  ok: boolean;
  message: string;
  /** 应用后出现冲突 */
  conflicted: boolean;
  conflictedPaths: string[];
  /** pop 失败时 stash 条目保留,供用户继续处理 */
  kept: boolean;
}

// ---------- 版本控制:Worktree (P1, WT-01) ----------

export interface GitWorktreeInfo {
  path: string;
  /** 是否为当前工作区所在路径 */
  current: boolean;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  /** git 认为可以清理(目录已缺失) */
  prunable: boolean;
  /** 目录已不存在 */
  missing: boolean;
  /** 位于 Vela 受管 worktree 根目录下 */
  managed: boolean;
  head: string | null;
  shortHead: string | null;
  branch: string | null;
  /** 未提交改动的文件数;目录缺失时为 null */
  changeCount: number | null;
  /** 未跟踪文件数,便于判断清理影响 */
  untrackedCount: number | null;
}

export interface GitWorktreeCreateInput {
  /** 目标分支;newBranch 为真时是待创建的分支名 */
  branch: string;
  /** 为真时基于 startPoint 创建新分支 */
  newBranch: boolean;
  startPoint?: string | null;
  /** 目标路径;为空时由服务端在受管目录下生成 */
  path?: string | null;
}

export interface GitWorktreeCreateResult {
  ok: boolean;
  message: string;
  path: string | null;
  branch: string | null;
}

export interface GitWorktreeRemoveInput {
  path: string;
  /** 目录有未保存内容时必须显式确认;为假时拒绝删除并报告状态 */
  force?: boolean;
}

export interface GitWorktreeRemoveResult {
  ok: boolean;
  message: string;
  /** 因存在未保存内容而未删除 */
  blocked: boolean;
  changeCount: number | null;
}

export interface GitWorktreePruneResult {
  ok: boolean;
  message: string;
  /** 被清理的记录 */
  pruned: string[];
}

// ---------- 版本控制:历史操作 (P2, HI-02–HI-04) ----------

/** 从指定提交创建分支:只新增引用,不移动 HEAD,也不改动工作区。 */
export interface GitBranchAtInput {
  name: string;
  /** 起点提交(必填);不改变当前 HEAD 与未提交内容 */
  startPoint: string;
  /** 创建后是否切换过去;默认 false */
  checkout?: boolean;
}

export interface GitBranchAtResult {
  ok: boolean;
  message: string;
  branch: string;
  startPoint: string;
  startShortSha: string | null;
  /** 创建后是否已切换(未切换时当前分支与未提交内容不变) */
  checkedOut: boolean;
  currentBranch: string | null;
  currentHead: string | null;
  /** 未提交改动是否原样保留 */
  worktreeUntouched: boolean;
  changeCount: number;
}

export type GitHistoryAction = "revert" | "cherry-pick";

export interface GitHistoryOpInput {
  action: GitHistoryAction;
  /** 要撤销或拣选的提交 */
  sha: string;
  /** Revert 合并提交时指定的父提交序号(1 起);非合并提交必须为空 */
  mainline?: number | null;
}

export interface GitHistoryCommitRef {
  sha: string;
  shortSha: string;
  subject: string;
  authorName: string;
  authorAt: number;
}

/** 执行前的范围预览:改哪些文件、落在哪个分支、是否需要处理冲突。 */
export interface GitHistoryOpPreview {
  action: GitHistoryAction;
  commit: GitHistoryCommitRef;
  /** 当前分支(操作目标);detached 时为 null */
  branch: string | null;
  head: string | null;
  isMerge: boolean;
  parents: string[];
  /** revert: 会被回退的文件;cherry-pick: 会被引入的文件 */
  files: GitCommitFileChange[];
  fileCount: number;
  addedLines: number;
  deletedLines: number;
  /** 工作区/索引是否有未提交改动 */
  dirty: boolean;
  /** 该提交是否已经在当前分支上(重复操作提示) */
  alreadyApplied: boolean;
  /** 可执行;为假时 reason 说明原因 */
  ok: boolean;
  reason: string | null;
  error: string | null;
}

export interface GitHistoryOpResult {
  ok: boolean;
  action: GitHistoryAction;
  message: string;
  /** 新产生的撤销/拣选提交 */
  sha: string | null;
  shortSha: string | null;
  /** 需要用户继续处理的冲突 */
  conflicted: boolean;
  conflictedPaths: string[];
  operation: GitOperationState | null;
  output: string;
}

// ---------- 版本控制:提交整理与 Reflog (P2, CT-06/HI-06) ----------

export type GitRewriteAction = "fixup" | "squash";

export interface GitRewriteCommitRef {
  sha: string;
  shortSha: string;
  subject: string;
  authorName: string;
  authorAt: number;
}

export interface GitRewritePreviewInput {
  action: GitRewriteAction;
  /** 被整理的提交(会并入目标提交,自身消失) */
  sourceSha: string;
  /** 保留的目标提交;必须与 source 同分支且早于 source */
  targetSha: string;
  /** squash 的新提交信息;为空表示沿用目标提交信息 */
  message?: string | null;
}

export interface GitRewritePreview {
  action: GitRewriteAction;
  source: GitRewriteCommitRef;
  target: GitRewriteCommitRef;
  branch: string | null;
  head: string | null;
  /** 会被重写的提交(含 source,不含 target 之前的历史) */
  rewritten: GitRewriteCommitRef[];
  rewrittenCount: number;
  /** 其中已经推送到 upstream 的提交数 */
  pushedCount: number;
  /** 有未提交改动时先要求处理 */
  dirty: boolean;
  /** 预览是否可执行;为假时 reason 说明原因 */
  ok: boolean;
  reason: string | null;
  /** 整理后的预期提交数(相对当前) */
  expectedCount: number;
  error: string | null;
}

export interface GitRewriteInput extends GitRewritePreviewInput {}

export interface GitRewriteResult {
  ok: boolean;
  action: GitRewriteAction;
  message: string;
  head: string | null;
  shortHead: string | null;
  rewrittenCount: number;
  /** 历史被重写且含已推送提交:需要另行同步(SY-04),不自动强推 */
  pushedCount: number;
  output: string;
}

/** Reflog 记录(HEAD 引用日志),用于恢复被 reset/重写丢失的提交。 */
export interface GitReflogEntry {
  /** 形如 HEAD@{3},可直接作为恢复目标 */
  id: string;
  index: number;
  sha: string;
  shortSha: string;
  /** commit / reset / rebase (finish) / checkout 等 reflog 动作 */
  action: string;
  message: string;
  at: number | null;
  /** 从当前 HEAD 可达 */
  reachable: boolean;
  /** 是否就是当前 HEAD */
  current: boolean;
  /** 该提交是否被某个分支或 tag 引用 */
  refs: string[];
}

export interface GitReflogQuery {
  limit?: number | null;
  /** 匹配动作、说明、SHA 或引用 */
  text?: string | null;
}

export interface GitReflogSnapshot {
  entries: GitReflogEntry[];
  /** 匹配条件的记录总数 */
  total: number;
  truncated: boolean;
  head: string | null;
  branch: string | null;
  error: string | null;
}

/**
 * 恢复方式:
 * - branch: 从目标提交新建分支(优先方案,不移动现有引用);
 * - reset-soft: 移动当前分支到目标,文件变化保留在索引;
 * - reset-mixed: 移动当前分支到目标,文件变化保留在工作区。
 */
export type GitRecoveryMode = "branch" | "reset-soft" | "reset-mixed";

export interface GitRecoveryPreviewInput {
  /** Reflog 条目 id 或提交 SHA */
  target: string;
  mode: GitRecoveryMode;
  /** mode 为 branch 时的新分支名 */
  branchName?: string | null;
}

export interface GitRecoveryPreview {
  target: GitReflogEntry;
  mode: GitRecoveryMode;
  branchName: string | null;
  head: string | null;
  branch: string | null;
  /** 会被移动/新建的引用 */
  refName: string;
  /** 相对当前 HEAD 会被丢弃的提交(reset 模式) */
  discarded: GitRewriteCommitRef[];
  /** 当前未提交改动文件数 */
  changeCount: number;
  /** 恢复后现有内容的保留位置说明 */
  keepNote: string;
  /** 需要用户明确确认(reset 会移动当前分支) */
  requiresConfirm: boolean;
  /** 可执行;为假时 reason 说明原因 */
  ok: boolean;
  reason: string | null;
  error: string | null;
}

export interface GitRecoveryResult {
  ok: boolean;
  mode: GitRecoveryMode;
  message: string;
  head: string | null;
  shortHead: string | null;
  branch: string | null;
  /** branch 模式新建的分支名 */
  createdBranch: string | null;
  /** reset 后保留在当前索引/工作区的文件数 */
  changeCount: number;
  conflictedPaths: string[];
  output: string;
}

// ---------- 版本控制:同步策略与安全强推 (P2, SY-03/SY-04) ----------

export type GitPullStrategy = "ff-only" | "merge" | "rebase";

export interface GitPullInput {
  /** 显式选择同步策略;缺省仍为 P0 的仅快进 */
  strategy: GitPullStrategy;
}

export interface GitForcePushInput {
  remote: string;
  branch: string;
  /** 预览时核对过的远程引用;实际推送前重新 Fetch,变化即拒绝 */
  expectedRemoteSha: string;
}

export interface GitForcePushCommitRef {
  sha: string;
  shortSha: string;
  subject: string;
  authorName: string;
  authorAt: number;
}

/** 显式安全强推前的核对结果:远程是否变化、覆盖了哪些提交。 */
export interface GitForcePushPreview {
  ok: boolean;
  remote: string;
  branch: string;
  localSha: string | null;
  localShortSha: string | null;
  /** 重新 Fetch 后读到的远程引用 */
  remoteSha: string | null;
  /** 本地领先远程的提交(推送后会出现在远程) */
  ahead: GitForcePushCommitRef[];
  /** 远程领先或分叉、会被覆盖的提交 */
  overwritten: GitForcePushCommitRef[];
  /** 完好的快进推送,不需要强推 */
  fastForward: boolean;
  /** 上次预览后远程引用已变化 */
  stale: boolean;
  upstream: string | null;
  message: string;
  error: string | null;
}

export interface GitForcePushResult {
  ok: boolean;
  outcome: GitPushOutcome;
  message: string;
  remote: string | null;
  branch: string | null;
  remoteSha: string | null;
  /** 远程引用已变化,拒绝覆盖 */
  stale: boolean;
  confirmed: boolean;
}

// ---------- 版本控制:Tag 与 Release (P2, RL-01) ----------

export interface GitTagInfo {
  name: string;
  sha: string;
  shortSha: string;
  /** annotated(带 tag 对象与说明) */
  annotated: boolean;
  taggerName: string | null;
  at: number | null;
  subject: string | null;
  message: string | null;
  /** 目标提交所在的分支名(取不到为 null) */
  targetSubject: string | null;
  /** 已推送到某个远程 */
  pushed: boolean | null;
  remotes: string[];
}

export interface GitTagListResult {
  ok: boolean;
  message: string;
  tags: GitTagInfo[];
  total: number;
  truncated: boolean;
}

export interface GitTagCreateInput {
  name: string;
  /** 目标提交;为空表示 HEAD */
  target?: string | null;
  /** 带说明则创建 annotated tag */
  message?: string | null;
  /** 创建后推送;必须显式指定远程 */
  push?: boolean;
  remote?: string | null;
}

export interface GitTagCreateResult {
  ok: boolean;
  message: string;
  tag: GitTagInfo | null;
  pushed: boolean;
  output: string;
}

export interface GitReleaseInfo {
  tagName: string;
  name: string | null;
  url: string;
  draft: boolean;
  prerelease: boolean;
  isLatest: boolean;
  createdAt: number | null;
  publishedAt: number | null;
  body: string;
  author: string | null;
}

export interface GitReleaseListResult {
  ok: boolean;
  message: string;
  ghAvailable: boolean;
  releases: GitReleaseInfo[];
  /** 本地存在但还没有 Release 的 tag */
  tagsWithoutRelease: string[];
}

export interface GitReleaseCreateInput {
  tagName: string;
  name?: string | null;
  body: string;
  draft: boolean;
  prerelease: boolean;
  /** 目标提交;tag 不存在时用于创建 tag */
  target?: string | null;
}

export interface GitReleaseCreateResult {
  ok: boolean;
  message: string;
  release: GitReleaseInfo | null;
}

export interface GitReleaseTagOption {
  name: string;
  sha: string;
  shortSha: string;
  at: number | null;
  subject: string | null;
  /** 已经存在 Release */
  released: boolean;
}

/** AI-12:按指定版本区间收集的可核对数据。 */
export interface GitReleaseNotesScope {
  /** 上一版本 tag;首个版本为 null */
  baseTag: string | null;
  /** 本次发布目标 tag(或计划创建的 tag 名) */
  targetTag: string;
  baseSha: string | null;
  headSha: string | null;
  commits: GitReleaseCommitRef[];
  commitCount: number;
  pullRequests: GitReleasePullRef[];
  contributors: string[];
  fileCount: number;
  addedLines: number;
  deletedLines: number;
  diff: string;
  diffTruncated: boolean;
  /** 上一版本的 Release 说明,供延续风格 */
  previousNotes: string | null;
  /** 人工填写说明:保留其来源 */
  manualNotes: string | null;
  /** 区间数据读取失败的原因;为空表示数据可用 */
  error: string | null;
}

export interface GitReleaseCommitRef {
  sha: string;
  shortSha: string;
  subject: string;
  authorName: string;
  authorAt: number;
  /** 是否为合并提交(避免把 merge 提交当成条目) */
  merge: boolean;
}

export interface GitReleasePullRef {
  number: number;
  title: string;
  author: string | null;
  url: string;
  mergedAt: number | null;
}

// ---------- 版本控制:操作记录 ----------

export type GitOperationType =
  | "stage"
  | "unstage"
  | "discard"
  | "commit"
  | "push"
  | "commit-push"
  | "fetch"
  | "pull"
  | "pr-create"
  | "amend"
  | "undo-commit"
  | "stash"
  | "worktree"
  | "branch"
  | "remote"
  | "conflict"
  | "pr-update"
  | "revert"
  | "cherry-pick"
  | "history-rewrite"
  | "reflog-recover"
  | "force-push"
  | "tag"
  | "release"
  | "pr-review"
  | "pr-merge";

export type GitOperationStepStatus = "pending" | "running" | "success" | "failed" | "skipped";

export interface GitOperationStep {
  id: string;
  label: string;
  status: GitOperationStepStatus;
  detail: string | null;
}

export type GitOperationStatus = "running" | "success" | "failed" | "partial" | "unconfirmed";

export interface GitOperationRecord {
  id: string;
  type: GitOperationType;
  workspace: string | null;
  repoRoot: string | null;
  branch: string | null;
  expectedHead: string | null;
  status: GitOperationStatus;
  steps: GitOperationStep[];
  startedAt: number;
  completedAt: number | null;
  resultSha: string | null;
  resultUrl: string | null;
  prNumber: number | null;
  error: string | null;
}

export interface GitOperationSnapshot {
  running: GitOperationRecord[];
  recent: GitOperationRecord[];
  /** 当前过滤条件下匹配的记录总数;未启用过滤时与 recent 长度一致 */
  total?: number;
}

/** 操作记录检索条件(OP-04);全部为空时返回该工作区的最近记录。 */
export interface GitOperationQuery {
  /** 匹配类型标签、分支、工作区路径、SHA、PR 编号与错误文本 */
  text?: string | null;
  types?: GitOperationType[] | null;
  statuses?: GitOperationStatus[] | null;
  /** 起始时间(毫秒,含) */
  since?: number | null;
  /** 结束时间(毫秒,含) */
  until?: number | null;
  limit?: number | null;
}

/** 当前工作树是否允许改动文件/索引;Agent 执行期间首期只读。 */
export interface GitGuardState {
  agentRunning: boolean;
  conversationId: string | null;
  reason: string | null;
}

// ---------- 版本控制:AI 文案 ----------

export type AiTextKind = "commit" | "pr" | "release";

export type AiTextAction = "generate" | "polish" | "adjust" | "regenerate";

/** 文案格式偏好;默认 plain。 */
export type AiTextStyle = "plain" | "conventional" | "chinese" | "english";

export interface AiTextSnapshot {
  kind: AiTextKind;
  /** 渲染层生成的快照键,用于识别结果是否已失效 */
  key: string;
  workspace: string | null;
  repoRoot: string | null;
  branch: string | null;
  head: string | null;
  /** PR 目标 base */
  base: string | null;
  /** commit 依据的已暂存文件 */
  stagedPaths: string[];
  /** 「全部暂存并提交」准备模式下的拟暂存文件 */
  plannedPaths: string[];
  diff: string;
  diffTruncated: boolean;
  fileCount: number;
  addedLines: number;
  deletedLines: number;
  commits: { sha: string; subject: string }[];
  recentCommitTitles: string[];
  template: string | null;
  taskGoal: string | null;
  userNote: string | null;
  /** 记录过验证命令及结果;无记录时不能把验证写成已完成 */
  verificationNotes: string | null;
  /** AI-12:发布目标 tag / 版本区间起点 / 关联 PR / 上一版说明 / 人工说明 */
  releaseTag?: string | null;
  baseTag?: string | null;
  pullRequests?: { number: number; title: string; author: string | null; url: string }[];
  previousNotes?: string | null;
  manualNotes?: string | null;
  locale: AppLocale;
  style: AiTextStyle;
}

export interface AiTextRequest {
  requestId: string;
  kind: AiTextKind;
  action: AiTextAction;
  snapshot: AiTextSnapshot;
  title: string;
  body: string;
  instruction: string | null;
}

export interface AiTextResult {
  requestId: string;
  title: string;
  body: string;
  modelLabel: string | null;
  /** 实际使用的输入范围描述,如「依据已暂存的 4 个文件」 */
  scopeLabel: string;
  /** 与请求的 snapshot.key 对应,用于过期判断 */
  snapshotKey: string;
  cancelled: boolean;
}

// ---------- 工作区文件预览 ----------

export type WorkspaceFileContentKind = "text" | "image" | "binary" | "missing" | "too-large";

export interface WorkspaceFileContent {
  /** 相对预览基准根(仓库根 ?? 工作区)、以 / 分隔的规范路径;基准根之外的文件为绝对路径 */
  path: string;
  absolutePath: string;
  kind: WorkspaceFileContentKind;
  /** text 为文件内容;image 为 data URL;其余为 null */
  content: string | null;
  size: number;
  /** 文本超出单次读取上限被截断 */
  truncated: boolean;
}

export interface WorkspaceFileList {
  root: string;
  files: string[];
  truncated: boolean;
}

export interface WorkspaceSearchMatch {
  path: string;
  line: number;
  text: string;
}

export interface WorkspaceSearchResult {
  query: string;
  matches: WorkspaceSearchMatch[];
  truncated: boolean;
}

// ---------- 集成终端 ----------

export interface TerminalCreateOptions {
  /** 渲染层生成,同一 id 在同一个 webContents 内只会有一个 PTY 会话 */
  id: string;
  cols: number;
  rows: number;
}

export interface TerminalSessionInfo {
  id: string;
  /** 实际启动的 shell 可执行文件路径 */
  shell: string;
  /** shell 启动目录 */
  cwd: string;
}

/** 终端输出与退出事件,经 terminal:event 推送到渲染层。 */
export type TerminalEvent =
  | { type: "output"; id: string; data: string }
  | { type: "exit"; id: string; exitCode: number; signal: number };

// ---------- Pull Request ----------

export type PrState = "open" | "draft" | "closed" | "merged";

export type PrChecksSummary = "passing" | "failing" | "pending" | "none";

export interface PrSummary {
  number: number;
  title: string;
  url: string;
  state: PrState;
  isDraft: boolean;
  reviewDecision: string | null;
  approvals: number;
  checks: PrChecksSummary;
  baseRefName: string;
  headRefName: string;
  /** 目标仓库 owner/repo */
  baseRepo: string | null;
  /** 来源仓库 owner/repo;与 baseRepo 不同表示来自 fork */
  headRepo: string | null;
  author: string | null;
  labels: string[];
  /** 当前请求的审阅者(含团队) */
  reviewers: string[];
  assignees: string[];
  /** 描述中以 Closes/Fixes 关联、合并后会自动关闭的 Issue 编号 */
  closingIssues: number[];
  updatedAt: number | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  body: string;
}

/** 检查的单项状态;跳过/取消与失败区分。 */
export type PrCheckState = "passing" | "failing" | "pending" | "skipped" | "cancelled" | "unknown";

export interface PrCheckDetail {
  name: string;
  workflow: string | null;
  state: PrCheckState;
  link: string | null;
  description: string | null;
}

/** PR 查询的互斥状态,避免把认证失败当成「暂无 PR」。 */
export type PrAccessState =
  | "ok"
  | "no-pr"
  | "no-gh"
  | "unauthenticated"
  | "permission"
  | "offline"
  | "failed";

export interface PrRepoRef {
  owner: string;
  name: string;
  host: string;
  baseRepo: string;
}

/** fork 工作流里各远程的实际角色(SY-02):来源仓库、目标仓库与推送远程分别识别。 */
export interface PrForkInfo {
  /** PR 目标(base)远程名 */
  baseRemote: string | null;
  /** 目标仓库 owner/repo */
  baseRepo: string | null;
  /** 推送与 PR 来源(head)远程名 */
  headRemote: string | null;
  /** 来源仓库 owner/repo */
  headRepo: string | null;
  /** 来源与目标仓库不同 */
  isFork: boolean;
  /** 已配置的 GitHub 远程;用于在界面里显式选择仓库 */
  remotes: { remote: string; repo: string | null; url: string }[];
}

export interface PullRequestInfo {
  status: PrAccessState;
  ghAvailable: boolean;
  reason: string | null;
  /** 数据已过期(刷新失败时保留上次结果) */
  stale: boolean;
  checkedAt: number;
  pr: PrSummary | null;
  /** 同分支但已关闭/已合并的 PR,与当前开放 PR 区分 */
  otherBranchPrs: PrSummary[];
  /** 检查明细;pr 为空时为空数组 */
  checks: PrCheckDetail[];
  repo: PrRepoRef | null;
  /** 推导出的默认 base 分支 */
  defaultBase: string | null;
  baseOptions: string[];
  /** 与当前分支对应的推送远程 */
  headRemote: string | null;
  /** fork/多远程上下文;仓库无法识别时为 null */
  fork: PrForkInfo | null;
}

// ---------- Pull Request:编辑与维护 (P1) ----------

export interface PrUpdateInput {
  number: number;
  /** 为 null 时保持原标题 */
  title?: string | null;
  /** 为 null 时保持原描述 */
  body?: string | null;
  addReviewers?: string[];
  removeReviewers?: string[];
  addLabels?: string[];
  removeLabels?: string[];
}

export interface PrUpdateResult {
  ok: boolean;
  message: string;
  pr: PrSummary | null;
  /** 实际提交给 gh 的修改项摘要,供界面核对 */
  changes: string[];
}

export interface PrEditOptions {
  labels: string[];
  /** 可请求审阅的协作者 */
  reviewers: string[];
  assignees: string[];
}

// ---------- Pull Request:评论与审阅线程 (P2, PR-06) ----------

export type PrReviewState =
  | "approved"
  | "changes_requested"
  | "commented"
  | "dismissed"
  | "pending"
  | "unknown";

/** 一条审阅评论;带 path/line 的属于某个代码版本。 */
export interface PrReviewComment {
  id: string;
  author: string | null;
  body: string;
  createdAt: number | null;
  url: string | null;
  /** 代码行评论的文件路径;会话评论为 null */
  path: string | null;
  line: number | null;
  /** 评论所针对的代码版本 */
  commitSha: string | null;
  /** 该行已经不是最新版本,GitHub 标记为 outdated */
  outdated: boolean;
  diffHunk: string | null;
  isReview: boolean;
  state: PrReviewState | null;
  replies: PrReviewComment[];
}

/** 一个审阅线程(含回复),线程可被解决/重新打开。 */
export interface PrReviewThread {
  /** GraphQL node id;解决线程时使用 */
  id: string;
  path: string | null;
  line: number | null;
  commitSha: string | null;
  outdated: boolean;
  resolved: boolean;
  resolvable: boolean;
  resolvedBy: string | null;
  comments: PrReviewComment[];
}

/** 一条审阅结论;过期批准单独标记,不能被当成当前批准。 */
export interface PrReviewSummary {
  author: string | null;
  state: PrReviewState;
  /** GitHub 原始状态文本 */
  rawState: string | null;
  body: string;
  submittedAt: number | null;
  url: string | null;
  /** 审阅时的代码版本 */
  commitSha: string | null;
  /** 之后又有了新提交,该审阅已过期 */
  outdated: boolean;
}

export interface PrReviewThreadsResult {
  ok: boolean;
  message: string;
  threads: PrReviewThread[];
  reviews: PrReviewSummary[];
  reviewDecision: string | null;
  /** 尚未提交结论的审阅请求 */
  pendingReviewers: string[];
  /** 当前 PR head 的代码版本 */
  headSha: string | null;
  /** 上一版 head(用于判断审阅是否过期);无记录为 null */
  previousHeadSha: string | null;
}

export interface PrCommentInput {
  number: number;
  body: string;
}

export type PrReviewEvent = "approve" | "request-changes" | "comment";

export interface PrReviewInput {
  number: number;
  event: PrReviewEvent;
  body?: string | null;
  /** 明确审阅的代码版本;缺省为当前 head */
  commitSha?: string | null;
}

export interface PrReviewMutationResult {
  ok: boolean;
  message: string;
  review: PrReviewSummary | null;
  /** 变更后的线程与审阅结论 */
  threads: PrReviewThread[] | null;
  reviews: PrReviewSummary[] | null;
  reviewDecision: string | null;
}

export interface PrThreadResolveInput {
  /** 线程 node id */
  threadId: string;
  resolved: boolean;
}

export interface PrThreadResolveResult {
  ok: boolean;
  message: string;
  threadId: string;
  resolved: boolean;
}

// ---------- Pull Request:合并与关闭 (P2, PR-07) ----------

export type PrMergeMethod = "merge" | "squash" | "rebase";

/** 合并前核对:依据 GitHub 当前规则与预期 head,不凭检查全绿判断。 */
export interface PrMergePreview {
  ok: boolean;
  message: string;
  number: number;
  url: string | null;
  state: PrState | null;
  isDraft: boolean;
  baseRefName: string | null;
  headRefName: string | null;
  /** GitHub 当前 head 的提交版本 */
  headSha: string | null;
  /** 本地记录的预期 head;为 null 表示尚未记录 */
  expectedHeadSha: string | null;
  /** head 与预期一致 */
  headMatches: boolean;
  mergeable: "mergeable" | "conflicting" | "unknown";
  mergeStateStatus: string | null;
  /** 仓库允许的合并方式 */
  allowedMethods: PrMergeMethod[];
  defaultMethod: PrMergeMethod | null;
  reviewDecision: string | null;
  approvals: number;
  /** 最近一次审阅结论;含已过期标记 */
  reviews: PrReviewSummary[];
  checks: PrChecksSummary;
  /** 阻止合并的条件说明(逐条列出) */
  blockers: string[];
  canMerge: boolean;
  /** 规则校验说明:检查全绿不等于可合并 */
  rulesNote: string | null;
}

export interface PrMergeInput {
  number: number;
  method: PrMergeMethod;
  /** 预览时核对过的 head;与 GitHub 当前 head 不一致时拒绝合并 */
  expectedHeadSha: string;
  /** gh 的 --delete-branch 会同时删除本地与远程分支;界面需明确说明 */
  deleteBranch?: boolean;
  subject?: string | null;
  body?: string | null;
}

export interface PrMergeResult {
  ok: boolean;
  message: string;
  merged: boolean;
  /** 因 head 或规则变化而未合并 */
  blocked: boolean;
  pr: PrSummary | null;
}

export interface PrCloseInput {
  number: number;
  /** 关闭前写入的说明 */
  comment?: string | null;
  /** gh 的 --delete-branch 会同时删除本地与远程分支 */
  deleteBranch?: boolean;
}

export interface PrCloseResult {
  ok: boolean;
  message: string;
  pr: PrSummary | null;
}

export type PrIssueLinkMode = "reference" | "close";

export interface PrIssueLinkInput {
  number: number;
  issues: number[];
  /** reference 只建立关联;close 会在合并后自动关闭 Issue */
  mode: PrIssueLinkMode;
}

// ---------- Pull Request:创建与范围 ----------

export interface PrTemplateInfo {
  path: string;
  name: string;
  body: string;
}

export interface PrScopeCommit {
  sha: string;
  subject: string;
  authorName: string;
}

export interface PrCompareScope {
  base: string;
  head: string;
  baseRepo: string | null;
  headRepo: string | null;
  commits: PrScopeCommit[];
  fileCount: number;
  addedLines: number;
  deletedLines: number;
  /** head 是否已推送到远程 */
  headPushed: boolean;
  /** 尚未推送的提交数 */
  unpushedCount: number;
  pushTarget: GitRemoteTarget | null;
  /** 没有可比较的变更 */
  empty: boolean;
  /** base...head 的完整 Diff,供 AI 文案使用 */
  diff: string;
  diffTruncated: boolean;
  error: string | null;
}

export interface PrCreateInput {
  baseRepo: string;
  base: string;
  headRepo: string;
  head: string;
  title: string;
  body: string;
  draft: boolean;
  /** 为真时先推送 head 再创建 */
  pushFirst: boolean;
  /** 使用的模板路径,仅用于记录 */
  templatePath: string | null;
}

export type PrCreateStep = "push" | "create";

export interface PrCreateResult {
  ok: boolean;
  /** 失败时停留的步骤,便于只重试该步骤 */
  step: PrCreateStep;
  pushed: boolean;
  pr: PrSummary | null;
  url: string | null;
  number: number | null;
  message: string;
  /** 超时或结果不明,需要查询确认而不是重试 */
  unconfirmed: boolean;
}

// ---------- Sandbox 权限 ----------

/**
 * ask:逐条审批;smart:由当前对话模型判断风险,仅风险操作审批;full:直接放行。
 */
export type SandboxMode = "ask" | "smart" | "full";

export type SandboxApprovalKind = "bash" | "edit" | "write" | "mkdir";

/** 交给模型判断的一次操作。workspace 为工作区边界,insideWorkspace 表明是否越界。 */
export interface SandboxRiskInput {
  kind: SandboxApprovalKind;
  command: string | null;
  path: string | null;
  cwd: string | null;
  workspace: string | null;
  insideWorkspace: boolean;
}

/** unknown 表示模型不可用、超时或输出无法识别,调用方应按风险操作处理。 */
export type SandboxRiskVerdict = "safe" | "risky" | "unknown";

export type SandboxRiskEvaluator = (input: SandboxRiskInput) => Promise<SandboxRiskVerdict>;

export interface SandboxApprovalRequest {
  id: string;
  kind: SandboxApprovalKind;
  command: string | null;
  path: string | null;
  cwd: string | null;
  createdAt: number;
}

export type SandboxApprovalEvent =
  | { type: "request"; request: SandboxApprovalRequest }
  | { type: "resolved"; id: string; allowed: boolean };

// ---------- AskUserQuestion 提问 ----------

export interface QuestionOption {
  label: string;
  description?: string;
}

/** agent 向用户提出的一个待回答问题,答复前工具调用保持挂起。 */
export interface AskUserQuestionRequest {
  id: string;
  conversationId: string;
  /** 发起提问的工具调用 id,界面用它把问题卡片定位到消息流里的对应工具。 */
  toolCallId: string;
  question: string;
  options: QuestionOption[];
  /** 为 true 时界面提供自由输入回答。 */
  allowFreeText: boolean;
  createdAt: number;
}

/** answer 为 null 表示用户跳过或会话中断。 */
export type AskUserQuestionEvent =
  | { type: "request"; request: AskUserQuestionRequest }
  | { type: "resolved"; id: string; answer: string | null };

// ---------- Prompt 附件 ----------

export interface ImageAttachment {
  type: "image";
  /** base64,不含 data: 前缀 */
  data: string;
  mimeType: string;
}

export interface PromptInput {
  text: string;
  images: ImageAttachment[];
  /** 目标对话;缺省时主进程使用当前激活的对话。 */
  conversationId?: string;
  /** 会话运行中追加时的投递方式;缺省表示开始新一轮用户消息。 */
  deliverAs?: RuntimeInstructionMode;
}

// ---------- 附件 ----------

export type AttachmentPickKind = "file" | "image";

/** 应用菜单里指向渲染层的动作;主进程通过 app:menu-action 转发。 */
export type MenuAction = "new-chat" | "toggle-settings";

export interface FileAttachmentPayload {
  path: string;
  name: string;
  kind: "file" | "image";
  /** kind 为 image 时提供 base64 图片数据 */
  image: ImageAttachment | null;
}

// ---------- 用本机 App 打开工作区 ----------

export const openTargetKinds = ["file-manager", "editor", "terminal"] as const;

export type OpenTargetKind = (typeof openTargetKinds)[number];

/** 主进程检测到的、可用于打开工作区目录的本机 App。 */
export interface OpenTarget {
  id: string;
  name: string;
  kind: OpenTargetKind;
  /** App 图标 data URL;取不到时为 null,界面回退到通用图标。 */
  icon: string | null;
}

export interface VelaApi {
  platform: string;
  /** Present in the desktop app; browser-only previews use localStorage. */
  uiStorage?: {
    getItem(key: string): string | null | undefined;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
  };
  setLocale(locale: AppLocale): void;
  getState(): Promise<AppState>;
  prompt(text: string, images?: ImageAttachment[], conversationId?: string, deliverAs?: RuntimeInstructionMode): Promise<AppState>;
  /** 撤销一条尚未被模型消费的运行中指令。 */
  removeInstruction(instructionId: string, conversationId?: string): Promise<AppState>;
  abort(conversationId?: string): Promise<AppState>;
  setInteractionMode(mode: InteractionMode, conversationId?: string): Promise<AppState>;
  /** 批准当前 Plan revision，并开始执行；strategy 决定复用规划上下文还是开新的执行上下文。 */
  executePlan(conversationId?: string, strategy?: PlanExecutionContextStrategy): Promise<AppState>;
  /** 把暂停中的目标重新设为进行中，并自动续跑。 */
  resumeGoal(conversationId?: string): Promise<AppState>;
  /** 新建一个对话并切换过去;原对话保留在侧边栏列表里。 */
  createConversation(cwd?: string): Promise<AppState>;
  switchConversation(id: string): Promise<AppState>;
  /** 手动名称持久化，并优先于自动标题。 */
  renameConversation(id: string, title: string): Promise<AppState>;
  /** 归档一个对话;侧边栏不再显示,历史保留,可在设置的归档列表里搜索恢复。 */
  archiveConversation(id: string): Promise<AppState>;
  /** 从某一轮回复处分支:复制该轮及之前的历史到新对话并切换过去。 */
  branchConversation(conversationId: string, turnIndex: number): Promise<AppState>;
  rewindConversation(conversationId: string, turnIndex: number): Promise<{ state: AppState; messages: TranscriptMessage[] }>;
  /** 取消归档,对话回到侧边栏。 */
  unarchiveConversation(id: string): Promise<AppState>;
  /** 读取某个对话的完整历史(用于应用重启后恢复界面消息)。 */
  getMessages(conversationId: string): Promise<TranscriptMessage[]>;
  summarizeThinking(input: ThinkingSummaryInput): Promise<string>;
  getTrace(conversationId: string): Promise<TraceSnapshot>;
  getTraceDetails(conversationId: string, nodeId: string): Promise<TraceDetails | null>;
  /** 读取某个常驻子代理自己的消息历史(用于打开右侧 Agent Pane 时回填)。 */
  getAgentMessages(conversationId: string, agentId: string): Promise<TranscriptMessage[]>;
  onEvent(listener: (event: AgentStreamEvent) => void): () => void;
  getCatalog(): Promise<ModelCatalog>;
  selectModel(provider: string, id: string): Promise<AppState>;
  setThinkingLevel(level: ThinkingLevel): Promise<AppState>;
  addModel(input: CustomModelInput): Promise<AppState>;
  /** 测试并登记自定义模型,不切换当前对话,也不改默认模型。 */
  registerModel(input: CustomModelInput): Promise<AppState>;
  removeModel(provider: string, id: string): Promise<AppState>;
  getAgentSettings(): Promise<AgentSettings>;
  saveAgentSettings(settings: AgentSettings): Promise<AgentSettings>;
  listSkills(): Promise<SkillCatalog>;
  openSkillsDirectory(): Promise<void>;
  scanExternalSkills(): Promise<ExternalSkillScan>;
  migrateSkills(ids: string[]): Promise<SkillMigrationResult>;
  /** 启用或停用一个 Skill，返回更新后的目录；已打开的对话会在空闲时重新加载。 */
  setSkillEnabled(name: string, enabled: boolean): Promise<SkillCatalog>;
  /** 删除 Vela 用户 Skill 目录里的一个 Skill，返回更新后的目录。 */
  deleteSkill(name: string, location: string): Promise<SkillCatalog>;
  logout(providerId: string): Promise<AppState>;
  login(providerId: string, type: AuthMethodType): Promise<LoginResult>;
  replyLogin(promptId: string, value: string | null): Promise<void>;
  cancelLogin(): Promise<void>;
  onModelEvent(listener: (event: ModelAuthEvent) => void): () => void;
  openWorkspaceDialog(): Promise<WorkspaceState>;
  getWorkspaceState(): Promise<WorkspaceState>;
  selectWorkspace(path: string): Promise<WorkspaceState>;
  closeWorkspace(): Promise<WorkspaceState>;
  removeRecentWorkspace(path: string): Promise<WorkspaceState>;
  getEnvironment(): Promise<ExecutionEnvironment | null>;
  listEnvironments(): Promise<ExecutionEnvironment[]>;
  setEnvironment(kind: SelectableEnvironmentKind): Promise<ExecutionEnvironment>;
  onWorkspaceEvent(listener: (event: WorkspaceEvent) => void): () => void;
  getGitStatus(): Promise<GitStatusSnapshot | null>;
  listBranches(): Promise<BranchSummary[]>;
  switchBranch(name: string, options?: { createTracking?: boolean }): Promise<GitStatusSnapshot | null>;
  createBranch(name: string, startPoint?: string | null): Promise<GitStatusSnapshot | null>;
  getFileDiff(path: string, scope: GitChangeScope, options?: GitDiffOptions): Promise<string>;
  /** 暂存/取消暂存/丢弃单个代码块;补丁需与最新 Diff 一致,否则拒绝并要求刷新。 */
  applyHunks(input: GitHunkApplyInput): Promise<GitStatusSnapshot | null>;
  /** 撤销最近一次未推送的提交;文件变化保留到索引或工作区。 */
  undoLastCommit(input: GitUndoCommitInput): Promise<GitUndoCommitResult>;
  /** 删除分支前的核对信息:合并状态、worktree 占用、未推送提交与远程分支。 */
  getBranchDetail(name: string): Promise<GitBranchDetail>;
  renameBranch(name: string, nextName: string): Promise<GitStatusSnapshot | null>;
  deleteBranch(input: GitBranchDeleteInput): Promise<GitBranchDeleteResult>;
  /** 比较任意两个 ref(分支或提交 SHA),方向为 base → head。 */
  compareRefs(base: string, head: string, options?: GitDiffOptions): Promise<GitCompareResult>;
  addRemote(input: GitRemoteInput): Promise<GitRemoteChange>;
  setRemoteUrl(name: string, url: string, pushUrl?: string | null): Promise<GitRemoteChange>;
  removeRemote(name: string): Promise<GitRemoteChange>;
  renameRemote(name: string, nextName: string): Promise<GitRemoteChange>;
  /** 设置或清除本地分支的上游跟踪关系。 */
  setUpstream(input: GitUpstreamInput): Promise<GitStatusSnapshot | null>;
  /** 读取冲突文件的三方内容(:1/:2/:3)与当前工作区内容。 */
  getConflictFile(path: string): Promise<GitConflictFile>;
  /** 写入解决后的内容并暂存该文件。 */
  resolveConflict(input: GitConflictResolveInput): Promise<GitConflictResolveResult>;
  /** 继续或中止进行中的 merge/rebase/cherry-pick/revert。 */
  controlGitOperation(action: GitOperationControlAction): Promise<GitOperationControlResult>;
  listStashes(): Promise<GitStashEntry[]>;
  /** 保存当前改动到 Stash;失败时不动工作区。 */
  createStash(input: GitStashCreateInput): Promise<GitStashCreateResult>;
  applyStash(input: GitStashApplyInput): Promise<GitStashApplyResult>;
  dropStash(id: string): Promise<{ ok: boolean; message: string; stashes: GitStashEntry[] }>;
  getStashDiff(id: string): Promise<string>;
  listWorktrees(): Promise<GitWorktreeInfo[]>;
  createWorktree(input: GitWorktreeCreateInput): Promise<GitWorktreeCreateResult>;
  removeWorktree(input: GitWorktreeRemoveInput): Promise<GitWorktreeRemoveResult>;
  pruneWorktrees(): Promise<GitWorktreePruneResult>;
  /** 已暂存内容的完整 Diff,供 Commit Message AI 使用。 */
  getStagedDiff(): Promise<string>;
  /** 显式把姓名/邮箱写入仓库级 Git 配置;绝不修改全局配置。 */
  setGitIdentity(name: string, email: string): Promise<void>;
  stageFiles(paths: string[]): Promise<GitStatusSnapshot | null>;
  unstageFiles(paths: string[]): Promise<GitStatusSnapshot | null>;
  discardFiles(paths: string[], options?: { untracked?: boolean }): Promise<GitStatusSnapshot | null>;
  openFile(absolutePath: string): Promise<void>;
  /** 用索引内容创建提交;Hooks 与签名按仓库配置执行。 */
  commit(input: GitCommitInput): Promise<GitCommitResult>;
  /** 校验草稿与当前作者身份,提交前由界面调用。 */
  getGitGuard(): Promise<GitGuardState>;
  fetchRemote(remote?: string | null): Promise<GitFetchResult>;
  pullLatest(): Promise<GitPullResult>;
  pushBranch(input: GitPushInput): Promise<GitSyncResult>;
  commitAndPush(input: GitCommitInput, target: GitPushInput): Promise<{ commit: GitCommitResult; push: GitSyncResult | null }>;
  getCommitGraph(query: GitGraphQuery): Promise<GitGraphSlice>;
  getCommitDetail(sha: string, parentSha?: string | null, options?: GitDiffOptions): Promise<GitCommitDetail>;
  searchCommits(query: string, scope: GitGraphScope, limit?: number): Promise<GitCommitSearchResult>;
  getOperationRecords(query?: GitOperationQuery): Promise<GitOperationSnapshot>;
  refreshOperation(id: string): Promise<GitOperationRecord | null>;
  /** 生成 Commit Message 或 PR 文案;结果是可编辑草稿,不执行任何 Git/GitHub 操作。 */
  generateTextAssist(input: AiTextRequest): Promise<AiTextResult>;
  cancelTextAssist(requestId: string): Promise<void>;
  /** PR 详情与检查明细;与 getPullRequest 相比多返回检查项和 base 候选。 */
  getPullRequestDetail(): Promise<PullRequestInfo>;
  listPrTemplates(): Promise<PrTemplateInfo[]>;
  getPrScope(base: string, head?: string | null): Promise<PrCompareScope>;
  createPullRequestNative(input: PrCreateInput): Promise<PrCreateResult>;
  /** 编辑现有 PR 的标题/描述与 Reviewer/标签;只更新选定 PR。 */
  updatePullRequest(input: PrUpdateInput): Promise<PrUpdateResult>;
  /** Draft 转 Ready for review。 */
  markPullRequestReady(number: number): Promise<PrUpdateResult>;
  /** 按 reference/close 两种语义关联 Issue;close 会在合并后自动关闭。 */
  linkPullRequestIssues(input: PrIssueLinkInput): Promise<PrUpdateResult>;
  /** 读取仓库可用的标签与协作者,供编辑 PR 时选择。 */
  getPullRequestEditOptions(): Promise<PrEditOptions>;
  // ---- P2:审阅协作、合并与关闭 (PR-06/PR-07) ----
  /** 读取 PR 的评论、审阅线程与审阅结论;定位到对应代码版本。 */
  getPullRequestReviewThreads(number?: number | null): Promise<PrReviewThreadsResult>;
  /** 在 PR 会话里发表评论。 */
  commentPullRequest(input: PrCommentInput): Promise<PrReviewMutationResult>;
  /** 提交审阅:批准 / 请求修改 / 仅评论;AI 候选不自动提交。 */
  reviewPullRequest(input: PrReviewInput): Promise<PrReviewMutationResult>;
  /** 解决或重新打开一个审阅线程。 */
  resolvePullRequestThread(input: PrThreadResolveInput): Promise<PrThreadResolveResult>;
  /** 合并前核对规则与预期 head;不凭检查全绿判断可合并。 */
  getPullRequestMergePreview(number?: number | null): Promise<PrMergePreview>;
  /** 按核对过的 head 合并 PR;head 或规则变化时拒绝。 */
  mergePullRequest(input: PrMergeInput): Promise<PrMergeResult>;
  /** 关闭 PR(不删除分支内容)。 */
  closePullRequest(input: PrCloseInput): Promise<PrCloseResult>;
  // ---- P2:历史操作、提交整理与恢复 (HI-02–HI-04/HI-06/CT-06) ----
  /** 从指定历史提交创建分支;不改变当前 HEAD 与未提交内容。 */
  createBranchAt(input: GitBranchAtInput): Promise<GitBranchAtResult>;
  /** Revert / Cherry-pick 前的范围预览。 */
  previewHistoryOp(input: GitHistoryOpInput): Promise<GitHistoryOpPreview>;
  /** 执行 Revert / Cherry-pick;冲突时返回需要处理的文件。 */
  runHistoryOp(input: GitHistoryOpInput): Promise<GitHistoryOpResult>;
  /** Fixup / Squash 前的范围预览与影响说明。 */
  previewRewrite(input: GitRewritePreviewInput): Promise<GitRewritePreview>;
  /** 执行 Fixup / Squash;不自动推送重写后的历史。 */
  runRewrite(input: GitRewriteInput): Promise<GitRewriteResult>;
  /** 读取 HEAD reflog。 */
  getReflog(query?: GitReflogQuery): Promise<GitReflogSnapshot>;
  /** Reflog 恢复前的预览:新分支 / reset 的影响范围。 */
  previewRecovery(input: GitRecoveryPreviewInput): Promise<GitRecoveryPreview>;
  /** 执行 Reflog 恢复;优先使用新分支保留现有内容。 */
  runRecovery(input: GitRecoveryPreviewInput): Promise<GitRecoveryResult>;
  // ---- P2:高级同步与安全强推 (SY-03/SY-04) ----
  /** 显式选择同步策略 Pull;冲突进入处理流程。 */
  pullWithStrategy(input: GitPullInput): Promise<GitPullResult>;
  /** 强推前核对远程引用与覆盖范围;远程已变化时返回 stale。 */
  previewForcePush(remote: string, branch: string): Promise<GitForcePushPreview>;
  /** 显式安全强推(--force-with-lease);远程变化时拒绝。 */
  forcePushBranch(input: GitForcePushInput): Promise<GitForcePushResult>;
  // ---- P2:Tag 与 Release (RL-01) ----
  /** 列出标签及其推送状态。 */
  listTags(): Promise<GitTagListResult>;
  /** 创建轻量/附注标签,可选推送到指定远程。 */
  createTag(input: GitTagCreateInput): Promise<GitTagCreateResult>;
  /** 删除标签(本地与远程分开处理)。 */
  deleteTag(name: string, remote?: string | null): Promise<GitTagCreateResult>;
  /** 列出 GitHub Release 与尚无 Release 的本地标签。 */
  listReleases(): Promise<GitReleaseListResult>;
  /** 创建 Release;指向选定提交/版本。 */
  createRelease(input: GitReleaseCreateInput): Promise<GitReleaseCreateResult>;
  /** AI-12:按版本区间收集发布说明依据。 */
  getReleaseNotesScope(baseTag: string | null, targetTag: string): Promise<GitReleaseNotesScope>;
  /** 读取文件用于侧栏预览;支持任意本地文件(相对路径按工作区解析),非法路径会被拒绝。 */
  readWorkspaceFile(path: string): Promise<WorkspaceFileContent>;
  /** 列出工作区内全部未忽略文件(git 仓库走 ls-files),用于目录树与文件名搜索。 */
  listWorkspaceFiles(): Promise<WorkspaceFileList>;
  /** 在工作区内做代码内容搜索(git 仓库走 git grep,否则本地扫描)。 */
  searchWorkspaceCode(query: string): Promise<WorkspaceSearchResult>;
  onGitEvent(listener: (event: GitEvent) => void): () => void;
  /** 在工作区目录启动一个交互式终端；同一 id 已存在时返回既有会话。 */
  createTerminal(options: TerminalCreateOptions): Promise<TerminalSessionInfo>;
  /** 把键盘输入写入终端。 */
  writeTerminal(id: string, data: string): void;
  /** 面板尺寸变化时同步 PTY 窗口大小。 */
  resizeTerminal(id: string, cols: number, rows: number): void;
  /** 关闭终端并结束 shell 进程。 */
  closeTerminal(id: string): void;
  onTerminalEvent(listener: (event: TerminalEvent) => void): () => void;
  getPullRequest(): Promise<PullRequestInfo>;
  openPullRequest(url: string): Promise<void>;
  createPullRequest(): Promise<void>;
  getSandboxMode(): Promise<SandboxMode>;
  setSandboxMode(mode: SandboxMode): Promise<SandboxMode>;
  replyApproval(id: string, allowed: boolean): Promise<void>;
  onApprovalEvent(listener: (event: SandboxApprovalEvent) => void): () => void;
  /** 回答 agent 提出的问题;answer 为 null 表示跳过。 */
  replyQuestion(id: string, answer: string | null): Promise<void>;
  onQuestionEvent(listener: (event: AskUserQuestionEvent) => void): () => void;
  /** 订阅应用菜单动作(新建会话、打开设置等);返回取消订阅函数。 */
  onMenuAction(listener: (action: MenuAction) => void): () => void;
  pickAttachments(kind: AttachmentPickKind): Promise<FileAttachmentPayload[]>;
  hydrateAttachments(paths: string[]): Promise<FileAttachmentPayload[]>;
  /** 列出本机可用于打开工作区的 App;macOS 之外返回空列表。 */
  listOpenTargets(): Promise<OpenTarget[]>;
  /** 用指定目标打开目录;targetId 来自 listOpenTargets。 */
  openInTarget(targetId: string, path: string): Promise<void>;
  /** file 为渲染层的 DOM File 对象(shared 包无 DOM lib,类型放宽为 unknown) */
  pathForFile(file: unknown): string;
}
