import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentRuntimeStreamEvent } from "@vela/shared";
import {
  applyAgentStreamEvent,
  type AgentMessageBuckets,
} from "../src/renderer/hooks/useSession.ts";

/** 依次把事件喂进 reducer，返回该 agent 的消息列表。 */
function reduce(events: AgentRuntimeStreamEvent[], agentId = "a1"): AgentMessageBuckets[string][string] {
  let buckets: AgentMessageBuckets = {};
  for (const event of events) {
    buckets = applyAgentStreamEvent(buckets, "conv-1", agentId, event);
  }
  return buckets["conv-1"]?.[agentId] ?? [];
}

describe("子代理运行流 reducer", () => {
  it("用户消息和 assistant 文本按顺序累积", () => {
    const messages = reduce([
      { type: "user_message", text: "查一下启动流程" },
      { type: "assistant_start" },
      { type: "text_delta", delta: "我先" },
      { type: "text_delta", delta: "读代码" },
    ]);
    assert.equal(messages.length, 2);
    assert.equal(messages[0]?.role, "user");
    assert.equal(messages[0]?.text, "查一下启动流程");
    assert.equal(messages[1]?.role, "assistant");
    assert.equal(messages[1]?.text, "我先读代码");
  });

  it("thinking 和工具调用挂在最后一条 assistant 上", () => {
    const messages = reduce([
      { type: "assistant_start" },
      { type: "thinking_delta", delta: "先看运行时" },
      {
        type: "tool_start",
        toolCallId: "t1",
        toolName: "read",
        activity: { path: "src/runtime.ts" },
      },
      {
        type: "tool_output",
        toolCallId: "t1",
        activity: { body: "export function ..." },
      },
      {
        type: "tool_end",
        toolCallId: "t1",
        toolName: "read",
        isError: false,
        activity: { path: "src/runtime.ts", body: "export function ..." },
      },
      { type: "text_delta", delta: "看完了" },
    ]);
    assert.equal(messages.length, 1);
    const message = messages[0]!;
    assert.equal(message.thinking, "先看运行时");
    assert.equal(message.text, "看完了");
    assert.equal(message.tools.length, 1);
    assert.equal(message.tools[0]?.status, "done");
    assert.equal(message.tools[0]?.activity.path, "src/runtime.ts");
    assert.equal(message.tools[0]?.activity.body, "export function ...");
  });

  it("工具失败标成 error，回合报错并进正文", () => {
    const messages = reduce([
      { type: "assistant_start" },
      { type: "tool_start", toolCallId: "t2", toolName: "bash", activity: { command: "npm test" } },
      {
        type: "tool_end",
        toolCallId: "t2",
        toolName: "bash",
        isError: true,
        activity: { command: "npm test", body: "failed" },
      },
      { type: "error", message: "模型中断了" },
    ]);
    assert.equal(messages[0]?.tools[0]?.status, "error");
    assert.match(messages[0]?.text ?? "", /模型中断了/);
  });

  it("assistant_start 会另起一块，不同 agent 互不串流", () => {
    let buckets: AgentMessageBuckets = {};
    buckets = applyAgentStreamEvent(buckets, "conv-1", "a1", { type: "assistant_start" });
    buckets = applyAgentStreamEvent(buckets, "conv-1", "a1", { type: "text_delta", delta: "第一步" });
    buckets = applyAgentStreamEvent(buckets, "conv-1", "a1", { type: "assistant_start" });
    buckets = applyAgentStreamEvent(buckets, "conv-1", "a1", { type: "text_delta", delta: "第二步" });
    buckets = applyAgentStreamEvent(buckets, "conv-1", "a2", { type: "assistant_start" });
    buckets = applyAgentStreamEvent(buckets, "conv-1", "a2", { type: "text_delta", delta: "另一个" });

    assert.deepEqual(
      buckets["conv-1"]?.["a1"]?.map((message) => message.text),
      ["第一步", "第二步"],
    );
    assert.deepEqual(
      buckets["conv-1"]?.["a2"]?.map((message) => message.text),
      ["另一个"],
    );
  });
});
