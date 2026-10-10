import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  mayContainUi,
  residentLimits,
  residentModes,
  type ProactiveRulesState,
  type ResidentAgentApi,
  type ResidentMode,
  type ResidentSettings,
  type ResidentStatus,
  type ResidentSubmitFailure,
} from "@vela/shared";
import { activeIntlLocale, tr, trf } from "../locale";
import type { MessageStore } from "../hooks/message-store";
import { useMessages } from "../hooks/useMessages";
import type { UiMessage } from "../hooks/useSession";
import { AssistantMarkdown } from "./intelligent-ui/AssistantMarkdown";
import { UiHostProvider, type UiHost } from "./intelligent-ui/UiRuntime";
import { stableUiMessageId } from "./intelligent-ui/ui-state-store";
import { PauseIcon, PlayIcon } from "./icons";
import { ProactiveRulesPanel } from "./ProactiveRulesPanel";
import { ResidentSettingsPanel } from "./ResidentSettingsPanel";
import { modeDescription, modeLabel, stateLabel, statusSummary, taskErrorText, taskSourceLabel, taskStatusLabel } from "./resident-agent-model";
import { useSlidingTabIndicator } from "./useSlidingTabIndicator";

type Tab = "chat" | "tasks" | "rules" | "settings";

const submitFailure: Record<ResidentSubmitFailure, () => string> = {
  disabled: () => tr("Resident Agent 已关闭，请先在设置里选择「待命」。", "Resident Agent is off. Choose Standby first."),
  paused: () => tr("后台自动任务已暂停，恢复后才能提交。", "Background tasks are paused. Resume them first."),
  invalid: () => tr("请输入内容。", "Enter something first."),
  unknown_workspace: () => tr("这个工作区没有登记，不能创建任务。", "That workspace isn't registered."),
  queue_full: () => tr("后台任务队列已满，请稍后再试。", "The task queue is full. Try again shortly."),
  failed: () => tr("提交失败。", "Couldn't submit that."),
};

const toolLabels: Record<string, () => string> = {
  list_workspaces: () => tr("查询工作区", "Listed workspaces"),
  list_background_tasks: () => tr("查询后台任务", "Checked background tasks"),
  list_inbox_items: () => tr("查询收件箱", "Checked the Inbox"),
  delegate_workspace_task: () => tr("创建后台任务", "Created a background task"),
  ask_user_question: () => tr("向你提问", "Asked you a question"),
};

function baseName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function formatTime(at: number | null): string {
  return at === null ? "" : new Date(at).toLocaleString(activeIntlLocale(), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

const ResidentMessage = memo(function ResidentMessage({ message, streaming }: { message: UiMessage; streaming: boolean }) {
  if (message.role === "user") return <div className="resident-msg user"><div className="resident-bubble">{message.text}</div></div>;
  if (!message.text && message.tools.length === 0) return streaming ? <div className="resident-msg assistant"><span className="resident-typing" role="status" aria-label={tr("正在回复", "Replying")} /></div> : null;
  return <div className="resident-msg assistant">
    {message.tools.length > 0 ? <ul className="resident-tools" aria-label={tr("工具调用", "Tool calls")}>
      {message.tools.map(tool => <li key={tool.id} data-status={tool.status}>{(toolLabels[tool.name] ?? (() => tool.name))()}</li>)}
    </ul> : null}
    {message.text ? <div className="resident-prose"><AssistantMarkdown messageId={message.id} text={message.text} streaming={streaming} /></div> : null}
  </div>;
});

function Chat({ api, status, settings, messageStore, notice, setNotice }: {
  api: ResidentAgentApi;
  status: ResidentStatus;
  settings: ResidentSettings | null;
  messageStore: MessageStore;
  notice: string | null;
  setNotice: (text: string | null) => void;
}) {
  const messages = useMessages(messageStore, status.conversationId);
  const [text, setText] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [sending, setSending] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const blocked = status.mode === "disabled" ? "disabled" : status.paused ? "paused" : null;

  const uiOrdinals = useMemo(() => {
    const ordinals = new Map<string, string>();
    for (const message of messages) if (message.role === "assistant" && mayContainUi(message.text)) ordinals.set(message.id, stableUiMessageId(ordinals.size));
    return ordinals;
  }, [messages]);

  const submit = async (value: string, target?: string): Promise<boolean> => {
    setNotice(null);
    try {
      const result = await api.submit({ text: value, ...(target ? { workspace: target } : {}) });
      if (result.ok) return true;
      setNotice(result.message ?? submitFailure[result.reason]());
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
    return false;
  };

  const uiHost = useMemo<UiHost>(() => ({
    conversationId: status.conversationId,
    stableMessageId: id => uiOrdinals.get(id) ?? null,
    canSubmit: status.conversationId !== null && !blocked,
    agentBusy: status.residentBusy,
    // 界面只是把用户的选择当作一条普通消息发给 Resident，不携带任何权限。
    submit: async value => { await submit(value); },
    openLink: () => false,
  }), [status.conversationId, status.residentBusy, uiOrdinals, blocked]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const list = listRef.current;
    if (list && stick.current) list.scrollTop = list.scrollHeight;
  }, [messages]);

  const send = async () => {
    const value = text.trim();
    if (!value || sending || blocked) return;
    setSending(true);
    const ok = await submit(value, workspace || undefined);
    setSending(false);
    if (ok) { setText(""); stick.current = true; }
  };

  const lastIndex = messages.length - 1;
  return <div className="resident-chat">
    <div className="resident-messages" ref={listRef} role="log" aria-label={tr("与 Resident Agent 的对话", "Conversation with Resident Agent")}
      onScroll={event => { const el = event.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48; }}>
      {messages.length === 0
        ? <p className="agent-inbox-empty">{tr("还没有对话。告诉它你想让后台处理什么，比如「检查一下 api 项目最近的失败测试」。", "No conversation yet. Tell it what to handle in the background, e.g. “check the failing tests in the api project”.")}</p>
        : <UiHostProvider value={uiHost}>
          {messages.map((message, index) => <ResidentMessage key={message.id} message={message} streaming={status.residentBusy && index === lastIndex} />)}
        </UiHostProvider>}
    </div>
    {notice ? <p className="agent-inbox-notice" role="alert">{notice}</p> : null}
    {blocked ? <p className="agent-inbox-muted resident-blocked" role="status">{submitFailure[blocked]()}</p> : null}
    <form className="resident-composer" onSubmit={event => { event.preventDefault(); void send(); }}>
      <label className="agent-inbox-sr" htmlFor="resident-input">{tr("给 Resident Agent 的消息", "Message for Resident Agent")}</label>
      <textarea id="resident-input" rows={2} value={text} maxLength={residentLimits.maxPrompt} disabled={Boolean(blocked)}
        placeholder={workspace ? tr("描述要在这个工作区里完成的任务", "Describe the task for this workspace") : tr("和 Resident Agent 对话，或交给它一个任务", "Talk to Resident Agent or hand it a task")}
        onChange={event => setText(event.target.value)}
        onKeyDown={event => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void send(); } }} />
      <div className="resident-composer-row">
        <label>
          <span className="agent-inbox-sr">{tr("目标", "Target")}</span>
          <select value={workspace} onChange={event => setWorkspace(event.target.value)} disabled={Boolean(blocked)}>
            <option value="">{tr("交给 Resident Agent", "Ask Resident Agent")}</option>
            {status.workspaces.map(path => <option key={path} value={path} title={path}>{trf("直接在 {0} 创建后台任务", "Run in {0} directly", baseName(path))}</option>)}
          </select>
        </label>
        <button type="submit" className="agent-inbox-primary" disabled={!text.trim() || sending || Boolean(blocked)}>{tr("发送", "Send")}</button>
      </div>
      {settings?.mode === "disabled" ? null : <p className="agent-inbox-muted resident-hint">{workspace
        ? tr("直接创建的任务按当前的权限设置运行；需要批准的操作会出现在收件箱里。", "The task runs with your current permission settings. Anything needing approval shows up in the Inbox.")
        : tr("Resident 不能读写文件或运行命令；需要动手时它会请你批准后在工作区里创建后台任务。", "Resident can't read files or run commands. When work is needed it asks you to approve a background task in a workspace.")}</p>}
    </form>
  </div>;
}

function Tasks({ api, status, onOpenConversation }: { api: ResidentAgentApi; status: ResidentStatus; onOpenConversation: (id: string) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const tasks = useMemo(() => [...status.tasks].sort((a, b) => b.createdAt - a.createdAt).slice(0, residentLimits.maxTasksShown), [status.tasks]);
  const cancel = async (id: string) => {
    setBusy(id); setFailure(null);
    try { await api.cancelTask(id); } catch (error) { setFailure(error instanceof Error ? error.message : String(error)); } finally { setBusy(null); }
  };
  if (!tasks.length) return <p className="agent-inbox-empty">{tr("还没有后台任务。", "No background tasks yet.")}</p>;
  return <div className="resident-tasks">
    {failure ? <p className="agent-inbox-notice" role="alert">{failure}</p> : null}
    <ul aria-label={tr("后台任务", "Background tasks")}>
      {tasks.map(task => <li key={task.id} className="resident-task" data-status={task.status}>
        <div className="resident-task-main">
          <strong>{task.title}</strong>
          <span className={`agent-inbox-status resident-task-${task.status}`}>{taskStatusLabel(task.status)}</span>
        </div>
        <div className="resident-task-meta">
          <span title={task.workspace}>{baseName(task.workspace)}</span>
          <span>{taskSourceLabel(task.source)}</span>
          <span>{formatTime(task.finishedAt ?? task.startedAt ?? task.createdAt)}</span>
        </div>
        {task.reason ? <p className="resident-task-reason">{trf("触发原因：{0}", "Why it ran: {0}", task.reason)}</p> : null}
        {task.error ? <p className="resident-task-error">{taskErrorText(task.error)}</p> : null}
        <div className="resident-task-actions">
          {task.conversationId ? <button type="button" onClick={() => onOpenConversation(task.conversationId!)}>{tr("打开对话", "Open conversation")}</button> : null}
          {task.status === "queued" || task.status === "running"
            ? <button type="button" disabled={busy === task.id} onClick={() => void cancel(task.id)}>{task.status === "queued" ? tr("移出队列", "Remove from queue") : tr("停止", "Stop")}</button> : null}
        </div>
      </li>)}
    </ul>
  </div>;
}

export function ResidentAgentView({ api, status, settings, rules, messageStore, ensureTranscript, onOpenConversation, onSettings, error, initialTab = "chat" }: {
  api: ResidentAgentApi | null;
  status: ResidentStatus | null;
  settings: ResidentSettings | null;
  rules: ProactiveRulesState | null;
  messageStore: MessageStore;
  ensureTranscript: (conversationId: string) => void;
  onOpenConversation: (id: string) => void;
  onSettings: (settings: ResidentSettings) => void;
  error: string | null;
  initialTab?: Tab;
}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const slider = useSlidingTabIndicator({ activeKey: tab });
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const conversationId = status?.conversationId ?? null;
  useEffect(() => { if (conversationId) ensureTranscript(conversationId); }, [conversationId, ensureTranscript]);

  if (!api) return <p className="agent-inbox-empty">{tr("当前环境不支持 Resident Agent。", "Resident Agent isn't available here.")}</p>;
  if (!status || !settings) return <p className="agent-inbox-empty" role="status">{error ?? tr("正在读取…", "Loading…")}</p>;

  const changeMode = async (mode: ResidentMode) => {
    if (mode === settings.mode || pending) return;
    setPending(true); setNotice(null);
    try { onSettings(await api.updateSettings({ mode })); }
    catch (reason) { setNotice(reason instanceof Error ? reason.message : String(reason)); }
    finally { setPending(false); }
  };
  const togglePause = async () => {
    setPending(true); setNotice(null);
    try { await (status.paused ? api.resume() : api.pause()); onSettings(await api.getSettings()); }
    catch (reason) { setNotice(reason instanceof Error ? reason.message : String(reason)); }
    finally { setPending(false); }
  };

  const tabs: Array<[Tab, string]> = [
    ["chat", tr("对话", "Chat")],
    ["tasks", status.tasks.length ? trf("任务（{0}）", "Tasks ({0})", status.tasks.length) : tr("任务", "Tasks")],
    ["rules", rules?.rules.length ? trf("主动规则（{0}）", "Rules ({0})", rules.rules.length) : tr("主动规则", "Rules")],
    ["settings", tr("设置", "Settings")],
  ];

  return <section className="resident-view" aria-label="Resident Agent">
    <header className="resident-head">
      <div className="resident-state">
        <span className={`resident-dot state-${status.state}`} aria-hidden="true" />
        <div>
          <h2>Resident Agent <span className="resident-state-label" role="status">{stateLabel(status.state)}</span></h2>
          <p>{statusSummary(status)}</p>
        </div>
      </div>
      <div className="resident-controls">
        <div className="resident-modes" role="radiogroup" aria-label={tr("运行模式", "Mode")}>
          {residentModes.map(mode => <button key={mode} type="button" role="radio" aria-checked={settings.mode === mode} disabled={pending}
            title={modeDescription(mode)} onClick={() => void changeMode(mode)}>{modeLabel(mode)}</button>)}
        </div>
        <button type="button" className="resident-pause" disabled={pending || settings.mode === "disabled"} aria-pressed={status.paused} onClick={() => void togglePause()}
          title={status.paused ? tr("恢复后台自动任务", "Resume background tasks") : tr("暂停全部后台自动任务；已在运行的不会被打断", "Pause all background tasks. Ones already running aren't interrupted")}>
          {status.paused ? <PlayIcon size={12} /> : <PauseIcon size={12} />}
          <span>{status.paused ? tr("恢复", "Resume") : tr("暂停", "Pause")}</span>
        </button>
      </div>
      <p className="resident-mode-note">{modeDescription(settings.mode)}</p>
      {status.error || error ? <p className="agent-inbox-notice" role="alert">{status.error ?? error}</p> : null}
      <dl className="resident-facts">
        <dt>{tr("模型", "Model")}</dt><dd>{status.model ?? tr("使用当前默认模型", "Default model")}</dd>
        <dt>{tr("最近活动", "Last activity")}</dt><dd>{status.lastActivityAt ? formatTime(status.lastActivityAt) : tr("暂无", "None yet")}</dd>
        {settings.mode === "proactive" ? <><dt>{tr("今日主动运行", "Proactive runs today")}</dt><dd>{status.proactiveRunsToday} / {settings.limits.dailyProactiveRuns}</dd></> : null}
      </dl>
    </header>
    <nav ref={slider.navRef} className="conversation-view-tabs resident-tabs" role="tablist" aria-label={tr("Resident Agent 分区", "Resident Agent sections")}
      onPointerMove={slider.onPointerMove} onPointerLeave={slider.onPointerLeave}>
      {tabs.map(([value, label]) => <button key={value} type="button" role="tab" id={`resident-tab-${value}`} data-tab-key={value} ref={slider.registerTab(value)}
        aria-selected={tab === value} aria-controls={`resident-panel-${value}`} tabIndex={tab === value ? 0 : -1} onClick={() => setTab(value)}>{label}</button>)}
      {slider.indicator}
    </nav>
    <div className="resident-panel" role="tabpanel" id={`resident-panel-${tab}`} aria-labelledby={`resident-tab-${tab}`}>
      {tab === "chat" ? <Chat api={api} status={status} settings={settings} messageStore={messageStore} notice={notice} setNotice={setNotice} /> : null}
      {tab === "tasks" ? <Tasks api={api} status={status} onOpenConversation={onOpenConversation} /> : null}
      {tab === "rules" ? <ProactiveRulesPanel api={api} status={status} settings={settings} rules={rules} /> : null}
      {tab === "settings" ? <ResidentSettingsPanel api={api} settings={settings} onSettings={onSettings} /> : null}
    </div>
  </section>;
}
