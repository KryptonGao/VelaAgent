import type { PrCheckDetail, PrReviewComment, PrReviewSummary, PrReviewThread, PrState } from './index';

export const PrInboxIpc = {
  list: 'pr-inbox:list', enrich: 'pr-inbox:enrich', detail: 'pr-inbox:detail',
  activity: 'pr-inbox:activity', files: 'pr-inbox:files', cancel: 'pr-inbox:cancel',
  open: 'pr-inbox:open', terminal: 'pr-inbox:terminal', comment: 'pr-inbox:comment',
  responsePrepare: 'pr-inbox:response-prepare', responseStart: 'pr-inbox:response-start',
  responseRuns: 'pr-inbox:response-runs', responseReview: 'pr-inbox:response-review',
  responsePublish: 'pr-inbox:response-publish', responseDiscard: 'pr-inbox:response-discard',
} as const;
export type PrRelation = 'authored' | 'reviewRequested' | 'assigned' | 'mentioned';
export const prRelations: PrRelation[] = ['authored', 'reviewRequested', 'assigned', 'mentioned'];
export interface PrTarget { host: string; owner: string; repo: string; number: number }
export type PrInboxStatus = 'ok' | 'no-gh' | 'unauthenticated' | 'permission' | 'offline' | 'rate-limited' | 'unavailable' | 'failed';
export interface PrInboxIdentity { host: string; login: string; key: string }
export interface PrInboxError { kind: PrInboxStatus; message: string; retryAt: number | null }
export type PrInboxChecks = 'unknown' | 'none' | 'passing' | 'failing' | 'pending' | 'skipped' | 'cancelled';
export interface PrInboxItem {
  key: string; target: PrTarget; url: string; title: string;
  author: { login: string; avatarUrl: string | null } | null;
  state: PrState; relations: PrRelation[]; updatedAt: string;
  headSha: string | null; baseSha: string | null;
  enrichment: 'idle' | 'ready' | 'error'; checks: PrInboxChecks;
  reviewDecision: string | null; mergeable: string | null; mergeStateStatus: string | null;
  attentionReasons: Array<'reviewRequested' | 'conflict' | 'checksFailed' | 'changesRequested'>;
}
export interface PrRelationPage {
  relation: PrRelation; nextPage: number | null; loadedCount: number;
  reportedTotal: number | null; complete: boolean; incompleteResults: boolean; error: string | null;
}
export type PrInboxFilterState = 'openAndDraft' | 'open' | 'draft' | 'merged' | 'closed' | 'all';
export interface PrInboxQuery { state: PrInboxFilterState; repository: string | null }
export interface PrInboxList {
  identity: PrInboxIdentity | null; items: PrInboxItem[]; pages: PrRelationPage[];
  complete: boolean; stale: boolean; syncedAt: number | null; error: PrInboxError | null;
  revision: number;
}
export interface PrInboxDetail {
  target: PrTarget; identity: PrInboxIdentity; item: PrInboxItem; body: string;
  createdAt: string; baseRefName: string; headRefName: string; headRepository: string | null;
  additions: number; deletions: number; changedFiles: number;
  checks: PrCheckDetail[]; checksError: string | null; syncedAt: number;
}
export type PrActivityKind = 'comments' | 'reviews' | 'threads' | 'threadComments' | 'commits';
export interface PrActivityCommit { sha: string; title: string; author: string | null; createdAt: number | null }
export interface PrActivityPage {
  headSha: string; comments: PrReviewComment[]; reviews: PrReviewSummary[]; threads: PrReviewThread[];
  commits?: PrActivityCommit[];
  nextCursor: string | null; threadCursors: Record<string, string | null>;
}
export interface PrInboxFile {
  path: string; previousPath: string | null; status: string; additions: number; deletions: number;
  patch: string | null; patchTruncated: boolean; url: string | null;
}
export interface PrInboxFiles {
  target: PrTarget; headSha: string; baseSha: string; files: PrInboxFile[];
  nextPage: number | null; expectedCount: number; limited: boolean;
  diffTruncated: boolean; diffError: string | null;
}

/** 让 Agent 回应审阅意见：只读取、开工作树、本地提交；推送与回复必须经用户确认。 */
export interface PrFeedbackComment { author: string | null; body: string; url: string | null }
export interface PrFeedbackThread {
  id: string; path: string | null; line: number | null; outdated: boolean;
  comments: PrFeedbackComment[]; moreComments: boolean;
}
export interface PrFeedbackReview { id: string; author: string | null; body: string; url: string | null }
/** 不能把修改推回 PR 分支的原因；仍可在本地修改。 */
export type PrPushBlocker = 'notOpen' | 'fork' | 'noBranch';
export interface PrLocalCheckout { path: string; remote: string }
export interface PrReviewResponsePlan {
  target: PrTarget; headSha: string; headRefName: string;
  pushBlocker: PrPushBlocker | null;
  threads: PrFeedbackThread[]; reviews: PrFeedbackReview[]; threadsIncomplete: boolean;
  checkouts: PrLocalCheckout[];
}
export interface PrReviewResponseStartInput {
  target: PrTarget; headSha: string; workspace: string; threadIds: string[]; note: string;
}
export type PrReviewResponseStatus = 'working' | 'published' | 'discarded';
export interface PrReviewResponseRun {
  id: string; target: PrTarget; title: string; headSha: string; headRefName: string;
  remote: string; source: string; worktree: string; branch: string; conversationId: string;
  threadIds: string[]; /** 已经成功回复过的线程；重试发布时不会再次回复。 */ repliedThreadIds: string[];
  pushBlocker: PrPushBlocker | null; status: PrReviewResponseStatus;
  createdAt: number; publishedAt: number | null;
}
export interface PrReviewResponseCommit { sha: string; subject: string; threadIds: string[]; reply: string }
export interface PrReviewResponseDraft {
  threadId: string; path: string | null; line: number | null; body: string; commitSha: string | null;
  /** 已解决的线程不再回复；这里只列出本次选择的线程。 */
  selected: boolean; resolve: boolean;
}
export interface PrReviewResponseReview {
  run: PrReviewResponseRun; tipSha: string; currentHeadSha: string | null; headMoved: boolean;
  dirtyFiles: string[]; commits: PrReviewResponseCommit[]; diffStat: string; drafts: PrReviewResponseDraft[];
  /** 已被 GitHub 解决或已不存在的线程 id；发布时跳过。 */
  closedThreadIds: string[];
}
export interface PrReviewResponsePublishInput {
  runId: string; requestId: string; identityKey: string; tipSha: string;
  replies: Array<{ threadId: string; body: string; resolve: boolean }>;
}
export interface PrReviewResponsePublishResult {
  push: { state: 'pushed' | 'skipped' | 'failed'; message: string };
  replies: Array<{ threadId: string; state: 'posted' | 'resolved' | 'failed' | 'skipped'; message: string; url: string | null }>;
  run: PrReviewResponseRun;
}
export interface PrReadOptions { requestId: string; identityKey: string; force?: boolean }
export interface PrInboxApi {
  list(query: PrInboxQuery, options: { requestId: string; force?: boolean; more?: boolean; revision?: number }): Promise<PrInboxList>;
  enrich(targets: PrTarget[], options: PrReadOptions): Promise<PrInboxItem[]>;
  detail(target: PrTarget, options: PrReadOptions): Promise<PrInboxDetail>;
  activity(target: PrTarget, kind: PrActivityKind, cursor: string | null, headSha: string, threadId: string | null, options: PrReadOptions): Promise<PrActivityPage>;
  files(target: PrTarget, page: number, headSha: string, baseSha: string, options: PrReadOptions): Promise<PrInboxFiles>;
  comment(target: PrTarget, body: string, options: { requestId: string; identityKey: string }): Promise<PrReviewComment>;
  cancel(requestId: string): Promise<void>;
  responsePrepare(target: PrTarget, options: PrReadOptions): Promise<PrReviewResponsePlan>;
  responseStart(input: PrReviewResponseStartInput, options: { requestId: string; identityKey: string }): Promise<PrReviewResponseRun>;
  responseRuns(target: PrTarget): Promise<PrReviewResponseRun[]>;
  responseReview(runId: string, options: PrReadOptions): Promise<PrReviewResponseReview>;
  responsePublish(input: PrReviewResponsePublishInput): Promise<PrReviewResponsePublishResult>;
  responseDiscard(runId: string, removeWorktree: boolean): Promise<PrReviewResponseRun>;
  open(target: PrTarget, url: string): Promise<void>;
  openTerminal(): Promise<void>;
}
