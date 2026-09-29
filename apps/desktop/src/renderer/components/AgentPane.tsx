import type { AgentInfo } from "@vela/shared";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useDismissable } from "../hooks/useDismissable";
import type { SidebarResize } from "../hooks/useSidebarResize";
import type { ToolDisplay } from "../hooks/usePreferences";
import type { UiMessage } from "../hooks/useSession";
import { tr } from "../locale";
import { ActivityIndicator } from "./ActivityIndicator";
import { AgentStatusMark, agentKindLabel, agentStatusLabel } from "./AgentPanel";
import { Markdown } from "./Markdown";
import { SidebarResizeHandle } from "./SidebarResizeHandle";
import { Thinking } from "./Thinking";
import { ToolList } from "./ToolCard";
import { BranchIcon, CloseIcon } from "./icons";

interface AgentPaneProps {
  agent: AgentInfo;
  agents: readonly AgentInfo[];
  messages: UiMessage[];
  toolDisplay?: ToolDisplay;
  resize: SidebarResize;
  onSwitch: (agentId: string) => void;
  onClose: () => void;
  /** 首次展示某个 agent 时回填历史消息。 */
  ensureMessages: (agentId: string) => void;
}

/**
 * 右侧 Agent Pane：展示选中子代理自己的完整运行流（消息、thinking、工具调用、
 * 状态与最终结论），主对话保持独立滚动互不影响。宽度由共享的拖拽条调整。
 */
export function AgentPane({
  agent,
  agents,
  messages,
  toolDisplay,
  resize,
  onSwitch,
  onClose,
  ensureMessages,
}: AgentPaneProps) {
  const agentId = agent.id;
  const scrollRef = useRef<HTMLDivElement>(null);
  /** agentId -> 滚动位置与是否贴底跟随；切换 agent 时各自恢复。 */
  const followRef = useRef<Record<string, { pinned: boolean; scrollTop: number }>>({});
  const streaming = agent.status === "running";

  useEffect(() => {
    ensureMessages(agentId);
  }, [agentId, ensureMessages]);

  // 切换 agent：恢复它自己的滚动位置；仍在贴底就继续跟随。
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const state = (followRef.current[agentId] ??= { pinned: true, scrollTop: 0 });
    node.scrollTop = state.pinned
      ? node.scrollHeight
      : Math.min(state.scrollTop, Math.max(0, node.scrollHeight - node.clientHeight));
  }, [agentId]);

  // 内容更新（流式文本、工具步骤）：只有贴底时才跟随。
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const state = followRef.current[agentId];
    if (state?.pinned) node.scrollTop = node.scrollHeight;
  }, [agentId, messages]);

  const onScroll = (): void => {
    const node = scrollRef.current;
    if (!node) return;
    const state = (followRef.current[agentId] ??= { pinned: true, scrollTop: 0 });
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
    state.pinned = distance <= 32;
    state.scrollTop = node.scrollTop;
  };

  return (
    <section className="agent-pane" aria-label={`${tr("子代理", "Subagent")} ${agent.path}`}>
      <SidebarResizeHandle target="agent" resize={resize} />
      <header className="agent-pane-header">
        <div className="agent-pane-title">
          <AgentStatusMark status={agent.status} />
          <AgentBreadcrumb agent={agent} agents={agents} onSwitch={onSwitch} />
          <span className="agent-kind">{agentKindLabel(agent.kind)}</span>
          <span className={`agent-state is-${agent.status}`}>{agentStatusLabel(agent.status)}</span>
        </div>
        <div className="agent-pane-actions">
          <AgentRosterMenu agents={agents} activeId={agentId} onSelect={onSwitch} />
          <button
            className="view-icon-btn"
            type="button"
            title={tr("关闭子代理面板", "Close subagent pane")}
            aria-label={tr("关闭子代理面板", "Close subagent pane")}
            onClick={onClose}
          >
            <CloseIcon size={13} />
          </button>
        </div>
      </header>
      <div className="agent-pane-scroll" ref={scrollRef} onScroll={onScroll}>
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
                key={message.id}
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
          title={tr(`切换到 ${accumulated}`, `Switch to ${accumulated}`)}
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

/** Agent Tree / Roster：平铺按深度缩进，用来切换右侧显示的 agent。 */
function AgentRosterMenu({
  agents,
  activeId,
  onSelect,
}: {
  agents: readonly AgentInfo[];
  activeId: string;
  onSelect: (agentId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useDismissable<HTMLDivElement>(open, () => setOpen(false));
  const items = agents
    .filter((item) => item.kind !== "root")
    .sort((a, b) => a.createdAt - b.createdAt);
  if (items.length === 0) return null;
  return (
    <div className="agent-roster-menu-anchor" ref={ref}>
      <button
        className={`view-icon-btn${open ? " active" : ""}`}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={tr("切换子代理", "Switch subagent")}
        aria-label={tr("切换子代理", "Switch subagent")}
        onClick={() => setOpen((value) => !value)}
      >
        <BranchIcon size={13} />
      </button>
      {open ? (
        <div className="agent-roster-menu" role="listbox" aria-label={tr("子代理列表", "Subagent list")}>
          {items.map((item) => (
            <button
              key={item.id}
              className={`agent-roster-menu-item${item.id === activeId ? " is-active" : ""}`}
              type="button"
              role="option"
              aria-selected={item.id === activeId}
              style={{ paddingLeft: 10 + Math.max(0, item.depth - 1) * 14 }}
              onClick={() => {
                onSelect(item.id);
                setOpen(false);
              }}
            >
              <AgentStatusMark status={item.status} />
              <span className="agent-roster-menu-path">{item.path}</span>
              <span className="agent-roster-menu-meta">{agentKindLabel(item.kind)}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function AgentStreamMessage({
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
      <article className="agent-stream-message is-user">
        <div className="agent-stream-user">
          {message.text ? <Markdown text={message.text} /> : null}
        </div>
      </article>
    );
  }
  const thinkingActive = streaming && !message.text;
  return (
    <article className="agent-stream-message is-assistant">
      {message.thinking ? (
        <Thinking
          text={message.thinking}
          active={thinkingActive}
          showActivityIndicator={thinkingActive && toolDisplay === "compact"}
        />
      ) : null}
      {message.tools.length > 0 ? <ToolList tools={message.tools} display={toolDisplay} /> : null}
      {message.text ? (
        <div className="agent-stream-text">
          <Markdown text={message.text} />
        </div>
      ) : null}
    </article>
  );
}
