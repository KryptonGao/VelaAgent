/// <reference lib="dom" />
import { AsyncLocalStorage } from "node:async_hooks";
import type { WebContents } from "electron";
import type { BrowserAgentAction } from "../../../../packages/shared/src/browser";

export class BrowserCdpError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = "BrowserCdpError"; }
  toJSON() { return { code: this.code, message: this.message }; }
}
type Frame = { id: string; parentId?: string; url: string; session?: string; context?: number };
type Entry = Record<string, any> & { cursor: number; collectedAt: number };

// Runs in an isolated world. References retain node identity, never a selector.
function domOperation(operation: string, query: any, value: any, generation: string): any {
  const w = globalThis as any;
  if (!w.__velaNodes || w.__velaGeneration !== generation) {
    w.__velaNodes = new Map(); w.__velaGeneration = generation; w.__velaNext = 0;
  }
  const nodes: Element[] = [];
  const walk = (root: Document | ShadowRoot) => {
    for (const node of Array.from(root.querySelectorAll("*"))) {
      nodes.push(node); if (node.shadowRoot) walk(node.shadowRoot);
    }
  };
  walk(document);
  const role = (n: Element) => n.getAttribute("role") || ({ BUTTON: "button", A: "link", SELECT: "combobox", TEXTAREA: "textbox" } as any)[n.tagName] || (n.tagName === "INPUT" ? ((n as HTMLInputElement).type === "checkbox" ? "checkbox" : "textbox") : "");
  const name = (n: Element) => n.getAttribute("aria-label") || (n.getAttribute("aria-labelledby") || "").split(/\s+/).map(id => document.getElementById(id)?.textContent || "").join(" ").trim() || (n as HTMLInputElement).labels?.[0]?.textContent?.trim() || n.textContent?.trim() || n.getAttribute("alt") || "";
  const ref = (n: Element) => { for (const [key, node] of w.__velaNodes) if (node === n) return key; const key = `${generation}:${++w.__velaNext}`; w.__velaNodes.set(key, n); return key; };
  if (operation === "snapshot") return { url: location.href, title: document.title, viewport: { width: innerWidth, height: innerHeight }, text: nodes.filter(n => role(n) || n.matches("input,textarea,select,[contenteditable],iframe,h1,h2,h3,p,li,label")).slice(0, 2000).map(n => `[${ref(n)}] ${role(n) || n.tagName.toLowerCase()} ${name(n).slice(0, 300)}`).join("\n") };
  let matches: Element[];
  if (query?.ref) { const n = w.__velaNodes.get(query.ref); if (!n?.isConnected || !query.ref.startsWith(`${generation}:`)) return { error: "STALE_REF" }; matches = [n]; }
  else if (query?.css) matches = nodes.filter(n => n.matches(query.css));
  else if (query?.role) matches = nodes.filter(n => role(n) === query.role && (query.name === undefined || name(n) === query.name));
  else if (typeof query?.text === "string") matches = nodes.filter(n => n.textContent?.trim() === query.text && !Array.from(n.children).some(c => c.textContent?.trim() === query.text));
  else return { error: "INVALID_QUERY" };
  if (matches.length > 1) return { error: "AMBIGUOUS_LOCATOR", count: matches.length };
  if (!matches.length) return { error: "NOT_FOUND" };
  const n = matches[0]!;
  if (operation === "read") return { value: n.matches("input,textarea") ? (n as HTMLInputElement).value : n.textContent || "" };
  if (operation === "query") return { ref: ref(n), role: role(n), name: name(n) };
  n.scrollIntoView({ block: "center", inline: "center" });
  const r = n.getBoundingClientRect(); const style = getComputedStyle(n);
  if (!r.width || !r.height || style.visibility !== "visible" || style.display === "none" || (n as HTMLInputElement).disabled || n.getAttribute("aria-disabled") === "true" || n.closest("[inert]")) return { error: "NOT_ACTIONABLE" };
  const x = r.x + r.width / 2, y = r.y + r.height / 2;
  const hit = n.getRootNode() as Document | ShadowRoot;
  const top = hit.elementFromPoint(x, y);
  if (top && top !== n && !n.contains(top)) return { error: "NOT_ACTIONABLE" };
  if (operation === "focus") {
    if ((value === "fill" || value === "type") && (!(n.matches("input,textarea,[contenteditable]")) || (n as HTMLInputElement).readOnly)) return { error: "NOT_EDITABLE" };
    (n as HTMLElement).focus();
    if (value === "fill" || value === "type") {
      if (n instanceof HTMLInputElement || n instanceof HTMLTextAreaElement) {
        if (value === "fill") n.select();
        else { try { n.setSelectionRange(n.value.length, n.value.length); } catch {} }
      } else {
        const range = document.createRange(); range.selectNodeContents(n);
        if (value === "type") range.collapse(false);
        const selection = getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
      }
    }
  }
  if (operation === "selectOption") {
    if (!(n instanceof HTMLSelectElement)) return { error: "NOT_SELECT" };
    const values = Array.isArray(value) ? value : [value];
    if (values.some(v => !Array.from(n.options).some(o => o.value === v && !o.disabled))) return { error: "INVALID_OPTION" };
    for (const option of Array.from(n.options)) option.selected = values.includes(option.value);
    n.dispatchEvent(new Event("input", { bubbles: true })); n.dispatchEvent(new Event("change", { bubbles: true }));
  }
  return { ref: ref(n), x, y, rect: [r.x, r.y, r.width, r.height] };
}

export class BrowserCdp {
  private ready: Promise<void>;
  private invocation = new AsyncLocalStorage<AbortSignal | undefined>();
  private actionObserver = new AsyncLocalStorage<{ method: string; notify?: (action: BrowserAgentAction) => void }>();
  private checkActive() {
    if (this.dead) throw this.dead;
    if (this.invocation.getStore()?.aborted) throw new BrowserCdpError("CALL_ABORTED", "Browser invocation was cancelled");
  }
  private wait(ms: number): Promise<void> {
    this.checkActive();
    const signal = this.invocation.getStore();
    return new Promise((resolve, reject) => {
      const finish = (error?: Error) => { clearTimeout(timer); signal?.removeEventListener("abort", abort); this.pending.delete(cancel); error ? reject(error) : resolve(); };
      const abort = () => finish(new BrowserCdpError("CALL_ABORTED", "Browser invocation was cancelled"));
      const cancel = (error: Error) => finish(error);
      const timer = setTimeout(() => finish(), ms);
      this.pending.add(cancel); signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
  private dead?: BrowserCdpError;
  private generation = 0;
  private frames = new Map<string, Frame>();
  private logs: Entry[] = [];
  private requests: Entry[] = [];
  private cursor = 0;
  readonly collectedAt = Date.now();
  private pending = new Set<(error: Error) => void>();
  private contexts = new Map<string, number>();
  private attached = false;
  private disposed = false;
  private debuggerApi: WebContents["debugger"];
  private sessionReady = new Map<string, Promise<void>>();
  private mainContexts = new Map<string, { id: number; frameId: string; session?: string }>();
  private contextKey(frameId: string, session?: string) { return JSON.stringify([session || "", frameId]); }
  constructor(private guest: WebContents) {
    this.debuggerApi = guest.debugger;
    guest.on("destroyed", this.destroyed); guest.on("render-process-gone", this.crashed);
    this.debuggerApi.on("detach", this.detached); this.debuggerApi.on("message", this.message);
    this.ready = this.initialize(); this.ready.catch(() => {});
  }
  private fail(code: string, message: string) { if (!this.dead) { this.dead = new BrowserCdpError(code, message); for (const reject of this.pending) reject(this.dead); } }
  private destroyed = () => this.fail("PAGE_DESTROYED", "Browser guest was destroyed");
  private crashed = () => this.fail("RENDERER_CRASHED", "Browser renderer crashed");
  private detached = () => this.fail("CDP_DETACHED", "Browser debugger detached");
  private async send(method: string, params: any = {}, session?: string): Promise<any> {
    this.checkActive();
    const signal = this.invocation.getStore();
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); this.pending.delete(cancel); signal?.removeEventListener("abort", abort); };
      const cancel = (error: Error) => { cleanup(); reject(error); };
      const abort = () => cancel(new BrowserCdpError("CALL_ABORTED", "Browser invocation was cancelled"));
      const timer = setTimeout(() => cancel(new BrowserCdpError("CDP_TIMEOUT", `${method} timed out`)), 10000);
      this.pending.add(cancel); signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      (session ? this.debuggerApi.sendCommand(method, params, session) : this.debuggerApi.sendCommand(method, params)).then(result => {
        try { this.checkActive(); cleanup(); resolve(result); } catch (error) { cancel(error as Error); }
      }, error => cancel(new BrowserCdpError("CDP_ERROR", String(error.message || error))));
    });
  }
  private async enable(session?: string) {
    // Renderer focus emulation keeps CDP keyboard input usable in hidden guests.
    // This deliberately never calls WebContents.focus() or BrowserWindow.focus().
    await this.send("Emulation.setFocusEmulationEnabled", { enabled: true }, session);
    await this.send("Runtime.enable", {}, session); await this.send("Page.enable", {}, session); await this.send("Network.enable", {}, session);
    await this.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, session);
  }
  private async initialize() {
    try {
      if (this.guest.isDestroyed()) throw new BrowserCdpError("PAGE_DESTROYED", "Browser guest was destroyed");
      if (this.debuggerApi.isAttached()) throw new BrowserCdpError("CDP_ALREADY_ATTACHED", "Guest already has a debugger owner");
      this.debuggerApi.attach("1.3"); this.attached = true;
      await this.enable();
      const tree = await this.send("Page.getFrameTree");
      const visit = (t: any) => { this.frames.set(t.frame.id, { ...this.frames.get(t.frame.id), ...t.frame }); for (const child of t.childFrames || []) visit(child); }; visit(tree.frameTree);
    } catch (error) { this.fail(error instanceof BrowserCdpError ? error.code : "CDP_INIT_FAILED", String((error as Error).message)); throw this.dead; }
  }
  private record(list: Entry[], entry: Record<string, any>) { list.push({ ...entry, cursor: ++this.cursor, collectedAt: Date.now() }); if (list.length > 500) list.shift(); }
  private message = (_event: unknown, method: string, p: any, session?: string) => {
    if (this.dead) return;
    session = session || undefined;
    if (method === "Target.attachedToTarget" && p.targetInfo.type === "iframe") {
      const id = p.targetInfo.targetId; this.contexts.delete(id); this.frames.set(id, { ...this.frames.get(id), id, parentId: p.targetInfo.parentFrameId || this.frames.get(id)?.parentId || [...this.frames.values()].find(f => f.session === session && !f.parentId)?.id, url: p.targetInfo.url, session: p.sessionId });
      const ready = this.invocation.run(undefined, () => this.enable(p.sessionId));
      this.sessionReady.set(p.sessionId, ready);
      void ready.catch(() => {});
    } else if (method === "Target.detachedFromTarget") { for (const [id, f] of this.frames) if (f.session === p.sessionId) { this.frames.delete(id); this.contexts.delete(id); this.mainContexts.delete(this.contextKey(id, p.sessionId)); } }
    else if (method === "Page.frameAttached") {
      this.frames.set(p.frameId, { url: "", ...this.frames.get(p.frameId), id: p.frameId, parentId: p.parentFrameId, session });
    }
    else if (method === "Page.frameNavigated") {
      this.generation++; this.contexts.delete(p.frame.id);
      const previous = this.frames.get(p.frame.id);
      this.mainContexts.delete(this.contextKey(p.frame.id, session));
      this.frames.set(p.frame.id, { ...previous, ...p.frame, parentId: p.frame.parentId ?? previous?.parentId, session: session ?? previous?.session });
    }
    else if (method === "Page.frameDetached") { this.frames.delete(p.frameId); this.contexts.delete(p.frameId); this.mainContexts.delete(this.contextKey(p.frameId, session)); this.generation++; }
    else if (method === "Runtime.executionContextCreated") {
      const context = p.context; const aux = context.auxData;
      if (aux?.isDefault && aux.frameId) this.mainContexts.set(this.contextKey(aux.frameId, session), { id: context.id, frameId: aux.frameId, session });
    }
    else if (method === "Runtime.executionContextDestroyed") {
      for (const [key, context] of this.mainContexts) if (context.session === session && context.id === p.executionContextId) this.mainContexts.delete(key);
    }
    else if (method === "Runtime.executionContextsCleared") {
      this.generation++;
      for (const f of this.frames.values()) if (f.session === session) this.contexts.delete(f.id);
      for (const [key, context] of this.mainContexts) if (context.session === session) this.mainContexts.delete(key);
    }
    else if (method === "Runtime.consoleAPICalled") this.record(this.logs, { type: p.type, args: p.args.map((a: any) => a.value ?? a.description), timestamp: p.timestamp, session });
    else if (method === "Runtime.exceptionThrown") this.record(this.logs, { type: "exception", message: p.exceptionDetails.exception?.description || p.exceptionDetails.text, timestamp: p.timestamp, session });
    else if (method === "Network.requestWillBeSent") this.record(this.requests, { requestId: p.requestId, session, method: p.request.method, url: p.request.url, type: p.type, startedAt: p.timestamp });
    else if (method.startsWith("Network.")) {
      const row = [...this.requests].reverse().find(r => r.requestId === p.requestId && r.session === session);
      if (!row) return;
      if (method === "Network.responseReceived") Object.assign(row, { status: p.response.status, type: p.type });
      if (method === "Network.loadingFinished" || method === "Network.loadingFailed") Object.assign(row, { duration: (p.timestamp - row.startedAt) * 1000, failure: p.errorText });
      row.cursor = ++this.cursor; row.collectedAt = Date.now();
    }
  };
  private frame(id?: string): Frame {
    const frame = id ? this.frames.get(id) : [...this.frames.values()].find(f => !f.parentId && !f.session);
    if (!frame) throw new BrowserCdpError("FRAME_NOT_FOUND", `Frame ${id || "main"} is unavailable`); return frame;
  }
  private async evaluate(expression: string, frame: Frame, mainWorld = false) {
    const generation = this.generation;
    let context = mainWorld ? this.mainContexts.get(this.contextKey(frame.id, frame.session))?.id : this.contexts.get(frame.id);
    if (mainWorld && !context) {
      const deadline = Date.now() + 3000;
      while (!context && Date.now() < deadline) {
        if (this.dead) throw this.dead;
        if (generation !== this.generation) throw new BrowserCdpError("STALE_PAGE", "Page changed while waiting for main world");
        await this.wait(25);
        context = this.mainContexts.get(this.contextKey(frame.id, frame.session))?.id;
      }
      if (!context) throw new BrowserCdpError("CONTEXT_UNAVAILABLE", "Page main-world context is unavailable");
    }
    if (!context) { const result = await this.send("Page.createIsolatedWorld", { frameId: frame.id, worldName: "vela-browser" }, frame.session); context = result.executionContextId; this.contexts.set(frame.id, context!); }
    const result = await this.send("Runtime.evaluate", { expression, contextId: context, returnByValue: true, awaitPromise: true }, frame.session);
    if (generation !== this.generation) throw new BrowserCdpError("STALE_PAGE", "Page changed during evaluation");
    if (result.exceptionDetails) throw new BrowserCdpError("EVALUATION_FAILED", result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
  private dom(op: string, query: any, value: any, frame: Frame) { return this.evaluate(`(${domOperation.toString()})(${JSON.stringify(op)},${JSON.stringify(query ?? null)},${JSON.stringify(value ?? null)},${JSON.stringify(`${frame.id}:${this.generation}`)})`, frame); }
  private async locate(op: string, query: any, value: any, frame: Frame) {
    const generation = this.generation; const deadline = Date.now() + 3000; let previous = "";
    while (true) {
      if (generation !== this.generation) throw new BrowserCdpError("STALE_PAGE", "Page navigated during operation");
      const result = await this.dom(op === "query" ? op : "check", query, null, frame);
      if (result.error && !["NOT_FOUND", "NOT_ACTIONABLE"].includes(result.error)) throw new BrowserCdpError(result.error, `Locator failed: ${result.error}`);
      const rect = JSON.stringify(result.rect);
      if (!result.error && (op === "query" || rect === previous)) return op === "focus" || op === "selectOption" ? this.dom(op, { ref: result.ref }, value, frame) : result;
      if (Date.now() >= deadline) throw new BrowserCdpError("ACTION_TIMEOUT", `Locator did not become actionable (${result.error || "unstable layout"})`);
      previous = rect; await this.wait(50); this.checkActive();
    }
  }
  async call(method: string, args: any[] = [], frameId?: string, signal?: AbortSignal, onAction?: (action: BrowserAgentAction) => void): Promise<any> {
    return this.actionObserver.run({ method, notify: onAction }, () => this.invocation.run(signal, async () => {
      this.checkActive();
      await this.awaitReady(this.ready);
      this.checkActive();
      return this.callActive(method, args, frameId);
    }));
  }
  private async reportAction(point: { x: number; y: number }, frame: Frame): Promise<void> {
    const observer = this.actionObserver.getStore();
    if (!observer?.notify) return;
    const generation = this.generation;
    try {
      let { x, y } = point;
      let child = frame;
      // Each content quad is relative to its parent's target-session root.
      // This also lifts OOPIF coordinates, while input still uses its own session.
      while (child.parentId) {
        const parent = this.frame(child.parentId);
        const viewport = await this.evaluate("({width: innerWidth, height: innerHeight})", child);
        const owner = await this.send("DOM.getFrameOwner", { frameId: child.id }, parent.session);
        const box = await this.send("DOM.getBoxModel", { backendNodeId: owner.backendNodeId }, parent.session);
        const q = box.model.content;
        if (!(viewport.width > 0 && viewport.height > 0) || q.length !== 8) return;
        if (Math.abs(q[0] + q[4] - q[2] - q[6]) > 0.5 || Math.abs(q[1] + q[5] - q[3] - q[7]) > 0.5) return;
        const u = x / viewport.width, v = y / viewport.height;
        x = q[0] + u * (q[2] - q[0]) + v * (q[6] - q[0]);
        y = q[1] + u * (q[3] - q[1]) + v * (q[7] - q[1]);
        child = parent;
        while (child.parentId && this.frame(child.parentId).session === child.session) child = this.frame(child.parentId);
      }
      const viewport = await this.evaluate("({width: innerWidth, height: innerHeight})", this.frame());
      this.checkActive();
      if (generation !== this.generation) return;
      const kind = ({ fill: "type", type: "type", selectOption: "select" } as const)[observer.method as 'fill' | 'type' | 'selectOption'] || observer.method;
      observer.notify({ x, y, viewportWidth: viewport.width, viewportHeight: viewport.height, kind: kind as BrowserAgentAction['kind'] });
    } catch {
      // Optional visual telemetry must never prevent the underlying input.
      this.checkActive();
    }
  }
  private awaitReady(ready: Promise<void>): Promise<void> {
    this.checkActive();
    const signal = this.invocation.getStore();
    return new Promise((resolve, reject) => {
      const cleanup = () => { signal?.removeEventListener("abort", abort); this.pending.delete(cancel); };
      const cancel = (error: Error) => { cleanup(); reject(error); };
      const abort = () => cancel(new BrowserCdpError("CALL_ABORTED", "Browser invocation was cancelled"));
      this.pending.add(cancel); signal?.addEventListener("abort", abort, { once: true });
      ready.then(() => { cleanup(); resolve(); }, cancel);
      if (signal?.aborted) abort();
    });
  }
  private async callActive(method: string, args: any[], frameId?: string): Promise<any> {
    this.checkActive();
    if (method === "console" || method === "network") { const options = args[0] || {}; const list = method === "console" ? this.logs : this.requests; return { collectedAt: this.collectedAt, cursor: this.cursor, entries: list.filter(e => e.cursor > (options.since || 0)).slice(-Math.max(1, Math.min(500, options.limit || 100))).map(e => ({ ...e })) }; }
    if (method === "screenshot") { const { data } = await this.send("Page.captureScreenshot", { format: "png", fromSurface: true }); const bytes = Buffer.from(data, "base64"); if (bytes.length < 24 || bytes.toString("hex", 0, 8) !== "89504e470d0a1a0a") throw new BrowserCdpError("INVALID_SCREENSHOT", "CDP returned invalid PNG"); return { data, mimeType: "image/png", width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }; }
    const frame = this.frame(frameId);
    if (frame.session) { const ready = this.sessionReady.get(frame.session); if (ready) await this.awaitReady(ready); this.checkActive(); }
    if (method === "snapshot") {
      const tree = await this.send("Page.getFrameTree");
      const visit = (t: any) => { this.frames.set(t.frame.id, { ...this.frames.get(t.frame.id), ...t.frame }); for (const child of t.childFrames || []) visit(child); }; visit(tree.frameTree);
    }
    if (method === "snapshot") return { ...await this.dom(method, null, null, frame), generation: this.generation, frameId: frame.id, frames: [...this.frames.values()].map(({ id, parentId, url }) => ({ id, parentId, url })) };
    if (method === "evaluate") { if (typeof args[0] !== "string") throw new BrowserCdpError("INVALID_ARGUMENT", "evaluate requires an expression"); return this.evaluate(args.length > 1 ? `(${args[0]})(...${JSON.stringify(Array.isArray(args[1]) ? args[1] : [args[1]])})` : args[0], frame, true); }
    if (method === "query") return this.locate(method, args[0], null, frame);
    if (method === "scroll") {
      if (this.actionObserver.getStore()?.notify) {
        const viewport = await this.evaluate("({width: innerWidth, height: innerHeight})", frame);
        await this.reportAction({ x: viewport.width / 2, y: viewport.height / 2 }, frame);
      }
      return this.evaluate(`window.scrollBy(${JSON.stringify(Number(args[0]?.x) || 0)},${JSON.stringify(Number(args[0]?.y) || 0)})`, frame);
    }
    if (method === "press") {
      if (args[0]) {
        const result = await this.locate("focus", args[0], null, frame);
        if (result.error) throw new BrowserCdpError(result.error, "Cannot focus locator");
        await this.reportAction(result, frame);
      } else if (this.actionObserver.getStore()?.notify) {
        const point = await this.evaluate("(() => { let n = document.activeElement; while(n?.shadowRoot?.activeElement) n = n.shadowRoot.activeElement; const r = n?.getBoundingClientRect(); return { x: r?.width ? r.x + r.width / 2 : innerWidth / 2, y: r?.height ? r.y + r.height / 2 : innerHeight / 2 }; })()", frame);
        await this.reportAction(point, frame);
      }
      return this.press(args[1], frame.session);
    }
    if (method === "click") {
      const point = await this.locate(method, args[0], null, frame);
      await this.reportAction(point, frame);

      // Same-process child coordinates are local; lift them through frame owners.
      let x = point.x, y = point.y, child = frame;
      while (!frame.session && child.parentId) {
        const parent = this.frame(child.parentId);
        const viewport = await this.evaluate("({width: innerWidth, height: innerHeight})", child);
        const owner = await this.send("DOM.getFrameOwner", { frameId: child.id }, parent.session);
        const box = await this.send("DOM.getBoxModel", { backendNodeId: owner.backendNodeId }, parent.session);
        const q = box.model.content;
        if (!(viewport.width > 0 && viewport.height > 0) || q.length !== 8) throw new BrowserCdpError("INVALID_FRAME_GEOMETRY", "Frame geometry unavailable");
        // Content quad maps CSS scale, rotation and skew. Reject perspective rather than misclick.
        if (Math.abs(q[0] + q[4] - q[2] - q[6]) > 0.5 || Math.abs(q[1] + q[5] - q[3] - q[7]) > 0.5) throw new BrowserCdpError("UNSUPPORTED_FRAME_TRANSFORM", "Perspective iframe transforms are unsupported");
        const u = x / viewport.width, v = y / viewport.height;
        x = q[0] + u * (q[2] - q[0]) + v * (q[6] - q[0]);
        y = q[1] + u * (q[3] - q[1]) + v * (q[7] - q[1]);
        // CDP quads are relative to the root of the target session, including same-process ancestors.
        if (!parent.session) break;
        child = parent;
        while (child.parentId && this.frame(child.parentId).session === child.session) child = this.frame(child.parentId);
      }
      await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, frame.session); await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, frame.session); return;
    }
    if (method === "fill" || method === "type") {
      await this.send("Emulation.setFocusEmulationEnabled", { enabled: true }, frame.session);
      await this.callActive("click", [args[0]], frame.id);
      const located = await this.locate("focus", args[0], method, frame);
      if (located.error) throw new BrowserCdpError(located.error, "Cannot edit locator");
      const query = { ref: located.ref };
      const before = await this.dom("read", query, null, frame);
      const text = String(args[1]);
      const expected = method === "fill" ? text : before.value + text;
      for (let attempt = 0; attempt < 3; attempt++) {
        this.checkActive();
        const focused = await this.dom("focus", query, method, frame);
        if (focused.error) throw new BrowserCdpError(focused.error, "Input node is unavailable");
        if (method === "fill" && !text) await this.press("Backspace", frame.session);
        else await this.send("Input.insertText", { text }, frame.session);
        await this.wait(50);
        const actual = await this.dom("read", query, null, frame);
        if (actual.error) throw new BrowserCdpError(actual.error, "Input node is unavailable");
        if (actual.value === expected) return;
        if (method === "type" && actual.value !== before.value) break;
        // Hidden renderer widgets can acknowledge their first input before focus is ready.
        await this.callActive("click", [query], frame.id);
      }
      throw new BrowserCdpError("INPUT_FAILED", "Chromium did not apply the requested text input");
    }
    if (method === "selectOption") { const result = await this.locate(method, args[0], args[1], frame); if (result.error) throw new BrowserCdpError(result.error, "Cannot select option"); await this.reportAction(result, frame); return; }
    throw new BrowserCdpError("UNSUPPORTED_METHOD", `Unsupported browser method: ${method}`);
  }
  private async press(key: string, session?: string) {
    if (typeof key !== "string") throw new BrowserCdpError("INVALID_ARGUMENT", "press requires a key");
    const parts = key.split("+"); const name = parts.pop()!; let modifiers = 0;
    for (const part of parts) { const flag = ({ Alt: 1, Control: 2, Meta: 4, Shift: 8, ControlOrMeta: process.platform === "darwin" ? 4 : 2 } as any)[part]; if (!flag) throw new BrowserCdpError("INVALID_KEY", `Unknown modifier ${part}`); modifiers |= flag; }
    const codes: Record<string, number> = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35, Space: 32 };
    const code = codes[name] || (name.length === 1 ? name.toUpperCase().charCodeAt(0) : 0);
    if (!code) throw new BrowserCdpError("INVALID_KEY", `Unsupported key ${name}`);
    const commands = (name.toLowerCase() === "a" && (modifiers & (process.platform === "darwin" ? 4 : 2))) ? ["selectAll"] : name === "Backspace" ? ["deleteBackward"] : undefined;
    const params = { key: name === "Space" ? " " : name, modifiers, windowsVirtualKeyCode: code };
    await this.send("Input.dispatchKeyEvent", { ...params, type: "keyDown", ...(commands ? { commands } : {}), ...(!modifiers && (name.length === 1 || name === "Enter" || name === "Space") ? { text: name === "Enter" ? "\r" : name === "Space" ? " " : name } : {}) }, session);
    await this.send("Input.dispatchKeyEvent", { ...params, type: "keyUp" }, session);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.fail("CDP_DISPOSED", "Browser automation disposed");
    this.guest.removeListener("destroyed", this.destroyed); this.guest.removeListener("render-process-gone", this.crashed);
    this.debuggerApi.removeListener("message", this.message); this.debuggerApi.removeListener("detach", this.detached);
    const owned = this.attached;
    this.attached = false;
    try {
      if (owned && !this.guest.isDestroyed() && this.debuggerApi.isAttached()) this.debuggerApi.detach();
    } catch { /* guest destruction may race debugger teardown */ }
    this.frames.clear(); this.contexts.clear(); this.mainContexts.clear(); this.sessionReady.clear(); this.logs = []; this.requests = [];
  }
}
