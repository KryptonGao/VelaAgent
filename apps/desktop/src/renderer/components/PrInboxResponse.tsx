import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type {
  PrInboxDetail, PrPushBlocker, PrReviewResponsePlan, PrReviewResponsePublishResult, PrReviewResponseReview, PrReviewResponseRun,
} from '@vela/shared';
import { tr, trf } from '../locale';
import { usePrInboxCache } from '../hooks/usePrInboxCache';

const maxThreads = 40;
function message(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}
function blockerText(blocker: PrPushBlocker): string {
  return blocker === 'fork' ? tr('这个 PR 来自分叉仓库，Vela 不能推送到作者的分支。Agent 仍可在本地修改，之后请手动处理。', 'This PR comes from a fork, so Vela cannot push to the author’s branch. The agent can still make local changes; handle them manually afterwards.')
    : blocker === 'notOpen' ? tr('这个 PR 已不是打开状态，不能推送。', 'This PR is no longer open, so it cannot be pushed to.')
    : tr('无法确定 PR 的分支，不能推送。', 'The PR branch is unknown, so it cannot be pushed to.');
}

function Modal({ title, busy, onClose, wide, children }: { title: string; busy: boolean; onClose: () => void; wide?: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null); const heading = useId();
  useEffect(() => {
    const dialog = ref.current; const opener = document.activeElement;
    dialog?.showModal();
    return () => { dialog?.close(); if (opener instanceof HTMLElement && opener.isConnected) opener.focus(); };
  }, []);
  return <dialog ref={ref} className={`pr-response-dialog${wide ? ' is-wide' : ''}`} aria-labelledby={heading}
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }} onKeyDown={event => event.stopPropagation()}>
    <header><h2 id={heading}>{title}</h2><button type="button" aria-label={tr('关闭', 'Close')} disabled={busy} onClick={onClose}>×</button></header>
    {children}
  </dialog>;
}

function StartDialog({ detail, onClose, onStarted }: { detail: PrInboxDetail; onClose: () => void; onStarted: (run: PrReviewResponseRun) => void }) {
  const { api } = usePrInboxCache();
  const { target, identity } = detail;
  const [plan, setPlan] = useState<PrReviewResponsePlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [workspace, setWorkspace] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false); const requestId = useRef(crypto.randomUUID());
  useEffect(() => {
    let live = true; const id = crypto.randomUUID();
    api.responsePrepare(target, { requestId: id, identityKey: identity.key, force: true }).then(next => {
      if (!live) return;
      setPlan(next); setWorkspace(next.checkouts[0]?.path ?? '');
      setPicked(new Set(next.threads.filter(t => !t.outdated).slice(0, maxThreads).map(t => t.id)));
    }, reason => { if (live) setError(message(reason)); });
    return () => { live = false; void api.cancel(id).catch(() => undefined); };
  }, [api, target, identity.key]);
  const toggle = (id: string) => setPicked(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else if (next.size < maxThreads) next.add(id); return next; });
  const start = async () => {
    if (!plan || pending.current || !picked.size || !workspace) return;
    pending.current = true; setBusy(true); setError(null);
    try {
      const run = await api.responseStart({ target, headSha: plan.headSha, workspace, threadIds: plan.threads.filter(t => picked.has(t.id)).map(t => t.id), note }, { requestId: requestId.current, identityKey: identity.key });
      onStarted(run);
    } catch (reason) { setError(message(reason)); requestId.current = crypto.randomUUID(); }
    finally { pending.current = false; setBusy(false); }
  };
  return <Modal title={tr('让 Agent 回应审阅意见', 'Let the agent respond to review')} busy={busy} onClose={onClose}>
    <div className="pr-response-body">
      {!plan && !error && <p role="status">{tr('正在读取审阅意见…', 'Reading review feedback…')}</p>}
      {error && <p className="pr-inbox-notice" role="alert">{error}</p>}
      {plan && <>
        <p className="pr-response-intro">{tr('Agent 会在独立的工作树里修改并本地提交。它不会推送，也不会回复；这两步要等你检查后再确认。', 'The agent works in a separate worktree and commits locally. It will not push or reply; you confirm both after reviewing.')}</p>
        {plan.pushBlocker && <p className="pr-inbox-notice">{blockerText(plan.pushBlocker)}</p>}
        {plan.threadsIncomplete && <p className="pr-inbox-notice">{tr('审阅线程过多，只读取了前面的一部分。', 'There are many review threads; only the first ones were loaded.')}</p>}
        {!plan.checkouts.length && <p className="pr-inbox-notice" role="alert">{trf('没有找到 {0}/{1} 的本机检出。请先把它作为工作区打开一次。', 'No local checkout of {0}/{1} was found. Open it as a workspace once first.', target.owner, target.repo)}</p>}
        {!plan.threads.length && <p className="pr-inbox-meta">{tr('没有未解决的审阅线程。', 'There are no unresolved review threads.')}</p>}
        <ul className="pr-response-threads">{plan.threads.map(thread => <li key={thread.id}><label>
          <input type="checkbox" checked={picked.has(thread.id)} disabled={busy || !picked.has(thread.id) && picked.size >= maxThreads} onChange={() => toggle(thread.id)}/>
          <span><code>{thread.path ?? tr('整体', 'General')}{thread.line ? `:${thread.line}` : ''}</code>{thread.outdated && <em>{tr('已过期', 'Outdated')}</em>}
            <span className="pr-response-quote">@{thread.comments[0]?.author ?? '—'}: {(thread.comments[0]?.body ?? '').replace(/\s+/g, ' ').slice(0, 220)}</span></span>
        </label></li>)}</ul>
        {plan.reviews.length > 0 && <details className="pr-response-reviews"><summary>{trf('{0} 条要求修改的审阅摘要（仅供参考）', '{0} change-request review summaries (context only)', plan.reviews.length)}</summary>
          {plan.reviews.map(review => <p key={review.id}><strong>@{review.author ?? '—'}</strong> {review.body.slice(0, 400)}</p>)}</details>}
        {plan.checkouts.length > 0 && <label className="pr-response-field">{tr('本机检出', 'Local checkout')}
          <select value={workspace} disabled={busy} onChange={e => setWorkspace(e.target.value)}>{plan.checkouts.map(c => <option key={c.path} value={c.path}>{c.path}</option>)}</select></label>}
        <label className="pr-response-field">{tr('补充要求（可选）', 'Extra instructions (optional)')}
          <textarea rows={2} maxLength={4000} value={note} disabled={busy} onChange={e => setNote(e.target.value)}/></label>
      </>}
    </div>
    <footer><button type="button" disabled={busy} onClick={onClose}>{tr('取消', 'Cancel')}</button>
      <button type="button" className="is-primary" disabled={busy || !plan || !picked.size || !workspace} onClick={() => void start()}>{busy ? tr('正在启动…', 'Starting…') : trf('开始处理 {0} 条意见', 'Start on {0} thread(s)', picked.size)}</button></footer>
  </Modal>;
}

interface DraftState { selected: boolean; body: string; resolve: boolean }

function PublishDialog({ run, identityKey, onClose, onChanged }: { run: PrReviewResponseRun; identityKey: string; onClose: () => void; onChanged: () => void }) {
  const { api } = usePrInboxCache();
  const [review, setReview] = useState<PrReviewResponseReview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, DraftState>>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PrReviewResponsePublishResult | null>(null);
  const pending = useRef(false); const attempt = useRef<{ key: string; requestId: string } | null>(null);
  const load = useCallback(() => {
    setReview(null); setError(null); setResult(null);
    api.responseReview(run.id, { requestId: crypto.randomUUID(), identityKey, force: true }).then(next => {
      setReview(next);
      setDrafts(Object.fromEntries(next.drafts.map(d => [d.threadId, { selected: d.selected, body: d.body, resolve: d.resolve }])));
    }, reason => setError(message(reason)));
  }, [api, run.id, identityKey]);
  useEffect(() => { load(); }, [load]);
  const picked = review ? review.drafts.filter(d => drafts[d.threadId]?.selected) : [];
  const emptyPicked = picked.some(d => !drafts[d.threadId]?.body.trim());
  const blockedBy = run.pushBlocker ? blockerText(run.pushBlocker) : review?.dirtyFiles.length ? tr('工作树里还有未提交的改动，请先让 Agent 提交，或自己处理后再回来。', 'The worktree has uncommitted changes. Ask the agent to commit them, or handle them yourself, then come back.')
    : review && !review.commits.length ? tr('Agent 还没有产生任何提交。', 'The agent has not made any commits yet.') : null;
  const publish = async () => {
    if (!review || pending.current || blockedBy || emptyPicked) return;
    const replies = picked.map(d => ({ threadId: d.threadId, body: drafts[d.threadId]!.body.trim(), resolve: drafts[d.threadId]!.resolve }));
    const key = JSON.stringify([review.tipSha, replies]);
    if (attempt.current?.key !== key) attempt.current = { key, requestId: crypto.randomUUID() };
    pending.current = true; setBusy(true); setError(null);
    try { setResult(await api.responsePublish({ runId: run.id, requestId: attempt.current.requestId, identityKey, tipSha: review.tipSha, replies })); onChanged(); }
    catch (reason) { setError(message(reason)); }
    finally { pending.current = false; setBusy(false); }
  };
  const finished = result && result.push.state === 'pushed' && result.replies.every(r => r.state !== 'failed');
  return <Modal title={tr('检查并发布', 'Review and publish')} busy={busy} onClose={onClose} wide>
    <div className="pr-response-body">
      {!review && !error && <p role="status">{tr('正在读取工作树…', 'Reading the worktree…')}</p>}
      {error && <p className="pr-inbox-notice" role="alert">{error}</p>}
      {review && !result && <>
        {review.headMoved && <p className="pr-inbox-notice">{tr('PR 在 GitHub 上已有新提交。推送时若分支已前进会被拒绝，不会覆盖别人的提交。', 'The PR has new commits on GitHub. If the branch moved on, the push is rejected and nothing is overwritten.')}</p>}
        {blockedBy && <p className="pr-inbox-notice" role="alert">{blockedBy}{review.dirtyFiles.length > 0 && <code className="pr-response-files">{review.dirtyFiles.join('\n')}</code>}</p>}
        {review.closedThreadIds.length > 0 && <p className="pr-inbox-meta">{trf('{0} 条意见已在 GitHub 上解决，已跳过。', '{0} thread(s) were already resolved on GitHub and are skipped.', review.closedThreadIds.length)}</p>}
        <h3>{trf('将推送的提交（{0}）', 'Commits to push ({0})', review.commits.length)}</h3>
        <ul className="pr-response-commits">{review.commits.map(c => <li key={c.sha}><code>{c.sha.slice(0, 7)}</code> {c.subject}</li>)}</ul>
        {review.diffStat && <pre className="pr-response-stat">{review.diffStat}</pre>}
        <h3>{tr('回复草稿', 'Reply drafts')}</h3>
        {!review.drafts.length && <p className="pr-inbox-meta">{tr('没有可回复的线程。', 'No threads left to reply to.')}</p>}
        {review.drafts.map(draft => { const state = drafts[draft.threadId]; if (!state) return null; return <div className="pr-response-draft" key={draft.threadId}>
          <label className="pr-response-draft-head"><input type="checkbox" checked={state.selected} disabled={busy} onChange={e => setDrafts(d => ({ ...d, [draft.threadId]: { ...state, selected: e.target.checked } }))}/>
            <code>{draft.path ?? tr('整体', 'General')}{draft.line ? `:${draft.line}` : ''}</code>{!draft.commitSha && <em>{tr('没有对应提交，请自己写回复', 'No matching commit; write the reply yourself')}</em>}</label>
          <textarea rows={3} value={state.body} disabled={busy || !state.selected} aria-label={tr('回复内容', 'Reply text')} onChange={e => setDrafts(d => ({ ...d, [draft.threadId]: { ...state, body: e.target.value } }))}/>
          <label className="pr-response-resolve"><input type="checkbox" checked={state.resolve} disabled={busy || !state.selected} onChange={e => setDrafts(d => ({ ...d, [draft.threadId]: { ...state, resolve: e.target.checked } }))}/>{tr('回复后标记为已解决', 'Mark as resolved after replying')}</label>
        </div>; })}
      </>}
      {result && <div className="pr-response-result" role="status">
        <p className={result.push.state === 'pushed' ? 'is-ok' : 'is-bad'}>{result.push.state === 'pushed' ? tr('已推送：', 'Pushed: ') : tr('推送失败：', 'Push failed: ')}{result.push.message}</p>
        {result.replies.map(r => <p key={r.threadId} className={r.state === 'failed' ? 'is-bad' : r.state === 'skipped' ? '' : 'is-ok'}>
          {r.state === 'resolved' ? tr('已回复并解决', 'Replied and resolved') : r.state === 'posted' ? tr('已回复', 'Replied') : r.state === 'skipped' ? tr('已跳过', 'Skipped') : tr('回复失败', 'Reply failed')}
          {' · '}<code>{review?.drafts.find(d => d.threadId === r.threadId)?.path ?? r.threadId}</code>{r.message && ` — ${r.message}`}</p>)}
      </div>}
    </div>
    <footer>{result && !finished && <button type="button" disabled={busy} onClick={load}>{tr('重新读取', 'Reload')}</button>}
      <button type="button" disabled={busy} onClick={onClose}>{finished ? tr('完成', 'Done') : tr('关闭', 'Close')}</button>
      {review && !result && <button type="button" className="is-primary" disabled={busy || !!blockedBy || emptyPicked || !review.commits.length}
        onClick={() => void publish()}>{busy ? tr('正在发布…', 'Publishing…') : trf('推送 {0} 个提交并回复 {1} 条', 'Push {0} commit(s) and post {1} repl(ies)', review.commits.length, picked.length)}</button>}
    </footer>
  </Modal>;
}

/** 概览侧栏里的入口：开始一次回应、查看进行中的回应、检查并发布。仅对自己创建的打开中 PR 显示。 */
export function PrResponsePanel({ detail, active, onOpenConversation, onPublished }: { detail: PrInboxDetail; active: boolean; onOpenConversation: (id: string) => void; onPublished: () => void }) {
  const { api } = usePrInboxCache();
  const { target, identity, item } = detail;
  const [runs, setRuns] = useState<PrReviewResponseRun[]>([]);
  const [dialog, setDialog] = useState<'start' | { publish: PrReviewResponseRun } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const eligible = (item.state === 'open' || item.state === 'draft') && item.author?.login.toLowerCase() === identity.login.toLowerCase();
  const refresh = useCallback(() => { api.responseRuns(target).then(setRuns, reason => setError(message(reason))); }, [api, target]);
  useEffect(() => { if (active && eligible) refresh(); }, [active, eligible, refresh]);
  if (!eligible) return null;
  const discard = async (run: PrReviewResponseRun, removeWorktree: boolean) => {
    setConfirming(null);
    try { await api.responseDiscard(run.id, removeWorktree); refresh(); } catch (reason) { setError(message(reason)); }
  };
  return <section className="pr-response" aria-label={tr('Agent 回应审阅', 'Agent review response')}>
    <h2>{tr('Agent 回应审阅', 'Agent review response')}</h2>
    <p className="pr-inbox-status-sub">{tr('读取未解决的意见，在独立工作树里修改并提交；检查后再推送并回复。', 'Reads unresolved feedback, fixes it in a separate worktree and commits; you review before it pushes and replies.')}</p>
    <button type="button" className="pr-response-start" onClick={() => setDialog('start')}>{tr('让 Agent 回应审阅意见', 'Respond to review with agent')}</button>
    {error && <p className="pr-inbox-notice" role="alert">{error}</p>}
    {runs.map(run => <div className="pr-response-run" key={run.id}>
      <p><strong>{run.status === 'published' ? tr('已发布', 'Published') : tr('处理中', 'In progress')}</strong> · {trf('{0} 条意见', '{0} thread(s)', run.threadIds.length)} · <time dateTime={new Date(run.createdAt).toISOString()}>{new Date(run.createdAt).toLocaleString()}</time></p>
      <div className="pr-response-actions">
        <button type="button" onClick={() => onOpenConversation(run.conversationId)}>{tr('打开对话', 'Open chat')}</button>
        {run.status === 'working' && <button type="button" onClick={() => setDialog({ publish: run })}>{tr('检查并发布', 'Review & publish')}</button>}
        {confirming === run.id ? <><button type="button" onClick={() => void discard(run, true)}>{tr('移除工作树', 'Remove worktree')}</button><button type="button" onClick={() => void discard(run, false)}>{tr('只隐藏', 'Just hide')}</button><button type="button" onClick={() => setConfirming(null)}>{tr('取消', 'Cancel')}</button></>
          : <button type="button" onClick={() => setConfirming(run.id)}>{tr('放弃', 'Discard')}</button>}
      </div>
      {confirming === run.id && <p className="pr-inbox-status-sub">{tr('本地分支和其中的提交会保留。', 'The local branch and its commits are kept.')}</p>}
    </div>)}
    {dialog === 'start' && <StartDialog detail={detail} onClose={() => setDialog(null)} onStarted={run => { setDialog(null); refresh(); onOpenConversation(run.conversationId); }}/>}
    {dialog && dialog !== 'start' && <PublishDialog run={dialog.publish} identityKey={identity.key} onClose={() => { setDialog(null); refresh(); }} onChanged={() => { refresh(); onPublished(); }}/>}
  </section>;
}
