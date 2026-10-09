import { agentElapsedMs, isAgentBusy, type AgentControlAction, type AgentInfo, type SubagentKind } from "@vela/shared";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { ActivityIndicator } from "./ActivityIndicator";
import { PauseIcon, PlayIcon, StopSquareIcon } from "./icons";
import { tr, trf } from "../locale";

export interface AgentWorkspaceValue {
  /** 当前对话的常驻 agent 树快照。 */
  agents: readonly AgentInfo[];
  /** 右侧 Agent Pane 正在展示的 agent；null 表示单栏。 */
  activeAgentId: string | null;
  openAgent: (agentId: string) => void;
  closeAgent: () => void;
}

const AgentWorkspaceContext = createContext<AgentWorkspaceValue>({
  agents: [],
  activeAgentId: null,
  openAgent: () => undefined,
  closeAgent: () => undefined,
});

/** 主对话和右侧 Agent Pane 共享同一份 agent 树与打开状态。 */
export function AgentWorkspaceProvider({
  agents,
  activeAgentId,
  openAgent,
  closeAgent,
  children,
}: AgentWorkspaceValue & { children: ReactNode }) {
  const value = useMemo(() => ({ agents, activeAgentId, openAgent, closeAgent }),
    [agents, activeAgentId, openAgent, closeAgent]);
  return (
    <AgentWorkspaceContext.Provider value={value}>
      {children}
    </AgentWorkspaceContext.Provider>
  );
}

export function useAgentWorkspace(): AgentWorkspaceValue {
  return useContext(AgentWorkspaceContext);
}

export function useAgentRoster(): readonly AgentInfo[] {
  return useAgentWorkspace().agents;
}

/** 卡片优先按 id 找 agent，找不到再退回路径匹配。 */
export function findAgentInfo(
  agents: readonly AgentInfo[],
  agentId: string | undefined,
  agentPath: string | undefined,
): AgentInfo | null {
  if (agents.length === 0) return null;
  if (agentId) {
    const found = agents.find((agent) => agent.id === agentId);
    if (found) return found;
  }
  if (agentPath) {
    const found = agents.find((agent) => agent.path === agentPath);
    if (found) return found;
  }
  return null;
}

const statusLabels: Record<AgentInfo["status"], [string, string]> = {
  idle: ["待命", "Idle"],
  running: ["运行中", "Running"],
  paused: ["已暂停", "Paused"],
  completed: ["已完成", "Completed"],
  failed: ["失败", "Failed"],
  aborted: ["已停止", "Stopped"],
};

export function agentStatusLabel(status: AgentInfo["status"]): string {
  const [zh, en] = statusLabels[status];
  return tr(zh, en);
}

/** 状态文案；已请求暂停但还没停下时显示「暂停中」。 */
export function agentStateText(agent: Pick<AgentInfo, "status" | "pauseRequested">): string {
  return agent.status === "running" && agent.pauseRequested
    ? tr("暂停中", "Pausing")
    : agentStatusLabel(agent.status);
}

/** 12,345 → 12.3k；1,234,567 → 1.23M。 */
export function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return String(Math.round(tokens));
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
  return `${(tokens / 1_000_000).toFixed(2)}M`;
}

/** 42s、3m 05s、1h 02m。 */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** 有代理在计时时每秒刷新一次当前时间；全都停着就不起定时器。 */
export function useAgentClock(agents: readonly Pick<AgentInfo, "runningSince">[]): number {
  const ticking = agents.some((agent) => agent.runningSince !== null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [ticking]);
  return now;
}

/** 单个代理的 token 与耗时；token 悬停时给出输入、输出和缓存明细。 */
export function AgentRunStats({ agent, now }: { agent: AgentInfo; now: number }) {
  const { usage } = agent;
  const detail = trf(
    "输入 {0} · 输出 {1} · 缓存读 {2} · 缓存写 {3}",
    "Input {0} · Output {1} · Cache read {2} · Cache write {3}",
    formatTokenCount(usage.input), formatTokenCount(usage.output),
    formatTokenCount(usage.cacheRead), formatTokenCount(usage.cacheWrite),
  );
  return (
    <span className="agent-run-stats">
      <span className="agent-run-stat" title={detail}>
        {usage.total > 0 ? `${formatTokenCount(usage.total)} tok` : "— tok"}
      </span>
      <span className="agent-run-stat" title={tr("累计运行时间（不含暂停）", "Active run time (excludes paused time)")}>
        {formatElapsed(agentElapsedMs(agent, now))}
      </span>
    </span>
  );
}

/** 暂停 / 继续 / 取消；只在当前状态下可行的操作才出现。 */
export function AgentControls({
  agent,
  onControl,
}: {
  agent: AgentInfo;
  onControl: (agentId: string, action: AgentControlAction) => void;
}) {
  if (agent.kind === "root") return null;
  const busy = isAgentBusy(agent.status);
  const canCancel = busy || agent.status === "idle";
  const canResume = agent.status === "paused" || (agent.status === "running" && agent.pauseRequested);
  const canPause = agent.status === "running" && !agent.pauseRequested;
  if (!canCancel && !canResume && !canPause) return null;
  const act = (action: AgentControlAction) => (event: { stopPropagation: () => void }): void => {
    event.stopPropagation();
    onControl(agent.id, action);
  };
  const pauseTitle = tr("暂停（在下一次调用工具前生效）", "Pause (takes effect before the next tool call)");
  const resumeTitle = agent.status === "paused" ? tr("继续", "Resume") : tr("取消暂停请求", "Cancel pause request");
  const cancelTitle = tr("取消这个子代理（包含它派出的子代理）", "Cancel this subagent (and any it spawned)");
  return (
    <span className="agent-controls">
      {canPause ? (
        <button className="agent-control-btn" type="button" title={pauseTitle} aria-label={pauseTitle} onClick={act("pause")}>
          <PauseIcon size={12} />
        </button>
      ) : null}
      {canResume ? (
        <button className="agent-control-btn" type="button" title={resumeTitle} aria-label={resumeTitle} onClick={act("resume")}>
          <PlayIcon size={12} />
        </button>
      ) : null}
      {canCancel ? (
        <button className="agent-control-btn is-danger" type="button" title={cancelTitle} aria-label={cancelTitle} onClick={act("cancel")}>
          <StopSquareIcon size={12} />
        </button>
      ) : null}
    </span>
  );
}

export function agentKindLabel(kind: AgentInfo["kind"] | SubagentKind | undefined): string {
  if (kind === "explore") return tr("查阅", "Explore");
  if (kind === "general") return tr("执行", "General");
  if (kind === "root") return tr("主代理", "Root");
  return tr("子代理", "Subagent");
}

/** 单条 agent 的状态标记：运行中转圈，其余用小圆点。 */
export function AgentStatusMark({ status }: { status: AgentInfo["status"] }) {
  if (status === "running") return <ActivityIndicator />;
  return (
    <span
      className={`agent-status-dot is-${status}`}
      role="img"
      aria-label={agentStatusLabel(status)}
    />
  );
}
