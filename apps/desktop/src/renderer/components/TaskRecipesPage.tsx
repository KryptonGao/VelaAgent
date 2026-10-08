import type { AppLocale } from "@vela/shared";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ModelCatalog, RecipeParameter, RecipePreview, RecipeRun, RecipeUseDraft, RecipeValue, TaskRecipe, TaskRecipeInput, TaskRecipesState } from '@vela/shared';
import { parseRecipeInput, recipeDefaults, validateRecipe, validateRecipeValues } from '@vela/shared';
import { tr } from '../locale';
import '../task-recipes.css';
import { RecipeGeneratePanel, RecipeSchedulePanel } from './RecipeEnhancements';
import { RecipeStageEditor, RecipeStagePreview, RecipeRunProgress, RecipeRunOutcome, RecipeComparison, RecipeTeamPanel } from './RecipeWorkflow';
import { CloseIcon, PlusIcon, SparkIcon } from './icons';

export interface RecipeMessageSeed { text: string; conversationId: string; messageId?: string; planId?: string }
export interface TaskRecipesPageProps {
  catalog: ModelCatalog | null; workspace: string | null; workspaces: string[]; locale: AppLocale;
  sidebarCollapsed: boolean; onToggleSidebar: () => void; onOpenConversation: (id: string) => void;
  selectedRecipe?: TaskRecipe | null; onConsumeSelection?: () => void;
  seed?: RecipeMessageSeed | null; onConsumeSeed: () => void;
  registerLeaveGuard: (guard: ((action: () => void) => void) | null) => void;
}
const matchedValues = (recipe: TaskRecipeInput, values: Record<string, RecipeValue>) => ({ ...recipeDefaults(recipe), ...Object.fromEntries(Object.entries(values).filter(([id]) => recipe.parameters.some(p => p.id === id))) });
const blankRecipe = (): TaskRecipeInput => ({ name: '', description: '', tags: [], defaultMode: 'agent', parameters: [], objectiveTemplate: '', workflowTemplate: '', deliverableTemplate: '' });
const api = () => window.vela?.taskRecipes;
const status = (run: RecipeRun) => ({ starting: tr('正在启动', 'Starting'), running: tr('运行中', 'Running'), waiting_for_user: tr('等待响应', 'Waiting for user'), responded: tr('回复已生成', 'Reply generated'), failed: tr('失败', 'Failed'), stopped: tr('已停止', 'Stopped'), interrupted: tr('已中断', 'Interrupted') })[run.status];
const date = (time: number | null) => time ? new Date(time).toLocaleString() : tr('尚未使用', 'Not used yet');
type Editor = { recipe: TaskRecipeInput; original: string; id?: string; revision?: number; projectWorkspace?: string; teamWorkspace?: string; teamFingerprint?: string };

export function TaskRecipesPage(props: TaskRecipesPageProps) {
  const [state, setState] = useState<TaskRecipesState>({ recipes: [], runs: [], error: null });
  const [loading, setLoading] = useState(true); const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState(''); const [origin, setOrigin] = useState('all');
  const [editor, setEditor] = useState<Editor | null>(null); const [using, setUsing] = useState<{ recipe: TaskRecipe; run?: RecipeRun } | null>(null);
  const [pending, setPending] = useState(false); const [deleting, setDeleting] = useState<TaskRecipe | null>(null);
  const [leave, setLeave] = useState<(() => void) | null>(null); const [fields, setFields] = useState<Record<string, string>>({});
  const [history, setHistory] = useState<string | null>(null); const [page, setPage] = useState(0);
  const [generating, setGenerating] = useState(false); const [imports, setImports] = useState<TaskRecipeInput[]>([]); const [notice, setNotice] = useState('');
  const editorRef = useRef(editor); editorRef.current = editor;
  const refresh = useCallback(async () => {
    if (!api()) { setError(tr('请在桌面应用中打开任务配方。', 'Task Recipes requires the desktop app.')); setLoading(false); return; }
    try { setState(await api()!.list(props.locale)); setError(null); } catch (e) { setError(String((e as Error).message)); }
    finally { setLoading(false); }
  }, [props.locale, props.workspace, props.workspaces]);
  useEffect(() => { void refresh(); return api()?.subscribe(() => { void refresh(); }); }, [refresh]);
  useEffect(() => { const focus = () => { void refresh(); }; window.addEventListener('focus', focus); return () => window.removeEventListener('focus', focus); }, [refresh]);
  const guard = useCallback((action: () => void) => {
    const current = editorRef.current;
    if (current && JSON.stringify(current.recipe) !== current.original) setLeave(() => action); else action();
  }, []);
  useEffect(() => { props.registerLeaveGuard(guard); return () => props.registerLeaveGuard(null); }, [guard, props.registerLeaveGuard]);
  useEffect(() => {
    if (!props.seed) return;
    const recipe: TaskRecipeInput = { ...blankRecipe(), defaultMode: props.seed.planId ? 'plan' : 'agent', workflowTemplate: props.seed.text, sourceReference: { conversationId: props.seed.conversationId, ...(props.seed.planId ? { planId: props.seed.planId } : { messageId: props.seed.messageId }) } };
    setEditor({ recipe, original: JSON.stringify(blankRecipe()) }); setUsing(null); props.onConsumeSeed();
  }, [props.seed, props.onConsumeSeed]);
  useEffect(() => {
    if (!props.selectedRecipe) return;
    guard(() => { setEditor(null); setUsing({ recipe: props.selectedRecipe! }); setError(null); props.onConsumeSelection?.(); });
  }, [props.selectedRecipe, props.onConsumeSelection, guard]);
  const edit = (recipe?: TaskRecipe, copy = false) => guard(() => {
    const input = recipe ? parseRecipeInput(recipe) : blankRecipe();
    if (copy) input.name = `${input.name} ${tr('副本', 'copy')}`.slice(0, 80);
    setEditor({ recipe: input, original: JSON.stringify(input), ...(recipe && !copy ? { id: recipe.id, revision: recipe.revision, projectWorkspace: recipe.projectWorkspace, teamWorkspace: recipe.teamWorkspace, teamFingerprint: recipe.teamFingerprint } : {}) }); setUsing(null); setGenerating(false); setFields({}); setError(null);
  });
  const save = async (): Promise<boolean> => {
    const current = editorRef.current; if (!current || !api()) return false;
    const errors = validateRecipe(current.recipe); setFields(errors);
    if (Object.keys(errors).length) { requestAnimationFrame(() => document.querySelector<HTMLElement>('.recipe-editor [aria-invalid=true]')?.focus()); return false; }
    setPending(true);
    try { if (current.teamWorkspace) await api()!.saveTeam(current.recipe, current.teamWorkspace, current.id, current.revision, current.teamFingerprint); else await api()!.save(current.recipe, current.id, current.revision, current.projectWorkspace); setEditor(null); setGenerating(false); setError(null); await refresh(); return true; }
    catch (e) { setError((e as Error).message); return false; } finally { setPending(false); }
  };
  const recipes = useMemo(() => state.recipes.filter(r => (origin === 'all' || r.origin === origin) && `${r.name} ${r.description} ${r.tags.join(' ')}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())).sort((a, b) => {
    const latest = (id: string) => Math.max(0, ...state.runs.filter(r => r.recipeId === id).map(r => r.startedAt));
    return latest(b.id) - latest(a.id) || a.name.localeCompare(b.name);
  }), [state, origin, search]);
  const runs = state.runs.filter(r => history === '*' || r.recipeId === history).sort((a, b) => b.startedAt - a.startedAt);
  const choose = (recipe: TaskRecipe, run?: RecipeRun) => guard(() => { setEditor(null); setUsing({ recipe, run }); setError(null); });
  return <section className="scheduled-tasks-page-shell recipe-page-shell">
    <header className="scheduled-tasks-page-toolbar main-chat-header">
      {props.sidebarCollapsed && <button type="button" className="header-toggle" aria-label={tr('展开侧栏', 'Show sidebar')} onClick={props.onToggleSidebar}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></svg></button>}
      <span>{tr('任务配方', 'Task Recipes')}</span>
    </header>
    <div className="scheduled-tasks-page-scroll"><div className={`scheduled-tasks-page recipe-page${editor ? ' is-editing' : ''}`}>
      {!editor && <div className="scheduled-tasks-header recipe-page-heading"><div><h1>{tr('任务配方', 'Task Recipes')}</h1><p className="scheduled-tasks-note">{tr('把常用任务保存为配方，下次填写参数即可开始。', 'Save repeatable tasks. Fill in the parameters and start again anytime.')}</p></div>
        <div className="scheduled-task-actions"><button type="button" className="recipe-primary" disabled={pending || !!state.error} onClick={() => edit()}><PlusIcon />{tr('创建配方', 'Create recipe')}</button>
          <button type="button" disabled={pending || !!state.error} onClick={() => guard(() => { void api()!.importFile().then(result => { if (result) { setImports(result); setEditor(null); setUsing(null); } }).catch(e => setError((e as Error).message)); })}>{tr('导入配方', 'Import recipes')}</button>
          <button type="button" onClick={() => void refresh()}>{tr('刷新', 'Refresh')}</button></div></div>}
      {(error || state.error) && <div className="recipe-errors" role="alert"><p>{error || state.error}</p><button type="button" onClick={() => void refresh()}>{tr('重试读取', 'Retry loading')}</button></div>}
      {notice && <p role="status" className="scheduled-tasks-note">{notice}</p>}
      {Object.entries(state.projectErrors ?? {}).map(([path, message]) => <p key={path} className="recipe-errors" role="alert">{path}: {message}</p>)}
      {!editor && !using && <RecipeTeamPanel state={state} workspaces={props.workspaces} />}
      {editor && <RecipeEditor editor={editor} fields={fields} pending={pending || generating} onChange={recipe => { setEditor({ ...editor, recipe }); setFields(validateRecipe(recipe)); }} onSave={save} onClose={() => guard(() => setEditor(null))} tools={<>
        <div className="recipe-editor-toolbar"><label>{tr('保存位置', 'Save to')}<select disabled={!!editor.id || pending || generating} value={editor.teamWorkspace ? `team:${editor.teamWorkspace}` : editor.projectWorkspace ?? ''} onChange={e => setEditor({ ...editor, projectWorkspace: e.target.value.startsWith('team:') ? undefined : e.target.value || undefined, teamWorkspace: e.target.value.startsWith('team:') ? e.target.value.slice(5) : undefined, teamFingerprint: undefined, original: '' })}><option value="">{tr('个人配方库', 'Personal library')}</option>{state.teams?.filter(t => t.permission === 'write' || t.workspace === editor.teamWorkspace).map(t => <option key={`team:${t.workspace}`} value={`team:${t.workspace}`}>{tr('团队', 'Team')}: {t.workspace}</option>)}{[...new Set([...props.workspaces, ...(editor.projectWorkspace ? [editor.projectWorkspace] : [])])].map(path => <option key={path} value={path}>{tr('项目', 'Project')}: {path}</option>)}</select></label>
        <button type="button" disabled={pending} onClick={() => setGenerating(true)}><SparkIcon />{tr('AI 整理配方', 'Organize with AI')}</button></div>
        {generating && <RecipeGeneratePanel text={editor.recipe.sourceReference ? editor.recipe.workflowTemplate : [editor.recipe.objectiveTemplate, editor.recipe.workflowTemplate, editor.recipe.deliverableTemplate].filter(Boolean).join('\n\n')} sourceReference={editor.recipe.sourceReference} catalog={props.catalog} locale={props.locale} onClose={() => setGenerating(false)} onGenerated={result => {
          setEditor({ ...editor, recipe: result.recipe }); setFields({}); setGenerating(false); setNotice(`${tr('已整理为草稿，保存后生效。模型', 'Draft generated; save to keep it. Model')}: ${result.model.provider}/${result.model.id}`);
        }} />}
        {editor.teamWorkspace && <p className="recipe-warning">{tr('保存会写入团队模板库，正文与参数默认值对团队可见；来源聊天引用不会写入。', 'Saving publishes template text and parameter defaults to the team library. Source chat references are omitted.')}</p>}
      </>} />}
      {using && <RecipeUse key={`${using.recipe.id}:${using.run?.id ?? 'current'}`} recipe={using.recipe} run={using.run} latest={state.recipes.find(r => r.id === using.recipe.id)} catalog={props.catalog}
        workspace={props.workspace} workspaces={props.workspaces} onClose={() => setUsing(null)} onStarted={id => { setUsing(null); props.onOpenConversation(id); }} onSaveAs={recipe => { setUsing(null); edit(recipe, true); }} />}
      {!editor && !using && <>
        {imports.length > 0 && <section className="scheduled-task-form"><h2>{tr('导入预览', 'Import preview')}</h2><p>{tr('导入内容尚未保存或执行。每项会以新 ID 保存，重名不会覆盖；请审阅正文和 Skill 依赖。', 'Nothing is saved or executed yet. Each template gets a new ID; duplicate names do not overwrite recipes. Review its text and Skill dependencies.')}</p>{imports.map((input, index) => <article key={index}><h3>{input.name}</h3><p>{input.description}</p><p>{input.parameters.length} {tr('个参数', 'parameters')} · {input.requiredSkills?.join(', ')}</p><button type="button" onClick={() => { setEditor({ recipe: input, original: JSON.stringify(blankRecipe()) }); setImports(imports.filter((_, i) => i !== index)); }}>{tr('编辑并保存', 'Review and save')}</button></article>)}<button type="button" onClick={() => setImports([])}>{tr('放弃剩余导入', 'Discard remaining imports')}</button></section>}
        <div className="recipe-filters"><label>{tr('搜索配方', 'Search recipes')}<input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder={tr('名称、说明或标签', 'Name, description, or tags')} /></label>
          <label>{tr('来源', 'Source')}<select value={origin} onChange={e => setOrigin(e.target.value)}><option value="all">{tr('全部', 'All')}</option><option value="builtin">{tr('内置', 'Built-in')}</option><option value="user">{tr('我的配方', 'My recipes')}</option><option value="project">{tr('项目配方', 'Project recipes')}</option><option value="team">{tr('团队配方', 'Team recipes')}</option></select></label>
          <button type="button" onClick={() => { setHistory(history === '*' ? null : '*'); setPage(0); }}>{tr('全部使用记录', 'All usage history')} ({state.runs.length})</button></div>
        {loading && <p role="status">{tr('加载中…', 'Loading…')}</p>}
        {!loading && recipes.length === 0 && <div className="recipe-empty"><p>{tr('没有匹配的配方。', 'No matching recipes.')}</p><button type="button" onClick={() => { setSearch(''); setOrigin('all'); }}>{tr('清空筛选', 'Clear filters')}</button><button type="button" onClick={() => edit()}>{tr('创建配方', 'Create recipe')}</button></div>}
        {!state.recipes.some(r => r.origin === 'user') && !state.error && <p className="scheduled-tasks-note">{tr('还没有个人配方。创建一个，或复制下方内置示例。', 'No personal recipes yet. Create one or copy a built-in example below.')}</p>}
        <div className="recipe-list">{recipes.map(recipe => {
          const latest = state.runs.filter(r => r.recipeId === recipe.id).sort((a, b) => b.startedAt - a.startedAt)[0];
          return <article key={recipe.id} className="scheduled-task-card recipe-card">
            <div className="scheduled-task-title"><h3>{recipe.name}</h3><span>{recipe.defaultMode === 'plan' ? 'Plan' : 'Agent'} · {recipe.origin === 'builtin' ? tr('内置', 'Built-in') : recipe.origin === 'project' ? tr('项目配方', 'Project') : recipe.origin === 'team' ? tr('团队配方', 'Team') : tr('我的配方', 'Personal')} · r{recipe.revision}</span></div>
            {(recipe.projectWorkspace || recipe.teamWorkspace) && <p className="scheduled-task-path">{recipe.projectWorkspace || recipe.teamWorkspace}{recipe.origin === 'team' ? ` · ${recipe.teamPermission === 'write' ? tr('可写', 'Writable') : tr('只读', 'Read only')}` : ''}</p>}
            <p>{recipe.description}</p>{recipe.tags.length > 0 && <p className="recipe-tags">{recipe.tags.join(' · ')}</p>}
            <p className="scheduled-tasks-note">{tr('最近使用', 'Last used')}: {date(latest?.startedAt ?? null)}</p>
            <div className="scheduled-task-actions"><button className="recipe-primary" type="button" disabled={!!state.error} onClick={() => choose(recipe)}>{tr('使用配方', 'Use recipe')}</button>
              <button type="button" disabled={!!state.error} onClick={() => edit(recipe, true)}>{tr('复制', 'Duplicate')}</button>
              {recipe.origin !== 'builtin' && (recipe.origin !== 'team' || recipe.teamPermission === 'write') && <><button type="button" disabled={!!state.error} onClick={() => edit(recipe)}>{tr('编辑', 'Edit')}</button><button type="button" disabled={!!state.error} onClick={() => setDeleting(recipe)}>{tr('删除', 'Delete')}</button></>}
              <button type="button" onClick={() => { void api()!.exportFile(recipe).then(saved => { if (saved) setNotice(tr('配方已导出。', 'Recipe exported.')); }).catch(e => setError((e as Error).message)); }}>{tr('导出', 'Export')}</button>
              <button type="button" onClick={() => { setHistory(history === recipe.id ? null : recipe.id); setPage(0); }}>{tr('使用记录', 'Usage history')} ({state.runs.filter(r => r.recipeId === recipe.id).length})</button></div>
            <details><summary>{tr('查看模板', 'View template')}</summary><pre className="recipe-preview">{recipe.objectiveTemplate}{'\n\n'}{recipe.workflowTemplate}{'\n\n'}{recipe.deliverableTemplate}</pre></details>
          </article>;
        })}</div>
        {history && <section className="recipe-history"><h2>{tr('使用记录', 'Usage history')}</h2><RecipeComparison runs={runs} />{runs.length === 0 && <p>{tr('暂无使用记录。', 'No runs yet.')}</p>}
          {runs.slice(page * 20, page * 20 + 20).map(run => <RecipeRunCard key={run.id} run={run} onOpen={props.onOpenConversation} onReuse={() => choose(run.recipeSnapshot, run)} />)}
          {runs.length > 20 && <div className="scheduled-task-actions"><button type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>{tr('上一页', 'Previous')}</button><span>{page + 1} / {Math.ceil(runs.length / 20)}</span><button type="button" disabled={(page + 1) * 20 >= runs.length} onClick={() => setPage(page + 1)}>{tr('下一页', 'Next')}</button></div>}
        </section>}
      </>}
    </div></div>
    {deleting && <RecipeDialog title={tr('删除配方', 'Delete recipe')} onDismiss={pending ? undefined : () => setDeleting(null)}><p>{tr('删除', 'Delete')}「{deleting.name}」？{tr('已有对话、使用记录和运行中的快照会保留。', 'Existing chats, records, and running snapshots are retained.')}</p>
      <div className="recipe-dialog-actions"><button type="button" autoFocus disabled={pending} onClick={() => setDeleting(null)}>{tr('取消', 'Cancel')}</button><button type="button" className="recipe-danger" disabled={pending} onClick={async () => { setPending(true); try { await api()!.delete(deleting.id, deleting.teamFingerprint); setDeleting(null); } catch (e) { setError((e as Error).message); } finally { setPending(false); } }}>{tr('删除', 'Delete')}</button></div></RecipeDialog>}
    {leave && <RecipeDialog title={tr('尚未保存', 'Unsaved changes')} onDismiss={pending ? undefined : () => setLeave(null)}><p>{tr('配方有未保存的修改。离开前要保存吗？', 'This recipe has unsaved changes. Save before leaving?')}</p><div className="recipe-dialog-actions">
      <button type="button" className="recipe-discard" disabled={pending} onClick={() => { const action = leave; setLeave(null); setEditor(null); action(); }}>{tr('放弃修改', 'Discard changes')}</button>
      <button type="button" autoFocus disabled={pending} onClick={() => setLeave(null)}>{tr('继续编辑', 'Keep editing')}</button>
      <button type="button" className="recipe-primary" disabled={pending} onClick={async () => { if (await save()) { const action = leave; setLeave(null); action(); } }}>{pending ? tr('保存中…', 'Saving…') : tr('保存并离开', 'Save and leave')}</button></div>{error && <p role="alert" className="recipe-errors">{error}</p>}</RecipeDialog>}
  </section>;
}
function RecipeDialog({ title, children, onDismiss }: { title: string; children: ReactNode; onDismiss?: () => void }) {
  const titleId = useId();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    const opener = document.activeElement;
    dialog?.showModal();
    return () => { dialog?.close(); if (opener instanceof HTMLElement && opener.isConnected && !opener.closest('[inert]')) opener.focus(); };
  }, []);
  return <dialog className="recipe-dialog" ref={ref} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onDismiss?.(); }} onKeyDown={event => event.stopPropagation()}>
    <div className="recipe-dialog-heading"><h2 id={titleId}>{title}</h2><button type="button" className="recipe-dialog-close" aria-label={tr('关闭弹窗', 'Close dialog')} disabled={!onDismiss} onClick={onDismiss}><CloseIcon size={16} /></button></div>{children}</dialog>;
}
function RecipeRunCard({ run, onOpen, onReuse }: { run: RecipeRun; onOpen: (id: string) => void; onReuse: () => void }) {
  const [exists, setExists] = useState(true);
  const [cleanup, setCleanup] = useState(false); const [cleanupBusy, setCleanupBusy] = useState(false); const [cleanupError, setCleanupError] = useState('');
  useEffect(() => { let active = true; void window.vela?.getState().then(state => { if (active) setExists(state.conversations.some(c => c.id === run.conversationId)); }); return () => { active = false; }; }, [run.conversationId]);
  return <article className="scheduled-task-card"><h3>{run.recipeSnapshot.name} · r{run.recipeSnapshot.revision}</h3><p>{date(run.startedAt)} · {run.mode} · {status(run)}{run.planPending ? ` · ${tr('方案待审阅', 'Plan awaiting review')}` : ''}</p>
    <p className="scheduled-task-path">{run.workspace}</p>{run.finishedAt && <p>{tr('结束时间', 'Finished')}: {date(run.finishedAt)}</p>}{run.error && <p className="recipe-errors">{run.error}</p>}
    {run.worktree && <div className="recipe-worktree-record"><p>{tr('独立 worktree', 'Independent worktree')}: {run.worktree.branch} · {run.worktree.startSha}</p><p className="scheduled-task-path">{run.worktree.path}</p>
      {run.worktreeRemovedAt ? <p>{tr('worktree 已清理，分支保留。', 'Worktree removed; branch retained.')}</p> : run.finishedAt && <><button type="button" disabled={cleanupBusy} onClick={() => setCleanup(true)}>{tr('清理 worktree', 'Remove worktree')}</button>{cleanup && <div className="scheduled-task-actions"><span>{tr('仅删除此 worktree 目录，保留分支与记录；有未提交改动时拒绝。', 'Remove this worktree directory; keep its branch and history. Uncommitted changes block removal.')}</span><button type="button" disabled={cleanupBusy} onClick={async () => { setCleanupBusy(true); setCleanupError(''); try { await api()!.cleanupWorktree(run.id); setCleanup(false); } catch (e) { setCleanupError((e as Error).message); } finally { setCleanupBusy(false); } }}>{tr('确认清理', 'Confirm removal')}</button><button type="button" disabled={cleanupBusy} onClick={() => setCleanup(false)}>{tr('取消', 'Cancel')}</button></div>}</>}
      {cleanupError && <p role="alert" className="recipe-errors">{cleanupError}</p>}</div>}
    <RecipeRunProgress run={run} /><RecipeRunOutcome run={run} />
    <p className="scheduled-tasks-note">{tr('此状态记录配方执行，后续自由聊天不改写记录。', 'This status covers recipe execution; later chat turns do not rewrite it.')}</p>
    <div className="scheduled-task-actions">{exists ? <button type="button" onClick={() => onOpen(run.conversationId)}>{tr('打开对话', 'Open chat')}</button> : <span>{tr('关联对话已删除', 'Linked chat deleted')}</span>}<button type="button" onClick={onReuse}>{tr('再次使用', 'Use again')}</button></div>
    <details><summary>{tr('查看本次快照', 'View run snapshot')}</summary><p>{run.resolvedExecution.model.provider}/{run.resolvedExecution.model.id} · {run.resolvedExecution.thinkingLevel} · {run.resolvedExecution.sandboxMode}</p><pre className="recipe-preview">{run.expandedPrompt}</pre><details><summary>{tr('完整配方与输入', 'Full recipe and inputs')}</summary><pre className="recipe-preview">{JSON.stringify({ recipeSnapshot: run.recipeSnapshot, values: run.values, resolvedContext: run.resolvedContext, additionalInstructions: run.additionalInstructions, requestId: run.requestId }, null, 2)}</pre></details></details>
  </article>;
}
function RecipeEditor({ editor, fields, pending, onChange, onSave, onClose, tools }: { editor: Editor; fields: Record<string, string>; pending: boolean; onChange: (r: TaskRecipeInput) => void; onSave: () => Promise<boolean>; onClose: () => void; tools: ReactNode }) {
  const recipe = editor.recipe;
  const set = <K extends keyof TaskRecipeInput>(key: K, value: TaskRecipeInput[K]) => onChange({ ...recipe, [key]: value });
  const textareas = useRef<Record<string, HTMLTextAreaElement | null>>({});
  const [insertField, setInsertField] = useState<'objectiveTemplate' | 'workflowTemplate' | 'deliverableTemplate'>('objectiveTemplate');
  const invalid = (field: string) => ({ 'aria-invalid': !!fields[field] });
  const fieldError = (field: string) => fields[field] && <span className="recipe-errors" role="alert">{fields[field]}</span>;
  return <form className="recipe-editor scheduled-task-form" onSubmit={e => { e.preventDefault(); void onSave(); }}>
    <div className="recipe-editor-heading"><div><h2>{editor.id ? tr('编辑配方', 'Edit recipe') : tr('新配方', 'New recipe')}</h2></div>
      <div className="scheduled-task-actions"><button type="button" disabled={pending} onClick={onClose}>{tr('关闭编辑', 'Close editor')}</button><button type="submit" disabled={pending}>{pending ? tr('保存中…', 'Saving…') : tr('保存配方', 'Save recipe')}</button></div>
    </div>
    {tools}
    <fieldset disabled={pending}>
      <section className="recipe-editor-section"><h3>{tr('基本信息', 'Basics')}</h3>
        <div className="recipe-columns recipe-basics"><label>{tr('名称', 'Name')}<input {...invalid('name')} placeholder={tr('例如：审查代码改动', 'e.g. Review code changes')} value={recipe.name} maxLength={80} onChange={e => set('name', e.target.value)} />{fieldError('name')}</label>
          <label>{tr('默认模式', 'Default mode')}<select value={recipe.defaultMode} onChange={e => set('defaultMode', e.target.value as 'agent' | 'plan')}><option value="agent">Agent</option><option value="plan">Plan</option></select></label></div>
        <label>{tr('说明', 'Description')}<textarea {...invalid('description')} placeholder={tr('这份配方适合什么任务？', 'When should this recipe be used?')} value={recipe.description} maxLength={300} rows={2} onChange={e => set('description', e.target.value)} />{fieldError('description')}</label>
      </section>
      <section className="recipe-editor-section recipe-task-content"><div className="scheduled-task-title"><h3>{tr('任务内容', 'Task instructions')}</h3><span>{tr('目标 · 流程 · 交付', 'Objective · Workflow · Deliverables')}</span></div>
        {(['objectiveTemplate', 'workflowTemplate', 'deliverableTemplate'] as const).map((field, i) => <label key={field}>{[tr('任务目标', 'Objective'), tr('流程要求', 'Workflow'), tr('交付要求', 'Deliverables')][i]}<textarea ref={node => { textareas.current[field] = node; }} {...invalid(field)} value={recipe[field]} rows={i === 1 ? 6 : 3} placeholder={[tr('希望完成什么？', 'What should be achieved?'), tr('描述执行步骤、约束和注意事项。', 'Describe the steps, constraints, and considerations.'), tr('最终需要哪些结果？', 'What should be delivered?')][i]} onChange={e => set(field, e.target.value)} />{fieldError(field)}</label>)}
        <details className="recipe-placeholder-tools"><summary>{tr('插入参数或工作区变量', 'Insert a parameter or workspace variable')}</summary>
          <div className="recipe-columns"><label>{tr('插入到', 'Insert into')}<select value={insertField} onChange={e => setInsertField(e.target.value as typeof insertField)}><option value="objectiveTemplate">{tr('任务目标', 'Objective')}</option><option value="workflowTemplate">{tr('流程要求', 'Workflow')}</option><option value="deliverableTemplate">{tr('交付要求', 'Deliverables')}</option></select></label>
        <label>{tr('插入占位符', 'Insert placeholder')}<select value="" onChange={e => {
          const node = textareas.current[insertField]; const value = recipe[insertField]; const start = node?.selectionStart ?? value.length; const end = node?.selectionEnd ?? start; const id = e.target.value;
          set(insertField, value.slice(0, start) + `{{${id}}}` + value.slice(end)); requestAnimationFrame(() => { node?.focus(); node?.setSelectionRange(start + id.length + 4, start + id.length + 4); });
        }}><option value="" disabled>{tr('选择参数…', 'Choose a parameter…')}</option>{[...recipe.parameters.map(p => p.id), 'workspace.name', 'workspace.path'].map(id => <option key={id} value={id}>{id}</option>)}</select></label></div>
          <p className="scheduled-tasks-note">{tr('正文最多 40,000 字符。变量只替换一次，不执行表达式或脚本。', 'Up to 40,000 characters. Variables are replaced once; expressions and scripts are not executed.')}</p>
        </details>
      </section>
      <section className="recipe-editor-section"><div className="scheduled-task-title"><h3>{tr('参数定义', 'Parameters')} <span className="recipe-count">{recipe.parameters.length}/20</span></h3><button type="button" disabled={recipe.parameters.length >= 20} onClick={() => set('parameters', [...recipe.parameters, { id: `parameter_${recipe.parameters.length + 1}`, label: '', type: 'text', required: false }])}><PlusIcon />{tr('添加参数', 'Add parameter')}</button></div>
        {!recipe.parameters.length && <p className="scheduled-tasks-note">{tr('把每次变化的内容设为参数，例如文件路径或审查范围。', 'Add parameters for values that change each time, such as a file path or review scope.')}</p>}
        {recipe.parameters.map((parameter, index) => <ParameterEditor key={index} parameter={parameter} index={index} fields={fields} onChange={p => set('parameters', recipe.parameters.map((old, i) => i === index ? p : old))} onRemove={() => set('parameters', recipe.parameters.filter((_, i) => i !== index))} />)}
        {fieldError('parameters')}</section>
      <div className="recipe-editor-section"><RecipeStageEditor recipe={recipe} fields={fields} onChange={stages => set('stages', stages)} /></div>
      <details className="recipe-editor-options" open={!!(recipe.requiredSkills?.length || recipe.tags.length || fields.requiredSkills || fields.tags)}><summary>{tr('更多设置', 'More settings')}<span>{tr('Skill 依赖与标签', 'Skill dependencies and tags')}</span></summary>
        <label>{tr('所需 Skill（每行一个名称）', 'Required Skills (one name per line)')}<textarea {...invalid('requiredSkills')} rows={3} value={recipe.requiredSkills?.join('\n') ?? ''} onChange={e => set('requiredSkills', e.target.value ? e.target.value.split('\n') : [])} />{fieldError('requiredSkills')}<span className="scheduled-tasks-note">{tr('使用工作区已有的 Skill；缺失或停用时无法开始，不会自动下载或启用。', 'Uses existing workspace Skills. Missing or disabled Skills block launch; nothing is downloaded or enabled automatically.')}</span></label>
        <label>{tr('标签（逗号分隔）', 'Tags (comma separated)')}<input {...invalid('tags')} placeholder={tr('例如：代码审查, 发布', 'e.g. review, release')} value={recipe.tags.join(',')} onChange={e => set('tags', e.target.value ? e.target.value.split(',') : [])} />{fieldError('tags')}</label>
      </details>
      {recipe.sourceReference && <details className="recipe-source-reference"><summary>{recipe.sourceReference.planId ? tr('来源计划', 'Source plan') : tr('来源消息', 'Source message')}</summary><p className="scheduled-tasks-note">{recipe.sourceReference.conversationId} / {recipe.sourceReference.planId ?? recipe.sourceReference.messageId}</p></details>}
    </fieldset></form>;
}
function ParameterEditor({ parameter: p, index, fields, onChange, onRemove }: { parameter: RecipeParameter; index: number; fields: Record<string, string>; onChange: (p: RecipeParameter) => void; onRemove: () => void }) {
  const set = <K extends keyof RecipeParameter>(k: K, value: RecipeParameter[K]) => onChange({ ...p, [k]: value });
  const error = (k: string) => fields[`parameters.${index}.${k}`];
  const input = (k: 'id' | 'label' | 'help', label: string) => <label>{label}<input value={p[k] ?? ''} aria-invalid={!!error(k)} onChange={e => set(k, e.target.value)} />{error(k) && <span className="recipe-errors">{error(k)}</span>}</label>;
  return <fieldset className="recipe-parameter"><legend>{tr('参数', 'Parameter')} {index + 1}</legend><div className="recipe-columns">{input('id', tr('标识', 'Identifier'))}{input('label', tr('显示名称', 'Label'))}
    <label>{tr('类型', 'Type')}<select value={p.type} onChange={e => { const type = e.target.value as RecipeParameter['type']; onChange({ ...p, type, defaultValue: undefined, ...(type === 'path' ? { pathKind: 'any' } : {}), ...(type === 'select' ? { options: [{ value: 'option_1', label: 'Option 1' }, { value: 'option_2', label: 'Option 2' }] } : {}) }); }}>{['text', 'multiline', 'select', 'boolean', 'path'].map(type => <option key={type}>{type}</option>)}</select></label>
    <label className="recipe-checkbox"><input type="checkbox" checked={p.required} onChange={e => set('required', e.target.checked)} />{tr('必填', 'Required')}</label></div>{input('help', tr('帮助文字', 'Help text'))}
    {p.type === 'select' && <label>{tr('选项（每行 稳定值|显示名称）', 'Options (one stable value|label per line)')}<textarea value={p.options?.map(o => `${o.value}|${o.label}`).join('\n') ?? ''} aria-invalid={!!error('options')} onChange={e => set('options', e.target.value.split('\n').map(line => { const [value, ...label] = line.split('|'); return { value: value!, label: label.join('|') }; }))} />{error('options') && <span className="recipe-errors">{error('options')}</span>}</label>}
    {p.type === 'path' && <label>{tr('路径类型', 'Path type')}<select value={p.pathKind ?? 'any'} onChange={e => set('pathKind', e.target.value as RecipeParameter['pathKind'])}><option value="any">{tr('文件或目录', 'File or directory')}</option><option value="file">{tr('文件', 'File')}</option><option value="directory">{tr('目录', 'Directory')}</option></select></label>}
    <label>{tr('默认值（可选）', 'Default value (optional)')}{p.type === 'boolean' ? <select value={p.defaultValue === undefined ? '' : String(p.defaultValue)} onChange={e => set('defaultValue', e.target.value === '' ? undefined : e.target.value === 'true')}><option value="">{tr('未设置', 'Unset')}</option><option value="true">{tr('是', 'Yes')}</option><option value="false">{tr('否', 'No')}</option></select> : p.type === 'multiline' ? <textarea rows={3} aria-invalid={!!error('defaultValue')} value={String(p.defaultValue ?? '')} onChange={e => set('defaultValue', e.target.value === '' ? undefined : e.target.value)} /> : <input aria-invalid={!!error('defaultValue')} value={String(p.defaultValue ?? '')} onChange={e => set('defaultValue', e.target.value === '' ? undefined : e.target.value)} />}{error('defaultValue') && <span className="recipe-errors">{error('defaultValue')}</span>}</label>
    <button type="button" onClick={onRemove}>{tr('移除此参数', 'Remove parameter')}</button></fieldset>;
}

// Session-only cache; never persisted to defaults and never includes permission overrides.
const drafts = new Map<string, Omit<RecipeUseDraft, 'recipeSnapshot' | 'workspace' | 'sandboxModeOverride'>>();
function RecipeUse({ recipe: initial, run, latest, workspace, workspaces, catalog, onClose, onStarted, onSaveAs }: {
  recipe: TaskRecipe; run?: RecipeRun; latest?: TaskRecipe; workspace: string | null; workspaces: string[]; catalog: ModelCatalog | null;
  onClose: () => void; onStarted: (id: string) => void; onSaveAs: (recipe: TaskRecipe) => void;
}) {
  const [recipe, setRecipe] = useState(initial); const [cwd, setCwd] = useState(run?.workspace ?? workspace ?? '');
  const initialWorkspaceApplied = useRef(Boolean(run?.workspace || workspace));
  useEffect(() => { if (!initialWorkspaceApplied.current && workspace) { initialWorkspaceApplied.current = true; setCwd(workspace); } }, [workspace]);
  const cached = drafts.get(`${initial.id}:${cwd}`);
  const [values, setValues] = useState<Record<string, RecipeValue>>(run?.values ?? (cached ? matchedValues(initial, cached.values) : recipeDefaults(initial)));
  const [additional, setAdditional] = useState(run?.additionalInstructions ?? cached?.additionalInstructions ?? '');
  const [mode, setMode] = useState(cached?.mode ?? run?.mode ?? initial.defaultMode);
  const [model, setModel] = useState(run ? null : cached?.modelOverride ?? null); const [thinking, setThinking] = useState(run ? null : cached?.thinkingLevelOverride ?? null);
  const [permission, setPermission] = useState<RecipeUseDraft['sandboxModeOverride']>(null);
  const [autoWorktree, setAutoWorktree] = useState<RecipeUseDraft['autoWorktree']>(null); const [scheduling, setScheduling] = useState(false);
  const [scheduleBusy, setScheduleBusy] = useState(false);
  const [preview, setPreview] = useState<RecipePreview | null>(null); const [busy, setBusy] = useState(false); const [previewBusy, setPreviewBusy] = useState(true);
  const [failedRun, setFailedRun] = useState<RecipeRun | null>(null);
  const [error, setError] = useState<string | null>(null); const [changed, setChanged] = useState(false);
  const previewDraft = useRef<RecipeUseDraft | null>(null);
  const previousFingerprint = useRef(''); const version = useRef(0); const mounted = useRef(true);
  const request = useRef<{ requestId: string; draft: RecipeUseDraft; fingerprint: string } | null>(null);
  const draft = useMemo<RecipeUseDraft>(() => ({ recipeSnapshot: recipe, workspace: cwd, values, additionalInstructions: additional, mode, modelOverride: model, thinkingLevelOverride: thinking, sandboxModeOverride: permission, autoWorktree }), [recipe, cwd, values, additional, mode, model, thinking, permission, autoWorktree]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { drafts.set(`${recipe.id}:${cwd}`, { values, additionalInstructions: additional, mode, modelOverride: model, thinkingLevelOverride: thinking }); }, [recipe.id, cwd, values, additional, mode, model, thinking]);
  useEffect(() => {
    let active = true; let checking = false;
    const current = ++version.current; request.current = null; setPreview(null); setPreviewBusy(true); setChanged(false); previousFingerprint.current = '';
    const check = async () => {
      if (checking || !api()) return; checking = true;
      try { const result = await api()!.preview(draft); if (!active || current !== version.current) return;
        if (previousFingerprint.current && result.fingerprint !== previousFingerprint.current) setChanged(true);
        previousFingerprint.current = result.fingerprint; previewDraft.current = draft; setPreview(result); setError(null);
      } catch (e) { if (active) { setError((e as Error).message); setPreview(null); } }
      finally { checking = false; if (active) setPreviewBusy(false); }
    };
    void check(); const timer = setInterval(() => { void check(); }, 2000); return () => { active = false; clearInterval(timer); };
  }, [draft]);
  const localErrors = validateRecipeValues(recipe, values); const errors = { ...localErrors, ...preview?.errors };
  const availableModels = catalog?.models.filter(m => m.available) ?? [];
  const selectedModel = catalog?.models.find(m => m.provider === model?.provider && m.id === model?.id);
  const levels = selectedModel?.thinkingLevels ?? catalog?.models.find(m => m.provider === preview?.execution?.model.provider && m.id === preview?.execution?.model.id)?.thinkingLevels ?? ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];
  const changeCwd = (next: string) => {
    initialWorkspaceApplied.current = true;
    const cache = drafts.get(`${recipe.id}:${next}`); setCwd(next);
    // Keep user's relative paths unless explicitly restoring a cached draft for this workspace.
    if (cache) { setValues(matchedValues(recipe, cache.values)); setAdditional(cache.additionalInstructions); setMode(cache.mode); setModel(cache.modelOverride ?? null); setThinking(cache.thinkingLevelOverride ?? null); }
  };
  const start = async () => {
    if (busy || previewDraft.current !== draft || !preview?.fingerprint || Object.keys(errors).length || !api()) return;
    setBusy(true); setError(null);
    try {
      request.current ??= { requestId: crypto.randomUUID(), draft, fingerprint: preview.fingerprint };
      const result = await api()!.start(request.current);
      if (!mounted.current) return;
      if (result.status === 'failed' || result.status === 'interrupted') { setError(result.error ?? tr('启动失败，请查看使用记录。', 'Start failed. Check the run record.')); const state = await window.vela!.getState(); if (state.conversations.some(c => c.id === result.conversationId)) setFailedRun(result); }
      else onStarted(result.conversationId);
    } catch (e) { if (mounted.current) { setError((e as Error).message); const updated = await api()!.preview(draft); previewDraft.current = draft; setPreview(updated); setChanged(true); request.current = null; } }
    finally { if (mounted.current) setBusy(false); }
  };
  return <form className="recipe-use scheduled-task-form" onSubmit={e => { e.preventDefault(); void start(); }}><div className="scheduled-task-title"><h2>{recipe.name} · r{recipe.revision}</h2><button type="button" disabled={busy || scheduleBusy} onClick={onClose}>{tr('关闭', 'Close')}</button></div><p>{recipe.description}</p>
    {latest && (latest.revision !== recipe.revision || latest.locale !== recipe.locale) && <p role="status">{tr('配方有新版本；当前仍使用固定快照。', 'A newer recipe is available; this snapshot is fixed.')} <button type="button" disabled={busy} onClick={() => { setRecipe(latest); setValues(matchedValues(latest, values)); }}>{tr('载入新版', 'Load latest')}</button></p>}
    {!latest && <p>{tr('原配方已删除，可继续使用此快照。', 'The original recipe was deleted. You can use this snapshot.')} <button type="button" onClick={() => onSaveAs(recipe)}>{tr('另存为新配方', 'Save as new recipe')}</button></p>}
    <p className="scheduled-tasks-note">{tr('参数会写入本次对话和本地使用记录。请勿填写密码或 API 密钥。', 'Parameters are saved in this chat and local history. Do not enter passwords or API keys.')}</p>
    <fieldset disabled={busy || scheduleBusy}><label>{tr('工作区', 'Workspace')}<select value={cwd} aria-invalid={!!errors.workspace} onChange={e => changeCwd(e.target.value)}><option value="">{tr('请选择工作区', 'Choose workspace')}</option>{[...new Set([...workspaces, ...(cwd ? [cwd] : [])])].map(w => <option key={w} value={w}>{w}</option>)}</select>{errors.workspace && <span className="recipe-errors">{errors.workspace}</span>}</label>
      <label className="recipe-checkbox"><input type="checkbox" checked={!!autoWorktree} disabled={scheduling} onChange={e => setAutoWorktree(e.target.checked ? { startRef: 'HEAD', branch: `vela/recipe-${crypto.randomUUID().slice(0, 12)}`, includeUncommitted: false } : null)} />{tr('自动创建独立 worktree', 'Create an independent worktree')}</label>
      {autoWorktree && <section className="recipe-worktree"><div className="recipe-columns"><label>{tr('起始提交或引用', 'Starting commit or ref')}<input value={autoWorktree.startRef} onChange={e => setAutoWorktree({ ...autoWorktree, startRef: e.target.value })} /></label><label>{tr('新分支', 'New branch')}<input value={autoWorktree.branch} onChange={e => setAutoWorktree({ ...autoWorktree, branch: e.target.value })} /></label></div><p className="scheduled-tasks-note">{tr('不带入未提交或未跟踪文件。完成、失败或中断后均保留目录与分支；可在使用记录中手动清理。', 'Uncommitted and untracked files are not copied. The directory and branch remain after completion, failure or interruption; remove the directory from usage history.')}</p>{preview?.context?.worktree && <p className="scheduled-task-path">{preview.context.worktree.path}<br />{preview.context.worktree.startSha}</p>}{errors.autoWorktree && <p className="recipe-errors" role="alert">{errors.autoWorktree}</p>}</section>}
      {recipe.requiredSkills?.length ? <p>{tr('所需 Skill', 'Required Skills')}: {recipe.requiredSkills.join(' · ')}</p> : null}
      {errors.requiredSkills && <p className="recipe-errors" role="alert">{errors.requiredSkills}</p>}
      {recipe.parameters.map(p => <label key={p.id}>{p.label}{p.required ? ' *' : ''}{p.help && <span className="scheduled-tasks-note">{p.help}</span>}
        {p.type === 'boolean' ? <div className="recipe-path"><button type="button" role="switch" aria-label={p.label} aria-checked={values[p.id] === true} aria-invalid={!!errors[`values.${p.id}`]} onClick={() => setValues({ ...values, [p.id]: values[p.id] !== true })}>{values[p.id] === undefined || values[p.id] === '' ? tr('未提供（点击设置）', 'Unset (click to set)') : values[p.id] ? tr('是', 'Yes') : tr('否', 'No')}</button>{!p.required && <button type="button" onClick={() => { const next = { ...values }; delete next[p.id]; setValues(next); }}>{tr('清空', 'Clear')}</button>}</div>
        : p.type === 'select' ? <select aria-invalid={!!errors[`values.${p.id}`]} value={String(values[p.id] ?? '')} onChange={e => setValues({ ...values, [p.id]: e.target.value })}><option value="">{tr('请选择', 'Choose')}</option>{p.options?.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
        : p.type === 'multiline' ? <textarea rows={3} maxLength={10000} aria-invalid={!!errors[`values.${p.id}`]} value={String(values[p.id] ?? '')} onChange={e => setValues({ ...values, [p.id]: e.target.value })} />
        : <div className="recipe-path"><input maxLength={500} aria-invalid={!!errors[`values.${p.id}`]} value={String(values[p.id] ?? '')} onChange={e => setValues({ ...values, [p.id]: e.target.value })} />{p.type === 'path' && <button type="button" disabled={!cwd} onClick={async () => { try { const path = await api()!.pickPath(cwd, p.pathKind ?? 'any'); if (path !== null) setValues({ ...values, [p.id]: path }); } catch (e) { setError((e as Error).message); } }}>{tr('选择…', 'Browse…')}</button>}</div>}
        {errors[`values.${p.id}`] && <span className="recipe-errors" role="alert">{errors[`values.${p.id}`]}</span>}</label>)}
      <div className="recipe-columns"><label>{tr('模式', 'Mode')}<select value={mode} onChange={e => setMode(e.target.value as 'agent' | 'plan')}><option value="agent">Agent</option><option value="plan">Plan</option></select></label>
        <label>{tr('模型', 'Model')}<select aria-invalid={!!errors.modelOverride} value={model ? JSON.stringify([model.provider, model.id]) : ''} onChange={e => { const pair = e.target.value ? JSON.parse(e.target.value) as [string, string] : null; setModel(pair ? { provider: pair[0], id: pair[1] } : null); setThinking(null); }}><option value="">{tr('沿用新对话设置', 'New chat default')}</option>{model && !selectedModel?.available && <option value={JSON.stringify([model.provider, model.id])} disabled>{tr('所选模型已不可用，请重新选择', 'Selected model unavailable; choose another')}</option>}{availableModels.map(m => <option key={`${m.provider}/${m.id}`} value={JSON.stringify([m.provider, m.id])}>{m.providerName} / {m.name}</option>)}</select></label>
        <label>{tr('思考强度', 'Thinking effort')}<select value={thinking ?? ''} onChange={e => setThinking(e.target.value as RecipeUseDraft['thinkingLevelOverride'] || null)}><option value="">{tr('沿用新对话设置', 'New chat default')}</option>{levels.map(level => <option key={level} value={level}>{level}</option>)}</select></label>
        <label>{tr('执行权限', 'Permissions')}<select value={permission ?? ''} onChange={e => setPermission(e.target.value as RecipeUseDraft['sandboxModeOverride'] || null)}><option value="">{tr('沿用应用设置', 'App default')}</option><option value="ask">{tr('逐条审批', 'Ask')}</option><option value="smart">{tr('帮我批准', 'Smart')}</option><option value="full">{tr('完全访问', 'Full access')}</option></select></label></div>
      <label>{tr('本次补充要求', 'Additional instructions')}<textarea value={additional} maxLength={10000} rows={3} onChange={e => setAdditional(e.target.value)} /></label>
      {preview?.concurrent && <p role="status" className="recipe-warning">{tr('此实际目录已有运行中的聊天，可能同时修改文件。', 'A chat is running in this directory and may modify the same files.')}</p>}
      {changed && <p role="status" className="recipe-warning">{tr('工作区、Git 或启动设置有变化，预览已更新，请查看后开始。', 'Workspace, Git, or launch settings changed. Review the updated preview before starting.')}</p>}
      {preview?.execution && <p className="scheduled-tasks-note">{tr('本次设置', 'Resolved settings')}: {preview.execution.model.provider}/{preview.execution.model.id} · {preview.execution.thinkingLevel} · {preview.execution.sandboxMode}</p>}
      {preview?.context?.git && <p className="recipe-git">{preview.context.git.scope}<br />HEAD: {preview.context.git.head}{preview.context.git.startSha && <><br />{preview.context.git.startSha} → {preview.context.git.endSha}</>}</p>}
      <details open className="recipe-preview-panel"><summary>{tr('完整任务预览', 'Full task preview')}</summary>{previewBusy ? <p role="status">{tr('正在校验…', 'Checking…')}</p> : <pre className="recipe-preview">{preview?.expandedPrompt}</pre>}</details>
      {(error || errors.preview || errors.values || errors.additionalInstructions || errors.thinkingLevelOverride || errors.sandboxModeOverride) && <p className="recipe-errors" role="alert">{error || errors.preview || errors.values || errors.additionalInstructions || errors.thinkingLevelOverride || errors.sandboxModeOverride}</p>}
      {failedRun && <button type="button" onClick={() => onStarted(failedRun.conversationId)}>{tr('检查已创建的对话', 'Inspect created chat')}</button>}
      <RecipeStagePreview recipe={recipe} values={values} mode={mode} />
      {mode === 'plan' && <p className="scheduled-tasks-note">{tr('Plan 只开展规划，方案仍需通过 Plan Document 批准实施。', 'Plan only creates a proposal. Implementation requires approval in Plan Document.')}</p>}
      <div className="scheduled-task-actions"><button type="submit" disabled={scheduling || busy || previewBusy || previewDraft.current !== draft || !preview?.fingerprint || Object.keys(errors).length > 0}>{busy ? tr('正在启动…', 'Starting…') : tr('开始', 'Start')}</button><button type="button" disabled={!!autoWorktree || busy || previewBusy || Object.keys(errors).length > 0} onClick={() => setScheduling(!scheduling)}>{tr('绑定定时任务', 'Schedule recipe')}</button><button type="button" onClick={onClose}>{tr('取消', 'Cancel')}</button></div>
      {scheduling && <RecipeSchedulePanel draft={draft} onClose={() => setScheduling(false)} onBusy={setScheduleBusy} />}
    </fieldset></form>;
}
