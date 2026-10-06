import type {
  PrInboxIdentity, PrInboxList, PrInboxQuery, PrInboxItem, PrRelation, PrRelationPage,
  PrTarget, PrInboxDetail, PrActivityKind, PrActivityPage, PrInboxFiles, PrInboxError,
  PrReviewComment,
} from '@vela/shared';
import { runGh, classifyGhFailure, ghFailureMessage, type GhResult, type GhRunOptions } from './gh-run';
import { toReviewComment, toReviewSummary, toReviewThread, mapCheckState } from './pull-request-service';
import { record, targetKey, validateTarget, searchItem, enrichItem, checkSummary, fileItem, safeGithubUrl, patchIncomplete, pairRemoteDiff } from './pr-inbox-mapping';

const relations: PrRelation[] = ['authored', 'reviewRequested', 'assigned', 'mentioned'];
const qualifiers: Record<PrRelation, string> = { authored: 'author', reviewRequested: 'review-requested', assigned: 'assignee', mentioned: 'mentions' };
const states: Record<PrInboxQuery['state'], string> = {
  openAndDraft: 'is:open', open: 'is:open draft:false', draft: 'is:open draft:true',
  merged: 'is:merged', closed: 'is:closed is:unmerged', all: '',
};
const fields = 'number,title,url,state,isDraft,author,body,createdAt,updatedAt,baseRefName,baseRefOid,headRefName,headRefOid,headRepository,headRepositoryOwner,isCrossRepository,additions,deletions,changedFiles,mergeable,mergeStateStatus,reviewDecision,reviewRequests,statusCheckRollup';
type Runner = (cwd: string | null, args: string[], timeout: number, stdin?: string, options?: GhRunOptions) => Promise<GhResult>;
interface QueryCache { result: PrInboxList; members: Map<PrRelation, Map<string, PrInboxItem>> }
class InboxFailure extends Error {
  constructor(readonly info: PrInboxError) { super(info.message); }
}
function initialPage(relation: PrRelation): PrRelationPage {
  return { relation, nextPage: 1, loadedCount: 0, reportedTotal: null, complete: false, incompleteResults: false, error: null };
}
export function validateInboxQuery(raw: unknown): PrInboxQuery {
  const q = record(raw);
  if (!Object.hasOwn(states, q.state) || !(q.repository === null || typeof q.repository === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9-]{0,99}\/[a-zA-Z0-9_.-]{1,100}$/.test(q.repository))) throw new Error('无效的 PR 筛选');
  return { state: q.state, repository: q.repository };
}
function checkAbort(signal?: AbortSignal): void { if (signal?.aborted) throw new Error('请求已取消'); }

export class PullRequestInboxService {
  private identity: PrInboxIdentity | null = null;
  private identityAt = 0;
  private epoch = 0;
  private identityPending: Promise<PrInboxIdentity> | null = null;
  private queries = new Map<string, QueryCache>();
  private reads = new Map<string, { at: number; value: unknown }>();
  private pending = new Map<string, { promise: Promise<any>; controller: AbortController; users: number }>();
  private backoffUntil = 0;
  private failures = 0;
  private revision = 0;
  private queryVersions = new Map<string, number>();
  private commentWrites = new Map<string, { fingerprint: string; at: number; settled: boolean; promise: Promise<PrReviewComment> }>();
  constructor(private readonly runner: Runner = runGh, private readonly now = Date.now) {}

  private async execute(args: string[], signal?: AbortSignal, stdin?: string): Promise<GhResult> {
    checkAbort(signal);
    if (this.now() < this.backoffUntil) throw new InboxFailure({ kind: 'rate-limited', message: 'GitHub 暂时不可用，已暂停自动读取', retryAt: this.backoffUntil });
    const result = await this.runner(null, args, 30_000, stdin, { signal, env: { GH_HOST: 'github.com' }, maxOutputBytes: 8 * 1024 * 1024 });
    if (result.cancelled) throw new Error('请求已取消');
    return result;
  }
  private failure(result: GhResult): InboxFailure {
    const text = `${result.stderr}\n${result.stdout}`;
    const rate = /rate limit|secondary rate|abuse detection|429/i.test(text);
    const offline = classifyGhFailure(result) === 'offline';
    let retryAt: number | null = null;
    if (rate || offline) {
      this.failures++;
      const retry = text.match(/retry-after\s*[:=]\s*(\d+)/i);
      const reset = text.match(/x-ratelimit-reset\s*[:=]\s*(\d+)/i);
      retryAt = retry ? this.now() + Number(retry[1]) * 1000 : reset ? Number(reset[1]) * 1000 :
        this.now() + Math.min(15 * 60_000, 30_000 * 2 ** Math.min(this.failures - 1, 5)) * (1 + Math.random() * .2);
      this.backoffUntil = retryAt;
    }
    return new InboxFailure({ kind: rate ? 'rate-limited' : /404|not found|could not resolve to/i.test(text) ? 'unavailable' : classifyGhFailure(result),
      message: rate ? 'GitHub 请求受限，请稍后重试' : ghFailureMessage(classifyGhFailure(result), result), retryAt });
  }
  private json(result: GhResult, allowChecks = false): any {
    if (result.outputTruncated) throw new InboxFailure({ kind: 'failed', message: 'GitHub 响应超过读取上限，请缩小读取范围', retryAt: null });
    const readFailure = /gh auth login|not logged in|bad credentials|HTTP [45]\d\d|authentication failed|forbidden|permission denied|rate limit|could not resolve host|connection (refused|reset)/i.test(result.stderr);
    if (result.timedOut || result.cancelled || result.spawnError ||
      (!result.ok && !(allowChecks && !readFailure && (result.exitCode === 1 || result.exitCode === 8)))) throw this.failure(result);
    try { return JSON.parse(result.stdout); }
    catch { throw new InboxFailure({ kind: 'failed', message: 'GitHub CLI 返回了无效数据', retryAt: null }); }
  }
  private assertIdentity(key: string, epoch: number, signal?: AbortSignal): void {
    checkAbort(signal);
    if (this.identity?.key !== key || this.epoch !== epoch) throw new Error('GitHub 身份已变化，请刷新');
  }
  private async probe(force = false): Promise<PrInboxIdentity> {
    if (!force && this.identity && this.now() - this.identityAt < 30_000) return this.identity;
    if (this.identityPending) return this.identityPending;
    const pending = (async () => {
      const version = await this.execute(['--version']);
      if (!version.ok) throw this.failure(version);
      // auth JSON may exit zero despite a failed stored account. The actual user request is authoritative,
      // including GH_TOKEN overrides. Never persist or log auth output.
      const auth = await this.execute(['auth', 'status', '--hostname', 'github.com', '--active', '--json', 'hosts']);
      let authFailed = !auth.ok;
      try {
        const hosts = record(this.json(auth)).hosts;
        const accounts = record(hosts)['github.com'];
        authFailed ||= !Array.isArray(accounts) || !accounts.some(a => a.state === 'success');
      } catch { authFailed = true; }
      const user = record(this.json(await this.execute(['api', '--hostname', 'github.com', '--method', 'GET', 'user'])));
      if (typeof user.login !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,99}$/.test(user.login))
        throw new InboxFailure({ kind: authFailed ? 'unauthenticated' : 'failed', message: '无法确认 GitHub 当前身份，请运行 gh auth login', retryAt: null });
      const identity = { host: 'github.com', login: user.login, key: `github.com/${user.login}`.toLowerCase() };
      if (identity.key !== this.identity?.key) {
        this.epoch++; this.queries.clear(); this.queryVersions.clear(); this.reads.clear();
        for (const p of this.pending.values()) p.controller.abort();
      }
      this.identity = identity; this.identityAt = this.now();
      return identity;
    })();
    this.identityPending = pending;
    try { return await pending; }
    catch (error) {
      if (error instanceof InboxFailure && (error.info.kind === 'unauthenticated' || error.info.kind === 'no-gh')) {
        this.epoch++; this.identity = null; this.queries.clear(); this.queryVersions.clear(); this.reads.clear();
        for (const p of this.pending.values()) p.controller.abort();
      }
      throw error;
    } finally { if (this.identityPending === pending) this.identityPending = null; }
  }

  // Coalesce identical reads. A caller can detach without cancelling another window's read.
  private async shared<T>(key: string, signal: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    checkAbort(signal);
    let job = this.pending.get(key);
    if (!job || job.controller.signal.aborted) {
      const controller = new AbortController();
      const promise = Promise.resolve().then(() => work(controller.signal));
      job = { promise, controller, users: 0 }; this.pending.set(key, job);
      void promise.finally(() => { if (this.pending.get(key)?.promise === promise) this.pending.delete(key); }).catch(() => {});
    }
    const current = job; current.users++;
    return new Promise<T>((resolve, reject) => {
      let finished = false;
      const finish = (fn: () => void) => {
        if (finished) return; finished = true; signal?.removeEventListener('abort', abort);
        current.users--; if (!current.users) current.controller.abort(); fn();
      };
      const abort = () => finish(() => reject(new Error('请求已取消')));
      signal?.addEventListener('abort', abort, { once: true });
      current.promise.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
      if (signal?.aborted) abort();
    });
  }
  private async cached<T>(key: string, ttl: number, force: boolean, signal: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const previous = this.reads.get(key);
    if (!force && previous && this.now() - previous.at < ttl) return previous.value as T;
    return this.shared(key, signal, async s => {
      const value = await work(s); checkAbort(s);
      this.reads.set(key, { at: this.now(), value });
      // Bound memory for large diffs and many historical PRs.
      while (this.reads.size > 60) this.reads.delete(this.reads.keys().next().value!);
      return value;
    });
  }

  async list(raw: PrInboxQuery, options: { force?: boolean; more?: boolean; revision?: number } = {}, signal?: AbortSignal): Promise<PrInboxList> {
    const query = validateInboxQuery(raw);
    const qkey = JSON.stringify(query);
    const old = this.queries.get(qkey)?.result;
    let identity: PrInboxIdentity;
    try { identity = await this.probe(options.force || !!old && this.now() - (old.syncedAt ?? 0) >= 60_000); }
    catch (error) {
      checkAbort(signal);
      const info = error instanceof InboxFailure ? error.info : { kind: 'failed' as const, message: String(error), retryAt: null };
      const cached = this.queries.get(qkey)?.result;
      return { identity: this.identity, items: cached?.items ?? [], pages: cached?.pages ?? relations.map(initialPage),
        complete: false, stale: !!cached, syncedAt: cached?.syncedAt ?? null, error: info, revision: cached?.revision ?? 0 };
    }
    checkAbort(signal);
    const previous = this.queries.get(qkey);
    if (options.more && (!previous || previous.result.revision !== options.revision)) throw new Error('分页已过期，请刷新');
    if (!options.force && !options.more && previous && !previous.result.stale && this.now() - (previous.result.syncedAt ?? 0) < 60_000) return previous.result;
    const epoch = this.epoch;
    return this.shared(`${identity.key}:list:${qkey}:${options.more ? options.revision : 'refresh'}`, signal, async s => {
      const queryVersion = (this.queryVersions.get(qkey) ?? 0) + 1;
      this.queryVersions.set(qkey, queryVersion);
      const members = new Map<PrRelation, Map<string, PrInboxItem>>(previous?.members);
      const errors: PrInboxError[] = [];
      let successes = 0;
      const pages = await Promise.all(relations.map(async relation => {
        const prior = previous?.result.pages.find(p => p.relation === relation) ?? initialPage(relation);
        if (options.more && prior.nextPage === null) return prior;
        const page = options.more ? prior.nextPage ?? 1 : 1;
        try {
          const q = ['is:pr', states[query.state], `${qualifiers[relation]}:${identity.login}`, query.repository ? `repo:${query.repository}` : ''].filter(Boolean).join(' ');
          const payload = record(this.json(await this.execute(['api', '--hostname', 'github.com', '--method', 'GET', 'search/issues',
            '-f', `q=${q}`, '-f', 'sort=updated', '-f', 'order=desc', '-F', 'per_page=100', '-F', `page=${page}`], s)));
          if (!Array.isArray(payload.items) || typeof payload.total_count !== 'number') throw new Error('搜索响应缺少分页数据');
          const rows: PrInboxItem[] = payload.items.map((v: unknown) => searchItem(v, relation));
          if (query.state === 'merged') for (const row of rows) row.state = 'merged';
          const next = options.more ? new Map(members.get(relation)) : new Map<string, PrInboxItem>();
          for (const row of rows) next.set(row.key, row);
          members.set(relation, next); successes++;
          const reportedTotal = Math.max(payload.total_count, options.more ? prior.reportedTotal ?? 0 : 0);
          const atEnd = payload.items.length < 100 || page * 100 >= payload.total_count;
          const limited = reportedTotal > 1000 || payload.incomplete_results === true || !!options.more && prior.incompleteResults || atEnd && next.size < reportedTotal;
          return { relation, nextPage: !atEnd && page < 10 ? page + 1 : null, loadedCount: next.size,
            reportedTotal, complete: atEnd && !limited, incompleteResults: limited, error: null };
        } catch (error) {
          checkAbort(s);
          const info = error instanceof InboxFailure ? error.info : { kind: 'failed' as const, message: String(error), retryAt: null };
          errors.push(info); return { ...prior, complete: false, error: info.message };
        }
      }));
      this.assertIdentity(identity.key, epoch, s);
      if (this.queryVersions.get(qkey) !== queryVersion) throw new Error("列表请求已过期，请刷新");
      const union = new Map<string, PrInboxItem>();
      for (const relation of relations) for (const [key, row] of members.get(relation) ?? []) {
        const existing = union.get(key);
        if (existing) existing.relations.push(relation);
        else union.set(key, { ...row, relations: [relation] });
      }
      const items = [...union.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.key.localeCompare(b.key));
      const result: PrInboxList = { identity, items, pages, complete: pages.every(p => p.complete),
        stale: errors.length > 0, syncedAt: successes ? this.now() : previous?.result.syncedAt ?? null,
        error: errors[0] ?? null, revision: ++this.revision };
      this.queries.set(qkey, { result, members });
      while (this.queries.size > 12) this.queries.delete(this.queries.keys().next().value!);
      if (!errors.length) this.failures = 0;
      return result;
    });
  }

  private async context(identityKey: string, signal?: AbortSignal): Promise<{ identity: PrInboxIdentity; epoch: number }> {
    const identity = await this.probe(); checkAbort(signal);
    if (identity.key !== identityKey) throw new Error('GitHub 身份已变化，请刷新列表');
    return { identity, epoch: this.epoch };
  }
  private async view(target: PrTarget, signal?: AbortSignal): Promise<Record<string, any>> {
    const pr = record(this.json(await this.execute(['pr', 'view', String(target.number), '--repo', `${target.host}/${target.owner}/${target.repo}`, '--json', fields], signal)));
    if (pr.number !== target.number || !safeGithubUrl(pr.url, target) || !/^[a-f0-9]{40,64}$/i.test(pr.headRefOid ?? '') || !/^[a-f0-9]{40,64}$/i.test(pr.baseRefOid ?? '')) throw new Error('PR 详情目标或版本无效');
    return pr;
  }
  private baseItem(target: PrTarget, pr: Record<string, any>): PrInboxItem {
    let base: PrInboxItem | undefined;
    for (const cache of this.queries.values()) { base = cache.result.items.find(i => i.key === targetKey(target)); if (base) break; }
    if (base) return base;
    const item = searchItem({ number: target.number, html_url: pr.url, title: pr.title, state: pr.state, draft: pr.isDraft,
      user: { login: pr.author?.login, avatar_url: pr.author?.avatarUrl }, updated_at: pr.updatedAt, pull_request: { merged_at: pr.state === 'MERGED' ? pr.updatedAt : null } }, 'authored');
    return { ...item, relations: [], attentionReasons: [] };
  }

  async enrich(raw: PrTarget[], identityKey: string, force = false, signal?: AbortSignal): Promise<PrInboxItem[]> {
    if (!Array.isArray(raw) || raw.length > 40) throw new Error('每次最多补全 40 条 PR');
    const targets = raw.map(validateTarget);
    const { identity, epoch } = await this.context(identityKey, signal);
    const batches = Array.from({ length: Math.ceil(targets.length / 20) }, (_, i) => targets.slice(i * 20, i * 20 + 20));
    const result = await Promise.all(batches.map(batch => this.cached(`${identity.key}:enrich:${batch.map(targetKey).join(',')}`, 30_000, force, signal, async s => {
      const variables: Record<string, unknown> = {};
      const defs: string[] = []; const repos = new Map<string, { target: PrTarget; rows: { target: PrTarget; index: number }[] }>();
      batch.forEach((target, index) => {
        const key = `${target.owner}/${target.repo}`.toLowerCase();
        if (!repos.has(key)) repos.set(key, { target, rows: [] });
        repos.get(key)!.rows.push({ target, index });
        defs.push(`$n${index}:Int!`); variables[`n${index}`] = target.number;
      });
      const fields: string[] = []; let ri = 0;
      for (const repo of repos.values()) {
        const index = ri++; defs.push(`$o${index}:String!`, `$r${index}:String!`);
        variables[`o${index}`] = repo.target.owner; variables[`r${index}`] = repo.target.repo;
        fields.push(`r${index}:repository(owner:$o${index},name:$r${index}) { ${repo.rows.map(row => `p${row.index}:pullRequest(number:$n${row.index}) {
          number title url state isDraft updatedAt headRefOid baseRefOid reviewDecision mergeable mergeStateStatus
          commits(last:1) { nodes { commit { statusCheckRollup { contexts(first:100) { pageInfo { hasNextPage } nodes {
            ... on CheckRun { status conclusion } ... on StatusContext { state }
          } } } } } }
        }`).join(' ')} }`);
      }
      try {
        const response = record(this.json(await this.execute(['api', '--hostname', 'github.com', 'graphql', '--input', '-'], s,
          JSON.stringify({ query: `query(${defs.join(',')}) { ${fields.join(' ')} }`, variables }))));
        this.assertIdentity(identity.key, epoch, s);
        const enriched = new Map<string, PrInboxItem>();
        ri = 0;
        for (const repo of repos.values()) {
          const node = response.data?.[`r${ri++}`];
          for (const row of repo.rows) {
            const pr = node?.[`p${row.index}`];
            const base = this.baseItem(row.target, pr ?? { url: `https://github.com/${row.target.owner}/${row.target.repo}/pull/${row.target.number}` });
            const valid = pr?.number === row.target.number && safeGithubUrl(pr.url, row.target) && /^[a-f0-9]{40,64}$/i.test(pr.headRefOid ?? '');
            enriched.set(targetKey(row.target), valid ? enrichItem(base, pr) : { ...base, enrichment: 'error', checks: 'unknown' });
          }
        }
        return batch.map(t => enriched.get(targetKey(t))!);
      } catch (error) {
        this.assertIdentity(identity.key, epoch, s);
        return batch.map(t => ({ ...this.baseItem(t, { url: `https://github.com/${t.owner}/${t.repo}/pull/${t.number}` }), enrichment: 'error' as const, checks: 'unknown' as const }));
      }
    })));
    this.assertIdentity(identity.key, epoch, signal);
    return result.flat();
  }

  async detail(raw: PrTarget, identityKey: string, force = false, signal?: AbortSignal): Promise<PrInboxDetail> {
    const target = validateTarget(raw); const { identity, epoch } = await this.context(identityKey, signal);
    return this.cached(`${identity.key}:detail:${targetKey(target)}`, 30_000, force, signal, async s => {
      const pr = await this.view(target, s);
      let checks: PrInboxDetail['checks'] = []; let checksError: string | null = null;
      try {
        const checksResult = await this.execute(['pr', 'checks', String(target.number), '--repo', `${target.host}/${target.owner}/${target.repo}`,
          '--json', 'name,state,bucket,link,description,workflow,startedAt,completedAt'], s);
        const data = !checksResult.ok && !checksResult.timedOut && !checksResult.cancelled && !checksResult.spawnError && !checksResult.outputTruncated && /no checks reported/i.test(checksResult.stderr) && Array.isArray(pr.statusCheckRollup) && pr.statusCheckRollup.length === 0 ? [] : this.json(checksResult, true);
        if (!Array.isArray(data) || data.some(c => !c || typeof c.name !== 'string' || typeof c.state !== 'string')) throw new Error('检查数据无效');
        checks = data.map(c => ({ name: c.name, state: mapCheckState(c.bucket ?? null, c.state ?? null), link: safeGithubUrl(c.link, target), description: c.description ?? null, workflow: c.workflow ?? null }));
      } catch (error) { checkAbort(s); checksError = String(error); }
      // Checks belong to a head; reject a moving head instead of combining versions.
      const version = await this.view(target, s);
      if (version.headRefOid !== pr.headRefOid || version.baseRefOid !== pr.baseRefOid) throw new Error('PR 版本已变化，请刷新详情');
      this.assertIdentity(identity.key, epoch, s);
      const item = enrichItem(this.baseItem(target, pr), pr);
      item.checks = checksError ? 'unknown' : checkSummary(checks);
      item.attentionReasons = item.attentionReasons.filter(reason => reason !== 'checksFailed');
      if (item.checks === 'failing' && (item.state === 'open' || item.state === 'draft')) item.attentionReasons.push('checksFailed');
      return { target, identity, item, body: pr.body ?? '', createdAt: pr.createdAt ?? '',
        baseRefName: pr.baseRefName ?? '', headRefName: pr.headRefName ?? '', headRepository: pr.headRepositoryOwner?.login && pr.headRepository?.name ? `${pr.headRepositoryOwner.login}/${pr.headRepository.name}` : null,
        additions: pr.additions ?? 0, deletions: pr.deletions ?? 0, changedFiles: pr.changedFiles ?? 0,
        checks, checksError, syncedAt: this.now() };
    });
  }

  async activity(raw: PrTarget, kind: PrActivityKind, cursor: string | null, headSha: string, threadId: string | null, identityKey: string, signal?: AbortSignal, force = false): Promise<PrActivityPage> {
    const target = validateTarget(raw); const { identity, epoch } = await this.context(identityKey, signal);
    if (!['comments', 'reviews', 'threads', 'threadComments', 'commits'].includes(kind) || cursor !== null && (typeof cursor !== 'string' || cursor.length > 1024) || typeof headSha !== 'string' || !/^[a-f0-9]{40,64}$/i.test(headSha) || kind === 'threadComments' && (typeof threadId !== 'string' || !threadId || threadId.length > 256)) throw new Error('无效活动分页');
    return this.cached(`${identity.key}:activity:${targetKey(target)}:${headSha}:${kind}:${threadId}:${cursor}`, 30_000, force, signal, async s => {
      const commentFields = 'id author { login } body createdAt url';
      const reviewCommentFields = `${commentFields} path line diffHunk outdated originalCommit { oid } commit { oid } replyTo { id } pullRequestReview { state }`;
      const pageInfo = 'pageInfo { hasNextPage endCursor }';
      const connection = kind === 'comments' ? `comments(last:30,before:$cursor) { ${pageInfo} nodes { ${commentFields} } }` :
        kind === 'reviews' ? `reviews(last:30,before:$cursor) { ${pageInfo} nodes { author { login } state body submittedAt url commit { oid } } }` :
        kind === 'commits' ? `commits(last:30,before:$cursor) { ${pageInfo} nodes { commit { oid messageHeadline committedDate author { name user { login } } } } }` :
        `reviewThreads(first:30,after:$cursor) { ${pageInfo} nodes { id path line isResolved isOutdated viewerCanResolve viewerCanUnresolve resolvedBy { login }
          comments(first:30) { ${pageInfo} nodes { ${reviewCommentFields} } } } }`;
      // Recent comments/reviews paginate backwards; use hasPreviousPage/startCursor there.
      const backwards = kind === 'comments' || kind === 'reviews' || kind === 'commits';
      const recentConnection = backwards ? connection.replace(pageInfo, 'pageInfo { hasPreviousPage startCursor }') : connection;
      const query = kind === 'threadComments' ? `query($id:ID!,$cursor:String) { node(id:$id) { ... on PullRequestReviewThread { pullRequest { number headRefOid repository { name owner { login } } } comments(first:30,after:$cursor) { ${pageInfo} nodes { ${reviewCommentFields} } } } } }` :
        `query($owner:String!,$repo:String!,$number:Int!,$cursor:String) { repository(owner:$owner,name:$repo) { pullRequest(number:$number) { headRefOid ${recentConnection} } } }`;
      const variables = kind === 'threadComments' ? { id: threadId, cursor } : { owner: target.owner, repo: target.repo, number: target.number, cursor };
      const response = record(this.json(await this.execute(['api', '--hostname', 'github.com', 'graphql', '--input', '-'], s, JSON.stringify({ query, variables }))));
      if (response.errors?.length) throw new Error('活动读取失败，可能没有访问权限');
      const node = kind === 'threadComments' ? response.data?.node : response.data?.repository?.pullRequest;
      const pr = kind === 'threadComments' ? node?.pullRequest : node;
      if (!pr || pr.headRefOid !== headSha) throw new Error('PR 版本已变化，请刷新');
      if (kind === 'threadComments' && (pr.number !== target.number || pr.repository?.name?.toLowerCase() !== target.repo.toLowerCase() || pr.repository?.owner?.login?.toLowerCase() !== target.owner.toLowerCase())) throw new Error('审阅线程不属于此 PR');
      const conn = node[kind === 'threadComments' ? 'comments' : kind === 'threads' ? 'reviewThreads' : kind];
      if (!Array.isArray(conn?.nodes)) throw new Error('活动分页数据无效');
      const info = conn.pageInfo;
      const threadCursors: Record<string, string | null> = {};
      if (kind === 'threads') for (const t of conn.nodes) threadCursors[t.id] = t.comments?.pageInfo?.hasNextPage ? t.comments.pageInfo.endCursor : null;
      this.assertIdentity(identity.key, epoch, s);
      return { headSha, comments: kind === 'comments' || kind === 'threadComments' ? conn.nodes.map(toReviewComment) : [],
        reviews: kind === 'reviews' ? conn.nodes.map((n: unknown) => toReviewSummary(n, headSha)).filter(Boolean) : [],
        threads: kind === 'threads' ? conn.nodes.map(toReviewThread).filter(Boolean) : [], threadCursors,
        commits: kind === 'commits' ? conn.nodes.map((n: any) => ({ sha: n.commit?.oid, title: n.commit?.messageHeadline ?? '', author: n.commit?.author?.user?.login ?? n.commit?.author?.name ?? null, createdAt: Number.isFinite(Date.parse(n.commit?.committedDate)) ? Date.parse(n.commit.committedDate) : null })).filter((c: any) => /^[a-f0-9]{40,64}$/i.test(c.sha ?? '')) : [],
        nextCursor: backwards ? info.hasPreviousPage ? info.startCursor : null : info.hasNextPage ? info.endCursor : null };
    });
  }

  async comment(raw: PrTarget, body: string, identityKey: string, requestId: string): Promise<PrReviewComment> {
    const target = validateTarget(raw);
    if (typeof body !== 'string' || !body.trim() || body.length > 65_536) throw new Error('留言不能为空，且不能超过 65,536 个字符');
    if (typeof identityKey !== 'string' || !/^github\.com\/[a-zA-Z0-9][a-zA-Z0-9-]{0,99}$/.test(identityKey) || typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(requestId)) throw new Error('无效留言请求');
    const key = `${identityKey}:${requestId}`;
    const fingerprint = JSON.stringify([targetKey(target), body]);
    // Retain receipts (including uncertain failures) so transport retries never repeat a POST.
    for (const [id, write] of this.commentWrites) if (write.settled && this.now() - write.at > 10 * 60_000) this.commentWrites.delete(id);
    const prior = this.commentWrites.get(key);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new Error('留言请求编号重复且内容不同');
      return prior.promise;
    }
    if (this.commentWrites.size >= 100) throw new Error('留言请求过多，请稍后重试');
    const promise = Promise.resolve().then(async () => {
      const identity = await this.probe(true);
      if (identity.key !== identityKey) throw new Error('GitHub 身份已变化，请刷新列表后再留言');
      const epoch = this.epoch;
      await this.view(target); // Ensure this is a PR, not an unrelated issue with the same number.
      this.assertIdentity(identity.key, epoch);
      const args = ['api', '--hostname', target.host, '--method', 'POST', `repos/${target.owner}/${target.repo}/issues/${target.number}/comments`, '--input', '-'];
      let data: Record<string, any>;
      try { data = record(this.json(await this.execute(args, undefined, JSON.stringify({ body })))); }
      catch (error) { throw new Error(`留言提交未确认：${error instanceof Error ? error.message : String(error)}。请刷新活动确认是否已发送，再决定是否重试。`); }
      finally {
        // Also invalidate on uncertain failures so a manual refresh can confirm a possibly accepted POST.
        const prefix = `${identity.key}:activity:${targetKey(target)}:`;
        for (const id of this.reads.keys()) if (id.startsWith(prefix)) this.reads.delete(id);
        for (const [id, job] of this.pending) if (id.startsWith(prefix)) job.controller.abort();
      }
      const url = safeGithubUrl(data.html_url, target);
      const path = url ? new URL(url).pathname.toLowerCase() : '';
      const repoPath = `/${target.owner}/${target.repo}`.toLowerCase();
      if (!url || ![`${repoPath}/issues/${target.number}`, `${repoPath}/pull/${target.number}`].includes(path) || !/^#issuecomment-\d+$/.test(new URL(url).hash) || typeof data.node_id !== 'string' || !data.node_id || typeof data.body !== 'string' || typeof data.user?.login !== 'string') throw new Error('GitHub 留言结果无法确认，请刷新活动查看，勿重复提交');
      return toReviewComment({ id: data.node_id, author: { login: data.user.login }, body: data.body, createdAt: data.created_at, url });
    });
    const write = { fingerprint, at: this.now(), settled: false, promise };
    this.commentWrites.set(key, write);
    void promise.finally(() => { write.settled = true; write.at = this.now(); }).catch(() => {});
    return promise;
  }

  async files(raw: PrTarget, page: number, headSha: string, baseSha: string, identityKey: string, force = false, signal?: AbortSignal): Promise<PrInboxFiles> {
    const target = validateTarget(raw); const { identity, epoch } = await this.context(identityKey, signal);
    if (!Number.isSafeInteger(page) || page < 1 || page > 30 || typeof headSha !== 'string' || typeof baseSha !== 'string' || !/^[a-f0-9]{40,64}$/i.test(headSha) || !/^[a-f0-9]{40,64}$/i.test(baseSha)) throw new Error('文件分页或版本无效');
    return this.cached(`${identity.key}:files:${targetKey(target)}:${headSha}:${baseSha}:${page}`, 30_000, force, signal, async s => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const before = await this.view(target, s);
        if (before.headRefOid !== headSha || before.baseRefOid !== baseSha) throw new Error('PR 版本已变化，请刷新详情与文件');
        const payload = this.json(await this.execute(['api', '--hostname', 'github.com', '--method', 'GET', `repos/${target.owner}/${target.repo}/pulls/${target.number}/files?per_page=100&page=${page}`], s));
        if (!Array.isArray(payload)) throw new Error('文件列表响应无效');
        const files = payload.map(f => fileItem(f, target));
        let diffTruncated = false; let diffError: string | null = null;
        // Files API patches are authoritative. Fetch the unified comparison only when a patch is absent.
        if (files.some(f => f.patch === null)) {
          try {
            const diff = await this.cached(`${identity.key}:diff:${targetKey(target)}:${headSha}:${baseSha}`, 30_000, force, s, ss =>
              this.execute(['pr', 'diff', String(target.number), '--repo', `${target.host}/${target.owner}/${target.repo}`, '--color', 'never'], ss));
            if (!diff.ok || diff.timedOut || diff.cancelled || diff.spawnError) throw this.failure(diff);
            diffTruncated = !!diff.outputTruncated;
            const paired = pairRemoteDiff(diff.stdout, files, diffTruncated);
            for (const file of files) if (file.patch === null && paired.has(file.path)) {
              file.patch = paired.get(file.path)!;
              file.patchTruncated = patchIncomplete(file.patch, file.additions, file.deletions);
            }
          } catch (error) { checkAbort(s); diffError = String(error); }
        }
        const after = await this.view(target, s);
        if (after.headRefOid !== before.headRefOid || after.baseRefOid !== before.baseRefOid) {
          this.reads.delete(`${identity.key}:diff:${targetKey(target)}:${headSha}:${baseSha}`);
          if (attempt === 0) continue;
          throw new Error('读取期间 PR 持续变化，请刷新');
        }
        this.assertIdentity(identity.key, epoch, s);
        const nextPage = files.length === 100 && page < 30 && page * 100 < before.changedFiles ? page + 1 : null;
        return { target, headSha, baseSha, files, nextPage, expectedCount: before.changedFiles,
          limited: before.changedFiles > 3000 || nextPage === null && (page - 1) * 100 + files.length < before.changedFiles,
          diffTruncated, diffError };
      }
      throw new Error('PR 版本已变化，请刷新');
    });
  }
}
