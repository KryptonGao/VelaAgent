/** Real-Electron checks for Intelligent UI: node apps/desktop/test/intelligent-ui-ui.mjs */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(resolve(here, "../package.json"));

const nd = lines => lines.join("\n");
const fence = lines => `\`\`\`vela-ui\n${nd(lines)}\n\`\`\``;
const billSplit = [
  '{"op":"begin","id":"split","version":1,"title":"账单平摊"}',
  '{"op":"state","name":"amount","kind":"number","initial":240,"min":0}',
  '{"op":"state","name":"people","kind":"number","initial":5,"min":1}',
  '{"op":"node","id":"root","type":"column","props":{}}',
  '{"op":"node","id":"a","parent":"root","type":"number_input","props":{"label":"总额","unit":"元","bind":"amount"}}',
  '{"op":"node","id":"p","parent":"root","type":"number_input","props":{"label":"人数","bind":"people"}}',
  '{"op":"node","id":"t","parent":"root","type":"stat","props":{"label":"每人金额","unit":"元","digits":2,"derive":{"op":"round","args":[{"op":"divide","args":[{"ref":"amount"},{"ref":"people"}]},2]}}}',
  '{"op":"node","id":"go","parent":"root","type":"button","props":{"label":"按这个人数继续","variant":"primary","action":{"type":"submit_to_agent","text":"按当前人数继续规划","include":["people"]}}}',
  '{"op":"commit"}',
];
const compare = [
  '{"op":"begin","id":"cmp","version":1,"title":"模型比较"}',
  '{"op":"state","name":"tier","kind":"string","initial":"all","options":["all","fast","cheap"]}',
  '{"op":"node","id":"root","type":"column","props":{}}',
  '{"op":"node","id":"seg","parent":"root","type":"segmented","props":{"bind":"tier","label":"类型","options":[{"value":"all","label":"全部"},{"value":"fast","label":"快"},{"value":"cheap","label":"便宜"}]}}',
  '{"op":"node","id":"tbl","parent":"root","type":"table","props":{"caption":"费用与速度","searchable":true,"filter":{"bind":"tier","column":"tier","allValue":"all"},"columns":[{"key":"name","label":"模型"},{"key":"tier","label":"类型"},{"key":"price","label":"价格","align":"right","sortable":true,"prefix":"$","digits":2},{"key":"speed","label":"速度","align":"right","sortable":true,"unit":"t/s"}],"rows":[{"name":"Alpha","tier":"fast","price":15,"speed":120,"detail":"**适合**交互场景"},{"name":"Beta","tier":"cheap","price":1.5,"speed":60},{"name":"Gamma","tier":"cheap","price":0.5,"speed":30,"detail":"批处理"}],"source":{"label":"厂商定价页","url":"https://example.com/pricing"}}}',
  '{"op":"commit"}',
];
const hostile = [
  '{"op":"begin","id":"evil","version":1}',
  '{"op":"node","id":"root","type":"column","props":{}}',
  '{"op":"node","id":"x","parent":"root","type":"text","props":{"text":"<img src=x onerror=\\"window.__pwned=1\\"><script>window.__pwned=2</script> [点我](javascript:window.__pwned=3) **粗体**"}}',
  '{"op":"node","id":"y","parent":"root","type":"iframe","props":{"src":"https://evil.example"}}',
  '{"op":"node","id":"z","parent":"root","type":"button","props":{"label":"危险","action":{"type":"open_external","url":"javascript:window.__pwned=4"}}}',
  '{"op":"node","id":"ok","parent":"root","type":"text","props":{"text":"其余内容仍然显示"}}',
  '{"op":"commit"}',
];

if (!process.versions.electron) {
  const temporary = mkdtempSync(join(tmpdir(), "vela-intelligent-ui-"));
  try {
    const { build } = await import("esbuild");
    await build({
      stdin: {
        contents: `
          import React from 'react';
          import { createRoot } from 'react-dom/client';
          import { AssistantMarkdown } from './apps/desktop/src/renderer/components/intelligent-ui/AssistantMarkdown';
          import { UiHostProvider } from './apps/desktop/src/renderer/components/intelligent-ui/UiRuntime';
          import { setActiveLocale } from './apps/desktop/src/renderer/locale';
          setActiveLocale('zh-CN');
          window.submitted = [];
          const root = createRoot(document.getElementById('root'));
          window.renderMessage = (text, { streaming = false, conversationId = 'c1', ordinal = 'u0', busy = false } = {}) => root.render(
            <UiHostProvider value={{ conversationId, stableMessageId: () => ordinal, canSubmit: true, agentBusy: busy,
              submit: async text => { window.submitted.push(text); }, openLink: () => false }}>
              <div className="agent-reply-prose" style={{ maxWidth: 640 }}><AssistantMarkdown messageId="m1" text={text} streaming={streaming} /></div>
            </UiHostProvider>);
          window.unmount = () => root.render(null);
        `,
        resolveDir: resolve(here, "../../.."), loader: "tsx",
      },
      bundle: true, platform: "browser", format: "iife", jsx: "automatic",
      outfile: join(temporary, "ui.js"), loader: { ".svg": "dataurl" },
      alias: { "@vela/shared": resolve(here, "../../../packages/shared/src/index.ts") },
      define: { "process.env.NODE_ENV": '"development"' },
    });
    writeFileSync(join(temporary, "fixtures.json"), JSON.stringify({ billSplit, compare, hostile }));
    writeFileSync(join(temporary, "index.html"), '<!doctype html><html data-scheme="light"><head><meta charset="utf-8"><style>' +
      readFileSync(join(here, "../src/renderer/styles.css"), "utf8") + readFileSync(join(here, "../src/renderer/components/intelligent-ui/intelligent-ui.css"), "utf8") +
      '</style></head><body><div id="root" style="padding:16px"></div><script src="ui.js"></script></body></html>');
    const env = { ...process.env, VELA_IUI_TEMP: temporary };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require("electron"), [fileURLToPath(import.meta.url)], { env, stdio: "inherit" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 60000);
    try {
      const code = await new Promise((done, reject) => { child.once("error", reject); child.once("exit", done); });
      assert.equal(code, 0, "Intelligent UI interaction checks failed");
    } finally { clearTimeout(timer); }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
} else {
  const { app, BrowserWindow } = await import("electron");
  const temp = process.env.VELA_IUI_TEMP;
  app.setPath("userData", join(temp, "profile"));
  void app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, width: 760, height: 900, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    try {
      await win.loadFile(join(temp, "index.html"));
      const fixtures = JSON.parse(readFileSync(join(temp, "fixtures.json"), "utf8"));
      const fence = lines => "```vela-ui\n" + lines.join("\n") + "\n```";
      const evaluate = async code => {
        try { return await win.webContents.executeJavaScript(code); }
        catch (error) { console.error(`Renderer check failed: ${code}`); throw error; }
      };
      const frame = () => new Promise(done => setTimeout(done, 60));
      const until = async code => {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          if (await evaluate(code)) return;
          await new Promise(done => setTimeout(done, 20));
        }
        throw new Error(`Timed out: ${code}`);
      };
      const render = async (text, options = {}) => { await evaluate(`window.renderMessage(${JSON.stringify(text)}, ${JSON.stringify(options)})`); await frame(); };
      const capture = async name => {
        if (!process.env.VELA_IUI_CAPTURE) return;
        mkdirSync(process.env.VELA_IUI_CAPTURE, { recursive: true });
        writeFileSync(join(process.env.VELA_IUI_CAPTURE, `${name}.png`), (await win.webContents.capturePage()).toPNG());
      };
      const typeInto = (label, value) => evaluate(`(() => {
        const input = Array.from(document.querySelectorAll('.iui-field, .iui-table-tools')).find(field => field.querySelector('.iui-label').textContent === ${JSON.stringify(label)}).querySelector('input');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      const stat = () => evaluate("document.querySelector('.iui-stat-value').textContent.trim()");
      const clickText = (selector, text) => evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(el => el.textContent.trim() === ${JSON.stringify(text)}).click()`);

      // 1. Plain answers do not grow a card.
      await render("只需要一句命令：`pnpm test`");
      assert.equal(await evaluate("document.querySelectorAll('.iui-frame').length"), 0);

      // 2. Markdown → UI → Markdown, streamed in odd chunks; validated nodes appear before commit.
      const text = `先看结果。\n\n${fence(fixtures.billSplit)}\n\n每人 48 元。`;
      const cut = text.indexOf('"id":"p"') + 12;
      await render(text.slice(0, cut), { streaming: true });
      assert.equal(await evaluate("document.querySelectorAll('.iui-frame').length"), 1);
      assert.equal(await evaluate("document.querySelector('.iui-frame').getAttribute('aria-busy')"), "true");
      assert.equal(await evaluate("document.querySelectorAll('.iui-number').length"), 1, "first input visible before the block is complete");
      await render(text.slice(0, text.indexOf('{"op":"commit"}')), { streaming: true });
      assert.equal(await evaluate("document.querySelectorAll('.iui-number').length"), 2);
      assert.equal(await stat(), "48.00 元", "derived value computes before commit");
      // The user starts editing while the model is still writing.
      await typeInto("人数", "8");
      assert.equal(await stat(), "30.00 元");
      await evaluate("document.querySelectorAll('.iui-number')[1].focus()");
      await render(text, { streaming: true });
      await render(text, { streaming: false });
      assert.equal(await evaluate("document.querySelectorAll('.iui-number')[1].value"), "8", "input is not reset by commit");
      assert.equal(await evaluate("document.activeElement === document.querySelectorAll('.iui-number')[1]"), true, "focus is not stolen or lost");
      assert.equal(await stat(), "30.00 元");
      assert.deepEqual(await evaluate("Array.from(document.querySelector('.agent-reply-prose').children).map(el => el.className.includes('iui-frame') ? 'ui' : 'md')"), ["md", "ui", "md"]);
      await capture("calculator-light");

      // 3. Invalid input becomes a readable message, never Infinity or a crash.
      await typeInto("人数", "0");
      assert.match(await stat(), /请先修正输入/);
      assert.equal(await evaluate("document.querySelector('.iui-field-error').textContent.includes('不能小于 1')"), true);
      assert.equal(await evaluate("document.querySelectorAll('.iui-number')[1].getAttribute('aria-invalid')"), "true");
      assert.equal(await evaluate("!document.body.textContent.includes('Infinity')"), true);
      await typeInto("人数", "");
      assert.match(await stat(), /请先修正输入/);
      await typeInto("人数", "5");
      assert.equal(await stat(), "48.00 元");
      await typeInto("总额", "100"); await typeInto("人数", "3");
      assert.equal(await stat(), "33.33 元");

      // 4. Submitting needs an explicit click + confirmation; local edits never send anything.
      assert.deepEqual(await evaluate("window.submitted"), []);
      await clickText(".iui-button", "按这个人数继续");
      assert.equal(await evaluate("document.querySelector('.iui-confirm-text').textContent.includes('人数 (people): 3')"), true);
      assert.equal(await evaluate("document.querySelector('.iui-confirm-text').textContent.includes('总额')"), false, "include limits the snapshot");
      assert.deepEqual(await evaluate("window.submitted"), []);
      await clickText(".iui-confirm .iui-button", "取消");
      assert.equal(await evaluate("document.querySelector('.iui-confirm')"), null);
      await clickText(".iui-button", "按这个人数继续"); await clickText(".iui-confirm .iui-button", "发送");
      assert.equal(await evaluate("window.submitted.length"), 1);
      assert.match(await evaluate("window.submitted[0]"), /^按当前人数继续规划\n\nCurrent parameters \[账单平摊\]:\n- 人数 \(people\): 3$/);

      // 5. Persistence: remount at the same stable position restores the edits; a different conversation does not.
      await evaluate("window.unmount()"); await frame();
      await new Promise(done => setTimeout(done, 500));
      await render(text);
      assert.equal(await evaluate("document.querySelectorAll('.iui-number')[1].value"), "3");
      assert.equal(await evaluate("document.querySelectorAll('.iui-number')[0].value"), "100");
      await render(text, { conversationId: "c2" });
      assert.equal(await evaluate("document.querySelectorAll('.iui-number')[1].value"), "5");
      // Same position but the definition was rewritten (edit & resend): the old snapshot is discarded.
      await render(text.replace('"initial":240', '"initial":999'), { conversationId: "c1" });
      assert.equal(await evaluate("document.querySelectorAll('.iui-number')[0].value"), "999");

      // 6. Comparison table: sort, search, filter (no submission), expand, keyboard.
      await render(fence(fixtures.compare));
      const rows = () => evaluate("Array.from(document.querySelectorAll('.iui-table tbody tr:not(.iui-detail-row)')).map(tr => tr.querySelector('td:nth-child(2)').textContent)");
      assert.deepEqual(await rows(), ["Alpha", "Beta", "Gamma"]);
      await clickText(".iui-sort", "价格 ↕");
      assert.deepEqual(await rows(), ["Gamma", "Beta", "Alpha"]);
      assert.equal(await evaluate("document.querySelector('th[aria-sort=ascending]').textContent.includes('价格')"), true);
      await clickText(".iui-sort", "价格 ↑升序");
      assert.deepEqual(await rows(), ["Alpha", "Beta", "Gamma"]);
      await clickText(".iui-segment", "便宜");
      assert.deepEqual(await rows(), ["Beta", "Gamma"]);
      await typeInto("搜索", "gam");
      assert.deepEqual(await rows(), ["Gamma"]);
      await typeInto("搜索", "");
      await clickText(".iui-segment", "全部");
      await evaluate("document.querySelector('.iui-expand').click()");
      assert.equal(await evaluate("document.querySelector('.iui-detail-row strong').textContent"), "适合");
      assert.equal(await evaluate("document.querySelector('.iui-expand').getAttribute('aria-expanded')"), "true");
      assert.match(await evaluate("document.querySelector('.iui-source').textContent"), /来源: 厂商定价页 · 未验证/);
      assert.equal(await evaluate("window.submitted.length"), 1, "filtering and sorting never submit");
      // Roving arrow keys inside the segmented control.
      await evaluate("document.querySelector('.iui-segment.is-selected').focus()");
      win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Right" }); win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Right" });
      await frame();
      assert.equal(await evaluate("document.querySelector('.iui-segment.is-selected').textContent"), "快");
      assert.deepEqual(await rows(), ["Alpha"]);
      await capture("compare-light");

      // 7. Hostile content stays inert; unknown components degrade locally.
      await render(fence(fixtures.hostile));
      assert.equal(await evaluate("window.__pwned"), undefined);
      assert.equal(await evaluate("document.querySelector('.iui-frame img, .iui-frame script, .iui-frame iframe')"), null);
      assert.equal(await evaluate("document.querySelector('.iui-text').textContent.includes('<img src=x')"), true);
      assert.equal(await evaluate("document.querySelector('.iui-text a')"), null, "javascript: links are plain text");
      assert.equal(await evaluate("document.querySelector('.iui-text strong').textContent"), "粗体");
      assert.match(await evaluate("document.querySelector('.iui-placeholder').textContent"), /不支持的组件: iframe/);
      assert.equal(await evaluate("document.body.textContent.includes('其余内容仍然显示')"), true);
      // The dangerous link never becomes a confirmation (node was rejected at validation).
      assert.equal(await evaluate("Array.from(document.querySelectorAll('.iui-button')).some(b => b.textContent === '危险')"), false);

      // 8. Broken and oversized blocks fall back to readable text without breaking the rest.
      await render("前文\n\n" + fence(['{"op":"begin","id":"bad","version":1}', "{oops"]) + "\n\n后文");
      assert.match(await evaluate("document.querySelector('.iui-notice-error').textContent"), /无法显示这个界面/);
      assert.equal(await evaluate("document.body.textContent.includes('前文') && document.body.textContent.includes('后文')"), true);
      await clickText(".iui-tool", "查看原始文本");
      assert.equal(await evaluate("document.querySelector('.iui-source-view').textContent.includes('{oops')"), true);
      await render(fence(fixtures.billSplit.slice(0, 5)));
      assert.match(await evaluate("document.querySelector('.iui-notice-warning').textContent"), /生成未完成/);
      assert.equal(await evaluate("document.querySelectorAll('.iui-number').length"), 1, "verified nodes stay visible");

      // 9. A code sample that merely mentions vela-ui is plain code.
      await render("语法示例：\n\n```vela-ui\nnot json\n```\n");
      assert.equal(await evaluate("document.querySelectorAll('.iui-frame').length"), 0);
      assert.equal(await evaluate("document.querySelector('pre code').textContent.includes('not json')"), true);

      // 10. Narrow layout and dark theme: nothing overflows the chat column.
      win.setSize(380, 900);
      await render(fence(fixtures.compare)); await frame();
      assert.equal(await evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1"), true);
      assert.equal(await evaluate("document.querySelector('.iui-table-scroll').scrollWidth >= document.querySelector('.iui-table-scroll').clientWidth"), true);
      await evaluate("document.documentElement.dataset.scheme = 'dark'");
      await capture("compare-dark-narrow");
      await render(text); await frame();
      assert.equal(await evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1"), true);
      await capture("calculator-dark-narrow");

      console.log("PASS intelligent UI: streaming, local state, calculator errors, explicit submit, persistence, table, XSS, fallbacks and narrow layout");
      app.exit(0);
    } catch (error) { console.error(error); app.exit(1); }
  });
}
