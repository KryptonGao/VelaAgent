import { isAgentBusy, type AgentControlAction, type AgentInfo } from "@vela/shared";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import { useDismissable } from "../hooks/useDismissable";
import { useEntryArrival } from "../hooks/useEntryArrival";
import type { ToolDisplay } from "../hooks/usePreferences";
import { useFrameTask } from "../hooks/useFrameTask";
import { emptyMessages, type MessageStore } from "../hooks/message-store";
import { useMessages } from "../hooks/useMessages";
import type { UiMessage } from "../hooks/useSession";
import { tr, trf } from "../locale";
import { ActivityIndicator } from "./ActivityIndicator";
import {
  AgentControls, AgentRunStats, AgentStatusMark, agentKindLabel, agentStateText, formatTokenCount, useAgentClock,
} from "./AgentPanel";
import { Markdown } from "./Markdown";
import { Thinking } from "./Thinking";
import { ToolList } from "./ToolCard";
import { BranchIcon } from "./icons";

interface AgentPaneProps {
  agent: AgentInfo;
  agents: readonly AgentInfo[];
  messages?: UiMessage[];
  messageStore?: MessageStore;
  conversationId?: string | null;
  toolDisplay?: ToolDisplay;
  /** 隐藏时卸载内容与订阅，外壳保留滚动位置。 */
  visible?: boolean;
  onSwitch: (agentId: string) => void;
  /** 首次展示某个 agent 时回填历史消息。 */
  ensureMessages: (agentId: string) => void;
  /** 暂停、继续或取消某个子代理。 */
  onControl: (agentId: string, action: AgentControlAction) => void;
}

/**
 * 右侧 Agent Pane：展示选中子代理自己的完整运行流（消息、thinking、工具调用、
 * 状态与最终结论），主对话保持独立滚动互不影响。宽度由共享的拖拽条调整。
 */
type AgentFollow = { pinned: boolean; scrollTop: number };
export function AgentPane(props: AgentPaneProps) {
  const follow = useRef<AgentFollow>({ pinned: true, scrollTop: 0 });
  const scope = JSON.stringify([props.conversationId, props.agent.id]);
  const previousScope = useRef(scope);
  if (previousScope.current !== scope) {
    previousScope.current = scope;
    follow.current = { pinned: true, scrollTop: 0 };
  }
  if (props.visible === false) return null;
  return <VisibleAgentPane {...props} follow={follow} />;
}

function VisibleAgentPane({
  agent, agents, messages: providedMessages, messageStore, conversationId = null,
  toolDisplay, onSwitch, ensureMessages, onControl, follow,
}: AgentPaneProps & { follow: MutableRefObject<AgentFollow> }) {
  const storedMessages = useMessages(messageStore, conversationId, agent.id);
  const messages = messageStore ? storedMessages : providedMessages ?? emptyMessages;
  const agentId = agent.id;
  const scrollRef = useRef<HTMLDivElement>(null);
  const streaming = agent.status === "running";
  const now = useAgentClock([agent]);
  const arrivalKeys = useMemo(() => messages.flatMap((message) => [message.id,
    ...(message.thinking ? [`${message.id}:thinking`] : []),
    ...(message.tools.length ? [`${message.id}:tools`] : []),
    ...(message.text ? [`${message.id}:text`] : []),
  ]), [messages]);

  useEffect(() => {
    ensureMessages(agentId);
  }, [agentId, ensureMessages]);

  // Restore before painting; save on unmount so tab switching keeps the viewport.
  const scheduleFollow = useFrameTask(() => {
    const node = scrollRef.current;
    if (node && follow.current.pinned) node.scrollTop = node.scrollHeight;
  });
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTop = follow.current.pinned ? node.scrollHeight
      : Math.min(follow.current.scrollTop, Math.max(0, node.scrollHeight - node.clientHeight));
    const observer = new ResizeObserver(scheduleFollow);
    const observeContent = () => { for (const child of node.children) observer.observe(child); };
    observeContent();
    const mutations = new MutationObserver(observeContent);
    mutations.observe(node, { childList: true });
    observer.observe(node);
    return () => {
      follow.current.scrollTop = node.scrollTop;
      observer.disconnect();
      mutations.disconnect();
    };
  }, [follow, scheduleFollow]);

  useLayoutEffect(scheduleFollow, [scheduleFollow, messages]);

  const onScroll = (): void => {
    const node = scrollRef.current;
    if (!node) return;
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
    follow.current.pinned = distance <= 32;
    follow.current.scrollTop = node.scrollTop;
  };

  const arrivalRef = useEntryArrival(agentId, arrivalKeys, 0, false);
  return (
    <section
      ref={arrivalRef}
      className="agent-pane"
      aria-label={`${tr("子代理", "Subagent")} ${agent.path}`}
    >
      <header className="agent-pane-header">
        <div className="agent-pane-title">
          <AgentStatusMark status={agent.status} />
          <AgentBreadcrumb agent={agent} agents={agents} onSwitch={onSwitch} />
          <span className="agent-kind">{agentKindLabel(agent.kind)}</span>
          <span className={`agent-state is-${agent.status}`}>{agentStateText(agent)}</span>
        </div>
        <div className="agent-pane-actions">
          <AgentRunStats agent={agent} now={now} />
          <AgentControls agent={agent} onControl={onControl} />
          <AgentRosterMenu agents={agents} activeId={agentId} onSelect={onSwitch} onControl={onControl} />
        </div>
      </header>
      <div className="agent-pane-scroll" ref={scrollRef} onScroll={onScroll}>
        {agent.historyIncomplete ? (
          <p className="agent-history-notice">
            {tr("此历史会话仅保留任务、工具步骤摘要和最终结论；思考与完整工具输出未保存。",
              "This historical session retains only the task, tool summaries, and final result. Thinking and full tool output were not saved.")}
          </p>
        ) : null}
        {messages.length === 0 ? (
          agent.finalText ? (
            <div className="agent-stream">
              <article className="agent-stream-message is-assistant">
                <div className="agent-stream-text">
                  <Markdown text={agent.finalText} />
                </div>
              </article>
            </div>
          ) : (
            <div className="agent-pane-empty">
              {streaming ? (
                <>
                  <ActivityIndicator />
                  <p>{tr("子代理正在启动…", "Subagent is starting…")}</p>
                </>
              ) : (
                <p>{tr("没有可展示的运行记录。", "No run output to show.")}</p>
              )}
            </div>
          )
        ) : (
          <div className="agent-stream">
            {messages.map((message, index) => (
              <AgentStreamMessage
                key={`${agentId}:${message.id}`}
                message={message}
                streaming={streaming && index === messages.length - 1}
                toolDisplay={toolDisplay}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

/** 面包屑按树路径逐段展示，点任意祖先可直接切过去。 */
function AgentBreadcrumb({
  agent,
  agents,
  onSwitch,
}: {
  agent: AgentInfo;
  agents: readonly AgentInfo[];
  onSwitch: (agentId: string) => void;
}) {
  const parts = agent.path.split("/").filter(Boolean);
  const nodes: ReactNode[] = [];
  let accumulated = "";
  parts.forEach((part, index) => {
    accumulated += `/${part}`;
    const target = index === 0
      ? null
      : agents.find((item) => item.kind !== "root" && item.path === accumulated) ?? null;
    nodes.push(
      <span className="agent-breadcrumb-sep" key={`sep-${accumulated}`} aria-hidden="true">
        /
      </span>,
    );
    nodes.push(
      target ? (
        <button
          key={accumulated}
          className="agent-breadcrumb-segment is-link"
          type="button"
          title={trf("切换到 {0}", "Switch to {0}", accumulated)}
          onClick={() => onSwitch(target.id)}
        >
          {part}
        </button>
      ) : (
        <span
          key={accumulated}
          className={`agent-breadcrumb-segment${index === parts.length - 1 ? " is-current" : ""}`}
        >
          {part}
        </span>
      ),
    );
  });
  return (
    <nav className="agent-breadcrumb" aria-label={tr("agent 路径", "Agent path")}>
      {nodes}
    </nav>
  );
}

/** SubAgents 面板：每个子代理的状态、token、耗时，以及单独的暂停 / 继续 / 取消。 */
function AgentRosterMenu({
  agents,
  activeId,
  onSelect,
  onControl,
}: {
  agents: readonly AgentInfo[];
  activeId: string;
  onSelect: (agentId: string) => void;
  onControl: (agentId: string, action: AgentControlAction) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useDismissable<HTMLDivElement>(open, () => setOpen(false));
  const items = useMemo(
    () => agents.filter((item) => item.kind !== "root").sort((a, b) => a.createdAt - b.createdAt),
    [agents],
  );
  const now = useAgentClock(open ? items : []);
  if (items.length === 0) return null;
  const active = items.filter((item) => isAgentBusy(item.status)).length;
  const totalTokens = items.reduce((sum, item) => sum + item.usage.total, 0);
  return (
    <div className="agent-roster-menu-anchor" ref={ref}>
      <button
        className={`view-icon-btn${open ? " active" : ""}`}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={tr("子代理面板", "Subagents panel")}
        aria-label={tr("子代理面板", "Subagents panel")}
        onClick={() => setOpen((value) => !value)}
      >
        <BranchIcon size={13} />
      </button>
      {open ? (
        <div className="agent-roster-menu" role="listbox" aria-label={tr("子代理列表", "Subagent list")}>
          <div className="agent-roster-summary">
            <span>{trf("{0} 个子代理 · {1} 个进行中", "{0} subagents · {1} active", items.length, active)}</span>
            <span className="agent-run-stat" title={tr("所有子代理累计 token", "Total tokens across all subagents")}>
              {formatTokenCount(totalTokens)} tok
            </span>
          </div>
          {items.map((item) => (
            <div
              key={item.id}
              className={`agent-roster-row${item.id === activeId ? " is-active" : ""}`}
              style={{ paddingLeft: 10 + Math.max(0, item.depth - 1) * 14 }}
            >
              <button
                className="agent-roster-menu-item"
                type="button"
                role="option"
                aria-selected={item.id === activeId}
                onClick={() => {
                  onSelect(item.id);
                  setOpen(false);
                }}
              >
                <AgentStatusMark status={item.status} />
                <span className="agent-roster-menu-path">{item.path}</span>
                <span className="agent-roster-menu-meta">{agentKindLabel(item.kind)}</span>
              </button>
              <div className="agent-roster-row-detail">
                <span className={`agent-state is-${item.status}`}>{agentStateText(item)}</span>
                <AgentRunStats agent={item} now={now} />
                <AgentControls agent={item} onControl={onControl} />
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

const AgentStreamMessage = memo(function AgentStreamMessage({
  message,
  streaming,
  toolDisplay,
}: {
  message: UiMessage;
  streaming: boolean;
  toolDisplay?: ToolDisplay;
}) {
  if (message.role === "user") {
    return (
      <article className="agent-stream-message is-user" data-arrival-key={message.id}>
        <div className="agent-stream-user">
          {message.text ? <Markdown text={message.text} /> : null}
        </div>
      </article>
    );
  }
  const thinkingActive = streaming && !message.text;
  return (
    <article className="agent-stream-message is-assistant" data-arrival-key={message.id}>
      {message.thinking ? (
        <div data-arrival-key={`${message.id}:thinking`}><Thinking
          text={message.thinking}
          active={thinkingActive}
          showActivityIndicator={thinkingActive && toolDisplay === "compact"}
        /></div>
      ) : null}
      {message.tools.length > 0 ? <div data-arrival-key={`${message.id}:tools`}><ToolList tools={message.tools} display={toolDisplay} /></div> : null}
      {message.text ? (
        <div className="agent-stream-text" data-arrival-key={`${message.id}:text`}>
          <Markdown text={message.text} streaming={streaming} />
        </div>
      ) : null}
    </article>
  );
});
