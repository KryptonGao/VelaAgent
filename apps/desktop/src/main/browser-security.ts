import type { BrowserWindow, BrowserWindowConstructorOptions, WebContents, WebPreferences } from "electron";
import { isUiBrowserUrl, UI_BROWSER_PARTITION } from "../browser-policy";

const browserContents = new WeakSet<WebContents>();
// Electron passes this native child in createWindow but omits it from its public constructor type.
type PopupOptions = BrowserWindowConstructorOptions & { webContents?: WebContents };
type InheritedPreferences = WebPreferences & { openerSandboxFlags?: number };
export function isUiBrowserContents(contents: WebContents): boolean {
  return browserContents.has(contents) && !contents.isDestroyed();
}

function isolatedPreferences(): WebPreferences {
  return {
    nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
    contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false,
    webviewTag: false, navigateOnDragDrop: false,
  };
}

/** Only the local workbench may attach guests. Remote pages get no Vela preload or IPC. */
export function registerUiBrowserSecurity(embedder: WebContents, onGuest?: (guest: WebContents) => void,
  createPopup?: (options: PopupOptions) => BrowserWindow): void {
  const windowPopups = new Set<BrowserWindow>();
  embedder.once("destroyed", () => {
    for (const popup of windowPopups) if (!popup.isDestroyed()) popup.destroy();
  });
  embedder.on("will-attach-webview", (event, preferences, params) => {
    if (params.partition !== UI_BROWSER_PARTITION || !isUiBrowserUrl(params.src)) {
      event.preventDefault();
      return;
    }
    delete preferences.preload;
    Object.assign(preferences, isolatedPreferences());
  });
  embedder.on("did-attach-webview", (_event, guest) => {
    onGuest?.(guest);
    const popups = new Set<BrowserWindow>();
    const securePage = (page: WebContents) => {
      browserContents.add(page);
      page.on("will-frame-navigate", (event) => {
        if (!isUiBrowserUrl(event.url)) event.preventDefault();
      });
      page.on("will-redirect", (event) => {
        if (!isUiBrowserUrl(event.url)) event.preventDefault();
      });
      const children = new Set<BrowserWindow>();
      page.once("destroyed", () => {
        browserContents.delete(page);
        for (const child of children) if (!child.isDestroyed()) child.destroy();
      });
      // Let Chromium establish opener, postMessage, POST bodies and window.close().
      // Secure the child before its first navigation, including about:blank children.
      page.setWindowOpenHandler(({ url, referrer, postBody }) => {
        if (!createPopup || !isUiBrowserUrl(url) || popups.size >= 8) return { action: "deny" };
        return { action: "allow",
          overrideBrowserWindowOptions: { webPreferences: { ...isolatedPreferences(), session: page.session } },
          createWindow: (options) => {
            const size = (value: number | undefined, fallback: number) =>
              Number.isFinite(value) ? Math.max(320, Math.min(1200, value!)) : fallback;
            const popup = createPopup({
              // Electron's supplied WebContents carries the Chromium opener relation.
              // Replacing it creates a disconnected window and can deadlock window.open.
              webContents: (options as PopupOptions).webContents,
              width: size(options.width, 520), height: size(options.height, 720), show: true,
              title: "Vela Browser", autoHideMenuBar: true,
              webPreferences: { ...isolatedPreferences(), session: page.session,
                // HTML iframe sandbox restrictions must also reach deferred children.
                ...((options.webPreferences as InheritedPreferences)?.openerSandboxFlags !== undefined
                  ? { openerSandboxFlags: (options.webPreferences as InheritedPreferences).openerSandboxFlags } : {}),
              },
            });
            children.add(popup); popups.add(popup); windowPopups.add(popup);
            popup.once("closed", () => { children.delete(popup); popups.delete(popup); windowPopups.delete(popup); });
            popup.setMenu(null);
            securePage(popup.webContents);
            const updateTitle = () => {
              if (popup.isDestroyed()) return;
              const address = popup.webContents.getURL();
              popup.setTitle(`Vela Browser — ${isUiBrowserUrl(address) && address !== "about:blank" ? new URL(address).origin : "about:blank"}`);
            };
            popup.webContents.on("did-navigate", updateTitle);
            popup.webContents.on("page-title-updated", (event) => { event.preventDefault(); updateTitle(); });
            // All modified-link dispositions may defer creating the native child.
            if (!(options as PopupOptions).webContents) {
              void popup.webContents.loadURL(url, { httpReferrer: referrer,
                ...(postBody ? { postData: postBody.data,
                  extraHeaders: `Content-Type: ${postBody.contentType}${postBody.boundary ? `; boundary=${postBody.boundary}` : ""}` } : {}),
              }).catch(() => undefined);
            }
            return popup.webContents;
          },
        };
      });
    };
    securePage(guest);
  });
}
