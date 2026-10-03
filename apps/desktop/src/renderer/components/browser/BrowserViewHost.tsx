import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { BrowserUiCommand } from "@vela/shared";
import type { RendererBrowserTab } from "../../browser/useBrowserTabs";
import type { BrowserView } from "../../browser/browser-controller";
import { UI_BROWSER_BLANK_URL, UI_BROWSER_PARTITION } from "../../../browser-policy";
import { BrowserAgentPointer } from "./BrowserAgentPointer";

interface Placement { left: number; top: number; width: number; height: number; visible: boolean }
/** Stable parent and keys: panel lifecycles never detach or recreate guests. */
export function BrowserViewHost({ tabs, activeTabId, visible, hosted, command }: {
  tabs: RendererBrowserTab[]; activeTabId: string | null; visible: boolean; hosted: boolean;
  command: (command: BrowserUiCommand) => void;
}) {
  return <div className="browser-view-host">{tabs.map(tab => <PersistentGuest key={tab.id}
    tab={tab} visible={visible && tab.id === activeTabId} hosted={hosted} command={command} />)}</div>;
}
function PersistentGuest({ tab, visible, hosted, command }: {
  tab: RendererBrowserTab; visible: boolean; hosted: boolean; command: (command: BrowserUiCommand) => void;
}) {
  const [placement, setPlacement] = useState<Placement>({ left: -10000, top: 0, width: tab.width || 1024, height: tab.height || 768, visible: false });
  const state = useSyncExternalStore(tab.controller.store.subscribe, tab.controller.store.getSnapshot);
  // Keep measuring the selected viewport even while its blank-page placeholder is shown.
  const guestVisible = placement.visible && (state.url !== UI_BROWSER_BLANK_URL || state.loading);
  const cleanup = useRef<(() => void) | null>(null);
  const bind = useCallback((element: HTMLElement | null) => {
    cleanup.current?.(); cleanup.current = null;
    if (!element) return;
    element.setAttribute("allowpopups", "");
    if (hosted) {
      let boundGuestId: number | null = null;
      const ready = () => {
        const guestId = (element as unknown as { getWebContentsId(): number }).getWebContentsId();
        if (guestId === boundGuestId) return;
        boundGuestId = guestId;
        command({ type: "bind", tabId: tab.id, guestId });
      };
      element.addEventListener("dom-ready", ready);
      cleanup.current = () => element.removeEventListener("dom-ready", ready);
    } else {
      tab.controller.attach(element as unknown as BrowserView);
      cleanup.current = () => tab.controller.detach();
    }
    if (!element.hasAttribute("src")) element.setAttribute("src", UI_BROWSER_BLANK_URL);
  }, [tab.id, tab.controller, hosted, command]);
  useEffect(() => {
    let frame = 0;
    let lastSize = "";
    const measure = () => {
      const target = visible ? Array.from(document.querySelectorAll<HTMLElement>("[data-browser-viewport]"))
        .find(element => element.dataset.browserViewport === tab.id) : undefined;
      const rect = target?.getBoundingClientRect();
      const shown = !!rect && rect.width > 0 && rect.height > 0 && !target?.closest('[hidden], [inert], [aria-hidden="true"]');
      setPlacement(previous => {
        const next = shown ? { left: rect!.left, top: rect!.top, width: Math.round(rect!.width), height: Math.round(rect!.height), visible: true }
          : { ...previous, left: -10000, visible: false };
        return Object.keys(next).every(key => next[key as keyof Placement] === previous[key as keyof Placement]) ? previous : next;
      });
      if (shown && hosted) {
        const width = Math.round(rect!.width), height = Math.round(rect!.height);
        const size = `${width}:${height}`;
        if (size !== lastSize) { lastSize = size; command({ type: "viewport", tabId: tab.id, width, height }); }
      }
      if (visible) frame = requestAnimationFrame(measure);
    };
    measure();
    return () => cancelAnimationFrame(frame);
  }, [visible, hosted, tab.id, command]);
  return <div className="browser-guest-frame" aria-hidden={!guestVisible} inert={!guestVisible}
    style={{ position: "fixed", left: guestVisible ? placement.left : -10000, top: placement.top, width: placement.width, height: placement.height,
      visibility: guestVisible ? "visible" : "hidden", pointerEvents: guestVisible ? "auto" : "none" }}>
    <webview ref={bind} className="browser-webview" partition={UI_BROWSER_PARTITION}
      webpreferences="contextIsolation=yes,sandbox=yes,nodeIntegration=no" aria-label="Web content" />
    {guestVisible && tab.agentCursor && <BrowserAgentPointer cursor={tab.agentCursor} width={placement.width} height={placement.height} />}
  </div>;
}
