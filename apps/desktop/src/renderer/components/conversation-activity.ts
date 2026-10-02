import type { ConversationSummary } from "@vela/shared";
import { isListedConversation } from "./conversation-search";

export type SidebarView = "activity" | "workspaces";
export const isSidebarView = (value: unknown): value is SidebarView =>
  value === "activity" || value === "workspaces";

export type ActivityReason = "waiting" | "error" | "priority" | "streaming" | "starting" | "recent";
export type ActivityGroupId = "priority" | "today" | "yesterday" | "earlier";

export interface ActivityOptions {
  priorityConversations?: Readonly<Record<string, boolean>>;
  waitingConversationIds?: readonly string[];
}

export interface ActivityGroup {
  id: ActivityGroupId;
  conversations: ConversationSummary[];
}

export function activityReason(conversation: ConversationSummary, options: ActivityOptions): ActivityReason {
  if (options.waitingConversationIds?.includes(conversation.id)) return "waiting";
  if (conversation.status === "error") return "error";
  if (options.priorityConversations?.[conversation.id]) return "priority";
  if (conversation.status === "streaming" || conversation.status === "starting") return conversation.status;
  return "recent";
}

const priority: Record<ActivityReason, number> = {
  waiting: 0, error: 1, priority: 2, streaming: 3, starting: 3, recent: 4,
};

export function activityDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** 跨工作区按需要关注的程度排序；同级按最近更新排序，归档不参与。 */
export function groupActivityConversations(
  conversations: readonly ConversationSummary[],
  options: ActivityOptions = {},
  now = Date.now(),
): ActivityGroup[] {
  const today = activityDay(now);
  const yesterdayDate = new Date(today);
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const yesterday = yesterdayDate.getTime();
  const groups: Record<ActivityGroupId, ConversationSummary[]> = {
    priority: [], today: [], yesterday: [], earlier: [],
  };
  const ranked = conversations.filter(isListedConversation).map(conversation => ({
    conversation, rank: priority[activityReason(conversation, options)],
  })).sort((a, b) => a.rank - b.rank || b.conversation.updatedAt - a.conversation.updatedAt || a.conversation.id.localeCompare(b.conversation.id));
  for (const { conversation, rank } of ranked) {
    const group = rank < priority.recent ? "priority"
      : conversation.updatedAt >= today ? "today"
      : conversation.updatedAt >= yesterday ? "yesterday" : "earlier";
    groups[group].push(conversation);
  }
  return (Object.keys(groups) as ActivityGroupId[])
    .filter(id => groups[id].length > 0)
    .map(id => ({ id, conversations: groups[id] }));
}
