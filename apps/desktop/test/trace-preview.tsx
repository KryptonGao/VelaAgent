/** Deterministic browser fixture. Not imported by the production renderer. */
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  AppState,
  TraceDetails,
  TraceNode,
  TraceRequest,
  TraceUpdate,
  VelaApi,
  AgentStreamEvent,
} from "@vela/shared";
import { TraceView } from "../src/renderer/components/trace/TraceView";
import "../src/renderer/styles.css";
const base = Date.parse("2026-09-25T19:14:34.567+08:00");
const count = Number(new URLSearchParams(location.search).get("count") ?? 24);
const request: TraceRequest = {
  id: "request-1",
  number: 1,
  turn: 1,
  model: "test/model",
  status: "Completed",
  contextId: "context-1",
  startedAt: base,
  completedAt: base + 2024,
  durationMs: 2024,
  firstTokenMs: 1280,
  generationMs: 744,
  usage: {
    input: 8000,
    output: 151,
    cacheRead: 240000,
    cacheWrite: 0,
    totalTokens: 248151,
  },
};
const context = {
  id: "context-1",
  systemPrompt:
    "You are a helpful software engineer assistant.\n\nUse available tools to inspect the workspace and complete the user's task.",
  tools: [
    {
      name: "bash",
      description:
        "Run commands in a bash shell. Returns stdout, stderr and the exit code.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to execute" },
          timeout: { type: "number", description: "Timeout in seconds" },
        },
        required: ["command"],
      },
    },
  ],
  recorded: true,
};
const summaries = [
  "The user wants a single HTML file with SVG animation of a pelican riding a bicycle. I'll first inspect the workspace.",
  '{"command":"ls -d ~/Desktop"}',
  "/Users/test/Desktop",
  "Desktop is /Users/test/Desktop. I'll create a single HTML file with SVG animation.",
  "Thigh angles 13–53° and knee bend 43–115° relative. Check the pedaling geometry.",
  '{"command":"node check-geometry.mjs"}',
  "near thigh: 33.8;40.4;47.5;54.7;61.2;65.9",
  "Check the knee joint and pedal crank before rendering the final animation.",
];
const nodes: TraceNode[] = Array.from({ length: count }, (_, i) => {
  const kind =
    i === 0
      ? "system"
      : i === 1
        ? "user"
        : (
            [
              "thinking",
              "tool-call",
              "tool-result",
              "assistant",
              "thinking",
              "tool-call",
              "tool-result",
              "thinking",
            ] as const
          )[(i - 2) % 8]!;
  return {
    id: `node-${i}`,
    sequence: i,
    kind,
    turn: i < 16 ? 1 : 2,
    step: Math.floor(i / 4) + 1,
    requestId: i > 1 ? "request-1" : null,
    toolCallId: kind.startsWith("tool") ? `call-${Math.floor(i / 4)}` : null,
    toolName: kind.startsWith("tool") ? "bash" : null,
    status: i === count - 2 ? "Failed" : "Completed",
    summary:
      i === 0
        ? "初始系统提示词"
        : i === 1
          ? "在桌面上用 HTML + SVG 单文件实现一个鹈鹕骑自行车的动画"
          : summaries[(i - 2) % 8]!,
    startedAt: base + i * 1800,
    completedAt:
      base +
      i * 1800 +
      (kind === "tool-call" ? 1696 : kind === "user" ? 0 : 744),
    executionStartedAt: kind === "tool-call" ? base + i * 1800 : null,
    durationMs: kind === "tool-call" ? 1696 : kind === "user" ? 0 : 744,
    version: i + 1,
    historical: false,
  };
});
const requests = [request];
// Reproduce a normal model response followed by a request containing only tools.
if (new URLSearchParams(location.search).get("scenario") === "tool-only") {
  requests.splice(0, 1,
    { ...request, completedAt: base + 5271, durationMs: 5271 },
    {
      ...request, id: "request-2", number: 2,
      startedAt: base + 5306, completedAt: base + 9047,
      durationMs: 3741, firstTokenMs: 2969, generationMs: 772,
    },
  );
  nodes.splice(0, nodes.length,
    nodes[0]!,
    { ...nodes[1]!, startedAt: base, completedAt: base },
    {
      ...nodes[2]!, id: "request-1-block-0",
      startedAt: base + 4224, completedAt: base + 5271, durationMs: 5271,
    },
    ...[9, 33].map((durationMs, i): TraceNode => ({
      ...nodes[3]!, id: `request-2-block-${i}`, sequence: 3 + i,
      step: 2, requestId: "request-2", toolCallId: `call-${i}`,
      startedAt: base + 8275 + i * 309,
      executionStartedAt: base + 9049 + i,
      completedAt: base + 9049 + i + durationMs, durationMs,
    })),
  );
}
const listeners = new Set<(e: AgentStreamEvent) => void>();
let version = count;
const details = (node: TraceNode): TraceDetails => ({
  node,
  content: node.summary,
  raw: { type: node.kind, content: node.summary },
  source: {
    kind: node.kind,
    clientTimeZone: "Asia/Shanghai",
    timestamp: node.startedAt,
  },
  arguments: { command: "ls -d ~/Desktop /root/Desktop /home/*/Desktop" },
  result: {
    content: [
      {
        type: "text",
        text: "/Users/test/Desktop\n---\n/Users/test\nApplications  Library  Public",
      },
    ],
    details: { exitCode: 0 },
  },
  context,
  request: requests.find((r) => r.id === node.requestId) ?? request,
  responseBlocks: node.requestId === "request-2"
    ? nodes.filter((n) => n.requestId === "request-2").map((n) => ({
        type: "toolCall", id: n.toolCallId, name: n.toolName,
        arguments: { command: "ls -d ~/Desktop" },
      }))
    : [
    { type: "thinking", thinking: summaries[0] },
    {
      type: "toolCall",
      name: "bash",
      arguments: { command: "ls -d ~/Desktop" },
    },
  ],
});
window.vela = {
  getTrace: async () => ({
    version,
    nodes: [...nodes],
    requests,
    warning: null,
  }),
  getTraceDetails: async (_c: string, id: string) => {
    const node = nodes.find((n) => n.id === id);
    return node ? details(node) : null;
  },
  onEvent: (fn: (e: AgentStreamEvent) => void) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
} as unknown as VelaApi;
function Fixture() {
  const [preview, setPreview] = useState(false),
    [chat, setChat] = useState(false);
  return (
    <div
      style={{
        display: "flex",
        height: "100vh",
        width: "100vw",
        background: "var(--bg-chat)",
      }}
    >
      <aside
        style={{
          width: 230,
          flexShrink: 0,
          background: "var(--bg-surface-subtle)",
          borderRight: "1px solid var(--border-subtle)",
          padding: "24px 16px",
          fontSize: 12,
        }}
      >
        <b>Vela</b>
        <p style={{ marginTop: 32, color: "var(--text-muted)" }}>
          工作区 / Workspace
        </p>
        <p>⌑ VelaAgent</p>
        <p style={{ marginTop: 28, color: "var(--text-muted)" }}>
          会话 / Conversations
        </p>
        <p
          style={{ background: "var(--bg-chat)", padding: 10, borderRadius: 4 }}
        >
          鹈鹕骑自行车 SVG 动画
        </p>
        <p style={{ marginTop: 40 }}>UI test fixture</p>
        <button id="toggle-preview" onClick={() => setPreview((v) => !v)}>
          切换文件预览
        </button>
        <button
          id="append-event"
          onClick={() => {
            const node = {
              ...nodes.at(-1)!,
              id: `node-${nodes.length}`,
              sequence: nodes.length,
              kind: "thinking" as const,
              status: "Running" as const,
              summary: "New live thinking event",
              version: ++version,
            };
            nodes.push(node);
            const event: TraceUpdate = {
              type: "trace",
              conversationId: "fixture",
              version,
              nodes: [node],
              requests: [],
              warning: null,
            };
            listeners.forEach((fn) => fn(event));
          }}
        >
          追加实时事件
        </button>
      </aside>
      <main className="main-chat-view">
        <header className="main-chat-header">
          <span className="chat-active-title">鹈鹕骑自行车 SVG 动画</span>
          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
            Agent Trace · Test fixture
          </span>
        </header>
        <nav className="conversation-view-tabs">
          <button onClick={() => setChat(true)} aria-selected={chat}>
            对话
          </button>
          <button onClick={() => setChat(false)} aria-selected={!chat}>
            轨迹
          </button>
        </nav>
        {chat ? (
          <p>Conversation input</p>
        ) : (
          <TraceView
            state={
              {
                activeConversationId: "fixture",
                session: { status: "ready" },
                context: { percent: 4 },
              } as AppState
            }
            onConversation={() => setChat(true)}
            onAbort={async () => {}}
            pendingInteraction={false}
          />
        )}
      </main>
      {preview ? (
        <aside
          style={{
            width: 340,
            flexShrink: 0,
            padding: 16,
            borderLeft: "1px solid var(--border-strong)",
            fontSize: 12,
          }}
        >
          文件预览 / Workspace inspector<pre>pelican-animation.html</pre>
        </aside>
      ) : null}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
