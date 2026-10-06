import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PrInboxItem, PrInboxList, PrInboxDetail, PrActivityPage, PrReviewComment, PrReviewSummary, PrReviewThread } from '@vela/shared';
import { filterInbox, loadedCount, prTimeline } from '../src/renderer/components/pr-inbox-model.ts';
const a = { key: 'github.com/o/one#128', target: { owner: 'o', repo: 'one', number: 128 }, title: 'Read remote diffs', relations: ['authored', 'mentioned'] } as PrInboxItem;
const b = { ...a, key: 'github.com/o/two#128', target: { ...a.target, repo: 'two' }, title: 'Fix checks', relations: ['assigned'] } as PrInboxItem;
describe('PR inbox loaded-result model', () => {
  it('filters every relation on overlapping items without duplicating the union', () => {
    assert.equal(filterInbox([a, b], 'all', '').length, 2);
    assert.deepEqual(filterInbox([a, b], 'mentioned', ''), [a]);
    assert.deepEqual(filterInbox([a, b], 'authored', 'REMOTE'), [a]);
  });
  it('searches titles, repository names and PR numbers only within loaded data', () => {
    assert.equal(filterInbox([a, b], 'all', '#128').length, 2);
    assert.deepEqual(filterInbox([a, b], 'all', 'o/two'), [b]);
    assert.deepEqual(filterInbox([a, b], 'all', 'not loaded'), []);
  });
  it('keeps relation counts separate from the deduplicated union and marks partial counts', () => {
    const list = { items: [a, b], complete: false, pages: [{ relation: 'authored', complete: true }, { relation: 'mentioned', complete: false }] } as PrInboxList;
    assert.equal(loadedCount(list, 'all'), '2+'); assert.equal(loadedCount(list, 'authored'), '1'); assert.equal(loadedCount(list, 'mentioned'), '1+');
    assert.equal(loadedCount({ ...list, complete: true }, 'all'), '2');
  });
});

describe('PR activity timeline', () => {
  it('sorts independently loaded commits, opening, comments and reviews by timestamp', () => {
    const detail = { item: { author: { login: 'owner' } }, createdAt: '2026-10-05T00:00:00Z' } as PrInboxDetail;
    const at = Date.parse(detail.createdAt);
    const comment = { id: 'C1', author: 'friend', body: 'comment', createdAt: at + 20 } as PrReviewComment;
    const review = { author: 'reviewer', submittedAt: at + 10, rawState: 'APPROVED', body: '', outdated: true } as PrReviewSummary;
    const pages = { comments: { comments: [comment] }, reviews: { reviews: [review] }, commits: { commits: [{ sha: 'a'.repeat(40), title: 'Before PR opened', author: 'owner', createdAt: at - 1 }] } } as unknown as Record<string, PrActivityPage>;
    assert.deepEqual(prTimeline(detail, pages, []).map(event => event.kind), ['commit', 'opened', 'review', 'comment']);
    assert.equal(prTimeline(detail, pages, []).find(event => event.kind === 'review')?.review.outdated, true);
  });
  it('deduplicates overlapping pages and newly posted receipts while preserving code threads', () => {
    const detail = { item: { author: null }, createdAt: '' } as PrInboxDetail;
    const comment = { id: 'IC1', body: 'stale', createdAt: 1 } as PrReviewComment;
    const thread = { id: 'T1', path: 'src/main.ts', line: 12, comments: [comment], resolved: true } as PrReviewThread;
    const pages = { comments: { comments: [comment, comment] }, threads: { threads: [thread, thread] } } as unknown as Record<string, PrActivityPage>;
    const timeline = prTimeline(detail, pages, [{ ...comment, body: 'posted' }]);
    assert.equal(timeline.filter(event => event.kind === 'comment').length, 1);
    assert.equal(timeline.find(event => event.kind === 'comment')?.comment.body, 'posted');
    assert.equal(timeline.filter(event => event.kind === 'thread').length, 1);
    assert.equal(timeline.find(event => event.kind === 'opened')?.at, null);
  });
});
