/** Focused renderer behavior checks for the Memory settings section: node apps/desktop/test/memory-settings-ui.mjs */
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
  const encoder = new TextEncoder();
  const alphaContent = "# Alpha\n\n- run tests\n";
  const files = {
    global: { exists: false, content: "", revision: "absent" },
    "/workspace/alpha": { exists: true, content: alphaContent, revision: "sha256:alpha1" },
    "/workspace/gone": { exists: false, content: "", revision: "absent", error: "unavailable", message: "项目目录不存在或无法访问" },
  };
  window.fixture = {
    enabled: true,
    failToggle: false,
    calls: [],
    failSave: null,
    projects: [
      { workspace: "/workspace/alpha", name: "alpha", available: true },
      { workspace: "/workspace/gone", name: "gone", available: false },
    ],
    state: files,
  };
  const f = window.fixture;
  const keyFor = (input) => (input.scope === "global" ? "global" : input.workspace);
  const pathFor = (input) => (input.scope === "global" ? "/profile/MEMORY.md" : input.workspace + "/.vela/MEMORY.md");
  const entry = (scope, workspace, name) => {
    const state = scope === "global" ? files.global : files[workspace];
    const exists = state.error ? false : state.exists;
    return {
      scope, workspace, name,
      path: scope === "global" ? "/profile/MEMORY.md" : workspace + "/.vela/MEMORY.md",
      exists,
      status: state.error ? "failed" : exists ? "loaded" : "missing",
      bytes: state.error ? 0 : encoder.encode(state.content).byteLength,
      revision: exists ? state.revision : "absent",
      error: state.error || null,
      message: state.message || null,
    };
  };
  const catalog = () => ({
    enabled: f.enabled,
    global: entry("global", null, ""),
    projects: f.projects.map((project) => entry("project", project.workspace, project.name)),
    workspaces: f.projects.map((project) => ({ ...project })),
    currentProject: "/workspace/alpha",
  });
  const documentFor = (input) => {
    const state = files[keyFor(input)];
    return {
      scope: input.scope,
      workspace: input.scope === "global" ? null : input.workspace,
      path: pathFor(input),
      exists: state.exists,
      content: state.content,
      revision: state.exists ? state.revision : "absent",
    };
  };
  let revision = 1;
  window.vela = {
    uiStorage: (() => {
      const store = new Map();
      return {
        getItem: (key) => (store.has(key) ? store.get(key) : undefined),
        setItem: (key, value) => { store.set(key, value); },
        removeItem: (key) => { store.delete(key); },
      };
    })(),
    openInTarget: async () => undefined,
    memory: {
      setEnabled: async (input) => {
        f.calls.push({ method: "setEnabled", input });
        if (f.holdToggle) await new Promise((resolve) => { f.releaseToggle = resolve; });
        if (f.failToggle) return { ok: false, error: { code: "io-error", message: "toggle failed", path: null } };
        f.enabled = input.enabled;
        return { ok: true, value: { enabled: f.enabled } };
      },
      list: async (input) => { f.calls.push({ method: "list", input }); return { ok: true, value: catalog() }; },
      read: async (input) => {
        f.calls.push({ method: "read", input });
        const state = files[keyFor(input)];
        if (state.error) return { ok: false, error: { code: state.error, message: state.message, path: pathFor(input) } };
        return { ok: true, value: documentFor(input) };
      },
      save: async (input) => {
        f.calls.push({ method: "save", input });
        if (f.failSave) return { ok: false, error: f.failSave };
        const state = files[keyFor(input)];
        state.exists = true;
        state.error = undefined;
        state.content = input.content;
        state.revision = "sha256:rev" + (++revision);
        return { ok: true, value: documentFor(input) };
      },
      remove: async (input) => {
        f.calls.push({ method: "remove", input });
        const state = files[keyFor(input)];
        if (!state.exists || state.revision !== input.expectedRevision) {
          return { ok: false, error: { code: "conflict", message: "版本不一致", path: pathFor(input) } };
        }
        state.exists = false;
        state.content = "";
        state.revision = "absent";
        return { ok: true, value: null };
      },
    },
  };
})();
`;

if (!process.versions.electron) {
  const temp = mkdtempSync(join(tmpdir(), "vela-memory-ui-"));
  try {
    const { build } = await import("esbuild");
    await build({
      stdin: {
        contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { MemorySettingsSection } from './apps/desktop/src/renderer/components/MemorySettingsSection';
      const root = createRoot(document.getElementById('root'));
      window.renderMemory = (locale) => root.render(<MemorySettingsSection locale={locale} conversationId="chat-a" />);
      window.unmountMemory = () => root.render(null);
      window.renderMemory('en');
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
        '</style></head><body><div id="root" style="padding:24px;max-width:800px;overflow:auto;height:100vh"></div><script>' +
        mockScript +
        '</script><script src="ui.js"></script></body></html>',
    );
    const env = { ...process.env, VELA_MEMORY_UI_TEMP: temp };
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
    assert.equal(code, 0, "Memory renderer behavior checks failed");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
} else {
  const { app, BrowserWindow } = await import("electron");
  app.setPath("userData", join(process.env.VELA_MEMORY_UI_TEMP, "profile"));
  void app.whenReady().then(async () => {
    const win = new BrowserWindow({
      show: false,
      width: 1000,
      height: 1000,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    try {
      await win.loadFile(join(process.env.VELA_MEMORY_UI_TEMP, "index.html"));
      const evaluate = (code) => win.webContents.executeJavaScript(code);
      const until = async (code) => {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          if (await evaluate(code)) return;
          await new Promise((res) => setTimeout(res, 20));
        }
        throw new Error("Timed out: " + code);
      };
      const click = (label, scope = "document") =>
        evaluate(`Array.from(${scope}.querySelectorAll('button')).find(node => node.textContent === ${JSON.stringify(label)}).click()`);
      const fill = (value, scope = "document.querySelector('.memory-editor-input')") =>
        evaluate(
          "(() => { const control = " + scope + ";" +
          "Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(control," + JSON.stringify(value) + ");" +
          "control.dispatchEvent(new Event('input',{bubbles:true}));return control.value; })()",
        );

      await until("document.querySelectorAll('.memory-entry').length === 3");
      assert.deepEqual(await evaluate("fixture.calls[0]"), { method: "list", input: { conversationId: "chat-a" } });
      const statuses = await evaluate("Array.from(document.querySelectorAll('.memory-entry')).map(node => node.textContent)");
      assert.ok(statuses[0].includes("Not created; saving will create it"), statuses[0]);
      assert.ok(statuses[1].includes("Saved"), statuses[1]);
      assert.ok(statuses[2].includes("Read failed"), statuses[2]);
      console.log("PASS English list shows global, project and unavailable states");

      // 开关只改变 Agent 权限，不调用删除或保存；等待保存时禁止重复切换。
      assert.equal(await evaluate("document.querySelector('[role=switch]').getAttribute('aria-checked')"), "true");
      await evaluate("fixture.holdToggle = true; document.querySelector('[role=switch]').click()");
      await until("document.querySelector('[role=switch]').disabled");
      await evaluate("document.querySelector('[role=switch]').click(); fixture.releaseToggle(); fixture.holdToggle = false");
      await until("document.querySelector('[role=switch]').getAttribute('aria-checked') === 'false' && !document.querySelector('[role=switch]').disabled");
      assert.equal(await evaluate("fixture.calls.filter(call => call.method === 'setEnabled').length"), 1);
      assert.equal(await evaluate("fixture.calls.filter(call => ['save','remove'].includes(call.method)).length"), 0);
      assert.equal(await evaluate("fixture.state['/workspace/alpha'].content"), "# Alpha\n\n- run tests\n");
      await evaluate("window.unmountMemory()");
      await until("!document.querySelector('.memory-settings')");
      await evaluate("window.renderMemory('en')");
      await until("document.querySelectorAll('.memory-entry').length === 3");
      assert.equal(await evaluate("document.querySelector('[role=switch]').getAttribute('aria-checked')"), "false");
      await evaluate("fixture.failToggle = true; document.querySelector('[role=switch]').click()");
      await until("!!document.querySelector('.memory-toggle-block [role=alert]')");
      assert.equal(await evaluate("document.querySelector('[role=switch]').getAttribute('aria-checked')"), "false");
      await evaluate("fixture.failToggle = false");
      console.log("PASS toggle preserves files, blocks duplicate submission, restores on reopen and reports failure");

      // 打开项目编辑，保存草稿。
      await evaluate("document.querySelectorAll('.memory-entry')[1].click()");
      await until("document.querySelector('.memory-editor-input')?.value === '# Alpha\\n\\n- run tests\\n'");
      assert.ok((await evaluate("document.querySelector('.settings-path').textContent")).includes("/workspace/alpha/.vela/MEMORY.md"));
      await fill("updated\n");
      await click("Save");
      await until("fixture.calls.some(call => call.method === 'save')");
      const save = await evaluate("fixture.calls.find(call => call.method === 'save')");
      assert.deepEqual(save.input, { scope: "project", workspace: "/workspace/alpha", content: "updated\n", expectedRevision: "sha256:alpha1" });
      await until("!!document.querySelector('.memory-editor .settings-path') && !document.querySelector('.memory-editor .memory-error')");
      console.log("PASS project content saves with the read revision");

      // 冲突保留草稿，重新加载丢弃草稿并载入最新内容。
      await fill("conflict draft\n");
      await evaluate("fixture.failSave = { code: 'conflict', message: 'conflict message', path: '/workspace/alpha/.vela/MEMORY.md' }");
      await click("Save");
      await until("!!document.querySelector('.memory-error')");
      assert.equal(await evaluate("document.querySelector('.memory-editor-input').value"), "conflict draft\n");
      assert.ok((await evaluate("document.querySelector('.memory-error').textContent")).includes("draft is kept"));
      await evaluate("fixture.failSave = null");
      await click("Reload");
      await until("document.querySelector('.memory-editor-input')?.value === 'updated\\n'");
      assert.equal(await evaluate("document.querySelectorAll('.memory-error').length"), 0);
      console.log("PASS conflict keeps the draft and reload restores the file");

      // 切换目标再回来，未保存草稿仍在。
      await fill("unfinished\n");
      await click("Global memory", "document.querySelector('.memory-tabs')");
      await until("document.querySelector('.memory-editor-input')?.value === ''");
      await click("Project memory", "document.querySelector('.memory-tabs')");
      await until("document.querySelector('.memory-editor-input')?.value === 'unfinished\\n'");
      console.log("PASS unsaved draft survives scope switches");

      // 清空内容后保存空文档。
      await click("Clear content");
      assert.equal(await evaluate("document.querySelector('.memory-editor-input').value"), "");
      await click("Save");
      await until("document.querySelector('.settings-saved')?.textContent === 'Saved.'");
      const cleared = await evaluate("fixture.calls.filter(call => call.method === 'save').at(-1)");
      assert.equal(cleared.input.content, "");
      console.log("PASS clearing content saves an empty document");

      // 删除文件：两步确认，删除后回到缺失状态。
      await click("Delete file");
      await until("!!document.querySelector('.memory-confirm')");
      await click("Confirm delete", "document.querySelector('.memory-confirm')");
      await until("fixture.calls.some(call => call.method === 'remove')");
      await until("document.querySelector('.memory-editor-input')?.value === ''");
      assert.ok((await evaluate("document.querySelector('.settings-hint').textContent + document.body.textContent")).includes("Not created"));
      console.log("PASS delete removes the file after confirmation");

      // 项目选择器：显式选择已登记但目录失效的工作区时显示可操作错误。
      await until("!!document.querySelector('.memory-project select')");
      await evaluate(
        "(() => { const select = document.querySelector('.memory-project select');" +
        "Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,'/workspace/gone');" +
        "select.dispatchEvent(new Event('change',{bubbles:true})); })()",
      );
      await until("!!document.querySelector('[role=tabpanel] .settings-error')");
      assert.ok((await evaluate("document.querySelector('[role=tabpanel] .settings-error').textContent")).includes("unavailable"));
      console.log("PASS selecting an unavailable workspace shows the failed state");

      // 缺失的全局记忆：编辑器为空、保存按钮禁用，输入后可保存。
      await click("Global memory", "document.querySelector('.memory-tabs')");
      await until("document.querySelector('.memory-editor-input')?.value === ''");
      assert.equal(await evaluate("document.querySelector('.primary-btn').disabled"), true);
      await fill("global note\n");
      await evaluate("document.querySelector('.memory-editor-input').dispatchEvent(new KeyboardEvent('keydown',{key:'s',metaKey:true,bubbles:true}))");
      await until("fixture.calls.filter(call => call.method === 'save').at(-1)?.input.scope === 'global'");
      const globalSave = await evaluate("fixture.calls.filter(call => call.method === 'save').at(-1)");
      assert.equal(globalSave.input.content, "global note\n");
      assert.equal(globalSave.input.expectedRevision, "absent");
      console.log("PASS Command/Ctrl + S saves the missing global file");

      // 键盘切换标签页。
      await click("All memory", "document.querySelector('.memory-tabs')");
      await until("document.querySelector('.memory-tab.active').textContent === 'All memory'");
      await evaluate("document.querySelector('.memory-tabs').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))");
      await until("document.querySelector('.memory-tab.active').textContent === 'Global memory'");
      await evaluate("document.querySelector('.memory-tabs').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}))");
      await until("document.querySelector('.memory-tab.active').textContent === 'All memory'");
      console.log("PASS arrow keys move between memory tabs");

      // 中文界面文案。
      await evaluate("window.renderMemory('zh-CN')");
      await until("document.querySelector('.memory-tab.active')?.textContent === '全部记忆'");
      const zhText = await evaluate("document.querySelector('.memory-settings').textContent");
      assert.ok(zhText.includes("全部记忆") && zhText.includes("全局记忆") && zhText.includes("项目记忆"));
      assert.ok(zhText.includes("未创建，保存后创建"));
      assert.ok(zhText.includes("关闭后保留已有记忆"));
      await evaluate("document.querySelector('[role=switch]').click()");
      await until("document.querySelector('[role=switch]').getAttribute('aria-checked') === 'true'");
      assert.equal(await evaluate("fixture.enabled"), true);
      console.log("PASS Chinese copy renders for the memory section");

      if (process.env.VELA_MEMORY_UI_CAPTURE) {
        await evaluate("window.renderMemory('zh-CN')");
        await until("document.querySelectorAll('.memory-entry').length === 3 && document.querySelector('[role=switch]').getAttribute('aria-checked') === 'true' && !document.querySelector('[role=switch]').disabled");
        await evaluate("document.querySelector('#root').scrollTop = 0; new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
        await new Promise((resolve) => setTimeout(resolve, 150));
        writeFileSync(join(process.env.VELA_MEMORY_UI_CAPTURE, "memory-settings.png"), (await win.webContents.capturePage()).toPNG());
      }
      app.exit(0);
    } catch (error) {
      console.error(error);
      app.exit(1);
    }
  });
}
