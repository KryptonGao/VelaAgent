import { ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { homedir } from 'node:os';
import { PrInboxIpc, type PrReadOptions } from '@vela/shared';
import { PullRequestInboxService, validateTarget, safeGithubUrl } from '@vela/workspace';
import { listOpenTargets, openInTarget } from './open-targets';
import type { PrReviewResponseService } from './pr-review-response-service';

export class PrInboxHost {
  private requests = new Map<string, AbortController>();
  private responseService: PrReviewResponseService | null = null;
  constructor(readonly service = new PullRequestInboxService()) {}
  /** 回应审阅意见依赖会话运行时，运行时晚于本 host 创建，所以事后注入。 */
  setResponses(service: PrReviewResponseService): void { this.responseService = service; }
  private responses(): PrReviewResponseService {
    if (!this.responseService) throw new Error('审阅回应功能尚未就绪，请稍后重试');
    return this.responseService;
  }
  private sender(event: IpcMainInvokeEvent): number {
    if (event.senderFrame !== event.sender.mainFrame) throw new Error('只允许 Vela 主页面访问 Pull Request');
    return event.sender.id;
  }
  private options(raw: unknown, withIdentity = true): PrReadOptions {
    if (!raw || typeof raw !== 'object') throw new Error('无效读取参数');
    const o = raw as PrReadOptions;
    if (typeof o.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(o.requestId) ||
      withIdentity && (typeof o.identityKey !== 'string' || !/^github\.com\/[a-zA-Z0-9][a-zA-Z0-9-]{0,99}$/.test(o.identityKey)) ||
      o.force !== undefined && typeof o.force !== 'boolean') throw new Error('无效读取参数');
    return o;
  }
  private async read<T>(event: IpcMainInvokeEvent, raw: unknown, work: (options: PrReadOptions, signal: AbortSignal) => Promise<T>, withIdentity = true): Promise<T> {
    const sender = this.sender(event); const options = this.options(raw, withIdentity);
    const key = `${sender}:${options.requestId}`;
    if (this.requests.has(key)) throw new Error('读取请求编号重复');
    const controller = new AbortController(); this.requests.set(key, controller);
    const destroyed = () => controller.abort(); event.sender.once('destroyed', destroyed);
    try { return await work(options, controller.signal); }
    finally { event.sender.removeListener('destroyed', destroyed); this.requests.delete(key); }
  }
  register(): void {
    ipcMain.handle(PrInboxIpc.list, (event, query, raw) => this.read(event, raw, (options, signal) => {
      const o = raw as { more?: boolean; revision?: number };
      if (o.more !== undefined && typeof o.more !== 'boolean' || o.revision !== undefined && (!Number.isSafeInteger(o.revision) || o.revision < 0)) throw new Error('无效分页参数');
      return this.service.list(query, { force: options.force, more: o.more, revision: o.revision }, signal);
    }, false));
    ipcMain.handle(PrInboxIpc.enrich, (event, targets, raw) => this.read(event, raw, (o, signal) => this.service.enrich(targets, o.identityKey, o.force, signal)));
    ipcMain.handle(PrInboxIpc.detail, (event, target, raw) => this.read(event, raw, (o, signal) => this.service.detail(target, o.identityKey, o.force, signal)));
    ipcMain.handle(PrInboxIpc.activity, (event, target, kind, cursor, headSha, threadId, raw) => this.read(event, raw, (o, signal) => this.service.activity(target, kind, cursor, headSha, threadId, o.identityKey, signal, o.force)));
    ipcMain.handle(PrInboxIpc.files, (event, target, page, headSha, baseSha, raw) => this.read(event, raw, (o, signal) => this.service.files(target, page, headSha, baseSha, o.identityKey, o.force, signal)));
    // A dispatched write must finish even when its view/window goes away; it is never a cancellable read.
    ipcMain.handle(PrInboxIpc.comment, (event, target, body, raw) => {
      this.sender(event); const options = this.options(raw);
      return this.service.comment(target, body, options.identityKey, options.requestId);
    });
    ipcMain.handle(PrInboxIpc.responsePrepare, (event, target, raw) => this.read(event, raw, (o, signal) => this.responses().prepare(target, o.identityKey, signal)));
    ipcMain.handle(PrInboxIpc.responseReview, (event, runId, raw) => this.read(event, raw, (o, signal) => this.responses().review(runId, o.identityKey, signal)));
    ipcMain.handle(PrInboxIpc.responseRuns, (event, target) => { this.sender(event); return this.responses().runsFor(validateTarget(target)); });
    // Starting, publishing and discarding change files or GitHub; like comment they finish even if the view goes away.
    ipcMain.handle(PrInboxIpc.responseStart, (event, input, raw) => {
      this.sender(event); const options = this.options(raw);
      return this.responses().start(input, options.identityKey, options.requestId);
    });
    ipcMain.handle(PrInboxIpc.responsePublish, (event, input) => {
      this.sender(event);
      if (!input || typeof input !== 'object') throw new Error('无效发布请求');
      this.options({ requestId: input.requestId, identityKey: input.identityKey });
      return this.responses().publish(input);
    });
    ipcMain.handle(PrInboxIpc.responseDiscard, (event, runId, removeTree) => { this.sender(event); return this.responses().discard(runId, removeTree); });
    ipcMain.handle(PrInboxIpc.cancel, (event, requestId) => {
      const sender = this.sender(event);
      const options = this.options({ requestId }, false);
      this.requests.get(`${sender}:${options.requestId}`)?.abort();
    });
    ipcMain.handle(PrInboxIpc.open, async (event, raw, url) => {
      this.sender(event); const target = validateTarget(raw); const safe = safeGithubUrl(url, target);
      if (!safe) throw new Error('无效的 GitHub 链接');
      await shell.openExternal(safe);
    });
    ipcMain.handle(PrInboxIpc.terminal, async event => {
      this.sender(event);
      const terminal = (await listOpenTargets()).find(t => t.kind === 'terminal');
      if (!terminal) throw new Error('未找到可用终端，请手动打开终端运行 gh auth login');
      await openInTarget(terminal.id, homedir());
    });
  }
  dispose(): void {
    for (const c of this.requests.values()) c.abort(); this.requests.clear();
    for (const channel of Object.values(PrInboxIpc)) ipcMain.removeHandler(channel);
  }
}
