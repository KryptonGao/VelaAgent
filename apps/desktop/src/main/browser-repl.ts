import { serializeBrowserError, type BrowserReplError } from './browser-client';
import { MessageChannelMain, utilityProcess, type UtilityProcess, type MessagePortMain } from 'electron';
export interface BrowserInvocationContext {
  windowId: number; conversationId: string; agentId: string; turnId: string; invocationId: string; signal?: AbortSignal;
}
export interface BrowserReplHost {
  invoke(context: BrowserInvocationContext, method: string, tabId?: string, args?: unknown[], frameId?: string): Promise<unknown>;
  beginInvocation(context: BrowserInvocationContext): (reason?: 'complete' | 'cancel') => void;
  resolveWindow(conversationId: string): number;
}
export interface BrowserReplResult { content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]; isError?: boolean; details?: { isError: boolean; error?: BrowserReplError } }
export interface BrowserReplRequest {
  conversationId: string; agentId: string; turnId: string; invocationId: string;
  code: string; timeoutMs?: number; cwd?: string; signal?: AbortSignal;
}
type Session = { windowId: number; worker: UtilityProcess; port: MessagePortMain; first: boolean; rebuilt: boolean; fail?: (error: Error) => void };
export class BrowserReplManager {
  private sessions = new Map<string, Session>();
  private queues = new Map<string, Promise<unknown>>();
  private seen = new Set<string>();
  private conversationWindows = new Map<string, number>();
  private disposed = false;
  constructor(private host: BrowserReplHost, private workerPath: string) {}
  private key(conversationId: string, agentId: string) { return JSON.stringify([conversationId, agentId]); }
  private kill(key: string) {
    const session = this.sessions.get(key);
    if (!session) return;
    this.sessions.delete(key); session.port.close(); session.worker.kill();
  }
  private enqueue<T>(conversationId: string, signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('Browser REPL disposed'));
    const previous = this.queues.get(conversationId) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(() => {
      if (this.disposed) throw new Error('Browser REPL disposed');
      signal?.throwIfAborted(); return run();
    });
    this.queues.set(conversationId, task);
    void task.finally(() => { if (this.queues.get(conversationId) === task) this.queues.delete(conversationId); }).catch(() => {});
    if (!signal) return task;
    // Abort queued callers promptly, while retaining the queue barrier.
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(signal.reason ?? new Error('Browser REPL aborted'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      task.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }
  execute(request: BrowserReplRequest): Promise<BrowserReplResult> {
    return this.enqueue(request.conversationId, request.signal, () => this.executeNow(request));
  }
  private executeNow(request: BrowserReplRequest): Promise<BrowserReplResult> {
    const key = this.key(request.conversationId, request.agentId);
    let session = this.sessions.get(key);
    const windowId = this.conversationWindows.get(request.conversationId)
      ?? this.host.resolveWindow(request.conversationId);
    const context: BrowserInvocationContext = {
      windowId,
      conversationId: request.conversationId, agentId: request.agentId,
      turnId: request.turnId, invocationId: request.invocationId,
    };
    const controller = new AbortController(); context.signal = controller.signal;
    const revoke = this.host.beginInvocation(context);
    // All agents in a conversation share the same Host window and tabs.
    // Retain ownership through reset/worker faults while Host pages still live.
    this.conversationWindows.set(request.conversationId, windowId);
    try {
      if (!session) {
        const worker = utilityProcess.fork(this.workerPath, [], { serviceName: 'Vela Browser REPL', stdio: 'ignore' });
        const { port1, port2 } = new MessageChannelMain();
        session = { windowId: context.windowId, worker, port: port1, first: !this.seen.has(key), rebuilt: this.seen.has(key) };
        this.sessions.set(key, session); this.seen.add(key);
        worker.on('exit', () => {
          if (this.sessions.get(key) === session) {
            session?.fail?.(new Error('Browser REPL worker exited'));
            this.kill(key);
          }
        });
        worker.postMessage({ type: 'connect' }, [port2]); port1.start();
      }
    } catch (error) { revoke('cancel'); controller.abort(); this.kill(key); throw error; }
    const current = session;
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (error?: Error, result?: BrowserReplResult) => {
        if (done) return; done = true;
        // Revoke before aborting RPC and terminating the worker.
        revoke(error ? 'cancel' : 'complete'); controller.abort(); clearTimeout(timer);
        request.signal?.removeEventListener('abort', abort);
        current.port.removeListener('message', receive); current.fail = undefined;
        if (error) { this.kill(key); reject(error); } else resolve(result!);
      };
      const abort = () => finish(new Error('Browser REPL aborted'));
      const timeout = Math.min(120000, Math.max(1, Number.isFinite(request.timeoutMs) ? request.timeoutMs! : 30000));
      const timer = setTimeout(() => finish(new Error(`Browser REPL timed out after ${timeout}ms`)), timeout);
      const receive = (event: { data: any }) => {
        const message = event.data;
        if (done || message.invocationId !== request.invocationId) return;
        if (message.type === 'result') { finish(undefined, { content: message.content, isError: message.isError ?? false, details: message.details ?? { isError: false } }); return; }
        if (message.type !== 'rpc') return;
        void Promise.resolve().then(() => {
          if (done) throw new Error("Browser invocation ended");
          return this.host.invoke(context, message.method, message.tabId, message.args, message.frameId);
        }).then(
          value => { if (!done) current.port.postMessage({ type: 'rpc-result', id: message.id, value }); },
          error => { if (!done) current.port.postMessage({ type: 'rpc-result', id: message.id, error: serializeBrowserError(error) }); },
        );
      };
      current.fail = error => finish(error);
      current.port.on('message', receive);
      request.signal?.addEventListener('abort', abort, { once: true });
      if (request.signal?.aborted) { abort(); return; }
      try {
        current.port.postMessage({ type: 'execute', invocationId: request.invocationId, code: request.code, cwd: request.cwd, first: current.first, rebuilt: current.rebuilt });
        current.first = false; current.rebuilt = false;
      } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
  }
  reset(request: { conversationId: string; agentId: string; signal?: AbortSignal }): Promise<void> {
    return this.enqueue(request.conversationId, request.signal, async () => {
      const key = this.key(request.conversationId, request.agentId); this.kill(key); this.seen.delete(key);
    });
  }
  closeWindow(windowId: number) {
    for (const [conversationId, owner] of this.conversationWindows) {
      if (owner === windowId) this.conversationWindows.delete(conversationId);
    }
    for (const [key, session] of this.sessions) {
      if (session.windowId !== windowId) continue;
      session.fail?.(new Error("Browser window closed"));
      this.kill(key);
    }
  }
  dispose() {
    this.disposed = true;
    this.conversationWindows.clear();
    for (const [key, session] of this.sessions) { session.fail?.(new Error('Browser REPL disposed')); this.kill(key); }
  }
}
