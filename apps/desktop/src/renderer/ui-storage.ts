type StorageBridge = {
  /** undefined means never saved; null is an explicit removal. */
  getItem(key: string): string | null | undefined;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

/** Import an old origin's values only when the durable store has no value yet. */
export function createUiStorage(bridge: StorageBridge | undefined, legacy: () => Storage) {
  return {
    getItem(key: string): string | null {
      if (!bridge) return legacy().getItem(key);
      const saved = bridge.getItem(key);
      if (saved !== undefined) return saved;
      let previous: string | null = null;
      try { previous = legacy().getItem(key); } catch { /* The disk store works without localStorage. */ }
      if (previous !== null) bridge.setItem(key, previous);
      return previous;
    },
    setItem(key: string, value: string): void {
      if (bridge) bridge.setItem(key, value);
      else legacy().setItem(key, value);
    },
    removeItem(key: string): void {
      if (bridge) bridge.removeItem(key);
      else legacy().removeItem(key);
    },
  };
}

export const uiStorage = createUiStorage(
  typeof window === "undefined" ? undefined : window.vela?.uiStorage,
  () => localStorage,
);
