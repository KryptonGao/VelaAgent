import type {
  ExecutionPlan,
  ExecutionPlanItem,
  PlanExecutionContextStrategy,
  ProposedPlanItem,
  ProposedPlanStatus,
} from "@vela/shared";

/** 正在流式接收的 <proposed_plan> 草稿；结束后由持久化的 ProposedPlanItem 接管。 */
export interface PlanDraft {
  id: string;
  revision: number;
  markdown: string;
  streaming: boolean;
}

export type PlanDraftEvent =
  | { type: "proposed_plan_start"; planId: string; revision: number }
  | { type: "proposed_plan_delta"; planId: string; delta: string }
  | { type: "proposed_plan_end"; plan: ProposedPlanItem };

export function applyPlanDraft(current: PlanDraft | null, event: PlanDraftEvent): PlanDraft | null {
  if (event.type === "proposed_plan_start") {
    return { id: event.planId, revision: event.revision, markdown: "", streaming: true };
  }
  if (!current) return current;
  const planId = event.type === "proposed_plan_delta" ? event.planId : event.plan.id;
  if (current.id !== planId) return current;
  if (event.type === "proposed_plan_delta") {
    return { ...current, markdown: current.markdown + event.delta };
  }
  // 方案已落盘，后续渲染直接读 state.session.proposedPlan。
  return null;
}

export interface PlanProgress {
  completed: number;
  total: number;
  percent: number;
  active: ExecutionPlanItem | null;
}

/** 执行进度只来自 ExecutionPlan，与 ProposedPlan 的正文无关。 */
export function planProgress(execution: ExecutionPlan | null): PlanProgress {
  const items = execution?.items ?? [];
  const completed = items.filter((item) => item.status === "completed").length;
  const total = items.length;
  return {
    completed,
    total,
    percent: total === 0 ? 0 : Math.round((completed / total) * 100),
    active: items.find((item) => item.status === "in_progress") ?? null,
  };
}

// ---------- Plan Document 模型 ----------

export interface PlanDocumentState {
  /** 当前打开的 Plan revision；null 表示文档面板关闭。 */
  activePlanId: string | null;
  /** 顶部 Revision selector 选中的版本；null 表示跟随 activePlanId。 */
  selectedRevisionId: string | null;
}

export type PlanDocumentAction =
  | { type: "open"; planId: string }
  | { type: "close" }
  | { type: "select"; planId: string };

export const emptyPlanDocumentState: PlanDocumentState = {
  activePlanId: null,
  selectedRevisionId: null,
};

/**
 * Plan Document 的打开/关闭/切换版本状态。它是纯 UI 状态，
 * 不携带消息或会话数据，关闭再打开不会影响 conversation。
 */
export function planDocumentReducer(
  state: PlanDocumentState,
  action: PlanDocumentAction,
): PlanDocumentState {
  if (action.type === "open") {
    return { activePlanId: action.planId, selectedRevisionId: action.planId };
  }
  if (action.type === "select") {
    return { ...state, selectedRevisionId: action.planId };
  }
  return emptyPlanDocumentState;
}

export interface PlanRevisionView {
  id: string;
  revision: number;
  status: ProposedPlanStatus;
  markdown: string;
  /** 正在流式生成；此时不显示执行按钮。 */
  streaming: boolean;
  /** 是否是当前最新版本（流式草稿算最新）。 */
  latest: boolean;
  /** 非最新版本只读展示。 */
  readOnly: boolean;
  objective: string | null;
}

/**
 * 文档面板打开时才解析 revision；关闭状态下不回退到最新版本或草稿。
 * 否则关掉面板后，已有 Plan 会让 resolvePlanRevision 又把它“解析”回来。
 */
export function resolveOpenPlanRevision(
  state: PlanDocumentState,
  plans: readonly ProposedPlanItem[],
  draft: PlanDraft | null,
): PlanRevisionView | null {
  if (!state.activePlanId) return null;
  return resolvePlanRevision(plans, draft, state.selectedRevisionId ?? state.activePlanId);
}

/**
 * 解析要展示的 revision：优先显式选择的版本，否则取最新（草稿优先）。
 * selectedId 指向的历史版本仍然只读可见，不会影响最新版本。
 */
export function resolvePlanRevision(
  plans: readonly ProposedPlanItem[],
  draft: PlanDraft | null,
  selectedId: string | null,
): PlanRevisionView | null {
  const latest = latestRevision(plans);
  const fallbackId = draft?.id ?? latest?.id ?? null;
  const wanted = selectedId ?? fallbackId;
  if (!wanted) return null;
  if (draft && wanted === draft.id) {
    return {
      id: draft.id,
      revision: draft.revision,
      status: "draft",
      markdown: draft.markdown,
      streaming: true,
      latest: true,
      readOnly: false,
      objective: null,
    };
  }
  const plan = plans.find((item) => item.id === wanted) ?? latest;
  if (!plan) return null;
  const latestId = draft?.id ?? latest?.id ?? null;
  return {
    id: plan.id,
    revision: plan.revision,
    status: plan.status,
    markdown: plan.markdown,
    streaming: false,
    latest: plan.id === latestId,
    readOnly: plan.id !== latestId,
    objective: plan.objective,
  };
}

export interface PlanRevisionEntry {
  id: string;
  revision: number;
  status: ProposedPlanStatus;
  /** 最新版本（含生成中的草稿）。 */
  latest: boolean;
  streaming: boolean;
}

/** Revision selector 的条目，最新在前。 */
export function planRevisionEntries(
  plans: readonly ProposedPlanItem[],
  draft: PlanDraft | null,
): PlanRevisionEntry[] {
  const sorted = [...plans].sort((a, b) => b.revision - a.revision);
  const latestId = draft?.id ?? sorted[0]?.id ?? null;
  const entries: PlanRevisionEntry[] = sorted.map((plan) => ({
    id: plan.id,
    revision: plan.revision,
    status: plan.status,
    latest: plan.id === latestId,
    streaming: false,
  }));
  if (draft) {
    entries.unshift({
      id: draft.id,
      revision: draft.revision,
      status: "draft",
      latest: true,
      streaming: true,
    });
  }
  return entries;
}

export interface PlanActionState {
  /** 生成中、历史版本查看或不忙时才可执行。 */
  canExecute: boolean;
  canRevise: boolean;
  /** 生成尚未完成。 */
  generating: boolean;
}

export function planActionState(
  plan: ProposedPlanItem | null,
  draft: PlanDraft | null,
  busy: boolean,
): PlanActionState {
  const generating = Boolean(draft);
  return {
    canExecute: Boolean(plan) && !generating && !busy,
    canRevise: Boolean(plan) && !generating && !busy,
    generating,
  };
}

export interface PlanExecutionChoice {
  strategy: PlanExecutionContextStrategy;
  labelZh: string;
  labelEn: string;
}

/** 执行计划下拉的两条固定路径；直接复用现有 executePlan(strategy)。 */
export const planExecutionChoices: readonly PlanExecutionChoice[] = [
  { strategy: "continue", labelZh: "在当前上下文执行", labelEn: "Implement in this context" },
  { strategy: "fresh", labelZh: "清空规划上下文执行", labelEn: "Implement with fresh context" },
];

// ---------- Chat Preview / ContextPanel 引用 ----------

export interface PlanPreviewInfo {
  title: string;
  overview: string | null;
  sections: string[];
}

const genericTitles = new Set(["plan", "计划", "实施方案"]);
const overviewHeadings = new Set([
  "overview",
  "summary",
  "goal",
  "background",
  "概要",
  "概述",
  "目标",
  "背景",
]);

/** 从完整 Markdown 里抽出标题、首段概要和章节名，供聊天预览与侧栏引用展示。 */
export function planPreviewInfo(markdown: string, fallbackTitle: string | null = null): PlanPreviewInfo {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  let title = "";
  const sections: string[] = [];
  let heading: string | null = null;
  let preferred: string | null = null;
  let firstParagraph: string | null = null;
  let buffer: string[] = [];
  let inFence = false;

  const flush = () => {
    const text = cleanInline(buffer.join(" "));
    buffer = [];
    if (!text || heading === null) return;
    if (overviewHeadings.has(normalizeHeading(heading))) preferred ??= text;
    else firstParagraph ??= text;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      flush();
      continue;
    }
    if (inFence) continue;
    const match = /^(#{1,6})\s+(.*)$/.exec(line);
    if (match) {
      flush();
      const level = match[1]?.length ?? 6;
      const text = cleanInline(match[2] ?? "");
      if (level === 1 && !title) title = text;
      if (level === 2 && text) sections.push(text);
      heading = text || null;
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    if (/^\s*([-*+]|\d+\.)\s/.test(line) || /^\s*>/.test(line)) {
      flush();
      continue;
    }
    buffer.push(line);
  }
  flush();

  const fallback = fallbackTitle ? cleanInline(fallbackTitle) : "";
  const resolvedTitle =
    title && !genericTitles.has(normalizeHeading(title))
      ? title
      : fallback || firstParagraph || preferred || title;
  return {
    title: clipText(resolvedTitle, 80),
    overview: preferred ? clipText(preferred, 220) : null,
    sections: sections.slice(0, 8).map((section) => clipText(section, 40)),
  };
}

export interface PlanReferenceModel {
  id: string;
  title: string;
  revision: number;
  status: ProposedPlanStatus;
  streaming: boolean;
  progress: PlanProgress;
}

/**
 * ContextPanel 的轻量引用：只包含标题、版本、状态和进度，不含 Markdown 正文，
 * 保证长方案不会塞进窄侧栏。
 */
export function planReferenceModel(
  plan: ProposedPlanItem | null,
  draft: PlanDraft | null,
  execution: ExecutionPlan | null,
): PlanReferenceModel | null {
  if (draft) {
    return {
      id: draft.id,
      title: planPreviewInfo(draft.markdown, plan?.objective ?? null).title,
      revision: draft.revision,
      status: "draft",
      streaming: true,
      progress: planProgress(execution),
    };
  }
  if (!plan) return null;
  return {
    id: plan.id,
    title: planPreviewInfo(plan.markdown, plan.objective).title,
    revision: plan.revision,
    status: plan.status,
    streaming: false,
    progress: planProgress(execution),
  };
}

/** 一个 turn 里所有 assistant 消息关联的 plan id，去重并保持出现顺序。 */
export function collectPlanIds(messages: readonly { planIds?: string[] }[]): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    for (const id of message.planIds ?? []) {
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

function latestRevision(plans: readonly ProposedPlanItem[]): ProposedPlanItem | null {
  let latest: ProposedPlanItem | null = null;
  for (const plan of plans) {
    if (!latest || plan.revision >= latest.revision) latest = plan;
  }
  return latest;
}

function normalizeHeading(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[：:。.!！?？#*_`]+$/g, "")
    .replace(/\s+/g, " ");
}

function cleanInline(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}
