import { useCallback, useSyncExternalStore } from "react";
import { emptyMessages, messageScope, type MessageStore } from "./message-store";

const noSubscription = () => () => {};
const emptySnapshot = () => emptyMessages;

export function useMessages(store: MessageStore | undefined, conversationId: string | null, agentId?: string) {
  const scope = conversationId ? messageScope(conversationId, agentId) : null;
  const subscribe = useCallback((listener: () => void) =>
    store && scope ? store.subscribe(scope, listener) : noSubscription(), [store, scope]);
  const getSnapshot = useCallback(() =>
    store && scope ? store.getSnapshot(scope) : emptyMessages, [store, scope]);
  return useSyncExternalStore(subscribe, getSnapshot, emptySnapshot);
}
