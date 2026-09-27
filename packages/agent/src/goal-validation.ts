import type {
  ConversationGoal,
  GoalStatus,
  GoalValidation,
  GoalValidationCategory,
  GoalValidationCheck,
  GoalValidationKnownIssue,
  GoalValidationRisk,
  GoalValidationSkipped,
} from "@vela/shared";
import { goalValidationCategories } from "@vela/shared";

export interface GoalValidationEvidence {
  toolCallId: string;
  command: string;
  result: "passed" | "failed";
  output: string;
  completedAt: number;
  sequence: number;
  workRevision: number;
}

export interface GoalValidationDraft {
  risk: GoalValidationRisk;
  checks: Array<{ category: GoalValidationCategory; toolCallId: string }>;
  skipped: GoalValidationSkipped[];
  knownIssues: GoalValidationKnownIssue[];
}

export type GoalValidationDraftResult =
  | { ok: true; validation: GoalValidation }
  | { ok: false; text: string };

const requiredCategories: GoalValidationCategory[] = ["diff", "test", "build", "typecheck", "regression"];

/** Normalize persisted Goal data; active goals become paused after restart. */
export function normalizeStoredGoal(value: unknown): ConversationGoal | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || !record.id || typeof record.objective !== "string" || !record.objective.trim()) {
    return null;
  }
  const status = normalizeGoalStatus(record.status);
  if (!status) return null;
  const note = typeof record.note === "string" && record.note.trim() ? record.note : null;
  const workRevision = Math.max(0, Math.floor(numberOr(record.workRevision, 0)));
  const validation = normalizePersistedValidation(record.validation, workRevision);
  return {
    id: record.id,
    objective: record.objective,
    status: status === "active" ? "paused" : status,
    note: status === "active" ? note ?? "应用重启后已暂停，可以继续" : note,
    workRevision,
    validation,
    updatedAt: numberOr(record.updatedAt, Date.now()),
  };
}

function normalizePersistedValidation(value: unknown, goalRevision: number): GoalValidation | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const risk = record.risk;
  if (risk !== "low" && risk !== "medium" && risk !== "high") return null;
  if (!Array.isArray(record.checks) || !Array.isArray(record.skipped) || !Array.isArray(record.knownIssues)) return null;

  const checks: GoalValidationCheck[] = [];
  for (const value of record.checks) {
    if (!value || typeof value !== "object") continue;
    const item = value as Record<string, unknown>;
    if (
      typeof item.toolCallId !== "string" || !item.toolCallId ||
      !isValidationCategory(item.category) || typeof item.command !== "string" ||
      (item.result !== "passed" && item.result !== "failed") || typeof item.output !== "string"
    ) continue;
    checks.push({
      toolCallId: item.toolCallId,
      category: item.category,
      command: item.command.slice(0, 1000),
      result: item.result,
      output: item.output.slice(0, 1200),
      completedAt: numberOr(item.completedAt, Date.now()),
      sequence: Math.max(0, Math.floor(numberOr(item.sequence, 0))),
      workRevision: Math.max(0, Math.floor(numberOr(item.workRevision, goalRevision))),
    });
  }

  const skipped: GoalValidationSkipped[] = [];
  for (const value of record.skipped) {
    if (!value || typeof value !== "object") continue;
    const item = value as Record<string, unknown>;
    if (!isValidationCategory(item.category) || typeof item.reason !== "string" || !item.reason.trim()) continue;
    skipped.push({ category: item.category, reason: item.reason.slice(0, 500) });
  }

  const knownIssues: GoalValidationKnownIssue[] = [];
  for (const value of record.knownIssues) {
    if (!value || typeof value !== "object") continue;
    const item = value as Record<string, unknown>;
    if (typeof item.toolCallId !== "string" || typeof item.reason !== "string" || !item.reason.trim()) continue;
    if (!checks.some((check) => check.toolCallId === item.toolCallId && check.result === "failed")) continue;
    knownIssues.push({ toolCallId: item.toolCallId, reason: item.reason.slice(0, 500) });
  }

  const status = record.status;
  if (status !== "passed" && status !== "known_issues" && status !== "skipped") return null;
  return {
    risk,
    status,
    workRevision: Math.max(0, Math.floor(numberOr(record.workRevision, goalRevision))),
    checkedAt: numberOr(record.checkedAt, Date.now()),
    checks,
    skipped,
    knownIssues,
  };
}

function normalizeGoalStatus(value: unknown): GoalStatus | null {
  return value === "active" || value === "paused" || value === "complete" ? value : null;
}

function isValidationCategory(value: unknown): value is GoalValidationCategory {
  return typeof value === "string" && (goalValidationCategories as readonly string[]).includes(value);
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * 把模型提交的分类与运行时捕获的 bash 结果关联起来。
 * 命令、退出状态和输出始终取自运行时证据，不能由模型填写。
 */
export function createGoalValidation(
  goal: ConversationGoal,
  draft: GoalValidationDraft,
  availableEvidence: Iterable<GoalValidationEvidence>,
  checkedAt = Date.now(),
): GoalValidationDraftResult {
  const capturedEvidence = [...availableEvidence];
  const evidenceById = new Map<string, GoalValidationEvidence>();
  for (const check of goal.validation?.checks ?? []) evidenceById.set(check.toolCallId, check);
  for (const evidence of capturedEvidence) evidenceById.set(evidence.toolCallId, evidence);

  const skipped = normalizeSkipped(draft.skipped);
  if (!skipped.ok) return skipped;
  const skipKinds = new Set(skipped.values.map((item) => item.category));
  const selectedIds = new Set(draft.checks.map((item) => item.toolCallId));
  const currentEvidence = capturedEvidence.filter((item) => item.workRevision === goal.workRevision);
  const lastUnrecorded = currentEvidence
    .filter((item) => !selectedIds.has(item.toolCallId))
    .sort((a, b) => b.sequence - a.sequence)[0];
  if (lastUnrecorded) {
    if (draft.checks.length === 0) {
      return {
        ok: false,
        text: `当前 Goal 中还有未记录的 bash 命令 ${lastUnrecorded.toolCallId}。请将它归类为检查，或在它之后运行并记录所需检查。`,
      };
    }
    const staleCheck = draft.checks
      .map((requested) => evidenceById.get(requested.toolCallId))
      .find((item) => item && item.workRevision === goal.workRevision && item.sequence < lastUnrecorded.sequence);
    if (staleCheck) {
      return {
        ok: false,
        text: `检查 ${staleCheck.toolCallId} 之后还有未记录的 bash 命令 ${lastUnrecorded.toolCallId}。该命令可能修改工作区，请把它也记录为检查，或在它之后重跑检查。`,
      };
    }
  }

  const checksById = new Map<string, GoalValidationCheck>();
  for (const check of goal.validation?.checks ?? []) checksById.set(check.toolCallId, check);
  for (const requested of draft.checks) {
    const evidence = evidenceById.get(requested.toolCallId);
    if (!evidence) return { ok: false, text: `找不到工具调用 ${requested.toolCallId} 的验证结果。请引用本目标中已完成的 bash 命令。` };
    const existing = checksById.get(requested.toolCallId);
    if (existing && existing.category !== requested.category) {
      return { ok: false, text: `工具调用 ${requested.toolCallId} 已归类为「${existing.category}」，不能改成「${requested.category}」。` };
    }
    checksById.set(requested.toolCallId, {
      ...evidence,
      category: requested.category,
      command: evidence.command.slice(0, 1000),
      output: evidence.output.slice(0, 1200),
    });
  }

  const checks = [...checksById.values()].sort((a, b) => a.completedAt - b.completedAt);
  const currentChecks = checks.filter((item) => item.workRevision === goal.workRevision);
  const checkedKinds = new Set(currentChecks.map((item) => item.category));
  for (const category of skipped.values) {
    if (checkedKinds.has(category.category)) {
      return { ok: false, text: `「${category.category}」已有执行记录，不能同时标记为跳过。` };
    }
  }
  for (const category of requiredCategories) {
    if (!checkedKinds.has(category) && !skipKinds.has(category)) {
      return { ok: false, text: `请记录「${category}」检查，或说明为什么跳过。` };
    }
  }
  if (draft.risk !== "low" && (!checkedKinds.has("diff") || !checkedKinds.has("test"))) {
    return { ok: false, text: "中高风险改动必须实际检查 diff 并运行定向测试。" };
  }
  if (draft.risk === "high" && !checkedKinds.has("regression")) {
    return { ok: false, text: "高风险改动必须运行更广范围的回归检查。" };
  }

  const latestByCategory = latestChecksByCategory(checks);
  const latestFailures = [...latestByCategory.values()].filter((check) => check.result === "failed");
  const knownIssues: GoalValidationKnownIssue[] = [];
  const seenIssues = new Set<string>();
  for (const issue of draft.knownIssues) {
    const failedCheck = checksById.get(issue.toolCallId);
    if (!failedCheck || failedCheck.result !== "failed") {
      return { ok: false, text: `已知问题 ${issue.toolCallId} 没有关联到失败的命令。` };
    }
    if (latestByCategory.get(failedCheck.category)?.toolCallId !== issue.toolCallId) continue;
    const reason = issue.reason.trim();
    if (reason.length < 8) return { ok: false, text: `请补充失败检查 ${issue.toolCallId} 与本次改动无关的依据。` };
    if (seenIssues.has(issue.toolCallId)) continue;
    seenIssues.add(issue.toolCallId);
    knownIssues.push({ toolCallId: issue.toolCallId, reason: reason.slice(0, 500) });
  }

  const acknowledged = new Set(knownIssues.map((item) => item.toolCallId));
  const unacknowledged = latestFailures.find((check) => !acknowledged.has(check.toolCallId));
  if (unacknowledged) {
    return {
      ok: false,
      text: `检查「${unacknowledged.category}」失败。请修复后重跑并重新记录；若能确认与本次改动无关，请提交失败调用 ${unacknowledged.toolCallId} 及依据。`,
    };
  }

  const hasRuns = currentChecks.length > 0;
  const status: GoalValidation["status"] = knownIssues.length > 0
    ? "known_issues"
    : hasRuns
      ? "passed"
      : "skipped";
  return {
    ok: true,
    validation: {
      risk: draft.risk,
      status,
      workRevision: goal.workRevision,
      checkedAt,
      checks,
      skipped: skipped.values,
      knownIssues,
    },
  };
}

/** 返回阻止 complete 的原因；无原因时允许完成。 */
export function goalCompletionBlocker(goal: ConversationGoal): string | null {
  const validation = goal.validation;
  if (!validation) return "完成前请先提交交付验证记录：运行检查，或按风险说明跳过项目。";
  if (validation.workRevision !== goal.workRevision) {
    return "验证记录已过期，因为验证后又运行了可能修改工作区的工具。请重新检查并提交验证记录。";
  }
  const currentKinds = new Set(
    validation.checks.filter((check) => check.workRevision === goal.workRevision).map((check) => check.category),
  );
  const skippedKinds = new Set(validation.skipped.map((item) => item.category));
  for (const category of currentKinds) {
    if (skippedKinds.has(category)) return `「${category}」同时标成已运行和跳过，请修正验证记录。`;
  }
  for (const category of requiredCategories) {
    if (!currentKinds.has(category) && !skippedKinds.has(category)) {
      return `验证记录缺少「${category}」检查结果或跳过原因，请重新提交。`;
    }
  }
  if (validation.risk !== "low" && (!currentKinds.has("diff") || !currentKinds.has("test"))) {
    return "中高风险改动必须实际检查 diff 并运行定向测试。";
  }
  if (validation.risk === "high" && !currentKinds.has("regression")) {
    return "高风险改动必须运行更广范围的回归检查。";
  }
  const latestFailures = [...latestChecksByCategory(validation.checks).values()]
    .filter((check) => check.result === "failed");
  const acknowledged = new Set(validation.knownIssues.map((item) => item.toolCallId));
  const unresolved = latestFailures.find((check) => !acknowledged.has(check.toolCallId));
  if (unresolved) {
    return `检查「${unresolved.category}」失败，不能完成目标。请修复并重跑，或提交与本次改动无关的依据。`;
  }
  return null;
}

function normalizeSkipped(
  skipped: GoalValidationSkipped[],
): { ok: true; values: GoalValidationSkipped[] } | { ok: false; text: string } {
  const values: GoalValidationSkipped[] = [];
  const seen = new Set<GoalValidationCategory>();
  for (const item of skipped) {
    const reason = item.reason.trim();
    if (!reason) return { ok: false, text: `跳过「${item.category}」时必须说明原因。` };
    if (seen.has(item.category)) return { ok: false, text: `「${item.category}」只能记录一次跳过原因。` };
    seen.add(item.category);
    values.push({ category: item.category, reason: reason.slice(0, 500) });
  }
  return { ok: true, values };
}

function latestChecksByCategory(checks: GoalValidationCheck[]): Map<GoalValidationCategory, GoalValidationCheck> {
  const latest = new Map<GoalValidationCategory, GoalValidationCheck>();
  for (const check of checks) {
    const previous = latest.get(check.category);
    if (!previous || check.completedAt >= previous.completedAt) latest.set(check.category, check);
  }
  return latest;
}
