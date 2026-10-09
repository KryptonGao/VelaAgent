import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { PrActivityPage, PrInboxApi, PrInboxDetail, PrInboxFiles, PrInboxItem, PrInboxList, PrTarget } from '@vela/shared';
import { PrInboxCache } from '../src/renderer/components/pr-inbox-cache.ts';

const target: PrTarget = { host: 'github.com', owner: 'Owner', repo: 'Repo', number: 128 };
const head = 'a'.repeat(40), base = 'b'.repeat(40);
const query = { state: 'openAndDraft' as const, repository: null };
const identity = { host: 'github.com', login: 'alice', key: 'github.com/alice' };
const item: PrInboxItem = { key: 'github.com/owner/repo#128', target, url: 'https://github.com/Owner/Repo/pull/128', title: 'Cached PR', author: null,
  state: 'open', relations: ['authored'], updatedAt: '2026-10-06T00:00:00Z', headSha: head, baseSha: base, enrichment: 'ready', checks: 'passing',
  reviewDecision: null, mergeable: null, mergeStateStatus: null, attentionReasons: [] };
const list = (extra: Partial<PrInboxList> = {}): PrInboxList => ({ identity, items: [item], pages: [], complete: true, stale: false, syncedAt: 1_000_000, error: null, revision: 1, ...extra });
const detail = (t = target): PrInboxDetail => ({ target: t, identity, item: { ...item, target: t }, body: 'Cached description', createdAt: '', baseRefName: 'main', headRefName: 'feature', headRepository: null,
  additions: 1, deletions: 1, changedFiles: 2, checks: [], checksError: null, syncedAt: 1_000_000 });
const activity = (body: string, nextCursor: string | null = null): PrActivityPage => ({ headSha: head, comments: [{ id: body, body } as any], reviews: [], threads: [], commits: [], nextCursor, threadCursors: {} });
const files = (page: number, h = head, b = base): PrInboxFiles => ({ target, headSha: h, baseSha: b, files: [{ path: `page${page}.ts`, previousPath: null, status: 'modified', additions: 1, deletions: 1, patch: '+new', patchTruncated: false, url: null }], nextPage: page === 1 ? 2 : null, expectedCount: 2, limited: false, diffTruncated: false, diffError: null });

function fixture(overrides: Partial<PrInboxApi> = {}) {
  let clock = 1_000_000, id = 0;
  const calls: { name: string; args: any[] }[] = [];
  const defaults: PrInboxApi = {
    list: async () => list(), enrich: async () => [item], detail: async t => detail(t),
    activity: async (_t, _k, cursor) => activity(cursor ? 'earlier' : 'recent', cursor ? null : 'older'),
    files: async (_t, page, h, b) => files(page, h, b), comment: async () => ({ id: 'posted' } as any),
    cancel: async () => {}, open: async () => {}, openTerminal: async () => {}, ...overrides,
  };
  const api = Object.fromEntries(Object.entries(defaults).map(([name, fn]) => [name, (...args: any[]) => { calls.push({ name, args }); return (fn as any)(...args); }])) as unknown as PrInboxApi;
  const cache = new PrInboxCache(api, () => clock, () => `idle-${++id}`);
  const options = () => ({ requestId: `request-${++id}`, identityKey: identity.key });
  const seed = () => cache.api.list(query, { requestId: `seed-${++id}` });
  return { cache, calls, options, seed, advance: (ms = 60_001) => { clock += ms; } };
}

it('renders the previous snapshot synchronously while a forced revalidation is pending, then publishes the new value', async () => {
  let release!: (value: PrInboxDetail) => void;
  let delayed = false;
  const f = fixture({ detail: async t => delayed ? new Promise(resolve => { release = resolve; }) : detail(t) });
  await f.seed(); await f.cache.api.detail(target, f.options());
  const cached = f.cache.getDetail(target, identity.key);
  let notifications = 0; f.cache.subscribe(() => { notifications++; });
  delayed = true;
  const pending = f.cache.api.detail(target, { ...f.options(), force: true });
  assert.equal(f.cache.getDetail(target, identity.key), cached);
  assert.equal(notifications, 0);
  release({ ...detail(), body: 'Fresh description' }); await pending;
  assert.equal(f.cache.getDetail(target, identity.key)?.body, 'Fresh description'); assert.equal(notifications, 1);
});

it('keeps query, account, full repository target, head and base caches separate', async () => {
  const f = fixture(); await f.seed();
  await f.cache.api.detail(target, f.options());
  assert.equal(f.cache.getDetail({ ...target, repo: 'Other' }, identity.key), null);
  assert.equal(f.cache.getDetail(target, 'github.com/bob'), null);
  assert.equal(f.cache.getList({ ...query, state: 'merged' }), null);
  assert.equal(f.cache.getList({ ...query, repository: 'Owner/Repo' }), null);
  assert.equal(f.cache.getDetail({ ...target, owner: 'owner', repo: 'repo' }, identity.key)?.body, 'Cached description');
  await f.cache.api.files(target, 1, head, base, f.options());
  assert.equal(f.cache.getFiles(target, identity.key, head, 'c'.repeat(40)), null);
  assert.equal(f.cache.getFiles(target, identity.key, 'd'.repeat(40), base), null);
});

it('retains loaded file and activity pages across remounts, including thread replies', async () => {
  const thread = { id: 'thread', comments: [{ id: 'first', body: 'first' }] } as any;
  const f = fixture({ activity: async (_t, kind, cursor) => kind === 'threads' ? { ...activity(''), comments: [], threads: [thread], threadCursors: { thread: 'reply-cursor' }, nextCursor: null }
    : kind === 'threadComments' ? activity('reply') : activity(cursor ? 'earlier' : 'recent', cursor ? null : 'older') });
  await f.seed();
  for (const page of [1, 2]) await f.cache.api.files(target, page, head, base, f.options());
  assert.deepEqual(f.cache.getFiles(target, identity.key, head, base)?.files.map(file => file.path), ['page1.ts', 'page2.ts']);
  for (const cursor of [null, 'older']) await f.cache.api.activity(target, 'comments', cursor, head, null, f.options());
  await f.cache.api.activity(target, 'threads', null, head, null, f.options());
  await f.cache.api.activity(target, 'threadComments', 'reply-cursor', head, 'thread', f.options());
  const pages = f.cache.getActivity(target, identity.key, head);
  assert.deepEqual(pages.comments?.comments.map(comment => comment.body), ['recent', 'earlier']);
  assert.deepEqual(pages.threads?.threads[0].comments.map(comment => comment.body), ['first', 'reply']);
  assert.equal(pages.threads?.threadCursors.thread, null);
  assert.deepEqual(f.cache.getActivity(target, identity.key, 'c'.repeat(40)), {});
  // A refresh of page one must retain already loaded page two for this immutable version.
  await f.cache.api.files(target, 1, head, base, { ...f.options(), force: true });
  assert.equal(f.cache.getFiles(target, identity.key, head, base)?.files.length, 2);
});

it('refreshes only loaded, expired resources when idle, forces fresh data and avoids polling file patches or historical pages', async () => {
  const f = fixture(); await f.cache.refreshIdle(); assert.equal(f.calls.length, 0);
  await f.seed(); await f.cache.api.detail(target, f.options()); await f.cache.api.enrich([target], f.options());
  await f.cache.api.files(target, 1, head, base, f.options());
  await f.cache.api.activity(target, 'comments', null, head, null, f.options());
  await f.cache.api.activity(target, 'comments', 'older', head, null, f.options());
  const count = f.calls.length; await f.cache.refreshIdle(); assert.equal(f.calls.length, count);
  f.advance(); await f.cache.refreshIdle(() => false); assert.equal(f.calls.length, count);
  await f.cache.refreshIdle();
  const refreshed = f.calls.slice(count);
  assert.deepEqual(refreshed.map(call => call.name), ['list', 'detail', 'enrich', 'activity']);
  assert.ok(refreshed.every(call => call.args.at(-1).force === true));
  await f.cache.refreshIdle(); assert.equal(f.calls.length, count + 4);
});

it('keeps cached content and stays silent on automatic offline failures, honoring retryAt', async () => {
  let offline = false;
  const f = fixture({ list: async () => offline ? list({ stale: true, error: { kind: 'offline', message: 'offline', retryAt: 1_180_000 } }) : list() });
  await f.seed(); const cached = f.cache.getList(query); let notices = 0; f.cache.subscribe(() => { notices++; });
  offline = true; f.advance(); await f.cache.refreshIdle();
  assert.equal(f.cache.getList(query), cached); assert.equal(notices, 0);
  const count = f.calls.length; f.advance(); await f.cache.refreshIdle(); assert.equal(f.calls.length, count);
  offline = false; f.advance(); await f.cache.refreshIdle(); assert.equal(f.calls.length, count + 1);
});

it('clears all previous-account snapshots and rejects late responses after an identity switch or cancellation', async () => {
  let bob = false, delayed = false; let release!: (value: PrInboxDetail) => void;
  const f = fixture({ list: async () => list({ identity: bob ? { ...identity, login: 'bob', key: 'github.com/bob' } : identity }),
    detail: async t => delayed ? new Promise(resolve => { release = resolve; }) : detail(t) });
  await f.seed(); await f.cache.api.detail(target, f.options()); delayed = true;
  const pending = f.cache.api.detail(target, f.options());
  bob = true; await f.seed(); release(detail()); await assert.rejects(pending, /过期/);
  assert.equal(f.cache.getDetail(target, identity.key), null); assert.equal(f.cache.getList(query)?.identity?.login, 'bob');
  const options = { ...f.options(), identityKey: 'github.com/bob' };
  const cancelled = f.cache.api.detail(target, options); await f.cache.api.cancel(options.requestId);
  release({ ...detail(), identity: { ...identity, key: 'github.com/bob' } }); await assert.rejects(cancelled, /过期/);
  assert.equal(f.cache.getDetail(target, 'github.com/bob'), null);
});

it('prevents older reads from overwriting a newer request and bounds idle work', async () => {
  const releases: ((value: PrInboxDetail) => void)[] = [];
  const f = fixture({ detail: async () => new Promise(resolve => { releases.push(resolve); }) }); await f.seed();
  const first = f.cache.api.detail(target, f.options()); const second = f.cache.api.detail(target, f.options());
  releases[1]({ ...detail(), body: 'new' }); await second;
  releases[0]({ ...detail(), body: 'old' }); await assert.rejects(first, /过期/);
  assert.equal(f.cache.getDetail(target, identity.key)?.body, 'new');
  const many = fixture(); await many.seed();
  for (let number = 1; number <= 12; number++) await many.cache.api.detail({ ...target, number }, many.options());
  const before = many.calls.length; many.advance(); await many.cache.refreshIdle(); assert.equal(many.calls.length - before, 8);
});

it('invalidates in-flight activity after an uncertain comment write without discarding displayed data', async () => {
  let delayed = false; let release!: (page: PrActivityPage) => void;
  const f = fixture({ activity: async () => delayed ? new Promise(resolve => { release = resolve; }) : activity('existing'),
    comment: async () => { throw new Error('unconfirmed'); } });
  await f.seed(); await f.cache.api.activity(target, 'comments', null, head, null, f.options()); delayed = true;
  const pending = f.cache.api.activity(target, 'comments', null, head, null, f.options());
  await assert.rejects(f.cache.api.comment(target, 'comment', f.options()), /unconfirmed/);
  release(activity('obsolete')); await assert.rejects(pending, /过期/);
  assert.equal(f.cache.getActivity(target, identity.key, head).comments?.comments[0].body, 'existing');
});

it('discards old activity and patch versions when detail observes a new head or base', async () => {
  let newHead = false;
  const f = fixture({ detail: async () => newHead ? { ...detail(), item: { ...item, headSha: 'c'.repeat(40) } } : detail() });
  await f.seed(); await f.cache.api.detail(target, f.options());
  await f.cache.api.activity(target, 'comments', null, head, null, f.options());
  await f.cache.api.files(target, 1, head, base, f.options());
  newHead = true; await f.cache.api.detail(target, { ...f.options(), force: true });
  assert.equal(f.cache.getFiles(target, identity.key, head, base), null);
  assert.deepEqual(f.cache.getActivity(target, identity.key, head), {});
  const before = f.calls.length; f.advance(); await f.cache.refreshIdle();
  assert.ok(f.calls.slice(before).every(call => call.name !== 'activity' && call.name !== 'files'));
});

it('keeps entries that are still being read when later reads fill the cache', async () => {
  const f = fixture(); await f.seed();
  await f.cache.api.detail(target, f.options());
  for (let n = 1; n <= 220; n++) {
    await f.cache.api.detail({ ...target, number: 1000 + n }, f.options());
    assert.ok(f.cache.getList(query)); assert.ok(f.cache.getDetail(target, identity.key));
  }
  assert.equal(f.cache.getDetail({ ...target, number: 1001 }, identity.key), null);
});

it('warms the default list and newest row status before the inbox is opened, then backs off on failure', async () => {
  const f = fixture({ list: async () => list({ items: [{ ...item, enrichment: 'idle' }] }), enrich: async targets => targets.map(t => ({ ...item, target: t })) });
  await f.cache.warm(query);
  assert.deepEqual(f.calls.map(call => call.name), ['list', 'enrich']);
  assert.equal(f.cache.getList(query)?.items[0].title, 'Cached PR');
  await f.cache.warm(query); assert.equal(f.calls.length, 2);
  const failing = fixture({ list: async () => { throw new Error('offline'); } });
  await failing.cache.warm(query); await failing.cache.warm(query); assert.equal(failing.calls.length, 1);
  failing.advance(); await failing.cache.warm(query); assert.equal(failing.calls.length, 2);
});

it('preloads unopened PR details attention-first, a few per call, and refreshes them on a slower cadence', async () => {
  const row = (number: number, updatedAt: string, attention = false): PrInboxItem => ({ ...item, key: `github.com/owner/repo#${number}`, target: { ...target, number }, updatedAt,
    attentionReasons: attention ? ['reviewRequested'] : [] });
  const rows = [row(1, '2026-10-01T00:00:00Z'), row(2, '2026-10-05T00:00:00Z'), row(3, '2026-09-01T00:00:00Z', true), row(4, '2026-10-03T00:00:00Z')];
  const f = fixture({ list: async () => list({ items: rows }) }); await f.seed();
  await f.cache.api.detail({ ...target, number: 2 }, f.options());
  const before = f.calls.length;
  await f.cache.preload(query);
  const preloaded = f.calls.slice(before);
  assert.deepEqual(preloaded.filter(call => call.name === 'detail').map(call => call.args[0].number), [3, 4]);
  assert.equal(preloaded.filter(call => call.name === 'activity').length, 8);
  assert.ok(f.cache.getDetail({ ...target, number: 3 }, identity.key));
  assert.ok(f.cache.getActivity({ ...target, number: 3 }, identity.key, head).comments);
  await f.cache.preload(query, () => true, 2);
  assert.deepEqual(f.calls.slice(before).filter(call => call.name === 'detail').map(call => call.args[0].number), [3, 4, 1]);
  // Viewed entries refresh after a minute; preloaded ones wait for five.
  const settled = f.calls.length; f.advance(); await f.cache.refreshIdle(); await f.cache.refreshIdle();
  assert.ok(f.calls.slice(settled).every(call => !(call.name === 'detail' && call.args[0].number !== 2)));
  f.advance(5 * 60_000);
  for (let i = 0; i < 4; i++) await f.cache.refreshIdle();
  assert.ok(f.calls.slice(settled).some(call => call.name === 'detail' && call.args[0].number === 3));
});
