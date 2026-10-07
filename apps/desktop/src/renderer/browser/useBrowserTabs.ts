import { useCallback, useEffect, useRef, useState } from "react";
import type { BrowserAgentCursor, BrowserPanelApi, BrowserUiCommand, BrowserWindowState } from "@vela/shared";
import { BrowserController } from "./browser-controller";
import { createLogger } from "../logger";

const log = createLogger("browser");

export interface RendererBrowserTab { id: string; conversationId: string | null; controller: BrowserController; width?: number; height?: number; agentCursor?: BrowserAgentCursor | null }
const empty: BrowserWindowState = { tabs: [], selected: {}, activeConversationId: null, operating: [], focusRequest: null };
export function useBrowserTabs(conversationId: string | null = null) {
  const api: BrowserPanelApi | undefined = window.vela?.browser;
  const [state, setState] = useState(empty);
  const [allTabs, setTabs] = useState<RendererBrowserTab[]>([]);
  const controllers = useRef(new Map<string, BrowserController>());
  const command = useCallback((request: BrowserUiCommand) => {
    if (api) void api.command(request).catch((error: unknown) => log.error("browser command failed", error));
  }, [api]);
  useEffect(() => {
    if (!api) return;
    let live = true;
    let received = false;
    const project = (next: BrowserWindowState) => {
      if (!live) return;
      setState(next);
      setTabs(next.tabs.map(tab => {
        let controller = controllers.current.get(tab.id);
        if (!controller) { controller = new BrowserController({ tabId: tab.id, command }); controllers.current.set(tab.id, controller); }
        controller.project(tab);
        return { ...tab, controller };
      }));
      for (const id of controllers.current.keys()) if (!next.tabs.some(tab => tab.id === id)) controllers.current.delete(id);
    };
    const unsubscribe = api.subscribe(next => { received = true; project(next); });
    void api.command({ type: "state" }).then(next => { if (!received) project(next); }).catch((error: unknown) => log.error("browser state request failed", error));
    return () => { live = false; unsubscribe(); };
  }, [api, command]);
  // Commands share the IPC channel: activation is sent before subsequent user opens.
  useEffect(() => { command({ type: "activate", conversationId }); }, [command, conversationId]);
  const open = useCallback(async (id: string, url?: string) => {
    if (api) { await api.command({ type: "open", id, url }); return; }
    const controller = new BrowserController();
    if (url) { controller.setAddress(url); controller.navigate(); }
    setTabs(current => [...current, { id, conversationId, controller }]);
  }, [api, command, conversationId]);
  const close = useCallback((id: string) => {
    if (api) command({ type: "close", tabId: id });
    else setTabs(current => current.filter(tab => tab.id !== id));
  }, [api, command]);
  const select = useCallback((id: string) => command({ type: "select", tabId: id }), [command]);
  return { tabs: allTabs.filter(tab => tab.conversationId === conversationId), allTabs, open, close, select, command, state, hosted: !!api };
}
