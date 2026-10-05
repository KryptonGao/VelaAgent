/** Real sidebar/header/editor with local fixture state; ?fail=1 exercises failed saves. */
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import type { AppState, ConversationSummary, VelaApi } from "@vela/shared";
import { Sidebar } from "../src/renderer/components/Sidebar";
import { ChatView } from "../src/renderer/components/ChatView";
import { RenameConversationDialog } from "../src/renderer/components/RenameConversationDialog";
import { FilePreviewProvider } from "../src/renderer/components/preview/FilePreviewContext";
import type { useModels } from "../src/renderer/hooks/useModels";
import type { ProjectApi } from "../src/renderer/hooks/useProject";
import { AppLocaleProvider, setActiveLocale } from "../src/renderer/locale";
import "../src/renderer/styles.css";

const params = new URLSearchParams(location.search);
setActiveLocale(params.has("en") ? "en" : "zh-CN");
document.documentElement.dataset.scheme = params.get("theme") ?? "light";
const noopSubscription = () => () => {};
window.vela = {
  platform: "darwin", setLocale() {}, listOpenTargets: async () => [],
  listSkills: async () => ({ skills: [] }),
  getAgentSettings: async () => ({ provider: null, modelId: null, thinkingLevel: "medium", newConversationSelection: "default", instructions: "" }),
  onWorkspaceEvent: noopSubscription, onGitEvent: noopSubscription,
  pickAttachments: async () => [], hydrateAttachments: async () => [],
} as unknown as VelaApi;
const models = {
  catalog: { models: [], providers: [] }, login: { active: false }, select() {}, setThinking() {},
  add() {}, remove() {}, logout() {}, loginProvider() {}, replyLogin() {}, cancelLogin() {}, dismissLogin() {},
} as unknown as ReturnType<typeof useModels>;
const project = {
  workspace: { current: "/projects/VelaHarness", recents: [] }, approval: null, environment: null, environments: [],
  sandboxMode: "ask", git: null, openWorkspaceDialog: async () => {}, replyApproval() {}, listBranches: async () => [],
} as unknown as ProjectApi;
const now = Date.now();
const initial: ConversationSummary[] = [
  { id: "a", title: "更强的会话整理与检索", cwd: "/projects/VelaHarness", createdAt: now, updatedAt: now, archivedAt: null, status: "ready", turnCompletedAt: now },
  { id: "b", title: "修复登录页面", cwd: "/projects/VelaHarness", createdAt: now, updatedAt: now - 60_000, archivedAt: null, status: "streaming" },
  { id: "c", title: "Release notes", cwd: "/projects/StudyPulse", createdAt: now, updatedAt: now - 120_000, archivedAt: null, status: "ready" },
  { id: "d", title: "已经归档的检索讨论", cwd: "/projects/VelaHarness", createdAt: now, updatedAt: now, archivedAt: now, status: "ready" },
  { id: "waiting", title: "确认发布范围", cwd: "/projects/StudyPulse", createdAt: now, updatedAt: now - 180_000, archivedAt: null, status: "streaming" },
  { id: "error", title: "检查构建失败", cwd: "/projects/VelaHarness", createdAt: now, updatedAt: now - 240_000, archivedAt: null, status: "error" },
  { id: "yesterday", title: "评估 Windows x86 支持与安装流程", cwd: "C:\\projects\\Desktop", createdAt: now, updatedAt: now - 86_400_000, archivedAt: null, status: "ready" },
  { id: "earlier", title: "优化 README", cwd: "/projects/VelaHarness", createdAt: now, updatedAt: now - 3 * 86_400_000, archivedAt: null, status: "ready" },
];
function Fixture() {
  const [conversations, setConversations] = useState(initial);
  const [activeId, setActiveId] = useState("a");
  const [editing, setEditing] = useState<ConversationSummary | null>(null);
  const active = conversations.find(item => item.id === activeId)!;
  const openRename = (id: string) => setEditing(conversations.find(item => item.id === id)!);
  const state = {
    activeConversationId: activeId, conversations,
    session: {
      id: activeId, title: active.title, cwd: active.cwd, status: active.status, model: "Preview",
      modelReady: true, modelProvider: "preview", modelId: "preview", tools: [], mode: "agent",
      thinkingLevel: "medium", thinkingLevels: ["medium"],
    },
    context: { tokens: 1000, contextWindow: 100000, percent: 1, messageCount: 2, toolCallCount: 0,
      segments: { system: 200, tools: 0, rules: 0, skills: 0, conversation: 800 } },
  } as AppState;
  return <div className="vela-window platform-darwin right-collapsed" style={{ height: "100vh" }}>
    <Sidebar collapsed={false} platform="darwin" resize={{ widths: { left: 248, right: 300, workbench: 500 }, startResize() {}, nudge() {}, reset() {} }}
      conversations={conversations} waitingConversationIds={["waiting"]} activeConversationId={activeId} settingsOpen={false} settingsLabel="设置"
      onToggle={() => {}} onOpenSettings={() => {}} onNewChat={() => {}} onSwitchConversation={setActiveId}
      onArchiveConversation={id => setConversations(items => items.map(item => item.id === id ? { ...item, archivedAt: Date.now() } : item))}
      onRenameConversation={openRename} />
    <ChatView messages={[
      { id: "u", role: "user", text: "先做侧边栏搜索和手动改名。", images: [], thinking: "", tools: [], timestamp: 1, planIds: [] },
      { id: "r", role: "assistant", text: "可以按标题和工作区检索会话，也可以给会话设置便于识别的名称。", images: [], thinking: "", tools: [], timestamp: 2, planIds: [] },
    ] as never} state={state} project={project} sendError={null} platform="darwin" leftCollapsed={false} rightCollapsed
      models={models} onToggleLeft={() => {}} onToggleRight={() => {}} onRenameConversation={openRename}
      onSend={async () => {}} onAbort={async () => {}} onMode={() => {}} getQuestion={() => null}
      onReplyQuestion={() => {}} onBranch={() => {}} showNewTab={false} onNewTab={() => {}} onOpenChanges={() => {}} />
    {editing ? <RenameConversationDialog key={editing.id} conversation={editing} onClose={() => setEditing(null)}
      onSave={async (id, title) => {
        await new Promise(resolve => setTimeout(resolve, 100));
        if (params.has("fail")) throw new Error("会话服务不可用");
        setConversations(items => items.map(item => item.id === id ? { ...item, title } : item));
      }} /> : null}
  </div>;
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode><AppLocaleProvider locale={params.has("en") ? "en" : "zh-CN"}><FilePreviewProvider><Fixture /></FilePreviewProvider></AppLocaleProvider></React.StrictMode>,
);
