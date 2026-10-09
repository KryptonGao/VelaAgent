/** Renderer behavior checks for the update settings page and restart notice: node apps/desktop/test/updates-ui.mjs */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(resolve(here, "../package.json"));

const mockScript = String.raw`
(() => {
  const listeners = new Set();
  const fixture = window.fixture = {
    calls: [],
    state: { status: "idle", currentVersion: "1.0.5", autoUpdate: true, installable: true },
    set(patch) {
      fixture.state = { ...fixture.state, ...patch };
      for (const listener of listeners) listener({ ...fixture.state });
    },
  };
  const record = (method, ...args) => { fixture.calls.push({ method, args }); };
  window.vela = {
    updates: {
      getState: async () => ({ ...fixture.state }),
      subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
      check: async () => {
        record("check");
        fixture.set({ status: "checking" });
        await new Promise((resolve) => setTimeout(resolve, 30));
        fixture.set({ status: "up-to-date", checkedAt: Date.UTC(2026, 9, 10, 8, 30) });
        return { ...fixture.state };
      },
      download: async () => { record("download"); fixture.set({ status: "downloading", progress: { receivedBytes: 42, totalBytes: 100 } }); return { ...fixture.state }; },
      restart: async () => { record("restart"); },
      setAutoUpdate: async (enabled) => { record("setAutoUpdate", enabled); fixture.set({ autoUpdate: enabled }); return { ...fixture.state }; },
      openReleasePage: async () => { record("openReleasePage"); },
    },
  };
})();
`;

if (!process.versions.electron) {
  const temp = mkdtempSync(join(tmpdir(), "vela-updates-ui-"));
  try {
    const { build } = await import("esbuild");
    await build({
      stdin: {
        contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { UpdatesPage } from './apps/desktop/src/renderer/components/settings/UpdatesPage';
      import { UpdateNotice } from './apps/desktop/src/renderer/components/UpdateNotice';
      import { settingsCopy } from './apps/desktop/src/renderer/components/settings-copy';
      const root = createRoot(document.getElementById('root'));
      window.renderUpdates = (locale) => root.render(<>
        <div className="settings-content"><UpdatesPage copy={settingsCopy(locale)} locale={locale} /></div>
        <UpdateNotice key={locale} locale={locale} />
      </>);
      window.renderUpdates('en');
    `,
        resolveDir: resolve(here, "../../.."),
        loader: "tsx",
      },
      loader: { ".svg": "dataurl" },
      bundle: true,
      outfile: join(temp, "ui.js"),
      platform: "browser",
      format: "iife",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"development"' },
    });
    writeFileSync(
      join(temp, "index.html"),
      '<!doctype html><html><head><meta charset="utf-8"><style>' +
        readFileSync(resolve(here, "../src/renderer/styles.css"), "utf8") +
        '</style><link rel="stylesheet" href="ui.css"></head><body><div id="root" style="padding:24px;max-width:800px;height:100vh"></div><script>' +
        mockScript +
        '</script><script src="ui.js"></script></body></html>',
    );
    const env = { ...process.env, VELA_UPDATES_UI_TEMP: temp };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require("electron"), [fileURLToPath(import.meta.url)], { env, stdio: "inherit" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 45000);
    const code = await new Promise((res, rej) => { child.once("error", rej); child.once("exit", res); });
    clearTimeout(timer);
    assert.equal(code, 0, "Update renderer behavior checks failed");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
} else {
  const { app, BrowserWindow } = await import("electron");
  app.setPath("userData", join(process.env.VELA_UPDATES_UI_TEMP, "profile"));
  void app.whenReady().then(async () => {
    const win = new BrowserWindow({
      show: false, width: 1000, height: 760,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    try {
      const errors = [];
      win.webContents.on("console-message", (event) => { if (event.level === "error") errors.push(event.message); });
      await win.loadFile(join(process.env.VELA_UPDATES_UI_TEMP, "index.html"));
      const evaluate = (code) => win.webContents.executeJavaScript(code);
      const until = async (code) => {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          if (await evaluate(code)) return;
          await new Promise((res) => setTimeout(res, 20));
        }
        throw new Error("Timed out: " + code);
      };
      const page = () => evaluate("document.querySelector('.update-card').textContent");
      const buttons = () => evaluate("Array.from(document.querySelectorAll('.update-card button')).map(node => node.textContent)");
      const noticeText = () => evaluate("document.querySelector('.update-notice')?.textContent ?? null");
      const click = (selector, label) => evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(node => node.textContent === ${JSON.stringify(label)}).click()`);
      const capture = async (name) => {
        if (!process.env.VELA_UPDATES_UI_CAPTURE) return;
        await new Promise((res) => setTimeout(res, 250));
        writeFileSync(join(process.env.VELA_UPDATES_UI_CAPTURE, name + ".png"), (await win.webContents.capturePage()).toPNG());
      };

      await until("!!document.querySelector('.update-card')");
      assert.match(await page(), /Vela 1\.0\.5/);
      assert.match(await page(), /Choose “Check for updates”/);
      assert.equal(await noticeText(), null, "nothing to announce yet");
      assert.equal(await evaluate("document.querySelector('[role=switch]').getAttribute('aria-checked')"), "true");
      console.log("PASS idle state shows the version and a manual check");

      await click(".update-card button", "Check for updates");
      await until("document.querySelector('.update-status')?.textContent === 'Checking for updates…'");
      await until("document.querySelector('.update-status')?.textContent === \"You're up to date.\"");
      assert.match(await page(), /Last checked:/);
      assert.deepEqual(await evaluate("fixture.calls.map(call => call.method)"), ["check"]);
      console.log("PASS manual check walks through checking to up to date");

      await evaluate("fixture.set({ status: 'available', version: '1.0.6', autoUpdate: false, installable: true, notes: '## What\\'s new\\n\\n- Faster **startup**' })");
      await until("[...document.querySelectorAll('.update-card button')].some(node => node.textContent === 'Download update')");
      assert.match(await page(), /Version 1\.0\.6 is available to download\./);
      assert.equal(await noticeText(), null, "installable updates wait for consent without a popup");
      await evaluate("document.querySelector('.update-notes summary').click()");
      assert.match(await evaluate("document.querySelector('.update-notes-body').textContent"), /Faster startup/);
      await click(".update-card button", "Download update");
      await until("document.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow') === '42'");
      assert.equal(await evaluate("document.querySelector('[role=progressbar] span').style.width"), "42%");
      assert.deepEqual((await buttons()).filter((label) => label !== "Check for updates"), []);
      assert.equal(await evaluate("[...document.querySelectorAll('.update-card button')].find(node => node.textContent === 'Check for updates').disabled"), true);
      console.log("PASS download button, release notes and progress bar");
      await capture("downloading");

      await evaluate("fixture.set({ status: 'ready', progress: undefined, autoUpdate: true })");
      await until("!!document.querySelector('.update-notice')");
      assert.match(await noticeText(), /Vela 1\.0\.6 has been downloaded/);
      assert.match(await page(), /downloaded and its signature verified/);
      assert.match(await page(), /installs automatically when you quit/);
      await capture("ready");
      await click(".update-notice button", "Later");
      await until("!document.querySelector('.update-notice')");
      await evaluate("fixture.set({ status: 'ready' })");
      await new Promise((res) => setTimeout(res, 100));
      assert.equal(await noticeText(), null, "dismissed for this version");
      await click(".update-card button", "Restart now");
      assert.equal(await evaluate("fixture.calls.at(-1).method"), "restart");
      await evaluate("fixture.set({ version: '1.0.7' })");
      await until("!!document.querySelector('.update-notice')");
      await click(".update-notice button", "Restart now");
      assert.equal(await evaluate("fixture.calls.filter(call => call.method === 'restart').length"), 2);
      console.log("PASS ready state prompts for restart, can be dismissed per version");

      await evaluate("fixture.set({ status: 'available', version: '1.0.8', installable: false })");
      await until("document.querySelector('.update-notice button')?.textContent === 'Open release page'");
      assert.match(await noticeText(), /Vela 1\.0\.8 is available/);
      assert.match(await page(), /can't update itself/);
      await click(".update-card button", "Open release page");
      assert.equal(await evaluate("fixture.calls.at(-1).method"), "openReleasePage");
      await capture("manual");
      console.log("PASS installations that cannot replace themselves point to the release page");

      await evaluate("fixture.set({ status: 'error', version: undefined, installable: true, error: { code: 'signature', message: 'SHA256SUMS.txt signature does not match' } })");
      await until("!document.querySelector('.update-notice')");
      assert.match(await page(), /signature could not be verified/);
      assert.match(await page(), /SHA256SUMS\.txt signature does not match/);
      assert.equal(await evaluate("document.querySelector('.update-status').classList.contains('error')"), true);
      await capture("error");
      console.log("PASS errors are explained without a popup");

      await evaluate("fixture.set({ status: 'idle', error: undefined })");
      await evaluate("document.querySelector('[role=switch]').click()");
      await until("document.querySelector('[role=switch]').getAttribute('aria-checked') === 'false'");
      assert.deepEqual(await evaluate("fixture.calls.at(-1)"), { method: "setAutoUpdate", args: [false] });
      console.log("PASS automatic update switch persists through the API");

      await evaluate("fixture.set({ status: 'ready', version: '1.0.9' }); window.renderUpdates('zh-CN')");
      await until("document.querySelector('.update-notice')?.textContent.includes('已下载')");
      assert.match(await noticeText(), /Vela 1\.0\.9 已下载/);
      assert.match(await page(), /已下载并通过签名校验/);
      await capture("ready-zh");
      for (const [locale, title, button] of [["zh-TW", "Vela 1.0.9 已下載", "立即重新啟動"], ["ja", "Vela 1.0.9 をダウンロードしました", "今すぐ再起動"], ["ko", "Vela 1.0.9 다운로드 완료", "지금 다시 시작"]]) {
        await evaluate(`window.renderUpdates(${JSON.stringify(locale)})`);
        await until(`document.querySelector('.update-notice')?.textContent.includes(${JSON.stringify(title)})`);
        assert.ok((await noticeText()).includes(button), `${locale}: ${await noticeText()}`);
        assert.ok(!/[简发进检]/.test(await page()), `${locale} leaks Simplified Chinese: ${await page()}`);
      }
      console.log("PASS notice and page are localized in every language");

      assert.deepEqual(errors, [], "no renderer console errors");
      app.exit(0);
    } catch (error) {
      console.error(error);
      app.exit(1);
    }
  });
}
