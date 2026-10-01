import type { AppLocale } from "@vela/shared";
import type { ThinkingSummaryStyle } from "./hooks/usePreferences";
import type { UiMessage } from "./hooks/useSession";

/** 只追踪新完成的思考；恢复历史或开启开关不会触发批量请求。 */
export class ThinkingCompletionTracker {
  private readonly conversations = new Map<string, {
    enabled: boolean;
    messages: Map<string, { active: boolean; hasThinking: boolean }>;
  }>();

  observe(conversationId: string, messages: UiMessage[], streaming: boolean, enabled: boolean): UiMessage[] {
    const previous = this.conversations.get(conversationId);
    const activeId = streaming ? messages.findLast((message) => message.role === "assistant")?.id : undefined;
    const current = new Map<string, { active: boolean; hasThinking: boolean }>();
    const completed: UiMessage[] = [];
    for (const message of messages) {
      if (message.role !== "assistant") continue;
      const active = message.id === activeId && !message.text && message.tools.length === 0;
      current.set(message.id, { active, hasThinking: Boolean(message.thinking.trim()) });
      const before = previous?.messages.get(message.id);
      if (enabled && previous?.enabled && message.thinking.trim() && !active && (
        before?.active || (!before?.hasThinking && message.turnStartedAt !== undefined)
      )) completed.push(message);
    }
    this.conversations.set(conversationId, { enabled, messages: current });
    return completed;
  }
}

export type ThinkingSummaryState =
  | { status: "pending" }
  | { status: "done"; text: string }
  | { status: "error"; error: string };

/** 已完成的总结以哪种形态出现:默认（跟在“思考”后）、标题、或回复正文。 */
export type ThinkingSummaryLayout = "default" | "headline" | "prose";

/** 只有已完成的总结能替换标题或变成正文;其他状态都退回默认的“思考”触发条。 */
export function thinkingSummaryLayout(
  style: ThinkingSummaryStyle,
  summary: ThinkingSummaryState | undefined,
  open: boolean,
): ThinkingSummaryLayout {
  if (summary?.status !== "done") return "default";
  if (style === "prose") return "prose";
  if (style === "headline" && !open) return "headline";
  return "default";
}

/** 持久化总结的条数上限;超出后先丢最早的记录。 */
export const storedSummaryLimit = 500;

/**
 * 消息 id 在窗口重开后由会话投影重新生成,不能在重开后定位总结;
 * 思考内容哈希在重开后仍然一致,所以对话、语言和内容哈希共同定位一条总结。
 */
export function thinkingSummaryKey(conversationId: string, locale: AppLocale, digest: string): string {
  return `${conversationId}\u0000${locale}\u0000${digest}`;
}

/** cyrb53:非加密哈希,只用来判断总结是否仍对应同一段思考内容。 */
export function thinkingDigest(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** 从 localStorage 读取已完成的总结;只信任字符串文本,损坏的内容直接忽略。 */
export function parseStoredSummaries(raw: string | null): Record<string, ThinkingSummaryState> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const entries: [string, ThinkingSummaryState][] = [];
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string" && value.trim()) entries.push([key, { status: "done", text: value }]);
    }
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

/** 只落盘已完成的总结,并按上限裁剪最早的记录。 */
export function serializeStoredSummaries(records: Readonly<Record<string, ThinkingSummaryState>>): string {
  const done: [string, string][] = [];
  for (const [key, record] of Object.entries(records)) {
    if (record.status === "done") done.push([key, record.text]);
  }
  // 对象保留插入顺序,新总结排在后面;超限时从最旧的一端开始丢。
  return JSON.stringify(Object.fromEntries(done.slice(Math.max(0, done.length - storedSummaryLimit))));
}
