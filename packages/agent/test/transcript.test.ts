import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionProjection } from "@earendil-works/pi-coding-agent";
import { planFreshPrompt } from "../src/plan.ts";
import {
  branchLeafForTurn,
  countTranscriptActivity,
  transcriptFromMessages,
  transcriptFromProjection,
  transcriptSourcesFromProjection,
} from "../src/transcript.ts";

function user(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: 0 } as unknown as AgentMessage;
}

function assistant(text: string, toolCallId?: string): AgentMessage {
  const content: unknown[] = text ? [{ type: "text", text }] : [];
  if (toolCallId) content.push({ type: "toolCall", id: toolCallId, name: "bash", arguments: {} });
  return { role: "assistant", content, timestamp: 0 } as unknown as AgentMessage;
}

function toolResult(toolCallId: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "bash",
    content: [{ type: "text", text: "ok" }],
    isError: false,
    timestamp: 0,
  } as unknown as AgentMessage;
}

function entry(id: string, message: AgentMessage, timestamp = "2025-03-01T08:00:00.000Z") {
  return {
    sourceEntry: { type: "message", id, parentId: null, timestamp, message },
    messages: [message],
  };
}

function projection(entries: ReturnType<typeof entry>[]): SessionProjection {
  return {
    entries,
    messages: entries.flatMap((item) => item.messages),
    thinkingLevel: "medium",
    model: null,
  } as unknown as SessionProjection;
}

function sourcesOf(entries: ReturnType<typeof entry>[]) {
  return transcriptSourcesFromProjection(projection(entries));
}

const planPrompt = planFreshPrompt("原始目标", {
  id: "p1",
  markdown: "# Plan\n\n## Goal\n\n做一件事",
  revision: 1,
  supersedes: null,
  status: "approved",
  objective: "原始目标",
  createdAt: 0,
  approvedAt: 1,
});

describe("transcript timestamps", () => {
  it("keeps the writing time of each message's source entry", () => {
    const messages = transcriptFromProjection(projection([
      entry("u1", user("你好"), "2025-03-01T08:00:00.000Z"),
      entry("a1", assistant("在"), "2025-03-01T08:00:05.000Z"),
    ]));
    assert.equal(messages.length, 2);
    assert.equal(messages[0]?.timestamp, Date.parse("2025-03-01T08:00:00.000Z"));
    assert.equal(messages[1]?.timestamp, Date.parse("2025-03-01T08:00:05.000Z"));
  });

  it("leaves timestamps empty for sessions without persisted entries", () => {
    const messages = transcriptFromMessages([user("你好"), assistant("在")]);
    assert.deepEqual(messages.map((message) => message.timestamp), [null, null]);
  });

  it("skips empty assistant blocks and system-issued plan prompts", () => {
    const entries = [
      entry("u1", user("开始")),
      entry("hidden", user(planPrompt)),
      entry("empty", assistant("")),
      entry("a1", assistant("完成")),
    ];
    assert.deepEqual(sourcesOf(entries).map((source) => source.entryId), ["u1", "hidden", "empty", "a1"]);
    assert.deepEqual(transcriptFromProjection(projection(entries)).map((message) => message.text), ["开始", "完成"]);
  });

  it("strips proposed plan blocks from assistant text", () => {
    const messages = transcriptFromProjection(projection([
      entry("a1", assistant("说明段落\n\n<proposed_plan>\n# Plan\n\n## Goal\n\nX\n</proposed_plan>\n\n收尾")),
    ]));
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.text.includes("<proposed_plan>"), false);
    assert.match(messages[0]?.text ?? "", /说明段落/);
    assert.match(messages[0]?.text ?? "", /收尾/);
  });

  it("maps stripped plan blocks back to revision ids for chat previews", () => {
    const plans = [
      { id: "p1", markdown: "# 方案\n\nv1", revision: 1, supersedes: null, status: "superseded" as const, objective: null, createdAt: 1, approvedAt: null },
      { id: "p2", markdown: "# 方案\n\nv2", revision: 2, supersedes: "p1", status: "approved" as const, objective: null, createdAt: 2, approvedAt: 3 },
    ];
    const messages = transcriptFromProjection(
      projection([
        entry("a1", assistant("说明\n\n<proposed_plan>\n# 方案\n\nv1\n</proposed_plan>")),
        entry("a2", assistant("<proposed_plan>\n# 方案\n\nv2\n</proposed_plan>\n\n收尾")),
      ]),
      plans,
    );
    assert.deepEqual(messages.map((message) => message.planIds), [["p1"], ["p2"]]);
    assert.equal(messages[0]?.text, "说明");
    assert.equal(messages[1]?.text, "收尾");
  });

  it("keeps plan-only assistant messages so the preview survives", () => {
    const messages = transcriptFromProjection(
      projection([entry("a1", assistant("<proposed_plan>\n# 方案\n\n只有方案\n</proposed_plan>"))]),
      [{ id: "p1", markdown: "# 方案\n\n只有方案", revision: 1, supersedes: null, status: "draft", objective: null, createdAt: 1, approvedAt: null }],
    );
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.text, "");
    assert.deepEqual(messages[0]?.planIds, ["p1"]);
  });
});

describe("countTranscriptActivity", () => {
  it("counts user messages and tool calls for a branched history", () => {
    const sources = sourcesOf([
      entry("u1", user("执行")),
      entry("a1", assistant("", "call-1")),
      entry("r1", toolResult("call-1")),
      entry("a2", assistant("完成")),
    ]);
    assert.deepEqual(countTranscriptActivity(sources), { messageCount: 1, toolCallCount: 1 });
  });
});

describe("branchLeafForTurn", () => {
  it("points at the last visible reply of the requested turn", () => {
    const sources = sourcesOf([
      entry("u1", user("第一轮")),
      entry("a1", assistant("回答一")),
      entry("u2", user("第二轮")),
      entry("a2", assistant("回答二")),
    ]);
    assert.equal(branchLeafForTurn(sources, 0), "a1");
    assert.equal(branchLeafForTurn(sources, 1), "a2");
  });

  it("counts only visible messages as turns", () => {
    const sources = sourcesOf([
      entry("u1", user("开始")),
      entry("hidden", user(planPrompt)),
      entry("empty", assistant("")),
      entry("a1", assistant("完成")),
    ]);
    assert.equal(branchLeafForTurn(sources, 0), "a1");
  });

  it("keeps the last reply when the turn ends with an empty block", () => {
    const sources = sourcesOf([
      entry("u1", user("开始")),
      entry("a1", assistant("回答")),
      entry("empty", assistant("")),
    ]);
    assert.equal(branchLeafForTurn(sources, 0), "a1");
  });

  it("extends the branch point through following tool results", () => {
    const sources = sourcesOf([
      entry("u1", user("执行")),
      entry("a1", assistant("", "call-1")),
      entry("r1", toolResult("call-1")),
    ]);
    assert.equal(branchLeafForTurn(sources, 0), "r1");
  });

  it("returns null for missing turns and messages without an entry", () => {
    const sources = sourcesOf([entry("u1", user("只有一条"))]);
    assert.equal(branchLeafForTurn(sources, 5), null);
    assert.equal(
      branchLeafForTurn(
        [
          { message: user("临时"), entryId: null, timestamp: null },
          { message: assistant("回答"), entryId: null, timestamp: null },
        ],
        0,
      ),
      null,
    );
  });
});
