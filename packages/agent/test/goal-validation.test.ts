import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ConversationGoal } from "@vela/shared";
import {
  createGoalValidation,
  goalCompletionBlocker,
  normalizeStoredGoal,
  type GoalValidationDraft,
  type GoalValidationEvidence,
} from "../src/goal-validation.ts";
import { modeSystemPrompt, toolNamesFor } from "../src/interaction.ts";

function goal(overrides: Partial<ConversationGoal> = {}): ConversationGoal {
  return {
    id: "goal-1",
    objective: "完成一个小改动",
    status: "active",
    note: null,
    workRevision: 0,
    validation: null,
    updatedAt: 100,
    ...overrides,
  };
}

function evidence(
  toolCallId: string,
  result: "passed" | "failed",
  workRevision = 0,
  completedAt = 200,
  sequence = completedAt,
): GoalValidationEvidence {
  return {
    toolCallId,
    command: toolCallId === "diff" ? "git diff --check" : "pnpm test --filter agent",
    result,
    output: result === "passed" ? "检查通过" : "检查失败，exit code 1",
    completedAt,
    sequence,
    workRevision,
  };
}

function lowRiskDraft(checks: GoalValidationDraft["checks"] = []): GoalValidationDraft {
  const checked = new Set(checks.map((item) => item.category));
  const skipped: GoalValidationDraft["skipped"] = [];
  for (const category of ["diff", "test", "build", "typecheck", "regression"] as const) {
    if (!checked.has(category)) skipped.push({ category, reason: "本次改动不涉及该项，已检查变更范围。" });
  }
  return { risk: "low", checks, skipped, knownIssues: [] };
}

function mediumDraft(checks: GoalValidationDraft["checks"], knownIssues: GoalValidationDraft["knownIssues"] = []): GoalValidationDraft {
  const checked = new Set(checks.map((item) => item.category));
  const skipped: GoalValidationDraft["skipped"] = [];
  for (const category of ["diff", "test", "build", "typecheck", "regression"] as const) {
    if (!checked.has(category)) skipped.push({ category, reason: "当前改动不影响该验证范围。" });
  }
  return { risk: "medium", checks, skipped, knownIssues };
}

describe("Goal 交付验证", () => {
  it("只在 Goal 模式提供验证工具，并要求先验证再完成", () => {
    assert.equal(toolNamesFor("goal", false).includes("record_goal_validation"), true);
    assert.equal(toolNamesFor("agent", false).includes("record_goal_validation"), false);
    assert.match(modeSystemPrompt("goal", false), /先调用 record_goal_validation/);
  });

  it("没有验证记录时不能完成目标", () => {
    assert.match(goalCompletionBlocker(goal()) ?? "", /提交交付验证/);
  });

  it("低风险任务允许带原因跳过测试等检查", () => {
    const checked = [{ category: "diff" as const, toolCallId: "diff" }];
    const result = createGoalValidation(goal(), lowRiskDraft(checked), [evidence("diff", "passed")], 300);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.validation.status, "passed");
    assert.equal(result.validation.skipped.some((item) => item.category === "test"), true);
    assert.equal(goalCompletionBlocker(goal({ validation: result.validation })), null);
  });

  it("中风险任务缺少 diff 或定向测试时无法提交报告", () => {
    const result = createGoalValidation(
      goal(),
      mediumDraft([{ category: "test", toolCallId: "test" }]),
      [evidence("test", "passed")],
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.text, /diff/);
  });

  it("高风险任务还必须运行更广范围的回归检查", () => {
    const result = createGoalValidation(
      goal(),
      {
        ...mediumDraft([
          { category: "diff", toolCallId: "diff" },
          { category: "test", toolCallId: "test" },
        ]),
        risk: "high",
        skipped: [
          { category: "build", reason: "未改构建配置。" },
          { category: "typecheck", reason: "未改类型接口。" },
          { category: "regression", reason: "暂未运行。" },
        ],
      },
      [evidence("diff", "passed"), evidence("test", "passed")],
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.text, /回归/);
  });

  it("测试失败后重跑通过，保留失败历史且允许完成", () => {
    const firstRun = createGoalValidation(
      goal(),
      mediumDraft(
        [
          { category: "diff", toolCallId: "initial-diff" },
          { category: "test", toolCallId: "failed-test" },
        ],
        [{ toolCallId: "failed-test", reason: "已确认该基线失败来自既有测试，后续会重跑确认。" }],
      ),
      [evidence("initial-diff", "passed"), evidence("failed-test", "failed")],
      250,
    );
    assert.equal(firstRun.ok, true);
    if (!firstRun.ok) return;
    const afterFix = goal({ workRevision: 1, validation: firstRun.validation });
    const rerun = createGoalValidation(
      afterFix,
      mediumDraft([
        { category: "diff", toolCallId: "new-diff" },
        { category: "test", toolCallId: "passed-test" },
      ]),
      [evidence("new-diff", "passed", 1, 300), evidence("passed-test", "passed", 1, 310)],
      320,
    );
    assert.equal(rerun.ok, true);
    if (!rerun.ok) return;
    assert.equal(rerun.validation.checks.some((check) => check.toolCallId === "failed-test"), true);
    assert.equal(goalCompletionBlocker(goal({ workRevision: 1, validation: rerun.validation })), null);
  });

  it("最新失败必须修复，或附上与本次改动无关的依据", () => {
    const checks = [
      { category: "diff" as const, toolCallId: "diff" },
      { category: "test" as const, toolCallId: "test-failed" },
    ];
    const runs = [evidence("diff", "passed"), evidence("test-failed", "failed")];
    const blocked = createGoalValidation(goal(), mediumDraft(checks), runs, 300);
    assert.equal(blocked.ok, false);
    if (blocked.ok) return;
    assert.match(blocked.text, /失败/);

    const acknowledged = createGoalValidation(
      goal(),
      mediumDraft(checks, [{ toolCallId: "test-failed", reason: "失败来自另一个预存测试，复核后确认与本次改动无关。" }]),
      runs,
      300,
    );
    assert.equal(acknowledged.ok, true);
    if (!acknowledged.ok) return;
    assert.equal(acknowledged.validation.status, "known_issues");
    assert.equal(goalCompletionBlocker(goal({ validation: acknowledged.validation })), null);
  });

  it("拒绝虚构的工具调用 id 和旧工作区修订的命令", () => {
    const missing = createGoalValidation(goal(), lowRiskDraft([{ category: "diff", toolCallId: "invented" }]), []);
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.match(missing.text, /找不到工具调用/);

    const stale = createGoalValidation(
      goal({ workRevision: 2 }),
      lowRiskDraft([{ category: "diff", toolCallId: "old-diff" }]),
      [evidence("old-diff", "passed", 1)],
    );
    assert.equal(stale.ok, false, "旧命令不能满足当前 revision 的检查门槛");
    if (!stale.ok) assert.match(stale.text, /diff/);
  });

  it("检查后未记录的 bash 命令会让先前检查失效", () => {
    const runs = [evidence("diff", "passed", 0, 200, 1), evidence("untracked", "passed", 0, 300, 2)];
    const missing = createGoalValidation(goal(), lowRiskDraft([{ category: "diff", toolCallId: "diff" }]), runs);
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.match(missing.text, /未记录的 bash 命令/);

    const recorded = createGoalValidation(
      goal(),
      lowRiskDraft([
        { category: "diff", toolCallId: "diff" },
        { category: "other", toolCallId: "untracked" },
      ]),
      runs,
    );
    assert.equal(recorded.ok, true);
  });

  it("工作区在验证后变化时，完成门槛要求重新验证", () => {
    const result = createGoalValidation(
      goal(),
      lowRiskDraft([{ category: "diff", toolCallId: "diff" }]),
      [evidence("diff", "passed")],
      300,
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(goalCompletionBlocker(goal({ workRevision: 1, validation: result.validation })) ?? "", /已过期/);
  });

  it("重启加载后保留验证证据和完成门槛", () => {
    const result = createGoalValidation(
      goal(),
      lowRiskDraft([{ category: "diff", toolCallId: "diff" }]),
      [evidence("diff", "passed")],
      300,
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const serialized = JSON.parse(JSON.stringify({ ...goal(), validation: result.validation })) as unknown;
    const restored = normalizeStoredGoal(serialized);
    assert.ok(restored);
    assert.equal(restored.status, "paused");
    assert.equal(restored.validation?.checks[0]?.toolCallId, "diff");
    assert.equal(goalCompletionBlocker(restored), null);
  });
});
