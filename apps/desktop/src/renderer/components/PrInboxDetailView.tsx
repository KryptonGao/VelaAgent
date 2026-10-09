import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PrInboxDetail, PrInboxItem, PrTarget, PrReviewComment } from '@vela/shared';
import { tr } from '../locale';
import { DiffPane } from './DiffPane';
import { PrCheckStatus, PrStateBadge } from './PrInboxPage';
import { PrMarkdown } from './PrInboxMarkdown';
import { PrActivity } from './PrInboxActivity';
import { usePrInboxCache } from '../hooks/usePrInboxCache';

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function mergeStateLabel(value: string | null): string {
  const labels: Record<string, [string, string]> = { BLOCKED: ['仓库规则阻止合并', 'Repository rules block merging'], BEHIND: ['落后于目标分支', 'Behind base branch'], CLEAN: ['当前规则满足', 'Current rules satisfied'], DIRTY: ['存在代码冲突', 'Merge conflicts'], DRAFT: ['草稿暂不可合并', 'Draft cannot merge'], UNSTABLE: ['检查未全部满足', 'Checks not fully satisfied'], HAS_HOOKS: ['需要额外仓库检查', 'Additional repository checks required'] };
  return value && labels[value] ? tr(...labels[value]) : tr('规则状态未知', 'Rule status unknown');
}
function reviewLabel(value: string | null): string {
  const labels: Record<string, [string, string]> = { APPROVED: ['已批准', 'Approved'], CHANGES_REQUESTED: ['请求修改', 'Changes requested'], REVIEW_REQUIRED: ['等待审阅', 'Review required'], COMMENTED: ['已发表评论', 'Commented'], DISMISSED: ['审阅已撤销', 'Review dismissed'], PENDING: ['待提交审阅', 'Pending review'] };
  return value && labels[value] ? tr(...labels[value]) : tr('暂无审阅结论', 'No review decision');
}
const checkOrder: Record<string, number> = { failing: 0, pending: 1, cancelled: 2, unknown: 3, skipped: 4, none: 5, passing: 6 };
function checkSummary(checks: PrInboxDetail['checks']): string {
  const count = (state: string) => checks.filter(check => check.state === state).length;
  return ([['passing', '通过', 'passed'], ['failing', '失败', 'failed'], ['pending', '运行中', 'running'], ['skipped', '跳过', 'skipped'], ['cancelled', '取消', 'cancelled']] as const)
    .filter(([state]) => count(state)).map(([state, zh, en]) => `${count(state)} ${tr(zh, en)}`).join(' · ');
}
function PrCheckList({ checks }: { checks: PrInboxDetail['checks'] }) {
  const sorted = [...checks].sort((a, b) => (checkOrder[a.state] ?? 9) - (checkOrder[b.state] ?? 9));
  const attention = sorted.filter(check => check.state !== 'passing');
  const passing = sorted.filter(check => check.state === 'passing');
  const row = (check: PrInboxDetail['checks'][number], i: number) => <div className="pr-inbox-check-row" key={`${check.name}:${i}`}><PrCheckStatus state={check.state} compact/><span title={check.description ?? undefined}>{check.name}</span></div>;
  return <>
    {attention.map(row)}
    {passing.length > 0 && (attention.length ? <details className="pr-inbox-check-passing"><summary>{tr(`${passing.length} 项通过的检查`, `${passing.length} passing checks`)}</summary>{passing.map(row)}</details> : passing.map(row))}
  </>;
}
function fileStatusLabel(value: string): string {
  const labels: Record<string, [string, string]> = { added: ['新增', 'Added'], removed: ['删除', 'Deleted'], modified: ['修改', 'Modified'], renamed: ['重命名', 'Renamed'], copied: ['复制', 'Copied'], changed: ['变更', 'Changed'], unchanged: ['未修改', 'Unchanged'] };
  return labels[value] ? tr(...labels[value]) : value;
}

export function PrInboxDetailView({ target, identityKey, active, onBack, related, summary }: { summary: PrInboxItem | null; target: PrTarget; identityKey: string; active: boolean; onBack: () => void; related: boolean }) {
  const { cache, api } = usePrInboxCache();
  const detail = cache.getDetail(target, identityKey);
  const detailRef = useRef(detail); detailRef.current = detail;
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<'overview' | 'changes'>('overview');
  const generation = useRef(0); const request = useRef<string | null>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [commentDraft, setCommentDraft] = useState('');
  const [postedComments, setPostedComments] = useState<PrReviewComment[]>([]);
  const [commentBusy, setCommentBusy] = useState(false);
  const [commentError, setCommentError] = useState<string | null>(null);
  const [commentNotice, setCommentNotice] = useState<string | null>(null);
  const commentPending = useRef(false);
  const submitComment = async () => {
    if (commentPending.current || !commentDraft.trim()) return;
    commentPending.current = true; setCommentBusy(true); setCommentError(null); setCommentNotice(null);
    try {
      const comment = await api.comment(target, commentDraft, { requestId: crypto.randomUUID(), identityKey });
      setPostedComments(previous => [...previous, comment]); setCommentDraft('');
      setCommentNotice(tr('留言已发布', 'Comment posted'));
    } catch (error) { setCommentError(message(error)); }
    finally { commentPending.current = false; setCommentBusy(false); }
  };
  const refresh = useCallback(async (force = false, silent = false) => {
    const current = ++generation.current;
    if (request.current) void api.cancel(request.current).catch(() => {});
    const requestId = crypto.randomUUID(); request.current = requestId; setLoading(!silent || !detailRef.current);
    try {
      await api.detail(target, { requestId, identityKey, force });
      if (current === generation.current) setError(null);
    } catch (e) { if (current === generation.current && (!silent || !detailRef.current)) setError(message(e)); }
    finally { if (current === generation.current) { setLoading(false); request.current = null; } }
  }, [api, target, identityKey]);
  useEffect(() => {
    if (!active) return;
    const visible = () => { if (document.visibilityState === 'visible') void refresh(true, true); };
    visible();
    document.addEventListener('visibilitychange', visible);
    return () => { generation.current++; document.removeEventListener('visibilitychange', visible); if (request.current) void api.cancel(request.current).catch(() => {}); request.current = null; setLoading(false); };
  }, [active, api, refresh]);
  const openGithub = () => { const url = detail?.item.url ?? summary?.url; if (url) void api.open(target, url).catch(e => setError(message(e))); };
  return <div className="pr-inbox-detail">
    <div className="pr-inbox-detail-toolbar"><button type="button" onClick={onBack}>← {tr('返回列表', 'Back to list')}</button>
      <div className="pr-inbox-segments" role="tablist" aria-label={tr('PR 详情', 'PR detail')} onKeyDown={e => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
        e.preventDefault(); const index = e.key === 'Home' ? 0 : e.key === 'End' ? 1 : tab === 'overview' ? 1 : 0;
        setTab(index ? 'changes' : 'overview'); tabRefs.current[index]?.focus();
      }}>
        {(['overview', 'changes'] as const).map((value, i) => <button type="button" role="tab" key={value} id={`pr-tab-${value}`} aria-controls={`pr-panel-${value}`} aria-selected={tab === value} tabIndex={tab === value ? 0 : -1} ref={node => { tabRefs.current[i] = node; }} onClick={() => setTab(value)}>{value === 'overview' ? tr('概览', 'Overview') : `${tr('变更', 'Changes')}${detail ? ` ${detail.changedFiles}` : ''}`}</button>)}
      </div>
      <button type="button" disabled={loading} onClick={() => void refresh(true)}>{loading ? tr('读取中…', 'Loading…') : tr('刷新详情', 'Refresh detail')}</button>
      <button type="button" disabled={!detail && !summary} onClick={openGithub}>{tr('在 GitHub 查看', 'View on GitHub')} ↗</button>
    </div>
    {error && <p className="pr-inbox-notice" role="alert">{detail && tr('显示缓存详情 · ', 'Showing cached detail · ')}{error}</p>}
    {!related && <p className="pr-inbox-notice">{tr('当前 PR 的关联已变化，仍可继续查看详情。', 'This PR is no longer related to you. Its detail remains available.')}</p>}
    {!detail ? <div className="pr-inbox-scroll">
        {/* The list row is already cached, so show what it knows while the first detail read is in flight. */}
        {summary && <div className="pr-inbox-overview"><article>
          <div className="pr-inbox-meta"><PrStateBadge state={summary.state}/><span>{target.owner}/{target.repo}</span><span>#{target.number}</span></div>
          <h1>{summary.title}</h1>
          <p className="pr-inbox-meta pr-inbox-branches"><span>@{summary.author?.login ?? '—'}</span>{summary.enrichment === 'ready' && <PrCheckStatus state={summary.checks}/>}</p>
        </article></div>}
        <div className="pr-inbox-empty" role="status">{loading ? tr('正在读取详情…', 'Loading detail…') : tr('详情不可访问，请重试或在 GitHub 查看。', 'Detail unavailable. Retry or view on GitHub.')}</div>
      </div> :
      tab === 'overview' ? <div id="pr-panel-overview" role="tabpanel" aria-labelledby="pr-tab-overview" className="pr-inbox-scroll">
        <div className="pr-inbox-overview"><article>
          <div className="pr-inbox-meta"><PrStateBadge state={detail.item.state}/><span>{target.owner}/{target.repo}</span><span>#{target.number}</span></div>
          <h1>{detail.item.title}</h1>
          <p className="pr-inbox-meta pr-inbox-branches"><span>@{detail.item.author?.login ?? '—'}</span><code>{detail.headRepository ? `${detail.headRepository}:` : ''}{detail.headRefName}</code><span aria-hidden="true">→</span><code>{detail.baseRefName}</code>
            <span className="pr-inbox-stats"><span className="pr-inbox-added">+{detail.additions}</span><span className="pr-inbox-deleted">−{detail.deletions}</span><span>{detail.changedFiles} {tr('个文件', 'files')}</span><code title={detail.item.headSha ?? ''}>{detail.item.headSha?.slice(0, 8)}</code></span></p>
          <PrMarkdown text={detail.body || tr('没有描述', 'No description')} target={target}/>
          <PrActivity key={detail.item.headSha} detail={detail} active={active} draft={commentDraft} onDraft={setCommentDraft} posted={postedComments} submitting={commentBusy} submitError={commentError} notice={commentNotice} onSubmit={submitComment}/>
        </article><aside className="pr-inbox-checks">
          <section className="pr-inbox-status-list">
            <div><h2>{tr('合并状态', 'Merge status')}</h2><p className={`pr-inbox-status-line ${detail.item.mergeable === 'CONFLICTING' ? 'tone-bad' : detail.item.mergeable === 'MERGEABLE' ? 'tone-good' : ''}`}>{detail.item.mergeable === 'CONFLICTING' ? tr('存在代码冲突', 'Merge conflicts') : detail.item.mergeable === 'MERGEABLE' ? tr('无代码冲突', 'No code conflicts') : tr('合并能力未知', 'Mergeability unknown')}</p>
              {detail.item.mergeStateStatus !== 'DIRTY' && <p className="pr-inbox-status-sub">{mergeStateLabel(detail.item.mergeStateStatus)}</p>}</div>
            <div><h2>{tr('当前审阅结论', 'Current review decision')}</h2><p className={`pr-inbox-status-line ${detail.item.reviewDecision === 'APPROVED' ? 'tone-good' : detail.item.reviewDecision === 'CHANGES_REQUESTED' ? 'tone-bad' : ''}`}>{reviewLabel(detail.item.reviewDecision)}</p></div>
          </section>
          <section><h2>{tr('检查结果', 'Checks')}</h2><p className="pr-inbox-check-summary"><PrCheckStatus state={detail.item.checks}/></p>
            {detail.checks.length > 0 && <p className="pr-inbox-status-sub">{checkSummary(detail.checks)}</p>}
            {detail.checksError && <p className="pr-inbox-notice">{detail.checksError}</p>}
            <PrCheckList checks={detail.checks}/>
          </section>
        </aside></div>
      </div> : <div id="pr-panel-changes" role="tabpanel" aria-labelledby="pr-tab-changes" className="pr-inbox-changes-panel">
        {active && <PrFiles key={`${detail.item.headSha}:${detail.item.baseSha}`} target={target} identityKey={identityKey} detail={detail}/>}</div>}
  </div>;
}

function PrFiles({ target, identityKey, detail }: { target: PrTarget; identityKey: string; detail: PrInboxDetail }) {
  const { cache, api, version } = usePrInboxCache();
  const result = useMemo(() => cache.getFiles(target, identityKey, detail.item.headSha!, detail.item.baseSha!), [cache, target, identityKey, detail.item.headSha, detail.item.baseSha, version]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(() => result?.files[0]?.path ?? null);
  const [search, setSearch] = useState('');
  const [mode, setMode] = useState<'unified' | 'split'>('unified');
  const [limit, setLimit] = useState(400);
  const request = useRef<string | null>(null); const generation = useRef(0);
  const load = useCallback(async (page: number, force = false, silent = false) => {
    const current = ++generation.current; const requestId = crypto.randomUUID(); request.current = requestId;
    setBusy(!silent || !cache.getFiles(target, identityKey, detail.item.headSha!, detail.item.baseSha!));
    try {
      const next = await api.files(target, page, detail.item.headSha!, detail.item.baseSha!, { requestId, identityKey, force });
      if (current !== generation.current) return;
      setError(null);
      setSelectedPath(path => path && (cache.getFiles(target, identityKey, detail.item.headSha!, detail.item.baseSha!)?.files.some(file => file.path === path)) ? path : next.files[0]?.path ?? null);
    } catch (e) { if (current === generation.current && (!silent || !cache.getFiles(target, identityKey, detail.item.headSha!, detail.item.baseSha!))) setError(message(e)); }
    finally { if (current === generation.current) { setBusy(false); request.current = null; } }
  }, [api, cache, target, identityKey, detail.item.headSha, detail.item.baseSha]);
  useEffect(() => { void load(1, true, true); return () => { generation.current++; if (request.current) void api.cancel(request.current).catch(() => {}); }; }, [api, load]);
  const files = result?.files.filter(f => f.path.toLowerCase().includes(search.toLowerCase())) ?? [];
  const selected = result?.files.find(f => f.path === selectedPath);
  const lines = selected?.patch?.split('\n') ?? [];
  return <div className="pr-inbox-files">
    <aside className="pr-inbox-file-tree"><input type="search" aria-label={tr('搜索已加载文件', 'Search loaded files')} placeholder={tr('搜索已加载文件', 'Search loaded files')} value={search} onChange={e => setSearch(e.target.value)}/>
      <p className="pr-inbox-meta">{result?.files.length ?? 0} / {detail.changedFiles} {tr('个文件', 'files')}</p>
      <nav aria-label={tr('变更文件', 'Changed files')}>{files.map(file => <button type="button" key={file.path} className={file.path === selectedPath ? 'selected' : ''} aria-current={file.path === selectedPath ? 'page' : undefined} title={file.path} onClick={() => { setSelectedPath(file.path); setLimit(400); }}><span className="pr-file-name"><strong>{file.path.slice(file.path.lastIndexOf('/') + 1)}</strong>{file.path.includes('/') && <em>{file.path.slice(0, file.path.lastIndexOf('/') + 1)}</em>}</span><small><span className="pr-inbox-added">+{file.additions}</span> <span className="pr-inbox-deleted">−{file.deletions}</span></small></button>)}</nav>
      {!files.length && !busy && <p>{tr('已加载文件中没有匹配结果', 'No matching loaded files')}</p>}
      {result?.nextPage && <button type="button" disabled={busy} onClick={() => void load(result.nextPage!)}>{tr('加载更多文件', 'Load more files')}</button>}
      {busy && <p role="status">{tr('正在读取文件…', 'Loading files…')}</p>}
    </aside>
    <section className="pr-inbox-file-diff">
      {error && <p className="pr-inbox-notice" role="alert">{error}<button type="button" disabled={busy} onClick={() => void load(result?.nextPage ?? 1, true)}>{tr('重试', 'Retry')}</button></p>}
      {(result?.limited || result?.diffTruncated || result?.diffError) && <p className="pr-inbox-notice">{result.limited && tr('文件列表不完整（GitHub 最多返回 3,000 个文件）。', 'File list is incomplete (GitHub returns up to 3,000 files).')}{result.diffTruncated && tr('原始 diff 达到输出上限，已截断。', 'The raw diff exceeded the output limit and was truncated.')}{result.diffError}</p>}
      <label className="pr-inbox-mobile-file">{tr('选择文件', 'Choose file')}<select value={selectedPath ?? ''} onChange={e => { setSelectedPath(e.target.value); setLimit(400); }}>{files.map(f => <option key={f.path} value={f.path}>{f.path}</option>)}</select></label>
      {selected ? <><header className="pr-inbox-diff-header"><div><strong>{selected.path}</strong>{selected.previousPath && <p>{selected.previousPath} → {selected.path}</p>}<p className="pr-inbox-meta">{fileStatusLabel(selected.status)} · <span className="pr-inbox-added">+{selected.additions}</span> <span className="pr-inbox-deleted">−{selected.deletions}</span></p></div>
        <label className="pr-inbox-view-mode"><select aria-label={tr('显示模式', 'View mode')} value={mode} onChange={e => setMode(e.target.value as typeof mode)}><option value="unified">{tr('统一', 'Unified')}</option><option value="split">{tr('并排', 'Split')}</option></select></label>
</header>
        <div className="pr-inbox-diff-scroll">{selected.patchTruncated && <p className="pr-inbox-notice">{tr("GitHub 只返回了此文件的部分差异，请在 GitHub 查看完整变更。", "GitHub returned only part of this file’s diff. View the complete changes on GitHub.")}</p>}{selected.patch && /^@@/m.test(selected.patch) ? <><DiffPane path={selected.path} diff={lines.slice(0, limit).join('\n')} mode={mode} showLineNumbers/>{lines.length > limit && <button type="button" className="pr-inbox-diff-more" onClick={() => setLimit(l => l + 400)}>{tr('展开更多差异', 'Show more diff')} ({Math.min(limit, lines.length)} / {lines.length})</button>}</> : <div className="pr-inbox-empty">{tr('此文件没有可用的文本差异。可通过顶栏在 GitHub 查看。', 'No text diff is available for this file. Use the GitHub link in the toolbar.')}</div>}</div>
      </> : !busy && !error && <div className="pr-inbox-empty">{tr('没有变更文件', 'No changed files')}</div>}
    </section>
  </div>;
}
