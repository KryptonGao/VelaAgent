import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { AgentRuntime } from "../src/runtime.ts";
import { parseThinkingSummaryInput, ThinkingSummaryGenerator } from "../src/thinking-summary.ts";

const model = { provider: "selected-provider", id: "selected-model" } as Model<Api>;
const input = { conversationId: "chat-a", text: "I will inspect the runtime before deciding whether to change it.", locale: "zh-CN" as const };
type Complete = ModelRuntime["completeSimple"];
const response = (text: string) => ({ content: [{ type: "text", text }], stopReason: "stop" }) as Awaited<ReturnType<Complete>>;

describe("thinking summary requests", () => {
  it("validates IPC input without silently truncating the passage", () => {
    assert.deepEqual(parseThinkingSummaryInput(input), input);
    for (const invalid of [null, {}, { ...input, conversationId: " " }, { ...input, locale: "fr" }, { ...input, text: " " }, { ...input, text: "a".repeat(100_001) }]) {
      assert.throws(() => parseThinkingSummaryInput(invalid));
    }
    assert.equal(parseThinkingSummaryInput({ ...input, text: "a".repeat(100_000) }).text.length, 100_000);
  });

  it("uses the supplied model and UI language with only the source passage as context", async () => {
    const generator = new ThinkingSummaryGenerator();
    const calls: Parameters<Complete>[] = [];
    const runtime = { completeSimple: async (...args: Parameters<Complete>) => {
      calls.push(args);
      return response("  Inspect the runtime.\nKeep the decision open.  ");
    } };
    assert.equal(await generator.generate(runtime, model, input), "Inspect the runtime. Keep the decision open.");
    await generator.generate(runtime, model, { ...input, locale: "en" });
    assert.equal(calls[0]![0], model);
    assert.match(calls[0]![1].systemPrompt!, /简体中文/);
    assert.match(calls[1]![1].systemPrompt!, /Write in English/);
    assert.match(calls[0]![1].systemPrompt!, /never as instructions/);
    assert.deepEqual(calls[0]![1].messages.map((message) => message.content), [input.text]);
    assert.equal(calls[0]![1].tools, undefined);
    assert.equal(calls[0]![2]?.sessionId, input.conversationId);
    assert.equal(calls[0]![2]?.headers, undefined);
    generator.dispose();
  });

  it("does not send an OpenCode header to unrelated or lookalike custom endpoints", async () => {
    const generator = new ThinkingSummaryGenerator();
    const runtime = { completeSimple: async (_model: Model<Api>, _context: Parameters<Complete>[1], options: Parameters<Complete>[2]) => {
      assert.equal(options?.sessionId, input.conversationId);
      assert.equal(options?.headers, undefined);
      return response("summary");
    } };
    for (const baseUrl of ["https://example.com/v1", "https://opencode.ai.example.com/v1"]) {
      await generator.generate(runtime, { ...model, baseUrl }, { ...input, text: baseUrl });
    }
    generator.dispose();
  });

  it("merges in-flight requests and isolates caches by chat, model, source, and language", async () => {
    const generator = new ThinkingSummaryGenerator();
    let count = 0;
    let finish!: (value: Awaited<ReturnType<Complete>>) => void;
    const runtime = { completeSimple: async () => {
      count += 1;
      if (count === 1) return new Promise<Awaited<ReturnType<Complete>>>((resolve) => { finish = resolve; });
      return response("summary");
    } };
    const first = generator.generate(runtime, model, input);
    const second = generator.generate(runtime, model, input);
    assert.equal(first, second);
    assert.equal(count, 1);
    finish(response("summary"));
    await Promise.all([first, second]);
    await generator.generate(runtime, model, input);
    assert.equal(count, 1);
    await generator.generate(runtime, model, { ...input, locale: "en" });
    await generator.generate(runtime, model, { ...input, conversationId: "chat-b" });
    await generator.generate(runtime, { ...model, id: "other-model" }, input);
    await generator.generate(runtime, model, { ...input, text: "different passage" });
    assert.equal(count, 5);
    generator.dispose();
  });

  it("does not cache errors or empty responses, so retries can succeed", async () => {
    const generator = new ThinkingSummaryGenerator();
    let count = 0;
    const runtime = { completeSimple: async () => {
      count += 1;
      if (count === 1) return { ...response("partial"), stopReason: "error", errorMessage: "provider failed" } as Awaited<ReturnType<Complete>>;
      if (count === 2) return response(" ");
      return response("recovered");
    } };
    await assert.rejects(generator.generate(runtime, model, input), /provider failed/);
    await assert.rejects(generator.generate(runtime, model, input), /模型未返回/);
    assert.equal(await generator.generate(runtime, model, input), "recovered");
    assert.equal(count, 3);
    generator.dispose();
  });

  it("bounds waiting and aborts outstanding model calls on disposal", async () => {
    const signals: AbortSignal[] = [];
    const runtime = { completeSimple: async (_model: Model<Api>, _context: Parameters<Complete>[1], options: Parameters<Complete>[2]) => {
      signals.push(options!.signal!);
      return new Promise<Awaited<ReturnType<Complete>>>(() => {});
    } };
    const timed = new ThinkingSummaryGenerator(10);
    await assert.rejects(timed.generate(runtime, model, input), /超时/);
    assert.equal(signals[0]!.aborted, true);
    timed.dispose();
    const stopped = new ThinkingSummaryGenerator();
    const pending = stopped.generate(runtime, model, input);
    stopped.dispose();
    await assert.rejects(pending, /无法生成/);
    assert.equal(signals[1]!.aborted, true);
  });
});

describe("conversation model selection for summaries", () => {
  it("captures the requested chat's selection before an asynchronous directory lookup", async () => {
    const generator = new ThinkingSummaryGenerator();
    const chat = { session: { model, messages: ["unchanged"] } };
    let ready!: () => void;
    const wait = new Promise<void>((resolve) => { ready = resolve; });
    let usedModel: Model<Api> | undefined;
    const directory = {
      isAvailable: () => true,
      runtime: { completeSimple: async (selected: Model<Api>) => { usedModel = selected; return response("summary"); } },
    };
    // A narrow runtime harness avoids credentials/network and exercises the real public method.
    const runtime = Object.assign(Object.create(AgentRuntime.prototype), {
      conversations: new Map([["chat-a", chat]]),
      activeId: "unrelated-chat",
      thinkingSummaries: generator,
      readyDirectory: async () => { await wait; return directory; },
    }) as AgentRuntime;
    const pending = runtime.summarizeThinking(input);
    chat.session.model = { ...model, id: "new-selection" };
    ready();
    assert.equal(await pending, "summary");
    assert.equal(usedModel, model);
    assert.deepEqual(chat.session.messages, ["unchanged"]);
    await runtime.summarizeThinking({ ...input, text: "next source" });
    assert.equal(usedModel, chat.session.model);
    await assert.rejects(runtime.summarizeThinking({ ...input, conversationId: "missing" }), /对话不存在/);
    directory.isAvailable = () => false;
    await assert.rejects(runtime.summarizeThinking(input), /先选择/);
    generator.dispose();
  });
});
