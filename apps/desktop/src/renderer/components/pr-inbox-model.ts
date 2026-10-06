import type { PrInboxItem, PrRelation, PrInboxList, PrInboxDetail, PrActivityPage, PrReviewComment, PrReviewSummary, PrReviewThread, PrActivityCommit } from '@vela/shared';
export function filterInbox(items: PrInboxItem[], relation: PrRelation | 'all', keyword: string): PrInboxItem[] {
  const q = keyword.trim().toLowerCase().replace(/^#(?=\d+$)/, '');
  return items.filter(item => (relation === 'all' || item.relations.includes(relation)) &&
    (!q || `${item.title}\n${item.target.owner}/${item.target.repo}\n${item.target.number}`.toLowerCase().includes(q)));
}
export function loadedCount(list: PrInboxList, relation: PrRelation | 'all'): string {
  const count = relation === 'all' ? list.items.length : list.items.filter(i => i.relations.includes(relation)).length;
  const complete = relation === 'all' ? list.complete : list.pages.find(p => p.relation === relation)?.complete;
  return `${count}${complete ? '' : '+'}`;
}
export function inboxKey(item: PrInboxItem): string { return item.key; }

export type PrTimelineEvent =
  | { kind: 'opened'; id: string; at: number | null; author: string | null }
  | { kind: 'commit'; id: string; at: number | null; commit: PrActivityCommit }
  | { kind: 'comment'; id: string; at: number | null; comment: PrReviewComment }
  | { kind: 'review'; id: string; at: number | null; review: PrReviewSummary }
  | { kind: 'thread'; id: string; at: number | null; thread: PrReviewThread };

/** Merge independently paginated sources without losing chronology or duplicating posted comments. */
export function prTimeline(detail: PrInboxDetail, pages: Partial<Record<string, PrActivityPage>>, posted: PrReviewComment[]): PrTimelineEvent[] {
  const created = Date.parse(detail.createdAt);
  const events: PrTimelineEvent[] = [{ kind: 'opened', id: 'opened', at: Number.isFinite(created) ? created : null, author: detail.item.author?.login ?? null }];
  for (const commit of pages.commits?.commits ?? []) events.push({ kind: 'commit', id: `commit:${commit.sha}`, at: commit.createdAt, commit });
  for (const comment of [...(pages.comments?.comments ?? []), ...posted]) events.push({ kind: 'comment', id: `comment:${comment.id}`, at: comment.createdAt, comment });
  for (const review of pages.reviews?.reviews ?? []) events.push({ kind: 'review', id: `review:${review.author}:${review.submittedAt}:${review.rawState}:${review.commitSha}:${review.body}`, at: review.submittedAt, review });
  for (const thread of pages.threads?.threads ?? []) events.push({ kind: 'thread', id: `thread:${thread.id}`, at: thread.comments[0]?.createdAt ?? null, thread });
  return [...new Map(events.map(event => [event.id, event])).values()].sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || a.id.localeCompare(b.id));
}
