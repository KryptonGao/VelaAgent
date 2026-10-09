import type { PrActivityKind, PrActivityPage, PrInboxApi, PrInboxDetail, PrInboxFiles, PrInboxItem, PrInboxList, PrInboxQuery, PrTarget } from '@vela/shared';

const kinds = ['commits', 'comments', 'reviews', 'threads'] as const;
/** The inbox's initial query, warmed in the background so the first open renders from cache. */
export const defaultPrInboxQuery: PrInboxQuery = { state: 'openAndDraft', repository: null };
const targetKey = (target: PrTarget) => `${target.host}/${target.owner}/${target.repo}#${target.number}`.toLowerCase();
const queryKey = (query: PrInboxQuery) => `list:${JSON.stringify([query.state, query.repository?.toLowerCase() ?? null])}`;
const detailKey = (target: PrTarget, identity: string) => `${identity}:detail:${targetKey(target)}`;
const activityPrefix = (target: PrTarget, identity: string) => `${identity}:activity:${targetKey(target)}:`;
const activityKey = (target: PrTarget, identity: string, head: string, kind: PrActivityKind, cursor: string | null, thread: string | null) =>
  `${activityPrefix(target, identity)}${JSON.stringify([head, kind, cursor, thread])}`;
const filesKey = (target: PrTarget, identity: string, head: string, base: string, page: number) => `${identity}:files:${targetKey(target)}:${head}:${base}:${page}`;

interface Entry {
  value: unknown;
  at: number;
  retryAt: number;
  refresh: (() => Promise<unknown>) | null;
  /** How long before an idle refresh is due; preloaded PRs nobody opened yet refresh less often. */
  ttl: number;
}
const viewedTtl = 60_000;
const preloadTtl = 5 * 60_000;

/** Session cache shared by the mounted inbox and remounted detail panels. No credentials or PR data are written to disk. */
export class PrInboxCache {
  readonly api: PrInboxApi;
  private entries = new Map<string, Entry>();
  private listeners = new Set<() => void>();
  private requests = new Map<string, { key: string; valid: boolean }>();
  private versions = new Map<string, number>();
  private identity: string | null = null;
  private epoch = 0;
  private version = 0;
  private refreshing = false;
  private retryAt = 0;
  private warming = false;
  private preloading = false;
  private warmAt = 0;
  private idleRequests = new Set<string>();
  private preloadRequests = new Set<string>();
  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  readonly getVersion = () => this.version;
  silenceRequest(requestId: string) { this.idleRequests.add(requestId); }

  constructor(source: PrInboxApi, private readonly now = Date.now, private readonly uuid = () => crypto.randomUUID()) {
    this.api = {
      ...source,
      list: (query, options) => this.read(queryKey(query), null, options.requestId,
        () => source.list(query, options), () => this.api.list(query, { requestId: this.idleRequestId(), force: true })),
      enrich: (targets, options) => this.read(`${options.identityKey}:enrich:${targets.map(targetKey).sort().join(',')}`, options.identityKey, options.requestId,
        async () => (await source.enrich(targets, options)).map(row => row.enrichment === 'error' ? this.getEnriched(row, options.identityKey) : row),
        () => this.api.enrich(targets, { ...options, requestId: this.idleRequestId(), force: true })),
      detail: (target, options) => this.read(detailKey(target, options.identityKey), options.identityKey, options.requestId,
        () => source.detail(target, options), () => this.api.detail(target, { ...options, requestId: this.idleRequestId(), force: true })),
      activity: (target, kind, cursor, head, thread, options) => this.read(activityKey(target, options.identityKey, head, kind, cursor, thread), options.identityKey, options.requestId,
        () => source.activity(target, kind, cursor, head, thread, options), cursor === null && kind !== 'threadComments'
          ? () => this.api.activity(target, kind, cursor, head, thread, { ...options, requestId: this.idleRequestId(), force: true }) : null),
      // File patches are immutable for a head/base pair; revalidate when entering Changes, without idle polling large diffs.
      files: (target, page, head, base, options) => this.read(filesKey(target, options.identityKey, head, base, page), options.identityKey, options.requestId,
        () => source.files(target, page, head, base, options), null),
      cancel: requestId => {
        const request = this.requests.get(requestId); if (request) request.valid = false;
        return source.cancel(requestId);
      },
      comment: async (target, body, options) => {
        try { return await source.comment(target, body, options); }
        finally {
          const prefix = activityPrefix(target, options.identityKey);
          for (const [key, entry] of this.entries) if (key.startsWith(prefix)) { entry.at = 0; entry.retryAt = 0; }
          for (const request of this.requests.values()) if (request.key.startsWith(prefix)) request.valid = false;
        }
      },
    };
  }

  private changed() { this.version++; for (const listener of this.listeners) listener(); }
  private idleRequestId() { const id = this.uuid(); this.idleRequests.add(id); return id; }
  private preloadRequestId() { const id = this.idleRequestId(); this.preloadRequests.add(id); return id; }
  /** Reads refresh recency, so whatever is on screen survives eviction even when idle refreshes rewrite older entries. */
  private peek<T>(key: string): T | null {
    const entry = this.entries.get(key); if (!entry) return null;
    this.entries.delete(key); this.entries.set(key, entry);
    return entry.value as T;
  }
  getList(query: PrInboxQuery) { return this.peek<PrInboxList>(queryKey(query)); }
  getDetail(target: PrTarget, identity: string) { return this.peek<PrInboxDetail>(detailKey(target, identity)); }
  getEnriched(item: PrInboxItem, identity: string): PrInboxItem {
    let latest = item;
    for (const [key, entry] of this.entries) if (key.startsWith(`${identity}:enrich:`)) {
      const row = (entry.value as PrInboxItem[]).find(row => row.key === item.key);
      if (row && row.updatedAt >= item.updatedAt) latest = { ...row, title: item.title, url: item.url, relations: item.relations };
    }
    return latest;
  }
  getFiles(target: PrTarget, identity: string, head: string, base: string): PrInboxFiles | null {
    let result = this.peek<PrInboxFiles>(filesKey(target, identity, head, base, 1));
    const seen = new Set<number>();
    while (result?.nextPage && !seen.has(result.nextPage)) {
      const page = result.nextPage; seen.add(page);
      const next = this.peek<PrInboxFiles>(filesKey(target, identity, head, base, page)); if (!next) break;
      result = { ...next, files: [...new Map([...result.files, ...next.files].map(file => [file.path, file])).values()],
        diffTruncated: result.diffTruncated || next.diffTruncated, diffError: next.diffError || result.diffError };
    }
    return result;
  }
  getActivity(target: PrTarget, identity: string, head: string): Partial<Record<PrActivityKind, PrActivityPage>> {
    const pages: Partial<Record<PrActivityKind, PrActivityPage>> = {};
    for (const kind of kinds) {
      let page = this.peek<PrActivityPage>(activityKey(target, identity, head, kind, null, null));
      const seen = new Set<string>();
      while (page?.nextCursor && !seen.has(page.nextCursor)) {
        const cursor = page.nextCursor; seen.add(cursor);
        const next = this.peek<PrActivityPage>(activityKey(target, identity, head, kind, cursor, null)); if (!next) break;
        page = { ...next, comments: [...page.comments, ...next.comments], reviews: [...page.reviews, ...next.reviews],
          threads: [...page.threads, ...next.threads], commits: [...(page.commits ?? []), ...(next.commits ?? [])], threadCursors: { ...page.threadCursors, ...next.threadCursors } };
      }
      if (page) pages[kind] = page;
    }
    if (pages.threads) {
      const threadsPage = { ...pages.threads, threadCursors: { ...pages.threads.threadCursors } };
      threadsPage.threads = threadsPage.threads.map(thread => {
        const comments = new Map(thread.comments.map(comment => [comment.id, comment]));
        let cursor = threadsPage.threadCursors[thread.id]; const seen = new Set<string>();
        while (cursor && !seen.has(cursor)) {
          seen.add(cursor);
          const next = this.peek<PrActivityPage>(activityKey(target, identity, head, 'threadComments', cursor, thread.id)); if (!next) break;
          for (const comment of next.comments) comments.set(comment.id, comment);
          cursor = next.nextCursor;
        }
        threadsPage.threadCursors[thread.id] = cursor;
        return { ...thread, comments: [...comments.values()] };
      });
      pages.threads = threadsPage;
    }
    return pages;
  }

  private async read<T>(key: string, identity: string | null, requestId: string, work: () => Promise<T>, refresh: Entry['refresh']): Promise<T> {
    const epoch = this.epoch; const startedIdentity = this.identity;
    const version = (this.versions.get(key) ?? 0) + 1; this.versions.set(key, version);
    const request = { key, valid: true }; this.requests.set(requestId, request);
    try {
      const value = await work();
      if (!request.valid || this.versions.get(key) !== version || epoch !== this.epoch && (startedIdentity !== null || identity !== null)) throw new Error('读取请求已过期');
      if (identity === null) {
        const list = value as PrInboxList;
        const nextIdentity = list.identity?.key ?? null;
        if (epoch !== this.epoch && nextIdentity !== this.identity) throw new Error('GitHub 身份已变化，请刷新');
        if (nextIdentity !== this.identity) {
          this.identity = nextIdentity; this.epoch++; this.entries.clear();
          for (const other of this.requests.values()) if (other !== request) other.valid = false;
        }
        this.retryAt = list.error?.retryAt ?? 0;
        // Automatic failures preserve the current snapshot and never create a loading/error banner.
        if (list.error && this.idleRequests.has(requestId) && this.entries.has(key)) throw new Error(list.error.message);
      } else if (identity !== this.identity) throw new Error('GitHub 身份已变化，请刷新');
      if (identity && key.startsWith(`${identity}:detail:`)) {
        const next = value as PrInboxDetail;
        const previous = this.peek<PrInboxDetail>(key);
        if (previous && (previous.item.headSha !== next.item.headSha || previous.item.baseSha !== next.item.baseSha)) {
          const prefixes = [activityPrefix(next.target, identity), `${identity}:files:${targetKey(next.target)}:`];
          for (const id of this.entries.keys()) if (prefixes.some(prefix => id.startsWith(prefix))) this.entries.delete(id);
          for (const other of this.requests.values()) if (prefixes.some(prefix => other.key.startsWith(prefix))) other.valid = false;
        }
      }
      this.entries.delete(key);
      // Explicit reads mark an entry as viewed; idle refreshes keep whatever cadence it already had.
      const ttl = this.preloadRequests.has(requestId) ? preloadTtl : this.idleRequests.has(requestId) ? this.entries.get(key)?.ttl ?? viewedTtl : viewedTtl;
      this.entries.set(key, { value, at: this.now(), retryAt: 0, refresh, ttl });
      while (this.entries.size > 200) this.entries.delete(this.entries.keys().next().value!);
      this.changed();
      return value;
    } finally {
      this.requests.delete(requestId);
      this.idleRequests.delete(requestId);
      this.preloadRequests.delete(requestId);
      // Keep only active/cache keys, so cursor navigation cannot grow bookkeeping indefinitely.
      for (const id of this.versions.keys()) if (!this.entries.has(id) && ![...this.requests.values()].some(request => request.key === id)) this.versions.delete(id);
    }
  }

  /** Load a query that was never read and status for its newest rows, so opening the inbox never starts from a skeleton. */
  async warm(query: PrInboxQuery): Promise<void> {
    if (this.warming || this.now() < this.warmAt || this.now() < this.retryAt) return;
    this.warming = true;
    try {
      const list = this.getList(query) ?? await this.api.list(query, { requestId: this.idleRequestId() });
      const identity = list.identity?.key; if (!identity) return;
      const targets = [...list.items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 40)
        .filter(item => this.getEnriched(item, identity).enrichment === 'idle').map(item => item.target);
      if (targets.length) await this.api.enrich(targets, { requestId: this.idleRequestId(), identityKey: identity });
    } catch { this.warmAt = this.now() + 60_000; }
    finally { this.warming = false; }
  }

  /**
   * Preload detail and the first activity page of PRs that were never opened, attention first then newest,
   * a few per call so background work stays within GitHub's rate budget.
   */
  async preload(query: PrInboxQuery, isActive: () => boolean = () => true, perCall = 2, depth = 12): Promise<void> {
    const list = this.getList(query); const identity = list?.identity?.key;
    if (!list || !identity || this.preloading || this.requests.size || this.now() < this.retryAt) return;
    this.preloading = true;
    try {
      const pending = list.items.map(item => this.getEnriched(item, identity))
        .sort((a, b) => Number(b.attentionReasons.length > 0) - Number(a.attentionReasons.length > 0) || b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, depth).filter(item => !this.getDetail(item.target, identity)).slice(0, perCall);
      for (const item of pending) {
        if (!isActive() || this.identity !== identity || this.now() < this.retryAt) break;
        try {
          const detail = await this.api.detail(item.target, { requestId: this.preloadRequestId(), identityKey: identity });
          const head = detail.item.headSha; if (!head) continue;
          for (const kind of kinds) {
            if (!isActive()) break;
            await this.api.activity(item.target, kind, null, head, null, { requestId: this.preloadRequestId(), identityKey: identity });
          }
        } catch { /* Opening the PR later still revalidates and reports errors. */ }
      }
    } finally { this.preloading = false; }
  }

  /** Refresh a bounded set sequentially, honoring visibility and the service's offline/rate backoff. */
  async refreshIdle(isIdle: () => boolean = () => true): Promise<void> {
    if (this.refreshing || this.requests.size || this.now() < this.retryAt || !isIdle()) return;
    this.refreshing = true;
    try {
      const due = [...this.entries].filter(([, entry]) => entry.refresh && this.now() - entry.at >= entry.ttl && this.now() >= entry.retryAt).slice(0, 8);
      for (const [key, entry] of due) {
        if (!isIdle() || this.requests.size || this.now() < this.retryAt) break;
        if (this.entries.get(key) !== entry) continue;
        try { await entry.refresh!(); }
        catch { entry.retryAt = this.now() + 60_000; }
      }
    } finally { this.refreshing = false; }
  }
}

const caches = new WeakMap<PrInboxApi, PrInboxCache>();
export function getPrInboxCache(api: PrInboxApi): PrInboxCache {
  let cache = caches.get(api);
  if (!cache) { cache = new PrInboxCache(api); caches.set(api, cache); }
  return cache;
}
