import { TurnCheckpoints, type TurnCheckpoint } from "./turn-checkpoints";
import { TraceRecorder } from "./trace";
import type { TraceSummaryRequest, TraceUpdate } from "@vela/shared";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  thinkingLevels,
  type AgentInfo,
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
} from "@vela/shared";
import { defaultToolNames } from "@vela/tools";
import { clampThinkingLevel, getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
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
import { openCodeSessionHeaders } from "./provider-headers";
import {
  createModeExtension,
  createModeTools,
  defaultToolPolicy,
  goalContinuePrompt,
  goalTurnLimit,
  goalTurnLimitNote,
  modeToolNames,
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
import { loadSkillCatalog } from "./skill-catalog";
import {
  deleteSkill as deleteSkillFiles,
  readDisabledSkills,
  setSkillEnabled as storeSkillEnabled,
} from "./skill-management";
import { migrateExternalSkills, scanExternalSkills as scanExternalSkillSources } from "./skill-migration";
import { activityFromCall, activityFromExecution, activityFromOutput } from "./tool-activity";
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
  agentToolNames,
  agentToolNamesFor,
  createExploreGuardExtension,
  spawnAgentToolName,
} from "./subagent";

export type RuntimeEvent =
  | TraceUpdate
  | { type: "status"; conversationId: string }
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
  cwd: string;
  /** Vela 自己的模型目录，不读取本机 Pi 配置。 */
  agentDir: string;
  /** 按会话 cwd 构造沙箱化的 bash/edit/write 工具,以同名覆盖 Pi 内置实现。 */
  toolFactory?: (cwd: string) => ToolDefinition[];
  /** 激活对话的 cwd 变化时回调(用于让工作区等界面状态跟随会话)。 */
  onActiveCwd?: (cwd: string) => void;
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

interface Conversation {
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
  /** toolCallId -> Goal id 与执行时工作区修订号。 */
  private readonly traces = new Map<string, TraceRecorder>();
  private readonly toolGoalContexts = new Map<string, { goalId: string; workRevision: number }>();
  /** toolCallId -> 子代理工具参数；子代理事件不带参数，结果事件用它还原命令和路径。 */
  private readonly agentToolArgs = new Map<string, unknown>();
  private readonly questions = new QuestionManager();
  private readonly thinkingSummaries = new ThinkingSummaryGenerator();
  private readonly textAssist = new TextAssistService();
  private readonly initializePromise: Promise<void>;
  private readonly store: ConversationStore;
  private currentCwd: string;
  /** 被停用的 Skill 名称；启动会话时据此过滤，null 表示还没读取。 */
  private disabledSkills: Set<string> | null = null;
  /** 每次停用、启用或删除 Skill 时递增，用于让已打开的会话在下次发言前刷新 Skill。 */
  private skillsRevision = 0;
  private gate: Promise<void> = Promise.resolve();
  private readonly rewindingWorkspaces = new Set<string>();
  private readonly overlappingCheckpointRuns = new Set<string>();

  constructor(private readonly options: AgentRuntimeOptions) {
    this.currentCwd = options.cwd;
    this.store = new ConversationStore(join(options.agentDir, "conversations.json"));
    // QuestionManager 的事件转发给宿主监听器(SessionHost 由此广播到界面)。
    this.questions.subscribe((event) => {
      for (const listener of this.questionListeners) listener(event);
    });
    this.initializePromise = this.initialize();
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
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        archivedAt: entry.archivedAt,
        ...(entry.snapshot.turnStartedAt !== undefined ? { turnStartedAt: entry.snapshot.turnStartedAt } : {}),
        ...(entry.snapshot.turnCompletedAt !== undefined ? { turnCompletedAt: entry.snapshot.turnCompletedAt } : {}),
      }));
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
  async createConversation(cwd: string): Promise<SessionSnapshot> {
    return this.exclusive(async () => {
      await this.ready();
      // 新对话可能沿用「上次使用」,所以先把当前对话正在用的选择记下来。
      await this.rememberActiveSelection();
      const entry = this.addEntry(cwd);
      return this.startInternal(entry);
    });
  }

  /**
   * 从某一轮回复处分支:把该轮及之前的历史复制成新会话文件并切换过去。
   * turnIndex 是界面上可见用户消息的序号(从 0 数起),与 getMessages 的轮次一致。
   */
  async branchConversation(conversationId: string, turnIndex: number): Promise<SessionSnapshot> {
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
      const sourceTimings = readTurnTimings(manager.getBranch());
      const branchedFile = manager.createBranchedSession(leaf);
      if (!branchedFile) throw new Error("无法创建分支会话");
      const branched = SessionManager.open(branchedFile, this.sessionDir(), source.snapshot.cwd);
      copyTurnTimings(sourceTimings, branched);
      const branchedSources = transcriptSourcesFromProjection(branched.buildSessionProjection());
      await this.rememberActiveSelection();
      const entry = this.addEntry(source.snapshot.cwd, {
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
      this.notifyActiveCwd(entry.snapshot.cwd);
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
          this.notifyActiveCwd(fallback.snapshot.cwd);
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
      if (!entry?.session || !entry.sessionManager) throw new Error("对话不存在或已结束");
      for (const other of this.conversations.values()) {
        if (other.snapshot.cwd !== entry.snapshot.cwd) continue;
        if (other.driving || other.session?.isStreaming || other.control?.list().some(agent => agent.kind !== "root" && agent.status === "running")) {
          throw new Error("工作区还有任务运行中，请停止或等待完成后修改消息");
        }
      }
      const manager = entry.sessionManager;
      const sources = transcriptSourcesFromProjection(manager.buildSessionProjection());
      const user = sources.filter(source => source.message.role === "user" && isVisibleTranscriptMessage(source.message))[turnIndex];
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
        this.detachEntry(entry);
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
    });
  }

  private checkpoints(entry: Conversation) {
    return new TurnCheckpoints<RewindMetadata>(join(this.options.agentDir, "checkpoints", entry.id), entry.snapshot.cwd, this.options.agentDir);
  }

  private async finishLatestCheckpoint(entry: Conversation) {
    if (entry.control?.list().some(agent => agent.kind !== "root" && agent.status === "running")) return;
    const checkpoints = this.checkpoints(entry);
    const branch = entry.sessionManager?.getBranch() ?? [];
    const points = await checkpoints.list();
    const point = [...branch].reverse().map(item => points.find(point => point.userEntryId === item.id)).find(Boolean);
    if (point) await checkpoints.finish(point, point.userEntryId);
  }

  async prompt(conversationId: string, text: string, images?: ImageAttachment[]): Promise<void> {
    const entry = this.requireIdle(conversationId);
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

  async setMode(conversationId: string, mode: InteractionMode): Promise<void> {
    const entry = this.conversations.get(conversationId);
    if (!entry) throw new Error("对话不存在或已结束");
    if (entry.driving || entry.session?.isStreaming) throw new Error("回复进行中，不能切换模式");
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
  async switchWorkspace(cwd: string): Promise<SessionSnapshot> {
    return this.exclusive(async () => {
      await this.ready();
      const existing = [...this.conversations.values()]
        .filter((entry) => entry.snapshot.cwd === cwd && entry.archivedAt === null)
        .sort((a, b) => b.updatedAt - a.updatedAt);
      if (existing.length > 0) {
        const entry = existing[0];
        if (!entry.session) await this.startInternal(entry);
        this.activeId = entry.id;
        this.notifyActiveCwd(cwd);
        this.emitStatus(entry);
        return this.getSnapshot();
      }
      this.currentCwd = cwd;
      await this.rememberActiveSelection();
      const entry = this.addEntry(cwd);
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
    const entry = this.activeConversation();
    const model = entry?.session?.model;
    if (!model || !directory.isAvailable(model)) return "unknown";
    const task = entry?.snapshot.goal?.objective ?? entry?.snapshot.title ?? null;
    const controller = new AbortController();
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
          signal: controller.signal,
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
      const model = active?.session?.model ?? directory.modelForSelection();
      const next = model ? clampToModel(model, level) : level;
      active?.session?.setThinkingLevel(next);
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
    return join(this.options.agentDir, "skills");
  }

  /** 按当前工作区扫描用户 Skill、项目 Skill 和 ~/.agents/skills。 */
  listSkills(cwd: string): Promise<SkillCatalog> {
    return loadSkillCatalog({ cwd, agentDir: this.options.agentDir });
  }

  /** 启用或停用一个 Skill；已打开的对话会在下次发言前重新加载资源。 */
  setSkillEnabled(cwd: string, name: string, enabled: boolean): Promise<SkillCatalog> {
    return this.exclusive(async () => {
      await storeSkillEnabled(this.options.agentDir, name, enabled);
      this.disabledSkills = await readDisabledSkills(this.options.agentDir);
      this.skillsRevision += 1;
      return this.listSkills(cwd);
    });
  }

  /** 删除 Vela 用户 Skill 目录里的 Skill；已打开的对话会在下次发言前重新加载资源。 */
  deleteSkill(cwd: string, name: string, location: string): Promise<SkillCatalog> {
    return this.exclusive(async () => {
      await deleteSkillFiles({ agentDir: this.options.agentDir, name, location });
      this.disabledSkills = await readDisabledSkills(this.options.agentDir);
      this.skillsRevision += 1;
      return this.listSkills(cwd);
    });
  }

  /** 列出 Codex 与 Claude Code 中可复制到 Vela 的 Skill。 */
  scanExternalSkills(cwd: string): Promise<ExternalSkillScan> {
    return scanExternalSkillSources(this.skillMigrationOptions(cwd));
  }

  /** 把选中的外部 Skill 复制到用户 Skill 目录。 */
  migrateSkills(cwd: string, ids: readonly string[]): Promise<SkillMigrationResult> {
    return migrateExternalSkills(this.skillMigrationOptions(cwd), ids);
  }

  private skillMigrationOptions(cwd: string) {
    return {
      home: homedir(),
      cwd,
      skillsDir: this.skillsDirectory(),
      codexHome: process.env.CODEX_HOME,
      claudeHome: process.env.CLAUDE_CONFIG_DIR,
    };
  }

  private async loadDisabledSkills(): Promise<Set<string>> {
    this.disabledSkills ??= await readDisabledSkills(this.options.agentDir);
    return this.disabledSkills;
  }

  /** 从资源里去掉被停用的 Skill，让模型和 /skill:名称 都看不到。 */
  private withoutDisabledSkills<T extends { skills: Array<{ name: string }> }>(base: T): T {
    const disabled = this.disabledSkills;
    if (!disabled || disabled.size === 0) return base;
    return { ...base, skills: base.skills.filter((skill) => !disabled.has(skill.name)) };
  }

  /** 停用、启用或删除 Skill 后，让会话在下次发言前重新加载 Skill 列表。 */
  private async refreshEntrySkills(entry: Conversation): Promise<void> {
    const session = entry.session;
    if (!session || entry.skillsRevision === this.skillsRevision) return;
    const revision = this.skillsRevision;
    try {
      await session.reload();
    } catch (error) {
      if (process.env.VELA_DEBUG) console.error("[vela] 重新加载 Skill 失败:", error);
      return;
    }
    // 重新加载期间 Skill 又变了就留到下一次发言再刷。
    if (revision === this.skillsRevision) entry.skillsRevision = revision;
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
    let recorder = this.traces.get(conversationId);
    if (!recorder) {
      recorder = new TraceRecorder(conversationId, join(this.options.agentDir, "traces", `${conversationId}.jsonl`), (event) => this.emit(event));
      this.traces.set(conversationId, recorder);
      const entry = this.conversations.get(conversationId);
      const manager = entry?.sessionManager ?? (entry?.sessionFile ? SessionManager.open(entry.sessionFile, this.sessionDir(), entry.snapshot.cwd) : null);
      if (manager && restoreHistory) recorder.restoreHistory(manager.getBranch());
    }
    return recorder;
  }

  getTrace(conversationId: string) {
    if (!this.conversations.has(conversationId)) throw new Error("对话不存在或已结束");
    return this.trace(conversationId).snapshot();
  }

  /** Trace bookkeeping must never block a summary; narrow test harnesses may omit the trace map. */
  private recordSummaryUsage(conversationId: string, summary: Omit<TraceSummaryRequest, "id">): void {
    if (!this.traces) return;
    this.trace(conversationId).recordSummary(summary);
  }

  getTraceDetails(conversationId: string, nodeId: string) {
    if (!this.conversations.has(conversationId)) throw new Error("对话不存在或已结束");
    return this.trace(conversationId).details(nodeId);
  }

  /** 恢复界面消息列表(应用重启后渲染层桶是空的,从会话文件重建)。 */
  getMessages(conversationId: string): TranscriptMessage[] {
    const entry = this.conversations.get(conversationId);
    const session = entry?.session ?? null;
    if (!session || !entry) return [];
    const manager = session.sessionManager;
    return transcriptFromProjection(manager.buildSessionProjection(), entry.plans, readTurnTimings(manager.getBranch()));
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
    if (session) return transcriptFromMessages(session.messages);
    const stored = entry.storedAgents.find((agent) => agent.id === agentId);
    if (stored?.sessionFile && existsSync(stored.sessionFile)) {
      const manager = SessionManager.open(stored.sessionFile, this.childSessionDir(entry.id), entry.snapshot.cwd);
      return transcriptFromProjection(manager.buildSessionProjection());
    }
    return stored ? legacyAgentTranscript(stored) : [];
  }

  getAgents(conversationId: string | null): AgentInfo[] {
    const entry = conversationId ? this.conversations.get(conversationId) : null;
    return entry?.control?.list() ?? entry?.storedAgents.map(({ sessionFile: _file, ...agent }) => agent) ?? [];
  }

  dispose(): void {
    this.thinkingSummaries.dispose();
    this.textAssist.dispose();
    for (const trace of this.traces.values()) trace.dispose();
    this.directory?.cancelLogin();
    this.questions.cancelAll();
    for (const entry of this.conversations.values()) this.detachEntry(entry);
    this.conversations.clear();
    this.toolArgs.clear();
    this.toolGoalContexts.clear();
    this.agentToolArgs.clear();
    this.activeId = null;
    this.store.flushSync();
  }

  private async initialize(): Promise<void> {
    await this.store.load();
    // 会话文件仍在磁盘上的对话才恢复。新对话在创建时就写入了文件
    // (见 createPersistedSession),所以没有文件的记录只会是历史遗留或已被外部清理的会话。
    for (const stored of this.store.list()) {
      if (!stored.sessionFile || !existsSync(stored.sessionFile)) continue;
      const activeExecution = activeExecutionPlan(stored.executionPlans, stored.activeExecutionPlanId);
      const storedAgents = stored.agents?.length ? stored.agents : recoverLegacyAgents(
        SessionManager.open(stored.sessionFile, this.sessionDir(), stored.cwd).buildSessionProjection().messages,
        stored.id,
      );
      this.conversations.set(stored.id, {
        id: stored.id,
        session: null,
        sessionManager: null,
        sessionFile: stored.sessionFile,
        snapshot: {
          ...this.createSnapshot("ready", stored.cwd),
          id: stored.id,
          title: stored.title,
          mode: stored.mode,
          proposedPlan: cloneProposedPlan(latestPlan(stored.plans)),
          planRevisions: stored.plans.map((plan) => ({ ...plan })),
          executionPlan: cloneExecutionPlan(activeExecution),
          goal: stored.goal,
          tools: defaultToolPolicy.availableTools(stored.mode, activeExecution !== null),
        },
        titleGenerationStarted: stored.title !== "新对话",
        titleManuallySet: stored.titleManuallySet === true,
        unsubscribe: null,
        createdAt: stored.createdAt,
        updatedAt: stored.updatedAt,
        instructions: stored.instructions,
        skillsRevision: 0,
        stopRequested: false,
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
    const directory = await ModelDirectory.open(this.options.agentDir);
    directory.subscribeAuth((event) => {
      for (const listener of this.authListeners) listener(event);
    });
    this.directory = directory;
    directory.refreshCatalogFromNetwork();
    const active = this.activeConversation();
    if (active) this.syncFromSession(active);
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
      sessionManager?: SessionManager;
      title?: string;
      mode?: InteractionMode;
      instructions?: string;
    } = {},
  ): Conversation {
    // 会话文件必须随新对话一起落到磁盘:Pi 默认要等首条回复才创建 JSONL,
    // 空对话会在强制退出后的重启中被当作已清理会话丢掉。
    const sessionManager = options.sessionManager ?? createPersistedSession(cwd, this.sessionDir());
    const snapshot = this.createSnapshot("starting", cwd);
    if (options.title) snapshot.title = options.title;
    if (options.mode) snapshot.mode = options.mode;
    const entry: Conversation = {
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
      skillsRevision: this.skillsRevision,
      stopRequested: false,
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
    this.activeId = entry.id;
    this.persistEntry(entry);
    // 新对话是用户明确创建的状态,不等防抖窗口,立刻同步落盘。
    this.store.flushSync();
    this.notifyActiveCwd(cwd);
    this.emitStatus(entry);
    return entry;
  }

  private async startInternal(entry: Conversation, selection?: { model: Model<Api> | undefined; thinkingLevel: ThinkingLevel }): Promise<SessionSnapshot> {
    this.patchEntry(entry, { status: "starting", error: null });
    try {
      const directory = await this.readyDirectory();
      const { model: chosen, thinkingLevel } = selection ?? this.conversationSelection(directory);
      const cwd = entry.snapshot.cwd;
      // 新对话:登记时已建或此处新建;恢复的对话:按文件打开以接续历史。
      const sessionManager = entry.sessionManager
        ?? (entry.sessionFile
          ? SessionManager.open(entry.sessionFile, this.sessionDir(), cwd)
          : createPersistedSession(cwd, this.sessionDir()));
      const settingsManager = SettingsManager.inMemory();
      const instructions = entry.instructions.trim();
      await this.loadDisabledSkills();
      const resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir: this.options.agentDir,
        settingsManager,
        skillsOverride: (base) => this.withoutDisabledSkills(base),
        extensionFactories: [{
          name: "vela-mode",
          hidden: true,
          factory: createModeExtension(() => ({
            mode: entry.snapshot.mode,
            hasExecutionPlan: entry.snapshot.executionPlan !== null,
          })),
        }],
        appendSystemPromptOverride: instructions ? (base) => [...base, instructions] : undefined,
      });
      await resourceLoader.reload();
      const control = new AgentControl({
        conversationId: entry.id,
        restoredAgents: entry.storedAgents,
        host: {
          createChildSession: (input) => this.createChildSession(entry, input),
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
          // tools 是 Pi 的注册表白名单(内置与自定义都过滤),模式和 agent 树工具必须并入才能被激活。
          tools: [...defaultToolNames, ...modeToolNames, ...agentToolNames],
          customTools: [
            ...(this.options.toolFactory?.(cwd) ?? []),
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
        control.dispose();
        throw error;
      }
      // 没有显式选择时，Pi 会挑第一个带本机环境变量的模型。这里清掉，只保留用户在 Vela 里选的模型。
      if (!chosen) clearSessionModel(session);
      this.attachEntry(entry, session, sessionManager);
      entry.control = control;
      control.registerRoot(session);
      entry.skillsRevision = this.skillsRevision;
      this.syncFromSession(entry);
      this.applyActiveTools(entry);
      this.patchEntry(entry, {
        status: "ready",
        id: session.sessionId,
        error: null,
      });
    } catch (error) {
      if (process.env.VELA_DEBUG) {
        console.error("[vela] 会话启动失败:", error);
      }
      this.detachEntry(entry);
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
    const current = session.model;
    if (!current || current.provider !== model.provider || current.id !== model.id) {
      await session.setModel(model);
    }
    session.setThinkingLevel(thinkingLevel);
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
    const recorder = this.trace(entry.id);
    const originalStream = session.agent.streamFunction;
    const tracedStream = recorder.wrapStream(originalStream);
    session.agent.streamFunction = tracedStream;
    entry.unsubscribe = session.subscribe((event) => {
      // Pi compares the stream function identity for summarization authentication.
      // Preserve its original function during compaction, then resume main-agent tracing.
      if (event.type === "compaction_start") session.agent.streamFunction = originalStream;
      if (event.type === "compaction_end") session.agent.streamFunction = tracedStream;
      this.handlePiEvent(entry.id, event);
    });
  }

  private detachEntry(entry: Conversation): void {
    entry.unsubscribe?.();
    entry.unsubscribe = null;
    entry.control?.dispose();
    entry.control = null;
    entry.session?.dispose();
    entry.session = null;
  }

  private handlePiEvent(conversationId: string, event: AgentSessionEvent): void {
    const recorder = this.trace(conversationId);
    recorder.capture(() => recorder.handle(event));
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
        entry && goalBeforeTool && goalBeforeTool.status !== "complete" && isPotentialGoalMutation(event.toolName, event.args) &&
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
        activity: activityFromCall(event.toolName, event.args),
      });
      return;
    }

    if (event.type === "tool_execution_update") {
      const activity = activityFromOutput(event.partialResult, event.toolName);
      if (!activity) return;
      this.emit({ type: "tool_output", conversationId, toolCallId: event.toolCallId, activity });
      return;
    }

    if (event.type === "tool_execution_end") {
      const args = this.toolArgs.get(event.toolCallId);
      this.toolArgs.delete(event.toolCallId);
      const goalContext = this.toolGoalContexts.get(event.toolCallId);
      this.toolGoalContexts.delete(event.toolCallId);
      const activity = activityFromExecution(event.toolName, args, event.result, event.isError);
      const entry = this.conversations.get(conversationId);
      const goal = entry?.snapshot.goal;
      if (entry && goalContext && event.toolName === "bash" && goal?.id === goalContext.goalId) {
        const command = activity.command?.trim();
        if (command) {
          entry.goalValidationSequence += 1;
          entry.goalValidationEvidence.set(event.toolCallId, {
            toolCallId: event.toolCallId,
            command: command.slice(0, 1000),
            result: event.isError ? "failed" : "passed",
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
        isError: event.isError,
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
        isError: event.isError,
        activity: activityFromExecution(event.toolName, args, event.result, event.isError),
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
    const intended = active ?? directory?.modelForSelection();
    const thinkingLevel = active && session
      ? session.thinkingLevel
      : directory?.selection.thinkingLevel ?? "medium";
    entry.snapshot = {
      ...entry.snapshot,
      model: intended ? modelLabel(intended) : null,
      modelProvider: intended?.provider ?? null,
      modelId: intended?.id ?? null,
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
    });
  }

  /** 激活对话的 cwd 变化时通知宿主(工作区/界面状态跟随会话)。 */
  private notifyActiveCwd(cwd: string): void {
    if (cwd === this.currentCwd) return;
    this.currentCwd = cwd;
    this.options.onActiveCwd?.(cwd);
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

  private emit(event: RuntimeEvent): void {
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
      error: null,
    };
  }

  private requireIdle(conversationId: string): Conversation {
    const entry = this.conversations.get(conversationId);
    const session = entry?.session;
    if (!entry || !session) throw new Error("对话不存在或已结束");
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
      entry.driving = false;
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
        other.control?.list().some(agent => agent.kind !== "root" && agent.status === "running"))) {
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
    const settingsManager = SettingsManager.inMemory();
    const instructions = entry.instructions.trim();
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: this.options.agentDir,
      settingsManager,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noExtensions: true,
      extensionFactories: input.kind === "explore"
        ? [{ name: "vela-explore", hidden: true, factory: createExploreGuardExtension() }]
        : [],
      appendSystemPromptOverride: (base) => [
        ...base,
        ...(instructions ? [instructions] : []),
        agentKindPrompt(input.kind),
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
    const sandboxTools = this.options.toolFactory?.(cwd) ?? [];
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
      tools: agentToolNamesFor(input.kind),
      customTools: [...childSandboxTools, ...input.customTools],
    });
    session.setSessionName(input.path);
    return session;
  }

  private handleAgentsChange(entry: Conversation, agents: AgentInfo[]): void {
    entry.storedAgents = entry.control?.storedAgents() ?? entry.storedAgents;
    this.persistEntry(entry);
    this.emit({ type: "agents", conversationId: entry.id, agents });
    // 子代理改完工作区后，按一次修订推进 Goal 验证的有效性。
    for (const agent of agents) {
      if (agent.kind === "root" || !agent.mutated || agent.status === "running") continue;
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
      entry.driving = false;
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
      if (process.env.VELA_DEBUG) console.error("[vela] 子代理消息投递失败:", error);
    }
  }

  private applyActiveTools(entry: Conversation): void {
    const tools = defaultToolPolicy.availableTools(entry.snapshot.mode, entry.snapshot.executionPlan !== null);
    entry.session?.setActiveToolsByName(tools);
    this.patchEntry(entry, { tools });
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
  if (toolName === "bash" || toolName === "edit" || toolName === "write") return true;
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
