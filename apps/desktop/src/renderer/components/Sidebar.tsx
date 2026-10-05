import type { ConversationSummary } from "@vela/shared";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { isBooleanRecord, useStoredState } from "../hooks/useStoredState";
import { modKeyLabel } from "../platform";
import { tr, useAppLocale } from "../locale";
import type { SidebarResize } from "../hooks/useSidebarResize";
import { MotionList } from "./BatchMotion";
import { SidebarResizeHandle } from "./SidebarResizeHandle";
import { groupActiveConversations, searchActiveConversations, workspaceName } from "./conversation-search";
import {
  activityDay,
  activityReason,
  groupActivityConversations,
  isSidebarView,
  type ActivityGroupId,
  type ActivityReason,
  type SidebarView,
} from "./conversation-activity";
import { ConversationSearchDialog } from "./ConversationSearchDialog";
import { ClockIcon } from "./icons";

interface SidebarProps {
  onOpenRecipes: () => void;
  recipesOpen: boolean;
  onOpenScheduledTasks: () => void;
  scheduledTasksOpen: boolean;
  collapsed: boolean;
  resize: SidebarResize;
  platform: string;
  conversations: ConversationSummary[];
  waitingConversationIds?: readonly string[];
  activeConversationId: string | null;
  settingsOpen: boolean;
  settingsLabel: string;
  onToggle: () => void;
  onOpenSettings: () => void;
  onNewChat: (cwd?: string) => void;
  onSwitchConversation: (id: string) => void;
  onArchiveConversation: (id: string) => void;
  onRenameConversation?: (id: string) => void;
}

export function Sidebar({
  onOpenRecipes,
  recipesOpen,
  onOpenScheduledTasks,
  scheduledTasksOpen,
  collapsed,
  resize,
  platform,
  conversations: allConversations,
  waitingConversationIds,
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
  const [view, setView] = useStoredState<SidebarView>("vela.sidebarView", "activity", isSidebarView);
  const [priorityConversations, setPriorityConversations] = useStoredState<Record<string, boolean>>(
    "vela.priorityConversations", {}, isBooleanRecord,
  );
  const sidebarRef = useRef<HTMLElement>(null);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const scroller = scrollAreaRef.current;
    if (!scroller) return;
    let hideTimer: number | undefined;
    const showScrollbar = () => {
      scroller.classList.add("is-scrolling");
      window.clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => {
        scroller.classList.remove("is-scrolling");
      }, 1000);
    };
    scroller.addEventListener("scroll", showScrollbar, { passive: true });
    return () => {
      window.clearTimeout(hideTimer);
      scroller.classList.remove("is-scrolling");
      scroller.removeEventListener("scroll", showScrollbar);
    };
  }, []);
  const priorityFocusRef = useRef<string | null>(null);
  // 优先标记会让行跨分组移动，重新挂载后恢复按钮焦点以便继续键盘操作。
  useEffect(() => {
    const id = priorityFocusRef.current;
    if (!id) return;
    priorityFocusRef.current = null;
    const buttons = sidebarRef.current?.querySelectorAll<HTMLButtonElement>(".subchat-priority") ?? [];
    [...buttons].find(button => button.dataset.conversationId === id && !button.closest("[inert]"))?.focus();
  }, [priorityConversations]);
  const [today, setToday] = useState(() => activityDay(Date.now()));
  const locale = useAppLocale();
  useEffect(() => {
    if (view !== "activity") return;
    const refresh = () => setToday(activityDay(Date.now()));
    refresh();
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener("focus", refresh);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [view]);
  const searchId = useId();
  const untitledLabel = tr("新对话", "New chat");
  const groups = useMemo(
    () => groupActiveConversations(allConversations, "", untitledLabel),
    [allConversations, untitledLabel],
  );
  const recentConversations = useMemo(
    () => searchActiveConversations(allConversations, "", untitledLabel).filter(conversation => conversation.hasWorkspace === false),
    [allConversations, untitledLabel],
  );
  const activityOptions = useMemo(() => ({ priorityConversations, waitingConversationIds }), [priorityConversations, waitingConversationIds]);
  const activityGroups = useMemo(
    () => groupActivityConversations(allConversations, activityOptions, today),
    [allConversations, activityOptions, today],
  );
  const togglePriority = (id: string) => {
    if (document.activeElement instanceof HTMLElement && document.activeElement.dataset.conversationId === id) {
      priorityFocusRef.current = id;
    }
    setPriorityConversations(current => {
      const next = { ...current };
      if (next[id]) delete next[id];
      else next[id] = true;
      return next;
    });
  };
  const renderConversation = (conversation: ConversationSummary) => (
    <ConversationRow conversation={conversation} active={conversation.id === activeConversationId}
      activity={view === "activity"} reason={activityReason(conversation, activityOptions)}
      priority={Boolean(priorityConversations[conversation.id])} locale={locale} today={today}
      onSelect={onSwitchConversation} onTogglePriority={togglePriority}
      onRename={onRenameConversation} onArchive={onArchiveConversation} />
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
    <aside ref={sidebarRef} className={`sidebar-left${collapsed ? " collapsed" : ""}`} inert={collapsed ? true : undefined}>
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
          <div className="sidebar-header-actions">
            <button className="icon-btn-ghost sidebar-activity-trigger" type="button"
              title={tr("活动视图：按优先级排布对话", "Activity view: chats ordered by priority")}
              aria-label={tr("活动视图", "Activity view")} aria-pressed={view === "activity"}
              onClick={() => setView(current => current === "activity" ? "workspaces" : "activity")}>
              <ActivityIcon />
            </button>
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
      </div>

      <div className="sidebar-quick-actions">
        <button className="quick-action-item" type="button" aria-current={scheduledTasksOpen ? "page" : undefined} onClick={onOpenScheduledTasks}>
          <span className="quick-action-item-left"><ClockIcon /><span>{tr("定时任务", "Scheduled Tasks")}</span></span>
        </button>
        <button className="quick-action-item" type="button" onClick={() => onNewChat()}>
          <span className="quick-action-item-left">
            <ComposeIcon />
            <span>{tr("新对话", "New chat")}</span>
          </span>
        </button>
        <button className="quick-action-item" type="button" aria-current={recipesOpen ? "page" : undefined} onClick={onOpenRecipes}>
          <span className="quick-action-item-left"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h4"/></svg><span>{tr("任务配方", "Task Recipes")}</span></span>
        </button>
      </div>

      <div ref={scrollAreaRef} className="sidebar-scroll-area">
        {view === "activity" ? <div className="sidebar-activity-view">
          <MotionList items={activityGroups} keyOf={group => group.id}>{group => (
            <section className="activity-group" aria-label={activityGroupLabel(group.id)}>
              {group.id !== "priority" ? <div className="activity-group-header">
                <span>{activityGroupLabel(group.id)}</span>
                <span className="activity-group-count">{group.conversations.length}</span>
              </div> : null}
              <MotionList className="activity-list" items={group.conversations} keyOf={conversation => conversation.id}>
                {renderConversation}
              </MotionList>
            </section>
          )}</MotionList>
          {activityGroups.length === 0 ? <div className="sidebar-empty-hint" role="status">{tr("还没有会话", "No chats yet")}</div> : null}
        </div> : <>
          <MotionList className="session-groups" items={groups} keyOf={(group) => group.cwd}>{(group) => {
            const isCollapsed = Boolean(collapsedWorkspaces[group.cwd]);
            return (
              <div className={`session-group${isCollapsed ? " collapsed" : ""}`} key={group.cwd}>
                <div className="session-group-row">
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
                  <button
                    className="subchat-action session-group-new-chat"
                    type="button"
                    title={tr("新建对话", "New chat")}
                    aria-label={`${tr("新建对话", "New chat")} · ${group.name}`}
                    onClick={() => onNewChat(group.cwd)}
                  >
                    <ComposeIcon />
                  </button>
                </div>
                {isCollapsed ? null : (
                  <MotionList className="subchat-list" items={group.conversations} keyOf={(conversation) => conversation.id}>
                    {renderConversation}
                  </MotionList>
                )}
              </div>
            );
          }}</MotionList>
          {recentConversations.length > 0 ? (
            <section className="sidebar-recent-chats" aria-label={tr("最近", "Recent")}>
              <div className="sidebar-section-title">{tr("最近", "Recent")}</div>
              <MotionList className="subchat-list recent-chat-list" items={recentConversations} keyOf={conversation => conversation.id}>
                {renderConversation}
              </MotionList>
            </section>
          ) : null}
          {groups.length === 0 && recentConversations.length === 0 ? (
            <div className="sidebar-empty-hint" role="status">{tr("还没有会话", "No chats yet")}</div>
          ) : null}
        </>}
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

function activityGroupLabel(id: ActivityGroupId): string {
  switch (id) {
    case "priority": return tr("优先级", "Priority");
    case "today": return tr("今天", "Today");
    case "yesterday": return tr("昨天", "Yesterday");
    case "earlier": return tr("更早", "Earlier");
  }
}

function activityReasonLabel(reason: ActivityReason, conversation: ConversationSummary): string {
  switch (reason) {
    case "waiting": return tr("等待回答", "Waiting for your reply");
    case "error": return tr("发生错误", "Needs attention");
    case "priority": return tr("优先关注", "Marked as priority");
    case "streaming": return tr("正在回复", "Replying");
    case "starting": return tr("正在准备", "Starting");
    case "recent": return conversation.turnCompletedAt ? tr("已完成", "Completed") : tr("最近更新", "Recently updated");
  }
}

function ConversationRow({ conversation, active, activity, reason, priority, locale, today, onSelect, onTogglePriority, onRename, onArchive }: {
  conversation: ConversationSummary; active: boolean; activity: boolean; reason: ActivityReason;
  priority: boolean; locale: string; today: number; onSelect: (id: string) => void;
  onTogglePriority: (id: string) => void; onRename?: (id: string) => void; onArchive: (id: string) => void;
}) {
  const title = conversation.title || tr("新对话", "New chat");
  const statusLabel = activityReasonLabel(reason, conversation);
  const priorityLabel = priority ? tr("取消优先关注", "Remove priority") : tr("设为优先关注", "Mark as priority");
  const workspaceLabel = conversation.hasWorkspace === false ? "" : workspaceName(conversation.cwd);
  const updatedAt = new Date(conversation.updatedAt);
  const timeLabel = updatedAt.toLocaleString(locale, {
    ...(conversation.updatedAt < today ? { month: "2-digit", day: "2-digit" } as const : {}),
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  return <div className={`subchat-row${activity ? " activity-row" : ""}${onRename ? " has-rename" : ""}`}>
    <button className={`subchat-item${active ? " active" : ""}`} type="button"
      title={activity ? [title, workspaceLabel ? conversation.cwd : "", `${statusLabel} · ${updatedAt.toLocaleString(locale)}`].filter(Boolean).join("\n") : title}
      aria-label={activity ? [title, workspaceLabel, statusLabel].filter(Boolean).join(", ") : title}
      aria-current={active ? "page" : undefined} onClick={() => onSelect(conversation.id)}>
      {activity ? <span className="activity-row-content">
        <span className="activity-row-heading">
          <span className="subchat-title">{title}</span>
          {workspaceLabel ? <span className="activity-workspace">{workspaceLabel}</span> : null}
        </span>
        <span className="activity-row-detail">
          <span className={`activity-status activity-status-${reason}`}>
            {reason === "streaming" || reason === "starting" ? <span className="subchat-streaming-dot" aria-hidden="true" /> : null}
            {statusLabel}
          </span>
          <time className="activity-time" dateTime={updatedAt.toISOString()}>{timeLabel}</time>
        </span>
      </span> : <>
        <span className="subchat-title">{title}</span>
        {conversation.status === "streaming" ? <span className="subchat-streaming-dot" role="img" aria-label={tr("正在回复", "Replying")} title={tr("正在回复", "Replying")} /> : null}
      </>}
    </button>
    <button className="subchat-action subchat-priority" type="button" title={priorityLabel} data-conversation-id={conversation.id}
      aria-label={`${priorityLabel} “${title}”`} aria-pressed={priority} onClick={() => onTogglePriority(conversation.id)}>
      <PriorityIcon />
    </button>
    {onRename ? <button className="subchat-action subchat-rename" type="button"
      title={tr("重命名对话", "Rename chat")} aria-label={`${tr("重命名", "Rename")} “${title}”`}
      onClick={() => onRename(conversation.id)}><RenameIcon /></button> : null}
    <button className="subchat-action subchat-archive" type="button"
      title={tr("归档对话", "Archive chat")} aria-label={`${tr("归档", "Archive")} “${title}”`}
      onClick={() => onArchive(conversation.id)}><ArchiveIcon /></button>
  </div>;
}

function ActivityIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9Z" /><path d="M10 21h4" /></svg>;
}

function PriorityIcon() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9L12 3Z" /></svg>;
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
