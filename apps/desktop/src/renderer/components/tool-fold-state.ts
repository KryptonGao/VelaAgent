export type ToolFoldState = { sequences: Record<string, boolean>; rows: Record<string, boolean> };
export interface FoldStorage {
  getItem(key: string): string | null | undefined;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const toolFoldStorageKey = (sessionId: string): string => `vela.toolFold.v1:${sessionId}`;
export const foldRowId = (id: string | undefined): string | null => id ? `rows:${id}` : null;
export const foldSequenceId = (id: string | undefined): string | null => id ? `sequences:${id}` : null;

/** IDs are namespaced so a sequence and its first call can use the same stable ID. */
export function createFoldStore({ sessionId, storage }: { sessionId: string | null; storage: FoldStorage }) {
  // Keep evicted values in memory so capacity pruning cannot collapse a visible row.
  const values = new Map<string, boolean>();
  const lastTouchedAt = new Map<string, number>();
  const listeners = new Set<() => void>();
  const key = sessionId ? toolFoldStorageKey(sessionId) : null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dirty = false;
  let warned = false;
  let clock = 0;
  const warn = () => {
    if (!warned) {
      warned = true;
      console.warn("Could not persist tool fold state; using memory for this session.");
    }
  };
  const validId = (id: string): boolean => /^(rows|sequences):.+/.test(id);
  const prune = () => {
    while (lastTouchedAt.size > 500) {
      const oldest = [...lastTouchedAt].reduce((a, b) => a[1] <= b[1] ? a : b);
      lastTouchedAt.delete(oldest[0]);
    }
  };

  if (key) {
    try {
      const saved = storage.getItem(key);
      if (saved != null) {
        const parsed = JSON.parse(saved);
        const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
        if (!record(parsed) || !record(parsed.rows) || !record(parsed.sequences)) throw new Error("Invalid fold state");
        const groups = { rows: parsed.rows, sequences: parsed.sequences };
        for (const group of ["rows", "sequences"] as const) {
          for (const [id, value] of Object.entries(groups[group])) {
            if (!id || typeof value !== "boolean") throw new Error("Invalid fold entry");
          }
        }
        for (const group of ["rows", "sequences"] as const) {
          for (const [id, value] of Object.entries(groups[group])) {
            const entry = `${group}:${id}`;
            values.set(entry, value as boolean);
            const touched = record(parsed.lastTouchedAt) ? parsed.lastTouchedAt[entry] : undefined;
            const time = typeof touched === "number" && Number.isFinite(touched) ? touched : ++clock;
            clock = Math.max(clock, time);
            lastTouchedAt.set(entry, time);
          }
        }
        if (lastTouchedAt.size > 500) { prune(); dirty = true; }
      }
    } catch { values.clear(); lastTouchedAt.clear(); /* Malformed or unavailable storage uses defaults. */ }
  }

  function flush(): void {
    clearTimeout(timer);
    timer = undefined;
    if (!dirty || !key) return;
    const state: ToolFoldState = { sequences: {}, rows: {} };
    for (const id of lastTouchedAt.keys()) {
      const split = id.indexOf(":");
      const group = id.slice(0, split) as keyof ToolFoldState;
      Object.defineProperty(state[group], id.slice(split + 1), { value: values.get(id), enumerable: true });
    }
    try {
      storage.setItem(key, JSON.stringify({ ...state, lastTouchedAt: Object.fromEntries(lastTouchedAt) }));
      dirty = false;
    } catch { warn(); }
  }
  const schedule = () => {
    dirty = true;
    clearTimeout(timer);
    if (key) timer = setTimeout(flush, 200);
  };
  const touch = (id: string) => {
    clock = Math.max(Date.now(), clock + 1);
    lastTouchedAt.set(id, clock);
    prune();
    schedule();
  };
  const peekExpanded = (id: string | null, fallback = false): boolean => id ? values.get(id) ?? fallback : fallback;

  return {
    peekExpanded,
    isExpanded(id: string | null, fallback = false): boolean {
      if (id && values.has(id)) touch(id);
      return peekExpanded(id, fallback);
    },
    setExpanded(id: string | null, value: boolean): void {
      if (!id || !validId(id)) return;
      values.set(id, value);
      touch(id);
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    flush,
    resetSession(): void {
      clearTimeout(timer);
      timer = undefined;
      dirty = false;
      values.clear();
      lastTouchedAt.clear();
      if (key) {
        try { storage.removeItem(key); } catch { warn(); }
      }
      for (const listener of listeners) listener();
    },
  };
}

export type ToolFoldStore = ReturnType<typeof createFoldStore>;
