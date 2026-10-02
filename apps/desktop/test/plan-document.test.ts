import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExecutionPlan, ProposedPlanItem } from "@vela/shared";
import {
  applyPlanDraft,
  collectPlanIds,
  emptyPlanDocumentState,
  planActionState,
  planDocumentReducer,
  planExecutionChoices,
  planPreviewInfo,
  planProgress,
  planReferenceModel,
  planRevisionEntries,
  resolveOpenPlanRevision,
  resolvePlanRevision,
  type PlanDraft,
} from "../src/renderer/plan-draft.ts";
import {
  attachPlanToLastAssistant,
  applyStreamEvent,
  type MessageBuckets,
  type UiMessage,
} from "../src/renderer/hooks/useSession.ts";

function plan(
  id: string,
  revision: number,
  markdown: string,
  status: ProposedPlanItem["status"] = "draft",
): ProposedPlanItem {
  return {
    id,
    markdown,
    revision,
    supersedes: null,
    status,
    objective: null,
    createdAt: revision,
    approvedAt: status === "approved" ? revision : null,
  };
}

function assistant(planIds?: string[]): UiMessage {
  return { id: `a-${planIds?.join("-") ?? "none"}`, role: "assistant", text: "看完了", thinking: "", tools: [], planIds };
}

describe("Plan Preview（聊天卡片）", () => {
  it("Plan 完成后 turn 里的 assistant 消息带上 revision，预览可用", () => {
    let draft = applyPlanDraft(null, { type: "proposed_plan_start", planId: "p2", revision: 2 });
    draft = applyPlanDraft(draft, {
      type: "proposed_plan_delta",
      planId: "p2",
      delta: "# 方案\n\n## Goal\n\n实现方案预览",
    });
    let buckets: MessageBuckets = { c1: [assistant()] };
    buckets = attachPlanToLastAssistant(buckets, "c1", "p2");
    assert.deepEqual(collectPlanIds(buckets.c1 ?? []), ["p2"]);

    const streaming = resolvePlanRevision([plan("p1", 1, "# 旧方案")], draft, "p2");
    assert.equal(streaming?.streaming, true);
    assert.match(streaming?.markdown ?? "", /实现方案预览/);

    const final = plan("p2", 2, "# 方案\n\n## Goal\n\n实现方案预览");
    assert.equal(applyPlanDraft(draft, { type: "proposed_plan_end", plan: final }), null);
    buckets = attachPlanToLastAssistant(buckets, "c1", "p2");
    assert.deepEqual(collectPlanIds(buckets.c1 ?? []), ["p2"]);
    const resolved = resolvePlanRevision([plan("p1", 1, "# 旧方案"), final], null, "p2");
    assert.equal(resolved?.revision, 2);
    assert.equal(resolved?.streaming, false);
  });

  it("同一条消息重复收到 plan 事件不会重复挂 revision", () => {
    let buckets: MessageBuckets = { c1: [assistant()] };
    buckets = attachPlanToLastAssistant(buckets, "c1", "p1");
    buckets = attachPlanToLastAssistant(buckets, "c1", "p1");
    assert.deepEqual(buckets.c1?.[0]?.planIds, ["p1"]);
  });

  it("计划作为唯一输出时创建本轮 assistant，不关联到上一轮", () => {
    const old = assistant(["old-plan"]);
    const user: UiMessage = { id: "u2", role: "user", text: "重新规划", thinking: "", tools: [] };
    const buckets = attachPlanToLastAssistant({ c1: [old, user] }, "c1", "p2", 100);
    assert.equal(buckets.c1?.length, 3);
    assert.equal(buckets.c1?.[0], old);
    assert.deepEqual(buckets.c1?.at(-1)?.planIds, ["p2"]);
    assert.equal(buckets.c1?.at(-1)?.turnStartedAt, 100);
    assert.deepEqual(collectPlanIds(attachPlanToLastAssistant({}, "c2", "p3").c2 ?? []), ["p3"]);
  });

  it("只有计划的消息也保留独立边界，下一条 assistant 不复用它", () => {
    const planOnly = { ...assistant(["p1"]), text: "" };
    const next = applyStreamEvent({ c1: [planOnly] }, { type: "assistant_start", conversationId: "c1" });
    assert.equal(next.c1?.length, 2);
    assert.equal(next.c1?.[0], planOnly);
    assert.equal(next.c1?.[1]?.planIds, undefined);
    assert.deepEqual(collectPlanIds(next.c1 ?? []), ["p1"]);
  });
});

describe("Plan Document 打开与 revision 切换", () => {
  it("打开动作指向对应 revision，关闭后状态清空", () => {
    const opened = planDocumentReducer(emptyPlanDocumentState, { type: "open", planId: "p2" });
    assert.equal(opened.activePlanId, "p2");
    assert.equal(opened.selectedRevisionId, "p2");
    assert.equal(
      resolvePlanRevision([plan("p1", 1, "# v1"), plan("p2", 2, "# v2")], null, opened.selectedRevisionId)?.id,
      "p2",
    );
    const closed = planDocumentReducer(opened, { type: "close" });
    assert.equal(closed.activePlanId, null);
    assert.equal(closed.selectedRevisionId, null);
  });

  it("切换 revision 返回对应正文，历史版本只读", () => {
    const plans = [plan("p1", 1, "# v1"), plan("p2", 2, "# v2"), plan("p3", 3, "# v3")];
    assert.equal(resolvePlanRevision(plans, null, "p1")?.markdown, "# v1");
    assert.equal(resolvePlanRevision(plans, null, "p3")?.markdown, "# v3");

    const old = resolvePlanRevision(plans, null, "p1");
    assert.equal(old?.readOnly, true);
    assert.equal(old?.latest, false);
    const current = resolvePlanRevision(plans, null, "p3");
    assert.equal(current?.readOnly, false);
    assert.equal(current?.latest, true);

    const entries = planRevisionEntries(plans, null);
    assert.deepEqual(entries.map((entry) => entry.revision), [3, 2, 1]);
    assert.deepEqual(entries.map((entry) => entry.latest), [true, false, false]);
  });

  it("流式草稿是当前最新版本，delta 实时更新文档", () => {
    let draft = applyPlanDraft(null, { type: "proposed_plan_start", planId: "p9", revision: 9 });
    draft = applyPlanDraft(draft, {
      type: "proposed_plan_delta",
      planId: "p9",
      delta: "# 标题\n\n## Goal\n\n第一段",
    });
    assert.equal(resolvePlanRevision([], draft, "p9")?.markdown, "# 标题\n\n## Goal\n\n第一段");
    assert.equal(planPreviewInfo(draft.markdown).title, "标题");
    draft = applyPlanDraft(draft, { type: "proposed_plan_delta", planId: "p9", delta: "，继续写" });
    assert.match(resolvePlanRevision([], draft, "p9")?.markdown ?? "", /继续写$/);
    const entries = planRevisionEntries([plan("p1", 1, "# 旧")], draft);
    assert.equal(entries[0]?.id, "p9");
    assert.equal(entries[0]?.streaming, true);
    assert.equal(entries[0]?.latest, true);
  });

  it("关闭后即使还有草稿或最新版本，文档面板也不再解析出来", () => {
    const plans = [plan("p1", 1, "# v1")];
    const draft: PlanDraft = { id: "p9", revision: 9, markdown: "# 草稿", streaming: true };
    const opened = { activePlanId: "p9", selectedRevisionId: "p9" };
    assert.ok(resolveOpenPlanRevision(opened, plans, draft));
    const closed = planDocumentReducer(opened, { type: "close" });
    assert.equal(closed.activePlanId, null);
    assert.equal(resolveOpenPlanRevision(closed, plans, draft), null);
    assert.equal(resolveOpenPlanRevision(closed, plans, null), null);
  });

  it("关闭再打开 Plan 不影响 conversation 消息", () => {
    const messages: UiMessage[] = [assistant(["p2"])];
    const before = JSON.stringify(messages);
    const opened = planDocumentReducer(emptyPlanDocumentState, { type: "open", planId: "p2" });
    const closed = planDocumentReducer(opened, { type: "close" });
    const reopened = planDocumentReducer(closed, { type: "open", planId: "p2" });
    assert.equal(reopened.activePlanId, "p2");
    planDocumentReducer(reopened, { type: "select", planId: "p1" });
    assert.equal(JSON.stringify(messages), before);
  });
});

describe("Plan 未完成 / 执行动作", () => {
  it("流式生成中不能执行或修改", () => {
    const draft: PlanDraft = { id: "p9", revision: 9, markdown: "# 草稿", streaming: true };
    const acting = planActionState(plan("p1", 1, "# v1"), draft, false);
    assert.equal(acting.canExecute, false);
    assert.equal(acting.canRevise, false);
    assert.equal(acting.generating, true);
  });

  it("空闲时的最新版本可执行，忙碌时不可执行", () => {
    assert.equal(planActionState(plan("p1", 1, "# v1"), null, false).canExecute, true);
    assert.equal(planActionState(plan("p1", 1, "# v1"), null, true).canExecute, false);
    assert.equal(planActionState(null, null, false).canExecute, false);
  });

  it("执行菜单复用现有的 continue / fresh strategy", () => {
    assert.deepEqual(planExecutionChoices.map((choice) => choice.strategy), ["continue", "fresh"]);
  });
});

describe("长文档与执行进度", () => {
  it("ContextPanel 引用只含标题、版本和进度，不带 Markdown 正文", () => {
    const long = `# 大方案\n\n## Goal\n\n${"很长的正文。".repeat(200)}`;
    const info = planPreviewInfo(long);
    assert.equal(info.title, "大方案");
    assert.ok((info.overview?.length ?? 0) <= 220);

    const reference = planReferenceModel(plan("p1", 1, long, "approved"), null, null);
    assert.ok(reference);
    assert.equal("markdown" in reference, false);
    assert.equal(reference.title, "大方案");
    assert.equal(reference.status, "approved");
  });

  it("ExecutionPlan 更新只影响进度，不改动 Plan Markdown", () => {
    const item = plan("p1", 1, "# Plan\n\n## Goal\n\n不要改我", "approved");
    const execution: ExecutionPlan = {
      id: "e1",
      sourcePlanId: "p1",
      items: [
        { id: "i1", text: "第一步", status: "completed" },
        { id: "i2", text: "第二步", status: "in_progress" },
      ],
      updatedAt: 2,
    };
    const progress = planProgress(execution);
    assert.equal(progress.completed, 1);
    assert.equal(progress.total, 2);
    assert.equal(progress.active?.text, "第二步");
    assert.equal(resolvePlanRevision([item], null, "p1")?.markdown, "# Plan\n\n## Goal\n\n不要改我");
    assert.equal(item.markdown, "# Plan\n\n## Goal\n\n不要改我");
  });

  it("预览信息抽取标题、概要和章节", () => {
    const info = planPreviewInfo(
      "# Agent Trace Viewer 实现方案\n\n## Goal\n\n为会话界面增加轨迹查看。\n\n## Runtime\n\n收集运行时事件。\n\n## Testing\n\n补充测试。",
    );
    assert.equal(info.title, "Agent Trace Viewer 实现方案");
    assert.equal(info.overview, "为会话界面增加轨迹查看。");
    assert.deepEqual(info.sections, ["Goal", "Runtime", "Testing"]);
  });

  it("通用 # Plan 标题回退到 objective 或首段", () => {
    assert.equal(planPreviewInfo("# Plan\n\n## Goal\n\n说明", "原始目标").title, "原始目标");
    assert.equal(planPreviewInfo("# Plan\n\n## Goal\n\n说明").title, "说明");
  });

  it("预览按顺序收集一轮里的多个 plan", () => {
    const ids = collectPlanIds([assistant(), assistant(["p1"]), assistant(["p2", "p1"])]);
    assert.deepEqual(ids, ["p1", "p2"]);
  });
});
