import { validateRecipeStages, expandRecipeStages } from './recipe-workflow';
import type { RecipeContext, RecipeParameter, RecipeValue, TaskRecipe, TaskRecipeInput } from './task-recipes';

export class RecipeValidationError extends Error {
  constructor(public readonly fields: Record<string, string>) { super(Object.values(fields)[0] ?? '配方不正确'); }
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const types = ['text', 'multiline', 'select', 'boolean', 'path'];
export function validateRecipe(input: unknown): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!record(input)) return { recipe: '配方不正确' };
  const check = (key: string, max: number, required = false) => {
    const value = input[key];
    if (typeof value !== 'string' || value.length > max || (required && !value.trim())) errors[key] = `请填写${required ? '非空的' : ''}文字（最多 ${max} 字符）`;
  };
  check('name', 80, true); check('description', 300);
  if (input.requiredSkills !== undefined && (!Array.isArray(input.requiredSkills) || input.requiredSkills.length > 20 || input.requiredSkills.some(name => typeof name !== 'string' || !name.trim() || name.length > 100 || /[\n\r\0]/.test(name)) || new Set(input.requiredSkills).size !== input.requiredSkills.length)) errors.requiredSkills = '最多 20 个唯一的 Skill 名称，每个 1–100 字符';
  if (!['agent', 'plan'].includes(String(input.defaultMode))) errors.defaultMode = '仅支持 Agent / Plan';
  if (!Array.isArray(input.tags) || input.tags.length > 5 || input.tags.some(t => typeof t !== 'string' || !t.trim() || t.length > 30)) errors.tags = '最多 5 个标签，每个 1–30 字符';
  const ids = new Set<string>();
  if (!Array.isArray(input.parameters) || input.parameters.length > 20) errors.parameters = '最多 20 个参数';
  else input.parameters.forEach((raw, i) => {
    const field = `parameters.${i}`;
    if (!record(raw)) { errors[field] = '参数不正确'; return; }
    if (typeof raw.id !== 'string' || !/^[a-z][a-z0-9_]{0,39}$/.test(raw.id) || raw.id === 'workspace' || ids.has(raw.id)) errors[`${field}.id`] = '标识需唯一，匹配 [a-z][a-z0-9_]{0,39}，不得为 workspace';
    else ids.add(raw.id);
    if (typeof raw.label !== 'string' || !raw.label.trim() || raw.label.length > 80) errors[`${field}.label`] = '显示名称为 1–80 字符';
    if (typeof raw.required !== 'boolean' || !types.includes(String(raw.type))) errors[`${field}.type`] = '参数类型或必填设置不正确';
    if (raw.help !== undefined && (typeof raw.help !== 'string' || raw.help.length > 1000)) errors[`${field}.help`] = '帮助文字最多 1000 字符';
    if (raw.type === 'select') {
      if (!Array.isArray(raw.options) || raw.options.length < 2 || raw.options.length > 20 || raw.options.some(o => !record(o) || typeof o.value !== 'string' || !o.value.trim() || o.value.length > 500 || typeof o.label !== 'string' || !o.label.trim() || o.label.length > 80) || new Set(raw.options.map(o => record(o) ? o.value : null)).size !== raw.options.length) errors[`${field}.options`] = '需要 2–20 个选项，值唯一，显示名称非空';
    }
    if (raw.type === 'path' && !['file', 'directory', 'any'].includes(String(raw.pathKind))) errors[`${field}.pathKind`] = '请选择文件、目录或两者';
    if (raw.defaultValue !== undefined) {
      if (raw.type === 'select' && (!Array.isArray(raw.options) || !raw.options.some(o => record(o) && o.value === raw.defaultValue))) errors[`${field}.defaultValue`] = '默认值必须属于选项列表';
      if (raw.type === 'boolean' && typeof raw.defaultValue !== 'boolean') errors[`${field}.defaultValue`] = '布尔默认值必须为 true / false';
      const error = parameterError(raw as unknown as RecipeParameter, raw.defaultValue, false);
      if (error) errors[`${field}.defaultValue`] = error;
    }
  });
  const body = ['objectiveTemplate', 'workflowTemplate', 'deliverableTemplate'];
  for (const key of body) {
    check(key, 40000, true);
    if (typeof input[key] === 'string') {
      for (const match of input[key].matchAll(/\{\{([^{}]*)\}\}/g)) {
        if (!ids.has(match[1]!) && !['workspace.name', 'workspace.path'].includes(match[1]!)) errors[key] = `未知占位符：${match[0]}`;
      }
      if (/\{\{|\}\}/.test(input[key].replace(/\{\{[^{}]*\}\}/g, ''))) errors[key] = '占位符格式不完整，仅支持 {{parameter_id}}';
    }
  }
  if (body.reduce((n, k) => n + (typeof input[k] === 'string' ? input[k].length : 0), 0) > 40000) errors.workflowTemplate = '正文三个字段合计最多 40,000 字符';
  Object.assign(errors, validateRecipeStages(input, ids));
  if (input.sourceReference !== undefined) {
    const source = input.sourceReference;
    if (!record(source) || typeof source.conversationId !== 'string' || !source.conversationId || source.conversationId.length > 200 ||
      [source.messageId, source.planId].filter(value => value !== undefined).length !== 1 ||
      [source.messageId, source.planId].some(value => value !== undefined && (typeof value !== 'string' || !value || value.length > 200))) errors.sourceReference = '来源引用不正确';
  }
  return errors;
}
export function parseRecipeInput(raw: unknown): TaskRecipeInput {
  const errors = validateRecipe(raw);
  if (Object.keys(errors).length) throw new RecipeValidationError(errors);
  const input = raw as TaskRecipeInput;
  // Whitelist fields: renderer cannot smuggle model/permission/builtin semantics into a user template.
  return { name: input.name, description: input.description, tags: [...input.tags], defaultMode: input.defaultMode,
    parameters: input.parameters.map(p => ({ id: p.id, label: p.label, type: p.type, required: p.required,
      ...(p.help !== undefined ? { help: p.help } : {}), ...(p.defaultValue !== undefined ? { defaultValue: p.defaultValue } : {}),
      ...(p.type === 'select' ? { options: p.options?.map(o => ({ ...o })) } : {}), ...(p.type === 'path' ? { pathKind: p.pathKind } : {}) })),
    objectiveTemplate: input.objectiveTemplate, workflowTemplate: input.workflowTemplate, deliverableTemplate: input.deliverableTemplate,
    ...(input.stages?.length ? { stages: input.stages.map(s => ({ id: s.id, name: s.name, instructions: s.instructions, approvalRequired: s.approvalRequired, retryLimit: s.retryLimit, sideEffect: s.sideEffect, ...(s.condition ? { condition: { parameterId: s.condition.parameterId, operator: s.condition.operator, value: s.condition.value } } : {}) })) } : {}),
    ...(input.requiredSkills?.length ? { requiredSkills: [...input.requiredSkills] } : {}),
    ...(input.sourceReference ? { sourceReference: { conversationId: input.sourceReference.conversationId, ...(input.sourceReference.messageId ? { messageId: input.sourceReference.messageId } : { planId: input.sourceReference.planId }) } } : {}) };
}
function parameterError(p: RecipeParameter, value: unknown, required = p.required): string | null {
  if (value === undefined || value === '') return required ? '请填写此参数' : null;
  if (p.type === 'boolean') return typeof value === 'boolean' ? null : '需要布尔值';
  if (typeof value !== 'string') return '需要文字';
  const max = p.type === 'multiline' ? 10000 : 500;
  if (value.length > max) return `最多 ${max} 字符`;
  if (p.type === 'select' && !p.options?.some(o => o.value === value)) return '请选择列表内的选项';
  if (!value.trim()) return required ? '请填写此参数' : null;
  if (p.type === 'path' && value.includes('\0')) return '路径不正确';
  return null;
}
export function validateRecipeValues(recipe: TaskRecipeInput, values: unknown): Record<string, string> {
  if (!record(values)) return { values: '参数不正确' };
  const errors: Record<string, string> = {};
  for (const key of Object.keys(values)) if (!recipe.parameters.some(p => p.id === key)) errors[`values.${key}`] = '未知参数';
  for (const p of recipe.parameters) { const error = parameterError(p, values[p.id]); if (error) errors[`values.${p.id}`] = error; }
  return errors;
}
export function recipeDefaults(recipe: TaskRecipeInput): Record<string, RecipeValue> {
  return Object.fromEntries(recipe.parameters.filter(p => p.defaultValue !== undefined).map(p => [p.id, p.defaultValue!]));
}
export function displayRecipeValue(p: RecipeParameter, value: RecipeValue | undefined): string {
  if (value === undefined || (typeof value === 'string' && !value.trim())) return '未提供';
  if (typeof value === 'boolean') return value ? '是' : '否';
  return p.type === 'select' ? p.options?.find(o => o.value === value)?.label ?? value : value;
}
/** A single replace pass: replacement values are never interpreted as templates or commands. */
export function expandRecipe(recipe: TaskRecipe, values: Record<string, RecipeValue>, context: RecipeContext, additional: string): string {
  const english = recipe.locale === 'en';
  const display = (p: RecipeParameter) => { const v = values[p.id]; return english && (v === undefined || v === '' || typeof v === 'boolean') ? v === true ? 'Yes' : v === false ? 'No' : 'Not provided' : displayRecipeValue(p, v); };
  const substitutions = Object.fromEntries(recipe.parameters.map(p => [p.id, display(p)]));
  substitutions['workspace.name'] = context.name; substitutions['workspace.path'] = context.path;
  const expand = (s: string) => s.replace(/\{\{([^{}]+)\}\}/g, (_, key: string) => substitutions[key]!);
  const sections = [
    `# ${recipe.name} · revision ${recipe.revision}\n${english ? 'Workspace' : '工作区'}: ${context.name}\n${context.path}`,
    `## ${english ? 'Objective' : '任务目标'}\n${expand(recipe.objectiveTemplate)}`,
    `## ${english ? 'Parameters' : '填写的参数'}\n${recipe.parameters.map(p => `- ${p.label}: ${display(p)}`).join('\n')}`,
    ...(context.git ? [`## ${english ? 'Git scope' : 'Git 查看范围'}\n${context.git.scope}\nHEAD: ${context.git.head}\n${context.git.startSha ? `Start SHA: ${context.git.startSha}\nEnd SHA: ${context.git.endSha}` : context.git.status || (english ? 'No changes' : '没有改动')}`] : []),
    `## ${english ? 'Workflow' : '流程要求'}\n${expand(recipe.workflowTemplate)}`,
    ...(recipe.stages?.length ? [`## ${english ? 'Structured stages' : '结构化阶段'}\n${expandRecipeStages(recipe, values, context)}`] : []),
    `## ${english ? 'Deliverables' : '交付要求'}\n${expand(recipe.deliverableTemplate)}`,
    ...(recipe.requiredSkills?.length ? [`## ${english ? 'Required Skills' : '所需 Skill'}\n${recipe.requiredSkills.map(name => `- ${name}`).join('\n')}`] : []),
  ];
  if (additional.trim()) sections.push(`## ${english ? 'Additional instructions' : '本次补充要求'}\n${additional}`);
  return sections.join('\n\n');
}
