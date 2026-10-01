import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExecutionPlan, ProposedPlanItem } from "@vela/shared";
import {
  DefaultToolPolicy,
  modeSystemPrompt,
  modeToolNames,
  toolNamesFor,
} from "../src/interaction.ts";
import { activityFromCall, activityFromExecution } from "../src/tool-activity.ts";
import {
  appendPlanRevision,
  applyExecutionPlanUpdate,
  approvePlanRevision,
  bindExecutionPlan,
  createExecutionPlan,
  createPlanStreamParser,
  extractProposedPlans,
  isPlanExecutionPrompt,
  latestPlan,
  migrateLegacyPlan,
  planContinuePrompt,
  planFreshPrompt,
  type PlanStreamEvent,
} from "../src/plan.ts";

function revision(id: string, markdown: string): ProposedPlanItem {
  return {
    id,
    markdown,
    revision: 1,
    supersedes: null,
    status: "draft",
    objective: "原始目标",
    createdAt: 1,
    approvedAt: null,
  };
}

function planEnd(events: PlanStreamEvent[]): string | null {
  const end = events.find((event) => event.type === "plan_end");
  return end?.type === "plan_end" ? end.markdown : null;
}

function textOf(events: PlanStreamEvent[]): string {
  return events
    .filter((event): event is Extract<PlanStreamEvent, { type: "text" }> => event.type === "text")
    .map((event) => event.delta)
    .join("");
}

describe("Plan 模式约束", () => {
  it("prompt 要求完整实施方案而不是短步骤清单", () => {
    const prompt = modeSystemPrompt("plan", false);
    assert.match(prompt, /<proposed_plan>/);
    assert.match(prompt, /decision-complete/);
    assert.match(prompt, /Implementation Steps/);
    assert.doesNotMatch(prompt, /最多 8 步/);
    assert.doesNotMatch(prompt, /每步一句/);
    assert.doesNotMatch(prompt, /plan_confirm/);
  });

  it("Plan 模式只提供只读工具", () => {
    assert.deepEqual(toolNamesFor("plan", false), ["read", "bash", "ask_user_question"]);
    assert.equal(toolNamesFor("plan", true).includes("update_plan"), false);
    assert.equal(toolNamesFor("plan", true).includes("spawn_agent"), false);
  });

  it("只有存在执行计划时才暴露 update_plan", () => {
    assert.equal(toolNamesFor("agent", false).includes("update_plan"), false);
    assert.equal(toolNamesFor("agent", true).includes("update_plan"), true);
    assert.match(modeSystemPrompt("agent", true), /update_plan/);
    assert.doesNotMatch(modeSystemPrompt("agent", false), /update_plan/);
  });

  it("旧的 submit_plan / complete_step 已从工具协议移除", () => {
    assert.equal(modeToolNames.includes("submit_plan"), false);
    assert.equal(modeToolNames.includes("complete_step"), false);
    assert.equal(toolNamesFor("agent", true).includes("complete_step"), false);
  });
});

describe("Plan ToolPolicy", () => {
  const policy = new DefaultToolPolicy();

  it("Plan 模式拒绝写文件工具", () => {
    for (const toolName of ["edit", "write", "apply_patch"]) {
      const result = policy.authorizeCall({ mode: "plan", toolName, input: {} });
      assert.equal(result.allowed, false, `${toolName} 应该被拒绝`);
    }
    assert.equal(policy.authorizeCall({ mode: "agent", toolName: "edit", input: {} }).allowed, true);
  });

  it("Plan 模式拒绝 destructive bash，放行只读命令", () => {
    const destructive = [
      "rm -rf src",
      "git commit -m x",
      "git checkout .",
      "npm install",
      "echo hello > file.txt",
    ];
    for (const command of destructive) {
      const result = policy.authorizeCall({ mode: "plan", toolName: "bash", input: { command } });
      assert.equal(result.allowed, false, `${command} 应该被拒绝`);
    }
    for (const command of ["rg submit_plan packages/agent/src", "git status", "git diff --stat"]) {
      const result = policy.authorizeCall({ mode: "plan", toolName: "bash", input: { command } });
      assert.equal(result.allowed, true, `${command} 应该被放行`);
    }
  });

  it("Plan 模式不放行 agent 树工具", () => {
    const result = policy.authorizeCall({ mode: "plan", toolName: "spawn_agent", input: {} });
    assert.equal(result.allowed, false);
  });
});

describe("<proposed_plan> 流式解析", () => {
  it("标签跨多个 delta 时也能解析，前后普通文本保留", () => {
    const parser = createPlanStreamParser();
    const events = [
      ...parser.push("我已经检查完 Runtime。\n\n<prop"),
      ...parser.push("osed_plan>\n# Plan\n\n## Goal\n\n"),
      ...parser.push("把计划升级为完整规格。\n</proposed"),
      ...parser.push("_plan>\n\n实现时注意兼容。"),
      ...parser.flush(),
    ];
    const starts = events.filter((event) => event.type === "plan_start");
    assert.equal(starts.length, 1);
    assert.equal(textOf(events).includes("我已经检查完 Runtime。"), true);
    assert.equal(textOf(events).includes("实现时注意兼容。"), true);
    const markdown = planEnd(events);
    assert.ok(markdown);
    assert.match(markdown, /# Plan/);
    assert.match(markdown, /把计划升级为完整规格。/);
  });

  it("同一 delta 里的完整块与后续文本分别输出", () => {
    const parser = createPlanStreamParser();
    const events = [
      ...parser.push("前言<proposed_plan># 方案</proposed_plan>后记"),
      ...parser.flush(),
    ];
    assert.equal(textOf(events), "前言后记");
    assert.equal(planEnd(events), "# 方案");
  });

  it("消息结束仍未闭合时按块结束收尾", () => {
    const parser = createPlanStreamParser();
    const events = [...parser.push("<proposed_plan>\n# Plan\n\n未写完的方案"), ...parser.flush()];
    assert.match(planEnd(events) ?? "", /未写完的方案/);
  });

  it("普通文本里不完整的标签前缀不会泄漏为 plan", () => {
    const parser = createPlanStreamParser();
    const events = [...parser.push("这段只是提到 <proposed"), ...parser.push("_plan 这个词"), ...parser.flush()];
    assert.equal(planEnd(events), null);
    assert.equal(textOf(events), "这段只是提到 <proposed_plan 这个词");
  });

  it("extractProposedPlans 剥离块并保留正文", () => {
    const extracted = extractProposedPlans("说明\n\n<proposed_plan>\n# Plan\n\nA\n</proposed_plan>\n\n收尾");
    assert.equal(extracted.plans.length, 1);
    assert.match(extracted.plans[0] ?? "", /# Plan/);
    assert.equal(extracted.text.includes("<proposed_plan>"), false);
    assert.match(extracted.text, /说明/);
    assert.match(extracted.text, /收尾/);
  });
});

describe("update_plan 工具活动", () => {
  const args = {
    plan: [
      { step: "新建 docs/README.md", status: "completed" },
      { step: "更新根 README.md 两处入口链接", status: "in_progress" },
      { step: "验证：链接检查、运行 plan 相关测试", status: "pending" },
    ],
  };

  it("解析成结构化执行项，供界面渲染图标和引导线", () => {
    const call = activityFromCall("update_plan", args);
    assert.deepEqual(call.plan, [
      { text: "新建 docs/README.md", status: "completed" },
      { text: "更新根 README.md 两处入口链接", status: "in_progress" },
      { text: "验证：链接检查、运行 plan 相关测试", status: "pending" },
    ]);
    const result = activityFromExecution(
      "update_plan",
      args,
      { content: [{ type: "text", text: "执行清单已更新：1/3 完成，进行中：更新根 README.md 两处入口链接。" }] },
      false,
    );
    assert.equal(result.plan?.length, 3);
    assert.equal(result.plan?.[1]?.status, "in_progress");
    // 文本摘要仍然保留，作为旧路径和搜索的回退。
    assert.match(result.body ?? "", /✓ 新建 docs\/README.md/);
  });

  it("丢弃空条目，未知状态回退为 pending", () => {
    const activity = activityFromCall("update_plan", {
      plan: [
        { step: "   ", status: "completed" },
        { step: "A", status: "bogus" },
      ],
    });
    assert.deepEqual(activity.plan, [{ text: "A", status: "pending" }]);
  });
});

describe("Plan revision", () => {
  it("新 revision 不覆盖旧版本，并指向上一版", () => {
    const first = appendPlanRevision([], {
      id: "p1",
      markdown: "# Plan\n\n## Goal\n\nA",
      objective: "原始目标",
      createdAt: 10,
    });
    assert.equal(first.plan.revision, 1);
    assert.equal(first.plan.supersedes, null);
    assert.equal(first.plan.status, "draft");

    const second = appendPlanRevision(first.plans, {
      id: "p2",
      markdown: "# Plan\n\n## Goal\n\nB",
      objective: null,
      createdAt: 20,
    });
    assert.equal(second.plan.revision, 2);
    assert.equal(second.plan.supersedes, "p1");
    const older = second.plans.find((plan) => plan.id === "p1");
    assert.ok(older);
    assert.equal(older.markdown, "# Plan\n\n## Goal\n\nA");
    assert.equal(older.status, "superseded");
    assert.equal(latestPlan(second.plans)?.id, "p2");
  });

  it("批准只改变目标 revision 的状态", () => {
    const { plans } = appendPlanRevision([], { id: "p1", markdown: "# A", objective: null, createdAt: 1 });
    const approved = approvePlanRevision(plans, "p1", 5);
    assert.equal(approved[0]?.status, "approved");
    assert.equal(approved[0]?.approvedAt, 5);
  });

  it("执行中重新规划会生成新 revision，旧 execution 仍绑定旧 revision", () => {
    const first = appendPlanRevision([], { id: "p1", markdown: "# v1", objective: null, createdAt: 1 });
    const execution = createExecutionPlan(first.plan, 1);
    const second = appendPlanRevision(first.plans, { id: "p2", markdown: "# v2", objective: null, createdAt: 2 });
    assert.equal(execution.sourcePlanId, "p1");
    assert.equal(second.plan.supersedes, "p1");
    assert.equal(latestPlan(second.plans)?.revision, 2);
  });
});

describe("ExecutionPlan", () => {
  it("绑定 sourcePlanId，更新进度不修改 ProposedPlan", () => {
    const { plans, plan } = appendPlanRevision([], {
      id: "p1",
      markdown: "# Plan",
      objective: null,
      createdAt: 1,
    });
    const execution = createExecutionPlan(plan, 1);
    assert.equal(execution.sourcePlanId, "p1");
    const result = applyExecutionPlanUpdate(
      execution,
      [
        { step: "Introduce AgentSessionFactory", status: "completed" },
        { step: "Update restoration logic", status: "in_progress" },
        { step: "Add integration tests", status: "pending" },
      ],
      2,
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.execution.items.map((item) => item.status), ["completed", "in_progress", "pending"]);
    assert.equal(plans[0]?.markdown, "# Plan");
    assert.equal(plans[0]?.status, "draft");
  });

  it("批准后绑定执行计划，重复执行复用已有进度", () => {
    const { plan } = appendPlanRevision([], { id: "p1", markdown: "# Plan", objective: null, createdAt: 1 });
    const first = bindExecutionPlan([], plan, 1);
    assert.equal(first.appended, true);
    assert.equal(first.execution.sourcePlanId, plan.id);
    const second = bindExecutionPlan(first.executionPlans, plan, 2);
    assert.equal(second.appended, false);
    assert.equal(second.execution.id, first.execution.id);
  });

  it("同一时刻最多一项 in_progress", () => {
    const execution: ExecutionPlan = { id: "e1", sourcePlanId: "p1", items: [], updatedAt: 0 };
    const result = applyExecutionPlanUpdate(
      execution,
      [
        { step: "A", status: "in_progress" },
        { step: "B", status: "in_progress" },
      ],
      1,
    );
    assert.equal(result.ok, false);
  });

  it("按文本复用已有条目的 id，允许新增和合并", () => {
    const execution: ExecutionPlan = {
      id: "e1",
      sourcePlanId: "p1",
      items: [{ id: "keep", text: "Keep me", status: "in_progress" }],
      updatedAt: 0,
    };
    const result = applyExecutionPlanUpdate(
      execution,
      [
        { step: "Keep me", status: "completed" },
        { step: "New item", status: "pending" },
      ],
      1,
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.execution.items[0]?.id, "keep");
    assert.equal(result.execution.items.length, 2);
  });
});

describe("执行输入", () => {
  it("continue 与 fresh 都被识别为系统代发", () => {
    const plan: ProposedPlanItem = {
      ...revision("p1", "# Plan\n\n## Goal\n\n做事"),
      status: "approved",
      revision: 3,
      approvedAt: 1,
    };
    const continuePrompt = planContinuePrompt(plan);
    const freshPrompt = planFreshPrompt("原始目标", plan);
    assert.equal(isPlanExecutionPrompt(continuePrompt), true);
    assert.equal(isPlanExecutionPrompt(freshPrompt), true);
    assert.equal(isPlanExecutionPrompt("普通用户消息"), false);
    assert.match(continuePrompt, /revision 3/);
    assert.match(freshPrompt, /# Objective/);
    assert.match(freshPrompt, /原始目标/);
    assert.match(freshPrompt, /# Approved Plan/);
    assert.match(freshPrompt, /# Plan/);
    assert.doesNotMatch(continuePrompt, /plan_confirm/);
  });
});

describe("旧 ConversationPlan 迁移", () => {
  it("迁移成 v1 方案与执行进度", () => {
    const migration = migrateLegacyPlan(
      {
        title: "旧计划",
        overview: "旧概述",
        steps: [
          { id: "s1", text: "第一步", done: true },
          { id: "s2", text: "第二步", done: false },
        ],
        updatedAt: 100,
      },
      { mode: "agent", now: 200 },
    );
    assert.ok(migration);
    assert.equal(migration.plans.length, 1);
    assert.equal(migration.plans[0]?.revision, 1);
    assert.equal(migration.plans[0]?.status, "approved");
    assert.match(migration.plans[0]?.markdown ?? "", /^# 旧计划/);
    assert.match(migration.plans[0]?.markdown ?? "", /## Overview/);
    assert.match(migration.plans[0]?.markdown ?? "", /1\. 第一步/);
    assert.equal(migration.latestProposedPlanId, migration.plans[0]?.id);
    assert.equal(migration.executionPlan?.sourcePlanId, migration.plans[0]?.id);
    assert.deepEqual(
      migration.executionPlan?.items.map((item) => item.status),
      ["completed", "pending"],
    );
  });

  it("没执行过的旧计划只迁移内容，不伪造进度", () => {
    const migration = migrateLegacyPlan(
      {
        title: "旧计划",
        overview: "旧概述",
        steps: [{ id: "s1", text: "第一步", done: false }],
        updatedAt: 100,
      },
      { mode: "plan", now: 200 },
    );
    assert.ok(migration);
    assert.equal(migration.executionPlan, null);
    assert.equal(migration.plans[0]?.status, "draft");
  });
});
