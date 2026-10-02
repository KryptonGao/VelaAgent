import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { AgentRuntime } from "../src/runtime.ts";
import { ModelDirectory } from "../src/model-directory.ts";
import { parseThinkingSummaryInput, ThinkingSummaryGenerator, type ThinkingSummaryRequest } from "../src/thinking-summary.ts";

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

  it("preserves an explicit model through IPC and rejects malformed selections", () => {
    const selection = { provider: "custom-provider", id: "org/summary-model" };
    assert.deepEqual(parseThinkingSummaryInput({ ...input, model: selection }), { ...input, model: selection });
    for (const invalid of [null, [], "custom/model", {}, { provider: "custom", id: " " },
      { provider: 1, id: "summary" }, { provider: " ", id: "summary" },
      { provider: "a".repeat(201), id: "summary" }, { provider: "custom", id: "a".repeat(501) }]) {
      assert.throws(() => parseThinkingSummaryInput({ ...input, model: invalid }), /思考总结模型不正确/);
    }
    assert.deepEqual(parseThinkingSummaryInput({ ...input, model: { ...selection, apiKey: "ignored" } }), { ...input, model: selection });
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
    // 第一人称指代思考的作者(助手),不能被转述成用户。
    assert.match(calls[0]![1].systemPrompt!, /first-person reference/);
    assert.match(calls[0]![1].systemPrompt!, /never the user/);
    assert.match(calls[0]![1].systemPrompt!, /不要写成“用户”/);
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
  it("routes explicit models independently without changing chat or default selections", async () => {
    const generator = new ThinkingSummaryGenerator();
    const customModel = { ...model, provider: "custom-provider", id: "org/summary-model" };
    const chat = { session: { model: model as Model<Api> | undefined, messages: ["unchanged"] } };
    const calls: Model<Api>[] = [];
    let available = true;
    const directory = Object.assign(Object.create(ModelDirectory.prototype), {
      selection: { provider: model.provider, modelId: model.id },
      isAvailable: (selected: Model<Api>) => selected === customModel && available,
      runtime: {
        getModel: (provider: string, id: string) => provider === customModel.provider && id === customModel.id ? customModel : undefined,
        completeSimple: async (selected: Model<Api>) => { calls.push(selected); return response("custom summary"); },
      },
    });
    const runtime = Object.assign(Object.create(AgentRuntime.prototype), {
      conversations: new Map([[input.conversationId, chat]]),
      activeId: "unrelated-chat",
      thinkingSummaries: generator,
      readyDirectory: async () => directory,
    }) as AgentRuntime;
    const request = { ...input, model: { provider: customModel.provider, id: customModel.id } };
    assert.equal(await runtime.summarizeThinking(request), "custom summary");
    assert.deepEqual(calls, [customModel]);
    assert.equal(chat.session.model, model);
    assert.deepEqual(chat.session.messages, ["unchanged"]);
    assert.deepEqual(directory.selection, { provider: model.provider, modelId: model.id });
    // Historical reasoning can use a summary model even without an available chat model.
    chat.session.model = undefined;
    assert.equal(await runtime.summarizeThinking({ ...request, text: "next passage" }), "custom summary");
    await assert.rejects(runtime.summarizeThinking({ ...request, model: { provider: customModel.provider, id: "missing" } }), /找不到这个模型/);
    available = false;
    await assert.rejects(runtime.summarizeThinking(request), /请先登录或填写密钥/);
    assert.equal(calls.length, 2);
    generator.dispose();
  });

  it("captures an explicit selection before asynchronous directory loading", async () => {
    const generator = new ThinkingSummaryGenerator();
    let ready!: () => void;
    const wait = new Promise<void>(resolve => { ready = resolve; });
    const selected = { provider: "custom-provider", id: "org/summary-model" };
    const requestedModel = { ...model, ...selected };
    let usedModel: Model<Api> | undefined;
    const runtime = Object.assign(Object.create(AgentRuntime.prototype), {
      conversations: new Map([[input.conversationId, { session: { model } }]]),
      thinkingSummaries: generator,
      readyDirectory: async () => {
        await wait;
        return {
          requireAvailable: (provider: string, id: string) => {
            assert.deepEqual({ provider, id }, { provider: "custom-provider", id: "org/summary-model" });
            return requestedModel;
          },
          isAvailable: () => true,
          runtime: { completeSimple: async (selected: Model<Api>) => { usedModel = selected; return response("summary"); } },
        };
      },
    }) as AgentRuntime;
    const pending = runtime.summarizeThinking({ ...input, model: selected });
    selected.id = "new-selection";
    ready();
    assert.equal(await pending, "summary");
    assert.equal(usedModel, requestedModel);
    generator.dispose();
  });

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

describe("thinking summary usage reporting", () => {
  const usage = { input: 12, output: 4, cacheRead: 30, cacheWrite: 0, totalTokens: 46 };
  const metered = () => ({ ...response("summary"), usage }) as Awaited<ReturnType<Complete>>;

  it("reports each dispatched request once with its provider usage", async () => {
    const generator = new ThinkingSummaryGenerator();
    const reports: ThinkingSummaryRequest[] = [];
    const runtime = { completeSimple: async () => metered() };
    assert.equal(await generator.generate(runtime, model, input, (request) => reports.push(request)), "summary");
    // Cached and merged requests do not dispatch again, so they report nothing.
    assert.equal(await generator.generate(runtime, model, input, (request) => reports.push(request)), "summary");
    assert.equal(reports.length, 1);
    assert.equal(reports[0]?.model, "selected-provider/selected-model");
    assert.equal(reports[0]?.status, "Completed");
    assert.deepEqual(reports[0]?.usage, usage);
    assert.ok((reports[0]?.durationMs ?? -1) >= 0);
    assert.ok((reports[0]?.completedAt ?? 0) >= (reports[0]?.startedAt ?? 0));
    generator.dispose();
  });

  it("reports failed requests without inventing usage", async () => {
    const generator = new ThinkingSummaryGenerator();
    const reports: ThinkingSummaryRequest[] = [];
    const runtime = { completeSimple: async () => ({ ...response("partial"), stopReason: "error", errorMessage: "provider failed" }) as Awaited<ReturnType<Complete>> };
    await assert.rejects(generator.generate(runtime, model, input, (request) => reports.push(request)), /provider failed/);
    assert.equal(reports.length, 1);
    assert.equal(reports[0]?.status, "Failed");
    assert.equal(reports[0]?.usage, null);
    generator.dispose();
  });

  it("records dispatched summary usage into the conversation trace", async () => {
    const generator = new ThinkingSummaryGenerator();
    const recorded: ThinkingSummaryRequest[] = [];
    const runtime = Object.assign(Object.create(AgentRuntime.prototype), {
      conversations: new Map([[input.conversationId, { session: { model } }]]),
      thinkingSummaries: generator,
      readyDirectory: async () => ({ isAvailable: () => true, runtime: { completeSimple: async () => metered() } }),
      traces: new Map(),
      trace: () => ({ recordSummary: (request: ThinkingSummaryRequest) => recorded.push(request) }),
    }) as AgentRuntime;
    assert.equal(await runtime.summarizeThinking(input), "summary");
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]?.model, "selected-provider/selected-model");
    assert.deepEqual(recorded[0]?.usage, usage);
    generator.dispose();
  });
});
