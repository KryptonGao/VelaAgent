import type { SkillSummary, TaskRecipe } from '@vela/shared';
import { filterSkills } from './skill-picker';

export type SlashMenuItem = { type: 'skill'; skill: SkillSummary } | { type: 'recipe'; recipe: TaskRecipe };

export function slashMenuItems(skills: SkillSummary[], recipes: TaskRecipe[], query: string): SlashMenuItem[] {
  const needle = query.trim().toLocaleLowerCase();
  const matchingRecipes = recipes.filter(recipe => `${recipe.name} ${recipe.description} ${recipe.tags.join(' ')}`.toLocaleLowerCase().includes(needle))
    .sort((a, b) => Number(b.name.toLocaleLowerCase().startsWith(needle)) - Number(a.name.toLocaleLowerCase().startsWith(needle)) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return [...filterSkills(skills, query).map(skill => ({ type: 'skill' as const, skill })),
    ...matchingRecipes.map(recipe => ({ type: 'recipe' as const, recipe }))];
}
