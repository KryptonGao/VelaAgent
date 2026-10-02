import { normalizeBrowserAddress, UI_BROWSER_BLANK_URL } from "../../browser-policy";
import { BrowserStore } from "./browser-store";

/** Narrow guest adapter. It deliberately exposes no scripting, CDP, or Agent bridge. */
export interface BrowserView {
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
  loadURL(url: string): Promise<void>;
  getURL(): string;
  getTitle(): string;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  stop(): void;
}

/** A single manual browser tab; lifetime is independent of visibility. */
export class BrowserController {
  readonly store = new BrowserStore();
  private view: BrowserView | null = null;
  private detachListeners: (() => void) | null = null;
  private pendingUrl: string | null = null;
  private navigation = 0;

  attach(view: BrowserView): void {
    if (this.view === view) return;
    this.detach();
    this.view = view;
    const listen = (type: string, handler: (event: Event) => void): (() => void) => {
      const listener: EventListener = handler;
      view.addEventListener(type, listener);
      return () => view.removeEventListener(type, listener);
    };
    const cleanups = [
      listen("dom-ready", () => {
        this.store.update({ ready: true });
        this.sync();
        if (this.pendingUrl) {
          const url = this.pendingUrl;
          this.pendingUrl = null;
          this.load(url);
        }
      }),
      listen("did-start-loading", () => this.store.update({ loading: true, error: null })),
      listen("did-stop-loading", () => { this.sync(); this.store.update({ loading: false }); }),
      listen("did-navigate", () => this.sync()),
      listen("did-navigate-in-page", () => this.sync()),
      listen("page-title-updated", () => this.sync()),
      listen("did-fail-load", (event) => {
        const failure = event as Event & { errorCode: number; errorDescription: string; isMainFrame: boolean };
        if (!failure.isMainFrame || failure.errorCode === -3) return; // ERR_ABORTED: stop / superseded load
        this.sync();
        this.store.update({ loading: false, error: { code: "load-failed", detail: failure.errorDescription } });
      }),
      listen("render-process-gone", () => {
        this.store.update({ loading: false, error: { code: "renderer-gone" } });
      }),
    ];
    this.detachListeners = () => cleanups.forEach((cleanup) => cleanup());
  }

  detach(): void {
    this.navigation++;
    this.detachListeners?.();
    this.detachListeners = null;
    this.view = null;
    this.store.update({ ready: false, loading: false });
  }

  setAddress = (address: string): void => { this.store.update({ address, editingAddress: true, error: null }); };
  beginAddressEdit = (): void => { this.store.update({ editingAddress: true }); };
  endAddressEdit = (): void => { this.store.update({ editingAddress: false }); };
  resetAddress = (): void => {
    const { url } = this.store.getSnapshot();
    this.store.update({ address: url === UI_BROWSER_BLANK_URL ? "" : url, editingAddress: false, error: null });
  };
  navigate = (): void => {
    const url = normalizeBrowserAddress(this.store.getSnapshot().address);
    if (!url) { this.store.update({ error: { code: "invalid-address" } }); return; }
    this.store.update({ address: url, editingAddress: false, error: null });
    if (!this.view || !this.store.getSnapshot().ready) this.pendingUrl = url;
    else this.load(url);
  };
  back = (): void => {
    if (this.store.getSnapshot().ready && this.store.getSnapshot().canGoBack) this.run((view) => view.goBack());
  };
  forward = (): void => {
    if (this.store.getSnapshot().ready && this.store.getSnapshot().canGoForward) this.run((view) => view.goForward());
  };
  refresh = (): void => { if (this.store.getSnapshot().ready) this.run((view) => view.reload()); };
  stop = (): void => {
    this.navigation++;
    this.run((view) => view.stop());
    this.store.update({ loading: false });
  };

  private run(action: (view: BrowserView) => void): void {
    if (!this.view) return;
    try { action(this.view); }
    catch (error) { this.store.update({ error: { code: "load-failed", detail: String(error) }, loading: false }); }
  }
  private load(url: string): void {
    const navigation = ++this.navigation;
    this.store.update({ loading: true, address: url, error: null });
    this.run((view) => {
      void view.loadURL(url).catch((error: unknown) => {
        if (navigation !== this.navigation || (error as { code?: string } | null)?.code === "ERR_ABORTED") return;
        this.store.update({ loading: false, error: { code: "load-failed", detail: String(error) } });
      });
    });
  }
  private sync(): void {
    if (!this.view || !this.store.getSnapshot().ready) return;
    this.run((view) => {
      const url = view.getURL();
      const state = this.store.getSnapshot();
      this.store.update({
        url, title: url === UI_BROWSER_BLANK_URL ? "" : view.getTitle(),
        canGoBack: view.canGoBack(), canGoForward: view.canGoForward(),
        ...(!state.editingAddress ? { address: url === UI_BROWSER_BLANK_URL ? "" : url } : {}),
      });
    });
  }
}
