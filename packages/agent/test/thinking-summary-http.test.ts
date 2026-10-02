import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ThinkingSummaryGenerator } from "../src/thinking-summary.ts";
import { AgentRuntime } from "../src/runtime.ts";
import { ModelDirectory } from "../src/model-directory.ts";

const summary = "先检查运行时，再决定是否修改界面。";
const input = { conversationId: "chat-a", text: "Inspect the runtime before deciding whether to change the UI.", locale: "zh-CN" as const };

/** Run the installed SDK against a local endpoint that enforces the reported OpenCode contract. */
async function endpoint(t: TestContext, provider: string) {
  const requests: IncomingHttpHeaders[] = [];
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Consume the request before responding. */ }
    requests.push(request.headers);
    if (!request.headers["x-opencode-session"]) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { type: "MissingSessionID", message: "MissingSessionID: Request is missing x-opencode-session" } }));
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const base = { id: "summary-response", object: "chat.completion.chunk", created: 1, model: "summary-test" };
    response.end([
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: summary }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
      "data: [DONE]\n\n",
    ].join(""));
  });
  const dir = await mkdtemp(join(tmpdir(), "vela-summary-http-"));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerProvider(provider, {
    baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "local-test-key",
    models: [{
      id: "summary-test", name: "Local summary test", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 4096,
    }],
  });
  const model = runtime.getModel(provider, "summary-test");
  assert.ok(model);
  const generator = new ThinkingSummaryGenerator();
  t.after(() => generator.dispose());
  return { runtime, model, generator, requests };
}

describe("thinking summary HTTP session routing", () => {
  it("dispatches the configured summary model through the real SDK without a chat model", async (t) => {
    const { runtime, model, generator, requests } = await endpoint(t, "opencode-go");
    const directory = Object.assign(Object.create(ModelDirectory.prototype), { runtime, isAvailable: () => true });
    const agent = Object.assign(Object.create(AgentRuntime.prototype), {
      conversations: new Map([[input.conversationId, { session: { model: undefined } }]]),
      thinkingSummaries: generator,
      readyDirectory: async () => directory,
    }) as AgentRuntime;
    assert.equal(await agent.summarizeThinking({ ...input, model: { provider: model.provider, id: model.id } }), summary);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!["x-opencode-session"], input.conversationId);
  });

  it("reproduces MissingSessionID and sends a stable conversation header through the real OpenCode SDK path", async (t) => {
    const { runtime, model, generator, requests } = await endpoint(t, "opencode-go");
    const missing = await runtime.completeSimple(model, { messages: [{ role: "user", content: input.text, timestamp: 1 }] }, { maxTokens: 32 });
    assert.equal(missing.stopReason, "error");
    assert.match(missing.errorMessage ?? "", /MissingSessionID/);
    assert.equal(await generator.generate(runtime, model, input), summary);
    assert.equal(await generator.generate(runtime, model, { ...input, text: "Next completed reasoning passage." }), summary);
    assert.equal(await generator.generate(runtime, model, { ...input, conversationId: "chat-b" }), summary);
    assert.deepEqual(requests.map((request) => request["x-opencode-session"]), [undefined, "chat-a", "chat-a", "chat-b"]);
  });

  it("also sends the header for a custom provider pointing at the OpenCode endpoint", async (t) => {
    const { runtime, model, generator, requests } = await endpoint(t, "custom-openai-compatible");
    // Route the real HTTP dispatch locally, preserving the model metadata seen by the summary generator.
    const declaredModel = { ...model, baseUrl: "https://opencode.ai/zen/go/v1" };
    const localDispatch: Pick<ModelRuntime, "completeSimple"> = {
      completeSimple: (selected, context, options) => {
        assert.equal(selected, declaredModel);
        return runtime.completeSimple(model, context, options);
      },
    };
    assert.equal(await generator.generate(localDispatch, declaredModel, input), summary);
    assert.equal(requests[0]!["x-opencode-session"], input.conversationId);
  });
});
