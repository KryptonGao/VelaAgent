import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PrInboxItem, PrInboxQuery, PrRelation, PrTarget } from '@vela/shared';
import { tr } from '../locale';
import { filterInbox, loadedCount } from './pr-inbox-model';
import { PrInboxDetailView } from './PrInboxDetailView';
import { usePrInboxCache, usePrInboxIdleRefresh } from '../hooks/usePrInboxCache';
import '../pr-inbox.css';

export const relationLabels: Record<PrRelation | 'all', [string, string]> = {
  all: ['全部关联', 'All related'], authored: ['我创建的', 'Authored'], reviewRequested: ['待我审查', 'Review requested'],
  assigned: ['分配给我', 'Assigned'], mentioned: ['提及我', 'Mentioned'],
};
export const checkLabels = {
  unknown: ['未知', 'Unknown'], none: ['无检查', 'No checks'], passing: ['检查通过', 'Checks passed'], failing: ['检查失败', 'Checks failed'],
  pending: ['检查运行中', 'Checks pending'], skipped: ['检查已跳过', 'Checks skipped'], cancelled: ['检查已取消', 'Checks cancelled'],
} as const;
export function PrCheckStatus({ state, compact = false }: { state: PrInboxItem['checks']; compact?: boolean }) {
  const label = tr(checkLabels[state][0], checkLabels[state][1]);
  return <span className={`pr-inbox-check-status check-${state}`} title={label} role={compact ? 'img' : undefined} aria-label={compact ? label : undefined}>
    <svg width="17" height="17" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="10" cy="10" r="7.5"/>
      {state === 'passing' ? <path d="m6.5 10 2.3 2.4 4.7-4.9"/> : state === 'failing' ? <path d="m7.3 7.3 5.4 5.4m0-5.4-5.4 5.4"/> :
        state === 'pending' ? <path d="M10 5.8v4.5l2.5 1.5"/> : state === 'unknown' ? <><path d="M8.2 7.7a1.9 1.9 0 1 1 3.6 1c-.6.9-1.8.9-1.8 2.3"/><path d="M10 13.5h.01"/></> : <path d="M6.7 10h6.6"/>}
    </svg>
    {!compact && <span>{label}</span>}
  </span>;
}
export function PrStateBadge({ state }: { state: PrInboxItem['state'] }) {
  const labels = { open: ['打开', 'Open'], draft: ['草稿', 'Draft'], merged: ['已合并', 'Merged'], closed: ['已关闭', 'Closed'] };
  return <span className={`pr-inbox-badge state-${state}`}>{tr(labels[state][0], labels[state][1])}</span>;
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export function PrInboxPage({ active, sidebarCollapsed, onToggleSidebar }: { active: boolean; sidebarCollapsed: boolean; onToggleSidebar: () => void }) {
  const { cache, api, version } = usePrInboxCache();
  usePrInboxIdleRefresh(cache);
  const [query, setQuery] = useState<PrInboxQuery>({ state: 'openAndDraft', repository: null });
  const [relation, setRelation] = useState<PrRelation | 'all'>('all');
  const [keyword, setKeyword] = useState('');
  const [sort, setSort] = useState('attention');
  const list = cache.getList(query);
  const [loading, setLoading] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [selected, setSelected] = useState<PrTarget | null>(null);
  const [page, setPage] = useState(0);
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const listRef = useRef(list); listRef.current = list;
  const generation = useRef(0);
  const request = useRef<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollPosition = useRef(0);
  const activeRef = useRef(active); activeRef.current = active;
  const previousIdentity = useRef(list?.identity?.key);
  useEffect(() => {
    if (previousIdentity.current !== list?.identity?.key) { setSelected(null); setLocalError(null); }
    previousIdentity.current = list?.identity?.key;
  }, [list?.identity?.key]);

  const refresh = useCallback(async (force = false, more = false, silent = false) => {
    if (request.current) void api.cancel(request.current).catch(() => {});
    const current = ++generation.current;
    const requestId = crypto.randomUUID(); request.current = requestId;
    if (silent) cache.silenceRequest(requestId);
    setLoading(!silent || !listRef.current); if (!silent) setLocalError(null);
    try {
      const result = await api.list(query, { requestId, force, more, revision: listRef.current?.revision });
      if (current !== generation.current || !activeRef.current) return;
      if (result.identity?.key !== listRef.current?.identity?.key) setSelected(null);
    } catch (error) { if (current === generation.current && (!silent || !listRef.current)) setLocalError(errorText(error)); }
    finally { if (current === generation.current) { request.current = null; setLoading(false); } }
  }, [api, cache, query]);

  useEffect(() => {
    if (!active) return;
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh(true, false, true); };
    onVisible();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      generation.current++; if (request.current) void api.cancel(request.current).catch(() => {});
      request.current = null; setLoading(false);
    };
  }, [active, refresh, api]);

  useEffect(() => {
    if (!active) return;
    const keyboard = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && !selectedRef.current) { event.preventDefault(); searchRef.current?.focus(); }
      if (event.key === 'Escape' && selectedRef.current) setSelected(null);
    };
    window.addEventListener('keydown', keyboard);
    return () => window.removeEventListener('keydown', keyboard);
  }, [active]);
  useEffect(() => { if (!selected && scrollRef.current) scrollRef.current.scrollTop = scrollPosition.current; }, [selected]);

  const items = useMemo(() => (list?.items ?? []).map(item => list?.identity ? cache.getEnriched(item, list.identity.key) : item), [list, cache, version]);
  const filtered = useMemo(() => {
    const rows = filterInbox(items, relation, keyword);
    return rows.sort((a, b) => {
      if (sort === 'attention') { const diff = Number(b.attentionReasons.length > 0) - Number(a.attentionReasons.length > 0); if (diff) return diff; }
      if (sort === 'repository') { const diff = `${a.target.owner}/${a.target.repo}`.localeCompare(`${b.target.owner}/${b.target.repo}`); if (diff) return diff; }
      return b.updatedAt.localeCompare(a.updatedAt) || a.key.localeCompare(b.key);
    });
  }, [items, relation, keyword, sort]);
  const effectivePage = Math.min(page, Math.max(0, Math.ceil(filtered.length / 40) - 1));
  const visible = filtered.slice(effectivePage * 40, effectivePage * 40 + 40);
  const targets = visible.map(i => i.target);
  const targetSignature = targets.map(t => `${t.owner}/${t.repo}#${t.number}`).sort().join(',');
  const identityKey = list?.identity?.key;
  const listRevision = list?.revision;
  useEffect(() => {
    if (!active || selected || !identityKey || !targets.length) return;
    let disposed = false; const requestId = crypto.randomUUID();
    void api.enrich(targets, { requestId, identityKey, force: true }).catch(error => { if (!disposed && targets.some(target => items.find(item => item.target === target)?.enrichment === 'idle')) setLocalError(errorText(error)); });
    return () => { disposed = true; void api.cancel(requestId).catch(() => {}); };
    // Only re-read when the visible target set or list snapshot changes.
  }, [active, selected, identityKey, listRevision, targetSignature, api]);

  const repositories = [...new Set((list?.items ?? []).map(i => `${i.target.owner}/${i.target.repo}`))].sort();
  if (query.repository && !repositories.includes(query.repository)) repositories.unshift(query.repository);
  const resetPage = () => { setPage(0); scrollPosition.current = 0; };
  const open = (item: PrInboxItem) => { scrollPosition.current = scrollRef.current?.scrollTop ?? 0; setSelected(item.target); };

  return <section className="pr-inbox-page" aria-label="Pull Request">
    <header className="pr-inbox-topbar main-chat-header">
      {sidebarCollapsed && <button type="button" onClick={onToggleSidebar} aria-label={tr('展开侧栏', 'Show sidebar')}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></svg></button>}
      <span>Pull Requests</span>
      <span className="pr-inbox-sync">{list?.syncedAt ? `${list.stale ? tr('缓存 · ', 'Cached · ') : ''}${tr('同步于 ', 'Synced ')}${new Date(list.syncedAt).toLocaleTimeString()}` : ''}</span>
      <button type="button" disabled={loading} onClick={() => void refresh(true)}>{loading ? tr('读取中…', 'Loading…') : tr('刷新', 'Refresh')}</button>
    </header>
    {selected && identityKey ? <PrInboxDetailView key={`${identityKey}:${selected.owner}/${selected.repo}#${selected.number}`} active={active}
      sourceUrl={list?.items.find(i => i.key === `${selected.host}/${selected.owner}/${selected.repo}#${selected.number}`.toLowerCase())?.url ?? null}
      target={selected} identityKey={identityKey} onBack={() => setSelected(null)} related={!!list?.items.some(i => i.key === `${selected.host}/${selected.owner}/${selected.repo}#${selected.number}`.toLowerCase())} /> :
      <div ref={scrollRef} className="pr-inbox-scroll">
        <div className="pr-inbox-content">
          <div className="pr-inbox-heading"><h1>Pull Requests</h1><span className="pr-inbox-account">{list?.identity ? `@${list.identity.login}` : tr('GitHub 身份未确认', 'GitHub identity unavailable')}</span></div>
          <nav className="pr-inbox-relations" aria-label={tr('关联类型', 'Relationships')}>
            {(Object.keys(relationLabels) as Array<PrRelation | 'all'>).map(value => <button type="button" key={value} aria-current={relation === value ? 'page' : undefined}
              onClick={() => { setRelation(value); resetPage(); }}>{tr(...relationLabels[value])}<span>{list ? loadedCount(list, value) : '—'}</span></button>)}
          </nav>
          <div className="pr-inbox-filters">
            <label className="pr-inbox-search"><span>{tr('搜索已加载 PR', 'Search loaded PRs')}</span><input ref={searchRef} value={keyword} placeholder={tr('标题、仓库或 #编号', 'Title, repository or #number')} onChange={e => { setKeyword(e.target.value); resetPage(); }} /></label>
            <label><span>{tr('仓库（已加载范围）', 'Repository (loaded results)')}</span><select value={query.repository ?? ''} onChange={e => { setQuery(q => ({ ...q, repository: e.target.value || null })); resetPage(); }}>
              <option value="">{tr('所有仓库', 'All repositories')}</option>{repositories.map(repo => <option key={repo}>{repo}</option>)}</select></label>
            <label><span>{tr('状态', 'State')}</span><select value={query.state} onChange={e => { setQuery(q => ({ ...q, state: e.target.value as PrInboxQuery['state'] })); resetPage(); }}>
              {([['openAndDraft', '打开与草稿', 'Open & draft'], ['open', '仅打开', 'Open'], ['draft', '仅草稿', 'Draft'], ['merged', '已合并', 'Merged'], ['closed', '已关闭', 'Closed'], ['all', '全部状态', 'All states']] as const).map(([value, zh, en]) => <option key={value} value={value}>{tr(zh, en)}</option>)}
            </select></label>
            <label><span>{tr('排序', 'Sort')}</span><select value={sort} onChange={e => { setSort(e.target.value); resetPage(); }}>
              <option value="attention">{tr('需要关注优先', 'Attention first')}</option><option value="updated">{tr('最近更新', 'Recently updated')}</option><option value="repository">{tr('按仓库', 'Repository')}</option></select></label>
          </div>
          {(localError || list?.error) && <div className="pr-inbox-notice" role="alert">
            <p>{localError || list?.error?.message}</p>
            {list?.pages.filter(p => p.error).map(p => <p key={p.relation}>{tr(...relationLabels[p.relation])}：{p.error}</p>)}
            {list?.error?.retryAt && <p>{tr('下次可重试：', 'Retry after: ')}{new Date(list.error.retryAt).toLocaleTimeString()}</p>}
            {list?.error?.kind === 'no-gh' && <p>{tr('安装 GitHub CLI：', 'Install GitHub CLI: ')}<code>brew install gh</code> · <code>https://cli.github.com</code></p>}
            {(list?.error?.kind === 'unauthenticated' || list?.error?.kind === 'no-gh') && <><p><code>gh auth login --hostname github.com</code></p><button type="button" onClick={() => void api.openTerminal().catch(e => setLocalError(errorText(e)))}>{tr('打开终端', 'Open terminal')}</button></>}
            <button type="button" disabled={loading || !!list?.error?.retryAt && Date.now() < list.error.retryAt} onClick={() => void refresh(true)}>{tr('重试读取', 'Retry')}</button>
          </div>}
          {list?.pages.some(p => p.incompleteResults) && <p className="pr-inbox-notice">{tr('搜索结果不完整或超过 1,000 条，请缩小仓库范围。', 'Results are incomplete or exceed 1,000. Narrow the repository filter.')}</p>}
          {!list && loading ? <div className="pr-inbox-skeleton" role="status" aria-label={tr('正在读取 PR', 'Loading PRs')}>{Array.from({ length: 5 }, (_, i) => <div key={i} />)}</div> :
            <div className="pr-inbox-list" aria-busy={loading}>
              {visible.map((item, index) => <div key={item.key}>
                {sort === 'attention' && (index === 0 || !!item.attentionReasons.length !== !!visible[index - 1].attentionReasons.length) && <h2 className="pr-inbox-group">{item.attentionReasons.length ? tr('需要关注', 'Needs attention') : tr('其他', 'Other')}</h2>}
                <button type="button" className="pr-inbox-row" onClick={() => open(item)}>
                  <span className={`pr-inbox-pr-symbol state-${item.state}`} aria-hidden="true"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="6" cy="5" r="3"/><circle cx="6" cy="19" r="3"/><circle cx="18" cy="19" r="3"/><path d="M6 8v8M18 16V9a4 4 0 0 0-4-4h-2m2-2-2 2 2 2"/></svg></span>
                  <span className="pr-inbox-row-title"><strong>{item.title}</strong><span className="pr-inbox-meta">{item.target.owner}/{item.target.repo} <span>#{item.target.number}</span> {item.relations.map(r => <span key={r}>{tr(...relationLabels[r])}</span>)}</span></span>
                  <span className="pr-inbox-row-state"><PrStateBadge state={item.state}/><span className="pr-inbox-check">{item.enrichment === 'idle' ? tr('正在读取状态…', 'Reading status…') : item.enrichment === 'error' ? tr('状态读取失败', 'Status unavailable') : <PrCheckStatus state={item.checks}/>}</span></span>
                  <time className="pr-inbox-updated" dateTime={item.updatedAt}>{item.updatedAt ? new Date(item.updatedAt).toLocaleDateString() : ''}</time>
                </button>
              </div>)}
              {list && !filtered.length && <div className="pr-inbox-empty">{keyword || relation !== 'all' ? tr('已加载的 PR 中没有匹配结果。', 'No matches in loaded PRs.') : list.complete ? tr('没有关联的 Pull Request。', 'No related pull requests.') : tr('当前读取范围内没有 PR，结果尚未完整。', 'No PRs in the current range. Results are incomplete.')}</div>}
            </div>}
          {filtered.length > 40 && <div className="pr-inbox-pagination"><button type="button" disabled={!effectivePage} onClick={() => setPage(effectivePage - 1)}>{tr('上一页', 'Previous')}</button><span>{effectivePage + 1} / {Math.ceil(filtered.length / 40)}</span><button type="button" disabled={(effectivePage + 1) * 40 >= filtered.length} onClick={() => setPage(effectivePage + 1)}>{tr('下一页', 'Next')}</button></div>}
          {list && <footer className="pr-inbox-footer"><span>{tr('已加载', 'Loaded')} {list.items.length} {tr('条', 'PRs')}{!list.complete && ` · ${tr('结果尚未完整', 'Results incomplete')}`}</span>
            {list.pages.some(p => p.nextPage !== null) && <button type="button" disabled={loading} onClick={() => void refresh(false, true)}>{tr('从 GitHub 加载更多', 'Load more from GitHub')}</button>}</footer>}
        </div>
      </div>}
  </section>;
}
