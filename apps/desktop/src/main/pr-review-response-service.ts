import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type {
  PrLocalCheckout, PrReviewResponsePlan, PrReviewResponsePublishInput, PrReviewResponsePublishResult,
  PrReviewResponseReview, PrReviewResponseRun, PrReviewResponseStartInput, PrTarget,
} from '@vela/shared';
import {
  assertValidRefName, buildDrafts, buildResponsePrompt, createWorktree, maxResponseThreads, parseGithubSlug,
  parseResponseCommits, pushBlocker, removeWorktree, responseLogFormat, runGit, validateTarget,
  type PullRequestInboxService,
} from '@vela/workspace';

export interface PrReviewResponseDeps {
  inbox: Pick<PullRequestInboxService, 'reviewFeedback' | 'replyToThread' | 'detail'>;
  /** Vela 数据目录：工作树放在 `worktrees/`，运行记录写入 `pr-review-responses.json`。 */
  home: string;
  /** 已登记的工作区路径；只在这些目录里寻找本机检出。 */
  workspaces: () => string[];
  /** 在 cwd 新建对话并发出提示词，不等待回合结束；返回对话 id。 */
  startConversation: (cwd: string, title: string, prompt: string) => Promise<string>;
  now?: () => number;
}

const maxRuns = 60;
const maxNote = 4000;

function slug(target: PrTarget): string { return `${target.owner}/${target.repo}`.toLowerCase(); }
function sameTarget(a: PrTarget, b: PrTarget): boolean { return a.host === b.host && slug(a) === slug(b) && a.number === b.number; }
function real(path: string): string { try { return realpathSync(path); } catch { return resolve(path); } }
function short(value: string): string { return createHash('sha1').update(value).digest('hex').slice(0, 16); }
async function git(cwd: string, args: string[], timeout = 30_000): Promise<string> {
  const result = await runGit(cwd, args, timeout);
  if (result.code !== 0) throw new Error(result.stderr.trim().split('\n')[0] || `git ${args[0]} 失败`);
  return result.stdout;
}

/**
 * 「让 Agent 回应审阅意见」的编排：读取意见 → 在独立工作树里启动对话 → 用户审阅提交与回复草稿 →
 * 经确认后推送并回复。推送和回复是对外写入，只在 publish 中发生，且必须带着用户看过的提交。
 */
export class PrReviewResponseService {
  private runs: PrReviewResponseRun[] = [];
  private loaded = false;
  private starts = new Map<string, { fingerprint: string; promise: Promise<PrReviewResponseRun> }>();
  private publishing = new Map<string, { requestId: string; fingerprint: string; promise: Promise<PrReviewResponsePublishResult> }>();
  private readonly now: () => number;
  constructor(private readonly deps: PrReviewResponseDeps) { this.now = deps.now ?? Date.now; }

  private get file(): string { return join(this.deps.home, 'pr-review-responses.json'); }
  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8'));
      if (Array.isArray(data?.runs)) this.runs = data.runs.filter((r: PrReviewResponseRun) => r && typeof r.id === 'string' && typeof r.worktree === 'string').map((r: PrReviewResponseRun) => ({ ...r, repliedThreadIds: r.repliedThreadIds ?? [] })).slice(-maxRuns);
    } catch { /* A missing or damaged record only hides history; the worktrees and branches stay on disk. */ }
  }
  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify({ version: 1, runs: this.runs.slice(-maxRuns) }, null, 2), { mode: 0o600 });
    renameSync(temp, this.file);
  }
  private run(id: unknown): PrReviewResponseRun {
    this.load();
    const run = typeof id === 'string' ? this.runs.find(r => r.id === id) : undefined;
    if (!run) throw new Error('找不到这次回应记录');
    return run;
  }

  /** 已登记工作区里 origin 指向该仓库的本机检出，按仓库根目录去重。 */
  async findCheckouts(target: PrTarget): Promise<PrLocalCheckout[]> {
    const wanted = slug(target); const found = new Map<string, PrLocalCheckout>();
    for (const workspace of this.deps.workspaces()) {
      try {
        const root = (await git(workspace, ['rev-parse', '--show-toplevel'])).trim();
        const common = resolve(root, (await git(root, ['rev-parse', '--git-common-dir'])).trim());
        if (found.has(common)) continue;
        const urls = (await git(root, ['config', '--get-regexp', '^remote\\..*\\.url$'])).split('\n').filter(Boolean);
        const remotes = urls.flatMap(line => {
          const match = /^remote\.(.+)\.url\s+(.+)$/.exec(line);
          return match && parseGithubSlug(match[2]!)?.toLowerCase() === wanted ? [match[1]!] : [];
        });
        const remote = remotes.includes('origin') ? 'origin' : remotes[0];
        if (remote) found.set(common, { path: root, remote });
      } catch { /* Not a repository, or a path that no longer exists. */ }
    }
    return [...found.values()];
  }

  async prepare(raw: PrTarget, identityKey: string, signal?: AbortSignal): Promise<PrReviewResponsePlan> {
    const target = validateTarget(raw);
    const feedback = await this.deps.inbox.reviewFeedback(target, identityKey, signal);
    // Threads on code that has since moved are listed last: the agent can still read them, but they are the likeliest to be stale.
    const threads = [...feedback.threads].sort((a, b) => Number(a.outdated) - Number(b.outdated));
    return { target, headSha: feedback.headSha, headRefName: feedback.headRefName,
      pushBlocker: pushBlocker({ state: feedback.state, isCrossRepository: feedback.isCrossRepository, headRefName: feedback.headRefName }),
      threads, reviews: feedback.reviews, threadsIncomplete: feedback.threadsIncomplete, checkouts: await this.findCheckouts(target) };
  }

  runsFor(raw: PrTarget): PrReviewResponseRun[] {
    this.load(); const target = validateTarget(raw);
    return this.runs.filter(r => sameTarget(r.target, target) && r.status !== 'discarded').map(r => structuredClone(r)).reverse();
  }

  start(raw: PrReviewResponseStartInput, identityKey: string, requestId: string): Promise<PrReviewResponseRun> {
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(requestId)) return Promise.reject(new Error('无效启动请求'));
    const fingerprint = JSON.stringify([raw, identityKey]);
    const prior = this.starts.get(requestId);
    if (prior) return prior.fingerprint === fingerprint ? prior.promise : Promise.reject(new Error('启动请求编号重复且内容不同'));
    const promise = this.begin(raw, identityKey);
    this.starts.set(requestId, { fingerprint, promise });
    // A failed start is safe to retry with a new request; keep only successful receipts so a double click cannot start two agents.
    void promise.catch(() => this.starts.delete(requestId));
    return promise;
  }

  private async begin(raw: PrReviewResponseStartInput, identityKey: string): Promise<PrReviewResponseRun> {
    if (!raw || typeof raw !== 'object') throw new Error('无效启动参数');
    const target = validateTarget(raw.target);
    if (!/^[a-f0-9]{40,64}$/i.test(raw.headSha) || typeof raw.workspace !== 'string' || typeof raw.note !== 'string' || raw.note.length > maxNote ||
      !Array.isArray(raw.threadIds) || !raw.threadIds.length || raw.threadIds.length > maxResponseThreads ||
      raw.threadIds.some(id => typeof id !== 'string') || new Set(raw.threadIds).size !== raw.threadIds.length) throw new Error(`请选择 1–${maxResponseThreads} 条意见`);
    const plan = await this.prepare(target, identityKey);
    if (plan.headSha !== raw.headSha) throw new Error('PR 已有新提交，请重新打开后再开始');
    // The path comes from the renderer: accept only a checkout we discovered for this repository.
    const checkout = plan.checkouts.find(c => real(c.path) === real(raw.workspace));
    if (!checkout) throw new Error('所选目录不是这个仓库的本机检出');
    const threads = raw.threadIds.map(id => plan.threads.find(t => t.id === id));
    if (threads.some(t => !t)) throw new Error('部分意见已解决或已不存在，请重新打开');
    await assertValidRefName(checkout.path, plan.headRefName);
    await git(checkout.path, ['fetch', '--quiet', checkout.remote, plan.headRefName], 120_000);
    const fetched = (await git(checkout.path, ['rev-parse', 'FETCH_HEAD^{commit}'])).trim();
    if (fetched !== plan.headSha) throw new Error('PR 分支已有新提交，请重新打开后再开始');

    let branch = `vela/pr-${target.number}-review`;
    for (let n = 2; (await runGit(checkout.path, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0; n++) branch = `vela/pr-${target.number}-review-${n}`;
    const worktrees = join(this.deps.home, 'worktrees');
    const path = join(worktrees, `pr-${target.owner}-${target.repo}-${target.number}-${plan.headSha.slice(0, 8)}-${branch.split('-').pop()}`.replace(/[^\w.-]/g, '-'));
    const created = await createWorktree(checkout.path, { branch, newBranch: true, startPoint: plan.headSha, path }, worktrees);
    if (!created.ok || created.path !== path) throw new Error(created.message || 'worktree 创建失败');

    const title = `PR #${target.number} · ${threads.length} 条审阅意见`;
    const prompt = buildResponsePrompt({ target, title: await this.title(target, identityKey), headRefName: plan.headRefName, headSha: plan.headSha, branch,
      threads: threads as NonNullable<typeof threads[number]>[], reviews: plan.reviews, note: raw.note });
    let conversationId: string;
    try { conversationId = await this.deps.startConversation(path, title, prompt); }
    catch (error) {
      // Nothing has run yet: do not leave an empty worktree and branch behind.
      await removeWorktree(checkout.path, { path, force: true }, null).catch(() => undefined);
      await runGit(checkout.path, ['branch', '-D', branch]).catch(() => undefined);
      throw error;
    }
    const run: PrReviewResponseRun = { id: randomUUID(), target, title, headSha: plan.headSha, headRefName: plan.headRefName, remote: checkout.remote,
      source: checkout.path, worktree: path, branch, conversationId, threadIds: raw.threadIds, repliedThreadIds: [], pushBlocker: plan.pushBlocker, status: 'working',
      createdAt: this.now(), publishedAt: null };
    this.load(); this.runs.push(run); this.save();
    return structuredClone(run);
  }
  private async title(target: PrTarget, identityKey: string): Promise<string> {
    try { return (await this.deps.inbox.detail(target, identityKey)).item.title; } catch { return `#${target.number}`; }
  }

  /** 读取工作树里的实际结果，供用户确认。只读。 */
  async review(runId: string, identityKey: string, signal?: AbortSignal): Promise<PrReviewResponseReview> {
    const run = this.run(runId);
    if (!existsSync(run.worktree)) throw new Error('工作树已不存在，无法继续');
    const tipSha = (await git(run.worktree, ['rev-parse', 'HEAD'])).trim();
    const dirtyFiles = (await git(run.worktree, ['status', '--porcelain'])).split('\n').filter(Boolean).map(line => line.slice(3)).slice(0, 50);
    const commits = parseResponseCommits(await git(run.worktree, ['log', `--format=${responseLogFormat}`, `${run.headSha}..HEAD`]));
    const diffStat = (await git(run.worktree, ['diff', '--stat', '--no-color', `${run.headSha}..HEAD`])).trim();
    const feedback = await this.deps.inbox.reviewFeedback(run.target, identityKey, signal);
    const open = new Set(feedback.threads.map(t => t.id));
    return { run: structuredClone(run), tipSha, currentHeadSha: feedback.headSha, headMoved: feedback.headSha !== run.headSha,
      dirtyFiles, commits, diffStat, drafts: buildDrafts(feedback.threads, run.threadIds.filter(id => open.has(id) && !run.repliedThreadIds.includes(id)), commits),
      closedThreadIds: run.threadIds.filter(id => !open.has(id)) };
  }

  publish(raw: PrReviewResponsePublishInput): Promise<PrReviewResponsePublishResult> {
    if (!raw || typeof raw !== 'object' || typeof raw.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(raw.requestId)) return Promise.reject(new Error('无效发布请求'));
    const fingerprint = JSON.stringify(raw);
    const active = this.publishing.get(raw.runId);
    if (active) return active.requestId === raw.requestId && active.fingerprint === fingerprint ? active.promise : Promise.reject(new Error('这次回应正在发布，请等待完成'));
    // Release the slot before the caller sees the result, so an immediate follow-up call gets the real answer.
    const promise: Promise<PrReviewResponsePublishResult> = this.send(raw).finally(() => { if (this.publishing.get(raw.runId)?.promise === promise) this.publishing.delete(raw.runId); });
    this.publishing.set(raw.runId, { requestId: raw.requestId, fingerprint, promise });
    return promise;
  }

  private async send(input: PrReviewResponsePublishInput): Promise<PrReviewResponsePublishResult> {
    const run = this.run(input.runId);
    if (run.status !== 'working') throw new Error('这次回应已结束');
    if (run.pushBlocker) throw new Error('这个 PR 不能由 Vela 推送，请在工作树里手动处理');
    if (!Array.isArray(input.replies) || input.replies.length > maxResponseThreads || typeof input.tipSha !== 'string') throw new Error('无效发布内容');
    const ids = new Set<string>();
    for (const reply of input.replies) {
      if (reply && run.repliedThreadIds.includes(reply.threadId)) throw new Error('这条意见已经回复过，请取消勾选后重试');
      if (!reply || !run.threadIds.includes(reply.threadId) || ids.has(reply.threadId) || typeof reply.body !== 'string' || !reply.body.trim() || reply.body.length > 65_536 || typeof reply.resolve !== 'boolean') throw new Error('回复内容或线程无效');
      ids.add(reply.threadId);
    }
    if (!existsSync(run.worktree)) throw new Error('工作树已不存在，无法继续');
    // What is pushed must be exactly what the user reviewed.
    const tip = (await git(run.worktree, ['rev-parse', 'HEAD'])).trim();
    if (tip !== input.tipSha) throw new Error('工作树又有了新提交，请重新审阅后再发布');
    if ((await git(run.worktree, ['status', '--porcelain'])).trim()) throw new Error('工作树还有未提交的改动，请先让 Agent 提交或手动处理');
    if (tip === run.headSha) throw new Error('Agent 还没有产生新的提交');
    // Read the PR again right before writing: it must still be open and the branch must not have moved on.
    const live = await this.deps.inbox.reviewFeedback(run.target, input.identityKey);
    const blocker = pushBlocker({ state: live.state, isCrossRepository: live.isCrossRepository, headRefName: live.headRefName });
    if (blocker) throw new Error('PR 已不是可推送的状态，请刷新后查看');
    if (live.headRefName !== run.headRefName) throw new Error('PR 分支已变化，请刷新后重新开始');

    await assertValidRefName(run.worktree, run.headRefName);
    let pushResult: PrReviewResponsePublishResult['push'];
    try {
      // Plain push, never forced: a branch that moved on is rejected and reported rather than overwritten.
      const pushed = await runGit(run.worktree, ['push', '--porcelain', run.remote, `HEAD:refs/heads/${run.headRefName}`], 120_000);
      pushResult = pushed.code === 0 ? { state: 'pushed', message: `已推送到 ${run.remote}/${run.headRefName}` }
        : { state: 'failed', message: (pushed.stderr || pushed.stdout).trim().split('\n').filter(Boolean).slice(-3).join('\n') || '推送失败' };
    } catch (error) { pushResult = { state: 'failed', message: `推送结果未确认：${error instanceof Error ? error.message : String(error)}` }; }
    if (pushResult.state === 'failed') {
      return { push: pushResult, replies: input.replies.map(r => ({ threadId: r.threadId, state: 'skipped' as const, message: '推送未完成，未发送回复', url: null })), run: structuredClone(run) };
    }
    const replies: PrReviewResponsePublishResult['replies'] = [];
    for (const reply of input.replies) {
      try {
        const done = await this.deps.inbox.replyToThread(run.target, reply.threadId, reply.body, reply.resolve, input.identityKey, `${input.requestId}-${short(reply.threadId)}`);
        replies.push({ threadId: reply.threadId, state: done.state === 'closed' ? 'skipped' : done.state, message: done.state === 'closed' ? '线程已被解决，未回复' : '', url: done.url });
        if (done.state !== 'closed') { run.repliedThreadIds.push(reply.threadId); this.save(); }
      } catch (error) { replies.push({ threadId: reply.threadId, state: 'failed', message: error instanceof Error ? error.message : String(error), url: null }); }
    }
    if (replies.every(r => r.state !== 'failed')) { run.status = 'published'; run.publishedAt = this.now(); this.save(); }
    return { push: pushResult, replies, run: structuredClone(run) };
  }

  /** 放弃这次回应。移除工作树目录，但保留本地分支，里面的提交不会丢。 */
  async discard(runId: string, removeTree: boolean): Promise<PrReviewResponseRun> {
    const run = this.run(runId);
    if (this.publishing.has(run.id)) throw new Error('这次回应正在发布，请等待完成');
    if (typeof removeTree !== 'boolean') throw new Error('无效参数');
    if (removeTree && existsSync(run.worktree)) {
      const removed = await removeWorktree(run.source, { path: run.worktree, force: false }, null);
      if (!removed.ok) throw new Error(removed.message);
    }
    if (run.status === 'working') run.status = 'discarded';
    this.save();
    return structuredClone(run);
  }
}
