import type { SandboxMode, TranscriptMessage } from "./index";

/**
 * 常驻 Agent（Resident Agent）与主动规则的共享类型和纯逻辑。
 * 这里不依赖 Electron、React 或文件系统，主进程、渲染层和测试共用同一份判断。
 */

export const residentModes = ["disabled", "standby", "proactive"] as const;
/** Disabled 不创建新的后台任务；Standby 只处理已授权的任务；Proactive 额外允许用户订阅的规则主动分析。 */
export type ResidentMode = (typeof residentModes)[number];

export const residentStates = ["ready", "working", "waiting_user", "paused", "suspended", "offline", "error"] as const;
export type ResidentState = (typeof residentStates)[number];

export const residentLimits = {
  maxConcurrentTasks: { min: 1, max: 5, fallback: 2 },
  maxTaskMinutes: { min: 5, max: 240, fallback: 60 },
  dailyProactiveRuns: { min: 0, max: 100, fallback: 10 },
  maxQueued: 20,
  maxTitle: 120,
  maxPrompt: 8000,
  maxTasksKept: 60,
  maxTasksShown: 30,
  maxRules: 30,
  maxRulePrompt: 4000,
  maxRuleFilter: 200,
  cooldownMinutes: { min: 1, max: 24 * 60, fallback: 30 },
  maxRunsPerDay: { min: 1, max: 50, fallback: 5 },
} as const;

export interface ResidentQuietHours {
  enabled: boolean;
  /** 从本地零点算起的分钟数。结束早于开始时表示跨午夜。 */
  startMinute: number;
  endMinute: number;
}

export interface ResidentNotificationSettings {
  enabled: boolean;
  /** 通知里不显示命令、路径和回答内容，只显示「有事项需要处理」。 */
  hidePreview: boolean;
  /** 默认只提醒需要用户处理的事项和 Agent 的建议；开启后任务完成也提醒。 */
  notifyResults: boolean;
  quietHours: ResidentQuietHours;
}

export interface ResidentSettings {
  mode: ResidentMode;
  /** 用户一键暂停全部后台自动任务；不会中断已经在运行的 Agent。 */
  paused: boolean;
  showMenuBarIcon: boolean;
  launchAtLogin: boolean;
  /** 关闭最后一个窗口时退出应用。默认 false：macOS 上关闭窗口后应用继续在后台运行。 */
  quitWhenWindowsClosed: boolean;
  notifications: ResidentNotificationSettings;
  limits: {
    maxConcurrentTasks: number;
    /** 单个后台任务的最长运行时间，到点后停止。 */
    maxTaskMinutes: number;
    /** 主动规则每天最多触发的模型调用次数；0 表示不允许主动触发。 */
    dailyProactiveRuns: number;
    pauseProactiveOnBattery: boolean;
  };
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };
/** 渲染层只需要提交改变的字段，嵌套的通知与限制设置同样可以只给一部分。 */
export type ResidentSettingsPatch = DeepPartial<ResidentSettings>;

export const defaultResidentSettings: ResidentSettings = {
  mode: "standby",
  paused: false,
  showMenuBarIcon: true,
  launchAtLogin: false,
  quitWhenWindowsClosed: false,
  notifications: {
    enabled: true,
    hidePreview: false,
    notifyResults: false,
    quietHours: { enabled: false, startMinute: 22 * 60, endMinute: 8 * 60 },
  },
  limits: {
    maxConcurrentTasks: residentLimits.maxConcurrentTasks.fallback,
    maxTaskMinutes: residentLimits.maxTaskMinutes.fallback,
    dailyProactiveRuns: residentLimits.dailyProactiveRuns.fallback,
    pauseProactiveOnBattery: true,
  },
};

function clampInt(value: unknown, range: { min: number; max: number; fallback: number }): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return range.fallback;
  return Math.min(range.max, Math.max(range.min, Math.round(value)));
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function minute(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(24 * 60 - 1, Math.max(0, Math.round(value)));
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** 任何输入都规整成合法设置：未知字段丢弃，错误类型回退到默认，数值夹在范围内。 */
export function normalizeResidentSettings(raw: unknown, base: ResidentSettings = defaultResidentSettings): ResidentSettings {
  const input = record(raw);
  const notifications = record(input.notifications);
  const quiet = record(notifications.quietHours);
  const limits = record(input.limits);
  return {
    mode: (residentModes as readonly unknown[]).includes(input.mode) ? input.mode as ResidentMode : base.mode,
    paused: bool(input.paused, base.paused),
    showMenuBarIcon: bool(input.showMenuBarIcon, base.showMenuBarIcon),
    launchAtLogin: bool(input.launchAtLogin, base.launchAtLogin),
    quitWhenWindowsClosed: bool(input.quitWhenWindowsClosed, base.quitWhenWindowsClosed),
    notifications: {
      enabled: bool(notifications.enabled, base.notifications.enabled),
      hidePreview: bool(notifications.hidePreview, base.notifications.hidePreview),
      notifyResults: bool(notifications.notifyResults, base.notifications.notifyResults),
      quietHours: {
        enabled: bool(quiet.enabled, base.notifications.quietHours.enabled),
        startMinute: minute(quiet.startMinute, base.notifications.quietHours.startMinute),
        endMinute: minute(quiet.endMinute, base.notifications.quietHours.endMinute),
      },
    },
    limits: {
      maxConcurrentTasks: clampInt(limits.maxConcurrentTasks, { ...residentLimits.maxConcurrentTasks, fallback: base.limits.maxConcurrentTasks }),
      maxTaskMinutes: clampInt(limits.maxTaskMinutes, { ...residentLimits.maxTaskMinutes, fallback: base.limits.maxTaskMinutes }),
      dailyProactiveRuns: clampInt(limits.dailyProactiveRuns, { ...residentLimits.dailyProactiveRuns, fallback: base.limits.dailyProactiveRuns }),
      pauseProactiveOnBattery: bool(limits.pauseProactiveOnBattery, base.limits.pauseProactiveOnBattery),
    },
  };
}

/** 把渲染层传来的局部更新合并进当前设置。 */
export function mergeResidentSettings(current: ResidentSettings, patch: unknown): ResidentSettings {
  const input = record(patch);
  const merged = {
    ...current,
    ...input,
    notifications: {
      ...current.notifications,
      ...record(input.notifications),
      quietHours: { ...current.notifications.quietHours, ...record(record(input.notifications).quietHours) },
    },
    limits: { ...current.limits, ...record(input.limits) },
  };
  return normalizeResidentSettings(merged, current);
}

/** 静默时段内不弹系统通知；事项仍然进入 Inbox 并计入徽标。 */
export function isQuietNow(quiet: ResidentQuietHours, now: Date): boolean {
  if (!quiet.enabled || quiet.startMinute === quiet.endMinute) return false;
  const minuteOfDay = now.getHours() * 60 + now.getMinutes();
  return quiet.startMinute < quiet.endMinute
    ? minuteOfDay >= quiet.startMinute && minuteOfDay < quiet.endMinute
    : minuteOfDay >= quiet.startMinute || minuteOfDay < quiet.endMinute;
}

// ---------- 任务 ----------

export type ResidentTaskSource = "user" | "agent" | "rule";
export type ResidentTaskStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted" | "timed_out";

export interface ResidentTask {
  id: string;
  title: string;
  /** 任务提示的节选；完整内容在任务对话里。 */
  prompt: string;
  workspace: string;
  source: ResidentTaskSource;
  ruleId?: string;
  /** 主动规则命中时的触发原因，随结果一起展示。 */
  reason?: string;
  /** 任务开始后才有对话。 */
  conversationId: string | null;
  status: ResidentTaskStatus;
  error?: string;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export function isResidentTaskActive(status: ResidentTaskStatus): boolean {
  return status === "queued" || status === "running";
}

// ---------- 状态 ----------

export interface ResidentStateInput {
  mode: ResidentMode;
  paused: boolean;
  suspended: boolean;
  /** 运行时是否可用（模型就绪、没有启动错误）。 */
  runtimeAvailable: boolean;
  error: string | null;
  runningTasks: number;
  /** Resident 自己的会话正在回复。 */
  residentBusy: boolean;
  /** 等待用户处理的审批与问题（来自 Resident 或它的任务）。 */
  waitingItems: number;
}

/**
 * 整体状态不能只取决于某一个任务：有任务在运行时，即使另一个任务在等审批也显示 working，
 * 等待数量由 `waitingItems` 单独呈现。
 */
export function deriveResidentState(input: ResidentStateInput): ResidentState {
  if (input.paused) return "paused";
  if (input.suspended) return "suspended";
  if (input.mode === "disabled" || !input.runtimeAvailable) return "offline";
  if (input.error) return "error";
  if (input.runningTasks > 0 || input.residentBusy) return "working";
  if (input.waitingItems > 0) return "waiting_user";
  return "ready";
}

export interface ResidentStatus {
  state: ResidentState;
  mode: ResidentMode;
  paused: boolean;
  /** Resident 持久会话；还没有开始过对话时为 null。 */
  conversationId: string | null;
  model: string | null;
  residentBusy: boolean;
  runningTasks: number;
  queuedTasks: number;
  /** 等待用户处理的审批与问题。 */
  waitingItems: number;
  /** 全部待处理事项（与侧栏徽标一致）。 */
  pendingItems: number;
  lastActivityAt: number | null;
  suspended: boolean;
  onBattery: boolean;
  error: string | null;
  /** 今天已经触发的主动运行次数。 */
  proactiveRunsToday: number;
  tasks: ResidentTask[];
  /** 可以作为任务目标的已登记工作区。 */
  workspaces: string[];
  revision: number;
}

export type ResidentSubmitFailure = "disabled" | "paused" | "invalid" | "unknown_workspace" | "queue_full" | "failed";
export type ResidentSubmitResult =
  | { ok: true; target: "resident" }
  | { ok: true; target: "task"; taskId: string }
  | { ok: false; reason: ResidentSubmitFailure; message?: string };

export interface ResidentSubmitInput {
  text: string;
  /** 指定后直接在该工作区创建后台任务；省略时交给 Resident Agent。 */
  workspace?: string;
}

// ---------- 主动规则 ----------

export const proactiveTriggerKinds = ["inbox_error", "git_change", "file_change"] as const;
export type ProactiveTriggerKind = (typeof proactiveTriggerKinds)[number];

export interface ProactiveTrigger {
  kind: ProactiveTriggerKind;
  /** 子串过滤：事项标题/摘要（inbox_error）或相对路径（file_change）。空表示不过滤。 */
  filter: string;
}

export interface ProactiveRuleInput {
  title: string;
  workspace: string;
  trigger: ProactiveTrigger;
  /** 触发后让 Agent 做什么。 */
  prompt: string;
  cooldownMinutes: number;
  maxRunsPerDay: number;
  /** 关闭时分析在 Plan 模式（只读）下运行；开启后用 Agent 模式，每个命令与写入仍需要在 Inbox 审批。 */
  allowTools: boolean;
  enabled: boolean;
}

export interface ProactiveRule extends ProactiveRuleInput {
  id: string;
  createdAt: number;
  updatedAt: number;
  lastTriggeredAt: number | null;
  /** 本地日期（YYYY-MM-DD）与当天已触发次数。 */
  runDay: string;
  runsToday: number;
  /** 最近一次没有启动的原因，供界面解释「为什么没有触发」。 */
  lastSkip: { at: number; reason: ProactiveSkipReason } | null;
}

export type ProactiveSkipReason =
  | "disabled_mode" | "paused" | "battery" | "suspended" | "cooldown" | "daily_limit" | "rule_limit" | "already_running" | "busy" | "filtered";

export interface ProactiveRulesState {
  rules: ProactiveRule[];
  error: string | null;
}

export type ProactiveRuleResult = { ok: true; rule: ProactiveRule } | { ok: false; error: string };

export function localDay(at: number): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function clip(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function normalizeRuleInput(raw: unknown): { ok: true; input: ProactiveRuleInput } | { ok: false; error: string } {
  const input = record(raw);
  const trigger = record(input.trigger);
  const title = clip(input.title, residentLimits.maxTitle);
  const workspace = clip(input.workspace, 1000);
  const prompt = clip(input.prompt, residentLimits.maxRulePrompt);
  if (!title) return { ok: false, error: "规则需要标题" };
  if (!workspace || !workspace.startsWith("/")) return { ok: false, error: "规则需要选择一个工作区" };
  if (!prompt) return { ok: false, error: "规则需要说明触发后做什么" };
  if (!(proactiveTriggerKinds as readonly unknown[]).includes(trigger.kind)) return { ok: false, error: "触发器类型不正确" };
  return {
    ok: true,
    input: {
      title, workspace, prompt,
      trigger: { kind: trigger.kind as ProactiveTriggerKind, filter: clip(trigger.filter, residentLimits.maxRuleFilter) },
      cooldownMinutes: clampInt(input.cooldownMinutes, residentLimits.cooldownMinutes),
      maxRunsPerDay: clampInt(input.maxRunsPerDay, residentLimits.maxRunsPerDay),
      allowTools: bool(input.allowTools, false),
      enabled: bool(input.enabled, true),
    },
  };
}

export interface ProactiveAdmissionInput {
  rule: Pick<ProactiveRule, "enabled" | "lastTriggeredAt" | "cooldownMinutes" | "maxRunsPerDay" | "runDay" | "runsToday">;
  settings: Pick<ResidentSettings, "mode" | "paused" | "limits">;
  now: number;
  suspended: boolean;
  onBattery: boolean;
  /** 同一条规则已有一个主动任务在运行或排队。 */
  ruleRunning: boolean;
  /** 全局今天已触发的主动运行次数。 */
  globalRunsToday: number;
}

/**
 * 一次触发信号能否启动 Agent。顺序即优先级，返回的原因会展示给用户。
 * 冷却、每日上限、并发保护与电池策略都在这里，保证「文件保存产生几十个事件」只会启动一次模型调用。
 */
export function admitProactiveRun(input: ProactiveAdmissionInput): { ok: true } | { ok: false; reason: ProactiveSkipReason } {
  const { rule, settings, now } = input;
  if (settings.mode !== "proactive" || !rule.enabled) return { ok: false, reason: "disabled_mode" };
  if (settings.paused) return { ok: false, reason: "paused" };
  if (input.suspended) return { ok: false, reason: "suspended" };
  if (input.onBattery && settings.limits.pauseProactiveOnBattery) return { ok: false, reason: "battery" };
  if (input.ruleRunning) return { ok: false, reason: "already_running" };
  if (rule.lastTriggeredAt !== null && now - rule.lastTriggeredAt < rule.cooldownMinutes * 60_000) return { ok: false, reason: "cooldown" };
  const runsToday = rule.runDay === localDay(now) ? rule.runsToday : 0;
  if (runsToday >= rule.maxRunsPerDay) return { ok: false, reason: "rule_limit" };
  if (input.globalRunsToday >= settings.limits.dailyProactiveRuns) return { ok: false, reason: "daily_limit" };
  return { ok: true };
}

/** 文件事件里这些目录不触发规则：构建产物、依赖和版本库内部文件。 */
const ignoredSegments = new Set([".git", "node_modules", "dist", "build", "out", ".next", ".turbo", "coverage", ".cache", ".vela", ".DS_Store"]);

export function isIgnoredWorkspacePath(relative: string): boolean {
  return relative.split(/[\\/]/).some(segment => ignoredSegments.has(segment) || segment.endsWith(".tmp") || segment.endsWith("~"));
}

// ---------- IPC ----------

export interface ResidentAgentApi {
  getStatus(): Promise<ResidentStatus>;
  submit(input: ResidentSubmitInput): Promise<ResidentSubmitResult>;
  pause(): Promise<ResidentStatus>;
  resume(): Promise<ResidentStatus>;
  getSettings(): Promise<ResidentSettings>;
  updateSettings(patch: ResidentSettingsPatch): Promise<ResidentSettings>;
  cancelTask(id: string): Promise<ResidentStatus>;
  /** Resident 持久会话的消息；没有会话时为空。 */
  getMessages(): Promise<TranscriptMessage[]>;
  subscribe(listener: (status: ResidentStatus) => void): () => void;
  rules: {
    list(): Promise<ProactiveRulesState>;
    save(input: ProactiveRuleInput, id?: string): Promise<ProactiveRuleResult>;
    remove(id: string): Promise<ProactiveRulesState>;
    subscribe(listener: (state: ProactiveRulesState) => void): () => void;
  };
}

export const ResidentIpc = {
  status: "resident:status",
  statusChange: "resident:status-change",
  submit: "resident:submit",
  pause: "resident:pause",
  resume: "resident:resume",
  getSettings: "resident:get-settings",
  updateSettings: "resident:update-settings",
  cancelTask: "resident:cancel-task",
  messages: "resident:messages",
  rulesList: "resident:rules-list",
  rulesSave: "resident:rules-save",
  rulesRemove: "resident:rules-remove",
  rulesChange: "resident:rules-change",
} as const;

/** 后台任务和主动规则默认不使用 full：主动触发的任务不应绕过审批。 */
export function backgroundSandboxMode(global: SandboxMode): SandboxMode {
  return global === "full" ? "smart" : global;
}
