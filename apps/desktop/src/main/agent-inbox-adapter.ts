import {
  agentInboxLimits,
  approvalOutcome,
  latestUiReply,
  uiContentRef,
  type AgentInboxContentRef,
  boundApprovalRequest,
  createLogger,
  questionDetail,
  questionOutcome,
  truncateInboxText,
  type AgentInfo,
  type AskUserQuestionEvent,
  type ConversationSummary,
  type SandboxApprovalEvent,
  type ScheduledTaskRun,
  type ScheduledTasksState,
  type TranscriptMessage,
} from "@vela/shared";
import type { AgentInboxService } from "./agent-inbox-service";

const log = createLogger("agent-inbox");

/** 适配器只依赖运行时的这几个读取入口，测试里用假对象替换。 */
export interface AgentInboxRuntimeSource {
  subscribe(listener: (event: AgentInboxRuntimeEvent) => void): () => void;
  subscribeQuestions(listener: (event: AskUserQuestionEvent) => void): () => void;
  listConversations(): Pick<ConversationSummary, "id" | "title" | "cwd" | "hasWorkspace">[];
  getMessages(conversationId: string): Pick<TranscriptMessage, "role" | "text">[];
}

export type AgentInboxRuntimeEvent =
  | { type: "prompt_end"; conversationId: string; status: "responded" | "stopped" | "failed"; error?: string; planPending: boolean }
  | { type: "agents"; conversationId: string; agents: AgentInfo[] }
  | { type: string; conversationId?: string };

export interface AgentInboxSandboxSource {
  subscribe(listener: (event: SandboxApprovalEvent) => void): () => void;
}

export interface AgentInboxSchedulerSource {
  list(): ScheduledTasksState;
  subscribe(listener: (state: ScheduledTasksState) => void): () => void;
}

/** 常驻 Agent 创建的对话（它自己的会话、委派的任务、主动规则的分析）的分类，由 Supervisor 提供。 */
export interface AgentInboxTaskInfo {
  /** 常驻 Agent 自己的持久会话：回复在常驻页里看，不进收件箱，失败除外。 */
  isResident: boolean;
  origin: "resident" | "proactive";
  taskId?: string;
  title?: string;
  /** 主动规则的结果是建议，而不是普通结果。 */
  suggestion?: boolean;
  timedOut?: boolean;
  reason?: string;
}

export interface AgentInboxTaskSource {
  classify(conversationId: string): AgentInboxTaskInfo | null;
}

export interface AgentInboxAdapterOptions {
  tasks?: AgentInboxTaskSource;
  service: AgentInboxService;
  runtime: AgentInboxRuntimeSource;
  sandbox: AgentInboxSandboxSource;
  scheduler: AgentInboxSchedulerSource;
  /** 审批无人回复时的自动拒绝时间，用来区分「拒绝」与「超时」。 */
  approvalTimeoutMs: number;
  now?: () => number;
}

/**
 * 把现有运行时事件翻译成 Inbox 事项，不改变原事件的语义。
 * 审批与问题的最终状态只取自 Host 的 resolved 事件，所以在聊天里回答和在 Inbox 里回答会汇合到同一个结果。
 */
export class AgentInboxAdapter {
  private readonly unsubscribe: Array<() => void> = [];
  private readonly agentStatus = new Map<string, string>();
  private started = false;
  private readonly now: () => number;

  constructor(private readonly options: AgentInboxAdapterOptions) {
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const { runtime, sandbox, scheduler, service } = this.options;
    if (service.getCursors().scheduledRunsAt === null) service.setCursor("scheduledRunsAt", this.now());
    this.unsubscribe.push(
      sandbox.subscribe(event => this.guard(() => this.onApproval(event))),
      runtime.subscribeQuestions(event => this.guard(() => this.onQuestion(event))),
      runtime.subscribe(event => this.guard(() => this.onRuntime(event))),
      scheduler.subscribe(state => this.guard(() => this.onScheduled(state))),
    );
    // 启动前就结束的定时任务（包括重启时被标记为中断的）也要补进来。
    this.guard(() => this.onScheduled(scheduler.list()));
  }

  stop(): void {
    for (const off of this.unsubscribe.splice(0)) off();
    this.started = false;
  }

  /** 一个来源出错不能影响其他来源，也不能让运行时事件循环抛出。 */
  private guard(work: () => void): void {
    try { work(); } catch (error) { log.error("agent inbox adapter failed", error); }
  }

  private conversation(id: string | undefined): Pick<ConversationSummary, "id" | "title" | "cwd" | "hasWorkspace"> | null {
    if (!id) return null;
    return this.options.runtime.listConversations().find(conversation => conversation.id === id) ?? null;
  }

  private workspaceOf(conversation: ReturnType<AgentInboxAdapter["conversation"]>): string | undefined {
    return conversation && conversation.hasWorkspace !== false ? conversation.cwd : undefined;
  }

  private onApproval(event: SandboxApprovalEvent): void {
    const { service } = this.options;
    if (event.type === "request") {
      const request = event.request;
      const conversation = this.conversation(request.conversationId);
      const subject = request.command ?? request.path ?? "";
      const workspace = this.workspaceOf(conversation) ?? request.cwd ?? undefined;
      service.upsert({
        sourceEventId: `approval:${request.id}`,
        type: "approval",
        origin: "sandbox",
        title: conversation?.title ?? "",
        summary: truncateInboxText(subject, agentInboxLimits.maxSummary),
        detail: { kind: "approval", request: boundApprovalRequest(request) },
        requestId: request.id,
        createdAt: request.createdAt,
        expiresAt: request.createdAt + this.options.approvalTimeoutMs,
        ...(request.conversationId ? { conversationId: request.conversationId } : {}),
        ...(workspace ? { workspaceId: workspace } : {}),
      });
      return;
    }
    const sourceEventId = `approval:${event.id}`;
    const item = service.getBySource(sourceEventId);
    if (!item) return;
    service.settle(sourceEventId, approvalOutcome(event.allowed, item.createdAt, this.now(), this.options.approvalTimeoutMs));
  }

  private onQuestion(event: AskUserQuestionEvent): void {
    const { service } = this.options;
    if (event.type === "request") {
      const request = event.request;
      const conversation = this.conversation(request.conversationId);
      service.upsert({
        sourceEventId: `question:${request.id}`,
        type: "question",
        origin: "question",
        title: conversation?.title ?? "",
        summary: truncateInboxText(request.question, agentInboxLimits.maxSummary),
        detail: questionDetail(request),
        requestId: request.id,
        conversationId: request.conversationId,
        createdAt: request.createdAt,
        ...(this.workspaceOf(conversation) ? { workspaceId: this.workspaceOf(conversation)! } : {}),
      });
      return;
    }
    const sourceEventId = `question:${event.id}`;
    const item = service.getBySource(sourceEventId);
    if (!item) return;
    const result = questionOutcome(event.answer);
    service.settle(sourceEventId, {
      ...result,
      ...(item.detail.kind === "question" && event.answer !== null ? { detail: { ...item.detail, answer: event.answer } } : {}),
    });
  }

  private onRuntime(event: AgentInboxRuntimeEvent): void {
    if (event.type === "prompt_end") this.onPromptEnd(event as Extract<AgentInboxRuntimeEvent, { type: "prompt_end" }>);
    else if (event.type === "agents") this.onAgents(event as Extract<AgentInboxRuntimeEvent, { type: "agents" }>);
  }

  /**
   * 每个对话回合的结束都进入 Inbox，包括正在查看的对话：用户可能正停留在别的页面，Inbox 是完成记录的统一入口。
   * 用户主动停止的回合不记录；定时任务的对话由定时任务执行记录单独汇报，避免同一件事出现两条。
   */
  private onPromptEnd(event: Extract<AgentInboxRuntimeEvent, { type: "prompt_end" }>): void {
    const { scheduler, service } = this.options;
    const task = this.options.tasks?.classify(event.conversationId) ?? null;
    const conversation = this.conversation(event.conversationId);
    const base = {
      origin: task?.origin ?? "turn" as const,
      title: task?.title || (conversation?.title ?? ""),
      conversationId: event.conversationId,
      ...(task?.taskId ? { taskId: task.taskId } : {}),
      ...(task?.reason ? { reason: task.reason } : {}),
      ...(this.workspaceOf(conversation) ? { workspaceId: this.workspaceOf(conversation)! } : {}),
    };
    const key = `turn:${event.conversationId}:${this.now()}`;
    if (event.status === "stopped") {
      // 只有被时限停止的任务需要汇报；用户主动停止的不记录。
      if (task?.timedOut) {
        const text = "任务超过设定的最长运行时间，已被停止。";
        service.upsert({ ...base, sourceEventId: key, type: "error", outcome: "timed_out", summary: text, detail: { kind: "text", text } });
      }
      return;
    }
    if (!task && scheduler.list().runs.some(run => run.conversationId === event.conversationId)) return;
    if (event.status === "failed") {
      const text = truncateInboxText(event.error ?? "", agentInboxLimits.maxDetailText);
      service.upsert({ ...base, sourceEventId: key, type: "error", outcome: "failed", summary: truncateInboxText(text, agentInboxLimits.maxSummary), detail: { kind: "text", text } });
      return;
    }
    if (task?.isResident) return;
    const reply = this.lastReply(event.conversationId);
    service.upsert({
      ...base,
      sourceEventId: key,
      type: task?.suggestion ? "suggestion" : event.planPending ? "review" : "result",
      outcome: event.planPending ? "plan_ready" : "responded",
      summary: truncateInboxText(reply.text, agentInboxLimits.maxSummary),
      detail: { kind: "text", text: reply.text },
      ...(reply.contentRef ? { contentRef: reply.contentRef } : {}),
    });
  }

  /** 只汇报失败的子代理；完成的子代理会唤醒主代理，由主代理的回合结果汇报。 */
  private onAgents(event: Extract<AgentInboxRuntimeEvent, { type: "agents" }>): void {
    const { service } = this.options;
    for (const agent of event.agents) {
      if (agent.kind === "root") continue;
      const key = `${event.conversationId}:${agent.id}`;
      const previous = this.agentStatus.get(key);
      this.agentStatus.set(key, agent.status);
      if (agent.status !== "failed" || (previous !== "running" && previous !== "paused")) continue;
      const conversation = this.conversation(event.conversationId);
      const text = truncateInboxText(agent.error ?? "", agentInboxLimits.maxDetailText);
      service.upsert({
        sourceEventId: `subagent:${key}:${agent.activeMs}`,
        type: "error",
        outcome: "failed",
        origin: "subagent",
        title: agent.name,
        summary: truncateInboxText(text, agentInboxLimits.maxSummary),
        detail: { kind: "text", text },
        conversationId: event.conversationId,
        agentId: agent.id,
        ...(this.workspaceOf(conversation) ? { workspaceId: this.workspaceOf(conversation)! } : {}),
      });
    }
  }

  private onScheduled(state: ScheduledTasksState): void {
    const { service } = this.options;
    const cursor = service.getCursors().scheduledRunsAt;
    if (cursor === null) return;
    let latest = cursor;
    const finished = state.runs
      .filter((run): run is ScheduledTaskRun & { finishedAt: number } => run.status !== "running" && run.finishedAt !== null && run.finishedAt >= cursor)
      .sort((a, b) => a.finishedAt - b.finishedAt);
    for (const run of finished) {
      latest = Math.max(latest, run.finishedAt);
      const task = state.tasks.find(candidate => candidate.id === run.taskId);
      const conversation = this.conversation(run.conversationId ?? undefined);
      const succeeded = run.status === "success";
      const reply = succeeded && run.conversationId ? this.lastReply(run.conversationId) : null;
      const text = reply ? truncateInboxText(reply.text, agentInboxLimits.maxDetailText) : truncateInboxText(run.error ?? "", agentInboxLimits.maxDetailText);
      service.upsert({
        sourceEventId: `schedrun:${run.id}:${run.status}`,
        type: succeeded ? "result" : run.status === "skipped" ? "system" : "error",
        origin: "scheduled_task",
        outcome: run.status,
        title: task?.title ?? conversation?.title ?? "",
        summary: truncateInboxText(text, agentInboxLimits.maxSummary),
        detail: { kind: "text", text },
        taskId: run.taskId,
        createdAt: run.finishedAt,
        ...(reply?.contentRef ? { contentRef: reply.contentRef } : {}),
        ...(run.conversationId ? { conversationId: run.conversationId } : {}),
        ...(task?.workspace ? { workspaceId: task.workspace } : {}),
      });
    }
    if (latest !== cursor) service.setCursor("scheduledRunsAt", latest);
  }

  /**
   * 最后一条有正文的助手回复。含 Intelligent UI 时正文只保留围栏之外的文字，
   * 完整回复由 contentRef 定位，详情打开时再读取。
   */
  private lastReply(conversationId: string): { text: string; contentRef?: AgentInboxContentRef } {
    try {
      const messages = this.options.runtime.getMessages(conversationId);
      const ui = latestUiReply(messages);
      if (ui) return { text: stripUiFences(ui.text), contentRef: uiContentRef(conversationId, ui) };
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index]!;
        if (message.role === "assistant" && message.text.trim()) return { text: message.text };
      }
    } catch (error) {
      log.error("agent inbox could not read messages", error);
    }
    return { text: "" };
  }
}

/** 去掉 vela-ui 围栏块，只留给收件箱摘要用的说明文字。 */
export function stripUiFences(text: string): string {
  return text.replace(/(^|\n) {0,3}(`{3,}|~{3,})vela-ui[^\n]*\n[\s\S]*?(?:\n {0,3}\2[`~]*[ \t]*(?=\n|$)|$)/g, "$1").replace(/\n{3,}/g, "\n\n").trim();
}
