import { useCallback, useSyncExternalStore } from "react";
import { UI_BROWSER_BLANK_URL, UI_BROWSER_PARTITION } from "../../../browser-policy";
import type { BrowserController, BrowserView } from "../../browser/browser-controller";
import { tr } from "../../locale";
import { ArrowLeftIcon, ArrowRightIcon, CloseIcon, GlobeIcon, RefreshIcon } from "../icons";

/** Presentation and DOM binding only. Guest events/navigation live in BrowserController. */
export function BrowserPanel({ controller }: { controller: BrowserController }) {
  const state = useSyncExternalStore(controller.store.subscribe, controller.store.getSnapshot);
  const bindView = useCallback((element: HTMLElement | null) => {
    if (element) {
      // Electron uses presence attributes; React does not serialize this boolean attribute.
      // Main-process setWindowOpenHandler denies windows and routes safe links in-place.
      element.setAttribute("allowpopups", "");
      controller.attach(element as unknown as BrowserView);
      // Set src last so Electron creates the guest with these attributes already present.
      if (!element.hasAttribute("src")) element.setAttribute("src", UI_BROWSER_BLANK_URL);
    } else controller.detach();
  }, [controller]);
  const error = state.error?.code === "invalid-address"
    ? tr("请输入有效的 HTTP 或 HTTPS 网址", "Enter a valid HTTP or HTTPS address")
    : state.error?.code === "renderer-gone"
      ? tr("页面已停止响应，请刷新重试", "The page stopped responding. Reload to retry")
      : state.error ? tr("页面加载失败", "Failed to load page") : null;
  const refreshLabel = state.loading ? tr("停止加载", "Stop loading") : tr("刷新", "Reload");

  return <section className="browser-panel" aria-label={tr("浏览器", "Browser")}>
    <div className="browser-toolbar">
      <button type="button" className="browser-nav" aria-label={tr("后退", "Back")}
        title={tr("后退", "Back")} disabled={!state.ready || !state.canGoBack} onClick={controller.back}>
        <ArrowLeftIcon size={14} />
      </button>
      <button type="button" className="browser-nav" aria-label={tr("前进", "Forward")}
        title={tr("前进", "Forward")} disabled={!state.ready || !state.canGoForward} onClick={controller.forward}>
        <ArrowRightIcon size={14} />
      </button>
      <button type="button" className="browser-nav" aria-label={refreshLabel} title={refreshLabel}
        disabled={!state.ready} onClick={state.loading ? controller.stop : controller.refresh}>
        {state.loading ? <CloseIcon size={14} /> : <RefreshIcon size={14} />}
      </button>
      <form className="browser-address-form" onSubmit={(event) => { event.preventDefault(); controller.navigate(); }}>
        <input className="browser-address" aria-label={tr("网页地址", "Web address")}
          placeholder={tr("输入网址", "Enter a URL")} value={state.address}
          autoComplete="off" spellCheck={false} aria-invalid={state.error?.code === "invalid-address" || undefined}
          onChange={(event) => controller.setAddress(event.target.value)}
          onFocus={(event) => { controller.beginAddressEdit(); event.currentTarget.select(); }}
          onBlur={controller.endAddressEdit}
          onKeyDown={(event) => {
            if (event.key === "Escape") { controller.resetAddress(); event.currentTarget.blur(); }
          }} />
      </form>
    </div>
    <div className="browser-page-info">
      <span className="browser-page-title" title={state.title || state.url}>
        {state.title || tr("浏览器", "Browser")}
      </span>
      <span className="browser-load-status" role="status">
        {state.loading ? tr("加载中…", "Loading…") : state.error ? tr("加载失败", "Load failed")
          : state.url === UI_BROWSER_BLANK_URL ? tr("手动浏览", "Manual browsing") : tr("已加载", "Loaded")}
      </span>
    </div>
    {error && <div className="browser-error" role="alert">
      {error}{state.error?.detail && <span>{state.error.detail}</span>}
    </div>}
    <div className="browser-viewport">
      <webview ref={bindView} className="browser-webview"
        partition={UI_BROWSER_PARTITION} webpreferences="contextIsolation=yes,sandbox=yes,nodeIntegration=no"
        aria-label={tr("网页内容", "Web content")} />
      {state.url === UI_BROWSER_BLANK_URL && !state.loading && !state.error && <div className="browser-empty">
        <span aria-hidden="true"><GlobeIcon size={28} /></span>
        <h2>{tr("打开网页", "Open a web page")}</h2>
        <p>{tr("在地址栏输入网址，开始浏览", "Enter a URL in the address bar to start browsing")}</p>
      </div>}
    </div>
  </section>;
}

export function BrowserTabLabel({ controller }: { controller: BrowserController }) {
  const state = useSyncExternalStore(controller.store.subscribe, controller.store.getSnapshot);
  const label = state.title || (state.url !== UI_BROWSER_BLANK_URL ? state.url : tr("浏览器", "Browser"));
  return <span className="workbench-tab-label" title={label}>{label}</span>;
}
