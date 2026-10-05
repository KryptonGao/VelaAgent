import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, type TestContext } from 'node:test';
import type { TaskRecipeInput } from '@vela/shared';
import { TeamRecipeLibraries } from '../src/main/task-recipe-team.ts';
import { parseTaskInput } from '../src/main/task-schedule.ts';
import { TaskRecipeService } from '../src/main/task-recipe-service.ts';
const template = (): TaskRecipeInput => ({ name: 'Team task', description: '', tags: [], defaultMode: 'agent', parameters: [], objectiveTemplate: 'Read project', workflowTemplate: 'Review changes', deliverableTemplate: 'Report findings', sourceReference: { conversationId: 'PRIVATE-CHAT', messageId: 'PRIVATE-MESSAGE' } });
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'vela-team-recipes-'))); const workspace = join(root, 'project'); await mkdir(workspace); const config = join(root, 'connections.json'); const file = join(workspace, '.vela/team-task-recipes.json');
  const known = [workspace]; const libraries = new TeamRecipeLibraries(config, () => known); t.after(() => rm(root, { force: true, recursive: true }));
  return { root, workspace, config, file, known, libraries };
}
it('defaults to explicit read access, persists connections, and never publishes private source or runtime settings', async t => {
  const f = await fixture(t); f.libraries.connect(f.workspace, 'read'); assert.throws(() => f.libraries.save(template(), f.workspace), /只读/); await assert.rejects(readFile(f.file));
  f.libraries.connect(f.workspace, 'write'); const recipe = f.libraries.save({ ...template(), sandboxMode: 'full', values: { secret: 'PRIVATE-VALUE' } } as TaskRecipeInput, f.workspace);
  assert.equal(recipe.origin, 'team'); assert.equal(recipe.revision, 1); assert.equal(recipe.sourceReference, undefined); assert.ok(recipe.teamFingerprint);
  const text = await readFile(f.file, 'utf8'); assert.ok(!text.includes('PRIVATE-')); assert.ok(!text.includes('sandboxMode')); assert.ok(!text.includes('teamPermission')); assert.ok(!text.includes('teamWorkspace'));
  const restored = new TeamRecipeLibraries(f.config, () => f.known); assert.equal(restored.list().teams[0]!.permission, 'write'); assert.equal(restored.list().recipes[0]!.id, recipe.id);
  restored.connect(f.workspace, 'read'); assert.equal(restored.list().recipes[0]!.teamPermission, 'read'); assert.throws(() => restored.delete(recipe.id, f.workspace, recipe.teamFingerprint), /只读/);
});
it('version checks and content fingerprints reject stale edits including same-revision external changes', async t => {
  const f = await fixture(t); f.libraries.connect(f.workspace, 'write'); const first = f.libraries.save(template(), f.workspace);
  const noop = f.libraries.save(template(), f.workspace, first.id, 1, first.teamFingerprint); assert.equal(noop.revision, 1);
  const second = f.libraries.save({ ...template(), name: 'Updated' }, f.workspace, first.id, 1, first.teamFingerprint); assert.equal(second.revision, 2);
  assert.throws(() => f.libraries.save(template(), f.workspace, first.id, 1, first.teamFingerprint), /更新/); assert.throws(() => f.libraries.delete(first.id, f.workspace, first.teamFingerprint), /更新/);
  const raw = JSON.parse(await readFile(f.file, 'utf8')); raw.recipes[0].workflowTemplate = 'External edit, revision unchanged'; await writeFile(f.file, JSON.stringify(raw));
  assert.throws(() => f.libraries.save(template(), f.workspace, second.id, 2, second.teamFingerprint), /更新/); assert.equal(JSON.parse(await readFile(f.file, 'utf8')).recipes[0].workflowTemplate, raw.recipes[0].workflowTemplate);
});
it('exclusive writer locks never overwrite or silently remove an uncertain concurrent claim', async t => {
  const f = await fixture(t); f.libraries.connect(f.workspace, 'write'); f.libraries.save(template(), f.workspace); const before = await readFile(f.file, 'utf8'); await writeFile(`${f.file}.lock`, 'Other process');
  assert.throws(() => f.libraries.save(template(), f.workspace), /正在写入/); assert.equal(await readFile(f.file, 'utf8'), before); assert.equal(await readFile(`${f.file}.lock`, 'utf8'), 'Other process');
});
it('bad documents and symlinked storage block only the corresponding team without overwriting', async t => {
  const f = await fixture(t); f.libraries.connect(f.workspace, 'write'); f.libraries.save(template(), f.workspace);
  for (const text of ['bad JSON', '{"schemaVersion":99,"recipes":[]}', '{"schemaVersion":1,"recipes":[{}]}']) {
    await writeFile(f.file, text); assert.ok(f.libraries.list().errors[f.workspace]); assert.throws(() => f.libraries.save(template(), f.workspace)); assert.equal(await readFile(f.file, 'utf8'), text);
  }
  await rm(f.file); const target = join(f.root, 'private.json'); await writeFile(target, '{"schemaVersion":1,"recipes":[]}'); await symlink(target, f.file);
  assert.ok(f.libraries.list().errors[f.workspace]); assert.throws(() => f.libraries.save(template(), f.workspace)); assert.equal(await readFile(target, 'utf8'), '{"schemaVersion":1,"recipes":[]}');
});
it('portable UUIDs retain versions but obtain different identities in separate project clones', async t => {
  const f = await fixture(t); f.libraries.connect(f.workspace, 'write'); const recipe = f.libraries.save(template(), f.workspace);
  const clone = join(f.root, 'clone'); await mkdir(join(clone, '.vela'), { recursive: true }); await writeFile(join(clone, '.vela/team-task-recipes.json'), await readFile(f.file)); f.known.push(clone); f.libraries.connect(clone, 'read');
  const copy = f.libraries.list().recipes.find(r => r.teamWorkspace === clone)!; assert.notEqual(copy.id, recipe.id); assert.equal(copy.revision, 1); assert.equal(copy.id.split('.').at(-1), recipe.id.split('.').at(-1));
  assert.throws(() => f.libraries.connect(f.root, 'write'), /已有/); f.libraries.disconnect(f.workspace); assert.equal(f.libraries.list().recipes.length, 1); assert.ok((await readFile(f.file)).length);
});
it('disappeared projects can be disconnected and corrupt local registrations are never reset', async t => {
  const f = await fixture(t); f.libraries.connect(f.workspace, 'read'); await rm(f.workspace, { recursive: true }); assert.ok(f.libraries.list().errors[f.workspace]); f.libraries.disconnect(f.workspace); assert.equal(f.libraries.list().teams.length, 0);
  await writeFile(f.config, '{"schemaVersion":99,"teams":[]}'); const restored = new TeamRecipeLibraries(f.config, () => f.known); assert.ok(restored.list().errors.connections);
  await mkdir(f.workspace); assert.throws(() => restored.connect(f.workspace, 'read'), /不兼容/); assert.equal(await readFile(f.config, 'utf8'), '{"schemaVersion":99,"teams":[]}');
});
it('shared templates integrate with personal history and retain snapshots after deletion or disconnect', async t => {
  const f = await fixture(t); const service = new TaskRecipeService(join(f.root, 'recipes.json'), { workspaces: () => f.known, runningWorkspaces: () => [], resolveExecution: async () => ({ model: { provider: 'fixture', id: 'fixture' }, thinkingLevel: 'off', sandboxMode: 'ask' }), create: async () => {}, submit: async () => ({ status: 'responded' }) }); service.init();
  service.connectTeam(f.workspace, 'write'); const recipe = service.saveTeam(template(), f.workspace); const draft = { recipeSnapshot: recipe, workspace: f.workspace, values: {}, additionalInstructions: '', mode: 'agent' as const }; const preview = await service.preview(draft);
  assert.deepEqual(preview.errors, {}); const { randomUUID } = await import('node:crypto'); const run = await service.start({ requestId: randomUUID(), draft, fingerprint: preview.fingerprint }); await service.waitForRun(run.id); service.rateRun(run.id, 'accepted', 'PRIVATE-ASSESSMENT');
  service.delete(recipe.id, recipe.teamFingerprint); service.disconnectTeam(f.workspace); assert.equal(service.list().runs[0]!.recipeSnapshot.origin, 'team'); assert.equal(service.list().runs[0]!.outcome!.note, 'PRIVATE-ASSESSMENT'); assert.equal((await service.preview(draft)).errors.preview, undefined);
  assert.ok(!(await readFile(f.file, 'utf8')).includes('PRIVATE-')); service.stop();
});

it('team snapshots and structured stages survive schedule binding without publishing client permissions', async t => {
  const f = await fixture(t); f.libraries.connect(f.workspace, 'write'); const recipe = f.libraries.save({ ...template(), stages: [{ id: 'review', name: 'Review', instructions: 'Read', sideEffect: 'read_only', retryLimit: 1, approvalRequired: true }] }, f.workspace);
  const task = parseTaskInput({ title: 'Team binding', workspace: f.workspace, prompt: 'Recipe', schedule: { kind: 'daily', time: '23:59', timezone: 'UTC' }, recipeBinding: { recipeSnapshot: recipe, versionPolicy: 'fixed', values: {}, additionalInstructions: '', mode: 'agent' } });
  assert.equal(task.recipeBinding!.recipeSnapshot.origin, 'team'); assert.equal(task.recipeBinding!.recipeSnapshot.teamWorkspace, recipe.teamWorkspace); assert.deepEqual(task.recipeBinding!.recipeSnapshot.stages, recipe.stages);
  assert.equal(task.recipeBinding!.recipeSnapshot.teamPermission, undefined); assert.equal(task.recipeBinding!.recipeSnapshot.teamFingerprint, undefined);
});
