import { isPlanExecutionPrompt } from "./plan";
import { goalContinuePrompt } from "./interaction";
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import type {
  AgentSessionEvent,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  getCurrentSystemMessage,
  getSystemMessageText,
  getCurrentTools,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import type {
  TraceContextSnapshot,
  TraceDetails,
  TraceKind,
  TraceNode,
  TraceRequest,
  TraceSnapshot,
  TraceStatus,
  TraceUpdate,
  TraceUsage,
} from "@vela/shared";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

interface StoredNode {
  node: TraceNode;
  content: string;
  raw: unknown;
  source: unknown;
  arguments: unknown;
  result: unknown;
  contextId: string | null;
}
interface StoredRequest {
  request: TraceRequest;
  blocks: unknown[];
}
type RecordEntry =
  | { type: "node"; value: StoredNode }
  | { type: "request"; value: StoredRequest }
  | { type: "context"; value: TraceContextSnapshot };
const clone = <T>(value: T): T =>
  value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
const summary = (value: string) => value.replace(/\s+/g, " ").slice(0, 220);
const printable = (value: unknown): string =>
  typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? "");
function outputText(value: unknown): string {
  if (typeof value === "string") return value;
  if (
    value &&
    typeof value === "object" &&
    "content" in value &&
    typeof value.content === "string"
  )
    return value.content;
  if (
    value &&
    typeof value === "object" &&
    "content" in value &&
    Array.isArray(value.content)
  ) {
    return value.content
      .map((p: { type?: string; text?: string }) =>
        p.type === "text" ? (p.text ?? "") : `[${p.type ?? "content"}]`,
      )
      .join("\n");
  }
  return printable(value);
}
function usageOf(message: AssistantMessage): TraceUsage | null {
  if (!message.usage) return null;
  const u = message.usage;
  return {
    input: u.input,
    output: u.output,
    cacheRead: u.cacheRead,
    cacheWrite: u.cacheWrite,
    totalTokens: u.totalTokens,
  };
}

/** Owns raw trace data independently of chat truncation and context compaction. */
export class TraceRecorder {
  private nodes = new Map<string, StoredNode>();
  private requests = new Map<string, StoredRequest>();
  private contexts = new Map<string, TraceContextSnapshot>();
  private dirtyNodes = new Set<string>();
  private dirtyRequests = new Set<string>();
  private dirtyContexts = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private version = 0;
  private sequence = 0;
  private turn = 0;
  private currentRequest: string | null = null;
  private requestClock = new Map<
    string,
    { start: number; first: number | null }
  >();
  private requestPending = false;
  private operation: { id: string; start: number } | null = null;
  private calls = new Map<string, string>();
  private toolClock = new Map<string, number>();
  private lastContext: string | null = null;
  private warning: string | null = null;
  private needsSeparator = false;

  constructor(
    readonly conversationId: string,
    private file: string,
    private emit: (event: TraceUpdate) => void,
    private clock = { wall: () => Date.now(), mono: () => performance.now() },
  ) {
    if (existsSync(file)) {
      let lines: string[] = [];
      try {
        const text = readFileSync(file, "utf8");
        this.needsSeparator = Boolean(text) && !text.endsWith("\n");
        lines = text.split("\n").filter(Boolean);
      } catch (error) {
        this.warning = `轨迹读取失败：${String(error)}`;
      }
      for (let index = 0; index < lines.length; index++) {
        try {
          const record = JSON.parse(lines[index]!) as RecordEntry;
          if (record.type === "node")
            this.nodes.set(record.value.node.id, record.value);
          else if (record.type === "request")
            this.requests.set(record.value.request.id, record.value);
          else if (record.type === "context")
            this.contexts.set(record.value.id, record.value);
        } catch {
          this.warning = "轨迹文件部分记录无法读取；已保留可恢复内容。";
        }
      }
      for (const stored of this.nodes.values()) {
        if (stored.node.kind === "tool-call" && stored.node.toolCallId)
          this.calls.set(stored.node.toolCallId, stored.node.id);
        this.sequence = Math.max(this.sequence, stored.node.sequence);
        this.turn = Math.max(this.turn, stored.node.turn);
        this.version = Math.max(this.version, stored.node.version);
        if (stored.node.status === "Running") {
          stored.node.status = "Interrupted";
          this.touch(stored);
        }
      }
      for (const stored of this.requests.values()) {
        if (stored.request.status === "Running") {
          stored.request.status = "Interrupted";
          this.dirtyRequests.add(stored.request.id);
        }
      }
      this.lastContext = [...this.contexts.keys()].at(-1) ?? null;
      this.flush();
    }
  }

  snapshot(): TraceSnapshot {
    return {
      version: this.version,
      nodes: [...this.nodes.values()]
        .map((s) => ({ ...s.node }))
        .sort((a, b) => a.sequence - b.sequence),
      requests: [...this.requests.values()].map((s) => clone(s.request)),
      warning: this.warning,
    };
  }
  details(id: string): TraceDetails | null {
    const s = this.nodes.get(id);
    if (!s) return null;
    const r = s.node.requestId ? this.requests.get(s.node.requestId) : null;
    const contextId = r?.request.contextId ?? s.contextId;
    const call = s.node.toolCallId ? this.findCall(s.node.toolCallId) : null;
    const node =
      s.node.kind === "tool-result" && call
        ? {
            ...s.node,
            executionStartedAt: call.node.executionStartedAt,
            durationMs: call.node.durationMs,
          }
        : s.node;
    return clone({
      node,
      content: s.content,
      raw: s.raw,
      source: s.source,
      arguments: call?.arguments ?? s.arguments,
      result: call?.result ?? s.result,
      context: contextId ? (this.contexts.get(contextId) ?? null) : null,
      request: r?.request ?? null,
      responseBlocks: r?.blocks ?? [],
    });
  }
  private create(
    kind: TraceKind,
    id: string,
    text: string,
    time: number | null,
    requestId: string | null = this.currentRequest,
  ): StoredNode {
    const request = requestId ? this.requests.get(requestId)?.request : null;
    const s: StoredNode = {
      node: {
        id,
        sequence: ++this.sequence,
        kind,
        turn: this.turn,
        step: request
          ? [...this.requests.values()].filter(
              (r) => r.request.turn === this.turn,
            ).length
          : 0,
        requestId,
        toolCallId: null,
        toolName: null,
        status: "Running",
        summary: summary(text),
        startedAt: time,
        completedAt: null,
        executionStartedAt: null,
        durationMs: null,
        version: 0,
        historical: false,
      },
      content: text,
      raw: null,
      source: null,
      arguments: null,
      result: null,
      contextId: null,
    };
    this.nodes.set(id, s);
    this.touch(s);
    return s;
  }
  private touch(s: StoredNode) {
    s.node.version = ++this.version;
    s.node.summary = summary(s.content);
    this.dirtyNodes.add(s.node.id);
    this.schedule();
  }
  private schedule() {
    if (!this.timer) this.timer = setTimeout(() => this.flush(), 100);
  }
  private findCall(id: string) {
    const nodeId = this.calls.get(id);
    return nodeId ? this.nodes.get(nodeId) : undefined;
  }
  capture(action: () => void) {
    try {
      action();
    } catch (error) {
      this.warning = `轨迹采集异常：${String(error)}`;
      this.emit({
        type: "trace",
        conversationId: this.conversationId,
        version: ++this.version,
        nodes: [],
        requests: [],
        warning: this.warning,
      });
    }
  }
  private context(messages: AgentMessage[], recorded: boolean): string {
    const system = getCurrentSystemMessage(messages);
    const tools = getCurrentTools(messages);
    const prompt = system ? getSystemMessageText(system) : null;
    const previous = this.lastContext
      ? this.contexts.get(this.lastContext)
      : null;
    if (
      previous &&
      previous.systemPrompt === prompt &&
      JSON.stringify(previous.tools) === JSON.stringify(tools)
    )
      return previous.id;
    const id = `context-${this.contexts.size + 1}`;
    const c: TraceContextSnapshot = {
      id,
      systemPrompt: prompt,
      tools: tools.map((t) => ({ ...t })),
      recorded,
    };
    this.contexts.set(id, clone(c));
    this.lastContext = id;
    this.dirtyContexts.add(id);
    const node = this.create(
      "system",
      `system-${id}`,
      this.contexts.size === 1 ? "初始系统提示词" : "系统提示词 / 工具定义变更",
      recorded ? this.clock.wall() : null,
      null,
    );
    node.contextId = id;
    node.node.status = "Completed";
    this.touch(node);
    return id;
  }

  /** Called immediately before the real stream function, after final context conversion. */
  wrapStream(original: StreamFn): StreamFn {
    return (model, context, options) => {
      if (!this.requestPending) return original(model, context, options);
      this.requestPending = false;
      let id: string | null = null;
      this.capture(() => {
        id = this.beginRequest(
          context.messages as AgentMessage[],
          `${model.provider}/${model.id}`,
        );
      });
      try {
        return original(model, context, options);
      } catch (error) {
        this.fail(error instanceof Error ? error.message : String(error));
        if (id) this.finishRequest(id, "Failed");
        throw error;
      }
    };
  }
  beginRequest(messages: AgentMessage[], model: string): string {
    const contextId = this.context(messages, true);
    const id = `request-${this.requests.size + 1}`;
    const request: TraceRequest = {
      id,
      number: this.requests.size + 1,
      turn: this.turn,
      model,
      status: "Running",
      contextId,
      startedAt: this.clock.wall(),
      completedAt: null,
      durationMs: null,
      firstTokenMs: null,
      generationMs: null,
      usage: null,
    };
    this.requests.set(id, { request, blocks: [] });
    this.currentRequest = id;
    this.requestClock.set(id, { start: this.clock.mono(), first: null });
    this.dirtyRequests.add(id);
    this.create(
      "assistant",
      `${id}-block-0`,
      "等待模型响应…",
      request.startedAt,
      id,
    );
    return id;
  }
  private finishRequest(
    id: string,
    status: TraceStatus,
    message?: AssistantMessage,
  ) {
    const r = this.requests.get(id);
    if (!r) return;
    const t = this.requestClock.get(id);
    const now = this.clock.mono();
    r.request.status = status;
    r.request.completedAt = this.clock.wall();
    if (t) {
      r.request.durationMs = Math.max(0, now - t.start);
      r.request.firstTokenMs =
        t.first === null ? null : Math.max(0, t.first - t.start);
      r.request.generationMs =
        t.first === null ? null : Math.max(0, now - t.first);
    }
    if (message) {
      r.blocks = clone(message.content);
      r.request.usage = usageOf(message);
    }
    for (const s of this.nodes.values()) {
      if (s.node.requestId !== id) continue;
      if (s.node.kind !== "tool-call" || status !== "Completed") {
        if (s.node.status === "Running") s.node.status = status;
        if (s.node.completedAt === null)
          s.node.completedAt = r.request.completedAt;
        if (s.node.id.endsWith("-block-0"))
          s.node.durationMs = r.request.durationMs;
        else if (s.node.startedAt !== null && s.node.completedAt !== null)
          s.node.durationMs = Math.max(
            0,
            s.node.completedAt - s.node.startedAt,
          );
      }
      this.touch(s);
    }
    this.dirtyRequests.add(id);
    this.requestClock.delete(id);
    this.flush();
  }
  handle(event: AgentSessionEvent): void {
    if (event.type === "turn_start") this.requestPending = true;
    if (
      event.type === "compaction_start" ||
      event.type === "auto_retry_start"
    ) {
      const text =
        event.type === "compaction_start"
          ? `上下文压缩 · ${event.reason}`
          : `模型请求重试 ${event.attempt}/${event.maxAttempts} · 等待 ${event.delayMs} ms · ${event.errorMessage}`;
      const node = this.create(
        "state",
        `state-${this.sequence + 1}`,
        text,
        this.clock.wall(),
        this.currentRequest,
      );
      node.raw = clone(event);
      this.operation = { id: node.node.id, start: this.clock.mono() };
      this.flush();
    }
    if (
      (event.type === "compaction_end" || event.type === "auto_retry_end") &&
      this.operation
    ) {
      const node = this.nodes.get(this.operation.id)!;
      node.node.status =
        event.type === "compaction_end"
          ? event.aborted
            ? "Interrupted"
            : event.errorMessage
              ? "Failed"
              : "Completed"
          : event.success
            ? "Completed"
            : "Failed";
      node.node.durationMs = Math.max(
        0,
        this.clock.mono() - this.operation.start,
      );
      node.node.completedAt = this.clock.wall();
      node.raw = clone(event);
      this.touch(node);
      this.operation = null;
      this.flush();
    }
    if (event.type === "message_start" && event.message.role === "user") {
      const text = outputText(event.message);
      const synthetic =
        isPlanExecutionPrompt(text) || text === goalContinuePrompt;
      if (!synthetic) this.turn++;
      const s = this.create(
        synthetic ? "state" : "user",
        `user-${this.sequence + 1}`,
        outputText(event.message),
        this.clock.wall(),
        null,
      );
      s.raw = clone(event.message);
      s.source = {
        kind: synthetic ? "system" : "user",
        timestamp: event.message.timestamp,
      };
      s.node.status = "Completed";
      s.node.completedAt = s.node.startedAt;
      s.node.durationMs = 0;
      this.touch(s);
      this.flush();
    }
    if (event.type === "message_update" && this.currentRequest) {
      const u = event.assistantMessageEvent;
      if (!("contentIndex" in u)) return;
      const r = this.requests.get(this.currentRequest)!;
      if ("delta" in u && typeof u.delta === "string" && u.delta.length) {
        const t = this.requestClock.get(this.currentRequest);
        if (t && t.first === null) {
          t.first = this.clock.mono();
          r.request.firstTokenMs = Math.max(0, t.first - t.start);
        }
      }
      const part = u.partial.content[u.contentIndex];
      if (!part) return;
      const id = `${this.currentRequest}-block-${u.contentIndex}`;
      const kind: TraceKind =
        part.type === "thinking"
          ? "thinking"
          : part.type === "toolCall"
            ? "tool-call"
            : "assistant";
      const s =
        this.nodes.get(id) ?? this.create(kind, id, "", this.clock.wall());
      const wasPlaceholder = s.content === "等待模型响应…";
      s.node.kind = kind;
      if (wasPlaceholder) s.node.startedAt = this.clock.wall();
      if (part.type === "toolCall") {
        s.node.toolCallId = part.id || null;
        s.node.toolName = part.name || null;
        if (part.id) this.calls.set(part.id, s.node.id);
        if (u.type === "toolcall_start") s.content = "";
        if (u.type === "toolcall_delta")
          s.content = (wasPlaceholder ? "" : s.content) + u.delta;
        if (u.type === "toolcall_end") {
          s.arguments = clone(u.toolCall.arguments);
          s.content = printable(s.arguments);
        }
      } else s.content = part.type === "thinking" ? part.thinking : part.text;
      s.raw = clone(part);
      r.blocks[u.contentIndex] = clone(part);
      this.dirtyRequests.add(r.request.id);
      if (u.type === "text_end" || u.type === "thinking_end") {
        s.node.status = "Completed";
        s.node.completedAt = this.clock.wall();
      }
      this.touch(s);
    }
    if (
      event.type === "message_end" &&
      event.message.role === "assistant" &&
      this.currentRequest
    ) {
      const message = event.message;
      // Non-streaming providers and redacted blocks may produce only a final message.
      message.content.forEach((part, index) => {
        const id = `${this.currentRequest}-block-${index}`;
        const s =
          this.nodes.get(id) ??
          this.create(
            part.type === "toolCall"
              ? "tool-call"
              : part.type === "thinking"
                ? "thinking"
                : "assistant",
            id,
            "",
            this.clock.wall(),
          );
        s.node.kind =
          part.type === "toolCall"
            ? "tool-call"
            : part.type === "thinking"
              ? "thinking"
              : "assistant";
        s.content =
          part.type === "toolCall"
            ? printable(part.arguments)
            : part.type === "thinking"
              ? part.thinking
              : part.text;
        s.raw = clone(part);
        if (part.type === "toolCall") {
          s.node.toolCallId = part.id;
          s.node.toolName = part.name;
          s.arguments = clone(part.arguments);
          this.calls.set(part.id, s.node.id);
        }
        this.touch(s);
      });
      const status =
        message.stopReason === "aborted"
          ? "Interrupted"
          : message.stopReason === "error"
            ? "Failed"
            : "Completed";
      this.finishRequest(this.currentRequest, status, message);
      if (message.errorMessage) this.fail(message.errorMessage);
    }
    if (event.type === "tool_execution_start") {
      const s =
        this.findCall(event.toolCallId) ??
        this.create(
          "tool-call",
          `call-${event.toolCallId}`,
          printable(event.args),
          this.clock.wall(),
        );
      s.node.toolCallId = event.toolCallId;
      s.node.toolName = event.toolName;
      s.arguments = clone(event.args);
      this.calls.set(event.toolCallId, s.node.id);
      s.node.executionStartedAt = this.clock.wall();
      s.node.status = "Running";
      this.toolClock.set(event.toolCallId, this.clock.mono());
      this.touch(s);
      this.flush();
    }
    if (event.type === "tool_execution_update") {
      const s = this.findCall(event.toolCallId);
      if (s) {
        s.result = clone(event.partialResult);
        this.touch(s);
      }
    }
    if (event.type === "tool_execution_end") {
      const call = this.findCall(event.toolCallId);
      const start = this.toolClock.get(event.toolCallId);
      if (call) {
        call.node.status = event.isError ? "Failed" : "Completed";
        call.node.completedAt = this.clock.wall();
        call.node.durationMs =
          start === undefined ? null : Math.max(0, this.clock.mono() - start);
        call.result = clone(event.result);
        this.touch(call);
      }
      const s = this.create(
        "tool-result",
        `result-${event.toolCallId}`,
        outputText(event.result),
        this.clock.wall(),
        call?.node.requestId ?? null,
      );
      s.node.toolCallId = event.toolCallId;
      s.node.toolName = event.toolName;
      s.node.status = event.isError ? "Failed" : "Completed";
      s.node.completedAt = s.node.startedAt;
      s.node.durationMs = 0;
      s.raw = clone(event.result);
      s.result = clone(event.result);
      this.touch(s);
      this.toolClock.delete(event.toolCallId);
      this.flush();
    }
  }
  fail(message: string) {
    if ([...this.nodes.values()].at(-1)?.content === message) return;
    const s = this.create(
      "error",
      `error-${this.sequence + 1}`,
      message,
      this.clock.wall(),
    );
    s.node.status = "Failed";
    this.touch(s);
    this.flush();
  }
  settle(status: TraceStatus) {
    for (const r of this.requests.values())
      if (r.request.status === "Running")
        this.finishRequest(r.request.id, status);
    for (const s of this.nodes.values())
      if (s.node.status === "Running") {
        s.node.status = status === "Completed" ? "Interrupted" : status;
        s.node.completedAt = this.clock.wall();
        this.touch(s);
      }
    this.flush();
  }
  /** Raw branch entries preserve pre-compaction history and historical content order. */
  restoreHistory(entries: SessionEntry[]) {
    if (this.nodes.size) return;
    const messages: AgentMessage[] = [];
    let requestId: string | null = null;
    for (const entry of entries) {
      if (entry.type !== "message") continue;
      const message = entry.message;
      messages.push(message as AgentMessage);
      const time = Date.parse(entry.timestamp);
      const at = Number.isFinite(time) ? time : null;
      if (message.role === "system") {
        this.context(messages, false);
        continue;
      }
      if (message.role === "user") {
        const text = outputText(message);
        const synthetic =
          isPlanExecutionPrompt(text) || text === goalContinuePrompt;
        if (!synthetic) this.turn++;
        const s = this.create(
          synthetic ? "state" : "user",
          `history-${entry.id}`,
          outputText(message),
          at,
          null,
        );
        s.raw = clone(message);
        s.source = {
          kind: "user",
          entryId: entry.id,
          timestamp: entry.timestamp,
        };
        s.node.status = "Completed";
        s.node.historical = true;
        this.touch(s);
      } else if (message.role === "assistant") {
        const contextId = this.lastContext ?? this.context(messages, false);
        requestId = `request-${this.requests.size + 1}`;
        const status: TraceStatus =
          message.stopReason === "error"
            ? "Failed"
            : message.stopReason === "aborted"
              ? "Interrupted"
              : "Completed";
        this.requests.set(requestId, {
          request: {
            id: requestId,
            number: this.requests.size + 1,
            turn: this.turn,
            model: `${message.provider}/${message.model}`,
            status,
            contextId,
            startedAt: null,
            completedAt: at,
            durationMs: null,
            firstTokenMs: null,
            generationMs: null,
            usage: usageOf(message),
          },
          blocks: clone(message.content),
        });
        this.dirtyRequests.add(requestId);
        message.content.forEach((part, index) => {
          const s = this.create(
            part.type === "toolCall"
              ? "tool-call"
              : part.type === "thinking"
                ? "thinking"
                : "assistant",
            `history-${entry.id}-${index}`,
            part.type === "toolCall"
              ? printable(part.arguments)
              : part.type === "thinking"
                ? part.thinking
                : part.text,
            at,
            requestId,
          );
          s.raw = clone(part);
          s.source = { entryId: entry.id, timestamp: entry.timestamp };
          s.node.status = status;
          s.node.historical = true;
          if (part.type === "toolCall") {
            s.node.toolCallId = part.id;
            s.node.toolName = part.name;
            s.arguments = clone(part.arguments);
            this.calls.set(part.id, s.node.id);
          }
          this.touch(s);
        });
      } else if (message.role === "toolResult") {
        const call = this.findCall(message.toolCallId);
        if (call) {
          call.result = clone(message);
          call.node.status = message.isError ? "Failed" : "Completed";
          this.touch(call);
        }
        const s = this.create(
          "tool-result",
          `history-${entry.id}`,
          outputText(message),
          at,
          call?.node.requestId ?? requestId,
        );
        s.node.toolCallId = message.toolCallId;
        s.node.toolName = message.toolName;
        s.node.status = message.isError ? "Failed" : "Completed";
        s.node.historical = true;
        s.raw = clone(message);
        s.result = clone(message);
        s.source = { entryId: entry.id, timestamp: entry.timestamp };
        this.touch(s);
      }
    }
    this.flush();
  }
  forkTo(target: TraceRecorder, turnIndex: number) {
    for (const [id, s] of this.nodes)
      if (s.node.turn <= turnIndex + 1) {
        target.nodes.set(id, clone(s));
        target.dirtyNodes.add(id);
        target.sequence = Math.max(target.sequence, s.node.sequence);
        target.turn = Math.max(target.turn, s.node.turn);
        target.version = Math.max(target.version, s.node.version);
      }
    for (const [id, r] of this.requests)
      if (r.request.turn <= turnIndex + 1) {
        target.requests.set(id, clone(r));
        target.dirtyRequests.add(id);
      }
    const needed = new Set(
      [...target.requests.values()].map((r) => r.request.contextId),
    );
    for (const s of target.nodes.values())
      if (s.contextId) needed.add(s.contextId);
    for (const [id, c] of this.contexts)
      if (needed.has(id)) {
        target.contexts.set(id, clone(c));
        target.dirtyContexts.add(id);
        target.lastContext = id;
      }
    for (const s of target.nodes.values())
      if (s.node.kind === "tool-call" && s.node.toolCallId)
        target.calls.set(s.node.toolCallId, s.node.id);
    target.flush();
  }
  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (
      !this.dirtyNodes.size &&
      !this.dirtyRequests.size &&
      !this.dirtyContexts.size
    )
      return;
    const changed = [...this.dirtyNodes].map((id) => this.nodes.get(id)!);
    const requests = [...this.dirtyRequests].map(
      (id) => this.requests.get(id)!,
    );
    const records: RecordEntry[] = [
      ...[...this.dirtyContexts].map((id) => ({
        type: "context" as const,
        value: this.contexts.get(id)!,
      })),
      ...changed.map((value) => ({ type: "node" as const, value })),
      ...requests.map((value) => ({ type: "request" as const, value })),
    ];
    this.dirtyNodes.clear();
    this.dirtyRequests.clear();
    this.dirtyContexts.clear();
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      appendFileSync(
        this.file,
        (this.needsSeparator ? "\n" : "") +
          records.map((r) => JSON.stringify(r)).join("\n") +
          "\n",
      );
      this.needsSeparator = false;
      if (this.warning?.startsWith("轨迹保存失败：")) this.warning = null;
    } catch (error) {
      this.warning = `轨迹保存失败：${error instanceof Error ? error.message : String(error)}`;
      changed.forEach((s) => this.dirtyNodes.add(s.node.id));
      requests.forEach((r) => this.dirtyRequests.add(r.request.id));
      records.forEach((r) => {
        if (r.type === "context") this.dirtyContexts.add(r.value.id);
      });
    }
    this.emit({
      type: "trace",
      conversationId: this.conversationId,
      version: this.version,
      nodes: changed.map((s) => ({ ...s.node })),
      requests: requests.map((r) => clone(r.request)),
      warning: this.warning,
    });
  }
  dispose() {
    this.flush();
  }
}
