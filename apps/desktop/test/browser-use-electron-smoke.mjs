/** Run from the repository root: node apps/desktop/test/browser-use-electron-smoke.mjs
 * VELA_SMOKE_WORKER overrides the worker (including an absolute app.asar member).
 * VELA_BROWSER_USE_SMOKE_CAPTURE_DIR retains before/after HMR PNGs.
 * Requires the desktop build's out/main/browser-repl-worker.mjs. This fixture tests
 * real Electron guests/CDP/utility workers; browser-electron-smoke.mjs tests Panel.
 */
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(resolve(here, '../package.json'));
const worker = process.env.VELA_SMOKE_WORKER ? resolve(process.env.VELA_SMOKE_WORKER) : resolve(here, '../out/main/browser-repl-worker.mjs');
// Node cannot stat a member inside app.asar; Electron resolves it at worker launch.
const archiveIndex = worker.indexOf('.asar/');
const checkPath = archiveIndex < 0 ? worker : worker.slice(0, archiveIndex + 5);
if (!existsSync(checkPath)) throw new Error(`Worker artifact missing: ${worker}. Build desktop first: pnpm --filter @vela/desktop build`);
const temporary = mkdtempSync(join(tmpdir(), 'vela-browser-use-'));
let child;
let timer;
let timedOut = false;
const grouped = process.platform !== 'win32';
function signalOwned(signal) {
  if (!child?.pid) return;
  try {
    if (grouped) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) { if (error.code !== 'ESRCH') throw error; }
}
async function cleanupOwned() {
  signalOwned('SIGTERM');
  // The leader can exit before its helpers; always signal the original group.
  await new Promise(resolve => setTimeout(resolve, 300));
  signalOwned('SIGKILL');
}
let interrupt;
const onSignal = signal => {
  process.exitCode = signal === 'SIGINT' ? 130 : 143;
  interrupt?.(process.exitCode);
};
const onInterrupt = () => onSignal('SIGINT');
const onTerminate = () => onSignal('SIGTERM');

try {
  const { build } = require('esbuild');
  const entry = join(temporary, 'main.mjs');
  await build({ entryPoints: [join(here, 'browser-use-smoke-entry.ts')], outfile: entry,
    bundle: true, platform: 'node', format: 'esm', external: ['electron'], target: 'node22' });
  const env = { ...process.env, VELA_SMOKE_TEMP: temporary, VELA_SMOKE_WORKER: worker };
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(require('electron'), [entry], { env, stdio: 'inherit', detached: grouped });
  process.on('SIGINT', onInterrupt); process.on('SIGTERM', onTerminate);
  const code = await new Promise((resolve, reject) => {
    interrupt = resolve;
    child.once('error', reject);
    child.once('exit', code => resolve(timedOut ? 1 : code ?? 1));
    timer = setTimeout(() => {
      timedOut = true;
      console.error('FAIL runner deadline (85s)');
      // Resolve independently of Electron exit/stream closure; finally kills helpers.
      resolve(1);
    }, 85000);
  });
  process.exitCode = Number(code);
} finally {
  clearTimeout(timer);
  try { await cleanupOwned(); }
  finally {
    process.removeListener('SIGINT', onInterrupt); process.removeListener('SIGTERM', onTerminate);
    rmSync(temporary, { recursive: true, force: true });
  }
}
