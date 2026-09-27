import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { countConversationActivity, userMessageText } from "../src/context-usage.ts";

const hiddenPrefix = "__hidden__";

function user(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: 0 } as unknown as AgentMessage;
}

function assistant(): AgentMessage {
  return { role: "assistant", content: [], timestamp: 0 } as unknown as AgentMessage;
}

const isHidden = (text: string) => text.startsWith(hiddenPrefix);

describe("conversation activity", () => {
  it("counts each visible user message as a round and each assistant message as a step", () => {
    const counted = countConversationActivity(
      [user("第一条"), assistant(), assistant(), user("第二条"), assistant()],
      isHidden,
    );
    assert.deepEqual(counted, { turnCount: 2, stepCount: 3 });
  });

  it("ignores system-issued prompts the user never typed", () => {
    const counted = countConversationActivity(
      [user("开始"), assistant(), user(`${hiddenPrefix}继续执行当前目标`), assistant()],
      isHidden,
    );
    assert.equal(counted.turnCount, 1);
    assert.equal(counted.stepCount, 2);
  });

  it("counts a compacted conversation from what is still in context", () => {
    assert.deepEqual(countConversationActivity([user("只剩这一轮"), assistant()], isHidden), {
      turnCount: 1,
      stepCount: 1,
    });
  });

  it("reads image parts without inventing extra text", () => {
    const message = {
      role: "user",
      content: [
        { type: "text", text: "看看这张图" },
        { type: "image", data: "AA==", mimeType: "image/png" },
      ],
      timestamp: 0,
    } as unknown as AgentMessage;
    assert.equal(userMessageText(message), "看看这张图");
  });
});
