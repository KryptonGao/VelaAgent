import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseRecipeInput, type TaskRecipe, type TaskRecipeInput } from '@vela/shared';

export function writeRecipeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`; let fd: number | undefined;
  try {
    fd = openSync(temporary, 'wx', 0o600); writeFileSync(fd, JSON.stringify(value, null, 2)); fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temporary, file);
  } finally { if (fd !== undefined) closeSync(fd); rmSync(temporary, { force: true }); }
}

/** Portable documents contain templates only: no credentials, runs, settings or trusted builtin semantics. */
export function parseRecipeExchange(text: string): TaskRecipeInput[] {
  if (typeof text !== 'string' || text.length > 4_000_000) throw new Error('导入文件最多 4 MB');
  const value = JSON.parse(text);
  if (value?.format !== 'vela-task-recipes' || value.schemaVersion !== 1 || !Array.isArray(value.recipes) || !value.recipes.length || value.recipes.length > 100) throw new Error('不支持的配方导入格式');
  return value.recipes.map((raw: unknown) => { const input = parseRecipeInput(raw); delete input.sourceReference; return input; });
}
export function exportRecipeExchange(recipe: TaskRecipe): string {
  const input = parseRecipeInput(recipe); delete input.sourceReference;
  return JSON.stringify({ format: 'vela-task-recipes', schemaVersion: 1, recipes: [input] }, null, 2);
}

export class ProjectRecipeLibrary {
  constructor(private readonly workspaces: () => string[]) {}
  private root(workspace: string): string {
    if (typeof workspace !== 'string' || !this.workspaces().some(w => {
      try { return resolve(w) === resolve(workspace) || realpathSync(w) === realpathSync(workspace); } catch { return false; }
    })) throw new Error('请选择已有项目工作区');
    const root = realpathSync(workspace);
    if (!statSync(root).isDirectory()) throw new Error('项目目录不可用');
    const directory = join(root, '.vela');
    try { if (lstatSync(directory).isSymbolicLink()) throw new Error('项目配方目录不能为符号链接'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return root;
  }
  private prefix(root: string): string { return `project.${createHash('sha256').update(root).digest('hex').slice(0, 16)}.`; }
  read(workspace: string): TaskRecipe[] {
    const root = this.root(workspace); const file = join(root, '.vela', 'task-recipes.json');
    let text: string;
    try { const info = lstatSync(file); if (!info.isFile() || info.size > 4_000_000) throw new Error('项目配方文件无效或超过 4 MB'); text = readFileSync(file, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const data = JSON.parse(text);
    if (data.schemaVersion !== 1 || !Array.isArray(data.recipes) || data.recipes.length > 100) throw new Error('项目配方 schemaVersion 或格式不兼容，已停止写入');
    const recipes = data.recipes.map((raw: TaskRecipe) => {
      const input = parseRecipeInput(raw);
      if (typeof raw.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(raw.id) || !Number.isSafeInteger(raw.revision) || raw.revision < 1 || !Number.isFinite(raw.createdAt) || !Number.isFinite(raw.updatedAt)) throw new Error('项目配方元数据损坏');
      return { ...input, id: this.prefix(root) + raw.id, origin: 'project' as const, projectWorkspace: root, revision: raw.revision, createdAt: raw.createdAt, updatedAt: raw.updatedAt };
    });
    if (new Set(recipes.map((r: TaskRecipe) => r.id)).size !== recipes.length) throw new Error('项目配方 ID 重复');
    return recipes;
  }
  save(input: TaskRecipeInput, workspace: string, id?: string, revision?: number): TaskRecipe {
    const root = this.root(workspace); const recipes = this.read(workspace); const old = recipes.find(r => r.id === id);
    if (id !== undefined && (!old || old.revision !== revision)) throw new Error('项目配方已更新或删除，请重新加载');
    if (old && JSON.stringify(parseRecipeInput(old)) === JSON.stringify(input)) return old;
    const now = Date.now(); const recipe: TaskRecipe = { ...input, id: old?.id ?? this.prefix(root) + randomUUID(), origin: 'project', projectWorkspace: root,
      revision: (old?.revision ?? 0) + 1, createdAt: old?.createdAt ?? now, updatedAt: now };
    if (!old && recipes.length >= 100) throw new Error('每个项目最多 100 个配方');
    this.write(root, [...recipes.filter(r => r.id !== id), recipe]); return recipe;
  }
  delete(id: string, workspace: string): void {
    const root = this.root(workspace); const recipes = this.read(workspace);
    if (!recipes.some(r => r.id === id)) throw new Error('项目配方已删除');
    this.write(root, recipes.filter(r => r.id !== id));
  }
  private write(root: string, recipes: TaskRecipe[]): void {
    const data = { schemaVersion: 1, recipes: recipes.map(r => ({ ...parseRecipeInput(r), id: r.id.slice(this.prefix(root).length), revision: r.revision, createdAt: r.createdAt, updatedAt: r.updatedAt })) };
    if (Buffer.byteLength(JSON.stringify(data, null, 2), 'utf8') > 4_000_000) throw new Error('项目配方文件最多 4 MB，未写入');
    writeRecipeJson(join(root, '.vela', 'task-recipes.json'), data);
  }
}
