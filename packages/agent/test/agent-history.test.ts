import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { legacyAgentTranscript, normalizeStoredAgents, recoverLegacyAgents, type StoredAgent } from "../src/agent-history.ts";
import { ConversationStore } from "../src/conversation-store.ts";
import { createPersistedSession } from "../src/session-persistence.ts";
import { AgentRuntime } from "../src/runtime.ts";

function agent(overrides: Partial<StoredAgent> = {}): StoredAgent {
  return { id: "child", parentId: "root", path: "/root/test", name: "test", kind: "explore",
    status: "completed", depth: 1, task: "查 package.json", steps: [], mutated: false,
    finalText: "检查完成", error: null, createdAt: 1, updatedAt: 2, sessionFile: null, ...overrides };
}

describe("子代理历史恢复", () => {
  it("真实 SDK 执行 spawn_agent 和 read 后，退出重启能恢复思考与完整工具正文", { timeout: 20_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "vela-harness-sdk-history-"));
    const runtimes: AgentRuntime[] = [];
    const failures: Error[] = [];
    const server = createServer(async (request, response) => {
      try {
        let source = "";
        for await (const chunk of request) source += chunk;
        const body = JSON.parse(source);
        const isChild = Boolean(body.tools?.length) && !body.tools.some((tool: { function: { name: string } }) => tool.function.name === "write");
        const calls = body.messages.flatMap((message: { tool_calls?: Array<{ function: { name: string } }> }) => message.tool_calls ?? []);
        let delta: Record<string, unknown>;
        let finish = "stop";
        if (isChild && !calls.some((call: { function: { name: string } }) => call.function.name === "read")) {
          delta = { role: "assistant", reasoning_content: "先读取持久化测试文件", tool_calls: [
            { index: 0, id: "read-history", type: "function", function: { name: "read", arguments: JSON.stringify({ path: join(dir, "fixture.txt") }) } },
          ] };
          finish = "tool_calls";
        } else if (!isChild && body.tools?.length && !calls.some((call: { function: { name: string } }) => call.function.name === "spawn_agent")) {
          delta = { role: "assistant", tool_calls: [
            { index: 0, id: "spawn-history", type: "function", function: { name: "spawn_agent", arguments: JSON.stringify({ agent: "explore", name: "sdk-history", task: "读取 fixture.txt，汇报文件内容", fork: "none" }) } },
          ] };
          finish = "tool_calls";
        } else {
          delta = { role: "assistant", content: isChild ? "已读取：持久化工具输出" : "测试完成" };
        }
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        const base = { id: "history-response", object: "chat.completion.chunk", created: 1, model: "history-test" };
        response.end([
          `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
          `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`,
          "data: [DONE]\n\n",
        ].join(""));
      } catch (error) {
        failures.push(error as Error);
        response.writeHead(500); response.end();
      }
    });
    try {
      await writeFile(join(dir, "fixture.txt"), "持久化工具输出");
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const runtime = new AgentRuntime({ cwd: dir, agentDir: dir }); runtimes.push(runtime);
      await runtime.createConversation(dir);
      await runtime.addModel({ providerId: "local-history-test", providerName: "Local test", modelId: "history-test", modelName: "History",
        api: "openai-completions", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "local-test-key", reasoning: true,
        contextWindow: 32768, maxTokens: 4096 });
      const id = runtime.activeConversationId;
      assert.ok(id);
      await runtime.prompt(id, "执行本地子代理测试");
      for (let i = 0; i < 300 && !runtime.getAgents(id).some((item) => item.kind !== "root" && item.status === "completed"); i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.deepEqual(failures, []);
      const child = runtime.getAgents(id).find((item) => item.kind !== "root");
      assert.equal(child?.status, "completed"); assert.ok(child);
      // 等主会话消费回传完成，模拟正常退出，避免仍有流式回调写入测试目录。
      for (let i = 0; i < 300 && runtime.getSnapshot().status === "streaming"; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      runtime.dispose();
      const stored = JSON.parse(await readFile(join(dir, "conversations.json"), "utf8"));
      assert.ok(stored.conversations.find((item: { id: string }) => item.id === id).agents[0].sessionFile);
      const restarted = new AgentRuntime({ cwd: dir, agentDir: dir }); runtimes.push(restarted);
      await restarted.switchConversation(id);
      const restored = restarted.getAgentMessages(id, child.id);
      assert.ok(restored.some((message) => message.thinking === "先读取持久化测试文件"), JSON.stringify(restored));
      assert.ok(restored.some((message) => message.tools.some((tool) => tool.activity.body?.includes("持久化工具输出"))));
      assert.equal(restored.at(-1)?.text, "已读取：持久化工具输出");
      assert.equal(restarted.getAgents(id).find((item) => item.id === child.id)?.historyIncomplete, false);
    } finally {
      runtimes.forEach((runtime) => runtime.dispose());
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("新进程在启动模型前即可读取完整历史，激活对话后仍保留嵌套代理与停止状态", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vela-harness-history-"));
    let runtime: AgentRuntime | null = null;
    let restarted: AgentRuntime | null = null;
    try {
      const root = createPersistedSession(dir, join(dir, "sessions"));
      const child = createPersistedSession(dir, join(dir, "subagents", root.getSessionId()));
      child.appendMessage({ role: "user", content: "查 package.json", timestamp: 1 } as never);
      child.appendMessage({ role: "assistant", content: [
        { type: "thinking", thinking: "先读取文件" },
        { type: "toolCall", id: "read-1", name: "read", arguments: { path: "package.json" } },
      ], timestamp: 2 } as never);
      child.appendMessage({ role: "toolResult", toolCallId: "read-1", toolName: "read",
        content: [{ type: "text", text: '{"name":"vela-harness"}' }], isError: false, timestamp: 3 } as never);
      child.appendMessage({ role: "assistant", content: [{ type: "text", text: "检查完成" }], timestamp: 4 } as never);
      const store = new ConversationStore(join(dir, "conversations.json"));
      store.put({ id: root.getSessionId(), cwd: dir, title: "历史对话", createdAt: 1, updatedAt: 2,
        messageCount: 1, toolCallCount: 1, sessionFile: root.getSessionFile(), instructions: "", mode: "agent",
        plans: [], latestProposedPlanId: null, executionPlans: [], activeExecutionPlanId: null,
        goal: null, archivedAt: null, agents: [
          agent({ parentId: root.getSessionId(), sessionFile: child.getSessionFile() }),
          agent({ id: "nested", parentId: "child", path: "/root/test/nested", name: "nested", depth: 2,
            status: "running", finalText: null, steps: [{ id: "pending", name: "bash", summary: "ls", status: "running" }] }),
        ] });
      store.flushSync();

      runtime = new AgentRuntime({ cwd: dir, agentDir: dir });
      await runtime.getAgentSettings();
      assert.deepEqual(runtime.getAgents(root.getSessionId()).map((item) => item.status), ["completed", "aborted"]);
      const transcript = runtime.getAgentMessages(root.getSessionId(), "child");
      assert.equal(transcript[0]?.text, "查 package.json");
      assert.equal(transcript[1]?.thinking, "先读取文件");
      assert.equal(transcript[1]?.tools[0]?.activity.body, '{"name":"vela-harness"}');
      assert.equal(transcript.at(-1)?.text, "检查完成");
      assert.equal(runtime.getAgentMessages(root.getSessionId(), "unknown").length, 0);

      const emitted: string[][] = [];
      runtime.subscribe((event) => { if (event.type === "agents") emitted.push(event.agents.map((item) => item.id)); });
      await runtime.switchConversation(root.getSessionId());
      assert.ok(emitted.some((ids) => ids.includes("child") && ids.includes("nested")));
      assert.equal(runtime.getAgents(root.getSessionId()).find((item) => item.id === "nested")?.parentId, "child");
      assert.equal(runtime.getAgents(root.getSessionId()).find((item) => item.id === "nested")?.steps[0]?.status, "error");
      assert.equal(runtime.getAgentMessages(root.getSessionId(), "child").at(-1)?.text, "检查完成");
      runtime.dispose();
      runtime = null;
      // 再次退出、启动不会把历史列表覆盖为只有 root。
      restarted = new AgentRuntime({ cwd: dir, agentDir: dir });
      await restarted.getAgentSettings();
      assert.equal(restarted.getAgents(root.getSessionId()).length, 2);
      assert.equal(restarted.getAgentMessages(root.getSessionId(), "child")[1]?.thinking, "先读取文件");
    } finally {
      runtime?.dispose();
      restarted?.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("旧会话从 spawn、followup 与回传记录恢复任务、步骤和结论", () => {
    const messages = [
      { role: "assistant", content: [{ type: "toolCall", id: "spawn", name: "spawn_agent",
        arguments: { agent: "explore", task: "查旧会话", name: "test" } }], timestamp: 1 },
      { role: "toolResult", toolCallId: "spawn", toolName: "spawn_agent", content: [], timestamp: 2,
        details: { agentId: "child", path: "/root/test", kind: "explore", status: "idle" } },
      { role: "toolResult", toolCallId: "follow", toolName: "followup_task", content: [], timestamp: 3,
        details: { agentId: "child", path: "/root/test", kind: "explore", status: "completed",
          finalText: "旧代理结论", steps: [{ id: "read", name: "read", summary: "README.md", status: "done" }] } },
      { role: "custom", customType: "vela_agent_result", content: "自动回传结论", timestamp: 4,
        details: { agentId: "nested", path: "/root/test/nested", kind: "general", status: "completed" } },
    ] as unknown as AgentMessage[];
    const recovered = recoverLegacyAgents(messages, "root");
    assert.equal(recovered[0]?.task, "查旧会话");
    assert.equal(recovered[0]?.finalText, "旧代理结论");
    assert.equal(recovered[0]?.steps[0]?.summary, "README.md");
    assert.equal(recovered[1]?.parentId, "child");
    assert.equal(recovered[1]?.finalText, "自动回传结论");
    assert.equal(recovered[0]?.historyIncomplete, true);
    const transcript = legacyAgentTranscript(recovered[0]!);
    assert.equal(transcript[0]?.text, "查旧会话");
    assert.equal(transcript[1]?.tools[0]?.activity.path, "README.md");
    assert.equal(transcript[1]?.text, "旧代理结论");
    assert.equal(transcript[1]?.tools[0]?.activity.body, undefined);
  });

  it("过滤损坏、重复和 root 节点，文件缺失仍能展示已有结论", async () => {
    assert.deepEqual(normalizeStoredAgents([null, { id: "broken" }, { ...agent(), kind: "root" }]), []);
    assert.equal(normalizeStoredAgents([agent(), agent()]).length, 1);
    const runtime = Object.assign(Object.create(AgentRuntime.prototype), {
      conversations: new Map([["root", { id: "root", storedAgents: [agent({ sessionFile: "/missing/session.jsonl" })] }]]),
    }) as AgentRuntime;
    assert.equal(runtime.getAgentMessages("root", "child").at(-1)?.text, "检查完成");
  });
});
