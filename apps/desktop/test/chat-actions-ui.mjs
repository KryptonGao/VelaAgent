/** Focused menu interaction checks: node apps/desktop/test/chat-actions-ui.mjs */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(resolve(here, "../package.json"));

if (!process.versions.electron) {
  const temporary = mkdtempSync(join(tmpdir(), "vela-chat-actions-"));
  try {
    const { build } = await import("esbuild");
    await build({
      stdin: {
        contents: `
          import React, { useState } from 'react';
          import { createRoot } from 'react-dom/client';
          import { ChatActionsMenu } from './apps/desktop/src/renderer/components/ChatActionsMenu';
          import { RecipeActionsContext } from './apps/desktop/src/renderer/components/recipe-actions-context';
          import { TaskRecipesPage } from './apps/desktop/src/renderer/components/TaskRecipesPage';
          import { setActiveLocale } from './apps/desktop/src/renderer/locale';
          setActiveLocale('zh-CN');
          window.fixture = { seeds: [], saved: [], messages: [
            { id: 'user', role: 'user', text: 'Earlier selected text', thinking: '', tools: [] },
            { id: 'reply', role: 'assistant', text: 'Latest assistant reply', thinking: '', tools: [] },
            { id: 'tool-only', role: 'assistant', text: '  ', thinking: '', tools: [] }
          ] };
          const root = createRoot(document.getElementById('root'));
          window.renderChat = (id = 'chat-a', messages = fixture.messages, streaming = false) => root.render(
            <RecipeActionsContext.Provider value={{conversationId: id, open: () => {}, fromMessage: seed => fixture.seeds.push(seed)}}>
              <main className="main-chat-view"><header className="main-chat-header">
                <span className="chat-active-title">Hello</span><div className="chat-header-actions">
                  <ChatActionsMenu key={id ?? 'empty'} messages={messages} streaming={streaming} />
                </div>
              </header><div className="chat-scroll-area"><p id="source" style={{userSelect: 'text'}}>Earlier selected text</p><p>Latest assistant reply</p></div>
              <button id="outside">Outside</button></main>
            </RecipeActionsContext.Provider>
          );
          window.renderChat();
          window.vela = { taskRecipes: {
            list: async () => ({recipes: [], runs: [], error: null}),
            subscribe: () => () => {},
            save: async recipe => {fixture.saved.push(structuredClone(recipe)); return recipe;}
          } };
          function RecipeNavigationFixture() {
            const [seed, setSeed] = useState(null);
            const [recipesOpen, setRecipesOpen] = useState(false);
            return <RecipeActionsContext.Provider value={{conversationId: 'navigation-chat',
              open: () => setRecipesOpen(true), fromMessage: next => {setSeed(next); setRecipesOpen(true);} }}>
              {recipesOpen ? <TaskRecipesPage catalog={null} workspace={null} workspaces={[]} locale="zh-CN"
                sidebarCollapsed={false} onToggleSidebar={() => {}} onOpenConversation={() => {}}
                seed={seed} onConsumeSeed={() => setSeed(null)} registerLeaveGuard={() => {}} /> :
                <header className="main-chat-header"><span className="chat-active-title">Hello</span><div className="chat-header-actions">
                  <ChatActionsMenu messages={fixture.messages} streaming={false} />
                </div></header>}
            </RecipeActionsContext.Provider>;
          }
          window.renderNavigation = () => root.render(<RecipeNavigationFixture />);
        `,
        resolveDir: resolve(here, "../../.."), loader: "tsx",
      },
      bundle: true, platform: "browser", format: "iife", jsx: "automatic",
      outfile: join(temporary, "ui.js"), loader: { ".svg": "dataurl" },
      define: { "process.env.NODE_ENV": '"development"' },
    });
    writeFileSync(join(temporary, "index.html"), '<!doctype html><html data-scheme="dark"><head><meta charset="utf-8"><style>' +
      readFileSync(join(here, "../src/renderer/styles.css"), "utf8") + readFileSync(join(here, "../src/renderer/scheduled-tasks.css"), "utf8") + readFileSync(join(here, "../src/renderer/task-recipes.css"), "utf8") +
      '</style></head><body><div id="root" style="height:100vh"></div><script src="ui.js"></script></body></html>');
    const env = { ...process.env, VELA_CHAT_ACTIONS_TEMP: temporary };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require("electron"), [fileURLToPath(import.meta.url)], { env, stdio: "inherit" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 45000);
    try {
      const code = await new Promise((done, reject) => { child.once("error", reject); child.once("exit", done); });
      assert.equal(code, 0, "Chat actions interaction checks failed");
    } finally { clearTimeout(timer); }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
} else {
  const { app, BrowserWindow } = await import("electron");
  app.setPath("userData", join(process.env.VELA_CHAT_ACTIONS_TEMP, "profile"));
  void app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 900, height: 600, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  try {
    await win.loadFile(join(process.env.VELA_CHAT_ACTIONS_TEMP, "index.html"));
    const evaluate = async code => {
      try { return await win.webContents.executeJavaScript(code); }
      catch (error) { console.error(`Renderer check failed: ${code}`); throw error; }
    };
    const until = async code => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (await evaluate(code)) return;
        await new Promise(done => setTimeout(done, 20));
      }
      throw new Error(`Timed out: ${code}`);
    };
    const open = async () => {
      await evaluate("document.querySelector('.chat-actions-anchor > button').click()");
      await until("document.querySelector('.chat-actions-anchor > button').getAttribute('aria-expanded') === 'true'");
    };
    const closed = () => until("!document.querySelector('.chat-actions-menu')");
    const choose = () => evaluate("document.querySelector('[role=menuitem]').click()");
    await until("document.querySelector('.main-chat-header .chat-actions-anchor')");
    await open();
    assert.equal(await evaluate("document.activeElement.getAttribute('role')"), "menuitem");
    assert.equal(await evaluate("document.querySelector('[role=menuitem]').textContent"), "从对话创建配方");
    await evaluate("document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    await closed();
    assert.equal(await evaluate("document.activeElement.matches('.chat-actions-anchor > button')"), true);
    await evaluate("document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))");
    await until("document.activeElement.getAttribute('role') === 'menuitem'");
    await choose(); await closed();
    assert.deepEqual(await evaluate("fixture.seeds[0]"), { text: "Latest assistant reply", conversationId: "chat-a", messageId: "reply" });

    await evaluate("const range = document.createRange(); range.selectNodeContents(document.getElementById('source')); window.getSelection().removeAllRanges(); window.getSelection().addRange(range)");
    assert.equal(await evaluate("window.getSelection().toString()"), "Earlier selected text");
    const point = await evaluate("(() => { const r = document.querySelector('.chat-actions-anchor > button').getBoundingClientRect(); return {x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2)}; })()");
    win.webContents.sendInputEvent({ type: "mouseDown", ...point, button: "left", clickCount: 1 });
    win.webContents.sendInputEvent({ type: "mouseUp", ...point, button: "left", clickCount: 1 });
    await until("document.querySelector('.chat-actions-anchor > button').getAttribute('aria-expanded') === 'true'");
    await choose(); await closed();
    assert.deepEqual(await evaluate("fixture.seeds[1]"), { text: "Earlier selected text", conversationId: "chat-a", messageId: "user" });
    await evaluate("window.getSelection().removeAllRanges()");

    await open();
    await evaluate("document.getElementById('outside').dispatchEvent(new PointerEvent('pointerdown', {bubbles: true}))");
    await closed();
    await open(); await evaluate("window.renderChat('chat-b')"); await closed();
    await open(); await choose(); await closed();
    assert.equal(await evaluate("fixture.seeds.at(-1).conversationId"), "chat-b");

    for (const render of ["window.renderChat('empty', [])", "window.renderChat(null)", "window.renderChat('streaming', fixture.messages, true)"]) {
      await evaluate(render); await closed(); await open();
      assert.equal(await evaluate("document.querySelector('[role=menuitem]').getAttribute('aria-disabled')"), "true");
      await choose();
      assert.equal(await evaluate("fixture.seeds.length"), 3);
      await evaluate("document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}))");
      await closed();
    }
    await evaluate("window.renderChat('user-only', fixture.messages.slice(0, 1))"); await open(); await choose(); await closed();
    assert.deepEqual(await evaluate("fixture.seeds.at(-1)"), { text: "Earlier selected text", conversationId: "user-only", messageId: "user" });

    await evaluate("window.renderChat('capture')"); await open();
    await evaluate("new Promise(done => setTimeout(done, 200))");
    assert.equal(await evaluate("(() => {const r = document.querySelector('.chat-actions-menu').getBoundingClientRect(); const h = document.querySelector('.chat-actions-anchor > button').getBoundingClientRect(); return r.top >= h.bottom && r.right <= innerWidth && r.left >= 0;})()"), true);
    if (process.env.VELA_CHAT_ACTIONS_CAPTURE) writeFileSync(process.env.VELA_CHAT_ACTIONS_CAPTURE, (await win.webContents.capturePage()).toPNG());
    await evaluate("window.renderNavigation()");
    await until("Boolean(document.querySelector('.main-chat-header .chat-actions-anchor'))");
    await open();
    assert.equal(await evaluate("document.querySelector('[role=menuitem]').getAttribute('aria-disabled')"), "false");
    await evaluate("new Promise(done => setTimeout(done, 200))");
    const menuPoint = await evaluate("(() => { const r = document.querySelector('[role=menuitem]').getBoundingClientRect(); return {x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2)}; })()");
    win.webContents.sendInputEvent({ type: "mouseDown", ...menuPoint, button: "left", clickCount: 1 });
    win.webContents.sendInputEvent({ type: "mouseUp", ...menuPoint, button: "left", clickCount: 1 });
    await until("Boolean(document.querySelector('.recipe-editor'))");
    assert.equal(await evaluate("Array.from(document.querySelectorAll('.recipe-editor label')).find(label => label.firstChild.textContent === '流程要求').querySelector('textarea').value"), "Latest assistant reply");
    assert.equal(await evaluate("document.querySelector('.recipe-editor').textContent.includes('navigation-chat / reply')"), true);
    const capture = async name => {
      if (!process.env.VELA_RECIPE_UI_CAPTURE) return;
      mkdirSync(process.env.VELA_RECIPE_UI_CAPTURE, {recursive: true});
      await evaluate("new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))");
      writeFileSync(join(process.env.VELA_RECIPE_UI_CAPTURE, `${name}.png`), (await win.webContents.capturePage()).toPNG());
    };
    const button = label => evaluate(`Array.from(document.querySelectorAll('.recipe-editor button, .recipe-dialog button')).find(button => button.textContent === ${JSON.stringify(label)}).click()`);
    const fill = (label, value) => evaluate(`(() => {
      const control = Array.from(document.querySelectorAll('.recipe-editor label')).find(label => label.firstChild.textContent === ${JSON.stringify(label)}).querySelector('input, textarea');
      const prototype = control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(control, ${JSON.stringify(value)});
      control.dispatchEvent(new Event('input', {bubbles: true}));
    })()`);
    win.setSize(900, 800); await capture('editor-dark'); win.setSize(900, 600);
    await evaluate("document.querySelector('.scheduled-tasks-page-scroll').scrollTop = 600");
    assert.equal(await evaluate("(() => {const r = document.querySelector('.recipe-editor-heading').getBoundingClientRect(); const s = document.querySelector('.scheduled-tasks-page-scroll').getBoundingClientRect(); return Math.abs(r.top - s.top) <= 1;})()"), true);
    await button('关闭编辑');
    await until("Boolean(document.querySelector('.recipe-dialog[open]'))");
    assert.equal(await evaluate("(() => {const r = document.querySelector('.recipe-dialog').getBoundingClientRect(); return r.width <= 440 && Math.abs(r.x + r.width / 2 - innerWidth / 2) < 2 && Math.abs(r.y + r.height / 2 - innerHeight / 2) < 2;})()"), true);
    await capture('unsaved-dark');
    await evaluate("document.querySelector('.recipe-dialog').dispatchEvent(new Event('cancel', {cancelable: true}))");
    await until("!document.querySelector('.recipe-dialog')");
    assert.equal(await evaluate("Array.from(document.querySelectorAll('.recipe-editor label')).find(label => label.firstChild.textContent === '流程要求').querySelector('textarea').value"), 'Latest assistant reply');
    await evaluate("document.querySelector('.scheduled-tasks-page-scroll').scrollTop = 0");
    win.setSize(520, 720);
    await evaluate("new Promise(done => requestAnimationFrame(done))");
    assert.equal(await evaluate("document.querySelector('.recipe-page').scrollWidth <= document.querySelector('.recipe-page').clientWidth + 1"), true);
    await capture('editor-narrow');
    await button('关闭编辑'); await until("Boolean(document.querySelector('.recipe-dialog[open]'))");
    await capture('unsaved-narrow'); await button('继续编辑');
    win.setSize(900, 600);
    await evaluate("document.documentElement.dataset.scheme = 'light'"); await capture('editor-light');
    await evaluate("document.body.style.zoom = '2'");
    assert.equal(await evaluate("document.querySelector('.recipe-page').scrollWidth <= document.querySelector('.recipe-page').clientWidth + 1"), true);
    await capture('editor-zoom');
    await evaluate("document.body.style.zoom = '1'; document.documentElement.dataset.scheme = 'dark'");
    await evaluate("document.querySelector('.recipe-editor-options').open = true; document.querySelector('.recipe-source-reference').open = true; document.querySelector('.scheduled-tasks-page-scroll').scrollTop = document.querySelector('.scheduled-tasks-page-scroll').scrollHeight");
    await capture('editor-details');
    await fill('标签（逗号分隔）', '代码审查,质量');
    await fill('名称', '代码审查'); await fill('任务目标', '审查当前工作区的代码改动。'); await fill('交付要求', '按优先级列出问题与验证依据。');
    await button('保存配方');
    await until("!document.querySelector('.recipe-editor')");
    assert.equal(await evaluate("fixture.saved.length"), 1);
    assert.equal(await evaluate("fixture.saved[0].workflowTemplate"), 'Latest assistant reply');
    assert.deepEqual(await evaluate("fixture.saved[0].tags"), ['代码审查', '质量']);
    assert.deepEqual(await evaluate("fixture.saved[0].sourceReference"), {conversationId: 'navigation-chat', messageId: 'reply'});
    console.log("PASS chat menu and recipe editor: navigation, source preservation, sticky actions, unsaved dialog, cancel/resume, responsive layout, zoom and save");
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
  });
}
