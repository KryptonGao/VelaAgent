import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { it, type TestContext } from 'node:test';
import { expandRecipe, parseRecipeInput, recipeDefaults, validateRecipe, validateRecipeValues, type RecipeUseDraft, type TaskRecipeInput, type RecipeExecution, type RecipeRun } from '@vela/shared';
import { builtinRecipes } from '../src/main/task-recipe-builtins.ts';
import { TaskRecipeService } from '../src/main/task-recipe-service.ts';
const input = (): TaskRecipeInput => ({ name: 'Repair', description: '', tags: [], defaultMode: 'agent', parameters: [{ id: 'problem', label: 'Problem', type: 'multiline', required: true }], objectiveTemplate: '{{problem}}', workflowTemplate: 'Read {{workspace.path}} then fix', deliverableTemplate: 'Report changes' });
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'vela-recipes-')); const workspace = join(root, 'workspace'); const other = join(root, 'other');
  await mkdir(workspace); await mkdir(other); t.after(() => rm(root, { recursive: true, force: true }));
  let creates = 0, submits = 0; let execution: RecipeExecution = { model: { provider: 'fixture', id: 'test' }, thinkingLevel: 'off', sandboxMode: 'ask' };
  let createHook = async (_run: RecipeRun) => {}; let submitHook = async (_run: RecipeRun): Promise<{ status: 'responded' | 'stopped' | 'failed' }> => ({ status: 'responded' });
  const host = { workspaces: () => [workspace, other], runningWorkspaces: () => [], resolveExecution: async () => structuredClone(execution),
    create: async (run: RecipeRun) => { creates++; await createHook(run); }, submit: async (run: RecipeRun) => { submits++; return submitHook(run); } };
  const file = join(root, 'task-recipes.json'); const service = new TaskRecipeService(file, host); service.init(); const recipe = service.save(input());
  const draft: RecipeUseDraft = { recipeSnapshot: recipe, workspace, values: { problem: 'Bug' }, additionalInstructions: '', mode: 'agent' };
  const start = async (d = draft, requestId = randomUUID()) => { const preview = await service.preview(d); assert.deepEqual(preview.errors, {}); return service.start({ requestId, draft: d, fingerprint: preview.fingerprint }); };
  return { root, workspace, other, file, service, recipe, draft, host, start, counts: () => ({ creates, submits }), setExecution: (value: RecipeExecution) => { execution = value; },
    onCreate: (fn: typeof createHook) => { createHook = fn; }, onSubmit: (fn: typeof submitHook) => { submitHook = fn; } };
}
it('validates defaults, lengths, identifiers, options, unknown references and false without invoking a model', () => {
  const recipe = input(); recipe.parameters.push({ id: 'flag', label: 'Flag', type: 'boolean', required: true, defaultValue: false }, { id: 'choice', label: 'Choice', type: 'select', required: false, options: [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }] });
  assert.deepEqual(validateRecipe(recipe), {}); assert.deepEqual(recipeDefaults(recipe), { flag: false }); assert.deepEqual(validateRecipeValues(recipe, { problem: 'x', flag: false }), {});
  assert.ok(validateRecipeValues(recipe, { problem: ' ', flag: false })['values.problem']); assert.ok(validateRecipeValues(recipe, { problem: 'x', flag: false, choice: 'unknown' })['values.choice']);
  assert.ok(validateRecipeValues(recipe, { problem: ' '.repeat(10001), flag: false })['values.problem']);
  for (const bad of ['', 'workspace', 'CamelCase', 'a'.repeat(41)]) assert.ok(Object.keys(validateRecipe({ ...recipe, parameters: [{ ...recipe.parameters[0], id: bad }] })).length);
  assert.ok(validateRecipe({ ...recipe, parameters: [...recipe.parameters, { ...recipe.parameters[0] }] })['parameters.3.id']);
  assert.ok(validateRecipe({ ...recipe, objectiveTemplate: '{{missing}}' }).objectiveTemplate);
  assert.ok(validateRecipe({ ...recipe, objectiveTemplate: '{{problem' }).objectiveTemplate);
  assert.ok(validateRecipe({ ...recipe, parameters: [{ ...recipe.parameters[1], defaultValue: '' }] })['parameters.0.defaultValue']);
  assert.ok(validateRecipe({ ...recipe, parameters: [{ ...recipe.parameters[2], defaultValue: 'invalid' }] })['parameters.0.defaultValue']);
  assert.ok(validateRecipe({ ...recipe, workflowTemplate: 'x'.repeat(40000) }).workflowTemplate);
  assert.throws(() => parseRecipeInput({ ...recipe, defaultMode: 'goal' }));
});
it('expands values once, preserves shell/quotes/newlines, and renders optional values/boolean/select labels', async t => {
  const f = await fixture(t); const recipe = { ...f.recipe, parameters: [...f.recipe.parameters, { id: 'flag', label: 'Flag', type: 'boolean' as const, required: true }, { id: 'choice', label: 'Choice', type: 'select' as const, required: true, options: [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }] }, { id: 'empty', label: 'Empty', type: 'text' as const, required: false }], objectiveTemplate: '{{problem}} {{flag}} {{choice}} {{empty}}' };
  const injected = `{{workspace.path}}\n'"\x60$(touch never)\x60`;
  const preview = await f.service.preview({ ...f.draft, recipeSnapshot: recipe, values: { problem: injected, flag: false, choice: 'b' } });
  assert.deepEqual(preview.errors, {}); assert.ok(preview.expandedPrompt.includes(`${injected} 否 Beta 未提供`));
  assert.equal(preview.expandedPrompt, expandRecipe(recipe, { problem: injected, flag: false, choice: 'b' }, preview.context!, ''));
});
it('CRUD revisions change only on content changes, duplicates receive new IDs, builtins stay read-only', async t => {
  const f = await fixture(t); assert.equal(f.service.list().recipes.filter(r => r.origin === 'builtin').length, 3);
  const same = f.service.save(input(), f.recipe.id, 1); assert.equal(same.revision, 1);
  const changed = f.service.save({ ...input(), name: 'Updated' }, f.recipe.id, 1); assert.equal(changed.revision, 2);
  assert.throws(() => f.service.save(input(), f.recipe.id, 1), /更新/);
  const copy = f.service.save(changed); assert.notEqual(copy.id, changed.id); assert.equal(copy.revision, 1);
  assert.throws(() => f.service.delete('vela.recipe.bug'), /只读/);
  const before = f.draft.recipeSnapshot; await f.start(); await f.service.drain(); f.service.delete(f.recipe.id);
  assert.deepEqual(f.service.list().runs[0].recipeSnapshot, before); assert.equal(f.service.list().runs[0].status, 'responded');
});
it('paths are resolved by the host, reject escapes/symlinks/type mismatches and recheck after switching workspace', async t => {
  const f = await fixture(t); await writeFile(join(f.workspace, 'a.txt'), 'a'); await symlink(f.other, join(f.workspace, 'escape'));
  const recipe = { ...f.recipe, parameters: [{ id: 'path', label: 'Path', type: 'path' as const, pathKind: 'file' as const, required: true }] , objectiveTemplate: '{{path}}' };
  const d = { ...f.draft, recipeSnapshot: recipe, values: { path: 'a.txt' } };
  assert.deepEqual((await f.service.preview(d)).errors, {});
  for (const path of ['../other', 'escape', '.', '/etc/passwd', 'missing']) assert.ok((await f.service.preview({ ...d, values: { path } })).errors['values.path']);
  assert.ok((await f.service.preview({ ...d, workspace: f.other })).errors['values.path']);
  const preview = await f.service.preview(d); await writeFile(join(f.workspace, 'a.txt'), 'new content');
  await assert.rejects(f.service.start({ requestId: randomUUID(), draft: d, fingerprint: preview.fingerprint }), /变化/);
  assert.equal(f.counts().creates, 0);
});
it('deduplicates simultaneous and repeated requests across restart; rejects reused IDs with different content', async t => {
  const f = await fixture(t); let resolve!: () => void; const gate = new Promise<void>(done => { resolve = done; }); f.onCreate(async () => gate);
  const preview = await f.service.preview(f.draft); const request = { requestId: randomUUID(), draft: f.draft, fingerprint: preview.fingerprint };
  const pending = Array.from({ length: 8 }, () => f.service.start(request)); resolve(); const runs = await Promise.all(pending); await f.service.drain();
  assert.equal(new Set(runs.map(r => r.id)).size, 1); assert.deepEqual(f.counts(), { creates: 1, submits: 1 });
  await assert.rejects(f.service.start({ ...request, draft: { ...request.draft, additionalInstructions: 'different' } }), /不同内容/);
  const restored = new TaskRecipeService(f.file, f.host); restored.init(); assert.equal((await restored.start(request)).id, runs[0].id); assert.deepEqual(f.counts(), { creates: 1, submits: 1 });
});
it('preserves reserved conversation ID and never resubmits after creation failure', async t => {
  const f = await fixture(t); f.onCreate(async () => { throw new Error('creation failure'); }); const run = await f.start();
  assert.equal(run.status, 'failed'); assert.ok(run.conversationId); assert.equal(run.sendIntentAt, null); assert.equal(f.counts().submits, 0);
  const preview = await f.service.preview(f.draft); const retry = await f.service.start({ requestId: run.requestId, draft: f.draft, fingerprint: preview.fingerprint });
  assert.equal(retry.conversationId, run.conversationId); assert.equal(f.counts().creates, 1);
});
it('a claim write failure creates no chat; corrupted/unknown stores remain unchanged and read-only', async t => {
  const f = await fixture(t); const file = join(f.root, 'blocked'); await writeFile(file, 'blocked');
  const failed = new TaskRecipeService(join(file, 'task-recipes.json'), f.host); failed.init();
  await assert.rejects(failed.start({ requestId: randomUUID(), draft: f.draft, fingerprint: 'invalid' })); assert.equal(f.counts().creates, 0);
  for (const raw of ['broken JSON', JSON.stringify({ schemaVersion: 999, recipes: [], runs: [] }), JSON.stringify({ schemaVersion: 1, recipes: [{}], runs: [] })]) {
    await writeFile(f.file, raw); const service = new TaskRecipeService(f.file, f.host); service.init(); assert.ok(service.list().error);
    assert.throws(() => service.save(input())); assert.equal(await readFile(f.file, 'utf8'), raw);
  }
});
it('persists send intent before submission, handles waiting/stop/error, and interrupts unfinished records on restart without replay', async t => {
  const f = await fixture(t); let resolve!: () => void; const gate = new Promise<void>(done => { resolve = done; });
  f.onSubmit(async run => { const stored = JSON.parse(await readFile(f.file, 'utf8')).runs[0]; assert.ok(stored.sendIntentAt); assert.equal(stored.conversationId, run.conversationId); await gate; return { status: 'responded' }; });
  const run = await f.start(); f.service.waiting(run.conversationId, 'approval', true); f.service.waiting(run.conversationId, 'question', true);
  assert.equal(f.service.list().runs[0].status, 'waiting_for_user'); f.service.waiting('', 'approval', false); assert.equal(f.service.list().runs[0].status, 'waiting_for_user'); f.service.waiting('', 'question', false); assert.equal(f.service.list().runs[0].status, 'running');
  const restored = new TaskRecipeService(f.file, f.host); restored.init(); assert.equal(restored.list().runs[0].status, 'interrupted'); assert.ok(restored.list().runs[0].finishedAt); assert.equal(f.counts().submits, 1);
  // The original process is simulated as stopped before its outstanding effect can finish.
  f.service.stop(); resolve(); await f.service.drain(); assert.equal(f.service.list().runs[0].status, 'interrupted');
  const g = await fixture(t); g.onSubmit(async () => ({ status: 'stopped' })); await g.start(); await g.service.drain(); assert.equal(g.service.list().runs[0].status, 'stopped');
});
it('validates builtin Git refs with argv, saves explicit SHAs, and detects HEAD/working-tree changes before effects', async t => {
  const f = await fixture(t); const git = (...args: string[]) => execFileSync('git', ['-C', f.workspace, ...args], { encoding: 'utf8' }).trim();
  assert.ok((await f.service.preview({ ...f.draft, recipeSnapshot: builtinRecipes()[1]!, values: { scope: 'uncommitted' }, mode: 'plan' })).errors.workspace);
  git('init'); git('config', 'user.name', 'Recipe Test'); git('config', 'user.email', 'recipe@example.invalid');
  await writeFile(join(f.workspace, 'file'), 'first'); git('add', 'file'); git('commit', '-m', 'first'); const first = git('rev-parse', 'HEAD');
  await writeFile(join(f.workspace, 'file'), 'second'); git('commit', '-am', 'second'); const second = git('rev-parse', 'HEAD');
  const d = { ...f.draft, recipeSnapshot: builtinRecipes()[1]!, values: { scope: 'refs', start_ref: 'HEAD~1', end_ref: 'HEAD' }, mode: 'plan' as const };
  const preview = await f.service.preview(d); assert.deepEqual(preview.errors, {}); assert.equal(preview.context?.git?.startSha, first); assert.equal(preview.context?.git?.endSha, second);
  assert.ok((await f.service.preview({ ...d, values: { scope: 'refs', start_ref: 'HEAD' } })).errors['values.end_ref']);
  assert.ok((await f.service.preview({ ...d, values: { ...d.values, start_ref: '`touch /tmp/never`' } })).errors['values.start_ref']);
  await writeFile(join(f.workspace, 'file'), 'third'); git('commit', '-am', 'third'); await assert.rejects(f.service.start({ requestId: randomUUID(), draft: d, fingerprint: preview.fingerprint }), /变化/);
  const uncommitted = { ...d, values: { scope: 'uncommitted' } }; const p = await f.service.preview(uncommitted); await writeFile(join(f.workspace, ' untracked'), 'new');
  assert.notEqual((await f.service.preview(uncommitted)).fingerprint, p.fingerprint);
  await writeFile(join(f.workspace, 'file'), 'indexed'); git('add', 'file'); await writeFile(join(f.workspace, 'file'), 'third');
  const indexed = await f.service.preview(uncommitted); assert.deepEqual(indexed.errors, {});
  await writeFile(join(f.workspace, 'file'), 'other index'); git('add', 'file'); await writeFile(join(f.workspace, 'file'), 'third');
  assert.notEqual((await f.service.preview(uncommitted)).fingerprint, indexed.fingerprint);
  const custom = { ...f.draft, values: { problem: 'invalid git ref' } }; assert.deepEqual((await f.service.preview(custom)).errors, {});
});
it('binding write failure retains the reserved chat, becomes interrupted and never submits or recreates', async t => {
  const f = await fixture(t); const originalFile = f.file; const badParent = join(f.root, 'not-a-directory'); await writeFile(badParent, 'blocked');
  let createdId = '';
  f.onCreate(async run => { createdId = run.conversationId; (f.service as unknown as { file: string }).file = join(badParent, 'recipes.json'); });
  const preview = await f.service.preview(f.draft); const request = { requestId: randomUUID(), draft: f.draft, fingerprint: preview.fingerprint };
  const run = await f.service.start(request); assert.equal(run.status, 'interrupted'); assert.equal(run.conversationId, createdId); assert.equal(f.counts().submits, 0);
  assert.equal((await f.service.start(request)).conversationId, createdId); assert.equal(f.counts().creates, 1);
  const restored = new TaskRecipeService(originalFile, f.host); restored.init(); assert.equal(restored.list().runs[0].status, 'interrupted'); assert.equal((await restored.start(request)).conversationId, createdId); assert.equal(f.counts().creates, 1);
});
it('model/default setting changes invalidate the reviewed fingerprint and no effects occur', async t => {
  const f = await fixture(t); const preview = await f.service.preview(f.draft);
  f.setExecution({ model: { provider: 'fixture', id: 'new-model' }, thinkingLevel: 'off', sandboxMode: 'full' });
  await assert.rejects(f.service.start({ requestId: randomUUID(), draft: f.draft, fingerprint: preview.fingerprint }), /变化/); assert.deepEqual(f.counts(), { creates: 0, submits: 0 });
});
it('changes during asynchronous conversation setup stop submission and retain the created conversation for inspection', async t => {
  const f = await fixture(t); f.onCreate(async () => f.setExecution({ model: { provider: 'fixture', id: 'changed' }, thinkingLevel: 'off', sandboxMode: 'ask' }));
  const run = await f.start(); assert.equal(run.status, 'failed'); assert.match(run.error!, /任务未提交/); assert.ok(run.conversationId); assert.equal(run.sendIntentAt, null); assert.equal(f.counts().submits, 0);
});
