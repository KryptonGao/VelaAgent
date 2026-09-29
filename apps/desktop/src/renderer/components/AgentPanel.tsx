import type { AgentInfo, SubagentKind } from "@vela/shared";
import { createContext, useContext, type ReactNode } from "react";
import { ActivityIndicator } from "./ActivityIndicator";
import { tr } from "../locale";

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
  return (
    <AgentWorkspaceContext.Provider value={{ agents, activeAgentId, openAgent, closeAgent }}>
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
  completed: ["已完成", "Completed"],
  failed: ["失败", "Failed"],
  aborted: ["已停止", "Stopped"],
};

export function agentStatusLabel(status: AgentInfo["status"]): string {
  const [zh, en] = statusLabels[status];
  return tr(zh, en);
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
