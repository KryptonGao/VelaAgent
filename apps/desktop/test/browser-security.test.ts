import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import type { WebContents, WebPreferences } from "electron";
import { UI_BROWSER_PARTITION } from "../src/browser-policy.ts";
import { registerUiBrowserSecurity } from "../src/main/browser-security.ts";

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
  it("guards guest navigation/redirects and routes popup links into the isolated guest", async () => {
    const embedder = setup(); const guest = new EventEmitter(); const loaded: string[] = [];
    let handler: ((details: { url: string }) => { action: string }) | undefined;
    Object.assign(guest, {
      setWindowOpenHandler(callback: typeof handler) { handler = callback; },
      async loadURL(url: string) { loaded.push(url); },
    });
    embedder.emit("did-attach-webview", {}, guest);
    for (const type of ["will-frame-navigate", "will-redirect"]) {
      const blocked = cancellable("file:///tmp/private"); guest.emit(type, blocked);
      assert.equal(blocked.prevented, true);
      const allowed = cancellable("http://localhost:3000"); guest.emit(type, allowed);
      assert.equal(allowed.prevented, false);
    }
    assert.deepEqual(handler!({ url: "https://example.com" }), { action: "deny" });
    assert.deepEqual(handler!({ url: "vela://command" }), { action: "deny" });
    await Promise.resolve(); assert.deepEqual(loaded, ["https://example.com"]);
  });
});
