/** Renderer-safe trace summaries. Full payloads are fetched only for the selected node. */
export type TraceStatus = "Running" | "Completed" | "Failed" | "Interrupted";
export type TraceKind =
  | "system"
  | "user"
  | "thinking"
  | "assistant"
  | "tool-call"
  | "tool-result"
  | "error"
  | "state";
export interface TraceToolDefinition {
  name: string;
  description: string;
  parameters: unknown;
  constrainedSampling?: unknown;
}
export interface TraceContextSnapshot {
  id: string;
  systemPrompt: string | null;
  tools: TraceToolDefinition[];
  recorded: boolean;
}
export interface TraceUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
}
export interface TraceRequest {
  id: string;
  number: number;
  turn: number;
  model: string;
  status: TraceStatus;
  contextId: string;
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
  firstTokenMs: number | null;
  generationMs: number | null;
  usage: TraceUsage | null;
}
/** A standalone model request outside the turn flow, such as a thinking summary. */
export interface TraceSummaryRequest {
  id: string;
  model: string;
  status: "Completed" | "Failed";
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
  usage: TraceUsage | null;
}
export interface TraceNode {
  mcp?: { server: string; tool: string };
  id: string;
  sequence: number;
  kind: TraceKind;
  turn: number;
  step: number;
  requestId: string | null;
  toolCallId: string | null;
  toolName: string | null;
  status: TraceStatus;
  summary: string;
  startedAt: number | null;
  completedAt: number | null;
  executionStartedAt: number | null;
  durationMs: number | null;
  version: number;
  historical: boolean;
}
export interface TraceDetails {
  node: TraceNode;
  content: string;
  raw: unknown;
  source: unknown;
  arguments: unknown;
  result: unknown;
  context: TraceContextSnapshot | null;
  request: TraceRequest | null;
  responseBlocks: unknown[];
}
export interface TraceSnapshot {
  version: number;
  nodes: TraceNode[];
  requests: TraceRequest[];
  summaries: TraceSummaryRequest[];
  warning: string | null;
}
export interface TraceUpdate extends TraceSnapshot {
  /** Complete replacement after a conversation rewind. */
  reset?: boolean;
  type: "trace";
  conversationId: string;
}
