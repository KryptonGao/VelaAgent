import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { it, type TestContext } from 'node:test';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, type AssistantMessage, type ToolCall } from '@earendil-works/pi-ai';
import { parseRecipeInput, type RecipeRun, type RecipeStage, type RecipeUseDraft } from '@vela/shared';
import { AgentRuntime } from '../src/runtime.ts';
import { TaskRecipeService } from '../../../apps/desktop/src/main/task-recipe-service.ts';
import { createSandboxedToolDefinitions } from '../../workspace/src/sandbox-tools.ts';
import { SandboxPermissionManager } from '../../workspace/src/sandbox-permission-manager.ts';
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'vela-recipe-runtime-')); const cwd = join(root, 'workspace'); const other = join(root, 'other'); await mkdir(cwd); await mkdir(other);
  const permission = new SandboxPermissionManager(join(root, 'sandbox.json')); await permission.init();
  const runtime = new AgentRuntime({ cwd, agentDir: root, onRecipeStop: id => service.stopConversation(id), toolFactory: (cwd, context) => createSandboxedToolDefinitions({ cwd, workspace: cwd, permission, ...context }) });
  let scripts: (string | ToolCall[])[] = ['Done']; let created!: RecipeRun;
  const service = new TaskRecipeService(join(root, 'task-recipes.json'), {
    workspaces: () => [cwd, other], runningWorkspaces: () => [],
    resolveExecution: draft => runtime.resolveRecipeExecution(draft, draft.sandboxModeOverride ?? permission.getMode()),
    create: async run => { created = run; await runtime.createRecipeConversation(run); script(session(run.conversationId), scripts); },
    submit: (run, stage) => runtime.submitRecipe(run, stage),
    beginWorkflow: run => runtime.beginRecipeWorkflow(run), finishWorkflow: run => runtime.finishRecipeWorkflow(run),
  }); service.init();
  const session = (id: string) => (runtime as unknown as { conversations: Map<string, { session: AgentSession }> }).conversations.get(id)!.session;
  t.after(async () => { service.stop(); await runtime.dispose(); await service.drain(); await rm(root, { recursive: true, force: true }); });
  await runtime.createConversation(cwd); const original = runtime.activeConversationId!;
  await runtime.addModel({ providerId: 'recipe-fixture', providerName: 'Recipe fixture', modelId: 'fixture', modelName: 'Fixture', api: 'openai-completions', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'synthetic-test-key', reasoning: false, contextWindow: 32768, maxTokens: 4096 });
  await runtime.saveAgentSettings({ ...await runtime.getAgentSettings(), provider: 'recipe-fixture', modelId: 'fixture', thinkingLevel: 'off' });
  const recipe = service.save({ name: 'Recipe', description: '', tags: [], defaultMode: 'agent', parameters: [], objectiveTemplate: 'Test task', workflowTemplate: 'Follow workspace rules', deliverableTemplate: 'Report findings' });
  const draft: RecipeUseDraft = { recipeSnapshot: recipe, workspace: other, values: {}, additionalInstructions: '', mode: 'agent' };
  const start = async (d = draft) => { const p = await service.preview(d); assert.deepEqual(p.errors, {}); return service.start({ requestId: randomUUID(), draft: d, fingerprint: p.fingerprint }); };
  runtime.subscribeQuestions(event => service.waiting(event.type === 'request' ? event.request.conversationId : '', event.type === 'request' ? event.request.id : event.id, event.type === 'request'));
  permission.subscribe(event => service.waiting(event.type === 'request' ? event.request.conversationId ?? '' : '', event.type === 'request' ? event.request.id : event.id, event.type === 'request'));
  return { root, cwd, other, runtime, permission, service, draft, original, start, session, created: () => created, replies: (values: typeof scripts) => { scripts = values; } };
}
function script(session: AgentSession, replies: (string | ToolCall[])[]) {
  let index = 0;
  session.agent.streamFunction = (model) => {
    const reply = replies[index++]; assert.notEqual(reply, undefined, 'No real model calls in this fixture');
    const message: AssistantMessage = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
      content: typeof reply === 'string' ? [{ type: 'text', text: reply }] : reply,
      stopReason: typeof reply === 'string' ? 'stop' : 'toolUse', timestamp: Date.now(),
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const output = createAssistantMessageEventStream(); output.push({ type: 'start', partial: message });
    if (typeof reply === 'string') output.push({ type: 'text_delta', contentIndex: 0, delta: reply, partial: message });
    else reply.forEach((toolCall, contentIndex) => output.push({ type: 'toolcall_end', contentIndex, toolCall, partial: message }));
    output.push({ type: 'done', reason: typeof reply === 'string' ? 'stop' : 'toolUse', message }); return output;
  };
}
it('creates exactly the reserved chat in the target workspace and submits one user message; later turns preserve status', async t => {
  const f = await fixture(t); const settings = await f.runtime.getAgentSettings(); const run = await f.start(); await f.service.drain();
  assert.equal(f.runtime.activeConversationId, run.conversationId); assert.notEqual(run.conversationId, f.original);
  assert.equal(f.runtime.getSnapshot().cwd, await realpath(f.other)); assert.equal(f.runtime.getSnapshot().title, 'Recipe · other');
  assert.equal(f.service.list().runs[0].status, 'responded'); assert.equal(f.runtime.getMessages(run.conversationId).filter(m => m.role === 'user').length, 1);
  assert.equal(f.runtime.getMessages(run.conversationId).find(m => m.role === 'user')?.text, run.expandedPrompt);
  const before = f.runtime.listConversations().length; await f.runtime.createRecipeConversation(f.created()); assert.equal(f.runtime.listConversations().length, before);
  script(f.session(run.conversationId), ['Later response']); await f.runtime.prompt(run.conversationId, 'Follow up'); assert.equal(f.service.list().runs[0].status, 'responded');
  assert.deepEqual(await f.runtime.getAgentSettings(), settings);
  const stored = JSON.parse(await readFile(join(f.root, 'conversations.json'), 'utf8')).conversations.find((c: { id: string }) => c.id === run.conversationId);
  assert.equal(stored.recipeRunId, run.id); assert.deepEqual(stored.recipeExecution, run.resolvedExecution);
});
it('Plan remains read-only even with full access, records proposed plan awaiting review and never auto-approves', async t => {
  const f = await fixture(t); f.replies([[{ type: 'toolCall', id: 'write-plan', name: 'write', arguments: { path: join(f.other, 'should-not-exist'), content: 'blocked' } }], '<proposed_plan>\n# Plan\n\n## Steps\n1. Review the implementation.\n</proposed_plan>']);
  const run = await f.start({ ...f.draft, mode: 'plan', sandboxModeOverride: 'full' }); await f.service.drain();
  const state = f.runtime.getSnapshot(); assert.equal(state.mode, 'plan'); assert.equal(state.executionPlan, null);
  assert.ok(!state.tools.includes('write')); await assert.rejects(readFile(join(f.other, 'should-not-exist')));
  assert.equal(f.service.list().runs[0].status, 'responded'); assert.equal(f.service.list().runs[0].planPending, true);
  assert.equal(f.permission.getMode(), 'ask'); assert.equal(run.resolvedExecution.sandboxMode, 'full');
});
it('real sandbox approvals drive waiting state and return to running; handled tool failures do not fail the recipe', async t => {
  const f = await fixture(t); const seen: string[] = [];
  f.service.subscribe(() => { seen.push(f.service.list().runs[0]?.status); });
  f.permission.subscribe(event => { if (event.type === 'request') { assert.ok(event.request.conversationId); f.permission.reply(event.request.id, false); } });
  f.replies([[{ type: 'toolCall', id: 'approval', name: 'bash', arguments: { command: 'echo fixture' } }], 'Handled denial']);
  await f.start(); await f.service.drain(); assert.ok(seen.includes('waiting_for_user')); assert.equal(seen.at(-1), 'responded');
  assert.equal(f.service.list().runs[0].status, 'responded');
});
it('runtime failures and user stop are distinct terminal records', async t => {
  const f = await fixture(t); f.replies([[{ type: 'toolCall', id: 'long-approval', name: 'bash', arguments: { command: 'echo fixture' } }], 'Never reached']);
  const requested = new Promise<string>(done => f.permission.subscribe(event => { if (event.type === 'request') done(event.request.id); }));
  const run = await f.start(); await requested; await f.runtime.abort(run.conversationId); await f.service.drain(); assert.equal(f.service.list().runs[0].status, 'stopped');
  const g = await fixture(t); const create = g.runtime.createRecipeConversation.bind(g.runtime);
  g.runtime.createRecipeConversation = async run => { await create(run); g.session(run.conversationId).agent.streamFunction = () => { throw new Error('Scripted failure'); }; };
  // fixture installs scripts after creation, so override the submission boundary for this provider error.
  const submit = g.runtime.submitRecipe.bind(g.runtime); g.runtime.submitRecipe = run => { g.session(run.conversationId).agent.streamFunction = () => { throw new Error('Scripted failure'); }; return submit(run); };
  await g.start(); await g.service.drain(); assert.equal(g.service.list().runs[0].status, 'failed'); assert.match(g.service.list().runs[0].error!, /Scripted failure/);
});
it('restore retains the reserved conversation, prompt, mode and permission snapshot and does not replay', async t => {
  const f = await fixture(t); const run = await f.start({ ...f.draft, mode: 'plan', sandboxModeOverride: 'full' }); await f.service.drain(); await f.runtime.dispose();
  const restored = new AgentRuntime({ cwd: f.cwd, agentDir: f.root }); t.after(() => restored.dispose()); await restored.switchConversation(run.conversationId);
  assert.equal(restored.getSnapshot().mode, 'plan'); assert.equal(restored.getMessages(run.conversationId).filter(m => m.role === 'user').length, 1);
  const entries = (restored as unknown as { conversations: Map<string, { scheduledSandboxMode: string }> }).conversations;
  assert.equal(entries.get(run.conversationId)?.scheduledSandboxMode, 'full'); assert.equal(restored.getSnapshot().modelId, 'fixture');
});
it('unavailable models or invalid launch settings fail before chat creation', async t => {
  const f = await fixture(t); const count = f.runtime.listConversations().length;
  const bad = { ...f.draft, modelOverride: { provider: 'missing', id: 'gone' } };
  assert.ok(Object.keys((await f.service.preview(bad)).errors).length);
  await assert.rejects(f.service.start({ requestId: randomUUID(), draft: bad, fingerprint: 'none' })); assert.equal(f.runtime.listConversations().length, count);
  assert.ok(Object.keys((await f.service.preview({ ...f.draft, sandboxModeOverride: 'invented' as 'ask' })).errors).length);
  assert.ok(Object.keys((await f.service.preview({ ...f.draft, thinkingLevelOverride: 'high' })).errors).length);
});
it('orphan session headers are reconciled by reserved ID after an index/binding failure without executing', async t => {
  const f = await fixture(t); const run = await f.start(); await f.service.drain(); await f.runtime.dispose();
  const file = join(f.root, 'conversations.json'); const raw = JSON.parse(await readFile(file, 'utf8'));
  raw.conversations = raw.conversations.filter((c: { id: string }) => c.id !== run.conversationId);
  const { writeFile } = await import('node:fs/promises'); await writeFile(file, JSON.stringify(raw));
  const restored = new AgentRuntime({ cwd: f.cwd, agentDir: f.root }); t.after(() => restored.dispose());
  await restored.reconcileRecipeConversations([{ ...run, conversationBound: false, status: 'interrupted' }]);
  assert.ok(restored.listConversations().some(c => c.id === run.conversationId)); await restored.switchConversation(run.conversationId); assert.equal(restored.getMessages(run.conversationId).filter(m => m.role === 'user').length, 1);
  const count = restored.listConversations().length; await restored.reconcileRecipeConversations([{ ...run, conversationBound: false }]); assert.equal(restored.listConversations().length, count);
});
it('real question events drive waiting state and a reply resumes the same initial turn', async t => {
  const f = await fixture(t); const states: string[] = [];
  f.service.subscribe(() => { states.push(f.service.list().runs[0]?.status); });
  f.runtime.subscribeQuestions(event => { if (event.type === 'request') f.runtime.replyQuestion(event.request.id, 'Use the focused fix'); });
  f.replies([[{ type: 'toolCall', id: 'question', name: 'ask_user_question', arguments: { question: 'Which behavior should be preserved?' } }], 'Question answered']);
  await f.start(); await f.service.drain(); assert.ok(states.includes('waiting_for_user')); assert.equal(f.service.list().runs[0].status, 'responded');
});
it('historic recipe chats remain readable after the saved model is removed, without silently selecting another model', async t => {
  const f = await fixture(t); const run = await f.start(); await f.service.drain(); await f.runtime.removeModel('recipe-fixture', 'fixture'); await f.runtime.dispose();
  const restored = new AgentRuntime({ cwd: f.cwd, agentDir: f.root }); t.after(() => restored.dispose()); await restored.switchConversation(run.conversationId);
  assert.equal(restored.getSnapshot().status, 'ready'); assert.equal(restored.getSnapshot().modelReady, false); assert.equal(restored.getSnapshot().modelId, 'fixture');
  assert.equal(restored.getMessages(run.conversationId).filter(m => m.role === 'user').length, 1); await assert.rejects(restored.prompt(run.conversationId, 'Continue'), /选择/);
});

const phase = (id: string, extra: Partial<RecipeStage> = {}): RecipeStage => ({ id, name: id, instructions: 'Only inspect and report evidence.', sideEffect: 'read_only', retryLimit: 0, approvalRequired: false, ...extra });
async function waitStage(service: TaskRecipeService, status: string) {
  for (let i = 0; i < 300; i++) { const run = service.list().runs[0]; if (run?.stages?.some(s => s.status === status)) return run; await new Promise(r => setTimeout(r, 10)); }
  throw new Error('Stage did not reach expected status');
}
it('structured stages execute in one real chat and bind evidence to completed tools and persisted replies', async t => {
  const f = await fixture(t); await import('node:fs/promises').then(fs => fs.writeFile(join(f.other, 'evidence.txt'), 'Original evidence'));
  const recipe = f.service.save({ ...parseRecipeInput(f.draft.recipeSnapshot), stages: [phase('inspect'), phase('report')] });
  f.replies([[{ type: 'toolCall', id: 'read-stage', name: 'read', arguments: { path: join(f.other, 'evidence.txt') } }], 'Inspected the actual file', 'Reported findings']);
  const run = await f.start({ ...f.draft, recipeSnapshot: recipe }); const result = await f.service.waitForRun(run.id);
  assert.equal(result.status, 'responded'); assert.deepEqual(result.stages!.map(s => s.status), ['responded', 'responded']);
  const messages = f.runtime.getMessages(run.conversationId); assert.equal(messages.filter(m => m.role === 'user').length, 2);
  const evidence = result.stages![0]!.attempts[0]!.evidence; assert.ok(evidence.some(e => e.type === 'tool' && e.id === 'read-stage'));
  const response = evidence.find(e => e.type === 'response')!; assert.equal(f.runtime.getRecipeEvidence(result, response).text, 'Inspected the actual file');
  assert.throws(() => f.service.evidenceReference(run.id, 'report', 1, response.id), /不属于/);
  script(f.session(run.conversationId), ['Later']); await f.runtime.prompt(run.conversationId, 'Followup'); assert.equal(f.service.list().runs[0]!.stages![0]!.attempts.length, 1);
  await f.runtime.dispose(); const restored = new AgentRuntime({ cwd: f.cwd, agentDir: f.root });
  try { await restored.reconcileRecipeConversations([result]); assert.equal(restored.getRecipeEvidence(result, response).text, 'Inspected the actual file'); } finally { await restored.dispose(); }
});
it('read-only phase guards forged write/bash/subagent calls even with full tool permissions', async t => {
  const f = await fixture(t); const target = join(f.other, 'must-not-exist');
  const recipe = f.service.save({ ...parseRecipeInput(f.draft.recipeSnapshot), stages: [phase('readonly')] });
  f.replies([[{ type: 'toolCall', id: 'forged-write', name: 'write', arguments: { path: target, content: 'forbidden' } }, { type: 'toolCall', id: 'forged-bash', name: 'bash', arguments: { command: `touch ${target}` } }, { type: 'toolCall', id: 'forged-child', name: 'spawn_agent', arguments: { agent: 'general', task: 'Write the file', name: 'forged' } }], 'Blocked operations handled']);
  const run = await f.start({ ...f.draft, recipeSnapshot: recipe, sandboxModeOverride: 'full' }); const result = await f.service.waitForRun(run.id);
  await assert.rejects(readFile(target)); assert.equal(result.status, 'responded'); assert.equal(f.runtime.getAgents(run.conversationId).filter(a => a.kind !== 'root').length, 0);
  assert.ok(result.stages![0]!.attempts[0]!.evidence.some(e => e.id === 'forged-write' && /error/.test(e.label)));
});
it('stage approvals block manual prompts, mode/model changes and chat stop resolves the gate', async t => {
  const f = await fixture(t); const recipe = f.service.save({ ...parseRecipeInput(f.draft.recipeSnapshot), stages: [phase('gate', { approvalRequired: true })] });
  const run = await f.start({ ...f.draft, recipeSnapshot: recipe }); await waitStage(f.service, 'waiting_for_approval');
  assert.equal(f.runtime.getMessages(run.conversationId).length, 0); await assert.rejects(f.runtime.prompt(run.conversationId, 'Sneak around gate'), /阶段/);
  await assert.rejects(f.runtime.setMode(run.conversationId, 'agent'), /切换/); await assert.rejects(f.runtime.setThinkingLevel('off'), /配方/); await assert.rejects(f.runtime.selectModel('recipe-fixture', 'fixture'), /配方/);
  await f.runtime.abort(run.conversationId); await f.service.drain(); assert.equal(f.service.list().runs[0]!.status, 'stopped'); assert.equal(f.runtime.getMessages(run.conversationId).length, 0);
  script(f.session(run.conversationId), ['Normal chat resumed']); await f.runtime.prompt(run.conversationId, 'After stopping'); assert.equal(f.service.list().runs[0]!.status, 'stopped');
});
it('confirmed read-only runtime failures allow bounded explicit retry; unknown throws do not', async t => {
  const f = await fixture(t); const recipe = f.service.save({ ...parseRecipeInput(f.draft.recipeSnapshot), stages: [phase('flaky', { retryLimit: 1 }), phase('report')] });
  const submit = f.runtime.submitRecipe.bind(f.runtime); let first = true;
  f.runtime.submitRecipe = (run, stage) => { if (first) { first = false; f.session(run.conversationId).agent.streamFunction = () => { throw new Error('Confirmed synthetic failure'); }; } return submit(run, stage); };
  const run = await f.start({ ...f.draft, recipeSnapshot: recipe }); const failed = await f.service.waitForRun(run.id); assert.equal(failed.status, 'failed'); assert.equal(failed.stages![0]!.attempts[0]!.retrySafe, true);
  script(f.session(run.conversationId), ['Retry response', 'Final report']); await f.service.retryStage(run.id, 'flaky', randomUUID()); const result = await f.service.waitForRun(run.id);
  assert.equal(result.status, 'responded'); assert.deepEqual(result.stages![0]!.attempts.map(a => a.status), ['failed', 'responded']); assert.equal(f.runtime.getMessages(run.conversationId).filter(m => m.role === 'user').length, 3);
});

it('structured invocations disable SDK automatic error retries and restore the normal chat setting', async t => {
  const f = await fixture(t); const recipe = f.service.save({ ...parseRecipeInput(f.draft.recipeSnapshot), stages: [phase('check')] });
  const submit = f.runtime.submitRecipe.bind(f.runtime); let observations = 0;
  f.runtime.submitRecipe = (run, stage) => {
    const session = f.session(run.conversationId); const original = session.agent.streamFunction;
    session.agent.streamFunction = (...args) => { observations++; assert.equal(session.settingsManager.getRetrySettings().enabled, false); assert.equal(session.settingsManager.getCompactionEnabled(), false); return original(...args); };
    return submit(run, stage);
  };
  const run = await f.start({ ...f.draft, recipeSnapshot: recipe }); assert.equal((await f.service.waitForRun(run.id)).status, 'responded'); assert.equal(observations, 1); assert.equal(f.session(run.conversationId).settingsManager.getRetrySettings().enabled, true); assert.equal(f.session(run.conversationId).settingsManager.getCompactionEnabled(), true);
});
