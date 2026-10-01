import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdtempSync, rmSync, readFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentSessionEvent,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import type { TraceUpdate } from "@vela/shared";
import { TraceRecorder } from "../src/trace.ts";
const dirs: string[] = [];
const recorders: TraceRecorder[] = [];
afterEach(() => {
  recorders.splice(0).forEach((r) => r.dispose());
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});
const system = {
  role: "system",
  content: "You are a helpful software engineer assistant.",
  toolsAdded: [
    {
      name: "bash",
      description: "Run a shell command",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
  ],
  timestamp: 0,
};
const user = {
  role: "user",
  content: "Make an SVG animation",
  timestamp: 1000,
};
const usage = {
  input: 10,
  output: 151,
  cacheRead: 970,
  cacheWrite: 0,
  totalTokens: 1131,
};
const message = (content: unknown[], stopReason = "toolUse") => ({
  role: "assistant",
  content,
  provider: "test",
  model: "test-model",
  api: "anthropic-messages",
  usage,
  stopReason,
  timestamp: 1000,
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "vela-trace-test-"));
  dirs.push(dir);
  const file = join(dir, "trace.jsonl"),
    events: TraceUpdate[] = [];
  let ms = 1000;
  const clock = { wall: () => 1700000000000 + ms, mono: () => ms };
  const r = new TraceRecorder("conv", file, (e) => events.push(e), clock);
  recorders.push(r);
  const handle = (event: unknown) => r.handle(event as AgentSessionEvent);
  const begin = () => {
    handle({ type: "message_start", message: user });
    return r.beginRequest([system, user] as AgentMessage[], "test/test-model");
  };
  return {
    r,
    file,
    events,
    handle,
    begin,
    advance: (n: number) => {
      ms += n;
    },
  };
}
function update(
  f: ReturnType<typeof fixture>,
  type: string,
  index: number,
  content: unknown[],
  delta?: string,
) {
  f.handle({
    type: "message_update",
    assistantMessageEvent: {
      type,
      contentIndex: index,
      partial: message(content),
      delta,
      toolCall: content[index],
    },
  });
}
describe("trace capture", () => {
  it("publishes thinking and first-token metrics before the request finishes", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const f = fixture();
    f.begin();
    f.advance(1280);
    update(
      f,
      "thinking_delta",
      0,
      [{ type: "thinking", thinking: "Inspecting the workspace" }],
      "Inspecting the workspace",
    );
    t.mock.timers.tick(100);
    assert.ok(
      f.events.some((event) =>
        event.nodes.some(
          (node) => node.kind === "thinking" && node.status === "Running",
        ),
      ),
    );
    assert.equal(f.events.at(-1)?.requests[0]?.firstTokenMs, 1280);
    assert.equal(f.r.snapshot().requests[0]?.status, "Running");
  });

  it("keeps block order, raw parameters, exact tool schema and results", () => {
    const f = fixture();
    f.begin();
    f.advance(1280);
    const thinking = { type: "thinking", thinking: "Inspect desktop first" };
    update(f, "thinking_delta", 0, [thinking], "Inspect desktop first");
    const text = { type: "text", text: "I will check the desktop." };
    update(f, "text_delta", 1, [thinking, text], text.text);
    const call = {
      type: "toolCall",
      id: "t1",
      name: "bash",
      arguments: { command: "ls -d ~/Desktop" },
    };
    update(f, "toolcall_end", 2, [thinking, text, call]);
    f.advance(744);
    f.handle({ type: "message_end", message: message([thinking, text, call]) });
    f.handle({
      type: "tool_execution_start",
      toolCallId: "t1",
      toolName: "bash",
      args: call.arguments,
    });
    f.advance(1696);
    const result = {
      content: [{ type: "text", text: "/Users/test/Desktop" }],
      details: { exitCode: 0 },
    };
    f.handle({
      type: "tool_execution_end",
      toolCallId: "t1",
      toolName: "bash",
      result,
      isError: false,
    });
    const snapshot = f.r.snapshot();
    assert.deepEqual(
      snapshot.nodes.map((n) => n.kind),
      ["user", "system", "thinking", "assistant", "tool-call", "tool-result"],
    );
    assert.equal(snapshot.requests[0]?.firstTokenMs, 1280);
    assert.equal(snapshot.requests[0]?.generationMs, 744);
    assert.equal(snapshot.requests[0]?.durationMs, 2024);
    const node = snapshot.nodes.find((n) => n.kind === "tool-call")!;
    const details = f.r.details(node.id)!;
    assert.deepEqual(details.arguments, call.arguments);
    assert.deepEqual(details.result, result);
    assert.deepEqual(
      details.context?.tools[0]?.parameters,
      system.toolsAdded[0]?.parameters,
    );
    assert.equal(node.durationMs, 1696);
    assert.equal(details.responseBlocks.length, 3);
    assert.equal(f.r.details(snapshot.nodes.at(-1)!.id)?.node.durationMs, 1696);
    assert.ok(f.events.some((e) => e.nodes.some((n) => n.kind === "thinking")));
  });
  it("tool-only deltas count for TTFT and incomplete JSON remains raw", () => {
    const f = fixture();
    f.begin();
    f.advance(700);
    const call = { type: "toolCall", id: "t1", name: "bash", arguments: {} };
    update(f, "toolcall_start", 0, [call]);
    update(f, "toolcall_delta", 0, [call], '{"command":"ls');
    const node = f.r.snapshot().nodes.find((n) => n.kind === "tool-call")!;
    assert.equal(f.r.details(node.id)?.content, '{"command":"ls');
    assert.equal(f.r.details(node.id)?.arguments, null);
    f.advance(300);
    f.handle({
      type: "message_end",
      message: message([{ ...call, arguments: { command: "ls" } }]),
    });
    assert.equal(f.r.snapshot().requests[0]?.firstTokenMs, 700);
  });
  it("appends parallel results in completion order and keeps failures", () => {
    const f = fixture();
    f.begin();
    const calls = ["a", "b"].map((id) => ({
      type: "toolCall",
      id,
      name: "bash",
      arguments: { command: id },
    }));
    f.handle({ type: "message_end", message: message(calls) });
    for (const c of calls)
      f.handle({
        type: "tool_execution_start",
        toolCallId: c.id,
        toolName: "bash",
        args: c.arguments,
      });
    for (const id of ["b", "a"])
      f.handle({
        type: "tool_execution_end",
        toolCallId: id,
        toolName: "bash",
        result: { content: [{ type: "text", text: id }] },
        isError: id === "b",
      });
    const s = f.r.snapshot();
    assert.deepEqual(
      s.nodes.filter((n) => n.kind === "tool-result").map((n) => n.toolCallId),
      ["b", "a"],
    );
    assert.equal(s.nodes.find((n) => n.toolCallId === "b")?.status, "Failed");
  });
  it("keeps first-token timing empty on failure before generation and closes pending tools on abort", () => {
    const f = fixture();
    f.begin();
    f.advance(900);
    f.handle({
      type: "message_end",
      message: { ...message([], "error"), errorMessage: "Rate limited" },
    });
    assert.equal(f.r.snapshot().requests[0]?.firstTokenMs, null);
    assert.equal(f.r.snapshot().requests[0]?.status, "Failed");
    f.begin();
    f.handle({
      type: "tool_execution_start",
      toolCallId: "abort",
      toolName: "bash",
      args: { command: "sleep 60" },
    });
    f.r.settle("Interrupted");
    assert.ok(f.r.snapshot().nodes.every((n) => n.status !== "Running"));
    assert.equal(f.r.snapshot().requests[1]?.status, "Interrupted");
  });
  it("captures only agent turns and preserves the original stream's return identity and options", () => {
    const f = fixture();
    let calls = 0;
    const result = { test: true };
    const original = ((_m: unknown, _c: unknown, options: unknown) => {
      calls++;
      assert.deepEqual(options, { temperature: 0 });
      return result;
    }) as unknown as StreamFn;
    const wrapped = f.r.wrapStream(original);
    const args = [
      { id: "m", provider: "p" },
      { messages: [system, user] },
      { temperature: 0 },
    ] as const;
    assert.equal((wrapped as Function)(...args), result);
    assert.equal(f.r.snapshot().requests.length, 0);
    f.handle({ type: "turn_start" });
    assert.equal((wrapped as Function)(...args), result);
    assert.equal(f.r.snapshot().requests.length, 1);
    assert.equal(calls, 2);
  });
  it("does not propagate capture failures or persistence failures", () => {
    const f = fixture();
    assert.doesNotThrow(() =>
      f.r.capture(() => {
        throw new Error("bad metadata");
      }),
    );
    assert.match(f.r.snapshot().warning ?? "", /采集异常/);
    f.begin();
    const bad = new TraceRecorder(
      "bad",
      join(f.file, "blocked.jsonl"),
      () => {},
    );
    recorders.push(bad);
    assert.doesNotThrow(() =>
      bad.beginRequest([system] as AgentMessage[], "m"),
    );
    bad.flush();
    assert.match(bad.snapshot().warning ?? "", /保存失败/);
  });
});
describe("trace recovery and branching", () => {
  it("restores full long results, interrupts unfinished work and tolerates a truncated last record", () => {
    const f = fixture();
    f.begin();
    const content = "line\n".repeat(50000);
    f.handle({
      type: "tool_execution_start",
      toolCallId: "long",
      toolName: "bash",
      args: { command: "long" },
    });
    f.handle({
      type: "tool_execution_update",
      toolCallId: "long",
      toolName: "bash",
      partialResult: { content: [{ type: "text", text: content }] },
    });
    f.r.flush();
    appendFileSync(f.file, '{"type":');
    const restored = new TraceRecorder("conv", f.file, () => {});
    recorders.push(restored);
    const s = restored.snapshot();
    assert.ok(s.nodes.every((n) => n.status !== "Running"));
    assert.equal(s.requests[0]?.status, "Interrupted");
    const call = s.nodes.find((n) => n.kind === "tool-call")!;
    assert.deepEqual(restored.details(call.id)?.result, {
      content: [{ type: "text", text: content }],
    });
    assert.match(s.warning ?? "", /无法读取/);
    assert.ok(
      readFileSync(f.file, "utf8").includes(
        content.slice(0, 20).replaceAll("\n", "\\n"),
      ),
    );
  });
  it("recovers historical block order and marks unavailable timings without current schema substitution", () => {
    const f = fixture();
    const messages = [
      system,
      user,
      message([
        { type: "thinking", thinking: "Think" },
        {
          type: "toolCall",
          id: "x",
          name: "bash",
          arguments: { command: "pwd" },
        },
      ]),
      {
        role: "toolResult",
        toolCallId: "x",
        toolName: "bash",
        content: [{ type: "text", text: "/tmp" }],
        isError: false,
        timestamp: 4000,
      },
    ];
    const entries = messages.map((message, i) => ({
      type: "message",
      id: `e${i}`,
      parentId: null,
      timestamp: new Date(1700000000000 + i * 1000).toISOString(),
      message,
    }));
    f.r.restoreHistory(entries as SessionEntry[]);
    const s = f.r.snapshot();
    assert.deepEqual(
      s.nodes.map((n) => n.kind),
      ["system", "user", "thinking", "tool-call", "tool-result"],
    );
    assert.equal(s.requests[0]?.durationMs, null);
    const node = s.nodes.find((n) => n.kind === "tool-call")!;
    assert.equal(node.durationMs, null);
    assert.equal(f.r.details(node.id)?.context?.tools[0]?.name, "bash");
  });
  it("forks only the selected turn and continues with stable new IDs", () => {
    const f = fixture();
    f.begin();
    f.r.settle("Completed");
    f.begin();
    f.r.settle("Completed");
    const target = new TraceRecorder(
      "fork",
      join(dirnameFor(f.file), "fork.jsonl"),
      () => {},
    );
    recorders.push(target);
    f.r.forkTo(target, 0);
    assert.equal(target.snapshot().requests.length, 1);
    assert.ok(target.snapshot().nodes.every((n) => n.turn <= 1));
    target.handle({
      type: "message_start",
      message: user,
    } as unknown as AgentSessionEvent);
    target.beginRequest([system, user] as AgentMessage[], "m");
    assert.equal(target.snapshot().requests[1]?.number, 2);
    assert.equal(
      new Set(target.snapshot().nodes.map((n) => n.id)).size,
      target.snapshot().nodes.length,
    );
    target.flush();
    const restored = new TraceRecorder(
      "fork",
      join(dirnameFor(f.file), "fork.jsonl"),
      () => {},
    );
    recorders.push(restored);
    assert.equal(restored.snapshot().requests.length, 2);
  });
});
function dirnameFor(file: string) {
  return join(file, "..");
}

describe("SDK agent loop integration", () => {
  it("traces a real SDK loop across tool execution and the following model request", async () => {
    const { Agent } = await import("@earendil-works/pi-agent-core");
    const { createAssistantMessageEventStream } = await import(
      "@earendil-works/pi-ai"
    );
    const f = fixture();
    let invocation = 0;
    const stream = (() => {
      const events = createAssistantMessageEventStream();
      const content =
        invocation++ === 0
          ? [
              { type: "thinking", thinking: "Inspect the workspace" },
              {
                type: "toolCall",
                id: "sdk-call",
                name: "bash",
                arguments: { command: "pwd" },
              },
            ]
          : [{ type: "text", text: "Done." }];
      const final = message(
        content,
        invocation === 1 ? "toolUse" : "stop",
      ) as unknown as import("@earendil-works/pi-ai").AssistantMessage;
      events.push({ type: "start", partial: final });
      events.push({
        type: content[0]!.type === "thinking" ? "thinking_delta" : "text_delta",
        contentIndex: 0,
        delta: "content",
        partial: final,
      });
      if (invocation === 1)
        events.push({
          type: "toolcall_end",
          contentIndex: 1,
          toolCall: final
            .content[1] as import("@earendil-works/pi-ai").ToolCall,
          partial: final,
        });
      events.push({
        type: "done",
        reason: invocation === 1 ? "toolUse" : "stop",
        message: final,
      });
      return events;
    }) as StreamFn;
    const agent = new Agent({
      streamFn: f.r.wrapStream(stream),
      initialState: {
        systemPrompt: "Test system prompt",
        model: {
          provider: "test",
          id: "model",
          api: "anthropic-messages",
        } as never,
        tools: [
          {
            name: "bash",
            label: "Bash",
            description: "Test shell",
            parameters: system.toolsAdded[0]!.parameters as never,
            execute: async () => {
              f.advance(1696);
              return {
                content: [{ type: "text" as const, text: "/workspace" }],
                details: { exitCode: 0 },
              };
            },
          },
        ],
      },
    });
    agent.subscribe((event) => f.handle(event));
    await agent.prompt("Inspect the workspace");
    f.r.settle("Completed");
    const trace = f.r.snapshot();
    assert.equal(invocation, 2);
    assert.equal(trace.requests.length, 2);
    assert.deepEqual(
      trace.nodes.filter((n) => n.kind !== "system").map((n) => n.kind),
      ["user", "thinking", "tool-call", "tool-result", "assistant"],
    );
    assert.equal(
      trace.nodes.find((n) => n.kind === "tool-call")?.durationMs,
      1696,
    );
    assert.ok(trace.nodes.every((n) => n.status === "Completed"));
    const call = trace.nodes.find((n) => n.kind === "tool-call")!;
    assert.equal(
      f.r.details(call.id)?.context?.tools[0]?.description,
      "Test shell",
    );
  });
  it("records compaction and retries as states without adding user turns", async () => {
    const { goalContinuePrompt } = await import("../src/interaction.ts");
    const f = fixture();
    f.begin();
    f.r.settle("Completed");
    f.handle({
      type: "message_start",
      message: { ...user, content: goalContinuePrompt },
    });
    f.handle({ type: "compaction_start", reason: "threshold" });
    f.advance(300);
    f.handle({
      type: "compaction_end",
      reason: "threshold",
      aborted: false,
      willRetry: false,
    });
    const trace = f.r.snapshot();
    assert.equal(Math.max(...trace.nodes.map((n) => n.turn)), 1);
    assert.equal(trace.nodes.at(-1)?.kind, "state");
    assert.equal(trace.nodes.at(-1)?.durationMs, 300);
    assert.equal(trace.requests.length, 1);
  });
});
