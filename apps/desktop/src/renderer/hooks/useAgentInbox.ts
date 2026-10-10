import { useEffect, useSyncExternalStore } from "react";
import { getAgentInboxStore, type AgentInboxSnapshot, type AgentInboxStore } from "../components/agent-inbox-store";

const emptySnapshot: AgentInboxSnapshot = { items: [], badge: 0, error: null, loaded: false, loadError: null };
const noopSubscribe = () => () => {};
const getEmpty = () => emptySnapshot;

/**
 * 订阅 Agent Inbox。应用根组件始终调用它以维持侧栏徽标；页面再次调用时共享同一个缓存。
 * 浏览器预览等没有 window.vela.agentInbox 的环境得到空快照。
 */
export function useAgentInbox(): { store: AgentInboxStore | null; snapshot: AgentInboxSnapshot } {
  const api = window.vela?.agentInbox;
  const store = api ? getAgentInboxStore(api) : null;
  const snapshot = useSyncExternalStore(store?.subscribe ?? noopSubscribe, store?.getSnapshot ?? getEmpty);
  useEffect(() => store?.attach(), [store]);
  return { store, snapshot };
}
