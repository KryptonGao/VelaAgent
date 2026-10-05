import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, type TestContext } from 'node:test';
import type { RecipeRun, RecipeUseDraft, ScheduledTaskInput, SkillCatalog, TaskRecipeInput } from '@vela/shared';
import { parseRecipeInput, validateRecipe } from '@vela/shared';
import { TaskRecipeService } from '../src/main/task-recipe-service.ts';
import { exportRecipeExchange, parseRecipeExchange } from '../src/main/task-recipe-library.ts';
import { ScheduledTaskScheduler } from '../src/main/scheduled-task-service.ts';
import { parseTaskInput } from '../src/main/task-schedule.ts';
import { executeScheduledRecipe } from '../src/main/task-recipe-schedule.ts';
import { createWorktree, removeWorktree } from '../../../packages/workspace/src/git-worktree.ts';
const template = (): TaskRecipeInput => ({ name: 'Reusable task', description: '', tags: [], defaultMode: 'agent', parameters: [{ id: 'issue', label: 'Issue', type: 'text', required: true }], objectiveTemplate: '{{issue}}', workflowTemplate: 'Read {{workspace.path}}', deliverableTemplate: 'Report' });
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'vela-recipes-p1-')); const workspace = join(root, 'workspace'); await mkdir(workspace);
  let creates = 0; let submits = 0; let worktreeCreates = 0; let submit = async (_run: RecipeRun) => ({ status: 'responded' as const });
  let catalog: SkillCatalog = { skillsDir: root, skills: [], diagnostics: [] };
  const host = { workspaces: () => [workspace], runningWorkspaces: () => [], resolveExecution: async () => ({ model: { provider: 'fixture', id: 'fixture' }, thinkingLevel: 'off' as const, sandboxMode: 'ask' as const }),
    skills: async () => structuredClone(catalog), worktreePath: (branch: string) => join(root, 'worktrees', branch.replace('/', '-')),
    createWorktree: async (run: RecipeRun) => { worktreeCreates++; const w = run.worktree!; const result = await createWorktree(w.sourceWorkspace, { branch: w.branch, newBranch: true, startPoint: w.startSha, path: w.path }, join(root, 'worktrees')); if (!result.ok) throw new Error(result.message); },
    removeWorktree: async (run: RecipeRun) => { const result = await removeWorktree(run.worktree!.sourceWorkspace, { path: run.worktree!.path, force: false }, null); if (!result.ok) throw new Error(result.message); },
    create: async (_run: RecipeRun) => { creates++; }, submit: async (run: RecipeRun) => { submits++; return submit(run); } };
  const file = join(root, 'recipes.json'); const service = new TaskRecipeService(file, host); service.init(); const recipe = service.save(template());
  t.after(async () => { service.stop(); await service.drain(); await rm(root, { recursive: true, force: true }); });
  const draft: RecipeUseDraft = { recipeSnapshot: recipe, workspace, values: { issue: 'Investigate' }, additionalInstructions: '', mode: 'agent' };
  const git = (...args: string[]) => execFileSync('git', ['-C', workspace, ...args], { encoding: 'utf8' }).trim();
  const initGit = async () => { git('init'); git('config', 'user.name', 'Recipe'); git('config', 'user.email', 'recipe@example.invalid'); await writeFile(join(workspace, 'tracked.txt'), 'committed'); git('add', '.'); git('commit', '-m', 'base'); };
  const start = async (d = draft) => { const preview = await service.preview(d); assert.deepEqual(preview.errors, {}); return service.start({ requestId: randomUUID(), draft: d, fingerprint: preview.fingerprint }); };
  return { root, workspace, file, host, service, recipe, draft, start, git, initGit, counts: () => ({ creates, submits, worktreeCreates }), catalog: (next: SkillCatalog) => { catalog = next; }, submit: (fn: typeof submit) => { submit = fn; } };
}
it('project libraries preserve revision, isolate same names, and leave personal history after delete', async t => {
  const f = await fixture(t); const project = f.service.save(template(), undefined, undefined, f.workspace);
  assert.equal(project.origin, 'project'); assert.equal(project.revision, 1); assert.notEqual(project.id, f.recipe.id);
  assert.equal(f.service.save(template(), project.id, 1, f.workspace).revision, 1);
  const newer = f.service.save({ ...template(), name: 'Updated' }, project.id, 1, f.workspace); assert.equal(newer.revision, 2);
  assert.throws(() => f.service.save(template(), project.id, 1, f.workspace), /更新/);
  await f.start({ ...f.draft, recipeSnapshot: newer }); await f.service.drain(); f.service.delete(newer.id);
  assert.ok(f.service.list().runs.some(run => run.recipeSnapshot.revision === 2)); assert.ok(f.service.list().recipes.some(r => r.id === f.recipe.id));
  const saved = JSON.parse(await readFile(join(f.workspace, '.vela/task-recipes.json'), 'utf8')); assert.equal(saved.schemaVersion, 1); assert.deepEqual(saved.recipes, []);
});
it('project files are portable, get workspace-scoped identities, and do not trust stored permissions', async t => {
  const f = await fixture(t); const a = f.service.save(template(), undefined, undefined, f.workspace); const second = join(f.root, 'second'); await mkdir(join(second, '.vela'), { recursive: true });
  const raw = JSON.parse(await readFile(join(f.workspace, '.vela/task-recipes.json'), 'utf8')); raw.recipes[0].sandboxMode = 'full'; raw.recipes[0].builtinKind = 'release';
  await writeFile(join(second, '.vela/task-recipes.json'), JSON.stringify(raw)); f.host.workspaces = () => [f.workspace, second];
  const canonical = await realpath(second); const b = f.service.list().recipes.find(r => r.projectWorkspace === canonical)!; assert.notEqual(a.id, b.id); assert.equal((b as any).sandboxMode, undefined); assert.equal(b.builtinKind, undefined);
});
it('unknown or corrupt project data blocks only that project and is never overwritten', async t => {
  const f = await fixture(t); await mkdir(join(f.workspace, '.vela')); const file = join(f.workspace, '.vela/task-recipes.json');
  for (const raw of ['bad json', '{"schemaVersion":999,"recipes":[]}', '{"schemaVersion":1,"recipes":[{}]}']) {
    await writeFile(file, raw); assert.ok(f.service.list().projectErrors![f.workspace]); assert.throws(() => f.service.save(template(), undefined, undefined, f.workspace)); assert.equal(await readFile(file, 'utf8'), raw);
    assert.equal(f.service.list().error, null); assert.ok(f.service.save(template()).id);
  }
});
it('project paths outside known workspaces and symlinked storage are rejected', async t => {
  const f = await fixture(t); assert.throws(() => f.service.save(template(), undefined, undefined, f.root));
  const outside = join(f.root, 'outside'); await mkdir(outside); await symlink(outside, join(f.workspace, '.vela'));
  assert.throws(() => f.service.save(template(), undefined, undefined, f.workspace), /符号链接/); await assert.rejects(readFile(join(outside, 'task-recipes.json')));
});
it('exchange validates every template and returns unsaved drafts with fresh IDs and no execution', async t => {
  const f = await fixture(t); const text = exportRecipeExchange({ ...f.recipe, sourceReference: { conversationId: 'private', messageId: 'private' } });
  const drafts = parseRecipeExchange(text); assert.equal(drafts.length, 1); assert.equal(drafts[0].sourceReference, undefined); assert.ok(!text.includes('private'));
  const copy = f.service.save(drafts[0]!); assert.notEqual(copy.id, f.recipe.id); assert.equal(copy.name, f.recipe.name); assert.equal(copy.revision, 1); assert.deepEqual(f.counts(), { creates: 0, submits: 0, worktreeCreates: 0 });
  for (const value of [{ format: 'other', schemaVersion: 1, recipes: [template()] }, { format: 'vela-task-recipes', schemaVersion: 2, recipes: [template()] }, { format: 'vela-task-recipes', schemaVersion: 1, recipes: [template(), { ...template(), objectiveTemplate: '{{unknown}}' }] }]) assert.throws(() => parseRecipeExchange(JSON.stringify(value)));
  assert.throws(() => parseRecipeExchange('x'.repeat(4_000_001)));
});
it('Skill dependencies list missing/disabled names, preserve caller settings, and invalidate changed content', async t => {
  const f = await fixture(t); const skill = join(f.root, 'SKILL.md'); await writeFile(skill, 'instructions');
  const recipe = f.service.save({ ...template(), requiredSkills: ['review', 'test'] }); const draft = { ...f.draft, recipeSnapshot: recipe };
  assert.match((await f.service.preview(draft)).errors.requiredSkills!, /review.*缺失.*test.*缺失/);
  const catalog: SkillCatalog = { skillsDir: f.root, diagnostics: [], skills: ['review', 'test'].map(name => ({ name, description: '', location: skill, origin: 'user', enabled: name !== 'test', canDelete: false, disableModelInvocation: false })) };
  f.catalog(catalog); assert.match((await f.service.preview(draft)).errors.requiredSkills!, /test.*停用/); catalog.skills[1]!.enabled = true; f.catalog(catalog);
  const preview = await f.service.preview(draft); assert.deepEqual(preview.errors, {}); assert.equal(preview.context!.skills!.length, 2); assert.match(preview.expandedPrompt, /所需 Skill/);
  await writeFile(skill, 'changed'); await assert.rejects(f.service.start({ requestId: randomUUID(), draft, fingerprint: preview.fingerprint }), /变化/); assert.equal(f.counts().creates, 0);
  assert.deepEqual(parseRecipeInput({ ...template(), requiredSkills: ['review'] }).requiredSkills, ['review']); assert.ok(validateRecipe({ ...template(), requiredSkills: ['review', 'review'] }).requiredSkills);
});
it('independent worktree previews exact target/SHA, excludes dirty files, deduplicates, and protects dirty cleanup', async t => {
  const f = await fixture(t); await f.initGit(); const sha = f.git('rev-parse', 'HEAD'); await writeFile(join(f.workspace, 'tracked.txt'), 'dirty'); await writeFile(join(f.workspace, 'untracked.txt'), 'untracked');
  const draft: RecipeUseDraft = { ...f.draft, autoWorktree: { startRef: 'HEAD', branch: 'vela/recipe-test', includeUncommitted: false } }; const preview = await f.service.preview(draft); assert.deepEqual(preview.errors, {});
  assert.equal(preview.context!.worktree!.startSha, sha); assert.match(preview.expandedPrompt, /vela-recipe-test/); await assert.rejects(readFile(join(preview.context!.path, 'tracked.txt')));
  const request = { requestId: randomUUID(), draft, fingerprint: preview.fingerprint }; const run = await f.service.start(request); await f.service.waitForRun(run.id); const again = await f.service.start(request);
  assert.equal(again.id, run.id); assert.equal(run.expandedPrompt, preview.expandedPrompt); assert.equal(await readFile(join(run.workspace, 'tracked.txt'), 'utf8'), 'committed'); await assert.rejects(readFile(join(run.workspace, 'untracked.txt')));
  assert.deepEqual(f.counts(), { creates: 1, submits: 1, worktreeCreates: 1 });
  await writeFile(join(run.workspace, 'tracked.txt'), 'new change'); await assert.rejects(f.service.cleanupWorktree(run.id)); assert.equal(f.service.list().runs[0]!.worktreeRemovedAt, undefined);
  execFileSync('git', ['-C', run.workspace, 'restore', 'tracked.txt']); await f.service.cleanupWorktree(run.id); assert.ok(f.service.list().runs[0]!.worktreeRemovedAt); assert.equal(f.git('rev-parse', 'vela/recipe-test'), sha);
});
it('worktree path parameters are validated against the starting commit rather than dirty source files', async t => {
  const f = await fixture(t); await f.initGit(); await writeFile(join(f.workspace, 'only-dirty'), 'not committed');
  const recipe = f.service.save({ ...template(), parameters: [{ id: 'issue', label: 'Path', type: 'path', pathKind: 'file', required: true }] });
  const draft: RecipeUseDraft = { ...f.draft, recipeSnapshot: recipe, values: { issue: 'tracked.txt' }, autoWorktree: { startRef: 'HEAD', branch: 'vela/recipe-path', includeUncommitted: false } };
  assert.deepEqual((await f.service.preview(draft)).errors, {});
  for (const issue of ['only-dirty', '../outside', '.', 'missing']) assert.ok((await f.service.preview({ ...draft, values: { issue } })).errors['values.issue']);
  await symlink('tracked.txt', join(f.workspace, 'link')); f.git('add', 'link'); f.git('commit', '-m', 'symlink'); assert.ok((await f.service.preview({ ...draft, values: { issue: 'link' } })).errors['values.issue']);
});
it('worktree preflight rejects moved commits and creation failures never submit or retry', async t => {
  const f = await fixture(t); await f.initGit(); const draft: RecipeUseDraft = { ...f.draft, autoWorktree: { startRef: 'HEAD', branch: 'vela/recipe-fail', includeUncommitted: false } };
  const preview = await f.service.preview(draft); f.git('commit', '--allow-empty', '-m', 'moved'); await assert.rejects(f.service.start({ requestId: randomUUID(), draft, fingerprint: preview.fingerprint }), /变化/); assert.equal(f.counts().worktreeCreates, 0);
  f.host.createWorktree = async () => { throw new Error('create failed'); }; const run = await f.start(draft); assert.equal(run.status, 'failed'); assert.equal(run.sendIntentAt, null); assert.ok(run.worktree?.path); assert.equal(f.counts().submits, 0);
  const restored = new TaskRecipeService(f.file, f.host); restored.init(); assert.ok(restored.list().runs[0]!.worktree); assert.equal(f.counts().submits, 0);
});
async function scheduleFixture(t: TestContext) {
  const f = await fixture(t); const scheduler = new ScheduledTaskScheduler(join(f.root, 'scheduled.json'), (task, link, run) => executeScheduledRecipe(f.service, task, link, run)); scheduler.init(); scheduler.start();
  t.after(async () => { scheduler.stop(); await scheduler.drain(); });
  const input = (versionPolicy: 'fixed' | 'latest' = 'fixed'): ScheduledTaskInput => ({ title: 'Recipe', prompt: 'Bound recipe', workspace: f.workspace, schedule: { kind: 'daily', time: '23:59', timezone: 'UTC' }, recipeBinding: { recipeSnapshot: f.recipe, versionPolicy, values: f.draft.values, additionalInstructions: 'extra', mode: 'plan' } });
  return { ...f, scheduler, input };
}
it('fixed schedule uses its original snapshot after edits/deletion, links both histories, and persists its policy', async t => {
  const f = await scheduleFixture(t); const task = await f.scheduler.create(f.input()); f.service.save({ ...template(), name: 'New' }, f.recipe.id, 1); f.service.delete(f.recipe.id);
  const slot = await f.scheduler.runNow(task.id); await f.scheduler.drain(); assert.equal(f.scheduler.list().runs[0]!.status, 'success');
  const run = f.service.list().runs[0]!; assert.equal(run.requestId, slot.id); assert.equal(run.recipeSnapshot.revision, 1); assert.equal(run.mode, 'plan'); assert.equal(run.trigger, 'scheduled'); assert.equal(f.scheduler.list().runs[0]!.conversationId, run.conversationId);
  assert.match(run.expandedPrompt, /extra/); const stored = new ScheduledTaskScheduler(join(f.root, 'scheduled.json'), async () => {}); stored.init(); assert.equal(stored.list().tasks[0]!.recipeBinding!.versionPolicy, 'fixed');
});
it('latest schedules resolve current content, fail on new required parameters or deletion without invoking the model', async t => {
  const f = await scheduleFixture(t); const task = await f.scheduler.create(f.input('latest')); let newer = f.service.save({ ...template(), name: 'Latest' }, f.recipe.id, 1);
  await f.scheduler.runNow(task.id); await f.scheduler.drain(); assert.equal(f.service.list().runs[0]!.recipeSnapshot.revision, 2);
  newer = f.service.save({ ...template(), parameters: [...template().parameters, { id: 'required', label: 'Required', type: 'text', required: true }] }, newer.id, newer.revision);
  await f.scheduler.runNow(task.id); await f.scheduler.drain(); assert.equal(f.scheduler.list().runs.at(-1)!.status, 'failed'); assert.equal(f.counts().submits, 1);
  f.service.delete(newer.id); await f.scheduler.runNow(task.id); await f.scheduler.drain(); assert.match(f.scheduler.list().runs.at(-1)!.error!, /删除/); assert.equal(f.counts().submits, 1);
});
it('scheduler holds overlap lock through the recipe turn, and shutdown never replays claimed work', async t => {
  const f = await scheduleFixture(t); let release!: () => void; const gate = new Promise<void>(done => { release = done; }); f.submit(async () => { await gate; return { status: 'responded' }; });
  const task = await f.scheduler.create(f.input()); await f.scheduler.runNow(task.id);
  for (let i = 0; i < 100 && !f.counts().submits; i++) await new Promise(done => setTimeout(done, 5));
  await assert.rejects(f.scheduler.runNow(task.id), /正在执行/); f.scheduler.stop(); f.service.stop(); release(); await f.scheduler.drain();
  assert.equal(f.scheduler.list().runs[0]!.status, 'interrupted'); assert.equal(f.service.list().runs[0]!.status, 'interrupted'); assert.equal(f.counts().submits, 1);
});
it('scheduler binding parser rejects invalid modes/params/policies and strips embedded execution overrides', async t => {
  const f = await scheduleFixture(t); const good = f.input(); const binding = good.recipeBinding!;
  for (const extra of [{ versionPolicy: 'unknown' }, { mode: 'goal' }, { values: {} }, { recipeSnapshot: { ...f.recipe, requiredSkills: ['bad', 'bad'] } }]) assert.throws(() => parseTaskInput({ ...good, recipeBinding: { ...binding, ...extra } }));
  const parsed = parseTaskInput({ ...good, recipeBinding: { ...binding, recipeSnapshot: { ...f.recipe, sandboxMode: 'full', modelOverride: { provider: 'other', id: 'other' } } } });
  assert.equal((parsed.recipeBinding!.recipeSnapshot as any).sandboxMode, undefined); assert.equal((parsed.recipeBinding!.recipeSnapshot as any).modelOverride, undefined);
});
it('worktree changes during conversation setup block submission and retain the directory for inspection', async t => {
  const f = await fixture(t); await f.initGit();
  const create = f.host.create; f.host.create = async run => { await create(run); await writeFile(join(run.workspace, 'tracked.txt'), 'unexpected setup change'); };
  const draft: RecipeUseDraft = { ...f.draft, autoWorktree: { startRef: 'HEAD', branch: 'vela/recipe-race', includeUncommitted: false } };
  const run = await f.start(draft); assert.equal(run.status, 'failed'); assert.equal(run.sendIntentAt, null); assert.equal(f.counts().submits, 0); assert.match(run.error!, /任务未提交/);
  assert.equal(await readFile(join(run.worktree!.path, 'tracked.txt'), 'utf8'), 'unexpected setup change');
});
it('bound schedules reject ineffective prompt edits and allow explicit conversion to a plain task', async t => {
  const f = await scheduleFixture(t); const task = await f.scheduler.create(f.input());
  await assert.rejects(f.scheduler.update(task.id, { prompt: 'Changed content' }), /绑定/);
  const updated = await f.scheduler.update(task.id, { title: 'Renamed', recipeBinding: { ...task.recipeBinding!, versionPolicy: 'latest' } });
  assert.equal(updated.recipeBinding!.versionPolicy, 'latest');
  const plain = await f.scheduler.update(task.id, { recipeBinding: null, prompt: 'Plain prompt' }); assert.equal(plain.recipeBinding, null); assert.equal(plain.prompt, 'Plain prompt');
});
it('project saves enforce the UTF-8 size limit before replacing a readable library', async t => {
  const f = await fixture(t); const input = { ...template(), parameters: [...template().parameters, ...Array.from({ length: 19 }, (_, index) => ({ id: `large_${index}`, label: 'Large default', type: 'multiline' as const, required: false, defaultValue: '汉'.repeat(10000) }))] };
  for (let index = 0; index < 6; index++) f.service.save({ ...input, name: `Large ${index}` }, undefined, undefined, f.workspace);
  const file = join(f.workspace, '.vela/task-recipes.json'); const before = await readFile(file, 'utf8');
  assert.throws(() => f.service.save({ ...input, name: 'Overflow' }, undefined, undefined, f.workspace), /4 MB/);
  assert.equal(await readFile(file, 'utf8'), before); assert.deepEqual(f.service.list().projectErrors, {}); assert.equal(f.service.list().recipes.filter(r => r.origin === 'project').length, 6);
});
