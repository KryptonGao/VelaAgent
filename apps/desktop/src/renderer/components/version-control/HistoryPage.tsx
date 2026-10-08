import { useEffect, useMemo, useRef, useState } from "react";
import type { AppLocale, GitCommitDetail, GitCommitSummary, GitRefLabel } from "@vela/shared";
import { tr, trf } from "../../locale";
import { AlertIcon, BranchIcon, CheckIcon, CommitIcon, CopyIcon, ExternalIcon, RefreshIcon, SearchIcon, TagIcon } from "../icons";
import { DiffPane } from "../DiffPane";
import { CommitGraph, useCommitGraphGeometry } from "./CommitGraph";
import { formatAbsoluteTime, formatRelativeTime } from "./time-format";
import type { VersionControlApi } from "../../hooks/useVersionControl";

/** 把提交 Diff 按文件切开,供逐文件查看。 */
export function splitCommitDiff(diff: string): Map<string, string> {
  const result = new Map<string, string>();
  const parts = diff.split(/(?=^diff --git )/m);
  for (const part of parts) {
    const match = /^diff --git a\/(.+?) b\/(.+)$/m.exec(part);
    if (!match) continue;
    const path = match[2] ?? match[1]!;
    result.set(path, part);
  }
  return result;
}

function refLabel(ref: GitRefLabel): string {
  if (ref.kind === "head") return ref.name.startsWith("HEAD") ? ref.name : `HEAD → ${ref.name}`;
  if (ref.kind === "tag") return ref.name;
  return ref.name;
}

function RefBadges({ refs, limit = 3 }: { refs: GitRefLabel[]; limit?: number }) {
  const [expanded, setExpanded] = useState(false);
  if (refs.length === 0) return null;
  const shown = expanded ? refs : refs.slice(0, limit);
  return (
    <span className="vc-refs">
      {shown.map((ref) => (
        <span key={`${ref.kind}:${ref.name}`} className={`vc-ref vc-ref-${ref.kind}`}>
          {ref.kind === "tag" ? <TagIcon size={9} /> : null}
          {ref.kind === "local" || ref.kind === "head" ? <BranchIcon size={9} /> : null}
          {refLabel(ref)}
        </span>
      ))}
      {refs.length > limit && !expanded ? (
        <button type="button" className="vc-ref vc-ref-more" onClick={(event) => { event.stopPropagation(); setExpanded(true); }}>
          +{refs.length - limit}
        </button>
      ) : null}
    </span>
  );
}

function CommitRow({
  commit,
  selected,
  upstream,
  locale,
  onSelect,
}: {
  commit: GitCommitSummary;
  selected: boolean;
  upstream: string | null;
  locale: AppLocale;
  onSelect(): void;
}) {
  return (
    <div
      className={`vc-commit-row${selected ? " selected" : ""}`}
      role="button"
      tabIndex={0}
      aria-current={selected ? "true" : undefined}
      data-sha={commit.sha}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
    >
      <div className="vc-commit-body">
        <div className="vc-commit-subject" title={commit.subject}>{commit.subject}</div>
        <div className="vc-commit-meta">
          <span>{commit.authorName}</span>
          <span className="vc-dot" aria-hidden="true" />
          <span>{formatRelativeTime(commit.authorAt, locale)}</span>
          <code className="vc-sha">{commit.shortSha}</code>
          <RefBadges refs={commit.refs} />
          {commit.pushed === false ? <span className="vc-badge vc-badge-pending">{tr("待推送", "Unpushed")}</span> : null}
          {commit.pushed === null && upstream === null && commit.refs.some((ref) => ref.kind === "head") ? (
            <span className="vc-badge vc-badge-muted">{tr("未发布", "Not published")}</span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function HistoryPage({
  api,
  repoRoot,
  upstream,
  onOpenFile,
  onCompare,
  onOpenHistoryOps,
  onOpenReflog,
  locale,
}: {
  api: VersionControlApi;
  repoRoot: string;
  upstream: string | null;
  onOpenFile(absolutePath: string): void;
  onCompare(base: string, head: string): void;
  /** HI-02–HI-04/CT-06:对选中提交执行撤销、拣选、整理或建分支。 */
  onOpenHistoryOps(commit: GitCommitSummary): void;
  /** HI-06:打开 Reflog 恢复入口。 */
  onOpenReflog(): void;
  locale: AppLocale;
}) {
  const [searchInput, setSearchInput] = useState("");
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [mobileDetail, setMobileDetail] = useState(false);
  const searchTimer = useRef<number | null>(null);

  const commits = api.searchResult ? api.searchResult.commits : api.graph?.commits ?? [];
  const geometry = useCommitGraphGeometry(commits);
  const detail = api.detail;

  useEffect(() => {
    if (!detail) {
      setSelectedFile(null);
      return;
    }
    setSelectedFile((current) =>
      current && detail.files.some((file) => file.path === current) ? current : detail.files[0]?.path ?? null,
    );
  }, [detail]);

  useEffect(() => () => {
    if (searchTimer.current !== null) window.clearTimeout(searchTimer.current);
  }, []);

  const diffByFile = useMemo(() => (detail ? splitCommitDiff(detail.diff) : new Map<string, string>()), [detail]);
  const fileDiff = detail && selectedFile ? diffByFile.get(selectedFile) ?? "" : "";

  const itemsRef = useRef<HTMLDivElement>(null);

  /** 定位 HEAD:必要时清空搜索并选中 HEAD 提交。 */
  const locateHead = () => {
    if (api.searchResult) api.clearSearch();
    const target = commits.find((commit) => commit.refs.some((ref) => ref.kind === "head")) ?? commits[0] ?? null;
    if (!target) {
      api.refreshGraph();
      return;
    }
    api.selectCommit(target.sha);
    setMobileDetail(true);
    window.requestAnimationFrame(() => {
      itemsRef.current?.querySelector<HTMLElement>(`[data-sha="${target.sha}"]`)?.scrollIntoView({ block: "center" });
    });
  };

  const copy = async (label: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      window.setTimeout(() => setCopied(null), 1500);
    } catch {
      setNotice(tr("复制失败", "Could not copy"));
    }
  };

  const openFile = async (path: string) => {
    const apiWindow = window.vela;
    if (!apiWindow) return;
    try {
      const content = await apiWindow.readWorkspaceFile(path);
      if (content.kind === "missing") {
        setNotice(tr("该文件在当前工作区不存在，未打开历史版本。", "This file does not exist in the workspace; the historical version was not opened."));
        return;
      }
      onOpenFile(`${repoRoot}/${path}`);
    } catch {
      setNotice(tr("无法打开该文件", "Could not open this file"));
    }
  };

  return (
    <div className={`vc-history${mobileDetail ? " show-detail" : ""}`}>
      <div className="vc-history-list">
        <div className="vc-history-tools">
          <select
            className="vc-select"
            aria-label={tr("历史范围", "History scope")}
            value={api.graphScope}
            onChange={(event) => api.setGraphScope(event.target.value === "all-local" ? "all-local" : "current")}
          >
            <option value="current">{tr("当前分支", "Current branch")}</option>
            <option value="all-local">{tr("全部本地分支", "All local branches")}</option>
          </select>
          <label className="vc-search">
            <SearchIcon size={12} />
            <input
              aria-label={tr("搜索提交、SHA 或作者", "Search commits, SHA or author")}
              placeholder={tr("搜索提交、SHA 或作者", "Search commits, SHA or author")}
              value={searchInput}
              onChange={(event) => {
                const value = event.target.value;
                setSearchInput(value);
                if (searchTimer.current !== null) window.clearTimeout(searchTimer.current);
                searchTimer.current = window.setTimeout(() => api.runSearch(value), 300);
              }}
            />
          </label>
          <button type="button" className="vc-icon-btn" title={tr("刷新历史", "Refresh history")} aria-label={tr("刷新历史", "Refresh history")} onClick={api.refreshGraph}>
            <RefreshIcon size={13} />
          </button>
          <button type="button" className="vc-icon-btn" title={tr("定位 HEAD", "Locate HEAD")} aria-label={tr("定位 HEAD", "Locate HEAD")} onClick={locateHead}>
            <CommitIcon size={13} />
          </button>
          <button
            type="button"
            className="vc-btn vc-btn-ghost"
            title={tr("比较两个分支或提交", "Compare two branches or commits")}
            onClick={() => onCompare(api.selectedSha ?? commits[0]?.sha ?? "HEAD", "HEAD")}
          >
            {tr("比较", "Compare")}
          </button>
          <button
            type="button"
            className="vc-btn vc-btn-ghost"
            title={tr("从 Reflog 找回被移动或重写的提交", "Recover moved or rewritten commits from the reflog")}
            onClick={onOpenReflog}
          >
            {tr("恢复", "Recover")}
          </button>
          <div className="vc-diff-options" role="group" aria-label={tr("差异显示方式", "Diff display options")}>
            <button type="button" className={`vc-chip${api.diffMode === "unified" ? " active" : ""}`} aria-pressed={api.diffMode === "unified"} onClick={() => api.setDiffMode("unified")}>{tr("统一", "Unified")}</button>
            <button type="button" className={`vc-chip${api.diffMode === "split" ? " active" : ""}`} aria-pressed={api.diffMode === "split"} onClick={() => api.setDiffMode("split")}>{tr("并排", "Split")}</button>
            <label className="vc-chip vc-chip-check">
              <input type="checkbox" checked={api.ignoreWhitespace} onChange={(event) => api.setIgnoreWhitespace(event.target.checked)} />
              {tr("忽略空白", "Ignore whitespace")}
            </label>
          </div>
          <button
            type="button"
            className="vc-icon-btn vc-mobile-detail-btn"
            title={tr("查看提交详情", "View commit detail")}
            aria-label={tr("查看提交详情", "View commit detail")}
            aria-pressed={mobileDetail}
            onClick={() => setMobileDetail((value) => !value)}
          >
            <CommitIcon size={13} />
          </button>
        </div>

        {api.searchResult ? (
          <div className="vc-search-note" role="status">
            <span>{trf("搜索到 {0} 条提交 · 结果列表不代表完整拓扑图", "{0} commits found · this list is not the full graph", api.searchResult.commits.length)}</span>
            <button type="button" className="vc-link" onClick={() => { setSearchInput(""); api.clearSearch(); }}>
              {tr("返回完整历史", "Back to full history")}
            </button>
          </div>
        ) : null}

        <div className="vc-history-items" role="list" ref={itemsRef}>
          {api.searchLoading ? <div className="vc-state">{tr("正在搜索…", "Searching…")}</div> : null}
          {!api.searchLoading && api.graphError ? (
            <div className="vc-state vc-state-error" role="alert">
              <AlertIcon size={13} />
              <span>{api.graphError}</span>
              <button type="button" className="vc-link" onClick={api.refreshGraph}>{tr("重试", "Retry")}</button>
            </div>
          ) : null}
          {!api.searchLoading && !api.graphError && commits.length === 0 ? (
            <div className="vc-state">{api.graph === null && api.graphLoading ? tr("正在读取历史…", "Loading history…") : tr("没有可显示的提交", "No commits to show")}</div>
          ) : null}
          {commits.length > 0 ? (
            <div className="vc-history-rows" style={{ paddingLeft: geometry.width }}>
              <CommitGraph commits={commits} geometry={geometry} selectedSha={api.selectedSha} />
              {commits.map((commit) => (
                <CommitRow
                  key={commit.sha}
                  commit={commit}
                  selected={commit.sha === api.selectedSha}
                  upstream={upstream}
                  locale={locale}
                  onSelect={() => {
                    api.selectCommit(commit.sha);
                    setMobileDetail(true);
                  }}
                />
              ))}
            </div>
          ) : null}
        </div>

        <div className="vc-history-foot">
          <span>
            {trf("已加载 {0} 条提交", "{0} commits loaded", commits.length)}
            {api.graph?.pendingParents.length ? ` · ${tr("仍有父提交未加载", "more parents available")}` : ""}
            {api.graph?.shallowBoundary.length ? ` · ${tr("浅克隆历史边界", "shallow clone boundary")}` : ""}
          </span>
          {!api.searchResult && api.graph?.hasMore ? (
            <button type="button" className="vc-btn vc-btn-ghost" disabled={api.graphLoading} onClick={api.loadMoreGraph}>
              {api.graphLoading ? tr("加载中…", "Loading…") : tr("加载更多", "Load more")}
            </button>
          ) : null}
        </div>
      </div>

      <div className="vc-commit-detail">
        {api.detailLoading && !detail ? <div className="vc-state">{tr("正在读取提交…", "Loading commit…")}</div> : null}
        {api.detailError ? (
          <div className="vc-state vc-state-error" role="alert">
            <AlertIcon size={13} />
            <span>{api.detailError}</span>
            <button type="button" className="vc-link" onClick={() => api.selectCommit(api.selectedSha)}>{tr("重试", "Retry")}</button>
          </div>
        ) : null}
        {!detail && !api.detailLoading && !api.detailError ? (
          <div className="vc-state">{tr("选择一个提交查看详情", "Select a commit to view details")}</div>
        ) : null}
        {detail ? <CommitDetailPane
          detail={detail}
          selectedFile={selectedFile}
          onSelectFile={setSelectedFile}
          fileDiff={fileDiff}
          copied={copied}
          notice={notice}
          onCopySha={() => void copy("sha", detail.commit.sha)}
          onCopyMessage={() => void copy("message", [detail.commit.subject, detail.body].filter(Boolean).join("\n\n"))}
          onOpenFile={(path) => void openFile(path)}
          onSelectParent={(parent) => api.setDetailParent(parent)}
          onCompareWith={(sha) => onCompare(sha, "HEAD")}
          onOpenHistoryOps={onOpenHistoryOps}
          diffMode={api.diffMode}
          locale={locale}
        /> : null}
      </div>
    </div>
  );
}

function CommitDetailPane({
  detail,
  selectedFile,
  onSelectFile,
  fileDiff,
  copied,
  notice,
  onCopySha,
  onCopyMessage,
  onOpenFile,
  onSelectParent,
  onCompareWith,
  onOpenHistoryOps,
  diffMode,
  locale,
}: {
  detail: GitCommitDetail;
  selectedFile: string | null;
  onSelectFile(path: string): void;
  fileDiff: string;
  copied: string | null;
  notice: string | null;
  onCopySha(): void;
  onCopyMessage(): void;
  onOpenFile(path: string): void;
  onSelectParent(parent: string | null): void;
  onCompareWith(sha: string): void;
  onOpenHistoryOps(commit: GitCommitSummary): void;
  diffMode: "unified" | "split";
  locale: AppLocale;
}) {
  const commit = detail.commit;
  return (
    <div className="vc-detail-scroll">
      <div className="vc-detail-head">
        <div className="vc-overline">{tr("提交详情", "Commit detail")} · <code className="vc-sha">{commit.shortSha}</code></div>
        <h2>{commit.subject}</h2>
        {detail.body ? <pre className="vc-detail-message">{detail.body}</pre> : null}
        <div className="vc-detail-meta">
          <span>{tr("作者", "Author")} <b>{commit.authorName}</b> &lt;{commit.authorEmail}&gt;</span>
          <span>{tr("提交者", "Committer")} <b>{commit.committerName}</b></span>
          <span>{tr("提交时间", "Committed")} <b>{formatAbsoluteTime(commit.committerAt, locale)}</b></span>
          <span>{tr("父提交", "Parents")} <b>{detail.parents.length > 0 ? detail.parents.map((parent) => parent.slice(0, 7)).join(", ") : tr("无（根提交）", "None (root)")}</b></span>
          <span className="vc-detail-refs">{tr("引用", "Refs")} <RefBadges refs={commit.refs} limit={5} /></span>
        </div>
        {detail.parents.length > 1 ? (
          <div className="vc-parent-switch" role="group" aria-label={tr("选择对比父提交", "Compare against parent")}>
            <span>{tr("对比父提交", "Compare with")}</span>
            {detail.parents.map((parent) => (
              <button
                key={parent}
                type="button"
                className={`vc-chip${detail.parentSha === parent ? " active" : ""}`}
                onClick={() => onSelectParent(parent)}
              >
                {parent.slice(0, 7)}
              </button>
            ))}
          </div>
        ) : detail.isRoot ? (
          <div className="vc-detail-note">{tr("根提交相对空树展示全部内容。", "The root commit is shown against the empty tree.")}</div>
        ) : null}
        <div className="vc-detail-actions">
          <button
            type="button"
            className="vc-btn vc-btn-primary"
            title={tr("撤销该提交、拣选到当前分支、整理历史或从该提交创建分支", "Revert, cherry-pick, rewrite history or branch from this commit")}
            onClick={() => onOpenHistoryOps(commit)}
          >
            <CommitIcon size={12} /> {tr("历史操作", "History actions")}
          </button>
          <button type="button" className="vc-btn" onClick={onCopySha}>{copied === "sha" ? <CheckIcon size={12} /> : <CopyIcon size={12} />}{tr("复制 SHA", "Copy SHA")}</button>
          <button type="button" className="vc-btn" onClick={onCopyMessage}>{copied === "message" ? <CheckIcon size={12} /> : <CopyIcon size={12} />}{tr("复制 Message", "Copy message")}</button>
          <button
            type="button"
            className="vc-btn"
            title={tr("以该提交为 base 与 HEAD 比较", "Compare this commit (base) with HEAD")}
            onClick={() => onCompareWith(commit.sha)}
          >
            {tr("以该提交为 base 比较", "Compare from this commit")}
          </button>
        </div>
        {notice ? <div className="vc-inline-notice" role="status">{notice}</div> : null}
      </div>

      <div className="vc-changed-title">
        <span>{trf("变更文件 {0}", "{0} changed files", detail.files.length)}</span>
        <span className="vc-stats">
          <b className="vc-plus">+{detail.files.reduce((sum, file) => sum + file.addedLines, 0)}</b>
          <b className="vc-minus">−{detail.files.reduce((sum, file) => sum + file.deletedLines, 0)}</b>
        </span>
      </div>
      <div className="vc-changed-files">
        {detail.files.map((file) => (
          <div
            key={file.path}
            className={`vc-changed-file${file.path === selectedFile ? " selected" : ""}`}
            role="button"
            tabIndex={0}
            onClick={() => onSelectFile(file.path)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelectFile(file.path);
              }
            }}
          >
            <span className={`vc-status vc-status-${file.status}`}>{file.status.slice(0, 1).toUpperCase()}</span>
            <span className="vc-changed-path" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>
              {file.oldPath && file.status === "renamed" ? `${file.oldPath} → ${file.path}` : file.path}
            </span>
            <span className="vc-stats"><b className="vc-plus">+{file.addedLines}</b> <b className="vc-minus">−{file.deletedLines}</b></span>
            <button
              type="button"
              className="vc-icon-btn"
              title={tr("打开当前文件", "Open current file")}
              aria-label={`${tr("打开", "Open")} ${file.path}`}
              onClick={(event) => {
                event.stopPropagation();
                onOpenFile(file.path);
              }}
            >
              <ExternalIcon size={12} />
            </button>
          </div>
        ))}
      </div>

      <div className="vc-changed-title vc-diff-title">
        <span>{selectedFile ?? tr("差异", "Diff")}</span>
        <span className="vc-detail-note">{tr("相对选定父提交", "Against the selected parent")}</span>
      </div>
      <div className="vc-detail-diff">
        {fileDiff ? <DiffPane key={`${commit.sha}:${selectedFile}:${detail.parentSha ?? ""}`} path={selectedFile ?? ""} diff={fileDiff} mode={diffMode} /> : (
          <div className="vc-state">{tr("没有可显示的差异", "No diff to display")}</div>
        )}
      </div>
    </div>
  );
}
