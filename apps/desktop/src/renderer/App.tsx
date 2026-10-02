import { uiStorage } from "./ui-storage";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentInfo } from "@vela/shared";
import { AgentWorkspaceProvider } from "./components/AgentPanel";
import { SessionChatView } from "./components/SessionChatView";
import { ContextPanel } from "./components/ContextPanel";
import { FileIconThemeProvider } from "./components/FileTypeIcon";
import { OnboardingView } from "./components/OnboardingView";
import { PlanDocumentProvider } from "./components/PlanPanel";
import { ScreenPresence } from "./components/MotionPresence";
import { Presence } from "./components/Presence";
import { SettingsView } from "./components/SettingsView";
import { Sidebar } from "./components/Sidebar";
import { RenameConversationDialog } from "./components/RenameConversationDialog";
import { FilePreviewProvider, type PreviewFileDescriptor } from "./components/preview/FilePreviewContext";
import type { StartTabAction } from "./components/StartView";
import { WorkbenchPanel, type WorkbenchTab } from "./components/WorkbenchPanel";
import { useModels } from "./hooks/useModels";
import { usePreferences } from "./hooks/usePreferences";
import { isBoolean, useStoredState } from "./hooks/useStoredState";
import { useProject } from "./hooks/useProject";
import { useSession, type UiMessage } from "./hooks/useSession";
import { useSidebarResize } from "./hooks/useSidebarResize";
import { useTurnReview } from "./hooks/useTurnReview";
import type { TurnReviewRequest } from "./components/turn-changes";
import {
  emptyPlanDocumentState,
  planDocumentReducer,
  type PlanDocumentAction,
  type PlanDocumentState,
} from "./plan-draft";
import { AppLocaleProvider, setActiveLocale, tr } from "./locale";

const onboardingCompleteKey = "vela.onboarding.complete";
const onboardingStepKey = "vela.onboarding.step";

function scopedTabId(kind: string, scope: string, id = ""): string {
  return `${kind}:${encodeURIComponent(scope)}${id ? `:${encodeURIComponent(id)}` : ""}`;
}

function fileTabId(workspaceKey: string, fileId: string): string {
  return scopedTabId("file", workspaceKey, fileId);
}

const filesTabId = "files";

function readOnboardingComplete(): boolean {
  try {
    return uiStorage.getItem(onboardingCompleteKey) === "true";
  } catch {
    return false;
  }
}

function readOnboardingStep(): number {
  try {
    const value = Number(uiStorage.getItem(onboardingStepKey));
    return Number.isInteger(value) && value >= 0 && value <= 6 ? value : 0;
  } catch {
    return 0;
  }
}

/**
 * 从已渲染的工具记录里还原一个已结束子代理的快照。
 * agent 树只在内存里，应用重启后点击历史卡片时用它让 Agent Pane 仍能打开。
 */
function findAgentInMessages(messages: UiMessage[], agentId: string): AgentInfo | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const tools = messages[index]?.tools ?? [];
    for (const tool of tools) {
      const activity = tool.activity;
      if (activity?.agentId !== agentId) continue;
      const path = activity.agentPath ?? tool.name;
      const name = path.split("/").filter(Boolean).pop() ?? path;
      return {
        id: agentId,
        parentId: null,
        path,
        name,
        kind: activity.agent ?? "general",
        status: tool.status === "running" ? "running" : tool.status === "error" ? "failed" : "completed",
        depth: 1,
        task: "",
        steps: activity.steps ?? [],
        mutated: activity.mutated === true,
        finalText: tool.activity.body ?? null,
        error: null,
        createdAt: 0,
        updatedAt: 0,
      };
    }
  }
  return null;
}

export function App() {
  const session = useSession();
  const [renamingConversation, setRenamingConversation] = useState<{ id: string; title: string } | null>(null);
  const openRenameConversation = useCallback((id: string) => {
    const conversation = session.conversations.find(item => item.id === id);
    if (conversation) setRenamingConversation({ id, title: conversation.title });
  }, [session.conversations]);
  const models = useModels(session.setAppState);
  const project = useProject();
  const preferences = usePreferences();
  setActiveLocale(preferences.locale);
  const [leftCollapsed, setLeftCollapsed] = useStoredState("vela.leftCollapsed", false, isBoolean);
  // Keep the conversation as the default focus; open the inspector when a tool
  // preview or workspace-change action needs it.
  const [rightCollapsed, setRightCollapsed] = useStoredState("vela.rightCollapsed", true, isBoolean);
  const floatingInfo = preferences.infoLayout === "floating";
  const contextSidebarOpen = !floatingInfo && !rightCollapsed;
  const [environmentCollapsed, setEnvironmentCollapsed] = useStoredState("vela.environmentCollapsed", false, isBoolean);
  const toggleInfo = useCallback(() => {
    if (floatingInfo) setEnvironmentCollapsed(value => !value);
    else setRightCollapsed(value => !value);
  }, [floatingInfo]);
  const resize = useSidebarResize(!leftCollapsed, contextSidebarOpen, floatingInfo);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const workspaceKey = project.workspace?.current ?? "";
  const conversationKey = session.activeConversationId ?? "";
  const { review: turnReview, tabId: turnReviewTabId, open: showTurnReview, close: dismissTurnReview } = useTurnReview(workspaceKey, conversationKey);
  const [fileTabsByWorkspace, setFileTabsByWorkspace] = useState<Record<string, PreviewFileDescriptor[]>>({});
  const fileWorkspaceRef = useRef<string | null>(null);
  const [changesByWorkspace, setChangesByWorkspace] = useState<Record<string, {
    open: boolean;
    initialPath: string | null;
    requestKey: number;
  }>>({});
  const [selectedChangePaths, setSelectedChangePaths] = useState<Record<string, string | null>>({});
  const [dismissedAgentsByConversation, setDismissedAgentsByConversation] = useState<Record<string, string[]>>({});
  const [planDocuments, setPlanDocuments] = useState<Record<string, PlanDocumentState>>({});
  const planDocument = planDocuments[conversationKey] ?? emptyPlanDocumentState;
  const [tabOrder, setTabOrder] = useState<string[]>([]);
  const [activeWorkbenchTabId, setActiveWorkbenchTabId] = useState<string | null>(null);
  const [startTabState, setStartTabState] = useState<{ id: string }[]>([]);
  // 终端与文件浏览标签不按工作区拆开存:工作区状态加载前(地址为空)创建的标签
  // 不能因为工作区地址随后确定而消失;真正切换工作区时再统一关闭。
  const [terminalTabState, setTerminalTabState] = useState<{ id: string; sessionId: string; label: string }[]>([]);
  const [filesTabOpen, setFilesTabOpen] = useState(false);
  const lastKnownWorkspace = useRef("");
  const tabSeq = useRef(0);
  const lastOpenedPlanFocusNonce = useRef<number | null>(null);
  const [onboardingComplete, setOnboardingComplete] = useState(readOnboardingComplete);
  const [onboardingStep, setOnboardingStep] = useState(readOnboardingStep);
  const platform = window.vela?.platform ?? "darwin";
  const toggleLeft = useCallback(() => setLeftCollapsed(value => !value), [setLeftCollapsed]);
  const replyQuestion = useCallback((id: string, answer: string | null) => { void session.replyQuestion(id, answer); }, [session.replyQuestion]);
  const branchTurn = useCallback((index: number) => { void session.branch(index); }, [session.branch]);
  const dispatchPlanDocument = useCallback((action: PlanDocumentAction) => {
    setPlanDocuments((current) => ({
      ...current,
      [conversationKey]: planDocumentReducer(current[conversationKey] ?? emptyPlanDocumentState, action),
    }));
  }, [conversationKey]);

  const allAgents = useMemo(() => {
    const byId = new Map<string, AgentInfo>();
    for (const agent of session.agents) {
      if (agent.kind !== "root") byId.set(agent.id, agent);
    }
    for (const message of session.agentHistory) {
      for (const tool of message.tools) {
        const id = tool.activity?.agentId;
        if (!id || byId.has(id)) continue;
        const restored = findAgentInMessages(session.agentHistory, id);
        if (restored) byId.set(id, restored);
      }
    }
    return [...byId.values()];
  }, [session.agents, session.agentHistory]);

  const openPlan = useCallback((planId: string) => {
    dispatchPlanDocument({ type: "open", planId });
    setActiveWorkbenchTabId(scopedTabId("plan", conversationKey));
  }, [conversationKey, dispatchPlanDocument]);

  const closePlan = useCallback(() => dispatchPlanDocument({ type: "close" }), [dispatchPlanDocument]);
  const selectPlanRevision = useCallback(
    (planId: string) => dispatchPlanDocument({ type: "select", planId }),
    [dispatchPlanDocument],
  );

  const openAgentPane = useCallback((agentId: string) => {
    setDismissedAgentsByConversation((current) => ({
      ...current,
      [conversationKey]: (current[conversationKey] ?? []).filter((id) => id !== agentId),
    }));
    setActiveWorkbenchTabId(scopedTabId("agent", conversationKey, agentId));
  }, [conversationKey]);

  const openChanges = useCallback((path?: string) => {
    setChangesByWorkspace((current) => {
      const existing = current[workspaceKey] ?? { open: false, initialPath: null, requestKey: 0 };
      return {
        ...current,
        [workspaceKey]: { open: true, initialPath: path ?? null, requestKey: existing.requestKey + 1 },
      };
    });
    setActiveWorkbenchTabId(scopedTabId("changes", workspaceKey));
  }, [workspaceKey]);

  const onReviewTurn = useCallback((request: TurnReviewRequest) => {
    showTurnReview(request);
    setActiveWorkbenchTabId(turnReviewTabId);
  }, [showTurnReview, turnReviewTabId]);

  const onOpenFile = useCallback((file: PreviewFileDescriptor) => {
    fileWorkspaceRef.current = workspaceKey;
    setFileTabsByWorkspace((current) => {
      const files = current[workspaceKey] ?? [];
      const index = files.findIndex((item) => item.id === file.id);
      if (index < 0) return { ...current, [workspaceKey]: [...files, file] };
      return { ...current, [workspaceKey]: files.map((item, itemIndex) => itemIndex === index ? file : item) };
    });
    const id = fileTabId(workspaceKey, file.id);
    setTabOrder((current) => current.includes(id) ? current : [...current, id]);
    setActiveWorkbenchTabId(id);
  }, [workspaceKey]);

  const onCloseFileTab = useCallback((fileId: string) => {
    const owner = fileWorkspaceRef.current ?? workspaceKey;
    const id = fileTabId(owner, fileId);
    setFileTabsByWorkspace((current) => ({
      ...current,
      [owner]: (current[owner] ?? []).filter((file) => file.id !== fileId),
    }));
    setActiveWorkbenchTabId((current) => current === id ? null : current);
  }, [workspaceKey]);

  const onCloseAllFileTabs = useCallback((fileIds: string[]) => {
    const owner = fileWorkspaceRef.current ?? workspaceKey;
    const ids = new Set(fileIds);
    setFileTabsByWorkspace((current) => ({
      ...current,
      [owner]: (current[owner] ?? []).filter((file) => fileIds.length > 0 && !ids.has(file.id)),
    }));
    setActiveWorkbenchTabId((current) => {
      if (!current) return current;
      return fileIds.some((fileId) => current === fileTabId(owner, fileId)) ? null : current;
    });
    fileWorkspaceRef.current = null;
  }, [workspaceKey]);

  /** 新建起始标签页;⌘T 和标签栏的 + 都走这里。 */
  const openStartTab = useCallback(() => {
    tabSeq.current += 1;
    const id = `start:${tabSeq.current}`;
    setStartTabState((current) => current.some((tab) => tab.id === id) ? current : [...current, { id }]);
    setActiveWorkbenchTabId(id);
  }, []);

  const openTerminalTab = useCallback(() => {
    tabSeq.current += 1;
    const sessionId = `term-${tabSeq.current}`;
    const id = `terminal:${sessionId}`;
    setTerminalTabState((current) => [
      ...current,
      { id, sessionId, label: tr(`终端 ${current.length + 1}`, `Terminal ${current.length + 1}`) },
    ]);
    setActiveWorkbenchTabId(id);
  }, []);

  const openFilesTab = useCallback(() => {
    setFilesTabOpen(true);
    setActiveWorkbenchTabId(filesTabId);
  }, []);

  /** 起始页选好入口后关闭起始标签,换成对应内容。 */
  const handleStartAction = useCallback((tab: WorkbenchTab, action: StartTabAction) => {
    setStartTabState((current) => current.filter((candidate) => candidate.id !== tab.id));
    if (action === "changes") openChanges();
    else if (action === "terminal") openTerminalTab();
    else openFilesTab();
  }, [openChanges, openTerminalTab, openFilesTab]);

  const fileTabs = useMemo<WorkbenchTab[]>(() => (fileTabsByWorkspace[workspaceKey] ?? []).map((file) => ({
    id: fileTabId(workspaceKey, file.id),
    kind: "file",
    label: file.name,
    title: file.path,
    path: file.id,
  })), [fileTabsByWorkspace, workspaceKey]);
  const changesState = useMemo(
    () => changesByWorkspace[workspaceKey] ?? { open: false, initialPath: null, requestKey: 0 },
    [changesByWorkspace, workspaceKey],
  );
  const changeTab = useMemo<WorkbenchTab | null>(() => changesState.open
    ? { id: scopedTabId("changes", workspaceKey), kind: "changes", label: tr("变更", "Changes") }
    : null, [changesState.open, workspaceKey]);
  const planTab = useMemo<WorkbenchTab | null>(() => planDocument.activePlanId
    ? { id: scopedTabId("plan", conversationKey), kind: "plan", label: tr("计划", "Plan") }
    : null, [planDocument.activePlanId, conversationKey]);
  const reviewTab = useMemo<WorkbenchTab | null>(() => turnReview
    ? { id: turnReviewTabId, kind: "turn-review", label: tr("变更审查", "Change review"), review: turnReview }
    : null, [turnReview, turnReviewTabId, preferences.locale]);
  const agentTabs = useMemo<WorkbenchTab[]>(() => {
    const dismissedAgentIds = new Set(dismissedAgentsByConversation[conversationKey] ?? []);
    return allAgents.filter((agent) => !dismissedAgentIds.has(agent.id)).map((agent) => ({
      id: scopedTabId("agent", conversationKey, agent.id),
      kind: "agent",
      label: agent.name,
      title: agent.path,
      agent,
    }));
  }, [allAgents, dismissedAgentsByConversation, conversationKey]);
  const terminalTabs = useMemo<WorkbenchTab[]>(() => terminalTabState.map((tab) => ({
    id: tab.id,
    kind: "terminal",
    label: tab.label,
    sessionId: tab.sessionId,
  })), [terminalTabState]);
  const filesTab = useMemo<WorkbenchTab | null>(() => filesTabOpen
    ? { id: filesTabId, kind: "files", label: tr("文件", "Files") }
    : null, [filesTabOpen]);
  const startTabItems = useMemo<WorkbenchTab[]>(() => startTabState.map((tab) => ({
    id: tab.id,
    kind: "start",
    label: tr("新标签页", "New tab"),
  })), [startTabState]);
  const unorderedTabs = useMemo<WorkbenchTab[]>(() => [
    ...fileTabs,
    ...(planTab ? [planTab] : []),
    ...(changeTab ? [changeTab] : []),
    ...(reviewTab ? [reviewTab] : []),
    ...agentTabs,
    ...(filesTab ? [filesTab] : []),
    ...terminalTabs,
    ...startTabItems,
  ], [fileTabs, planTab, changeTab, reviewTab, agentTabs, filesTab, terminalTabs, startTabItems]);
  const workbenchTabs = useMemo(() => {
    const tabIdSet = new Set(unorderedTabs.map((tab) => tab.id));
    return [
      ...tabOrder.filter((id) => tabIdSet.has(id)).map((id) => unorderedTabs.find((tab) => tab.id === id)!),
      ...unorderedTabs.filter((tab) => !tabOrder.includes(tab.id)),
    ];
  }, [tabOrder, unorderedTabs]);
  const activeWorkbenchTab = workbenchTabs.find((tab) => tab.id === activeWorkbenchTabId) ?? null;

  useEffect(() => {
    const liveIds = new Set(unorderedTabs.map((tab) => tab.id));
    setTabOrder((current) => {
      const retained = current.filter((id) => liveIds.has(id));
      const next = [
        ...retained,
        ...unorderedTabs.filter((tab) => !retained.includes(tab.id)).map((tab) => tab.id),
      ];
      // 依赖恒定时返回原引用,避免 effect 里 setState 造成渲染死循环。
      const unchanged =
        next.length === current.length && next.every((id, index) => current[index] === id);
      return unchanged ? current : next;
    });
  }, [unorderedTabs]);

  useEffect(() => {
    if (activeWorkbenchTabId && workbenchTabs.some((tab) => tab.id === activeWorkbenchTabId)) return;
    setActiveWorkbenchTabId(workbenchTabs.at(-1)?.id ?? null);
  }, [activeWorkbenchTabId, workbenchTabs]);

  // 真正切换工作区后旧目录的终端已失效,连同文件浏览标签一起关闭;
  // 启动时 "" → 工作区地址只是状态尚未到位,保留已有标签。
  useEffect(() => {
    const previous = lastKnownWorkspace.current;
    lastKnownWorkspace.current = workspaceKey;
    if (!previous || previous === workspaceKey) return;
    setTerminalTabState([]);
    setFilesTabOpen(false);
  }, [workspaceKey]);

  // 启动瞬间打开的文件/变更标签会先落在 "" 作用域;工作区地址确定后归到真实 key,
  // 否则标签会因为工作区 key 变化而消失。
  useEffect(() => {
    if (!workspaceKey) return;
    const adopt = <T,>(record: Record<string, T>): Record<string, T> => {
      if (!("" in record)) return record;
      const { "": pending, ...rest } = record;
      return { ...rest, [workspaceKey]: pending };
    };
    setFileTabsByWorkspace(adopt);
    setChangesByWorkspace(adopt);
    setSelectedChangePaths(adopt);
  }, [workspaceKey]);

  const openAllChanges = useCallback(() => openChanges(), [openChanges]);

  const closeActiveAgent = useCallback(() => {
    if (activeWorkbenchTab?.kind === "agent") {
      setDismissedAgentsByConversation((current) => ({
        ...current,
        [conversationKey]: [...new Set([...(current[conversationKey] ?? []), activeWorkbenchTab.agent.id])],
      }));
      setActiveWorkbenchTabId(null);
    }
  }, [activeWorkbenchTab, conversationKey]);

  const closeWorkbenchTab = useCallback((tab: WorkbenchTab) => {
    const index = workbenchTabs.findIndex((candidate) => candidate.id === tab.id);
    const neighbor = workbenchTabs[index + 1] ?? workbenchTabs[index - 1] ?? null;
    setActiveWorkbenchTabId((current) => current === tab.id ? neighbor?.id ?? null : current);
    setTabOrder((current) => current.filter((id) => id !== tab.id));
    if (tab.kind === "plan") {
      dispatchPlanDocument({ type: "close" });
    } else if (tab.kind === "changes") {
      setChangesByWorkspace((current) => ({
        ...current,
        [workspaceKey]: { ...changesState, open: false },
      }));
      setSelectedChangePaths((current) => ({ ...current, [workspaceKey]: null }));
    } else if (tab.kind === "turn-review") {
      dismissTurnReview();
    } else if (tab.kind === "agent") {
      setDismissedAgentsByConversation((current) => ({
        ...current,
        [conversationKey]: [...new Set([...(current[conversationKey] ?? []), tab.agent.id])],
      }));
    } else if (tab.kind === "terminal") {
      setTerminalTabState((current) => current.filter((candidate) => candidate.id !== tab.id));
    } else if (tab.kind === "files") {
      setFilesTabOpen(false);
    } else if (tab.kind === "start") {
      setStartTabState((current) => current.filter((candidate) => candidate.id !== tab.id));
    }
  }, [workbenchTabs, dispatchPlanDocument, workspaceKey, changesState, conversationKey, dismissTurnReview]);

  const workbenchOpen = workbenchTabs.length > 0;
  const previousWorkbenchOpen = useRef(false);
  useEffect(() => {
    // Only the opening edge folds the card; a manual expansion stays open.
    const open = floatingInfo && workbenchOpen;
    if (open && !previousWorkbenchOpen.current) setEnvironmentCollapsed(true);
    previousWorkbenchOpen.current = open;
  }, [floatingInfo, workbenchOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!onboardingComplete) return;
      if (document.querySelector(".rename-conversation-dialog[open], .conversation-search-dialog[open]")) return;
      if (event.key === "Escape") {
        // 对话框和输入框各自处理 Esc,只有停在设置页本身时才关闭设置。
        if (event.isComposing || document.querySelector(".sheet-presence")) return;
        if (event.target instanceof HTMLElement && event.target.closest("input, textarea, select")) return;
        setSettingsOpen(false);
        return;
      }
      const mod = platform === "darwin" ? event.metaKey : event.ctrlKey;
      if (!mod) return;
      const key = event.key.toLowerCase();
      if (key === "b") {
        event.preventDefault();
        setLeftCollapsed((value) => !value);
      } else if (key === "j") {
        event.preventDefault();
        toggleInfo();
      } else if (key === "t") {
        event.preventDefault();
        openStartTab();
      } else if (event.code === "Comma") {
        event.preventDefault();
        setSettingsOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onboardingComplete, platform, openStartTab, toggleInfo]);

  useEffect(() => {
    // <proposed_plan> 开始生成时自动打开 Plan Document，正文实时填入。
    if (!session.planFocus || lastOpenedPlanFocusNonce.current === session.planFocus.nonce) return;
    lastOpenedPlanFocusNonce.current = session.planFocus.nonce;
    openPlan(session.planFocus.planId);
  }, [session.planFocus, openPlan]);

  useEffect(() => {
    const vela = window.vela;
    if (!vela) return;
    // 应用菜单的「新建会话/设置」经主进程转发到这里,行为与侧边栏按钮一致。
    return vela.onMenuAction((action) => {
      if (!onboardingComplete) return;
      if (action === "new-chat") {
        setSettingsOpen(false);
        void session.newChat();
      } else {
        setSettingsOpen((open) => !open);
      }
    });
  }, [onboardingComplete, session.newChat]);

  useEffect(() => {
    window.vela?.setLocale(preferences.locale);
  }, [preferences.locale]);

  if (!session.available) {
    return (
      <div className="boot-fallback">
        <p>{tr("Vela 需要在桌面窗口中运行。", "Vela must run in the desktop app.")}</p>
      </div>
    );
  }

  return (
    <FileIconThemeProvider value={preferences.fileIconTheme}>
      <AppLocaleProvider locale={preferences.locale}>
        <div className="app-screens">
          <ScreenPresence present={!onboardingComplete} className="app-screen-onboarding">
            <div className={`vela-window platform-${platform} onboarding-window`}>
              <OnboardingView
                preferences={preferences}
                models={models}
                initialStep={onboardingStep}
                onStepChange={(step) => {
                  setOnboardingStep(step);
                  try {
                    uiStorage.setItem(onboardingStepKey, String(step));
                  } catch {
                    // Keep onboarding usable when local storage is unavailable.
                  }
                }}
                onComplete={() => {
                  setOnboardingComplete(true);
                  setSettingsOpen(false);
                  try {
                    uiStorage.setItem(onboardingCompleteKey, "true");
                    uiStorage.removeItem(onboardingStepKey);
                  } catch {
                    // Completion applies for this run even if storage is unavailable.
                  }
                }}
              />
            </div>
          </ScreenPresence>
          <ScreenPresence present={onboardingComplete} className="app-screen-main">
            <div className={`vela-window platform-${platform}${leftCollapsed ? " left-collapsed" : ""}${!contextSidebarOpen ? " right-collapsed" : ""}${floatingInfo ? " layout-floating" : ""}`}>
              <Sidebar
                collapsed={leftCollapsed}
                resize={resize}
                platform={platform}
                conversations={session.conversations}
                activeConversationId={session.activeConversationId}
                settingsOpen={settingsOpen}
                settingsLabel={tr("设置", "Settings")}
                onToggle={() => setLeftCollapsed((value) => !value)}
                onOpenSettings={() => setSettingsOpen((open) => !open)}
                onNewChat={() => {
                  setSettingsOpen(false);
                  void session.newChat();
                }}
                onSwitchConversation={(id) => {
                  setSettingsOpen(false);
                  void session.switchTo(id);
                }}
                onArchiveConversation={(id) => void session.archive(id)}
                onRenameConversation={openRenameConversation}
              />
              <div className="main-stage">
                <FilePreviewProvider
                  onOpenFile={onOpenFile}
                  onCloseFileTab={onCloseFileTab}
                  onCloseAllFileTabs={onCloseAllFileTabs}
                >
                  <Presence present={!settingsOpen} className="main-stage-pane">
                    <PlanDocumentProvider
                      plans={session.state?.session.planRevisions ?? []}
                      draft={session.planDraft}
                      activePlanId={planDocument.activePlanId}
                      selectedRevisionId={planDocument.selectedRevisionId}
                      openPlan={openPlan}
                      closePlan={closePlan}
                      selectRevision={selectPlanRevision}
                    >
                      <AgentWorkspaceProvider
                        agents={allAgents}
                        activeAgentId={activeWorkbenchTab?.kind === "agent" ? activeWorkbenchTab.agent.id : null}
                        openAgent={openAgentPane}
                        closeAgent={closeActiveAgent}
                      >
                        <SessionChatView
                          messageStore={session.messageStore}
                          state={session.state}
                          sendError={session.sendError}
                          platform={platform}
                          leftCollapsed={leftCollapsed}
                          onToggleLeft={toggleLeft}
                          onRenameConversation={openRenameConversation}
                          rightCollapsed={floatingInfo ? environmentCollapsed : rightCollapsed}
                          onToggleRight={toggleInfo}
                          floatingInfo={floatingInfo}
                          environmentCollapsed={environmentCollapsed}
                          changesActive={activeWorkbenchTab?.kind === "changes"}
                          project={project}
                          toolDisplay={preferences.toolDisplay}
                          toolFold={preferences.toolFold}
                          toolProcessDetails={preferences.toolProcessDetails}
                          summaryEnabled={preferences.thinkingSummary}
                          summaryStyle={preferences.thinkingSummaryStyle}
                          locale={preferences.locale}
                          hiddenModels={preferences.hiddenModels}
                          onSend={session.send}
                          onEdit={session.edit}
                          onAbort={session.abort}
                          onMode={session.setMode}
                          models={models}
                          question={session.question}
                          getQuestion={session.getQuestion}
                          onReplyQuestion={replyQuestion}
                          onBranch={branchTurn}
                          // 工作面板自己没开(没有标签页)时,或右侧栏收起时,顶栏补一个新建标签页入口;
                          // 工作面板和右侧栏都在时它自己标签栏里的 + 已经够用,不再重复。
                          showNewTab={workbenchTabs.length === 0 || !contextSidebarOpen}
                          onNewTab={openStartTab}
                          onOpenChanges={openAllChanges}
                          onReviewTurn={onReviewTurn}
                          planDraft={session.planDraft}
                          onOpenPlan={openPlan}
                        />
                      </AgentWorkspaceProvider>
                      <WorkbenchPanel
                        tabs={workbenchTabs}
                        activeTabId={activeWorkbenchTabId}
                        contextOpen={contextSidebarOpen}
                        leftOpen={!leftCollapsed}
                        resize={resize}
                        project={project}
                        busy={session.state?.session.status !== "ready"}
                        execution={session.state?.session.executionPlan ?? null}
                        onRevise={() => void session.setMode("plan")}
                        onExecutePlan={(strategy) => void session.executePlan(strategy)}
                        initialDiffPath={changesState.initialPath}
                        initialDiffPathRequestKey={changesState.requestKey}
                        selectedChangePath={selectedChangePaths[workspaceKey] ?? null}
                        onSelectedChangePath={(path) => setSelectedChangePaths((current) => ({
                          ...current,
                          [workspaceKey]: path,
                        }))}
                        onShowDiff={openChanges}
                        agents={allAgents}
                        messageStore={session.messageStore}
                        conversationId={session.activeConversationId}
                        toolDisplay={preferences.toolDisplay}
                        ensureAgentMessages={session.ensureAgentMessages}
                        onOpenAgent={openAgentPane}
                        onNewTab={openStartTab}
                        onStartAction={handleStartAction}
                        gitAvailable={Boolean(project.git?.repo)}
                        onActivateTab={(tab) => setActiveWorkbenchTabId(tab.id)}
                        onCloseTab={closeWorkbenchTab}
                      />
                      {!floatingInfo ? <ContextPanel
                        collapsed={rightCollapsed}
                        leftOpen={!leftCollapsed}
                        resize={resize}
                        state={session.state}
                        planDraft={session.planDraft}
                        project={project}
                        onToggle={() => setRightCollapsed(true)}
                        onOpenPlan={openPlan}
                        onResumeGoal={() => void session.resumeGoal()}
                        changesActive={activeWorkbenchTab?.kind === "changes"}
                        onOpenChanges={openAllChanges}
                      /> : null}
                    </PlanDocumentProvider>
                  </Presence>
                </FilePreviewProvider>
                <Presence present={settingsOpen} className="main-stage-pane">
                  <SettingsView
                    preferences={preferences}
                    platform={platform}
                    project={project}
                    models={models}
                    conversations={session.conversations}
                    onUnarchiveConversation={(id) => void session.unarchive(id)}
                    onClose={() => setSettingsOpen(false)}
                  />
                </Presence>
              </div>
            </div>
          </ScreenPresence>
        </div>
        {renamingConversation ? <RenameConversationDialog
          key={renamingConversation.id}
          conversation={renamingConversation}
          onSave={session.rename}
          onClose={() => setRenamingConversation(null)}
        /> : null}
      </AppLocaleProvider>
    </FileIconThemeProvider>
  );
}
