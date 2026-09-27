import { useState } from "react";
import {
  contextCategories,
  type AppState,
  type ContextCategory,
  type ContextUsage,
  type ConversationGoal,
  type ConversationPlan,
  type GoalValidationCategory,
  type GoalStatus,
} from "@vela/shared";
import type { ProjectApi } from "../hooks/useProject";
import { ChangesView } from "./ChangesView";
import { ChevronDownIcon } from "./icons";
import { SheetPresence } from "./Presence";
import { FilePreviewView } from "./preview/FilePreviewView";
import { useFilePreview } from "./preview/FilePreviewContext";
import { RepoCard } from "./RepoCard";

const categoryLabels: Record<ContextCategory, string> = {
  system: "系统提示词",
  tools: "工具定义",
  rules: "规则",
  skills: "Skills",
  conversation: "对话",
};

interface ContextPanelProps {
  collapsed: boolean;
  state: AppState | null;
  project: ProjectApi;
  onToggle: () => void;
  onExecutePlan: () => void;
  onResumeGoal: () => void;
}

export function ContextPanel({
  collapsed,
  state,
  project,
  onToggle,
  onExecutePlan,
  onResumeGoal,
}: ContextPanelProps) {
  const [changesOpen, setChangesOpen] = useState(false);
  const [diffRequestPath, setDiffRequestPath] = useState<string | null>(null);
  const preview = useFilePreview();
  const session = state?.session;
  const context = state?.context;

  return (
    <aside
      className={`sidebar-right${collapsed ? " collapsed" : ""}${preview?.open ? " preview-mode" : ""}`}
      inert={collapsed ? true : undefined}
    >
      <div className="sidebar-right-header">
        <div className="sidebar-right-header-spacer" />
        <button
          className="sidebar-collapse-btn"
          type="button"
          title="收起右侧面板"
          aria-label="收起右侧面板"
          onClick={onToggle}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
      </div>

      <div key={preview?.open ? "preview" : "context"} className="side-panel-swap">
      {preview?.open ? (
        <FilePreviewView
          project={project}
          onShowDiff={(path) => {
            setDiffRequestPath(path);
            setChangesOpen(true);
          }}
        />
      ) : (
        <>
          <div className="sidebar-right-scroll">
        {session?.plan ? (
          <PlanCard plan={session.plan} busy={session.status !== "ready"} onExecute={onExecutePlan} />
        ) : null}
        {session?.goal ? (
          <GoalCard goal={session.goal} busy={session.status !== "ready"} onResume={onResumeGoal} />
        ) : null}

        <RepoCard
          project={project}
          onOpenChanges={() => setChangesOpen(true)}
          activeChanges={changesOpen}
        />

        <section>
          <div className="side-panel-title-row">
            <span className="side-panel-heading">上下文</span>
            <span className="side-panel-counter">{context?.messageCount ?? 0} 条消息</span>
          </div>
          <div className="context-metrics-card">
            <div className="context-metrics-header">
              <span className="context-metrics-label">工具调用</span>
              <span className="context-metrics-value">{context?.toolCallCount ?? 0}</span>
            </div>
            <div className="context-path" title={session?.cwd}>
              {session?.cwd ?? "—"}
            </div>
          </div>
        </section>

        <section>
          <div className="side-panel-title-row">
            <span className="side-panel-heading">已启用工具</span>
            <span className="side-panel-counter">{session?.tools?.length ?? 0}</span>
          </div>
          {session?.tools && session.tools.length > 0 ? (
            <ul className="tool-chip-list">
              {session.tools.map((tool) => (
                <li className="tool-chip" key={tool}>
                  {tool}
                </li>
              ))}
            </ul>
          ) : (
            <p className="tool-chip-empty">会话开始后显示</p>
          )}
        </section>
          </div>

          <ContextUsageCard context={context} />
        </>
      )}
      </div>

      <SheetPresence present={changesOpen}>
        <ChangesView
          project={project}
          initialPath={diffRequestPath}
          onClose={() => setChangesOpen(false)}
          onPreviewFile={(path) => preview?.openFile(path)}
        />
      </SheetPresence>
    </aside>
  );
}

const goalStatusLabel: Record<GoalStatus, string> = {
  active: "进行中",
  paused: "已暂停",
  complete: "已完成",
};

const validationCategoryLabel: Record<GoalValidationCategory, string> = {
  diff: "Diff 检查",
  test: "定向测试",
  build: "构建",
  typecheck: "类型检查",
  regression: "回归检查",
  other: "其他检查",
};

const validationStatusLabel = {
  passed: "已通过",
  known_issues: "带已知问题",
  skipped: "已说明跳过",
} as const;

const validationRiskLabel = {
  low: "低风险",
  medium: "中风险",
  high: "高风险",
} as const;

function PlanCard({
  plan,
  busy,
  onExecute,
}: {
  plan: ConversationPlan;
  busy: boolean;
  onExecute: () => void;
}) {
  const done = plan.steps.filter((step) => step.done).length;
  const total = plan.steps.length;
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);

  return (
    <section className="mode-card">
      <div className="side-panel-title-row">
        <span className="side-panel-heading">计划</span>
        <span className="side-panel-counter">
          {done}/{total}
        </span>
      </div>
      <div className="mode-card-title">{plan.title}</div>
      {plan.overview ? <p className="mode-card-copy">{plan.overview}</p> : null}
      <div className="mode-progress" aria-hidden="true">
        <span style={{ width: `${percent}%` }} />
      </div>
      <div className="mode-steps">
        {plan.steps.map((step) => (
          <div className={`mode-step${step.done ? " done" : ""}`} key={step.id}>
            <span className="mode-step-mark" aria-hidden="true">
              {step.done ? "✓" : ""}
            </span>
            <span>{step.text}</span>
          </div>
        ))}
      </div>
      <button className="mode-card-action" type="button" disabled={busy} onClick={onExecute}>
        执行计划
      </button>
    </section>
  );
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
        <span className="side-panel-heading">目标</span>
        <span className={`mode-status mode-${goal.status}`}>{goalStatusLabel[goal.status]}</span>
      </div>
      <p className="mode-card-copy">{goal.objective}</p>
      {goal.note ? <p className="mode-card-note">{goal.note}</p> : null}
      <div className="goal-validation">
        <div className="goal-validation-heading">
          <span>交付验证</span>
          <span className={`goal-validation-status${goal.validation ? ` is-${goal.validation.status}` : " is-pending"}`}>
            {goal.validation
              ? `${validationRiskLabel[goal.validation.risk]} · ${validationStatusLabel[goal.validation.status]}`
              : "待验证"}
          </span>
        </div>
        {!goal.validation ? <p className="goal-validation-note">完成目标前需要记录检查结果和跳过原因。</p> : null}
        {goal.validation && goal.validation.workRevision !== goal.workRevision ? (
          <p className="goal-validation-note is-stale">验证后工作区又有变化，请重新检查。</p>
        ) : null}
        {goal.validation?.checks.map((check) => {
          const issue = goal.validation?.knownIssues.find((item) => item.toolCallId === check.toolCallId);
          const oldCheck = check.workRevision !== goal.workRevision;
          return (
            <div className={`goal-validation-item is-${check.result}${oldCheck ? " is-stale" : ""}`} key={check.toolCallId}>
              <div className="goal-validation-row">
                <span>{validationCategoryLabel[check.category]}</span>
                <span>{oldCheck ? "旧结果" : check.result === "passed" ? "通过" : issue ? "已知失败" : "失败"}</span>
              </div>
              <code>{check.command}</code>
              {check.output ? <p>{check.output}</p> : null}
              {issue ? <p className="goal-validation-note">依据：{issue.reason}</p> : null}
            </div>
          );
        })}
        {goal.validation?.skipped.map((item, index) => (
          <div className="goal-validation-item is-skipped" key={`${item.category}-${index}`}>
            <div className="goal-validation-row">
              <span>{validationCategoryLabel[item.category]}</span>
              <span>未运行</span>
            </div>
            <p>{item.reason}</p>
          </div>
        ))}
      </div>
      {goal.status === "paused" ? (
        <button className="mode-card-action" type="button" disabled={busy} onClick={onResume}>
          继续
        </button>
      ) : null}
    </section>
  );
}

function ContextUsageCard({ context }: { context: ContextUsage | undefined }) {
  const [open, setOpen] = useState(true);
  const tokens = context?.tokens ?? 0;
  const contextWindow = context?.contextWindow ?? null;
  const segments = context?.segments;
  const used = contextCategories.reduce((sum, id) => sum + (segments?.[id] ?? 0), 0);
  const basis = contextWindow && contextWindow > 0 ? Math.max(contextWindow, used) : used;

  return (
    <section className={`context-usage${open ? "" : " collapsed"}`} aria-label="上下文用量">
      <button
        className="context-usage-title"
        type="button"
        aria-expanded={open}
        title={open ? "收起明细" : "展开明细"}
        onClick={() => setOpen((value) => !value)}
      >
        <span>上下文用量</span>
        <span className="context-usage-chevron" aria-hidden="true">
          <ChevronDownIcon />
        </span>
      </button>
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
              title={`${categoryLabels[id]} ${formatPrecise(value)}`}
            />
          );
        })}
      </div>
      {open ? (
        <ul className="context-usage-legend">
          {contextCategories.map((id) => (
            <li className="context-usage-row" key={id}>
              <span className="context-usage-label">
                <span className={`context-usage-swatch ${id}`} />
                {categoryLabels[id]}
              </span>
              <span className="context-usage-value" title={`${(segments?.[id] ?? 0).toLocaleString("zh-CN")} tokens`}>
                {formatPrecise(segments?.[id] ?? 0)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function formatPercent(percent: number | null, tokens: number): string {
  if (percent == null) return tokens > 0 ? "—" : "已用 0%";
  const rounded = Math.round(percent);
  if (rounded <= 0 && tokens > 0) return "已用 <1%";
  return `已用 ${rounded}%`;
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
