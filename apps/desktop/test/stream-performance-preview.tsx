/** Browser integration checks for stream isolation and deferred history. No real IPC. */
import React, { Profiler, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { AgentInfo, AgentStreamEvent, AppState, AskUserQuestionEvent, VelaApi } from "@vela/shared";
import { useSession } from "../src/renderer/hooks/useSession";
import { SessionChatView } from "../src/renderer/components/SessionChatView";
import { AgentPane } from "../src/renderer/components/AgentPane";
import { ToolCard, ToolRunGroup, CompactToolGroup } from "../src/renderer/components/ToolCard";
import type { ProjectApi } from "../src/renderer/hooks/useProject";
import type { useModels } from "../src/renderer/hooks/useModels";
import "../src/renderer/styles.css";

const noop = () => {};
const ready = async () => {};
const pause = (ms = 80) => new Promise(resolve => setTimeout(resolve, ms));
const state = { activeConversationId: "c", conversations: [{ id: "c", title: "Fixture", status: "ready" }],
  // 首帧消息还没加载时 ChatView 会读 context,这里给全字段避免竞态崩溃。
  context: { messageCount: 0, toolCallCount: 0, turnCount: 0, stepCount: 0, tokens: 0, contextWindow: null, percent: null,
    segments: { system: 0, tools: 0, rules: 0, skills: 0, conversation: 0 }, sessionTokens: null, cacheHitRate: null, outputSpeed: null },
  session: { id: "c", title: "Fixture", status: "ready", mode: "agent", modelReady: false, tools: [], thinkingLevels: [] },
} as unknown as AppState;
let emit: (event: AgentStreamEvent) => void = noop;
let emitQuestion: (event: AskUserQuestionEvent) => void = noop;
window.vela = {
  platform: "darwin", getState: async () => state,
  getMessages: async (id: string) => id !== "c" ? [] : [
    { id: "u", role: "user", text: "Previous turn", thinking: "", tools: [] },
    { id: "m", role: "assistant", text: "Completed reply", thinking: "Historical thinking", tools: [
      { id: "history-tool", name: "read", status: "done", activity: { path: "history.ts", body: "secret detail" } },
    ] },
  ],
  getAgentMessages: async () => [],
  onEvent: (listener: typeof emit) => { emit = listener; return noop; },
  onQuestionEvent: (listener: typeof emitQuestion) => { emitQuestion = listener; return noop; },
  listOpenTargets: async () => [], listSkills: async () => ({ skills: [] }),
  getAgentSettings: async () => ({ provider: null, modelId: null, thinkingLevel: "medium", newConversationSelection: "default", instructions: "" }),
} as unknown as VelaApi;
const project = { sandboxMode: "ask", approval: null, workspace: null, git: null, environment: null, environments: [],
  openWorkspaceDialog: ready } as unknown as ProjectApi;
const models = { catalog: { models: [], providers: [] }, login: { active: false },
  select: noop, setThinking: noop, add: noop, remove: noop, logout: noop, loginProvider: noop,
  replyLogin: noop, cancelLogin: noop, dismissLogin: noop } as unknown as ReturnType<typeof useModels>;
const agent = (id: string): AgentInfo => ({ id, parentId: null, path: `/root/${id}`, name: id, kind: "general", status: "running", depth: 1,
  task: "Fixture", steps: [], mutated: false, finalText: null, error: null, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, activeMs: 0, runningSince: null, pauseRequested: false, createdAt: 0, updatedAt: 0 });
const a = agent("a");
const b = agent("b");
const agents = [a, b];
const tools = Array.from({ length: 4 }, (_, index) => ({ id: `t${index}`, name: "read", status: "done" as const,
  activity: { path: `file${index}.ts`, body: Array.from({ length: 300 }, (_, line) => `code line ${line}`).join("\n") } }));
const counts = { app: 0, chat: 0, a: 0, b: 0 };
let hideA: (visible: boolean) => void = noop;
let currentSession: ReturnType<typeof useSession>;
function Fixture() {
  const session = useSession();
  currentSession = session;
  counts.app += 1;
  const [visible, setVisible] = useState(true);
  hideA = value => flushSync(() => setVisible(value));
  return <div style={{ display: "flex", height: 700 }}>
    <div style={{ display: "flex", flex: 1, minWidth: 0 }}><Profiler id="chat" onRender={() => { counts.chat += 1; }}>
      <SessionChatView messageStore={session.messageStore} state={session.state} question={session.question}
        summaryEnabled={false} summaryStyle="inline" locale="en" sendError={null} platform="darwin"
        leftCollapsed rightCollapsed project={project} models={models} onToggleLeft={noop} onToggleRight={noop}
        onSend={ready} onAbort={ready} onMode={noop} getQuestion={session.getQuestion} onReplyQuestion={noop}
        onBranch={noop} showNewTab={false} onNewTab={noop} onOpenChanges={noop} />
    </Profiler></div>
    <div id="agent-a" style={{ width: 350, height: 600, display: "flex" }}><Profiler id="a" onRender={() => { counts.a += 1; }}>
      <AgentPane agent={a} agents={agents} messageStore={session.messageStore} conversationId="c" visible={visible}
        ensureMessages={session.ensureAgentMessages} onSwitch={noop} onControl={noop} />
    </Profiler></div>
    <div id="agent-b" style={{ width: 350, height: 600, display: "flex" }}><Profiler id="b" onRender={() => { counts.b += 1; }}>
      <AgentPane agent={b} agents={agents} messageStore={session.messageStore} conversationId="c"
        ensureMessages={session.ensureAgentMessages} onSwitch={noop} onControl={noop} />
    </Profiler></div>
    <div id="details" style={{ width: 300 }}><ToolCard tool={tools[0]!} /><ToolRunGroup tools={tools} /><CompactToolGroup tools={tools} /></div>
  </div>;
}
const root = createRoot(document.getElementById("root")!);
root.render(<React.StrictMode><Fixture /></React.StrictMode>);

let disposed = false;
const results: string[] = [];
function check(condition: boolean, description: string) {
  if (disposed) throw new Error("Fixture disposed");
  if (!condition) throw new Error(description);
  results.push(`PASS ${description}`);
}
async function checks() {
  await pause(250);
  check(Boolean(document.querySelector("#agent-a .agent-pane")), "fixture mounts real chat and agent components");
  const historicalNode = document.querySelector(".assistant-turn .agent-reply-prose")!;
  const before = { ...counts };
  for (let i = 0; i < 100; i += 1) emit({ type: "agent_event", conversationId: "c", agentId: "a", event: { type: "text_delta", delta: `${i},` } });
  await pause();
  check(counts.app === before.app && counts.chat === before.chat && counts.b === before.b, "100 agent deltas do not render App, chat or sibling agent");
  check(counts.a === before.a + 1, `100 agent deltas publish one visible-agent commit (${counts.a - before.a})`);
  check(document.querySelector("#agent-a")!.textContent!.includes("99,"), "all agent deltas remain in order");
  const beforeMain = { ...counts };
  emit({ type: "user_message", conversationId: "c", text: "Next turn" });
  for (let i = 0; i < 100; i += 1) emit({ type: "text_delta", conversationId: "c", delta: "x" });
  await pause();
  check(counts.app === beforeMain.app && counts.a === beforeMain.a && counts.b === beforeMain.b, "main deltas do not render App or agents");
  check(document.querySelector(".assistant-turn .agent-reply-prose") === historicalNode, "history DOM survives updates to a later turn");
  const historyReply = historicalNode;
  check(!document.querySelector(".time-spent-body .tool-card"), "collapsed completed history mounts no tool details");
  check(!document.querySelector("#details .tool-code-line") && !document.querySelector("#details .tool-run .tool-card"), "collapsed tools and groups mount no code rows or nested cards");
  const trigger = document.querySelector<HTMLButtonElement>(".time-spent-trigger[aria-controls]")!;
  trigger.click();
  await pause(340);
  check(Boolean(document.querySelector(".time-spent-body .tool-card")), "completed history mounts on first expansion");
  trigger.click();
  await pause(340);
  check(!document.querySelector(".time-spent-body .tool-card"), "completed history releases content after closing");
  check(historyReply.isConnected, "historical final reply keeps its DOM through stream updates and folding");
  const toolTrigger = document.querySelector<HTMLButtonElement>("#details .tool-card-head")!;
  toolTrigger.click();
  await pause(340);
  check(Boolean(document.querySelector("#details .tool-code-line")), "tool code rows mount on expansion");
  toolTrigger.click();
  await pause(340);
  check(!document.querySelector("#details .tool-code-line"), "tool code rows unmount after closing");
  emit({ type: "agent_event", conversationId: "c", agentId: "a", event: { type: "text_delta", delta: "\n\n" + "long paragraph\n\n".repeat(100) } });
  await pause(150);
  const scroller = document.querySelector<HTMLDivElement>("#agent-a .agent-pane-scroll")!;
  scroller.scrollTop = 70;
  scroller.dispatchEvent(new Event("scroll"));
  hideA(false);
  await pause();
  const hiddenBefore = { ...counts };
  emit({ type: "agent_event", conversationId: "c", agentId: "a", event: { type: "text_delta", delta: "HIDDEN OUTPUT" } });
  await pause();
  check(!document.querySelector("#agent-a .agent-pane"), "hidden agent content is unmounted");
  check(counts.app === hiddenBefore.app && counts.a === hiddenBefore.a && counts.chat === hiddenBefore.chat && counts.b === hiddenBefore.b, "hidden-agent output causes zero React commits");
  hideA(true);
  await pause();
  check(document.querySelector("#agent-a")!.textContent!.includes("HIDDEN OUTPUT"), "hidden output is available on reopening");
  check(Math.abs(document.querySelector<HTMLDivElement>("#agent-a .agent-pane-scroll")!.scrollTop - 70) < 2, "unpinned agent scroll position survives hiding and reopening");
  emit({ type: "state", state: { ...state, session: { ...state.session, status: "streaming" } } });
  await pause();
  emit({ type: "tool_start", conversationId: "c", toolCallId: "q", toolName: "ask_user_question", activity: {} });
  await pause();
  const request = { id: "request", conversationId: "c", toolCallId: "q", question: "Pick one?", options: [{ label: "A", description: "A" }, { label: "B", description: "B" }], allowFreeText: true };
  emitQuestion({ type: "request", request } as unknown as AskUserQuestionEvent);
  await pause();
  check(currentSession.question?.id === "request" && document.querySelector(".question-card")!.textContent!.includes("Pick one?"), "question requests reach memoized tool history");
  emitQuestion({ type: "resolved", id: "request" } as unknown as AskUserQuestionEvent);
  await pause();
  check(currentSession.question === null && !document.querySelector(".question-card.interactive"), "question resolution clears the active request and disables interaction");
  emit({ type: "text_delta", conversationId: "c", delta: " FINAL TAIL" });
  flushSync(() => emit({ type: "state", state }));
  check(document.querySelector(".chat-message-surface")!.textContent!.includes("FINAL TAIL"), "completion publishes pending tail before the ready-state render");
  emit({ type: "text_delta", conversationId: "background", delta: "BACKGROUND REPLY" });
  await pause();
  flushSync(() => emit({ type: "state", state: { ...state, activeConversationId: "background", session: { ...state.session, id: "background" } } }));
  await pause();
  const switched = document.querySelector(".chat-message-surface")!.textContent!;
  check(switched.includes("BACKGROUND REPLY") && !switched.includes("Completed reply"), "conversation switch subscribes to its own background stream");
  flushSync(() => emit({ type: "state", state }));
  await pause();
  check(document.querySelector(".chat-message-surface")!.textContent!.includes("FINAL TAIL"), "switching back restores the completed stream");

}
void checks().catch(error => results.push(`FAIL ${error.message}`)).finally(() => {
  if (disposed) return;
  const output = document.createElement("pre");
  output.id = "stream-check-results";
  output.textContent = results.join("\n");
  output.dataset.status = results.some((line) => line.startsWith("FAIL")) ? "failed" : "passed";
  output.style.cssText = "position:fixed;inset:0;background:white;color:black;z-index:99999;overflow:auto;padding:24px";
  document.body.append(output);
});

if (import.meta.hot) import.meta.hot.dispose(() => {
  disposed = true;
  root.unmount();
  document.querySelector("#stream-check-results")?.remove();
});
