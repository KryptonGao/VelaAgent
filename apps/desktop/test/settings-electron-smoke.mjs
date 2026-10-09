/** Run after building: node_modules/.bin/electron apps/desktop/test/settings-electron-smoke.mjs */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";

const temporary = mkdtempSync(join(tmpdir(), "vela-settings-smoke-"));
const electronData = join(temporary, "electron"); const velaData = join(temporary, "vela");
mkdirSync(electronData); mkdirSync(velaData);
app.setPath("userData", electronData);
process.env.VELA_USER_DATA = velaData; process.env.VELA_CWD = temporary;
delete process.env.ELECTRON_RENDERER_URL; delete process.env.VELA_CAPTURE;
writeFileSync(join(velaData, "ui-state.json"), JSON.stringify({ "vela.onboarding.complete": "true", "vela.appearance": "light", "vela.locale": "en" }));
const pause = ms => new Promise(r => setTimeout(r, ms));
async function until(check, label) { for (let i = 0; i < 100; i++) { if (await check()) return; await pause(50); } throw new Error(`Timed out: ${label}`); }

async function run() {
const watchdog = setTimeout(() => app.exit(1), 60000);
try {
  await import("../out/main/index.mjs");
  await until(() => BrowserWindow.getAllWindows().length > 0, "window");
  const win = BrowserWindow.getAllWindows()[0];
  win.setSize(1200, 800);
  const errors = [];
  win.webContents.on("console-message", e => { if (e.level === "error") errors.push(e.message); });
  const ev = code => win.webContents.executeJavaScript(code, true);
  await until(() => ev("!!document.querySelector('.sidebar-user-pill')"), "renderer");
  await ev("document.querySelector('.sidebar-user-pill').click()");
  await until(() => ev("!!document.querySelector('.settings-nav-item')"), "settings");
  const labels = await ev("[...document.querySelectorAll('.settings-nav-group-label')].map(n => n.textContent)");
  const development = await ev("Boolean(window.vela.development)");
  assert.deepEqual(labels, ["General", "Agent", "Models & extensions", "Data & workspace", ...(development ? ["Development"] : [])]);
  const items = await ev("[...document.querySelectorAll('.settings-nav-item')].map(n => n.textContent)");
  assert.equal(items.length, development ? 17 : 16);
  console.log("PASS grouped nav keeps all 16 pages (plus developer tools in dev builds)");
  // the update page talks to the real main-process service over IPC
  await ev("[...document.querySelectorAll('.settings-nav-item')].find(n => n.textContent === 'About & updates').click()");
  await until(() => ev("!!document.querySelector('.update-card')"), "updates page");
  assert.match(await ev("document.querySelector('.update-version').textContent"), /^Vela \d+\.\d+\.\d+/);
  assert.equal(await ev("document.querySelector('[data-setting-id=\"update-auto\"] [role=switch]').getAttribute('aria-checked')"), "true");
  console.log("PASS updates page renders the current version and the automatic-update switch");

  // the storage page reads real checkpoint usage from the main process and cleans only after a confirmation
  await ev("[...document.querySelectorAll('.settings-nav-item')].find(n => n.textContent === 'Storage').click()");
  await until(() => ev("/^Using /.test(document.querySelector('[data-setting-id=\"checkpoint-storage\"] [role=status]')?.textContent ?? '')"), "storage usage");
  await ev("[...document.querySelectorAll('[data-setting-id=\"checkpoint-storage\"] button')].find(n => n.textContent === 'Clean up').click()");
  await until(() => ev("[...document.querySelectorAll('[data-setting-id=\"checkpoint-storage\"] button')].some(n => n.textContent === 'Confirm cleanup')"), "cleanup confirmation");
  await ev("[...document.querySelectorAll('[data-setting-id=\"checkpoint-storage\"] button')].find(n => n.textContent === 'Confirm cleanup').click()");
  await until(() => ev("document.querySelector('[data-setting-id=\"checkpoint-storage\"] .settings-saved')?.textContent === 'Nothing to clean up.'"), "cleanup result");
  console.log("PASS storage page shows checkpoint usage and cleans after confirmation");

  // search → jump (permissions sits at the bottom of "Defaults & permissions")
  await ev("document.querySelector('.settings-search-input').focus()");
  const type = async text => { await ev(`(() => { const i = document.querySelector('.settings-search-input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; set.call(i, ${JSON.stringify(text)}); i.dispatchEvent(new Event('input', {bubbles:true})); })()`); await pause(100); };
  await type("sandbox");
  const first = await ev("document.querySelector('[role=option]')?.textContent");
  console.log("first result:", first);
  assert.match(first, /Execution permissions/);
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
  await until(() => ev("document.querySelector('.settings-nav-item.active')?.textContent === 'Defaults & permissions'"), "jump page");
  await pause(900);
  const geo = await ev(`(() => { const c = document.querySelector('.settings-content'); const p = document.querySelector('[data-setting-id="permissions"]'); const r = p.getBoundingClientRect(); const cr = c.getBoundingClientRect(); return { scrollTop: c.scrollTop, canScroll: c.scrollHeight > c.clientHeight, inView: r.top >= cr.top && r.bottom <= cr.bottom, view: document.querySelector('.settings-view').scrollTop, doc: document.scrollingElement.scrollTop, body: document.querySelector('.settings-body').scrollTop, headerTop: Math.round(document.querySelector('.settings-header').getBoundingClientRect().top), flash: p.classList.contains('setting-flash') }; })()`);
  console.log("geometry:", JSON.stringify(geo));
  assert.ok(geo.inView, "permissions block visible");
  assert.equal(geo.view, 0); assert.equal(geo.doc, 0); assert.equal(geo.body, 0);
  console.log("PASS search jumps and scrolls only the content pane");

  // scrollbars only show while scrolling
  const thumb = selector => ev(`getComputedStyle(document.querySelector('${selector}'), '::-webkit-scrollbar-thumb').backgroundColor`);
  const scrolling = selector => ev(`document.querySelector('${selector}').classList.contains('is-scrolling')`);
  await pause(1500);
  for (const selector of [".settings-content", ".settings-nav"]) {
    assert.equal(await scrolling(selector), false, `${selector} idle`);
    assert.equal(await thumb(selector), "rgba(0, 0, 0, 0)", `${selector} thumb hidden at rest`);
  }
  await ev("(() => { const c = document.querySelector('.settings-content'); c.scrollTop = c.scrollTop > 40 ? 0 : 40; })()");
  await pause(300);
  assert.equal(await scrolling(".settings-content"), true);
  assert.notEqual(await thumb(".settings-content"), "rgba(0, 0, 0, 0)", "thumb shows while scrolling");
  await pause(1600);
  assert.equal(await scrolling(".settings-content"), false);
  assert.equal(await thumb(".settings-content"), "rgba(0, 0, 0, 0)", "thumb hides again");
  console.log("PASS scrollbars appear only while scrolling");

  // autosave
  await ev("document.querySelector('.settings-content').scrollTop = 0");
  await ev(`(() => { const t = document.querySelector('textarea[aria-label="Extra instructions"]'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; set.call(t, 'Prefer concise answers.'); t.dispatchEvent(new Event('input', {bubbles:true})); })()`);
  await pause(1500);
  assert.equal((await ev("window.vela.getAgentSettings()")).instructions, "Prefer concise answers.");
  assert.match(await ev("document.querySelector('.settings-autosave').textContent"), /Saved/);
  console.log("PASS instructions auto-save after typing stops");
  await ev(`[...document.querySelectorAll('[aria-label="Default thinking level"] [role=radio]')].find(b => b.textContent === 'High').click()`);
  await until(async () => (await ev("window.vela.getAgentSettings()")).thinkingLevel === "high", "thinking saved");
  console.log("PASS thinking level saves immediately");

  // remembered page
  await ev("document.querySelector('.settings-done').click()"); await pause(500);
  await ev("document.querySelector('.sidebar-user-pill').click()");
  await until(() => ev("!!document.querySelector('.settings-nav-item')"), "reopen");
  assert.equal(await ev("document.querySelector('.settings-nav-item.active').textContent"), "Defaults & permissions");
  assert.equal(await ev("window.vela.uiStorage.getItem('vela.settingsPage')"), '"defaults"');
  console.log("PASS remembers last page");
  assert.deepEqual(errors, []);
  console.log("ALL OK");
  clearTimeout(watchdog); app.quit();
} catch (error) { console.error("FAIL", error); clearTimeout(watchdog); app.exit(1); }
}
app.on("will-quit", () => rmSync(temporary, { recursive: true, force: true }));
app.whenReady().then(run);
