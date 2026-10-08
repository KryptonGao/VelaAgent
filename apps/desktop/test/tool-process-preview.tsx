/** Real session view with recorded trace summaries and browser persistence. */
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { AppState, ToolTrace, TraceNode, VelaApi } from "@vela/shared";
import { SessionChatView } from "../src/renderer/components/SessionChatView";
import { SettingsView } from "../src/renderer/components/SettingsView";
import { createMessageStore, messageScope } from "../src/renderer/hooks/message-store";
import type { UiMessage } from "../src/renderer/hooks/useSession";
import type { useModels } from "../src/renderer/hooks/useModels";
import type { ProjectApi } from "../src/renderer/hooks/useProject";
import { usePreferences, type ToolDisplay, type ToolFold } from "../src/renderer/hooks/usePreferences";
import { toolFoldStorageKey } from "../src/renderer/components/tool-fold-state";
import { AppLocaleProvider, setActiveLocale } from "../src/renderer/locale";
import "../src/renderer/styles.css";

const params = new URLSearchParams(location.search);
setActiveLocale("zh-CN");
document.documentElement.dataset.scheme = params.get("theme") ?? "light";
const noop = () => {};
const ids = ["fold-fixture-a", "fold-fixture-b", "fold-fixture-legacy", "fold-fixture-running"];
const unopenedId = "fold-fixture-unopened";
if (params.has("checks")) for (const id of ids) localStorage.removeItem(toolFoldStorageKey(id));
if (params.has("checks")) localStorage.setItem(toolFoldStorageKey(unopenedId), '{"rows":{"bash":true},"sequences":{}}');
// The preference starts at its real default; the settings control below turns it on.
if (params.has("checks")) localStorage.removeItem("vela.toolProcessDetails");
// Keep the fixture theme while usePreferences owns data-scheme.
localStorage.setItem("vela.appearance", params.get("theme") === "dark" ? "dark" : "light");
const eventListeners = new Set<Parameters<VelaApi["onEvent"]>[0]>();
const tool = (id: string, name: string, running = false): ToolTrace => ({
  id, name, status: running ? "running" : "done", activity: name === "bash"
    ? { command: id === "long" ? "pnpm build" : "git status --short", body: "Build complete.\nAll checks passed." }
    : { path: "src/renderer/components/ChatView.tsx", body: "export function ChatView() {}" },
});
const recordedNodes = (sessionId: string): TraceNode[] => sessionId.endsWith("legacy") ? [] : [2300, 820, 100000].map((duration, index) => ({
  id: `node-${index}`, sequence: index, kind: "tool-call", turn: 1, step: index, requestId: null,
  toolCallId: ["bash", "read", "long"][index], toolName: index === 1 ? "read" : "bash", status: "Completed", summary: "Recorded tool call",
  startedAt: 0, executionStartedAt: 100, completedAt: duration + 100,
  durationMs: sessionId.endsWith("b") ? duration * 2 : duration, version: 1, historical: false,
}));
let traceReads = 0;
window.vela = {
  platform: "darwin", listOpenTargets: async () => [], listSkills: async () => ({ skillsDir: "/fixture/skills", skills: [], diagnostics: [] }),
  getAgentSettings: async () => ({ provider: null, modelId: null, thinkingLevel: "medium", newConversationSelection: "default", instructions: "" }),
  onWorkspaceEvent: () => noop, onGitEvent: () => noop,
  onEvent: listener => { eventListeners.add(listener); return () => { eventListeners.delete(listener); }; },
  getTrace: async sessionId => { traceReads++; return { version: 1, nodes: recordedNodes(sessionId), requests: [], summaries: [], warning: null }; },
  pickAttachments: async () => [], hydrateAttachments: async () => [],
} as unknown as VelaApi;
const models = { catalog: { models: [], providers: [] }, login: { active: false }, select: noop, setThinking: noop } as unknown as ReturnType<typeof useModels>;
const project = { workspace: { current: "/fixture", recents: [] }, environments: [], environment: { kind: "local" },
  git: null, approval: null, sandboxMode: "ask", listBranches: async () => [] } as unknown as ProjectApi;
const messageStore = createMessageStore(() => noop);
for (const id of ids) {
  const running = id.endsWith("running");
  const legacy = id.endsWith("legacy");
  const messages: UiMessage[] = [
    { id: "user", role: "user", text: "检查紧凑过程行的耗时和折叠状态。", thinking: "", tools: [] },
    { id: "first", role: "assistant", text: "", thinking: "", tools: [tool("bash", "bash"), tool("read", "read")] },
    { id: "reply", role: "assistant", text: running ? "" : "工具执行完毕。", thinking: "接下来验证构建。", tools: [tool("long", "bash", running)],
      ...(legacy ? {} : { turnStartedAt: 0, ...(running ? {} : { turnCompletedAt: 105000 }) }), historical: true },
  ];
  messageStore.publish(messageScope(id), messages);
}
messageStore.flush();
let controls: { session(id: string): void; remount(): void; display(value: ToolDisplay): void; fold(value: ToolFold): void; details(value: boolean): void; remove(id: string): void };
function Fixture() {
  const [session, setSession] = useState(ids.includes(params.get("session") ?? "") ? params.get("session")! : ids[0]);
  const [mount, setMount] = useState(0);
  const [display, setDisplay] = useState<ToolDisplay>("compact");
  const [fold, setFold] = useState<ToolFold>("position");
  const [sessions, setSessions] = useState([...ids, unopenedId]);
  const preferences = usePreferences();
  const details = preferences.toolProcessDetails;
  controls = { session: setSession, remount: () => setMount(value => value + 1), display: setDisplay, fold: setFold,
    details: preferences.setToolProcessDetails,
    remove: id => setSessions(current => current.filter(value => value !== id)) };
  const state = {
    activeConversationId: session,
    conversations: sessions.map(id => ({ id, title: id, archivedAt: null })),
    session: { id: session, title: "紧凑模式过程行", cwd: "/fixture", status: session.endsWith("running") ? "streaming" : "ready",
      model: "Fixture", modelReady: true, modelProvider: "fixture", modelId: "fixture", tools: [], mode: "agent", thinkingLevel: "medium", thinkingLevels: ["medium"] },
    agents: [], context: { tokens: 100, contextWindow: 10000, percent: 1, messageCount: 3, toolCallCount: 3,
      segments: { system: 0, tools: 0, rules: 0, skills: 0, conversation: 100 } },
  } as unknown as AppState;
  return <>
    <div className="fixture-controls">
      {ids.map(id => <button key={id} onClick={() => setSession(id)}>{id.replace("fold-fixture-", "")}</button>)}
      <button onClick={controls.remount}>Remount</button>
      <button onClick={() => setDisplay(value => value === "compact" ? "card" : "compact")}>Mode: {display}</button>
      <button onClick={() => setFold(value => value === "message" ? "position" : "message")}>Fold: {fold}</button>
      <button onClick={() => preferences.setToolProcessDetails(!details)}>Details: {details ? "on" : "off"}</button>
      <button onClick={() => { document.documentElement.dataset.scheme = document.documentElement.dataset.scheme === "light" ? "dark" : "light"; }}>Theme</button>
      <output id="check-result">Ready</output>
    </div>
    <div className="vela-window platform-darwin left-collapsed right-collapsed layout-floating" style={{ height: "calc(100vh - 42px)" }}>
      <div className="main-stage"><div className="main-stage-pane">
        <SessionChatView key={mount} messageStore={messageStore} summaryEnabled={false} summaryStyle="inline" locale="zh-CN"
          state={state} project={project} sendError={null} platform="darwin" leftCollapsed rightCollapsed floatingInfo environmentCollapsed
          toolDisplay={display} toolFold={fold} models={models} onToggleLeft={noop} onToggleRight={noop}
          toolProcessDetails={details}
          onSend={async () => {}} onAbort={async () => {}} onMode={noop} getQuestion={() => null} onReplyQuestion={noop} onBranch={noop}
          showNewTab={false} onNewTab={noop} onOpenChanges={noop} />
      </div></div>
    </div>
    {params.has("checks") || params.has("settings") ? (
      <div className="fixture-settings" style={params.has("settings") ? undefined : { display: "none" }}>
        <SettingsView preferences={preferences} platform="darwin" models={models} project={project}
          conversations={state.conversations} onUnarchiveConversation={noop} onClose={noop} />
      </div>
    ) : null}
  </>;
}
const style = document.createElement("style");
style.textContent = ".fixture-controls{height:42px;display:flex;align-items:center;gap:8px;padding:0 12px;font-size:12px}.fixture-controls button{padding:4px 8px;border:1px solid var(--border-subtle);border-radius:4px}.fixture-controls output{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.main-chat-view{min-width:0}";
document.head.append(style);
createRoot(document.getElementById("root")!).render(<AppLocaleProvider locale="zh-CN"><Fixture /></AppLocaleProvider>);

const wait = (ms = 80) => new Promise(resolve => setTimeout(resolve, ms));
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const trigger = () => document.querySelector<HTMLButtonElement>("button.assistant-turn-trigger")!;
const summary = () => document.querySelector<HTMLButtonElement>(".tool-compact-summary")!;
const command = () => document.querySelector<HTMLButtonElement>("button.tool-compact-line")!;
const expanded = (button: HTMLButtonElement) => button?.getAttribute("aria-expanded") === "true";
const click = (button: HTMLButtonElement) => flushSync(() => button.click());
const switchSession = async (id: string) => { flushSync(() => controls.session(id)); await wait(); };
const openTurn = async () => { if (!expanded(trigger())) click(trigger()); await wait(); };
const openGroup = async () => { if (!expanded(summary())) click(summary()); await wait(); };
const optionLabel = () => Array.from(document.querySelectorAll("button")).find(button => button.textContent?.startsWith("Details:"))?.textContent ?? "";
/** Drive the real settings control, which is the entry point users get. */
function settingsToggle() {
  const view = document.querySelector<HTMLElement>(".fixture-settings")!;
  const group = Array.from(view.querySelectorAll<HTMLElement>('[role="radiogroup"]'))
    .find(item => item.getAttribute("aria-label") === "过程行耗时与折叠记忆");
  if (!group) {
    click(Array.from(view.querySelectorAll<HTMLButtonElement>(".settings-nav-item")).find(item => item.textContent === "对话显示")!);
    return settingsToggle();
  }
  const radios = () => Array.from(group.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
  return {
    state: () => radios().find(item => item.getAttribute("aria-checked") === "true")?.textContent ?? "",
    pick: (label: string) => click(radios().find(item => item.textContent === label)!),
  };
}

async function runChecks() {
  await wait(250);
  const passed: string[] = [];
  try {
    // 默认关闭:行为与加入该功能之前一致。
    assert(optionLabel() === "Details: off", "Option starts at its off default");
    assert(settingsToggle().state() === "关闭", "Settings control reflects the off default");
    assert(!document.querySelector(".tool-compact-steps") && !document.querySelector(".tool-duration"), "Off hides step and duration labels");
    assert(trigger().textContent?.includes("1分45秒"), "Off keeps the message-based elapsed text");
    assert(!expanded(trigger()), "Off keeps the collapsed turn default");
    await openTurn(); await openGroup(); click(command());
    assert(expanded(command()), "Off still toggles rows locally");
    const readsOff = traceReads;
    flushSync(() => controls.remount()); await wait(250);
    assert(!expanded(command()), "Off does not remember rows");
    assert(traceReads === readsOff, "Off reads no trace data");
    passed.push("option off");

    settingsToggle().pick("开启"); await wait(350);
    assert(optionLabel() === "Details: on" && settingsToggle().state() === "开启", "Settings control turns the option on");
    assert(localStorage.getItem("vela.toolProcessDetails") === "true", "Settings control persists the option");
    assert(trigger().textContent?.includes("1m45s"), "Collapsed turn uses recorded wall time");
    assert(!expanded(trigger()), "Turn starts collapsed");
    await openTurn(); await openGroup();
    assert(summary().textContent?.includes("3.1s"), "Sequence sums recorded calls");
    assert(command().querySelector(".tool-duration")?.textContent === "· 2.3s", "Call joins trace timing by ID");
    assert(Array.from(document.querySelectorAll(".tool-duration")).some(label => label.textContent === "· 1m40s"), "Long duration fits compact label");
    // 展开箭头始终紧跟在左侧内容之后,只有耗时段靠右。
    const follows = (first: Element, second: Element) => Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
    assert(follows(command().querySelector(".tool-compact-chevron")!, command().querySelector(".tool-duration")!), "Command chevron stays left of the right-aligned duration");
    assert(follows(summary().querySelector(".tool-compact-chevron")!, summary().querySelector(".tool-compact-steps")!), "Sequence chevron stays left of the steps and duration block");
    click(command());
    assert(expanded(command()), "Command opens");
    passed.push("recorded durations");

    // Recreate all stores before the debounce fires; provider cleanup must flush.
    flushSync(() => controls.remount()); await wait(250);
    assert(expanded(trigger()) && expanded(summary()) && expanded(command()), "Fold states survive full session remount");
    passed.push("remount persistence");
    await switchSession(ids[1]);
    assert(!expanded(trigger()), "Another chat starts collapsed despite reused message IDs");
    await openTurn(); await openGroup();
    assert(!expanded(command()), "Another chat starts with collapsed rows");
    assert(command().querySelector(".tool-duration")?.textContent === "· 4.6s", "Another chat uses its own trace");
    await switchSession(ids[0]);
    assert(expanded(trigger()) && expanded(summary()) && expanded(command()), "Switching back restores all fold states");
    passed.push("session isolation");

    const height = command().getBoundingClientRect().height;
    for (let i = 0; i < 10; i++) click(command());
    assert(expanded(command()), "Rapid toggles keep the final state");
    assert(command().getBoundingClientRect().height === height, "Toggling does not change row height");
    passed.push("rapid toggles");
    for (const mode of ["message", "position"] as const) {
      flushSync(() => controls.fold(mode)); await wait();
      assert(expanded(summary()) && expanded(command()), "Both grouping modes use stable fold IDs");
    }
    passed.push("grouping modes");

    await switchSession(ids[2]); await openTurn(); await openGroup();
    assert(Array.from(document.querySelectorAll(".tool-duration")).every(label => !label.textContent), "Old sessions hide unrecorded timing");
    click(command());
    flushSync(() => controls.remount()); await wait();
    assert(expanded(command()), "Old sessions still persist fold state");
    passed.push("legacy history");

    await switchSession(ids[3]);
    const live = Array.from(document.querySelectorAll("button.tool-compact-line")).find(button => button.textContent?.includes("pnpm build"))!;
    assert(live.querySelector('[role="status"]') && !live.querySelector(".tool-duration")?.textContent, "Running call shows activity instead of duration");
    passed.push("running indicator");
    await switchSession(ids[0]);
    const reads = traceReads;
    flushSync(() => controls.display("card")); await wait(350);
    assert(!document.querySelector(".tool-duration") && !expanded(trigger()), "Card mode keeps its existing defaults and hides duration badges");
    assert(trigger().textContent?.includes("1分45秒"), "Card mode keeps the message-based elapsed text");
    assert(traceReads === reads, "Card mode does not fetch extra traces");
    flushSync(() => controls.display("compact")); await wait();
    assert(expanded(trigger()) && expanded(command()), "Compact fold state survives display-mode changes");
    passed.push("card mode unchanged");

    // 关掉后不再显示也不再记忆,但已保存的折叠状态保留。
    await wait(300); // Let the debounced write from the enabled phase land first.
    const savedFold = localStorage.getItem(toolFoldStorageKey(ids[0]));
    assert(savedFold !== null, "Enabled option had saved fold state");
    settingsToggle().pick("关闭"); await wait(350);
    assert(!document.querySelector(".tool-compact-steps") && !document.querySelector(".tool-duration"), "Turning the option off hides durations again");
    assert(trigger().textContent?.includes("1分45秒"), "Turning the option off restores the old elapsed text");
    const readsDisabled = traceReads;
    await openTurn(); await openGroup(); click(command());
    assert(expanded(command()), "Rows still toggle while the option is off");
    assert(localStorage.getItem(toolFoldStorageKey(ids[0])) === savedFold, "Off writes no fold state");
    assert(traceReads === readsDisabled, "Off stops reading traces");
    settingsToggle().pick("开启"); await wait(350);
    assert(expanded(trigger()) && expanded(command()), "Turning the option back on restores the saved fold state");
    passed.push("optional switch");

    await switchSession(ids[1]);
    flushSync(() => { controls.remove(ids[0]); controls.remove(unopenedId); }); await wait(250);
    assert(localStorage.getItem(toolFoldStorageKey(ids[0])) === null, "Removed sessions clean saved fold state");
    assert(localStorage.getItem(toolFoldStorageKey(unopenedId)) === null, "Removed sessions clean state saved before this app launch");
    assert(localStorage.getItem(toolFoldStorageKey(ids[1])) !== null, "Other sessions retain saved fold state");
    passed.push("session removal");

    // Leave a useful final view for visual inspection.
    await openTurn(); await openGroup();
    const result = document.querySelector<HTMLOutputElement>("#check-result")!;
    result.textContent = `PASS ${passed.length}: ${passed.join(", ")}`;
    result.dataset.status = "passed";
  } catch (error) {
    const result = document.querySelector<HTMLOutputElement>("#check-result")!;
    result.textContent = `FAIL after ${passed.join(", ")}: ${String(error)}`;
    result.dataset.status = "failed";
    console.error(error);
  }
}
if (params.has("checks")) void runChecks();
