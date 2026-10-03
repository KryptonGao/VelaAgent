/** Real Electron renderer interaction and secureStorage smoke, isolated from user credentials. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(resolve(here, "../package.json"));

if (!process.versions.electron) {
  const temporary = mkdtempSync(join(tmpdir(), "vela-plugins-ui-"));
  try {
    const { build } = await import("esbuild");
    const piEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
    await build({ stdin: { contents: `
      import React from 'react'; import { createRoot } from 'react-dom/client';
      import { IntegrationsSection } from './apps/desktop/src/renderer/components/IntegrationsSection';
      const f = window.fixture = { calls: [], pluginListener: null, mcpListener: null, resolveConnect: null, fail: false,
        catalog: {cwd:'/workspace',pendingApply:false,plugins:[{id:'notion',name:'Notion',description:'Search, read and edit your Notion workspace',icon:'notion',mcpUrl:'https://mcp.notion.com/mcp',transport:'streamable-http',authType:'oauth2',serverName:'builtin_notion',status:'disconnected',toolCount:0}]}};
      window.vela = {
        getState: async()=>({session:{cwd:'/fallback'}}),
        getPlugins: async input=>{f.calls.push({method:'list',input}); return structuredClone(f.catalog);},
        connectPlugin: input=>{f.calls.push({method:'connect',input}); return new Promise(resolve=>{f.resolveConnect=()=>{f.catalog.plugins[0].status=f.fail?'error':'connected';f.catalog.plugins[0].toolCount=f.fail?0:12; resolve(structuredClone(f.catalog));};});},
        disconnectPlugin: async input=>{f.calls.push({method:'disconnect',input});f.catalog.plugins[0].status='disconnected';f.resolveConnect?.();f.catalog.plugins[0].status='disconnected'; return structuredClone(f.catalog);},
        onPluginStatus: listener=>{f.pluginListener=listener;return()=>{f.pluginListener=null;}},
        onMcpStatus: listener=>{f.mcpListener=listener;return()=>{f.mcpListener=null;}}
      };
      const root=createRoot(document.getElementById('root'));
      window.render=(locale='en',cwd='/workspace')=>root.render(<IntegrationsSection locale={locale} workspacePath={cwd} conversationId={null}/>);
      window.render();`, resolveDir: resolve(here, "../../.."), loader: "tsx" }, bundle: true, platform: "browser", format: "iife", jsx: "automatic", outfile: join(temporary, "ui.js"), define: { "process.env.NODE_ENV": '"development"' } });
    await build({ entryPoints: [join(here, "../src/main/plugin-credentials.ts")], bundle: true, platform: "node", format: "esm", outfile: join(temporary, "secure.mjs"), external: ["electron", piEntry], alias: { "@earendil-works/pi-coding-agent": piEntry } });
    writeFileSync(join(temporary, "index.html"), '<!doctype html><html><head><meta charset="utf-8"><style>' + readFileSync(join(here, "../src/renderer/styles.css"), "utf8") + '</style></head><body><div id="root" style="padding:32px;max-width:800px;margin:auto"></div><script src="ui.js"></script></body></html>');
    const env = { ...process.env, VELA_PLUGIN_UI_TEMP: temporary }; delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require("electron"), [fileURLToPath(import.meta.url)], { env, stdio: "inherit" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 45000);
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    clearTimeout(timer); assert.equal(code, 0, "Plugin renderer/secureStorage smoke failed");
  } finally { rmSync(temporary, { recursive: true, force: true }); }
} else {
  const { app, BrowserWindow, safeStorage } = await import("electron");
  app.setPath("userData", join(process.env.VELA_PLUGIN_UI_TEMP, "profile"));
  app.whenReady().then(async () => {
    const window = new BrowserWindow({ show: false, width: 900, height: 540, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    try {
      const { SecureCredentialStore } = await import(join(process.env.VELA_PLUGIN_UI_TEMP, "secure.mjs"));
      assert.ok(safeStorage.isEncryptionAvailable(), "OS encryption must be available in the desktop smoke");
      const path = join(process.env.VELA_PLUGIN_UI_TEMP, "auth.enc.json");
      const storage = new SecureCredentialStore(path);
      storage.withLock(() => ({ result: undefined, next: '{"access_token":"desktop-fixture-token","refresh_token":"desktop-fixture-refresh"}' }));
      assert.equal(readFileSync(path, "utf8").includes("desktop-fixture"), false);
      assert.ok(new SecureCredentialStore(path).withLock(current => ({ result: current })).includes("desktop-fixture-token"));
      console.log("PASS native Electron OS-encrypted credential persistence");
      await window.loadFile(join(process.env.VELA_PLUGIN_UI_TEMP, "index.html"));
      const evaluate = code => window.webContents.executeJavaScript(code);
      const until = async code => { const deadline = Date.now() + 5000; while (Date.now() < deadline) { if (await evaluate(code)) return; await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error(`Timed out: ${code}`); };
      const click = label => evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent===${JSON.stringify(label)}).click()`);
      const capture = async name => {
        if (!process.env.VELA_PLUGIN_UI_CAPTURE) return;
        await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
        mkdirSync(process.env.VELA_PLUGIN_UI_CAPTURE, { recursive: true });
        writeFileSync(join(process.env.VELA_PLUGIN_UI_CAPTURE, name + ".png"), (await window.webContents.capturePage()).toPNG());
      };
      await until("document.querySelector('.integration-status')?.textContent==='Not connected'");
      assert.equal(await evaluate("document.querySelectorAll('input,textarea').length"), 0);
      await capture("integrations-disconnected");
      await click("Connect"); await until("document.querySelector('.integration-status')?.textContent==='Connecting…'");
      assert.deepEqual(await evaluate("fixture.calls.find(call=>call.method==='connect').input"), {cwd:"/workspace",conversationId:null,id:"notion"});
      await capture("integrations-connecting");
      await evaluate("fixture.resolveConnect()"); await until("document.querySelector('.integration-status')?.textContent==='Connected'");
      await capture("integrations-connected");
      await click("Disconnect"); await until("document.querySelector('.integration-status')?.textContent==='Not connected'");
      await click("Connect"); await until("document.querySelector('.integration-status')?.textContent==='Connecting…'");
      await evaluate("fixture.fail=true;fixture.resolveConnect()"); await until("document.querySelector('.integration-status')?.textContent==='Connection failed'");
      await capture("integrations-error");
      await click("Disconnect"); await until("document.querySelector('.integration-status')?.textContent==='Not connected'");
      await evaluate("fixture.fail=false"); await click("Connect"); await until("document.querySelector('.integration-status')?.textContent==='Connecting…'");
      await click("Cancel"); await until("document.querySelector('.integration-status')?.textContent==='Not connected'");
      await evaluate("document.documentElement.dataset.scheme='dark';window.render('zh-CN')");
      await until("document.querySelector('.integration-status')?.textContent==='未连接'");
      await capture("integrations-dark-zh");
      await evaluate("document.body.style.zoom='2'");
      await capture("integrations-200-percent");
      assert.equal(await evaluate("document.documentElement.scrollWidth>document.documentElement.clientWidth"), false);
      console.log("PASS plugin renderer connect/disconnect/cancel/error, IPC payload, localization and zoom");
      app.exit(0);
    } catch (error) { console.error(error); app.exit(1); }
  });
}
