import type { PrInboxItem, PrInboxChecks, PrTarget, PrRelation, PrInboxFile } from '@vela/shared';
import { mapCheckState, readPrState } from './pull-request-service';

export function record(value: unknown): Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}
export function targetKey(target: PrTarget): string {
  return `${target.host}/${target.owner}/${target.repo}#${target.number}`.toLowerCase();
}
export function validateTarget(value: unknown): PrTarget {
  const t = record(value);
  if (t.host !== 'github.com' || typeof t.owner !== 'string' || typeof t.repo !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,99}$/.test(t.owner ?? '') ||
      !/^[a-zA-Z0-9_.-]{1,100}$/.test(t.repo ?? '') || ['.', '..'].includes(t.repo) ||
      !Number.isSafeInteger(t.number) || t.number < 1) throw new Error('无效的 Pull Request 目标');
  return { host: t.host, owner: t.owner, repo: t.repo, number: t.number };
}
export function safeGithubUrl(value: unknown, target: PrTarget): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== target.host || url.port || url.username || url.password) return null;
    const prefix = `/${target.owner}/${target.repo}/`.toLowerCase();
    return url.pathname.toLowerCase().startsWith(prefix) ? url.href : null;
  } catch { return null; }
}
export function searchItem(value: unknown, relation: PrRelation): PrInboxItem {
  const item = record(value);
  const url = new URL(item.html_url);
  const parts = url.pathname.split('/');
  const target = validateTarget({ host: url.hostname, owner: parts[1], repo: parts[2], number: item.number });
  if (parts[3] !== 'pull' || Number(parts[4]) !== target.number || !safeGithubUrl(item.html_url, target)) throw new Error('搜索返回了无效 PR');
  const pr = record(item.pull_request);
  const state = readPrState({ state: pr.merged_at ? 'MERGED' : item.state, isDraft: item.draft });
  return {
    key: targetKey(target), target, url: item.html_url, title: String(item.title ?? ''),
    author: item.user?.login ? { login: item.user.login, avatarUrl: item.user.avatar_url ?? null } : null,
    state, relations: [relation], updatedAt: item.updated_at ?? '', headSha: null, baseSha: null,
    enrichment: 'idle', checks: 'unknown', reviewDecision: null, mergeable: null, mergeStateStatus: null,
    attentionReasons: relation === 'reviewRequested' && (state === 'open' || state === 'draft') ? ['reviewRequested'] : [],
  };
}
export function checkSummary(values: unknown, complete = true): PrInboxChecks {
  if (!Array.isArray(values) || !complete) return 'unknown';
  if (values.length === 0) return 'none';
  const states = values.map(value => {
    const c = record(value);
    return mapCheckState(c.bucket ?? null, c.conclusion ?? c.state ?? c.status ?? null);
  });
  for (const state of ['failing', 'pending', 'unknown', 'cancelled', 'skipped'] as const) if (states.includes(state)) return state;
  return states.every(s => s === 'passing') ? 'passing' : 'unknown';
}
export function enrichItem(base: PrInboxItem, value: unknown): PrInboxItem {
  const pr = record(value);
  const head = record(pr.commits).nodes?.[0]?.commit;
  const rollup = head?.statusCheckRollup?.contexts;
  const checks = checkSummary(pr.statusCheckRollup ?? rollup?.nodes ?? (head?.statusCheckRollup === null ? [] : undefined), !rollup?.pageInfo?.hasNextPage);
  const state = readPrState(pr);
  const result: PrInboxItem = {
    ...base, state, title: typeof pr.title === 'string' ? pr.title : base.title, url: safeGithubUrl(pr.url, base.target) ?? base.url, updatedAt: pr.updatedAt ?? base.updatedAt,
    author: pr.author?.login ? { login: pr.author.login, avatarUrl: pr.author.avatarUrl ?? null } : base.author, headSha: pr.headRefOid ?? null, baseSha: pr.baseRefOid ?? null, enrichment: 'ready', checks,
    reviewDecision: pr.reviewDecision ?? null, mergeable: pr.mergeable ?? null, mergeStateStatus: pr.mergeStateStatus ?? null,
    attentionReasons: [],
  };
  if (state === 'open' || state === 'draft') {
    if (base.relations.includes('reviewRequested')) result.attentionReasons.push('reviewRequested');
    if (pr.mergeable === 'CONFLICTING') result.attentionReasons.push('conflict');
    if (checks === 'failing') result.attentionReasons.push('checksFailed');
    if (pr.reviewDecision === 'CHANGES_REQUESTED') result.attentionReasons.push('changesRequested');
  }
  return result;
}
export function fileItem(value: unknown, target: PrTarget): PrInboxFile {
  const f = record(value);
  if (typeof f.filename !== 'string' || !f.filename) throw new Error('文件响应无效');
  return { path: f.filename, previousPath: f.previous_filename ?? null, status: f.status ?? 'modified',
    additions: f.additions ?? 0, deletions: f.deletions ?? 0, patch: typeof f.patch === 'string' ? f.patch : null,
    patchTruncated: typeof f.patch === 'string' && patchIncomplete(f.patch, f.additions ?? 0, f.deletions ?? 0),
    url: safeGithubUrl(f.blob_url, target) };
}

export function patchIncomplete(patch: string, additions: number, deletions: number): boolean {
  let inHunk = false; let added = 0; let deleted = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) { inHunk = false; continue; }
    if (line.startsWith('@@')) { inHunk = true; continue; }
    if (!inHunk) continue;
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) deleted++;
  }
  return added !== additions || deleted !== deletions;
}

// Paths come from the files API. Only attach sections whose new path can be decoded exactly.
function decodePath(path: string, prefixed = true): string | null {
  let text = path.trim();
  if (text.startsWith('"')) {
    if (!text.endsWith('"')) return null;
    text = text.slice(1, -1);
    const bytes: number[] = [];
    for (let i = 0; i < text.length;) {
      if (text[i] !== '\\') { const cp = text.codePointAt(i)!; bytes.push(...Buffer.from(String.fromCodePoint(cp))); i += cp > 0xffff ? 2 : 1; continue; }
      const octal = text.slice(i + 1).match(/^[0-7]{1,3}/);
      if (octal) { bytes.push(parseInt(octal[0], 8)); i += octal[0].length + 1; continue; }
      const escapes: Record<string, string> = { t: '\t', n: '\n', r: '\r', '"': '"', '\\': '\\' };
      const next = escapes[text[i + 1]];
      if (next === undefined) return null;
      bytes.push(...Buffer.from(next)); i += 2;
    }
    text = Buffer.from(bytes).toString('utf8');
  }
  return text === '/dev/null' ? null : prefixed ? text.replace(/^[ab]\//, '') : text;
}
export function pairRemoteDiff(diff: string, files: PrInboxFile[], truncated: boolean): Map<string, string> {
  const sections = diff.split(/(?=^diff --git )/m).filter(s => s.startsWith('diff --git '));
  if (truncated) sections.pop(); // Last section may end in the middle of a hunk.
  const paths = new Set(files.map(f => f.path));
  const paired = new Map<string, string>();
  for (const section of sections) {
    const newPath = section.match(/^\+\+\+ (.+)$/m)?.[1];
    const oldPath = section.match(/^--- (.+)$/m)?.[1];
    const renamed = section.match(/^rename to (.+)$/m)?.[1];
    const path = newPath && newPath !== '/dev/null' ? decodePath(newPath) : renamed ? decodePath(renamed, false) : oldPath ? decodePath(oldPath) : null;
    if (path !== null && paths.has(path) && !paired.has(path)) paired.set(path, section);
  }
  return paired;
}
