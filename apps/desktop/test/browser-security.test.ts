import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import type { BrowserWindow, BrowserWindowConstructorOptions, WebContents, WebPreferences } from "electron";
import { UI_BROWSER_PARTITION } from "../src/browser-policy.ts";
import { isUiBrowserContents, registerUiBrowserSecurity } from "../src/main/browser-security.ts";

class Page extends EventEmitter {
  session = {};
  destroyed = false;
  url = "about:blank";
  handler: any;
  loads: { url: string; options: unknown }[] = [];
  setWindowOpenHandler(handler: any) { this.handler = handler; }
  async loadURL(url: string, options?: unknown) { this.loads.push({ url, options }); }
  isDestroyed() { return this.destroyed; }
  getURL() { return this.url; }
  destroy() { this.destroyed = true; this.emit("destroyed"); }
}
class Popup extends EventEmitter {
  webContents = new Page();
  title = "";
  constructor(readonly options: BrowserWindowConstructorOptions) {
    super();
    this.webContents = (options as { webContents?: Page }).webContents ?? this.webContents;
    this.webContents.session = options.webPreferences!.session!;
  }
  setMenu() {}
  setTitle(title: string) { this.title = title; }
  isDestroyed() { return this.webContents.isDestroyed(); }
  destroy() { this.webContents.destroy(); this.emit("closed"); }
}

function setup() {
  const embedder = new EventEmitter();
  registerUiBrowserSecurity(embedder as unknown as WebContents);
  return embedder;
}
function cancellable(url?: string) {
  return { url, prevented: false, preventDefault() { this.prevented = true; } };
}

describe("manual browser main-process isolation", () => {
  it("strips preload and overrides guest-controlled security preferences", () => {
    const embedder = setup();
    const preferences: WebPreferences = {
      preload: "/app/preload.js", nodeIntegration: true, contextIsolation: false,
      sandbox: false, webSecurity: false, nodeIntegrationInWorker: true,
      nodeIntegrationInSubFrames: true, webviewTag: true, allowRunningInsecureContent: true,
    };
    const event = cancellable();
    embedder.emit("will-attach-webview", event, preferences, { partition: UI_BROWSER_PARTITION, src: "about:blank" });
    assert.equal(event.prevented, false); assert.equal(preferences.preload, undefined);
    for (const flag of ["nodeIntegration", "nodeIntegrationInWorker", "nodeIntegrationInSubFrames", "webviewTag", "allowRunningInsecureContent", "navigateOnDragDrop"] as const) assert.equal(preferences[flag], false);
    for (const flag of ["contextIsolation", "sandbox", "webSecurity"] as const) assert.equal(preferences[flag], true);
  });
  it("rejects other partitions and privileged initial URLs", () => {
    const embedder = setup();
    for (const [partition, src] of [["", "https://example.com"], ["persist:agent", "about:blank"],
      [UI_BROWSER_PARTITION, "file:///tmp/private"], [UI_BROWSER_PARTITION, "javascript:alert(1)"]]) {
      const event = cancellable(); embedder.emit("will-attach-webview", event, {}, { partition, src });
      assert.equal(event.prevented, true);
    }
  });
  it("guards guest navigation/redirects and denies popups without a trusted factory", () => {
    const embedder = setup(); const guest = new Page();
    embedder.emit("did-attach-webview", {}, guest);
    for (const type of ["will-frame-navigate", "will-redirect"]) {
      const blocked = cancellable("file:///tmp/private"); guest.emit(type, blocked);
      assert.equal(blocked.prevented, true);
      const allowed = cancellable("http://localhost:3000"); guest.emit(type, allowed);
      assert.equal(allowed.prevented, false);
    }
    assert.deepEqual(guest.handler({ url: "https://example.com" }), { action: "deny" });
    assert.deepEqual(guest.handler({ url: "vela://command" }), { action: "deny" });
  });
  it("secures real popup creation, nested windows and blank children before navigation", () => {
    const embedder = new EventEmitter(); const guest = new Page(); const popups: Popup[] = [];
    registerUiBrowserSecurity(embedder as unknown as WebContents, undefined, options => {
      const popup = new Popup(options); popups.push(popup); return popup as unknown as BrowserWindow;
    });
    embedder.emit("did-attach-webview", {}, guest);
    for (const url of ["file:///tmp/private", "javascript:alert(1)", "data:text/html,hello", "vela://command"]) {
      assert.deepEqual(guest.handler({ url }), { action: "deny" });
    }
    const response = guest.handler({ url: "about:blank" });
    assert.equal(response.action, "allow");
    assert.equal(response.overrideBrowserWindowOptions.webPreferences.sandbox, true);
    assert.equal(response.overrideBrowserWindowOptions.webPreferences.session, guest.session);
    const nativeChild = new Page();
    const child = response.createWindow({ width: 10, height: 99999, frame: false,
      webContents: nativeChild,
      webPreferences: { preload: "/privileged.js", nodeIntegration: true, partition: "persist:evil", sandbox: false } });
    assert.equal(child, popups[0].webContents);
    assert.equal(child, nativeChild, "retain Electron's native child/opener relation");
    const options = popups[0].options;
    assert.equal(options.width, 320); assert.equal(options.height, 1200); assert.equal(options.frame, undefined);
    assert.equal(options.webPreferences!.session, guest.session);
    assert.equal(options.webPreferences!.preload, undefined); assert.equal(options.webPreferences!.partition, undefined);
    assert.equal(options.webPreferences!.sandbox, true); assert.equal(options.webPreferences!.contextIsolation, true);
    assert.equal(options.webPreferences!.nodeIntegration, false); assert.equal(options.webPreferences!.webviewTag, false);
    assert.equal(isUiBrowserContents(child), true);
    for (const type of ["will-frame-navigate", "will-redirect"]) {
      const blocked = cancellable("file:///tmp/private"); child.emit(type, blocked); assert.equal(blocked.prevented, true);
    }
    child.url = "https://login.example.com/oauth?token=private";
    child.emit("did-navigate"); assert.equal(popups[0].title, "Vela Browser — https://login.example.com");
    const title = cancellable(); child.emit("page-title-updated", title); assert.equal(title.prevented, true);
    const nested = child.handler({ url: "https://example.com" }).createWindow({});
    assert.equal(nested.session, guest.session);
    guest.destroy(); assert.equal(child.isDestroyed(), true); assert.equal(nested.isDestroyed(), true);
    assert.equal(isUiBrowserContents(child), false);
  });
  it("loads every deferred disposition with inherited HTML sandbox, referrer and POST data", async () => {
    const embedder = new EventEmitter(); const guest = new Page(); const popups: Popup[] = [];
    registerUiBrowserSecurity(embedder as unknown as WebContents, undefined, options => {
      const popup = new Popup(options); popups.push(popup); return popup as unknown as BrowserWindow;
    });
    embedder.emit("did-attach-webview", {}, guest);
    const referrer = { url: "https://example.com/login", policy: "strict-origin-when-cross-origin" };
    const data = [{ type: "rawData", bytes: Buffer.from("state=proof") }];
    for (const disposition of ["background-tab", "foreground-tab", "new-window"]) {
      const child = guest.handler({ url: "https://provider.example/auth", disposition, referrer,
        postBody: { contentType: "application/x-www-form-urlencoded", data } }).createWindow({
        webPreferences: { openerSandboxFlags: 42, preload: "/evil.js", nodeIntegration: true },
      });
      await Promise.resolve();
      assert.deepEqual(child.loads, [{ url: "https://provider.example/auth", options: {
        httpReferrer: referrer, postData: data, extraHeaders: "Content-Type: application/x-www-form-urlencoded",
      } }]);
      assert.equal(popups.at(-1)!.options.webPreferences!.preload, undefined);
      assert.equal((popups.at(-1)!.options.webPreferences as { openerSandboxFlags?: number }).openerSandboxFlags, 42);
      popups.at(-1)!.destroy();
    }
    guest.destroy();
  });
  it("bounds each popup tree and releases slots on closure; embedder closure cleans up", () => {
    const embedder = new EventEmitter(); const guest = new Page(); const popups: Popup[] = [];
    registerUiBrowserSecurity(embedder as unknown as WebContents, undefined, options => {
      const popup = new Popup(options); popups.push(popup); return popup as unknown as BrowserWindow;
    });
    embedder.emit("did-attach-webview", {}, guest);
    for (let i = 0; i < 8; i++) guest.handler({ url: "https://example.com" }).createWindow({});
    assert.equal(guest.handler({ url: "https://example.com" }).action, "deny");
    assert.equal(popups[0].webContents.handler({ url: "https://example.com" }).action, "deny");
    popups[0].destroy(); assert.equal(guest.handler({ url: "https://example.com" }).action, "allow");
    embedder.emit("destroyed"); assert.ok(popups.every(p => p.isDestroyed()));
  });
});
