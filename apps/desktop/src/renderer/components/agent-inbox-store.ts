import type {
  AgentInboxApi,
  AgentInboxChange,
  AgentInboxDecideResult,
  AgentInboxDecision,
  AgentInboxItem,
  AgentInboxListResult,
} from "@vela/shared";

export interface AgentInboxSnapshot {
  /** 已加载的事项，按最近更新倒序。 */
  items: AgentInboxItem[];
  /** 主进程给出的待处理数量，是徽标的唯一来源。 */
  badge: number;
  error: string | null;
  loaded: boolean;
  /** 最近一次读取失败（主进程不可用等）。 */
  loadError: string | null;
}

const emptySnapshot: AgentInboxSnapshot = { items: [], badge: 0, error: null, loaded: false, loadError: null };

/**
 * Agent Inbox 的渲染层缓存。事项的唯一权威是主进程：这里只缓存读取结果，
 * 并按推送的变更增量更新；推送序号出现缺口时整体重新读取。
 */
export class AgentInboxStore {
  private items = new Map<string, AgentInboxItem>();
  private snapshot: AgentInboxSnapshot = emptySnapshot;
  private listeners = new Set<() => void>();
  private revision = -1;
  private badge = 0;
  private error: string | null = null;
  private loadError: string | null = null;
  private loaded = false;
  private archivedLoaded = false;
  private attachCount = 0;
  private detach: (() => void) | null = null;
  private generation = 0;
  private buffered: AgentInboxChange[] | null = null;

  constructor(private readonly api: AgentInboxApi) {}

  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  readonly getSnapshot = () => this.snapshot;

  /** 引用计数：应用级徽标和页面各自 attach，最后一个离开时才取消订阅。 */
  attach(): () => void {
    this.attachCount += 1;
    if (this.attachCount === 1) {
      this.buffered = [];
      this.detach = this.api.subscribe(change => this.receive(change));
      void this.reload();
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.attachCount -= 1;
      if (this.attachCount === 0) {
        this.detach?.();
        this.detach = null;
        this.generation += 1;
      }
    };
  }

  async reload(): Promise<void> {
    const generation = ++this.generation;
    this.buffered = [];
    let result: AgentInboxListResult;
    try { result = await this.api.list({}); }
    catch (error) {
      if (generation !== this.generation) return;
      this.loadError = error instanceof Error ? error.message : String(error);
      this.buffered = null;
      this.publish();
      return;
    }
    if (generation !== this.generation) return;
    const next = new Map<string, AgentInboxItem>();
    for (const [id, item] of this.items) if (item.readState === "archived") next.set(id, item);
    for (const item of result.items) next.set(item.id, item);
    this.items = next;
    this.revision = result.revision;
    this.badge = result.badge;
    this.error = result.error;
    this.loadError = null;
    this.loaded = true;
    const queued = this.buffered ?? [];
    this.buffered = null;
    for (const change of queued) this.apply(change);
    this.publish();
  }

  /** 进入归档视图时按需读取。 */
  async loadArchived(): Promise<void> {
    if (this.archivedLoaded) return;
    try {
      const result = await this.api.list({ archived: true });
      this.archivedLoaded = true;
      for (const item of result.items) this.put(item);
      this.publish();
    } catch (error) {
      this.loadError = error instanceof Error ? error.message : String(error);
      this.publish();
    }
  }

  async decide(item: AgentInboxItem, decision: AgentInboxDecision, answer?: string): Promise<AgentInboxDecideResult> {
    const result = await this.api.decide({
      itemId: item.id,
      expectedRevision: item.revision,
      decision,
      clientActionId: crypto.randomUUID(),
      ...(answer === undefined ? {} : { answer }),
    });
    if (result.item) { this.put(result.item); this.publish(); }
    return result;
  }

  async markRead(item: AgentInboxItem): Promise<void> {
    if (item.readState !== "unread") return;
    const updated = await this.api.markRead(item.id);
    if (updated) { this.put(updated); this.publish(); }
  }

  async archive(item: AgentInboxItem, archived: boolean): Promise<void> {
    const updated = await this.api.archive(item.id, archived);
    if (updated) { this.put(updated); this.publish(); }
  }

  private receive(change: AgentInboxChange): void {
    if (this.buffered) { this.buffered.push(change); return; }
    if (change.revision <= this.revision) return;
    if (change.revision > this.revision + 1) { void this.reload(); return; }
    this.apply(change);
    this.publish();
  }

  private apply(change: AgentInboxChange): void {
    if (change.revision <= this.revision) return;
    this.revision = change.revision;
    this.badge = change.badge;
    this.error = change.error;
    for (const item of change.upserts) this.put(item);
  }

  /** 业务版本较旧的副本不能覆盖较新的；阅读状态变更不改变业务版本，所以相等时允许替换。 */
  private put(item: AgentInboxItem): void {
    const existing = this.items.get(item.id);
    if (!existing || item.revision >= existing.revision) this.items.set(item.id, item);
  }

  private publish(): void {
    const items = [...this.items.values()].sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1));
    this.snapshot = { items, badge: this.badge, error: this.error, loaded: this.loaded, loadError: this.loadError };
    for (const listener of this.listeners) listener();
  }
}

const stores = new WeakMap<AgentInboxApi, AgentInboxStore>();
export function getAgentInboxStore(api: AgentInboxApi): AgentInboxStore {
  let store = stores.get(api);
  if (!store) { store = new AgentInboxStore(api); stores.set(api, store); }
  return store;
}
