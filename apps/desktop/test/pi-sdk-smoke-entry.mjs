/** Isolated production entry used by pi-sdk-electron-smoke.mjs. */
import assert from 'node:assert/strict';
import { app } from 'electron';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.env.VELA_PI_SMOKE_APP_ROOT;
const data = process.env.VELA_PI_SMOKE_TEMP;
app.setPath('userData', join(data, 'electron-data'));
app.setPath('sessionData', join(data, 'electron-data'));
const require = createRequire(join(root, 'package.json'));
const packaged = root.endsWith('.asar');
const timeout = setTimeout(() => { console.error('FAIL Pi production startup deadline'); app.exit(1); }, 30000);
function packageEntry(name) {
  const packageDir = require.resolve.paths(name).map(path => join(path, name)).find(path => existsSync(join(path, 'package.json')));
  assert.ok(packageDir, 'missing packaged dependency: ' + name);
  if (packaged) assert.ok(packageDir.startsWith(root + '/'), 'dependency escaped the application archive');
  return join(packageDir, 'dist/index.js');
}
try {
  for (const name of ['pi-ai', 'pi-agent-core', 'pi-coding-agent']) {
    const file = packageEntry('@earendil-works/' + name);
    const packageFile = join(file, '../../package.json');
    assert.equal(JSON.parse(readFileSync(packageFile, 'utf8')).version, '1.0.0');
    await import(pathToFileURL(file).href);
  }
  const sdkRequire = createRequire(packageEntry('@earendil-works/pi-coding-agent'));
  const wasm = sdkRequire.resolve('quickjs-wasi/quickjs.wasm');
  assert.ok(await WebAssembly.compile(readFileSync(wasm)));
  assert.ok(existsSync(join(packageEntry('@earendil-works/pi-codemode'), '../runtime/worker.js')));
  assert.ok(existsSync(join(root, 'out/main/browser-repl-worker.mjs')));
  if (packaged) assert.ok(existsSync(wasm.replace('app.asar/', 'app.asar.unpacked/')));
  app.on('browser-window-created', (_event, win) => {
    win.webContents.once('did-finish-load', async () => {
      try {
        const state = await win.webContents.executeJavaScript(`(async () => {
          let state;
          for (let i = 0; i < 100; i++) {
            state = await window.vela.getState();
            if (state.session.status !== 'starting') break;
            await new Promise(resolve => setTimeout(resolve, 20));
          }
          const phase = ${JSON.stringify(process.env.VELA_PI_SMOKE_PHASE)};
          if (phase === 'create') state = await window.vela.createConversation(${JSON.stringify(join(data, 'workspace'))});
          else state = await window.vela.switchConversation(${JSON.stringify(process.env.VELA_PI_SMOKE_CHAT || '')});
          if (state.session.status !== 'ready' || state.session.error) throw new Error(JSON.stringify(state.session));
          const id = state.activeConversationId;
          const modes = [];
          for (const mode of ['plan', 'goal', 'agent']) {
            state = await window.vela.setInteractionMode(mode, id);
            modes.push({ mode: state.session.mode, tools: state.session.tools });
          }
          const catalog = await window.vela.getCatalog();
          if (catalog.providers.some(provider => provider.id === 'typesafe')) throw new Error('classifier-only provider exposed');
          const openai = catalog.providers.find(provider => provider.id === 'openai');
          if (openai.methods.some(method => method.type === 'oauth')) throw new Error('unsupported new login exposed');
          return { id, model: state.session.modelId, modes };
        })()`);
        assert.ok(state.id);
        assert.equal(state.model, null);
        assert.deepEqual(state.modes[0].tools, ['read', 'bash', 'ask_user_question', 'list_scheduled_tasks']);
        assert.ok(state.modes[1].tools.includes('update_goal'));
        assert.ok(state.modes[2].tools.includes('browser_repl'));
        assert.ok(state.modes.every(mode => !mode.tools.includes('codemode') && !mode.tools.includes('tool_search')));
        const stored = JSON.parse(readFileSync(join(data, 'vela', 'conversations.json'), 'utf8'));
        const conversation = stored.conversations.find(item => item.id === state.id);
        assert.ok(existsSync(conversation.sessionFile));
        writeFileSync(join(data, 'chat-id'), state.id);
        clearTimeout(timeout);
        console.log('PASS Pi production session ' + process.env.VELA_PI_SMOKE_PHASE + ' (' + (packaged ? 'asar' : 'build') + ')');
        app.quit();
      } catch (error) { clearTimeout(timeout); console.error(error); app.exit(1); }
    });
  });
  await import(pathToFileURL(join(root, 'out/main/index.mjs')).href);
} catch (error) { clearTimeout(timeout); console.error(error); app.exit(1); }
