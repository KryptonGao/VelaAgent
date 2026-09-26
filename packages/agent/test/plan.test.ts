import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  acceptPlanDraft,
  isPlanExecutionPrompt,
  modeSystemPrompt,
  planExecutionPrompt,
  planOverviewMax,
  planStepMax,
} from "../src/interaction.ts";
import { activityFromExecution } from "../src/tool-activity.ts";

const shortPlan = {
  title: "桌面单文件：鹈鹕骑车",
  overview: "在桌面写一个自包含 HTML，用内联 SVG 和 SMIL 做循环动画。",
  steps: ["搭好页面骨架", "画出鹈鹕和自行车", "让轮子、踏板和云朵循环"],
};

describe("计划概括", () => {
  it("Plan 模式要求提交短概括", () => {
    const prompt = modeSystemPrompt("plan", false);
    assert.match(prompt, /扫一眼的概括/);
    assert.match(prompt, /最多 8 步/);
    assert.match(prompt, /每步一句/);
  });

  it("识别系统代发的计划执行提示", () => {
    const prompt = planExecutionPrompt({
      title: shortPlan.title,
      overview: shortPlan.overview,
      steps: shortPlan.steps.map((text, index) => ({ id: `s${index}`, text, done: false })),
      updatedAt: 0,
    });
    assert.equal(isPlanExecutionPrompt(prompt), true);
    assert.equal(isPlanExecutionPrompt("请按计划实现"), false);
  });

  it("收下短计划，并收成单行", () => {
    const accepted = acceptPlanDraft({
      title: "  桌面单文件：鹈鹕骑车  ",
      overview: "在桌面写一个自包含 HTML。\n用内联 SVG 做循环动画。",
      steps: [" 搭好页面骨架 ", "", "画出鹈鹕和自行车"],
    });
    assert.equal(accepted.ok, true);
    if (!accepted.ok) return;
    assert.equal(accepted.plan.title, "桌面单文件：鹈鹕骑车");
    assert.equal(accepted.plan.overview, "在桌面写一个自包含 HTML。 用内联 SVG 做循环动画。");
    assert.deepEqual(accepted.plan.steps, ["搭好页面骨架", "画出鹈鹕和自行车"]);
  });

  it("超长规格说明会被退回，而不是截断后保存", () => {
    const accepted = acceptPlanDraft({
      ...shortPlan,
      overview: "详".repeat(planOverviewMax + 1),
      steps: ["步".repeat(planStepMax + 1), ...Array.from({ length: 8 }, (_, index) => `步骤 ${index}`)],
    });
    assert.equal(accepted.ok, false);
    if (accepted.ok) return;
    assert.match(accepted.text, /概括/);
    assert.match(accepted.text, /概述/);
    assert.match(accepted.text, /步骤请合并/);
    assert.match(accepted.text, /每步请写成一句/);
  });
});

describe("计划卡片", () => {
  it("展示标题、概述和步骤，不展示给模型的提交说明", () => {
    const activity = activityFromExecution(
      "submit_plan",
      shortPlan,
      {
        content: [
          {
            type: "text",
            text: "已提交计划「桌面单文件：鹈鹕骑车」，共 3 步。请立即调用 ask_user_question（kind 设为 plan_confirm）问用户是否执行。",
          },
        ],
      },
      false,
    );
    assert.equal(
      activity.body,
      ["桌面单文件：鹈鹕骑车", shortPlan.overview, "1. 搭好页面骨架", "2. 画出鹈鹕和自行车", "3. 让轮子、踏板和云朵循环"].join(
        "\n",
      ),
    );
    assert.doesNotMatch(activity.body ?? "", /ask_user_question/);
  });
});
