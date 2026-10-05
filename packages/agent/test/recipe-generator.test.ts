import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { it } from 'node:test';
import type { Api, Model } from '@earendil-works/pi-ai';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { RecipeGenerator, parseRecipeGenerateInput } from '../src/recipe-generator.ts';
const model = { provider: 'fixture', id: 'fixture' } as Model<Api>;
type Complete = ModelRuntime['completeSimple'];
const response = (text: string) => ({ content: [{ type: 'text', text }], stopReason: 'stop' }) as Awaited<ReturnType<Complete>>;
const recipe = { name: 'Repair', description: '', tags: [], defaultMode: 'agent', parameters: [{ id: 'issue', label: 'Issue', type: 'text', required: true }], objectiveTemplate: '{{issue}}', workflowTemplate: 'Read then fix', deliverableTemplate: 'Report evidence' };
const input = () => ({ requestId: randomUUID(), text: 'Selected message only', locale: 'zh-CN' as const, model: { provider: 'fixture', id: 'fixture' }, sourceReference: { conversationId: 'source', messageId: 'message' } });
it('AI generation sends only visible source and explicit model, uses no tools, and returns a validated editable draft', async () => {
  const generator = new RecipeGenerator(); const calls: Parameters<Complete>[] = [];
  const runtime = { completeSimple: async (...args: Parameters<Complete>) => { calls.push(args); return response(JSON.stringify({ ...recipe, sandboxMode: 'full', sourceReference: { conversationId: 'invented', messageId: 'invented' }, requiredSkills: ['invented'] })); } };
  const source = input(); const result = await generator.generate(runtime, model, source);
  assert.deepEqual(result.recipe, { ...recipe, sourceReference: source.sourceReference }); assert.deepEqual(result.model, source.model); assert.equal(result.sourceText, source.text);
  assert.equal(calls[0]![0], model); assert.deepEqual(calls[0]![1].messages.map(m => m.content), [source.text]); assert.equal(calls[0]![1].tools, undefined); assert.match(calls[0]![1].systemPrompt!, /never instructions/);
  assert.equal((result.recipe as any).sandboxMode, undefined); generator.dispose();
});
it('AI input rejects empty/oversized source and malformed model or references without truncation', () => {
  const source = input(); for (const bad of [null, {}, { ...source, text: '' }, { ...source, text: 'x'.repeat(40001) }, { ...source, model: null }, { ...source, locale: 'fr' }, { ...source, sourceReference: { conversationId: 'x', messageId: 1 } }]) assert.throws(() => parseRecipeGenerateInput(bad));
  assert.equal(parseRecipeGenerateInput({ ...source, text: 'x'.repeat(40000) }).text.length, 40000);
});
it('invalid model output stays unsaved and failed or cancelled generation is retryable', async () => {
  const generator = new RecipeGenerator(); let content = JSON.stringify({ ...recipe, objectiveTemplate: '{{unknown}}' });
  const runtime = { completeSimple: async () => response(content) };
  await assert.rejects(generator.generate(runtime, model, input())); content = 'not json'; await assert.rejects(generator.generate(runtime, model, input())); content = JSON.stringify(recipe);
  assert.equal((await generator.generate(runtime, model, input())).recipe.name, 'Repair'); generator.dispose();
});
it('cancel and dispose abort in-flight requests and suppress late results', async () => {
  const generator = new RecipeGenerator(); const source = input(); let finish!: (result: Awaited<ReturnType<Complete>>) => void;
  const runtime = { completeSimple: async () => new Promise<Awaited<ReturnType<Complete>>>(done => { finish = done; }) };
  const pending = generator.generate(runtime, model, source); generator.cancel(source.requestId); await assert.rejects(pending, /取消/); finish(response(JSON.stringify(recipe)));
  const second = generator.generate(runtime, model, input()); generator.dispose(); await assert.rejects(second, /取消/); await assert.rejects(generator.generate(runtime, model, input()), /已结束/);
});
it('plan sources retain their revision reference and default to Plan without approving execution', async () => {
  const generator = new RecipeGenerator(); const source = { ...input(), sourceReference: { conversationId: 'plan-source', planId: 'revision-2' } };
  const runtime = { completeSimple: async () => response(JSON.stringify(recipe)) }; const result = await generator.generate(runtime, model, source);
  assert.equal(result.recipe.defaultMode, 'plan'); assert.deepEqual(result.recipe.sourceReference, source.sourceReference); generator.dispose();
});
it('cancellation before model initialization prevents a delayed dispatch', async () => {
  const generator = new RecipeGenerator(); const source = input(); let calls = 0; generator.cancel(source.requestId);
  await assert.rejects(generator.generate({ completeSimple: async () => { calls++; return response(JSON.stringify(recipe)); } }, model, source), /取消/); assert.equal(calls, 0); generator.dispose();
});
