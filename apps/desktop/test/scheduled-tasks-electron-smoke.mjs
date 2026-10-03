/** Production Main/Preload/Renderer integration, including a real application restart. Build first. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(resolve(here, "../package.json"));
const root = resolve(here, "..");
const temporary = mkdtempSync(join(tmpdir(), "vela-tasks-electron-"));
const entry = join(temporary, "entry.mjs");
for (const path of ["workspace", "other", "vela"]) mkdirSync(join(temporary, path));
writeFileSync(join(temporary, "vela/ui-state.json"), JSON.stringify({ "vela.onboarding.complete": "true", "vela.leftCollapsed": "false" }));
writeFileSync(join(temporary, "vela/models.json"), JSON.stringify({ providers: { "task-smoke": {
  name: "Task smoke", api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", apiKey: "synthetic-test-key",
  models: [{ id: "reasoner", name: "Reasoner", reasoning: true, contextWindow: 32768, maxTokens: 4096 },
    { id: "plain", name: "Plain", reasoning: false, contextWindow: 32768, maxTokens: 4096 }],
} } }));
copyFileSync(join(here, "scheduled-tasks-smoke-entry.mjs"), entry);
try {
  for (const phase of ["create", "restore"]) {
    const env = { ...process.env, PI_OFFLINE: "1", VELA_USER_DATA: join(temporary, "vela"), VELA_CWD: join(temporary, "workspace"),
      VELA_TASK_SMOKE_ROOT: root, VELA_TASK_SMOKE_TEMP: temporary, VELA_TASK_SMOKE_PHASE: phase };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require("electron"), [entry], { env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; process.stdout.write(chunk); });
    child.stderr.on("data", chunk => process.stderr.write(chunk));
    const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 40000);
    const code = await new Promise((done, reject) => { child.once("error", reject); child.once("exit", done); });
    clearTimeout(timer); assert.equal(code, 0, "Scheduled Tasks production smoke failed");
    assert.ok(output.includes(`PASS Scheduled Tasks ${phase}`));
  }
} finally { rmSync(temporary, { recursive: true, force: true }); }
