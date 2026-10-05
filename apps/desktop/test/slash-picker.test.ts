import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { SkillSummary, TaskRecipe } from '@vela/shared';
import { slashMenuItems } from '../src/renderer/components/composer/slash-picker.ts';
const skill = (enabled = true): SkillSummary => ({ name: 'review', description: 'Read a project', enabled, origin: 'project', location: '/skills/review', disableModelInvocation: false, canDelete: false });
const recipe = (id: string, name: string, description = '', tags: string[] = []): TaskRecipe => ({ id, name, description, tags, origin: 'user', revision: 1, createdAt: 1, updatedAt: 1, parameters: [], defaultMode: 'agent', objectiveTemplate: 'Review', workflowTemplate: 'Read', deliverableTemplate: 'Report' });
it('keeps skill and recipe identities separate and includes same-named recipes from distinct libraries', () => {
  const entries = slashMenuItems([skill(), { ...skill(false), location: '/disabled' }], [recipe('a', 'review'), { ...recipe('b', 'review'), origin: 'team', teamWorkspace: '/project' }], 'review');
  assert.deepEqual(entries.map(e => e.type === 'skill' ? e.skill.location : e.recipe.id), ['/skills/review', 'a', 'b']);
});
it('searches recipe names, descriptions and tags without case sensitivity and ranks name prefixes first', () => {
  const recipes = [recipe('tag', 'Bug fix', '', ['Release']), recipe('desc', 'Changelog', 'Review RELEASE notes'), recipe('name', 'Release checklist')];
  assert.deepEqual(slashMenuItems([], recipes, 'ReLeAsE').map(e => e.type === 'recipe' && e.recipe.id), ['name', 'tag', 'desc']);
  assert.equal(slashMenuItems([], recipes, 'missing').length, 0);
  assert.equal(slashMenuItems([], recipes, '').length, 3);
});
