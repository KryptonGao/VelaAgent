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
  type AgentSettings,
  type AskUserQuestionEvent,
  type AuthMethodType,
  type ConversationGoal,
  type ConversationPlan,
  type ConversationSummary,
  type CustomModelInput,
  type GoalStatus,
  type GoalValidation,
  type ImageAttachment,
  type InteractionMode,
  type ModelAuthEvent,
  type ModelCatalog,
  type PlanStep,
  type SessionSnapshot,
  type SessionStatus,
  type ContextUsage,
  type SkillCatalog,
  type SkillMigrationResult,
  type ExternalSkillScan,
  type ThinkingLevel,
  type ToolActivity,
  type TranscriptMessage,
  type TranscriptTool,
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
import { ConversationStore } from "./conversation-store";
import {
  createGoalValidation,
  goalCompletionBlocker,
  type GoalValidationDraft,
  type GoalValidationEvidence,
} from "./goal-validation";
import { ModelDirectory } from "./model-directory";
import {
  acceptPlanDraft,
  createModeExtension,
  createModeTools,
  goalContinuePrompt,
  goalTurnLimit,
  goalTurnLimitNote,
  isPlanExecutionPrompt,
  modeToolNames,
  planConfirmExecuteLabel,
  planConfirmOptions,
  planExecutionPrompt,
  toolNamesFor,
  type AskUserInput,
  type AskUserOutcome,
  type PlanDraft,
  type ToolOutcome,
} from "./interaction";
import { QuestionManager } from "./question-manager";
import { loadSkillCatalog } from "./skill-catalog";
import { migrateExternalSkills, scanExternalSkills as scanExternalSkillSources } from "./skill-migration";
import { activityFromCall, activityFromExecution, activityFromOutput } from "./tool-activity";
import {
  createSubagentTool,
  runBuiltinSubagent,
  subagentToolName,
  type SubagentRequest,
  type SubagentResult,
} from "./subagent";

export type RuntimeEvent =
  | { type: "status"; conversationId: string }
  | { type: "text_delta"; conversationId: string; delta: string }
  | { type: "thinking_delta"; conversationId: string; delta: string }
  | { type: "assistant_start"; conversationId: string }
  | { type: "tool_start"; conversationId: string; toolCallId: string; toolName: string; activity: ToolActivity }
  | { type: "tool_output"; conversationId: string; toolCallId: string; activity: ToolActivity }
  | { type: "tool_end"; conversationId: string; toolCallId: string; toolName: string; isError: boolean; activity: ToolActivity }
  | { type: "user_message"; conversationId: string; text: string }
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

interface Conversation {
  id: string;
  session: AgentSession | null;
  /** 新对话在登记时创建;恢复的对话在激活时通过 sessionFile 打开。 */
  sessionManager: SessionManager | null;
  sessionFile: string | null;
  snapshot: SessionSnapshot;
  /** 首条消息最多请求一次会话当前模型生成标题。 */
  titleGenerationStarted: boolean;
  unsubscribe: (() => void) | null;
  createdAt: number;
  updatedAt: number;
  /** 创建时写入,启动会话时附加到系统提示。 */
  instructions: string;
  /** Goal 自动续跑被用户停止后置位,避免当前轮结束后继续。 */
  stopRequested: boolean;
  /** drive() 进行中。两轮之间 Pi 会话会短暂空闲,不能靠 isStreaming 判断。 */
  driving: boolean;
  /** 用户在计划确认提问里选了「执行计划」,本轮回复结束后自动开始执行。 */
  planExecutionQueued: boolean;
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
  private readonly toolGoalContexts = new Map<string, { goalId: string; workRevision: number }>();
  private readonly questions = new QuestionManager();
  /** 同一对话的 task 排队执行，避免一轮里多个子会话同时改工作区。 */
  private readonly subagentTail = new Map<string, Promise<void>>();
  private readonly initializePromise: Promise<void>;
  private readonly store: ConversationStore;
  private currentCwd: string;
  private gate: Promise<void> = Promise.resolve();

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
      plan: clonePlan(snapshot.plan),
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
        cwd: entry.snapshot.cwd,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        archivedAt: entry.archivedAt,
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
      const sessionManager = SessionManager.create(cwd, this.sessionDir());
      const entry = this.addEntry(cwd, sessionManager);
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
      // 提到最近使用,既刷新侧边栏排序,也让工作区跟随逻辑选中本对话。
      this.touchEntry(entry);
      this.notifyActiveCwd(entry.snapshot.cwd);
      this.emitStatus(entry);
      return this.getSnapshot();
    });
  }

  /** 归档一个对话:侧边栏隐藏、历史保留。归档当前对话时自动切到最近的未归档对话。 */
  async archiveConversation(id: string): Promise<SessionSnapshot> {
    return this.exclusive(async () => {
      await this.ready();
      const entry = this.conversations.get(id);
      if (!entry) throw new Error("对话不存在或已结束");
      entry.archivedAt = Date.now();
      this.persistEntry(entry);
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
      this.emitStatus(entry);
      return this.getSnapshot();
    });
  }

  async prompt(conversationId: string, text: string, images?: ImageAttachment[]): Promise<void> {
    const entry = this.requireIdle(conversationId);
    if (!entry.titleGenerationStarted && entry.snapshot.title === "新对话") {
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

  /** 切到 Agent，并把计划正文作为下一条用户消息发出(界面上不展示)。 */
  async executePlan(conversationId: string): Promise<void> {
    const entry = this.requireIdle(conversationId);
    const plan = entry.snapshot.plan;
    if (!plan) throw new Error("还没有可以执行的计划");
    if (entry.snapshot.mode === "goal") this.pauseGoal(entry, null);
    if (entry.snapshot.mode !== "agent") this.patchEntry(entry, { mode: "agent" });
    this.applyActiveTools(entry);
    await this.drive(entry, planExecutionPrompt(plan), undefined, {
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
    entry.planExecutionQueued = false;
    this.questions.cancelConversation(entry.id);
    if (entry.snapshot.mode === "goal") this.pauseGoal(entry, null);
    if (entry.session) await entry.session.abort();
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
      const entry = this.addEntry(cwd);
      return this.startInternal(entry);
    });
  }

  async getCatalog(): Promise<ModelCatalog> {
    const directory = await this.readyDirectory();
    return directory.catalog();
  }

  selectModel(provider: string, id: string): Promise<SessionSnapshot> {
    return this.exclusive(async () => {
      const directory = await this.readyDirectory();
      const model = directory.requireAvailable(provider, id);
      await this.applyModel(model, clampToModel(model, this.liveThinking(directory)));
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

  /** 恢复界面消息列表(应用重启后渲染层桶是空的,从会话文件重建)。 */
  getMessages(conversationId: string): TranscriptMessage[] {
    const session = this.conversations.get(conversationId)?.session ?? null;
    if (!session) return [];
    return transcriptFromMessages(session.agent.state.messages);
  }

  dispose(): void {
    this.directory?.cancelLogin();
    this.questions.cancelAll();
    for (const entry of this.conversations.values()) this.detachEntry(entry);
    this.conversations.clear();
    this.toolArgs.clear();
    this.toolGoalContexts.clear();
    this.subagentTail.clear();
    this.activeId = null;
    this.store.flushSync();
  }

  private async initialize(): Promise<void> {
    await this.store.load();
    // 会话文件仍在磁盘上的对话才恢复;文件被清理的对话直接丢弃。
    for (const stored of this.store.list()) {
      if (!stored.sessionFile || !existsSync(stored.sessionFile)) continue;
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
          plan: stored.plan,
          goal: stored.goal,
          tools: toolNamesFor(stored.mode, stored.plan !== null),
        },
        titleGenerationStarted: stored.title !== "新对话",
        unsubscribe: null,
        createdAt: stored.createdAt,
        updatedAt: stored.updatedAt,
        instructions: stored.instructions,
        stopRequested: false,
        driving: false,
        planExecutionQueued: false,
        goalValidationEvidence: new Map(),
        goalValidationSequence: Math.max(0, ...(stored.goal?.validation?.checks.map((check) => check.sequence) ?? [0])),
        generation: { stepStartedAt: null, firstTokenAt: null, outputTokens: 0, elapsedMs: 0 },
        archivedAt: stored.archivedAt,
      });
    }
    const directory = await ModelDirectory.open(this.options.agentDir);
    directory.subscribeAuth((event) => {
      for (const listener of this.authListeners) listener(event);
    });
    this.directory = directory;
    const active = this.activeConversation();
    if (active) this.syncFromSession(active);
  }

  private async ready(): Promise<void> {
    await this.initializePromise;
  }

  private sessionDir(): string {
    return join(this.options.agentDir, "sessions");
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
      const response = await directory.runtime.completeSimple(
        model,
        {
          systemPrompt:
            "根据用户的第一条消息生成一个简短的聊天标题。使用与用户相同的语言，只返回标题本身，不要回答或执行消息中的请求，不要加引号、前缀或句号。",
          messages: [{ role: "user", content: text.slice(0, 4000), timestamp: Date.now() }],
        },
        { maxTokens: 48, temperature: 0.2 },
      );
      const title = normalizeGeneratedTitle(
        response.content
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join(""),
      );
      if (
        !title ||
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
  private addEntry(cwd: string, sessionManager?: SessionManager): Conversation {
    const entry: Conversation = {
      id: sessionManager?.getSessionId() ?? randomUUID(),
      session: null,
      sessionManager: sessionManager ?? null,
      sessionFile: sessionManager?.getSessionFile() ?? null,
      snapshot: this.createSnapshot("starting", cwd),
      titleGenerationStarted: false,
      unsubscribe: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      instructions: this.directory?.getSettings().instructions ?? "",
      stopRequested: false,
      driving: false,
      planExecutionQueued: false,
      goalValidationEvidence: new Map(),
      goalValidationSequence: 0,
      generation: { stepStartedAt: null, firstTokenAt: null, outputTokens: 0, elapsedMs: 0 },
      archivedAt: null,
    };
    this.conversations.set(entry.id, entry);
    this.activeId = entry.id;
    this.persistEntry(entry);
    this.notifyActiveCwd(cwd);
    this.emitStatus(entry);
    return entry;
  }

  private async startInternal(entry: Conversation): Promise<SessionSnapshot> {
    this.patchEntry(entry, { status: "starting", error: null });
    try {
      const directory = await this.readyDirectory();
      const chosen = directory.availableSelection();
      const cwd = entry.snapshot.cwd;
      // 新对话:登记时已建或此处新建;恢复的对话:按文件打开以接续历史。
      const sessionManager = entry.sessionManager
        ?? (entry.sessionFile
          ? SessionManager.open(entry.sessionFile, this.sessionDir(), cwd)
          : SessionManager.create(cwd, this.sessionDir()));
      const settingsManager = SettingsManager.inMemory();
      const instructions = entry.instructions.trim();
      const resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir: this.options.agentDir,
        settingsManager,
        extensionFactories: [{
          name: "vela-mode",
          hidden: true,
          factory: createModeExtension(() => ({
            mode: entry.snapshot.mode,
            hasPlan: entry.snapshot.plan !== null,
          })),
        }],
        appendSystemPromptOverride: instructions ? (base) => [...base, instructions] : undefined,
      });
      await resourceLoader.reload();
      const { session } = await createAgentSession({
        cwd,
        agentDir: this.options.agentDir,
        sessionManager,
        settingsManager,
        resourceLoader,
        modelRuntime: directory.runtime,
        model: chosen,
        thinkingLevel: directory.selection.thinkingLevel,
        // tools 是 Pi 的注册表白名单(内置与自定义都过滤),模式工具必须并入才能被激活。
        tools: [...defaultToolNames, ...modeToolNames, subagentToolName],
        customTools: [
          ...(this.options.toolFactory?.(cwd) ?? []),
          ...createModeTools({
            submitPlan: (draft) => this.submitPlan(entry, draft),
            completeStep: (id) => this.completeStep(entry, id),
            updateGoal: (status, note) => this.updateGoal(entry, status, note),
            recordGoalValidation: (draft) => this.recordGoalValidation(entry, draft),
            askUser: (input) => this.askUser(entry, input),
          }),
          createSubagentTool({
            run: (request) => this.enqueueSubagent(entry.id, () => this.runSubagent(entry, request)),
          }),
        ],
      });
      // 没有显式选择时，Pi 会挑第一个带本机环境变量的模型。这里清掉，只保留用户在 Vela 里选的模型。
      if (!chosen) clearSessionModel(session);
      this.attachEntry(entry, session, sessionManager);
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

  private async applySavedModel(): Promise<void> {
    const directory = this.directory;
    if (!directory) return;
    const chosen = directory.availableSelection();
    if (!chosen) {
      const active = this.activeConversation();
      if (active) this.syncFromSession(active);
      return;
    }
    await this.applyModel(chosen, directory.selection.thinkingLevel);
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
    entry.unsubscribe = session.subscribe((event) => {
      this.handlePiEvent(entry.id, event);
    });
  }

  private detachEntry(entry: Conversation): void {
    entry.unsubscribe?.();
    entry.unsubscribe = null;
    entry.session?.dispose();
    entry.session = null;
  }

  private handlePiEvent(conversationId: string, event: AgentSessionEvent): void {
    // agent 循环里每步 assistant 消息都要在界面上独立成块;user/toolResult 的 message_start 不是边界。
    if (event.type === "message_start" && event.message.role === "assistant") {
      const entry = this.conversations.get(conversationId);
      if (entry) {
        entry.generation.stepStartedAt = Date.now();
        entry.generation.firstTokenAt = null;
      }
      this.emit({ type: "assistant_start", conversationId });
      return;
    }
    if (event.type === "message_end") {
      this.recordGeneration(conversationId, event.message);
      return;
    }
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (update.type === "text_delta" || update.type === "thinking_delta") {
        const entry = this.conversations.get(conversationId);
        // 首字到达前的等待属于提示词处理,不计入生成速度。
        if (entry && entry.generation.firstTokenAt === null) entry.generation.firstTokenAt = Date.now();
      }
      if (update.type === "text_delta") this.emit({ type: "text_delta", conversationId, delta: update.delta });
      else if (update.type === "thinking_delta") this.emit({ type: "thinking_delta", conversationId, delta: update.delta });
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
    this.emit({ type: "error", conversationId: entry.id, message });
    this.patchEntry(entry, { status: "ready", error: null });
  }

  private patchEntry(entry: Conversation, patch: Partial<SessionSnapshot> & { updatedAt?: number }): void {
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
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      messageCount: this.store.get(entry.id)?.messageCount ?? 0,
      toolCallCount: this.store.get(entry.id)?.toolCallCount ?? 0,
      sessionFile: entry.sessionFile,
      instructions: entry.instructions,
      mode: entry.snapshot.mode,
      plan: entry.snapshot.plan,
      goal: entry.snapshot.goal,
      archivedAt: entry.archivedAt,
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
      plan: null,
      goal: null,
      error: null,
    };
  }

  private requireIdle(conversationId: string): Conversation {
    const entry = this.conversations.get(conversationId);
    const session = entry?.session;
    if (!entry || !session) throw new Error("对话不存在或已结束");
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
    let current: { text: string; images?: ImageAttachment[]; hidden?: boolean } | null = {
      text,
      images,
      hidden: options.hidden,
    };
    let announce = options.announce;
    let rename = options.rename;
    let continuations = 0;
    try {
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
        // 计划确认提问里用户选了「执行计划」:切回 Agent 模式,把计划正文作为下一轮输入。
        const queued = entry.planExecutionQueued;
        entry.planExecutionQueued = false;
        if (queued && outcome === "ok" && !entry.stopRequested) {
          const plan = entry.snapshot.plan;
          if (plan) {
            if (entry.snapshot.mode === "goal") this.pauseGoal(entry, null);
            if (entry.snapshot.mode !== "agent") this.patchEntry(entry, { mode: "agent" });
            this.applyActiveTools(entry);
            current = { text: planExecutionPrompt(plan), hidden: true };
            continue;
          }
        }
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
      entry.driving = false;
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
    const previousError = readSessionError(session);
    this.patchEntry(entry, {
      status: "streaming",
      error: null,
      title: options.rename && entry.snapshot.title === "新对话" ? clipTitle(text) : entry.snapshot.title,
      updatedAt: Date.now(),
    });
    try {
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
        this.failPrompt(entry, failure);
        return "error";
      }
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
      this.failPrompt(entry, error instanceof Error ? error.message : "会话执行失败");
      return "error";
    }
  }

  private enqueueSubagent<T>(conversationId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.subagentTail.get(conversationId) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.subagentTail.set(conversationId, tail);
    return previous.then(run).finally(() => {
      release();
      if (this.subagentTail.get(conversationId) === tail) this.subagentTail.delete(conversationId);
    });
  }

  private async runSubagent(entry: Conversation, request: SubagentRequest): Promise<SubagentResult> {
    const session = entry.session;
    const directory = this.directory;
    const model = session?.model;
    if (!session || !directory || !model || !directory.isAvailable(model)) {
      throw new Error("先选择一个已登录或已配置密钥的模型");
    }
    return runBuiltinSubagent({
      agent: request.agent,
      task: request.task,
      cwd: entry.snapshot.cwd,
      agentDir: this.options.agentDir,
      model,
      thinkingLevel: session.thinkingLevel,
      modelRuntime: directory.runtime,
      instructions: entry.instructions,
      tools: this.options.toolFactory?.(entry.snapshot.cwd) ?? [],
      signal: request.signal,
      onProgress: request.onProgress,
    });
  }

  private applyActiveTools(entry: Conversation): void {
    const tools = toolNamesFor(entry.snapshot.mode, entry.snapshot.plan !== null);
    entry.session?.setActiveToolsByName(tools);
    this.patchEntry(entry, { tools });
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
   * plan_confirm 是提交计划后的执行确认,用户选「执行计划」时记下标志,
   * 由 drive() 在本轮回复结束后自动开始执行。
   */
  private async askUser(entry: Conversation, input: AskUserInput): Promise<AskUserOutcome> {
    const confirm = input.kind === "plan_confirm";
    const question = clipField(input.question, 500);
    if (!question) return { ok: false, text: "问题不能为空。" };
    const options = confirm
      ? planConfirmOptions
      : input.options.slice(0, 4).map((option) => ({
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
    if (confirm && answer === planConfirmExecuteLabel && entry.snapshot.mode === "plan" && entry.snapshot.plan) {
      entry.planExecutionQueued = true;
      return {
        ok: true,
        text: "用户确认执行计划。请立即结束本轮回复，系统会自动开始执行计划，现在不要修改文件。",
        answer,
      };
    }
    return { ok: true, text: `用户回答：${clipField(answer, 2000)}`, answer };
  }

  private submitPlan(entry: Conversation, draft: PlanDraft): ToolOutcome {
    const accepted = acceptPlanDraft(draft);
    if (!accepted.ok) return accepted;
    const { title, overview } = accepted.plan;
    const steps = accepted.plan.steps.map((text): PlanStep => ({ id: randomUUID(), text, done: false }));
    const plan: ConversationPlan = { title, overview, steps, updatedAt: Date.now() };
    this.patchEntry(entry, { plan });
    return {
      ok: true,
      text: `已提交计划「${title}」，共 ${steps.length} 步。请立即调用 ask_user_question（kind 设为 plan_confirm）问用户是否执行。`,
    };
  }

  private completeStep(entry: Conversation, id: string): ToolOutcome {
    const plan = entry.snapshot.plan;
    if (!plan) return { ok: false, text: "当前没有计划。" };
    const step = plan.steps.find((item) => item.id === id);
    if (!step) return { ok: false, text: `找不到步骤 ${id}。` };
    this.patchEntry(entry, {
      plan: {
        ...plan,
        updatedAt: Date.now(),
        steps: plan.steps.map((item) => (item.id === id ? { ...item, done: true } : item)),
      },
    });
    return { ok: true, text: `已完成：${step.text}` };
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

function clipTitle(text: string): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length > 32 ? `${singleLine.slice(0, 32)}…` : singleLine;
}

function normalizeGeneratedTitle(text: string): string {
  const firstLine = text.replace(/\r/g, "").split("\n", 1)[0]?.trim() ?? "";
  const withoutPrefix = firstLine.replace(/^(?:标题|title)\s*[:：]\s*/i, "");
  const withoutWrapping = withoutPrefix
    .replace(/^#+\s*/, "")
    .replace(/^[`"'“‘《]+/, "")
    .replace(/[`"'”’》]+$/, "")
    .trim();
  return clipTitle(withoutWrapping);
}

function clipObjective(text: string): string {
  return clipField(text.replace(/\s+/g, " "), 500);
}

function clipField(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

function clonePlan(plan: ConversationPlan | null): ConversationPlan | null {
  if (!plan) return null;
  return { ...plan, steps: plan.steps.map((step) => ({ ...step })) };
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
  if (toolName !== subagentToolName) return false;
  if (!args || typeof args !== "object") return true;
  return (args as { agent?: unknown }).agent !== "explore";
}

function readSessionError(session: AgentSession): string | null {
  const errorMessage = session.agent.state.errorMessage;
  return errorMessage?.trim() ? errorMessage : null;
}

/** 把 Pi 的会话消息重建为界面消息，并带上命令、输出、diff 和文件正文。 */
function transcriptFromMessages(messages: AgentMessage[]): TranscriptMessage[] {
  const result: TranscriptMessage[] = [];
  const argsByCall = new Map<string, unknown>();
  for (const message of messages) {
    if (message.role === "user") {
      const parts = typeof message.content === "string"
        ? [{ type: "text" as const, text: message.content }]
        : message.content;
      const text = userMessageText(message);
      const imageCount = parts.filter((part) => part.type === "image").length;
      const fullText = imageCount > 0 ? `${text}\n\n[图片 ×${imageCount}]` : text;
      if (!fullText.trim() || isPlanExecutionPrompt(text)) continue;
      result.push({ id: randomUUID(), role: "user", text: fullText, thinking: "", tools: [] });
      continue;
    }

    if (message.role === "assistant") {
      let text = "";
      let thinking = "";
      const tools: TranscriptTool[] = [];
      for (const part of message.content) {
        if (part.type === "text") text += part.text;
        else if (part.type === "thinking") thinking += part.thinking;
        else if (part.type === "toolCall") {
          argsByCall.set(part.id, part.arguments);
          tools.push({
            id: part.id,
            name: part.name,
            status: "done",
            activity: activityFromCall(part.name, part.arguments),
          });
        }
      }
      if (!text && !thinking && tools.length === 0) continue;
      result.push({ id: randomUUID(), role: "assistant", text, thinking, tools });
      continue;
    }

    if (message.role === "toolResult") {
      for (const entry of result) {
        const tool = entry.tools.find((item) => item.id === message.toolCallId);
        if (!tool) continue;
        tool.status = message.isError ? "error" : "done";
        tool.activity = activityFromExecution(
          message.toolName || tool.name,
          argsByCall.get(message.toolCallId),
          message,
          message.isError,
        );
      }
    }
  }
  return result;
}
