/**
 * 依次跑真实 Electron 的渲染层 UI 检查和冒烟测试，汇总结果；任一失败则整体非零退出。
 * 用法：node test/run-electron-suite.mjs <ui|smoke|all> [名字过滤...]
 * smoke 依赖 out/ 下的生产构建，先执行 pnpm build。
 * 这些检查慢且依赖桌面环境，只在 nightly 和发版前跑；PR 上只跑 pnpm test。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");
const require = createRequire(join(appRoot, "package.json"));

// runner：node 表示用系统 Node 启动（脚本自己再拉起 Electron），electron 表示直接在 Electron 里跑。
// skip：已知坏掉的检查，写明原因；修好后删掉这一项，汇总里每次都会列出来。
const suites = {
  ui: [
    { name: "plugins-ui", runner: "node" },
    { name: "mcp-settings-ui", runner: "node" },
    { name: "memory-settings-ui", runner: "node" },
    { name: "chat-actions-ui", runner: "node" },
    { name: "updates-ui", runner: "node" },
  ],
  smoke: [
    { name: "pi-sdk-electron-smoke", runner: "node" },
    { name: "vela-profile-electron-smoke", runner: "node" },
    { name: "browser-electron-smoke", runner: "electron" },
    { name: "browser-auth-electron-smoke", runner: "node" },
    { name: "browser-use-electron-smoke", runner: "node" },
    { name: "mcp-electron-smoke", runner: "node" },
    { name: "scheduled-tasks-electron-smoke", runner: "node" },
    { name: "task-recipes-electron-smoke", runner: "node" },
    { name: "pr-inbox-electron-smoke", runner: "node" },
    { name: "pr-review-response-electron-smoke", runner: "node" },
    { name: "notification-sounds-electron-smoke", runner: "electron" },
    { name: "settings-electron-smoke", runner: "electron" },
    { name: "thinking-blur-electron-smoke", runner: "electron" },
  ],
};
suites.all = [...suites.ui, ...suites.smoke];

const [suiteName = "all", ...filters] = process.argv.slice(2);
const suite = suites[suiteName];
if (!suite) {
  console.error(`未知套件 ${suiteName}，可选：${Object.keys(suites).join(", ")}`);
  process.exit(2);
}
// 显式按名字点到的检查即使标了 skip 也照跑，方便修的时候验证。
const selected = filters.length
  ? suite.filter(({ name }) => filters.some((filter) => name.includes(filter))).map((entry) => ({ ...entry, skip: undefined }))
  : suite;
if (selected.some(({ name }) => name.includes("smoke")) && !existsSync(join(appRoot, "out/main/index.mjs"))) {
  console.error("缺少 out/main/index.mjs，冒烟测试前先执行 pnpm build。");
  process.exit(2);
}

const timeoutMs = Number(process.env.VELA_SUITE_TIMEOUT_MS) || 5 * 60_000;
const electron = require("electron");

function run({ name, runner }) {
  const started = Date.now();
  const command = runner === "electron" ? electron : process.execPath;
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return new Promise((done) => {
    console.log(`\n▶ ${name}`);
    const child = spawn(command, [join(here, `${name}.mjs`)], { cwd: appRoot, env, stdio: "inherit", detached: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // 进程组一起杀，避免脚本拉起的 Electron 残留。
      try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    }, timeoutMs);
    let finished = false;
    const finish = (code, error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      const ok = code === 0 && !timedOut && !error;
      const reason = timedOut ? `超时 ${timeoutMs / 1000}s` : error ? error.message : `退出码 ${code}`;
      console.log(`${ok ? "✔" : "✖"} ${name} (${seconds}s)${ok ? "" : ` — ${reason}`}`);
      done({ name, ok, seconds, reason });
    };
    child.once("error", (error) => finish(null, error));
    child.once("exit", (code, signal) => finish(code ?? signal));
  });
}

const results = [];
const skipped = selected.filter(({ skip }) => skip);
for (const entry of selected) if (!entry.skip) results.push(await run(entry));

const failed = results.filter(({ ok }) => !ok);
console.log(`\n${suiteName}: ${results.length - failed.length}/${results.length} 通过${skipped.length ? `，跳过 ${skipped.length}` : ""}`);
for (const { name, reason } of failed) console.log(`  ✖ ${name} — ${reason}`);
for (const { name, skip } of skipped) console.log(`  ⏭ ${name} — ${skip}`);
process.exit(failed.length ? 1 : 0);
