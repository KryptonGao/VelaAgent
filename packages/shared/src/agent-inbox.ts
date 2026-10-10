import type { AskUserQuestionRequest, QuestionOption, SandboxApprovalRequest } from "./index";
import { hashUiSource, mayContainUi } from "./intelligent-ui-parser";

export const agentInboxSchemaVersion = 1;

export const agentInboxLimits = {
  /** 本地保留的事项数量上限，超出后先淘汰最旧的已完成且已归档事项。 */
  maxItems: 1000,
  maxDecisions: 20,
  maxTitle: 200,
  maxSummary: 600,
  maxDetailText: 4000,
  maxCommand: 2000,
  maxAnswer: 4000,
  pageSize: 200,
} as const;

export const agentInboxItemTypes = ["approval", "question", "review", "result", "error", "alert", "suggestion", "system"] as const;
export type AgentInboxItemType = (typeof agentInboxItemTypes)[number];

/** 业务状态：只由 Host 的权威事件或经 Host 确认的决策改变，与阅读状态相互独立。 */
export const agentInboxStatuses = ["pending", "processing", "resolved", "rejected", "expired", "cancelled", "invalidated"] as const;
export type AgentInboxStatus = (typeof agentInboxStatuses)[number];

export const agentInboxReadStates = ["unread", "read", "archived"] as const;
export type AgentInboxReadState = (typeof agentInboxReadStates)[number];

export const agentInboxPriorities = ["low", "normal", "high", "critical"] as const;
export type AgentInboxPriority = (typeof agentInboxPriorities)[number];

/** Inbox 可以提交的决策。approve/deny 只对工具审批有效，answer/skip 只对用户问题有效。 */
export const agentInboxDecisions = ["approve", "deny", "answer", "skip", "acknowledge"] as const;
export type AgentInboxDecision = (typeof agentInboxDecisions)[number];

export type AgentInboxDetail =
  | { kind: "approval"; request: SandboxApprovalRequest }
  | { kind: "question"; toolCallId: string; question: string; options: QuestionOption[]; allowFreeText: boolean; answer?: string | null }
  | { kind: "text"; text: string };

/** 事项由哪类 Host 事件产生，界面据此显示本地化的来源说明。 */
export const agentInboxOrigins = ["sandbox", "question", "turn", "subagent", "scheduled_task", "resident", "proactive"] as const;
export type AgentInboxOrigin = (typeof agentInboxOrigins)[number];

/**
 * 指向对话里一条含 Intelligent UI 的助手回复。事项只保存定位，不复制正文：
 * 详情打开时由主进程按 conversationId + 序号读取原消息，状态快照沿用聊天里同一套键（会话 + u{序号} + artifactId）。
 */
export interface AgentInboxContentRef {
  conversationId: string;
  /** 第几条含界面的助手回复（从 0 数起），与聊天里的 `u{n}` 一致。 */
  uiOrdinal: number;
  /** 回复正文的指纹；回退或改写后与当前正文不一致时，不再渲染旧位置。 */
  fingerprint: string;
}

export interface AgentInboxContent {
  text: string;
  conversationId: string;
  uiOrdinal: number;
}

export type AgentInboxDecideFailure = "not_found" | "stale" | "not_pending" | "invalid" | "invalidated";

export interface AgentInboxItem {
  id: string;
  schemaVersion: number;
  type: AgentInboxItemType;
  origin: AgentInboxOrigin;
  status: AgentInboxStatus;
  readState: AgentInboxReadState;
  priority: AgentInboxPriority;
  title: string;
  summary: string;
  /** 来源事件的稳定标识，同一来源事件只会产生一个事项。 */
  sourceEventId: string;
  conversationId?: string;
  agentId?: string;
  taskId?: string;
  /** 工作区路径。 */
  workspaceId?: string;
  /** 权威请求标识：审批请求 id 或问题 id。 */
  requestId?: string;
  /** 业务状态变更时递增，用于决策的乐观并发控制；仅改阅读状态不会改变它。 */
  revision: number;
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
  resolvedAt?: number;
  /** Host 允许对该事项执行的决策；事项不再待决时为空。 */
  actions: AgentInboxDecision[];
  /** 业务状态落定时的说明，例如 approved / denied / answered / skipped / timed_out。 */
  outcome?: string;
  detail: AgentInboxDetail;
  /** clientActionId → 当时的处理结果，用来让重复提交得到相同结论。 */
  decisions: Record<string, AgentInboxDecisionRecord>;
  /** 结果里含 Intelligent UI 时，指向原回复。 */
  contentRef?: AgentInboxContentRef;
  /** 主动建议的触发原因：哪条规则、因为什么事件。 */
  reason?: string;
}

export type AgentInboxDecisionRecord = { ok: true } | { ok: false; reason: AgentInboxDecideFailure };

export interface AgentInboxDecideRequest {
  itemId: string;
  expectedRevision: number;
  decision: AgentInboxDecision;
  /** 仅 answer 决策使用。 */
  answer?: string;
  clientActionId: string;
}

export type AgentInboxDecideResult =
  | { ok: true; item: AgentInboxItem }
  | { ok: false; reason: AgentInboxDecideFailure; item: AgentInboxItem | null };

export interface AgentInboxListQuery {
  archived?: boolean;
  limit?: number;
  /** 只返回 updatedAt 严格小于它的事项，用于翻页。 */
  before?: number;
}

export interface AgentInboxListResult {
  items: AgentInboxItem[];
  nextBefore: number | null;
  badge: number;
  revision: number;
  /** 存储损坏等需要用户知道的错误。 */
  error: string | null;
}

export interface AgentInboxChange {
  revision: number;
  upserts: AgentInboxItem[];
  badge: number;
  error: string | null;
}

/** 主进程要求渲染层切换到的位置：通知被点击、菜单栏入口。 */
export type AgentInboxNavigation =
  | { view: "item"; itemId: string }
  | { view: "resident" }
  | { view: "inbox" };

export type AgentInboxSubmitResult = { ok: true } | { ok: false; message: string };

export interface AgentInboxApi {
  list(query?: AgentInboxListQuery): Promise<AgentInboxListResult>;
  get(id: string): Promise<AgentInboxItem | null>;
  /** 读取事项关联的完整回复，用于渲染 Intelligent UI；不可用时为 null。 */
  getContent(id: string): Promise<AgentInboxContent | null>;
  /** 把 Intelligent UI 的 submit_to_agent 发给事项所属的对话，目标由主进程按存储的事项决定。 */
  submitToSource(id: string, text: string): Promise<AgentInboxSubmitResult>;
  /** 取走尚未被渲染层消费的导航请求（窗口刚创建时渲染层还没订阅）。 */
  takeNavigation(): Promise<AgentInboxNavigation | null>;
  onNavigate(listener: (target: AgentInboxNavigation) => void): () => void;
  decide(request: AgentInboxDecideRequest): Promise<AgentInboxDecideResult>;
  markRead(id: string): Promise<AgentInboxItem | null>;
  archive(id: string, archived: boolean): Promise<AgentInboxItem | null>;
  subscribe(listener: (change: AgentInboxChange) => void): () => void;
}

export const AgentInboxIpc = {
  list: "agent-inbox:list",
  get: "agent-inbox:get",
  decide: "agent-inbox:decide",
  markRead: "agent-inbox:mark-read",
  archive: "agent-inbox:archive",
  change: "agent-inbox:change",
  content: "agent-inbox:content",
  submit: "agent-inbox:submit",
  takeNavigation: "agent-inbox:take-navigation",
  navigate: "agent-inbox:navigate",
} as const;

export const agentInboxIdPattern = /^[A-Za-z0-9_:.-]{1,200}$/;

const pendingStatuses: readonly AgentInboxStatus[] = ["pending", "processing"];
const terminalStatuses: readonly AgentInboxStatus[] = ["resolved", "rejected", "expired", "cancelled", "invalidated"];

export function isAgentInboxOpen(status: AgentInboxStatus): boolean {
  return pendingStatuses.includes(status);
}

export function isAgentInboxTerminal(status: AgentInboxStatus): boolean {
  return terminalStatuses.includes(status);
}

/** 真正需要用户处理的事项数。归档只改变展示，不改变这里的结果。 */
export function agentInboxBadge(items: readonly Pick<AgentInboxItem, "status">[]): number {
  let count = 0;
  for (const item of items) if (item.status === "pending") count += 1;
  return count;
}

const priorityRank: Record<AgentInboxPriority, number> = { critical: 3, high: 2, normal: 1, low: 0 };
const typeRank: Record<AgentInboxItemType, number> = {
  approval: 7, question: 6, error: 5, review: 4, alert: 3, result: 2, suggestion: 1, system: 0,
};

/** 待处理的真实审批与问题在前；同级别按最近更新倒序。 */
export function compareAgentInboxItems(a: AgentInboxItem, b: AgentInboxItem): number {
  const open = Number(b.status === "pending") - Number(a.status === "pending");
  if (open) return open;
  if (a.status === "pending" && b.status === "pending") {
    const type = typeRank[b.type] - typeRank[a.type];
    if (type) return type;
    const priority = priorityRank[b.priority] - priorityRank[a.priority];
    if (priority) return priority;
  }
  return b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1);
}

/** 工具审批的 Host 事件到业务状态的映射。 */
export function approvalOutcome(allowed: boolean, createdAt: number, now: number, timeoutMs: number): { status: AgentInboxStatus; outcome: string } {
  if (allowed) return { status: "resolved", outcome: "approved" };
  // 定时器与适配器各自读取时钟，留 1 秒误差，避免把真正的超时误判成拒绝。
  if (now - createdAt >= timeoutMs - 1000) return { status: "expired", outcome: "timed_out" };
  return { status: "rejected", outcome: "denied" };
}

/** 用户问题的 Host 事件到业务状态的映射。answer 为 null 表示跳过、停止或应用退出。 */
export function questionOutcome(answer: string | null): { status: AgentInboxStatus; outcome: string } {
  return answer === null ? { status: "cancelled", outcome: "skipped" } : { status: "resolved", outcome: "answered" };
}

export function truncateInboxText(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, Math.max(0, max - 1))}…`;
}

export function boundApprovalRequest(request: SandboxApprovalRequest): SandboxApprovalRequest {
  return {
    ...request,
    command: request.command === null ? null : request.command.slice(0, agentInboxLimits.maxCommand),
  };
}

export function questionDetail(request: AskUserQuestionRequest): Extract<AgentInboxDetail, { kind: "question" }> {
  return {
    kind: "question",
    toolCallId: request.toolCallId,
    question: request.question.slice(0, agentInboxLimits.maxDetailText),
    options: request.options.slice(0, 12),
    allowFreeText: request.allowFreeText,
  };
}

/** 一条回复的 Intelligent UI 位置：最后一条有正文的助手回复，且它含界面时才有值。 */
export function latestUiReply(messages: readonly { role: string; text: string }[]): { ordinal: number; text: string } | null {
  let ordinal = -1;
  let found: { ordinal: number; text: string } | null = null;
  for (const message of messages) {
    if (message.role !== "assistant" || !message.text.trim()) continue;
    if (mayContainUi(message.text)) ordinal += 1;
    found = mayContainUi(message.text) ? { ordinal, text: message.text } : null;
  }
  return found;
}

export function uiContentRef(conversationId: string, reply: { ordinal: number; text: string }): AgentInboxContentRef {
  return { conversationId, uiOrdinal: reply.ordinal, fingerprint: hashUiSource(reply.text) };
}

/** 按事项里存储的定位找回完整回复；位置不存在或正文已改变时返回 null。 */
export function resolveUiContent(messages: readonly { role: string; text: string }[], ref: AgentInboxContentRef): AgentInboxContent | null {
  let ordinal = -1;
  for (const message of messages) {
    if (message.role !== "assistant" || !mayContainUi(message.text)) continue;
    ordinal += 1;
    if (ordinal !== ref.uiOrdinal) continue;
    return hashUiSource(message.text) === ref.fingerprint ? { text: message.text, conversationId: ref.conversationId, uiOrdinal: ordinal } : null;
  }
  return null;
}
