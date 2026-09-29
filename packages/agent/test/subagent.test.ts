import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { modeSystemPrompt, toolNamesFor } from "../src/interaction.ts";
import { exploreCommandAllowed, formatAgentReport } from "../src/subagent.ts";
import { activityFromCall, activityFromExecution } from "../src/tool-activity.ts";

const agentTools = ["spawn_agent", "send_message", "followup_task"];

describe("agent 树工具开关", () => {
  it("Agent 和 Goal 可以派子代理，Plan 不可以", () => {
    for (const mode of ["agent", "goal"] as const) {
      for (const name of agentTools) {
        assert.equal(toolNamesFor(mode, false).includes(name), true, `${mode} 应该有 ${name}`);
      }
    }
    for (const name of agentTools) {
      assert.equal(toolNamesFor("plan", false).includes(name), false);
      assert.equal(toolNamesFor("plan", true).includes(name), false);
    }
  });

  it("只有能派子代理的模式才会提示什么时候用", () => {
    assert.match(modeSystemPrompt("agent", false), /spawn_agent/);
    assert.match(modeSystemPrompt("agent", true), /spawn_agent/);
    assert.match(modeSystemPrompt("goal", false), /spawn_agent/);
    assert.doesNotMatch(modeSystemPrompt("plan", false), /spawn_agent/);
  });
});

describe("agent 工具活动", () => {
  it("spawn_agent 开始时用任务摘要做标题", () => {
    const activity = activityFromCall("spawn_agent", { agent: "explore", task: "  查会话启动\n相关文件  " });
    assert.equal(activity.agent, "explore");
    assert.equal(activity.body, "查会话启动 相关文件");
    assert.equal(activity.agentId, undefined);
  });

  it("spawn_agent 结束后带上 agent id、路径和结论", () => {
    const activity = activityFromExecution(
      "spawn_agent",
      { agent: "general", task: "改标题" },
      {
        content: [{ type: "text", text: "已启动子代理 /root/title（general，fork=none）。" }],
        details: { agentId: "agent-1", path: "/root/title", kind: "general", status: "idle" },
      },
      false,
    );
    assert.equal(activity.agent, "general");
    assert.equal(activity.agentId, "agent-1");
    assert.equal(activity.agentPath, "/root/title");
    assert.match(activity.body ?? "", /改标题/);
    assert.match(activity.body ?? "", /已启动子代理/);
  });

  it("followup_task 结束后保留步骤和改动标记", () => {
    const activity = activityFromExecution(
      "followup_task",
      { agent_id: "/root/title", task: "再改一次" },
      {
        content: [{ type: "text", text: "[/root/title · general]\n\n改好了" }],
        details: {
          agentId: "agent-1",
          path: "/root/title",
          kind: "general",
          status: "completed",
          steps: [
            { id: "2", name: "edit", summary: "README.md", status: "done" },
            { id: "3", name: "bash", summary: "git status", status: "done" },
          ],
          mutated: true,
        },
      },
      false,
    );
    assert.equal(activity.agentPath, "/root/title");
    assert.equal(activity.mutated, true);
    assert.deepEqual(activity.steps, [
      { id: "2", name: "edit", summary: "README.md", status: "done" },
      { id: "3", name: "bash", summary: "git status", status: "done" },
    ]);
    assert.match(activity.body ?? "", /再改一次/);
    assert.match(activity.body ?? "", /改好了/);
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
    const report = formatAgentReport({
      agent: "explore",
      path: "/root/scan",
      text: "查完了",
      failure: "",
      turnLimited: true,
      stopped: false,
    });
    assert.match(report.text, /\/root\/scan/);
    assert.match(report.text, /查完了/);
    assert.match(report.text, /回合上限/);
    assert.equal(report.truncated, true);

    const clipped = formatAgentReport({
      agent: "general",
      path: "/root/run",
      text: "x".repeat(12_001),
      failure: "",
      turnLimited: false,
      stopped: false,
    });
    assert.match(clipped.text, /结论过长，已截断/);
    assert.equal(clipped.truncated, true);
  });
});
