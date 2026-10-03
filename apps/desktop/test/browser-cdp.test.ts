import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import type { WebContents } from "electron";
import { BrowserCdp } from "../src/main/browser-cdp.ts";
import type { BrowserAgentAction } from "../../../packages/shared/src/browser.ts";
function setup() {
  const guest = new EventEmitter(); const debuggerApi = new EventEmitter();
  const commands: { method: string; params: any; session?: string }[] = [];
  let inputValue = "";
  let attached = false; let evaluation: any = { ref: "0:1", x: 20, y: 30, rect: [0, 0, 40, 60] };
  let hook: ((method: string) => Promise<any> | undefined) | undefined;
  Object.assign(debuggerApi, {
    isAttached: () => attached, attach: () => { attached = true; }, detach: () => { attached = false; },
    async sendCommand(method: string, params: any, session?: string) {
      commands.push({ method, params, session });
      if (method === "Runtime.enable") debuggerApi.emit("message", {}, "Runtime.executionContextCreated", { context: { id: session ? 12 : 11, auxData: { frameId: session ? "child" : "main", isDefault: true } } }, session); const overridden = hook?.(method); if (overridden) return overridden;
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main", url: "https://test" }, childFrames: [{ frame: { id: "child", parentId: "main", url: "https://other" } }] } };
      if (method === "Page.createIsolatedWorld") return { executionContextId: session ? 2 : 1 };
      if (method === "Input.insertText") inputValue += params.text;
      if (method === "Runtime.evaluate" && /\)\("read",/.test(params.expression)) return { result: { value: { value: inputValue } } };
      if (method === "Runtime.evaluate" && params.expression === "({width: innerWidth, height: innerHeight})") return { result: { value: { width: 100, height: 100 } } };
      if (method === "Runtime.evaluate") return { result: { value: evaluation } };
      if (method === "DOM.getFrameOwner") return { backendNodeId: 42 };
      if (method === "DOM.getBoxModel") return { model: { content: [100, 200, 300, 200, 300, 400, 100, 400] } };
      if (method === "Page.captureScreenshot") { const png = Buffer.alloc(24); Buffer.from("89504e470d0a1a0a", "hex").copy(png); png.writeUInt32BE(800, 16); png.writeUInt32BE(600, 20); return { data: png.toString("base64") }; }
      return {};
    },
  });
  Object.assign(guest, { debugger: debuggerApi, isDestroyed: () => false });
  const cdp = new BrowserCdp(guest as unknown as WebContents);
  return { guest, debuggerApi, cdp, commands, setEvaluation: (value: any) => { evaluation = value; }, setHook: (value: typeof hook) => { hook = value; }, emit: (method: string, params: any, session?: string) => debuggerApi.emit("message", {}, method, params, session) };
}
describe("BrowserCdp", () => {
  it("reports actual input targets and kinds, without showing a pointer for reads", async () => {
    const s = setup(); const actions: BrowserAgentAction[] = [];
    const observe = (action: BrowserAgentAction) => actions.push(action);
    await s.cdp.call("query", [{ css: "button" }], undefined, undefined, observe);
    assert.equal(actions.length, 0);
    await s.cdp.call("click", [{ css: "button" }], undefined, undefined, observe);
    assert.deepEqual(actions[0], { x: 20, y: 30, viewportWidth: 100, viewportHeight: 100, kind: "click" });
    await s.cdp.call("type", [{ css: "input" }, "hello"], undefined, undefined, observe);
    assert.equal(actions.at(-1)?.kind, "type", "internal focus click remains typing feedback");
    await s.cdp.call("scroll", [{ y: 200 }], undefined, undefined, observe);
    assert.deepEqual(actions.at(-1), { x: 50, y: 50, viewportWidth: 100, viewportHeight: 100, kind: "scroll" });
    await s.cdp.call("press", [{ css: "input" }, "Enter"], undefined, undefined, observe);
    assert.equal(actions.at(-1)?.kind, "press");
    await s.cdp.call("selectOption", [{ css: "select" }, "b"], undefined, undefined, observe);
    assert.equal(actions.at(-1)?.kind, "select"); s.cdp.dispose();
  });
  it("lifts both same-process and cross-process cursor coordinates without changing input routing", async () => {
    for (const crossProcess of [false, true]) {
      const s = setup(); const actions: BrowserAgentAction[] = [];
      await s.cdp.call("console");
      if (crossProcess) s.emit("Target.attachedToTarget", { sessionId: "oopif", targetInfo: { type: "iframe", targetId: "child", url: "https://other" } });
      await s.cdp.call("click", [{ css: "button" }], "child", undefined, action => actions.push(action));
      assert.deepEqual(actions[0], { x: 140, y: 260, viewportWidth: 100, viewportHeight: 100, kind: "click" });
      const click = s.commands.find(c => c.method === "Input.dispatchMouseEvent")!;
      assert.equal(click.params.x, crossProcess ? 20 : 140);
      assert.equal(click.session, crossProcess ? "oopif" : undefined); s.cdp.dispose();
    }
  });
  it("keeps visual observers isolated between concurrent operations", async () => {
    const s = setup(); const click: BrowserAgentAction[] = [], scroll: BrowserAgentAction[] = [];
    await Promise.all([
      s.cdp.call("click", [{ css: "button" }], undefined, undefined, action => click.push(action)),
      s.cdp.call("scroll", [{ y: 10 }], undefined, undefined, action => scroll.push(action)),
    ]);
    assert.deepEqual(click.map(a => a.kind), ["click"]); assert.deepEqual(scroll.map(a => a.kind), ["scroll"]); s.cdp.dispose();
  });
  it("retains reported OOPIF ancestry even when attachment precedes the initial frame tree", async () => {
    const s = setup(); const actions: BrowserAgentAction[] = [];
    s.emit("Target.attachedToTarget", { sessionId: "oopif", targetInfo: { type: "iframe", targetId: "early-child", parentFrameId: "main", url: "https://other" } });
    await s.cdp.call("click", [{ css: "button" }], "early-child", undefined, action => actions.push(action));
    assert.equal(actions[0].x, 140); assert.equal(actions[0].y, 260);
    const snapshot = await s.cdp.call("snapshot");
    assert.equal(snapshot.frames.find((f: any) => f.id === "early-child").parentId, "main"); s.cdp.dispose();
  });
  it("allows only the fixed browser API and returns structured errors", async () => {
    const s = setup(); await assert.rejects(s.cdp.call("Browser.close"), { code: "UNSUPPORTED_METHOD" });
    assert.equal(s.commands.some(c => c.method === "Browser.close"), false); s.cdp.dispose();
  });
  it("captures PNG dimensions from the actual image", async () => {
    const s = setup(); const shot = await s.cdp.call("screenshot"); assert.equal(shot.width, 800); assert.equal(shot.height, 600); assert.equal(shot.mimeType, "image/png"); s.cdp.dispose();
  });
  it("dispatches CDP click and fill inputs", async () => {
    const s = setup(); await s.cdp.call("click", [{ css: "button" }]); await s.cdp.call("fill", [{ css: "input" }, "hello"]);
    assert.deepEqual(s.commands.filter(c => c.method === "Input.dispatchMouseEvent").map(c => c.params.type).slice(0, 2), ["mousePressed", "mouseReleased"]);
    assert.deepEqual(s.commands.find(c => c.method === "Input.insertText")?.params, { text: "hello" }); s.cdp.dispose();
  });
  it("rejects stale references and ambiguous matches immediately", async () => {
    const s = setup(); for (const error of ["STALE_REF", "AMBIGUOUS_LOCATOR"]) { s.setEvaluation({ error }); await assert.rejects(s.cdp.call("click", [{ ref: "0:1" }]), { code: error }); } s.cdp.dispose();
  });
  it("routes cross-origin frame evaluations through child sessions", async () => {
    const s = setup(); await s.cdp.call("query", [{ css: "input" }]);
    s.emit("Target.attachedToTarget", { sessionId: "oopif", targetInfo: { type: "iframe", targetId: "child", url: "https://other" } });
    await s.cdp.call("query", [{ css: "input" }], "child");
    assert.equal(s.commands.filter(c => c.method === "Runtime.evaluate").at(-1)?.session, "oopif"); s.cdp.dispose();
  });
  it("bounds logs and updates network cursors on completion", async () => {
    const s = setup(); await s.cdp.call("console");
    for (let i = 0; i < 510; i++) s.emit("Runtime.consoleAPICalled", { type: "log", args: [{ value: i }], timestamp: i });
    const logs = await s.cdp.call("console", [{ limit: 500 }]); assert.equal(logs.entries.length, 500); assert.equal(logs.entries[0].args[0], 10);
    s.emit("Network.requestWillBeSent", { requestId: "r", request: { method: "GET", url: "https://test" }, timestamp: 1 });
    const before = await s.cdp.call("network");
    s.emit("Network.responseReceived", { requestId: "r", response: { status: 200 }, type: "Document" });
    s.emit("Network.loadingFinished", { requestId: "r", timestamp: 1.5 });
    const after = await s.cdp.call("network", [{ since: before.cursor }]); assert.equal(after.entries[0].status, 200); assert.equal(after.entries[0].duration, 500); s.cdp.dispose();
  });
  it("cancels in-flight commands and removes listeners on dispose", async () => {
    const s = setup(); await s.cdp.call("console"); s.setHook(method => method === "Runtime.evaluate" ? new Promise(() => {}) : undefined);
    const pending = s.cdp.call("evaluate", ["1"]); await new Promise(resolve => setImmediate(resolve)); s.cdp.dispose();
    await assert.rejects(pending, { code: "CDP_DISPOSED" }); assert.equal(s.debuggerApi.listenerCount("message"), 0); assert.equal(s.guest.listenerCount("destroyed"), 0);
  });
  it("rejects late evaluation results after navigation and crash", async () => {
    const s = setup(); await s.cdp.call("console"); let resolve!: (value: any) => void;
    s.setHook(method => method === "Runtime.evaluate" ? new Promise(r => { resolve = r; }) : undefined);
    const pending = s.cdp.call("evaluate", ["1"]); await new Promise(r => setImmediate(r)); s.emit("Page.frameNavigated", { frame: { id: "main", url: "https://next" } }); resolve({ result: { value: 1 } }); await assert.rejects(pending, { code: "STALE_PAGE" });
    s.guest.emit("render-process-gone"); await assert.rejects(s.cdp.call("console"), { code: "RENDERER_CRASHED" }); s.cdp.dispose();
  });
  it("evaluates app globals in main world and supports object or positional arguments", async () => {
    const s = setup(); await s.cdp.call("evaluate", ["window.app"]);
    assert.equal(s.commands.at(-1)?.params.contextId, 11);
    await s.cdp.call("evaluate", ["value => value.x", { x: 3 }]);
    assert.equal(s.commands.at(-1)?.params.expression, '(value => value.x)(...[{"x":3}])');
    await s.cdp.call("evaluate", ["(a,b) => a+b", [1,2]]);
    assert.equal(s.commands.at(-1)?.params.expression, '((a,b) => a+b)(...[1,2])');
    await s.cdp.call("query", [{ css: "input" }]); assert.equal(s.commands.at(-1)?.params.contextId, 1); s.cdp.dispose();
  });
  it("preserves OOPIF ancestry and dispatches clicks in the child session", async () => {
    const s = setup(); await s.cdp.call("console");
    s.emit("Target.attachedToTarget", { sessionId: "oopif", targetInfo: { type: "iframe", targetId: "child", url: "https://other" } });
    s.emit("Page.frameNavigated", { frame: { id: "child", url: "https://next" } }, "oopif");
    const snapshot = await s.cdp.call("snapshot"); assert.equal(snapshot.frames.find((f: any) => f.id === "child").parentId, "main");
    await s.cdp.call("click", [{ css: "button" }], "child");
    const click = s.commands.find(c => c.method === "Input.dispatchMouseEvent")!;
    assert.equal(click.session, "oopif"); assert.equal(click.params.x, 20); assert.equal(click.params.y, 30); s.cdp.dispose();
  });
  it("aborts a pending command without allowing subsequent input or detaching", async () => {
    const s = setup(); await s.cdp.call("console"); const controller = new AbortController();
    let finish!: (value: any) => void;
    s.setHook(method => method === "Runtime.evaluate" ? new Promise(resolve => { finish = resolve; }) : undefined);
    const pending = s.cdp.call("click", [{ css: "button" }], undefined, controller.signal);
    await new Promise(resolve => setImmediate(resolve)); controller.abort();
    await assert.rejects(pending, { code: "CALL_ABORTED" }); finish({ result: { value: { x: 1, y: 1, rect: [0,0,2,2] } } });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(s.commands.some(c => c.method.startsWith("Input.")), false);
    assert.equal(s.debuggerApi.listenerCount("message"), 1); await s.cdp.call("console"); s.cdp.dispose();
  });
  it("aborts actionability polling and isolates simultaneous call signals", async () => {
    const s = setup(); s.setEvaluation({ error: "NOT_ACTIONABLE" }); const controller = new AbortController();
    const pending = s.cdp.call("click", [{ css: "button" }], undefined, controller.signal);
    await new Promise(resolve => setImmediate(resolve)); controller.abort(); await assert.rejects(pending, { code: "CALL_ABORTED" });
    const count = s.commands.length; await new Promise(resolve => setTimeout(resolve, 70)); assert.equal(s.commands.length, count);
    assert.ok(await s.cdp.call("screenshot")); await assert.rejects(s.cdp.call("screenshot", [], undefined, controller.signal), { code: "CALL_ABORTED" }); s.cdp.dispose();
  });

  it("enables renderer focus emulation on root and OOPIF sessions without native focus", async () => {
    const s = setup(); Object.assign(s.guest, { focus() { assert.fail("Must not steal OS focus"); } });
    await s.cdp.call("fill", [{ css: "input" }, "background"]);
    const root = s.commands.findIndex(c => c.method === "Emulation.setFocusEmulationEnabled" && !c.session);
    assert.ok(root >= 0); assert.deepEqual(s.commands[root].params, { enabled: true });
    assert.ok(root < s.commands.findIndex(c => c.method === "Input.insertText"));
    s.emit("Target.attachedToTarget", { sessionId: "oopif", targetInfo: { type: "iframe", targetId: "child", url: "https://other" } });
    await s.cdp.call("type", [{ css: "input" }, "child-background"], "child");
    assert.deepEqual(s.commands.find(c => c.method === "Emulation.setFocusEmulationEnabled" && c.session === "oopif")?.params, { enabled: true });
    s.cdp.dispose();
  });

  it("never reads the native debugger getter after destruction and disposes twice safely", async () => {
    const s = setup(); await s.cdp.call("console"); let destroyed = true;
    Object.defineProperty(s.guest, "debugger", { get() { if (destroyed) throw new Error("Object has been destroyed"); return s.debuggerApi; } });
    Object.assign(s.guest, { isDestroyed: () => destroyed });
    s.guest.emit("destroyed"); assert.doesNotThrow(() => s.cdp.dispose()); assert.doesNotThrow(() => s.cdp.dispose());
    assert.equal(s.debuggerApi.listenerCount("message"), 0); destroyed = false;
  });
  it("maps same-process child clicks through the scaled root content quad", async () => {
    const s = setup(); await s.cdp.call("click", [{ css: "button" }], "child");
    const click = s.commands.find(c => c.method === "Input.dispatchMouseEvent")!;
    assert.equal(click.params.x, 140); assert.equal(click.params.y, 260); s.cdp.dispose();
  });

});
