// Real Electron lock regression: installed + development coexist, duplicate profiles quit.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "../package.json"));
const electron = require("electron");
const temporary = mkdtempSync(join(tmpdir(), "vela-profile-electron-"));
const children = new Set();
// 打包而不是只剥类型：vela-home.ts 依赖工作区包 @vela/shared，临时目录里解析不到。
const { build } = await import("esbuild");
await build({
  entryPoints: [join(here, "../src/main/vela-home.ts")], outfile: join(temporary, "vela-home.mjs"),
  bundle: true, platform: "node", format: "esm", logLevel: "warning",
});
writeFileSync(join(temporary, "entry.mjs"), `
import { app } from "electron";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { configureVelaProfile } from "./vela-home.mjs";
const root = process.env.VELA_PROFILE_SMOKE_ROOT;
const installed = join(root, "Vela");
mkdirSync(installed, { recursive: true });
app.setPath("appData", root);
app.setPath("userData", installed);
app.setPath("sessionData", installed);
const home = configureVelaProfile({
  isPackaged: process.env.VELA_PROFILE_SMOKE_PACKAGED === "1",
  setName: name => app.setName(name),
  getPath: name => app.getPath(name),
  setPath: (name, path) => app.setPath(name, path),
});
const primary = app.requestSingleInstanceLock();
if (!primary) {
  console.log("PROFILE " + JSON.stringify({ primary, home, userData: app.getPath("userData") }));
  app.quit();
} else {
  app.whenReady().then(() => {
    console.log("PROFILE " + JSON.stringify({ primary, home, userData: app.getPath("userData"), sessionData: app.getPath("sessionData") }));
    process.stdin.resume();
    process.stdin.once("data", () => app.quit());
  });
}
`);

async function launch(packaged, override) {
  const env = { ...process.env, VELA_PROFILE_SMOKE_ROOT: temporary, VELA_PROFILE_SMOKE_PACKAGED: packaged ? "1" : "0" };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.VELA_USER_DATA;
  if (override !== undefined) env.VELA_USER_DATA = override;
  const child = spawn(electron, [join(temporary, "entry.mjs")], { env, stdio: ["pipe", "pipe", "pipe"] });
  children.add(child);
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => { children.delete(child); resolve({ code, signal }); });
  });
  let output = "";
  const report = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Electron profile timed out: ${output}`)), 15000);
    child.stdout.on("data", chunk => {
      output += chunk;
      const match = output.match(/^PROFILE (.+)$/m);
      if (match) { clearTimeout(timer); resolve(JSON.parse(match[1])); }
    });
    child.stderr.on("data", chunk => { output += chunk; });
    done.then(() => { clearTimeout(timer); if (!output.includes("PROFILE ")) reject(new Error(output)); }, reject);
  });
  return { child, done, report };
}

async function rejected(packaged, override) {
  const instance = await launch(packaged, override);
  assert.equal(instance.report.primary, false, "same persisted profile must reject a second main process");
  assert.equal((await instance.done).code, 0);
}

try {
  const installed = await launch(true);
  const development = await launch(false);
  assert.equal(installed.report.primary, true);
  assert.equal(development.report.primary, true);
  assert.equal(installed.report.home, join(homedir(), ".vela"));
  assert.equal(development.report.home, join(homedir(), ".vela-dev"));
  assert.notEqual(installed.report.userData, development.report.userData);
  assert.equal(development.report.userData, development.report.sessionData);
  await rejected(true);
  await rejected(false);
  await rejected(false, join(homedir(), ".vela"));
  await rejected(true, join(homedir(), ".vela-dev"));
  const customHome = join(temporary, "custom");
  const custom = await launch(false, customHome);
  assert.equal(custom.report.primary, true);
  await rejected(true, customHome);
  await rejected(false, customHome);
  for (const instance of [installed, development, custom]) {
    instance.child.stdin.end("quit\n");
    assert.equal((await instance.done).code, 0);
  }
  const restart = await launch(false);
  assert.equal(restart.report.primary, true, "development lock is released on exit");
  restart.child.stdin.end("quit\n");
  assert.equal((await restart.done).code, 0);
  console.log("PASS Electron installed/development coexistence, duplicate locks, overrides and restart");
} finally {
  for (const child of children) child.kill("SIGKILL");
  rmSync(temporary, { recursive: true, force: true });
}
