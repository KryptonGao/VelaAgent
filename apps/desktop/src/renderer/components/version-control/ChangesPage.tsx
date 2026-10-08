import { useEffect, useMemo, useRef, useState } from "react";
import type { AppLocale, ConversationGoal, GitChangeScope, GitHunkAction, GitStatusSnapshot } from "@vela/shared";
import { tr, trf } from "../../locale";
import type { ProjectApi } from "../../hooks/useProject";
import type { VersionControlApi } from "../../hooks/useVersionControl";
import { AlertIcon, CheckIcon, ExternalIcon, FileIcon, RefreshIcon, SearchIcon, TrashIcon } from "../icons";
import { ConflictResolver, operationLabel } from "./ConflictResolver";
import { groupChanges, matchesChangeFilter, scopeStats, scopeStatus, type ChangeGroupRow } from "./git-change-groups";
import { HunkedDiff } from "./HunkedDiff";
import { CommitComposer } from "./CommitComposer";

const statusLetters: Record<string, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  untracked: "U",
  conflicted: "C",
};

const statusLabels: Record<string, [string, string]> = {
  modified: ["修改", "Modified"],
  added: ["新增", "Added"],
  deleted: ["删除", "Deleted"],
  renamed: ["重命名", "Renamed"],
  untracked: ["未跟踪", "Untracked"],
  conflicted: ["冲突", "Conflicted"],
};

function statusText(status: string): string {
  const labels = statusLabels[status] ?? statusLabels.modified!;
  return tr(labels[0], labels[1]);
}

interface DiffState {
  key: string;
  text: string;
  error: string | null;
  truncated: boolean;
}

const maxDiffChars = 400_000;

/** 改动页:分组审阅 + 暂存/取消暂存/丢弃 + Commit 编辑区。 */
export function ChangesPage({
  project,
  api,
  status,
  goal,
  locale,
  workspace,
  onOpenHistory,
  onOpenFile,
}: {
  project: ProjectApi;
  api: VersionControlApi;
  status: GitStatusSnapshot;
  goal: ConversationGoal | null;
  locale: AppLocale;
  workspace: string | null;
  onOpenHistory(): void;
  onOpenFile(absolutePath: string): void;
}) {
  const [filter, setFilter] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [diff, setDiff] = useState<DiffState | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState<string | null>(null);
  const [mobileDiff, setMobileDiff] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [diffNonce, setDiffNonce] = useState(0);
  const diffSeq = useRef(0);

  const groups = useMemo(() => groupChanges(status.files), [status.files]);
  const visible = useMemo(() => ({
    conflicted: groups.conflicted.filter((row) => matchesChangeFilter(row.file, filter)),
    unstaged: groups.unstaged.filter((row) => matchesChangeFilter(row.file, filter)),
    staged: groups.staged.filter((row) => matchesChangeFilter(row.file, filter)),
  }), [groups, filter]);
  const allRows = useMemo(() => [...visible.conflicted, ...visible.unstaged, ...visible.staged], [visible]);

  const selected = allRows.find((row) => row.key === selectedKey) ?? null;
  const selectedRevision = `${status.files.length}:${status.addedLines}:${status.deletedLines}:${status.branch ?? ""}`;

  // 选中项失效时回到第一行;文件状态刷新后重新读取 Diff。
  useEffect(() => {
    if (allRows.length === 0) {
      setSelectedKey(null);
      return;
    }
    if (!selectedKey || !allRows.some((row) => row.key === selectedKey)) {
      setSelectedKey(allRows[0]!.key);
    }
  }, [allRows, selectedKey]);

  useEffect(() => {
    if (!selected) {
      setDiff(null);
      return;
    }
    const scope: GitChangeScope = selected.scope === "index" ? "index" : "worktree";
    // 冲突文件不展示普通 Diff,交给冲突编辑器读取三方内容。
    if (selected.scope === "conflict") {
      setDiff({ key: `${selected.key}:conflict`, text: "", error: null, truncated: false });
      return;
    }
    const key = `${selected.key}:${selectedRevision}:${diffNonce}:${api.ignoreWhitespace ? "w" : ""}`;
    const seq = ++diffSeq.current;
    setDiff((current) => (current?.key === key ? current : { key, text: "", error: null, truncated: false }));
    void project
      .fileDiff(selected.file.path, scope, api.diffOptions)
      .then((text) => {
        if (seq !== diffSeq.current) return;
        const truncated = text.length > maxDiffChars;
        setDiff({ key, text: truncated ? text.slice(0, maxDiffChars) : text, error: null, truncated });
      })
      .catch((caught) => {
        if (seq !== diffSeq.current) return;
        setDiff({ key, text: "", error: caught instanceof Error ? caught.message : tr("差异加载失败", "Could not load the diff"), truncated: false });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.key, selected?.file.path, selected?.scope, selectedRevision, diffNonce, api.ignoreWhitespace, api.diffOptions, project.fileDiff]);

  useEffect(() => {
    setSelection((current) => {
      const live = new Set(allRows.map((row) => row.key));
      const next = new Set([...current].filter((key) => live.has(key)));
      return next.size === current.size ? current : next;
    });
  }, [allRows]);

  const toggleSelection = (key: string) => {
    setSelection((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const stageRows = async (rows: ChangeGroupRow[]) => {
    if (rows.length === 0 || !(await api.ensureMutable())) return;
    await project.stageFiles([...new Set(rows.map((row) => row.file.path))]);
    setSelection(new Set());
  };

  const unstageRows = async (rows: ChangeGroupRow[]) => {
    if (rows.length === 0 || !(await api.ensureMutable())) return;
    await project.unstageFiles([...new Set(rows.map((row) => row.file.path))]);
    setSelection(new Set());
  };

  const discardRow = async (row: ChangeGroupRow) => {
    setConfirmDiscard(null);
    if (!(await api.ensureMutable())) return;
    const untracked = row.file.status === "untracked";
    await project.discardFiles([row.file.path], { untracked });
  };

  const selectedRows = allRows.filter((row) => selection.has(row.key));
  const conflictedCount = groups.conflicted.length;
  const operation = status.operation;

  const hunkActionsFor = (row: ChangeGroupRow): GitHunkAction[] => {
    if (row.scope === "index") return ["unstage"];
    if (row.scope === "conflict") return [];
    if (row.file.status === "untracked") return [];
    return ["stage", "discard"];
  };

  // 忽略空白是展示层过滤,代码块边界可能和真实索引内容不一致,此时禁用按块操作。
  const hunkActions = (row: ChangeGroupRow): GitHunkAction[] =>
    api.ignoreWhitespace ? [] : hunkActionsFor(row);

  const applyHunkPatch = (row: ChangeGroupRow) => async (action: GitHunkAction, patch: string, count: number) => {
    setNotice(null);
    const ok = await api.applyHunks(row.file.path, action, patch);
    if (ok) {
      const verb = action === "stage" ? tr("已暂存", "Staged") : action === "unstage" ? tr("已取消暂存", "Unstaged") : tr("已丢弃", "Discarded");
      setNotice(trf("{0} {1} 个代码块", "{0} {1} hunk(s)", verb, count));
    }
  };

  const controlOperation = async (action: "continue" | "abort") => {
    const result = await api.controlOperation(action);
    if (result?.ok) setNotice(result.message);
  };

  return (
    <div className={`vc-changes${mobileDiff ? " show-diff" : ""}`}>
      {operation ? (
        <div className="vc-op-banner" role="alert">
          <AlertIcon size={13} />
          <span>
            {trf("正在进行的操作：{0}，{1} 个冲突文件", "Operation in progress: {0}, {1} conflicted file(s)", operationLabel(operation.kind), operation.conflictedPaths.length)}
          </span>
          <button
            type="button"
            className="vc-btn vc-btn-ghost"
            disabled={api.busy !== null || api.guard?.agentRunning === true}
            onClick={() => void controlOperation("continue")}
          >
            {tr("全部解决后继续", "Continue when resolved")}
          </button>
          <button
            type="button"
            className="vc-btn vc-btn-danger"
            disabled={api.busy !== null || api.guard?.agentRunning === true}
            onClick={() => void controlOperation("abort")}
          >
            {tr("中止操作", "Abort")}
          </button>
          <span className="vc-hint">{tr("解决文件中的冲突标记后才能继续。", "Resolve the conflict markers before continuing.")}</span>
        </div>
      ) : null}

      <div className="vc-files">
        <div className="vc-files-head">
          <div className="vc-files-title">
            <FileIcon size={13} />
            <b>{tr("变更文件", "Changed files")}</b>
            <span>{trf("{0} 个", "{0}", status.files.length)}</span>
          </div>
          <button
            type="button"
            className="vc-icon-btn vc-mobile-diff-btn"
            title={tr("查看差异", "View diff")}
            aria-label={tr("查看差异", "View diff")}
            aria-pressed={mobileDiff}
            onClick={() => setMobileDiff((value) => !value)}
          >
            <SearchIcon size={13} />
          </button>
        </div>
        <label className="vc-search">
          <SearchIcon size={12} />
          <input
            aria-label={tr("筛选文件名或路径", "Filter by file name or path")}
            placeholder={tr("筛选文件名或路径", "Filter file name or path")}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </label>

        {selection.size > 0 ? (
          <div className="vc-selection-bar">
            <span>{trf("已选 {0} 项", "{0} selected", selection.size)}</span>
            <button type="button" className="vc-link" onClick={() => void stageRows(selectedRows.filter((row) => row.scope === "worktree" || row.scope === "conflict"))}>
              {tr("暂存", "Stage")}
            </button>
            <button type="button" className="vc-link" onClick={() => void unstageRows(selectedRows.filter((row) => row.scope === "index"))}>
              {tr("取消暂存", "Unstage")}
            </button>
            <button type="button" className="vc-link" onClick={() => setSelection(new Set())}>{tr("清除", "Clear")}</button>
          </div>
        ) : null}

        <div className="vc-files-scroll">
          {status.files.length === 0 ? (
            <div className="vc-state">{tr("工作区是干净的", "The workspace is clean")}</div>
          ) : null}
          {conflictedCount > 0 ? (
            <div className="vc-group vc-group-conflict">
              <div className="vc-group-head">
                <span className="vc-group-title"><AlertIcon size={12} />{tr("冲突", "Conflicts")}</span>
                <span className="vc-group-count">{visible.conflicted.length}</span>
              </div>
              {visible.conflicted.map((row) => (
                <ChangeRow
                  key={row.key}
                  row={row}
                  selected={row.key === selectedKey}
                  checked={selection.has(row.key)}
                  onSelect={() => { setSelectedKey(row.key); setMobileDiff(true); }}
                  onToggle={() => toggleSelection(row.key)}
                  onStage={() => void stageRows([row])}
                  onDiscard={() => setConfirmDiscard(row.key)}
                />
              ))}
            </div>
          ) : null}

          <ChangeGroup
            title={tr("未暂存", "Unstaged")}
            action={tr("全部暂存", "Stage all")}
            rows={visible.unstaged}
            selectedKey={selectedKey}
            selection={selection}
            onSelect={(row) => { setSelectedKey(row.key); setMobileDiff(true); }}
            onToggle={toggleSelection}
            onStage={(rows) => void stageRows(rows)}
            onDiscard={setConfirmDiscard}
            confirmDiscard={confirmDiscard}
            onConfirmDiscard={(row) => void discardRow(row)}
            onCancelDiscard={() => setConfirmDiscard(null)}
            canDiscard
          />

          <ChangeGroup
            title={tr("已暂存", "Staged")}
            action={tr("取消全部", "Unstage all")}
            rows={visible.staged}
            selectedKey={selectedKey}
            selection={selection}
            onSelect={(row) => { setSelectedKey(row.key); setMobileDiff(true); }}
            onToggle={toggleSelection}
            onStage={(rows) => void unstageRows(rows)}
            onDiscard={setConfirmDiscard}
            confirmDiscard={confirmDiscard}
            onConfirmDiscard={(row) => void discardRow(row)}
            onCancelDiscard={() => setConfirmDiscard(null)}
          />
        </div>

        <div className="vc-git-state">
          <span className="vc-dot vc-dot-ok" aria-hidden="true" />
          {status.repo?.subdir
            ? tr("仓库级范围", "Repository scope")
            : tr("Git 状态已更新", "Git status up to date")}
          <span className="vc-git-state-path" title={status.repo?.root}>{status.repo?.root}</span>
        </div>
      </div>

      <div className="vc-diff-pane">
        {selected ? (
          <>
            <div className="vc-diff-head">
              <span className={`vc-status vc-status-${scopeStatus(selected.file, selected.scope)}`}>
                {statusLetters[scopeStatus(selected.file, selected.scope)] ?? "M"}
              </span>
              <span className="vc-diff-path" title={selected.file.path}>
                {selected.file.oldPath && selected.file.status === "renamed"
                  ? `${selected.file.oldPath} → ${selected.file.path}`
                  : selected.file.path}
              </span>
              <span className="vc-diff-scope">
                {selected.scope === "index" ? tr("索引版本", "Index version") : selected.scope === "conflict" ? tr("冲突内容", "Conflict") : tr("工作区改动", "Working tree")}
              </span>
              <span className="vc-stats">
                <b className="vc-plus">+{scopeStats(selected.file, selected.scope).added}</b>
                <b className="vc-minus">−{scopeStats(selected.file, selected.scope).deleted}</b>
              </span>
              <div className="vc-diff-options" role="group" aria-label={tr("差异显示方式", "Diff display options")}>
                <button
                  type="button"
                  className={`vc-chip${api.diffMode === "unified" ? " active" : ""}`}
                  aria-pressed={api.diffMode === "unified"}
                  onClick={() => api.setDiffMode("unified")}
                >
                  {tr("统一", "Unified")}
                </button>
                <button
                  type="button"
                  className={`vc-chip${api.diffMode === "split" ? " active" : ""}`}
                  aria-pressed={api.diffMode === "split"}
                  onClick={() => api.setDiffMode("split")}
                >
                  {tr("并排", "Split")}
                </button>
                <label className="vc-chip vc-chip-check">
                  <input
                    type="checkbox"
                    checked={api.ignoreWhitespace}
                    onChange={(event) => api.setIgnoreWhitespace(event.target.checked)}
                  />
                  {tr("忽略空白", "Ignore whitespace")}
                </label>
              </div>
              <button
                type="button"
                className="vc-icon-btn"
                title={tr("打开文件", "Open file")}
                aria-label={tr("打开文件", "Open file")}
                onClick={() => {
                  void window.vela?.readWorkspaceFile(selected.file.path).then((content) => {
                    if (content.kind === "missing") setNotice(tr("该文件在当前工作区不存在，未打开历史版本。", "This file does not exist in the workspace; the historical version was not opened."));
                    else onOpenFile(`${status.repo?.root ?? ""}/${selected.file.path}`);
                  }).catch(() => setNotice(tr("无法打开该文件", "Could not open this file")));
                }}
              >
                <ExternalIcon size={12} />
              </button>
              {selected.scope === "worktree" || selected.file.status === "untracked" ? (
                <button
                  type="button"
                  className="vc-icon-btn vc-danger"
                  title={tr("丢弃工作区改动", "Discard working tree changes")}
                  aria-label={tr("丢弃工作区改动", "Discard working tree changes")}
                  onClick={() => setConfirmDiscard(selected.key)}
                >
                  <TrashIcon size={12} />
                </button>
              ) : null}
            </div>
            {notice ? <div className="vc-inline-notice" role="status">{notice}</div> : null}
            {selected.scope === "worktree" && confirmDiscard === selected.key ? (
              <DiscardConfirm row={selected} onCancel={() => setConfirmDiscard(null)} onConfirm={() => void discardRow(selected)} />
            ) : null}
            <div className="vc-diff-scroll">
              {selected.scope === "conflict" ? (
                <ConflictResolver
                  api={api}
                  path={selected.file.path}
                  disabled={api.busy !== null || api.guard?.agentRunning === true}
                  onResolved={() => setDiffNonce((value) => value + 1)}
                />
              ) : diff?.key.startsWith(`${selected.key}:`) && diff.error ? (
                <div className="vc-state vc-state-error" role="alert">
                  <AlertIcon size={13} />
                  <span>{diff.error}</span>
                  <button type="button" className="vc-link" onClick={() => setDiffNonce((value) => value + 1)}>
                    <RefreshIcon size={12} /> {tr("重试", "Retry")}
                  </button>
                </div>
              ) : !diff || !diff.key.startsWith(`${selected.key}:`) ? (
                <div className="vc-state">{tr("正在读取差异…", "Loading diff…")}</div>
              ) : isBinaryDiff(diff.text) ? (
                <div className="vc-state">{tr("二进制文件，无法显示文本差异。", "Binary file; no text diff is available.")}</div>
              ) : diff.text ? (
                <>
                  {diff.truncated ? <div className="vc-inline-notice">{tr("差异过大，仅显示前一部分。", "The diff is very large; only the first part is shown.")}</div> : null}
                  {api.ignoreWhitespace && hunkActionsFor(selected).length > 0 ? (
                    <div className="vc-inline-notice" role="status">
                      {tr(
                        "忽略空白只影响显示；要按代码块暂存或丢弃，请先切回完整差异。",
                        "Ignoring whitespace only changes the display; switch back to the full diff to stage or discard hunks.",
                      )}
                    </div>
                  ) : null}
                  <HunkedDiff
                    key={diff.key}
                    path={selected.file.path}
                    diff={diff.text}
                    mode={api.diffMode}
                    actions={hunkActions(selected)}
                    disabled={api.busy !== null || api.guard?.agentRunning === true}
                    onApply={(action, patch, count) => void applyHunkPatch(selected)(action, patch, count)}
                  />
                </>
              ) : (
                <div className="vc-state">{tr("没有可显示的差异", "No diff to display")}</div>
              )}
            </div>
          </>
        ) : (
          <div className="vc-state">{tr("选择一个文件查看差异", "Select a file to view its diff")}</div>
        )}

        <CommitComposer
          api={api}
          status={status}
          stagedRows={groups.staged}
          unstagedRows={groups.unstaged}
          goal={goal}
          locale={locale}
          workspace={workspace}
          onCommitted={() => undefined}
          onOpenHistory={onOpenHistory}
        />
      </div>
    </div>
  );
}

function isBinaryDiff(text: string): boolean {
  return text.includes("Binary files") || text.includes("GIT binary patch");
}

function ChangeGroup({
  title,
  action,
  rows,
  selectedKey,
  selection,
  onSelect,
  onToggle,
  onStage,
  onDiscard,
  confirmDiscard,
  onConfirmDiscard,
  onCancelDiscard,
  canDiscard = false,
}: {
  title: string;
  action: string;
  rows: ChangeGroupRow[];
  selectedKey: string | null;
  selection: Set<string>;
  onSelect(row: ChangeGroupRow): void;
  onToggle(key: string): void;
  onStage(rows: ChangeGroupRow[]): void;
  onDiscard(key: string): void;
  confirmDiscard: string | null;
  onConfirmDiscard(row: ChangeGroupRow): void;
  onCancelDiscard(): void;
  canDiscard?: boolean;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="vc-group">
      <div className="vc-group-head">
        <span className="vc-group-count">{rows.length}</span>
        <span className="vc-group-title">{title}</span>
        <button type="button" className="vc-link" onClick={() => onStage(rows)}>{action}</button>
      </div>
      {rows.map((row) => (
        <ChangeRow
          key={row.key}
          row={row}
          selected={row.key === selectedKey}
          checked={selection.has(row.key)}
          onSelect={() => onSelect(row)}
          onToggle={() => onToggle(row.key)}
          onStage={() => onStage([row])}
          onDiscard={canDiscard || row.file.status === "untracked" ? () => onDiscard(row.key) : undefined}
          confirmDiscard={confirmDiscard === row.key}
          onConfirmDiscard={() => onConfirmDiscard(row)}
          onCancelDiscard={onCancelDiscard}
        />
      ))}
    </div>
  );
}

function ChangeRow({
  row,
  selected,
  checked,
  onSelect,
  onToggle,
  onStage,
  onDiscard,
  confirmDiscard = false,
  onConfirmDiscard,
  onCancelDiscard,
}: {
  row: ChangeGroupRow;
  selected: boolean;
  checked: boolean;
  onSelect(): void;
  onToggle(): void;
  onStage(): void;
  onDiscard?: () => void;
  confirmDiscard?: boolean;
  onConfirmDiscard?(): void;
  onCancelDiscard?(): void;
}) {
  const segments = row.file.path.split("/");
  const name = segments.pop() ?? row.file.path;
  const directory = segments.join("/");
  const status = scopeStatus(row.file, row.scope);
  const stats = scopeStats(row.file, row.scope);
  return (
    <div className={`vc-file-row${selected ? " selected" : ""}`} role="button" tabIndex={0} onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
    >
      <input
        type="checkbox"
        className="vc-check"
        checked={checked}
        aria-label={trf("选择 {0}", "Select {0}", row.file.path)}
        onClick={(event) => event.stopPropagation()}
        onChange={onToggle}
      />
      <span className={`vc-status vc-status-${status}`} title={statusText(status)} aria-label={statusText(status)}>
        {statusLetters[status] ?? "M"}
      </span>
      <span className="vc-file-copy">
        <span className="vc-file-name" title={row.file.path}>
          {row.file.oldPath && row.file.status === "renamed" ? `${row.file.oldPath} → ${name}` : name}
        </span>
        <span className="vc-file-dir">
          {directory}
          {row.scope === "index" ? ` · ${tr("索引版本", "index")}` : row.scope === "worktree" ? ` · ${tr("工作区版本", "worktree")}` : ""}
        </span>
      </span>
      <span className="vc-stats"><b className="vc-plus">+{stats.added}</b> <b className="vc-minus">−{stats.deleted}</b></span>
      <span className="vc-file-actions" onClick={(event) => event.stopPropagation()}>
        {confirmDiscard && onConfirmDiscard && onCancelDiscard ? (
          <span className="vc-confirm">
            <button type="button" className="vc-link vc-danger" onClick={onConfirmDiscard}>{tr("确认丢弃", "Discard")}</button>
            <button type="button" className="vc-link" onClick={onCancelDiscard}>{tr("取消", "Cancel")}</button>
          </span>
        ) : (
          <>
            {onDiscard ? (
              <button type="button" className="vc-icon-btn vc-danger" title={tr("丢弃工作区改动", "Discard changes")} aria-label={tr("丢弃", "Discard")} onClick={onDiscard}>
                <TrashIcon size={11} />
              </button>
            ) : null}
            <button type="button" className="vc-icon-btn" title={row.scope === "index" ? tr("取消暂存", "Unstage") : tr("暂存", "Stage")} aria-label={row.scope === "index" ? tr("取消暂存", "Unstage") : tr("暂存", "Stage")} onClick={onStage}>
              {row.scope === "index" ? "−" : <CheckIcon size={11} />}
            </button>
          </>
        )}
      </span>
    </div>
  );
}

function DiscardConfirm({ row, onCancel, onConfirm }: { row: ChangeGroupRow; onCancel(): void; onConfirm(): void }) {
  const untracked = row.file.status === "untracked";
  return (
    <div className="vc-discard-confirm" role="alertdialog" aria-label={tr("确认丢弃", "Confirm discard")}>
      <p>
        {untracked
          ? trf("将删除未跟踪文件 {0}，此操作不可撤销。", "Deletes untracked file {0}. This cannot be undone.", row.file.path)
          : trf("将把 {0} 的工作区内容还原为索引版本；已暂存内容不受影响。", "Restores {0} to the index version; staged content is untouched.", row.file.path)}
      </p>
      <div className="vc-dialog-actions">
        <button type="button" className="vc-btn vc-btn-ghost" onClick={onCancel}>{tr("取消", "Cancel")}</button>
        <button type="button" className="vc-btn vc-btn-danger" onClick={onConfirm}>{untracked ? tr("删除未跟踪文件", "Delete file") : tr("丢弃工作区改动", "Discard changes")}</button>
      </div>
    </div>
  );
}
