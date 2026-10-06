import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { describe, it } from 'node:test';
import type { PrTarget } from '@vela/shared';
import type { GhResult, GhRunOptions } from '../src/gh-run.ts';
registerHooks({ resolve(specifier, context, next) { if (specifier.startsWith('.') && !/\.[jt]s$/.test(specifier)) { try { return next(`${specifier}.ts`, context); } catch {} } return next(specifier, context); } });
const { PullRequestInboxService, validateInboxQuery } = await import('../src/pull-request-inbox-service.ts');
const { searchItem, enrichItem, checkSummary, pairRemoteDiff, validateTarget, targetKey, safeGithubUrl } = await import('../src/pr-inbox-mapping.ts');
const target: PrTarget = { host: 'github.com', owner: 'Owner', repo: 'Repo', number: 128 };
const head = 'a'.repeat(40); const base = 'b'.repeat(40);
const query = { state: 'openAndDraft' as const, repository: null };
function result(value: unknown, code = 0): GhResult {
  return { ok: code === 0, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '', timedOut: false, killed: false, spawnError: null, exitCode: code, cancelled: false, outputTruncated: false };
}
function search(repo = 'Repo', number = 128, extra = {}) {
  return { number, html_url: `https://github.com/Owner/${repo}/pull/${number}`, title: `Title ${repo}`, state: 'open', draft: false, updated_at: '2026-10-05T00:00:00Z', user: { login: 'alice' }, pull_request: {}, ...extra };
}
function pr(extra = {}) {
  return { number: 128, title: 'PR title', url: 'https://github.com/Owner/Repo/pull/128', state: 'OPEN', isDraft: false,
    author: { login: 'alice' }, body: '# Description', headRefOid: head, baseRefOid: base, headRefName: 'feature', baseRefName: 'main',
    statusCheckRollup: [], changedFiles: 1, updatedAt: '2026-10-05T00:00:00Z', ...extra };
}
function fixture(custom?: (args: string[], stdin?: string, options?: GhRunOptions) => GhResult | Promise<GhResult> | undefined) {
  const calls: { cwd: string | null; args: string[]; stdin?: string; options?: GhRunOptions }[] = [];
  let login = 'alice'; let clock = 1_000_000;
  const service = new PullRequestInboxService(async (cwd, args, _timeout, stdin, options) => {
    calls.push({ cwd, args, stdin, options });
    const override = await custom?.(args, stdin, options); if (override) return override;
    if (args[0] === '--version') return result('gh version 2.96.0');
    if (args[0] === 'auth') return result({ hosts: { 'github.com': [{ state: 'success', active: true, login }] } });
    if (args.includes('user')) return result({ login });
    if (args.includes('search/issues')) return result({ items: [search()], total_count: 1, incomplete_results: false });
    if (args[1] === 'view') return result(pr());
    if (args[1] === 'checks') return result([]);
    if (args.some(a => a.includes('/files?'))) return result([{ filename: 'src/a.ts', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-old\n+new' }]);
    throw new Error(`Unhandled fake gh: ${args.join(' ')}`);
  }, () => clock);
  return { service, calls, setLogin: (value: string) => { login = value; }, advance: (ms = 60_001) => { clock += ms; } };
}

describe('PR inbox mappings and boundaries', () => {
  it('uses repository-qualified, case-insensitive keys and merged/closed before draft', () => {
    assert.equal(targetKey(target), 'github.com/owner/repo#128');
    assert.notEqual(searchItem(search('Other'), 'authored').key, searchItem(search(), 'authored').key);
    assert.equal(searchItem(search('Repo', 128, { state: 'closed', draft: true, pull_request: { merged_at: '2026-01-01' } }), 'authored').state, 'merged');
    assert.equal(searchItem(search('Repo', 128, { state: 'closed', draft: true }), 'authored').state, 'closed');
  });
  it('keeps unknown, no checks, skip and cancel separate from success', () => {
    assert.equal(checkSummary(undefined), 'unknown'); assert.equal(checkSummary([]), 'none');
    assert.equal(checkSummary([{ bucket: 'skipping' }]), 'skipped'); assert.equal(checkSummary([{ conclusion: 'CANCELLED' }]), 'cancelled');
    assert.equal(checkSummary([{ state: 'SUCCESS' }]), 'passing'); assert.equal(checkSummary([{ state: 'PENDING' }]), 'pending');
    assert.equal(checkSummary([{ state: 'SUCCESS' }], false), 'unknown');
    assert.equal(enrichItem(searchItem(search(), 'authored'), { ...pr(), commits: { nodes: [{ commit: { statusCheckRollup: null } }] }, statusCheckRollup: undefined }).checks, 'none');
  });
  it('rejects renderer-supplied targets, filters, and unsafe links', () => {
    for (const invalid of [{ ...target, host: 'evil.test' }, { ...target, owner: 123 }, { ...target, repo: '../repo' }, { ...target, number: '-1' }, { ...target, repo: '..' }]) {
      assert.throws(() => validateTarget(invalid));
    }
    assert.throws(() => validateInboxQuery({ state: 'is:pr', repository: null }));
    assert.throws(() => validateInboxQuery({ state: 'all', repository: 'o/r is:closed' }));
    for (const url of ['javascript:alert(1)', 'https://github.com.evil/Owner/Repo/pull/128', 'https://github.com@evil.test/Owner/Repo/pull/128', 'https://github.com/Other/Repo/pull/128']) assert.equal(safeGithubUrl(url, target), null);
  });
  it('pairs multi-hunk, rename, deletion, spaced and escaped paths without guessing binary files', () => {
    const files = ['space name.ts', '新.ts', 'gone.ts', 'renamed.ts', 'bin.png'].map(path => ({ path, previousPath: null, status: 'modified', additions: 1, deletions: 1, patch: null, patchTruncated: false, url: null }));
    const diff = 'diff --git a/space name.ts b/space name.ts\n--- a/space name.ts\n+++ b/space name.ts\n@@ -1 +1 @@\n-a\n+b\n@@ -9 +9 @@\n-c\n+d\n\\ No newline at end of file\n' +
      'diff --git "a/\\346\\226\\260.ts" "b/\\346\\226\\260.ts"\n--- "a/\\346\\226\\260.ts"\n+++ "b/\\346\\226\\260.ts"\n@@ -1 +1 @@\n-a\n+b\n' +
      'diff --git a/gone.ts b/gone.ts\n--- a/gone.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-a\n' +
      'diff --git a/old.ts b/renamed.ts\nrename from old.ts\nrename to renamed.ts\n' +
      'diff --git a/bin.png b/bin.png\nBinary files a/bin.png and b/bin.png differ\n';
    const paired = pairRemoteDiff(diff, files, false);
    assert.equal(paired.size, 4); assert.match(paired.get('space name.ts')!, /@@ -9/); assert.ok(paired.has('新.ts')); assert.ok(!paired.has('bin.png'));
    assert.equal(pairRemoteDiff(diff.slice(0, diff.indexOf('diff --git a/bin.png')), files, true).has('renamed.ts'), false);
  });
});

describe('PR inbox gh service', () => {
  it('reads without cwd, merges overlapping relationships and keeps repository collisions separate', async () => {
    const f = fixture(args => args.includes('search/issues') ? result({ items: args.includes('q=is:pr is:open author:alice') ? [search(), search('Other')] : [search()], total_count: args.includes('q=is:pr is:open author:alice') ? 2 : 1, incomplete_results: false }) : undefined);
    const list = await f.service.list(query);
    assert.equal(list.items.length, 2); assert.deepEqual(list.items.find(i => i.target.repo === 'Repo')!.relations, ['authored', 'reviewRequested', 'assigned', 'mentioned']);
    assert.ok(list.complete); assert.ok(f.calls.every(c => c.cwd === null && c.options?.env?.GH_HOST === 'github.com'));
    assert.ok(f.calls.filter(c => c.args.includes('search/issues')).every(c => c.args.includes('GET')));
    const calls = f.calls.length; await f.service.list(query); assert.equal(f.calls.length, calls);
  });
  it('paginates each relation and caps the 1000-result search range', async () => {
    const f = fixture(args => {
      if (!args.includes('search/issues')) return;
      const page = Number(args.find(a => a.startsWith('page='))!.slice(5));
      return result({ items: Array.from({ length: 100 }, (_, i) => search('Repo', (page - 1) * 100 + i + 1)), total_count: 1200, incomplete_results: false });
    });
    let list = await f.service.list(query); assert.equal(list.items.length, 100); assert.equal(list.complete, false);
    for (let i = 0; i < 9; i++) list = await f.service.list(query, { more: true, revision: list.revision });
    assert.equal(list.items.length, 1000); assert.ok(list.pages.every(p => p.nextPage === null && p.incompleteResults && !p.complete));
    assert.throws(() => validateInboxQuery({ state: 'all', repository: 'a/b x' }));
  });
  it('preserves failed relationships while successful categories replace stale members', async () => {
    let failing = false;
    const f = fixture(args => {
      if (!args.includes('search/issues') || !failing) return;
      if (args.some(a => a.includes('author:alice'))) return { ...result('', 1), stderr: 'temporary error' };
      return result({ items: [], total_count: 0, incomplete_results: false });
    });
    const first = await f.service.list(query); failing = true;
    const next = await f.service.list(query, { force: true });
    assert.equal(next.items.length, 1); assert.deepEqual(next.items[0].relations, ['authored']); assert.equal(next.stale, true);
    assert.ok(next.pages[0].error); assert.ok(next.syncedAt! >= first.syncedAt!);
  });
  it('isolates account changes and discards requests from an earlier identity', async () => {
    const f = fixture(); const first = await f.service.list(query); f.setLogin('bob');
    const second = await f.service.list(query, { force: true }); assert.equal(second.identity?.login, 'bob');
    await assert.rejects(f.service.detail(target, first.identity!.key), /身份已变化/);
    f.setLogin('alice'); await f.service.list(query, { force: true });
    const a = await f.service.detail(target, 'github.com/alice'); assert.equal(a.identity.login, 'alice');
  });
  it('accepts effective user even when auth JSON reports a failed saved account', async () => {
    const f = fixture(args => args[0] === 'auth' ? result({ hosts: { 'github.com': [{ state: 'failure' }] } }) : undefined);
    assert.equal((await f.service.list(query)).identity?.login, 'alice');
  });
  it('clears cache when effective credentials become invalid, but keeps offline cache', async () => {
    let failure = '';
    const f = fixture(args => args.includes('user') && failure ? { ...result('', 1), stderr: failure } : undefined);
    await f.service.list(query); failure = 'network connection reset';
    const offline = await f.service.list(query, { force: true }); assert.equal(offline.error?.kind, 'offline'); assert.equal(offline.items.length, 1); assert.ok(offline.stale);
    f.advance(1_000_000); failure = 'HTTP 401 Bad credentials';
    const invalid = await f.service.list(query, { force: true }); assert.equal(invalid.error?.kind, 'unauthenticated'); assert.equal(invalid.items.length, 0); assert.equal(invalid.identity, null);
  });
  it('allows valid checks JSON with business failure/pending exits, rejects invalid JSON', async () => {
    for (const code of [1, 8]) {
      const f = fixture(args => args[1] === 'checks' ? result([{ name: 'CI', state: code === 8 ? 'PENDING' : 'FAILURE', bucket: code === 8 ? 'pending' : 'fail' }], code) : undefined);
      await f.service.list(query); const detail = await f.service.detail(target, 'github.com/alice');
      assert.equal(detail.checksError, null); assert.equal(detail.checks[0].state, code === 8 ? 'pending' : 'failing');
    }
    const f = fixture(args => args[1] === 'checks' ? result('broken json', 8) : undefined);
    await f.service.list(query); assert.ok((await f.service.detail(target, 'github.com/alice')).checksError);
  });
  it('batches GraphQL with variables and marks unavailable contexts unknown', async () => {
    const f = fixture((args, stdin) => {
      if (!args.includes('graphql')) return;
      const body = JSON.parse(stdin!); assert.equal(body.variables.o0, 'Owner'); assert.equal(body.variables.n0, 128);
      assert.ok(!body.query.includes('Owner')); assert.ok(args.includes('--input'));
      return result({ data: { r0: { p0: { ...pr(), statusCheckRollup: undefined, commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [{ state: 'SUCCESS' }], pageInfo: { hasNextPage: true } } } } }] } } } } });
    });
    await f.service.list(query); const rows = await f.service.enrich([target], 'github.com/alice');
    assert.equal(rows[0].checks, 'unknown'); assert.equal(f.calls.filter(c => c.args.includes('graphql')).length, 1);
  });
  it('coalesces duplicate detail reads, and cancellation does not cancel another reader', async () => {
    let views = 0; let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const f = fixture(async args => { if (args[1] === 'view' && ++views === 1) { await wait; return result(pr()); } });
    await f.service.list(query);
    const controller = new AbortController(); const one = f.service.detail(target, 'github.com/alice', false, controller.signal);
    const rejection = assert.rejects(one, /取消/); const two = f.service.detail(target, 'github.com/alice');
    await new Promise(resolve => setImmediate(resolve)); controller.abort(); release();
    await rejection; assert.equal((await two).item.headSha, head); assert.equal(views, 2);
  });
  it('rejects file/detail versions that changed during read', async () => {
    let views = 0;
    const f = fixture(args => args[1] === 'view' ? result(pr({ headRefOid: ++views > 1 ? 'c'.repeat(40) : head })) : undefined);
    await f.service.list(query); await assert.rejects(f.service.files(target, 1, head, base, 'github.com/alice'), /版本已变化/);
  });
  it('keeps binary/missing patches and reports file API limits and truncated diff', async () => {
    const f = fixture(args => {
      if (args[1] === 'view') return result(pr({ changedFiles: 3100 }));
      if (args.some(a => a.includes('/files?'))) return result([{ filename: 'bin.png', additions: 0, deletions: 0, status: 'modified' }]);
      if (args[1] === 'diff') return { ...result('diff --git a/bin.png b/bin.png\nBinary files differ'), outputTruncated: true };
    });
    await f.service.list(query); const files = await f.service.files(target, 1, head, base, 'github.com/alice');
    assert.equal(files.files[0].patch, null); assert.equal(files.limited, true); assert.equal(files.diffTruncated, true);
  });
  it('paginates recent activities backwards and validates thread ownership', async () => {
    const f = fixture((args, stdin) => {
      if (!args.includes('graphql')) return;
      const input = JSON.parse(stdin!);
      if (input.variables.id) return result({ data: { node: { pullRequest: { headRefOid: head, number: 999, repository: { name: 'Repo', owner: { login: 'Owner' } } }, comments: { nodes: [], pageInfo: { hasNextPage: false } } } } });
      assert.match(input.query, /comments\(last:30,before:\$cursor\)/);
      return result({ data: { repository: { pullRequest: { headRefOid: head, comments: { nodes: [{ id: 'C1', body: 'hello', author: { login: 'friend' } }], pageInfo: { hasPreviousPage: true, startCursor: 'cursor1' } } } } } });
    });
    await f.service.list(query);
    const page = await f.service.activity(target, 'comments', null, head, null, 'github.com/alice'); assert.equal(page.nextCursor, 'cursor1'); assert.equal(page.comments[0].body, 'hello');
    await assert.rejects(f.service.activity(target, 'threadComments', null, head, 'T1', 'github.com/alice'), /不属于/);
  });
  it('uses server-side state/repository filters and rate-limit backoff', async () => {
    const f = fixture(args => args.includes('search/issues') ? { ...result('', 1), stderr: 'HTTP 429 rate limit exceeded Retry-After: 90' } : undefined);
    const list = await f.service.list({ state: 'closed', repository: 'Owner/Repo' });
    assert.equal(list.error?.kind, 'rate-limited'); assert.ok(list.error!.retryAt! >= 1_090_000);
    const calls = f.calls.length; await f.service.list(query, { force: true }); assert.equal(f.calls.length, calls);
    assert.ok(f.calls.some(c => c.args.some(a => a.includes('is:closed is:unmerged') && a.includes('repo:Owner/Repo'))));
  });
});

describe('PR inbox asynchronous isolation', () => {
  it('never shares detail cache for identical PR numbers in different repositories', async () => {
    const f = fixture(args => args[1] === 'view' && args.includes('github.com/Owner/Other') ? result(pr({ url: 'https://github.com/Owner/Other/pull/128', title: 'Other repository', headRefOid: 'c'.repeat(40) })) : undefined);
    await f.service.list(query);
    const one = await f.service.detail(target, 'github.com/alice');
    const other = await f.service.detail({ ...target, repo: 'Other' }, 'github.com/alice');
    assert.equal(one.item.title, 'PR title'); assert.equal(other.item.title, 'Other repository'); assert.notEqual(one.item.headSha, other.item.headSha);
    assert.ok(f.calls.some(c => c.args.includes('github.com/Owner/Other')));
  });
  it('discards an old-account detail response when effective identity changes', async () => {
    let release!: () => void; let slow = true;
    const delay = new Promise<void>(resolve => { release = resolve; });
    const f = fixture(async args => { if (args[1] === 'view' && slow) { await delay; return result(pr()); } });
    await f.service.list(query);
    const old = f.service.detail(target, 'github.com/alice'); const rejected = assert.rejects(old, /取消|身份已变化/);
    await new Promise(resolve => setImmediate(resolve)); f.setLogin('bob');
    const current = await f.service.list(query, { force: true }); assert.equal(current.identity?.login, 'bob'); slow = false; release(); await rejected;
    assert.equal((await f.service.detail(target, 'github.com/bob')).identity.login, 'bob');
  });
  it('does not let a delayed older page overwrite a newer refresh', async () => {
    let release!: () => void; const delay = new Promise<void>(resolve => { release = resolve; });
    const f = fixture(async args => {
      if (!args.includes('search/issues')) return;
      const page = Number(args.find(a => a.startsWith('page='))!.slice(5));
      if (page === 2) await delay;
      return result({ items: Array.from({ length: 100 }, (_, i) => search('Repo', (page - 1) * 100 + i + 1)), total_count: 200, incomplete_results: false });
    });
    const first = await f.service.list(query);
    const more = f.service.list(query, { more: true, revision: first.revision }); const rejected = assert.rejects(more, /已过期/);
    await new Promise(resolve => setImmediate(resolve)); const refreshed = await f.service.list(query, { force: true });
    release(); await rejected;
    const cached = await f.service.list(query); assert.equal(cached.items.length, 100); assert.equal(cached.revision, refreshed.revision);
  });
  it('reports no checks without interpreting an empty nonzero result as passed', async () => {
    const f = fixture(args => args[1] === 'checks' ? { ...result('', 1), stderr: 'no checks reported on the branch' } : undefined);
    await f.service.list(query); const detail = await f.service.detail(target, 'github.com/alice');
    assert.equal(detail.item.checks, 'none'); assert.equal(detail.checksError, null);
  });
});

describe('PR inbox failure semantics', () => {
  it('does not accept authentication failures as business check exits even with a JSON array', async () => {
    const f = fixture(args => args[1] === 'checks' ? { ...result([], 1), stderr: 'HTTP 401 Bad credentials' } : undefined);
    await f.service.list(query); const detail = await f.service.detail(target, 'github.com/alice');
    assert.ok(detail.checksError); assert.equal(detail.item.checks, 'unknown');
  });
  it('distinguishes missing gh, inaccessible PRs and malformed/truncated responses', async () => {
    const missing = fixture(args => args[0] === '--version' ? { ...result('', 1), spawnError: 'spawn gh ENOENT' } : undefined);
    assert.equal((await missing.service.list(query)).error?.kind, 'no-gh');
    const unavailable = fixture(args => args[1] === 'view' ? { ...result('', 1), stderr: 'HTTP 404 Not Found' } : undefined);
    await unavailable.service.list(query); await assert.rejects(unavailable.service.detail(target, 'github.com/alice'), /404|权限/);
    const truncated = fixture(args => args.includes('search/issues') ? { ...result('{"partial":'), outputTruncated: true } : undefined);
    const list = await truncated.service.list(query); assert.ok(list.pages.every(p => p.error?.includes('超过读取上限'))); assert.equal(list.complete, false);
  });
});

describe('PR inbox pagination completeness', () => {
  it('retains incomplete_results from earlier pages and never reports a definitive total', async () => {
    const f = fixture(args => {
      if (!args.includes('search/issues')) return;
      const page = Number(args.find(a => a.startsWith('page='))!.slice(5));
      return result({ items: Array.from({ length: page === 1 ? 100 : 1 }, (_, i) => search('Repo', page === 1 ? i + 1 : 101)), total_count: 101, incomplete_results: page === 1 });
    });
    const first = await f.service.list(query); const more = await f.service.list(query, { more: true, revision: first.revision });
    assert.equal(more.items.length, 101); assert.equal(more.complete, false); assert.ok(more.pages.every(p => p.incompleteResults));
  });
});

describe('PR inbox conversation writes', () => {
  const posted = (body = 'hello', extra = {}) => ({ node_id: 'IC_1', body, user: { login: 'alice' }, created_at: '2026-10-06T00:00:00Z', html_url: 'https://github.com/Owner/Repo/pull/128#issuecomment-1', ...extra });
  it('validates the target and body before invoking gh', async () => {
    const f = fixture();
    for (const body of ['', '  \n', 'a'.repeat(65_537), null]) await assert.rejects(f.service.comment(target, body as string, 'github.com/alice', 'write1'), /留言/);
    await assert.rejects(f.service.comment({ ...target, repo: 'Repo;evil' }, 'hello', 'github.com/alice', 'write1'));
    await assert.rejects(f.service.comment(target, 'hello', 'bad-identity', 'write1'));
    assert.equal(f.calls.length, 0);
  });
  it('uses a repository-qualified POST, preserves Markdown through stdin and returns the real receipt', async () => {
    const body = '## Comment\n- 中文 `code`\n$(do not execute) & "quoted"';
    const f = fixture(args => args.includes('POST') ? result(posted(body)) : undefined);
    const comment = await f.service.comment(target, body, 'github.com/alice', 'write1');
    assert.equal(comment.id, 'IC_1'); assert.equal(comment.author, 'alice'); assert.equal(comment.body, body);
    assert.equal(comment.createdAt, Date.parse('2026-10-06T00:00:00Z'));
    const write = f.calls.find(c => c.args.includes('POST'))!;
    assert.deepEqual(write.args, ['api', '--hostname', 'github.com', '--method', 'POST', 'repos/Owner/Repo/issues/128/comments', '--input', '-']);
    assert.deepEqual(JSON.parse(write.stdin!), { body }); assert.equal(write.cwd, null); assert.equal(write.options?.env?.GH_HOST, 'github.com');
    assert.ok(f.calls.findIndex(c => c.args[1] === 'view') < f.calls.indexOf(write));
  });
  it('probes credentials afresh and blocks writes after an account switch or inaccessible PR', async () => {
    const f = fixture(); await f.service.list(query); f.setLogin('bob');
    await assert.rejects(f.service.comment(target, 'hello', 'github.com/alice', 'write1'), /身份已变化/);
    assert.ok(!f.calls.some(c => c.args.includes('POST')));
    const missing = fixture(args => args[1] === 'view' ? { ...result('', 1), stderr: 'HTTP 404 Not Found' } : undefined);
    await assert.rejects(missing.service.comment(target, 'hello', 'github.com/alice', 'write1'));
    assert.ok(!missing.calls.some(c => c.args.includes('POST')));
  });
  it('coalesces concurrent and completed repeats of one operation and rejects changed payloads', async () => {
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const f = fixture(async args => { if (args.includes('POST')) { await gate; return result(posted()); } });
    const one = f.service.comment(target, 'hello', 'github.com/alice', 'write1');
    const two = f.service.comment(target, 'hello', 'github.com/alice', 'write1');
    await assert.rejects(f.service.comment(target, 'different', 'github.com/alice', 'write1'), /内容不同/);
    await assert.rejects(f.service.comment({ ...target, repo: 'Other' }, 'hello', 'github.com/alice', 'write1'), /内容不同/);
    release(); assert.equal((await one).id, (await two).id);
    await f.service.comment(target, 'hello', 'github.com/alice', 'write1');
    assert.equal(f.calls.filter(c => c.args.includes('POST')).length, 1);
  });
  it('never repeats an uncertain POST and does not report success on a malformed or wrong-target receipt', async () => {
    for (const failure of [{ ...result('', 1), timedOut: true }, result(posted('hello', { html_url: 'https://github.com/Owner/Repo/pull/129#issuecomment-1' })), result('invalid json')]) {
      const f = fixture(args => args.includes('POST') ? failure : undefined);
      await assert.rejects(f.service.comment(target, 'hello', 'github.com/alice', 'write1'), /确认/);
      await assert.rejects(f.service.comment(target, 'hello', 'github.com/alice', 'write1'), /确认/);
      assert.equal(f.calls.filter(c => c.args.includes('POST')).length, 1);
    }
  });
  it('revalidates activities immediately when force is requested, even within the service TTL', async () => {
    let body = 'before';
    const f = fixture(args => args.includes('graphql') ? result({ data: { repository: { pullRequest: { headRefOid: head,
      comments: { nodes: [{ id: 'IC_1', body }], pageInfo: { hasPreviousPage: false } } } } } }) : undefined);
    const first = await f.service.activity(target, 'comments', null, head, null, 'github.com/alice');
    body = 'after';
    assert.equal(await f.service.activity(target, 'comments', null, head, null, 'github.com/alice'), first);
    const refreshed = await f.service.activity(target, 'comments', null, head, null, 'github.com/alice', undefined, true);
    assert.equal(refreshed.comments[0].body, 'after');
    assert.equal(f.calls.filter(call => call.args.includes('graphql')).length, 2);
  });
  it('invalidates activity cache after posting so refresh returns the new discussion', async () => {
    let body = 'before';
    const f = fixture(args => {
      if (args.includes('POST')) { body = 'after'; return result(posted(body)); }
      if (args.includes('graphql')) return result({ data: { repository: { pullRequest: { headRefOid: head, comments: { nodes: [{ id: 'IC_1', body }], pageInfo: { hasPreviousPage: false } } } } } });
    });
    const before = await f.service.activity(target, 'comments', null, head, null, 'github.com/alice'); assert.equal(before.comments[0].body, 'before');
    await f.service.comment(target, 'after', 'github.com/alice', 'write1');
    const after = await f.service.activity(target, 'comments', null, head, null, 'github.com/alice'); assert.equal(after.comments[0].body, 'after');
    assert.equal(f.calls.filter(c => c.args.includes('graphql')).length, 2);
  });
  it('reads actual commits and paginates backwards without using the PR title as a commit message', async () => {
    const f = fixture((args, stdin) => {
      if (!args.includes('graphql')) return;
      const input = JSON.parse(stdin!); assert.match(input.query, /commits\(last:30,before:\$cursor\)/); assert.equal(input.variables.cursor, 'older');
      return result({ data: { repository: { pullRequest: { headRefOid: head, commits: { nodes: [{ commit: { oid: head, messageHeadline: 'Actual commit', committedDate: '2026-10-05T00:00:00Z', author: { name: 'Alice', user: { login: 'alice' } } } }], pageInfo: { hasPreviousPage: true, startCursor: 'next' } } } } } });
    });
    const page = await f.service.activity(target, 'commits', 'older', head, null, 'github.com/alice');
    assert.equal(page.commits?.[0].title, 'Actual commit'); assert.equal(page.commits?.[0].author, 'alice'); assert.equal(page.nextCursor, 'next');
  });
  it('allows a refresh to discover an accepted write even if the POST response timed out', async () => {
    let accepted = false;
    const f = fixture(args => {
      if (args.includes('POST')) { accepted = true; return { ...result('', 1), timedOut: true }; }
      if (args.includes('graphql')) return result({ data: { repository: { pullRequest: { headRefOid: head, comments: { nodes: accepted ? [{ id: 'IC_1', body: 'accepted' }] : [], pageInfo: { hasPreviousPage: false } } } } } });
    });
    assert.equal((await f.service.activity(target, 'comments', null, head, null, 'github.com/alice')).comments.length, 0);
    await assert.rejects(f.service.comment(target, 'accepted', 'github.com/alice', 'write1'), /未确认/);
    f.advance(); // Respect the existing transport backoff before confirming the outcome.
    assert.equal((await f.service.activity(target, 'comments', null, head, null, 'github.com/alice')).comments[0].body, 'accepted');
    assert.equal(f.calls.filter(c => c.args.includes('POST')).length, 1);
  });
});

it('marks a GitHub patch incomplete when its hunk counts do not cover file statistics', async () => {
  const { fileItem } = await import('../src/pr-inbox-mapping.ts');
  const file = fileItem({ filename: 'large.ts', additions: 2000, deletions: 0, patch: '@@ -0,0 +1,2000 @@\n+only one returned line' }, target);
  assert.equal(file.patchTruncated, true);
  assert.equal(fileItem({ filename: 'normal.ts', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n--- old code\n+++ new code' }, target).patchTruncated, false);
});
