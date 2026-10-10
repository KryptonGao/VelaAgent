import { compareAgentInboxItems, type AgentInboxItem, type AgentInboxItemType } from "@vela/shared";

export type AgentInboxView = "overview" | "needs_action" | "activity" | "archive";
export const agentInboxViews: readonly AgentInboxView[] = ["overview", "needs_action", "activity", "archive"];

export interface AgentInboxFilter {
  view: AgentInboxView;
  type: AgentInboxItemType | "all";
  search: string;
}

/**
 * 待处理事项即使被归档也留在「需要处理」里：归档只改变展示，不会解除阻塞，
 * 所以徽标数量始终等于该视图的数量。
 */
export function inAgentInboxView(item: AgentInboxItem, view: AgentInboxView): boolean {
  const archived = item.readState === "archived";
  switch (view) {
    case "needs_action": return item.status === "pending";
    case "activity": return !archived && item.status !== "pending";
    case "archive": return archived;
    default: return !archived || item.status === "pending";
  }
}

export function agentInboxViewCount(items: readonly AgentInboxItem[], view: AgentInboxView): number {
  let count = 0;
  for (const item of items) if (inAgentInboxView(item, view)) count += 1;
  return count;
}

export function agentInboxUnreadCount(items: readonly AgentInboxItem[]): number {
  let count = 0;
  for (const item of items) if (item.readState === "unread") count += 1;
  return count;
}

function haystack(item: AgentInboxItem): string {
  const detail = item.detail.kind === "approval"
    ? [item.detail.request.command, item.detail.request.path, item.detail.request.cwd]
    : item.detail.kind === "question" ? [item.detail.question] : [item.detail.text.slice(0, 400)];
  return [item.title, item.summary, item.type, item.origin, item.workspaceId, item.outcome, ...detail].filter(Boolean).join("\n").toLowerCase();
}

export function filterAgentInboxItems(items: readonly AgentInboxItem[], filter: AgentInboxFilter): AgentInboxItem[] {
  const terms = filter.search.toLowerCase().split(/\s+/).filter(Boolean);
  return items
    .filter(item => inAgentInboxView(item, filter.view))
    .filter(item => filter.type === "all" || item.type === filter.type)
    .filter(item => {
      if (!terms.length) return true;
      const text = haystack(item);
      return terms.every(term => text.includes(term));
    })
    .sort(compareAgentInboxItems);
}

export interface AgentInboxOverview {
  attention: AgentInboxItem[];
  recent: AgentInboxItem[];
}

/** 首页：需要处理的事项在上，最近的后台活动在下。 */
export function agentInboxOverview(items: readonly AgentInboxItem[], recentLimit = 8): AgentInboxOverview {
  const attention = items.filter(item => item.status === "pending").sort(compareAgentInboxItems);
  const recent = items
    .filter(item => item.status !== "pending" && item.readState !== "archived")
    .sort(compareAgentInboxItems)
    .slice(0, recentLimit);
  return { attention, recent };
}

export function agentInboxTypes(items: readonly AgentInboxItem[]): AgentInboxItemType[] {
  return [...new Set(items.map(item => item.type))].sort();
}

/** 选中项在当前列表中不存在时回落到第一项，没有列表时为空。 */
export function resolveSelection(list: readonly AgentInboxItem[], selectedId: string | null): AgentInboxItem | null {
  return list.find(item => item.id === selectedId) ?? null;
}
