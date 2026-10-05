import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, type TestContext } from 'node:test';
import { canRetryRecipeStage, compareRecipeRevisions, parseRecipeInput, validateRecipe, type RecipeRun, type RecipeStage, type RecipeStageSubmission, type RecipeSubmitResult, type RecipeUseDraft, type TaskRecipeInput } from '@vela/shared';
import { TaskRecipeService, type RecipeHostRuntime } from '../src/main/task-recipe-service.ts';
import { executeScheduledRecipe } from '../src/main/task-recipe-schedule.ts';
import { ScheduledTaskScheduler } from '../src/main/scheduled-task-service.ts';
const stage = (id: string, extra: Partial<RecipeStage> = {}): RecipeStage => ({ id, name: id, instructions: 'Inspect {{topic}} in {{workspace.path}}', approvalRequired: false, retryLimit: 0, sideEffect: 'read_only', ...extra });
const template = (stages: RecipeStage[] = [stage('inspect'), stage('report')]): TaskRecipeInput => ({ name: 'Stages', description: '', tags: [], defaultMode: 'agent', parameters: [{ id: 'topic', label: 'Topic', type: 'text', required: true }, { id: 'fix', label: 'Fix', type: 'boolean', required: false }], objectiveTemplate: '{{topic}}', workflowTemplate: 'Follow workspace rules', deliverableTemplate: 'Report evidence', stages });
async function fixture(t: TestContext, stages?: RecipeStage[]) {
  const root = await mkdtemp(join(tmpdir(), 'vela-recipe-p2-')); const workspace = join(root, 'workspace'); await mkdir(workspace);
  const file = join(root, 'recipes.json'); let creates = 0; const submissions: (RecipeStageSubmission | undefined)[] = [];
  let result: (run: RecipeRun, s?: RecipeStageSubmission) => Promise<RecipeSubmitResult> = async (_run, s) => ({ status: 'responded', evidence: s ? [{ type: 'response', id: `reply-${s.id}`, label: 'Response' }] : [] });
  const host: RecipeHostRuntime = { workspaces: () => [workspace], runningWorkspaces: () => [], resolveExecution: async () => ({ model: { provider: 'fixture', id: 'fixture' }, thinkingLevel: 'off', sandboxMode: 'ask' }),
    create: async () => { creates++; }, submit: async (run, s) => {
      submissions.push(s); const stored = JSON.parse(await readFile(file, 'utf8')).runs.find((r: RecipeRun) => r.id === run.id);
      if (s) { const attempt = stored.stages.find((p: { stageId: string }) => p.stageId === s.id).attempts.at(-1); assert.equal(attempt.status, 'running'); assert.ok(attempt.sendIntentAt); assert.equal(attempt.attempt, s.attempt); }
      return result(run, s);
    } };
  const service = new TaskRecipeService(file, host); service.init(); const recipe = service.save(template(stages));
  const draft: RecipeUseDraft = { recipeSnapshot: recipe, workspace, values: { topic: 'Typed {{fix}}', fix: false }, additionalInstructions: '', mode: 'agent' };
  const start = async (input = draft) => { const preview = await service.preview(input); assert.deepEqual(preview.errors, {}); return service.start({ requestId: randomUUID(), draft: input, fingerprint: preview.fingerprint }); };
  t.after(async () => { service.stop(); await service.drain(); await rm(root, { force: true, recursive: true }); });
  return { root, workspace, file, host, service, recipe, draft, start, submissions, creates: () => creates, result: (f: typeof result) => { result = f; } };
}
function until(service: TaskRecipeService, check: (run: RecipeRun) => boolean): Promise<RecipeRun> {
  return new Promise((done, reject) => {
    const timeout = setTimeout(() => { off(); reject(new Error('State did not arrive')); }, 3000);
    const update = () => { const run = service.list().runs[0]; if (run && check(run)) { clearTimeout(timeout); off(); done(run); } };
    const off = service.subscribe(update); update();
  });
}
it('validates unique stages, typed parameter conditions, retry effects, bounds, and placeholders', () => {
  const valid = template([stage('inspect', { retryLimit: 2, condition: { parameterId: 'fix', operator: 'equals', value: false } })]);
  assert.deepEqual(validateRecipe(valid), {}); assert.deepEqual(parseRecipeInput(valid).stages, valid.stages);
  for (const stages of [[stage('a'), stage('a')], [stage('a', { instructions: '{{missing}}' })], [stage('a', { instructions: '{{topic' })], [stage('a', { retryLimit: 4 })], [stage('a', { retryLimit: 1, sideEffect: 'workspace' })], [stage('a', { condition: { parameterId: 'fix', operator: 'equals', value: 'false' } })], [stage('a', { condition: { parameterId: 'missing', operator: 'equals', value: '' } })]]) assert.notDeepEqual(validateRecipe(template(stages)), {});
  assert.notDeepEqual(validateRecipe({ ...valid, stages: Array.from({ length: 21 }, (_, i) => stage(`s${i}`)) }), {});
  assert.notDeepEqual(validateRecipe({ ...valid, workflowTemplate: 'x'.repeat(39999) }), {});
});
it('runs selected stages in order with durable attempts and actual evidence; no recursive parameter expansion', async t => {
  const f = await fixture(t, [stage('inspect'), stage('fix', { condition: { parameterId: 'fix', operator: 'equals', value: true } }), stage('report')]);
  const preview = await f.service.preview(f.draft); assert.match(preview.expandedPrompt, /跳过 \/ Skipped/);
  const run = await f.start(); const result = await f.service.waitForRun(run.id);
  assert.equal(result.status, 'responded'); assert.equal(f.creates(), 1); assert.deepEqual(f.submissions.map(s => s?.id), ['inspect', 'report']);
  assert.match(f.submissions[0]!.prompt, /Typed \{\{fix\}\}/); assert.deepEqual(result.stages!.map(s => s.status), ['responded', 'skipped', 'responded']);
  assert.equal(result.stages![0]!.attempts[0]!.evidence[0]!.id, 'reply-inspect'); assert.equal(result.stages![1]!.attempts.length, 0);
  f.service.delete(f.recipe.id); assert.equal(f.service.list().runs[0]!.recipeSnapshot.stages!.length, 3);
});
it('approval gates dispatch, rejection stops later stages, and repeated approval is idempotent', async t => {
  const f = await fixture(t, [stage('inspect'), stage('gate', { approvalRequired: true }), stage('later')]);
  const run = await f.start(); await until(f.service, r => r.stages![1]!.status === 'waiting_for_approval');
  assert.deepEqual(f.submissions.map(s => s?.id), ['inspect']); f.service.approveStage(run.id, 'gate', false); f.service.approveStage(run.id, 'gate', false);
  const result = await f.service.waitForRun(run.id); assert.equal(result.status, 'stopped'); assert.equal(result.stages![1]!.approval?.approved, false); assert.equal(f.submissions.length, 1);
  const g = await fixture(t, [stage('gate', { approvalRequired: true }), stage('later')]); const other = await g.start(); await until(g.service, r => r.status === 'waiting_for_user');
  g.service.approveStage(other.id, 'gate', true); g.service.approveStage(other.id, 'gate', true); assert.equal((await g.service.waitForRun(other.id)).status, 'responded'); assert.equal(g.submissions.length, 2);
});
it('explicit safe retries preserve attempts, skip completed stages, enforce limits, and deduplicate request IDs', async t => {
  const f = await fixture(t, [stage('before'), stage('flaky', { retryLimit: 1 }), stage('after')]);
  f.result(async (_run, s) => s?.id === 'flaky' && s.attempt === 1 ? { status: 'failed', error: 'Confirmed provider failure', retrySafe: true, evidence: [] } : { status: 'responded', evidence: [{ type: 'response', id: `response-${s?.id}`, label: 'Response' }] });
  const run = await f.start(); const failed = await f.service.waitForRun(run.id); assert.equal(failed.status, 'failed'); assert.equal(canRetryRecipeStage(failed, 'flaky'), true); assert.equal(f.submissions.length, 2);
  const requestId = randomUUID(); const retries = await Promise.all([f.service.retryStage(run.id, 'flaky', requestId), f.service.retryStage(run.id, 'flaky', requestId)]); assert.equal(retries[0]!.id, retries[1]!.id); await f.service.retryStage(run.id, 'flaky', requestId);
  const result = await f.service.waitForRun(run.id); assert.equal(result.status, 'responded'); assert.deepEqual(f.submissions.map(s => s?.id), ['before', 'flaky', 'flaky', 'after']); assert.deepEqual(result.stages![1]!.attempts.map(a => a.status), ['failed', 'responded']);
  await assert.rejects(f.service.retryStage(run.id, 'after', requestId), /相同重试/); await assert.rejects(f.service.retryStage(run.id, 'flaky', randomUUID()), /只读/);
});
it('uncertain failures, mutations and interrupted attempts cannot be replayed', async t => {
  for (const sideEffect of ['read_only', 'workspace', 'external'] as const) {
    const f = await fixture(t, [stage('effect', { sideEffect, retryLimit: sideEffect === 'read_only' ? 1 : 0 })]); f.result(async () => { throw new Error('Unconfirmed outcome'); });
    const run = await f.start(); const result = await f.service.waitForRun(run.id); assert.equal(result.status, 'failed'); assert.equal(result.stages![0]!.attempts[0]!.retrySafe, false);
    await assert.rejects(f.service.retryStage(run.id, 'effect', randomUUID()), /只读/); assert.equal(f.submissions.length, 1);
  }
});
it('safe retry limits and resource changes stop dispatch without clearing the failed result', async t => {
  const f = await fixture(t, [stage('flaky', { retryLimit: 1 })]); f.result(async () => ({ status: 'failed', error: 'Confirmed', retrySafe: true }));
  const run = await f.start(); await f.service.waitForRun(run.id); await f.service.retryStage(run.id, 'flaky', randomUUID()); await f.service.waitForRun(run.id);
  await assert.rejects(f.service.retryStage(run.id, 'flaky', randomUUID()), /只读/); assert.equal(f.submissions.length, 2);
  const g = await fixture(t, [stage('flaky', { retryLimit: 1 })]); g.result(async () => ({ status: 'failed', error: 'Confirmed', retrySafe: true })); const other = await g.start(); await g.service.waitForRun(other.id);
  g.host.resolveExecution = async () => { throw new Error('Model removed'); }; await assert.rejects(g.service.retryStage(other.id, 'flaky', randomUUID()), /Model removed/); assert.equal(g.service.list().runs[0]!.status, 'failed'); assert.equal(g.submissions.length, 1);
});
it('shutdown/restart interrupt approval gates and attempts without replay or reopening approval', async t => {
  const f = await fixture(t, [stage('gate', { approvalRequired: true })]); const run = await f.start(); await until(f.service, r => r.status === 'waiting_for_user');
  f.service.stop(); await f.service.drain(); const restored = new TaskRecipeService(f.file, f.host); restored.init();
  assert.equal(restored.list().error, null); assert.equal(restored.list().runs[0]!.status, 'interrupted'); assert.equal(restored.list().runs[0]!.stages![0]!.status, 'interrupted'); assert.equal(f.submissions.length, 0);
  assert.throws(() => restored.approveStage(run.id, 'gate', true), /中断/); await assert.rejects(restored.retryStage(run.id, 'gate', randomUUID()));
  const g = await fixture(t); let release!: () => void; g.result(async () => { await new Promise<void>(r => { release = r; }); return { status: 'responded' }; });
  const other = await g.start(); await until(g.service, r => r.stages![0]!.status === 'running'); while (!release) await new Promise(r => setImmediate(r));
  g.service.stop(); release(); await g.service.drain(); const fresh = new TaskRecipeService(g.file, g.host); fresh.init(); assert.equal(fresh.list().runs[0]!.stages![0]!.attempts[0]!.status, 'interrupted'); assert.equal(g.submissions.length, 1); assert.equal(other.id, fresh.list().runs[0]!.id);
});
it('chat stop interrupts the approval gate and prevents all later dispatches', async t => {
  const f = await fixture(t, [stage('gate', { approvalRequired: true }), stage('later')]); const run = await f.start(); await until(f.service, r => r.status === 'waiting_for_user');
  f.service.stopConversation(run.conversationId); await f.service.drain(); assert.equal(f.service.list().runs[0]!.status, 'stopped'); assert.equal(f.submissions.length, 0);
});
it('Plan uses one read-only planning invocation and no stage approval or auto execution', async t => {
  const f = await fixture(t, [stage('edit', { sideEffect: 'workspace', approvalRequired: true })]); const run = await f.start({ ...f.draft, mode: 'plan' }); const result = await f.service.waitForRun(run.id);
  assert.equal(result.stages, undefined); assert.equal(f.submissions.length, 1); assert.equal(f.submissions[0], undefined);
});
it('corrupt stage evidence and assessments stop storage writes without overwriting the file', async t => {
  const f = await fixture(t); const run = await f.start(); await f.service.waitForRun(run.id); const data = JSON.parse(await readFile(f.file, 'utf8')); data.runs[0].stages[0].attempts[0].evidence = [{ type: 'tool', id: 999, label: 'Forged' }];
  const text = JSON.stringify(data); await writeFile(f.file, text); const restored = new TaskRecipeService(f.file, f.host); restored.init(); assert.match(restored.list().error!, /损坏/); assert.throws(() => restored.save(template())); assert.equal(await readFile(f.file, 'utf8'), text);
});
it('compares revisions with explicit local assessments and never treats replies as acceptance', async t => {
  const f = await fixture(t); const a = await f.start(); await f.service.waitForRun(a.id); f.service.rateRun(a.id, 'needs_work', 'Needs evidence');
  const newer = f.service.save({ ...template(), name: 'Stages v2' }, f.recipe.id, 1); const b = await f.start({ ...f.draft, recipeSnapshot: newer }); await f.service.waitForRun(b.id);
  let rows = compareRecipeRevisions(f.service.list().runs); assert.deepEqual(rows.map(r => [r.revision, r.responded, r.accepted, r.needsWork, r.rated]), [[1, 1, 0, 1, 1], [2, 1, 0, 0, 0]]);
  f.service.rateRun(b.id, 'accepted', 'Checked manually'); rows = compareRecipeRevisions(f.service.list().runs); assert.equal(rows[1]!.accepted, 1); assert.throws(() => f.service.rateRun(a.id, 'accepted', 'x'.repeat(2001)));
});
it('scheduled approval gates retain the scheduler lock and reject in-place retry after failure', async t => {
  const f = await fixture(t, [stage('gate', { approvalRequired: true, retryLimit: 1 })]); const scheduler = new ScheduledTaskScheduler(join(f.root, 'scheduled.json'), (task, link, run) => executeScheduledRecipe(f.service, task, link, run)); scheduler.init(); scheduler.start();
  t.after(async () => { scheduler.stop(); f.service.stop(); await scheduler.drain(); });
  const task = await scheduler.create({ title: 'Stages', workspace: f.workspace, prompt: 'Binding', schedule: { kind: 'daily', time: '23:59', timezone: 'UTC' }, recipeBinding: { recipeSnapshot: f.recipe, values: f.draft.values, additionalInstructions: '', mode: 'agent', versionPolicy: 'fixed' } });
  await scheduler.runNow(task.id); const run = await until(f.service, r => r.status === 'waiting_for_user'); await assert.rejects(scheduler.runNow(task.id));
  f.result(async () => ({ status: 'failed', error: 'Confirmed', retrySafe: true })); f.service.approveStage(run.id, 'gate', true); await scheduler.drain(); assert.equal(scheduler.list().runs[0]!.status, 'failed'); await assert.rejects(f.service.retryStage(run.id, 'gate', randomUUID()), /定时/);
});

it('parameter branches that select no stage fail preflight without creating a chat', async t => {
  const f = await fixture(t, [stage('skip', { condition: { parameterId: 'fix', operator: 'equals', value: true } })]); const preview = await f.service.preview(f.draft); assert.ok(preview.errors.stages); assert.equal(f.creates(), 0);
});
it('failed attempt write prevents the model call and keeps a non-replayable interruption', async t => {
  const f = await fixture(t); const commit = (f.service as unknown as { commit: (change: unknown) => void }).commit.bind(f.service); let count = 0;
  (f.service as unknown as { commit: (change: unknown) => void }).commit = change => { if (++count === 4) throw new Error('Attempt fsync failed'); commit(change); };
  const run = await f.start(); const result = await f.service.waitForRun(run.id); assert.equal(result.status, 'failed'); assert.equal(f.submissions.length, 0); assert.match(result.error!, /fsync/); await assert.rejects(f.service.retryStage(run.id, 'inspect', randomUUID()));
});

it('storage failure while stopping still releases an approval gate and never dispatches', async t => {
  const f = await fixture(t, [stage('gate', { approvalRequired: true })]); const run = await f.start(); await until(f.service, r => r.status === 'waiting_for_user');
  const commit = (f.service as unknown as { commit: (change: unknown) => void }).commit.bind(f.service);
  (f.service as unknown as { commit: (change: unknown) => void }).commit = () => { throw new Error('Stop fsync failed'); };
  f.service.stopConversation(run.conversationId); await f.service.drain(); assert.equal(f.service.list().runs[0]!.status, 'interrupted'); assert.match(f.service.list().error!, /Stop fsync failed/); assert.equal(f.submissions.length, 0);
  (f.service as unknown as { commit: (change: unknown) => void }).commit = commit;
});
