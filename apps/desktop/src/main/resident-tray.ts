import { localizeTemplate, localizeZh, type AppLocale, type ResidentState, type ResidentStatus } from "@vela/shared";

export type TrayAction = "open-inbox" | "open-resident" | "toggle-pause" | "quit";

export interface TrayMenuItem {
  kind: "label" | "action" | "separator";
  id?: TrayAction;
  label?: string;
  enabled?: boolean;
}

export interface TrayDescription {
  tooltip: string;
  /** macOS 菜单栏图标旁的文字：待处理数量，没有时为空。 */
  title: string;
  items: TrayMenuItem[];
}

const stateLabels: Record<ResidentState, [string, string]> = {
  ready: ["待命", "Ready"],
  working: ["工作中", "Working"],
  waiting_user: ["等你处理", "Waiting for you"],
  paused: ["已暂停", "Paused"],
  suspended: ["系统休眠中", "System asleep"],
  offline: ["未运行", "Offline"],
  error: ["出错", "Error"],
};

export function residentStateLabel(locale: AppLocale, state: ResidentState): string {
  const [zh, en] = stateLabels[state];
  return localizeZh(locale, zh, en);
}

/** 菜单栏入口的内容：纯数据，Electron 只负责把它画出来。 */
export function describeTray(status: ResidentStatus, locale: AppLocale): TrayDescription {
  const text = (zh: string, en: string) => localizeZh(locale, zh, en);
  const state = residentStateLabel(locale, status.state);
  const pending = status.pendingItems;
  const lines: TrayMenuItem[] = [
    { kind: "label", label: localizeTemplate(locale, "Resident Agent：{0}", "Resident Agent: {0}", state) },
  ];
  if (status.runningTasks > 0 || status.queuedTasks > 0) {
    lines.push({ kind: "label", label: localizeTemplate(locale, "运行中 {0} · 排队 {1}", "{0} running · {1} queued", status.runningTasks, status.queuedTasks) });
  }
  lines.push({
    kind: "label",
    label: pending > 0 ? localizeTemplate(locale, "{0} 项需要处理", "{0} need your attention", pending) : text("没有待处理事项", "All caught up"),
  });
  return {
    tooltip: `Vela · ${state}${pending > 0 ? ` · ${pending}` : ""}`,
    title: pending > 0 ? String(pending > 99 ? "99+" : pending) : "",
    items: [
      ...lines,
      { kind: "separator" },
      { kind: "action", id: "open-inbox", label: text("打开 Agent 收件箱", "Open Agent Inbox") },
      { kind: "action", id: "open-resident", label: text("打开 Resident Agent", "Open Resident Agent") },
      { kind: "action", id: "toggle-pause", label: status.paused ? text("恢复后台自动任务", "Resume background tasks") : text("暂停全部后台自动任务", "Pause all background tasks"), enabled: status.mode !== "disabled" },
      { kind: "separator" },
      { kind: "action", id: "quit", label: text("退出 Vela", "Quit Vela") },
    ],
  };
}

/** Electron Tray 与 Menu 的最小接口，测试里用假对象替换。 */
export interface TrayHandle {
  setToolTip(text: string): void;
  setTitle(text: string): void;
  setMenu(items: Array<{ type?: "separator"; label?: string; enabled?: boolean; click?: () => void }>): void;
  onClick(listener: () => void): void;
  destroy(): void;
}

/** 菜单栏图标的生命周期：按设置创建或销毁，状态变化时刷新内容。 */
export class ResidentTray {
  private handle: TrayHandle | null = null;
  private last: ResidentStatus | null = null;

  constructor(private readonly options: {
    create: () => TrayHandle;
    locale: () => AppLocale;
    onAction: (action: TrayAction) => void;
  }) {}

  /** `visible` 来自设置；不可见时销毁图标。 */
  update(status: ResidentStatus, visible: boolean): void {
    this.last = status;
    if (!visible) { this.dispose(); return; }
    if (!this.handle) {
      this.handle = this.options.create();
      this.handle.onClick(() => this.options.onAction("open-inbox"));
    }
    const description = describeTray(status, this.options.locale());
    this.handle.setToolTip(description.tooltip);
    this.handle.setTitle(description.title);
    this.handle.setMenu(description.items.map(item => item.kind === "separator" ? { type: "separator" as const } : {
      label: item.label,
      enabled: item.kind === "action" ? item.enabled !== false : false,
      ...(item.kind === "action" && item.id ? { click: () => this.options.onAction(item.id!) } : {}),
    }));
  }

  /** 语言切换后用最近的状态重绘。 */
  refresh(visible: boolean): void { if (this.last) this.update(this.last, visible); }

  isVisible(): boolean { return this.handle !== null; }

  dispose(): void {
    this.handle?.destroy();
    this.handle = null;
  }
}
