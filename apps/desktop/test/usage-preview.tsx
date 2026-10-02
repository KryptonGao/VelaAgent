/** Real chat tabs and live trace subscription; ?theme=dark, ?width=480, ?en, ?scenario=empty|error|unmetered. */
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { AppState, TraceRequest, TraceSnapshot, VelaApi } from "@vela/shared";
import { ChatView } from "../src/renderer/components/ChatView";
import { SettingsView } from "../src/renderer/components/SettingsView";
import { usePreferences } from "../src/renderer/hooks/usePreferences";
import { FilePreviewProvider } from "../src/renderer/components/preview/FilePreviewContext";
import type { useModels } from "../src/renderer/hooks/useModels";
import type { ProjectApi } from "../src/renderer/hooks/useProject";
import { AppLocaleProvider, setActiveLocale, tr } from "../src/renderer/locale";
import "../src/renderer/styles.css";

const params = new URLSearchParams(location.search);
const locale = params.has("en") ? "en" : "zh-CN";
setActiveLocale(locale);
document.documentElement.dataset.scheme = params.get("theme") ?? "light";
type SessionEvent = Parameters<Parameters<VelaApi["onEvent"]>[0]>[0];
const listeners = new Set<(event: SessionEvent) => void>();
const requests: TraceRequest[] = Array.from({ length: 347 }, (_, index) => {
  const model = index < 277 ? "openai-codex/gpt-6.1-sol" : index < 335 ? "opencode-go/deepseek-v4.1-flash" : "openai-codex/gpt-6-luna";
  return {
    id: `request-${index + 1}`, number: index + 1, turn: 1, model, contextId: "context", status: "Completed",
    startedAt: new Date(2026, 9, 2, 8, 0).getTime() + index * 1000,
    completedAt: new Date(2026, 9, 2, 8, 0).getTime() + (index + 1) * 1000,
    durationMs: 1000, firstTokenMs: 300, generationMs: 700,
    usage: index < 6 || params.get("scenario") === "unmetered" ? null : {
      input: 6000, output: 480, cacheRead: index < 277 ? 97000 : index < 335 ? 220000 : 10000,
      cacheWrite: 1000, totalTokens: index < 277 ? 104480 : index < 335 ? 227480 : 17480,
    },
  };
});
let version = 1;
const summaryRequests = Array.from({ length: 24 }, (_, index) => ({
  id: `summary-${index + 1}`, model: "openai-codex/gpt-6.1-sol", status: "Completed" as const,
  startedAt: new Date(2026, 9, 2, 9, 0).getTime() + index * 60_000,
  completedAt: new Date(2026, 9, 2, 9, 0).getTime() + index * 60_000 + 1800,
  durationMs: 1800,
  usage: index < 2 || params.get("scenario") === "unmetered" ? null : {
    input: 900, output: 120, cacheRead: 6400, cacheWrite: 300, totalTokens: 7420,
  },
}));
const snapshot = (id: string): TraceSnapshot => ({ version, nodes: [], requests: structuredClone(
  id === "empty" || params.get("scenario") === "empty" ? [] : !params.has("settings") ? requests
    : id === "archived" ? requests.slice(277, 335) : [...requests.slice(0, 277), ...requests.slice(335)]),
  summaries: structuredClone(id === "empty" || params.get("scenario") === "empty" ? [] : summaryRequests), warning: null });
const noopSubscription = () => () => {};
window.vela = {
  platform: "darwin", setLocale() {}, listOpenTargets: async () => [],
  listSkills: async () => ({ skillsDir: "/preview/skills", skills: [], diagnostics: [] }),
  getAgentSettings: async () => ({ provider: null, modelId: null, thinkingLevel: "medium", newConversationSelection: "default", instructions: "" }),
  onWorkspaceEvent: noopSubscription, onGitEvent: noopSubscription,
  onEvent(listener: (event: SessionEvent) => void) { listeners.add(listener); return () => listeners.delete(listener); },
  getTrace: async (id: string) => {
    if (params.get("scenario") === "error") throw new Error("Preview trace unavailable");
    return snapshot(id);
  },
  pickAttachments: async () => [], hydrateAttachments: async () => [],
} as unknown as VelaApi;
const models = {
  catalog: { models: [], providers: [{ id: "openai-codex", name: "OpenAI (Codex login)", methods: [] }, { id: "opencode-go", name: "OpenCode Go", methods: [] }] },
  login: { active: false }, select() {}, setThinking() {},
} as unknown as ReturnType<typeof useModels>;
const project = {
  workspace: { current: "/projects/VelaAgent", recents: [] }, approval: null, environment: null, environments: [],
  sandboxMode: "ask", git: null, openWorkspaceDialog: async () => {}, replyApproval() {}, listBranches: async () => [],
} as unknown as ProjectApi;

function Fixture() {
  const preferences = usePreferences();
  useEffect(() => { document.documentElement.dataset.scheme = params.get("theme") ?? "light"; }, []);
  const [conversationId, setConversationId] = useState("sample");
  const state = {
    activeConversationId: conversationId, conversations: [],
    context: { tokens: 0, contextWindow: 100000, percent: 0, messageCount: 0, toolCallCount: 0, turnCount: 0,
      segments: { system: 0, tools: 0, rules: 0, skills: 0, conversation: 0 } },
    session: { id: conversationId, title: tr("使用统计预览", "Usage preview"), cwd: "/projects/VelaAgent", status: "ready", model: "Preview",
      modelReady: true, modelProvider: "preview", modelId: "preview", tools: [], mode: "agent", thinkingLevel: "medium", thinkingLevels: ["medium"] },
  } as unknown as AppState;
  return <div style={{ display: "flex", flexDirection: "column", height: "100vh", width: params.get("width") ? `${Number(params.get("width"))}px` : "100%", maxWidth: "100%" }}>
    <div style={{ display: "flex", gap: 8, padding: 8, flexShrink: 0, background: "var(--bg-surface-subtle)" }}>
      <button onClick={() => setConversationId(id => id === "sample" ? "empty" : "sample")}>{tr("切换测试对话", "Switch test conversation")}</button>
      <button onClick={() => {
        const request = requests[0]!;
        request.usage = { input: 100, output: 50, cacheRead: 800, cacheWrite: 100, totalTokens: 1050 };
        version++;
        listeners.forEach(listener => listener({ type: "trace", conversationId: "sample", ...snapshot("sample"), requests: [request] }));
      }}>{tr("模拟用量更新", "Simulate usage update")}</button>
    </div>
    {params.has("settings") ? <SettingsView preferences={{ ...preferences, locale }} platform="darwin" models={models} project={project}
      conversations={[
        { id: "sample", title: "Sample", cwd: "/projects/VelaAgent", createdAt: Date.now(), updatedAt: Date.now(), status: "ready", archivedAt: null },
        { id: "archived", title: "Archived", cwd: "/projects/VelaAgent", createdAt: Date.now(), updatedAt: Date.now(), status: "ready", archivedAt: Date.now() },
      ]} onUnarchiveConversation={() => {}} onClose={() => {}} /> : <ChatView messages={[]} state={state} project={project} sendError={null} platform="darwin" leftCollapsed rightCollapsed
      models={models} onToggleLeft={() => {}} onToggleRight={() => {}} onSend={async () => {}} onAbort={async () => {}}
      onMode={() => {}} getQuestion={() => null} onReplyQuestion={() => {}} onBranch={() => {}}
      showNewTab={false} onNewTab={() => {}} onOpenChanges={() => {}} />}
  </div>;
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode><AppLocaleProvider locale={locale}><FilePreviewProvider><Fixture /></FilePreviewProvider></AppLocaleProvider></React.StrictMode>,
);
