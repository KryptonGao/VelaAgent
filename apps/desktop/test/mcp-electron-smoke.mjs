/** Native Electron MCP smoke. With VELA_PI_SMOKE_APP_ROOT (or VELA_MCP_SMOKE_APP_ROOT)
 * pointing at app.asar, all Pi code must resolve from that archive. No release/publish step.
 * Run with system Node: node apps/desktop/test/mcp-electron-smoke.mjs
 */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(resolve(here, '../package.json'));
assert.equal(process.versions.electron, undefined, 'launch the smoke with system Node');
const appRoot = resolve(process.env.VELA_MCP_SMOKE_APP_ROOT || process.env.VELA_PI_SMOKE_APP_ROOT || join(here, '..'));
const systemNode = process.env.VELA_MCP_SMOKE_NODE || process.execPath;
assert.equal(execFileSync(systemNode, ['-p', 'Boolean(process.versions.electron)'], { encoding: 'utf8' }).trim(), 'false', 'stdio fixture must use system Node, not Electron');
const temporary = mkdtempSync(join(tmpdir(), 'vela-mcp-electron-'));
const entry = join(temporary, 'mcp-smoke.mjs');
const fixtures = resolve(here, '../../../packages/agent/test/fixtures');
mkdirSync(join(temporary, 'workspace'));
mkdirSync(join(temporary, 'electron-data'));
copyFileSync(join(here, 'mcp-smoke-entry.mjs'), entry);
for (const file of ['mcp-server.mjs', 'mcp-http-server.mjs']) copyFileSync(join(fixtures, file), join(temporary, file));
const env = { ...process.env, PI_OFFLINE: '1', VELA_MCP_SMOKE_APP_ROOT: appRoot,
  VELA_MCP_SMOKE_TEMP: temporary, VELA_MCP_SMOKE_NODE: systemNode };
delete env.ELECTRON_RUN_AS_NODE;
let child;
let timedOut = false;
let timer;
try {
  child = spawn(require('electron'), [entry], { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; process.stdout.write(chunk); });
  child.stderr.on('data', chunk => process.stderr.write(chunk));
  timer = setTimeout(() => {
    timedOut = true;
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  }, 35000);
  const { code, signal } = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  assert.equal(timedOut, false, 'Electron MCP smoke exceeded its deadline');
  assert.equal(code, 0, `Electron MCP smoke failed (${signal || code})`);
  assert.ok(output.includes('PASS MCP Electron smoke'));
  const report = JSON.parse(readFileSync(join(temporary, 'mcp-report.json'), 'utf8'));
  assert.equal(report.mode, appRoot.endsWith('.asar') ? 'asar' : 'build');
  assert.deepEqual(report.capabilities, ['stdio-direct', 'stdio-deferred', 'http-oauth', 'tool-search', 'resources', 'policy-refresh', 'tool-change', 'image', 'large-structured-result', 'cancel', 'shutdown']);
  assert.ok(report.piEntry.startsWith(appRoot.endsWith('.asar') ? appRoot + '/' : resolve(here, '../../../node_modules') + '/'));
  assert.equal(report.systemNode, systemNode);
  console.log(JSON.stringify(report, null, 2));
} finally {
  clearTimeout(timer);
  // On assertion/startup failure, terminate only this smoke's process group and fixture children.
  if (child?.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
  rmSync(temporary, { recursive: true, force: true });
}
