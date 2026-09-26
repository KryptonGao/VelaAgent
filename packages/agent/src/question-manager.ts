import { randomUUID } from "node:crypto";
import type { AskUserQuestionEvent, AskUserQuestionRequest } from "@vela/shared";

type QuestionListener = (event: AskUserQuestionEvent) => void;

interface PendingQuestion {
  conversationId: string;
  resolve: (answer: string | null) => void;
}

/**
 * agent 向用户提问的等待门,镜像 SandboxPermissionManager 的 promise 挂起模式:
 * ask() 推送问题并返回未 resolve 的 Promise,reply() 用 id 兑现答案。
 * 问题不设超时——等待回答期间会话保持 streaming,由用户回答、跳过或中断收尾。
 * 同一对话一次只挂起一个问题,后续提问排队等前一个问题了结后再推送。
 */
export class QuestionManager {
  private readonly pending = new Map<string, PendingQuestion>();
  private readonly listeners = new Set<QuestionListener>();
  /** conversationId -> 前一个提问完全了结(含事件发出)后的 Promise,用来串行排队。 */
  private readonly queues = new Map<string, Promise<void>>();

  subscribe(listener: QuestionListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  ask(conversationId: string, input: Omit<AskUserQuestionRequest, "id" | "conversationId" | "createdAt">): Promise<string | null> {
    const previous = this.queues.get(conversationId) ?? Promise.resolve();
    const release = withResolvers<void>();
    this.queues.set(conversationId, release.promise);
    return previous.then(
      () => this.emitRequest(conversationId, input),
      () => this.emitRequest(conversationId, input),
    ).finally(() => {
      if (this.queues.get(conversationId) === release.promise) this.queues.delete(conversationId);
      release.resolve();
    });
  }

  reply(id: string, answer: string | null): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    this.emit({ type: "resolved", id, answer });
    pending.resolve(answer);
  }

  /** 中断某个对话的全部待答问题(用户点停止时)。 */
  cancelConversation(conversationId: string): void {
    for (const [id, pending] of [...this.pending]) {
      if (pending.conversationId !== conversationId) continue;
      this.pending.delete(id);
      this.emit({ type: "resolved", id, answer: null });
      pending.resolve(null);
    }
  }

  cancelAll(): void {
    for (const [id, pending] of [...this.pending]) {
      this.pending.delete(id);
      this.emit({ type: "resolved", id, answer: null });
      pending.resolve(null);
    }
  }

  private emitRequest(
    conversationId: string,
    input: Omit<AskUserQuestionRequest, "id" | "conversationId" | "createdAt">,
  ): Promise<string | null> {
    const request: AskUserQuestionRequest = {
      ...input,
      id: randomUUID(),
      conversationId,
      createdAt: Date.now(),
    };
    return new Promise<string | null>((resolve) => {
      this.pending.set(request.id, { conversationId, resolve });
      this.emit({ type: "request", request });
    });
  }

  private emit(event: AskUserQuestionEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
