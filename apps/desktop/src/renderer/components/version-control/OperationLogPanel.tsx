import { useEffect, useMemo, useState } from "react";
import type { AppLocale, GitOperationQuery, GitOperationRecord, GitOperationType } from "@vela/shared";
import { tr } from "../../locale";
import { useDismissable } from "../../hooks/useDismissable";
import { AlertIcon, CheckIcon, CommitIcon, ExternalIcon, PrIcon, RefreshIcon, SearchIcon } from "../icons";
import { formatRelativeTime } from "./time-format";

const operationLabels: Record<GitOperationType, [string, string]> = {
  stage: ["暂存", "Stage"],
  unstage: ["取消暂存", "Unstage"],
  discard: ["丢弃改动", "Discard"],
  commit: ["提交", "Commit"],
  push: ["推送", "Push"],
  "commit-push": ["提交并推送", "Commit and push"],
  fetch: ["Fetch", "Fetch"],
  pull: ["Pull", "Pull"],
  "pr-create": ["创建 PR", "Create PR"],
  amend: ["修正提交", "Amend"],
  "undo-commit": ["撤销提交", "Undo commit"],
  stash: ["Stash", "Stash"],
  worktree: ["Worktree", "Worktree"],
  branch: ["分支", "Branch"],
  remote: ["远程", "Remote"],
  conflict: ["冲突处理", "Conflict"],
  "pr-update": ["更新 PR", "Update PR"],
  revert: ["撤销提交", "Revert"],
  "cherry-pick": ["拣选提交", "Cherry-pick"],
  "history-rewrite": ["整理历史", "Rewrite history"],
  "reflog-recover": ["Reflog 恢复", "Reflog recovery"],
  "force-push": ["安全强推", "Force push"],
  tag: ["标签", "Tag"],
  release: ["发布", "Release"],
  "pr-review": ["PR 审阅", "PR review"],
  "pr-merge": ["合并/关闭 PR", "Merge/close PR"],
};

const statusLabels: Record<GitOperationRecord["status"], [string, string]> = {
  running: ["进行中", "Running"],
  success: ["成功", "Succeeded"],
  failed: ["失败", "Failed"],
  partial: ["部分完成", "Partly completed"],
  unconfirmed: ["结果待确认", "Unconfirmed"],
};

const statusFilters = ["all", "success", "failed", "partial", "unconfirmed"] as const;
type StatusFilter = (typeof statusFilters)[number];

const statusFilterLabels: Record<StatusFilter, [string, string]> = {
  all: ["全部结果", "All results"],
  success: ["成功", "Succeeded"],
  failed: ["失败", "Failed"],
  partial: ["部分完成", "Partly"],
  unconfirmed: ["待确认", "Unconfirmed"],
};

const timeFilters = ["all", "hour", "day", "week"] as const;
type TimeFilter = (typeof timeFilters)[number];

const timeFilterLabels: Record<TimeFilter, [string, string]> = {
  all: ["全部时间", "Any time"],
  hour: ["最近 1 小时", "Last hour"],
  day: ["最近 24 小时", "Last 24 hours"],
  week: ["最近 7 天", "Last 7 days"],
};

const timeFilterMs: Record<TimeFilter, number | null> = {
  all: null,
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
};

const typeFilters: Array<{ value: GitOperationType | "all"; label: [string, string] }> = [
  { value: "all", label: ["全部类型", "All types"] },
  { value: "commit", label: ["提交", "Commit"] },
  { value: "amend", label: ["修正提交", "Amend"] },
  { value: "push", label: ["推送", "Push"] },
  { value: "fetch", label: ["Fetch", "Fetch"] },
  { value: "pull", label: ["Pull", "Pull"] },
  { value: "stash", label: ["Stash", "Stash"] },
  { value: "branch", label: ["分支", "Branch"] },
  { value: "remote", label: ["远程", "Remote"] },
  { value: "worktree", label: ["Worktree", "Worktree"] },
  { value: "conflict", label: ["冲突", "Conflict"] },
  { value: "pr-create", label: ["创建 PR", "Create PR"] },
  { value: "pr-update", label: ["更新 PR", "Update PR"] },
];

/** 操作记录:按目标、时间与结果检索,并可导航到提交与 PR。 */
export function OperationLogPanel({
  open,
  onClose,
  operations,
  onRefreshOperation,
  onRefresh,
  onSearch,
  onOpenCommit,
  onOpenPullRequest,
  locale,
}: {
  open: boolean;
  onClose(): void;
  operations: { running: GitOperationRecord[]; recent: GitOperationRecord[]; total?: number } | null;
  onRefreshOperation(id: string): void;
  onRefresh(): void;
  onSearch(query: GitOperationQuery | null): void;
  onOpenCommit(sha: string): void;
  onOpenPullRequest(): void;
  locale: AppLocale;
}) {
  const ref = useDismissable<HTMLDivElement>(open, onClose);
  const [text, setText] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [type, setType] = useState<GitOperationType | "all">("all");
  const [time, setTime] = useState<TimeFilter>("all");

  const query = useMemo<GitOperationQuery | null>(() => {
    const trimmed = text.trim();
    const next: GitOperationQuery = {};
    if (trimmed) next.text = trimmed;
    if (status !== "all") next.statuses = [status];
    if (type !== "all") next.types = [type];
    const window = timeFilterMs[time];
    if (window !== null) next.since = Date.now() - window;
    if (!next.text && !next.statuses && !next.types && next.since === undefined) return null;
    return next;
  }, [text, status, type, time]);

  // 过滤条件变化时防抖检索;打开面板时先刷新一次。
  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => onSearch(query), 250);
    return () => window.clearTimeout(timer);
  }, [open, query, onSearch]);

  if (!open) return null;
  const records = [...(operations?.running ?? []), ...(operations?.recent ?? [])];
  const filtered = query !== null;

  return (
    <div className="vc-popover vc-ops-popover" ref={ref} role="dialog" aria-label={tr("操作记录", "Operation log")}>
      <div className="vc-ops-head">
        <b>{tr("操作记录", "Operation log")}</b>
        <button type="button" className="vc-icon-btn" title={tr("刷新", "Refresh")} aria-label={tr("刷新", "Refresh")} onClick={onRefresh}>
          <RefreshIcon size={12} />
        </button>
        <button type="button" className="vc-link" onClick={onClose}>{tr("关闭", "Close")}</button>
      </div>

      <div className="vc-ops-filters">
        <label className="vc-search">
          <SearchIcon size={12} />
          <input
            aria-label={tr("检索操作记录", "Search operations")}
            placeholder={tr("检索分支、SHA、PR 或错误", "Search branch, SHA, PR or error")}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </label>
        <select className="vc-select" aria-label={tr("按结果筛选", "Filter by result")} value={status} onChange={(event) => setStatus(event.target.value as StatusFilter)}>
          {statusFilters.map((value) => (
            <option key={value} value={value}>{tr(statusFilterLabels[value][0], statusFilterLabels[value][1])}</option>
          ))}
        </select>
        <select className="vc-select" aria-label={tr("按类型筛选", "Filter by type")} value={type} onChange={(event) => setType(event.target.value as GitOperationType | "all")}>
          {typeFilters.map((entry) => (
            <option key={entry.value} value={entry.value}>{tr(entry.label[0], entry.label[1])}</option>
          ))}
        </select>
        <select className="vc-select" aria-label={tr("按时间筛选", "Filter by time")} value={time} onChange={(event) => setTime(event.target.value as TimeFilter)}>
          {timeFilters.map((value) => (
            <option key={value} value={value}>{tr(timeFilterLabels[value][0], timeFilterLabels[value][1])}</option>
          ))}
        </select>
      </div>
      {filtered ? (
        <div className="vc-ops-summary">
          {tr(`匹配 ${operations?.total ?? records.length} 条记录`, `${operations?.total ?? records.length} matching records`)}
          <button
            type="button"
            className="vc-link"
            onClick={() => {
              setText("");
              setStatus("all");
              setType("all");
              setTime("all");
            }}
          >
            {tr("清除筛选", "Clear filters")}
          </button>
        </div>
      ) : null}

      {records.length === 0 ? <div className="vc-state">{tr("没有匹配的操作记录", "No matching operations")}</div> : null}
      <div className="vc-ops-list">
        {records.map((record) => (
          <div key={record.id} className={`vc-op vc-op-${record.status}`}>
            <div className="vc-op-head">
              <span className="vc-op-type">{tr(operationLabels[record.type][0], operationLabels[record.type][1])}</span>
              <span className={`vc-badge vc-badge-${record.status === "success" ? "ok" : record.status === "running" ? "muted" : "pending"}`}>
                {tr(statusLabels[record.status][0], statusLabels[record.status][1])}
              </span>
              <span className="vc-hint">{formatRelativeTime(record.startedAt, locale)}</span>
            </div>
            <div className="vc-op-target">
              {record.branch ? <code>{record.branch}</code> : null}
              {record.expectedHead ? <code>{record.expectedHead.slice(0, 7)}</code> : null}
              {record.workspace ? <span title={record.workspace}>{record.workspace.split("/").pop()}</span> : null}
            </div>
            <div className="vc-op-steps">
              {record.steps.map((step) => (
                <span key={step.id} className={`vc-op-step vc-op-step-${step.status}`}>
                  {step.status === "success" ? <CheckIcon size={10} /> : step.status === "failed" ? <AlertIcon size={10} /> : null}
                  {step.label}
                  {step.detail ? <em>{step.detail}</em> : null}
                </span>
              ))}
            </div>
            <div className="vc-op-nav">
              {record.resultSha ? (
                <button type="button" className="vc-link" onClick={() => onOpenCommit(record.resultSha!)}>
                  <CommitIcon size={11} /> {tr("查看提交", "View commit")} <code>{record.resultSha.slice(0, 7)}</code>
                </button>
              ) : null}
              {record.resultUrl ? (
                <button
                  type="button"
                  className="vc-link"
                  onClick={() => {
                    onOpenPullRequest();
                    void window.vela?.openPullRequest(record.resultUrl!);
                  }}
                >
                  <PrIcon size={11} /> {record.prNumber ? `PR #${record.prNumber}` : tr("打开 PR", "Open PR")}
                  <ExternalIcon size={10} />
                </button>
              ) : null}
            </div>
            {record.error ? <div className="vc-op-error" role="alert">{record.error}</div> : null}
            {record.status === "unconfirmed" ? (
              <button type="button" className="vc-link" onClick={() => onRefreshOperation(record.id)}>
                {tr("核对实际结果", "Check actual result")}
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
