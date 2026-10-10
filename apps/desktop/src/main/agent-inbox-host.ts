import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron";
import {
  AgentInboxIpc,
  agentInboxDecisions,
  agentInboxIdPattern,
  agentInboxLimits,
  createLogger,
  resolveUiContent,
  type AgentInboxContent,
  type AgentInboxDecideRequest,
  type AgentInboxListQuery,
  type AgentInboxNavigation,
  type AgentInboxSubmitResult,
  type TranscriptMessage,
} from "@vela/shared";
import type { AgentInboxService } from "./agent-inbox-service";

const log = createLogger("agent-inbox");

const channels = [
  AgentInboxIpc.list, AgentInboxIpc.get, AgentInboxIpc.decide, AgentInboxIpc.markRead, AgentInboxIpc.archive,
  AgentInboxIpc.content, AgentInboxIpc.submit, AgentInboxIpc.takeNavigation,
];

/** 读取与续写对话的入口。目标永远由已存储的事项决定，渲染层不能指定任意对话。 */
export interface AgentInboxHostRuntime {
  getMessages(conversationId: string): Pick<TranscriptMessage, "role" | "text">[];
  promptBackground(conversationId: string, text: string): Promise<void>;
}

/** 提交后等这么久还没有失败，就认为已被运行时接受；回合本身可能运行很久。 */
const acceptWindowMs = 150;

/**
 * Agent Inbox 的 IPC 入口。每个处理函数都先确认调用方是应用窗口的主框架（webview 等子框架不行），
 * 再把参数当作 unknown 逐项校验。`requestId` 永远取自已存储的事项，渲染层传来的值不被信任。
 */
export class AgentInboxHost {
  private unsubscribe: (() => void) | null = null;
  private pendingNavigation: AgentInboxNavigation | null = null;
  constructor(private readonly service: AgentInboxService, private readonly runtime?: AgentInboxHostRuntime) {}

  /** 通知点击、菜单栏入口：让渲染层切到收件箱的某个位置。窗口还没加载好时先暂存。 */
  navigate(target: AgentInboxNavigation): void {
    let delivered = false;
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed() || window.webContents.isDestroyed() || window.webContents.isLoading()) continue;
      window.webContents.send(AgentInboxIpc.navigate, target);
      delivered = true;
    }
    // 已经送到的请求不再暂存，否则之后刷新页面会重放一次过期的跳转。
    this.pendingNavigation = delivered ? null : target;
  }

  getContent(id: string): AgentInboxContent | null {
    const item = this.service.get(id);
    if (!item?.contentRef || !this.runtime) return null;
    try { return resolveUiContent(this.runtime.getMessages(item.contentRef.conversationId), item.contentRef); }
    catch (error) { log.error("agent inbox content unavailable", error); return null; }
  }

  async submitToSource(id: string, text: string): Promise<AgentInboxSubmitResult> {
    const item = this.service.get(id);
    if (!item?.conversationId || !this.runtime) return { ok: false, message: "没有可以回复的对话" };
    const clean = text.trim();
    if (!clean || clean.length > agentInboxLimits.maxAnswer) return { ok: false, message: "内容无效" };
    const sending = this.runtime.promptBackground(item.conversationId, clean).then(
      () => ({ ok: true } as AgentInboxSubmitResult),
      (error: unknown) => ({ ok: false, message: error instanceof Error ? error.message : "发送失败" } as AgentInboxSubmitResult),
    );
    // 回合会一直运行到结束，这里只等「是否被接受」。
    return Promise.race([sending, new Promise<AgentInboxSubmitResult>(resolve => setTimeout(() => resolve({ ok: true }), acceptWindowMs))]);
  }

  register(): void {
    const service = this.service;
    ipcMain.handle(AgentInboxIpc.list, (event, raw: unknown) => { assertMainFrame(event); return service.list(parseQuery(raw)); });
    ipcMain.handle(AgentInboxIpc.get, (event, raw: unknown) => { assertMainFrame(event); return service.get(parseId(raw)); });
    ipcMain.handle(AgentInboxIpc.decide, (event, raw: unknown) => { assertMainFrame(event); return service.decide(parseDecision(raw)); });
    ipcMain.handle(AgentInboxIpc.markRead, (event, raw: unknown) => { assertMainFrame(event); return service.markRead(parseId(raw)); });
    ipcMain.handle(AgentInboxIpc.archive, (event, rawId: unknown, rawArchived: unknown) => {
      assertMainFrame(event);
      if (typeof rawArchived !== "boolean") throw new Error("参数不正确");
      return service.archive(parseId(rawId), rawArchived);
    });
    ipcMain.handle(AgentInboxIpc.content, (event, raw: unknown) => { assertMainFrame(event); return this.getContent(parseId(raw)); });
    ipcMain.handle(AgentInboxIpc.submit, (event, rawId: unknown, rawText: unknown) => {
      assertMainFrame(event);
      if (typeof rawText !== "string") throw new Error("参数不正确");
      return this.submitToSource(parseId(rawId), rawText);
    });
    ipcMain.handle(AgentInboxIpc.takeNavigation, event => {
      assertMainFrame(event);
      const target = this.pendingNavigation;
      this.pendingNavigation = null;
      return target;
    });
    this.unsubscribe = service.subscribe(change => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
        window.webContents.send(AgentInboxIpc.change, change);
      }
    });
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const channel of channels) ipcMain.removeHandler(channel);
  }
}

export function assertMainFrame(event: IpcMainInvokeEvent): void {
  if (!BrowserWindow.fromWebContents(event.sender) || event.senderFrame !== event.sender.mainFrame) throw new Error("Agent Inbox 只接受应用窗口的请求");
}

function parseId(raw: unknown): string {
  if (typeof raw !== "string" || !agentInboxIdPattern.test(raw)) throw new Error("事项 ID 不正确");
  return raw;
}

function parseQuery(raw: unknown): AgentInboxListQuery {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("参数不正确");
  const input = raw as Record<string, unknown>;
  const query: AgentInboxListQuery = {};
  if (input.archived !== undefined) {
    if (typeof input.archived !== "boolean") throw new Error("参数不正确");
    query.archived = input.archived;
  }
  if (input.limit !== undefined) {
    if (!Number.isInteger(input.limit) || (input.limit as number) < 1 || (input.limit as number) > agentInboxLimits.pageSize) throw new Error("参数不正确");
    query.limit = input.limit as number;
  }
  if (input.before !== undefined) {
    if (typeof input.before !== "number" || !Number.isFinite(input.before)) throw new Error("参数不正确");
    query.before = input.before;
  }
  return query;
}

function parseDecision(raw: unknown): AgentInboxDecideRequest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("参数不正确");
  const input = raw as Record<string, unknown>;
  const itemId = parseId(input.itemId);
  const clientActionId = parseId(input.clientActionId);
  if (!Number.isInteger(input.expectedRevision) || (input.expectedRevision as number) < 0) throw new Error("版本号不正确");
  if (typeof input.decision !== "string" || !(agentInboxDecisions as readonly string[]).includes(input.decision)) throw new Error("决策类型不正确");
  const request: AgentInboxDecideRequest = {
    itemId,
    clientActionId,
    expectedRevision: input.expectedRevision as number,
    decision: input.decision as AgentInboxDecideRequest["decision"],
  };
  if (input.answer !== undefined) {
    if (typeof input.answer !== "string" || input.answer.length > agentInboxLimits.maxAnswer) throw new Error("回答不正确");
    request.answer = input.answer;
  }
  return request;
}
