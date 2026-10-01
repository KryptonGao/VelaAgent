export interface MotionEntry<T> {
  key: string;
  item: T;
  present: boolean;
  entering: boolean;
}

/** Retain removed items at their former index while live items follow the new order. */
export function reconcileMotionItems<T>(previous: MotionEntry<T>[], items: readonly T[], keyOf: (item: T) => string): MotionEntry<T>[] {
  const old = new Map(previous.map((entry) => [entry.key, entry]));
  const next = items.map((item) => {
    const key = keyOf(item);
    return { key, item, present: true, entering: old.get(key)?.entering ?? true };
  });
  const live = new Set(next.map((entry) => entry.key));
  previous.forEach((entry, index) => {
    if (!live.has(entry.key)) next.splice(Math.min(index, next.length), 0, { ...entry, present: false });
  });
  return next;
}
