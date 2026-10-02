import type { TraceNode } from "@vela/shared";
import type { ProcessItem } from "./tool-sequence";

export interface ToolDurationSource {
  status?: string;
  durationMs?: number | null;
  startedAt?: number | null;
  completedAt?: number | null;
  executionStartedAt?: number | null;
}

export function formatDuration(ms: number): string {
  const duration = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  if (duration < 1000) return `${Math.floor(duration)}ms`;
  if (duration < 60000) return `${(Math.min(599, Math.round(duration / 100)) / 10).toFixed(1)}s`;
  const seconds = Math.floor(duration / 1000);
  return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

const valid = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** Never infer elapsed time for an unfinished or unrecorded call. */
export function readToolDuration(tool: ToolDurationSource): number | null {
  if (tool.status === "running" || tool.status === "Running") return null;
  if (valid(tool.durationMs)) return tool.durationMs;
  const start = tool.executionStartedAt ?? tool.startedAt;
  return valid(start) && valid(tool.completedAt) && tool.completedAt >= start
    ? tool.completedAt - start
    : null;
}

/** A partial sum must not be presented as the total for an old or running turn. */
export function readTurnDuration(items: readonly (ToolDurationSource | ProcessItem)[]): number | null {
  let total = 0;
  let count = 0;
  for (const item of items) {
    const tool = "messageId" in item ? item.kind === "tool" ? item.tool : null : item;
    if (!tool) continue;
    const duration = readToolDuration(tool);
    if (duration === null) return null;
    total += duration;
    count += 1;
  }
  return count > 0 && Number.isFinite(total) ? total : null;
}

/** ToolTrace has no timing fields; join the existing trace summaries by call ID. */
export function indexToolDurations(nodes: readonly TraceNode[]): Map<string, ToolDurationSource> {
  const calls = new Map<string, TraceNode>();
  for (const node of nodes) {
    if (node.kind !== "tool-call" || !node.toolCallId) continue;
    const previous = calls.get(node.toolCallId);
    if (!previous || node.version >= previous.version) calls.set(node.toolCallId, node);
  }
  return calls;
}
