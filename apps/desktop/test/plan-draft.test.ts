import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyPlanDraft, planProgress } from "../src/renderer/plan-draft.ts";

describe("Plan 草稿", () => {
  it("跨事件累加 markdown，收到 plan_end 后清空", () => {
    let draft = applyPlanDraft(null, { type: "proposed_plan_start", planId: "p1", revision: 2 });
    assert.equal(draft?.revision, 2);
    draft = applyPlanDraft(draft, { type: "proposed_plan_delta", planId: "p1", delta: "# Plan\n\n" });
    draft = applyPlanDraft(draft, { type: "proposed_plan_delta", planId: "p1", delta: "## Goal\n\n做事" });
    assert.equal(draft?.markdown, "# Plan\n\n## Goal\n\n做事");
    draft = applyPlanDraft(draft, {
      type: "proposed_plan_end",
      plan: {
        id: "p1",
        markdown: "# Plan\n\n## Goal\n\n做事",
        revision: 2,
        supersedes: null,
        status: "draft",
        objective: null,
        createdAt: 1,
        approvedAt: null,
      },
    });
    assert.equal(draft, null);
  });

  it("忽略其他 revision 的 delta", () => {
    const draft = applyPlanDraft(null, { type: "proposed_plan_start", planId: "p1", revision: 1 });
    const stale = applyPlanDraft(draft, { type: "proposed_plan_delta", planId: "p2", delta: "x" });
    assert.deepEqual(stale, draft);
  });
});

describe("执行进度", () => {
  it("只从 ExecutionPlan 计算，不依赖 Plan 正文", () => {
    const progress = planProgress({
      id: "e1",
      sourcePlanId: "p1",
      updatedAt: 1,
      items: [
        { id: "1", text: "a", status: "completed" },
        { id: "2", text: "b", status: "in_progress" },
        { id: "3", text: "c", status: "pending" },
      ],
    });
    assert.equal(progress.completed, 1);
    assert.equal(progress.total, 3);
    assert.equal(progress.percent, 33);
    assert.equal(progress.active?.id, "2");
  });

  it("没有执行计划时是空进度", () => {
    assert.deepEqual(planProgress(null), { completed: 0, total: 0, percent: 0, active: null });
  });
});
