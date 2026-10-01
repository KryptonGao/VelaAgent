import type { UiMessage } from "./useSession";

export const emptyMessages: UiMessage[] = [];
export const messageScope = (conversationId: string, agentId?: string): string =>
  JSON.stringify([conversationId, agentId ?? null]);

type ScheduleFrame = (callback: () => void) => () => void;
const scheduleFrame: ScheduleFrame = (callback) => {
  const id = requestAnimationFrame(callback);
  return () => cancelAnimationFrame(id);
};

/** Publish only changed streams, once per frame. Reducers keep their own latest
 * data so history loads and terminal events cannot race a pending publication. */
export function createMessageStore(schedule: ScheduleFrame = scheduleFrame) {
  const snapshots = new Map<string, UiMessage[]>();
  const pending = new Map<string, UiMessage[]>();
  const listeners = new Map<string, Set<() => void>>();
  let cancelFrame: (() => void) | null = null;
  const flush = () => {
    cancelFrame?.();
    cancelFrame = null;
    const changed: string[] = [];
    for (const [scope, messages] of pending) {
      if (snapshots.get(scope) === messages) continue;
      snapshots.set(scope, messages);
      changed.push(scope);
    }
    pending.clear();
    // Commit every snapshot before notifying any subscriber.
    for (const scope of changed) for (const listener of listeners.get(scope) ?? []) listener();
  };
  return {
    getSnapshot: (scope: string) => snapshots.get(scope) ?? emptyMessages,
    subscribe(scope: string, listener: () => void) {
      let scoped = listeners.get(scope);
      if (!scoped) listeners.set(scope, scoped = new Set());
      scoped.add(listener);
      return () => {
        scoped.delete(listener);
        if (!scoped.size) listeners.delete(scope);
      };
    },
    publish(scope: string, messages: UiMessage[]) {
      pending.set(scope, messages);
      if (!cancelFrame) cancelFrame = schedule(flush);
    },
    flush,
  };
}

export type MessageStore = ReturnType<typeof createMessageStore>;
