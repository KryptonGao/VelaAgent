import { useEffect, useRef, useState } from "react";
import { residentLimits, type ResidentAgentApi, type ResidentSettings, type ResidentSettingsPatch } from "@vela/shared";
import { tr } from "../locale";
import { formatMinute, parseMinute } from "./resident-agent-model";

function Toggle({ label, hint, checked, disabled, onChange }: { label: string; hint?: string; checked: boolean; disabled?: boolean; onChange: (value: boolean) => void }) {
  return <label className="resident-row">
    <span className="resident-row-text"><span>{label}</span>{hint ? <small>{hint}</small> : null}</span>
    <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} />
  </label>;
}

function NumberRow({ label, hint, value, min, max, unit, disabled, onCommit }: {
  label: string; hint?: string; value: number; min: number; max: number; unit?: string; disabled?: boolean; onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) { setDraft(String(value)); return; }
    const next = Math.min(max, Math.max(min, Math.round(parsed)));
    setDraft(String(next));
    if (next !== value) onCommit(next);
  };
  return <label className="resident-row">
    <span className="resident-row-text"><span>{label}</span>{hint ? <small>{hint}</small> : null}</span>
    <span className="resident-number">
      <input type="number" inputMode="numeric" min={min} max={max} value={draft} disabled={disabled}
        onChange={event => setDraft(event.target.value)} onBlur={commit} onKeyDown={event => { if (event.key === "Enter") commit(); }} />
      {unit ? <span aria-hidden="true">{unit}</span> : null}
    </span>
  </label>;
}

/** 设置面板。每次修改都立刻交给主进程规整并保存，界面始终显示主进程返回的结果。 */
export function ResidentSettingsPanel({ api, settings, onSettings }: { api: ResidentAgentApi; settings: ResidentSettings; onSettings: (settings: ResidentSettings) => void }) {
  const [error, setError] = useState<string | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const update = (patch: ResidentSettingsPatch) => {
    setError(null);
    // 串行提交：快速连续修改不会因为乱序返回而回退。
    queue.current = queue.current.then(async () => {
      try { onSettings(await api.updateSettings(patch)); }
      catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    });
  };
  const { notifications: notify, limits } = settings;
  const quiet = notify.quietHours;
  return <div className="resident-settings">
    {error ? <p className="agent-inbox-notice" role="alert">{error}</p> : null}

    <fieldset>
      <legend>{tr("后台运行", "Running in the background")}</legend>
      <Toggle label={tr("在菜单栏显示状态", "Show status in the menu bar")} hint={tr("显示待处理数量，并可一键暂停后台任务。", "Shows the pending count and a one-click pause.")}
        checked={settings.showMenuBarIcon} onChange={value => update({ showMenuBarIcon: value })} />
      <Toggle label={tr("登录时自动启动", "Launch at login")} hint={tr("开机后在后台启动，不打开窗口。仅安装版有效。", "Starts in the background at login without opening a window. Installed app only.")}
        checked={settings.launchAtLogin} onChange={value => update({ launchAtLogin: value })} />
      <Toggle label={tr("关闭所有窗口时退出应用", "Quit when all windows are closed")} hint={tr("关闭后，后台任务、通知和主动规则都会随应用停止。", "When on, background tasks, notifications and rules stop with the app.")}
        checked={settings.quitWhenWindowsClosed} onChange={value => update({ quitWhenWindowsClosed: value })} />
      <p className="agent-inbox-muted">{tr("Vela 只在应用运行时工作：退出应用或电脑休眠时，正在运行的任务会暂停或中断，不会自动重放。", "Vela only works while the app runs. Quitting or sleeping pauses or interrupts running tasks, and they are never replayed automatically.")}</p>
    </fieldset>

    <fieldset>
      <legend>{tr("通知", "Notifications")}</legend>
      <Toggle label={tr("系统通知", "System notifications")} hint={tr("有事项需要你处理时提醒；应用在前台时不打扰。", "Alerts you when something needs attention. Stays quiet while the app is in front.")}
        checked={notify.enabled} onChange={value => update({ notifications: { enabled: value } })} />
      <Toggle label={tr("隐藏通知内容", "Hide notification previews")} hint={tr("通知里不显示命令、路径和回答，只提示有事项。", "Notifications won't show commands, paths or answers.")}
        checked={notify.hidePreview} disabled={!notify.enabled} onChange={value => update({ notifications: { hidePreview: value } })} />
      <Toggle label={tr("任务完成时也提醒", "Also notify when tasks finish")} hint={tr("默认只提醒需要你处理的事项和 Agent 的建议。", "By default only items needing you and Agent suggestions notify.")}
        checked={notify.notifyResults} disabled={!notify.enabled} onChange={value => update({ notifications: { notifyResults: value } })} />
      <Toggle label={tr("静默时段", "Quiet hours")} hint={tr("这段时间不弹通知，事项仍会进入收件箱。", "No notifications in this window. Items still land in the Inbox.")}
        checked={quiet.enabled} disabled={!notify.enabled} onChange={value => update({ notifications: { quietHours: { enabled: value } } })} />
      {quiet.enabled && notify.enabled ? <div className="resident-row resident-quiet">
        <label><span>{tr("开始", "From")}</span>
          <input type="time" value={formatMinute(quiet.startMinute)} onChange={event => { const minute = parseMinute(event.target.value); if (minute !== null) update({ notifications: { quietHours: { startMinute: minute } } }); }} /></label>
        <label><span>{tr("结束", "To")}</span>
          <input type="time" value={formatMinute(quiet.endMinute)} onChange={event => { const minute = parseMinute(event.target.value); if (minute !== null) update({ notifications: { quietHours: { endMinute: minute } } }); }} /></label>
      </div> : null}
    </fieldset>

    <fieldset>
      <legend>{tr("资源限制", "Limits")}</legend>
      <NumberRow label={tr("同时运行的任务数", "Concurrent tasks")} value={limits.maxConcurrentTasks} min={residentLimits.maxConcurrentTasks.min} max={residentLimits.maxConcurrentTasks.max}
        onCommit={value => update({ limits: { maxConcurrentTasks: value } })} />
      <NumberRow label={tr("单个任务最长运行时间", "Longest a task may run")} value={limits.maxTaskMinutes} min={residentLimits.maxTaskMinutes.min} max={residentLimits.maxTaskMinutes.max} unit={tr("分钟", "min")}
        hint={tr("超时的任务会被停止，并在收件箱里标记为失败。", "Tasks past the limit are stopped and reported as failures in the Inbox.")}
        onCommit={value => update({ limits: { maxTaskMinutes: value } })} />
      <NumberRow label={tr("每天最多主动运行", "Proactive runs per day")} value={limits.dailyProactiveRuns} min={residentLimits.dailyProactiveRuns.min} max={residentLimits.dailyProactiveRuns.max} unit={tr("次", "runs")}
        hint={tr("每次主动运行都会调用模型。设为 0 则不允许主动触发。", "Each proactive run calls the model. 0 disables proactive triggers.")}
        onCommit={value => update({ limits: { dailyProactiveRuns: value } })} />
      <Toggle label={tr("电池供电时暂停主动任务", "Pause proactive runs on battery")} checked={limits.pauseProactiveOnBattery}
        onChange={value => update({ limits: { pauseProactiveOnBattery: value } })} />
      <p className="agent-inbox-muted">{tr("后台任务不会使用「完全访问」：即使全局设置为完全访问，也会按「帮我批准」运行。", "Background tasks never run with Full access: even if it's your global setting, they use Smart approval.")}</p>
    </fieldset>
  </div>;
}
