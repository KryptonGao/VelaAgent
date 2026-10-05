import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(new URL("../package.json", import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), "vela-browser-auth-"));
let child, timer;
let interrupted;
const grouped = process.platform !== "win32";
const signal = value => {
  if (!child?.pid) return;
  try { if (grouped) process.kill(-child.pid, value); else child.kill(value); }
  catch (error) { if (error.code !== "ESRCH") throw error; }
};
const onInterrupt = () => interrupted?.(130);
const onTerminate = () => interrupted?.(143);
try {
  const entry = join(temporary, "main.mjs");
  await require("esbuild").build({ entryPoints: [join(here, "browser-auth-smoke-entry.mjs")], outfile: entry,
    bundle: true, platform: "node", format: "esm", external: ["electron"] });
  const env = { ...process.env, VELA_AUTH_SMOKE_TEMP: temporary };
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(require("electron"), [entry], { env, stdio: "inherit", detached: grouped });
  process.on("SIGINT", onInterrupt); process.on("SIGTERM", onTerminate);
  process.exitCode = await new Promise((resolve, reject) => {
    interrupted = resolve;
    child.once("error", reject); child.once("exit", code => resolve(code ?? 1));
    timer = setTimeout(() => { console.error("Browser authentication runner timed out"); resolve(1); }, 65000);
  });
} finally {
  clearTimeout(timer); signal("SIGTERM");
  await new Promise(resolve => setTimeout(resolve, 300)); signal("SIGKILL");
  process.removeListener("SIGINT", onInterrupt); process.removeListener("SIGTERM", onTerminate);
  rmSync(temporary, { recursive: true, force: true });
}
