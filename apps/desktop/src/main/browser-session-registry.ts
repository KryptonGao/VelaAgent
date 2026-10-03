import { randomUUID } from 'node:crypto';
import type { BrowserTabState } from '../../../../packages/shared/src/browser';

export class BrowserHostError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'BrowserHostError'; }
}
export interface BrowserRecord extends BrowserTabState { windowId: number; generation: number; guestId: number | null }
/** Ownership is main-process authority; callers never supply a WebContents ID for automation. */
export class BrowserSessionRegistry {
  private readonly records = new Map<string, BrowserRecord>();
  create(windowId: number, conversationId: string | null, id = `browser:${randomUUID()}`, url = 'about:blank', viewport = { width: 1024, height: 768 }): BrowserRecord {
    if (this.records.has(id)) throw new BrowserHostError('duplicate-tab', 'Tab ID already exists');
    const record: BrowserRecord = { id, windowId, conversationId, url, title: '', loading: false, ready: false,
      canGoBack: false, canGoForward: false, error: null, ...viewport, generation: 0, guestId: null };
    this.records.set(id, record); return record;
  }
  get(id: string, windowId: number, conversationId: string | null, bindUnowned = false): BrowserRecord {
    const record = this.records.get(id);
    if (!record) throw new BrowserHostError('tab-closed', 'The browser tab has been closed');
    if (record.windowId !== windowId) throw new BrowserHostError('wrong-window', 'Tab belongs to another window');
    if (record.conversationId === null && bindUnowned && conversationId) record.conversationId = conversationId;
    if (record.conversationId !== conversationId) throw new BrowserHostError('wrong-conversation', 'Tab belongs to another conversation');
    return record;
  }
  list(windowId: number, conversationId?: string | null): BrowserRecord[] {
    return [...this.records.values()].filter(tab => tab.windowId === windowId && (conversationId === undefined || tab.conversationId === conversationId));
  }
  remove(id: string): void { this.records.delete(id); }
  removeWindow(windowId: number): void { for (const tab of this.list(windowId)) this.remove(tab.id); }
}
