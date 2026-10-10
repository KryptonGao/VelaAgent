import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { AgentInboxDecideFailure, AgentInboxDecision, AgentInboxItem, AgentInboxItemType, AgentInboxNavigation } from "@vela/shared";
import { activeIntlLocale, tr, trf } from "../locale";
import { useAgentInbox } from "../hooks/useAgentInbox";
import { useResidentAgent } from "../hooks/useResidentAgent";
import type { MessageStore } from "../hooks/message-store";
import { ApprovalBanner } from "./composer/ApprovalBanner";
import { AgentInboxQuestionForm } from "./AgentInboxQuestionForm";
import { AgentInboxContent } from "./AgentInboxContent";
import { ResidentAgentView } from "./ResidentAgentView";
import { stateLabel } from "./resident-agent-model";
import { InboxIcon, QuestionIcon, ShieldIcon } from "./icons";
import {
  agentInboxOverview,
  agentInboxTypes,
  agentInboxViewCount,
  agentInboxViews,
  filterAgentInboxItems,
  resolveSelection,
  type AgentInboxView,
} from "./agent-inbox-model";
import "../agent-inbox.css";

const viewLabels: Record<AgentInboxView, () => string> = {
  overview: () => tr("概览", "Overview"),
  needs_action: () => tr("需要处理", "Needs action"),
  activity: () => tr("动态", "Activity"),
  archive: () => tr("归档", "Archive"),
};

const typeLabels: Record<AgentInboxItemType, () => string> = {
  approval: () => tr("工具审批", "Tool approval"),
  question: () => tr("Agent 提问", "Agent question"),
  review: () => tr("待检查", "Needs review"),
  result: () => tr("结果", "Result"),
  error: () => tr("失败", "Failure"),
  alert: () => tr("提醒", "Alert"),
  suggestion: () => tr("建议", "Suggestion"),
  system: () => tr("系统", "System"),
};

/** 事项的来源说明由类型、来源与结果组合而成；主进程只存数据，不存界面文案。 */
export function itemLabel(item: AgentInboxItem): string {
  const scheduled = item.origin === "scheduled_task";
  const resident = item.origin === "resident";
  const proactive = item.origin === "proactive";
  switch (item.type) {
    case "approval": return item.detail.kind === "approval" && item.detail.request.kind === "delegate" ? tr("后台任务审批", "Background task approval") : typeLabels.approval();
    case "suggestion": return proactive ? tr("主动建议", "Proactive suggestion") : typeLabels.suggestion();
    case "error":
      if (proactive) return tr("主动分析失败", "Proactive analysis failed");
      if (resident) return item.outcome === "timed_out" ? tr("后台任务超时，已停止", "Background task timed out") : tr("后台任务失败", "Background task failed");
      if (scheduled) return item.outcome === "interrupted" ? tr("定时任务被中断", "Scheduled task interrupted") : tr("定时任务失败", "Scheduled task failed");
      return item.origin === "subagent" ? tr("子代理失败", "Subagent failed") : tr("对话失败", "Conversation failed");
    case "result": return scheduled ? tr("定时任务已完成", "Scheduled task finished") : resident ? tr("后台任务已完成", "Background task finished") : tr("对话已完成", "Conversation finished");
    case "system": return scheduled ? tr("定时任务已跳过", "Scheduled task skipped") : typeLabels.system();
    case "review": return tr("计划待检查", "Plan ready for review");
    default: return typeLabels[item.type]();
  }
}

export function statusLabel(item: AgentInboxItem): string {
  switch (item.status) {
    case "pending": return tr("待处理", "Pending");
    case "processing": return tr("处理中", "Processing");
    case "rejected": return tr("已拒绝", "Denied");
    case "expired": return tr("已超时", "Timed out");
    case "cancelled": return tr("已跳过", "Skipped");
    case "invalidated": return tr("已失效", "No longer valid");
    default:
      if (item.outcome === "approved") return tr("已批准", "Approved");
      if (item.outcome === "answered") return tr("已回答", "Answered");
      if (item.outcome === "acknowledged") return tr("已确认", "Acknowledged");
      return item.type === "result" || item.type === "system" ? "" : tr("已完成", "Done");
  }
}

function failureText(reason: AgentInboxDecideFailure): string {
  switch (reason) {
    case "stale":
    case "not_pending": return tr("该事项已被更新，可能已在对话中处理。已显示最新状态。", "This item changed, possibly handled in the conversation. Showing the latest state.");
    case "invalidated": return tr("原来的等待点已经失效（任务已结束或应用重启过），无法继续。", "The original wait point is gone (the task ended or the app restarted), so this can't continue.");
    case "invalid": return tr("提交的内容无效。", "That input isn't valid.");
    default: return tr("事项不存在。", "This item no longer exists.");
  }
}

function itemSubject(item: AgentInboxItem): string {
  if (item.detail.kind === "approval") return item.detail.request.command ?? item.detail.request.path ?? item.summary;
  if (item.detail.kind === "question") return item.detail.question;
  return item.summary || item.title;
}

function InboxTime({ at }: { at: number }) {
  const seconds = (at - Date.now()) / 1000;
  const [divisor, unit] = Math.abs(seconds) >= 86400 ? [86400, "day"] : Math.abs(seconds) >= 3600 ? [3600, "hour"] : Math.abs(seconds) >= 60 ? [60, "minute"] : [1, "second"];
  const locale = activeIntlLocale();
  const date = new Date(at);
  const text = Math.abs(seconds) < 7 * 86400
    ? new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "narrow" }).format(Math.round(seconds / Number(divisor)), unit as Intl.RelativeTimeFormatUnit)
    : date.toLocaleDateString(locale, { month: "short", day: "numeric" });
  return <time className="agent-inbox-time" dateTime={date.toISOString()} title={date.toLocaleString(locale)}>{text}</time>;
}

function TypeMark({ type }: { type: AgentInboxItemType }) {
  return <span className={`agent-inbox-mark type-${type}`} aria-hidden="true">
    {type === "approval" ? <ShieldIcon size={15} /> : type === "question" ? <QuestionIcon size={15} /> : <InboxIcon size={15} />}
  </span>;
}

function Row({ item, selected, busy, onSelect, onDecide }: {
  item: AgentInboxItem;
  selected: boolean;
  busy: boolean;
  onSelect: (item: AgentInboxItem) => void;
  onDecide: (item: AgentInboxItem, decision: AgentInboxDecision) => void;
}) {
  const status = statusLabel(item);
  const quick = item.type === "approval" && item.status === "pending";
  return <div className="agent-inbox-row-wrap" data-selected={selected ? "" : undefined}>
    <button type="button" className="agent-inbox-row" aria-current={selected ? "true" : undefined}
      data-status={item.status} data-unread={item.readState === "unread" ? "" : undefined} onClick={() => onSelect(item)}>
      <TypeMark type={item.type} />
      <span className="agent-inbox-row-main">
        <strong>{itemLabel(item)}</strong>
        <span className="agent-inbox-row-subject">{itemSubject(item)}</span>
        {item.title ? <span className="agent-inbox-row-meta">{item.title}</span> : null}
      </span>
      <span className="agent-inbox-row-side">
        {item.readState === "unread" ? <span className="agent-inbox-unread" role="img" aria-label={tr("未读", "Unread")} /> : null}
        {status ? <span className={`agent-inbox-status status-${item.status}`}>{status}</span> : null}
        <InboxTime at={item.updatedAt} />
      </span>
    </button>
    {quick ? <div className="agent-inbox-row-actions">
      <button type="button" className="agent-inbox-quick" disabled={busy} aria-label={trf("拒绝：{0}", "Deny: {0}", itemSubject(item))}
        onClick={() => onDecide(item, "deny")}>{tr("拒绝", "Deny")}</button>
      <button type="button" className="agent-inbox-quick allow" disabled={busy} aria-label={trf("允许一次：{0}", "Allow once: {0}", itemSubject(item))}
        title={tr("允许一次", "Allow once")} onClick={() => onDecide(item, "approve")}>{tr("允许", "Allow")}</button>
    </div> : null}
  </div>;
}

function Detail({ item, busy, notice, onDecide, onArchive, onBack, onOpenConversation }: {
  item: AgentInboxItem;
  busy: boolean;
  notice: string | null;
  onDecide: (item: AgentInboxItem, decision: AgentInboxDecision, answer?: string) => void;
  onArchive: (item: AgentInboxItem) => void;
  onBack: () => void;
  onOpenConversation: (id: string) => void;
}) {
  const pending = item.status === "pending";
  const status = statusLabel(item);
  const detail = item.detail;
  return <article className="agent-inbox-detail" aria-label={itemLabel(item)}>
    <header className="agent-inbox-detail-head">
      <button type="button" className="agent-inbox-back" onClick={onBack}>{tr("返回列表", "Back to list")}</button>
      <TypeMark type={item.type} />
      <h2>{itemLabel(item)}</h2>
      {status ? <span className={`agent-inbox-status status-${item.status}`}>{status}</span> : null}
    </header>
    <dl className="agent-inbox-facts">
      {item.title ? <><dt>{tr("来源", "Source")}</dt><dd>{item.title}</dd></> : null}
      {item.workspaceId ? <><dt>{tr("工作区", "Workspace")}</dt><dd className="agent-inbox-path">{item.workspaceId}</dd></> : null}
      {item.reason ? <><dt>{tr("触发原因", "Why it ran")}</dt><dd>{item.reason}</dd></> : null}
      <dt>{tr("时间", "Time")}</dt><dd>{new Date(item.createdAt).toLocaleString(activeIntlLocale())}</dd>
    </dl>
    {notice ? <p className="agent-inbox-notice" role="alert">{notice}</p> : null}
    {item.status === "invalidated" && !notice ? <p className="agent-inbox-notice" role="status">{failureText("invalidated")}</p> : null}
    {item.status === "expired" ? <p className="agent-inbox-notice" role="status">{tr("审批超过 5 分钟没有回复，已自动拒绝；需要重新触发。", "No reply within 5 minutes, so it was denied automatically. It has to be triggered again.")}</p> : null}

    {detail.kind === "approval" ? (
      pending
        ? <ApprovalBanner approval={detail.request} onReply={(_id, allowed) => onDecide(item, allowed ? "approve" : "deny")} />
        : <pre className="approval-banner-summary agent-inbox-readonly">{detail.request.command ?? detail.request.path ?? item.summary}</pre>
    ) : null}
    {detail.kind === "question" ? (
      pending
        ? <AgentInboxQuestionForm detail={detail} busy={busy} onAnswer={answer => onDecide(item, "answer", answer)} onSkip={() => onDecide(item, "skip")} />
        : <div className="agent-inbox-answer">
          <div className="question-card-q">{detail.question}</div>
          {detail.answer ? <div className="question-card-a">{detail.answer}</div> : <p className="agent-inbox-muted">{tr("没有回答", "No answer")}</p>}
        </div>
    ) : null}
    {detail.kind === "text" ? <AgentInboxContent item={item} fallback={detail.text || item.summary || tr("没有可显示的内容。", "Nothing to show.")} /> : null}

    <div className="agent-inbox-actions">
      {pending && (item.type === "error" || item.type === "review") ? <button type="button" className="agent-inbox-primary" disabled={busy} onClick={() => onDecide(item, "acknowledge")}>{tr("标为已确认", "Mark as acknowledged")}</button> : null}
      {item.conversationId ? <button type="button" onClick={() => onOpenConversation(item.conversationId!)}>{tr("打开对话", "Open conversation")}</button> : null}
      <button type="button" onClick={() => onArchive(item)} title={pending ? tr("归档只改变显示，不会处理这个请求", "Archiving only changes how it's shown. It doesn't act on the request") : undefined}>
        {item.readState === "archived" ? tr("取消归档", "Unarchive") : tr("归档", "Archive")}
      </button>
    </div>
  </article>;
}

export function AgentInboxPage({ active, sidebarCollapsed, onToggleSidebar, onOpenConversation, messageStore, ensureTranscript, navigation, onNavigationHandled }: {
  active: boolean;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  onOpenConversation: (id: string) => void;
  messageStore: MessageStore;
  ensureTranscript: (conversationId: string) => void;
  /** 主进程要求跳转到的位置（通知点击、菜单栏入口）；处理后调用 onNavigationHandled。 */
  navigation: { target: AgentInboxNavigation; nonce: number } | null;
  onNavigationHandled: (nonce: number) => void;
}) {
  const { store, snapshot } = useAgentInbox();
  const resident = useResidentAgent(true);
  const [section, setSection] = useState<"inbox" | "resident">("inbox");
  const [view, setView] = useState<AgentInboxView>("overview");
  const [type, setType] = useState<AgentInboxItemType | "all">("all");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ id: string; text: string } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const selectedRef = useRef(selectedId); selectedRef.current = selectedId;

  useEffect(() => { if (active && view === "archive") void store?.loadArchived(); }, [active, view, store]);
  useEffect(() => {
    if (!navigation) return;
    const { target, nonce } = navigation;
    if (target.view === "resident") setSection("resident");
    else {
      setSection("inbox");
      if (target.view === "item") { setView("overview"); setType("all"); setSearch(""); setSelectedId(target.itemId); }
    }
    onNavigationHandled(nonce);
  }, [navigation, onNavigationHandled]);
  useEffect(() => {
    if (!active) return;
    const keyboard = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k" && !selectedRef.current) { event.preventDefault(); searchRef.current?.focus(); }
      if (event.key === "Escape" && selectedRef.current && !(event.target instanceof HTMLInputElement)) setSelectedId(null);
    };
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  }, [active]);

  const filtering = type !== "all" || search.trim() !== "";
  const list = useMemo(() => filterAgentInboxItems(snapshot.items, { view, type, search }), [snapshot.items, view, type, search]);
  const overview = useMemo(() => agentInboxOverview(snapshot.items), [snapshot.items]);
  const types = useMemo(() => agentInboxTypes(snapshot.items), [snapshot.items]);
  const selected = resolveSelection(snapshot.items, selectedId);
  const grouped = view === "overview" && !filtering;

  const select = (item: AgentInboxItem) => { setSelectedId(item.id); void store?.markRead(item); };
  // 通知点击跳来的事项：列表加载出来后标为已读，与手动点开一致。
  useEffect(() => { if (active && selected && selected.readState === "unread") void store?.markRead(selected); }, [active, selected?.id, selected?.readState, store]);
  const decide = async (item: AgentInboxItem, decision: AgentInboxDecision, answer?: string) => {
    if (!store || busyId) return;
    setBusyId(item.id); setNotice(null);
    try {
      const result = await store.decide(item, decision, answer);
      if (!result.ok) { setSelectedId(item.id); setNotice({ id: item.id, text: failureText(result.reason) }); }
    } catch (error) {
      setSelectedId(item.id); setNotice({ id: item.id, text: error instanceof Error ? error.message : String(error) });
    } finally { setBusyId(null); }
  };
  const archive = (item: AgentInboxItem) => { void store?.archive(item, item.readState !== "archived"); };

  const emptyText = view === "needs_action" ? tr("没有需要你处理的事项。", "Nothing needs your attention.")
    : view === "archive" ? tr("没有归档的事项。", "No archived items.")
    : filtering ? tr("没有匹配的事项。", "No matching items.")
    : tr("审批、提问和后台任务的结果会出现在这里。", "Approvals, questions and background results show up here.");

  return <section className="agent-inbox-page" aria-label={tr("Agent 收件箱", "Agent Inbox")}>
    <header className="agent-inbox-topbar main-chat-header">
      {sidebarCollapsed && <button type="button" onClick={onToggleSidebar} aria-label={tr("展开侧栏", "Show sidebar")}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></svg></button>}
      <h1>{tr("Agent 收件箱", "Agent Inbox")}</h1>
      <span className="agent-inbox-summary" role="status">
        {snapshot.badge > 0 ? trf("{0} 项需要处理", "{0} need your attention", snapshot.badge) : tr("没有待处理事项", "All caught up")}
      </span>
    </header>
    {snapshot.loadError || snapshot.error ? <p className="agent-inbox-banner" role="alert">{snapshot.loadError ?? snapshot.error}</p> : null}
    <div className="agent-inbox-body" data-mode={section === "resident" ? "resident" : selected ? "detail" : "list"}>
      <nav className="agent-inbox-nav" aria-label={tr("收件箱视图", "Inbox views")}>
        {agentInboxViews.map(value => <button type="button" key={value} aria-current={section === "inbox" && view === value ? "page" : undefined}
          onClick={() => { setSection("inbox"); setView(value); setSelectedId(null); }}>
          <span>{viewLabels[value]()}</span>
          <span className="agent-inbox-count" data-urgent={value === "needs_action" && snapshot.badge > 0 ? "" : undefined}>{value === "needs_action" ? snapshot.badge : agentInboxViewCount(snapshot.items, value)}</span>
        </button>)}
        <button type="button" className="agent-inbox-nav-resident" aria-current={section === "resident" ? "page" : undefined}
          onClick={() => { setSection("resident"); setSelectedId(null); }}>
          <span>Resident Agent</span>
          <span className="resident-dot resident-nav-dot" role="img" aria-label={resident.status ? stateLabel(resident.status.state) : tr("未运行", "Offline")} title={resident.status ? stateLabel(resident.status.state) : undefined}
            data-state={resident.status?.state ?? "offline"} />
        </button>
      </nav>
      {section === "resident" ? <div className="agent-inbox-resident">
        <ResidentAgentView api={resident.api} status={resident.status} settings={resident.settings} rules={resident.rules} error={resident.error}
          messageStore={messageStore} ensureTranscript={ensureTranscript} onOpenConversation={onOpenConversation} onSettings={resident.setSettings} />
      </div> : <>
      <div className="agent-inbox-feed">
        <div className="agent-inbox-filters">
          <label className="agent-inbox-search"><span className="agent-inbox-sr">{tr("搜索事项", "Search items")}</span>
            <input ref={searchRef} type="search" value={search} placeholder={tr("搜索事项", "Search items")} onChange={event => setSearch(event.target.value)} /></label>
          <label><span className="agent-inbox-sr">{tr("类型", "Type")}</span>
            <select value={type} onChange={event => setType(event.target.value as AgentInboxItemType | "all")}>
              <option value="all">{tr("所有类型", "All types")}</option>
              {types.map(value => <option key={value} value={value}>{typeLabels[value]()}</option>)}
            </select></label>
        </div>
        {!snapshot.loaded && !snapshot.loadError ? <p className="agent-inbox-empty" role="status">{tr("正在读取…", "Loading…")}</p>
          : grouped ? <>
            {overview.attention.length > 0 ? <section aria-label={tr("需要你处理", "Needs your attention")}>
              <h2 className="agent-inbox-group">{tr("需要你处理", "Needs your attention")}</h2>
              {overview.attention.map(item => <Row key={item.id} item={item} selected={item.id === selectedId} busy={busyId === item.id} onSelect={select} onDecide={decide} />)}
            </section> : null}
            {overview.recent.length > 0 ? <section aria-label={tr("最近动态", "Recent activity")}>
              <h2 className="agent-inbox-group">{tr("最近动态", "Recent activity")}</h2>
              {overview.recent.map(item => <Row key={item.id} item={item} selected={item.id === selectedId} busy={busyId === item.id} onSelect={select} onDecide={decide} />)}
            </section> : null}
            {!overview.attention.length && !overview.recent.length ? <p className="agent-inbox-empty">{emptyText}</p> : null}
          </>
          : <Fragment>
            {list.map(item => <Row key={item.id} item={item} selected={item.id === selectedId} busy={busyId === item.id} onSelect={select} onDecide={decide} />)}
            {!list.length ? <p className="agent-inbox-empty">{emptyText}</p> : null}
          </Fragment>}
      </div>
      <div className="agent-inbox-detail-pane">
        {selected
          ? <Detail key={selected.id} item={selected} busy={busyId === selected.id} notice={notice?.id === selected.id ? notice.text : null}
            onDecide={decide} onArchive={archive} onBack={() => setSelectedId(null)} onOpenConversation={onOpenConversation} />
          : <p className="agent-inbox-empty">{tr("选择一个事项查看详情。", "Select an item to see its details.")}</p>}
      </div>
      </>}
    </div>
  </section>;
}
