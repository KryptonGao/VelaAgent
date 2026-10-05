import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url)); const require = createRequire(resolve(here, '../package.json'));
const root = resolve(here, '..'); const temporary = mkdtempSync(join(tmpdir(), 'vela-recipes-electron-'));
const entry = join(temporary, 'entry.mjs');
for (const dir of ['workspace', 'other', 'vela']) mkdirSync(join(temporary, dir));
writeFileSync(join(temporary, 'workspace/initial.txt'), 'Committed fixture');
if (process.argv.includes('--slash-recipes')) {
  mkdirSync(join(temporary, 'workspace/.agents/skills/slash-fixture'), {recursive:true});
  writeFileSync(join(temporary, 'workspace/.agents/skills/slash-fixture/SKILL.md'), '---\nname: slash-fixture\ndescription: Slash menu skill fixture\n---\nRead the project.');
}
for (const args of [['init'], ['config', 'user.name', 'Recipe smoke'], ['config', 'user.email', 'recipe@example.invalid'], ['add', '.'], ['commit', '-m', 'base']]) execFileSync('git', ['-C', join(temporary, 'workspace'), ...args], { stdio: 'ignore' });
writeFileSync(join(temporary, 'vela/workspaces.json'), JSON.stringify({ current: join(temporary, 'workspace'), recents: ['workspace', 'other'].map(name => ({ path: join(temporary, name), name, lastUsedAt: Date.now() })) }));
let requests = 0;
const server = createServer(async (req, res) => {
  let raw = ''; for await (const data of req) raw += data; const input = JSON.parse(raw); requests++;
  const last = JSON.stringify(input.messages.findLast(m => m.role === 'user')?.content ?? '');
  if (typeof last === 'string' && last.includes('Current stage: P2 inspect') && last.includes('· attempt 1')) { res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'P2 confirmed synthetic provider failure' } })); return; }
  const plan = JSON.stringify(input.messages).includes('Smoke plan');
  const generation = input.messages.some(message => message.role === 'system' && message.content.includes('reusable task recipe'));
  if (generation) { assert.equal(input.messages.filter(message => message.role === 'user').length, 1); assert.equal(input.messages.find(message => message.role === 'user').content, 'P1 original source only'); assert.equal(input.tools, undefined); }
  const generated = { name: 'AI smoke recipe', description: 'Generated draft', tags: [], defaultMode: 'agent', parameters: [{ id: 'topic', label: 'Topic', type: 'text', required: true, defaultValue: 'Fixture topic' }], objectiveTemplate: '{{topic}}', workflowTemplate: 'Read {{workspace.path}} and report.', deliverableTemplate: 'Report evidence.' };
  const content = generation ? JSON.stringify(generated) : plan ? '<proposed_plan>\n# Recipe smoke plan\n\n## Steps\n1. Read the project.\n2. Validate the focused changes.\n</proposed_plan>' : 'Recipe smoke response';
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const chunk = delta => `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: input.model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`;
  res.write(chunk({ role: 'assistant', content: '' })); res.write(chunk({ content }));
  res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: input.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`); res.end();
}); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
writeFileSync(join(temporary, 'vela/ui-state.json'), JSON.stringify({ 'vela.onboarding.complete': 'true', 'vela.leftCollapsed': 'false' }));
writeFileSync(join(temporary, 'vela/models.json'), JSON.stringify({ providers: { 'recipe-smoke': { name: 'Recipe smoke', api: 'openai-completions', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'synthetic-test-key', models: [{ id: 'fixture', name: 'Fixture', reasoning: false, contextWindow: 32768, maxTokens: 4096 }] } } }));
writeFileSync(join(temporary, 'vela/selection.json'), JSON.stringify({ provider: 'recipe-smoke', modelId: 'fixture', thinkingLevel: 'off', newConversationSelection: 'default' }));
copyFileSync(join(here, 'task-recipes-smoke-entry.mjs'), entry);
try {
  for (const phase of (process.argv.includes('--slash-recipes') ? ['slash-recipes'] : process.argv.includes('--model-filter') ? ['model-filter'] : ['create', 'p1', 'p2', 'restore'])) {
    const before = requests;
    const env = { ...process.env, PI_OFFLINE: '1', VELA_USER_DATA: join(temporary, 'vela'), VELA_CWD: join(temporary, 'workspace'), VELA_RECIPE_SMOKE_ROOT: root, VELA_RECIPE_SMOKE_TEMP: temporary, VELA_RECIPE_SMOKE_PHASE: phase };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require('electron'), [entry], { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true }); let output = '';
    child.stdout.on('data', chunk => { output += chunk; process.stdout.write(chunk); }); child.stderr.on('data', chunk => process.stderr.write(chunk));
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 55000);
    const code = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done); }); clearTimeout(timer);
    assert.equal(code, 0, 'Task Recipes Electron smoke failed'); assert.ok(output.includes(`PASS Task Recipes ${phase}`));
    if (phase === 'create') {
      const store = JSON.parse(readFileSync(join(temporary, 'vela/task-recipes.json'), 'utf8'));
      const first = store.runs[0]; store.runs.push({ ...first, id: 'interrupted-fixture', requestId: 'interrupted-request', status: 'running', finishedAt: null });
      writeFileSync(join(temporary, 'vela/task-recipes.json'), JSON.stringify(store));
      assert.equal(requests - before, 3, 'Each of the three starts should make only one model call');
    } else if (phase === 'p1') assert.equal(requests - before, 3, 'P1 makes one draft, one scheduled and one worktree model call');
    else if (phase === 'p2') { assert.equal(requests - before, 3, 'P2 makes one failed attempt, one explicit retry, and one approved stage call'); const team = readFileSync(join(temporary, 'workspace/.vela/team-task-recipes.json'), 'utf8'); assert.ok(!team.includes('P2 private assessment')); }
    else assert.equal(requests, before, 'Restart must not replay requests');
  }
} finally { await new Promise(resolve => server.close(resolve)); rmSync(temporary, { recursive: true, force: true }); }
