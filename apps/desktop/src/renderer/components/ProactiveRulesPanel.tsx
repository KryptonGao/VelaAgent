import { useState } from "react";
import {
  proactiveTriggerKinds,
  residentLimits,
  type ProactiveRule,
  type ProactiveRuleInput,
  type ProactiveRulesState,
  type ResidentAgentApi,
  type ResidentSettings,
  type ResidentStatus,
} from "@vela/shared";
import { activeIntlLocale, tr, trf } from "../locale";
import { ruleStatus, triggerFilterHint, triggerLabel } from "./resident-agent-model";

const baseName = (path: string) => path.split("/").filter(Boolean).pop() ?? path;

function emptyDraft(workspace: string): ProactiveRuleInput {
  return {
    title: "", workspace, prompt: "", trigger: { kind: "inbox_error", filter: "" },
    cooldownMinutes: residentLimits.cooldownMinutes.fallback, maxRunsPerDay: residentLimits.maxRunsPerDay.fallback, allowTools: false, enabled: true,
  };
}

function toInput(rule: ProactiveRule): ProactiveRuleInput {
  const { title, workspace, prompt, trigger, cooldownMinutes, maxRunsPerDay, allowTools, enabled } = rule;
  return { title, workspace, prompt, trigger: { ...trigger }, cooldownMinutes, maxRunsPerDay, allowTools, enabled };
}

function RuleForm({ draft, workspaces, saving, error, onChange, onSave, onCancel }: {
  draft: ProactiveRuleInput;
  workspaces: string[];
  saving: boolean;
  error: string | null;
  onChange: (draft: ProactiveRuleInput) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const set = (patch: Partial<ProactiveRuleInput>) => onChange({ ...draft, ...patch });
  const hint = triggerFilterHint(draft.trigger.kind);
  return <form className="resident-rule-form" onSubmit={event => { event.preventDefault(); onSave(); }} aria-label={tr("主动规则", "Proactive rule")}>
    {error ? <p className="agent-inbox-notice" role="alert">{error}</p> : null}
    <label><span>{tr("规则名称", "Name")}</span>
      <input value={draft.title} maxLength={residentLimits.maxTitle} required onChange={event => set({ title: event.target.value })} /></label>
    <label><span>{tr("工作区", "Workspace")}</span>
      <select value={draft.workspace} required onChange={event => set({ workspace: event.target.value })}>
        {!workspaces.includes(draft.workspace) ? <option value={draft.workspace}>{draft.workspace || tr("选择工作区", "Choose a workspace")}</option> : null}
        {workspaces.map(path => <option key={path} value={path} title={path}>{baseName(path)}</option>)}
      </select></label>
    <label><span>{tr("触发条件", "When")}</span>
      <select value={draft.trigger.kind} onChange={event => set({ trigger: { kind: event.target.value as ProactiveRuleInput["trigger"]["kind"], filter: "" } })}>
        {proactiveTriggerKinds.map(kind => <option key={kind} value={kind}>{triggerLabel(kind)}</option>)}
      </select></label>
    {hint ? <label><span>{tr("过滤", "Filter")}</span>
      <input value={draft.trigger.filter} maxLength={residentLimits.maxRuleFilter} placeholder={hint} onChange={event => set({ trigger: { ...draft.trigger, filter: event.target.value } })} /></label> : null}
    <label><span>{tr("触发后做什么", "Then do")}</span>
      <textarea rows={3} value={draft.prompt} maxLength={residentLimits.maxRulePrompt} required
        placeholder={tr("例如：分析失败原因，给出最小的修复建议", "e.g. Work out why it failed and suggest the smallest fix")} onChange={event => set({ prompt: event.target.value })} /></label>
    <div className="resident-rule-numbers">
      <label><span>{tr("冷却时间（分钟）", "Cooldown (min)")}</span>
        <input type="number" min={residentLimits.cooldownMinutes.min} max={residentLimits.cooldownMinutes.max} value={draft.cooldownMinutes}
          onChange={event => set({ cooldownMinutes: Number(event.target.value) })} /></label>
      <label><span>{tr("每天最多（次）", "Max per day")}</span>
        <input type="number" min={residentLimits.maxRunsPerDay.min} max={residentLimits.maxRunsPerDay.max} value={draft.maxRunsPerDay}
          onChange={event => set({ maxRunsPerDay: Number(event.target.value) })} /></label>
    </div>
    <label className="resident-row">
      <span className="resident-row-text"><span>{tr("允许运行命令和修改文件", "Allow commands and file changes")}</span>
        <small>{tr("默认只读分析。开启后每个操作仍然需要你在收件箱里批准。", "Read-only by default. When on, every action still needs your approval in the Inbox.")}</small></span>
      <input type="checkbox" role="switch" checked={draft.allowTools} onChange={event => set({ allowTools: event.target.checked })} />
    </label>
    <div className="resident-rule-actions">
      <button type="button" onClick={onCancel}>{tr("取消", "Cancel")}</button>
      <button type="submit" className="agent-inbox-primary" disabled={saving || !draft.title.trim() || !draft.prompt.trim() || !draft.workspace}>{tr("保存规则", "Save rule")}</button>
    </div>
  </form>;
}

export function ProactiveRulesPanel({ api, status, settings, rules }: {
  api: ResidentAgentApi;
  status: ResidentStatus;
  settings: ResidentSettings;
  rules: ProactiveRulesState | null;
}) {
  const [editing, setEditing] = useState<{ id: string | null; draft: ProactiveRuleInput } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = settings.mode === "proactive" && !settings.paused;
  const list = rules?.rules ?? [];

  const save = async () => {
    if (!editing) return;
    setSaving(true); setError(null);
    try {
      const result = await api.rules.save(editing.draft, editing.id ?? undefined);
      if (result.ok) setEditing(null); else setError(result.error);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setSaving(false); }
  };
  const toggle = async (rule: ProactiveRule) => {
    setError(null);
    try {
      const result = await api.rules.save({ ...toInput(rule), enabled: !rule.enabled }, rule.id);
      if (!result.ok) setError(result.error);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const remove = async (rule: ProactiveRule) => {
    setError(null);
    try { await api.rules.remove(rule.id); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  return <div className="resident-rules">
    <p className="agent-inbox-notice resident-cost" role="note">{tr(
      "规则只在「主动」模式下生效。每次触发都会调用模型并产生费用；同一批事件会合并成一次运行，并受冷却时间、每日次数、电池和并发限制约束。",
      "Rules only work in Proactive mode. Each trigger calls the model and costs money. A burst of events becomes one run, bounded by cooldown, daily limits, battery and concurrency.")}</p>
    {!active ? <p className="agent-inbox-muted" role="status">{settings.paused ? tr("后台自动任务已暂停，规则不会触发。", "Background tasks are paused, so rules won't trigger.") : tr("当前不是主动模式，规则不会触发。", "Proactive mode is off, so rules won't trigger.")}</p> : null}
    {rules?.error ? <p className="agent-inbox-notice" role="alert">{rules.error}</p> : null}
    {error && !editing ? <p className="agent-inbox-notice" role="alert">{error}</p> : null}
    {editing
      ? <RuleForm draft={editing.draft} workspaces={status.workspaces} saving={saving} error={error}
        onChange={draft => setEditing({ ...editing, draft })} onSave={() => void save()} onCancel={() => { setEditing(null); setError(null); }} />
      : <div className="resident-rule-toolbar">
        <button type="button" className="agent-inbox-primary" disabled={status.workspaces.length === 0 || list.length >= residentLimits.maxRules}
          onClick={() => { setError(null); setEditing({ id: null, draft: emptyDraft(status.workspaces[0] ?? "") }); }}>{tr("新建规则", "New rule")}</button>
        {status.workspaces.length === 0 ? <span className="agent-inbox-muted">{tr("先打开一个工作区。", "Open a workspace first.")}</span> : null}
      </div>}
    {list.length === 0 && !editing ? <p className="agent-inbox-empty">{tr("还没有规则。比如：工作区里的测试失败时，让 Agent 先分析原因。", "No rules yet. For example: when tests fail in a workspace, have the Agent look into why first.")}</p> : null}
    <ul className="resident-rule-list" aria-label={tr("规则列表", "Rules")}>
      {list.map(rule => <li key={rule.id} className="resident-rule" data-enabled={rule.enabled ? "" : undefined}>
        <div className="resident-rule-main">
          <strong>{rule.title}</strong>
          <span className="resident-rule-meta">{baseName(rule.workspace)} · {triggerLabel(rule.trigger.kind)}{rule.trigger.filter ? ` · “${rule.trigger.filter}”` : ""}</span>
          <span className="resident-rule-state" data-skip={rule.lastSkip ? "" : undefined}>{ruleStatus(rule, active)}</span>
          <span className="resident-rule-meta">
            {trf("冷却 {0} 分钟 · 每天最多 {1} 次", "Cooldown {0} min · up to {1}/day", rule.cooldownMinutes, rule.maxRunsPerDay)}
            {rule.lastTriggeredAt ? ` · ${trf("上次 {0}", "Last {0}", new Date(rule.lastTriggeredAt).toLocaleString(activeIntlLocale(), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }))}` : ""}
          </span>
        </div>
        <div className="resident-rule-buttons">
          <button type="button" role="switch" aria-checked={rule.enabled} aria-label={trf("启用规则：{0}", "Enable rule: {0}", rule.title)} onClick={() => void toggle(rule)}>{rule.enabled ? tr("停用", "Turn off") : tr("启用", "Turn on")}</button>
          <button type="button" onClick={() => { setError(null); setEditing({ id: rule.id, draft: toInput(rule) }); }}>{tr("编辑", "Edit")}</button>
          <button type="button" onClick={() => void remove(rule)}>{tr("删除", "Delete")}</button>
        </div>
      </li>)}
    </ul>
  </div>;
}
