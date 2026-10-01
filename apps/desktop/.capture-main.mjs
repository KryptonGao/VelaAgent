/* 临时验证:长总结换行时箭头跟在最后一行文字后;12px、无背景加深、折叠朝右展开朝下。用完即删。 */
import { app, BrowserWindow } from "electron";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";

const desktop = import.meta.dirname;
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
setTimeout(() => { console.error("watchdog exit"); process.exit(2); }, 75_000);

const server = await createServer({
  root: desktop,
  configFile: false,
  plugins: [react()],
  resolve: { alias: { "@vela/shared": resolve(desktop, "../../packages/shared/src/index.ts") } },
  optimizeDeps: { entries: ["test/thinking-summary-preview.html"] },
  server: { port: 5187, host: "127.0.0.1" },
});
await server.listen();

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 720, height: 560, show: true, backgroundColor: "#16181d" });
  await win.loadURL("http://127.0.0.1:5187/test/thinking-summary-preview.html");
  await wait(1800);
  const run = (code) => win.webContents.executeJavaScript(code);
  const shot = async (name) => {
    writeFileSync(`/tmp/vela-${name}.png`, (await win.webContents.capturePage()).toPNG());
    console.log("captured", name);
  };

  await run(`document.querySelector('input[type=checkbox]').click()`);
  await run(`window.vela.summarizeThinking = async () => "先检查运行时与模型选择，再验证思考完成和重试逻辑，确认后调整界面。这里需要一段足够长的文字来占满多行，验证换行时右侧不会因为展开图标而提前留空。"`);
  await run(`[...document.querySelectorAll("button")].find((x) => x.textContent.includes("总结")).click()`);
  await wait(1200);
  await run(`[...document.querySelectorAll("button")].find((x) => x.textContent.includes("prose")).click()`);
  await wait(400);
  await shot("prose-long-collapsed");

  const expanded = `document.querySelector(".thinking-block").classList.contains("expanded")`;
  await run(`document.querySelector(".thinking-prose-summary .thinking-prose-text").click()`);
  await wait(450);
  console.log("click text expands:", await run(expanded));
  await shot("prose-long-expanded");

  await server.close();
  app.exit(0);
});
