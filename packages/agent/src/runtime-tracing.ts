import type { AgentSession, AgentSessionEvent, SessionManager } from "@earendil-works/pi-coding-agent";
import type { TraceUpdate } from "@vela/shared";
import { join } from "node:path";
import { TraceRecorder } from "./trace";

export interface ConversationTracesOptions {
  agentDir: string;
  emit: (event: TraceUpdate) => void;
  /** 懒创建的记录器从这个会话历史恢复已有轨迹；没有历史时返回 null。 */
  history: (conversationId: string) => SessionManager | null;
}

/** 每个对话一个 TraceRecorder，首次访问时创建，落盘到 `<agentDir>/traces/<id>.jsonl`。 */
export class ConversationTraces {
  private readonly recorders = new Map<string, TraceRecorder>();

  constructor(private readonly options: ConversationTracesOptions) {}

  get(conversationId: string, restoreHistory = true): TraceRecorder {
    let recorder = this.recorders.get(conversationId);
    if (recorder) return recorder;
    const file = join(this.options.agentDir, "traces", `${conversationId}.jsonl`);
    recorder = new TraceRecorder(conversationId, file, this.options.emit);
    this.recorders.set(conversationId, recorder);
    const manager = restoreHistory ? this.options.history(conversationId) : null;
    if (manager) recorder.restoreHistory(manager.getBranch());
    return recorder;
  }

  dispose(): void {
    for (const recorder of this.recorders.values()) recorder.dispose();
  }
}

/**
 * 让主会话的模型请求经过 TraceRecorder，并把会话事件转给 onEvent；返回取消订阅函数。
 * Pi 用 stream function 的引用判断摘要请求的认证方式，所以 compaction 期间换回原函数，
 * compaction 结束后再恢复主代理追踪。
 */
export function subscribeTracedSession(
  session: AgentSession,
  recorder: TraceRecorder,
  onEvent: (event: AgentSessionEvent) => void,
): () => void {
  const originalStream = session.agent.streamFunction;
  const tracedStream = recorder.wrapStream(originalStream);
  session.agent.streamFunction = tracedStream;
  return session.subscribe((event) => {
    if (event.type === "compaction_start") session.agent.streamFunction = originalStream;
    if (event.type === "compaction_end") session.agent.streamFunction = tracedStream;
    onEvent(event);
  });
}
