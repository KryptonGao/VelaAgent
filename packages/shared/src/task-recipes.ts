import type { AppLocale } from "./i18n";
import type { SandboxMode, ThinkingLevel, ThinkingSummaryModel } from './index';

export type RecipeMode = 'agent' | 'plan';
export type RecipeValue = string | boolean;
export interface RecipeParameter {
  id: string; label: string; type: 'text' | 'multiline' | 'select' | 'boolean' | 'path';
  help?: string; required: boolean; defaultValue?: RecipeValue;
  options?: { value: string; label: string }[]; pathKind?: 'file' | 'directory' | 'any';
}
export interface TaskRecipeInput {
  name: string; description: string; tags: string[]; defaultMode: RecipeMode; parameters: RecipeParameter[];
  objectiveTemplate: string; workflowTemplate: string; deliverableTemplate: string;
  sourceReference?: { conversationId: string; messageId?: string; planId?: string };
  requiredSkills?: string[];
  stages?: RecipeStage[];
}
export interface TaskRecipe extends TaskRecipeInput {
  id: string; origin: 'builtin' | 'user' | 'project' | 'team'; revision: number; createdAt: number; updatedAt: number;
  projectWorkspace?: string;
  teamWorkspace?: string; teamPermission?: 'read' | 'write'; teamFingerprint?: string;
  builtinVersion?: number; builtinKind?: 'bug' | 'review' | 'release'; locale?: AppLocale;
}
export interface RecipeUseDraft {
  recipeSnapshot: TaskRecipe; workspace: string; values: Record<string, RecipeValue>;
  additionalInstructions: string; mode: RecipeMode;
  modelOverride?: ThinkingSummaryModel | null; thinkingLevelOverride?: ThinkingLevel | null; sandboxModeOverride?: SandboxMode | null;
  autoWorktree?: { startRef: string; branch: string; includeUncommitted: false } | null;
}
export interface RecipeExecution {
  model: ThinkingSummaryModel; thinkingLevel: ThinkingLevel; sandboxMode: SandboxMode;
}
export interface RecipeContext {
  name: string; path: string; paths: Record<string, { path: string; fingerprint: string }>;
  git?: { startSha?: string; endSha?: string; head: string; status: string; scope: string };
  skills?: { name: string; location: string; fingerprint: string }[];
  worktree?: { sourceWorkspace: string; path: string; startSha: string; branch: string; includeUncommitted: false };
}
export interface RecipePreview {
  errors: Record<string, string>; expandedPrompt: string; fingerprint: string;
  context: RecipeContext | null; execution: RecipeExecution | null; concurrent: boolean;
}
export type RecipeRunStatus = 'starting' | 'running' | 'waiting_for_user' | 'responded' | 'failed' | 'stopped' | 'interrupted';
export interface RecipeRun {
  id: string; requestId: string; inputDigest: string; recipeId: string; recipeSnapshot: TaskRecipe;
  values: Record<string, RecipeValue>; additionalInstructions: string; mode: RecipeMode;
  resolvedContext: RecipeContext; expandedPrompt: string; workspace: string; resolvedExecution: RecipeExecution;
  conversationId: string; conversationBound: boolean; sendIntentAt: number | null;
  status: RecipeRunStatus; startedAt: number; finishedAt: number | null; error: string | null; planPending?: boolean;
  worktree?: RecipeContext['worktree']; worktreeRemovedAt?: number;
  trigger?: 'manual' | 'scheduled';
  stages?: RecipeStageRun[];
  outcome?: { rating: 'accepted' | 'needs_work'; note: string; updatedAt: number };
  retryRequests?: { requestId: string; stageId: string }[];
}
export interface TaskRecipesState { recipes: TaskRecipe[]; runs: RecipeRun[]; error: string | null; projectErrors?: Record<string, string>; teams?: RecipeTeamConnection[]; teamErrors?: Record<string, string> }
export interface RecipeGenerateInput { requestId: string; text: string; locale: AppLocale; model: ThinkingSummaryModel; sourceReference?: TaskRecipeInput['sourceReference'] }
export interface RecipeGenerateResult { recipe: TaskRecipeInput; model: ThinkingSummaryModel; sourceText: string }
export interface TaskRecipesApi {
  list(locale?: AppLocale): Promise<TaskRecipesState>;
  save(input: TaskRecipeInput, id?: string, expectedRevision?: number, projectWorkspace?: string): Promise<TaskRecipe>;
  delete(id: string, expectedFingerprint?: string): Promise<void>;
  preview(draft: RecipeUseDraft): Promise<RecipePreview>;
  start(input: { requestId: string; draft: RecipeUseDraft; fingerprint: string }): Promise<RecipeRun>;
  pickPath(workspace: string, kind: 'file' | 'directory' | 'any'): Promise<string | null>;
  importFile(): Promise<TaskRecipeInput[] | null>;
  exportFile(recipe: TaskRecipe): Promise<boolean>;
  generate(input: RecipeGenerateInput): Promise<RecipeGenerateResult>;
  cancelGenerate(requestId: string): Promise<void>;
  cleanupWorktree(runId: string): Promise<void>;
  stageEvidence(runId: string, stageId: string, attempt: number, evidenceId: string): Promise<{ label: string; text: string }>;
  approveStage(runId: string, stageId: string, approved: boolean): Promise<RecipeRun>;
  retryStage(runId: string, stageId: string, requestId: string): Promise<RecipeRun>;
  rateRun(runId: string, rating: 'accepted' | 'needs_work', note: string): Promise<void>;
  connectTeam(workspace: string, permission: 'read' | 'write'): Promise<void>;
  disconnectTeam(workspace: string): Promise<void>;
  saveTeam(input: TaskRecipeInput, workspace: string, id?: string, expectedRevision?: number, expectedFingerprint?: string): Promise<TaskRecipe>;
  subscribe(listener: () => void): () => void;
}
export const TaskRecipesIpc = {
  list: 'task-recipes:list', save: 'task-recipes:save', delete: 'task-recipes:delete', preview: 'task-recipes:preview',
  start: 'task-recipes:start', pickPath: 'task-recipes:pick-path', state: 'task-recipes:state',
  importFile: 'task-recipes:import', exportFile: 'task-recipes:export', generate: 'task-recipes:generate',
  cancelGenerate: 'task-recipes:cancel-generate', cleanupWorktree: 'task-recipes:cleanup-worktree',
  stageEvidence: 'task-recipes:stage-evidence', approveStage: 'task-recipes:approve-stage', retryStage: 'task-recipes:retry-stage', rateRun: 'task-recipes:rate-run',
  connectTeam: 'task-recipes:connect-team', disconnectTeam: 'task-recipes:disconnect-team', saveTeam: 'task-recipes:save-team',
} as const;

export interface RecipeTeamConnection { workspace: string; permission: 'read' | 'write' }
export interface RecipeStage {
  id: string; name: string; instructions: string;
  condition?: { parameterId: string; operator: 'equals' | 'not_equals'; value: RecipeValue };
  approvalRequired: boolean; retryLimit: number; sideEffect: 'read_only' | 'workspace' | 'external';
}
export type RecipeStageStatus = 'pending' | 'skipped' | 'waiting_for_approval' | 'running' | 'responded' | 'failed' | 'stopped' | 'interrupted';
export interface RecipeStageEvidence { type: 'tool' | 'response'; id: string; label: string }
export interface RecipeStageAttempt {
  attempt: number; status: 'running' | 'responded' | 'failed' | 'stopped' | 'interrupted';
  startedAt: number; finishedAt: number | null; sendIntentAt: number;
  error: string | null; evidence: RecipeStageEvidence[]; retrySafe: boolean;
}
export interface RecipeStageRun { stageId: string; status: RecipeStageStatus; attempts: RecipeStageAttempt[]; approval?: { approved: boolean; at: number } }
export interface RecipeStageSubmission { id: string; name: string; prompt: string; attempt: number; sideEffect: RecipeStage['sideEffect'] }
export interface RecipeSubmitResult { status: 'responded' | 'stopped' | 'failed'; error?: string; planPending?: boolean; evidence?: RecipeStageEvidence[]; retrySafe?: boolean }
