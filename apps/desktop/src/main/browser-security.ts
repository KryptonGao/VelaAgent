import type { WebContents } from "electron";
import { isUiBrowserUrl, UI_BROWSER_PARTITION } from "../browser-policy";

/** Only the local workbench may attach guests. Remote pages get no Vela preload or IPC. */
export function registerUiBrowserSecurity(embedder: WebContents, onGuest?: (guest: WebContents) => void): void {
  embedder.on("will-attach-webview", (event, preferences, params) => {
    if (params.partition !== UI_BROWSER_PARTITION || !isUiBrowserUrl(params.src)) {
      event.preventDefault();
      return;
    }
    delete preferences.preload;
    preferences.nodeIntegration = false;
    preferences.nodeIntegrationInWorker = false;
    preferences.nodeIntegrationInSubFrames = false;
    preferences.contextIsolation = true;
    preferences.sandbox = true;
    preferences.webSecurity = true;
    preferences.allowRunningInsecureContent = false;
    preferences.webviewTag = false;
    preferences.navigateOnDragDrop = false;
  });
  embedder.on("did-attach-webview", (_event, guest) => {
    onGuest?.(guest);
    guest.on("will-frame-navigate", (event) => {
      if (!isUiBrowserUrl(event.url)) event.preventDefault();
    });
    guest.on("will-redirect", (event) => {
      if (!isUiBrowserUrl(event.url)) event.preventDefault();
    });
    // Open target=_blank links in this guest, with the same isolation and URL policy.
    guest.setWindowOpenHandler(({ url }) => {
      if (isUiBrowserUrl(url)) void guest.loadURL(url).catch(() => undefined);
      return { action: "deny" };
    });
  });
}
