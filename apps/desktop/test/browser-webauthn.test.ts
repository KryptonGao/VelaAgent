import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import type { App, BrowserWindow, MessageBoxOptions, MessageBoxReturnValue, Session, WebContents, WebFrameMain } from "electron";
import { registerUiBrowserSecurity } from "../src/main/browser-security.ts";
import { configureBrowserPlatformAuthenticator, registerBrowserWebAuthn } from "../src/main/browser-webauthn.ts";

function setup(selectionTimeoutMs?: number) {
  const browserSession = new EventEmitter();
  const contents = Object.assign(new EventEmitter(), {
    session: browserSession, destroyed: false, isDestroyed() { return this.destroyed; }, setWindowOpenHandler() {},
  });
  const embedder = new EventEmitter();
  registerUiBrowserSecurity(embedder as unknown as WebContents);
  embedder.emit("did-attach-webview", {}, contents);
  const frame = { url: "https://login.example.com/auth", get origin() { return new URL(this.url).origin; },
    destroyed: false, isDestroyed() { return this.destroyed; } };
  let parentDestroyed = false;
  const parent = { isDestroyed: () => parentDestroyed } as BrowserWindow;
  const dialogs: MessageBoxOptions[] = [];
  let resolve: (result: MessageBoxReturnValue) => void = () => {};
  let reject: (error: Error) => void = () => {};
  const dispose = registerBrowserWebAuthn(browserSession as unknown as Session, {
    selectionTimeoutMs,
    contentsFromFrame: () => contents as unknown as WebContents,
    parentForContents: () => parent,
    showMessageBox: async (_parent, options) => {
      assert.equal(_parent, parent); dialogs.push(options);
      return new Promise<MessageBoxReturnValue>((yes, no) => { resolve = yes; reject = no; });
    },
  });
  const callbacks: (string | null | undefined)[] = [];
  const request = (overrides = {}) => browserSession.emit("select-webauthn-account", {}, {
    relyingPartyId: "example.com", frame: frame as unknown as WebFrameMain,
    accounts: [{ credentialId: "first", name: "alice@example.com" }, { credentialId: "second", displayName: "Bob" }],
    ...overrides,
  }, (id?: string | null) => callbacks.push(id));
  const response = async (index: number) => { resolve({ response: index, checkboxChecked: false }); await Promise.resolve(); await Promise.resolve(); };
  return { browserSession, contents, frame, dialogs, callbacks, request, response, dispose,
    reject: async () => { reject(new Error("Dialog failed")); await Promise.resolve(); await Promise.resolve(); },
    destroyParent: () => { parentDestroyed = true; } };
}

describe("browser native WebAuthn", () => {
  it("configures macOS with the signed keychain group and leaves other platforms native", () => {
    const calls: unknown[] = [];
    const app = { configureWebAuthn: (options: unknown) => calls.push(options) } as Pick<App, "configureWebAuthn">;
    assert.equal(configureBrowserPlatformAuthenticator(app, "darwin", null), false);
    assert.equal(configureBrowserPlatformAuthenticator(app, "win32", "TEAM.group"), false);
    assert.equal(configureBrowserPlatformAuthenticator(app, "linux", "TEAM.group"), false);
    assert.equal(configureBrowserPlatformAuthenticator(app, "darwin", "A1B2C3D4E5.com.vela.desktop.webauthn"), true);
    assert.deepEqual(calls, [{ touchID: { keychainAccessGroup: "A1B2C3D4E5.com.vela.desktop.webauthn", promptReason: "sign in to $1" } }]);
  });
  it("requires an explicit account selection, binds to the requesting origin and calls back once", async () => {
    const s = setup(); s.request();
    assert.deepEqual(s.callbacks, []);
    assert.deepEqual(s.dialogs[0].buttons, ["Cancel", "alice@example.com", "Bob"]);
    assert.equal(s.dialogs[0].defaultId, 0); assert.equal(s.dialogs[0].cancelId, 0);
    assert.match(s.dialogs[0].detail!, /https:\/\/login.example.com\/auth/);
    await s.response(2); assert.deepEqual(s.callbacks, ["second"]);
    assert.equal(s.dialogs[0].signal!.aborted, true);
    assert.equal(s.contents.listenerCount("did-start-navigation"), 0);
    s.dispose(); assert.deepEqual(s.callbacks, ["second"]);
  });
  it("handles cancellation, invalid selections and dialog errors", async () => {
    for (const response of [0, -1, 99]) {
      const s = setup(); s.request(); await s.response(response); assert.deepEqual(s.callbacks, [undefined]); s.dispose();
    }
    const s = setup(); s.request(); await s.reject(); assert.deepEqual(s.callbacks, [undefined]); s.dispose();
  });
  it("does not automatically select a single discoverable passkey", async () => {
    const s = setup(); s.request({ accounts: [{ credentialId: "only", name: "Alice" }] });
    assert.deepEqual(s.callbacks, []); await s.response(1); assert.deepEqual(s.callbacks, ["only"]); s.dispose();
  });
  it("rejects dead/empty/foreign request frames and destroyed parent windows", () => {
    for (const reason of ["null-frame", "dead-frame", "dead-contents", "empty", "foreign-session", "dead-parent"]) {
      const s = setup();
      if (reason === "dead-frame") s.frame.destroyed = true;
      if (reason === "dead-contents") s.contents.destroyed = true;
      if (reason === "foreign-session") s.contents.session = new EventEmitter();
      if (reason === "dead-parent") s.destroyParent();
      s.request(reason === "null-frame" ? { frame: null } : reason === "empty" ? { accounts: [] } : {});
      assert.deepEqual(s.callbacks, [undefined], reason); assert.equal(s.dialogs.length, 0); s.dispose();
    }
  });
  it("cancels pending selection on page closure, crash, navigation or service disposal", async () => {
    for (const reason of ["destroyed", "render-process-gone", "main-navigation", "frame-navigation", "dispose"]) {
      const s = setup(); s.request();
      if (reason === "dispose") s.dispose();
      else if (reason === "main-navigation") s.contents.emit("did-start-navigation", { isSameDocument: false, isMainFrame: true });
      else if (reason === "frame-navigation") s.contents.emit("did-start-navigation", { isSameDocument: false, frame: s.frame });
      else s.contents.emit(reason);
      assert.deepEqual(s.callbacks, [undefined], reason); assert.equal(s.dialogs[0].signal!.aborted, true);
      await s.response(1); assert.deepEqual(s.callbacks, [undefined]); s.dispose();
    }
  });
  it("keeps selections during unrelated iframe/same-document navigation and rejects changed frame origins", async () => {
    const s = setup(); s.request();
    s.contents.emit("did-start-navigation", { isSameDocument: false, isMainFrame: false, frame: {} });
    s.contents.emit("did-start-navigation", { isSameDocument: true, isMainFrame: true, frame: s.frame });
    assert.deepEqual(s.callbacks, []);
    s.frame.url = "https://evil.example/"; await s.response(1); assert.deepEqual(s.callbacks, [undefined]); s.dispose();
  });
  it("allows SPA route and fragment updates in the same requesting document", async () => {
    const s = setup(); s.request();
    s.frame.url = "https://login.example.com/continue#passkey";
    s.contents.emit("did-start-navigation", { isSameDocument: true, isMainFrame: true, frame: s.frame });
    await s.response(1); assert.deepEqual(s.callbacks, ["first"]); s.dispose();
  });
  it("cleans up the session listener and settles every pending request on disposal", () => {
    const s = setup(); s.request(); s.request(); s.dispose(); s.dispose();
    assert.deepEqual(s.callbacks, [undefined, undefined]);
    assert.equal(s.browserSession.listenerCount("select-webauthn-account"), 0);
    assert.ok(s.dialogs.every(dialog => dialog.signal!.aborted));
  });
  it("closes and cancels a previous chooser when the same frame starts another request", () => {
    const s = setup(); s.request(); s.request();
    assert.deepEqual(s.callbacks, [undefined]);
    assert.equal(s.dialogs[0].signal!.aborted, true); assert.equal(s.dialogs[1].signal!.aborted, false);
    s.dispose(); assert.deepEqual(s.callbacks, [undefined, undefined]);
  });
  it("bounds a stale chooser even when the page's cancellation has no native notification", async () => {
    const s = setup(10); s.request();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.deepEqual(s.callbacks, [undefined]); assert.equal(s.dialogs[0].signal!.aborted, true);
    assert.equal(s.contents.listenerCount("did-start-navigation"), 0);
    await s.response(1); assert.deepEqual(s.callbacks, [undefined]); s.dispose();
  });
});
