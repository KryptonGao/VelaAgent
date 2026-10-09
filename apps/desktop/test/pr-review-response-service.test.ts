import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import type { PrFeedbackThread, PrTarget } from '@vela/shared';
import { PrReviewResponseService } from '../src/main/pr-review-response-service.ts';

const target: PrTarget = { host: 'github.com', owner: 'Owner', repo: 'Repo', number: 128 };
const identity = 'github.com/alice';
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const scratch = mkdtempSync(join(tmpdir(), 'vela-prr-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
const thread = (id: string, extra: Partial<PrFeedbackThread> = {}): PrFeedbackThread => ({ id, path: 'a.txt', line: 1, outdated: false, moreComments: false, comments: [{ author: 'bob', body: `Please fix ${id}`, url: null }], ...extra });

interface World { bare: string; clone: string; home: string; headSha: string; feedback: any; replies: any[]; conversations: any[]; service: PrReviewResponseService; failReply: Set<string>; workspaces: string[] }
let counter = 0;
function world(): World {
  const dir = join(scratch, `w${counter++}`); mkdirSync(dir, { recursive: true });
  const bare = join(dir, 'remote.git'); const clone = join(dir, 'clone'); const home = join(dir, 'home');
  sh(dir, 'init', '--bare', '-b', 'main', bare);
  sh(dir, 'clone', bare, clone);
  writeFileSync(join(clone, 'a.txt'), 'one\n'); sh(clone, 'add', '.'); sh(clone, 'commit', '-m', 'init'); sh(clone, 'push', 'origin', 'main');
  sh(clone, 'checkout', '-b', 'feature'); writeFileSync(join(clone, 'a.txt'), 'one\ntwo\n'); sh(clone, 'commit', '-am', 'feature work'); sh(clone, 'push', 'origin', 'feature');
  sh(clone, 'checkout', 'main');
  // The remote looks like GitHub to Vela, but git still reaches the local bare repository.
  sh(clone, 'remote', 'set-url', 'origin', 'https://github.com/Owner/Repo.git');
  sh(clone, 'config', `url.${bare}.insteadOf`, 'https://github.com/Owner/Repo.git');
  const headSha = sh(clone, 'rev-parse', 'feature');
  const w = { bare, clone, home, headSha, replies: [] as any[], conversations: [] as any[], failReply: new Set<string>(), workspaces: [clone, join(dir, 'not-a-repo')] } as World;
  w.feedback = { headSha, headRefName: 'feature', state: 'OPEN', authorLogin: 'alice', headRepository: 'Owner/Repo', isCrossRepository: false, maintainerCanModify: false,
    threads: [thread('PRRT_old', { outdated: true }), thread('PRRT_1'), thread('PRRT_2')], reviews: [], threadsIncomplete: false };
  w.service = new PrReviewResponseService({
    home, workspaces: () => w.workspaces, now: () => 1_000,
    inbox: {
      reviewFeedback: async () => structuredClone(w.feedback),
      replyToThread: async (_t: PrTarget, threadId: string, body: string, resolve: boolean, _id: string, requestId: string) => {
        if (w.failReply.has(threadId)) throw new Error('boom'); w.replies.push({ threadId, body, resolve, requestId });
        return { threadId, state: resolve ? 'resolved' : 'posted', url: null };
      },
      detail: async () => ({ item: { title: 'Add feature' } }),
    } as any,
    startConversation: async (cwd, title, prompt) => { w.conversations.push({ cwd, title, prompt }); return `conv-${w.conversations.length}`; },
  });
  return w;
}
const startInput = (w: World, ids = ['PRRT_1', 'PRRT_2']) => ({ target, headSha: w.headSha, workspace: w.clone, threadIds: ids, note: '' });
/** Stand-in for the agent: one commit that claims PRRT_1 with a drafted reply. */
function agentCommit(worktree: string, file = 'a.txt', thread = 'PRRT_1') {
  writeFileSync(join(worktree, file), 'one\ntwo\nthree\n');
  sh(worktree, 'commit', '-am', `Fix ${thread}\n\nRenamed the thing.\n\nReview-Thread: ${thread}`);
  return sh(worktree, 'rev-parse', 'HEAD');
}

describe('preparing a review response', () => {
  it('finds the local checkout by remote, ignores other paths, and lists stale threads last', async () => {
    const w = world(); w.workspaces.push(w.clone);
    const plan = await w.service.prepare(target, identity);
    assert.deepEqual(plan.checkouts.map(c => [realpathSync(c.path), c.remote]), [[realpathSync(w.clone), 'origin']]);
    assert.deepEqual(plan.threads.map(t => t.id), ['PRRT_1', 'PRRT_2', 'PRRT_old']);
    assert.equal(plan.pushBlocker, null);
    w.feedback.isCrossRepository = true;
    assert.equal((await w.service.prepare(target, identity)).pushBlocker, 'fork');
  });
  it('finds no checkout for a different repository', async () => {
    const w = world();
    assert.deepEqual((await w.service.prepare({ ...target, repo: 'Other' }, identity)).checkouts, []);
  });
});

describe('starting the agent', () => {
  it('creates a worktree at the PR head, starts one conversation with the threads, and records the run', async () => {
    const w = world();
    const run = await w.service.start(startInput(w) as any, identity, 'start1');
    assert.equal(sh(run.worktree, 'rev-parse', 'HEAD'), w.headSha);
    assert.equal(sh(run.worktree, 'rev-parse', '--abbrev-ref', 'HEAD'), 'vela/pr-128-review');
    assert.ok(run.worktree.startsWith(join(w.home, 'worktrees')));
    assert.equal(w.conversations.length, 1); assert.equal(w.conversations[0].cwd, run.worktree);
    assert.match(w.conversations[0].prompt, /Thread id: PRRT_1/); assert.match(w.conversations[0].prompt, /Thread id: PRRT_2/);
    assert.doesNotMatch(w.conversations[0].prompt, /PRRT_old/);
    assert.equal(run.conversationId, 'conv-1'); assert.equal(run.status, 'working'); assert.deepEqual(run.repliedThreadIds, []);
    const saved = JSON.parse(readFileSync(join(w.home, 'pr-review-responses.json'), 'utf8'));
    assert.equal(saved.runs[0].id, run.id);
    assert.equal(w.service.runsFor(target).length, 1);
    assert.equal(w.service.runsFor({ ...target, number: 1 }).length, 0);
    // A fresh service reads the same record back.
    const again = new PrReviewResponseService({ home: w.home, workspaces: () => [], startConversation: async () => 'x', inbox: {} as any });
    assert.equal(again.runsFor(target)[0]!.id, run.id);
  });
  it('is idempotent per request id and numbers a second branch instead of reusing one', async () => {
    const w = world();
    const [a, b] = await Promise.all([w.service.start(startInput(w) as any, identity, 'same'), w.service.start(startInput(w) as any, identity, 'same')]);
    assert.equal(a.id, b.id); assert.equal(w.conversations.length, 1);
    await assert.rejects(w.service.start(startInput(w, ['PRRT_1']) as any, identity, 'same'), /编号重复/);
    const second = await w.service.start(startInput(w) as any, identity, 'other');
    assert.equal(second.branch, 'vela/pr-128-review-2');
  });
  it('rejects anything the renderer could forge, before creating a worktree or conversation', async () => {
    const w = world();
    const attempts: Array<[string, any]> = [
      ['不是这个仓库的本机检出', { ...startInput(w), workspace: w.home }],
      ['已有新提交', { ...startInput(w), headSha: 'f'.repeat(40) }],
      ['已解决或已不存在', startInput(w, ['PRRT_1', 'PRRT_fake'])],
      ['请选择', startInput(w, [])],
      ['请选择', startInput(w, ['PRRT_1', 'PRRT_1'])],
      ['请选择', { ...startInput(w), note: 'x'.repeat(5000) }],
    ];
    for (const [message, input] of attempts) await assert.rejects(w.service.start(input, identity, `bad-${attempts.indexOf(attempts.find(a => a[1] === input)!)}`), new RegExp(message));
    assert.equal(w.conversations.length, 0); assert.equal(existsSync(join(w.home, 'worktrees')), false);
  });
  it('refuses to start when the remote branch moved past the head the user looked at', async () => {
    const w = world();
    sh(w.clone, 'checkout', 'feature'); writeFileSync(join(w.clone, 'b.txt'), 'x'); sh(w.clone, 'add', '.'); sh(w.clone, 'commit', '-m', 'someone else'); sh(w.clone, 'push', 'origin', 'feature');
    await assert.rejects(w.service.start(startInput(w) as any, identity, 's'), /PR 分支已有新提交/);
    assert.equal(w.conversations.length, 0);
  });
  it('cleans up the worktree and branch if the conversation cannot be started', async () => {
    const w = world();
    const failing = new PrReviewResponseService({ home: w.home, workspaces: () => [w.clone], startConversation: async () => { throw new Error('no model'); },
      inbox: { reviewFeedback: async () => structuredClone(w.feedback), detail: async () => ({ item: { title: 't' } }) } as any });
    await assert.rejects(failing.start(startInput(w) as any, identity, 's'), /no model/);
    assert.equal(sh(w.clone, 'branch', '--list', 'vela/*'), '');
    assert.doesNotMatch(sh(w.clone, 'worktree', 'list'), /pr-Owner/);
    assert.equal(failing.runsFor(target).length, 0);
  });
  it('lets a fork pull request be worked on locally but never published', async () => {
    const w = world(); w.feedback.isCrossRepository = true;
    const run = await w.service.start(startInput(w) as any, identity, 'fork');
    assert.equal(run.pushBlocker, 'fork');
    agentCommit(run.worktree);
    await assert.rejects(w.service.publish({ runId: run.id, requestId: 'p1', identityKey: identity, tipSha: sh(run.worktree, 'rev-parse', 'HEAD'), replies: [] }), /不能由 Vela 推送/);
  });
});

describe('reviewing and publishing', () => {
  it('shows commits, dirty files and reply drafts, and skips threads closed in the meantime', async () => {
    const w = world(); const run = await w.service.start(startInput(w) as any, identity, 's1');
    const sha = agentCommit(run.worktree); writeFileSync(join(run.worktree, 'scratch.txt'), 'x');
    w.feedback.threads = w.feedback.threads.filter((t: PrFeedbackThread) => t.id !== 'PRRT_2');
    const review = await w.service.review(run.id, identity);
    assert.equal(review.tipSha, sha); assert.equal(review.headMoved, false);
    assert.deepEqual(review.commits.map(c => [c.sha, c.threadIds]), [[sha, ['PRRT_1']]]);
    assert.deepEqual(review.dirtyFiles, ['scratch.txt']);
    assert.deepEqual(review.closedThreadIds, ['PRRT_2']);
    assert.deepEqual(review.drafts.map(d => [d.threadId, d.selected, d.body]), [['PRRT_1', true, `Renamed the thing.\n\nAddressed in ${sha.slice(0, 7)}.`]]);
    assert.match(review.diffStat, /a\.txt/);
    w.feedback.headSha = 'c'.repeat(40);
    assert.equal((await w.service.review(run.id, identity)).headMoved, true);
  });
  it('pushes exactly the reviewed commits, then replies, and finishes the run', async () => {
    const w = world(); const run = await w.service.start(startInput(w) as any, identity, 's1');
    const sha = agentCommit(run.worktree);
    const out = await w.service.publish({ runId: run.id, requestId: 'pub1', identityKey: identity, tipSha: sha,
      replies: [{ threadId: 'PRRT_1', body: 'Renamed.', resolve: true }] });
    assert.equal(out.push.state, 'pushed'); assert.equal(sh(w.bare, 'rev-parse', 'feature'), sha);
    assert.deepEqual(out.replies.map(r => [r.threadId, r.state]), [['PRRT_1', 'resolved']]);
    assert.deepEqual(w.replies.map(r => [r.threadId, r.body, r.resolve]), [['PRRT_1', 'Renamed.', true]]);
    assert.match(w.replies[0].requestId, /^pub1-[a-f0-9]{16}$/);
    assert.equal(out.run.status, 'published'); assert.deepEqual(out.run.repliedThreadIds, ['PRRT_1']);
    await assert.rejects(w.service.publish({ runId: run.id, requestId: 'pub2', identityKey: identity, tipSha: sha, replies: [] }), /已结束/);
  });
  it('refuses to publish anything but the tip the user reviewed, a dirty tree, or no commits', async () => {
    const w = world(); const run = await w.service.start(startInput(w) as any, identity, 's1');
    const base = { runId: run.id, identityKey: identity, replies: [] as any[] };
    await assert.rejects(w.service.publish({ ...base, requestId: 'a', tipSha: w.headSha }), /还没有产生新的提交/);
    const sha = agentCommit(run.worktree);
    await assert.rejects(w.service.publish({ ...base, requestId: 'b', tipSha: w.headSha }), /重新审阅/);
    writeFileSync(join(run.worktree, 'a.txt'), 'changed again');
    await assert.rejects(w.service.publish({ ...base, requestId: 'c', tipSha: sha }), /未提交的改动/);
    assert.equal(sh(w.bare, 'rev-parse', 'feature'), w.headSha, 'nothing reached the remote');
    assert.equal(w.replies.length, 0);
  });
  it('validates replies before pushing: unknown threads, duplicates, empty bodies', async () => {
    const w = world(); const run = await w.service.start(startInput(w, ['PRRT_1']) as any, identity, 's1');
    const sha = agentCommit(run.worktree);
    const base = { runId: run.id, identityKey: identity, tipSha: sha };
    for (const [i, replies] of ([[{ threadId: 'PRRT_2', body: 'x', resolve: false }], [{ threadId: 'PRRT_1', body: 'x', resolve: false }, { threadId: 'PRRT_1', body: 'y', resolve: false }], [{ threadId: 'PRRT_1', body: '  ', resolve: false }]] as const).entries())
      await assert.rejects(w.service.publish({ ...base, requestId: `v${i}`, replies: replies as any }), /回复内容或线程无效/);
    assert.equal(sh(w.bare, 'rev-parse', 'feature'), w.headSha);
  });
  it('does not post replies when the push is rejected, and never force-pushes', async () => {
    const w = world(); const run = await w.service.start(startInput(w) as any, identity, 's1');
    const sha = agentCommit(run.worktree);
    sh(w.clone, 'checkout', 'feature'); writeFileSync(join(w.clone, 'b.txt'), 'x'); sh(w.clone, 'add', '.'); sh(w.clone, 'commit', '-m', 'someone else'); sh(w.clone, 'push', 'origin', 'feature');
    const theirs = sh(w.bare, 'rev-parse', 'feature');
    const out = await w.service.publish({ runId: run.id, requestId: 'pub1', identityKey: identity, tipSha: sha, replies: [{ threadId: 'PRRT_1', body: 'Renamed.', resolve: false }] });
    assert.equal(out.push.state, 'failed'); assert.equal(sh(w.bare, 'rev-parse', 'feature'), theirs);
    assert.deepEqual(out.replies.map(r => r.state), ['skipped']); assert.equal(w.replies.length, 0);
    assert.equal(out.run.status, 'working');
  });
  it('retries only what failed: a reply that already posted is never sent twice', async () => {
    const w = world(); const run = await w.service.start(startInput(w) as any, identity, 's1');
    const sha = agentCommit(run.worktree); w.failReply.add('PRRT_2');
    const replies = [{ threadId: 'PRRT_1', body: 'one', resolve: false }, { threadId: 'PRRT_2', body: 'two', resolve: false }];
    const first = await w.service.publish({ runId: run.id, requestId: 'pub1', identityKey: identity, tipSha: sha, replies });
    assert.deepEqual(first.replies.map(r => r.state), ['posted', 'failed']); assert.equal(first.run.status, 'working');
    const review = await w.service.review(run.id, identity);
    assert.deepEqual(review.drafts.map(d => d.threadId), ['PRRT_2'], 'the posted thread is no longer offered');
    await assert.rejects(w.service.publish({ runId: run.id, requestId: 'pub2', identityKey: identity, tipSha: sha, replies }), /已经回复过/);
    w.failReply.clear();
    const second = await w.service.publish({ runId: run.id, requestId: 'pub3', identityKey: identity, tipSha: sha, replies: [replies[1]!] });
    assert.equal(second.push.state, 'pushed'); assert.equal(second.run.status, 'published');
    assert.deepEqual(w.replies.map(r => r.threadId), ['PRRT_1', 'PRRT_2']);
  });
  it('rejects a concurrent publish for the same run and the same request is shared', async () => {
    const w = world(); const run = await w.service.start(startInput(w) as any, identity, 's1');
    const sha = agentCommit(run.worktree);
    const input = { runId: run.id, requestId: 'pub1', identityKey: identity, tipSha: sha, replies: [{ threadId: 'PRRT_1', body: 'x', resolve: false }] };
    const first = w.service.publish(input); const same = w.service.publish(input);
    await assert.rejects(w.service.publish({ ...input, requestId: 'pub2' }), /正在发布/);
    assert.equal((await first).run.id, (await same).run.id); assert.equal(w.replies.length, 1);
  });
  it('refuses to publish if the pull request closed or its branch changed', async () => {
    const w = world(); const run = await w.service.start(startInput(w) as any, identity, 's1');
    const sha = agentCommit(run.worktree);
    const input = { runId: run.id, identityKey: identity, tipSha: sha, replies: [] as any[] };
    w.feedback.state = 'MERGED';
    await assert.rejects(w.service.publish({ ...input, requestId: 'a' }), /不是可推送的状态/);
    w.feedback.state = 'OPEN'; w.feedback.headRefName = 'renamed';
    await assert.rejects(w.service.publish({ ...input, requestId: 'b' }), /分支已变化/);
    assert.equal(sh(w.bare, 'rev-parse', 'feature'), w.headSha);
  });
});

describe('discarding', () => {
  it('removes the worktree directory but keeps the branch and its commits', async () => {
    const w = world(); const run = await w.service.start(startInput(w) as any, identity, 's1');
    const sha = agentCommit(run.worktree);
    const done = await w.service.discard(run.id, true);
    assert.equal(done.status, 'discarded'); assert.equal(existsSync(run.worktree), false);
    assert.equal(sh(w.clone, 'rev-parse', run.branch), sha);
    assert.equal(w.service.runsFor(target).length, 0);
  });
  it('will not delete a worktree that still has uncommitted work', async () => {
    const w = world(); const run = await w.service.start(startInput(w) as any, identity, 's1');
    writeFileSync(join(run.worktree, 'wip.txt'), 'x');
    await assert.rejects(w.service.discard(run.id, true));
    assert.equal(existsSync(run.worktree), true); assert.equal(w.service.runsFor(target)[0]!.status, 'working');
  });
});
