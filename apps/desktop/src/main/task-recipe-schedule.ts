import { recipeDefaults, type RecipeUseDraft, type ScheduledTask, type ScheduledTaskRun } from '@vela/shared';
import type { TaskRecipeService } from './task-recipe-service';

export async function executeScheduledRecipe(service: TaskRecipeService, task: ScheduledTask, link: (id: string) => void, scheduledRun: ScheduledTaskRun): Promise<void> {
  const binding = task.recipeBinding;
  if (!binding) throw new Error('缺少配方绑定');
  const recipe = binding.versionPolicy === 'fixed' ? service.validateSnapshot(binding.recipeSnapshot) : service.list(binding.recipeSnapshot.locale).recipes.find(r => r.id === binding.recipeSnapshot.id);
  if (!recipe) throw new Error('跟随新版的配方已删除或项目库不可读取；未执行');
  const draft: RecipeUseDraft = { recipeSnapshot: recipe, workspace: task.workspace, values: { ...recipeDefaults(recipe), ...binding.values },
    additionalInstructions: binding.additionalInstructions, mode: binding.mode, modelOverride: task.model, thinkingLevelOverride: task.thinkingLevel, sandboxModeOverride: task.sandboxMode };
  const preview = await service.preview(draft);
  if (Object.keys(preview.errors).length) throw new Error(`定时配方预检失败：${Object.values(preview.errors).join('；')}`);
  const run = await service.start({ requestId: scheduledRun.id, draft, fingerprint: preview.fingerprint, trigger: 'scheduled' });
  if (run.conversationBound) link(run.conversationId);
  const result = await service.waitForRun(run.id);
  if (result.status !== 'responded') throw new Error(result.error || `配方运行${result.status}`);
}
