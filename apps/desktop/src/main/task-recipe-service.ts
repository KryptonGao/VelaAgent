import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { lstat, realpath, stat, readFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expandRecipe, expandStageInstructions, recipeStageSelected, canRetryRecipeStage, parseRecipeInput, RecipeValidationError, validateRecipeValues, thinkingLevels,
  type RecipeContext, type RecipeExecution, type RecipePreview, type RecipeRun, type RecipeRunStatus,
  type RecipeStageSubmission, type RecipeSubmitResult, type RecipeStageRun, type RecipeStageEvidence, type RecipeUseDraft, type TaskRecipe, type TaskRecipeInput, type TaskRecipesState } from '@vela/shared';
import { builtinRecipes } from './task-recipe-builtins';
import { ProjectRecipeLibrary } from './task-recipe-library';
import { TeamRecipeLibraries } from './task-recipe-team';
import { createLogger } from "@vela/shared";

const log = createLogger("recipes");

export interface RecipeHostRuntime {
  resolveExecution(draft: RecipeUseDraft): Promise<RecipeExecution>;
  create(run: RecipeRun): Promise<void>;
  submit(run: RecipeRun, stage?: RecipeStageSubmission): Promise<RecipeSubmitResult>;
  beginWorkflow?(run: RecipeRun): Promise<void>;
  finishWorkflow?(run: RecipeRun): void;
  workspaces(): string[];
  runningWorkspaces(): string[];
  skills?(workspace: string): Promise<import('@vela/shared').SkillCatalog>;
  worktreePath?(branch: string): string;
  createWorktree?(run: RecipeRun): Promise<void>;
  removeWorktree?(run: RecipeRun): Promise<void>;
  trustedSnapshot?(recipe: TaskRecipe): boolean;
}
interface Store { schemaVersion: 1; recipes: TaskRecipe[]; runs: RecipeRun[] }
const activeStatuses: RecipeRunStatus[] = ['starting', 'running', 'waiting_for_user'];
const digest = (value: unknown) => createHash('sha256').update(stable(value)).digest('hex');
function stable(value: unknown): string { return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item); }
const exec = promisify(execFile);

/** Main-process authority. Every mutation is synchronous, atomic and durable before effects. */
export class TaskRecipeService {
  private store: Store = { schemaVersion: 1, recipes: [], runs: [] };
  private error: string | null = null;
  private loaded = false;
  private stopped = false;
  private readonly pending = new Map<string, Promise<RecipeRun>>();
  private readonly effects = new Set<Promise<void>>();
  private readonly effectsByRun = new Map<string, Promise<void>>();
  private readonly projects: ProjectRecipeLibrary;
  private readonly teams: TeamRecipeLibraries;
  private readonly approvals = new Map<string, (approved: boolean) => void>();
  private readonly retrying = new Set<string>();
  private readonly retryPending = new Map<string, { stageId: string; promise: Promise<RecipeRun> }>();
  private readonly listeners = new Set<() => void>();
  private readonly waits = new Map<string, string>();
  private readonly cleaningWorkspaces = new Set<string>();
  constructor(private readonly file: string, private readonly runtime: RecipeHostRuntime) { this.projects = new ProjectRecipeLibrary(() => runtime.workspaces()); this.teams = new TeamRecipeLibraries(`${file}.teams.json`, () => runtime.workspaces()); }
  init(): void { this.load(); }
  private load(): void {
    try {
      let raw: string;
      try { raw = readFileSync(this.file, 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { this.loaded = true; this.error = null; return; } throw error; }
      const store = JSON.parse(raw) as Store;
      if (store.schemaVersion !== 1) throw new Error('任务配方 schemaVersion 不兼容，已停止写入');
      if (!Array.isArray(store.recipes) || !Array.isArray(store.runs)) throw new Error('任务配方资料损坏');
      for (const recipe of store.recipes) { this.parseSnapshot(recipe); if (recipe.origin !== 'user') throw new Error('用户库包含非法内置配方'); }
      // Historical built-ins retain their old content across application upgrades.
      for (const run of store.runs) {
        const snapshot = run?.recipeSnapshot;
        parseRecipeInput(snapshot);
        this.validateProgress(run);
        if (!snapshot || typeof snapshot.id !== 'string' || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 1) throw new Error('配方快照损坏');
        if (!run || typeof run.id !== 'string' || typeof run.requestId !== 'string' || typeof run.inputDigest !== 'string' || typeof run.conversationId !== 'string' ||
          !['starting', 'running', 'waiting_for_user', 'responded', 'failed', 'stopped', 'interrupted'].includes(run.status) || !Number.isFinite(run.startedAt) || typeof run.expandedPrompt !== 'string' ||
          !run.resolvedContext || typeof run.resolvedContext.path !== 'string' || typeof run.resolvedContext.name !== 'string' || !run.resolvedContext.paths ||
          !run.resolvedExecution || typeof run.resolvedExecution.model?.provider !== 'string' || typeof run.resolvedExecution.model?.id !== 'string' ||
          !['ask', 'smart', 'full'].includes(run.resolvedExecution.sandboxMode) || !(thinkingLevels as readonly string[]).includes(run.resolvedExecution.thinkingLevel) ||
          !['agent', 'plan'].includes(run.mode) || typeof run.workspace !== 'string' || typeof run.additionalInstructions !== 'string' ||
          run.recipeId !== snapshot.id || typeof run.conversationBound !== 'boolean' || (run.sendIntentAt !== null && !Number.isFinite(run.sendIntentAt)) ||
          (run.finishedAt !== null && !Number.isFinite(run.finishedAt)) || (run.error !== null && typeof run.error !== 'string') ||
          Object.keys(validateRecipeValues(run.recipeSnapshot, run.values)).length) throw new Error('任务配方使用记录损坏');
        if (run.worktree && (typeof run.worktree.sourceWorkspace !== 'string' || !isAbsolute(run.worktree.sourceWorkspace) || typeof run.worktree.path !== 'string' || !isAbsolute(run.worktree.path) ||
          typeof run.worktree.branch !== 'string' || !/^vela\/recipe-[a-zA-Z0-9-]{1,80}$/.test(run.worktree.branch) || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(run.worktree.startSha) || run.worktree.includeUncommitted !== false)) throw new Error('配方 worktree 记录损坏');
        if (run.worktreeRemovedAt !== undefined && !Number.isFinite(run.worktreeRemovedAt) || run.trigger !== undefined && !['manual', 'scheduled'].includes(run.trigger)) throw new Error('配方使用记录元数据损坏');
      }
      if (new Set(store.recipes.map(r => r.id)).size !== store.recipes.length || new Set(store.runs.map(r => r.requestId)).size !== store.runs.length || new Set(store.runs.map(r => r.id)).size !== store.runs.length) throw new Error('任务配方 ID 重复');
      this.store = store; this.loaded = true; this.error = null;
      if (store.runs.some(r => activeStatuses.includes(r.status))) this.commit(next => {
        for (const run of next.runs) if (activeStatuses.includes(run.status)) Object.assign(run, { stages: this.interruptStages(run.stages), status: 'interrupted', finishedAt: Date.now(), error: '应用退出导致初始回合中断；请查看关联对话，不自动重发' });
      });
    } catch (error) { this.loaded = false; this.error = error instanceof Error ? error.message : String(error); }
  }
  list(locale: 'zh-CN' | 'en' = 'zh-CN'): TaskRecipesState {
    if (locale !== 'en' && locale !== 'zh-CN') throw new Error('语言不正确');
    if (!this.loaded) this.load();
    const projectRecipes: TaskRecipe[] = []; const projectErrors: Record<string, string> = {};
    const seen = new Set<string>();
    for (const workspace of this.runtime.workspaces()) {
      try { for (const recipe of this.projects.read(workspace)) if (!seen.has(recipe.id)) { seen.add(recipe.id); projectRecipes.push(recipe); } }
      catch (error) { projectErrors[workspace] = error instanceof Error ? error.message : String(error); }
    }
    const teamState = this.teams.list();
    return structuredClone({ recipes: [...builtinRecipes(locale), ...this.store.recipes, ...projectRecipes, ...teamState.recipes], runs: this.store.runs, error: this.error, projectErrors, teams: teamState.teams, teamErrors: teamState.errors });
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  save(raw: TaskRecipeInput, id?: string, expectedRevision?: number, projectWorkspace?: string): TaskRecipe {
    this.assertWritable(); const input = parseRecipeInput(raw); const now = Date.now();
    if (projectWorkspace !== undefined) { const recipe = this.projects.save(input, projectWorkspace, id, expectedRevision); this.emit(); return recipe; }
    const previous = id === undefined ? undefined : this.store.recipes.find(r => r.id === id);
    if (id !== undefined && !previous) throw new Error('配方不存在或为只读内置配方');
    if (previous && previous.revision !== expectedRevision) throw new Error('配方已更新，请重新加载后保存');
    if (previous && stable(parseRecipeInput(previous)) === stable(input)) return structuredClone(previous);
    const recipe: TaskRecipe = { ...input, id: previous?.id ?? randomUUID(), origin: 'user', revision: (previous?.revision ?? 0) + 1, createdAt: previous?.createdAt ?? now, updatedAt: now };
    this.commit(next => { next.recipes = next.recipes.filter(r => r.id !== recipe.id); next.recipes.push(recipe); });
    return structuredClone(recipe);
  }
  connectTeam(workspace: string, permission: 'read' | 'write'): void { this.assertWritable(); this.teams.connect(workspace, permission); this.emit(); }
  disconnectTeam(workspace: string): void { this.assertWritable(); this.teams.disconnect(workspace); this.emit(); }
  saveTeam(input: TaskRecipeInput, workspace: string, id?: string, revision?: number, fingerprint?: string): TaskRecipe {
    this.assertWritable(); const recipe = this.teams.save(input, workspace, id, revision, fingerprint); this.emit(); return recipe;
  }
  delete(id: string, fingerprint?: string): void {
    this.assertWritable();
    const team = this.list().recipes.find(r => r.id === id && r.origin === 'team');
    if (team) { this.teams.delete(id, team.teamWorkspace!, fingerprint); this.emit(); return; }
    const project = this.list().recipes.find(r => r.id === id && r.origin === 'project');
    if (project) { this.projects.delete(id, project.projectWorkspace!); this.emit(); return; }
    if (!this.store.recipes.some(r => r.id === id)) throw new Error('配方不存在或为只读内置配方');
    this.commit(next => { next.recipes = next.recipes.filter(r => r.id !== id); });
  }
  private parseSnapshot(raw: unknown): TaskRecipe {
    const input = parseRecipeInput(raw); const r = raw as TaskRecipe;
    if (typeof r.id !== 'string' || !r.id || r.id.length > 200 || !['user', 'builtin', 'project', 'team'].includes(r.origin) || !Number.isSafeInteger(r.revision) || r.revision < 1 || !Number.isFinite(r.createdAt) || !Number.isFinite(r.updatedAt)) throw new Error('配方快照不正确');
    if (r.origin === 'project' && (typeof r.projectWorkspace !== 'string' || !isAbsolute(r.projectWorkspace) || !r.id.startsWith('project.'))) throw new Error('项目配方快照不正确');
    if (r.origin === 'team' && (typeof r.teamWorkspace !== 'string' || !isAbsolute(r.teamWorkspace) || !r.id.startsWith('team.'))) throw new Error('团队配方快照不正确');
    if (r.origin === 'user' && r.id.startsWith('vela.recipe.')) throw new Error('内置 ID 不能作为用户配方');
    if (r.origin === 'builtin') {
      const builtin = builtinRecipes(r.locale).find(b => b.id === r.id);
      // Current bundled definitions or persisted historical snapshots only.
      if (!builtin || (stable(builtin) !== stable(r) && !this.store.runs.some(run => stable(run.recipeSnapshot) === stable(r)) && !this.runtime.trustedSnapshot?.(r))) throw new Error('内置配方快照不正确');
    }
    return { ...input, id: r.id, origin: r.origin, revision: r.revision, createdAt: r.createdAt, updatedAt: r.updatedAt,
      ...(r.origin === 'builtin' ? { builtinKind: r.builtinKind, builtinVersion: r.builtinVersion, locale: r.locale } : {}), ...(r.origin === 'project' ? { projectWorkspace: r.projectWorkspace } : {}), ...(r.origin === 'team' ? { teamWorkspace: r.teamWorkspace } : {}) };
  }
  private parseDraft(raw: RecipeUseDraft): RecipeUseDraft {
    if (!raw || typeof raw !== 'object') throw new Error('使用参数不正确');
    const recipeSnapshot = this.parseSnapshot(raw.recipeSnapshot);
    if (typeof raw.workspace !== 'string' || !raw.workspace || raw.workspace.length > 4096) throw new RecipeValidationError({ workspace: '请选择已有工作区' });
    if (raw.mode !== 'agent' && raw.mode !== 'plan') throw new RecipeValidationError({ mode: '仅支持 Agent / Plan' });
    if (typeof raw.additionalInstructions !== 'string' || raw.additionalInstructions.length > 10000) throw new RecipeValidationError({ additionalInstructions: '补充要求最多 10,000 字符' });
    if (raw.sandboxModeOverride != null && !['ask', 'smart', 'full'].includes(raw.sandboxModeOverride)) throw new RecipeValidationError({ sandboxModeOverride: '执行权限不正确' });
    if (raw.thinkingLevelOverride != null && !(thinkingLevels as readonly string[]).includes(raw.thinkingLevelOverride)) throw new RecipeValidationError({ thinkingLevelOverride: '思考强度不正确' });
    if (raw.modelOverride != null && (typeof raw.modelOverride.provider !== 'string' || !raw.modelOverride.provider || raw.modelOverride.provider.length > 200 || typeof raw.modelOverride.id !== 'string' || !raw.modelOverride.id || raw.modelOverride.id.length > 200)) throw new RecipeValidationError({ modelOverride: '模型选择不正确' });
    const errors = validateRecipeValues(recipeSnapshot, raw.values); if (Object.keys(errors).length) throw new RecipeValidationError(errors);
    if (raw.autoWorktree != null && (typeof raw.autoWorktree.startRef !== 'string' || !raw.autoWorktree.startRef.trim() || raw.autoWorktree.startRef.length > 500 ||
      typeof raw.autoWorktree.branch !== 'string' || !/^vela\/recipe-[a-zA-Z0-9-]{1,80}$/.test(raw.autoWorktree.branch) || raw.autoWorktree.includeUncommitted !== false)) throw new RecipeValidationError({ autoWorktree: '请选择起始提交；分支需匹配 vela/recipe-名称；不带入未提交文件' });
    return structuredClone({ recipeSnapshot, workspace: raw.workspace, mode: raw.mode, values: raw.values, additionalInstructions: raw.additionalInstructions,
      modelOverride: raw.modelOverride ? { provider: raw.modelOverride.provider, id: raw.modelOverride.id } : null, thinkingLevelOverride: raw.thinkingLevelOverride ?? null, sandboxModeOverride: raw.sandboxModeOverride ?? null,
      ...(raw.autoWorktree ? { autoWorktree: { startRef: raw.autoWorktree.startRef, branch: raw.autoWorktree.branch, includeUncommitted: false } } : {}) });
  }
  async preview(raw: RecipeUseDraft): Promise<RecipePreview> {
    const result: RecipePreview = { errors: {}, expandedPrompt: '', fingerprint: '', context: null, execution: null, concurrent: false };
    try {
      this.assertWritable(); const draft = this.parseDraft(raw);
      if (draft.mode === 'agent' && draft.recipeSnapshot.stages?.length && !draft.recipeSnapshot.stages.some(stage => recipeStageSelected(stage, draft.values))) throw new RecipeValidationError({ stages: '本次条件未匹配任何阶段，请调整参数或配方' });
      const context = draft.autoWorktree ? await this.worktreeContext(draft) : await this.context(draft);
      context.skills = await this.resolveSkills(draft.recipeSnapshot, draft.workspace);
      const execution = await this.runtime.resolveExecution(draft);
      result.context = context; result.execution = execution;
      result.expandedPrompt = expandRecipe(draft.recipeSnapshot, draft.values, context, draft.additionalInstructions);
      // Runtime/session input size is bounded independently of template size.
      if (result.expandedPrompt.length > 300000) throw new RecipeValidationError({ values: '展开正文过长（最多 300,000 字符）' });
      const runningRoots = await Promise.all(this.runtime.runningWorkspaces().map(async w => { try { return await realpath(w); } catch { return resolve(w); } }));
      result.concurrent = runningRoots.includes(context.path);
      result.fingerprint = digest({ draft, context, execution, expandedPrompt: result.expandedPrompt });
    } catch (error) { result.errors = error instanceof RecipeValidationError ? error.fields : { preview: error instanceof Error ? error.message : String(error) }; }
    return result;
  }
  start(raw: { requestId: string; draft: RecipeUseDraft; fingerprint: string; trigger?: 'manual' | 'scheduled' }): Promise<RecipeRun> {
    if (!raw || typeof raw.requestId !== 'string' || !/^[0-9a-f-]{36}$/i.test(raw.requestId) || typeof raw.fingerprint !== 'string') return Promise.reject(new Error('启动请求不正确'));
    if (raw.trigger !== undefined && !['manual', 'scheduled'].includes(raw.trigger)) return Promise.reject(new Error('触发方式不正确'));
    const inputDigest = digest(raw);
    const existing = this.store.runs.find(r => r.requestId === raw.requestId);
    if (existing) return existing.inputDigest === inputDigest ? Promise.resolve(structuredClone(existing)) : Promise.reject(new Error('相同 requestId 不能携带不同内容'));
    const pending = this.pending.get(raw.requestId);
    if (pending) return pending.then(run => { if (run.inputDigest !== inputDigest) throw new Error('相同 requestId 不能携带不同内容'); return run; });
    const promise = this.claim(raw, inputDigest);
    this.pending.set(raw.requestId, promise);
    void promise.finally(() => this.pending.delete(raw.requestId)).catch(() => undefined);
    return promise;
  }
  private async claim(raw: { requestId: string; draft: RecipeUseDraft; fingerprint: string; trigger?: 'manual' | 'scheduled' }, inputDigest: string): Promise<RecipeRun> {
    this.assertWritable(); if (this.stopped) throw new Error('应用正在退出');
    const draft = this.parseDraft(raw.draft); const preview = await this.preview(draft);
    if (Object.keys(preview.errors).length) throw new RecipeValidationError(preview.errors);
    if (preview.fingerprint !== raw.fingerprint) throw new Error('目录、路径、Git 或启动设置已变化，请查看更新后的预览再开始');
    if (this.cleaningWorkspaces.has(preview.context!.path)) throw new Error('worktree 正在清理，不能启动任务');
    if (this.stopped) throw new Error('应用正在退出');
    const run: RecipeRun = { id: randomUUID(), requestId: raw.requestId, inputDigest, recipeId: draft.recipeSnapshot.id, recipeSnapshot: draft.recipeSnapshot,
      values: draft.values, additionalInstructions: draft.additionalInstructions, mode: draft.mode, resolvedContext: preview.context!, expandedPrompt: preview.expandedPrompt,
      workspace: preview.context!.path, resolvedExecution: preview.execution!, conversationId: randomUUID(), conversationBound: false, sendIntentAt: null,
      ...(draft.mode === 'agent' && draft.recipeSnapshot.stages?.length ? { stages: draft.recipeSnapshot.stages.map(stage => ({ stageId: stage.id, status: recipeStageSelected(stage, draft.values) ? 'pending' as const : 'skipped' as const, attempts: [] })) } : {}),
      status: 'starting', startedAt: Date.now(), finishedAt: null, error: null, ...(preview.context!.worktree ? { worktree: preview.context!.worktree } : {}), ...(raw.trigger ? { trigger: raw.trigger } : {}) };
    this.commit(next => { next.runs.push(run); }); // Reserve the conversation ID before creating anything.
    let created = false;
    let checking = false;
    try {
      if (run.worktree) {
        if (!this.runtime.createWorktree) throw new Error('独立 worktree 不可用');
        await this.runtime.createWorktree(structuredClone(run));
        const targetDraft = { ...draft, workspace: run.worktree.path, autoWorktree: null };
        const actualContext = await this.context(targetDraft);
        await this.assertCreatedWorktree(actualContext.path, run.worktree.startSha);
        actualContext.skills = await this.resolveSkills(draft.recipeSnapshot, run.worktree.path);
        if (stable(actualContext.skills.map(({ name, fingerprint }) => ({ name, fingerprint }))) !== stable((preview.context!.skills ?? []).map(({ name, fingerprint }) => ({ name, fingerprint })))) throw new Error('独立 worktree 的 Skill 与预览不同，请检查项目 Skill');
        // Preserve the reviewed prompt, whose workspace already points to the reserved worktree.
        run.resolvedContext = { ...actualContext, worktree: run.worktree }; run.workspace = actualContext.path;
        this.patch(run.id, { workspace: run.workspace, resolvedContext: run.resolvedContext });
      }
      await this.runtime.create(structuredClone(run));
      created = true;
      if (this.stopped) return this.run(run.id);
      // Resource/session setup may await IO. Recheck immediately before sending intent too.
      checking = true;
      const current = await this.preview(draft);
      if (Object.keys(current.errors).length) throw new RecipeValidationError(current.errors);
      if (current.fingerprint !== raw.fingerprint) throw new Error('启动准备期间目录、路径、Git 或设置已变化；任务未提交，请重新预览');
      if (run.worktree) {
        await this.assertCreatedWorktree(run.workspace, run.worktree.startSha);
        const targetContext = await this.context({ ...draft, workspace: run.workspace, autoWorktree: null });
        targetContext.skills = await this.resolveSkills(draft.recipeSnapshot, run.workspace);
        if (stable(targetContext) !== stable({ ...run.resolvedContext, worktree: undefined })) throw new Error('启动准备期间独立 worktree 的路径、Git 或 Skill 已变化；任务未提交');
      }
      checking = false;
      if (this.stopped) return this.run(run.id);
      this.patch(run.id, { conversationBound: true });
      this.patch(run.id, { sendIntentAt: Date.now(), status: 'running' }); // Never replay this intent.
      const effect = Promise.resolve().then(async () => {
        if (this.stopped) return;
        try {
          if (run.stages) await this.executeStages(run.id);
          else { const result = await this.runtime.submit(structuredClone(run)); this.patch(run.id, { status: result.status, planPending: result.planPending, error: result.error ?? null, finishedAt: Date.now() }); }
        }
        catch (error) { this.patch(run.id, { stages: this.interruptStages(this.run(run.id).stages), status: 'failed', error: error instanceof Error ? error.message : String(error), finishedAt: Date.now() }); }
      }).catch(error => {
        this.error = `使用记录写入失败：${String(error)}`;
        const current = this.store.runs.find(r => r.id === run.id)!;
        if (activeStatuses.includes(current.status)) Object.assign(current, { stages: this.interruptStages(current.stages), status: 'interrupted', finishedAt: Date.now(), error: this.error });
        this.emit();
      }).finally(() => { this.runtime.finishWorkflow?.(this.run(run.id)); this.effects.delete(effect); this.effectsByRun.delete(run.id); });
      this.effects.add(effect); this.effectsByRun.set(run.id, effect);
    } catch (error) {
      // Reserved ID remains visible even when creation/binding outcomes cannot be confirmed.
      try { this.patch(run.id, { status: created && !checking ? 'interrupted' : 'failed', error: error instanceof Error ? error.message : String(error), finishedAt: Date.now() }); }
      catch (writeError) {
        this.error = `启动结果无法保存，请检查关联对话：${String(writeError)}`;
        // Stop all retries in this process too; durable starting claim becomes interrupted on restart.
        Object.assign(this.store.runs.find(r => r.id === run.id)!, { status: 'interrupted', finishedAt: Date.now(), error: this.error }); this.emit();
      }
    }
    return this.run(run.id);
  }
  private validateProgress(run: RecipeRun): void {
    if (run.stages !== undefined) {
      const definitions = run.recipeSnapshot?.stages;
      if (!Array.isArray(run.stages) || !definitions || run.stages.length !== definitions.length || run.mode !== 'agent') throw new Error('阶段记录损坏');
      run.stages.forEach((stage, i) => {
        const definition = definitions[i]!;
        if (!stage || stage.stageId !== definition.id || !['pending', 'skipped', 'waiting_for_approval', 'running', 'responded', 'failed', 'stopped', 'interrupted'].includes(stage.status) || !Array.isArray(stage.attempts) || stage.attempts.length > definition.retryLimit + 1) throw new Error('阶段记录损坏');
        if (stage.approval !== undefined && (typeof stage.approval.approved !== 'boolean' || !Number.isFinite(stage.approval.at))) throw new Error('阶段审批损坏');
        stage.attempts.forEach((attempt, index) => {
          if (!attempt || attempt.attempt !== index + 1 || !['running', 'responded', 'failed', 'stopped', 'interrupted'].includes(attempt.status) || !Number.isFinite(attempt.startedAt) || !Number.isFinite(attempt.sendIntentAt) || (attempt.finishedAt !== null && !Number.isFinite(attempt.finishedAt)) || (attempt.error !== null && typeof attempt.error !== 'string') || typeof attempt.retrySafe !== 'boolean' || !this.validEvidence(attempt.evidence) || attempt.retrySafe && (definition.sideEffect !== 'read_only' || attempt.status !== 'failed')) throw new Error('阶段尝试记录损坏');
        });
      });
    }
    if (run.outcome !== undefined && (!run.outcome || !['accepted', 'needs_work'].includes(run.outcome.rating) || typeof run.outcome.note !== 'string' || run.outcome.note.length > 2000 || !Number.isFinite(run.outcome.updatedAt))) throw new Error('效果评价损坏');
    if (run.retryRequests !== undefined && (!Array.isArray(run.retryRequests) || run.retryRequests.length > 60 || run.retryRequests.some(r => !r || typeof r.requestId !== 'string' || !/^[0-9a-f-]{36}$/i.test(r.requestId) || !run.stages?.some(s => s.stageId === r.stageId)) || new Set(run.retryRequests.map(r => r.requestId)).size !== run.retryRequests.length)) throw new Error('阶段重试请求损坏');
  }
  private validEvidence(evidence: unknown): evidence is RecipeStageEvidence[] {
    return Array.isArray(evidence) && evidence.length <= 10000 && evidence.every(e => e && ['tool', 'response'].includes(e.type) && typeof e.id === 'string' && e.id.length > 0 && e.id.length <= 200 && typeof e.label === 'string' && e.label.length <= 300);
  }
  private interruptStages(stages: RecipeStageRun[] | undefined): RecipeStageRun[] | undefined {
    return stages?.map(stage => ['running', 'waiting_for_approval'].includes(stage.status) ? { ...stage, status: 'interrupted', attempts: stage.attempts.map(a => a.status === 'running' ? { ...a, status: 'interrupted', finishedAt: Date.now(), retrySafe: false, error: '阶段执行中断；不自动重发' } : a) } : stage);
  }
  private async executeStages(id: string, resumeAt = 0): Promise<void> {
    const initial = this.run(id);
    await this.runtime.beginWorkflow?.(initial);
    const definitions = initial.recipeSnapshot.stages!;
    for (let i = resumeAt; i < definitions.length; i++) {
      if (this.stopped || !activeStatuses.includes(this.run(id).status)) return;
      const definition = definitions[i]!; const progress = this.run(id).stages![i]!;
      if (progress.status === 'skipped' || progress.status === 'responded') continue;
      if (definition.approvalRequired && !progress.approval?.approved) {
        const key = `${id}:${definition.id}`;
        const approval = new Promise<boolean>(resolveApproval => this.approvals.set(key, resolveApproval));
        try {
          this.commit(next => { const run = next.runs.find(r => r.id === id)!; run.stages![i]!.status = 'waiting_for_approval'; run.status = 'waiting_for_user'; });
          if (!await approval) return;
        } finally { this.approvals.delete(key); }
      }
      if (this.stopped || !activeStatuses.includes(this.run(id).status)) return;
      const current = this.run(id); const now = Date.now(); const attempt = current.stages![i]!.attempts.length + 1;
      this.commit(next => {
        const run = next.runs.find(r => r.id === id)!; const stage = run.stages![i]!;
        stage.status = 'running'; stage.attempts.push({ attempt, status: 'running', startedAt: now, finishedAt: null, sendIntentAt: now, error: null, evidence: [], retrySafe: false });
        run.status = 'running'; run.sendIntentAt ??= now;
      });
      const stagePrompt = `${current.expandedPrompt}\n\n## 当前阶段 / Current stage: ${definition.name} [${definition.id}] · attempt ${attempt}\n只执行此阶段，后续阶段由运行时单独启动。Only execute this stage; the runtime starts later stages.\n副作用范围 / Effect boundary: ${definition.sideEffect}\n${expandStageInstructions(definition, current.recipeSnapshot, current.values, current.resolvedContext)}`;
      let result: RecipeSubmitResult;
      try { result = await this.runtime.submit(this.run(id), { id: definition.id, name: definition.name, prompt: stagePrompt, attempt, sideEffect: definition.sideEffect }); }
      catch (e) { result = { status: 'failed', error: (e as Error).message, retrySafe: false }; }
      if (!['responded', 'failed', 'stopped'].includes(result.status) || result.evidence !== undefined && !this.validEvidence(result.evidence)) throw new Error('运行时无法确认阶段结果');
      if (this.stopped || !activeStatuses.includes(this.run(id).status)) return;
      this.commit(next => {
        const run = next.runs.find(r => r.id === id)!; const stage = run.stages![i]!; const record = stage.attempts.at(-1)!;
        Object.assign(record, { status: result.status, finishedAt: Date.now(), error: result.error ?? null, evidence: result.evidence ?? [], retrySafe: result.status === 'failed' && definition.sideEffect === 'read_only' && result.retrySafe === true });
        stage.status = result.status;
        if (result.status !== 'responded') Object.assign(run, { status: result.status, finishedAt: Date.now(), error: result.error ?? null });
      });
      if (result.status !== 'responded') return;
    }
    this.patch(id, { status: 'responded', error: null, finishedAt: Date.now() });
  }
  evidenceReference(id: string, stageId: string, attempt: number, evidenceId: string): { run: RecipeRun; evidence: RecipeStageEvidence } {
    const run = this.run(id); const evidence = run.stages?.find(s => s.stageId === stageId)?.attempts.find(a => a.attempt === attempt)?.evidence.find(e => e.id === evidenceId);
    if (!evidence) throw new Error('此证据不属于该阶段尝试');
    return { run, evidence };
  }
  approveStage(id: string, stageId: string, approved: boolean): RecipeRun {
    this.assertWritable(); if (typeof approved !== 'boolean') throw new Error('审批结果不正确');
    const run = this.run(id); const stage = run.stages?.find(s => s.stageId === stageId);
    if (stage?.approval?.approved === approved) return run;
    const gate = this.approvals.get(`${id}:${stageId}`);
    if (run.status !== 'waiting_for_user' || stage?.status !== 'waiting_for_approval' || !gate) throw new Error('阶段不在等待审批，或该执行已中断');
    this.commit(next => {
      const record = next.runs.find(r => r.id === id)!; const progress = record.stages!.find(s => s.stageId === stageId)!;
      progress.approval = { approved, at: Date.now() };
      progress.status = approved ? 'pending' : 'stopped';
      record.status = approved ? 'running' : 'stopped';
      if (!approved) { record.finishedAt = Date.now(); record.error = '用户拒绝阶段审批，后续阶段未执行'; }
    });
    gate(approved); return this.run(id);
  }
  stopConversation(conversationId: string): void {
    const run = this.store.runs.find(r => r.conversationId === conversationId && activeStatuses.includes(r.status)); if (!run) return;
    try {
      this.commit(next => {
        const record = next.runs.find(r => r.id === run.id)!;
        record.stages = this.interruptStages(record.stages)?.map(s => s.status === 'interrupted' ? { ...s, status: 'stopped', attempts: s.attempts.map(a => a.status === 'interrupted' ? { ...a, status: 'stopped' } : a) } : s);
        Object.assign(record, { status: 'stopped', finishedAt: Date.now(), error: '用户停止任务；不回滚已发生的操作' });
      });
    } catch (e) {
      this.error = `停止结果无法保存：${String(e)}`;
      Object.assign(run, { stages: this.interruptStages(run.stages), status: 'interrupted', finishedAt: Date.now(), error: this.error }); this.emit();
    } finally {
      for (const [key, gate] of this.approvals) if (key.startsWith(`${run.id}:`)) { gate(false); this.approvals.delete(key); }
    }
  }
  retryStage(id: string, stageId: string, requestId: string): Promise<RecipeRun> {
    const key = `${id}:${requestId}`; const pending = this.retryPending.get(key);
    if (pending) return pending.stageId === stageId ? pending.promise : Promise.reject(new Error('相同重试 ID 不能更换阶段'));
    const promise = this.claimRetry(id, stageId, requestId); this.retryPending.set(key, { stageId, promise });
    void promise.finally(() => this.retryPending.delete(key)).catch(() => undefined); return promise;
  }
  private async claimRetry(id: string, stageId: string, requestId: string): Promise<RecipeRun> {
    this.assertWritable(); if (this.stopped || typeof requestId !== 'string' || !/^[0-9a-f-]{36}$/i.test(requestId)) throw new Error('重试请求不正确');
    const run = this.run(id); const previous = run.retryRequests?.find(r => r.requestId === requestId);
    if (previous) { if (previous.stageId !== stageId) throw new Error('相同重试 ID 不能更换阶段'); return run; }
    if (this.retrying.has(id) || this.effectsByRun.has(id)) throw new Error('此阶段正在提交或运行，请稍后检查记录');
    if (run.trigger === 'scheduled') throw new Error('定时执行失败后请从快照新建手动任务，不重写调度结果');
    if (!canRetryRecipeStage(run, stageId)) throw new Error('仅已确认失败的只读阶段可限次重试；中断、修改和外部操作需检查后新建任务');
    this.retrying.add(id);
    try {
      const draft: RecipeUseDraft = { recipeSnapshot: run.recipeSnapshot, workspace: run.workspace, values: run.values, additionalInstructions: run.additionalInstructions, mode: run.mode,
        modelOverride: run.resolvedExecution.model, thinkingLevelOverride: run.resolvedExecution.thinkingLevel, sandboxModeOverride: run.resolvedExecution.sandboxMode };
      const preview = await this.preview(draft);
      if (Object.keys(preview.errors).length) throw new RecipeValidationError(preview.errors);
      if (stable(preview.context) !== stable({ ...run.resolvedContext, worktree: undefined }) || stable(preview.execution) !== stable(run.resolvedExecution)) throw new Error('目录、路径、Skill、Git 或模型已变化，请重新预览新任务');
      if (this.stopped) throw new Error('应用正在退出，不能重试');
      await this.runtime.beginWorkflow?.(run);
      if (this.stopped || !canRetryRecipeStage(this.run(id), stageId)) throw new Error('执行状态已变化，不能重试');
      this.commit(next => {
        const record = next.runs.find(r => r.id === id)!; record.retryRequests ??= []; record.retryRequests.push({ requestId, stageId });
        Object.assign(record, { status: 'running', finishedAt: null, error: null }); delete record.outcome;
      });
      const effect = Promise.resolve().then(() => this.executeStages(id, run.stages!.findIndex(s => s.stageId === stageId)))
        .catch(error => { this.patch(id, { stages: this.interruptStages(this.run(id).stages), status: 'failed', error: String(error), finishedAt: Date.now() }); })
        .catch(error => {
          this.error = `阶段重试结果无法保存：${String(error)}`; const record = this.store.runs.find(r => r.id === id)!;
          Object.assign(record, { stages: this.interruptStages(record.stages), status: 'interrupted', finishedAt: Date.now(), error: this.error }); this.emit();
        })
        .finally(() => { this.runtime.finishWorkflow?.(this.run(id)); this.effects.delete(effect); this.effectsByRun.delete(id); });
      this.effects.add(effect); this.effectsByRun.set(id, effect); return this.run(id);
    } catch (e) { this.runtime.finishWorkflow?.(run); throw e; }
    finally { this.retrying.delete(id); }
  }
  rateRun(id: string, rating: 'accepted' | 'needs_work', note: string): void {
    this.assertWritable(); const run = this.run(id);
    if (activeStatuses.includes(run.status) || !['accepted', 'needs_work'].includes(rating) || typeof note !== 'string' || note.length > 2000) throw new Error('只能评价已结束任务，评价说明最多 2,000 字符');
    this.commit(next => { next.runs.find(r => r.id === id)!.outcome = { rating, note, updatedAt: Date.now() }; });
  }

  waiting(conversationId: string, id: string, active: boolean): void {
    if (!active) conversationId = this.waits.get(id) ?? conversationId;
    if (active) this.waits.set(id, conversationId); else this.waits.delete(id);
    const run = this.store.runs.find(r => r.conversationId === conversationId && ['running', 'waiting_for_user'].includes(r.status));
    if (run) try { this.patch(run.id, { status: [...this.waits.values()].includes(conversationId) ? 'waiting_for_user' : 'running' }); }
    catch (error) { this.error = `使用记录写入失败：${String(error)}`; this.emit(); }
  }
  stop(): void {
    this.stopped = true;
    for (const resolveApproval of this.approvals.values()) resolveApproval(false); this.approvals.clear();
    if (this.loaded && this.store.runs.some(r => activeStatuses.includes(r.status))) this.commit(next => {
      for (const run of next.runs) if (activeStatuses.includes(run.status)) Object.assign(run, { stages: this.interruptStages(run.stages), status: 'interrupted', finishedAt: Date.now(), error: '应用退出导致初始回合中断；不自动重发' });
    });
  }
  async drain(): Promise<void> { await Promise.allSettled(this.effects); }
  async waitForRun(id: string): Promise<RecipeRun> { await this.effectsByRun.get(id); return this.run(id); }
  validateSnapshot(raw: unknown): TaskRecipe { return this.parseSnapshot(raw); }
  async cleanupWorktree(id: string): Promise<void> {
    this.assertWritable(); const run = this.run(id);
    if (!run?.worktree || activeStatuses.includes(run.status)) throw new Error('只能清理没有运行任务的配方 worktree');
    if (run.worktreeRemovedAt) return;
    if (!this.runtime.removeWorktree || this.runtime.worktreePath?.(run.worktree.branch) !== run.worktree.path) throw new Error('不是当前应用受管的配方 worktree，不能清理');
    const canonical = async (path: string) => { try { return await realpath(path); } catch { return resolve(path); } };
    const path = await canonical(run.worktree.path);
    const running = await Promise.all(this.runtime.runningWorkspaces().map(canonical));
    if (this.cleaningWorkspaces.has(path) || running.includes(path) || this.store.runs.some(r => activeStatuses.includes(r.status) && r.workspace === path)) throw new Error('worktree 中有运行任务或正在清理');
    this.cleaningWorkspaces.add(path);
    try {
      await this.runtime.removeWorktree(run);
      this.commit(next => { next.runs.find(r => r.id === id)!.worktreeRemovedAt = Date.now(); });
    } finally { this.cleaningWorkspaces.delete(path); }
  }
  private run(id: string): RecipeRun { const run = this.store.runs.find(r => r.id === id); if (!run) throw new Error('使用记录不存在'); return structuredClone(run); }
  private patch(id: string, patch: Partial<RecipeRun>): void {
    this.commit(next => { const run = next.runs.find(r => r.id === id)!; if (activeStatuses.includes(run.status)) Object.assign(run, patch); });
  }
  private assertWritable(): void { if (!this.loaded || this.error) throw new Error(this.error ?? '配方库未加载'); }
  private emit(): void { for (const listener of this.listeners) { try { listener(); } catch (error) { log.error("recipe listener failed", error); } } }
  private commit(change: (next: Store) => void): void {
    const next = structuredClone(this.store); change(next);
    mkdirSync(dirname(this.file), { recursive: true }); const temporary = `${this.file}.${randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporary, 'wx', 0o600); writeFileSync(descriptor, JSON.stringify(next)); fsyncSync(descriptor); closeSync(descriptor); descriptor = undefined;
      renameSync(temporary, this.file);
    } finally { if (descriptor !== undefined) closeSync(descriptor); rmSync(temporary, { force: true }); }
    this.store = next; this.emit();
  }
  private async resolveSkills(recipe: TaskRecipe, workspace: string): Promise<NonNullable<RecipeContext['skills']>> {
    if (!recipe.requiredSkills?.length) return [];
    if (!this.runtime.skills) throw new RecipeValidationError({ requiredSkills: 'Skill 目录不可用' });
    const catalog = await this.runtime.skills(workspace); const errors: string[] = []; const resolved: NonNullable<RecipeContext['skills']> = [];
    for (const name of recipe.requiredSkills) {
      const skill = catalog.skills.find(s => s.name === name);
      if (!skill || !skill.enabled) { errors.push(`${name}（${skill ? '已停用' : '缺失'}）`); continue; }
      try {
        const location = await realpath(skill.location); const info = await stat(location);
        if (!info.isFile() || info.size > 1_000_000) throw new Error();
        resolved.push({ name, location, fingerprint: createHash('sha256').update(await readFile(location)).digest('hex') });
      } catch { errors.push(`${name}（文件不可读取）`); }
    }
    if (errors.length) throw new RecipeValidationError({ requiredSkills: `所需 Skill 不可用：${errors.join('、')}` });
    return resolved;
  }
  private async worktreeContext(draft: RecipeUseDraft): Promise<RecipeContext> {
    if (!this.runtime.worktreePath || !this.runtime.createWorktree) throw new RecipeValidationError({ autoWorktree: '独立 worktree 不可用' });
    const options = draft.autoWorktree!;
    if (draft.recipeSnapshot.builtinKind === 'review' && draft.values.scope === 'uncommitted') throw new RecipeValidationError({ autoWorktree: '未提交改动审查需在原工作区进行，独立 worktree 不带入这些文件' });
    const context = await this.context({ ...draft, recipeSnapshot: { ...draft.recipeSnapshot, parameters: [] } });
    const git = async (...args: string[]) => (await exec('git', ['-C', draft.workspace, ...args], { timeout: 10000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
    let startSha: string; let head: string;
    try { startSha = await git('rev-parse', '--verify', '--end-of-options', `${options.startRef}^{commit}`); head = await git('rev-parse', '--verify', 'HEAD'); }
    catch { throw new RecipeValidationError({ autoWorktree: '起始引用必须为有效的 Git 提交' }); }
    const path = this.runtime.worktreePath(options.branch);
    context.worktree = { sourceWorkspace: context.path, path, startSha, branch: options.branch, includeUncommitted: false };
    context.path = path; context.name = basename(path);
    context.git ??= { head, status: '', scope: `独立 worktree 起始提交：${startSha}；不带入未提交文件` };
    context.paths['worktree-start'] = { path: draft.workspace, fingerprint: `${head}:${startSha}` };
    for (const parameter of draft.recipeSnapshot.parameters.filter(p => p.type === 'path')) {
      const value = draft.values[parameter.id]; if (value === undefined || value === '' || typeof value === 'string' && !value.trim()) continue;
      try {
        if (typeof value !== 'string' || isAbsolute(value) || value.includes('\0')) throw new Error();
        const normalized = relative(draft.workspace, resolve(draft.workspace, value));
        if (normalized === '..' || normalized.startsWith(`..${sep}`) || isAbsolute(normalized)) throw new Error();
        const components = normalized.split(sep).filter(Boolean);
        for (let i = 1; i <= components.length; i++) {
          const entry = await git('ls-tree', startSha, '--', components.slice(0, i).join('/'));
          if (entry.startsWith('120000')) throw new Error();
        }
        const object = normalized ? `${startSha}:${components.join('/')}` : `${startSha}^{tree}`;
        const kind = await git('cat-file', '-t', object);
        if (!['blob', 'tree'].includes(kind) || parameter.pathKind === 'file' && kind !== 'blob' || parameter.pathKind === 'directory' && kind !== 'tree') throw new Error();
        context.paths[parameter.id] = { path: resolve(path, normalized), fingerprint: await git('rev-parse', '--verify', '--end-of-options', object) };
      } catch { throw new RecipeValidationError({ [`values.${parameter.id}`]: '此路径在起始提交中不存在、类型不符或包含符号链接' }); }
    }
    return context;
  }
  private async assertCreatedWorktree(path: string, sha: string): Promise<void> {
    const query = async (...args: string[]) => (await exec('git', ['-C', path, ...args], { timeout: 10000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
    if (await query('rev-parse', '--verify', 'HEAD') !== sha || await query('status', '--porcelain', '--untracked-files=all')) throw new Error('独立 worktree 的起始提交或未提交文件与预览不同，任务未提交');
  }
  private async context(draft: RecipeUseDraft): Promise<RecipeContext> {
    if (!(await Promise.all(this.runtime.workspaces().map(async w => { try { return await realpath(w); } catch { return resolve(w); } }))).includes(await realpath(draft.workspace).catch(() => resolve(draft.workspace))) && !this.store.runs.some(r => r.worktree && (r.worktree.path === draft.workspace || r.workspace === draft.workspace) && !r.worktreeRemovedAt)) throw new RecipeValidationError({ workspace: '请选择已有本地工作区或 worktree' });
    let root: string;
    try { root = await realpath(draft.workspace); if (!(await stat(root)).isDirectory()) throw new Error(); }
    catch { throw new RecipeValidationError({ workspace: '工作区目录不存在或不可访问' }); }
    const rootStat = await stat(root);
    if (this.cleaningWorkspaces.has(root)) throw new RecipeValidationError({ workspace: 'worktree 正在清理，不能启动任务' });
    const context: RecipeContext = { name: basename(root), path: root, paths: { 'workspace-root': { path: root, fingerprint: `${rootStat.dev}:${rootStat.ino}` } } }; const errors: Record<string, string> = {};
    for (const p of draft.recipeSnapshot.parameters.filter(p => p.type === 'path')) {
      const value = draft.values[p.id]; if (value === undefined || value === '' || (typeof value === 'string' && !value.trim())) continue;
      try {
        if (typeof value !== 'string' || isAbsolute(value)) throw new Error('请输入工作区内相对路径');
        const target = await realpath(resolve(root, value)); const rel = relative(root, target);
        if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('路径或符号链接越出工作区');
        const info = await stat(target);
        if ((!info.isFile() && !info.isDirectory()) || (p.pathKind === 'file' && !info.isFile()) || (p.pathKind === 'directory' && !info.isDirectory())) throw new Error('路径类型不符合要求');
        context.paths[p.id] = { path: target, fingerprint: `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}` };
      } catch (error) { errors[`values.${p.id}`] = (error as NodeJS.ErrnoException).code ? '路径不存在或不可访问' : String((error as Error).message); }
    }
    if (Object.keys(errors).length) throw new RecipeValidationError(errors);
    if (draft.recipeSnapshot.builtinKind === 'review' || draft.recipeSnapshot.builtinKind === 'release') {
      const query = async (args: string[]) => (await exec('git', ['--no-optional-locks', '-C', root, ...args], { timeout: 10000, maxBuffer: 8 * 1024 * 1024 })).stdout;
      let head: string;
      try { head = (await query(['rev-parse', '--verify', 'HEAD^{commit}'])).trim(); } catch { throw new RecipeValidationError({ workspace: '此内置配方需要包含有效提交的 Git 仓库' }); }
      const refs = draft.recipeSnapshot.builtinKind === 'release' || draft.values.scope === 'refs';
      const status = (await query(['status', '--porcelain=v1', '--untracked-files=all'])).trimEnd();
      context.git = { head, status, scope: refs ? '明确起止提交比较 / Explicit start → end comparison' : '索引 + 工作区差异 + 未跟踪文件 / Index + working tree + untracked files' };
      if (refs) for (const [key, target] of [['start_ref', 'startSha'], ['end_ref', 'endSha']] as const) {
        const value = draft.values[key]; if (typeof value !== 'string' || !value.trim()) { errors[`values.${key}`] = '双引用比较必须填写起止引用'; continue; }
        try { context.git[target] = (await query(['rev-parse', '--verify', '--end-of-options', `${value}^{commit}`])).trim(); }
        catch { errors[`values.${key}`] = 'Git 引用不存在或不能解析为提交'; }
      }
      if (!refs) {
        // File names alone do not detect content changes while the form is open.
        const [indexDiff, workingDiff] = await Promise.all([query(['diff', '--cached', '--no-ext-diff', '--no-textconv', '--binary', '--']), query(['diff', '--no-ext-diff', '--no-textconv', '--binary', '--'])]);
        const untracked = await query(['ls-files', '--others', '--exclude-standard', '-z']);
        const untrackedStats = await Promise.all(untracked.split('\0').filter(Boolean).map(async path => {
          const info = await lstat(resolve(root, path)); return [path, info.dev, info.ino, info.size, info.mtimeMs];
        }));
        context.paths['git-state'] = { path: root, fingerprint: digest({ indexDiff, workingDiff, untrackedStats, status }) };
      }
      if (Object.keys(errors).length) throw new RecipeValidationError(errors);
    }
    return context;
  }
}
