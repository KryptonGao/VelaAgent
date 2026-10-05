import { createHash, randomUUID } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parseRecipeInput, type RecipeTeamConnection, type TaskRecipe, type TaskRecipeInput } from '@vela/shared';
import { writeRecipeJson } from './task-recipe-library';

/** A project document shared through Git/filesystem ACLs; local opt-in is not an authentication system. */
export class TeamRecipeLibraries {
  private connections: RecipeTeamConnection[] = [];
  private error: string | null = null;
  constructor(private readonly configFile: string, private readonly workspaces: () => string[]) { this.load(); }
  private load(): void {
    try {
      let text: string;
      try { const info = lstatSync(this.configFile); if (!info.isFile() || info.size > 100000) throw new Error('团队库连接文件无效'); text = readFileSync(this.configFile, 'utf8'); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') { this.connections = []; this.error = null; return; } throw e; }
      const data = JSON.parse(text);
      if (data.schemaVersion !== 1 || !Array.isArray(data.teams) || data.teams.length > 100 || data.teams.some((t: RecipeTeamConnection) => !t || typeof t.workspace !== 'string' || !isAbsolute(t.workspace) || !['read', 'write'].includes(t.permission)) || new Set(data.teams.map((t: RecipeTeamConnection) => t.workspace)).size !== data.teams.length) throw new Error('团队库连接资料损坏或版本不兼容');
      this.connections = data.teams.map((t: RecipeTeamConnection) => ({ workspace: t.workspace, permission: t.permission })); this.error = null;
    } catch (e) { this.error = (e as Error).message; }
  }
  private root(workspace: string): string {
    if (typeof workspace !== 'string' || !this.workspaces().some(w => { try { return resolve(w) === resolve(workspace) || realpathSync(w) === realpathSync(workspace); } catch { return false; } })) throw new Error('请选择已有项目工作区');
    const root = realpathSync(workspace); if (!statSync(root).isDirectory()) throw new Error('团队项目目录不存在');
    try { if (!lstatSync(join(root, '.vela')).isDirectory() || lstatSync(join(root, '.vela')).isSymbolicLink()) throw new Error('团队配方目录不能为符号链接'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    return root;
  }
  private prefix(root: string): string { return `team.${createHash('sha256').update(root).digest('hex').slice(0, 16)}.`; }
  private connection(workspace: string, write = false): RecipeTeamConnection {
    const root = this.root(workspace); const connection = this.connections.find(t => t.workspace === root);
    if (!connection || write && connection.permission !== 'write') throw new Error('团队库未连接或为只读；需要明确开启写入');
    return connection;
  }
  private persist(teams: RecipeTeamConnection[]): void {
    if (this.error) throw new Error(this.error);
    if (teams.length > 100) throw new Error('最多连接 100 个团队库');
    writeRecipeJson(this.configFile, { schemaVersion: 1, teams }); this.connections = teams;
  }
  connect(workspace: string, permission: 'read' | 'write'): void {
    if (!['read', 'write'].includes(permission)) throw new Error('共享权限不正确');
    if (this.error) this.load();
    const root = this.root(workspace);
    // Validate an existing shared document before accepting a connection, never repair/overwrite it.
    this.readDocument(root, permission);
    this.persist([...this.connections.filter(t => t.workspace !== root), { workspace: root, permission }]);
  }
  disconnect(workspace: string): void {
    if (typeof workspace !== 'string') throw new Error('团队目录不正确');
    // A disappeared project must still be disconnectable; the local registration is the authority.
    let root = resolve(workspace); try { root = realpathSync(workspace); } catch {}
    this.persist(this.connections.filter(t => t.workspace !== root));
  }
  list(): { recipes: TaskRecipe[]; teams: RecipeTeamConnection[]; errors: Record<string, string> } {
    if (this.error) this.load();
    const recipes: TaskRecipe[] = []; const errors: Record<string, string> = {};
    if (this.error) errors.connections = this.error;
    for (const team of this.connections) try { recipes.push(...this.readDocument(this.root(team.workspace), team.permission)); }
    catch (e) { errors[team.workspace] = (e as Error).message; }
    return { recipes, teams: structuredClone(this.connections), errors };
  }
  private readDocument(root: string, permission: 'read' | 'write'): TaskRecipe[] {
    const file = join(root, '.vela', 'team-task-recipes.json'); let text: string;
    try { const info = lstatSync(file); if (!info.isFile() || info.size > 4_000_000) throw new Error('团队配方文件无效、为符号链接或超过 4 MB'); text = readFileSync(file, 'utf8'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
    const data = JSON.parse(text);
    if (data.schemaVersion !== 1 || !Array.isArray(data.recipes) || data.recipes.length > 100) throw new Error('团队配方格式或 schemaVersion 不兼容，已停止写入');
    const recipes = data.recipes.map((raw: TaskRecipe) => {
      const input = parseRecipeInput(raw); delete input.sourceReference;
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw.id) || !Number.isSafeInteger(raw.revision) || raw.revision < 1 || !Number.isFinite(raw.createdAt) || !Number.isFinite(raw.updatedAt)) throw new Error('团队配方版本元数据损坏');
      return { ...input, id: this.prefix(root) + raw.id, revision: raw.revision, origin: 'team' as const, createdAt: raw.createdAt, updatedAt: raw.updatedAt,
        teamWorkspace: root, teamPermission: permission, teamFingerprint: createHash('sha256').update(JSON.stringify(raw)).digest('hex') };
    });
    if (new Set(recipes.map((r: TaskRecipe) => r.id)).size !== recipes.length) throw new Error('团队配方 ID 重复');
    return recipes;
  }
  save(raw: TaskRecipeInput, workspace: string, id?: string, revision?: number, fingerprint?: string): TaskRecipe {
    const input = parseRecipeInput(raw); delete input.sourceReference;
    return this.mutate(workspace, recipes => {
      const previous = recipes.find(r => r.id === id);
      if (id !== undefined && (!previous || previous.revision !== revision || previous.teamFingerprint !== fingerprint)) throw new Error('团队配方已更新或删除，请刷新后重新审阅');
      if (previous && JSON.stringify(parseRecipeInput(previous)) === JSON.stringify(input)) return { recipes, recipe: previous, changed: false };
      if (!previous && recipes.length >= 100) throw new Error('团队库最多 100 个配方');
      const now = Date.now(); const root = this.connection(workspace, true).workspace;
      const recipe: TaskRecipe = { ...input, id: previous?.id ?? this.prefix(root) + randomUUID(), origin: 'team', teamWorkspace: root, teamPermission: 'write',
        revision: (previous?.revision ?? 0) + 1, createdAt: previous?.createdAt ?? now, updatedAt: now };
      return { recipes: [...recipes.filter(r => r.id !== id), recipe], recipe, changed: true };
    });
  }
  delete(id: string, workspace: string, fingerprint?: string): void {
    this.mutate(workspace, recipes => {
      const previous = recipes.find(r => r.id === id);
      if (!previous || previous.teamFingerprint !== fingerprint) throw new Error('团队配方已更新或删除，请刷新后重新审阅');
      return { recipes: recipes.filter(r => r.id !== id), recipe: previous, changed: true };
    });
  }
  private mutate(workspace: string, change: (recipes: TaskRecipe[]) => { recipes: TaskRecipe[]; recipe: TaskRecipe; changed: boolean }): TaskRecipe {
    if (this.error) throw new Error(this.error);
    const root = this.connection(workspace, true).workspace; const file = join(root, '.vela', 'team-task-recipes.json');
    mkdirSync(dirname(file), { recursive: true }); const lock = `${file}.lock`; let descriptor: number;
    try { descriptor = openSync(lock, 'wx', 0o600); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('团队库正在写入；若上次进程中断，请确认后手动移除 .lock 文件'); throw e; }
    try {
      this.root(root); const result = change(this.readDocument(root, 'write'));
      if (!result.changed) return result.recipe;
      const data = { schemaVersion: 1, recipes: result.recipes.map(r => ({ ...parseRecipeInput(r), id: r.id.slice(this.prefix(root).length), revision: r.revision, createdAt: r.createdAt, updatedAt: r.updatedAt })) };
      if (Buffer.byteLength(JSON.stringify(data, null, 2)) > 4_000_000) throw new Error('团队配方文件最多 4 MB，未写入');
      writeRecipeJson(file, data);
      return this.readDocument(root, 'write').find(r => r.id === result.recipe.id) ?? result.recipe;
    } finally { closeSync(descriptor); rmSync(lock, { force: true }); }
  }
}
