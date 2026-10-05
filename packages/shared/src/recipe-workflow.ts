import type { RecipeContext, RecipeStage, RecipeValue, RecipeRun, TaskRecipeInput } from './task-recipes';

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export function validateRecipeStages(input: Record<string, unknown>, parameterIds: Set<string>): Record<string, string> {
  const errors: Record<string, string> = {};
  if (input.stages === undefined) return errors;
  if (!Array.isArray(input.stages) || input.stages.length > 20) return { stages: '最多 20 个结构化阶段' };
  const ids = new Set<string>(); let length = 0;
  input.stages.forEach((stage, i) => {
    const key = `stages.${i}`;
    if (!record(stage)) { errors[key] = '阶段格式不正确'; return; }
    if (typeof stage.id !== 'string' || !/^[a-z][a-z0-9_]{0,39}$/.test(stage.id) || ids.has(stage.id)) errors[`${key}.id`] = '阶段标识需唯一，匹配 [a-z][a-z0-9_]{0,39}';
    else ids.add(stage.id);
    if (typeof stage.name !== 'string' || !stage.name.trim() || stage.name.length > 80) errors[`${key}.name`] = '阶段名称为 1–80 字符';
    if (typeof stage.instructions !== 'string' || !stage.instructions.trim() || stage.instructions.length > 10000) errors[`${key}.instructions`] = '阶段要求为 1–10,000 字符';
    else {
      length += stage.instructions.length;
      for (const match of stage.instructions.matchAll(/\{\{([^{}]*)\}\}/g)) if (!parameterIds.has(match[1]!) && !['workspace.name', 'workspace.path'].includes(match[1]!)) errors[`${key}.instructions`] = `未知占位符：${match[0]}`;
      if (/\{\{|\}\}/.test(stage.instructions.replace(/\{\{[^{}]*\}\}/g, ''))) errors[`${key}.instructions`] = '阶段占位符格式不完整';
    }
    if (typeof stage.approvalRequired !== 'boolean') errors[`${key}.approvalRequired`] = '请选择是否需要阶段审批';
    if (!['read_only', 'workspace', 'external'].includes(String(stage.sideEffect))) errors[`${key}.sideEffect`] = '请选择阶段副作用范围';
    if (!Number.isSafeInteger(stage.retryLimit) || Number(stage.retryLimit) < 0 || Number(stage.retryLimit) > 3 || stage.sideEffect !== 'read_only' && stage.retryLimit !== 0) errors[`${key}.retryLimit`] = '只读阶段可重试 0–3 次；其他阶段不能原地重试';
    if (stage.condition !== undefined) {
      const c = stage.condition;
      const parameter = Array.isArray(input.parameters) ? input.parameters.find(p => record(p) && p.id === (record(c) ? c.parameterId : undefined)) : undefined;
      if (!record(c) || typeof c.parameterId !== 'string' || !parameterIds.has(c.parameterId) || !['equals', 'not_equals'].includes(String(c.operator)) || !record(parameter) ||
        (parameter.type === 'boolean' ? typeof c.value !== 'boolean' : typeof c.value !== 'string' || c.value.length > (parameter.type === 'multiline' ? 10000 : 500)) ||
        parameter.type === 'select' && (!Array.isArray(parameter.options) || !parameter.options.some(o => record(o) && o.value === c.value))) errors[`${key}.condition`] = '条件必须引用现有参数，并使用符合其类型的固定比较值';
    }
  });
  const bodyLength = ['objectiveTemplate', 'workflowTemplate', 'deliverableTemplate'].reduce((n, k) => n + (typeof input[k] === 'string' ? input[k].length : 0), 0);
  if (bodyLength + length > 40000) errors.stages = '正文与阶段要求合计最多 40,000 字符';
  return errors;
}

export function recipeStageSelected(stage: RecipeStage, values: Record<string, RecipeValue>): boolean {
  if (!stage.condition) return true;
  const equal = values[stage.condition.parameterId] === stage.condition.value;
  return stage.condition.operator === 'equals' ? equal : !equal;
}
export function expandStageInstructions(stage: RecipeStage, recipe: TaskRecipeInput, values: Record<string, RecipeValue>, context: RecipeContext): string {
  const substitutions: Record<string, string> = { 'workspace.name': context.name, 'workspace.path': context.path };
  for (const p of recipe.parameters) {
    const v = values[p.id];
    substitutions[p.id] = typeof v === 'boolean' ? v ? '是' : '否' : v === undefined || !v.trim() ? '未提供' : p.type === 'select' ? p.options?.find(o => o.value === v)?.label ?? v : v;
  }
  return stage.instructions.replace(/\{\{([^{}]+)\}\}/g, (_, key: string) => substitutions[key]!);
}
export function expandRecipeStages(recipe: TaskRecipeInput, values: Record<string, RecipeValue>, context: RecipeContext): string {
  return (recipe.stages ?? []).map((stage, i) => `${i + 1}. ${stage.name} [${stage.id}] · ${recipeStageSelected(stage, values) ? '执行 / Selected' : '跳过 / Skipped'} · ${stage.sideEffect}${stage.approvalRequired ? ' · 需要审批 / Approval required' : ''}\n${expandStageInstructions(stage, recipe, values, context)}`).join('\n\n');
}
export function canRetryRecipeStage(run: RecipeRun, stageId: string): boolean {
  const definition = run.recipeSnapshot.stages?.find(s => s.id === stageId);
  const progress = run.stages?.find(s => s.stageId === stageId);
  return run.status === 'failed' && definition?.sideEffect === 'read_only' && !!progress && progress.status === 'failed' && progress.attempts.length <= definition.retryLimit && progress.attempts.at(-1)?.retrySafe === true;
}
export interface RecipeRevisionComparison {
  recipeId: string; name: string; revision: number; runs: number; responded: number; failed: number; stopped: number; interrupted: number; active: number;
  rated: number; accepted: number; needsWork: number; averageDurationMs: number | null;
}
/** Local observations only. Response completion is never counted as acceptance. */
export function compareRecipeRevisions(runs: RecipeRun[]): RecipeRevisionComparison[] {
  const groups = new Map<string, RecipeRun[]>();
  for (const run of runs) { const key = `${run.recipeId}:${run.recipeSnapshot.revision}`; const group = groups.get(key) ?? []; group.push(run); groups.set(key, group); }
  return [...groups.values()].map(group => {
    const first = group[0]!; const durations = group.filter(r => r.finishedAt !== null).map(r => Math.max(0, r.finishedAt! - r.startedAt));
    return { recipeId: first.recipeId, name: first.recipeSnapshot.name, revision: first.recipeSnapshot.revision, runs: group.length,
      responded: group.filter(r => r.status === 'responded').length, failed: group.filter(r => r.status === 'failed').length, stopped: group.filter(r => r.status === 'stopped').length,
      interrupted: group.filter(r => r.status === 'interrupted').length, active: group.filter(r => ['starting', 'running', 'waiting_for_user'].includes(r.status)).length,
      rated: group.filter(r => r.outcome).length, accepted: group.filter(r => r.outcome?.rating === 'accepted').length, needsWork: group.filter(r => r.outcome?.rating === 'needs_work').length,
      averageDurationMs: durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null };
  }).sort((a, b) => a.name.localeCompare(b.name) || a.recipeId.localeCompare(b.recipeId) || a.revision - b.revision);
}
