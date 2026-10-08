import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PrActivityKind, PrInboxDetail, PrReviewComment, PrTarget } from '@vela/shared';
import { tr, activeIntlLocale } from '../locale';
import { PrMarkdown } from './PrInboxMarkdown';
import { prTimeline, type PrTimelineEvent } from './pr-inbox-model';
import { usePrInboxCache } from '../hooks/usePrInboxCache';

const kinds = ['commits', 'comments', 'reviews', 'threads'] as const;
const kindLabels = { commits: ['提交', 'Commits'], comments: ['讨论', 'Comments'], reviews: ['审阅', 'Reviews'], threads: ['审阅线程', 'Review threads'], threadComments: ['线程回复', 'Thread replies'] } as const;
const reviewLabels: Record<string, [string, string]> = { APPROVED: ['批准了此 Pull Request', 'approved this pull request'], CHANGES_REQUESTED: ['请求修改', 'requested changes'], COMMENTED: ['发表了审阅意见', 'reviewed this pull request'], DISMISSED: ['审阅已撤销', 'review dismissed'], PENDING: ['待提交审阅', 'pending review'] };
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function ActivityTime({ at }: { at: number | null }) {
  if (at === null) return null;
  const seconds = (at - Date.now()) / 1000;
  const [divisor, unit] = Math.abs(seconds) >= 604800 ? [604800, 'week'] : Math.abs(seconds) >= 86400 ? [86400, 'day'] : Math.abs(seconds) >= 3600 ? [3600, 'hour'] : Math.abs(seconds) >= 60 ? [60, 'minute'] : [1, 'second'];
  const text = new Intl.RelativeTimeFormat(activeIntlLocale(), { numeric: 'auto', style: 'narrow' }).format(Math.round(seconds / Number(divisor)), unit as Intl.RelativeTimeFormatUnit);
  return <time dateTime={new Date(at).toISOString()} title={new Date(at).toLocaleString()}>{text}</time>;
}
function ActivityAvatar({ author }: { author: string | null }) {
  const name = author ?? tr('未知用户', 'Unknown user');
  const tone = [...name].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 3;
  return <span className={`pr-activity-avatar tone-${tone}`} role="img" aria-label={name}>{name.slice(0, 1).toUpperCase()}</span>;
}
function EventIcon({ kind }: { kind: 'commit' | 'opened' | 'review' | 'thread' }) {
  return <svg className={`pr-activity-icon kind-${kind}`} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === 'commit' ? <><path d="M3 12h5m8 0h5"/><circle cx="12" cy="12" r="4"/></> : kind === 'opened' ? <><circle cx="6" cy="5" r="2.5"/><circle cx="6" cy="19" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="M6 8v8M18 16V9a4 4 0 0 0-4-4h-2m2-2-2 2 2 2"/></> : kind === 'review' ? <><circle cx="12" cy="12" r="8"/><path d="m8 12 3 3 5-6"/></> : <path d="M20 14a3 3 0 0 1-3 3H9l-5 3V7a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3z"/>}
  </svg>;
}

function ActivityBody({ text, target }: { text: string; target: PrTarget }) {
  const [expanded, setExpanded] = useState(false);
  const long = text.length > 650 || text.split('\n').length > 10;
  return <>
    <div className={`pr-activity-body${long && !expanded ? ' is-folded' : ''}`}><PrMarkdown text={text} target={target}/></div>
    {long && <footer className="pr-activity-card-footer"><button type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? tr('收起', 'Collapse') : tr('展开', 'Expand')}<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true"><path d={expanded ? 'm4 10 4-4 4 4' : 'm4 6 4 4 4-4'}/></svg></button></footer>}
  </>;
}

function ActivityCard({ event, target, threadCursor, threadBusy, onThreadMore }: { event: PrTimelineEvent; target: PrTarget; threadCursor?: string | null; threadBusy?: boolean; onThreadMore: (id: string, cursor: string) => void }) {
  if (event.kind === 'commit' || event.kind === 'opened') return <article className="pr-activity-event">
    <EventIcon kind={event.kind}/><span className="pr-activity-event-text">{event.kind === 'commit' ? event.commit.title : <><strong>{event.author ?? '—'}</strong> {tr('创建了此 Pull Request', 'opened this pull request')}</>}</span>
    {event.kind === 'commit' && <><code title={event.commit.sha}>{event.commit.sha.slice(0, 7)}</code><ActivityAvatar author={event.commit.author}/></>}
    <ActivityTime at={event.at}/>
  </article>;
  if (event.kind === 'thread') return <article className="pr-activity-card">
    <header className="pr-activity-card-header"><EventIcon kind="thread"/><strong>{tr('代码讨论', 'Code discussion')}</strong><code className="pr-activity-path">{event.thread.path}:{event.thread.line ?? '—'}</code><ActivityTime at={event.at}/></header>
    <p className="pr-activity-review-state">{event.thread.resolved ? tr('已解决', 'Resolved') : tr('未解决', 'Unresolved')}{event.thread.outdated && ` · ${tr('已过期', 'Outdated')}`}</p>
    {event.thread.comments.map(comment => <div className="pr-activity-reply" key={comment.id}><header className="pr-activity-card-header"><ActivityAvatar author={comment.author}/><strong>{comment.author ?? '—'}</strong><ActivityTime at={comment.createdAt}/></header><ActivityBody text={comment.body} target={target}/></div>)}
    {threadCursor && <button type="button" className="pr-activity-more" disabled={threadBusy} onClick={() => onThreadMore(event.thread.id, threadCursor)}>{tr('加载更多回复', 'Load more replies')}</button>}
  </article>;
  const author = event.kind === 'comment' ? event.comment.author : event.review.author;
  const body = event.kind === 'comment' ? event.comment.body : event.review.body;
  return <article className="pr-activity-card">
    <header className="pr-activity-card-header"><ActivityAvatar author={author}/><strong>{author ?? '—'}</strong><ActivityTime at={event.at}/></header>
    {event.kind === 'review' && <p className="pr-activity-review-state"><EventIcon kind="review"/>{tr(...(reviewLabels[event.review.rawState ?? ''] ?? ['发表了审阅意见', 'reviewed this pull request']))}{event.review.commitSha && <code>{event.review.commitSha.slice(0, 7)}</code>}{event.review.outdated && <span>{tr('旧版本审阅', 'Review of an older head')}</span>}</p>}
    {body && <ActivityBody text={body} target={target}/>}
  </article>;
}

export function PrActivity({ detail, active, draft, onDraft, posted, submitting, submitError, notice, onSubmit }: {
  detail: PrInboxDetail; active: boolean; draft: string; onDraft: (text: string) => void; posted: PrReviewComment[];
  submitting: boolean; submitError: string | null; notice: string | null; onSubmit: () => Promise<void>;
}) {
  const { cache, api, version } = usePrInboxCache();
  const { target, identity, syncedAt } = detail;
  const headSha = detail.item.headSha!;
  const pages = useMemo(() => cache.getActivity(target, identity.key, headSha), [cache, target, identity.key, headSha, version]);
  const [errors, setErrors] = useState<Partial<Record<PrActivityKind, string>>>({});
  const [busy, setBusy] = useState<Partial<Record<PrActivityKind, boolean>>>({});
  const [filter, setFilter] = useState('all');
  const generation = useRef(0); const pending = useRef(new Set<string>());
  const load = useCallback(async (kind: PrActivityKind, cursor: string | null = null, threadId: string | null = null, silent = false) => {
    const current = generation.current; const requestId = crypto.randomUUID(); pending.current.add(requestId);
    const cached = cache.getActivity(target, identity.key, headSha)[kind];
    setBusy(b => ({ ...b, [kind]: !silent || !cached }));
    try {
      await api.activity(target, kind, cursor, headSha, threadId, { requestId, identityKey: identity.key, force: cursor === null });
      if (generation.current !== current) return;
      setErrors(e => ({ ...e, [kind]: undefined, ...(kind === 'threads' ? { threadComments: undefined } : {}) }));
    } catch (error) { if (generation.current === current && (!silent || !cached)) setErrors(previous => ({ ...previous, [kind]: message(error) })); }
    finally { pending.current.delete(requestId); if (generation.current === current) setBusy(b => ({ ...b, [kind]: false })); }
  }, [api, cache, target, identity.key, headSha]);
  useEffect(() => {
    if (!active) return;
    setBusy({}); setErrors({});
    for (const kind of kinds) void load(kind, null, null, true);
    return () => { generation.current++; for (const id of pending.current) void api.cancel(id).catch(() => {}); };
  }, [active, api, load, syncedAt, headSha, posted]);
  const events = useMemo(() => prTimeline(detail, pages, posted).filter(event => filter === 'all' || (filter === 'commits' ? event.kind === 'commit' : ['comment', 'review', 'thread'].includes(event.kind))), [detail, pages, posted, filter]);
  return <section className="pr-inbox-activity" aria-label={tr('活动与讨论', 'Activity & Conversation')}>
    <header className="pr-activity-heading"><h2>{tr('活动与讨论', 'Activity & Conversation')}</h2><label><svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="M3 5h14M5 10h10M8 15h4"/></svg><select aria-label={tr('活动类型', 'Activity type')} value={filter} onChange={e => setFilter(e.target.value)}><option value="all">{tr('全部活动', 'All activity')}</option><option value="conversation">{tr('讨论与审阅', 'Conversation')}</option><option value="commits">{tr('提交', 'Commits')}</option></select></label></header>
    {Object.entries(errors).filter(([, error]) => error).map(([kind, error]) => <p className="pr-inbox-notice" role="alert" key={kind}>{tr(kindLabels[kind as PrActivityKind][0], kindLabels[kind as PrActivityKind][1])}：{error} <button type="button" disabled={busy[kind as PrActivityKind]} onClick={() => kind === 'threadComments' ? void load('threads') : void load(kind as PrActivityKind, pages[kind as PrActivityKind]?.nextCursor ?? null)}>{tr('重试', 'Retry')}</button></p>)}
    {kinds.some(kind => busy[kind]) && <p className="pr-inbox-meta" role="status">{tr('正在读取活动…', 'Loading activity…')}</p>}
    <div className="pr-activity-timeline">{events.map(event => <ActivityCard key={event.id} event={event} target={target} threadCursor={event.kind === 'thread' ? pages.threads?.threadCursors[event.thread.id] : null} threadBusy={busy.threadComments} onThreadMore={(id, cursor) => void load('threadComments', cursor, id)}/>)}</div>
    {!events.length && !kinds.some(kind => busy[kind]) && !Object.values(errors).some(Boolean) && <p className="pr-inbox-meta">{tr('暂无此类活动', 'No activity of this type')}</p>}
    <div className="pr-activity-pagination">{kinds.filter(kind => pages[kind]?.nextCursor && (filter === 'all' || (filter === 'commits' ? kind === 'commits' : kind !== 'commits'))).map(kind => <button type="button" key={kind} disabled={busy[kind]} onClick={() => void load(kind, pages[kind]!.nextCursor)}>{kind === 'threads' ? tr('加载更多', 'Load more') : tr('加载更早的', 'Load earlier')} {tr(kindLabels[kind][0], kindLabels[kind][1])}</button>)}</div>
    <form className="pr-activity-composer" onSubmit={event => { event.preventDefault(); void onSubmit(); }}>
      <ActivityAvatar author={identity.login}/><div className="pr-activity-composer-content"><textarea aria-label={tr('留言内容', 'Comment body')} placeholder={tr('留言…', 'Leave a comment')} rows={2} maxLength={65_536} value={draft} disabled={submitting} onChange={e => onDraft(e.target.value)}/>
        <div className="pr-activity-composer-actions"><button type="submit" disabled={submitting || !draft.trim()}>{submitting ? tr('发布中…', 'Posting…') : tr('留言', 'Comment')}</button><span>{tr('以', 'As')} @{identity.login}</span></div>
        {submitError && <p className="pr-activity-submit-error" role="alert">{submitError}</p>}{notice && <p className="pr-activity-submit-notice" role="status">{notice}</p>}
      </div>
    </form>
  </section>;
}
