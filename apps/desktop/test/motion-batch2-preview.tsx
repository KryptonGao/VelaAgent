/** Real renderer components with in-memory state and IPC; safe for repeatable motion checks. */
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { AppState, ConversationSummary, ToolTrace, VelaApi } from "@vela/shared";
import { Sidebar } from "../src/renderer/components/Sidebar";
import { ChatView } from "../src/renderer/components/ChatView";
import { ContextUsageCard, PanelDisclosure } from "../src/renderer/components/ContextPanel";
import { OnboardingView } from "../src/renderer/components/OnboardingView";
import { ToolCard, CompactToolLine } from "../src/renderer/components/ToolCard";
import { ChangesView } from "../src/renderer/components/ChangesView";
import { FilePreviewProvider, useFilePreview } from "../src/renderer/components/preview/FilePreviewContext";
import { CodePane } from "../src/renderer/components/preview/CodePane";
import { usePreferences } from "../src/renderer/hooks/usePreferences";
import type { useModels } from "../src/renderer/hooks/useModels";
import type { ProjectApi } from "../src/renderer/hooks/useProject";
import type { SidebarResize } from "../src/renderer/hooks/useSidebarResize";
import "../src/renderer/styles.css";
import { runBatch2MotionChecks } from "./motion-batch2-checks";

const automated = new URLSearchParams(location.search).has("checks");
const media = Object.assign(new EventTarget(), { matches: false, media: "(prefers-reduced-motion: reduce)" });
const originalMatchMedia = window.matchMedia.bind(window);
if (automated) {
  window.matchMedia = (query) => query === media.media ? media as unknown as MediaQueryList : originalMatchMedia(query);
}
const reducedStyle = document.createElement("style");
function setReducedMotion(value: boolean) {
  // Apply the actual reduced-motion CSS rules alongside the mocked OS preference.
  if (value) {
    reducedStyle.textContent = [...document.styleSheets].flatMap((sheet) => [...sheet.cssRules]
      .filter((rule) => rule instanceof CSSMediaRule && rule.conditionText.includes("prefers-reduced-motion: reduce"))
      .flatMap((rule) => [...(rule as CSSMediaRule).cssRules].map((inner) => inner.cssText))).join("\n");
    document.head.append(reducedStyle);
  } else reducedStyle.remove();
  media.matches = value; media.dispatchEvent(new Event("change"));
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const makeConversation = (id: string, updatedAt: number, cwd = "/workspace/Vela") => ({ id, title: `Chat ${id}`, updatedAt, cwd, archivedAt: null, status: "ready" } as ConversationSummary);
const initial = [makeConversation("a", 3), makeConversation("b", 2), makeConversation("c", 1)];
const usage = { tokens: 15000, contextWindow: 100000, percent: 15, messageCount: 4, toolCallCount: 2,
  segments: { system: 5000, tools: 1000, rules: 1000, skills: 0, conversation: 8000 } };
const models = { catalog: { models: [], providers: [] }, login: { active: false },
  select() {}, setThinking() {}, add() {}, remove() {}, logout() {}, loginProvider() {},
  replyLogin() {}, cancelLogin() {}, dismissLogin() {} } as unknown as ReturnType<typeof useModels>;
const resize = { widths: { left: 250, right: 340, workbench: 500 }, startResize() {}, nudge() {}, reset() {} } as unknown as SidebarResize;
const noopSubscription = () => () => {};
window.vela = {
  platform: "darwin", setLocale() {}, listOpenTargets: async () => [],
  getAgentSettings: async () => ({ provider: null, modelId: null, thinkingLevel: "medium", newConversationSelection: "default", instructions: "" }),
  listSkills: async () => ({ skills: [] }),
  readWorkspaceFile: async (path: string) => { await pause(75); const content = Array.from({ length: 120 }, (_, i) => `${path} line ${i + 1}`).join("\n");
    return { path, absolutePath: `/workspace/Vela/${path}`, kind: "text", content, size: content.length, truncated: false }; },
  listWorkspaceFiles: async () => ({ root: "/workspace/Vela", files: [] }),
  onWorkspaceEvent: noopSubscription, onGitEvent: noopSubscription,
  hydrateAttachments: async () => ["first.txt", "second.txt", "third.txt"].map((name) => ({ path: `/workspace/Vela/${name}`, name, kind: "file", image: null })),
  pickAttachments: async () => ["first.txt", "second.txt", "third.txt"].map((name) => ({ path: `/workspace/Vela/${name}`, name, kind: "file", image: null })),
} as unknown as VelaApi;
const files = ["first.txt", "second.txt"].map((path) => ({ path, status: "modified", indexStatus: null, worktreeStatus: "modified", oldPath: null, addedLines: 1, deletedLines: 1, indexAddedLines: 0, indexDeletedLines: 0, worktreeAddedLines: 1, worktreeDeletedLines: 1 }));
const project = { workspace: { current: "/workspace/Vela", recents: [] }, approval: null, environment: null,
  environments: [], sandboxMode: "ask", git: { repo: { root: "/workspace/Vela", name: "Vela" }, files, branch: "main", addedLines: 2, deletedLines: 2 },
  fileDiff: async (path: string) => { await pause(path === "second.txt" ? 90 : 30); return `@@ -1 +1 @@\n-${path} old\n+${path} new`; },
  openWorkspaceDialog: async () => {}, replyApproval() {}, listBranches: async () => [],
  stageFiles: async () => true, unstageFiles: async () => true, discardFiles: async () => true,
} as unknown as ProjectApi;

function PreviewFixture() {
  const preview = useFilePreview()!;
  useEffect(() => { preview.openFile("first.txt"); }, []);
  Object.assign(window, { batch2Preview: preview });
  return <CodePane onOpenExternal={() => {}} />;
}
function Fixture() {
  const preferences = usePreferences();
  const [conversations, setConversations] = useState(initial);
  const [active, setActive] = useState("a");
  const [streaming, setStreaming] = useState(false);
  const [open, setOpen] = useState(false);
  const [percent, setPercent] = useState(15);
  const [status, setStatus] = useState<ToolTrace["status"]>("running");
  const [changePath, setChangePath] = useState("first.txt");
  const [workspace, setWorkspace] = useState("/workspace/Vela");
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [messages, setMessages] = useState(Array.from({ length: 20 }, (_, i) => ({ id: `${i}`, role: i % 2 ? "assistant" : "user", text: `Message ${i}`, thinking: "", tools: [] })));
  const state = { activeConversationId: active, conversations, session: { id: active, title: `Chat ${active}`, cwd: workspace,
    status: streaming ? "streaming" : "ready", model: "Fixture", modelReady: true, modelProvider: "fixture", modelId: "fixture",
    tools: [], mode: "agent", thinkingLevel: "medium", thinkingLevels: ["medium"] }, context: { ...usage, percent } } as AppState;
  const tool = { id: "tool", name: "read", status, input: { path: "first.txt" }, output: "File read", activity: [] } as unknown as ToolTrace;
  Object.assign(window, { batch2Fixture: {
    conversations: (ids: string[]) => flushSync(() => setConversations(ids.map((id, i) => makeConversation(id, ids.length - i)))),
    active: (id: string) => flushSync(() => setActive(id)), workspace: (value: string) => flushSync(() => setWorkspace(value)),
    disclosure: (value: boolean) => flushSync(() => setOpen(value)), percent: (value: number) => flushSync(() => setPercent(value)),
    streaming: (value: boolean) => flushSync(() => setStreaming(value)), status: (value: ToolTrace["status"]) => flushSync(() => setStatus(value)),
    changePath: (value: string) => flushSync(() => setChangePath(value)),
    append: () => flushSync(() => setMessages((current) => [...current, { id: `new-${current.length}`, role: "assistant", text: "New reply", thinking: "", tools: [] }])),
  } });
  return <div style={{ height: "100vh", display: "flex", background: "var(--bg-chat)" }}>
    <Sidebar collapsed={false} resize={resize} platform="darwin" conversations={conversations} activeConversationId={active}
      settingsOpen={false} settingsLabel="Settings" onToggle={() => {}} onOpenSettings={() => {}}
      onNewChat={() => setConversations((current) => [makeConversation(`new-${current.length}`, Date.now()), ...current])}
      onSwitchConversation={setActive} onArchiveConversation={(id) => setConversations((current) => current.filter((item) => item.id !== id))} />
    <div style={{ flex: 1, minWidth: 0, display: "flex" }}>
      <ChatView messages={messages as never} state={state} project={{ ...project, workspace: { ...project.workspace!, current: workspace } }}
        sendError={null} platform="darwin" leftCollapsed={false} rightCollapsed={false} models={models}
        onToggleLeft={() => {}} onToggleRight={() => {}} onSend={async () => setStreaming(true)} onAbort={async () => setStreaming(false)}
        onMode={() => {}} getQuestion={() => null} onReplyQuestion={() => {}} onBranch={() => {}}
        showNewTab={false} onNewTab={() => {}} onOpenChanges={() => {}} />
    </div>
    <div style={{ width: 390, overflow: "auto", padding: 12 }}>
      <PanelDisclosure title="Disclosure" meta="2" open={open} onToggle={() => setOpen((value) => !value)}><input defaultValue="preserved" /></PanelDisclosure>
      <ContextUsageCard context={{ ...usage, percent }} />
      <ToolCard tool={tool} /><CompactToolLine tool={tool} />
      <div style={{ height: 180, display: "flex" }}><PreviewFixture /></div>
      <div style={{ height: 220 }}><ChangesView project={project} selectedPath={changePath} onSelectedPathChange={setChangePath} onClose={() => {}} /></div>
    </div>
    {!automated ? <button style={{ position: "fixed", top: 12, left: 260, zIndex: 30 }}
      onClick={() => setShowOnboarding((value) => !value)}>{showOnboarding ? "Close onboarding" : "Preview onboarding"}</button> : null}
    <div id="onboarding-fixture" style={{ position: "fixed", left: 20, top: 20, width: 900, height: 620, zIndex: 20, display: showOnboarding ? "block" : "none" }}>
      <OnboardingView preferences={preferences} models={models} initialStep={0} onStepChange={() => {}} onComplete={() => {}} />
    </div>
  </div>;
}
const root = createRoot(document.getElementById("root")!);
root.render(<React.StrictMode><FilePreviewProvider><Fixture /></FilePreviewProvider></React.StrictMode>);
const checksTimer = automated ? setTimeout(() => { void runBatch2MotionChecks(setReducedMotion); }, 700) : undefined;
if (import.meta.hot) import.meta.hot.dispose(() => {
  root.unmount(); window.clearTimeout(checksTimer);
  window.matchMedia = originalMatchMedia;
  reducedStyle.remove(); document.querySelector("#batch2-check-results")?.remove();
});
