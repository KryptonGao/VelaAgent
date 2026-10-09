import { useEffect, useId, useRef, useState } from "react";
import { thinkingLevels, thinkingLevelLabel, type ModelCatalog, type SandboxMode, type ThinkingLevel, type ScheduledTask, type ScheduledTaskInput, type ScheduledTasksState, type TaskSchedule } from "@vela/shared";
import { tr } from "../locale";
import { cleanErrorMessage } from "../hooks/useProject";
import "../scheduled-tasks.css";

const emptyState: ScheduledTasksState = { tasks: [], runs: [] };
const statusLabels = { active: ["启用", "Active"], paused: ["已暂停", "Paused"], completed: ["已完成", "Completed"],
  running: ["执行中", "Running"], success: ["成功", "Success"], failed: ["失败", "Failed"], skipped: ["已跳过", "Skipped"], interrupted: ["已中断", "Interrupted"] } as const;
const statusText = (status: keyof typeof statusLabels) => tr(statusLabels[status][0], statusLabels[status][1]);
const dateText = (date: number | null) => date === null ? "—" : new Date(date).toLocaleString();
const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;
const statusTone = (status: keyof typeof statusLabels) => status === "success" || status === "active" ? "ok" : status === "failed" || status === "interrupted" ? "bad" : status === "running" ? "run" : "idle";
const days = () => [tr("日", "Sun"), tr("一", "Mon"), tr("二", "Tue"), tr("三", "Wed"), tr("四", "Thu"), tr("五", "Fri"), tr("六", "Sat")];
function scheduleText(schedule: TaskSchedule): string {
  if (schedule.kind === "once") return `${tr("一次性", "Once")} · ${dateText(Date.parse(schedule.at))}`;
  if (schedule.kind === "cron") return `Cron · ${schedule.expression} · ${schedule.timezone}`;
  return `${schedule.kind === "daily" ? tr("每日", "Daily") : `${tr("每周", "Weekly")} ${schedule.weekdays.map(day => days()[day]).join("、")}`} · ${schedule.time} · ${schedule.timezone}`;
}

export function ScheduledTasksPage({ workspace, workspaces, onOpenConversation, sidebarCollapsed, onToggleSidebar, catalog, catalogError }: {
  workspace: string | null; workspaces: string[]; onOpenConversation: (id: string) => void;
  sidebarCollapsed: boolean; onToggleSidebar: () => void; catalog: ModelCatalog | null; catalogError: string | null;
}) {
  const api = window.vela?.scheduledTasks;
  const [state, setState] = useState(emptyState);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [editor, setEditor] = useState<ScheduledTask | "new" | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [scope, setScope] = useState("all");
  useEffect(() => { document.querySelector<HTMLElement>(".scheduled-tasks-page h1")?.focus(); }, []);
  useEffect(() => {
    if (!api) { setLoading(false); return; }
    let live = true, revision = 0;
    const unsubscribe = api.subscribe(next => { revision++; if (live) setState(next); });
    void api.list().then(next => { if (live && revision === 0) setState(next); }).catch(caught => { if (live) setError(cleanErrorMessage(caught)); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; unsubscribe(); };
  }, [api]);
  async function action(operation: () => Promise<unknown>): Promise<boolean> {
    setPending(true); setError(null);
    try { await operation(); return true; }
    catch (caught) { setError(cleanErrorMessage(caught)); return false; }
    finally { setPending(false); }
  }
  const choices = [...new Set([...(workspace ? [workspace] : []), ...workspaces, ...state.tasks.map(task => task.workspace)])];
  const tasks = state.tasks.filter(task => scope === "all" || task.workspace === workspace).sort((a, b) => b.createdAt - a.createdAt);
  return <main className="scheduled-tasks-page-shell">
    <header className="main-chat-header scheduled-tasks-page-toolbar">
      <div className="chat-title-group">
        {sidebarCollapsed && <button className="view-icon-btn" type="button" onClick={onToggleSidebar}
          title={tr("展开侧边栏", "Expand sidebar")} aria-label={tr("展开侧边栏", "Expand sidebar")}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></svg>
        </button>}
        <span className="chat-active-title">{tr("定时任务", "Scheduled Tasks")}</span>
      </div>
    </header>
    <div className="scheduled-tasks-page-scroll">
    <section className="scheduled-tasks-page st-page" aria-label={tr("定时任务", "Scheduled Tasks")}>
    <header className="scheduled-tasks-header"><div><h1 tabIndex={-1}>{tr("定时任务", "Scheduled Tasks")}</h1><p>{tr("让 Vela 在指定时间开始一段新对话。", "Start a new chat at a scheduled time.")}</p>
      <p className="scheduled-tasks-note">{tr("应用运行时调度。睡眠或退出后，恢复时按策略补执行一次或跳过；每个任务保留最近 100 条已结束记录。", "Runs while the app is open. After sleep or exit, catch up once or skip. Keeps the latest 100 settled runs per task.")}</p></div>
      <button type="button" disabled={!api || pending || choices.length === 0} onClick={() => setEditor("new")}>{tr("创建任务", "New task")}</button></header>
    {error && <p role="alert" className="scheduled-tasks-error">{error}</p>}
    {!api && <p role="status">{tr("定时任务 API 不可用，请在桌面应用中打开。", "Scheduled Tasks is available in the desktop app.")}</p>}
    {choices.length === 0 && <p>{tr("请先选择工作区，再创建任务。", "Choose a workspace before creating a task.")}</p>}
    {editor && <TaskForm key={editor === "new" ? "new" : editor.id} task={editor === "new" ? null : editor} workspaces={choices}
      workspace={workspace} pending={pending} catalog={catalog} catalogError={catalogError} onCancel={() => setEditor(null)} onSave={async input => {
        if (!api) return;
        const saved = await action(() => editor === "new" ? api.create(input) : api.update(editor!.id, { ...input, status: editor!.status === "paused" ? "paused" : "active" }));
        if (saved) setEditor(null);
      }} />}
    <div className="scheduled-tasks-filter"><span className="scheduled-tasks-count">{tr(`${tasks.length} 个任务`, tasks.length === 1 ? "1 task" : `${tasks.length} tasks`)}</span>
      <label>{tr("显示", "Show")} <select value={scope} onChange={event => setScope(event.target.value)}>
        <option value="all">{tr("全部工作区", "All workspaces")}</option><option value="current">{tr("当前工作区", "Current workspace")}</option>
      </select></label></div>
    {loading && <p role="status">{tr("加载中…", "Loading…")}</p>}
    {!loading && tasks.length === 0 && <div className="scheduled-tasks-empty"><strong>{tr("暂无定时任务", "No scheduled tasks yet")}</strong><span>{tr("创建一个提醒或周期任务，或在对话中输入：每天晚上 10 点提醒我复习英语。", "Create a reminder or recurring task, or ask in chat: remind me to study English every day at 10 pm.")}</span></div>}
    <div className="scheduled-tasks-list">{tasks.map(task => {
      const runs = state.runs.filter(run => run.taskId === task.id).sort((a, b) => b.startedAt - a.startedAt);
      const running = runs.some(run => run.status === "running");
      const latest = runs[0];
      const shown = running ? "running" : task.status;
      return <article key={task.id} className="scheduled-task-card">
        <div className="scheduled-task-title"><h3>{task.title}</h3><span className="st-status" data-tone={statusTone(shown)}>{statusText(shown)}</span></div>
        <p className="scheduled-task-prompt">{task.prompt}</p>
        {task.recipeBinding && <details><summary>{tr('配方绑定', 'Recipe binding')}: {task.recipeBinding.recipeSnapshot.name} · r{task.recipeBinding.recipeSnapshot.revision} · {task.recipeBinding.versionPolicy === 'fixed' ? tr('固定版本', 'Pinned version') : tr('跟随新版', 'Follow latest')}</summary><p>{task.recipeBinding.mode} · {JSON.stringify(task.recipeBinding.values)}</p><pre className="scheduled-task-prompt">{task.recipeBinding.recipeSnapshot.objectiveTemplate}{'\n\n'}{task.recipeBinding.recipeSnapshot.workflowTemplate}{'\n\n'}{task.recipeBinding.recipeSnapshot.deliverableTemplate}{'\n\n'}{task.recipeBinding.additionalInstructions}</pre></details>}
        <dl className="st-meta">
          <div><dt>{tr("周期", "Schedule")}</dt><dd>{scheduleText(task.schedule)}</dd></div>
          <div><dt>{tr("下次执行", "Next run")}</dt><dd>{dateText(task.nextRunAt)}</dd></div>
          <div><dt>{tr("最近执行", "Latest run")}</dt><dd>{latest ? <><span className="st-dot" data-tone={statusTone(latest.status)} />{statusText(latest.status)} · {dateText(latest.startedAt)}</> : "—"}</dd></div>
          <div><dt>{tr("工作区", "Workspace")}</dt><dd className="scheduled-task-path" title={task.workspace}>{baseName(task.workspace)}</dd></div>
        </dl>
        <div className="scheduled-task-actions">
          <button type="button" className="st-primary" disabled={pending || running} onClick={() => { void action(() => api!.runNow(task.id)); }}>{tr("立即执行", "Run now")}</button>
          <button type="button" disabled={pending} onClick={() => setEditor(task)}>{tr("编辑", "Edit")}</button>
          {task.status !== "completed" && <button type="button" disabled={pending} onClick={() => { void action(() => api!.update(task.id, { status: task.status === "paused" ? "active" : "paused" })); }}>{task.status === "paused" ? tr("恢复", "Resume") : tr("暂停", "Pause")}</button>}
          <button type="button" aria-expanded={expanded === task.id} onClick={() => setExpanded(expanded === task.id ? null : task.id)}>{tr("执行记录", "History")} ({runs.length})</button>
          <button type="button" className="st-danger" disabled={pending || running} onClick={() => setDeleting(task.id)}>{tr("删除", "Delete")}</button>
        </div>
        {deleting === task.id && <div className="scheduled-task-actions st-confirm"><span>{tr("删除任务及其执行记录？", "Delete this task and its history?")}</span>
          <button type="button" className="st-danger" disabled={pending} onClick={() => { void action(() => api!.delete(task.id)).then(ok => { if (ok) setDeleting(null); }); }}>{tr("确认删除", "Confirm delete")}</button>
          <button type="button" onClick={() => setDeleting(null)}>{tr("取消", "Cancel")}</button></div>}
        {expanded === task.id && <ol className="scheduled-task-history">{runs.length === 0 && <li>{tr("尚未执行", "No runs yet")}</li>}{runs.map(run => <li key={run.id}>
          <div>{statusText(run.status)} · {run.trigger === "manual" ? tr("手动", "Manual") : tr("定时", "Scheduled")} · {dateText(run.startedAt)}</div>
          <div>{tr("计划时间", "Scheduled for")}: {dateText(run.scheduledAt)}</div>
          {run.finishedAt && <div>{tr("结束时间", "Finished")}: {dateText(run.finishedAt)}</div>}
          {run.error && <p className="scheduled-tasks-error">{run.error}</p>}
          {run.conversationId && <button type="button" onClick={() => onOpenConversation(run.conversationId!)}>{tr("打开对话", "Open chat")}</button>}
        </li>)}</ol>}
      </article>;
    })}</div>
  </section></div></main>;
}

function TaskForm({ task, workspaces, workspace, pending, catalog, catalogError, onCancel, onSave }: {
  task: ScheduledTask | null; workspaces: string[]; workspace: string | null; pending: boolean;
  catalog: ModelCatalog | null; catalogError: string | null;
  onCancel: () => void; onSave: (input: ScheduledTaskInput) => Promise<void>;
}) {
  const id = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = dialogRef.current; if (dialog && !dialog.open) { dialog.showModal(); dialog.querySelector<HTMLElement>(".st-form-body :is(input, textarea)")?.focus(); } }, []);
  const [title, setTitle] = useState(task?.title ?? "");
  const [prompt, setPrompt] = useState(task?.prompt ?? "");
  const [cwd, setCwd] = useState(task?.workspace ?? workspace ?? workspaces[0] ?? "");
  const [sandboxMode, setSandboxMode] = useState<SandboxMode | "">(task?.sandboxMode ?? "");
  const [model, setModel] = useState(task?.model ? JSON.stringify([task.model.provider, task.model.id]) : "");
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel | "">(task?.thinkingLevel ?? "");
  const selectedModel = catalog?.models.find(item => JSON.stringify([item.provider, item.id]) === model);
  const levels = selectedModel ? selectedModel.thinkingLevels : thinkingLevels;
  const modelMissing = Boolean(model && catalog && !selectedModel);
  const [kind, setKind] = useState<TaskSchedule["kind"]>(task?.schedule.kind ?? "daily");
  const [time, setTime] = useState(task?.schedule.kind === "daily" || task?.schedule.kind === "weekly" ? task.schedule.time : "22:00");
  const [timezone, setTimezone] = useState(task && task.schedule.kind !== "once" ? task.schedule.timezone : Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [weekdays, setWeekdays] = useState(task?.schedule.kind === "weekly" ? task.schedule.weekdays : [1]);
  const [cron, setCron] = useState(task?.schedule.kind === "cron" ? task.schedule.expression : "0 22 * * *");
  const initialAt = new Date(task?.schedule.kind === "once" ? task.schedule.at : Date.now() + 3600_000);
  const [at, setAt] = useState(new Date(initialAt.getTime() - initialAt.getTimezoneOffset() * 60000).toISOString().slice(0, 16));
  const [policy, setPolicy] = useState(task?.missedPolicy ?? "run-once");
  const [recipePolicy, setRecipePolicy] = useState(task?.recipeBinding?.versionPolicy ?? 'fixed');
  const [error, setError] = useState<string | null>(null);
  return <dialog ref={dialogRef} className="st-dialog" aria-labelledby={`${id}-heading`} onCancel={event => { event.preventDefault(); if (!pending) onCancel(); }}
    onMouseDown={event => { if (event.target === event.currentTarget && !pending) onCancel(); }}>
  <form className="scheduled-task-form st-form" aria-labelledby={`${id}-heading`} onSubmit={event => {
    event.preventDefault(); setError(null);
    try {
      if (kind === "weekly" && weekdays.length === 0) throw new Error(tr("至少选择一天", "Select at least one day"));
      const schedule: TaskSchedule = kind === "once" ? { kind, at: new Date(at).toISOString() }
        : kind === "cron" ? { kind, expression: cron, timezone }
          : kind === "weekly" ? { kind, time, weekdays, timezone } : { kind, time, timezone };
      if (model && catalog && (!selectedModel || !selectedModel.available)) throw new Error(tr("所选模型不可用，请选择其他模型或沿用应用设置。", "The selected model is unavailable. Choose another model or use app settings."));
      if (thinkingLevel && !levels.includes(thinkingLevel)) throw new Error(tr("所选模型不支持此推理强度，请重新选择。", "Choose a reasoning effort supported by the selected model."));
      const [provider, modelId] = model ? JSON.parse(model) as [string, string] : [];
      void onSave({ title, prompt, workspace: cwd, schedule, missedPolicy: policy, sandboxMode: sandboxMode || null,
        model: provider && modelId ? { provider, id: modelId } : null, thinkingLevel: thinkingLevel || null,
        ...(task?.recipeBinding ? { recipeBinding: { ...task.recipeBinding, versionPolicy: recipePolicy } } : {}) });
    } catch (caught) { setError(cleanErrorMessage(caught)); }
  }}>
    <div className="st-form-head"><h3 id={`${id}-heading`}>{task ? tr("编辑任务", "Edit task") : tr("创建任务", "Create task")}</h3>
      <button type="button" className="st-close" aria-label={tr("关闭", "Close")} title={tr("关闭", "Close")} disabled={pending} onClick={onCancel}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg></button></div>
    <fieldset disabled={pending}>
      <div className="st-form-body">
        <section className="st-section">
          <label>{tr("名称", "Name")}<input required maxLength={200} value={title} onChange={event => setTitle(event.target.value)} /></label>
          <label>{tr("执行内容（Prompt）", "Prompt")}<textarea readOnly={!!task?.recipeBinding} required maxLength={100000} rows={5} value={prompt} onChange={event => setPrompt(event.target.value)} /></label>
          {task?.recipeBinding && <><label>{tr('配方版本策略', 'Recipe version policy')}<select value={recipePolicy} onChange={e => setRecipePolicy(e.target.value as 'fixed' | 'latest')}><option value="fixed">{tr('固定绑定快照', 'Pin bound snapshot')}</option><option value="latest">{tr('每次跟随新版', 'Follow latest at each run')}</option></select></label><p className="scheduled-tasks-note">{tr('配方参数和正文来自绑定快照；修改参数请在任务配方中重新绑定。', 'Parameters and text come from the bound snapshot. Create a new binding in Task Recipes to change parameters.')}</p></>}
          <label>{tr("工作区", "Workspace")}<select required value={cwd} onChange={event => setCwd(event.target.value)}>{workspaces.map(path => <option key={path} value={path}>{path}</option>)}</select></label>
        </section>
        <section className="st-section">
          <h4>{tr("运行计划", "Schedule")}</h4>
          <div className="scheduled-task-schedule">
            <label>{tr("周期", "Schedule")}<select value={kind} onChange={event => setKind(event.target.value as TaskSchedule["kind"])}>
              <option value="once">{tr("一次性", "Once")}</option><option value="daily">{tr("每日", "Daily")}</option><option value="weekly">{tr("每周", "Weekly")}</option><option value="cron">Cron</option>
            </select></label>
            {kind === "once" ? <label className="st-span-2">{tr("执行时间（本机时区）", "Run time (local timezone)")}<input required type="datetime-local" value={at} onChange={event => setAt(event.target.value)} /></label>
              : <>{kind === "cron" ? <label className="st-span-2">{tr("Cron（分 时 日 月 星期）", "Cron (minute hour day month weekday)")}<input required value={cron} onChange={event => setCron(event.target.value)} /></label>
                  : <label>{tr("时间", "Time")}<input required type="time" value={time} onChange={event => setTime(event.target.value)} /></label>}
                <label>{tr("时区", "Timezone")}<input required value={timezone} onChange={event => setTimezone(event.target.value)} /></label></>}
            <label>{tr("错过执行时", "When a run is missed")}<select value={policy} onChange={event => setPolicy(event.target.value as "run-once" | "skip")}>
              <option value="run-once">{tr("恢复后补执行一次", "Catch up once")}</option><option value="skip">{tr("跳过", "Skip")}</option></select></label>
          </div>
          {kind === "weekly" && <fieldset className="scheduled-task-weekdays"><legend>{tr("星期", "Weekdays")}</legend>{days().map((day, index) => <label key={day}><input type="checkbox" checked={weekdays.includes(index)} onChange={event => setWeekdays(event.target.checked ? [...weekdays, index] : weekdays.filter(value => value !== index))} /><span>{day}</span></label>)}</fieldset>}
        </section>
        <section className="st-section">
          <h4>{tr("执行设置", "Run settings")}</h4>
          <div className="scheduled-task-execution">
            <label>{tr("执行权限", "Execution permissions")}<select value={sandboxMode} onChange={event => setSandboxMode(event.target.value as SandboxMode | "")}>
              <option value="">{tr("沿用应用设置", "Use app settings")}</option>
              <option value="ask">{tr("每次询问", "Ask every time")}</option><option value="smart">{tr("帮我批准", "Smart approval")}</option><option value="full">{tr("完全访问", "Full access")}</option>
            </select></label>
            <label>{tr("模型", "Model")}<select value={model} onChange={event => {
              const next = event.target.value; setModel(next);
              const supported = catalog?.models.find(item => JSON.stringify([item.provider, item.id]) === next)?.thinkingLevels;
              if (thinkingLevel && supported && !supported.includes(thinkingLevel)) setThinkingLevel("");
            }}>
              <option value="">{tr("沿用应用设置", "Use app settings")}</option>
              {modelMissing && <option value={model} disabled>{task?.model?.provider} / {task?.model?.id} · {tr("不可用", "Unavailable")}</option>}
              {catalog?.models.map(item => <option key={JSON.stringify([item.provider, item.id])} value={JSON.stringify([item.provider, item.id])} disabled={!item.available}>
                {item.providerName} / {item.name}{item.available ? "" : ` · ${tr("不可用", "Unavailable")}`}
              </option>)}
            </select></label>
            <label>{tr("推理强度", "Reasoning effort")}<select value={thinkingLevel} onChange={event => setThinkingLevel(event.target.value as ThinkingLevel | "")}>
              <option value="">{tr("沿用应用设置", "Use app settings")}</option>
              {thinkingLevel && !levels.includes(thinkingLevel) && <option value={thinkingLevel} disabled>{tr("当前强度不受支持", "Current effort is unsupported")}</option>}
              {levels.map(level => <option key={level} value={level}>{tr(thinkingLevelLabel[level], level === "off" ? "Off" : level)}</option>)}
            </select></label>
          </div>
          <p className="scheduled-tasks-note">{tr("设置仅用于此任务。每次询问和帮我批准可能需要你在执行时确认操作。", "These settings apply to this task. Ask every time and smart approval may need your confirmation during execution.")}</p>
          {(catalogError || catalog?.error) && <p role="alert" className="scheduled-tasks-error">{catalogError || catalog?.error}</p>}
        </section>
        {error && <p role="alert" className="scheduled-tasks-error">{error}</p>}
      </div>
      <div className="st-form-foot"><button type="button" onClick={onCancel}>{tr("取消", "Cancel")}</button><button type="submit" className="st-primary">{pending ? tr("保存中…", "Saving…") : tr("保存任务", "Save task")}</button></div>
    </fieldset>
  </form></dialog>;
}
