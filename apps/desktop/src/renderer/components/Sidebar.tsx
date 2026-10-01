import type { ConversationSummary } from "@vela/shared";
import { useEffect, useId, useMemo, useState } from "react";
import { isBooleanRecord, useStoredState } from "../hooks/useStoredState";
import { modKeyLabel } from "../platform";
import { tr } from "../locale";
import type { SidebarResize } from "../hooks/useSidebarResize";
import { MotionList } from "./BatchMotion";
import { SidebarResizeHandle } from "./SidebarResizeHandle";
import { groupActiveConversations } from "./conversation-search";
import { ConversationSearchDialog } from "./ConversationSearchDialog";

interface SidebarProps {
  collapsed: boolean;
  resize: SidebarResize;
  platform: string;
  conversations: ConversationSummary[];
  activeConversationId: string | null;
  settingsOpen: boolean;
  settingsLabel: string;
  onToggle: () => void;
  onOpenSettings: () => void;
  onNewChat: () => void;
  onSwitchConversation: (id: string) => void;
  onArchiveConversation: (id: string) => void;
  onRenameConversation?: (id: string) => void;
}

export function Sidebar({
  collapsed,
  resize,
  platform,
  conversations: allConversations,
  activeConversationId,
  settingsOpen,
  settingsLabel,
  onToggle,
  onOpenSettings,
  onNewChat,
  onSwitchConversation,
  onArchiveConversation,
  onRenameConversation,
}: SidebarProps) {
  const [searchOpen, setSearchOpen] = useState(false);
  const searchId = useId();
  const untitledLabel = tr("新对话", "New chat");
  const groups = useMemo(
    () => groupActiveConversations(allConversations, "", untitledLabel),
    [allConversations, untitledLabel],
  );

  const [collapsedWorkspaces, setCollapsedWorkspaces] = useStoredState<Record<string, boolean>>(
    "vela.collapsedWorkspaces", {}, isBooleanRecord,
  );
  const activeWorkspace = allConversations.find(
    (item) => item.id === activeConversationId && item.archivedAt === null,
  )?.cwd ?? null;

  // 激活对话变化时(新建/切换)自动展开它所在的工作区分组。
  useEffect(() => {
    if (!activeWorkspace) return;
    setCollapsedWorkspaces((current) =>
      current[activeWorkspace] ? { ...current, [activeWorkspace]: false } : current,
    );
  }, [activeWorkspace]);

  const mod = modKeyLabel(platform);

  return (
    <aside className={`sidebar-left${collapsed ? " collapsed" : ""}`} inert={collapsed ? true : undefined}>
      <SidebarResizeHandle target="left" resize={resize} />
      <div className="sidebar-left-header">
        <div className="titlebar-drag-row">
          <button
            className="icon-btn-ghost"
            type="button"
            title={`${tr("收起侧边栏", "Collapse sidebar")} (${mod}B)`}
            aria-label={tr("收起侧边栏", "Collapse sidebar")}
            onClick={onToggle}
          >
            <SidebarIcon />
          </button>
        </div>
        <div className="workspace-title-row">
          <div className="workspace-dropdown-trigger">
            <span>Vela</span>
          </div>
          <button
            className="icon-btn-ghost sidebar-search-trigger"
            type="button"
            title={tr("搜索会话", "Search chats")}
            aria-label={tr("搜索会话", "Search chats")}
            aria-expanded={searchOpen}
            aria-haspopup="dialog"
            aria-controls={searchId}
            onClick={() => setSearchOpen(true)}
          >
            <SearchIcon />
          </button>
        </div>
      </div>

      <div className="sidebar-quick-actions">
        <button className="quick-action-item" type="button" onClick={onNewChat}>
          <span className="quick-action-item-left">
            <ComposeIcon />
            <span>{tr("新对话", "New chat")}</span>
          </span>
        </button>
      </div>

      <div className="sidebar-scroll-area">
        <div className="sidebar-section-title">{tr("会话", "Chats")}</div>
        <MotionList className="session-groups" items={groups} keyOf={(group) => group.cwd}>{(group) => {
          const isCollapsed = Boolean(collapsedWorkspaces[group.cwd]);
          return (
            <div className={`session-group${isCollapsed ? " collapsed" : ""}`} key={group.cwd}>
              <button
                className="session-group-header"
                type="button"
                title={group.cwd}
                aria-expanded={!isCollapsed}
                onClick={() =>
                  setCollapsedWorkspaces((current) => ({ ...current, [group.cwd]: !isCollapsed }))
                }
              >
                <span className="session-group-chevron">
                  <ChevronIcon />
                </span>
                <span className="session-group-name">{group.name}</span>
                <span className="session-group-count">{group.conversations.length}</span>
              </button>
              {isCollapsed ? null : (
                <MotionList className="subchat-list" items={group.conversations} keyOf={(conversation) => conversation.id}>
                  {(conversation) => (
                    <div className="subchat-row" key={conversation.id}>
                      <button
                        className={`subchat-item${conversation.id === activeConversationId ? " active" : ""}`}
                        type="button"
                        title={conversation.title || tr("新对话", "New chat")}
                        aria-current={conversation.id === activeConversationId ? "page" : undefined}
                        onClick={() => onSwitchConversation(conversation.id)}
                      >
                        <span className="subchat-title">
                          {conversation.title || tr("新对话", "New chat")}
                        </span>
                        {conversation.status === "streaming" ? (
                          <span className="subchat-streaming-dot" role="img" aria-label={tr("正在回复", "Replying")} title={tr("正在回复", "Replying")} />
                        ) : null}
                      </button>
                      {onRenameConversation ? <button
                        className="subchat-action subchat-rename"
                        type="button"
                        title={tr("重命名对话", "Rename chat")}
                        aria-label={`${tr("重命名", "Rename")} “${conversation.title || untitledLabel}”`}
                        onClick={() => onRenameConversation(conversation.id)}
                      >
                        <RenameIcon />
                      </button> : null}
                      <button
                        className="subchat-action subchat-archive"
                        type="button"
                        title={tr("归档对话", "Archive chat")}
                        aria-label={`${tr("归档", "Archive")} “${conversation.title || tr("新对话", "New chat")}”`}
                        onClick={() => onArchiveConversation(conversation.id)}
                      >
                        <ArchiveIcon />
                      </button>
                    </div>
                  )}
                </MotionList>
              )}
            </div>
          );
        }}</MotionList>
        {groups.length === 0 ? (
          <div className="sidebar-empty-hint" role="status">{tr("还没有会话", "No chats yet")}</div>
        ) : null}
      </div>

      <div className="sidebar-left-footer">
        <button
          className={`sidebar-user-pill${settingsOpen ? " active" : ""}`}
          type="button"
          title={`${settingsLabel} (${mod},)`}
          aria-pressed={settingsOpen}
          onClick={onOpenSettings}
        >
          <span className="sidebar-settings-icon" aria-hidden="true">
            <SettingsIcon />
          </span>
          <span className="user-name-text">{settingsLabel}</span>
          <span className="sidebar-shortcut-hint" aria-hidden="true">
            {mod},
          </span>
        </button>
      </div>
      {searchOpen ? <ConversationSearchDialog
        id={searchId}
        conversations={allConversations}
        activeConversationId={activeConversationId}
        onSelect={onSwitchConversation}
        onNewChat={onNewChat}
        onClose={() => setSearchOpen(false)}
      /> : null}
    </aside>
  );
}

function SearchIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></svg>;
}

function RenameIcon() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m16 3 5 5-12 12-6 1 1-6L16 3Z" /><path d="m14 5 5 5" /></svg>;
}

function SidebarIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="9" y1="3" x2="9" y2="21" />
    </svg>
  );
}

function ComposeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  );
}

function ArchiveIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="2" y="4" width="20" height="5" rx="1" />
      <path d="M4 9v10a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V9" />
      <line x1="10" y1="13" x2="14" y2="13" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.65 1.65 0 0 0 15 19.4a1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}
