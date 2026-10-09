import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { agentStatuses, emptyAgentUsage, type AgentInfo, type AgentUsage, type TranscriptMessage } from "@vela/shared";

/** 子代理索引；完整消息保存在独立的 Pi JSONL 会话里。 */
export interface StoredAgent extends AgentInfo {
  sessionFile: string | null;
}

export function normalizeStoredAgents(value: unknown): StoredAgent[] {
  if (!Array.isArray(value)) return [];
  const result: StoredAgent[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const record = object(item);
    if (!record || typeof record.id !== "string" || !record.id || seen.has(record.id)
      || typeof record.path !== "string" || !record.path.startsWith("/root/")
      || (record.kind !== "explore" && record.kind !== "general")) continue;
    seen.add(record.id);
    const status = agentStatuses.includes(record.status as AgentInfo["status"])
      ? record.status as AgentInfo["status"] : "aborted";
    result.push({
      historyIncomplete: record.historyIncomplete === true || !record.sessionFile,
      id: record.id,
      parentId: typeof record.parentId === "string" ? record.parentId : null,
      path: record.path,
      name: typeof record.name === "string" ? record.name : record.path.split("/").at(-1) ?? "agent",
      kind: record.kind,
      // 进程退出后原来的任务不会自动续跑，不能继续显示运行中。
      status: status === "running" || status === "idle" || status === "paused" ? "aborted" : status,
      depth: record.path.split("/").filter(Boolean).length - 1,
      task: typeof record.task === "string" ? record.task : "",
      steps: Array.isArray(record.steps) ? record.steps.flatMap((step) => {
        const entry = object(step);
        if (!entry || typeof entry.id !== "string" || typeof entry.name !== "string") return [];
        return [{ id: entry.id, name: entry.name,
          summary: typeof entry.summary === "string" ? entry.summary : entry.name,
          status: entry.status === "running" || entry.status === "error" ? "error" as const : "done" as const }];
      }) : [],
      mutated: record.mutated === true,
      finalText: typeof record.finalText === "string" ? unwrapAgentReport(record.finalText) : null,
      error: typeof record.error === "string" ? record.error : null,
      usage: normalizeUsage(record.usage),
      activeMs: finiteNumber(record.activeMs),
      // 进程退出时的运行片段不再续计。
      runningSince: null,
      pauseRequested: false,
      createdAt: finiteNumber(record.createdAt),
      updatedAt: finiteNumber(record.updatedAt),
      sessionFile: typeof record.sessionFile === "string" ? record.sessionFile : null,
    });
  }
  return result;
}

/** 旧版只有主会话落盘，从工具结果与子代理回传中找回可用的任务、步骤和结论。 */
export function recoverLegacyAgents(messages: readonly AgentMessage[], conversationId: string): StoredAgent[] {
  const records = new Map<string, Record<string, unknown>>();
  const calls = new Map<string, Record<string, unknown>>();
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "toolCall" && part.name === "spawn_agent") {
          calls.set(part.id, object(part.arguments) ?? {});
        }
      }
      continue;
    }
    if (message.role !== "toolResult" && message.role !== "custom") continue;
    if (message.role === "custom" && message.customType !== "vela_agent_result") continue;
    const details = object(message.details);
    if (!details || typeof details.agentId !== "string" || typeof details.path !== "string") continue;
    const previous = records.get(details.agentId);
    const args = message.role === "toolResult" ? calls.get(message.toolCallId) : null;
    const content = typeof message.content === "string" ? message.content
      : message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    records.set(details.agentId, {
      ...previous, ...details, id: details.agentId,
      parentId: conversationId,
      task: typeof args?.task === "string" ? args.task : previous?.task ?? "",
      createdAt: previous?.createdAt ?? message.timestamp,
      updatedAt: message.timestamp,
      finalText: typeof details.finalText === "string" ? details.finalText
        : message.role === "custom" ? unwrapAgentReport(content) : previous?.finalText ?? null,
      status: message.role === "custom" ? details.status ?? "completed" : details.status ?? previous?.status,
      sessionFile: null,
    });
  }
  const agents = normalizeStoredAgents([...records.values()]);
  for (const agent of agents) {
    const parentPath = agent.path.slice(0, agent.path.lastIndexOf("/"));
    agent.parentId = agents.find((parent) => parent.path === parentPath)?.id ?? conversationId;
  }
  return agents;
}

/** 只展示磁盘上确实存在的旧记录；步骤摘要不能当成完整工具输出。 */
export function legacyAgentTranscript(agent: StoredAgent): TranscriptMessage[] {
  const messages: TranscriptMessage[] = [];
  if (agent.task) messages.push({ id: `${agent.id}:task`, role: "user", text: agent.task,
    thinking: "", tools: [], timestamp: agent.createdAt });
  if (agent.steps.length || agent.finalText || agent.error) {
    messages.push({ id: `${agent.id}:result`, role: "assistant", text: agent.finalText ?? agent.error ?? "",
      thinking: "", timestamp: agent.updatedAt,
      tools: agent.steps.map((step) => ({ id: step.id, name: step.name,
        status: step.status === "done" ? "done" : "error",
        activity: step.name === "bash" ? { command: step.summary }
          : ["read", "edit", "write"].includes(step.name) ? { path: step.summary } : { body: step.summary },
      })),
    });
  }
  return messages;
}

function unwrapAgentReport(content: string): string {
  return content.replace(/^\[子代理 [^\n]+\]\s*\n+/, "")
    .replace(/^\[\/root\/[^\n]+ · (?:explore|general)\]\s*\n+/, "").trim();
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function normalizeUsage(value: unknown): AgentUsage {
  const record = object(value);
  if (!record) return { ...emptyAgentUsage };
  return {
    input: finiteNumber(record.input), output: finiteNumber(record.output),
    cacheRead: finiteNumber(record.cacheRead), cacheWrite: finiteNumber(record.cacheWrite),
    total: finiteNumber(record.total),
  };
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
