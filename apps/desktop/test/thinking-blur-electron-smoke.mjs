/** node_modules/.bin/electron apps/desktop/test/thinking-blur-electron-smoke.mjs */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow } from "electron";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

const temporary = mkdtempSync(join(tmpdir(), "vela-thinking-blur-"));
app.setPath("userData", temporary);
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let server;
const watchdog = setTimeout(() => app.exit(1), 45000);

async function run() {
  try {
    server = await createServer({
      root: desktop, configFile: false, plugins: [react()],
      resolve: { alias: { "@vela/shared": resolve(desktop, "../../packages/shared/src/index.ts") } },
      optimizeDeps: { entries: ["test/blur-preview.html"] },
      server: { host: "127.0.0.1", port: 0 },
    });
    await server.listen();
    await app.whenReady();
    const win = new BrowserWindow({ width: 1500, height: 1300, show: false, webPreferences: { backgroundThrottling: false } });
    const errors = [];
    win.webContents.on("console-message", (event) => { if (event.level === "error") errors.push(event.message); });
    const evaluate = (code) => win.webContents.executeJavaScript(code, true);
    await win.loadURL(`http://127.0.0.1:${server.httpServer.address().port}/test/blur-preview.html`);
    for (let i = 0; i < 100; i++) {
      if (await evaluate("document.querySelectorAll('.thinking-scroll-viewport').length === 3")) break;
      await pause(50);
    }
    await pause(400);
    await evaluate(`document.querySelector('.blur-summary-card .tool-card-open').click();
      document.querySelector('.blur-summary-compact .agent-compact-toggle').click()`);
    await pause(300);
    assert.equal(await evaluate("document.querySelectorAll('.thinking-scroll-viewport').length"), 5);
    assert.equal(await evaluate("document.querySelectorAll('.thinking-edge-filter feImage').length"), 0);
    const scroll = async (index, position) => {
      await evaluate(`(() => {
        const v = document.querySelectorAll('.thinking-scroll-viewport')[${index}];
        v.scrollTop = ${position === "end" ? "v.scrollHeight" : position};
        v.dispatchEvent(new Event('scroll'));
      })()`);
      await pause(35);
    };
    const state = (index) => evaluate(`(() => {
      const v = document.querySelectorAll('.thinking-scroll-viewport')[${index}], shell = v.parentElement;
      const floods = shell.querySelectorAll('feFlood');
      return { top: Number(shell.querySelector('.thinking-scroll-fade-top').style.opacity),
        bottom: Number(shell.querySelector('.thinking-scroll-fade-bottom').style.opacity),
        maskTop: Number(floods[0].getAttribute('flood-opacity')), maskBottom: Number(floods[1].getAttribute('flood-opacity')),
        filter: getComputedStyle(v).filter, position: v.scrollTop, max: v.scrollHeight - v.clientHeight,
        height: v.clientHeight, background: getComputedStyle(shell).getPropertyValue('--scroll-fade-background').trim() };
    })()`);
    for (let i = 0; i < 5; i++) {
      const originalFilter = (await state(i)).filter;
      assert.notEqual(originalFilter, "none");
      await scroll(i, 0);
      assert.equal((await state(i)).top, 0);
      assert.equal((await state(i)).bottom, 1);
      await scroll(i, 2);
      assert.ok((await state(i)).top > 0 && (await state(i)).top < 0.03);
      await scroll(i, 12);
      const middle = await state(i);
      assert.equal(middle.top, 0.5);
      assert.equal(middle.maskTop, middle.top);
      assert.equal(middle.maskBottom, middle.bottom);
      await scroll(i, "end");
      assert.equal((await state(i)).bottom, 0);
      assert.equal((await state(i)).filter, originalFilter);
    }
    assert.equal((await state(0)).height, 280);
    assert.equal((await state(3)).height, 320);
    assert.equal((await state(4)).height, 320);
    assert.notEqual((await state(3)).background, (await state(4)).background);
    console.log("PASS shared continuous edge blur in main chat, nested scrollers and real card/compact summaries; layout and backgrounds preserved");

    for (const [index, selector, toggle] of [
      [3, '.blur-summary-card', '.tool-card-open'],
      [4, '.blur-summary-compact', '.agent-compact-toggle'],
    ]) {
      await scroll(index, 200);
      await evaluate(`document.querySelector('${selector} [data-summary-action=append]').click()`);
      await pause(100);
      assert.equal((await state(index)).position, 200);
      await evaluate(`document.querySelector('${selector} [data-summary-action=short]').click()`);
      await pause(100);
      assert.equal((await state(index)).top, 0);
      assert.equal((await state(index)).bottom, 0);
      await evaluate(`document.querySelector('${selector} [data-summary-action=long]').click()`);
      await pause(100);
      await scroll(index, 200);
      await evaluate(`document.querySelector('${selector} ${toggle}').click()`);
      await pause(300);
      await evaluate(`document.querySelector('${selector} ${toggle}').click()`);
      await pause(300);
      const reopened = await state(index);
      assert.equal(reopened.top, 1);
      assert.equal(reopened.bottom, 1);
      assert.equal(reopened.height, 320);
    }
    console.log("PASS card/compact summaries handle content growth, short content and lazy collapse/reopen");

    await evaluate(`(() => {
      window.bottomFlashes = [];
      const bottom = document.querySelector('.blur-main .thinking-scroll-fade-bottom');
      window.blurObserver = new MutationObserver(() => {
        if (Number(bottom.style.opacity) > 0) window.bottomFlashes.push(bottom.style.opacity);
      });
      window.blurObserver.observe(bottom, { attributes: true });
    })()`);
    for (let i = 0; i < 5; i++) {
      await evaluate("document.querySelector('[data-blur-action=append]').click()");
      await pause(50);
      const pinned = await state(0);
      assert.ok(pinned.max - pinned.position < 1);
      assert.equal(pinned.bottom, 0);
    }
    assert.deepEqual(await evaluate("window.bottomFlashes"), []);
    await evaluate("window.blurObserver.disconnect()");
    await scroll(0, 200);
    const readingPosition = (await state(0)).position;
    await evaluate("document.querySelector('[data-blur-action=append]').click()");
    await pause(100);
    assert.equal((await state(0)).position, readingPosition);
    console.log("PASS streaming follows the bottom without flashes and retains the reader's scroll position");

    await evaluate("document.querySelector('[data-blur-action=short]').click()");
    await pause(100);
    assert.equal((await state(0)).top, 0);
    assert.equal((await state(0)).bottom, 0);
    await evaluate("document.querySelector('[data-blur-action=long]').click()");
    await pause(100);
    await scroll(0, 200);
    const beforeResize = (await state(0)).position;
    await evaluate("document.querySelector('.blur-main').style.width = '340px'");
    await pause(100);
    const resized = await state(0);
    // Native scroll anchoring may adjust by a wrapped line; it must not jump to the tail.
    assert.ok(Math.abs(resized.position - beforeResize) < 60);
    assert.ok(resized.max - resized.position > 24);
    const mainPosition = resized.position;
    await evaluate("document.querySelector('.blur-main .time-spent-trigger').click()");
    await pause(240);
    assert.equal((await state(0)).top, 0);
    assert.equal((await state(0)).bottom, 0);
    await evaluate("document.querySelector('.blur-main .time-spent-trigger').click()");
    await pause(240);
    assert.equal((await state(0)).position, mainPosition);
    assert.equal((await state(0)).top, 1);
    assert.equal((await state(0)).bottom, 1);
    console.log("PASS short content, width changes and collapse/reopen keep correct edges and reading position");

    // Pixel checks ensure the filter really paints blur, and keeps central text sharp.
    await evaluate("document.querySelectorAll('.thinking-scroll-fade').forEach(e => e.style.visibility = 'hidden')");
    for (const index of [0, 3, 4]) {
      // macOS may cap the window to the screen height: expose each region before capture.
      await evaluate(`document.querySelectorAll('.thinking-scroll-viewport')[${index}].scrollIntoView({ block: 'center', behavior: 'instant' })`);
      await scroll(index, 200);
      await pause(100);
      const rect = await evaluate(`(() => {
        const box = document.querySelectorAll('.thinking-scroll-viewport')[${index}].getBoundingClientRect();
        return { x: Math.ceil(box.x), y: Math.ceil(box.y), width: Math.floor(box.width), height: Math.floor(box.height) };
      })()`);
      assert.ok(rect.y >= 0 && rect.y + rect.height <= await evaluate('innerHeight'), 'capture region is outside the viewport');
      // Prime the hidden window's backing surface after scrolling.
      await win.webContents.capturePage();
      const blurred = await win.webContents.capturePage(rect);
      await evaluate(`document.querySelectorAll('.thinking-scroll-viewport')[${index}].style.filter = 'none'`);
      await pause(50);
      await win.webContents.capturePage();
      const clear = await win.webContents.capturePage(rect);
      const dimensions = blurred.getSize();
      const a = blurred.toBitmap(), b = clear.toBitmap();
      const difference = (start, end) => {
        let total = 0;
        const rowSize = dimensions.width * 4;
        for (let j = Math.floor(start * dimensions.height) * rowSize; j < Math.floor(end * dimensions.height) * rowSize; j++) total += Math.abs(a[j] - b[j]);
        return total / ((end - start) * dimensions.height * rowSize);
      };
      if (process.env.VELA_BLUR_SCREENSHOT) {
        writeFileSync(`${process.env.VELA_BLUR_SCREENSHOT}.${index}.blurred.png`, blurred.toPNG());
        writeFileSync(`${process.env.VELA_BLUR_SCREENSHOT}.${index}.clear.png`, clear.toPNG());
        console.log(`Pixel differences ${index}:`, difference(0, 0.15), difference(0.4, 0.6), difference(0.85, 1));
      }
      assert.ok(difference(0, 0.15) > 0.1, `viewport ${index}: top filter did not paint`);
      assert.ok(difference(0.85, 1) > 0.1, `viewport ${index}: bottom filter did not paint`);
      assert.ok(difference(0.4, 0.6) < 0.05, `viewport ${index}: central reading area was blurred`);
      if (index === 0 && process.env.VELA_BLUR_SCREENSHOT) writeFileSync(process.env.VELA_BLUR_SCREENSHOT, blurred.toPNG());
      await evaluate(`document.querySelectorAll('.thinking-scroll-viewport')[${index}].style.removeProperty('filter')`);
    }
    assert.deepEqual(errors, []);
    console.log("PASS main chat and card/compact summary pixels blur both edges while keeping the center sharp; no renderer errors");
    win.destroy();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    clearTimeout(watchdog);
    await server?.close();
    app.exit(process.exitCode ?? 0);
  }
}
app.on("will-quit", () => rmSync(temporary, { recursive: true, force: true }));
void run();
