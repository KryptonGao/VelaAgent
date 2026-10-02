/** Real renderer components with isolated, deterministic README data. */
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import type { AppState, ConversationSummary, VelaApi } from "@vela/shared";
import { Sidebar } from "../src/renderer/components/Sidebar";
import { ChatView } from "../src/renderer/components/ChatView";
import { WorkbenchPanel, type WorkbenchTab } from "../src/renderer/components/WorkbenchPanel";
import { AgentWorkspaceProvider } from "../src/renderer/components/AgentPanel";
import { FilePreviewProvider } from "../src/renderer/components/preview/FilePreviewContext";
import type { useModels } from "../src/renderer/hooks/useModels";
import type { ProjectApi } from "../src/renderer/hooks/useProject";
import { AppLocaleProvider, setActiveLocale } from "../src/renderer/locale";
import { agents, agentMessages, base, collaborationMessages, compactMessages, cwd, nodes, requests, title, traceDetails } from "./readme-preview-data";
import "../src/renderer/styles.css";

const scene = new URLSearchParams(location.search).get("scene") ?? "compact";
setActiveLocale("zh-CN");
document.documentElement.dataset.scheme = "light";
const noop = () => {};
const noopSubscription = () => noop;
window.vela = {
  platform: "darwin", setLocale: noop, listOpenTargets: async () => [],
  listSkills: async () => ({ skills: [] }),
  getAgentSettings: async () => ({ provider: null, modelId: null, thinkingLevel: "high", newConversationSelection: "default", instructions: "" }),
  onWorkspaceEvent: noopSubscription, onGitEvent: noopSubscription, onEvent: noopSubscription,
  pickAttachments: async () => [], hydrateAttachments: async () => [],
  getTrace: async () => ({ version: nodes.length, nodes, requests, summaries: [], warning: null }),
  getTraceDetails: async (_conversationId: string, id: string) => {
    const node = nodes.find(node => node.id === id);
    return node ? traceDetails(node) : null;
  },
} as unknown as VelaApi;
const models = {
  catalog: { models: [], providers: [], error: null }, login: { active: false }, select: noop, setThinking: noop,
  add: noop, remove: noop, logout: noop, loginProvider: noop, replyLogin: noop, cancelLogin: noop, dismissLogin: noop,
} as unknown as ReturnType<typeof useModels>;
const project = {
  workspace: { current: cwd, recents: [] }, approval: null, environment: { kind: "local", label: "本地", path: cwd, available: true },
  environments: [], sandboxMode: "ask", git: null, openWorkspaceDialog: async () => {}, replyApproval: noop, listBranches: async () => [],
} as unknown as ProjectApi;
const conversations: ConversationSummary[] = [title, "为项目列表添加搜索", "整理组件库文档"].map((title, i) => ({
  id: `demo-${i}`, title, cwd, status: "ready", createdAt: base - i * 3600000, updatedAt: base - i * 3600000, archivedAt: null,
}));
const resize = { widths: { left: 216, right: 300, workbench: 520 }, startResize: noop, nudge: noop, reset: noop };
const state: AppState = {
  activeConversationId: "demo-0", conversations, agents: scene === "subagents" ? agents : [],
  session: {
    id: "demo-0", title, cwd, status: "ready", model: "Demo Model", modelProvider: "demo", modelId: "demo-model", modelReady: true,
    tools: ["read", "edit", "bash", "spawn_agent", "send_message", "followup_task"], mode: "agent", thinkingLevel: "high", thinkingLevels: ["off", "low", "medium", "high"],
    proposedPlan: null, planRevisions: [], executionPlan: null, goal: null, error: null,
  },
  context: { tokens: 18400, contextWindow: 128000, percent: 14.375, messageCount: 6, toolCallCount: 7, turnCount: 1, stepCount: 5,
    segments: { system: 2400, tools: 1800, rules: 600, skills: 0, conversation: 13600 }, sessionTokens: 61600, cacheHitRate: 0.8, outputSpeed: 132 },
};
function Fixture() {
  const [tabs, setTabs] = useState<WorkbenchTab[]>(scene === "subagents" ? agents.slice(1).map(agent => ({
    id: agent.id, kind: "agent", label: agent.name, title: agent.path, agent,
  })) : []);
  const [activeId, setActiveId] = useState<string | null>(scene === "subagents" ? "auth" : null);
  const openAgent = (id: string) => {
    const agent = agents.find(agent => agent.id === id);
    if (!agent) return;
    setTabs(items => items.some(item => item.id === id) ? items : [...items, { id, kind: "agent", label: agent.name, title: agent.path, agent }]);
    setActiveId(id);
  };
  return <div className="vela-window platform-darwin right-collapsed" style={{ height: "100vh", "--sidebar-left-width": "216px", "--workbench-width": "520px" } as React.CSSProperties}>
    <Sidebar collapsed={false} platform="darwin" resize={resize}
      conversations={conversations} activeConversationId="demo-0" settingsOpen={false} settingsLabel="设置"
      onToggle={noop} onOpenSettings={noop} onNewChat={noop} onSwitchConversation={noop} onArchiveConversation={noop} onRenameConversation={noop} />
    <div className="main-stage"><div className="main-stage-pane">
      <AgentWorkspaceProvider agents={state.agents ?? []} activeAgentId={activeId} openAgent={openAgent} closeAgent={() => setActiveId(null)}>
        <ChatView messages={scene === "subagents" ? collaborationMessages : compactMessages} state={state} project={project}
          sendError={null} platform="darwin" leftCollapsed={false} rightCollapsed floatingInfo environmentCollapsed toolDisplay="compact" toolFold="message"
          models={models} onToggleLeft={noop} onToggleRight={noop} onRenameConversation={noop}
          onSend={async () => {}} onAbort={async () => {}} onMode={noop} getQuestion={() => null} onReplyQuestion={noop}
          onBranch={noop} showNewTab={tabs.length === 0} onNewTab={noop} onOpenChanges={noop} />
      </AgentWorkspaceProvider>
      <WorkbenchPanel tabs={tabs} activeTabId={activeId} contextOpen={false} leftOpen resize={resize} project={project}
        busy={false} execution={null} onRevise={noop} onExecutePlan={noop} initialDiffPath={null} initialDiffPathRequestKey={0}
        selectedChangePath={null} onSelectedChangePath={noop} onShowDiff={noop} agents={agents} getAgentMessages={id => agentMessages[id] ?? []}
        conversationId="demo-0" toolDisplay="compact" ensureAgentMessages={noop} onOpenAgent={openAgent} onNewTab={noop}
        onStartAction={noop} gitAvailable={false} onActivateTab={tab => setActiveId(tab.id)}
        onCloseTab={tab => { setTabs(items => items.filter(item => item.id !== tab.id)); setActiveId(tabs.find(item => item.id !== tab.id)?.id ?? null); }} />
    </div></div>
  </div>;
}
createRoot(document.getElementById("root")!).render(
  <AppLocaleProvider locale="zh-CN"><FilePreviewProvider><Fixture /></FilePreviewProvider></AppLocaleProvider>,
);
