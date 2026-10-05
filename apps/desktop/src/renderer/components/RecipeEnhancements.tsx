import { useEffect, useRef, useState } from 'react';
import type { ModelCatalog, RecipeGenerateResult, RecipeUseDraft, TaskRecipeInput, TaskSchedule } from '@vela/shared';
import { tr } from '../locale';

export function RecipeGeneratePanel({ text: initial, sourceReference, catalog, locale, onGenerated, onClose }: {
  text: string; sourceReference?: TaskRecipeInput['sourceReference']; catalog: ModelCatalog | null; locale: 'zh-CN' | 'en';
  onGenerated: (result: RecipeGenerateResult) => void; onClose: () => void;
}) {
  const [text, setText] = useState(initial); const [model, setModel] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const request = useRef<string | null>(null); const live = useRef(true);
  const availableModels = catalog?.models.filter(m => m.available) ?? [];
  const modelAvailable = availableModels.some(m => JSON.stringify([m.provider, m.id]) === model);
  useEffect(() => { live.current = true; return () => { live.current = false; if (request.current) void window.vela?.taskRecipes?.cancelGenerate(request.current).catch(() => undefined); }; }, []);
  async function generate() {
    if (busy || !modelAvailable || !text.trim()) return;
    const [provider, id] = JSON.parse(model) as [string, string]; const requestId = crypto.randomUUID(); request.current = requestId;
    setBusy(true); setError('');
    try { const result = await window.vela!.taskRecipes!.generate({ requestId, text, model: { provider, id }, locale, sourceReference }); if (live.current) onGenerated(result); }
    catch (e) { if (live.current) setError((e as Error).message); }
    finally { request.current = null; if (live.current) setBusy(false); }
  }
  return <section className="scheduled-task-form recipe-ai" aria-label={tr('AI 整理配方', 'Organize with AI')}>
    <h2>{tr('AI 整理配方', 'Organize with AI')}</h2><p className="scheduled-tasks-note">{tr('仅将下方原文发送给所选模型；不会读取其他消息。返回参数、流程和交付要求的可编辑草稿，保存后生效。', 'Only the source below is sent to the selected model. The result is an editable draft of parameters, workflow and deliverables; save it to add it to your library.')}</p>
    <fieldset disabled={busy}><label>{tr('原文范围（消息或计划）', 'Source (message or plan)')}<textarea maxLength={40000} rows={8} value={text} onChange={e => setText(e.target.value)} /></label>
      <label>{tr('整理模型', 'Model')}<select value={model} onChange={e => setModel(e.target.value)}><option value="">{tr('选择模型', 'Choose model')}</option>{model && !modelAvailable && <option value={model} disabled>{tr('所选模型已不可用，请重新选择', 'Selected model unavailable; choose another')}</option>}{availableModels.map(m => <option key={`${m.provider}/${m.id}`} value={JSON.stringify([m.provider, m.id])}>{m.providerName} / {m.name}</option>)}</select></label>
    </fieldset>
    {catalog && !availableModels.length && <p role="status" className="scheduled-tasks-note">{tr('暂无可用模型，请先在设置中连接提供方。', 'No models available. Connect a provider in Settings first.')}</p>}
    {error && <p role="alert" className="recipe-errors">{error}</p>}{busy && <p role="status">{tr('模型正在整理…', 'Generating a draft…')}</p>}
    <div className="scheduled-task-actions"><button type="button" disabled={busy || !modelAvailable || !text.trim()} onClick={() => void generate()}>{tr('调用模型整理', 'Generate draft')}</button><button type="button" onClick={onClose}>{busy ? tr('取消生成', 'Cancel generation') : tr('关闭', 'Close')}</button></div>
  </section>;
}

export function RecipeSchedulePanel({ draft, onClose, onBusy }: { draft: RecipeUseDraft; onClose: () => void; onBusy: (busy: boolean) => void }) {
  const [kind, setKind] = useState<TaskSchedule['kind']>('daily'); const [time, setTime] = useState('09:00');
  const [at, setAt] = useState(''); const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [weekdays, setWeekdays] = useState([1]); const [cron, setCron] = useState('0 9 * * *');
  const [policy, setPolicy] = useState<'fixed' | 'latest'>('fixed'); const [missed, setMissed] = useState<'run-once' | 'skip'>('run-once');
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [created, setCreated] = useState(false);
  async function save() {
    if (busy) return; setBusy(true); onBusy(true); setError('');
    try {
      if (draft.autoWorktree) throw new Error(tr('定时绑定请选已有工作区。', 'Select an existing workspace for a schedule.'));
      const preview = await window.vela!.taskRecipes!.preview(draft);
      if (Object.keys(preview.errors).length) throw new Error(Object.values(preview.errors).join('；'));
      const schedule: TaskSchedule = kind === 'once' ? { kind, at: new Date(at).toISOString() } : kind === 'cron' ? { kind, expression: cron, timezone } : kind === 'weekly' ? { kind, time, timezone, weekdays } : { kind, time, timezone };
      await window.vela!.scheduledTasks!.create({ title: draft.recipeSnapshot.name, prompt: `Task Recipe: ${draft.recipeSnapshot.name} · r${draft.recipeSnapshot.revision}`, workspace: draft.workspace, schedule, missedPolicy: missed,
        model: draft.modelOverride, thinkingLevel: draft.thinkingLevelOverride, sandboxMode: draft.sandboxModeOverride,
        recipeBinding: { recipeSnapshot: draft.recipeSnapshot, versionPolicy: policy, values: draft.values, additionalInstructions: draft.additionalInstructions, mode: draft.mode } });
      setCreated(true);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); onBusy(false); }
  }
  return <section className="recipe-schedule" aria-label={tr('绑定定时任务', 'Schedule recipe')}><h3>{tr('绑定定时任务', 'Schedule recipe')}</h3>
    <p className="scheduled-tasks-note">{tr('绑定当前快照、参数、补充要求和启动设置。应用运行时触发，沿用既有错过和中断策略；不会现在执行。', 'Bind this snapshot, parameters, extra instructions and settings. Runs while the app is open, using the existing missed-run and interruption policies.')}</p>
    {created ? <p role="status">{tr('已创建，可在「定时任务」查看、修改时间或暂停。', 'Created. View, reschedule or pause it in Scheduled Tasks.')}</p> : <fieldset disabled={busy}>
      <div className="recipe-columns"><label>{tr('配方版本', 'Recipe version')}<select value={policy} onChange={e => setPolicy(e.target.value as typeof policy)}><option value="fixed">{tr('固定此版本（默认）', 'Pin this version (default)')}</option><option value="latest">{tr('每次跟随新版', 'Follow latest at each run')}</option></select></label>
        <label>{tr('周期', 'Frequency')}<select value={kind} onChange={e => setKind(e.target.value as typeof kind)}><option value="once">{tr('一次', 'Once')}</option><option value="daily">{tr('每日', 'Daily')}</option><option value="weekly">{tr('每周', 'Weekly')}</option><option value="cron">Cron</option></select></label></div>
      {kind === 'once' ? <label>{tr('本地日期与时间', 'Local date and time')}<input type="datetime-local" value={at} onChange={e => setAt(e.target.value)} /></label> : <><label>{tr('时区', 'Timezone')}<input value={timezone} onChange={e => setTimezone(e.target.value)} /></label>{kind === 'cron' ? <label>{tr('Cron 表达式', 'Cron expression')}<input value={cron} onChange={e => setCron(e.target.value)} /></label> : <label>{tr('时间', 'Time')}<input type="time" value={time} onChange={e => setTime(e.target.value)} /></label>}</>}
      {kind === 'weekly' && <fieldset><legend>{tr('星期', 'Weekdays')}</legend><div className="scheduled-task-actions">{[tr('日', 'Sun'), tr('一', 'Mon'), tr('二', 'Tue'), tr('三', 'Wed'), tr('四', 'Thu'), tr('五', 'Fri'), tr('六', 'Sat')].map((day, index) => <label key={day} className="recipe-checkbox"><input type="checkbox" checked={weekdays.includes(index)} onChange={e => setWeekdays(e.target.checked ? [...weekdays, index] : weekdays.filter(d => d !== index))} />{day}</label>)}</div></fieldset>}
      {policy === 'latest' && <p className="recipe-warning">{tr('新版改变参数或 Skill 时，触发前会重新校验；缺失值会使该次运行失败。', 'Changed parameters or Skills are checked before every run. Missing values cause that run to fail.')}</p>}
      <label>{tr('错过执行', 'Missed runs')}<select value={missed} onChange={e => setMissed(e.target.value as typeof missed)}><option value="run-once">{tr('补执行一次', 'Catch up once')}</option><option value="skip">{tr('跳过', 'Skip')}</option></select></label>
      <button type="button" disabled={busy} onClick={() => void save()}>{busy ? tr('创建中…', 'Creating…') : tr('创建定时任务', 'Create schedule')}</button>
    </fieldset>}
    {error && <p role="alert" className="recipe-errors">{error}</p>}<button type="button" disabled={busy} onClick={onClose}>{tr('关闭定时设置', 'Close schedule settings')}</button>
  </section>;
}
