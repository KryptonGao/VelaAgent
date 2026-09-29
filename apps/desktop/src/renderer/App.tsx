import { useEffect, useMemo, useState } from "react";
import type { AgentInfo } from "@vela/shared";
import { AgentPane } from "./components/AgentPane";
import { AgentWorkspaceProvider } from "./components/AgentPanel";
import { ChatView } from "./components/ChatView";
import { ContextPanel } from "./components/ContextPanel";
import { FileIconThemeProvider } from "./components/FileTypeIcon";
import { OnboardingView } from "./components/OnboardingView";
import { Presence } from "./components/Presence";
import { SettingsView } from "./components/SettingsView";
import { Sidebar } from "./components/Sidebar";
import { FilePreviewProvider } from "./components/preview/FilePreviewContext";
import { useModels } from "./hooks/useModels";
import { usePreferences } from "./hooks/usePreferences";
import { useProject } from "./hooks/useProject";
import { useSession, type UiMessage } from "./hooks/useSession";
import { useSidebarResize } from "./hooks/useSidebarResize";
import { AppLocaleProvider, setActiveLocale, tr } from "./locale";

const onboardingCompleteKey = "vela.onboarding.complete";
const onboardingStepKey = "vela.onboarding.step";

function readOnboardingComplete(): boolean {
  try {
    return localStorage.getItem(onboardingCompleteKey) === "true";
  } catch {
    return false;
  }
}

function readOnboardingStep(): number {
  try {
    const value = Number(localStorage.getItem(onboardingStepKey));
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
  const models = useModels(session.setAppState);
  const project = useProject();
  const preferences = usePreferences();
  const resize = useSidebarResize();
  setActiveLocale(preferences.locale);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  // Keep the conversation as the default focus; open the inspector when a tool
  // preview or workspace-change action needs it.
  const [rightCollapsed, setRightCollapsed] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [changesOpen, setChangesOpen] = useState(false);
  /** 右侧 Agent Pane 当前展示的子代理；null 时保持单栏。 */
  const [openAgentId, setOpenAgentId] = useState<string | null>(null);
  const [onboardingComplete, setOnboardingComplete] = useState(readOnboardingComplete);
  const [onboardingStep, setOnboardingStep] = useState(readOnboardingStep);
  const platform = window.vela?.platform ?? "darwin";
  // 优先用实时 agent 树；应用重启后树已丢失，就从消息流里的工具记录还原，保证点击能打开 Pane。
  const openAgent = useMemo(() => {
    if (!openAgentId) return null;
    return (
      session.agents.find((agent) => agent.id === openAgentId) ??
      findAgentInMessages(session.messages, openAgentId)
    );
  }, [openAgentId, session.agents, session.messages]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!onboardingComplete) return;
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
        setRightCollapsed((value) => !value);
      } else if (event.code === "Comma") {
        event.preventDefault();
        setSettingsOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onboardingComplete, platform]);

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

  if (!onboardingComplete) {
    return (
      <AppLocaleProvider locale={preferences.locale}>
        <div className={`vela-window platform-${platform} onboarding-window`}>
          <OnboardingView
            preferences={preferences}
            models={models}
            initialStep={onboardingStep}
            onStepChange={(step) => {
              setOnboardingStep(step);
              try {
                localStorage.setItem(onboardingStepKey, String(step));
              } catch {
                // Keep onboarding usable when local storage is unavailable.
              }
            }}
            onComplete={() => {
              setOnboardingComplete(true);
              setSettingsOpen(false);
              try {
                localStorage.setItem(onboardingCompleteKey, "true");
                localStorage.removeItem(onboardingStepKey);
              } catch {
                // Completion applies for this run even if storage is unavailable.
              }
            }}
          />
        </div>
      </AppLocaleProvider>
    );
  }

  return (
    <FileIconThemeProvider value={preferences.fileIconTheme}>
      <AppLocaleProvider locale={preferences.locale}>
        <div className={`vela-window platform-${platform}${leftCollapsed ? " left-collapsed" : ""}`}>
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
          />
          <div className="main-stage">
            <Presence present={!settingsOpen} className="main-stage-pane">
              <FilePreviewProvider onExpand={() => setRightCollapsed(false)}>
                <AgentWorkspaceProvider
                  agents={session.agents}
                  activeAgentId={openAgent ? openAgent.id : null}
                  openAgent={setOpenAgentId}
                  closeAgent={() => setOpenAgentId(null)}
                >
                  <ChatView
                    messages={session.messages}
                    state={session.state}
                    sendError={session.sendError}
                    platform={platform}
                    leftCollapsed={leftCollapsed}
                    onToggleLeft={() => setLeftCollapsed((value) => !value)}
                    rightCollapsed={rightCollapsed}
                    onToggleRight={() => setRightCollapsed((value) => !value)}
                    project={project}
                    toolDisplay={preferences.toolDisplay}
                    toolFold={preferences.toolFold}
                    hiddenModels={preferences.hiddenModels}
                    onSend={session.send}
                    onAbort={session.abort}
                    onMode={session.setMode}
                    models={models}
                    getQuestion={session.getQuestion}
                    onReplyQuestion={(id, answer) => void session.replyQuestion(id, answer)}
                    onOpenChanges={() => {
                      setRightCollapsed(false);
                      setChangesOpen(true);
                    }}
                  />
                  {openAgent ? (
                    <AgentPane
                      agent={openAgent}
                      agents={session.agents}
                      messages={session.getAgentMessages(openAgent.id)}
                      toolDisplay={preferences.toolDisplay}
                      resize={resize}
                      onSwitch={setOpenAgentId}
                      onClose={() => setOpenAgentId(null)}
                      ensureMessages={session.ensureAgentMessages}
                    />
                  ) : null}
                </AgentWorkspaceProvider>
                <ContextPanel
                  collapsed={rightCollapsed}
                  resize={resize}
                  state={session.state}
                  project={project}
                  onToggle={() => setRightCollapsed(true)}
                  onExecutePlan={() => void session.executePlan()}
                  onResumeGoal={() => void session.resumeGoal()}
                  changesOpen={changesOpen}
                  onChangesOpenChange={setChangesOpen}
                />
              </FilePreviewProvider>
            </Presence>
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
      </AppLocaleProvider>
    </FileIconThemeProvider>
  );
}
