/** Focused renderer behavior checks: node apps/desktop/test/mcp-settings-ui.mjs */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkMcpToolDetails } from "./mcp-tool-details-checks.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(resolve(here, "../package.json"));

if (!process.versions.electron) {
  const temp = mkdtempSync(join(tmpdir(), "vela-mcp-ui-"));
  try {
    const { build } = await import("esbuild");
    await build({
      stdin: {
        contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { McpSettingsSection } from './apps/desktop/src/renderer/components/McpSettingsSection';
      import { ToolCard } from './apps/desktop/src/renderer/components/ToolCard';
      import { AppLocaleProvider, setActiveLocale } from './apps/desktop/src/renderer/locale';
      import { toUiMessage } from './apps/desktop/src/renderer/hooks/useSession';
      setActiveLocale('en');
      const digest = 'a'.repeat(64);
      const server = (name, scope, config) => ({ name, scope, config, enabled: true, effective: true, trusted: scope === 'global', status: 'configured', configDigest: digest, secretFields: ['/env/TOKEN'], connectionStatus: 'connected', authStatus: 'none', tools: [{ server: name, name: 'lookup', readOnly: false, configDigest: digest, toolDigest: 'b'.repeat(64) }] });
      window.fixture = {
        calls: [], listener: null, stateListener: null, stateCalls: 0, state: { activeConversationId: null, session: { cwd: '/no-chat' } }, failSave: false, loginResolve: null,
        catalog: { cwd: '/workspace', conversationId: 'chat-a', errors: [], pendingApply: false, servers: [server('local', 'global', { command: 'node', args: ['server.js'], env: { TOKEN: '••••••••' }, vendor: { keep: true } }), server('remote', 'project', { url: 'https://tools.example/mcp', oauth: { clientId: 'public', clientSecret: '••••••••' } })], projectTrust: { path: '/workspace/.vela/mcp.json', digest, trusted: false, servers: [{name:'remote',url:'https://tools.example/mcp'}], review: [{name:'remote',config:{url:'https://tools.example/mcp'},secretFields:[]}] } }
      };
      const f = window.fixture;
      const call = async (method, input) => { f.calls.push({method,input}); if(method === 'save' && f.failSave) throw new Error('Save failed'); return structuredClone(f.catalog); };
      window.vela = {
        getState: async () => { f.stateCalls++;return structuredClone(f.state); },
        onEvent: listener => { f.stateListener=listener;return ()=>{f.stateListener=null;}; },
        getMcpCatalog: input => call('catalog', input), saveMcpServer: input => call('save', input),
        removeMcpServer: input => call('remove',input), setMcpEnabled: input => call('enabled',input),
        reconnectMcpServer: input => call('reconnect',input), setMcpProjectTrust: input => call('trust',input),
        setMcpToolReadOnly: input => call('readOnly',input), logoutMcpServer: input => call('logout',input),
        loginMcpServer: input => { f.calls.push({method:'login',input}); return new Promise(resolve => {f.loginResolve=resolve;}); },
        cancelMcpLogin: input => { f.calls.push({method:'cancelLogin',input}); f.loginResolve?.(structuredClone(f.catalog)); return Promise.resolve(structuredClone(f.catalog)); },
        onMcpStatus: listener => {f.listener=listener;return ()=>{f.listener=null;};}
      };
      const root = createRoot(document.getElementById('root'));
      window.renderMcp = (locale='en', cwd='/workspace', conversationId='chat-a') => root.render(<McpSettingsSection locale={locale} workspacePath={cwd} conversationId={conversationId}/>);
      window.detailLocale='en';
      window.renderTool = (tool, compact=false) => {window.detailTool=tool;window.detailCompact=compact;root.render(<AppLocaleProvider locale={window.detailLocale}><ToolCard key={tool.id} tool={tool} compact={compact}/></AppLocaleProvider>);};
      window.setDetailLocale = locale => {window.detailLocale=locale;setActiveLocale(locale);window.renderTool(window.detailTool,window.detailCompact);};
      window.restoreTool = (tool, compact=false) => window.renderTool(toUiMessage({id:'history',role:'assistant',text:'',thinking:'',tools:[tool]}).tools[0],compact);
      window.renderMcp();
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
        '</style></head><body><div id="root" style="padding:24px;max-width:800px;overflow:auto;height:100vh"></div><script src="ui.js"></script></body></html>',
    );
    const env = { ...process.env, VELA_MCP_UI_TEMP: temp };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require("electron"), [fileURLToPath(import.meta.url)], {
      env,
      stdio: "inherit",
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 45000);
    const code = await new Promise((res, rej) => {
      child.once("error", rej);
      child.once("exit", res);
    });
    clearTimeout(timer);
    assert.equal(code, 0, "MCP renderer behavior checks failed");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
} else {
  const { app, BrowserWindow } = await import("electron");
  app.setPath("userData", join(process.env.VELA_MCP_UI_TEMP, "profile"));
  void app.whenReady().then(async () => {
    const win = new BrowserWindow({
      show: false,
      width: 1000,
      height: 1000,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    try {
      await win.loadFile(join(process.env.VELA_MCP_UI_TEMP, "index.html"));
      const evaluate = (code) => win.webContents.executeJavaScript(code);
      const until = async (code) => {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          if (await evaluate(code)) return;
          await new Promise((res) => setTimeout(res, 20));
        }
        throw new Error(`Timed out: ${code}`);
      };
      const click = async (label, scope = "document") =>
        evaluate(
          `Array.from(${scope}.querySelectorAll('button')).find(node => node.textContent === ${JSON.stringify(label)}).click()`,
        );
      const fill = async (label, value, scope = "document") => {
        await evaluate(
          `(() => { const control = Array.from(${scope}.querySelectorAll('label')).find(n => n.querySelector('span')?.textContent === ${JSON.stringify(label)}).querySelector('input,textarea,select'); Object.getOwnPropertyDescriptor(control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : control instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype,'value').set.call(control,${JSON.stringify(value)});control.dispatchEvent(new Event('input',{bubbles:true}));control.dispatchEvent(new Event('change',{bubbles:true})); })()`,
        );
      };
      if (process.env.VELA_MCP_TOOL_DETAILS_ONLY) {
        await checkMcpToolDetails({ win, evaluate, until, captureDir: process.env.VELA_MCP_UI_CAPTURE });
        app.exit(0);
        return;
      }
      await until("document.querySelectorAll('.mcp-server').length === 2");
      assert.deepEqual(await evaluate("fixture.calls[0].input"), {
        cwd: "/workspace",
        conversationId: "chat-a",
      });
      if (process.env.VELA_MCP_UI_CAPTURE) {
        writeFileSync(
          join(process.env.VELA_MCP_UI_CAPTURE, "mcp-settings-light.png"),
          (await win.webContents.capturePage()).toPNG(),
        );
        await evaluate("document.documentElement.dataset.scheme='dark'");
        await evaluate(
          "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
        );
        writeFileSync(
          join(process.env.VELA_MCP_UI_CAPTURE, "mcp-settings-dark.png"),
          (await win.webContents.capturePage()).toPNG(),
        );
        await evaluate("document.documentElement.dataset.scheme='light'");
      }
      await click("Edit", "document.querySelector('.mcp-server')");
      await until("!!document.querySelector('.mcp-form')");
      assert.equal(
        await evaluate(
          "document.querySelector('.mcp-form textarea[autocomplete=off]').value",
        ),
        "",
      );
      await fill("Command", "node-new", "document.querySelector('.mcp-form')");
      await evaluate("fixture.failSave=true");
      await click("Save server", "document.querySelector('.mcp-form')");
      await until(
        "document.querySelector('section > [role=alert]')?.textContent==='Save failed'",
      );
      assert.equal(
        await evaluate(
          "document.querySelector('.mcp-form input:not(:disabled)').value",
        ),
        "node-new",
      );
      await evaluate(
        "fixture.failSave=false;fixture.calls=fixture.calls.filter(c=>c.method!=='save')",
      );
      await click("Save server", "document.querySelector('.mcp-form')");
      await until("!document.querySelector('.mcp-form')");
      const save = await evaluate(
        "fixture.calls.find(call=>call.method==='save')",
      );
      assert.equal(save.input.config.env.TOKEN, "••••••••");
      assert.deepEqual(save.input.config.vendor, { keep: true });
      assert.equal(save.input.config.command, "node-new");
      console.log(
        "PASS editing preserves masked credentials and vendor options",
      );

      await click("Create override", "document.querySelector('.mcp-server')");
      await until("!!document.querySelector('.mcp-form')");
      assert.ok(
        (
          await evaluate("document.querySelector('.mcp-form').textContent")
        ).includes("cannot be copied to another scope"),
      );
      await click("Save server", "document.querySelector('.mcp-form')");
      await until("!document.querySelector('.mcp-form')");
      const override = await evaluate(
        "fixture.calls.filter(c=>c.method==='save').at(-1)",
      );
      assert.equal(override.input.scope, "project");
      assert.deepEqual(override.input.config.env, {});
      await evaluate(
        "fixture.calls=fixture.calls.filter(c=>c!==fixture.calls.filter(c=>c.method==='save').at(-1))",
      );
      console.log(
        "PASS source override removes masked values that cannot be copied across scopes",
      );
      await evaluate(
        "document.querySelector('details.settings-block').open = true",
      );
      await fill(
        "Import JSON",
        '{"mcpServers":{"good":{"command":"node"},"bad":{"command":""}}}',
      );
      await click("Preview import");
      await until(
        "!!document.querySelector('details.settings-block [role=alert]')",
      );
      assert.equal(
        await evaluate("fixture.calls.filter(c=>c.method==='save').length"),
        1,
      );
      await fill(
        "Import JSON",
        '{"mcpServers":{"new":{"command":"node","args":["two words"]}}}',
      );
      await click("Preview import");
      await until(
        "Array.from(document.querySelectorAll('button')).some(n=>n.textContent==='Import selected')",
      );
      assert.equal(
        await evaluate("fixture.calls.filter(c=>c.method==='save').length"),
        1,
      );
      await click("Import selected");
      await until("fixture.calls.filter(c=>c.method==='save').length===2");
      assert.deepEqual(
        await evaluate(
          "fixture.calls.filter(c=>c.method==='save')[1].input.config.args",
        ),
        ["two words"],
      );
      console.log(
        "PASS malformed import is rejected and valid import needs preview plus explicit save",
      );

      await until("!document.querySelector('section[aria-busy=true]')");
      assert.ok(
        (
          await evaluate("document.querySelector('.mcp-trust').textContent")
        ).includes("https://tools.example/mcp"),
      );
      await click("Trust this project");
      await until("fixture.calls.some(c=>c.method==='trust')");
      assert.deepEqual(
        await evaluate("fixture.calls.find(c=>c.method==='trust').input"),
        { cwd: "/workspace", trusted: true, digest: "a".repeat(64) },
      );
      console.log(
        "PASS project trust exposes endpoint and submits reviewed digest",
      );

      await until("!document.querySelector('section[aria-busy=true]')");
      await evaluate(
        "document.querySelector('.mcp-server details').open = true",
      );
      await click("Mark as read-only", "document.querySelector('.mcp-server')");
      assert.equal(
        await evaluate("fixture.calls.filter(c=>c.method==='readOnly').length"),
        0,
      );
      await click("Confirm read-only");
      await until("fixture.calls.some(c=>c.method==='readOnly')");
      assert.deepEqual(
        await evaluate("fixture.calls.find(c=>c.method==='readOnly').input"),
        {
          cwd: "/workspace",
          conversationId: "chat-a",
          server: "local",
          tool: "lookup",
          readOnly: true,
          configDigest: "a".repeat(64),
          toolDigest: "b".repeat(64),
        },
      );
      console.log(
        "PASS read-only requires confirmation bound to config and tool digests",
      );

      await evaluate(
        "fixture.listener({cwd:'/other',conversationId:'chat-b',catalog:{...fixture.catalog,servers:[]}})",
      );
      await evaluate("new Promise(resolve=>requestAnimationFrame(resolve))");
      assert.equal(
        await evaluate("document.querySelectorAll('.mcp-server').length"),
        2,
      );
      await evaluate(
        "fixture.catalog.projectTrust.trusted=true;fixture.catalog.servers[1].trusted=true;fixture.listener({cwd:'/workspace',conversationId:'chat-a',catalog:structuredClone(fixture.catalog)})",
      );
      await until(
        "Array.from(document.querySelectorAll('button')).some(n=>n.textContent==='Log in with OAuth')",
      );
      await click("Log in with OAuth");
      await until(
        "Array.from(document.querySelectorAll('button')).some(n=>n.textContent==='Cancel login'&&!n.disabled)",
      );
      await click("Cancel login");
      await until("fixture.calls.some(c=>c.method==='cancelLogin')");
      assert.deepEqual(
        await evaluate("fixture.calls.find(c=>c.method==='cancelLogin').input"),
        {
          cwd: "/workspace",
          conversationId: "chat-a",
          scope: "project",
          name: "remote",
        },
      );
      console.log(
        "PASS unrelated status ignored and pending OAuth remains cancellable",
      );

      await until("!document.querySelector('section[aria-busy=true]')");
      await click("Delete", "document.querySelector('.mcp-server')");
      assert.equal(
        await evaluate("fixture.calls.filter(c=>c.method==='remove').length"),
        0,
      );
      await click("Confirm delete");
      await until("fixture.calls.some(c=>c.method==='remove')");
      console.log("PASS deletion requires an explicit confirmation");

      await evaluate("window.renderMcp('zh')");
      await until("document.querySelector('h2')?.textContent==='MCP 服务器'");
      assert.equal(
        await evaluate(
          "Array.from(document.querySelectorAll('button')).some(n=>n.textContent==='添加服务器')",
        ),
        true,
      );
      console.log("PASS Chinese copy renders with the same controls");
      await evaluate(
        "fixture.catalog.cwd='/other';fixture.catalog.conversationId='chat-b';fixture.catalog.servers[0].name='other-local';window.renderMcp('en','/other','chat-b')",
      );
      await until(
        "document.querySelector('.mcp-server h3')?.textContent==='other-local'",
      );
      assert.deepEqual(
        await evaluate(
          "fixture.calls.filter(c=>c.method==='catalog').at(-1).input",
        ),
        { cwd: "/other", conversationId: "chat-b" },
      );
      await evaluate(
        "fixture.listener({cwd:'/other',conversationId:'chat-a',catalog:{...fixture.catalog,servers:[]}})",
      );
      await evaluate("new Promise(resolve=>requestAnimationFrame(resolve))");
      assert.equal(
        await evaluate("document.querySelector('.mcp-server h3').textContent"),
        "other-local",
      );
      win.setSize(640, 900);
      await evaluate(
        "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
      );
      assert.equal(
        await evaluate(
          "document.querySelector('.mcp-settings').scrollWidth<=document.querySelector('.mcp-settings').clientWidth",
        ),
        true,
      );
      console.log(
        "PASS conversation/workspace changes reset context and narrow layout has no horizontal overflow",
      );

      await evaluate(
        "fixture.catalog.cwd='/actual-no-chat';fixture.catalog.conversationId=null;fixture.state.session.cwd='/actual-no-chat';window.renderMcp('en',null,null)",
      );
      await until(
        "fixture.calls.filter(c=>c.method==='catalog').at(-1)?.input.cwd==='/actual-no-chat' && !!document.querySelector('.mcp-settings')",
      );
      assert.deepEqual(
        await evaluate(
          "fixture.calls.filter(c=>c.method==='catalog').at(-1).input",
        ),
        { cwd: "/actual-no-chat", conversationId: null },
      );
      await click("Add server");
      await until("!!document.querySelector('.mcp-form')");
      await fill(
        "Server name",
        "no-chat-server",
        "document.querySelector('.mcp-form')",
      );
      await fill("Command", "node", "document.querySelector('.mcp-form')");
      await click("Save server", "document.querySelector('.mcp-form')");
      await until("!document.querySelector('.mcp-form')");
      assert.deepEqual(
        await evaluate(
          "({cwd:fixture.calls.filter(c=>c.method==='save').at(-1).input.cwd,conversationId:fixture.calls.filter(c=>c.method==='save').at(-1).input.conversationId})",
        ),
        { cwd: "/actual-no-chat", conversationId: null },
      );
      const stateCalls = await evaluate("fixture.stateCalls");
      await evaluate("window.renderMcp('en','/stale-worktree',null)");
      await until(
        `fixture.stateCalls>${stateCalls} && !!document.querySelector('.mcp-settings')`,
      );
      assert.equal(
        await evaluate(
          "fixture.calls.filter(c=>c.method==='catalog').at(-1).input.cwd",
        ),
        "/actual-no-chat",
      );
      await evaluate(
        "fixture.catalog.cwd='/next-no-chat';fixture.stateListener({type:'state',state:{activeConversationId:null,session:{cwd:'/next-no-chat'}}})",
      );
      await until(
        "fixture.calls.filter(c=>c.method==='catalog').at(-1).input.cwd==='/next-no-chat'",
      );
      console.log(
        "PASS no-chat management resolves real cwd, ignores stale project path, and follows cwd changes",
      );

      await evaluate(
        "window.mcpTool={id:'mcp-live',name:'opaque_registered_name',status:'running',activity:{mcp:{server:'docs-server',tool:'lookup'},body:'Searching'}};window.renderTool(window.mcpTool)",
      );
      await until("!!document.querySelector('.tool-mcp-source')");
      assert.equal(
        await evaluate(
          "document.querySelector('.tool-mcp-source').textContent",
        ),
        "docs-server",
      );
      assert.equal(
        await evaluate("document.querySelector('.tool-card-name').textContent"),
        "lookup",
      );
      assert.equal(
        await evaluate(
          "document.querySelector('.tool-kind-label').textContent",
        ),
        "MCP",
      );
      await evaluate("document.querySelector('.tool-card-head').click()");
      await until("!!document.querySelector('.mcp-detail-tabs')");
      await click("Call info");
      await until(
        "document.querySelector('.mcp-call-fields')?.textContent.includes('docs-server')",
      );
      assert.ok(
        (
          await evaluate(
            "document.querySelector('.mcp-call-fields').textContent",
          )
        ).includes("Toollookup"),
      );
      await evaluate(
        "window.restoreTool({...window.mcpTool,id:'mcp-history',status:'done',activity:{...window.mcpTool.activity,body:'Historical tool output'}},true)",
      );
      await until(
        "document.querySelector('.tool-mcp-source')?.textContent==='docs-server' && document.querySelector('.tool-card')?.classList.contains('is-done')",
      );
      await evaluate("document.querySelector('.tool-card-head').click()");
      await until(
        "document.querySelector('.tool-note')?.textContent==='Historical tool output'",
      );
      await evaluate(
        "window.renderTool({id:'ordinary-tool',name:'mcp__encoded__name',status:'done',activity:{body:'Normal output'}})",
      );
      await until(
        "document.querySelector('.tool-card-name')?.textContent==='mcp__encoded__name'",
      );
      assert.equal(
        await evaluate("document.querySelector('.tool-mcp-source')===null"),
        true,
      );
      console.log(
        "PASS live and restored compact cards expose MCP server and tool from metadata only",
      );

      app.exit(0);
    } catch (error) {
      console.error(error);
      app.exit(1);
    }
  });
}
