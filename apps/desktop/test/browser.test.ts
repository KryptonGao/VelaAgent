import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isUiBrowserUrl, normalizeBrowserAddress } from "../src/browser-policy.ts";
import { BrowserController, type BrowserView } from "../src/renderer/browser/browser-controller.ts";

class Guest extends EventTarget implements BrowserView {
  url = "about:blank";
  title = "";
  backAvailable = false;
  forwardAvailable = false;
  calls: string[] = [];
  rejectLoad: ((reason: unknown) => void) | null = null;
  loadURL(url: string): Promise<void> {
    this.calls.push(url);
    return new Promise((_resolve, reject) => { this.rejectLoad = reject; });
  }
  getURL() { return this.url; }
  getTitle() { return this.title; }
  canGoBack() { return this.backAvailable; }
  canGoForward() { return this.forwardAvailable; }
  goBack() { this.calls.push("back"); }
  goForward() { this.calls.push("forward"); }
  reload() { this.calls.push("reload"); }
  stop() { this.calls.push("stop"); }
  emit(type: string, detail = {}) { this.dispatchEvent(Object.assign(new Event(type), detail)); }
}

function setup() {
  const controller = new BrowserController();
  const guest = new Guest();
  controller.attach(guest);
  guest.emit("dom-ready");
  return { controller, guest, state: controller.store.getSnapshot };
}

describe("manual browser address policy", () => {
  it("normalizes hosts and local development URLs without admitting privileged schemes", () => {
    for (const [input, expected] of [
      [" example.com/a?x=1#two ", "https://example.com/a?x=1#two"],
      ["localhost:5173", "http://localhost:5173/"],
      ["127.0.0.1:3000/a", "http://127.0.0.1:3000/a"],
      ["[::1]:8080", "http://[::1]:8080/"],
      ["example.com:8080", "https://example.com:8080/"],
      ["http://example.com", "http://example.com/"],
      ["about:blank", "about:blank"],
    ]) assert.equal(normalizeBrowserAddress(input), expected);
    for (const input of ["", "hello world", "file:///tmp/private", "javascript:alert(1)",
      "data:text/html,test", "vela://command", "about:config", "https://", "http://[bad]"]) {
      assert.equal(normalizeBrowserAddress(input), null, input);
      assert.equal(isUiBrowserUrl(input), false, input);
    }
  });
});

describe("BrowserController lifecycle and navigation", () => {
  it("queues navigation until dom-ready and never calls guest methods early", () => {
    const controller = new BrowserController();
    const guest = new Guest();
    controller.attach(guest);
    controller.setAddress("localhost:5173"); controller.navigate(); controller.refresh(); controller.back();
    assert.deepEqual(guest.calls, []);
    guest.emit("dom-ready");
    assert.deepEqual(guest.calls, ["http://localhost:5173/"]);
    assert.equal(controller.store.getSnapshot().loading, true);
    assert.equal(controller.store.getSnapshot().address, "http://localhost:5173/");
  });
  it("tracks redirects, titles, SPA history and navigation availability", () => {
    const { controller, guest, state } = setup();
    guest.url = "https://example.com/redirected"; guest.title = "Example"; guest.backAvailable = true;
    guest.emit("did-navigate");
    assert.equal(state().address, guest.url); assert.equal(state().title, "Example");
    controller.back(); controller.forward(); controller.refresh();
    assert.deepEqual(guest.calls, ["back", "reload"]);
    guest.forwardAvailable = true; guest.emit("did-navigate-in-page"); controller.forward();
    guest.title = "New title"; guest.emit("page-title-updated");
    assert.equal(state().title, "New title");
    assert.equal(guest.calls.at(-1), "forward");
    guest.emit("did-start-loading"); assert.equal(state().loading, true);
    guest.emit("did-stop-loading"); assert.equal(state().loading, false);
  });
  it("does not overwrite an address being edited when background events arrive", () => {
    const { controller, guest, state } = setup();
    controller.beginAddressEdit(); controller.setAddress("new.example/path");
    guest.url = "https://example.com/"; guest.emit("did-navigate");
    assert.equal(state().address, "new.example/path");
    controller.resetAddress(); assert.equal(state().address, guest.url);
    controller.setAddress("file:///tmp/private"); controller.navigate();
    assert.equal(state().error?.code, "invalid-address"); assert.deepEqual(guest.calls, []);
  });
  it("ignores cancelled/subframe failures and reports main-frame failure and crashes", () => {
    const { guest, state } = setup();
    guest.emit("did-fail-load", { errorCode: -3, isMainFrame: true });
    guest.emit("did-fail-load", { errorCode: -105, isMainFrame: false });
    assert.equal(state().error, null);
    guest.emit("did-fail-load", { errorCode: -105, isMainFrame: true, errorDescription: "ERR_NAME_NOT_RESOLVED" });
    assert.equal(state().error?.detail, "ERR_NAME_NOT_RESOLVED");
    guest.emit("did-start-loading"); assert.equal(state().error, null);
    guest.emit("render-process-gone"); assert.equal(state().error?.code, "renderer-gone");
  });
  it("ignores stale promises after a new navigation, stopping or detaching", async () => {
    const { controller, guest, state } = setup();
    controller.setAddress("one.example"); controller.navigate(); const rejectFirst = guest.rejectLoad!;
    controller.setAddress("two.example"); controller.navigate();
    rejectFirst(new Error("old failure")); await Promise.resolve(); assert.equal(state().error, null);
    const rejectSecond = guest.rejectLoad!; controller.stop();
    rejectSecond(new Error("stopped")); await Promise.resolve(); assert.equal(state().error, null);
    controller.navigate(); const rejectThird = guest.rejectLoad!; controller.detach();
    rejectThird(new Error("closed")); await Promise.resolve(); assert.equal(state().error, null);
  });
  it("cleans up listeners and attaches idempotently, with no cross-tab state", () => {
    const { controller, guest, state } = setup();
    const other = setup();
    guest.url = "https://one.example/"; guest.emit("did-navigate");
    assert.equal(other.state().url, "about:blank");
    const snapshot = state(); let updates = 0;
    const unsubscribe = controller.store.subscribe(() => updates++);
    controller.attach(guest); guest.emit("did-navigate");
    assert.equal(state(), snapshot); assert.equal(updates, 0);
    controller.detach(); const detached = state(); guest.emit("did-start-loading");
    assert.equal(state(), detached); unsubscribe();
    controller.attach(guest); guest.emit("dom-ready"); assert.equal(state().url, guest.url);
  });
});

describe("BrowserController Host projection", () => {
  it("routes every manual navigation command through Host without accessing the guest", () => {
    const commands: unknown[] = [];
    const controller = new BrowserController({ tabId: "shared", command: command => commands.push(command) });
    const guest = new Guest();
    controller.attach(guest);
    guest.emit("dom-ready");
    controller.setAddress("localhost:5173"); controller.navigate();
    controller.back(); controller.forward(); controller.refresh(); controller.stop();
    assert.deepEqual(guest.calls, []);
    assert.deepEqual(commands, [
      { type: "goto", tabId: "shared", url: "http://localhost:5173/" },
      { type: "back", tabId: "shared" }, { type: "forward", tabId: "shared" },
      { type: "reload", tabId: "shared" }, { type: "stop", tabId: "shared" },
    ]);
    assert.equal(controller.store.getSnapshot().ready, false);
  });
  it("projects authoritative state, preserves address drafts and survives view detachment", () => {
    const controller = new BrowserController({ tabId: "shared", command: () => {} });
    const tab = { id: "shared", conversationId: "a", url: "https://example.com/", title: "Example",
      loading: true, ready: true, canGoBack: true, canGoForward: false, error: null, width: 1024, height: 768 };
    controller.project(tab);
    assert.equal(controller.store.getSnapshot().address, tab.url);
    controller.setAddress("draft.example");
    controller.project({ ...tab, url: "https://example.com/redirect", loading: false });
    assert.equal(controller.store.getSnapshot().address, "draft.example");
    assert.equal(controller.store.getSnapshot().url, "https://example.com/redirect");
    const snapshot = controller.store.getSnapshot();
    controller.detach();
    assert.equal(controller.store.getSnapshot(), snapshot);
    controller.resetAddress();
    assert.equal(controller.store.getSnapshot().address, "https://example.com/redirect");
    controller.setAddress("file:///private"); controller.navigate();
    assert.equal(controller.store.getSnapshot().error?.code, "invalid-address");
  });
});
