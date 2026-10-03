/** Isolated native Electron entry; imports the patched Pi SDK from the requested build/ASAR. */
import assert from 'node:assert/strict';
import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
const root = process.env.VELA_MCP_SMOKE_APP_ROOT;
const data = process.env.VELA_MCP_SMOKE_TEMP;
const systemNode = process.env.VELA_MCP_SMOKE_NODE;
assert.ok(root && data && systemNode, 'run through mcp-electron-smoke.mjs');
assert.ok(process.versions.electron, 'MCP smoke must run in native Electron');
assert.notEqual(systemNode, process.execPath, 'stdio servers cannot use Electron execPath');
app.setPath('userData', join(data, 'electron-data'));
app.setPath('sessionData', join(data, 'electron-data'));
const require = createRequire(join(root, 'package.json'));
const packaged = root.endsWith('.asar');
const timeout = setTimeout(() => { console.error('FAIL MCP Electron smoke deadline'); app.exit(1); }, 30000);
function packageEntry(name, relative = 'dist/index.js', from = require) {
  const packageDir = from.resolve.paths(name).map(path => join(path, name)).find(path => existsSync(join(path, 'package.json')));
  assert.ok(packageDir, 'missing dependency: ' + name);
  if (packaged) assert.ok(packageDir.startsWith(root + '/'), 'dependency escaped app.asar: ' + name);
  const file = join(packageDir, relative);
  assert.ok(existsSync(file), 'missing package entry: ' + file);
  assert.equal(JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')).version, '1.0.0');
  return file;
}
async function eventually(read, accept, description) {
  const until = Date.now() + 5000;
  let value;
  do {
    value = await read();
    if (accept(value)) return value;
    await delay(10);
  } while (Date.now() < until);
  assert.fail(`${description}: ${JSON.stringify(value)}`);
}
let session;
let controller;
let http;
const outputFiles = [];
async function smoke() {
try {
  await app.whenReady();
  assert.ok(existsSync(join(root, 'out/main/index.mjs')), 'build the production main entry before smoke testing');
  const piEntry = packageEntry('@earendil-works/pi-coding-agent');
  const sdk = await import(pathToFileURL(piEntry).href);
  const { runToolCall } = await import(pathToFileURL(packageEntry('@earendil-works/pi-agent-core')).href);
  const sdkRequire = createRequire(piEntry);
  const transportEntry = packageEntry('@earendil-works/pi-mcp', 'dist/index.js', sdkRequire);
  await import(pathToFileURL(transportEntry).href);
  for (const name of ['createMcpExtension', 'loadMcpConfig', 'validateMcpServerConfig', 'McpOAuthCredentialStore', 'FileAuthStorageBackend'])
    assert.equal(typeof sdk[name], 'function', 'missing patched root API: ' + name);
  const { startMcpHttpFixture } = await import(pathToFileURL(join(data, 'mcp-http-server.mjs')).href);
  http = await startMcpHttpFixture();
  const cwd = join(data, 'workspace');
  const agentDir = join(data, 'agent');
  mkdirSync(agentDir);
  const config = {
    stdio_direct: { command: systemNode, args: [join(data, 'mcp-server.mjs'), 'normal', join(data, 'stdio-direct.trace')], exposure: 'direct', timeout: 4 },
    stdio_deferred: { command: systemNode, args: [join(data, 'mcp-server.mjs'), 'normal', join(data, 'stdio-deferred.trace')], exposure: 'deferred', timeout: 4 },
    http_oauth: { url: `${http.origin}/mcp`, exposure: 'deferred', timeout: 4, oauth: { clientId: 'fixture-client', authServerMetadataUrl: `${http.origin}/metadata` } },
  };
  for (const [name, raw] of Object.entries(config)) assert.equal(typeof sdk.validateMcpServerConfig(name, raw), 'object');
  writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: config }));
  assert.equal(sdk.loadMcpConfig({ agentDir, cwd, projectTrusted: false }).servers.length, 3);
  let readonly = true;
  const changes = [];
  const settingsManager = sdk.SettingsManager.inMemory({});
  const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [sdk.createToolSearchExtension(), sdk.createMcpExtension({ agentDir,
      allowTool: (_entry, raw) => !readonly || raw.annotations?.readOnlyHint === true,
      onController: value => { controller = value; controller.subscribe(snapshot => changes.push(snapshot)); },
    })],
  });
  await loader.reload();
  const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  ({ session } = await sdk.createAgentSession({ cwd, agentDir, resourceLoader: loader, modelRuntime, settingsManager,
    sessionManager: sdk.SessionManager.inMemory(cwd), noTools: 'builtin' }));
  await session.extensionRunner.emit({ type: 'session_start', reason: 'startup' });
  const assistant = { role: 'assistant', api: 'openai-completions', provider: 'fixture', model: 'fixture', content: [], stopReason: 'toolUse', timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  session.agent.state.messages = [assistant];
  const call = (name, args = {}, signal) => name === 'tool_search'
    ? runToolCall({ type: 'toolCall', id: 'smoke-search', name, arguments: args }, { tools: session.agent.state.tools, assistantMessage: assistant,
      context: { messages: session.agent.state.messages, tools: session.agent.state.tools }, signal })
    : session.extensionRunner.createToolContext('smoke-parent', signal).executeTool(name, args, { signal });
  const snapshot = () => controller.getSnapshot();
  const toolName = (server, raw) => snapshot().find(item => item.name === server).tools.find(tool => tool.name === raw).registeredName;
  await eventually(snapshot, all => all.length === 3 && all.filter(server => server.name.startsWith('stdio_')).every(server => server.state === 'connected') && all.find(server => server.name === 'http_oauth')?.state === 'needs-auth', 'initial transport discovery');
  assert.equal(snapshot().find(server => server.name === 'http_oauth').oauth, true);
  assert.equal(snapshot().find(server => server.name === 'http_oauth').authenticated, false);
  assert.equal(snapshot().find(server => server.name === 'stdio_direct').oauth, false);
  assert.ok(session.getActiveToolNames().includes(toolName('stdio_direct', 'read-data')));
  assert.equal(session.getActiveToolNames().includes(toolName('stdio_deferred', 'read-data')), false);
  let callbackRequest;
  await controller.login('http_oauth', { onUrl: value => {
    const auth = new URL(value);
    const callback = new URL(auth.searchParams.get('redirect_uri'));
    callback.searchParams.set('state', auth.searchParams.get('state'));
    callback.searchParams.set('code', 'electron-fixture-code');
    callbackRequest = fetch(callback);
  } });
  assert.equal((await callbackRequest).status, 200);
  assert.equal(snapshot().find(server => server.name === 'http_oauth').state, 'connected');
  assert.equal(snapshot().find(server => server.name === 'http_oauth').authenticated, true);
  assert.match(readFileSync(join(agentDir, 'mcp-auth.json'), 'utf8'), /controller-test-access/);
  assert.equal(JSON.stringify(snapshot()).includes('controller-test-access'), false);
  assert.equal((await call(toolName('stdio_direct', 'read-data'))).isError, false);
  const image = await call(toolName('stdio_direct', 'image_data'));
  assert.equal(image.isError, false, JSON.stringify(image));
  const media = image.result.content.find(block => block.type === 'image');
  assert.ok(media); assert.equal(media.mimeType, 'image/png');
  assert.equal(Buffer.from(media.data, 'base64').subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const large = await call(toolName('stdio_direct', 'large_result'));
  assert.equal(large.isError, false);
  const largePayload = large.result.structuredContent.structuredContent;
  assert.ok(largePayload.size > 48000);
  assert.equal(largePayload.text.length, largePayload.size);
  const fullOutputPath = large.result.details.fullOutputPath;
  assert.ok(fullOutputPath); outputFiles.push(fullOutputPath);
  assert.equal(readFileSync(fullOutputPath, 'utf8'), largePayload.text);
  assert.ok(large.result.content.filter(block => block.type === 'text').map(block => block.text).join('').length < largePayload.size);
  const search = await call('tool_search', { query: 'read HTTP fixture data', limit: 20 });
  assert.equal(search.isError, false, JSON.stringify(search));
  assert.ok(search.result.details.loaded.includes(toolName('http_oauth', 'read-data')));
  assert.ok(search.result.details.loaded.includes(toolName('stdio_deferred', 'read-data')));
  assert.equal(JSON.stringify(search).includes('write_data'), false);
  const httpCall = await call(toolName('http_oauth', 'read-data'));
  assert.equal(httpCall.isError, false);
  assert.match(JSON.stringify(httpCall.result), /HTTP fixture success/);
  for (const server of ['stdio_direct', 'stdio_deferred', 'http_oauth']) {
    assert.equal(snapshot().find(item => item.name === server).resources, 1);
    assert.equal(snapshot().find(item => item.name === server).resourceTemplates, 1);
    const resources = await call('list_mcp_resources', { server });
    assert.equal(resources.isError, false); assert.match(JSON.stringify(resources.result), /fixture:\/\/data/);
    const read = await call('read_mcp_resource', { server, uri: 'fixture://data' });
    assert.equal(read.isError, false); assert.match(JSON.stringify(read.result), /fixture resource/);
  }
  readonly = false; controller.refreshTools();
  assert.ok(session.getActiveToolNames().includes(toolName('stdio_direct', 'write_data')));
  readonly = true; controller.refreshTools();
  assert.equal(session.getActiveToolNames().includes(toolName('stdio_direct', 'write_data')), false);
  assert.ok(session.getActiveToolNames().includes(toolName('http_oauth', 'read-data')), 'policy refresh must preserve a loaded deferred tool');
  const before = changes.length;
  assert.equal((await call(toolName('stdio_direct', 'change_tools'))).isError, false);
  await eventually(() => changes.slice(before), updates => updates.some(all => all.find(server => server.name === 'stdio_direct')?.tools.some(tool => tool.name === 'new_read')), 'tool-change snapshot');
  const abort = new AbortController();
  const pendingResource = call('read_mcp_resource', { server: 'http_oauth', uri: 'fixture://hang' }, abort.signal);
  await eventually(() => http.requests, requests => requests.filter(method => method === 'resources/read').length >= 2, 'pending HTTP resource');
  abort.abort();
  assert.equal((await pendingResource).isError, true);
  const priorCalls = readFileSync(join(data, 'stdio-direct.trace'), 'utf8').split('tools/call').length;
  const hangingTool = call(toolName('stdio_direct', 'hang'));
  await eventually(() => readFileSync(join(data, 'stdio-direct.trace'), 'utf8'), trace => trace.split('tools/call').length > priorCalls, 'pending stdio tool');
  const beforeSuspendConfig = readFileSync(join(agentDir, 'mcp.json'), 'utf8');
  await controller.suspend('stdio_direct');
  assert.equal((await hangingTool).isError, true);
  assert.equal(readFileSync(join(agentDir, 'mcp.json'), 'utf8'), beforeSuspendConfig);
  assert.equal(snapshot().find(server => server.name === 'stdio_direct').suspended, true);
  await controller.reconnect('stdio_direct');
  assert.equal(snapshot().find(server => server.name === 'stdio_direct').state, 'connected');
  const pids = ['stdio-direct.trace', 'stdio-deferred.trace'].map(file => Number(readFileSync(join(data, file), 'utf8').split('\n')[0]));
  assert.equal(await controller.logout('http_oauth'), true);
  assert.equal(snapshot().find(server => server.name === 'http_oauth').state, 'needs-auth');
  assert.equal(snapshot().find(server => server.name === 'http_oauth').authenticated, false);
  assert.equal(readFileSync(join(agentDir, 'mcp-auth.json'), 'utf8').includes('controller-test-access'), false);
  await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
  const closing = controller.close(); assert.equal(controller.close(), closing); await closing;
  assert.deepEqual(snapshot(), []);
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  session.dispose(); session = undefined;
  await http.close(); http = undefined;
  const report = { mode: packaged ? 'asar' : 'build', electron: process.versions.electron, node: process.versions.node,
    systemNode, piEntry, transportEntry, snapshotUpdates: changes.length,
    capabilities: ['stdio-direct', 'stdio-deferred', 'http-oauth', 'tool-search', 'resources', 'policy-refresh', 'tool-change', 'image', 'large-structured-result', 'cancel', 'shutdown'] };
  for (const file of outputFiles) rmSync(file, { force: true });
  writeFileSync(join(data, 'mcp-report.json'), JSON.stringify(report));
  clearTimeout(timeout);
  console.log(`PASS MCP Electron smoke (${report.mode})`);
  app.quit();
} catch (error) {
  console.error(error);
  clearTimeout(timeout);
  try { await controller?.close(); } catch {}
  session?.dispose();
  try { await http?.close(); } catch {}
  for (const file of outputFiles) rmSync(file, { force: true });
  app.exit(1);
}

}
void smoke();
