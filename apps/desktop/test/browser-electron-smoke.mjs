/** Run after building: node_modules/.bin/electron apps/desktop/test/browser-electron-smoke.mjs */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, session, webContents } from "electron";

const temporary = mkdtempSync(join(tmpdir(), "vela-browser-smoke-"));
const electronData = join(temporary, "electron");
const velaData = join(temporary, "vela");
mkdirSync(electronData); mkdirSync(velaData);
app.setPath("userData", electronData);
process.env.VELA_USER_DATA = velaData;
process.env.VELA_CWD = temporary;
delete process.env.ELECTRON_RENDERER_URL;
delete process.env.VELA_CAPTURE;
writeFileSync(join(velaData, "ui-state.json"), JSON.stringify({
  "vela.onboarding.complete": "true", "vela.appearance": "light", "vela.locale": "en",
}));
const requests = new Map();
const server = createServer((request, response) => {
  const path = request.url;
  requests.set(path, (requests.get(path) ?? 0) + 1);
  if (path === "/fail") { request.socket.destroy(); return; }
  if (path === "/redirect") { response.writeHead(302, { Location: "/two" }); response.end(); return; }
  response.writeHead(200, { "Content-Type": "text/html" });
  const page = `<!doctype html><title>${path === "/two" ? "Page Two" : "Page One"}</title>
    <style>body{font:16px system-ui;padding:24px;background:#f9fafb;color:#202124}main{height:2400px}</style>
    <h1>Vela browser fixture</h1><input id="saved" value="original">
    <a id="popup" href="/two" target="_blank">Open Page Two</a><main>Scroll state fixture</main>`;
  if (path === "/slow") setTimeout(() => { if (!response.destroyed) response.end(page); }, 800);
  else response.end(page);
});
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, message) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) { if (await check()) return; await pause(50); }
  throw new Error(`Timed out: ${message}`);
}
const watchdog = setTimeout(() => { console.error("Browser smoke timed out"); app.exit(1); }, 60000);
async function run() {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await import(process.env.VELA_BROWSER_SMOKE_APP_PATH ?? "../out/main/index.mjs");
    await until(() => BrowserWindow.getAllWindows().length > 0, "application window");
    const win = BrowserWindow.getAllWindows()[0];
    win.webContents.on("console-message", (event) => {
      if (event.level === "error") console.error(`Renderer: ${event.message}`);
    });
    const evaluate = async (code) => {
      try { return await win.webContents.executeJavaScript(code); }
      catch (error) { throw new Error(`Renderer expression failed: ${code}`, { cause: error }); }
    };
    await until(() => evaluate("!!document.querySelector('[aria-label=\"New tab\"]')"), "main renderer");
    await evaluate("document.querySelector('[aria-label=\"New tab\"]').click()");
    await until(() => evaluate("!!document.querySelector('.start-option')"), "start tab");
    await evaluate("Array.from(document.querySelectorAll('.start-option')).find(n => n.textContent.includes('Browser')).click()");
    await until(() => webContents.getAllWebContents().some((item) => item.getType() === "webview"), "webview attachment");
    const guest = webContents.getAllWebContents().find((item) => item.getType() === "webview");
    await until(() => evaluate("document.querySelector('[aria-label=\"Reload\"]')?.disabled === false"), "guest ready");
    const navigate = async (path) => {
      await evaluate(`(() => {
        const input = document.querySelector('.workbench-tabpanel:not(.is-inactive) .browser-address');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(base + path)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await pause(20);
      await evaluate("document.querySelector('.workbench-tabpanel:not(.is-inactive) .browser-address-form').requestSubmit()");
    };
    const loaded = async (path, title) => {
      await until(() => evaluate(`(() => {
        const panel = document.querySelector('.workbench-tabpanel:not(.is-inactive)');
        return panel.querySelector('.browser-address')?.value === ${JSON.stringify(base + path)} &&
          panel.querySelector('.browser-page-title')?.textContent === ${JSON.stringify(title)} &&
          panel.querySelector('.browser-load-status')?.textContent === 'Loaded';
      })()`), `load ${path}`);
    };
    await navigate("/one"); await loaded("/one", "Page One");
    assert.deepEqual(await guest.executeJavaScript("({node:typeof require,api:typeof window.vela})"), { node: "undefined", api: "undefined" });
    const preferences = guest.getLastWebPreferences();
    assert.equal(preferences.sandbox, true); assert.equal(preferences.contextIsolation, true);
    assert.equal(preferences.nodeIntegration, false); assert.equal(preferences.preload, undefined);
    assert.equal(guest.session, session.fromPartition("persist:vela-ui-browser"));
    assert.notEqual(guest.session, win.webContents.session);
    console.log("PASS real guest navigation, address/title/loading synchronization and isolation");

    // Feed real CDP action coordinates through the product's normal state projection.
    // No model credentials are needed, and page screenshots remain overlay-free.
    const require = createRequire(new URL('../package.json', import.meta.url));
    const adapterPath = join(temporary, 'browser-cdp.mjs');
    await require('esbuild').build({ entryPoints: [fileURLToPath(new URL('../src/main/browser-cdp.ts', import.meta.url))],
      outfile: adapterPath, bundle: true, platform: 'node', format: 'esm', target: 'node22', external: ['electron'] });
    const { BrowserCdp } = await import(adapterPath);
    const adapter = new BrowserCdp(guest);
    let cursorState = await evaluate("window.vela.browser.command({type:'state'})");
    const cursorTab = cursorState.tabs.find(tab => tab.url === base + '/one');
    let cursorSequence = 0;
    const notify = action => {
      cursorTab.agentCursor = { ...action, sequence: ++cursorSequence };
      win.webContents.send('browser:state', cursorState);
    };
    try {
      assert.equal(cursorTab.agentCursor, undefined, 'manual browsing has no Agent cursor state');
      assert.equal(await evaluate("!!document.querySelector('.browser-agent-pointer')"), false, 'manual browsing has no Agent pointer');
      await adapter.call('click', [{ css: '#saved' }], undefined, undefined, notify);
      await until(() => evaluate("!!document.querySelector('.browser-agent-pointer.is-click')"), 'Agent click pointer');
      await evaluate("window.__cursorPointer=document.querySelector('.browser-agent-pointer');true");
      await pause(360);
      assert.equal(await evaluate("document.querySelector('.browser-agent-pointer')===window.__cursorPointer"), true);
      const pointer = await evaluate("(() => { const n=document.querySelector('.browser-agent-pointer'), f=n.closest('.browser-guest-frame'), p=n.getBoundingClientRect(), r=f.getBoundingClientRect(); return {x:p.left-r.left,y:p.top-r.top,label:n.textContent,passthrough:getComputedStyle(n.closest('.browser-agent-overlay')).pointerEvents,under:document.elementFromPoint(p.left,p.top)?.tagName}; })()");
      assert.ok(Math.abs(pointer.x - cursorTab.agentCursor.x) < 2); assert.ok(Math.abs(pointer.y - cursorTab.agentCursor.y) < 2);
      assert.equal(pointer.label, ''); assert.equal(pointer.passthrough, 'none'); assert.equal(pointer.under, 'WEBVIEW');
      assert.equal(await guest.executeJavaScript("!!document.querySelector('.browser-agent-pointer')"), false);
      if (process.env.VELA_BROWSER_CURSOR_CAPTURE_DIR) {
        mkdirSync(process.env.VELA_BROWSER_CURSOR_CAPTURE_DIR, { recursive: true });
        writeFileSync(join(process.env.VELA_BROWSER_CURSOR_CAPTURE_DIR, 'agent-cursor-light.png'), (await win.webContents.capturePage()).toPNG());
        await evaluate("document.documentElement.dataset.scheme='dark'"); await pause(100);
        writeFileSync(join(process.env.VELA_BROWSER_CURSOR_CAPTURE_DIR, 'agent-cursor-dark.png'), (await win.webContents.capturePage()).toPNG());
        await evaluate("document.documentElement.dataset.scheme='light'");
      }
      cursorTab.agentCursor = { ...cursorTab.agentCursor, active: false }; win.webContents.send('browser:state', cursorState);
      await pause(2000);
      assert.equal(await evaluate("document.querySelector('.browser-agent-pointer')===window.__cursorPointer && window.__cursorPointer.textContent===''"), true);
      await adapter.call('type', [{ css: '#saved' }, '-agent'], undefined, undefined, notify);
      await until(() => evaluate("!!document.querySelector('.browser-agent-pointer.is-type')"), 'Agent typing pointer');
      assert.equal(await guest.executeJavaScript("document.querySelector('#saved').value"), 'original-agent');
      await adapter.call('scroll', [{ y: 120 }], undefined, undefined, notify);
      await until(() => evaluate("!!document.querySelector('.browser-agent-pointer.is-scroll')"), 'Agent scroll pointer');
      assert.equal(await evaluate("document.querySelector('.browser-agent-pointer')===window.__cursorPointer"), true);
      await pause(360);
      assert.equal(await evaluate("document.querySelector('.browser-agent-pointer').textContent"), '');
      win.webContents.debugger.attach('1.3');
      try {
        await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
        assert.ok(Number.parseFloat(await evaluate("getComputedStyle(document.querySelector('.browser-agent-pointer')).transitionDuration")) <= .0001);
        assert.equal(await evaluate("getComputedStyle(document.querySelector('.browser-agent-feedback')).animationName"), 'none');
      } finally { win.webContents.debugger.detach(); }
      // Stopping removes action feedback while preserving the cursor and guest.
      cursorTab.agentCursor = { ...cursorTab.agentCursor, active: false }; win.webContents.send('browser:state', cursorState);
      await until(() => evaluate("!!document.querySelector('.browser-agent-pointer.is-idle')"), 'Agent pointer returns to idle');
      assert.equal(await evaluate("document.querySelector('.browser-agent-pointer')===window.__cursorPointer && !document.querySelector('.browser-agent-feedback')"), true);
      assert.equal(guest.isDestroyed(), false);
    } finally { adapter.dispose(); }
    console.log("PASS persistent Agent pointer, smooth movement, click/type/scroll feedback, input passthrough, reduced motion and stop retention");

    await guest.executeJavaScript("document.querySelector('#saved').value='preserved';window.fixtureMarker=42;scrollTo(0,350)");
    const originalScroll = await guest.executeJavaScript("scrollY");
    const originalViewport = await guest.executeJavaScript("({width:innerWidth,height:innerHeight})");
    const originalRequests = requests.get("/one");
    await evaluate("document.querySelector('.workbench-new-tab').click()");
    await pause(200);
    assert.equal(guest.isDestroyed(), false);
    await evaluate("Array.from(document.querySelectorAll('.workbench-tab')).find(n => n.textContent.includes('Page One')).click()");
    await pause(200);
    await evaluate("document.querySelector('.workbench-collapse').click()");
    await until(() => evaluate("document.querySelector('.workbench-panel').getBoundingClientRect().width === 0"), "fully hidden workbench");
    assert.equal(await evaluate("document.querySelector('.workbench-panel').inert"), true);
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.main-chat-view')).getPropertyValue('--paper-right-radius').trim() === '0px'"), false);
    assert.equal(guest.isDestroyed(), false);
    assert.deepEqual(await guest.executeJavaScript("({width:innerWidth,height:innerHeight})"), originalViewport);
    await evaluate("document.querySelector('[aria-label=\"Expand workbench\"]').click()"); await pause(500);
    assert.deepEqual(await guest.executeJavaScript("({value:document.querySelector('#saved').value,marker:window.fixtureMarker,scroll:scrollY})"),
      { value: "preserved", marker: 42, scroll: originalScroll });
    assert.equal(requests.get("/one"), originalRequests);
    console.log("PASS switch/fold/expand retains the same guest, page state and scroll without reloading");

    await evaluate("document.querySelector('.sidebar-user-pill').click()"); await pause(650);
    assert.equal(guest.isDestroyed(), false);
    assert.equal(await evaluate("Array.from(document.querySelectorAll('.browser-guest-frame')).every(n => n.inert)"), true);
    await evaluate("document.querySelector('.sidebar-user-pill').click()"); await pause(500);
    assert.equal(await guest.executeJavaScript("window.fixtureMarker"), 42);
    assert.equal(requests.get("/one"), originalRequests);
    console.log("PASS opening/closing Settings retains the guest and excludes hidden controls");

    const originalConversationId = (await evaluate("window.vela.getState()")).activeConversationId;
    await guest.executeJavaScript("document.cookie='manualLogin=present; path=/';localStorage.setItem('loginFixture','present')");
    const anotherConversation = await evaluate("window.vela.createConversation()");
    await until(() => evaluate("!Array.from(document.querySelectorAll('.workbench-tab')).some(n => n.textContent.includes('Page One'))"), "conversation-owned tab bar");
    assert.equal(guest.isDestroyed(), false);
    assert.equal(await guest.executeJavaScript("window.fixtureMarker"), 42);
    await evaluate("document.querySelector('.workbench-new-tab').click()");
    await until(() => evaluate("!!document.querySelector('.start-option')"), "new conversation start tab");
    await evaluate("Array.from(document.querySelectorAll('.start-option')).find(n => n.textContent.includes('Browser')).click()");
    await until(() => webContents.getAllWebContents().filter(item => item.getType() === 'webview').length === 2, "other conversation guest");
    const conversationGuest = webContents.getAllWebContents().find(item => item.getType() === 'webview' && item.id !== guest.id);
    await until(() => evaluate("document.querySelector('.workbench-tabpanel:not(.is-inactive) [aria-label=\"Reload\"]')?.disabled === false"), "other conversation guest ready");
    await navigate("/two"); await loaded("/two", "Page Two");
    assert.equal(await conversationGuest.executeJavaScript("document.cookie.includes('manualLogin=present') && localStorage.getItem('loginFixture') === 'present'"), true);
    await evaluate(`window.vela.switchConversation(${JSON.stringify(originalConversationId)})`);
    await loaded("/one", "Page One");
    assert.equal(conversationGuest.isDestroyed(), false);
    assert.equal(await guest.executeJavaScript("window.fixtureMarker"), 42);
    assert.equal(requests.get("/one"), originalRequests);
    await evaluate(`window.vela.switchConversation(${JSON.stringify(anotherConversation.activeConversationId)})`);
    await loaded("/two", "Page Two");
    await evaluate("(() => { const tabs=Array.from(document.querySelectorAll('.workbench-tab')); document.querySelectorAll('.workbench-tab-close')[tabs.findIndex(n=>n.getAttribute('aria-selected')==='true')].click(); })()");
    await until(() => conversationGuest.isDestroyed(), "other conversation guest close");
    await evaluate(`window.vela.switchConversation(${JSON.stringify(originalConversationId)})`);
    await loaded("/one", "Page One");
    console.log("PASS conversation tab isolation, empty-conversation retention and shared manual login storage");

    await navigate("/redirect"); await loaded("/two", "Page Two");
    await evaluate("document.querySelector('[aria-label=\"Back\"]').click()"); await loaded("/one", "Page One");
    await evaluate("document.querySelector('[aria-label=\"Forward\"]').click()"); await loaded("/two", "Page Two");
    const reloadRequests = requests.get("/two");
    await evaluate("document.querySelector('[aria-label=\"Reload\"]').click()");
    await until(() => requests.get("/two") > reloadRequests, "reload request"); await loaded("/two", "Page Two");
    await guest.executeJavaScript("history.pushState({},'', '/spa');document.title='SPA title'");
    await loaded("/spa", "SPA title");
    await guest.executeJavaScript("document.querySelector('#popup').click()", true);
    await until(() => BrowserWindow.getAllWindows().some(w => w !== win && w.webContents.getURL() === base + "/two"), "separate popup");
    const popup = BrowserWindow.getAllWindows().find(w => w !== win);
    assert.equal(popup.webContents.session, guest.session);
    await loaded("/spa", "SPA title");
    popup.destroy();
    await navigate("/two"); await loaded("/two", "Page Two");
    console.log("PASS redirects, back/forward, reload, SPA navigation and popup links");

    await navigate("/slow");
    await until(() => evaluate("document.querySelector('.browser-load-status').textContent === 'Loading…'"), "loading indicator");
    await evaluate("document.querySelector('[aria-label=\"Stop loading\"]').click()");
    await until(() => evaluate("document.querySelector('.browser-load-status').textContent !== 'Loading…'"), "stop load");
    assert.equal(await evaluate("!!document.querySelector('.browser-error')"), false);
    await navigate("/fail");
    await until(() => evaluate("!!document.querySelector('.browser-error') && document.querySelector('.browser-load-status').textContent === 'Load failed'"), "load failure feedback");
    await navigate("/one"); await loaded("/one", "Page One");
    for (const scheme of ["light", "dark"]) {
      await evaluate(`document.documentElement.dataset.scheme=${JSON.stringify(scheme)};document.documentElement.dataset.theme=${JSON.stringify(scheme === "light" ? "daylight" : "midnight")}`);
      await pause(100);
      writeFileSync(join(temporary, `browser-${scheme}.png`), (await win.webContents.capturePage()).toPNG());
    }
    if (process.env.VELA_BROWSER_SMOKE_CAPTURE_DIR) {
      const { copyFileSync } = await import("node:fs");
      mkdirSync(process.env.VELA_BROWSER_SMOKE_CAPTURE_DIR, { recursive: true });
      for (const scheme of ["light", "dark"]) copyFileSync(join(temporary, `browser-${scheme}.png`), join(process.env.VELA_BROWSER_SMOKE_CAPTURE_DIR, `browser-${scheme}.png`));
    }
    await evaluate("Array.from(document.querySelectorAll('.workbench-tab')).find(n => n.textContent.includes('New tab')).click()");
    await pause(200);
    await evaluate("Array.from(document.querySelectorAll('.start-option')).find(n => n.textContent.includes('Browser')).click()");
    await until(() => webContents.getAllWebContents().filter((item) => item.getType() === "webview").length === 2, "second browser tab");
    const secondGuest = webContents.getAllWebContents().find((item) => item.getType() === "webview" && item.id !== guest.id);
    await until(() => evaluate("document.querySelector('.workbench-tabpanel:not(.is-inactive) [aria-label=\"Reload\"]')?.disabled === false"), "second guest ready");
    await navigate("/two"); await loaded("/two", "Page Two");
    assert.equal(guest.getURL(), base + "/one");
    const closeActive = () => evaluate(`(() => {
      const tabs = Array.from(document.querySelectorAll('.workbench-tab'));
      document.querySelectorAll('.workbench-tab-close')[tabs.findIndex(tab => tab.getAttribute('aria-selected') === 'true')].click();
    })()`);
    await closeActive(); await until(() => secondGuest.isDestroyed(), "second guest closed");
    assert.equal(guest.isDestroyed(), false); await loaded("/one", "Page One");
    console.log("PASS multiple browser tabs keep independent guests and close independently");
    await closeActive();
    await until(() => guest.isDestroyed(), "closed guest destroyed");
    console.log("PASS stop loading, failure/recovery and explicit close releases the guest");

    // Fixture stream events exercise the real conversation Markdown without a model/network call.
    const conversation = await evaluate("window.vela.createConversation()");
    await pause(150);
    const publishLinks = (conversationId) => {
      win.webContents.send("session:event", { type: "user_message", conversationId, text: "Browser link fixture" });
      win.webContents.send("session:event", { type: "text_delta", conversationId,
        delta: `[First page](${base}/one) and [Second page](${base}/two).` });
    };
    publishLinks(conversation.activeConversationId);
    await until(() => evaluate("!!document.querySelector('.chat-scroll-area a')"), "conversation links rendered");
    assert.equal(webContents.getAllWebContents().filter((item) => item.getType() === "webview").length, 0);
    const external = [];
    // Observe native target=_blank requests without launching the user's system browser in this test.
    win.webContents.setWindowOpenHandler(({ url }) => { external.push(url); return { action: "deny" }; });
    await evaluate("document.querySelector('.chat-scroll-area a').click()");
    await loaded("/one", "Page One");
    assert.deepEqual(external, []);
    const linkGuest = webContents.getAllWebContents().find((item) => item.getType() === "webview");
    await evaluate("document.querySelector('.workbench-collapse').click()");
    await until(() => evaluate("document.querySelector('.workbench-panel').getBoundingClientRect().width === 0"), "fold before link click");
    await evaluate("document.querySelectorAll('.chat-scroll-area a')[1].click()");
    await loaded("/two", "Page Two");
    assert.equal(linkGuest.isDestroyed(), false); assert.equal(linkGuest.getURL(), base + "/one");
    assert.equal(await evaluate("document.querySelector('.workbench-panel').classList.contains('is-collapsed')"), false);
    console.log("PASS conversation clicks open new browser tabs by default and expand a folded panel");

    const openLinkSettings = async () => {
      await evaluate("document.querySelector('.sidebar-user-pill').click()");
      await until(() => evaluate("!!document.querySelector('.settings-nav-item')"), "settings");
      await evaluate("Array.from(document.querySelectorAll('.settings-nav-item')).find(n => n.textContent === 'Interface').click()");
    };
    await openLinkSettings();
    assert.equal(await evaluate("document.querySelector('[aria-label=\"Conversation links\"] button').getAttribute('aria-checked')"), "true");
    await evaluate("document.querySelectorAll('[aria-label=\"Conversation links\"] button')[1].click()");
    await until(() => evaluate("window.vela.uiStorage.getItem('vela.conversationLinkTarget') === 'external'"), "saved system-browser preference");
    await evaluate("document.querySelector('.sidebar-user-pill').click()"); await pause(500);
    const guestCount = webContents.getAllWebContents().filter((item) => item.getType() === "webview").length;
    await evaluate("document.querySelector('.chat-scroll-area a').click()");
    await until(() => external.length > 0, "native link handling");
    assert.equal(external.at(-1), base + "/one");
    assert.equal(webContents.getAllWebContents().filter((item) => item.getType() === "webview").length, guestCount);

    await win.webContents.reload();
    await until(() => evaluate("!!document.querySelector('.sidebar-user-pill')"), "renderer reload");
    await openLinkSettings();
    await until(() => evaluate("document.querySelectorAll('[aria-label=\"Conversation links\"] button')[1]?.getAttribute('aria-checked') === 'true'"), "restored link preference");
    console.log("PASS setting changes apply to existing messages and persist across renderer reload");
    console.log("Browser Electron smoke: 10 checks passed");
    clearTimeout(watchdog);
    server.closeAllConnections(); server.close();
    app.quit();
  } catch (error) {
    console.error(error);
    clearTimeout(watchdog); server.closeAllConnections(); server.close();
    app.exit(1);
  }
}
app.on("will-quit", () => rmSync(temporary, { recursive: true, force: true }));
void run(); // Electron must finish evaluating the ESM entry before emitting app.ready.
