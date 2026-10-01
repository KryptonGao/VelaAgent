import { useEffect, useState } from "react";
import { uiStorage } from "../ui-storage";

export function readStoredState<T>(key: string, fallback: T, accept: (value: unknown) => value is T, storage = uiStorage): T {
  try {
    const raw = storage.getItem(key);
    if (raw !== null) {
      const value: unknown = JSON.parse(raw);
      if (accept(value)) return value;
    }
  } catch { /* Keep the view usable if storage cannot be read. */ }
  return fallback;
}

export function useStoredState<T>(key: string, fallback: T, accept: (value: unknown) => value is T) {
  const [value, setValue] = useState<T>(() => readStoredState(key, fallback, accept));
  useEffect(() => {
    try { uiStorage.setItem(key, JSON.stringify(value)); }
    catch (error) { console.error("[vela] Failed to save UI preference", key, error); }
  }, [key, value]);
  return [value, setValue] as const;
}

export const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";
export const isBooleanRecord = (value: unknown): value is Record<string, boolean> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
  Object.values(value as object).every(isBoolean);
