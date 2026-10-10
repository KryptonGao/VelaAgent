import type {
  ProactiveRule,
  ProactiveSkipReason,
  ProactiveTriggerKind,
  ResidentMode,
  ResidentState,
  ResidentStatus,
  ResidentTask,
  ResidentTaskStatus,
} from "@vela/shared";
import { localizeError, tr, trf } from "../locale";

export const stateLabel = (state: ResidentState): string => ({
  ready: tr("待命", "Ready"),
  working: tr("工作中", "Working"),
  waiting_user: tr("等你处理", "Waiting for you"),
  paused: tr("已暂停", "Paused"),
  suspended: tr("系统休眠中", "System asleep"),
  offline: tr("未运行", "Offline"),
  error: tr("出错", "Error"),
} as const)[state];

export const modeLabel = (mode: ResidentMode): string => ({
  disabled: tr("关闭", "Disabled"),
  standby: tr("待命", "Standby"),
  proactive: tr("主动", "Proactive"),
} as const)[mode];

export const modeDescription = (mode: ResidentMode): string => ({
  disabled: tr("不创建新的后台任务，也不监听任何事件。已经在运行的对话不受影响。", "No new background tasks and no event listening. Conversations already running aren't affected."),
  standby: tr("只处理你交给它的任务；没有新事件时不会调用模型。", "Only handles tasks you hand over. The model isn't called when nothing new happens."),
  proactive: tr("在待命的基础上，按你订阅的规则在事件发生时主动分析。每次触发都会调用模型并产生费用。", "On top of Standby, analyses on its own when an event matches a rule you subscribed to. Every run calls the model and costs money."),
} as const)[mode];

export const taskStatusLabel = (status: ResidentTaskStatus): string => ({
  queued: tr("排队中", "Queued"),
  running: tr("运行中", "Running"),
  succeeded: tr("已完成", "Done"),
  failed: tr("失败", "Failed"),
  cancelled: tr("已取消", "Cancelled"),
  interrupted: tr("已中断", "Interrupted"),
  timed_out: tr("已超时", "Timed out"),
} as const)[status];

export const taskSourceLabel = (source: ResidentTask["source"]): string => ({
  user: tr("你创建", "You"),
  agent: tr("Resident 委派", "Resident"),
  rule: tr("主动规则", "Rule"),
} as const)[source];

export const triggerLabel = (kind: ProactiveTriggerKind): string => ({
  inbox_error: tr("收件箱出现失败事项", "A failure shows up in the Inbox"),
  git_change: tr("Git 分支或提交变化", "Git branch or commits change"),
  file_change: tr("工作区文件变化", "Workspace files change"),
} as const)[kind];

export const triggerFilterHint = (kind: ProactiveTriggerKind): string => kind === "file_change"
  ? tr("只关注路径包含…（可留空）", "Only paths containing… (optional)")
  : kind === "inbox_error"
    ? tr("只关注标题或内容包含…（可留空）", "Only titles or text containing… (optional)")
    : "";

export const skipReasonLabel = (reason: ProactiveSkipReason): string => ({
  disabled_mode: tr("当前不是主动模式，或规则已停用", "Not in Proactive mode, or the rule is off"),
  paused: tr("后台自动任务已暂停", "Background tasks are paused"),
  battery: tr("电池供电，主动任务已暂停", "On battery, so proactive runs are paused"),
  suspended: tr("系统休眠中", "The system is asleep"),
  cooldown: tr("还在冷却时间内", "Still cooling down"),
  daily_limit: tr("今天的主动运行次数已用完", "Today's proactive run limit is reached"),
  rule_limit: tr("这条规则今天的次数已用完", "This rule's limit for today is reached"),
  already_running: tr("这条规则已有任务在运行", "This rule already has a task running"),
  busy: tr("后台任务队列已满，稍后重试", "The task queue is full; retrying later"),
  filtered: tr("工作区不可用", "The workspace isn't available"),
} as const)[reason];

/** 分钟数转 `HH:MM`，供 `<input type="time">` 使用。 */
export function formatMinute(minute: number): string {
  const safe = Math.max(0, Math.min(1439, Math.floor(minute)));
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

/** `HH:MM` 转分钟数；格式不对时返回 null。 */
export function parseMinute(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours < 24 && minutes < 60 ? hours * 60 + minutes : null;
}

/** 总览里一句话说明现在的状态，数量都来自主进程的真实记录。 */
export function statusSummary(status: ResidentStatus): string {
  const parts: string[] = [];
  if (status.runningTasks > 0) parts.push(trf("{0} 个任务运行中", "{0} running", status.runningTasks));
  if (status.queuedTasks > 0) parts.push(trf("{0} 个排队", "{0} queued", status.queuedTasks));
  if (status.waitingItems > 0) parts.push(trf("{0} 项等你处理", "{0} waiting for you", status.waitingItems));
  if (status.onBattery) parts.push(tr("电池供电", "On battery"));
  return parts.length ? parts.join(" · ") : tr("没有进行中的事项", "Nothing in progress");
}

/** 规则当前的一句话状态。 */
export function ruleStatus(rule: ProactiveRule, active: boolean): string {
  if (!rule.enabled) return tr("已停用", "Off");
  if (!active) return tr("未生效：需要主动模式", "Inactive: needs Proactive mode");
  if (rule.lastSkip) return trf("最近一次未触发：{0}", "Last skipped: {0}", skipReasonLabel(rule.lastSkip.reason));
  return rule.lastTriggeredAt ? tr("运行正常", "Running normally") : tr("等待事件", "Waiting for an event");
}

export function activeTasks(tasks: readonly ResidentTask[]): ResidentTask[] {
  return tasks.filter(task => task.status === "queued" || task.status === "running");
}

/** 任务记录里存的是主进程写下的中文原因；按当前语言显示，其余错误交给通用的错误本地化。 */
export function taskErrorText(error: string): string {
  if (error === "应用退出或重启时任务尚未完成") return tr("应用退出或重启时任务尚未完成", "The task wasn't finished when the app quit or restarted");
  const timeout = /^超过 (\d+) 分钟，已停止$/.exec(error);
  if (timeout) return trf("超过 {0} 分钟，已停止", "Stopped after {0} minutes", timeout[1]);
  return localizeError(error);
}
