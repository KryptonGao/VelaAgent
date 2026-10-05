import { useContext, useEffect, useState } from 'react';
import { canRetryRecipeStage, type RecipeRun } from '@vela/shared';
import { RecipeActionsContext } from './recipe-actions-context';
import { tr } from '../locale';
import { RecipeRunProgress, RecipeRunOutcome } from './RecipeWorkflow';

export function useRecipeRun(): RecipeRun | null {
  const actions = useContext(RecipeActionsContext); const [run, setRun] = useState<RecipeRun | null>(null);
  useEffect(() => {
    let active = true;
    const update = async () => {
      try { const state = await window.vela?.taskRecipes?.list(); if (active) setRun(state?.runs.find(r => r.conversationId === actions?.conversationId) ?? null); } catch { /* Chat remains usable if recipe history is unavailable. */ }
    };
    setRun(null); void update(); const unsubscribe = window.vela?.taskRecipes?.subscribe(() => { void update(); });
    return () => { active = false; unsubscribe?.(); };
  }, [actions?.conversationId]);
  return run;
}
export function RecipeChatCard() {
  const run = useRecipeRun();
  if (!run) return null;
  return <aside className="recipe-chat-card" data-run-id={run.id}><strong>{run.recipeSnapshot.name} · r{run.recipeSnapshot.revision}</strong>
    <p>{run.mode} · {run.resolvedExecution.model.provider}/{run.resolvedExecution.model.id} · {run.resolvedExecution.thinkingLevel} · {run.resolvedExecution.sandboxMode}</p>
    <p>{run.recipeSnapshot.parameters.map(p => `${p.label}: ${p.type === 'select' ? p.options?.find(o => o.value === run.values[p.id])?.label ?? tr('未提供', 'Not provided') : typeof run.values[p.id] === 'boolean' ? run.values[p.id] ? tr('是', 'Yes') : tr('否', 'No') : run.values[p.id] || tr('未提供', 'Not provided')}`).join(' · ')}</p>
    <RecipeRunProgress run={run} /><RecipeRunOutcome key={`${run.id}:${run.finishedAt}`} run={run} />
    <details><summary>{tr('本次任务快照', 'Task snapshot')}</summary><pre>{run.expandedPrompt}</pre></details></aside>;
}

export function RecipeStageDock({ run }: { run: RecipeRun | null }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const stage = run?.stages?.find(s => ['waiting_for_approval', 'running', 'failed'].includes(s.status));
  if (!run || !stage || !['running', 'waiting_for_user', 'failed'].includes(run.status)) return null;
  const definition = run.recipeSnapshot.stages!.find(s => s.id === stage.stageId)!;
  const action = async (fn: () => Promise<unknown>) => { setBusy(true); setError(''); try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  return <aside className="recipe-stage-dock" aria-label={tr('当前配方阶段', 'Current recipe stage')}><div role="status"><strong>{definition.name}</strong> · {stage.status === 'waiting_for_approval' ? tr('等待阶段审批', 'Waiting for stage approval') : stage.status === 'failed' ? tr('阶段失败，请检查记录', 'Stage failed; inspect the record') : tr('阶段执行中，自由输入已暂停', 'Stage running; free input paused')}</div>
    <div className="scheduled-task-actions">{stage.status === 'waiting_for_approval' && <><button type="button" disabled={busy} onClick={() => void action(() => window.vela!.taskRecipes!.approveStage(run.id, stage.stageId, true))}>{tr('批准阶段', 'Approve stage')}</button><button type="button" disabled={busy} onClick={() => void action(() => window.vela!.taskRecipes!.approveStage(run.id, stage.stageId, false))}>{tr('拒绝并停止', 'Reject and stop')}</button></>}
      {canRetryRecipeStage(run, stage.stageId) && run.trigger !== 'scheduled' && <button type="button" disabled={busy} onClick={() => void action(() => window.vela!.taskRecipes!.retryStage(run.id, stage.stageId, crypto.randomUUID()))}>{tr('重试此只读阶段', 'Retry this read-only stage')}</button>}
      {run.status !== 'failed' && <button type="button" disabled={busy} onClick={() => void action(() => window.vela!.abort(run.conversationId))}>{tr('停止配方任务', 'Stop recipe run')}</button>}</div>{error && <p role="alert" className="recipe-errors">{error}</p>}</aside>;
}
