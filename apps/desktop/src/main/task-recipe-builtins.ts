import type { RecipeParameter, TaskRecipe } from '@vela/shared';

export function builtinRecipes(locale: 'zh-CN' | 'en' = 'zh-CN'): TaskRecipe[] {
  const en = locale === 'en';
  const text = (zh: string, english: string) => en ? english : zh;
  const parameter = (id: string, zh: string, english: string, type: RecipeParameter['type'], required = false): RecipeParameter => ({ id, label: text(zh, english), type, required });
  const base = { origin: 'builtin' as const, revision: 1, builtinVersion: 1, createdAt: 0, updatedAt: 0, locale, tags: [] };
  return [
    { ...base, id: 'vela.recipe.bug', builtinKind: 'bug', name: text('修复 Bug', 'Fix a bug'), defaultMode: 'agent',
      description: text('定位问题并限定修复范围，按风险验证。适用于代码或非 Git 工作区。', 'Find the cause, make a focused fix, and validate according to risk. Works without Git.'),
      parameters: [parameter('problem', '问题描述', 'Problem', 'multiline', true), parameter('reproduction', '复现步骤', 'Reproduction steps', 'multiline'), parameter('expected', '预期行为', 'Expected behavior', 'multiline'), { ...parameter('focus_path', '关注路径', 'Focus path', 'path'), pathKind: 'any' }],
      objectiveTemplate: text('在 {{workspace.name}} 修复以下问题：\n{{problem}}', 'Fix this problem in {{workspace.name}}:\n{{problem}}'),
      workflowTemplate: text('1. 查阅工作区指令与相关实现，结合复现步骤 {{reproduction}} 和预期行为 {{expected}} 查明原因。关注路径：{{focus_path}}。\n2. 限定修复范围；无法复现时说明证据缺口，不猜测已验证。\n3. 实施必要改动。\n4. 按风险和影响范围验证，不默认运行全量测试。', '1. Read workspace instructions and relevant code. Investigate using reproduction steps {{reproduction}}, expected behavior {{expected}}, and focus path {{focus_path}}.\n2. Bound the fix. Explain evidence gaps if reproduction is unavailable.\n3. Implement the necessary changes.\n4. Validate according to risk and scope; do not require the full test suite by default.'),
      deliverableTemplate: text('说明根因、改动、实际执行的验证与结果，以及剩余问题。', 'Report the cause, changes, actual validation and results, and remaining issues.') },
    { ...base, id: 'vela.recipe.review', builtinKind: 'review', name: text('审查改动', 'Review changes'), defaultMode: 'plan',
      description: text('只读审阅未提交改动或两个明确 Git 提交之间的差异，不自动修复。', 'Read-only review of uncommitted changes or differences between two explicit Git commits.'),
      parameters: [{ ...parameter('scope', '审查范围', 'Review scope', 'select', true), defaultValue: 'uncommitted', options: [{ value: 'uncommitted', label: text('未提交改动', 'Uncommitted changes') }, { value: 'refs', label: text('两个 Git 引用', 'Two Git references') }] }, parameter('start_ref', '起始引用', 'Start reference', 'text'), parameter('end_ref', '结束引用', 'End reference', 'text'), parameter('focus', '关注点', 'Focus areas', 'multiline')],
      objectiveTemplate: text('审查 {{workspace.name}} 的 {{scope}}。关注点：{{focus}}。', 'Review {{scope}} in {{workspace.name}}. Focus: {{focus}}.'),
      workflowTemplate: text('1. 按预览中保存的 Git 范围查阅差异与相关代码。双引用使用明确起止 SHA 比较，不使用 merge-base。未提交范围包含索引和工作区差异，并列出未跟踪文件与实际查看范围。\n2. 检查正确性和回归风险。\n3. 汇总发现，不修改文件、不自动修复；沿用 Plan 审阅机制。', '1. Inspect differences and relevant code using the saved Git scope. Compare the explicit start and end SHAs, not merge-base. For uncommitted changes, inspect both index and working tree, list untracked files and state the actual scope.\n2. Check correctness and regression risks.\n3. Report findings without changing files or applying fixes; use the existing Plan review flow.'),
      deliverableTemplate: text('按严重程度列出问题、文件位置、触发条件和建议。未发现问题时说明检查范围与限制。', 'List findings by severity with file locations, trigger conditions, and suggestions. If none, explain the inspected scope and limitations.') },
    { ...base, id: 'vela.recipe.release', builtinKind: 'release', name: text('准备发布', 'Prepare a release'), defaultMode: 'agent',
      description: text('核对版本与提交范围，准备发布材料；不创建 Tag、不推送、不实际发布。', 'Check the version and commit scope and prepare release materials. Does not create tags, push, or publish.'),
      parameters: [parameter('version', '目标版本', 'Target version', 'text', true), parameter('start_ref', '起始引用', 'Start reference', 'text', true), { ...parameter('end_ref', '结束引用', 'End reference', 'text', true), defaultValue: 'HEAD' }, parameter('notes', '补充说明', 'Additional notes', 'multiline')],
      objectiveTemplate: text('为 {{workspace.name}} 准备 {{version}} 的发布材料。补充说明：{{notes}}。', 'Prepare release materials for {{version}} in {{workspace.name}}. Notes: {{notes}}.'),
      workflowTemplate: text('1. 核对项目版本规则与保存的起止提交 SHA。使用两个明确提交比较，不自动改为 merge-base。\n2. 整理发布说明草稿。\n3. 列出需要的检查和发布步骤。本次仅准备材料，不创建 Tag、不推送、不发布。', '1. Check project version rules and the saved start and end commit SHAs. Compare those commits explicitly; do not substitute merge-base.\n2. Draft release notes.\n3. List required checks and release steps. Prepare materials only: do not create tags, push, or publish.'),
      deliverableTemplate: text('交付发布说明草稿、版本差异和待完成事项，并明确哪些检查尚未执行。', 'Deliver draft release notes, version differences, and outstanding tasks. Identify checks that have not been run.') },
  ];
}
