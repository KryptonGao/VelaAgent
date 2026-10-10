import {
  createLogger,
  isQuietNow,
  localizeTemplate,
  localizeZh,
  truncateInboxText,
  type AgentInboxChange,
  type AgentInboxItem,
  type AppLocale,
  type ResidentSettings,
} from "@vela/shared";

const log = createLogger("agent-inbox-notifier");

export interface InboxNotification {
  title: string;
  body: string;
  /** 点击后定位到的事项；汇总通知没有。 */
  itemId?: string;
}

export interface AgentInboxNotifierOptions {
  settings: () => ResidentSettings;
  locale: () => AppLocale;
  /** 应用窗口正在前台：徽标和页面已经可见，不再弹系统通知。 */
  appFocused: () => boolean;
  show: (notification: InboxNotification) => void;
  now?: () => number;
  /** 测试里替换成可控的定时器。 */
  schedule?: (work: () => void, ms: number) => { cancel(): void };
}

/** 一个时间窗口内最多弹出的通知条数；超出的合并成一条汇总，避免多个 Agent 同时请求时刷屏。 */
export const notificationBurst = { windowMs: 60_000, max: 3 } as const;

const notifyTypes = new Set(["approval", "question", "error", "review", "suggestion"]);

/**
 * 把收件箱里新出现的事项变成系统通知。
 * 每个事项最多提醒一次；静默时段、前台窗口和关闭通知都只影响提醒，不影响事项本身和徽标。
 */
export class AgentInboxNotifier {
  private readonly seen = new Set<string>();
  private readonly shownAt: number[] = [];
  private overflow = 0;
  private flushTimer: { cancel(): void } | null = null;
  private readonly now: () => number;
  private readonly schedule: NonNullable<AgentInboxNotifierOptions["schedule"]>;

  constructor(private readonly options: AgentInboxNotifierOptions) {
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? ((work, ms) => {
      const timer = setTimeout(work, ms);
      timer.unref?.();
      return { cancel: () => clearTimeout(timer) };
    });
  }

  /** 启动时已有的事项视为已知：重启不会把昨天的待办再提醒一遍。 */
  seed(items: readonly Pick<AgentInboxItem, "id">[]): void {
    for (const item of items) this.seen.add(item.id);
  }

  dispose(): void {
    this.flushTimer?.cancel();
    this.flushTimer = null;
  }

  onChange(change: Pick<AgentInboxChange, "upserts">): void {
    for (const item of change.upserts) {
      if (this.seen.has(item.id)) continue;
      this.seen.add(item.id);
      try { this.consider(item); } catch (error) { log.error("notification failed", error); }
    }
  }

  private consider(item: AgentInboxItem): void {
    const settings = this.options.settings();
    if (!settings.notifications.enabled || item.readState !== "unread") return;
    const wanted = item.status === "pending" ? notifyTypes.has(item.type)
      : item.type === "suggestion" || (item.type === "result" && settings.notifications.notifyResults);
    if (!wanted) return;
    if (isQuietNow(settings.notifications.quietHours, new Date(this.now()))) return;
    if (this.options.appFocused()) return;
    const now = this.now();
    while (this.shownAt.length && now - this.shownAt[0]! >= notificationBurst.windowMs) this.shownAt.shift();
    if (this.shownAt.length >= notificationBurst.max) {
      this.overflow += 1;
      this.scheduleSummary();
      return;
    }
    this.shownAt.push(now);
    this.options.show(this.compose(item, settings));
  }

  private scheduleSummary(): void {
    if (this.flushTimer) return;
    const wait = Math.max(1000, notificationBurst.windowMs - (this.now() - (this.shownAt[0] ?? this.now())));
    this.flushTimer = this.schedule(() => {
      this.flushTimer = null;
      const count = this.overflow;
      this.overflow = 0;
      if (!count) return;
      const locale = this.options.locale();
      this.options.show({
        title: "Vela",
        body: localizeTemplate(locale, "还有 {0} 项新事项，打开 Agent 收件箱查看", "{0} more items in Agent Inbox", count),
      });
    }, wait);
  }

  private compose(item: AgentInboxItem, settings: ResidentSettings): InboxNotification {
    const locale = this.options.locale();
    const text = (zh: string, en: string) => localizeZh(locale, zh, en);
    const urgent = item.status === "pending" && (item.type === "approval" || item.type === "question");
    if (settings.notifications.hidePreview) {
      return { title: "Vela", body: urgent ? text("有事项需要你处理", "Something needs your attention") : text("Agent 收件箱有新事项", "New item in Agent Inbox"), itemId: item.id };
    }
    const subject = truncateInboxText(
      item.detail.kind === "approval" ? item.detail.request.command ?? item.detail.request.path ?? item.summary
        : item.detail.kind === "question" ? item.detail.question : item.summary || item.title,
      140,
    );
    const title = ({
      approval: text("需要你批准", "Approval needed"),
      question: text("Agent 在等你的回答", "Agent is waiting for your answer"),
      error: text("任务失败", "Task failed"),
      review: text("计划待检查", "Plan ready for review"),
      suggestion: text("Agent 的建议", "Agent suggestion"),
      result: text("任务完成", "Task finished"),
    } as Record<string, string>)[item.type] ?? "Vela";
    const from = item.title && item.title !== subject ? `${item.title}\n` : "";
    return { title, body: `${from}${subject}`.trim() || title, itemId: item.id };
  }
}
