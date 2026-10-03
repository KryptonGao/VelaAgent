/** Launch the production main/preload/renderer with isolated data, then restart it.
 * Build first. Set VELA_PI_SMOKE_APP_ROOT to an app.asar to check a packaged build.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(resolve(here, '../package.json'));
const appRoot = resolve(process.env.VELA_PI_SMOKE_APP_ROOT || join(here, '..'));
const temporary = mkdtempSync(join(tmpdir(), 'vela-pi-electron-'));
const entry = join(temporary, 'smoke.mjs');
mkdirSync(join(temporary, 'workspace'));
copyFileSync(join(here, 'pi-sdk-smoke-entry.mjs'), entry);
try {
  for (const phase of ['create', 'restore']) {
    const { readFileSync } = await import('node:fs');
    const env = { ...process.env, PI_OFFLINE: '1', VELA_USER_DATA: join(temporary, 'vela'),
      VELA_CWD: join(temporary, 'workspace'), VELA_PI_SMOKE_APP_ROOT: appRoot,
      VELA_PI_SMOKE_TEMP: temporary, VELA_PI_SMOKE_PHASE: phase,
      VELA_PI_SMOKE_CHAT: phase === 'restore' ? readFileSync(join(temporary, 'chat-id'), 'utf8') : '' };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require('electron'), [entry], { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; process.stdout.write(chunk); });
    child.stderr.on('data', chunk => process.stderr.write(chunk));
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 40000);
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    clearTimeout(timer);
    assert.equal(code, 0, 'Electron production smoke failed');
    assert.ok(output.includes('PASS Pi production session ' + phase));
  }
} finally { rmSync(temporary, { recursive: true, force: true }); }
