import { useSyncExternalStore } from "react";
import { readStoredState } from "./useStoredState";
import { uiStorage } from "../ui-storage";
import { createLogger } from "../logger";

const log = createLogger("preferences");

export const sidebarItemIds = ["prInbox", "scheduledTasks", "newChat", "recipes"] as const;
export type SidebarItemId = (typeof sidebarItemIds)[number];
export type SidebarItems = Record<SidebarItemId, boolean>;

const key = "vela.sidebarItems";
const defaults: SidebarItems = { prInbox: true, scheduledTasks: true, newChat: true, recipes: true };
const accept = (value: unknown): value is Partial<SidebarItems> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

let current: SidebarItems = { ...defaults, ...readStoredState<Partial<SidebarItems>>(key, {}, accept) };
const listeners = new Set<() => void>();

export function setSidebarItem(id: SidebarItemId, visible: boolean) {
  current = { ...current, [id]: visible };
  try { uiStorage.setItem(key, JSON.stringify(current)); }
  catch (error) { log.error(`failed to save UI preference ${key}`, error); }
  listeners.forEach(listener => listener());
}

export function useSidebarItems() {
  return useSyncExternalStore(
    listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => current,
  );
}
