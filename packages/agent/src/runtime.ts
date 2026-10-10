import { McpConfigService } from "./mcp-config";
import { PluginRegistry } from "./mcp/plugin-registry";
import { OAuthMCPManager } from "./mcp/oauth";
import { PluginMCPManager } from "./mcp/manager";
import type { CredentialStore } from "./mcp/credentials";
import type { BuiltInPlugin, PluginCatalog, PluginTarget, PluginStatusEvent, UiPreference } from "@vela/shared";
import { redactMcpDisplay, mcpConfiguredSecrets } from "./mcp-redaction";
import { McpSessionBridge, isMcpTool, type McpPermission } from "./mcp-session";
import { createScheduledTaskTools, scheduledTaskInstructions } from "./scheduled-task-tools";
import { RecipeGenerator, parseRecipeGenerateInput } from './recipe-generator';
import type { RecipeExecution, RecipeRun, RecipeStageSubmission, RecipeSubmitResult, RecipeStageEvidence, RecipeUseDraft, ScheduledTaskInput, SandboxExecutionContext, SandboxMode, ScheduledTaskService } from "@vela/shared";
import type { McpCatalog, McpCatalogInput, McpServerInput, McpServerTarget, McpEnabledInput, McpProjectTrustInput, McpToolReadOnlyInput, McpStatusEvent, MemoryLoadReport } from "@vela/shared";
import { browserUseInstructions, createBrowserTools, type BrowserReplService, type BrowserReplPermission } from "./browser-use";
import { TurnCheckpoints, changedPaths, sharedDirectory, type TurnCheckpoint } from "./turn-checkpoints";
import { checkpointUsage, cleanCheckpoints, defaultCheckpointPolicy } from "./checkpoint-storage";
import type { TraceRecorder } from "./trace";
import { ConversationTraces, subscribeTracedSession } from "./runtime-tracing";
import { SkillLibrary } from "./runtime-skills";
import { ToolLoadout } from "./runtime-tools";
import { RecipeSubmitOutcome, stageResponseEvidence, suspendAutomaticRecovery } from "./recipe-stage";
import type { BranchConversationOptions, CheckpointCleanResult, CheckpointRestorePreview, CheckpointStorageUsage, CheckpointTimeline, TraceSummaryRequest, TraceUpdate } from "@vela/shared";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type ToolDefinition,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  thinkingLevels,
  type AgentInfo,
  type SubagentKind,
  type AgentRuntimeStreamEvent,
  type AgentSettings,
  type AskUserQuestionEvent,
  type AuthMethodType,
  type ConversationGoal,
  type ConversationSummary,
  type CustomModelInput,
  type ExecutionPlan,
  type GoalStatus,
  type GoalValidation,
  type ImageAttachment,
  type InteractionMode,
  type ModelAuthEvent,
  type ModelCatalog,
  type PlanExecutionContextStrategy,
  type ProposedPlanItem,
  type RuntimeInstructionMode,
  type SandboxRiskInput,
  type SandboxRiskVerdict,
  type SessionSnapshot,
  type SessionStatus,
  type ContextUsage,
  type SkillCatalog,
  type SkillMigrationResult,
  type ExternalSkillScan,
  type ThinkingLevel,
  type ThinkingSummaryInput,
  type ToolActivity,
  type TranscriptMessage,
  type AiTextResult,
  type AgentControlAction,
  isAgentBusy,
} from "@vela/shared";
import { defaultToolNames } from "@vela/tools";
import { getCurrentTools, clampThinkingLevel, getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import { existsSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  countConversationActivity,
  emptyContextSegments,
  measureSessionContext,
  measureSessionUsage,
  userMessageText,
} from "./context-usage";
import { clipTitle, normalizeManualConversationTitle, requestConversationTitle } from "./conversation-title";
import { parseAiTextRequest, TextAssistService } from "./text-assist";
import { ConversationStore } from "./conversation-store";
import { legacyAgentTranscript, recoverLegacyAgents, type StoredAgent } from "./agent-history";
import { createPersistedSession } from "./session-persistence";
import { copyTurnTimings, readTurnTimings, turnTimingEntryType } from "./turn-timing";
import {
  createGoalValidation,
  goalCompletionBlocker,
  type GoalValidationDraft,
  type GoalValidationEvidence,
} from "./goal-validation";
import { ModelDirectory } from "./model-directory";
import { MemoryService } from "./memory";
import { MemorySettings } from "./memory-settings";
import { IntelligentUiSettings } from "./intelligent-ui-settings";
import { intelligentUiInstructions } from "./intelligent-ui-prompt";
import { createMemoryContextExtension } from "./memory-context";
import { createMemoryTools, memoryDisabledInstructions, memoryInstructions, memoryReadOnlyInstructions, type MemoryWritePermission } from "./memory-tools";
import { openCodeSessionHeaders } from "./provider-headers";
import {
  createModeExtension,
  createModeTools,
  goalContinuePrompt,
  goalTurnLimit,
  goalTurnLimitNote,
  type AskUserInput,
  type AskUserOutcome,
  type ToolOutcome,
} from "./interaction";
import {
  activeExecutionPlan,
  appendPlanRevision,
  applyExecutionPlanUpdate,
  approvePlanRevision,
  bindExecutionPlan,
  createExecutionPlan,
  createPlanStreamParser,
  isPlanExecutionPrompt,
  latestPlan,
  planContinuePrompt,
  planFreshPrompt,
  type ExecutionPlanUpdateItem,
  type PlanStreamEvent,
  type PlanStreamParser,
} from "./plan";
import { QuestionManager } from "./question-manager";
import { ThinkingSummaryGenerator } from "./thinking-summary";
import {
  buildSandboxRiskMessage,
  parseSandboxRiskVerdict,
  sandboxRiskMaxTokens,
  sandboxRiskSystemPrompt,
  sandboxRiskTimeoutMs,
} from "./sandbox-risk";
import { activityFromCall, activityFromExecution, activityFromOutput, toolResultIsError } from "./tool-activity";
import {
  branchLeafForTurn,
  isVisibleTranscriptMessage,
  countTranscriptActivity,
  transcriptFromMessages,
  transcriptFromProjection,
  transcriptSourcesFromProjection,
} from "./transcript";
import {
  AgentControl,
  type AgentRootMessage,
  type AgentSessionRequest,
} from "./agent-control";
import {
  agentKindPrompt,
  createAgentPauseExtension,
  createExploreGuardExtension,
  spawnAgentToolName,
} from "./subagent";
import { createLogger } from "@vela/shared";

const log = createLogger("runtime");

const recipePromptToken = Symbol("recipe-stage-prompt");

export type RuntimeEvent =
  | TraceUpdate
  | { type: "status"; conversationId: string }
  | { type: "prompt_end"; conversationId: string; status: "responded" | "stopped" | "failed"; error?: string; planPending: boolean }
  | { type: "text_delta"; conversationId: string; delta: string }
  | { type: "thinking_delta"; conversationId: string; delta: string }
  | { type: "assistant_start"; conversationId: string }
  | { type: "tool_start"; conversationId: string; toolCallId: string; toolName: string; activity: ToolActivity }
  | { type: "tool_output"; conversationId: string; toolCallId: string; activity: ToolActivity }
  | { type: "tool_end"; conversationId: string; toolCallId: string; toolName: string; isError: boolean; activity: ToolActivity }
  | { type: "agents"; conversationId: string; agents: AgentInfo[] }
  | { type: "agent_event"; conversationId: string; agentId: string; event: AgentRuntimeStreamEvent }
  | { type: "user_message"; conversationId: string; text: string }
  | { type: "proposed_plan_start"; conversationId: string; planId: string; revision: number }
  | { type: "proposed_plan_delta"; conversationId: string; planId: string; delta: string }
  | { type: "proposed_plan_end"; conversationId: string; plan: ProposedPlanItem }
  | { type: "error"; conversationId: string; message: string };

export interface AgentRuntimeOptions {
  scheduledTasks?: ScheduledTaskService;
  cwd: string;
  /** Vela 自己的模型目录，不读取本机 Pi 配置。 */
  agentDir: string;
  /** Optional desktop host for persistent Browser Panel JavaScript contexts. */
  browserRepl?: BrowserReplService;
  browserReplPermission?: BrowserReplPermission;
  /** 记忆写入的沙箱审批入口；复用现有 ask / smart / full 写权限判断。 */
  memoryPermission?: MemoryWritePermission;
  mcpPermission?: McpPermission;
  mcpOpenUrl?: (url: string) => void;
  pluginCredentialStore?: CredentialStore;
  builtInPlugins?: readonly BuiltInPlugin[];
  /** 按会话 cwd 构造沙箱化的 bash/edit/write 工具,以同名覆盖 Pi 内置实现。 */
  toolFactory?: (cwd: string, context?: SandboxExecutionContext) => ToolDefinition[];
  /** 仅用于迁移旧会话缺失的工作区归属。 */
  isWorkspaceCwd?: (cwd: string) => boolean;
  /** 激活对话的执行目录或工作区归属变化时通知宿主。 */
  onActiveCwd?: (cwd: string, hasWorkspace: boolean) => void;
  onRecipeStop?: (conversationId: string) => void;
}

interface RewindMetadata {
  plans: ProposedPlanItem[];
  latestProposedPlanId: string | null;
  executionPlans: ExecutionPlan[];
  activeExecutionPlanId: string | null;
  goal: ConversationGoal | null;
  agents: StoredAgent[];
  agentLeaves: Record<string, string | null>;
}

interface PendingInstruction {
  id: string;
  mode: RuntimeInstructionMode;
  text: string;
  images?: ImageAttachment[];
  createdAt: number;
  /** Only confirmed Pi queue entries participate in delivery accounting. */
  queued: boolean;
}

interface Conversation {
  hasWorkspace: boolean;
  scheduledSandboxMode?: SandboxMode | null;
  /** 定时任务后台会话：只读记忆，不提供 memory_update。 */
  scheduledTaskConversation?: boolean;
  recipeExecution?: RecipeExecution;
  recipeRunId?: string;
  recipeWorkflowActive?: boolean;
  recipeStageSideEffect?: RecipeStageSubmission["sideEffect"];
  id: string;
  session: AgentSession | null;
  /** 新对话在登记时创建;恢复的对话在激活时通过 sessionFile 打开。 */
  sessionManager: SessionManager | null;
  sessionFile: string | null;
  snapshot: SessionSnapshot;
  /** 首条消息最多请求一次会话当前模型生成标题。 */
  titleGenerationStarted: boolean;
  titleManuallySet: boolean;
  unsubscribe: (() => void) | null;
  createdAt: number;
  updatedAt: number;
  /** 创建时写入,启动会话时附加到系统提示。 */
  instructions: string;
  /** 会话资源对应的 Skill 配置修订号;停用或删除 Skill 后递增,下次发言前重新加载。 */
  skillsRevision: number;
  /** Goal 自动续跑被用户停止后置位,避免当前轮结束后继续。 */
  stopRequested: boolean;
  /** 运行中追加、还没有被 Pi 队列消费的指令;投递或撤销时移除。 */
  pendingInstructions: PendingInstruction[];
  /** 撤销指令时正在重建 Pi 队列,期间忽略 queue_update 的对账。 */
  rebuildingInstructions: boolean;
  /** drive() 进行中。两轮之间 Pi 会话会短暂空闲,不能靠 isStreaming 判断。 */
  driving: boolean;
  /** 全部 ProposedPlan revision;新 revision 不改写旧版本。 */
  plans: ProposedPlanItem[];
  latestProposedPlanId: string | null;
  /** 历次执行计划,activeExecutionPlanId 指向当前激活的一个。 */
  executionPlans: ExecutionPlan[];
  activeExecutionPlanId: string | null;
  /** 当前 assistant 消息的 <proposed_plan> 解析器;message_end 时收尾。 */
  planStream: PlanStreamParser | null;
  /** 已开始但还没结束的 plan 块分配到的 id 和 revision。 */
  planStreamPlan: { id: string; revision: number } | null;
  /** 当前 Goal 中已结束的 bash 工具结果，可供验证记录引用。 */
  goalValidationEvidence: Map<string, GoalValidationEvidence>;
  goalValidationSequence: number;
  /** 输入框统计条用的生成指标：按步累计输出 token 与纯生成耗时（不含首字等待）。 */
  generation: {
    stepStartedAt: number | null;
    firstTokenAt: number | null;
    outputTokens: number;
    elapsedMs: number;
  };
  /** 非空表示已归档:侧边栏隐藏、工作区恢复跳过,可在设置里搜索后取消归档。 */
  archivedAt: number | null;
  activeTurn?: { startedAt: number; leafId: string | null };
  /** 这个对话的 agent 树控制面；会话启动时创建，会话销毁时释放。 */
  control: AgentControl | null;
  storedAgents: StoredAgent[];
  /** 已经触发过 Goal 工作区修订的子代理 id，避免同一次改动重复计数。 */
  agentMutationsSeen: Set<string>;
}

/**
 * 管理多个相互独立的对话:每个对话有自己的 Pi AgentSession(上下文互不影响),
 * 同一时刻只有一个激活对话接收 prompt;后台对话可以继续把流式输出跑完。
 * 对话列表与会话消息分别持久化在 conversations.json 和 Pi 的 JSONL 会话文件中,
 * 应用重启后恢复。
 */
export class AgentRuntime {
  private readonly conversations = new Map<string, Conversation>();
  private activeId: string | null = null;
  private directory: ModelDirectory | null = null;
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();
  private readonly authListeners = new Set<(event: ModelAuthEvent) => void>();
  private readonly questionListeners = new Set<(event: AskUserQuestionEvent) => void>();
  /** toolCallId -> 已校验参数。结果事件本身不带参数，用来还原命令和路径。 */
  private readonly toolArgs = new Map<string, unknown>();
  private readonly traces: ConversationTraces;
  /** toolCallId -> Goal id 与执行时工作区修订号。 */
  private readonly toolGoalContexts = new Map<string, { goalId: string; workRevision: number }>();
  /** toolCallId -> 子代理工具参数；子代理事件不带参数，结果事件用它还原命令和路径。 */
  private readonly agentToolArgs = new Map<string, unknown>();
  private readonly questions = new QuestionManager();
  private readonly thinkingSummaries = new ThinkingSummaryGenerator();
  private readonly textAssist = new TextAssistService();
  private readonly recipeGenerator = new RecipeGenerator();
  private readonly initializePromise: Promise<void>;
  private readonly store: ConversationStore;
  private currentCwd: string;
  private currentHasWorkspace: boolean | undefined;
  private readonly skills: SkillLibrary;
  private readonly tools: ToolLoadout;
  private readonly mcpConfig: McpConfigService;
  private readonly plugins: PluginRegistry;
  private readonly oauthMcp: OAuthMCPManager;
  private readonly pluginManager: PluginMCPManager;
  private readonly mcpBridges = new Map<AgentSession, McpSessionBridge>();
  private readonly mcpManagement = new Map<string, AgentSession>();
  private readonly mcpManagementStarting = new Map<string, Promise<McpSessionBridge>>();
  private readonly mcpRevisions = new Map<AgentSession, number>();
  private readonly sessionStarting = new Map<string, Promise<SessionSnapshot>>();
  private readonly mcpListeners = new Set<(event: McpStatusEvent) => void>();
  private readonly mcpPending = new Set<AgentSession>();
  private readonly mcpReloading = new Map<AgentSession, Promise<void>>();
  private readonly sessionClosings = new Map<AgentSession, Promise<void>>();
  /** 最近一次执行加载的记忆来源状态；根会话用 conversationId，子代理用 conversationId/agentId。 */
  private readonly memoryLoads = new Map<string, MemoryLoadReport[]>();
  private mcpPoll: ReturnType<typeof setInterval> | null = null;
  private mcpPolling = false;
  private checkpointSweep: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private gate: Promise<void> = Promise.resolve();
  private readonly rewindingWorkspaces = new Set<string>();
  private readonly overlappingCheckpointRuns = new Set<string>();
  /** 记忆服务入口：模型工具与桌面管理入口共用同一个实例；第一版是文件存储，不维护数据库副本。 */
  readonly memory: MemoryService;
  private readonly memorySettings: MemorySettings;
  private readonly intelligentUiSettings: IntelligentUiSettings;

  constructor(private readonly options: AgentRuntimeOptions) {
    this.currentCwd = options.cwd;
    this.memory = new MemoryService({ agentDir: options.agentDir });
    this.memorySettings = new MemorySettings(options.agentDir);
    this.intelligentUiSettings = new IntelligentUiSettings(options.agentDir);
    this.skills = new SkillLibrary(options.agentDir);
    this.tools = new ToolLoadout({
      scheduledTasks: Boolean(options.scheduledTasks),
      browser: Boolean(options.browserRepl),
      memoryEnabled: () => this.memorySettings.enabled,
    });
    this.traces = new ConversationTraces({
      agentDir: options.agentDir,
      emit: (event) => this.emit(event),
      history: (conversationId) => {
        const entry = this.conversations.get(conversationId);
        if (entry?.sessionManager) return entry.sessionManager;
        return entry?.sessionFile ? SessionManager.open(entry.sessionFile, this.sessionDir(), entry.snapshot.cwd) : null;
      },
    });
    this.plugins = new PluginRegistry(join(options.agentDir, "integrations.json"), options.builtInPlugins);
    this.oauthMcp = new OAuthMCPManager({ agentDir: options.agentDir, credentialStore: options.pluginCredentialStore,
      isPlugin: name => this.plugins.ownsServer(name), openUrl: options.mcpOpenUrl });
    this.pluginManager = new PluginMCPManager(this.plugins, {
      activate: (id, cwd, signal) => this.activatePlugin(id, cwd, signal),
      deactivate: (id, cwd) => this.deactivatePlugin(id, cwd),
    });
    this.mcpConfig = new McpConfigService({ agentDir: options.agentDir, plugins: this.plugins });
    this.store = new ConversationStore(join(options.agentDir, "conversations.json"));
    // QuestionManager 的事件转发给宿主监听器(SessionHost 由此广播到界面)。
    this.questions.subscribe((event) => {
      for (const listener of this.questionListeners) listener(event);
    });
    this.initializePromise = this.initialize();
    this.mcpPoll = setInterval(() => { void this.pollMcpChanges(); }, 1000);
    this.mcpPoll.unref();
    // Merge duplicate checkpoint blobs and apply the retention policy shortly after startup, away from the first paint.
    this.checkpointSweep = setTimeout(() => { void this.cleanCheckpointStorage().catch(() => undefined); }, 2 * 60 * 1000);
    this.checkpointSweep.unref();
  }

  get activeConversationId(): string | null {
    return this.activeId;
  }

  getSnapshot(): SessionSnapshot {
    const active = this.activeConversation();
    const snapshot = active ? active.snapshot : this.createSnapshot("starting");
    return {
      ...snapshot,
      tools: [...snapshot.tools],
      thinkingLevels: [...snapshot.thinkingLevels],
      proposedPlan: cloneProposedPlan(snapshot.proposedPlan),
      planRevisions: snapshot.planRevisions.map((plan) => ({ ...plan })),
      executionPlan: cloneExecutionPlan(snapshot.executionPlan),
      goal: cloneGoal(snapshot.goal),
      memory: (snapshot.memory ?? []).map((source) => ({ ...source })),
      pendingInstructions: snapshot.pendingInstructions.map((instruction) => ({ ...instruction })),
    };
  }

  listConversations(): ConversationSummary[] {
    return [...this.conversations.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((entry) => ({
        id: entry.id,
        title: entry.snapshot.title,
        status: entry.snapshot.status,
        messageCount: this.store.get(entry.id)?.messageCount ?? 0,
        cwd: entry.snapshot.cwd,
        hasWorkspace: entry.hasWorkspace,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        archivedAt: entry.archivedAt,
        ...(entry.snapshot.turnStartedAt !== undefined ? { turnStartedAt: entry.snapshot.turnStartedAt } : {}),
        ...(entry.snapshot.turnCompletedAt !== undefined ? { turnCompletedAt: entry.snapshot.turnCompletedAt } : {}),
      }));
  }

  /** 在会话操作队列内导入历史，不切换当前会话或重建已有会话。 */
  async importConversations(load: (knownIds: ReadonlySet<string>) => Promise<unknown[]>): Promise<number> {
    return this.exclusive(async () => {
      await this.ready();
      if (this.disposed) throw new Error("应用正在退出，请重新启动后同步");
      this.store.flushSync(true);
      const entries = await load(new Set(this.store.list().map(entry => entry.id)));
      if (this.disposed) throw new Error("应用正在退出，请重新启动后同步");
      const count = this.store.importMissing(entries);
      this.restoreConversations();
      const active = this.activeConversation();
      if (active) this.emitStatus(active);
      return count;
    });
  }

  /** 撤销批量导入：从索引和内存里移除指定对话，不删除磁盘文件（由调用方清理）。运行中或当前激活的对话不能移除。 */
  async removeConversations(ids: readonly string[]): Promise<number> {
    return this.exclusive(async () => {
      await this.ready();
      if (this.disposed) throw new Error("应用正在退出，请重新启动后撤销");
      const entries = ids.flatMap(id => {
        const entry = this.conversations.get(id);
        return entry ? [entry] : [];
      });
      if (entries.some(entry => entry.id === this.activeId)) throw new Error("当前会话属于这批同步，请先切换到其他会话再撤销");
      if (entries.some(entry => entry.driving || entry.session?.isStreaming
        || entry.control?.list().some(agent => agent.kind !== "root" && isAgentBusy(agent.status)))) {
        throw new Error("这批同步的会话仍在运行，请先停止后再撤销");
      }
      await Promise.all(entries.map(entry => this.detachEntry(entry)));
      for (const entry of entries) this.conversations.delete(entry.id);
      const count = this.store.remove(ids);
      const active = this.activeConversation();
      if (active) this.emitStatus(active);
      return count;
    });
  }

  /** 把待写入的会话索引立即落盘；开发版重启 main process 之前使用。 */
  flushPersistence(): void {
    this.store.flushSync();
  }

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  subscribeAuth(listener: (event: ModelAuthEvent) => void): () => void {
    this.authListeners.add(listener);
    return () => {
      this.authListeners.delete(listener);
    };
  }

  /** 订阅 agent 提问事件(请求回答/已了结),宿主转发给界面。 */
  subscribeQuestions(listener: (event: AskUserQuestionEvent) => void): () => void {
    this.questionListeners.add(listener);
    return () => {
      this.questionListeners.delete(listener);
    };
  }

  /** 用户对某个待答问题的回复;answer 为 null 表示跳过。 */
  replyQuestion(id: string, answer: string | null): void {
    this.questions.reply(id, answer);
  }

  /** 新建一个绑定 cwd 的对话并激活它。 */
  async createConversation(cwd: string, options: { hasWorkspace?: boolean } = {}): Promise<SessionSnapshot> {
    return this.exclusive(async () => {
      await this.ready();
      // 新对话可能沿用「上次使用」,所以先把当前对话正在用的选择记下来。
      await this.rememberActiveSelection();
      const entry = this.addEntry(cwd, options);
      return this.startInternal(entry);
    });
  }

  /** Reconcile orphan session headers after a failed index/binding write, without running them. */
  async reconcileRecipeConversations(runs: readonly RecipeRun[]): Promise<void> {
    await this.exclusive(async () => {
      await this.ready();
      for (const run of runs) {
        if (run.conversationBound || this.conversations.has(run.conversationId)) continue;
        let files: string[];
        try { files = readdirSync(this.sessionDir()); } catch { continue; }
        const file = files.find(file => file.endsWith(`_${run.conversationId}.jsonl`));
        if (!file) continue;
        const manager = SessionManager.open(join(this.sessionDir(), file), this.sessionDir(), run.workspace);
        if (manager.getSessionId() !== run.conversationId) continue;
        this.addEntry(run.workspace, { sessionManager: manager, activate: false, reservedId: run.conversationId,
          hasWorkspace: true, mode: run.mode, title: `${run.recipeSnapshot.name} · ${run.resolvedContext.name}`,
          recipeRunId: run.id, recipeExecution: run.resolvedExecution });
      }
    });
  }

  /** Resolve new-chat defaults without mutating active chat or application settings. */
  async resolveRecipeExecution(draft: Pick<RecipeUseDraft, "modelOverride" | "thinkingLevelOverride">, sandboxMode: SandboxMode): Promise<RecipeExecution> {
    const directory = await this.readyDirectory();
    const defaults = this.conversationSelection(directory);
    const model = draft.modelOverride ? directory.requireAvailable(draft.modelOverride.provider, draft.modelOverride.id) : defaults.model;
    if (!model) throw new Error("模型不可用，请选择已配置的模型");
    const thinkingLevel = draft.thinkingLevelOverride ?? defaults.thinkingLevel;
    if (!levelsFor(model).includes(thinkingLevel)) throw new Error("所选模型不支持此思考强度，请重新选择");
    return { model: { provider: model.provider, id: model.id }, thinkingLevel, sandboxMode };
  }

  /** Reserved ID comes from a durable RecipeRun claim. No message is submitted here. */
  async createRecipeConversation(run: RecipeRun): Promise<void> {
    await this.exclusive(async () => {
      await this.ready();
      if (this.conversations.has(run.conversationId)) {
        const existing = this.conversations.get(run.conversationId)!;
        if (existing.recipeRunId !== run.id) throw new Error("预留对话 ID 已被占用");
        return;
      }
      const directory = await this.readyDirectory();
      const model = directory.requireAvailable(run.resolvedExecution.model.provider, run.resolvedExecution.model.id);
      const entry = this.addEntry(run.workspace, { reservedId: run.conversationId, activate: false, hasWorkspace: true,
        title: `${run.recipeSnapshot.name} · ${run.resolvedContext.name}`, mode: run.mode,
        recipeRunId: run.id, recipeExecution: run.resolvedExecution });
      await this.startInternal(entry, { model, thinkingLevel: run.resolvedExecution.thinkingLevel });
      if (!entry.session || entry.snapshot.status === "error") throw new Error(entry.snapshot.error ?? "无法创建配方对话");
      this.store.flushSync(true);
      if (run.trigger !== 'scheduled') {
        this.activeId = entry.id;
        this.notifyActiveCwd(entry.snapshot.cwd, true);
      }
      this.emitStatus(entry);
    });
  }

  async beginRecipeWorkflow(run: RecipeRun): Promise<void> {
    const entry = this.conversations.get(run.conversationId);
    if (!entry || entry.recipeRunId !== run.id) throw new Error("配方对话绑定不可用");
    if (!entry.session) await this.startInternal(entry);
    this.requireIdle(entry.id, true);
    const expected = run.resolvedExecution;
    const model = entry.session?.model;
    if (entry.snapshot.mode !== run.mode || model?.provider !== expected.model.provider || model?.id !== expected.model.id
      || entry.session?.thinkingLevel !== expected.thinkingLevel) throw new Error("聊天的模式或模型已变化，请检查后新建配方任务");
    if (entry.control?.list().some(agent => agent.kind !== "root" && isAgentBusy(agent.status))) throw new Error("聊天仍有运行中的子任务");
    entry.recipeWorkflowActive = true;
  }
  finishRecipeWorkflow(run: RecipeRun): void {
    const entry = this.conversations.get(run.conversationId);
    if (!entry || entry.recipeRunId !== run.id) return;
    entry.recipeWorkflowActive = false;
    entry.recipeStageSideEffect = undefined;
    if (!this.disposed) this.applyActiveTools(entry);
  }

  /** The prompt result and evidence belong only to this invocation, never to later turns. */
  async submitRecipe(run: RecipeRun, stage?: RecipeStageSubmission): Promise<RecipeSubmitResult> {
    const entry = this.conversations.get(run.conversationId);
    if (!entry?.session || entry.recipeRunId !== run.id) throw new Error("配方对话绑定不可用");
    if (stage) {
      const declared = run.recipeSnapshot.stages?.some(s => s.id === stage.id && s.sideEffect === stage.sideEffect);
      if (!entry.recipeWorkflowActive || run.mode !== "agent" || !declared) throw new Error("阶段执行绑定不可用");
      entry.recipeStageSideEffect = stage.sideEffect;
      this.applyActiveTools(entry);
    }
    const restoreRecovery = stage ? suspendAutomaticRecovery(entry.session.settingsManager) : null;
    const outcome = new RecipeSubmitOutcome(entry.id, Boolean(stage));
    const leaf = entry.sessionManager?.getLeafId();
    const unsubscribe = this.subscribe(event => outcome.observe(event));
    try {
      const text = stage?.prompt ?? run.expandedPrompt;
      this.emit({ type: "user_message", conversationId: entry.id, text });
      await this.prompt(entry.id, text, undefined, undefined, recipePromptToken);
      if (this.disposed) throw new Error("应用退出导致任务中断");
      const result = outcome.settle(entry.stopRequested);
      if (!stage) return result;
      const response = stageResponseEvidence(entry.sessionManager?.getBranch() ?? [], leaf);
      const evidence = response ? [...outcome.evidence, response] : outcome.evidence;
      return { ...result, evidence, retrySafe: result.status === "failed" && stage.sideEffect === "read_only" };
    } finally {
      unsubscribe();
      entry.recipeStageSideEffect = undefined;
      restoreRecovery?.();
      if (entry.session && !this.disposed) this.applyActiveTools(entry);
    }
  }

  /** Scheduler entry point: create a persisted background chat without changing the selected workspace. */
  async runScheduledTask(cwd: string, text: string, onCreated: (id: string) => void, execution: Pick<ScheduledTaskInput, "model" | "thinkingLevel" | "sandboxMode"> = {}): Promise<void> {
    const entry = await this.exclusive(async () => {
      await this.ready();
      const entry = this.addEntry(cwd, { activate: false, mode: "agent" });
      entry.scheduledSandboxMode = execution.sandboxMode;
      entry.scheduledTaskConversation = true;
      onCreated(entry.id);
      try {
        const directory = await this.readyDirectory();
        const defaults = this.conversationSelection(directory);
        const model = execution.model ? directory.requireAvailable(execution.model.provider, execution.model.id) : defaults.model;
        const requestedLevel = execution.thinkingLevel ?? defaults.thinkingLevel;
        const thinkingLevel = model ? clampToModel(model, requestedLevel) : requestedLevel;
        await this.startInternal(entry, { model, thinkingLevel });
      } catch (error) {
        this.patchEntry(entry, { status: "error", error: error instanceof Error ? error.message : "无法启动定时任务对话" });
        throw error;
      }
      if (!entry.session || entry.snapshot.status === "error") throw new Error(entry.snapshot.error ?? "无法启动定时任务对话");
      return entry;
    });
    let failure: string | null = null;
    const unsubscribe = this.subscribe(event => { if (event.type === "error" && event.conversationId === entry.id) failure = event.message; });
    try {
      // The renderer is not sending this prompt, so publish it for any viewer already in this chat.
      this.emit({ type: "user_message", conversationId: entry.id, text });
      await this.prompt(entry.id, text);
      if (this.disposed) throw new Error("应用退出导致任务中断");
      if (failure) throw new Error(failure);
      if (entry.stopRequested) throw new Error("任务执行已停止");
    } finally { unsubscribe(); }
  }

  /**
   * 从某一轮回复处分支:把该轮及之前的历史复制成新会话文件并切换过去。
   * turnIndex 是界面上可见用户消息的序号(从 0 数起),与 getMessages 的轮次一致。
   */
  async branchConversation(conversationId: string, turnIndex: number, options: BranchConversationOptions = {}): Promise<SessionSnapshot> {
    return this.exclusive(async () => {
      await this.ready();
      const source = this.conversations.get(conversationId);
      if (!source) throw new Error("对话不存在或已结束");
      if (source.driving || source.session?.isStreaming) throw new Error("回复进行中，不能分支到新聊天");
      const sessionFile = source.sessionFile;
      if (!sessionFile) throw new Error("这个对话还没有可以分支的回复");
      // 分支会改写调用方管理器的会话文件,所以在独立的临时管理器上创建。
      const manager = SessionManager.open(sessionFile, this.sessionDir(), source.snapshot.cwd);
      const sources = transcriptSourcesFromProjection(manager.buildSessionProjection());
      const leaf = branchLeafForTurn(sources, turnIndex);
      if (!leaf) throw new Error("找不到要分支的回复");
      const sourceBranch = manager.getBranch();
      const sourceTimings = readTurnTimings(sourceBranch);
      const sourceCheckpoints = this.checkpoints(source);
      const points = await sourceCheckpoints.list();
      if (options.restoreFiles) {
        // 工作区文件回到这一轮之后：撤销其后各轮的改动；原对话历史保留，但它之后的文件改动不再在工作区里。
        this.assertWorkspaceIdle(source.snapshot.cwd);
        const next = this.visibleUserSources(manager)[turnIndex + 1];
        if (next) {
          const position = sourceBranch.findIndex(item => item.id === next.entryId);
          const later = new Set(sourceBranch.slice(position).map(item => item.id));
          if (!points.some(point => point.userEntryId === next.entryId)) throw new Error("下一轮没有单独的文件检查点，无法把文件恢复到这一轮之后");
          const selected = sourceBranch.flatMap(item => later.has(item.id) ? points.filter(point => point.userEntryId === item.id) : []);
          this.rewindingWorkspaces.add(source.snapshot.cwd);
          try { await sourceCheckpoints.restore(selected); }
          finally { this.rewindingWorkspaces.delete(source.snapshot.cwd); }
        }
      }
      const branchedFile = manager.createBranchedSession(leaf);
      if (!branchedFile) throw new Error("无法创建分支会话");
      const branched = SessionManager.open(branchedFile, this.sessionDir(), source.snapshot.cwd);
      copyTurnTimings(sourceTimings, branched);
      const branchedSources = transcriptSourcesFromProjection(branched.buildSessionProjection());
      await this.rememberActiveSelection();
      const entry = this.addEntry(source.snapshot.cwd, {
        hasWorkspace: source.hasWorkspace,
        sessionManager: branched,
        title: branchTitle(source.snapshot.title),
        mode: source.snapshot.mode,
        instructions: source.instructions,
      });
      // 带上已提交的 Plan revision，分支里的历史 Plan Preview 才能对应到文档；
      // 执行进度不复制，分支是新的执行上下文。
      if (source.plans.length > 0) {
        entry.plans = source.plans.map((plan) => ({ ...plan }));
        entry.latestProposedPlanId = source.latestProposedPlanId;
        this.syncPlanState(entry);
      }
      // 分叉保留到这一轮为止的检查点，新聊天也能回退这些轮次。子代理与执行进度不随分支复制，
      // 所以元数据里也去掉它们，回退时不会改写原对话的子代理会话。
      const kept = new Set(branched.getEntries().map(item => item.id));
      await sourceCheckpoints.copyTo(this.checkpoints(entry),
        points.filter(point => point.userEntryId && kept.has(point.userEntryId) && (point.leaf === null || kept.has(point.leaf))),
        metadata => ({ ...metadata, executionPlans: [], activeExecutionPlanId: null, goal: null, agents: [], agentLeaves: {} }));
      this.trace(source.id).forkTo(this.trace(entry.id, false), turnIndex);
      this.store.update(entry.id, countTranscriptActivity(branchedSources));
      return this.startInternal(entry);
    });
  }

  /** 切换激活对话;原对话保持原状(后台流继续),上下文不丢。 */
  async switchConversation(id: string): Promise<SessionSnapshot> {
    return this.exclusive(async () => {
      await this.ready();
      const entry = this.conversations.get(id);
      if (!entry) throw new Error("对话不存在或已结束");
      if (!entry.session) await this.startInternal(entry);
      this.activeId = entry.id;
      this.notifyActiveCwd(entry.snapshot.cwd, entry.hasWorkspace);
      this.emitStatus(entry);
      return this.getSnapshot();
    });
  }

  /** 改名不激活会话或改变最近使用顺序，运行中的会话也可改名。 */
  async renameConversation(id: string, rawTitle: unknown): Promise<void> {
    const title = normalizeManualConversationTitle(rawTitle);
    await this.ready();
    const entry = this.conversations.get(id);
    if (!entry) throw new Error("对话不存在或已结束");
    entry.titleManuallySet = true;
    entry.titleGenerationStarted = true;
    this.patchEntry(entry, { title });
  }

  /** 归档一个对话:侧边栏隐藏、历史保留。归档当前对话时自动切到最近的未归档对话。 */
  async archiveConversation(id: string): Promise<SessionSnapshot> {
    return this.exclusive(async () => {
      await this.ready();
      const entry = this.conversations.get(id);
      if (!entry) throw new Error("对话不存在或已结束");
      entry.archivedAt = Date.now();
      this.persistEntry(entry);
      this.store.flushSync();
      this.emitStatus(entry);
      if (this.activeId === id) {
        const fallback = [...this.conversations.values()]
          .filter((other) => other.archivedAt === null)
          .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
        if (fallback) {
          if (!fallback.session) await this.startInternal(fallback);
          this.activeId = fallback.id;
          this.touchEntry(fallback);
          this.notifyActiveCwd(fallback.snapshot.cwd, fallback.hasWorkspace);
          this.emitStatus(fallback);
        }
      }
      return this.getSnapshot();
    });
  }

  /** 取消归档,对话回到侧边栏;不改变当前激活对话。 */
  async unarchiveConversation(id: string): Promise<SessionSnapshot> {
    return this.exclusive(async () => {
      await this.ready();
      const entry = this.conversations.get(id);
      if (!entry) throw new Error("对话不存在或已结束");
      entry.archivedAt = null;
      this.persistEntry(entry);
      this.store.flushSync();
      this.emitStatus(entry);
      return this.getSnapshot();
    });
  }

  /** Rewind in the same chat. A marker persists the selected branch even before resending. */
  async rewindConversation(conversationId: string, turnIndex: number): Promise<void> {
    await this.exclusive(async () => {
      await this.ready();
      const entry = this.conversations.get(conversationId);
      if (!entry) throw new Error("对话不存在或已结束");
      await this.rewindEntry(entry, turnIndex);
    });
  }

  /** Return to the state right after a turn (-1 is the start of the chat): later turns and their file changes are undone. */
  async restoreCheckpoint(conversationId: string, turnIndex: number): Promise<void> {
    await this.exclusive(async () => {
      await this.ready();
      const entry = this.conversations.get(conversationId);
      if (!entry) throw new Error("对话不存在或已结束");
      if (!entry.session) await this.startInternal(entry);
      const turns = this.visibleUserSources(entry.sessionManager!).length;
      if (!Number.isInteger(turnIndex) || turnIndex < -1 || turnIndex >= turns) throw new Error("找不到要回到的检查点");
      if (turnIndex === turns - 1) throw new Error("已经在这个检查点");
      await this.rewindEntry(entry, turnIndex + 1);
    });
  }

  /** Each turn's checkpoint and whether returning to it is safe right now. Nothing is written. */
  async getCheckpoints(conversationId: string): Promise<CheckpointTimeline> {
    await this.ready();
    const entry = this.conversations.get(conversationId);
    if (!entry) throw new Error("对话不存在或已结束");
    const manager = entry.sessionManager ?? (entry.sessionFile ? SessionManager.open(entry.sessionFile, this.sessionDir(), entry.snapshot.cwd) : null);
    if (!manager) return { conversationId, start: null, turns: [] };
    const users = this.visibleUserSources(manager);
    const branch = manager.getBranch();
    const points = await this.checkpoints(entry).list();
    const byUser = new Map(points.filter(point => point.userEntryId).map(point => [point.userEntryId!, point]));
    // Same selection as rewindEntry: every checkpoint from a turn to the end of the branch, oldest first.
    const ordered = branch.flatMap(item => byUser.get(item.id) ?? []);
    const failures = await this.checkpoints(entry).check(ordered);
    const preview = (index: number): CheckpointRestorePreview => {
      const point = byUser.get(users[index]!.entryId ?? "");
      const removedTurns = users.length - index;
      if (!point) return { available: false, reason: "这一轮与上一轮在同一次运行中，没有单独的文件检查点", removedTurns, files: [] };
      const from = ordered.indexOf(point);
      const files = [...new Set(ordered.slice(from).flatMap(changedPaths))].sort();
      const reason = failures[from];
      return reason ? { available: false, reason, removedTurns, files } : { available: true, removedTurns, files };
    };
    return {
      conversationId,
      start: users.length > 0 ? preview(0) : null,
      turns: users.map((user, index) => {
        const point = byUser.get(user.entryId ?? "");
        return {
          turnIndex: index,
          text: userMessageText(user.message),
          timestamp: user.timestamp,
          changedFiles: point ? changedPaths(point) : null,
          restore: index + 1 < users.length ? preview(index + 1) : null,
        };
      }),
    };
  }

  private visibleUserSources(manager: SessionManager) {
    return transcriptSourcesFromProjection(manager.buildSessionProjection())
      .filter(source => source.message.role === "user" && isVisibleTranscriptMessage(source.message));
  }

  private assertWorkspaceIdle(cwd: string) {
    for (const other of this.conversations.values()) {
      if (other.snapshot.cwd !== cwd) continue;
      if (other.driving || other.session?.isStreaming || other.control?.list().some(agent => agent.kind !== "root" && isAgentBusy(agent.status))) {
        throw new Error("工作区还有任务运行中，请停止或等待完成后修改消息");
      }
    }
  }

  private async rewindEntry(entry: Conversation, turnIndex: number): Promise<void> {
    if (!entry.session || !entry.sessionManager) throw new Error("对话不存在或已结束");
    this.assertWorkspaceIdle(entry.snapshot.cwd);
    const manager = entry.sessionManager;
    const user = this.visibleUserSources(manager)[turnIndex];
    if (!user?.entryId) throw new Error("找不到要修改的消息");
    const checkpoints = this.checkpoints(entry);
    const points = await checkpoints.list();
    const point = points.find(item => item.userEntryId === user.entryId);
    if (!point) throw new Error("这条历史消息没有文件检查点，无法回退更改");
    const branch = manager.getBranch();
    const position = branch.findIndex(item => item.id === user.entryId);
    const abandoned = new Set(branch.slice(position).map(item => item.id));
    const selected = points.filter(item => item.userEntryId && abandoned.has(item.userEntryId))
      .sort((a, b) => branch.findIndex(item => item.id === a.userEntryId) - branch.findIndex(item => item.id === b.userEntryId));
    // Validate files before touching chat history; conflict failures leave the whole chat intact.
    this.rewindingWorkspaces.add(entry.snapshot.cwd);
    try {
      await checkpoints.restore(selected);
      const selection = { model: entry.session.model, thinkingLevel: entry.session.thinkingLevel as ThinkingLevel };
      await this.detachEntry(entry);
      if (point.leaf) manager.branch(point.leaf); else manager.resetLeaf();
      manager.appendCustomEntry("vela_rewind", { turnIndex });
      entry.plans = point.metadata.plans;
      entry.latestProposedPlanId = point.metadata.latestProposedPlanId;
      entry.executionPlans = point.metadata.executionPlans;
      entry.activeExecutionPlanId = point.metadata.activeExecutionPlanId;
      entry.storedAgents = point.metadata.agents;
      for (const agent of entry.storedAgents) {
        if (!agent.sessionFile || !existsSync(agent.sessionFile)) continue;
        const child = SessionManager.open(agent.sessionFile, this.childSessionDir(entry.id), entry.snapshot.cwd);
        const leaf = point.metadata.agentLeaves[agent.id];
        if (leaf) child.branch(leaf); else child.resetLeaf();
        child.appendCustomEntry("vela_rewind", { turnIndex });
      }
      entry.agentMutationsSeen = new Set(entry.storedAgents.filter(agent => agent.mutated).map(agent => agent.id));
      entry.goalValidationEvidence.clear();
      entry.goalValidationSequence = Math.max(0, ...(point.metadata.goal?.validation?.checks.map(check => check.sequence) ?? [0]));
      entry.planStream = null;
      entry.planStreamPlan = null;
      entry.pendingInstructions = [];
      this.syncPendingInstructions(entry);
      entry.generation = { stepStartedAt: null, firstTokenAt: null, outputTokens: 0, elapsedMs: 0 };
      entry.snapshot.goal = point.metadata.goal;
      this.syncPlanState(entry);
      const retainedTraceTurns = branch.slice(0, position).filter(item => item.type === "message" && item.message.role === "user" &&
        isVisibleTranscriptMessage(item.message as AgentMessage) && userMessageText(item.message as AgentMessage) !== goalContinuePrompt).length;
      this.trace(entry.id).rewindTo(retainedTraceTurns);
      this.store.update(entry.id, countTranscriptActivity(transcriptSourcesFromProjection(manager.buildSessionProjection())));
      this.persistEntry(entry);
      this.store.flushSync();
      await checkpoints.remove(selected);
      await this.startInternal(entry, selection);
      this.emit({ type: "agents", conversationId: entry.id, agents: entry.control?.list() ?? [] });
    } finally { this.rewindingWorkspaces.delete(entry.snapshot.cwd); }
  }

  private checkpoints(entry: Conversation) {
    const root = join(this.options.agentDir, "checkpoints");
    return new TurnCheckpoints<RewindMetadata>(join(root, entry.id), entry.snapshot.cwd, this.options.agentDir, sharedDirectory(root));
  }

  /** Disk used by file checkpoints. */
  getCheckpointStorage(): Promise<CheckpointStorageUsage> {
    return checkpointUsage(join(this.options.agentDir, "checkpoints"));
  }

  /** Merge duplicate files, drop checkpoints beyond the retention policy and delete files nothing references. */
  cleanCheckpointStorage(): Promise<CheckpointCleanResult> {
    return cleanCheckpoints(join(this.options.agentDir, "checkpoints"));
  }

  private async finishLatestCheckpoint(entry: Conversation) {
    if (entry.control?.list().some(agent => agent.kind !== "root" && isAgentBusy(agent.status))) return;
    const checkpoints = this.checkpoints(entry);
    const branch = entry.sessionManager?.getBranch() ?? [];
    const points = await checkpoints.list();
    const point = [...branch].reverse().map(item => points.find(point => point.userEntryId === item.id)).find(Boolean);
    if (point) {
      await checkpoints.finish(point, point.userEntryId);
      await checkpoints.prune(defaultCheckpointPolicy.maxPointsPerConversation).catch(() => undefined);
    }
  }

  /**
   * 发送一条用户消息。运行中传入 deliverAs 时不做新一轮:
   * queue 排队到当前任务自然结束,steer 在最早可达的执行边界调整当前任务。
   */
  async prompt(
    conversationId: string,
    text: string,
    images?: ImageAttachment[],
    deliverAs?: RuntimeInstructionMode,
    recipeToken?: symbol,
  ): Promise<void> {
    const entry = this.conversations.get(conversationId);
    if (!entry?.session) throw new Error("对话不存在或已结束");
    if (entry.recipeWorkflowActive && recipeToken !== recipePromptToken) throw new Error("配方阶段正在执行或等待审批，请使用阶段操作，或先停止任务");
    const running = entry.driving || entry.session.isStreaming;
    if (deliverAs && running) {
      await this.appendInstruction(entry, text, images, deliverAs);
      return;
    }
    this.requireIdle(conversationId, recipeToken === recipePromptToken);
    this.addUsage(conversationId, 1, 0);
    if (!entry.titleManuallySet && !entry.titleGenerationStarted && entry.snapshot.title === "新对话") {
      entry.titleGenerationStarted = true;
      const fallbackTitle = clipTitle(text);
      this.patchEntry(entry, { title: fallbackTitle, updatedAt: Date.now() });
      const directory = this.directory;
      const model = entry.session?.model;
      if (directory && model && directory.isAvailable(model)) {
        void this.generateConversationTitle(entry, text, fallbackTitle, model, directory);
      }
    }
    if (entry.snapshot.mode === "goal") this.beginGoal(entry, text);
    await this.drive(entry, text, images, {
      autonomous: entry.snapshot.mode === "goal",
      announce: false,
      rename: true,
    });
  }

  /** 撤销一条还没被 Pi 队列消费的运行中指令。 */
  async removeInstruction(conversationId: string, instructionId: string): Promise<void> {
    const entry = this.conversations.get(conversationId);
    if (!entry?.session) throw new Error("对话不存在或已结束");
    if (!entry.pendingInstructions.some((item) => item.id === instructionId)) return;
    entry.pendingInstructions = entry.pendingInstructions.filter((item) => item.id !== instructionId);
    entry.rebuildingInstructions = true;
    try {
      // Pi 队列没有单条删除接口,清空后按原顺序回放剩余指令;
      // 文本保留原始输入,技能命令和模板会重新展开。
      entry.session.clearQueue();
      const remaining = [...entry.pendingInstructions];
      for (const item of remaining) item.queued = false;
      for (const item of remaining) {
        await this.queueInstruction(entry, entry.session, item);
      }
    } finally {
      entry.rebuildingInstructions = false;
    }
    // 重建期间如果有指令被消费,这里用队列现状补一次对账。
    this.reconcileInstructions(entry.id, entry.session.getSteeringMessages(), entry.session.getFollowUpMessages());
    this.syncPendingInstructions(entry);
  }

  private async appendInstruction(
    entry: Conversation,
    text: string,
    images: ImageAttachment[] | undefined,
    mode: RuntimeInstructionMode,
  ): Promise<void> {
    const session = entry.session;
    if (!session) throw new Error("对话不存在或已结束");
    const trimmed = text.trim();
    if (!trimmed) throw new Error("指令不能为空");
    const instruction: PendingInstruction = {
      id: randomUUID(),
      mode,
      text: trimmed,
      images: images && images.length > 0 ? images : undefined,
      createdAt: Date.now(),
      queued: false,
    };
    entry.pendingInstructions.push(instruction);
    this.syncPendingInstructions(entry);
    try {
      await this.queueInstruction(entry, session, instruction);
    } catch (error) {
      entry.pendingInstructions = entry.pendingInstructions.filter((item) => item.id !== instruction.id);
      this.syncPendingInstructions(entry);
      throw error;
    }
  }

  private async queueInstruction(entry: Conversation, session: AgentSession, instruction: PendingInstruction): Promise<void> {
    const images = instruction.images?.map((image) => ({
      type: "image" as const,
      data: image.data,
      mimeType: image.mimeType,
    }));
    const disposition = instruction.mode === "steer"
      ? await session.steer(instruction.text, images)
      : await session.followUp(instruction.text, images);
    if (disposition === "handled") {
      // An input extension consumed it; it never became a user message in Pi.
      entry.pendingInstructions = entry.pendingInstructions.filter((item) => item.id !== instruction.id);
    } else {
      instruction.queued = true;
    }
    // queue_update may fire before the async input handler returns, including
    // consumption of this or an earlier input. Account only after disposition.
    this.reconcileInstructions(entry.id, session.getSteeringMessages(), session.getFollowUpMessages());
    this.syncPendingInstructions(entry);
  }

  /**
   * Pi 队列对账:steering / followUp 数组少了多少条,就说明最早提交的对应指令
   * 已经进入会话。补发 user_message 并计数,然后从待处理列表里移除。
   */
  private reconcileInstructions(
    conversationId: string,
    steering: readonly string[],
    followUp: readonly string[],
  ): void {
    const entry = this.conversations.get(conversationId);
    if (!entry || entry.rebuildingInstructions) return;
    const delivered: PendingInstruction[] = [];
    for (const mode of ["steer", "queue"] as const) {
      const pending = entry.pendingInstructions.filter((item) => item.mode === mode && item.queued);
      const queued = mode === "steer" ? steering.length : followUp.length;
      const count = pending.length - queued;
      if (count > 0) delivered.push(...pending.slice(0, count));
    }
    if (delivered.length === 0) return;
    const deliveredIds = new Set(delivered.map((item) => item.id));
    entry.pendingInstructions = entry.pendingInstructions.filter((item) => !deliveredIds.has(item.id));
    for (const instruction of delivered) {
      this.addUsage(entry.id, 1, 0);
      this.emit({ type: "user_message", conversationId: entry.id, text: instruction.text });
    }
    this.syncPendingInstructions(entry);
  }

  /** 把运行中指令镜像进快照并广播,输入框上方的待处理条据此渲染。 */
  private syncPendingInstructions(entry: Conversation): void {
    entry.snapshot = {
      ...entry.snapshot,
      pendingInstructions: entry.pendingInstructions.map(({ id, mode, text, createdAt }) => ({
        id,
        mode,
        text,
        createdAt,
      })),
    };
    this.emitStatus(entry);
  }

  async setMode(conversationId: string, mode: InteractionMode): Promise<void> {
    const entry = this.conversations.get(conversationId);
    if (!entry) throw new Error("对话不存在或已结束");
    if (entry.driving || entry.session?.isStreaming) throw new Error("回复进行中，不能切换模式");
    if (entry.recipeWorkflowActive) throw new Error("配方阶段执行期间不能切换模式");
    if (entry.snapshot.mode === mode) return;
    if (entry.snapshot.mode === "goal") this.pauseGoal(entry, null);
    this.patchEntry(entry, { mode });
    this.applyActiveTools(entry);
  }

  /**
   * 批准最新 Plan revision 并开始执行。
   * continue：沿用当前对话上下文；fresh：用原始目标 + 已批准方案开一个新的执行对话。
   */
  async executePlan(
    conversationId: string,
    strategy: PlanExecutionContextStrategy = "continue",
  ): Promise<void> {
    const entry = this.requireIdle(conversationId);
    const plan = latestPlan(entry.plans);
    if (!plan) throw new Error("还没有可以执行的计划");
    const plans = approvePlanRevision(entry.plans, plan.id, Date.now());
    const approved = plans.find((item) => item.id === plan.id) ?? plan;
    if (entry.snapshot.mode === "goal") this.pauseGoal(entry, null);
    if (strategy === "fresh") {
      // 规划对话里也记下批准结果，fresh 对话再带上这份已批准的 revision。
      entry.plans = plans;
      entry.latestProposedPlanId = approved.id;
      this.syncPlanState(entry);
      const fresh = await this.startFreshExecution(entry, approved);
      await this.drive(fresh, planFreshPrompt(approved.objective, approved), undefined, {
        autonomous: false,
        announce: true,
        hidden: true,
        rename: false,
      });
      return;
    }
    this.bindExecution(entry, approved, plans);
    if (entry.snapshot.mode !== "agent") this.patchEntry(entry, { mode: "agent" });
    this.applyActiveTools(entry);
    await this.drive(entry, planContinuePrompt(approved), undefined, {
      autonomous: false,
      announce: true,
      hidden: true,
      rename: false,
    });
  }

  /** 继续一个暂停中的目标，并重新进入自动续跑。 */
  async resumeGoal(conversationId: string): Promise<void> {
    const entry = this.requireIdle(conversationId);
    const goal = entry.snapshot.goal;
    if (!goal || goal.status === "complete") throw new Error("没有可以继续的目标");
    if (entry.snapshot.mode !== "goal") this.patchEntry(entry, { mode: "goal" });
    this.patchEntry(entry, {
      goal: { ...goal, status: "active", note: null, updatedAt: Date.now() },
    });
    this.applyActiveTools(entry);
    await this.drive(entry, goalContinuePrompt, undefined, {
      autonomous: true,
      announce: true,
      rename: false,
    });
  }

  async abort(conversationId?: string): Promise<void> {
    const entry = conversationId ? this.conversations.get(conversationId) : this.activeConversation();
    if (!entry) return;
    entry.stopRequested = true;
    try { this.options.onRecipeStop?.(entry.id); } catch (error) { log.error("recipe stop notification failed", error); }
    // 停止一并撤销还没投递的排队/调整指令,避免下一次发言时意外继续。
    entry.pendingInstructions = [];
    this.syncPendingInstructions(entry);
    entry.session?.clearQueue();
    // 中断时不沉淀未写完的 plan 草稿。
    entry.planStream = null;
    entry.planStreamPlan = null;
    this.questions.cancelConversation(entry.id);
    if (entry.snapshot.mode === "goal") this.pauseGoal(entry, null);
    entry.control?.abortAll();
    if (entry.session) await entry.session.abort();
    this.trace(entry.id).settle("Interrupted");
    entry.control?.setRootStatus("aborted");
    this.patchEntry(entry, { status: "ready", updatedAt: Date.now() });
  }

  /**
   * 工作区变化:优先切回该工作区最近使用的对话(上下文保留),
   * 没有才新建一个;其他工作区的对话留在列表里。
   */
  async switchWorkspace(cwd: string, hasWorkspace = true): Promise<SessionSnapshot> {
    return this.exclusive(async () => {
      await this.ready();
      const existing = [...this.conversations.values()]
        .filter((entry) => entry.snapshot.cwd === cwd && entry.hasWorkspace === hasWorkspace && entry.archivedAt === null)
        .sort((a, b) => b.updatedAt - a.updatedAt);
      if (existing.length > 0) {
        const entry = existing[0];
        if (!entry.session) await this.startInternal(entry);
        this.activeId = entry.id;
        this.notifyActiveCwd(cwd, entry.hasWorkspace);
        this.emitStatus(entry);
        return this.getSnapshot();
      }
      await this.rememberActiveSelection();
      const entry = this.addEntry(cwd, { hasWorkspace });
      return this.startInternal(entry);
    });
  }

  async getCatalog(): Promise<ModelCatalog> {
    const directory = await this.readyDirectory();
    return directory.catalog();
  }

  /**
   * 用当前对话选择的模型判断一次沙箱操作的风险。
   * 模型不可用、超时或输出无法识别时返回 unknown,由权限管理器按风险处理。
   */
  async evaluateSandboxRisk(input: SandboxRiskInput): Promise<SandboxRiskVerdict> {
    let directory: ModelDirectory;
    try {
      directory = await this.readyDirectory();
    } catch {
      return "unknown";
    }
    const entry = input.conversationId ? this.conversations.get(input.conversationId) : this.activeConversation();
    const model = entry?.session?.model;
    if (!model || !directory.isAvailable(model)) return "unknown";
    const task = entry?.snapshot.goal?.objective ?? entry?.snapshot.title ?? null;
    const controller = new AbortController();
    const riskSignal = input.signal ? AbortSignal.any([controller.signal, input.signal as AbortSignal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(), sandboxRiskTimeoutMs);
    try {
      const response = await directory.runtime.completeSimple(
        model,
        {
          systemPrompt: sandboxRiskSystemPrompt,
          messages: [
            { role: "user", content: buildSandboxRiskMessage(input, task), timestamp: Date.now() },
          ],
        },
        {
          maxTokens: sandboxRiskMaxTokens,
          temperature: 0,
          signal: riskSignal,
          sessionId: entry.id,
          headers: openCodeSessionHeaders(model, entry.id),
        },
      );
      return parseSandboxRiskVerdict(
        response.content
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join(""),
      );
    } catch {
      return "unknown";
    } finally {
      clearTimeout(timer);
    }
  }

  selectModel(provider: string, id: string): Promise<SessionSnapshot> {
    return this.exclusive(async () => {
      const directory = await this.readyDirectory();
      const model = directory.requireAvailable(provider, id);
      const level = clampToModel(model, this.liveThinking(directory));
      await this.applyModel(model, level);
      await directory.rememberLastUsed(model.provider, model.id, level);
      return this.getSnapshot();
    });
  }

  setThinkingLevel(level: ThinkingLevel): Promise<SessionSnapshot> {
    return this.exclusive(async () => {
      if (!isThinkingLevel(level)) throw new Error("不支持这个思考强度");
      const directory = await this.readyDirectory();
      const active = this.activeConversation();
      if (active?.recipeWorkflowActive) throw new Error("配方执行期间不能更换思考强度");
      const model = active?.session?.model ?? directory.modelForSelection();
      const next = model ? clampToModel(model, level) : level;
      active?.session?.setThinkingLevel(next);
      if (active?.recipeExecution) active.recipeExecution = { ...active.recipeExecution, thinkingLevel: next };
      if (active) this.syncFromSession(active);
      if (model) await directory.rememberLastUsed(model.provider, model.id, next);
      return this.getSnapshot();
    });
  }

  async getAgentSettings(): Promise<AgentSettings> {
    const directory = await this.readyDirectory();
    return directory.getSettings();
  }

  /** 用户 Skill 目录。与会话启动时 Pi 扫描的 `<agentDir>/skills` 相同。 */
  skillsDirectory(): string {
    return this.skills.directory();
  }

  /** 按当前工作区扫描用户 Skill、项目 Skill 和 ~/.agents/skills。 */
  listSkills(cwd: string): Promise<SkillCatalog> {
    return this.skills.list(cwd);
  }

  /** 启用或停用一个 Skill；已打开的对话会在下次发言前重新加载资源。 */
  setSkillEnabled(cwd: string, name: string, enabled: boolean): Promise<SkillCatalog> {
    return this.exclusive(() => this.skills.setEnabled(cwd, name, enabled));
  }

  /** 删除 Vela 用户 Skill 目录里的 Skill；已打开的对话会在下次发言前重新加载资源。 */
  deleteSkill(cwd: string, name: string, location: string): Promise<SkillCatalog> {
    return this.exclusive(() => this.skills.delete(cwd, name, location));
  }

  /** 列出 Codex 与 Claude Code 中可复制到 Vela 的 Skill。 */
  scanExternalSkills(cwd: string): Promise<ExternalSkillScan> {
    return this.skills.scanExternal(cwd);
  }

  /** 把选中的外部 Skill 复制到用户 Skill 目录。 */
  migrateSkills(cwd: string, ids: readonly string[]): Promise<SkillMigrationResult> {
    return this.skills.migrate(cwd, ids);
  }

  /** 停用、启用或删除 Skill 后，让会话在下次发言前重新加载 Skill 列表。 */
  private async refreshEntrySkills(entry: Conversation): Promise<void> {
    const session = entry.session;
    if (!session || entry.skillsRevision === this.skills.revision) return;
    const revision = this.skills.revision;
    try {
      await session.reload();
      this.applyActiveTools(entry);
    } catch (error) {
      log.debug("skill reload failed", error);
      return;
    }
    // 重新加载期间 Skill 又变了就留到下一次发言再刷。
    if (revision === this.skills.revision) entry.skillsRevision = revision;
  }

  saveAgentSettings(input: AgentSettings): Promise<AgentSettings> {
    return this.exclusive(async () => {
      const directory = await this.readyDirectory();
      return directory.saveSettings(input);
    });
  }

  addModel(input: CustomModelInput): Promise<SessionSnapshot> {
    return this.exclusive(async () => {
      const directory = await this.readyDirectory();
      const added = await directory.addCustom(input);
      const model = directory.requireAvailable(added.providerId, added.modelId);
      await this.applyModel(model, clampToModel(model, this.liveThinking(directory)));
      return this.getSnapshot();
    });
  }

  /** 只登记模型,留给设置页;当前对话和默认模型都保持不变。 */
  registerModel(input: CustomModelInput): Promise<void> {
    return this.exclusive(async () => {
      const directory = await this.readyDirectory();
      await directory.addCustom(input);
    });
  }

  removeModel(provider: string, id: string): Promise<SessionSnapshot> {
    return this.exclusive(async () => {
      const active = this.activeConversation();
      const directory = await this.readyDirectory();
      await directory.removeCustom(provider, id);
      if (active?.session?.model?.provider === provider && active.session.model.id === id) {
        clearSessionModel(active.session);
      }
      if (active) this.syncFromSession(active);
      return this.getSnapshot();
    });
  }

  logout(providerId: string): Promise<SessionSnapshot> {
    return this.exclusive(async () => {
      const directory = await this.readyDirectory();
      await directory.logout(providerId);
      const active = this.activeConversation();
      if (active) this.syncFromSession(active);
      return this.getSnapshot();
    });
  }

  login(providerId: string, type: AuthMethodType): Promise<"ok" | "cancelled"> {
    return this.exclusive(async () => {
      const directory = await this.readyDirectory();
      const result = await directory.login(providerId, type);
      if (result === "ok") await this.applySavedModel();
      return result;
    });
  }

  replyLogin(promptId: string, value: string | null): void {
    if (value !== null && value.length > 8000) throw new Error("输入过长");
    this.directory?.replyLogin(promptId, value);
  }

  cancelLogin(): void {
    this.directory?.cancelLogin();
  }

  /**
   * 某个对话的 Context 用量。消息计数来自持久层，token 分段从当前会话实时估算。
   * 会话 token、缓存命中率与输出速度用于输入框下方的统计条。
   */
  getUsage(conversationId: string | null): ContextUsage {
    const stored = conversationId ? this.store.get(conversationId) : null;
    const entry = conversationId ? this.conversations.get(conversationId) ?? null : null;
    const session = entry?.session ?? null;
    const measured = session
      ? measureSessionContext(session)
      : { tokens: 0, contextWindow: null, percent: null, segments: emptyContextSegments() };
    const sessionUsage = session
      ? measureSessionUsage(session)
      : { sessionTokens: null, cacheHitRate: null };
    return {
      messageCount: stored?.messageCount ?? 0,
      toolCallCount: stored?.toolCallCount ?? 0,
      ...countConversationActivity(session?.agent.state.messages ?? [], isPlanExecutionPrompt),
      ...measured,
      ...sessionUsage,
      outputSpeed: session ? outputSpeed(entry) : null,
    };
  }

  addUsage(conversationId: string, dMessages: number, dToolCalls: number): void {
    const stored = this.store.get(conversationId);
    if (!stored) return;
    this.store.update(conversationId, {
      messageCount: Math.max(0, stored.messageCount + dMessages),
      toolCallCount: Math.max(0, stored.toolCallCount + dToolCalls),
    });
  }

  private trace(conversationId: string, restoreHistory = true): TraceRecorder {
    return this.traces.get(conversationId, restoreHistory);
  }

  getTrace(conversationId: string) {
    if (!this.conversations.has(conversationId)) throw new Error("对话不存在或已结束");
    return this.redactMcpForConversation(conversationId, this.trace(conversationId).snapshot());
  }

  /** Trace bookkeeping must never block a summary; narrow test harnesses may omit the traces. */
  private recordSummaryUsage(conversationId: string, summary: Omit<TraceSummaryRequest, "id">): void {
    if (!this.traces) return;
    this.trace(conversationId).recordSummary(summary);
  }

  getTraceDetails(conversationId: string, nodeId: string) {
    if (!this.conversations.has(conversationId)) throw new Error("对话不存在或已结束");
    return this.redactMcpForConversation(conversationId, this.trace(conversationId).details(nodeId));
  }

  /** 恢复界面消息列表(应用重启后渲染层桶是空的,从会话文件重建)。 */
  getMessages(conversationId: string): TranscriptMessage[] {
    const entry = this.conversations.get(conversationId);
    const session = entry?.session ?? null;
    if (!session || !entry) return [];
    const manager = session.sessionManager;
    return this.decorateMcpTranscript(entry.id, session, transcriptFromProjection(manager.buildSessionProjection(), entry.plans, readTurnTimings(manager.getBranch())));
  }

  getRecipeEvidence(run: RecipeRun, evidence: RecipeStageEvidence): { label: string; text: string } {
    const entry = this.conversations.get(run.conversationId);
    if (!entry || entry.recipeRunId !== run.id) throw new Error("关联聊天已删除或绑定不可用");
    const manager = entry.sessionManager ?? (entry.sessionFile ? SessionManager.open(entry.sessionFile, this.sessionDir(), entry.snapshot.cwd) : null);
    if (!manager) throw new Error("聊天证据不可读取");
    if (evidence.type === "response") {
      const message = manager.getBranch().find(item => item.id === evidence.id);
      if (message?.type !== "message" || message.message.role !== "assistant") throw new Error("关联回复不在当前聊天历史中");
      const visible = transcriptFromMessages([message.message as AgentMessage])[0];
      return this.redactMcpForConversation(entry.id, { label: evidence.label, text: visible?.text ?? "" });
    }
    const messages = this.decorateMcpTranscript(entry.id, entry.session, transcriptFromProjection(manager.buildSessionProjection(), entry.plans));
    const tool = messages.flatMap(m => m.tools).find(t => t.id === evidence.id);
    if (!tool) throw new Error("关联工具记录不在当前聊天历史中");
    return this.redactMcpForConversation(entry.id, { label: evidence.label, text: JSON.stringify(tool.activity, null, 2) });
  }

  /** 使用指定总结模型或捕获对话当前模型；独立调用，不修改会话消息和模型选择。 */
  async summarizeThinking(input: ThinkingSummaryInput): Promise<string> {
    const entry = this.conversations.get(input.conversationId);
    if (!entry) throw new Error("对话不存在或已结束");
    const chatModel = entry.session?.model;
    const selection = input.model ? { ...input.model } : undefined;
    const directory = await this.readyDirectory();
    const model = selection ? directory.requireAvailable(selection.provider, selection.id) : chatModel;
    if (!model || !directory.isAvailable(model)) throw new Error("先选择一个已登录或已配置密钥的模型");
    return this.thinkingSummaries.generate(directory.runtime, model, input, (request) => {
      this.recordSummaryUsage(input.conversationId, request);
    });
  }

  /**
   * 生成 Commit Message / PR 文案。默认用当前对话选定的模型;
   * 没有对话时用设置里的默认模型。结果是可编辑草稿,不执行任何 Git/GitHub 操作。
   */
  async generateTextAssist(raw: unknown): Promise<AiTextResult> {
    const request = parseAiTextRequest(raw);
    const directory = await this.readyDirectory();
    const entry = this.activeConversation();
    const model = entry?.session?.model ?? directory.modelForSelection();
    if (!model || !directory.isAvailable(model)) throw new Error("先选择一个已登录或已配置密钥的模型");
    return this.textAssist.generate(directory.runtime, model, request, entry?.id ?? null);
  }

  async generateRecipe(raw: unknown) {
    const input = parseRecipeGenerateInput(raw);
    const directory = await this.readyDirectory();
    const model = directory.requireAvailable(input.model.provider, input.model.id);
    return this.recipeGenerator.generate(directory.runtime, model, input);
  }
  cancelRecipeGeneration(id: string): void { this.recipeGenerator.cancel(id); }

  cancelTextAssist(requestId: unknown): void {
    if (typeof requestId === "string" && requestId.length > 0 && requestId.length <= 100) {
      this.textAssist.cancel(requestId);
    }
  }

  /** 同一工作树上是否有 Agent 正在执行;用于限制暂存/提交等改动文件或索引的操作。 */
  findRunningAgent(cwd: string | null): string | null {
    const match = this.listConversations().find(
      (conversation) => conversation.status === "streaming" && (!cwd || conversation.cwd === cwd),
    );
    return match?.id ?? null;
  }

  hasRunningAgent(cwd: string | null): boolean {
    return this.findRunningAgent(cwd) !== null;
  }

  /**
   * 某个常驻 agent 自己的消息历史；右侧 Agent Pane 首次打开时用它回填。
   * agentId 等于对话 id 时返回主代理消息。
   */
  getAgentMessages(conversationId: string, agentId: string): TranscriptMessage[] {
    const entry = this.conversations.get(conversationId);
    if (!entry) return [];
    const session = agentId === entry.id ? entry.session : entry.control?.getSession(agentId) ?? null;
    if (session) return this.decorateMcpTranscript(conversationId, session, transcriptFromMessages(session.messages));
    const stored = entry.storedAgents.find((agent) => agent.id === agentId);
    if (stored?.sessionFile && existsSync(stored.sessionFile)) {
      const manager = SessionManager.open(stored.sessionFile, this.childSessionDir(entry.id), entry.snapshot.cwd);
      return this.decorateMcpTranscript(conversationId, null, transcriptFromProjection(manager.buildSessionProjection()));
    }
    return stored ? this.decorateMcpTranscript(conversationId, null, legacyAgentTranscript(stored)) : [];
  }

  /** 用户对单个子代理的操作：暂停（下一次工具调用前生效）、继续、取消（含后代）。 */
  controlAgent(conversationId: string, agentId: string, action: AgentControlAction): void {
    const control = this.conversations.get(conversationId)?.control;
    if (!control) throw new Error("找不到这个对话的子代理。");
    if (action === "pause") control.pause(agentId);
    else if (action === "resume") control.resume(agentId);
    else control.cancel(agentId);
  }

  getAgents(conversationId: string | null): AgentInfo[] {
    const entry = conversationId ? this.conversations.get(conversationId) : null;
    return entry?.control?.list() ?? entry?.storedAgents.map(({ sessionFile: _file, ...agent }) => agent) ?? [];
  }

  subscribeMcp(listener: (event: McpStatusEvent) => void): () => void {
    this.mcpListeners.add(listener);
    return () => this.mcpListeners.delete(listener);
  }

  async getMcpCatalog(input: McpCatalogInput): Promise<McpCatalog> {
    await this.ready();
    if (this.disposed) throw new Error("MCP runtime has closed");
    const bridge = await this.mcpBridgeFor(input);
    const catalog = bridge.catalog();
    catalog.pendingApply = bridge.session ? this.mcpPending.has(bridge.session) : false;
    return catalog;
  }

  saveMcpServer(input: McpServerInput): Promise<McpCatalog> {
    return this.exclusive(async () => {
      await this.mcpConfig.save(input);
      await this.applyMcpChanges(input.cwd, true, false, input.scope === "global");
      return this.getMcpCatalog(input);
    });
  }

  removeMcpServer(input: McpServerTarget): Promise<McpCatalog> {
    return this.exclusive(async () => {
      await this.mcpConfig.remove(input);
      await this.applyMcpChanges(input.cwd, true, true, input.scope === "global");
      return this.getMcpCatalog(input);
    });
  }

  setMcpEnabled(input: McpEnabledInput): Promise<McpCatalog> {
    return this.exclusive(async () => {
      await this.mcpConfig.setEnabled(input);
      await this.applyMcpChanges(input.cwd, true, !input.enabled, input.scope === "global");
      return this.getMcpCatalog(input);
    });
  }

  setMcpProjectTrust(input: McpProjectTrustInput): Promise<McpCatalog> {
    return this.exclusive(async () => {
      await this.mcpConfig.setTrust(input);
      await this.applyMcpChanges(input.cwd, true, !input.trusted);
      return this.getMcpCatalog(input);
    });
  }

  setMcpToolReadOnly(input: McpToolReadOnlyInput): Promise<McpCatalog> {
    return this.exclusive(async () => {
      const bridge = await this.mcpBridgeFor(input);
      const tool = bridge.rawTool(input.server, input.tool);
      if (!tool) throw new Error("MCP tool is unavailable; reconnect and review its definition");
      await this.mcpConfig.setReadOnly(input, tool);
      await this.applyMcpChanges(input.cwd, false, !input.readOnly);
      return this.getMcpCatalog(input);
    });
  }

  async reconnectMcpServer(input: McpServerTarget): Promise<McpCatalog> {
    const bridge = await this.mcpBridgeFor(input);
    this.validateMcpServerTarget(bridge, input);
    try { await bridge.controller?.reconnect(input.name); }
    catch { throw new Error("MCP reconnect failed. Check the server configuration and diagnostics."); }
    return this.getMcpCatalog(input);
  }

  subscribePlugins(listener: (event: PluginStatusEvent) => void): () => void {
    return this.pluginManager.subscribe(listener);
  }

  async getPlugins(input: McpCatalogInput): Promise<PluginCatalog> {
    const catalog = await this.getMcpCatalog({ cwd: input.cwd, conversationId: null });
    const pendingApply = [...this.mcpPending].some(session => this.mcpBridges.get(session)?.options.cwd === catalog.cwd);
    return { cwd: catalog.cwd, plugins: this.pluginManager.snapshots(catalog), pendingApply };
  }

  async connectPlugin(input: PluginTarget): Promise<PluginCatalog> {
    await this.ready();
    await this.pluginManager.connect(input.id, input.cwd);
    return this.getPlugins(input);
  }

  async disconnectPlugin(input: PluginTarget): Promise<PluginCatalog> {
    await this.ready();
    await this.pluginManager.disconnect(input.id, input.cwd);
    return this.getPlugins(input);
  }

  private async activatePlugin(id: string, cwd: string, signal: AbortSignal): Promise<void> {
    const check = () => { signal.throwIfAborted(); if (this.disposed) throw new Error("MCP runtime is closed"); };
    check();
    this.plugins.setEnabled(id, true);
    await this.applyPluginConfiguration(cwd);
    check();
    // A separate management session makes Connect available even while a chat is streaming.
    const bridge = await this.mcpBridgeFor({ cwd, conversationId: null });
    check();
    const server = this.plugins.serverName(id);
    if (!bridge.controller) throw new Error("MCP session is starting");
    try { await bridge.controller.reconnect(server); }
    catch {
      if (bridge.controller.getSnapshot().find(item => item.name === server)?.state !== "needs-auth") throw new Error("MCP connection failed");
    }
    check();
    if (this.plugins.get(id).authType === "oauth2" && bridge.controller.getSnapshot().find(item => item.name === server)?.state !== "connected") {
      await this.oauthMcp.login(bridge.controller, server, this.plugins.get(id).mcpUrl, signal);
    }
    check();
    if (bridge.controller.getSnapshot().find(item => item.name === server)?.state !== "connected") throw new Error("MCP connection failed");
    await Promise.all([...this.mcpBridges.values()].filter(other => other !== bridge).map(async other => {
      if (other.session?.isStreaming) return;
      await other.controller?.reconnect(server).catch(() => undefined);
    }));
    this.emitMcp(bridge);
  }

  private async deactivatePlugin(id: string, cwd: string): Promise<void> {
    const plugin = this.plugins.get(id);
    const server = this.plugins.serverName(id);
    this.oauthMcp.cancel(server);
    for (const bridge of this.mcpBridges.values()) bridge.controller?.cancelLogin(server);
    this.plugins.setEnabled(id, false);
    // Disable live policy before closing transports, then await refreshes before deleting tokens.
    await this.applyPluginConfiguration(cwd);
    await Promise.all([...this.mcpBridges.values()].map(bridge => bridge.controller?.suspend(server)));
    this.oauthMcp.credentials.remove(server, plugin.mcpUrl);
  }

  private async applyPluginConfiguration(cwd: string): Promise<void> {
    // Record our own write before yielding: the external-change poll must not reload and
    // cancel an OAuth browser flow merely because we enabled the plugin ourselves.
    const cwds = new Set([cwd, ...[...this.mcpBridges.values()].map(bridge => bridge.options.cwd)]);
    const changes = [...cwds].map(path => this.mcpConfig.checkChanges(path));
    await this.applyMcpChanges(cwd, true, changes.some(change => change.policyChanged), true);
  }

  async loginMcpServer(input: McpServerTarget): Promise<McpCatalog> {
    const bridge = await this.mcpBridgeFor(input);
    this.validateMcpServerTarget(bridge, input);
    if (!bridge.controller) throw new Error("MCP session is starting");
    const config = this.mcpConfig.loadConfigSync(input.cwd).servers.find(item => item.name === input.name)?.config;
    if (!config || !("url" in config)) throw new Error("MCP server does not use OAuth");
    try { await this.oauthMcp.login(bridge.controller, input.name, config.url); }
    catch { throw new Error("MCP sign-in was cancelled or failed. Retry from the MCP settings."); }
    for (const [session, other] of this.mcpBridges) {
      if (other.options.cwd === bridge.options.cwd && session !== bridge.session && !session.isStreaming) {
        void other.controller?.reconnect(input.name).catch(() => undefined);
      }
    }
    return this.getMcpCatalog(input);
  }

  async cancelMcpLogin(input: McpServerTarget): Promise<McpCatalog> {
    this.oauthMcp.cancel(input.name);
    const bridge = await this.mcpBridgeFor(input);
    bridge.controller?.cancelLogin(input.name);
    return this.getMcpCatalog(input);
  }

  async logoutMcpServer(input: McpServerTarget): Promise<McpCatalog> {
    const bridge = await this.mcpBridgeFor(input);
    this.validateMcpServerTarget(bridge, input);
    await bridge.controller?.logout(input.name);
    // All sessions sharing this server/account must stop using its old tokens immediately.
    await Promise.all([...this.mcpBridges.values()].map(other => other.controller?.suspend(input.name)));
    await bridge.controller?.reconnect(input.name).catch(() => undefined);
    return this.getMcpCatalog(input);
  }

  private validateMcpServerTarget(bridge: McpSessionBridge, input: McpServerTarget): void {
    const server = bridge.catalog().servers.find(item => item.name === input.name && item.scope === input.scope && item.effective && item.enabled && item.trusted);
    if (!server) throw new Error("MCP server is disabled, untrusted, or overridden");
  }

  private async mcpBridgeFor(input: McpCatalogInput): Promise<McpSessionBridge> {
    await this.ready();
    const id = input.conversationId === undefined ? (this.activeConversation()?.snapshot.cwd === input.cwd ? this.activeId : null) : input.conversationId;
    if (id) {
      const entry = this.conversations.get(id);
      if (!entry || entry.snapshot.cwd !== input.cwd) throw new Error("MCP conversation does not belong to this workspace");
      if (!entry.session) await this.startInternal(entry);
      const bridge = entry.session ? this.mcpBridges.get(entry.session) : undefined;
      if (bridge) return bridge;
      throw new Error("MCP conversation is unavailable");
    }
    const existing = this.mcpManagement.get(input.cwd);
    if (existing) return this.mcpBridges.get(existing)!;
    const starting = this.mcpManagementStarting.get(input.cwd);
    if (starting) return starting;
    const creating = this.createMcpManagement(input.cwd);
    this.mcpManagementStarting.set(input.cwd, creating);
    try { return await creating; } finally { this.mcpManagementStarting.delete(input.cwd); }
  }

  private async createMcpManagement(cwd: string): Promise<McpSessionBridge> {
    if (this.disposed) throw new Error("MCP runtime is closed");
    // Management sessions contain no conversation history and never send a model request.
    const bridge = this.createMcpBridge(cwd, null, () => false);
    const settingsManager = SettingsManager.inMemory({ defaultTools: [] });
    const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: this.options.agentDir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      extensionFactories: bridge.factories() });
    await resourceLoader.reload();
    const { session } = await createAgentSession({ cwd, agentDir: this.options.agentDir, settingsManager,
      resourceLoader, modelRuntime: (await this.readyDirectory()).runtime, sessionManager: SessionManager.inMemory(cwd) });
    clearSessionModel(session);
    if (this.disposed) { bridge.attach(session); await bridge.close(); session.dispose(); throw new Error("MCP runtime is closed"); }
    bridge.attach(session);
    this.mcpBridges.set(session, bridge);
    this.mcpManagement.set(cwd, session);
    try { await session.bindExtensions({}); } catch (error) { await this.closeSession(session); throw error; }
    return bridge;
  }

  private createMcpBridge(cwd: string, conversationId: string | null, readOnly: () => boolean, nativeTools?: () => string[]): McpSessionBridge {
    const changes = this.mcpConfig.checkChanges(cwd);
    if (changes.changed && this.mcpBridges.size) void this.applyMcpChanges(cwd, changes.configChanged, changes.policyChanged).catch(() => undefined);
    let bridge: McpSessionBridge;
    bridge = new McpSessionBridge({ cwd, conversationId, agentDir: this.options.agentDir, config: this.mcpConfig, readOnly,
      nativeTools: nativeTools ?? (() => {
        const entry = conversationId ? this.conversations.get(conversationId) : undefined;
        if (!entry) return [];
        return this.tools.active(entry);
      }),
      permission: this.options.mcpPermission ? { request: input => this.options.mcpPermission!.request({ ...input,
        conversationId: conversationId ?? undefined, sandboxMode: conversationId ? this.conversations.get(conversationId)?.scheduledSandboxMode : undefined }) } : undefined, openUrl: this.options.mcpOpenUrl, oauth: this.oauthMcp,
      onChange: () => queueMicrotask(() => {
        if (this.disposed || !bridge.session || !this.mcpBridges.has(bridge.session)) return;
        const entry = conversationId ? this.conversations.get(conversationId) : undefined;
        if (entry?.session === bridge.session) {
          const tools = this.mcpActiveTools(bridge.session, this.tools.active(entry));
          bridge.session.setActiveToolsByName(tools);
          if (JSON.stringify(tools) !== JSON.stringify(entry.snapshot.tools)) this.patchEntry(entry, { tools });
        } else {
          bridge.session.setActiveToolsByName(this.mcpActiveTools(bridge.session, bridge.options.nativeTools()));
        }
        this.emitMcp(bridge);
      }),
    });
    return bridge;
  }

  private mcpActiveTools(session: AgentSession, native: string[]): string[] {
    const entry = [...this.conversations.values()].find(e => e.session === session);
    if (entry?.recipeStageSideEffect === "read_only") return this.tools.readOnlyStage(entry);
    const registered = session.getAllTools();
    const active = new Set([...session.getActiveToolNames(), ...getCurrentTools(session.sessionManager.buildSessionContext().messages).map(tool => tool.name)]);
    const extra = registered.filter(tool => isMcpTool(tool.name) && tool.name !== "tool_search" && tool.exposure !== "hidden"
      && (tool.exposure === "direct" || active.has(tool.name))).map(tool => tool.name);
    const servers = this.mcpBridges.get(session)?.controller?.getSnapshot() ?? [];
    const discovery = servers.some(server => server.state !== "disabled" && !server.suspended && server.exposure !== "hidden"
      && (server.exposure === "deferred" || server.tools.some(tool => tool.exposure === "deferred")));
    return [...new Set([...native, ...(discovery ? ["tool_search"] : []), ...extra])];
  }

  private emitMcp(bridge: McpSessionBridge): void {
    if (this.disposed) return;
    try {
      const catalog = bridge.catalog();
      catalog.pendingApply = bridge.session ? this.mcpPending.has(bridge.session) : false;
      for (const listener of this.mcpListeners) listener({ cwd: catalog.cwd, conversationId: catalog.conversationId, catalog });
    } catch { /* A removed workspace must not interrupt an unrelated conversation. */ }
  }

  private async applyMcpChanges(cwd: string, configChanged: boolean, revoke: boolean, all = false): Promise<void> {
    const affected = [...this.mcpBridges.entries()].filter(([, bridge]) => all || bridge.options.cwd === cwd);
    for (const [session, bridge] of affected) {
      await bridge.revokeChanged(revoke);
      if (configChanged || revoke) {
        this.mcpPending.add(session);
        this.mcpRevisions.set(session, (this.mcpRevisions.get(session) ?? 0) + 1);
      }
      bridge.refresh();
      this.emitMcp(bridge);
    }
    await this.refreshPendingMcp();
  }

  private async refreshPendingMcp(): Promise<void> {
    await Promise.all([...this.mcpPending].map(async session => {
      const bridge = this.mcpBridges.get(session);
      if (!bridge || this.disposed || session.isStreaming || (bridge.options.conversationId && this.conversations.get(bridge.options.conversationId)?.driving)) return;
      let loading = this.mcpReloading.get(session);
      if (!loading) {
        const revision = this.mcpRevisions.get(session);
        loading = (async () => {
          try {
            await session.reload();
            // Management binds no UI/actions; Pi therefore does not emit session_start on reload.
            if (this.mcpManagement.get(bridge.options.cwd) === session) await session.bindExtensions({});
            if (revision === this.mcpRevisions.get(session)) this.mcpPending.delete(session);
            const entry = bridge.options.conversationId ? this.conversations.get(bridge.options.conversationId) : undefined;
            if (entry?.session === session) this.applyActiveTools(entry);
            else session.setActiveToolsByName(this.mcpActiveTools(session, bridge.options.nativeTools()));
            this.emitMcp(bridge);
          } catch { /* Preserve pending state so settings and the next idle poll can retry. */ }
          finally { this.mcpReloading.delete(session); }
        })();
        this.mcpReloading.set(session, loading);
      }
      await loading;
    }));
  }

  private async pollMcpChanges(): Promise<void> {
    if (this.mcpPolling || this.disposed) return;
    this.mcpPolling = true;
    try {
      const cwds = new Set([...this.mcpBridges.values()].map(bridge => bridge.options.cwd));
      for (const cwd of cwds) {
        try {
          const change = this.mcpConfig.checkChanges(cwd);
          if (change.changed) await this.applyMcpChanges(cwd, change.configChanged, change.policyChanged);
        } catch { /* Workspace might have been removed. The per-call guard fails closed. */ }
      }
      await this.refreshPendingMcp();
    } finally { this.mcpPolling = false; }
  }

  private closeSession(session: AgentSession): Promise<void> {
    const existing = this.sessionClosings.get(session);
    if (existing) return existing;
    const bridge = this.mcpBridges.get(session);
    session.agent.abort();
    const closing = (async () => {
      try {
        await this.mcpReloading.get(session);
        await bridge?.close();
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      } finally {
        session.dispose();
        this.mcpBridges.delete(session);
        this.mcpPending.delete(session);
        this.mcpRevisions.delete(session);
        for (const [cwd, management] of this.mcpManagement) if (management === session) this.mcpManagement.delete(cwd);
      }
    })();
    this.sessionClosings.set(session, closing);
    void closing.finally(() => this.sessionClosings.delete(session)).catch(() => undefined);
    return closing;
  }

  private mcpActivity(conversationId: string, name: string, activity: ToolActivity): ToolActivity {
    const session = this.conversations.get(conversationId)?.session;
    return session ? this.mcpBridges.get(session)?.decorateActivity(name, activity) ?? activity : activity;
  }

  dispose(): Promise<void> {
    this.disposed = true;
    if (this.checkpointSweep) clearTimeout(this.checkpointSweep);
    this.checkpointSweep = null;
    if (this.mcpPoll) clearInterval(this.mcpPoll);
    this.mcpPoll = null;
    const closing: Promise<void>[] = [...this.sessionStarting.values()].map(starting => starting.then(() => undefined, () => undefined));
    closing.push(this.pluginManager.dispose(), this.oauthMcp.dispose());
    void Promise.resolve().then(() => this.options.browserRepl?.dispose?.()).catch(() => {});
    this.thinkingSummaries.dispose();
    this.textAssist.dispose();
    this.recipeGenerator.dispose();
    this.traces.dispose();
    this.directory?.cancelLogin();
    this.questions.cancelAll();
    for (const entry of this.conversations.values()) closing.push(this.detachEntry(entry));
    for (const session of this.mcpManagement.values()) closing.push(this.closeSession(session));
    for (const pending of this.mcpManagementStarting.values()) closing.push(pending.then(bridge => bridge.session ? this.closeSession(bridge.session) : undefined, () => undefined));
    for (const session of this.mcpBridges.keys()) closing.push(this.closeSession(session));
    this.mcpManagement.clear();
    this.mcpListeners.clear();
    this.conversations.clear();
    this.toolArgs.clear();
    this.toolGoalContexts.clear();
    this.agentToolArgs.clear();
    this.memoryLoads.clear();
    this.activeId = null;
    this.store.flushSync();
    return Promise.allSettled(closing).then(() => undefined);
  }

  private async initialize(): Promise<void> {
    await this.store.load();
    this.restoreConversations();
    this.store.flushSync();
    const directory = await ModelDirectory.open(this.options.agentDir);
    directory.subscribeAuth((event) => {
      for (const listener of this.authListeners) listener(event);
    });
    this.directory = directory;
    directory.refreshCatalogFromNetwork();
    const active = this.activeConversation();
    if (active) this.syncFromSession(active);
  }

  private restoreConversations(): void {
    // 会话文件仍在磁盘上的对话才恢复。新对话在创建时就写入了文件
    // (见 createPersistedSession),所以没有文件的记录只会是历史遗留或已被外部清理的会话。
    for (const stored of this.store.list()) {
      if (this.conversations.has(stored.id)) continue;
      if (!stored.sessionFile || !existsSync(stored.sessionFile)) continue;
      const hasWorkspace = stored.hasWorkspace ?? this.options.isWorkspaceCwd?.(stored.cwd) ?? true;
      if (stored.hasWorkspace === undefined) this.store.update(stored.id, { hasWorkspace });
      const activeExecution = activeExecutionPlan(stored.executionPlans, stored.activeExecutionPlanId);
      const storedAgents = stored.agents?.length ? stored.agents : recoverLegacyAgents(
        SessionManager.open(stored.sessionFile, this.sessionDir(), stored.cwd).buildSessionProjection().messages,
        stored.id,
      );
      this.conversations.set(stored.id, {
        hasWorkspace,
        recipeRunId: stored.recipeRunId,
        recipeExecution: stored.recipeExecution,
        scheduledSandboxMode: stored.recipeExecution?.sandboxMode,
        id: stored.id,
        session: null,
        sessionManager: null,
        sessionFile: stored.sessionFile,
        snapshot: {
          ...this.createSnapshot("ready", stored.cwd),
          id: stored.id,
          title: stored.title,
          mode: stored.mode,
          ...(stored.recipeExecution ? { sandboxMode: stored.recipeExecution.sandboxMode } : {}),
          proposedPlan: cloneProposedPlan(latestPlan(stored.plans)),
          planRevisions: stored.plans.map((plan) => ({ ...plan })),
          executionPlan: cloneExecutionPlan(activeExecution),
          goal: stored.goal,
          tools: this.tools.native(stored.mode, activeExecution !== null),
        },
        titleGenerationStarted: stored.title !== "新对话",
        titleManuallySet: stored.titleManuallySet === true,
        unsubscribe: null,
        createdAt: stored.createdAt,
        updatedAt: stored.updatedAt,
        instructions: stored.instructions,
        skillsRevision: 0,
        stopRequested: false,
        pendingInstructions: [],
        rebuildingInstructions: false,
        driving: false,
        plans: stored.plans,
        latestProposedPlanId: stored.latestProposedPlanId,
        executionPlans: stored.executionPlans,
        activeExecutionPlanId: stored.activeExecutionPlanId,
        planStream: null,
        planStreamPlan: null,
        goalValidationEvidence: new Map(),
        goalValidationSequence: Math.max(0, ...(stored.goal?.validation?.checks.map((check) => check.sequence) ?? [0])),
        generation: { stepStartedAt: null, firstTokenAt: null, outputTokens: 0, elapsedMs: 0 },
        archivedAt: stored.archivedAt,
        control: null,
        storedAgents,
        agentMutationsSeen: new Set(storedAgents.filter((agent) => agent.mutated).map((agent) => agent.id)),
      });
    }
  }

  private async ready(): Promise<void> {
    await this.initializePromise;
  }

  private sessionDir(): string {
    return join(this.options.agentDir, "sessions");
  }

  private childSessionDir(conversationId: string): string {
    return join(this.options.agentDir, "subagents", conversationId);
  }

  private async readyDirectory(): Promise<ModelDirectory> {
    await this.initializePromise;
    if (!this.directory) throw new Error("模型目录没有就绪");
    return this.directory;
  }

  private async generateConversationTitle(
    entry: Conversation,
    text: string,
    fallbackTitle: string,
    model: Model<Api>,
    directory: ModelDirectory,
  ): Promise<void> {
    try {
      const title = await requestConversationTitle(directory.runtime, model, {
        conversationId: entry.id,
        text,
      });
      if (
        !title ||
        entry.titleManuallySet ||
        this.conversations.get(entry.id) !== entry ||
        entry.snapshot.title !== fallbackTitle
      ) {
        return;
      }
      this.patchEntry(entry, { title, updatedAt: Date.now() });
    } catch {
      // 标题生成失败时保留首条消息生成的兜底标题,不影响聊天。
    }
  }

  private activeConversation(): Conversation | null {
    return this.activeId ? this.conversations.get(this.activeId) ?? null : null;
  }

  /** 登记一个新对话并激活;会话本身的启动由调用方负责。 */
  private addEntry(
    cwd: string,
    options: {
      hasWorkspace?: boolean;
      activate?: boolean;
      sessionManager?: SessionManager;
      title?: string;
      mode?: InteractionMode;
      instructions?: string;
      reservedId?: string;
      recipeRunId?: string;
      recipeExecution?: RecipeExecution;
    } = {},
  ): Conversation {
    // 会话文件必须随新对话一起落到磁盘:Pi 默认要等首条回复才创建 JSONL,
    // 空对话会在强制退出后的重启中被当作已清理会话丢掉。
    const sessionManager = options.sessionManager ?? createPersistedSession(cwd, this.sessionDir(), options.reservedId);
    const snapshot = this.createSnapshot("starting", cwd);
    if (options.title) snapshot.title = options.title;
    if (options.mode) snapshot.mode = options.mode;
    if (options.recipeExecution) snapshot.sandboxMode = options.recipeExecution.sandboxMode;
    const entry: Conversation = {
      hasWorkspace: options.hasWorkspace ?? true,
      recipeRunId: options.recipeRunId,
      recipeExecution: options.recipeExecution,
      scheduledSandboxMode: options.recipeExecution?.sandboxMode,
      id: sessionManager.getSessionId(),
      session: null,
      sessionManager,
      sessionFile: sessionManager.getSessionFile() ?? null,
      snapshot,
      titleGenerationStarted: false,
      titleManuallySet: false,
      unsubscribe: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      instructions: options.instructions ?? this.directory?.getSettings().instructions ?? "",
      skillsRevision: this.skills.revision,
      stopRequested: false,
      pendingInstructions: [],
      rebuildingInstructions: false,
      driving: false,
      plans: [],
      latestProposedPlanId: null,
      executionPlans: [],
      activeExecutionPlanId: null,
      planStream: null,
      planStreamPlan: null,
      goalValidationEvidence: new Map(),
      goalValidationSequence: 0,
      generation: { stepStartedAt: null, firstTokenAt: null, outputTokens: 0, elapsedMs: 0 },
      archivedAt: null,
      control: null,
      storedAgents: [],
      agentMutationsSeen: new Set(),
    };
    this.conversations.set(entry.id, entry);
    if (options.activate !== false) this.activeId = entry.id;
    this.persistEntry(entry);
    // 新对话是用户明确创建的状态,不等防抖窗口,立刻同步落盘。
    this.store.flushSync(Boolean(options.reservedId));
    if (options.activate !== false) this.notifyActiveCwd(cwd, entry.hasWorkspace);
    this.emitStatus(entry);
    return entry;
  }

  private async startInternal(entry: Conversation, selection?: { model: Model<Api> | undefined; thinkingLevel: ThinkingLevel }): Promise<SessionSnapshot> {
    if (this.disposed) throw new Error("Vela runtime has closed");
    const existing = this.sessionStarting.get(entry.id);
    if (existing) return existing;
    const starting = this.startInternalOnce(entry, selection);
    this.sessionStarting.set(entry.id, starting);
    try { return await starting; } finally { this.sessionStarting.delete(entry.id); }
  }

  private async startInternalOnce(entry: Conversation, selection?: { model: Model<Api> | undefined; thinkingLevel: ThinkingLevel }): Promise<SessionSnapshot> {
    this.patchEntry(entry, { status: "starting", error: null });
    try {
      const directory = await this.readyDirectory();
      const recipeModel = entry.recipeExecution ? directory.runtime.getModel(entry.recipeExecution.model.provider, entry.recipeExecution.model.id) : undefined;
      const { model: chosen, thinkingLevel } = selection ?? (entry.recipeExecution ? {
        // History remains readable when its original model/account is unavailable.
        model: recipeModel && directory.isAvailable(recipeModel) ? recipeModel : undefined,
        thinkingLevel: entry.recipeExecution.thinkingLevel,
      } : this.conversationSelection(directory));
      const cwd = entry.snapshot.cwd;
      // 新对话:登记时已建或此处新建;恢复的对话:按文件打开以接续历史。
      const sessionManager = entry.sessionManager
        ?? (entry.sessionFile
          ? SessionManager.open(entry.sessionFile, this.sessionDir(), cwd)
          : createPersistedSession(cwd, this.sessionDir()));
      const settingsManager = SettingsManager.inMemory({ defaultTools: this.tools.registered() });
      const instructions = entry.instructions.trim();
      await this.skills.load();
      const mcp = this.createMcpBridge(cwd, entry.id, () => entry.snapshot.mode === "plan");
      const resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir: this.options.agentDir,
        settingsManager,
        skillsOverride: (base) => this.skills.withoutDisabled(base),
        extensionFactories: [{
          name: "vela-mode",
          hidden: true,
          factory: createModeExtension(() => ({
            mode: entry.snapshot.mode,
            hasExecutionPlan: entry.snapshot.executionPlan !== null,
          }), {
            availableTools: (mode, plan) => this.tools.native(mode, plan, entry),
            authorizeCall: call => this.tools.authorize(call, entry),
          }),
        }, { name: "vela-memory", hidden: true, factory: this.memoryExtension(entry, null) }, {
          name: "vela-intelligent-ui",
          hidden: true,
          factory: ((pi) => { pi.on("before_agent_start", event => {
            // 每轮读取当前偏好，设置切换后下一轮立即生效。
            const extra = intelligentUiInstructions(this.intelligentUiSettings.preference, entry.snapshot.mode);
            if (!extra) return;
            const current = event.systemPromptOptions.appendSystemPrompt.trim();
            event.systemPromptOptions.appendSystemPrompt = current ? `${current}\n\n${extra}` : extra;
          }); }) as ExtensionFactory,
        }, ...(this.options.scheduledTasks ? [{ name: "vela-scheduled-tasks-clock", hidden: true,
          factory: ((pi) => { pi.on("before_agent_start", event => {
            event.systemPromptOptions.appendSystemPrompt += `\n\n任务时间上下文：${new Date().toISOString()}；本机时区：${Intl.DateTimeFormat().resolvedOptions().timeZone}`;
          }); }) as ExtensionFactory,
        }] : []), ...mcp.factories()],
        appendSystemPromptOverride: (base) => [
          ...base,
          ...(instructions ? [instructions] : []),
          ...(this.options.scheduledTasks ? [scheduledTaskInstructions] : []),
          ...(this.options.browserRepl ? [browserUseInstructions] : []),
        ],
      });
      await resourceLoader.reload();
      const control = new AgentControl({
        conversationId: entry.id,
        restoredAgents: entry.storedAgents,
        host: {
          createChildSession: (input) => this.createChildSession(entry, input),
          disposeChildSession: (session) => this.closeSession(session),
          toolMutates: (session, name) => this.mcpBridges.get(session)?.isMutation(name) ?? false,
          deliverToRoot: (input) => {
            void this.deliverAgentMessage(entry, input.message);
          },
          onAgentEvent: (input) => this.handleAgentPiEvent(input.conversationId, input.agentId, input.event),
        },
        onChange: (agents) => this.handleAgentsChange(entry, agents),
      });
      let session: AgentSession;
      try {
        const created = await createAgentSession({
          cwd,
          agentDir: this.options.agentDir,
          sessionManager,
          settingsManager,
          resourceLoader,
          modelRuntime: directory.runtime,
          model: chosen,
          thinkingLevel,
          // MCP registers tools after session_start; defaultTools selects the loadout without restricting the registry.
          customTools: [
            ...(this.options.toolFactory?.(cwd, { conversationId: entry.id, sandboxMode: entry.scheduledSandboxMode }) ?? []),
            ...this.browserTools(entry, entry.id),
            ...(this.options.scheduledTasks ? createScheduledTaskTools(this.options.scheduledTasks, cwd, () => entry.snapshot.mode !== "plan") : []),
            ...this.memoryTools(entry, entry.id, true),
            ...createModeTools({
              updateExecutionPlan: (items) => this.updateExecutionPlan(entry, items),
              updateGoal: (status, note) => this.updateGoal(entry, status, note),
              recordGoalValidation: (draft) => this.recordGoalValidation(entry, draft),
              askUser: (input) => this.askUser(entry, input),
            }),
            ...control.createAgentTools(entry.id),
          ],
        });
        session = created.session;
      } catch (error) {
        await control.dispose();
        throw error;
      }
      if (this.disposed || !this.conversations.has(entry.id)) {
        mcp.attach(session);
        await mcp.close();
        session.dispose();
        await control.dispose();
        throw new Error("Vela runtime has closed");
      }
      // 没有显式选择时，Pi 会挑第一个带本机环境变量的模型。这里清掉，只保留用户在 Vela 里选的模型。
      if (!chosen) clearSessionModel(session);
      mcp.attach(session);
      this.mcpBridges.set(session, mcp);
      this.attachEntry(entry, session, sessionManager);
      entry.control = control;
      await session.bindExtensions({ onError: event => { log.debug("extension error", event.event); } });
      if (this.disposed) { await this.closeSession(session); await control.dispose(); throw new Error("Vela runtime has closed"); }
      control.registerRoot(session);
      entry.skillsRevision = this.skills.revision;
      this.syncFromSession(entry);
      this.applyActiveTools(entry);
      this.patchEntry(entry, {
        status: "ready",
        id: session.sessionId,
        error: null,
      });
    } catch (error) {
      log.warn("session start failed", error);
      await this.detachEntry(entry);
      this.patchEntry(entry, {
        status: "error",
        id: null,
        error: error instanceof Error ? error.message : "无法启动会话",
      });
    }
    return this.getSnapshot();
  }

  /**
   * 新对话(以及懒启动的会话)使用哪个模型和思考强度:
   * 「设置默认」取设置页的默认选择,「上次使用」取最近一次在对话中用过的选择,
   * 上次使用的模型不可用时回退到设置默认。
   */
  private conversationSelection(directory: ModelDirectory): { model: Model<Api> | undefined; thinkingLevel: ThinkingLevel } {
    if (directory.selection.newConversationSelection === "lastUsed") {
      const lastUsed = directory.availableLastUsed();
      if (lastUsed) {
        return { model: lastUsed, thinkingLevel: clampToModel(lastUsed, directory.lastUsedThinkingLevel()) };
      }
    }
    const model = directory.availableSelection();
    return {
      model,
      thinkingLevel: model ? clampToModel(model, directory.selection.thinkingLevel) : directory.selection.thinkingLevel,
    };
  }

  /** 把当前对话正在使用的模型与思考强度记为「上次使用」;没有会话时不动。 */
  private async rememberActiveSelection(): Promise<void> {
    const directory = this.directory;
    const session = this.activeConversation()?.session;
    if (!directory || !session?.model) return;
    await directory.rememberLastUsed(session.model.provider, session.model.id, session.thinkingLevel);
  }

  private async applySavedModel(): Promise<void> {
    const directory = this.directory;
    if (!directory) return;
    const { model: chosen, thinkingLevel } = this.conversationSelection(directory);
    if (!chosen) {
      const active = this.activeConversation();
      if (active) this.syncFromSession(active);
      return;
    }
    await this.applyModel(chosen, thinkingLevel);
  }

  private async applyModel(model: Model<Api>, thinkingLevel: ThinkingLevel): Promise<void> {
    const entry = this.activeConversation();
    const session = entry?.session;
    if (!entry || !session) return;
    if (entry.recipeWorkflowActive) throw new Error("配方执行期间不能更换模型或思考强度");
    const current = session.model;
    if (!current || current.provider !== model.provider || current.id !== model.id) {
      await session.setModel(model);
    }
    session.setThinkingLevel(thinkingLevel);
    if (entry.recipeExecution) entry.recipeExecution = { ...entry.recipeExecution, model: { provider: model.provider, id: model.id }, thinkingLevel };
    this.syncFromSession(entry);
  }

  private attachEntry(
    entry: Conversation,
    session: AgentSession,
    sessionManager: SessionManager,
  ): void {
    entry.session = session;
    entry.sessionManager = sessionManager;
    entry.sessionFile = sessionManager.getSessionFile() ?? entry.sessionFile;
    entry.unsubscribe = subscribeTracedSession(session, this.trace(entry.id), (event) => this.handlePiEvent(entry.id, event));
  }

  private async detachEntry(entry: Conversation): Promise<void> {
    entry.unsubscribe?.();
    entry.unsubscribe = null;
    const control = entry.control;
    const session = entry.session;
    entry.control = null;
    entry.session = null;
    await Promise.all([control?.dispose(), session ? this.closeSession(session) : undefined]);
  }

  private handlePiEvent(conversationId: string, event: AgentSessionEvent): void {
    const recorder = this.trace(conversationId);
    recorder.capture(() => recorder.handle(event));
    // Pi 在消费 steering / follow-up 时更新队列;这里同步运行中指令的“已投递”状态。
    if (event.type === "queue_update") {
      this.reconcileInstructions(conversationId, event.steering, event.followUp);
      return;
    }
    // agent 循环里每步 assistant 消息都要在界面上独立成块;user/toolResult 的 message_start 不是边界。
    if (event.type === "message_start" && event.message.role === "assistant") {
      const entry = this.conversations.get(conversationId);
      if (entry) {
        entry.generation.stepStartedAt = Date.now();
        entry.generation.firstTokenAt = null;
        // 每条 assistant 消息独立解析，plan 块不跨消息。
        entry.planStream = createPlanStreamParser();
        entry.planStreamPlan = null;
      }
      this.emit({ type: "assistant_start", conversationId });
      return;
    }
    if (event.type === "message_end") {
      if (event.message.role === "assistant") {
        const entry = this.conversations.get(conversationId);
        const stream = entry?.planStream;
        if (entry && stream) {
          entry.planStream = null;
          // 用户停止时丢弃未完成的草稿，不生成半截 revision。
          if (!entry.stopRequested) {
            for (const streamEvent of stream.flush()) this.emitPlanStream(entry, streamEvent);
          }
          entry.planStreamPlan = null;
        }
      }
      this.recordGeneration(conversationId, event.message);
      return;
    }
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      const entry = this.conversations.get(conversationId);
      if (update.type === "text_delta" || update.type === "thinking_delta") {
        // 首字到达前的等待属于提示词处理,不计入生成速度。
        if (entry && entry.generation.firstTokenAt === null) entry.generation.firstTokenAt = Date.now();
      }
      if (update.type === "text_delta") {
        if (entry?.planStream) {
          // <proposed_plan> 之外的文本仍然按普通 assistant 文本输出。
          for (const streamEvent of entry.planStream.push(update.delta)) this.emitPlanStream(entry, streamEvent);
        } else {
          this.emit({ type: "text_delta", conversationId, delta: update.delta });
        }
      } else if (update.type === "thinking_delta") {
        this.emit({ type: "thinking_delta", conversationId, delta: update.delta });
      }
      return;
    }

    if (event.type === "tool_execution_start") {
      const entry = this.conversations.get(conversationId);
      const goalBeforeTool = entry?.snapshot.goal;
      const hasFreshValidation = Boolean(
        goalBeforeTool && goalBeforeTool.validation?.workRevision === goalBeforeTool.workRevision,
      );
      if (
        entry && goalBeforeTool && goalBeforeTool.status !== "complete" && (isPotentialGoalMutation(event.toolName, event.args) || (entry.session && this.mcpBridges.get(entry.session)?.isMutation(event.toolName))) &&
        (event.toolName !== "bash" || hasFreshValidation)
      ) {
        this.advanceGoalWorkRevision(entry);
      }
      const goal = entry?.snapshot.goal;
      if (entry?.snapshot.mode === "goal" && goal?.status === "active") {
        this.toolGoalContexts.set(event.toolCallId, { goalId: goal.id, workRevision: goal.workRevision });
      }
      this.toolArgs.set(event.toolCallId, event.args);
      this.emit({
        type: "tool_start",
        conversationId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        activity: this.mcpActivity(conversationId, event.toolName, activityFromCall(event.toolName, event.args)),
      });
      return;
    }

    if (event.type === "tool_execution_update") {
      const activity = activityFromOutput(event.partialResult, event.toolName);
      if (!activity) return;
      this.emit({ type: "tool_output", conversationId, toolCallId: event.toolCallId, activity: this.mcpActivity(conversationId, event.toolName, activity) });
      return;
    }

    if (event.type === "tool_execution_end") {
      const args = this.toolArgs.get(event.toolCallId);
      this.toolArgs.delete(event.toolCallId);
      const goalContext = this.toolGoalContexts.get(event.toolCallId);
      this.toolGoalContexts.delete(event.toolCallId);
      const activity = this.mcpActivity(conversationId, event.toolName, activityFromExecution(event.toolName, args, event.result, toolResultIsError(event.toolName, event.result, event.isError)));
      const entry = this.conversations.get(conversationId);
      const goal = entry?.snapshot.goal;
      if (entry && goalContext && event.toolName === "bash" && goal?.id === goalContext.goalId) {
        const command = activity.command?.trim();
        if (command) {
          entry.goalValidationSequence += 1;
          entry.goalValidationEvidence.set(event.toolCallId, {
            toolCallId: event.toolCallId,
            command: command.slice(0, 1000),
            result: toolResultIsError(event.toolName, event.result, event.isError) ? "failed" : "passed",
            output: (activity.body ?? "").slice(0, 1200),
            completedAt: Date.now(),
            sequence: entry.goalValidationSequence,
            workRevision: goalContext.workRevision,
          });
        }
      }
      this.emit({
        type: "tool_end",
        conversationId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        isError: toolResultIsError(event.toolName, event.result, event.isError),
        activity,
      });
    }
  }

  /**
   * 子代理会话事件的翻译：只管自己的运行流，不碰主对话的标题、Goal 和生成统计。
   * 事件带 agentId 发给渲染层，右侧 Agent Pane 据此按 agent 分桶实时渲染。
   */
  private handleAgentPiEvent(conversationId: string, agentId: string, event: AgentSessionEvent): void {
    const emit = (streamEvent: AgentRuntimeStreamEvent): void => {
      const child = this.conversations.get(conversationId)?.control?.getSession(agentId);
      if ((streamEvent.type === "tool_start" || streamEvent.type === "tool_output" || streamEvent.type === "tool_end") && child) {
        const name = "toolName" in streamEvent ? streamEvent.toolName : event.type === "tool_execution_update" ? event.toolName : "";
        streamEvent = { ...streamEvent, activity: this.mcpBridges.get(child)?.decorateActivity(name, streamEvent.activity) ?? streamEvent.activity };
      }
      this.emit({ type: "agent_event", conversationId, agentId, event: streamEvent });
    };
    if (event.type === "message_start" && event.message.role === "assistant") {
      emit({ type: "assistant_start" });
      return;
    }
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (update.type === "text_delta") emit({ type: "text_delta", delta: update.delta });
      else if (update.type === "thinking_delta") emit({ type: "thinking_delta", delta: update.delta });
      return;
    }
    if (event.type === "message_end") {
      const message = event.message;
      if (message.role === "user") {
        const text = userMessageText(message);
        if (text.trim()) emit({ type: "user_message", text });
        return;
      }
      const failure = message.role === "assistant" ? message.errorMessage?.trim() : undefined;
      if (failure) emit({ type: "error", message: failure });
      return;
    }
    if (event.type === "tool_execution_start") {
      this.agentToolArgs.set(event.toolCallId, event.args);
      emit({
        type: "tool_start",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        activity: activityFromCall(event.toolName, event.args),
      });
      return;
    }
    if (event.type === "tool_execution_update") {
      const activity = activityFromOutput(event.partialResult, event.toolName);
      if (activity) emit({ type: "tool_output", toolCallId: event.toolCallId, activity });
      return;
    }
    if (event.type === "tool_execution_end") {
      const args = this.agentToolArgs.get(event.toolCallId);
      this.agentToolArgs.delete(event.toolCallId);
      emit({
        type: "tool_end",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        isError: toolResultIsError(event.toolName, event.result, event.isError),
        activity: activityFromExecution(event.toolName, args, event.result, toolResultIsError(event.toolName, event.result, event.isError)),
      });
    }
  }

  /**
   * 一步 assistant 消息结束后累计输出 token 与生成耗时,输入框统计条的 tok/s 由两者算出。
   * 首字之前的时间是提示词处理,不参与统计;没走流式的兜底路径在同一个事件循环里
   * start/end,计时不足一瞬,计入会把平均速度拉飞,所以过短的一步直接丢掉。
   */
  private recordGeneration(conversationId: string, message: AgentMessage): void {
    if (message.role !== "assistant") return;
    const entry = this.conversations.get(conversationId);
    if (!entry) return;
    const { stepStartedAt, firstTokenAt } = entry.generation;
    entry.generation.stepStartedAt = null;
    entry.generation.firstTokenAt = null;
    const output = message.usage?.output ?? 0;
    if (stepStartedAt === null || output <= 0) return;
    const elapsed = Date.now() - (firstTokenAt ?? stepStartedAt);
    if (elapsed < 200) return;
    entry.generation.outputTokens += output;
    entry.generation.elapsedMs += elapsed;
    // 每步结算后推一次状态,统计条的 tok/s 不必等到工具边界才更新。
    this.emitStatus(entry);
  }

  private syncFromSession(entry: Conversation): void {
    const directory = this.directory;
    const session = entry.session;
    const active = session?.model;
    const intended = active ?? (entry.recipeExecution ? directory?.runtime.getModel(entry.recipeExecution.model.provider, entry.recipeExecution.model.id) : directory?.modelForSelection());
    const thinkingLevel = active && session
      ? session.thinkingLevel
      : entry.recipeExecution?.thinkingLevel ?? directory?.selection.thinkingLevel ?? "medium";
    entry.snapshot = {
      ...entry.snapshot,
      model: intended ? modelLabel(intended) : entry.recipeExecution ? `${entry.recipeExecution.model.provider}/${entry.recipeExecution.model.id}` : null,
      modelProvider: intended?.provider ?? entry.recipeExecution?.model.provider ?? null,
      modelId: intended?.id ?? entry.recipeExecution?.model.id ?? null,
      modelReady: Boolean(active && directory?.isAvailable(active)),
      thinkingLevel: isThinkingLevel(thinkingLevel) ? thinkingLevel : "medium",
      thinkingLevels: intended ? levelsFor(intended) : ["off"],
    };
    this.emitStatus(entry);
  }

  private failPrompt(entry: Conversation, message: string): void {
    const recorder = this.trace(entry.id);
    recorder.capture(() => { recorder.fail(message); recorder.settle("Failed"); });
    this.emit({ type: "error", conversationId: entry.id, message });
    this.patchEntry(entry, { status: "ready", error: null });
  }

  private patchEntry(entry: Conversation, patch: Partial<SessionSnapshot> & { updatedAt?: number }): void {
    if (patch.status === "streaming" && entry.snapshot.status !== "streaming") {
      const startedAt = Date.now();
      entry.activeTurn = { startedAt, leafId: entry.sessionManager?.getLeafId() ?? null };
      patch = { ...patch, turnStartedAt: startedAt, turnCompletedAt: undefined };
    } else if (patch.status && patch.status !== "streaming" && entry.activeTurn) {
      const completedAt = Date.now();
      const { startedAt, leafId } = entry.activeTurn;
      const manager = entry.sessionManager;
      const branch = manager?.getBranch() ?? [];
      const start = leafId ? branch.findIndex(item => item.id === leafId) + 1 : 0;
      const assistant = branch.slice(start).findLast(item => item.type === "message" &&
        item.message.role === "assistant" && isVisibleTranscriptMessage(item.message as AgentMessage));
      if (assistant) manager?.appendCustomEntry(turnTimingEntryType, { assistantEntryId: assistant.id, startedAt, completedAt });
      entry.activeTurn = undefined;
      patch = { ...patch, turnCompletedAt: completedAt };
    }
    entry.snapshot = {
      ...entry.snapshot,
      ...patch,
      tools: patch.tools ? [...patch.tools] : entry.snapshot.tools,
      thinkingLevels: patch.thinkingLevels ? [...patch.thinkingLevels] : entry.snapshot.thinkingLevels,
    };
    if (patch.updatedAt !== undefined) entry.updatedAt = patch.updatedAt;
    this.persistEntry(entry);
    this.emitStatus(entry);
  }

  private touchEntry(entry: Conversation): void {
    entry.updatedAt = Date.now();
    this.persistEntry(entry);
  }

  private persistEntry(entry: Conversation): void {
    this.store.put({
      id: entry.id,
      cwd: entry.snapshot.cwd,
      hasWorkspace: entry.hasWorkspace,
      title: entry.snapshot.title,
      titleManuallySet: entry.titleManuallySet,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      messageCount: this.store.get(entry.id)?.messageCount ?? 0,
      toolCallCount: this.store.get(entry.id)?.toolCallCount ?? 0,
      sessionFile: entry.sessionFile,
      instructions: entry.instructions,
      mode: entry.snapshot.mode,
      plans: entry.plans,
      latestProposedPlanId: entry.latestProposedPlanId,
      executionPlans: entry.executionPlans,
      activeExecutionPlanId: entry.activeExecutionPlanId,
      goal: entry.snapshot.goal,
      archivedAt: entry.archivedAt,
      agents: entry.storedAgents,
      ...(entry.recipeRunId ? { recipeRunId: entry.recipeRunId, recipeExecution: entry.recipeExecution } : {}),
    });
  }

  /** 激活对话的 cwd 变化时通知宿主(工作区/界面状态跟随会话)。 */
  private notifyActiveCwd(cwd: string, hasWorkspace: boolean): void {
    if (cwd === this.currentCwd && hasWorkspace === this.currentHasWorkspace) return;
    this.currentCwd = cwd;
    this.currentHasWorkspace = hasWorkspace;
    this.options.onActiveCwd?.(cwd, hasWorkspace);
  }

  private emitStatus(entry: Conversation): void {
    this.emit({ type: "status", conversationId: entry.id });
  }

  /** 当前对话自己的思考强度;没有会话时用新建对话的默认值。 */
  private liveThinking(directory: ModelDirectory): ThinkingLevel {
    const sessionLevel = this.activeConversation()?.session?.thinkingLevel;
    if (typeof sessionLevel === "string" && isThinkingLevel(sessionLevel)) return sessionLevel;
    return directory.selection.thinkingLevel;
  }

  private redactMcpForConversation<T>(conversationId: string, value: T): T {
    const entry = this.conversations.get(conversationId);
    const bridge = entry?.session ? this.mcpBridges.get(entry.session) : undefined;
    if (bridge) return bridge.redact(value);
    if (!entry) return value;
    try {
      const secrets = [...this.mcpConfig.configuredSecrets(entry.snapshot.cwd), ...mcpConfiguredSecrets(this.mcpConfig.loadConfigSync(entry.snapshot.cwd).servers.map(item => item.config))];
      return redactMcpDisplay(value, secrets) as T;
    } catch { return value; }
  }

  private decorateMcpTranscript(conversationId: string, session: AgentSession | null, messages: TranscriptMessage[]): TranscriptMessage[] {
    const bridge = session ? this.mcpBridges.get(session) : undefined;
    return messages.map(message => ({ ...message, tools: message.tools.map(tool => ({ ...tool,
      activity: bridge?.decorateActivity(tool.name, tool.activity) ?? (isMcpTool(tool.name) ? this.redactMcpForConversation(conversationId, tool.activity) : tool.activity),
    })) }));
  }

  private emit(event: RuntimeEvent): void {
    if (event.type === "trace") event = this.redactMcpForConversation(event.conversationId, event);
    for (const listener of this.listeners) listener(event);
  }

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.gate.then(task, task);
    this.gate = run.then(() => undefined, () => undefined);
    return run;
  }

  private createSnapshot(status: SessionStatus, cwd = this.currentCwd): SessionSnapshot {
    return {
      id: null,
      title: "新对话",
      status,
      cwd,
      model: null,
      modelProvider: null,
      modelId: null,
      modelReady: false,
      thinkingLevel: "medium",
      thinkingLevels: ["off"],
      tools: [...defaultToolNames],
      mode: "agent",
      proposedPlan: null,
      planRevisions: [],
      executionPlan: null,
      goal: null,
      memory: [],
      error: null,
      pendingInstructions: [],
    };
  }

  private requireIdle(conversationId: string, recipeInvocation = false): Conversation {
    const entry = this.conversations.get(conversationId);
    const session = entry?.session;
    if (!entry || !session) throw new Error("对话不存在或已结束");
    if (entry.recipeWorkflowActive && !recipeInvocation) throw new Error("配方阶段正在执行或等待审批，请先停止任务");
    if (this.rewindingWorkspaces.has(entry.snapshot.cwd)) throw new Error("工作区正在回退消息，请稍后再发送");
    if (entry.driving || session.isStreaming) throw new Error("上一个回复还在进行中");
    if (!session.model || !this.directory?.isAvailable(session.model)) {
      throw new Error("先选择一个已登录或已配置密钥的模型");
    }
    return entry;
  }

  private async drive(
    entry: Conversation,
    text: string,
    images: ImageAttachment[] | undefined,
    options: { autonomous: boolean; announce: boolean; hidden?: boolean; rename: boolean },
  ): Promise<void> {
    entry.stopRequested = false;
    entry.driving = true;
    entry.control?.setRootStatus("running");
    let current: { text: string; images?: ImageAttachment[]; hidden?: boolean } | null = {
      text,
      images,
      hidden: options.hidden,
    };
    let announce = options.announce;
    let rename = options.rename;
    let continuations = 0;
    try {
      // Skill 有变更时，先刷新系统提示和技能命令再发言。
      await this.refreshEntrySkills(entry);
      while (current) {
        if (entry.stopRequested) {
          this.pauseGoal(entry, null);
          return;
        }
        if (announce) {
          this.addUsage(entry.id, 1, 0);
          if (!current.hidden) this.emit({ type: "user_message", conversationId: entry.id, text: current.text });
        }
        const outcome = await this.runSinglePrompt(entry, current.text, current.images, {
          rename,
          release: !options.autonomous,
        });
        announce = true;
        rename = false;
        if (!options.autonomous || entry.snapshot.mode !== "goal") return;
        if (entry.stopRequested || outcome === "aborted") {
          this.pauseGoal(entry, null);
          return;
        }
        if (outcome === "error") {
          this.pauseGoal(entry, null);
          return;
        }
        if (entry.snapshot.goal?.status !== "active") return;
        if (continuations >= goalTurnLimit) {
          this.pauseGoal(entry, goalTurnLimitNote);
          return;
        }
        continuations += 1;
        current = { text: goalContinuePrompt };
      }
    } finally {
      if (options.hidden) {
        try { await this.finishLatestCheckpoint(entry); }
        catch (error) { this.failPrompt(entry, error instanceof Error ? error.message : "无法保存文件检查点"); }
      }
      this.emit({ type: "prompt_end", conversationId: entry.id, status: entry.stopRequested ? "stopped" : entry.snapshot.error ? "failed" : "responded",
        ...(entry.snapshot.error ? { error: entry.snapshot.error } : {}), planPending: entry.snapshot.mode === "plan" && entry.plans.length > 0 });
      entry.driving = false;
      await this.refreshPendingMcp();
      entry.control?.setRootStatus(entry.stopRequested ? "aborted" : "idle");
      if (entry.snapshot.status === "streaming") {
        this.patchEntry(entry, { status: "ready", updatedAt: Date.now() });
      }
    }
  }

  private async runSinglePrompt(
    entry: Conversation,
    text: string,
    images: ImageAttachment[] | undefined,
    options: { rename: boolean; release: boolean },
  ): Promise<"ok" | "error" | "aborted"> {
    const session = entry.session;
    if (!session) {
      this.failPrompt(entry, "对话不存在或已结束");
      return "error";
    }
    if (entry.stopRequested) return "aborted";
    this.overlappingCheckpointRuns.delete(entry.id);
    for (const other of this.conversations.values()) {
      if (other.id !== entry.id && other.snapshot.cwd === entry.snapshot.cwd && (other.driving || other.session?.isStreaming ||
        other.control?.list().some(agent => agent.kind !== "root" && isAgentBusy(agent.status)))) {
        this.overlappingCheckpointRuns.add(entry.id);
        this.overlappingCheckpointRuns.add(other.id);
      }
    }
    const previousError = readSessionError(session);
    let checkpoint: TurnCheckpoint<RewindMetadata> | null = null;
    this.patchEntry(entry, {
      status: "streaming",
      error: null,
      title: options.rename && !entry.titleManuallySet && entry.snapshot.title === "新对话" ? clipTitle(text) : entry.snapshot.title,
      updatedAt: Date.now(),
    });
    try {
      if (!isPlanExecutionPrompt(text)) {
        checkpoint = await this.checkpoints(entry).begin(session.sessionManager.getLeafId(), structuredClone({
          plans: entry.plans, latestProposedPlanId: entry.latestProposedPlanId,
          executionPlans: entry.executionPlans, activeExecutionPlanId: entry.activeExecutionPlanId,
          goal: entry.snapshot.goal, agents: entry.storedAgents,
          agentLeaves: Object.fromEntries(entry.storedAgents.map(agent => [agent.id,
            agent.sessionFile && existsSync(agent.sessionFile)
              ? SessionManager.open(agent.sessionFile, this.childSessionDir(entry.id), entry.snapshot.cwd).getLeafId() : null,
          ])),
        }));
      }
      await session.prompt(
        text,
        images && images.length > 0
          ? {
              images: images.map((image) => ({
                type: "image" as const,
                data: image.data,
                mimeType: image.mimeType,
              })),
            }
          : undefined,
      );
      if (entry.stopRequested) {
        this.patchEntry(entry, { status: "ready", updatedAt: Date.now() });
        return "aborted";
      }
      const failure = readSessionError(session);
      if (failure && failure !== previousError) {
        this.trace(entry.id).settle("Failed");
        this.failPrompt(entry, failure);
        return "error";
      }
      this.trace(entry.id).settle("Completed");
      this.patchEntry(entry, {
        status: options.release ? "ready" : "streaming",
        error: null,
        updatedAt: Date.now(),
      });
      return "ok";
    } catch (error) {
      if (entry.stopRequested) {
        this.patchEntry(entry, { status: "ready", updatedAt: Date.now() });
        return "aborted";
      }
      const failureMessage = error instanceof Error ? error.message : "会话执行失败";
      this.trace(entry.id).fail(failureMessage);
      this.trace(entry.id).settle("Failed");
      this.failPrompt(entry, failureMessage);
      return "error";
    } finally {
      if (checkpoint) {
        const branch = session.sessionManager.getBranch();
        const start = checkpoint.leaf ? branch.findIndex(item => item.id === checkpoint!.leaf) + 1 : 0;
        const user = branch.slice(start).find(item => item.type === "message" && item.message.role === "user" && isVisibleTranscriptMessage(item.message as AgentMessage));
        if (user) {
          if (this.overlappingCheckpointRuns.has(entry.id)) checkpoint.unavailableReason = "这轮执行时有其他对话同时更改工作区，无法安全回退";
          await this.checkpoints(entry).finish(checkpoint, user.id);
          await this.checkpoints(entry).prune(defaultCheckpointPolicy.maxPointsPerConversation).catch(() => undefined);
        }
      }
    }
  }

  /**
   * 为 agent 树创建子会话：独立 Pi 会话、独立上下文，继承父会话的模型、思考强度、
   * 沙箱工具和指令；explore 追加只读守卫并只保留只读工具。
   */
  private async createChildSession(entry: Conversation, input: AgentSessionRequest): Promise<AgentSession> {
    const directory = await this.readyDirectory();
    const parentSession = input.parentSession;
    const model = parentSession.model;
    if (!model || !directory.isAvailable(model)) {
      throw new Error("先选择一个已登录或已配置密钥的模型");
    }
    const cwd = entry.snapshot.cwd;
    const childNativeTools = () => this.tools.child(input.kind);
    const settingsManager = SettingsManager.inMemory({ defaultTools: childNativeTools() });
    const instructions = entry.instructions.trim();
    const mcp = this.createMcpBridge(cwd, entry.id, () => input.kind === "explore" || entry.snapshot.mode === "plan", childNativeTools);
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: this.options.agentDir,
      settingsManager,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noExtensions: true,
      extensionFactories: [
        ...(input.kind === "explore" ? [{ name: "vela-explore", hidden: true, factory: createExploreGuardExtension() }] : []),
        ...(input.beforeToolCall ? [{ name: "vela-agent-pause", hidden: true, factory: createAgentPauseExtension(input.beforeToolCall) }] : []),
        { name: "vela-memory", hidden: true, factory: this.memoryExtension(entry, input.agentId) },
        ...mcp.factories(),
      ],
      appendSystemPromptOverride: (base) => [
        ...base,
        ...(instructions ? [instructions] : []),
        agentKindPrompt(input.kind),
        ...(this.options.browserRepl && input.kind === "general" ? [browserUseInstructions] : []),
      ],
    });
    await resourceLoader.reload();
    // 子代理独立落盘；恢复时沿用自己的历史，新建时才复制 fork 上下文。
    const sessionDir = this.childSessionDir(entry.id);
    const restoring = input.sessionFile && existsSync(input.sessionFile);
    const sessionManager = restoring
      ? SessionManager.open(input.sessionFile!, sessionDir, cwd)
      : createPersistedSession(cwd, sessionDir);
    if (!restoring) {
      for (const message of input.forkMessages) {
        sessionManager.appendMessage(message as Parameters<SessionManager["appendMessage"]>[0]);
      }
    }
    const sandboxTools = this.options.toolFactory?.(cwd, { conversationId: entry.id, sandboxMode: entry.scheduledSandboxMode }) ?? [];
    const childSandboxTools = input.kind === "explore"
      ? sandboxTools.filter((tool) => tool.name === "bash" || tool.name === "read")
      : sandboxTools;
    const { session } = await createAgentSession({
      cwd,
      agentDir: this.options.agentDir,
      model,
      thinkingLevel: parentSession.thinkingLevel,
      modelRuntime: directory.runtime,
      sessionManager,
      settingsManager,
      resourceLoader,

      customTools: [
        ...childSandboxTools,
        ...input.customTools,
        ...this.memoryTools(entry, input.agentId, false),
        ...(input.kind === "general" ? this.browserTools(entry, input.agentId, input.kind) : []),
      ],
    });
    mcp.attach(session);
    if (this.disposed) { await mcp.close(); session.dispose(); throw new Error("Vela runtime has closed"); }
    this.mcpBridges.set(session, mcp);
    try { await session.bindExtensions({}); }
    catch (error) { await this.closeSession(session); throw error; }
    session.setActiveToolsByName(this.mcpActiveTools(session, childNativeTools()));
    session.setSessionName(input.path);
    return session;
  }

  private handleAgentsChange(entry: Conversation, agents: AgentInfo[]): void {
    entry.storedAgents = entry.control?.storedAgents() ?? entry.storedAgents;
    this.persistEntry(entry);
    this.emit({ type: "agents", conversationId: entry.id, agents });
    // 子代理改完工作区后，按一次修订推进 Goal 验证的有效性。
    for (const agent of agents) {
      if (agent.kind === "root" || !agent.mutated || isAgentBusy(agent.status)) continue;
      if (entry.agentMutationsSeen.has(agent.id)) continue;
      entry.agentMutationsSeen.add(agent.id);
      if (entry.snapshot.goal) this.advanceGoalWorkRevision(entry);
    }
  }

  /**
   * 子代理结论/消息进入 root 会话：主代理空闲就自动唤醒继续处理，运行中作为
   * follow-up 追加，用户已停止则只进上下文不唤醒。
   */
  private async deliverAgentMessage(entry: Conversation, message: AgentRootMessage): Promise<void> {
    const session = entry.session;
    if (!session) return;
    const payload = {
      customType: message.kind === "result" ? "vela_agent_result" : "vela_agent_message",
      content: formatAgentRootMessage(message),
      display: false,
      details: {
        agentId: message.agentId,
        path: message.path,
        kind: message.agentKind,
        status: message.status ?? null,
      },
    };
    if (entry.stopRequested) {
      await this.sendAgentMessageSafely(session, payload, { triggerTurn: false });
      return;
    }
    if (entry.driving || session.isStreaming) {
      await this.sendAgentMessageSafely(
        session,
        payload,
        session.isStreaming ? { deliverAs: "followUp", triggerTurn: true } : { triggerTurn: false },
      );
      return;
    }
    entry.driving = true;
    this.patchEntry(entry, { status: "streaming", error: null, updatedAt: Date.now() });
    entry.control?.setRootStatus("running");
    try {
      await session.sendCustomMessage(payload, { triggerTurn: true });
    } catch (error) {
      this.failPrompt(entry, error instanceof Error ? error.message : "子代理结论投递失败");
    } finally {
      try { await this.finishLatestCheckpoint(entry); }
      catch (error) { this.failPrompt(entry, error instanceof Error ? error.message : "无法保存文件检查点"); }
      this.emit({ type: "prompt_end", conversationId: entry.id, status: entry.stopRequested ? "stopped" : entry.snapshot.error ? "failed" : "responded",
        ...(entry.snapshot.error ? { error: entry.snapshot.error } : {}), planPending: entry.snapshot.mode === "plan" && entry.plans.length > 0 });
      entry.driving = false;
      await this.refreshPendingMcp();
      entry.control?.setRootStatus(entry.stopRequested ? "aborted" : "idle");
      if (entry.snapshot.status === "streaming") {
        this.patchEntry(entry, { status: "ready", updatedAt: Date.now() });
      }
    }
  }

  /** 投递失败只记日志，不让子代理完成事件把主循环弄挂。 */
  private async sendAgentMessageSafely(
    session: AgentSession,
    payload: Parameters<AgentSession["sendCustomMessage"]>[0],
    options?: Parameters<AgentSession["sendCustomMessage"]>[1],
  ): Promise<void> {
    try {
      await session.sendCustomMessage(payload, options);
    } catch (error) {
      log.debug("subagent message delivery failed", error);
    }
  }

  private browserTools(entry: Conversation, agentId: string, kind?: SubagentKind): ToolDefinition[] {
    if (kind === "explore" || !this.options.browserRepl) return [];
    const permission = this.options.browserReplPermission;
    return createBrowserTools({
      service: this.options.browserRepl,
      permission: permission
        ? { request: input => permission.request({ ...input, conversationId: entry.id, sandboxMode: entry.scheduledSandboxMode }) }
        : undefined,
      conversationId: entry.id, agentId, cwd: entry.snapshot.cwd,
      turnId: () => `${entry.id}:${entry.activeTurn?.startedAt ?? entry.snapshot.turnStartedAt ?? "idle"}`,
      allowed: () => entry.snapshot.mode !== "plan",
    });
  }

  /**
   * 最近一次加载的记忆来源状态；不含正文，可供设置页或状态提示读取。
   * agentId 为空表示根会话。
   */
  getMemoryStatus(conversationId: string, agentId?: string): MemoryLoadReport[] {
    return (this.memoryLoads.get(agentId ? `${conversationId}/${agentId}` : conversationId) ?? []).map((source) => ({ ...source }));
  }

  getIntelligentUiSettings(): { preference: UiPreference } {
    return { preference: this.intelligentUiSettings.preference };
  }

  setIntelligentUiPreference(preference: UiPreference): { preference: UiPreference } {
    this.intelligentUiSettings.setPreference(preference);
    return this.getIntelligentUiSettings();
  }

  getMemorySettings(): { enabled: boolean } {
    return { enabled: this.memorySettings.enabled };
  }

  setMemoryEnabled(enabled: boolean): { enabled: boolean } {
    this.memorySettings.setEnabled(enabled);
    if (!enabled) this.memoryLoads.clear();
    for (const entry of this.conversations.values()) {
      if (!enabled) this.patchEntry(entry, { memory: [] });
      this.applyActiveTools(entry);
    }
    return this.getMemorySettings();
  }

  /**
   * 根会话和子代理共用同一套加载实现。
   * 项目绑定始终取会话自己的工作区；子代理跟随所属根会话，
   * 不会因为界面当前选中的工作区不同而读取别的项目。
   */
  private memoryExtension(entry: Conversation, agentId: string | null): ExtensionFactory {
    const key = agentId ? `${entry.id}/${agentId}` : entry.id;
    return createMemoryContextExtension({
      service: this.memory,
      enabled: () => this.memorySettings.enabled,
      instructions: () => !this.memorySettings.enabled ? memoryDisabledInstructions
        : agentId || !this.tools.canUpdateMemory(entry) ? memoryReadOnlyInstructions : memoryInstructions,
      workspace: () => ({ cwd: entry.snapshot.cwd, hasWorkspace: entry.hasWorkspace }),
      onLoad: (sources) => {
        this.memoryLoads.set(key, sources);
        // 只在根会话上写快照；子代理的加载状态由 getMemoryStatus 按 agentId 提供。
        if (!agentId) this.patchEntry(entry, { memory: sources });
      },
    });
  }

  /**
   * 创建会话自己的记忆工具。update 为 false 的子代理只拿到 memory_read；
   * 写入权限通过 options.memoryPermission 复用现有沙箱写权限。
   */
  private memoryTools(entry: Conversation, agentId: string, update: boolean): ToolDefinition[] {
    return createMemoryTools({
      service: this.memory,
      enabled: () => this.memorySettings.enabled,
      update,
      workspace: () => ({ cwd: entry.snapshot.cwd, hasWorkspace: entry.hasWorkspace }),
      allowUpdate: () => this.tools.canUpdateMemory(entry),
      conversationId: agentId,
      sandboxMode: () => entry.scheduledSandboxMode,
      permission: this.options.memoryPermission
        ? { request: input => this.options.memoryPermission!.request({ ...input, conversationId: agentId, sandboxMode: entry.scheduledSandboxMode }) }
        : undefined,
    });
  }

  private applyActiveTools(entry: Conversation): void {
    const tools = this.tools.active(entry);
    const session = entry.session;
    const bridge = session ? this.mcpBridges.get(session) : undefined;
    bridge?.refresh();
    const active = session && bridge ? this.mcpActiveTools(session, tools) : tools;
    session?.setActiveToolsByName(active);
    this.patchEntry(entry, { tools: active });
    for (const [child, other] of this.mcpBridges) {
      if (other !== bridge && other.options.conversationId === entry.id) {
        other.refresh();
        child.setActiveToolsByName(this.mcpActiveTools(child, other.options.nativeTools()));
      }
    }
  }

  /** conversation 上的 plan 字段变化后，把只读快照同步给界面并持久化。 */
  private syncPlanState(entry: Conversation): void {
    const activeExecution = activeExecutionPlan(entry.executionPlans, entry.activeExecutionPlanId);
    this.patchEntry(entry, {
      proposedPlan: cloneProposedPlan(latestPlan(entry.plans)),
      planRevisions: entry.plans.map((plan) => ({ ...plan })),
      executionPlan: cloneExecutionPlan(activeExecution),
    });
  }

  /**
   * <proposed_plan> 解析结果转成 runtime 事件：
   * plan_start 分配 revision，plan_end 立即持久化成新的 ProposedPlanItem。
   */
  private emitPlanStream(entry: Conversation, event: PlanStreamEvent): void {
    if (event.type === "text") {
      this.emit({ type: "text_delta", conversationId: entry.id, delta: event.delta });
      return;
    }
    if (event.type === "plan_start") {
      const allocation = {
        id: randomUUID(),
        revision: (latestPlan(entry.plans)?.revision ?? 0) + 1,
      };
      entry.planStreamPlan = allocation;
      this.emit({
        type: "proposed_plan_start",
        conversationId: entry.id,
        planId: allocation.id,
        revision: allocation.revision,
      });
      return;
    }
    const allocation = entry.planStreamPlan;
    if (!allocation) return;
    if (event.type === "plan_delta") {
      this.emit({
        type: "proposed_plan_delta",
        conversationId: entry.id,
        planId: allocation.id,
        delta: event.delta,
      });
      return;
    }
    // plan_end：新 revision 指向上一版，旧版本原地保留。
    const result = appendPlanRevision(entry.plans, {
      id: allocation.id,
      markdown: event.markdown,
      objective: this.planObjective(entry),
      createdAt: Date.now(),
    });
    entry.plans = result.plans;
    entry.latestProposedPlanId = result.plan.id;
    entry.planStreamPlan = null;
    this.syncPlanState(entry);
    this.emit({ type: "proposed_plan_end", conversationId: entry.id, plan: result.plan });
  }

  /** 规划开始时用户提出的目标：会话里最近一条非系统代发的用户消息。 */
  private planObjective(entry: Conversation): string | null {
    const messages = entry.session?.messages ?? [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (!message || message.role !== "user") continue;
      const text = userMessageText(message);
      if (!text.trim() || isPlanExecutionPrompt(text)) continue;
      return clipObjective(text);
    }
    return null;
  }

  /** 批准 revision 后绑定一个执行计划；同一 revision 重复执行时复用已有进度。 */
  private bindExecution(
    entry: Conversation,
    plan: ProposedPlanItem,
    plans: ProposedPlanItem[],
  ): ExecutionPlan {
    const bound = bindExecutionPlan(entry.executionPlans, plan, Date.now());
    entry.plans = plans;
    entry.latestProposedPlanId = plan.id;
    entry.executionPlans = bound.executionPlans;
    entry.activeExecutionPlanId = bound.execution.id;
    this.syncPlanState(entry);
    return bound.execution;
  }

  /** fresh 策略：新开一个只带原始目标与已批准方案的对话，不继承规划阶段的搜索与 reasoning。 */
  private async startFreshExecution(source: Conversation, plan: ProposedPlanItem): Promise<Conversation> {
    await this.ready();
    await this.rememberActiveSelection();
    const entry = this.addEntry(source.snapshot.cwd, {
      hasWorkspace: source.hasWorkspace,
      title: freshExecutionTitle(source.snapshot.title),
      mode: "agent",
      instructions: source.instructions,
    });
    const execution = createExecutionPlan(plan, Date.now());
    entry.plans = [plan];
    entry.latestProposedPlanId = plan.id;
    entry.executionPlans = [execution];
    entry.activeExecutionPlanId = execution.id;
    this.syncPlanState(entry);
    await this.startInternal(entry);
    return entry;
  }

  private beginGoal(entry: Conversation, text: string): void {
    const current = entry.snapshot.goal;
    if (!current || current.status === "complete") {
      entry.goalValidationEvidence.clear();
      entry.goalValidationSequence = 0;
      this.patchEntry(entry, {
        goal: {
          id: randomUUID(),
          objective: clipObjective(text),
          status: "active",
          note: null,
          workRevision: 0,
          validation: null,
          updatedAt: Date.now(),
        },
      });
      return;
    }
    this.patchEntry(entry, {
      goal: { ...current, status: "active", note: null, updatedAt: Date.now() },
    });
  }

  private pauseGoal(entry: Conversation, note: string | null): void {
    const goal = entry.snapshot.goal;
    if (!goal || goal.status === "complete") return;
    if (goal.status === "paused" && note === null) return;
    this.patchEntry(entry, {
      goal: {
        ...goal,
        status: "paused",
        note: note ?? goal.note,
        updatedAt: Date.now(),
      },
    });
  }

  private advanceGoalWorkRevision(entry: Conversation): void {
    const goal = entry.snapshot.goal;
    if (!goal || goal.status === "complete") return;
    this.patchEntry(entry, {
      goal: { ...goal, workRevision: goal.workRevision + 1, updatedAt: Date.now() },
    });
  }

  /**
   * ask_user_question 的宿主实现:挂起工具执行,把问题推给界面,等用户答复。
   * 计划批准改由界面驱动，这里只处理真正的设计决策问题。
   */
  private async askUser(entry: Conversation, input: AskUserInput): Promise<AskUserOutcome> {
    const question = clipField(input.question, 500);
    if (!question) return { ok: false, text: "问题不能为空。" };
    const options = input.options.slice(0, 4).map((option) => ({
      label: clipField(option.label, 100),
      description: option.description ? clipField(option.description, 200) : undefined,
    }));
    const onAbort = (): void => this.questions.cancelConversation(entry.id);
    input.signal?.addEventListener("abort", onAbort, { once: true });
    let answer: string | null;
    try {
      answer = await this.questions.ask(entry.id, {
        toolCallId: input.toolCallId,
        question,
        options,
        allowFreeText: true,
      });
    } finally {
      input.signal?.removeEventListener("abort", onAbort);
    }
    if (answer === null) {
      if (input.signal?.aborted) return { ok: true, text: "用户中断了会话，问题未回答。", answer: null };
      return {
        ok: true,
        text: "用户没有回答这个问题。请基于现有信息继续，或者换个方式推进。",
        answer: null,
      };
    }
    return { ok: true, text: `用户回答：${clipField(answer, 2000)}`, answer };
  }

  /** update_plan 的宿主实现：只改 ExecutionPlan，不触碰 ProposedPlan。 */
  private updateExecutionPlan(entry: Conversation, items: readonly ExecutionPlanUpdateItem[]): ToolOutcome {
    const execution = activeExecutionPlan(entry.executionPlans, entry.activeExecutionPlanId);
    if (!execution) return { ok: false, text: "当前没有执行计划。" };
    const result = applyExecutionPlanUpdate(execution, items, Date.now());
    if (!result.ok) return result;
    entry.executionPlans = entry.executionPlans.map((plan) =>
      plan.id === execution.id ? result.execution : plan,
    );
    this.syncPlanState(entry);
    const done = result.execution.items.filter((item) => item.status === "completed").length;
    const active = result.execution.items.find((item) => item.status === "in_progress");
    return {
      ok: true,
      text: `执行清单已更新：${done}/${result.execution.items.length} 完成${active ? `，进行中：${active.text}` : ""}。`,
    };
  }

  private updateGoal(
    entry: Conversation,
    status: Extract<GoalStatus, "active" | "complete">,
    note: string | null,
  ): ToolOutcome {
    const goal = entry.snapshot.goal;
    if (!goal) return { ok: false, text: "当前没有目标。" };
    if (goal.status === "paused") return { ok: false, text: "目标已暂停，等用户继续后再更新。" };
    if (status === "complete") {
      const blocker = goalCompletionBlocker(goal);
      if (blocker) return { ok: false, text: blocker };
    }
    const nextNote = note ? clipField(note, 400) : goal.note;
    const next: ConversationGoal = { ...goal, status, note: nextNote || null, updatedAt: Date.now() };
    this.patchEntry(entry, { goal: next });
    if (status === "complete" && next.validation?.status === "known_issues") {
      return { ok: true, text: "目标已完成，验证记录中包含已知问题。请在最终回复中列出失败检查和依据。" };
    }
    return { ok: true, text: status === "complete" ? "目标已完成，交付验证已记录。" : `目标仍在进行。${next.note ?? ""}`.trim() };
  }

  private recordGoalValidation(entry: Conversation, draft: GoalValidationDraft): ToolOutcome {
    const goal = entry.snapshot.goal;
    if (!goal) return { ok: false, text: "当前没有目标。" };
    if (goal.status !== "active") return { ok: false, text: "目标未处于进行中，不能更新验证记录。" };
    const result = createGoalValidation(goal, draft, entry.goalValidationEvidence.values());
    if (!result.ok) return { ok: false, text: result.text };
    this.patchEntry(entry, {
      goal: { ...goal, validation: result.validation, updatedAt: Date.now() },
    });
    const checks = result.validation.checks.length;
    const skipped = result.validation.skipped.length;
    const failures = result.validation.knownIssues.length;
    const status = result.validation.status === "known_issues"
      ? "已记录，含已知失败"
      : result.validation.status === "skipped"
        ? "已记录，检查均已说明跳过原因"
        : "已记录，未发现未说明的失败";
    return {
      ok: true,
      text: `${status}。命令 ${checks} 项，跳过 ${skipped} 项，已知失败 ${failures} 项。完成前若再运行可能修改工作区的工具，需要重新记录验证。`,
    };
  }
}

function clearSessionModel(session: AgentSession | null): void {
  if (!session) return;
  const state = session.agent.state as { model?: Model<Api> };
  state.model = undefined;
}

/** 本次对话生成速度（tokens/秒）；采样太短或还没跑过一步时为空。 */
function outputSpeed(entry: Conversation | null): number | null {
  const generation = entry?.generation;
  if (!generation || generation.outputTokens <= 0 || generation.elapsedMs < 1) return null;
  return (generation.outputTokens / generation.elapsedMs) * 1000;
}

function modelLabel(model: { name?: string; provider: string; id: string }): string {
  return model.name?.trim() || `${model.provider}/${model.id}`;
}

function levelsFor(model: Model<Api>): ThinkingLevel[] {
  return getSupportedThinkingLevels(model).filter(isThinkingLevel);
}

function clampToModel(model: Model<Api>, level: ThinkingLevel): ThinkingLevel {
  const clamped = clampThinkingLevel(model, level);
  return isThinkingLevel(clamped) ? clamped : "off";
}

function isThinkingLevel(value: string): value is ThinkingLevel {
  return (thinkingLevels as readonly string[]).includes(value);
}

/** 分支会话在侧边栏里用原标题加后缀区分。 */
function branchTitle(title: string): string {
  const base = title.trim() || "新对话";
  return `${base} · 分支`;
}

/** fresh 执行会新开一个对话，标题标明它来自哪次规划。 */
function freshExecutionTitle(title: string): string {
  const base = title.trim() || "新对话";
  return `${base} · 执行`;
}

function clipObjective(text: string): string {
  return clipField(text.replace(/\s+/g, " "), 500);
}

function clipField(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

function cloneProposedPlan(plan: ProposedPlanItem | null): ProposedPlanItem | null {
  return plan ? { ...plan } : null;
}

function cloneExecutionPlan(plan: ExecutionPlan | null): ExecutionPlan | null {
  if (!plan) return null;
  return { ...plan, items: plan.items.map((item) => ({ ...item })) };
}

function cloneGoal(goal: ConversationGoal | null): ConversationGoal | null {
  if (!goal) return null;
  const validation: GoalValidation | null = goal.validation
    ? {
        ...goal.validation,
        checks: goal.validation.checks.map((check) => ({ ...check })),
        skipped: goal.validation.skipped.map((item) => ({ ...item })),
        knownIssues: goal.validation.knownIssues.map((item) => ({ ...item })),
      }
    : null;
  return { ...goal, validation };
}

function isPotentialGoalMutation(toolName: string, args: unknown): boolean {
  if (toolName === "browser_repl" || toolName === "bash" || toolName === "edit" || toolName === "write") return true;
  if (toolName !== spawnAgentToolName) return false;
  if (!args || typeof args !== "object") return true;
  return (args as { agent?: unknown }).agent !== "explore";
}

/** 投递给主代理的 agent 消息正文；其余元数据随 custom message details 透出。 */
function formatAgentRootMessage(message: AgentRootMessage): string {
  if (message.kind === "message") {
    return `[来自子代理 ${message.path} 的消息]\n\n${message.text}`;
  }
  const label = message.status === "completed" ? "已完成" : message.status === "aborted" ? "已停止" : "失败";
  return `[子代理 ${message.path} ${label}]\n\n${message.text}`;
}

function readSessionError(session: AgentSession): string | null {
  const errorMessage = session.agent.state.errorMessage;
  return errorMessage?.trim() ? errorMessage : null;
}
