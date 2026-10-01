import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { requestConversationTitle } from "../src/conversation-title.ts";

type Complete = ModelRuntime["completeSimple"];
const model = { provider: "selected-provider", id: "selected-model", baseUrl: "https://example.com/v1" } as Model<Api>;
const response = (text: string) => ({ content: [{ type: "text", text }], stopReason: "stop" }) as Awaited<ReturnType<Complete>>;

function capture(...titles: string[]) {
  const calls: Parameters<Complete>[] = [];
  const runtime = {
    completeSimple: async (...args: Parameters<Complete>) => {
      calls.push(args);
      return response(titles[calls.length - 1] ?? "生成的标题");
    },
  };
  return { calls, runtime };
}

describe("conversation title requests", () => {
  it("only sends the first message, clamps it, and asks for a bare title with the chat session id", async () => {
    const { calls, runtime } = capture("  第一个标题  ");
    const text = `${"a".repeat(4200)}\n第二行`;
    assert.equal(await requestConversationTitle(runtime, model, { conversationId: "chat-a", text }), "第一个标题");
    assert.equal(calls[0]![0], model);
    assert.equal(calls[0]![1].messages.length, 1);
    assert.equal((calls[0]![1].messages[0] as { content: string }).content.length, 4000);
    assert.match(calls[0]![1].systemPrompt!, /只返回标题/);
    assert.equal(calls[0]![2]?.maxTokens, 48);
    assert.equal(calls[0]![2]?.sessionId, "chat-a");
    assert.equal(calls[0]![2]?.headers, undefined);
  });

  it("cleans up prefixes and wrapping, and reports an empty answer as null", async () => {
    const { runtime } = capture("标题：修复标题生成", '"修复标题生成"', "   ");
    assert.equal(await requestConversationTitle(runtime, model, { conversationId: "chat-a", text: "x" }), "修复标题生成");
    assert.equal(await requestConversationTitle(runtime, model, { conversationId: "chat-a", text: "x" }), "修复标题生成");
    assert.equal(await requestConversationTitle(runtime, model, { conversationId: "chat-a", text: "x" }), null);
  });

  it("adds x-opencode-session for the built-in provider and OpenCode-hosted custom endpoints only", async () => {
    const { calls, runtime } = capture("t1", "t2", "t3", "t4");
    await requestConversationTitle(runtime, { ...model, provider: "opencode-go", baseUrl: "https://opencode.ai/zen/go" }, { conversationId: "chat-b", text: "hi" });
    assert.deepEqual(calls[0]![2]?.headers, { "x-opencode-session": "chat-b" });
    await requestConversationTitle(runtime, { ...model, provider: "custom", baseUrl: "https://opencode.ai/zen/go/v1" }, { conversationId: "chat-c", text: "hi" });
    assert.deepEqual(calls[1]![2]?.headers, { "x-opencode-session": "chat-c" });
    for (const baseUrl of ["https://example.com/v1", "https://opencode.ai.example.com/v1"]) {
      await requestConversationTitle(runtime, { ...model, provider: "custom", baseUrl }, { conversationId: "chat-d", text: "hi" });
    }
    assert.equal(calls[2]![2]?.headers, undefined);
    assert.equal(calls[3]![2]?.headers, undefined);
  });
});
