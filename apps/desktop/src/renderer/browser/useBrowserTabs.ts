import { useCallback, useState } from "react";
import { BrowserController } from "./browser-controller";

/** Manual UI tabs are window-scoped, independent of workspace/conversation/Agent. */
export function useBrowserTabs() {
  const [tabs, setTabs] = useState<{ id: string; controller: BrowserController }[]>([]);
  const open = useCallback((id: string, url?: string) => {
    const tab = { id, controller: new BrowserController() };
    if (url) {
      tab.controller.setAddress(url);
      tab.controller.navigate();
    }
    setTabs((current) => [...current, tab]);
  }, []);
  const close = useCallback((id: string) => {
    setTabs((current) => current.filter((tab) => tab.id !== id));
  }, []);
  return { tabs, open, close };
}
