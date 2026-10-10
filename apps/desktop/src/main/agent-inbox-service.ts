import { randomUUID } from "node:crypto";
import { readFileSync, renameSync } from "node:fs";
import {
  agentInboxBadge,
  agentInboxDecisions,
  agentInboxItemTypes,
  agentInboxLimits,
  agentInboxOrigins,
  agentInboxPriorities,
  agentInboxReadStates,
  agentInboxSchemaVersion,
  agentInboxStatuses,
  compareAgentInboxItems,
  createLogger,
  isAgentInboxOpen,
  type AgentInboxChange,
  type AgentInboxContentRef,
  type AgentInboxDecideRequest,
  type AgentInboxDecideResult,
  type AgentInboxDecision,
  type AgentInboxDetail,
  type AgentInboxItem,
  type AgentInboxItemType,
  type AgentInboxListQuery,
  type AgentInboxListResult,
  type AgentInboxOrigin,
  type AgentInboxPriority,
  type AgentInboxStatus,
} from "@vela/shared";
import { writeJsonAtomic } from "./atomic-json";

const log = createLogger("agent-inbox");

/** Host 的权威回复入口。返回 false 表示原等待点已经不存在。 */
export interface AgentInboxResolver {
  approve(requestId: string, allowed: boolean): boolean;
  answer(requestId: string, answer: string | null): boolean;
}

/** 适配器提交的来源事件。同一个 sourceEventId 只会产生一个事项。 */
export interface AgentInboxEvent {
  sourceEventId: string;
  type: AgentInboxItemType;
  origin: AgentInboxOrigin;
  title: string;
  summary: string;
  detail: AgentInboxDetail;
  priority?: AgentInboxPriority;
  /** 默认：approval / question / review / error 待决，其余为已落定。 */
  status?: AgentInboxStatus;
  actions?: AgentInboxDecision[];
  /** 已落定事项的结果说明，例如 responded / failed / success / interrupted。 */
  outcome?: string;
  conversationId?: string;
  agentId?: string;
  taskId?: string;
  workspaceId?: string;
  requestId?: string;
  createdAt?: number;
  expiresAt?: number;
  contentRef?: AgentInboxContentRef;
  reason?: string;
}

export interface AgentInboxCursors {
  /** 已经处理过的定时任务执行记录的最晚结束时间。 */
  scheduledRunsAt: number | null;
}

interface Stored {
  schemaVersion: number;
  revision: number;
  items: AgentInboxItem[];
  cursors: AgentInboxCursors;
}

const pendingByDefault: ReadonlySet<AgentInboxItemType> = new Set(["approval", "question", "review", "error"]);
const defaultActions: Record<AgentInboxItemType, AgentInboxDecision[]> = {
  approval: ["approve", "deny"],
  question: ["answer", "skip"],
  review: ["acknowledge"],
  error: ["acknowledge"],
  result: [],
  alert: [],
  suggestion: [],
  system: [],
};

/**
 * Agent Inbox 的持久化事项库。先落盘、后通知；业务状态只能由 Host 事件或经 Host 确认的决策推进。
 * 审批与问题的等待点只存在于内存，所以启动时仍然待决的这两类事项一律作废，不会重放。
 */
export class AgentInboxService {
  private items = new Map<string, AgentInboxItem>();
  private bySource = new Map<string, string>();
  private cursors: AgentInboxCursors = { scheduledRunsAt: null };
  private revision = 0;
  private error: string | null = null;
  private readonly listeners = new Set<(change: AgentInboxChange) => void>();

  constructor(
    private readonly file: string,
    private readonly resolver: AgentInboxResolver,
    private readonly now: () => number = Date.now,
  ) {}

  init(): void {
    const stored = this.load();
    if (!stored) return;
    this.revision = stored.revision;
    this.cursors = stored.cursors;
    for (const item of stored.items) this.index(item);
    const invalidated: AgentInboxItem[] = [];
    for (const item of this.items.values()) {
      if (!isAgentInboxOpen(item.status) || (item.type !== "approval" && item.type !== "question")) continue;
      invalidated.push(this.apply(item, { status: "invalidated", outcome: "app_restarted", actions: [] }));
    }
    if (invalidated.length) this.commit(invalidated);
  }

  subscribe(listener: (change: AgentInboxChange) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  getError(): string | null { return this.error; }
  getCursors(): AgentInboxCursors { return { ...this.cursors }; }

  setCursor(name: keyof AgentInboxCursors, value: number | null): void {
    if (this.cursors[name] === value) return;
    this.cursors = { ...this.cursors, [name]: value };
    this.commit([]);
  }

  list(query: AgentInboxListQuery = {}): AgentInboxListResult {
    const limit = Math.max(1, Math.min(agentInboxLimits.pageSize, Math.floor(query.limit ?? agentInboxLimits.pageSize)));
    const archived = query.archived === true;
    const sorted = [...this.items.values()]
      .filter(item => (item.readState === "archived") === archived)
      .filter(item => query.before === undefined || item.updatedAt < query.before)
      .sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1));
    const items = sorted.slice(0, limit);
    return {
      items,
      nextBefore: sorted.length > limit ? items[items.length - 1]!.updatedAt : null,
      badge: this.badge(),
      revision: this.revision,
      error: this.error,
    };
  }

  get(id: string): AgentInboxItem | null { return this.items.get(id) ?? null; }

  /** 当前待处理的审批与提问所属的对话，供常驻 Agent 判断「是否在等你」。 */
  pendingWaits(): Array<{ conversationId: string | undefined; type: AgentInboxItemType }> {
    const waits: Array<{ conversationId: string | undefined; type: AgentInboxItemType }> = [];
    for (const item of this.items.values()) {
      if (item.status === "pending" && (item.type === "approval" || item.type === "question")) waits.push({ conversationId: item.conversationId, type: item.type });
    }
    return waits;
  }

  pendingCount(): number { return this.badge(); }

  /** 常驻 Agent 能读到的事项摘要：只有类型、状态、标题和安全摘要，不含命令全文或对话记录。 */
  summaries(filter: { pendingOnly: boolean; limit: number }): Array<{ id: string; type: string; status: string; title: string; summary: string; workspace?: string; updatedAt: number }> {
    return [...this.items.values()]
      .filter(item => !filter.pendingOnly || item.status === "pending")
      .sort(compareAgentInboxItems)
      .slice(0, Math.max(1, Math.min(50, filter.limit)))
      .map(item => ({
        id: item.id, type: item.type, status: item.status, title: item.title, summary: item.summary.slice(0, 300),
        ...(item.workspaceId ? { workspace: item.workspaceId } : {}), updatedAt: item.updatedAt,
      }));
  }
  getBySource(sourceEventId: string): AgentInboxItem | null {
    const id = this.bySource.get(sourceEventId);
    return id ? this.items.get(id) ?? null : null;
  }

  /** 创建事项；同一个来源事件重复到达时返回已有事项，不产生第二条。 */
  upsert(event: AgentInboxEvent): AgentInboxItem {
    const existing = this.getBySource(event.sourceEventId);
    if (existing) return existing;
    const now = this.now();
    const status = event.status ?? (pendingByDefault.has(event.type) ? "pending" : "resolved");
    const open = isAgentInboxOpen(status);
    const item: AgentInboxItem = {
      id: randomUUID(),
      schemaVersion: agentInboxSchemaVersion,
      type: event.type,
      origin: event.origin,
      status,
      readState: "unread",
      priority: event.priority ?? (event.type === "approval" || event.type === "question" ? "high" : event.type === "error" ? "high" : "normal"),
      title: event.title.slice(0, agentInboxLimits.maxTitle),
      summary: event.summary.slice(0, agentInboxLimits.maxSummary),
      sourceEventId: event.sourceEventId,
      ...(event.conversationId ? { conversationId: event.conversationId } : {}),
      ...(event.agentId ? { agentId: event.agentId } : {}),
      ...(event.taskId ? { taskId: event.taskId } : {}),
      ...(event.workspaceId ? { workspaceId: event.workspaceId } : {}),
      ...(event.requestId ? { requestId: event.requestId } : {}),
      revision: 1,
      createdAt: event.createdAt ?? now,
      updatedAt: now,
      ...(event.expiresAt !== undefined ? { expiresAt: event.expiresAt } : {}),
      ...(event.outcome ? { outcome: event.outcome } : {}),
      ...(event.contentRef ? { contentRef: event.contentRef } : {}),
      ...(event.reason ? { reason: event.reason.slice(0, 300) } : {}),
      ...(open ? {} : { resolvedAt: now }),
      actions: open ? (event.actions ?? defaultActions[event.type]) : [],
      detail: event.detail,
      decisions: {},
    };
    this.index(item);
    this.prune();
    this.commit([item]);
    return item;
  }

  /**
   * 由 Host 的权威事件推进业务状态。只有待决事项可以落定，已经落定的事项保持原样，
   * 因此聊天与 Inbox 同时回答时，后到的事件不会覆盖先到的结果。
   */
  settle(sourceEventId: string, result: { status: AgentInboxStatus; outcome: string; detail?: AgentInboxDetail }): AgentInboxItem | null {
    const item = this.getBySource(sourceEventId);
    if (!item) return null;
    if (!isAgentInboxOpen(item.status)) return item;
    const next = this.apply(item, { ...result, actions: [] });
    this.commit([next]);
    return next;
  }

  /**
   * 提交一个决策。整个流程同步完成：校验、调用 Host、写盘，所以同一事项上的并发提交
   * 中只有第一个能越过 pending 检查。
   */
  decide(request: AgentInboxDecideRequest): AgentInboxDecideResult {
    const item = this.items.get(request.itemId);
    if (!item) return { ok: false, reason: "not_found", item: null };
    const recorded = item.decisions[request.clientActionId];
    if (recorded) return recorded.ok ? { ok: true, item } : { ok: false, reason: recorded.reason, item };
    if (item.revision !== request.expectedRevision) return { ok: false, reason: "stale", item };
    if (item.status !== "pending") return this.record(item, request.clientActionId, { ok: false, reason: "not_pending" });
    if (!item.actions.includes(request.decision) || !agentInboxDecisions.includes(request.decision)) {
      return { ok: false, reason: "invalid", item };
    }
    const answer = request.decision === "answer" ? this.validAnswer(item, request.answer) : null;
    if (request.decision === "answer" && answer === null) return { ok: false, reason: "invalid", item };

    if (item.type === "approval" || item.type === "question") {
      if (!item.requestId) return this.invalidate(item, request.clientActionId);
      const accepted = item.type === "approval"
        ? this.resolver.approve(item.requestId, request.decision === "approve")
        : this.resolver.answer(item.requestId, request.decision === "answer" ? answer : null);
      if (!accepted) return this.invalidate(item, request.clientActionId);
    }

    // Host 的 resolved 事件通常已经同步推进了状态；没有时由这里补上同样的结果。
    const settled = this.settle(item.sourceEventId, decisionResult(item, request, answer)) ?? item;
    return this.record(settled, request.clientActionId, { ok: true });
  }

  markRead(id: string): AgentInboxItem | null {
    const item = this.items.get(id);
    if (!item) return null;
    if (item.readState !== "unread") return item;
    const next = { ...item, readState: "read" as const };
    this.items.set(id, next);
    this.commit([next]);
    return next;
  }

  /** 归档只改变展示，不改变业务状态，也不会同意、拒绝或解除任何阻塞。 */
  archive(id: string, archived: boolean): AgentInboxItem | null {
    const item = this.items.get(id);
    if (!item) return null;
    const readState = archived ? "archived" : "read";
    if (item.readState === readState) return item;
    const next = { ...item, readState } as AgentInboxItem;
    this.items.set(id, next);
    this.commit([next]);
    return next;
  }

  private validAnswer(item: AgentInboxItem, raw: string | undefined): string | null {
    if (item.detail.kind !== "question" || typeof raw !== "string") return null;
    const answer = raw.trim();
    if (!answer || answer.length > agentInboxLimits.maxAnswer) return null;
    if (item.detail.allowFreeText || item.detail.options.some(option => option.label === answer)) return answer;
    return null;
  }

  private invalidate(item: AgentInboxItem, clientActionId: string): AgentInboxDecideResult {
    const next = this.apply(item, { status: "invalidated", outcome: "request_gone", actions: [] });
    next.decisions = { ...next.decisions, [clientActionId]: { ok: false, reason: "invalidated" } };
    this.items.set(next.id, next);
    this.commit([next]);
    return { ok: false, reason: "invalidated", item: next };
  }

  private record(item: AgentInboxItem, clientActionId: string, record: AgentInboxItem["decisions"][string]): AgentInboxDecideResult {
    const keys = Object.keys(item.decisions);
    const decisions = { ...item.decisions };
    if (keys.length >= agentInboxLimits.maxDecisions) delete decisions[keys[0]!];
    decisions[clientActionId] = record;
    const next = { ...item, decisions };
    this.items.set(next.id, next);
    this.commit([next]);
    return record.ok ? { ok: true, item: next } : { ok: false, reason: record.reason, item: next };
  }

  private apply(
    item: AgentInboxItem,
    change: { status: AgentInboxStatus; outcome: string; actions: AgentInboxDecision[]; detail?: AgentInboxDetail },
  ): AgentInboxItem {
    const now = this.now();
    const next: AgentInboxItem = {
      ...item,
      status: change.status,
      outcome: change.outcome,
      actions: change.actions,
      detail: change.detail ?? item.detail,
      revision: item.revision + 1,
      updatedAt: now,
      ...(isAgentInboxOpen(change.status) ? {} : { resolvedAt: now }),
    };
    this.items.set(next.id, next);
    return next;
  }

  private badge(): number { return agentInboxBadge([...this.items.values()]); }

  private index(item: AgentInboxItem): void {
    this.items.set(item.id, item);
    this.bySource.set(item.sourceEventId, item.id);
  }

  private prune(): void {
    const excess = this.items.size - agentInboxLimits.maxItems;
    if (excess <= 0) return;
    const removable = [...this.items.values()]
      .filter(item => !isAgentInboxOpen(item.status))
      .sort((a, b) => Number(b.readState === "archived") - Number(a.readState === "archived") || a.updatedAt - b.updatedAt);
    for (const item of removable.slice(0, excess)) {
      this.items.delete(item.id);
      this.bySource.delete(item.sourceEventId);
    }
  }

  /** 先写盘，成功后才通知监听者。写盘失败时抛出，调用方不会看到半成功的状态。 */
  private commit(changed: AgentInboxItem[]): void {
    this.revision += 1;
    const stored: Stored = {
      schemaVersion: agentInboxSchemaVersion,
      revision: this.revision,
      items: [...this.items.values()],
      cursors: this.cursors,
    };
    try {
      writeJsonAtomic(this.file, stored);
    } catch (error) {
      this.revision -= 1;
      log.error("agent inbox write failed", error);
      throw error;
    }
    const change: AgentInboxChange = { revision: this.revision, upserts: changed, badge: this.badge(), error: this.error };
    for (const listener of this.listeners) {
      try { listener(change); } catch (error) { log.error("agent inbox listener failed", error); }
    }
  }

  private load(): Stored | null {
    let raw: string;
    try { raw = readFileSync(this.file, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      this.error = `无法读取 Agent Inbox 存储：${(error as Error).message}`;
      throw error;
    }
    try {
      return parseStored(JSON.parse(raw));
    } catch (error) {
      const quarantined = `${this.file}.corrupt-${this.now()}`;
      try { renameSync(this.file, quarantined); } catch { /* 隔离失败时仍然从空库开始，原文件会被下次写入覆盖。 */ }
      this.error = `Agent Inbox 存储已损坏，已隔离为 ${quarantined}`;
      log.error("agent inbox store corrupt", error);
      return null;
    }
  }
}

function decisionResult(
  item: AgentInboxItem,
  request: AgentInboxDecideRequest,
  answer: string | null,
): { status: AgentInboxStatus; outcome: string; detail?: AgentInboxDetail } {
  switch (request.decision) {
    case "approve": return { status: "resolved", outcome: "approved" };
    case "deny": return { status: "rejected", outcome: "denied" };
    case "answer": {
      const detail = item.detail.kind === "question" ? { ...item.detail, answer } : undefined;
      return { status: "resolved", outcome: "answered", ...(detail ? { detail } : {}) };
    }
    case "skip": return { status: "cancelled", outcome: "skipped" };
    default: return { status: "resolved", outcome: "acknowledged" };
  }
}

function parseStored(value: unknown): Stored {
  const stored = value as Partial<Stored> | null;
  if (!stored || stored.schemaVersion !== agentInboxSchemaVersion || !Number.isFinite(stored.revision) || !Array.isArray(stored.items)) {
    throw new Error("Agent Inbox 存储格式不正确");
  }
  const ids = new Set<string>();
  const sources = new Set<string>();
  for (const item of stored.items as AgentInboxItem[]) {
    if (
      !item || typeof item.id !== "string" || ids.has(item.id) || typeof item.sourceEventId !== "string" || sources.has(item.sourceEventId) ||
      !agentInboxItemTypes.includes(item.type) || !agentInboxOrigins.includes(item.origin) || !agentInboxStatuses.includes(item.status) ||
      !agentInboxReadStates.includes(item.readState) || !agentInboxPriorities.includes(item.priority) ||
      !Number.isFinite(item.revision) || !Number.isFinite(item.createdAt) || !Number.isFinite(item.updatedAt) ||
      !Array.isArray(item.actions) || !item.detail || typeof item.detail !== "object" || typeof item.decisions !== "object" || !item.decisions
    ) throw new Error("Agent Inbox 事项记录不正确");
    ids.add(item.id);
    sources.add(item.sourceEventId);
  }
  const cursors = stored.cursors;
  const scheduledRunsAt = cursors && (cursors.scheduledRunsAt === null || Number.isFinite(cursors.scheduledRunsAt)) ? cursors.scheduledRunsAt ?? null : null;
  return { schemaVersion: agentInboxSchemaVersion, revision: stored.revision as number, items: stored.items as AgentInboxItem[], cursors: { scheduledRunsAt } };
}
