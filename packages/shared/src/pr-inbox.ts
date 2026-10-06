import type { PrCheckDetail, PrReviewComment, PrReviewSummary, PrReviewThread, PrState } from './index';

export const PrInboxIpc = {
  list: 'pr-inbox:list', enrich: 'pr-inbox:enrich', detail: 'pr-inbox:detail',
  activity: 'pr-inbox:activity', files: 'pr-inbox:files', cancel: 'pr-inbox:cancel',
  open: 'pr-inbox:open', terminal: 'pr-inbox:terminal', comment: 'pr-inbox:comment',
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
export interface PrReadOptions { requestId: string; identityKey: string; force?: boolean }
export interface PrInboxApi {
  list(query: PrInboxQuery, options: { requestId: string; force?: boolean; more?: boolean; revision?: number }): Promise<PrInboxList>;
  enrich(targets: PrTarget[], options: PrReadOptions): Promise<PrInboxItem[]>;
  detail(target: PrTarget, options: PrReadOptions): Promise<PrInboxDetail>;
  activity(target: PrTarget, kind: PrActivityKind, cursor: string | null, headSha: string, threadId: string | null, options: PrReadOptions): Promise<PrActivityPage>;
  files(target: PrTarget, page: number, headSha: string, baseSha: string, options: PrReadOptions): Promise<PrInboxFiles>;
  comment(target: PrTarget, body: string, options: { requestId: string; identityKey: string }): Promise<PrReviewComment>;
  cancel(requestId: string): Promise<void>;
  open(target: PrTarget, url: string): Promise<void>;
  openTerminal(): Promise<void>;
}
