import {
  executionItemStatuses,
  type ExecutionItemStatus,
  type ExecutionPlan,
  type ExecutionPlanItem,
  type InteractionMode,
  type ProposedPlanItem,
} from "@vela/shared";
import { randomUUID } from "node:crypto";

/**
 * Plan 文档与执行清单的全部纯逻辑：流式解析、revision 管理、执行清单更新和旧数据迁移。
 * 运行时只负责把结果落到 conversation，不在这里维护状态。
 */

export const proposedPlanOpenTag = "<proposed_plan>";
export const proposedPlanCloseTag = "</proposed_plan>";
export const proposedPlanMaxMarkdown = 200_000;
export const executionPlanItemMax = 50;

// ---------- <proposed_plan> 流式解析 ----------

export type PlanStreamEvent =
  | { type: "text"; delta: string }
  | { type: "plan_start" }
  | { type: "plan_delta"; delta: string }
  | { type: "plan_end"; markdown: string };

export interface PlanStreamParser {
  /** 消费一段文本 delta，返回应当对外发出的结构化事件。 */
  push(delta: string): PlanStreamEvent[];
  /** 消息结束时收尾：未闭合的 plan 块按已结束处理，悬挂的标签前缀按普通文本放行。 */
  flush(): PlanStreamEvent[];
}

/**
 * 逐 delta 解析 <proposed_plan>。标签可能被切成多段，所以文本模式会扣住
 * 结尾处可能是开标签前缀的部分，等下一个 delta 再判断。
 */
export function createPlanStreamParser(): PlanStreamParser {
  let mode: "text" | "plan" = "text";
  let pending = "";
  let markdown = "";

  function drainText(out: PlanStreamEvent[]): boolean {
    const index = pending.indexOf(proposedPlanOpenTag);
    if (index >= 0) {
      if (index > 0) out.push({ type: "text", delta: pending.slice(0, index) });
      pending = pending.slice(index + proposedPlanOpenTag.length);
      mode = "plan";
      out.push({ type: "plan_start" });
      return true;
    }
    const keep = longestTagPrefixSuffix(pending, proposedPlanOpenTag);
    const emit = pending.slice(0, pending.length - keep);
    if (emit) out.push({ type: "text", delta: emit });
    pending = pending.slice(pending.length - keep);
    return false;
  }

  function drainPlan(out: PlanStreamEvent[]): boolean {
    const index = pending.indexOf(proposedPlanCloseTag);
    if (index >= 0) {
      const content = pending.slice(0, index);
      if (content) {
        markdown += content;
        out.push({ type: "plan_delta", delta: content });
      }
      pending = pending.slice(index + proposedPlanCloseTag.length);
      mode = "text";
      const normalized = normalizePlanMarkdown(markdown);
      markdown = "";
      if (normalized) out.push({ type: "plan_end", markdown: normalized });
      return true;
    }
    const keep = longestTagPrefixSuffix(pending, proposedPlanCloseTag);
    const emit = pending.slice(0, pending.length - keep);
    if (emit) {
      markdown += emit;
      out.push({ type: "plan_delta", delta: emit });
    }
    pending = pending.slice(pending.length - keep);
    return false;
  }

  return {
    push(delta) {
      if (!delta) return [];
      pending += delta;
      const out: PlanStreamEvent[] = [];
      // 一段 delta 里可能同时包含开标签、正文、闭标签和后续普通文本。
      while (true) {
        if (mode === "text") {
          if (!drainText(out)) break;
        } else if (!drainPlan(out)) {
          break;
        }
      }
      return out;
    },
    flush() {
      const out: PlanStreamEvent[] = [];
      if (mode === "plan") {
        if (pending) {
          markdown += pending;
          out.push({ type: "plan_delta", delta: pending });
          pending = "";
        }
        const normalized = normalizePlanMarkdown(markdown);
        markdown = "";
        mode = "text";
        if (normalized) out.push({ type: "plan_end", markdown: normalized });
        return out;
      }
      if (pending) {
        out.push({ type: "text", delta: pending });
        pending = "";
      }
      return out;
    },
  };
}

/** 从完整文本里摘出所有 plan 块，并返回剥离后的可见正文。 */
export function extractProposedPlans(text: string): { text: string; plans: string[] } {
  const plans: string[] = [];
  let remaining = text;
  let visible = "";
  while (true) {
    const start = remaining.indexOf(proposedPlanOpenTag);
    if (start < 0) {
      visible += remaining;
      break;
    }
    visible += remaining.slice(0, start);
    const after = remaining.slice(start + proposedPlanOpenTag.length);
    const end = after.indexOf(proposedPlanCloseTag);
    if (end < 0) {
      plans.push(after);
      break;
    }
    plans.push(after.slice(0, end));
    remaining = after.slice(end + proposedPlanCloseTag.length);
  }
  return {
    text: visible.replace(/\n{3,}/g, "\n\n").trim(),
    plans: plans.map(normalizePlanMarkdown).filter((plan) => plan.length > 0),
  };
}

/** 去掉块首尾空行，并限制长度，避免把失控输出带进持久层。 */
export function normalizePlanMarkdown(markdown: string): string {
  const trimmed = markdown.replace(/\r\n/g, "\n").replace(/^\s*\n/, "").replace(/\n\s*$/, "").trim();
  if (trimmed.length <= proposedPlanMaxMarkdown) return trimmed;
  return `${trimmed.slice(0, proposedPlanMaxMarkdown - 1)}…`;
}

function longestTagPrefixSuffix(text: string, tag: string): number {
  const max = Math.min(text.length, tag.length - 1);
  for (let length = max; length > 0; length -= 1) {
    if (text.slice(text.length - length) === tag.slice(0, length)) return length;
  }
  return 0;
}

// ---------- Revision 管理 ----------

export function sortPlans(plans: readonly ProposedPlanItem[]): ProposedPlanItem[] {
  return [...plans].sort((a, b) => a.revision - b.revision);
}

export function latestPlan(plans: readonly ProposedPlanItem[]): ProposedPlanItem | null {
  let latest: ProposedPlanItem | null = null;
  for (const plan of plans) {
    if (!latest || plan.revision >= latest.revision) latest = plan;
  }
  return latest;
}

export interface AppendPlanRevisionInput {
  id: string;
  markdown: string;
  objective: string | null;
  createdAt: number;
}

/**
 * 追加一个 revision：编号在最新版上加一，指向上一版并把上一版标记为 superseded；
 * 旧 revision 的 markdown 原地不动。
 */
export function appendPlanRevision(
  plans: readonly ProposedPlanItem[],
  input: AppendPlanRevisionInput,
): { plans: ProposedPlanItem[]; plan: ProposedPlanItem } {
  const previous = latestPlan(plans);
  const plan: ProposedPlanItem = {
    id: input.id,
    markdown: normalizePlanMarkdown(input.markdown),
    revision: (previous?.revision ?? 0) + 1,
    supersedes: previous?.id ?? null,
    status: "draft",
    objective: input.objective,
    createdAt: input.createdAt,
    approvedAt: null,
  };
  const next = sortPlans([...plans, plan]).map((item) =>
    item.id === plan.supersedes && item.status !== "superseded"
      ? { ...item, status: "superseded" as const }
      : item,
  );
  return { plans: next, plan };
}

export function approvePlanRevision(
  plans: readonly ProposedPlanItem[],
  id: string,
  at: number,
): ProposedPlanItem[] {
  return plans.map((plan) =>
    plan.id === id ? { ...plan, status: "approved" as const, approvedAt: at } : plan,
  );
}

// ---------- ExecutionPlan ----------

export function activeExecutionPlan(
  executionPlans: readonly ExecutionPlan[],
  activeId: string | null,
): ExecutionPlan | null {
  if (!activeId) return null;
  return executionPlans.find((plan) => plan.id === activeId) ?? null;
}

export function createExecutionPlan(plan: ProposedPlanItem, now: number): ExecutionPlan {
  return { id: randomUUID(), sourcePlanId: plan.id, items: [], updatedAt: now };
}

export interface BoundExecutionPlan {
  executionPlans: ExecutionPlan[];
  execution: ExecutionPlan;
  /** 新绑定还是复用已有进度。 */
  appended: boolean;
}

/** 批准某个 revision 后绑定执行计划；同一 revision 重复执行时复用已有进度。 */
export function bindExecutionPlan(
  executionPlans: readonly ExecutionPlan[],
  plan: ProposedPlanItem,
  now: number,
): BoundExecutionPlan {
  const existing = executionPlans.find((item) => item.sourcePlanId === plan.id);
  if (existing) return { executionPlans: [...executionPlans], execution: existing, appended: false };
  const execution = createExecutionPlan(plan, now);
  return { executionPlans: [...executionPlans, execution], execution, appended: true };
}

export interface ExecutionPlanUpdateItem {
  step: string;
  status: ExecutionItemStatus;
}

export type ExecutionPlanUpdateResult =
  | { ok: true; execution: ExecutionPlan }
  | { ok: false; text: string };

/**
 * 用模型提交的清单替换执行项：按文本复用已有 id，允许根据实际实现增删或合并条目；
 * 最多一项 in_progress。只改 ExecutionPlan，不触碰 ProposedPlan。
 */
export function applyExecutionPlanUpdate(
  execution: ExecutionPlan,
  update: readonly ExecutionPlanUpdateItem[],
  now: number,
): ExecutionPlanUpdateResult {
  if (!Array.isArray(update) || update.length === 0) {
    return { ok: false, text: "执行清单至少需要一项。" };
  }
  if (update.length > executionPlanItemMax) {
    return { ok: false, text: `执行清单最多 ${executionPlanItemMax} 项。` };
  }
  const items: ExecutionPlanItem[] = [];
  const seen = new Set<string>();
  for (const raw of update) {
    if (!executionItemStatuses.includes(raw.status)) {
      return { ok: false, text: "执行项状态不正确。" };
    }
    const text = singleLine(raw.step).slice(0, 200);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    const existing = execution.items.find((item) => item.text === text);
    items.push({ id: existing?.id ?? randomUUID(), text, status: raw.status });
  }
  if (items.length === 0) return { ok: false, text: "执行清单至少需要一项。" };
  if (items.filter((item) => item.status === "in_progress").length > 1) {
    return { ok: false, text: "最多只能有一项处于进行中。" };
  }
  return { ok: true, execution: { ...execution, items, updatedAt: now } };
}

// ---------- 执行输入 ----------

export const planExecutionHeader = "Implement the approved plan.";
export const planFreshExecutionHeader = "Implement this plan.";

const planExecutionToolNote =
  "Use update_plan to track execution progress (at most one item in_progress, items may be adjusted as implementation unfolds). Do not rewrite the approved plan; if the design must change, ask the user to go back to Plan mode.";

export function planContinuePrompt(plan: ProposedPlanItem): string {
  return [
    planExecutionHeader,
    "",
    `Approved plan revision ${plan.revision} (${plan.id}).`,
    planExecutionToolNote,
  ].join("\n");
}

export function planFreshPrompt(objective: string | null, plan: ProposedPlanItem): string {
  return [
    planFreshExecutionHeader,
    "",
    "# Objective",
    objective?.trim() || "(not recorded)",
    "",
    `# Approved Plan (revision ${plan.revision})`,
    "",
    plan.markdown,
    "",
    planExecutionToolNote,
  ].join("\n");
}

/** 系统代发的执行输入不在消息列表里展示；continue 与 fresh 两种开头都识别。 */
export function isPlanExecutionPrompt(text: string): boolean {
  return text.startsWith(planExecutionHeader) || text.startsWith(planFreshExecutionHeader);
}

// ---------- 旧 ConversationPlan 迁移 ----------

export interface LegacyPlanStep {
  id: string;
  text: string;
  done: boolean;
}

export interface LegacyPlanRecord {
  title: string;
  overview: string;
  steps: LegacyPlanStep[];
  updatedAt: number;
}

export interface LegacyPlanMigration {
  plans: ProposedPlanItem[];
  latestProposedPlanId: string;
  executionPlan: ExecutionPlan | null;
}

/**
 * 旧数据只有 title/overview/steps 和 done 状态。迁移成一份 v1 方案，
 * 并把已勾选的步骤转成执行进度；没有任何 done 且当时不在 Agent 模式时，
 * 视为还没执行，只迁移方案内容。
 */
export function migrateLegacyPlan(
  legacy: LegacyPlanRecord,
  options: { mode: InteractionMode; now: number },
): LegacyPlanMigration | null {
  const steps = legacy.steps
    .map((step) => ({ ...step, text: singleLine(step.text) }))
    .filter((step) => step.text.length > 0);
  if (!legacy.title.trim() || steps.length === 0) return null;
  const anyDone = steps.some((step) => step.done);
  const approved = anyDone || options.mode === "agent";
  const createdAt = legacy.updatedAt > 0 ? legacy.updatedAt : options.now;
  const id = randomUUID();
  const plan: ProposedPlanItem = {
    id,
    markdown: legacyPlanMarkdown({ ...legacy, steps }),
    revision: 1,
    supersedes: null,
    status: approved ? "approved" : "draft",
    objective: null,
    createdAt,
    approvedAt: approved ? createdAt : null,
  };
  const executionPlan: ExecutionPlan | null = approved
    ? {
        id: randomUUID(),
        sourcePlanId: id,
        items: steps.map((step) => ({
          id: randomUUID(),
          text: step.text,
          status: step.done ? ("completed" as const) : ("pending" as const),
        })),
        updatedAt: createdAt,
      }
    : null;
  return { plans: [plan], latestProposedPlanId: id, executionPlan };
}

export function legacyPlanMarkdown(legacy: LegacyPlanRecord): string {
  const steps = legacy.steps
    .map((step, index) => `${index + 1}. ${singleLine(step.text)}`)
    .filter((line) => line.length > 0);
  return [
    `# ${singleLine(legacy.title)}`,
    "",
    "## Overview",
    "",
    singleLine(legacy.overview),
    "",
    "## Implementation Steps",
    "",
    ...steps,
  ].join("\n");
}

export function singleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
