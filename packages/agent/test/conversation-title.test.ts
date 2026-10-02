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
    assert.equal(calls[0]![2]?.maxTokens, 2048);
    assert.equal(calls[0]![2]?.sessionId, "chat-a");
    assert.equal(calls[0]![2]?.headers, undefined);
    // 标题请求不用显式关闭推理：Anthropic 适配器会把 truthy 的 "off" 当作用户要思考，
    // 必思考模型也会忽略这个开关，真正兜底的是上面的预算。
    assert.equal(calls[0]![2]?.reasoning, undefined);
  });

  it("keeps room for mandatory reasoning so OpenCode Go models still return a title", async () => {
    const calls: Parameters<Complete>[] = [];
    const runtime = { completeSimple: async (...args: Parameters<Complete>) => {
      calls.push(args);
      // OpenCode Go 上 deepseek-v4.1-flash 等模型的 off 是 null，推理无法关闭：
      // 预算不足时全部 token 被思考内容占满，stopReason=length 且没有正文。
      if ((args[2]?.maxTokens ?? 0) <= 48) {
        return { content: [{ type: "thinking", thinking: "先想一个合适的标题……" }], stopReason: "length" } as Awaited<ReturnType<Complete>>;
      }
      return response("修复登录页");
    } };
    assert.equal(
      await requestConversationTitle(runtime, { ...model, provider: "opencode-go", baseUrl: "https://opencode.ai/zen/go/v1" }, { conversationId: "chat-a", text: "帮我修一下登录页" }),
      "修复登录页",
    );
    assert.ok((calls[0]![2]?.maxTokens ?? 0) > 48);
  });

  it("retries with a larger budget when mandatory reasoning still fills the first one", async () => {
    const calls: Parameters<Complete>[] = [];
    const runtime = { completeSimple: async (...args: Parameters<Complete>) => {
      calls.push(args);
      if (calls.length === 1) {
        return { content: [{ type: "thinking", thinking: "先想标题，再继续想……" }], stopReason: "length" } as Awaited<ReturnType<Complete>>;
      }
      return response("修复登录页");
    } };
    assert.equal(await requestConversationTitle(runtime, model, { conversationId: "chat-a", text: "帮我修一下登录页" }), "修复登录页");
    assert.equal(calls.length, 2);
    assert.ok((calls[1]![2]?.maxTokens ?? 0) > (calls[0]![2]?.maxTokens ?? 0));
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
