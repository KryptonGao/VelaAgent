import { useId, useState, type ReactNode } from "react";
import {
  contextCategories,
  type AppState,
  type ContextCategory,
  type ContextUsage,
  type ConversationGoal,
  type GoalValidationCategory,
  type GoalStatus,
} from "@vela/shared";
import type { ProjectApi } from "../hooks/useProject";
import type { SidebarResize } from "../hooks/useSidebarResize";
import type { PlanDraft } from "../plan-draft";
import { ChevronDownIcon } from "./icons";
import { PlanReferenceCard } from "./PlanPanel";
import { RepoCard } from "./RepoCard";
import { SidebarResizeHandle } from "./SidebarResizeHandle";
import { isEnglish, tr } from "../locale";

const categoryLabels: Record<ContextCategory, [string, string]> = {
  system: ["系统提示词", "System prompt"],
  tools: ["工具定义", "Tool definitions"],
  rules: ["规则", "Rules"],
  skills: ["Skills", "Skills"],
  conversation: ["对话", "Conversation"],
};

function categoryLabel(category: ContextCategory): string {
  const [chinese, english] = categoryLabels[category];
  return tr(chinese, english);
}

interface ContextPanelProps {
  collapsed: boolean;
  leftOpen: boolean;
  resize: SidebarResize;
  state: AppState | null;
  planDraft: PlanDraft | null;
  project: ProjectApi;
  onToggle: () => void;
  onOpenPlan: (planId: string) => void;
  onResumeGoal: () => void;
  changesActive?: boolean;
  onOpenChanges: () => void;
}

export function ContextPanel({
  collapsed,
  leftOpen,
  resize,
  state,
  planDraft,
  project,
  onToggle,
  onOpenPlan,
  onResumeGoal,
  changesActive = false,
  onOpenChanges,
}: ContextPanelProps) {
  const [contextOpen, setContextOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const session = state?.session;
  const context = state?.context;

  return (
    <aside
      className={`sidebar-right${collapsed ? " collapsed" : ""}`}
      inert={collapsed ? true : undefined}
    >
      <SidebarResizeHandle target="right" resize={resize} leftOpen={leftOpen} />
      <div className="sidebar-right-header">
        <div className="sidebar-right-header-spacer" />
        <button
          className="sidebar-collapse-btn"
          type="button"
          title={tr("收起右侧面板", "Collapse right panel")}
          aria-label={tr("收起右侧面板", "Collapse right panel")}
          onClick={onToggle}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
      </div>

      <div className="sidebar-right-scroll">
        {session?.proposedPlan || planDraft ? (
          <PlanReferenceCard
            plan={session?.proposedPlan ?? null}
            draft={planDraft}
            execution={session?.executionPlan ?? null}
            onOpen={onOpenPlan}
          />
        ) : null}
        {session?.goal ? (
          <GoalCard goal={session.goal} busy={session.status !== "ready"} onResume={onResumeGoal} />
        ) : null}

        <RepoCard
          project={project}
          onOpenChanges={onOpenChanges}
          activeChanges={changesActive}
        />

        <PanelDisclosure
          title={tr("上下文", "Context")}
          meta={tr(`${context?.messageCount ?? 0} 条消息`, `${context?.messageCount ?? 0} messages`)}
          open={contextOpen}
          onToggle={() => setContextOpen((value) => !value)}
        >
          <div className="context-metrics-card">
            <div className="context-metrics-header">
              <span className="context-metrics-label">{tr("工具调用", "Tool calls")}</span>
              <span className="context-metrics-value">{context?.toolCallCount ?? 0}</span>
            </div>
            <div className="context-path" title={session?.cwd}>
              {session?.cwd ?? "—"}
            </div>
          </div>
        </PanelDisclosure>

        <PanelDisclosure
          title={tr("已启用工具", "Enabled tools")}
          meta={String(session?.tools?.length ?? 0)}
          open={toolsOpen}
          onToggle={() => setToolsOpen((value) => !value)}
        >
          {session?.tools && session.tools.length > 0 ? (
            <ul className="tool-chip-list">
              {session.tools.map((tool) => (
                <li className="tool-chip" key={tool}>
                  {tool}
                </li>
              ))}
            </ul>
          ) : (
            <p className="tool-chip-empty">{tr("会话开始后显示", "Shown after the chat starts")}</p>
          )}
        </PanelDisclosure>
      </div>
      <ContextUsageCard context={context} />
    </aside>
  );
}

export function PanelDisclosure({
  title,
  meta,
  open,
  onToggle,
  children,
}: {
  title: string;
  meta: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const contentId = useId();
  return (
    <section className={`panel-disclosure${open ? " open" : ""}`}>
      <button
        className="panel-disclosure-toggle"
        type="button"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={onToggle}
      >
        <span className="panel-disclosure-title">{title}</span>
        <span className="panel-disclosure-meta">{meta}</span>
        <span className="panel-disclosure-chevron" aria-hidden="true"><ChevronDownIcon /></span>
      </button>
      <div id={contentId} className="panel-disclosure-content" inert={!open} aria-hidden={!open}>
        <div className="panel-disclosure-inner">{children}</div>
      </div>
    </section>
  );
}

const goalStatusLabels: Record<GoalStatus, [string, string]> = {
  active: ["进行中", "In progress"],
  paused: ["已暂停", "Paused"],
  complete: ["已完成", "Complete"],
};

const validationCategoryLabels: Record<GoalValidationCategory, [string, string]> = {
  diff: ["Diff 检查", "Diff check"],
  test: ["定向测试", "Targeted tests"],
  build: ["构建", "Build"],
  typecheck: ["类型检查", "Typecheck"],
  regression: ["回归检查", "Regression check"],
  other: ["其他检查", "Other check"],
};

const validationStatusLabels = {
  passed: ["已通过", "Passed"],
  known_issues: ["带已知问题", "Known issues"],
  skipped: ["已说明跳过", "Skipped with reason"],
} as const;

const validationRiskLabels = {
  low: ["低风险", "Low risk"],
  medium: ["中风险", "Medium risk"],
  high: ["高风险", "High risk"],
} as const;

function translatedPair(pair: readonly [string, string]): string {
  return tr(pair[0], pair[1]);
}

function GoalCard({
  goal,
  busy,
  onResume,
}: {
  goal: ConversationGoal;
  busy: boolean;
  onResume: () => void;
}) {
  return (
    <section className="mode-card">
      <div className="side-panel-title-row">
        <span className="side-panel-heading">{tr("目标", "Goal")}</span>
        <span className={`mode-status mode-${goal.status}`}>{translatedPair(goalStatusLabels[goal.status])}</span>
      </div>
      <p className="mode-card-copy">{goal.objective}</p>
      {goal.note ? <p className="mode-card-note">{goal.note}</p> : null}
      <div className="goal-validation">
        <div className="goal-validation-heading">
          <span>{tr("交付验证", "Delivery checks")}</span>
          <span className={`goal-validation-status${goal.validation ? ` is-${goal.validation.status}` : " is-pending"}`}>
            {goal.validation
              ? `${translatedPair(validationRiskLabels[goal.validation.risk])} · ${translatedPair(validationStatusLabels[goal.validation.status])}`
              : tr("待验证", "Pending")}
          </span>
        </div>
        {!goal.validation ? <p className="goal-validation-note">{tr("完成目标前需要记录检查结果和跳过原因。", "Record check results and reasons for any skipped checks before completing the goal.")}</p> : null}
        {goal.validation && goal.validation.workRevision !== goal.workRevision ? (
          <p className="goal-validation-note is-stale">{tr("验证后工作区又有变化，请重新检查。", "The workspace changed after validation. Run the checks again.")}</p>
        ) : null}
        {goal.validation?.checks.map((check) => {
          const issue = goal.validation?.knownIssues.find((item) => item.toolCallId === check.toolCallId);
          const oldCheck = check.workRevision !== goal.workRevision;
          return (
            <div className={`goal-validation-item is-${check.result}${oldCheck ? " is-stale" : ""}`} key={check.toolCallId}>
              <div className="goal-validation-row">
                <span>{translatedPair(validationCategoryLabels[check.category])}</span>
                <span>{oldCheck ? tr("旧结果", "Outdated") : check.result === "passed" ? tr("通过", "Passed") : issue ? tr("已知失败", "Known failure") : tr("失败", "Failed")}</span>
              </div>
              <code>{check.command}</code>
              {check.output ? <p>{check.output}</p> : null}
              {issue ? <p className="goal-validation-note">{tr("依据：", "Reason: ")}{issue.reason}</p> : null}
            </div>
          );
        })}
        {goal.validation?.skipped.map((item, index) => (
          <div className="goal-validation-item is-skipped" key={`${item.category}-${index}`}>
            <div className="goal-validation-row">
              <span>{translatedPair(validationCategoryLabels[item.category])}</span>
              <span>{tr("未运行", "Not run")}</span>
            </div>
            <p>{item.reason}</p>
          </div>
        ))}
      </div>
      {goal.status === "paused" ? (
        <button className="mode-card-action" type="button" disabled={busy} onClick={onResume}>
          {tr("继续", "Resume")}
        </button>
      ) : null}
    </section>
  );
}

export function ContextUsageCard({ context, details = false }: { context: ContextUsage | undefined | null; details?: boolean }) {
  const [open, setOpen] = useState(false);
  const tokens = context?.tokens ?? 0;
  const contextWindow = context?.contextWindow ?? null;
  const segments = context?.segments;
  const used = contextCategories.reduce((sum, id) => sum + (segments?.[id] ?? 0), 0);
  const basis = contextWindow && contextWindow > 0 ? Math.max(contextWindow, used) : used;

  return (
    <section className={`context-usage${open || details ? "" : " collapsed"}`} aria-label={tr("上下文用量", "Context usage")}>
      {details ? <div className="context-usage-title">{tr("上下文用量", "Context usage")}</div> : <button
        className="context-usage-title"
        type="button"
        aria-expanded={open}
        title={open ? tr("收起明细", "Collapse details") : tr("展开明细", "Expand details")}
        onClick={() => setOpen((value) => !value)}
      >
        <span>{tr("上下文用量", "Context usage")}</span>
        <span className="context-usage-chevron" aria-hidden="true">
          <ChevronDownIcon />
        </span>
      </button>}
      <div className="context-usage-summary">
        <span className={`context-usage-percent${(context?.percent ?? 0) >= 80 ? " high" : ""}`}>
          {formatPercent(context?.percent ?? null, tokens)}
        </span>
        <span className="context-usage-total">{formatTotal(tokens, contextWindow)}</span>
      </div>
      <div className="context-usage-track" aria-hidden="true">
        {contextCategories.map((id) => {
          const value = segments?.[id] ?? 0;
          if (value <= 0 || basis <= 0) return null;
          return (
            <div
              className={`context-usage-seg ${id}`}
              key={id}
              style={{ width: `${(value / basis) * 100}%` }}
              title={`${categoryLabel(id)} ${formatPrecise(value)}`}
            />
          );
        })}
      </div>
      <div className={`context-usage-details${open || details ? " open" : ""}`} inert={!open && !details} aria-hidden={!open && !details}>
        <div className="context-usage-details-inner">
        <ul className="context-usage-legend">
          {contextCategories.map((id) => (
            <li className="context-usage-row" key={id}>
              <span className="context-usage-label">
                <span className={`context-usage-swatch ${id}`} />
                {categoryLabel(id)}
              </span>
              <span className="context-usage-value" title={`${(segments?.[id] ?? 0).toLocaleString(isEnglish() ? "en-US" : "zh-CN")} tokens`}>
                {formatPrecise(segments?.[id] ?? 0)}
              </span>
            </li>
          ))}
        </ul>
        </div>
      </div>
    </section>
  );
}

function formatPercent(percent: number | null, tokens: number): string {
  if (percent == null) return tokens > 0 ? "—" : tr("已用 0%", "0% used");
  const rounded = Math.round(percent);
  if (rounded <= 0 && tokens > 0) return tr("已用 <1%", "<1% used");
  return tr(`已用 ${rounded}%`, `${rounded}% used`);
}

function formatTotal(tokens: number, contextWindow: number | null): string {
  if (!contextWindow) return tokens > 0 ? `~${formatPrecise(tokens)} tokens` : "— tokens";
  return `~${formatPrecise(tokens)} / ${formatWindow(contextWindow)} tokens`;
}

function formatPrecise(value: number): string {
  if (value < 1000) return String(Math.round(value));
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  return `${(value / 1000).toFixed(1)}K`;
}

function formatWindow(value: number): string {
  if (value < 1000) return String(Math.round(value));
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    return Number.isInteger(millions) ? `${millions}M` : `${millions.toFixed(1)}M`;
  }
  const thousands = value / 1000;
  const rounded = Math.round(thousands * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}K` : `${rounded.toFixed(1)}K`;
}
