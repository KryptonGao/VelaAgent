/** Run after building: node_modules/.bin/electron apps/desktop/test/browser-electron-smoke.mjs */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    await import("../out/main/index.mjs");
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

    await guest.executeJavaScript("document.querySelector('#saved').value='preserved';window.fixtureMarker=42;scrollTo(0,350)");
    const originalScroll = await guest.executeJavaScript("scrollY");
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
    await evaluate("document.querySelector('[aria-label=\"Expand workbench\"]').click()"); await pause(500);
    assert.deepEqual(await guest.executeJavaScript("({value:document.querySelector('#saved').value,marker:window.fixtureMarker,scroll:scrollY})"),
      { value: "preserved", marker: 42, scroll: originalScroll });
    assert.equal(requests.get("/one"), originalRequests);
    console.log("PASS switch/fold/expand retains the same guest, page state and scroll without reloading");

    await evaluate("document.querySelector('.sidebar-user-pill').click()"); await pause(650);
    assert.equal(guest.isDestroyed(), false);
    assert.equal(await evaluate("document.querySelector('.main-stage-pane.is-overlay').inert"), true);
    await evaluate("document.querySelector('.sidebar-user-pill').click()"); await pause(500);
    assert.equal(await guest.executeJavaScript("window.fixtureMarker"), 42);
    assert.equal(requests.get("/one"), originalRequests);
    console.log("PASS opening/closing Settings retains the guest and excludes hidden controls");

    await navigate("/redirect"); await loaded("/two", "Page Two");
    await evaluate("document.querySelector('[aria-label=\"Back\"]').click()"); await loaded("/one", "Page One");
    await evaluate("document.querySelector('[aria-label=\"Forward\"]').click()"); await loaded("/two", "Page Two");
    const reloadRequests = requests.get("/two");
    await evaluate("document.querySelector('[aria-label=\"Reload\"]').click()");
    await until(() => requests.get("/two") > reloadRequests, "reload request"); await loaded("/two", "Page Two");
    await guest.executeJavaScript("history.pushState({},'', '/spa');document.title='SPA title'");
    await loaded("/spa", "SPA title");
    await guest.executeJavaScript("document.querySelector('#popup').click()", true); await loaded("/two", "Page Two");
    assert.equal(BrowserWindow.getAllWindows().length, 1);
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
      await evaluate("Array.from(document.querySelectorAll('.settings-nav-item')).find(n => n.textContent === 'Appearance & shortcuts').click()");
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
    console.log("Browser Electron smoke: 8 checks passed");
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
