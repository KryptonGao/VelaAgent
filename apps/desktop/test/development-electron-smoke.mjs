/** Run after building: node_modules/.bin/electron apps/desktop/test/development-electron-smoke.mjs */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";

const temporary = mkdtempSync(join(tmpdir(), "vela-development-smoke-"));
const electronData = join(temporary, "electron"); const velaData = join(temporary, "vela-dev");
const fakeHome = join(temporary, "home"); const production = join(fakeHome, ".vela");
mkdirSync(electronData); mkdirSync(velaData); mkdirSync(join(production, "skills", "alpha"), { recursive: true });
writeFileSync(join(production, "MEMORY.md"), "Prefer pnpm.\n");
writeFileSync(join(production, "skills", "alpha", "SKILL.md"), "# alpha\n");
app.setPath("userData", electronData);
process.env.VELA_PRODUCTION_HOME = production;
process.env.VELA_USER_DATA = velaData; process.env.VELA_CWD = temporary;
delete process.env.ELECTRON_RENDERER_URL; delete process.env.VELA_CAPTURE;
writeFileSync(join(velaData, "ui-state.json"), JSON.stringify({ "vela.onboarding.complete": "true", "vela.appearance": "light", "vela.locale": "en" }));
const pause = ms => new Promise(r => setTimeout(r, ms));
async function until(check, label) {
  console.log("waiting for", label); for (let i = 0; i < 100; i++) { if (await check()) return; await pause(50); } throw new Error(`Timed out: ${label}`); }

async function run() {
const watchdog = setTimeout(() => { console.error("watchdog: timed out"); app.exit(1); }, 60000);
try {
  await import("../out/main/index.mjs");
  await until(() => BrowserWindow.getAllWindows().length > 0, "window");
  const win = BrowserWindow.getAllWindows()[0];
  win.setSize(1200, 900);
  const errors = [];
  win.webContents.on("console-message", e => { if (e.level === "error") { errors.push(e.message); console.log("renderer error:", e.message.slice(0, 300)); } });
  win.webContents.on("did-fail-load", (_e, code, description, url) => console.log("did-fail-load", code, description, url));
  const ev = code => win.webContents.executeJavaScript(code, true);
  const click = selector => ev(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const clickButton = text => ev(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)}).click()`);
  const page = () => ev("document.querySelector('.settings-content')?.innerText ?? ''");
  await until(() => ev("!!document.querySelector('.sidebar-user-pill')"), "renderer");
  await click(".sidebar-user-pill");
  await until(() => ev("!!document.querySelector('.settings-nav-item')"), "settings");
  await ev("[...document.querySelectorAll('.settings-nav-item')].find(n => n.textContent === 'Developer tools').click()");
  await until(() => ev("!!document.querySelector('.dev-sync-scopes')"), "development page");

  // Version information is readable and copyable.
  await until(() => ev("!!document.querySelector('.dev-info')"), "version info");
  const info = await ev("Object.fromEntries([...document.querySelectorAll('.dev-info dt')].map(dt => [dt.textContent, dt.nextElementSibling.textContent]))");
  assert.equal(info.Electron, process.versions.electron);
  assert.equal(info.Node, process.versions.node);
  assert.match(info.Commit, /[0-9a-f]{10}/);
  console.log("PASS version information shows commit, Electron and Node");

  // Preview does not write; sync imports one batch; undo removes it.
  await ev("[...document.querySelectorAll('.dev-sync-scope')].filter(l => /Skills|Memory/.test(l.textContent)).forEach(l => l.querySelector('input').click())");
  await ev("[...document.querySelectorAll('.dev-sync-scope')].find(l => /Conversations/.test(l.textContent)).querySelector('input').click()");
  await clickButton("Preview");
  await until(async () => /2 items will be imported/.test(await page()), "preview total");
  assert.equal(existsSync(join(velaData, "MEMORY.md")), false, "preview writes nothing");
  assert.equal(existsSync(join(velaData, "production-sync")), false);
  await clickButton("Sync 2 items");
  await until(async () => /Imported 2 items/.test(await page()), "sync result");
  assert.equal(existsSync(join(velaData, "MEMORY.md")), true);
  assert.equal(existsSync(join(velaData, "skills", "alpha", "SKILL.md")), true);
  await until(() => ev("document.querySelectorAll('.dev-sync-batch').length === 1"), "history row");
  console.log("PASS preview, sync and batch history");
  await pause(300);
  const screenshot = process.env.VELA_SMOKE_SCREENSHOT || join(temporary, "development.png");
  writeFileSync(screenshot, (await win.webContents.capturePage()).toPNG());
  console.log("screenshot:", screenshot);

  await clickButton("Undo");
  await until(async () => /removes the imported conversations/.test(await page()), "undo warning");
  await clickButton("Confirm undo");
  await until(async () => /Undid 2 items/.test(await page()), "undo result");
  assert.equal(existsSync(join(velaData, "MEMORY.md")), false);
  assert.equal(existsSync(join(velaData, "skills", "alpha")), false);
  await until(() => ev("document.querySelectorAll('.dev-sync-batch').length === 0"), "history cleared");
  console.log("PASS undo restores the development profile");

  // DevTools and reload act on the app window.
  await ev("window.__marker = 1");
  await clickButton("Open DevTools");
  await until(() => win.webContents.isDevToolsOpened(), "devtools");
  win.webContents.closeDevTools();
  await clickButton("Reload window");
  await until(async () => (await ev("window.__marker ?? null").catch(() => 1)) === null, "reload");
  console.log("PASS DevTools opens and the window reloads");
  assert.deepEqual(errors, [], errors.join("\n"));
  console.log("DEVELOPMENT SMOKE PASS");
  clearTimeout(watchdog);
  app.exit(0);
} catch (error) {
  console.error(error);
  try { console.log("BODY:", (await BrowserWindow.getAllWindows()[0].webContents.executeJavaScript("document.body.innerText.slice(0, 600) + ' | ' + location.href")).replace(/\n/g, " / ")); } catch {}
  app.exit(1);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
}
app.whenReady().then(run);
