import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { modeSystemPrompt, toolNamesFor } from "../src/interaction.ts";
import { exploreCommandAllowed, formatSubagentReport } from "../src/subagent.ts";
import { activityFromCall, activityFromExecution, activityFromOutput } from "../src/tool-activity.ts";

describe("task 工具开关", () => {
  it("Agent 和 Goal 可以调用 task，Plan 不可以", () => {
    assert.equal(toolNamesFor("agent", false).includes("task"), true);
    assert.equal(toolNamesFor("agent", true).includes("task"), true);
    assert.equal(toolNamesFor("goal", false).includes("task"), true);
    assert.equal(toolNamesFor("plan", false).includes("task"), false);
    assert.equal(toolNamesFor("plan", true).includes("task"), false);
  });

  it("只有能调用 task 的模式才会提示何时使用", () => {
    assert.match(modeSystemPrompt("agent", false), /调用 task/);
    assert.match(modeSystemPrompt("agent", true), /调用 task/);
    assert.match(modeSystemPrompt("goal", false), /调用 task/);
    assert.doesNotMatch(modeSystemPrompt("plan", false), /调用 task/);
  });
});

describe("task 活动", () => {
  it("开始时用任务摘要做标题", () => {
    const activity = activityFromCall("task", { agent: "explore", task: "  找会话启动\n相关文件  " });
    assert.equal(activity.agent, "explore");
    assert.equal(activity.body, "找会话启动 相关文件");
    assert.equal(activity.steps, undefined);
  });

  it("进行中只更新步骤，不盖掉标题", () => {
    const activity = activityFromOutput(
      {
        content: [{ type: "text", text: "正在读 runtime" }],
        details: {
          agent: "explore",
          steps: [{ id: "1", name: "read", summary: "src/runtime.ts", status: "running" }],
          mutated: false,
        },
      },
      "task",
    );
    assert.equal(activity?.body, undefined);
    assert.equal(activity?.agent, "explore");
    assert.deepEqual(activity?.steps, [{ id: "1", name: "read", summary: "src/runtime.ts", status: "running" }]);
    assert.equal(activity?.mutated, undefined);
  });

  it("结束时保留任务摘要、结论、步骤和改动标记", () => {
    const activity = activityFromExecution(
      "task",
      { agent: "general", task: "改标题" },
      {
        content: [{ type: "text", text: "[general]\n\n改好了" }],
        details: {
          agent: "general",
          steps: [
            { id: "2", name: "edit", summary: "README.md", status: "done" },
            { id: "", name: "read", summary: "缺 id", status: "done" },
            { id: "3", name: "bash", summary: "git status", status: "nope" },
          ],
          mutated: true,
          truncated: false,
        },
      },
      false,
    );
    assert.equal(activity.agent, "general");
    assert.equal(activity.mutated, true);
    assert.equal(activity.body, "改标题\n\n[general]\n\n改好了");
    assert.deepEqual(activity.steps, [{ id: "2", name: "edit", summary: "README.md", status: "done" }]);
  });
});

describe("查阅子代理命令守卫", () => {
  it("放行只读命令，拒绝会改动系统的命令", () => {
    assert.equal(exploreCommandAllowed("rg foo src"), true);
    assert.equal(exploreCommandAllowed("git status"), true);
    assert.equal(exploreCommandAllowed("rm -rf tmp"), false);
    assert.equal(exploreCommandAllowed("git commit -m x"), false);
    assert.equal(exploreCommandAllowed("echo hi > out.txt"), false);
    assert.equal(exploreCommandAllowed("   "), false);
  });
});

describe("子代理结论", () => {
  it("回合上限和过长结论会写进返回给父代理的正文", () => {
    const report = formatSubagentReport({
      agent: "explore",
      text: "查完了",
      failure: "",
      turnLimited: true,
      stopped: false,
    });
    assert.match(report.text, /\[explore\]/);
    assert.match(report.text, /查完了/);
    assert.match(report.text, /回合上限/);
    assert.equal(report.truncated, true);

    const clipped = formatSubagentReport({
      agent: "general",
      text: "x".repeat(12_001),
      failure: "",
      turnLimited: false,
      stopped: false,
    });
    assert.match(clipped.text, /结论过长，已截断/);
    assert.equal(clipped.truncated, true);
  });
});
