/** Test Centre entry: always build the current source before the real Panel smoke. */
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { build } from "electron-vite";

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(desktopDir);
await build({ configFile: resolve(desktopDir, "electron.vite.config.ts") });
const require = createRequire(import.meta.url);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.VELA_BROWSER_SMOKE_APP_PATH;
const child = spawn(require("electron"), [resolve(desktopDir, "test/browser-electron-smoke.mjs")], {
  cwd: resolve(desktopDir, "../.."), env, stdio: "inherit",
});
process.exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject); child.once("exit", (code) => resolve(code ?? 1));
});
