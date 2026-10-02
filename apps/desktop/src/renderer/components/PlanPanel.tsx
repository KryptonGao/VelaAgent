import type { ExecutionPlan, PlanExecutionContextStrategy, ProposedPlanItem, ProposedPlanStatus } from "@vela/shared";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useDismissable } from "../hooks/useDismissable";
import { tr } from "../locale";
import {
  planActionState,
  planExecutionChoices,
  planPreviewInfo,
  planProgress,
  planReferenceModel,
  planRevisionEntries,
  resolveOpenPlanRevision,
  resolvePlanRevision,
  type PlanDraft,
} from "../plan-draft";
import { Markdown } from "./Markdown";
import { ContentSwap } from "./BatchMotion";
import { PopoverPresence } from "./MotionPresence";
import { CheckIcon, ChevronDownIcon, CopyIcon, PlanIcon } from "./icons";

const planStatusLabels: Record<ProposedPlanStatus, [string, string]> = {
  draft: ["草稿", "Draft"],
  approved: ["已批准", "Approved"],
  superseded: ["已被取代", "Superseded"],
};

/** plan revision id -> 文档阅读位置；面板关闭再打开后仍然恢复。 */
const planScrollPositions = new Map<string, number>();

function planStatusLabel(status: ProposedPlanStatus): string {
  const [zh, en] = planStatusLabels[status];
  return tr(zh, en);
}

// ---------- Provider ----------

export interface PlanDocumentValue {
  plans: readonly ProposedPlanItem[];
  draft: PlanDraft | null;
  activePlanId: string | null;
  selectedRevisionId: string | null;
  openPlan: (planId: string) => void;
  closePlan: () => void;
  selectRevision: (planId: string) => void;
}

const PlanDocumentContext = createContext<PlanDocumentValue | null>(null);

export function usePlanDocument(): PlanDocumentValue {
  const value = useContext(PlanDocumentContext);
  if (!value) throw new Error("usePlanDocument 必须在 PlanDocumentProvider 内使用");
  return value;
}

export function PlanDocumentProvider({
  plans,
  draft,
  activePlanId,
  selectedRevisionId,
  openPlan,
  closePlan,
  selectRevision,
  children,
}: PlanDocumentValue & { children: ReactNode }) {
  const value = useMemo<PlanDocumentValue>(
    () => ({ plans, draft, activePlanId, selectedRevisionId, openPlan, closePlan, selectRevision }),
    [plans, draft, activePlanId, selectedRevisionId, openPlan, closePlan, selectRevision],
  );
  return <PlanDocumentContext.Provider value={value}>{children}</PlanDocumentContext.Provider>;
}

// ---------- Chat 里的 Plan Preview ----------

/** 一轮 assistant 回复关联的 Plan Preview；不渲染完整 Markdown。 */
export function PlanPreviewList({ planIds }: { planIds: readonly string[] }) {
  if (planIds.length === 0) return null;
  return (
    <div className="plan-preview-list">
      {planIds.map((planId) => (
        <PlanPreviewCard key={planId} planId={planId} />
      ))}
    </div>
  );
}

function PlanPreviewCard({ planId }: { planId: string }) {
  const { plans, draft, openPlan } = usePlanDocument();
  const resolved = resolvePlanRevision(plans, draft, planId);
  if (!resolved) return null;
  const info = planPreviewInfo(resolved.markdown, resolved.objective);
  const meta = resolved.streaming
    ? tr("生成中", "Writing")
    : `${tr("修订", "Revision")} ${resolved.revision}`;
  return (
    <button
      type="button"
      className={`plan-preview-card${resolved.streaming ? " is-streaming" : ""}`}
      onClick={() => openPlan(resolved.id)}
      aria-label={`${tr("打开计划", "Open plan")}: ${info.title || tr("未命名计划", "Untitled plan")}`}
    >
      <span className="plan-preview-head">
        <span className="plan-preview-kind">
          <PlanIcon size={12} />
          {resolved.streaming ? tr("正在撰写计划", "Writing a plan") : tr("已提交计划", "Plan submitted")}
        </span>
        <span className="plan-preview-meta">
          {meta}
          <span className="plan-preview-open" aria-hidden="true">↗</span>
        </span>
      </span>
      <span className="plan-preview-title">{info.title || tr("未命名计划", "Untitled plan")}</span>
      {resolved.streaming ? (
        <span className="plan-preview-overview is-streaming">{tr("正在生成完整方案…", "Writing the full plan…")}</span>
      ) : info.overview ? (
        <>
          <span className="plan-preview-overview-heading">{tr("概述", "Overview")}</span>
          <span className="plan-preview-overview">{info.overview}</span>
        </>
      ) : null}
      {!resolved.streaming && info.sections.length > 0 ? (
        <span className="plan-preview-sections" aria-hidden="true">
          {info.sections.slice(0, 5).map((section) => (
            <span className="plan-preview-chip" key={section}>{section}</span>
          ))}
        </span>
      ) : null}
    </button>
  );
}

// ---------- ContextPanel 里的 Plan 引用 ----------

/** 侧栏引用：标题、revision、状态和执行进度；正文放在 Plan Document 里。 */
export function PlanReferenceCard({
  plan,
  draft,
  execution,
  onOpen,
}: {
  plan: ProposedPlanItem | null;
  draft: PlanDraft | null;
  execution: ExecutionPlan | null;
  onOpen: (planId: string) => void;
}) {
  const model = planReferenceModel(plan, draft, execution);
  if (!model) return null;
  return (
    <section className="mode-card plan-reference">
      <div className="side-panel-title-row">
        <span className="side-panel-heading">{tr("计划", "Plan")}</span>
        <span className={`mode-status mode-${model.status}`}>
          {model.streaming ? tr("生成中", "Writing") : planStatusLabel(model.status)}
        </span>
      </div>
      <button type="button" className="plan-reference-main" onClick={() => onOpen(model.id)}>
        <span className="plan-reference-icon" aria-hidden="true">
          <PlanIcon size={14} />
        </span>
        <span className="plan-reference-text">
          <span className="plan-reference-title">{model.title || tr("未命名计划", "Untitled plan")}</span>
          <span className="plan-reference-meta">
            {`${tr("修订", "Revision")} ${model.revision}`}
          </span>
        </span>
      </button>
      {model.progress.total > 0 ? (
        <>
          <div className="mode-progress" aria-hidden="true">
            <span style={{ width: `${model.progress.percent}%` }} />
          </div>
          <div className="plan-reference-progress">
            <span>{tr("执行进度", "Execution")}</span>
            <span className="side-panel-counter">
              {model.progress.completed} / {model.progress.total}
            </span>
          </div>
        </>
      ) : null}
      <button type="button" className="plan-reference-open" onClick={() => onOpen(model.id)}>
        {tr("查看计划", "Open plan")} <span aria-hidden="true">→</span>
      </button>
    </section>
  );
}

// ---------- Plan Document Pane ----------

/**
 * 独立的 Plan 文档面板：宽版长文阅读、Revision selector、底部操作栏。
 * 正文来自 ProposedPlanItem / 流式草稿，执行进度单独展示，不进入 Markdown。
 */
export function PlanDocumentPane({
  busy,
  execution,
  onRevise,
  onExecutePlan,
  visible = true,
}: {
  busy: boolean;
  execution: ExecutionPlan | null;
  onRevise: () => void;
  onExecutePlan: (strategy: PlanExecutionContextStrategy) => void;
  /** 宿主切换标签时隐藏但保持挂载，以保留 revision 菜单和文档局部状态。 */
  visible?: boolean;
}) {
  const doc = usePlanDocument();
  const resolved = resolveOpenPlanRevision(doc, doc.plans, doc.draft);
  const latest = resolvePlanRevision(doc.plans, doc.draft, null);
  const latestItem = doc.plans.find((plan) => plan.id === latest?.id) ?? null;
  const actions = planActionState(latestItem, doc.draft, busy);
  const revisionId = resolved?.id ?? null;

  const scrollRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const [revisionMenu, setRevisionMenu] = useState(false);
  const [executeMenu, setExecuteMenu] = useState(false);
  const revisionMenuRef = useDismissable<HTMLDivElement>(revisionMenu, () => setRevisionMenu(false));
  const executeMenuRef = useDismissable<HTMLDivElement>(executeMenu, () => setExecuteMenu(false));

  // 切换 revision 时恢复该版本的阅读位置。
  useEffect(() => {
    const node = scrollRef.current;
    if (!node || !revisionId) return;
    node.scrollTop = planScrollPositions.get(revisionId) ?? 0;
  }, [revisionId]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  if (!resolved) return null;
  const info = planPreviewInfo(resolved.markdown, resolved.objective);
  const entries = planRevisionEntries(doc.plans, doc.draft);
  const progress = planProgress(execution);

  const copyMarkdown = (): void => {
    const clipboard = navigator.clipboard;
    if (!clipboard) return;
    clipboard
      .writeText(resolved.markdown)
      .then(() => setCopied(true))
      .catch(() => undefined);
  };

  return (
    <section
      className="plan-pane"
      aria-label={tr("计划文档", "Plan document")}
      aria-hidden={!visible}
      inert={!visible ? true : undefined}
      style={{ display: visible ? undefined : "none" }}
    >
      <header className="plan-pane-header">
        <div className="plan-pane-title">
          <span className="plan-pane-kind" aria-hidden="true">
            <PlanIcon size={13} />
          </span>
          <h2 className="plan-pane-title-text" title={info.title}>
            {info.title || tr("未命名计划", "Untitled plan")}
          </h2>
          <span className={`plan-state is-${resolved.streaming ? "streaming" : resolved.status}`}>
            {resolved.streaming ? tr("生成中", "Generating") : planStatusLabel(resolved.status)}
          </span>
        </div>
        <div className="plan-pane-actions">
          <button
            className="icon-btn-ghost"
            type="button"
            title={copied ? tr("已复制", "Copied") : tr("复制 Markdown", "Copy Markdown")}
            aria-label={tr("复制 Markdown", "Copy Markdown")}
            onClick={copyMarkdown}
          >
            {copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
          </button>
          <div className="plan-revision-anchor" ref={revisionMenuRef}>
            <button
              type="button"
              className="plan-revision-trigger"
              aria-haspopup="menu"
              aria-expanded={revisionMenu}
              onClick={() => setRevisionMenu((value) => !value)}
            >
              {`v${resolved.revision}`}
              <ChevronDownIcon size={11} />
            </button>
            <PopoverPresence present={revisionMenu}>
              <div className="dock-popover plan-revision-menu" role="menu">
                <div className="plan-revision-menu-title">{tr("修订历史", "Revision history")}</div>
                {entries.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={entry.id === resolved.id}
                    className={`plan-revision-option${entry.id === resolved.id ? " active" : ""}`}
                    onClick={() => {
                      doc.selectRevision(entry.id);
                      setRevisionMenu(false);
                    }}
                  >
                    <span className="plan-revision-option-label">{`v${entry.revision}`}</span>
                    <span className="plan-revision-option-meta">
                      {entry.streaming ? tr("生成中", "Writing") : planStatusLabel(entry.status)}
                      {entry.latest ? ` · ${tr("当前", "Current")}` : ""}
                    </span>
                  </button>
                ))}
              </div>
            </PopoverPresence>
          </div>
        </div>
      </header>

      <div
        className="plan-doc-scroll"
        ref={scrollRef}
        onScroll={() => {
          const node = scrollRef.current;
          if (node && revisionId) planScrollPositions.set(revisionId, node.scrollTop);
        }}
      >
        <ContentSwap motionKey={resolved.id} className="plan-revision-swap" exitMs={150}>
          <div className="plan-doc-body">
            <Markdown text={resolved.markdown} streaming={resolved.streaming} />
          </div>
        </ContentSwap>
      </div>

      <footer className="plan-doc-footer">
        {execution && progress.total > 0 ? (
          <div className="plan-exec-summary">
            <div className="plan-exec-summary-head">
              <span>{tr("执行进度", "Execution")}</span>
              <span>
                {progress.completed} / {progress.total}
              </span>
            </div>
            <div className="mode-progress" aria-hidden="true">
              <span style={{ width: `${progress.percent}%` }} />
            </div>
            {progress.active ? <div className="plan-exec-active">→ {progress.active.text}</div> : null}
          </div>
        ) : null}

        {resolved.readOnly ? (
          <div className="plan-readonly-note">
            <span>{tr("这是历史版本，只读查看。", "This is a historical revision. Read only.")}</span>
            {latest ? (
              <button type="button" className="plan-action-secondary" onClick={() => doc.selectRevision(latest.id)}>
                {tr("回到最新版本", "Back to latest")}
              </button>
            ) : null}
          </div>
        ) : (
          <div className="plan-action-bar">
            <button
              type="button"
              className="plan-action-secondary"
              disabled={!actions.canRevise}
              onClick={onRevise}
            >
              {tr("继续修改", "Revise")}
            </button>
            <div className="plan-action-anchor" ref={executeMenuRef}>
              <button
                type="button"
                className="plan-action-primary"
                disabled={!actions.canExecute}
                aria-haspopup="menu"
                aria-expanded={executeMenu}
                onClick={() => setExecuteMenu((value) => !value)}
              >
                {actions.generating ? tr("生成中…", "Generating…") : tr("执行计划", "Implement")}
                <ChevronDownIcon size={11} />
              </button>
              <PopoverPresence present={executeMenu}>
                <div className="dock-popover up plan-execute-menu" role="menu">
                  {planExecutionChoices.map((choice) => (
                    <button
                      key={choice.strategy}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setExecuteMenu(false);
                        onExecutePlan(choice.strategy);
                      }}
                    >
                      <span className="plan-execute-menu-label">{tr(choice.labelZh, choice.labelEn)}</span>
                      <span className="plan-execute-menu-desc">
                        {choice.strategy === "continue"
                          ? tr("沿用当前对话上下文继续实现", "Keep the planning context")
                          : tr("用原始目标开启新的执行对话", "Start a fresh execution chat")}
                      </span>
                    </button>
                  ))}
                </div>
              </PopoverPresence>
            </div>
          </div>
        )}
      </footer>
    </section>
  );
}
