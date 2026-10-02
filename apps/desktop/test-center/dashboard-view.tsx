/** 测试中心看板的展示组件与共享类型。 */
import type { ReactNode } from "react";

export type TaskKind = "node" | "ui";
export type TaskStatus = "pending" | "running" | "passed" | "failed" | "skipped" | "cancelled";

export interface TestTask {
  id: string;
  kind: TaskKind;
  title: string;
  path: string;
  package: string;
  layer: string;
  feature: string | null;
}

export interface TestGroup {
  id: string;
  title: string;
  taskIds: string[];
}

export interface TestFeature {
  id: string;
  title: string;
  taskIds: string[];
}

export interface TestError {
  message: string;
  stack?: string;
}

export interface SubtestResult {
  testId: number;
  name: string;
  nesting: number;
  status: TaskStatus;
  durationMs: number | null;
  error: TestError | null;
}

export interface TaskResult {
  status: TaskStatus;
  durationMs: number | null;
  error: TestError | null;
  output: string;
  subtests: SubtestResult[];
  startedAt: number | null;
  finishedAt: number | null;
}

export interface RunSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  cancelled: number;
  pending: number;
  durationMs: number;
}

export interface RunState {
  id: string;
  status: "running" | "finished" | "cancelled" | "error";
  phase: "node" | "ui" | null;
  startedAt: number;
  finishedAt: number | null;
  selection: string[];
  results: Record<string, TaskResult>;
  log: string[];
  summary: RunSummary | null;
}

export const statusMeta: Record<TaskStatus, { label: string; tone: string }> = {
  pending: { label: "未运行", tone: "pending" },
  running: { label: "运行中", tone: "running" },
  passed: { label: "通过", tone: "passed" },
  failed: { label: "失败", tone: "failed" },
  skipped: { label: "跳过", tone: "skipped" },
  cancelled: { label: "取消", tone: "cancelled" },
};

export function formatDuration(durationMs: number | null | undefined): string {
  if (durationMs == null) return "—";
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

export function StatusDot({ status }: { status: TaskStatus }) {
  return <span className={`tc-dot tc-dot-${statusMeta[status].tone}`} title={statusMeta[status].label} />;
}

interface ToolbarProps {
  run: RunState | null;
  running: boolean;
  connected: boolean;
  selectedCount: number;
  visibleCount: number;
  totalCount: number;
  phase: "node" | "ui" | null;
  onRunAll: () => void;
  onRunSelected: () => void;
  onRerunFailed: () => void;
  onStop: () => void;
  search: string;
  onSearch: (value: string) => void;
  onlyFailed: boolean;
  onOnlyFailed: (value: boolean) => void;
  groupMode: "layer" | "feature";
  onGroupMode: (mode: "layer" | "feature") => void;
}

export function Toolbar(props: ToolbarProps) {
  const failedCount = props.run
    ? Object.values(props.run.results).filter((result) => result.status === "failed").length
    : 0;
  return (
    <header className="tc-toolbar">
      <div className="tc-toolbar-actions">
        <button className="tc-button tc-button-primary" onClick={props.onRunAll} disabled={props.running}>
          运行全部
        </button>
        <button className="tc-button" onClick={props.onRunSelected} disabled={props.running || props.selectedCount === 0}>
          运行选中{props.selectedCount > 0 ? ` (${props.selectedCount})` : ""}
        </button>
        <button className="tc-button" onClick={props.onRerunFailed} disabled={props.running || failedCount === 0}>
          重跑失败{failedCount > 0 ? ` (${failedCount})` : ""}
        </button>
        <button className="tc-button tc-button-danger" onClick={props.onStop} disabled={!props.running}>
          停止
        </button>
      </div>
      <div className="tc-toolbar-filters">
        <input
          className="tc-search"
          type="search"
          placeholder="搜索任务或路径"
          value={props.search}
          onChange={(event) => props.onSearch(event.target.value)}
        />
        <label className="tc-check">
          <input type="checkbox" checked={props.onlyFailed} onChange={(event) => props.onOnlyFailed(event.target.checked)} />
          只看失败
        </label>
        <div className="tc-segmented" role="group" aria-label="分组方式">
          <button className={props.groupMode === "layer" ? "active" : ""} onClick={() => props.onGroupMode("layer")}>
            按包/层
          </button>
          <button className={props.groupMode === "feature" ? "active" : ""} onClick={() => props.onGroupMode("feature")}>
            按功能
          </button>
        </div>
        <span className={`tc-connection ${props.connected ? "online" : "offline"}`}>
          {props.connected ? "已连接" : "重连中…"}
        </span>
      </div>
    </header>
  );
}

interface SummaryBarProps {
  run: RunState | null;
  running: boolean;
  phase: "node" | "ui" | null;
  selectedCount: number;
  visibleCount: number;
  totalCount: number;
}

export function SummaryBar(props: SummaryBarProps) {
  const summary = props.run?.summary;
  const results = props.run?.results ?? {};
  const live = {
    total: props.run?.selection.length ?? 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    cancelled: 0,
    running: 0,
    pending: 0,
  };
  for (const id of props.run?.selection ?? []) {
    const status = results[id]?.status ?? "pending";
    if (status === "running") live.running += 1;
    else if (status in live) (live as unknown as Record<string, number>)[status] += 1;
  }
  const finished = live.passed + live.failed + live.skipped + live.cancelled;
  const percent = live.total === 0 ? 0 : Math.round((finished / live.total) * 100);
  const duration = summary?.durationMs ?? (props.run ? Date.now() - props.run.startedAt : 0);
  return (
    <div className="tc-summary">
      {props.running ? (
        <div className="tc-progress" aria-label="运行进度">
          <div className="tc-progress-track">
            <div className="tc-progress-fill" style={{ width: `${percent}%` }} />
          </div>
          <span>
            {props.phase === "ui" ? "浏览器检查" : "Node 单测"} · {finished}/{live.total}
          </span>
        </div>
      ) : null}
      <div className="tc-summary-chips">
        {props.running ? <span className="tc-chip running">{live.running} 运行中</span> : null}
        <span className="tc-chip passed">{live.passed} 通过</span>
        <span className={`tc-chip ${live.failed > 0 ? "failed" : ""}`}>{live.failed} 失败</span>
        <span className="tc-chip skipped">{live.skipped} 跳过</span>
        <span className="tc-chip cancelled">{live.cancelled} 取消</span>
        <span className="tc-chip pending">{live.pending} 未完成</span>
        <span className="tc-chip muted">{formatDuration(duration)}</span>
      </div>
      <span className="tc-summary-note">
        {props.run ? `运行 ${props.run.id}` : "还没有运行过测试"} · 当前显示 {props.visibleCount}/{props.totalCount} 个任务
        {props.selectedCount > 0 ? ` · 已选 ${props.selectedCount}` : ""}
      </span>
    </div>
  );
}

interface GroupSidebarProps {
  mode: "layer" | "feature";
  groups: TestGroup[];
  features: TestFeature[];
  active: string;
  onSelect: (id: string) => void;
  tasks: TestTask[];
  run: RunState | null;
}

export function GroupSidebar(props: GroupSidebarProps) {
  const entries: { id: string; title: string; taskIds: string[] }[] = props.mode === "layer" ? props.groups : [...props.features];
  const ungrouped = props.mode === "feature" ? props.tasks.filter((task) => !task.feature).map((task) => task.id) : [];
  if (ungrouped.length > 0) entries.push({ id: "ungrouped", title: "未分组", taskIds: ungrouped });

  const counts = (taskIds: string[]) => {
    const bucket = { passed: 0, failed: 0, running: 0, pending: 0 };
    for (const id of taskIds) {
      const status = props.run?.results[id]?.status ?? "pending";
      if (status === "passed") bucket.passed += 1;
      else if (status === "failed") bucket.failed += 1;
      else if (status === "running") bucket.running += 1;
      else bucket.pending += 1;
    }
    return bucket;
  };

  const row = (entry: { id: string; title: string; taskIds: string[] }) => {
    const bucket = counts(entry.taskIds);
    return (
      <button key={entry.id} className={`tc-group ${props.active === entry.id ? "active" : ""}`} onClick={() => props.onSelect(entry.id)}>
        <span className="tc-group-title">{entry.title}</span>
        <span className="tc-group-count">{entry.taskIds.length}</span>
        <span className="tc-group-bar">
          {bucket.failed > 0 ? <i className="failed" style={{ flexGrow: bucket.failed }} /> : null}
          {bucket.running > 0 ? <i className="running" style={{ flexGrow: bucket.running }} /> : null}
          {bucket.passed > 0 ? <i className="passed" style={{ flexGrow: bucket.passed }} /> : null}
        </span>
      </button>
    );
  };

  return (
    <nav className="tc-sidebar">
      <button className={`tc-group ${props.active === "all" ? "active" : ""}`} onClick={() => props.onSelect("all")}>
        <span className="tc-group-title">全部任务</span>
        <span className="tc-group-count">{props.tasks.length}</span>
      </button>
      {entries.map(row)}
    </nav>
  );
}

interface TaskRowProps {
  task: TestTask;
  result: TaskResult | null;
  selected: boolean;
  expanded: boolean;
  onToggleSelect: () => void;
  onToggleExpand: () => void;
}

function ErrorBlock({ error }: { error: TestError | null }) {
  if (!error) return null;
  return (
    <div className="tc-error">
      <div className="tc-error-message">{error.message}</div>
      {error.stack ? <pre className="tc-pre">{error.stack}</pre> : null}
    </div>
  );
}

function OutputBlock({ label, text }: { label: string; text: string }) {
  if (!text) return null;
  return (
    <div className="tc-output">
      <div className="tc-output-label">{label}</div>
      <pre className="tc-pre">{text}</pre>
    </div>
  );
}

export function TaskRow(props: TaskRowProps) {
  const status = props.result?.status ?? "pending";
  const subtests = props.result?.subtests ?? [];
  return (
    <div className={`tc-row ${props.expanded ? "expanded" : ""} tc-row-${status}`}>
      <div className="tc-row-head">
        <input
          type="checkbox"
          className="tc-row-check"
          checked={props.selected}
          onChange={props.onToggleSelect}
          aria-label={`选择 ${props.task.title}`}
        />
        <button className="tc-row-main" onClick={props.onToggleExpand}>
          <StatusDot status={status} />
          <span className="tc-row-title">{props.task.title}</span>
          <span className="tc-row-path">{props.task.path}</span>
          {props.task.kind === "ui" ? <span className="tc-badge">浏览器</span> : null}
          {subtests.length > 0 ? <span className="tc-row-subtests">{subtests.length} 项</span> : null}
          <span className="tc-row-duration">{formatDuration(props.result?.durationMs)}</span>
          <span className={`tc-row-status ${statusMeta[status].tone}`}>{statusMeta[status].label}</span>
        </button>
        {props.task.kind === "ui" ? (
          <a className="tc-row-link" href={`/${props.task.path}`} target="_blank" rel="noreferrer">
            预览
          </a>
        ) : null}
      </div>
      {props.expanded ? (
        <div className="tc-row-detail">
          {subtests.length > 0 ? (
            <ul className="tc-subtests">
              {subtests.map((subtest) => (
                <li key={subtest.testId} className={`tc-subtest ${statusMeta[subtest.status].tone}`}>
                  <StatusDot status={subtest.status} />
                  <span className="tc-subtest-name" style={{ paddingLeft: `${Math.max(0, subtest.nesting - 1) * 14}px` }}>
                    {subtest.name}
                  </span>
                  <span className="tc-subtest-duration">{formatDuration(subtest.durationMs)}</span>
                </li>
              ))}
            </ul>
          ) : null}
          <ErrorBlock error={props.result?.error ?? null} />
          <OutputBlock label="输出" text={props.result?.output ?? ""} />
          {!props.result ? <p className="tc-hint">尚未运行。勾选后点「运行选中」，或直接点「运行全部」。</p> : null}
        </div>
      ) : null}
    </div>
  );
}

export function LogDrawer({ log, open, onToggle }: { log: string[]; open: boolean; onToggle: () => void }): ReactNode {
  return (
    <section className={`tc-log ${open ? "open" : ""}`}>
      <button className="tc-log-head" onClick={onToggle}>
        运行日志{log.length > 0 ? ` (${log.length})` : ""}
      </button>
      {open ? <pre className="tc-pre tc-log-body">{log.join("\n") || "暂无日志"}</pre> : null}
    </section>
  );
}
