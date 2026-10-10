import {
  parseUiStateSnapshot,
  serializeUiStateSnapshot,
  uiSourceFingerprint,
  uiStateKeyPrefix,
  uiStateStorageKey,
  type UiStateScope,
  type UiValue,
} from "@vela/shared";

export { uiSourceFingerprint, type UiStateScope };

/**
 * Intelligent UI 本地状态的持久化。
 *
 * 键以 conversationId + messageId + artifactId 定位。messageId 不是聊天里的随机消息 id
 * （实时消息和历史恢复的 id 不同），而是「会话里第几条含 UI 的回复」，所以重启、切换、分支后保持稳定。
 * 快照里带内容指纹：同一位置的 UI 被改写（编辑重发）后，旧快照会被丢弃而不是套到新界面上。
 */

export interface UiStateStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const maxSnapshotBytes = 16 * 1024;
const maxIndexEntries = 400;

const stateKey = uiStateStorageKey;
const indexKey = (conversationId: string) => `${uiStateKeyPrefix}.index.${conversationId}`;
const entryName = (scope: Pick<UiStateScope, "messageId" | "artifactId">) => `${scope.messageId}/${scope.artifactId}`;

export function stableUiMessageId(ordinal: number): string {
  return `u${ordinal}`;
}

export function uiMessageOrdinal(messageId: string): number {
  return /^u\d+$/.test(messageId) ? Number(messageId.slice(1)) : -1;
}

export type UiSavedValues = Record<string, UiValue>;

export function createUiStateStore(storage: UiStateStorage) {
  const safe = <T>(action: () => T, fallback: T): T => {
    try { return action(); } catch { return fallback; }
  };

  const readIndex = (conversationId: string): string[] => safe(() => {
    const parsed: unknown = JSON.parse(storage.getItem(indexKey(conversationId)) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string" && /^u\d+\/[\w-]+$/.test(item)) : [];
  }, []);

  const writeIndex = (conversationId: string, entries: string[]) => safe(() => {
    if (entries.length === 0) storage.removeItem(indexKey(conversationId));
    else storage.setItem(indexKey(conversationId), JSON.stringify(entries));
  }, undefined);

  const parseName = (entry: string): Pick<UiStateScope, "messageId" | "artifactId"> => {
    const [messageId, artifactId] = entry.split("/");
    return { messageId, artifactId };
  };

  return {
    /** 读取保存的覆盖值；指纹不符或格式损坏时返回 null。 */
    load(scope: UiStateScope, fingerprint: string): UiSavedValues | null {
      return safe(() => parseUiStateSnapshot(storage.getItem(stateKey(scope)), fingerprint), null);
    },

    save(scope: UiStateScope, fingerprint: string, values: UiSavedValues): void {
      safe(() => {
        const serialized = serializeUiStateSnapshot(fingerprint, values);
        if (serialized.length > maxSnapshotBytes) return;
        storage.setItem(stateKey(scope), serialized);
        const entries = readIndex(scope.conversationId);
        const name = entryName(scope);
        if (!entries.includes(name)) {
          entries.push(name);
          // 超过上限时丢弃最早的位置，防止长对话无限增长。
          while (entries.length > maxIndexEntries) {
            const dropped = entries.shift()!;
            storage.removeItem(stateKey({ conversationId: scope.conversationId, ...parseName(dropped) }));
          }
          writeIndex(scope.conversationId, entries);
        }
      }, undefined);
    },

    remove(scope: UiStateScope): void {
      safe(() => {
        storage.removeItem(stateKey(scope));
        const name = entryName(scope);
        writeIndex(scope.conversationId, readIndex(scope.conversationId).filter(entry => entry !== name));
      }, undefined);
    },

    /** 删除会话：移除它名下的全部快照。 */
    removeConversation(conversationId: string): void {
      safe(() => {
        for (const entry of readIndex(conversationId)) storage.removeItem(stateKey({ conversationId, ...parseName(entry) }));
        storage.removeItem(indexKey(conversationId));
      }, undefined);
    },

    /** 回退、编辑重发后：只保留仍然存在的 UI 回复位置（messageCount 条）。 */
    pruneConversation(conversationId: string, messageCount: number): void {
      safe(() => {
        const entries = readIndex(conversationId);
        const kept = entries.filter(entry => uiMessageOrdinal(parseName(entry).messageId) < messageCount);
        for (const entry of entries) {
          if (!kept.includes(entry)) storage.removeItem(stateKey({ conversationId, ...parseName(entry) }));
        }
        if (kept.length !== entries.length) writeIndex(conversationId, kept);
      }, undefined);
    },

    /** 分支：复制快照，各自独立保存，不共享可变引用。 */
    copyConversation(fromId: string, toId: string): void {
      if (fromId === toId) return;
      safe(() => {
        const copied: string[] = [];
        for (const entry of readIndex(fromId)) {
          const name = parseName(entry);
          const raw = storage.getItem(stateKey({ conversationId: fromId, ...name }));
          if (raw === null) continue;
          storage.setItem(stateKey({ conversationId: toId, ...name }), raw);
          copied.push(entry);
        }
        if (copied.length > 0) writeIndex(toId, copied);
      }, undefined);
    },
  };
}

export type UiStateStore = ReturnType<typeof createUiStateStore>;
