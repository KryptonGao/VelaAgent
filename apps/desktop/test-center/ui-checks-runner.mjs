/**
 * 浏览器 UI 检查驱动(Electron 主进程脚本)。
 * 依次加载 fixture 页面,轮询结果元素,把结果以带前缀的 NDJSON 写到 stdout。
 * 用法: electron ui-checks-runner.mjs <fixtures.json>
 */
import { app, BrowserWindow } from "electron";
import { readFileSync } from "node:fs";
import { inferFixtureStatus, reporterPrefix } from "./protocol.mjs";

const configPath = process.argv[2];
if (!configPath) {
  process.stderr.write("缺少 fixtures 配置文件参数\n");
  process.exit(2);
}
const config = JSON.parse(readFileSync(configPath, "utf8"));
const fixtures = Array.isArray(config.fixtures) ? config.fixtures : [];
const showWindow = process.env.VELA_TEST_CENTER_SHOW === "1";
const consoleLimit = 64 * 1024;
const loadTimeoutMs = 30_000;

let pendingWrites = 0;
function emit(payload) {
  pendingWrites += 1;
  process.stdout.write(`${reporterPrefix}${JSON.stringify(payload)}\n`, () => {
    pendingWrites -= 1;
  });
}

async function flushStdout() {
  const deadline = Date.now() + 3000;
  while (pendingWrites > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function extractFailure(text) {
  const lines = String(text ?? "").split("\n");
  const index = lines.findIndex((line) => /^\s*FAIL\b/.test(line));
  if (index < 0) return "检查失败(页面未给出原因)";
  return lines.slice(index, index + 5).join("\n").trim();
}

const consoleChunks = new Map();

function collectConsole(id, text) {
  if (!id) return;
  const chunks = consoleChunks.get(id) ?? [];
  chunks.push(text);
  let total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  while (total > consoleLimit && chunks.length > 1) {
    total -= chunks.shift().length;
  }
  consoleChunks.set(id, chunks);
}

async function runFixture(window, fixture) {
  const startedAt = Date.now();
  consoleChunks.set(fixture.id, []);
  emit({ type: "fixture:start", id: fixture.id });

  let failure = null;
  try {
    await withTimeout(window.loadURL(fixture.url), loadTimeoutMs, `页面加载超时(${loadTimeoutMs}ms)`);
  } catch (error) {
    failure = `页面加载失败: ${String(error?.message ?? error)}`;
  }

  const deadline = Date.now() + fixture.timeoutMs;
  let sample = { found: false, status: null, text: "" };
  while (!failure && Date.now() < deadline) {
    try {
      sample = await window.webContents.executeJavaScript(
        `(() => {
          const node = document.querySelector(${JSON.stringify(fixture.resultSelector)});
          if (!node) return { found: false, status: null, text: "" };
          return { found: true, status: node.dataset.status ?? null, text: node.textContent ?? "" };
        })()`,
      );
    } catch (error) {
      failure = `读取结果失败: ${String(error?.message ?? error)}`;
      break;
    }
    if (inferFixtureStatus(sample) !== "pending") break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const inferred = failure ? "failed" : inferFixtureStatus(sample);
  if (!failure && inferred === "pending") failure = `等待结果超时(${fixture.timeoutMs}ms)`;
  const status = failure || inferred === "failed" ? "failed" : "passed";

  const consoleText = (consoleChunks.get(fixture.id) ?? []).join("");
  if (consoleText) emit({ type: "fixture:output", id: fixture.id, stream: "console", chunk: consoleText });
  if (sample.text) emit({ type: "fixture:output", id: fixture.id, stream: "stdout", chunk: `${sample.text.trimEnd()}\n` });
  emit({
    type: "fixture:end",
    id: fixture.id,
    status,
    durationMs: Date.now() - startedAt,
    error: failure ? { message: failure } : status === "failed" ? { message: extractFailure(sample.text) } : null,
  });
}

app
  .whenReady()
  .then(async () => {
    app.dock?.hide();
    const window = new BrowserWindow({
      width: 1440,
      height: 960,
      show: showWindow,
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
      },
    });

    let currentId = null;
    window.webContents.on("console-message", (...args) => {
      const details = args[1];
      let level = args[1];
      let message = args[2];
      if (details && typeof details === "object") {
        level = details.level;
        message = details.message;
      }
      if (level === "debug" || level === "info" || level === 0 || level === 1) return;
      collectConsole(currentId, `[console] ${String(message)}\n`);
    });
    window.webContents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
      if (isMainFrame) collectConsole(currentId, `[load] ${code} ${description} ${url}\n`);
    });
    window.webContents.on("render-process-gone", (_event, details) => {
      collectConsole(currentId, `[crash] ${details?.reason ?? "renderer gone"}\n`);
    });
    window.webContents.on("unresponsive", () => {
      collectConsole(currentId, "[hang] 页面无响应\n");
    });

    for (const fixture of fixtures) {
      currentId = fixture.id;
      await runFixture(window, fixture);
      currentId = null;
    }
    await flushStdout();
    app.exit(0);
  })
  .catch(async (error) => {
    emit({ type: "runner:error", message: String(error?.stack ?? error) });
    await flushStdout();
    app.exit(1);
  });
