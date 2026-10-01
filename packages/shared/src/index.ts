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

/** 独立总结一段已完成的思考，不写入聊天上下文。 */
export interface ThinkingSummaryInput {
  conversationId: string;
  text: string;
  locale: AppLocale;
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
  | { type: "cleared" };

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
  turnStartedAt?: number;
  turnCompletedAt?: number;
}

/** 侧边栏会话列表里的一条对话,绑定创建时的工作区目录。 */
export interface ConversationSummary {
  id: string;
  title: string;
  status: SessionStatus;
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
}

export type GitFileStatus = "modified" | "added" | "deleted" | "renamed" | "untracked";

export interface GitFileChange {
  /** 相对仓库根目录的路径 */
  path: string;
  oldPath: string | null;
  status: GitFileStatus;
  /** 是否已暂存(有未暂存改动的已暂存文件按未暂存处理) */
  staged: boolean;
  addedLines: number;
  deletedLines: number;
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
}

export interface BranchSummary {
  name: string;
  current: boolean;
  remote: boolean;
}

export interface GitEvent {
  type: "status-changed";
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
  reviewDecision: string | null;
  approvals: number;
  checks: PrChecksSummary;
  baseRefName: string;
  headRefName: string;
}

export interface PullRequestInfo {
  ghAvailable: boolean;
  reason: string | null;
  pr: PrSummary | null;
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
  prompt(text: string, images?: ImageAttachment[], conversationId?: string): Promise<AppState>;
  abort(conversationId?: string): Promise<AppState>;
  setInteractionMode(mode: InteractionMode, conversationId?: string): Promise<AppState>;
  /** 批准当前 Plan revision，并开始执行；strategy 决定复用规划上下文还是开新的执行上下文。 */
  executePlan(conversationId?: string, strategy?: PlanExecutionContextStrategy): Promise<AppState>;
  /** 把暂停中的目标重新设为进行中，并自动续跑。 */
  resumeGoal(conversationId?: string): Promise<AppState>;
  /** 新建一个对话并切换过去;原对话保留在侧边栏列表里。 */
  createConversation(): Promise<AppState>;
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
  switchBranch(name: string): Promise<GitStatusSnapshot | null>;
  createBranch(name: string): Promise<GitStatusSnapshot | null>;
  getFileDiff(path: string, staged: boolean): Promise<string>;
  stageFiles(paths: string[]): Promise<GitStatusSnapshot | null>;
  unstageFiles(paths: string[]): Promise<GitStatusSnapshot | null>;
  discardFiles(paths: string[]): Promise<GitStatusSnapshot | null>;
  openFile(absolutePath: string): Promise<void>;
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
