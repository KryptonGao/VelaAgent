import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { requestConversationTitle } from "../src/conversation-title.ts";

const title = "修复标题生成";

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
    const base = { id: "title-response", object: "chat.completion.chunk", created: 1, model: "title-test" };
    response.end([
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: title }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
      "data: [DONE]\n\n",
    ].join(""));
  });
  const dir = await mkdtemp(join(tmpdir(), "vela-title-http-"));
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
      id: "title-test", name: "Local title test", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 4096,
    }],
  });
  const model = runtime.getModel(provider, "title-test");
  assert.ok(model);
  return { runtime, model, requests };
}

describe("conversation title HTTP session routing", () => {
  it("reproduces MissingSessionID and sends the conversation header through the real OpenCode SDK path", async (t) => {
    const { runtime, model, requests } = await endpoint(t, "opencode-go");
    const missing = await runtime.completeSimple(model, { messages: [{ role: "user", content: "帮我修复标题生成", timestamp: 1 }] }, { maxTokens: 32 });
    assert.equal(missing.stopReason, "error");
    assert.match(missing.errorMessage ?? "", /MissingSessionID/);
    assert.equal(await requestConversationTitle(runtime, model, { conversationId: "chat-a", text: "帮我修复标题生成" }), title);
    assert.deepEqual(requests.map((request) => request["x-opencode-session"]), [undefined, "chat-a"]);
  });

  it("also sends the header for a custom provider pointing at the OpenCode endpoint", async (t) => {
    const { runtime, model, requests } = await endpoint(t, "custom-openai-compatible");
    // Route the real HTTP dispatch locally, preserving the model metadata seen by the title request.
    const declaredModel = { ...model, baseUrl: "https://opencode.ai/zen/go/v1" };
    const localDispatch: Pick<ModelRuntime, "completeSimple"> = {
      completeSimple: (selected, context, options) => {
        assert.equal(selected, declaredModel);
        return runtime.completeSimple(model, context, options);
      },
    };
    assert.equal(await requestConversationTitle(localDispatch, declaredModel, { conversationId: "chat-a", text: "帮我修复标题生成" }), title);
    assert.equal(requests[0]!["x-opencode-session"], "chat-a");
  });
});
