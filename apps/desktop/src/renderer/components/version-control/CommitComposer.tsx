import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppLocale, ConversationGoal, GitPushInput, GitStatusSnapshot } from "@vela/shared";
import { tr, trf } from "../../locale";
import type { VersionControlApi } from "../../hooks/useVersionControl";
import { AlertIcon, SparkIcon } from "../icons";
import { AiAssist } from "./AiAssist";
import { buildCommitSnapshot, useAiText, verificationNotesFromGoal, commitSnapshotKey } from "./ai-text";
import { clearCommitDraft, commitDraftKey, readCommitDraft, writeCommitDraft } from "./git-drafts";
import { PushDialog } from "./PushDialog";
import type { ChangeGroupRow } from "./git-change-groups";

/**
 * Commit 编辑区:只提交索引内容;「全部暂存并提交」先展示范围再执行。
 * 草稿按工作树 + 分支保存,Detached HEAD 按提交保存。
 */
export function CommitComposer({
  api,
  status,
  stagedRows,
  unstagedRows,
  goal,
  locale,
  workspace,
  onCommitted,
  onOpenHistory,
}: {
  api: VersionControlApi;
  status: GitStatusSnapshot;
  stagedRows: ChangeGroupRow[];
  unstagedRows: ChangeGroupRow[];
  goal: ConversationGoal | null;
  locale: AppLocale;
  workspace: string | null;
  onCommitted(sha: string): void;
  onOpenHistory(): void;
}) {
  const repoRoot = status.repo?.root ?? null;
  const branch = status.branch;
  const head = api.graph?.commits[0]?.sha ?? null;
  const draftKey = useMemo(
    () => commitDraftKey(workspace, branch, status.detached ? head : null),
    [workspace, branch, status.detached, head],
  );
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [aiStyle, setAiStyle] = useState<"plain" | "conventional">("plain");
  const [recentTitles, setRecentTitles] = useState<string[]>([]);
  const [result, setResult] = useState<{ kind: "ok" | "fail"; sha?: string; message: string; output: string; retryPush?: boolean } | null>(null);
  const [pushOpen, setPushOpen] = useState(false);
  const [stageAllOpen, setStageAllOpen] = useState(false);
  const [identityOpen, setIdentityOpen] = useState(false);
  const [identityName, setIdentityName] = useState("");
  const [identityEmail, setIdentityEmail] = useState("");
  const [identityError, setIdentityError] = useState<string | null>(null);
  const [showOutput, setShowOutput] = useState(false);
  const [amend, setAmend] = useState(false);
  const [amendTarget, setAmendTarget] = useState<{ sha: string; shortSha: string; subject: string; pushed: boolean | null } | null>(null);
  const [undoOpen, setUndoOpen] = useState(false);
  const [undoMode, setUndoMode] = useState<"keep-index" | "keep-worktree">("keep-worktree");
  const [undoResult, setUndoResult] = useState<string | null>(null);
  const ai = useAiText();

  const titleRef = useRef(title);
  const bodyRef = useRef(body);
  titleRef.current = title;
  bodyRef.current = body;
  const draftLoadedKey = useRef<string | null>(null);

  // 草稿按目标读取;切换分支/工作树后恢复对应草稿,不覆盖其他目标。
  useEffect(() => {
    if (draftLoadedKey.current === draftKey) return;
    draftLoadedKey.current = draftKey;
    const draft = readCommitDraft(draftKey);
    setTitle(draft?.title ?? "");
    setBody(draft?.body ?? "");
    setResult(null);
  }, [draftKey]);

  useEffect(() => {
    if (draftLoadedKey.current !== draftKey) return;
    const timer = window.setTimeout(() => {
      if (title.trim() || body.trim()) writeCommitDraft(draftKey, { title, body });
      else clearCommitDraft(draftKey);
    }, 400);
    return () => window.clearTimeout(timer);
  }, [draftKey, title, body]);

  useEffect(() => {
    const apiWindow = window.vela;
    if (!apiWindow || !repoRoot) return;
    void apiWindow
      .getCommitGraph({ scope: "current", skip: 0, limit: 8 })
      .then((slice) => setRecentTitles(slice.commits.map((commit) => commit.subject)))
      .catch(() => setRecentTitles([]));
  }, [repoRoot, head]);

  /** Amend 前读取被修正提交的完整信息,并明确它是否已经推送。 */
  useEffect(() => {
    if (!amend) {
      setAmendTarget(null);
      return;
    }
    const apiWindow = window.vela;
    if (!apiWindow || !head) {
      setAmend(false);
      return;
    }
    let active = true;
    void apiWindow
      .getCommitDetail(head, null)
      .then((detail) => {
        if (!active) return;
        setAmendTarget({
          sha: detail.commit.sha,
          shortSha: detail.commit.shortSha,
          subject: detail.commit.subject,
          pushed: detail.commit.pushed,
        });
        // 用被修正提交的内容预填,便于直接修改后再修正。
        if (!titleRef.current && !bodyRef.current) {
          setTitle(detail.commit.subject);
          setBody(detail.body);
        }
      })
      .catch(() => {
        if (active) setAmend(false);
      });
    return () => {
      active = false;
    };
    // 只在开启 Amend 时读取一次;后续编辑不覆盖用户输入。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amend, head]);

  const canUndo = !status.detached && status.branch !== null && (status.ahead > 0 || status.upstream === null);
  const runUndo = async () => {
    setUndoResult(null);
    const result = await api.undoCommit(undoMode);
    if (!result) return;
    if (result.ok) {
      setUndoOpen(false);
      setResult({
        kind: "ok",
        sha: result.shortSha ?? undefined,
        message: trf("已撤销提交 {0}：{1}", "Undid commit {0}: {1}", result.shortSha ?? "", result.subject ?? ""),
        output: "",
      });
      setTitle("");
      setBody("");
      clearCommitDraft(draftKey);
    } else {
      setUndoResult(result.message);
    }
  };

  const stagedPaths = useMemo(() => stagedRows.map((row) => row.file.path), [stagedRows]);
  const currentKey = commitSnapshotKey(workspace, branch, head, stagedPaths, []);
  const markStale = ai.markStale;
  useEffect(() => {
    if (ai.state.result) markStale(ai.state.result.snapshotKey !== currentKey);
  }, [currentKey, ai.state.result, markStale]);

  // 切换目标(工作树/分支/提交)后,旧目标的生成结果不得填入新表单。
  const targetKey = `${workspace ?? ""}|${branch ?? ""}|${head ?? ""}`;
  const lastTargetRef = useRef(targetKey);
  const dismissResult = ai.dismissResult;
  useEffect(() => {
    if (lastTargetRef.current === targetKey) return;
    lastTargetRef.current = targetKey;
    dismissResult();
  }, [targetKey, dismissResult]);

  const goalObjective = goal?.objective ?? null;
  const verificationNotes = verificationNotesFromGoal(goal);

  const onGenerate = useCallback(
    async (action: "generate" | "polish" | "adjust" | "regenerate", instruction?: string | null) => {
      const capturedTitle = titleRef.current;
      const capturedBody = bodyRef.current;
      const diff = await api.stagedDiff();
      const snapshot = buildCommitSnapshot({
        workspace,
        repoRoot,
        branch,
        head,
        status,
        stagedPaths,
        plannedPaths: [],
        diff,
        recentCommitTitles: recentTitles,
        taskGoal: goalObjective,
        userNote: null,
        verificationNotes,
        locale,
        style: aiStyle,
      });
      const generated = await ai.generate({
        kind: "commit",
        action,
        snapshot,
        title: capturedTitle,
        body: capturedBody,
        instruction: instruction ?? null,
      });
      if (!generated) return;
      // 用户没有改动输入时直接填入;否则保留为候选,不覆盖手写内容。
      if (titleRef.current === capturedTitle && bodyRef.current === capturedBody) {
        setTitle(generated.title);
        setBody(generated.body);
        ai.dismissResult();
      }
    },
    [api, workspace, repoRoot, branch, head, status, stagedPaths, recentTitles, goalObjective, verificationNotes, locale, aiStyle, ai],
  );

  const blocked = useMemo(() => {
    if (api.guard?.agentRunning) return tr("Agent 正在这个工作树执行，暂不能提交。", "The agent is running in this worktree; commit is paused.");
    if (status.detached) return tr("Detached HEAD 状态，首期不开放普通提交。请先创建或切换分支。", "Detached HEAD: regular commits are unavailable. Create or switch to a branch first.");
    if (status.operation) return tr("仓库里有进行中的操作，请先处理冲突或在终端完成/中止。", "A Git operation is in progress. Resolve it or finish/abort it in a terminal first.");
    if (!status.identity.configured) return tr("需要配置 Git 作者姓名和邮箱。", "Set the Git author name and email first.");
    // Amend 允许只改提交说明;普通提交必须有索引内容。
    if (!amend && stagedRows.length === 0) return tr("暂存区为空，先暂存要提交的文件。", "Nothing is staged yet; stage the files to commit first.");
    if (amend && !head) return tr("当前分支还没有可修正的提交。", "There is no commit to amend on this branch.");
    return null;
  }, [api.guard?.agentRunning, status.detached, status.operation, status.identity.configured, stagedRows.length, amend, head]);

  const stats = useMemo(
    () => stagedRows.reduce(
      (sum, row) => ({ added: sum.added + row.file.indexAddedLines, deleted: sum.deleted + row.file.indexDeletedLines }),
      { added: 0, deleted: 0 },
    ),
    [stagedRows],
  );

  const runCommit = async (withPush: boolean) => {
    const input = { title: title.trim(), body, stagePaths: null, amend };
    if (!input.title) return;
    setResult(null);
    if (withPush) {
      if (!status.upstream && status.remotes.length > 0) {
        setPushOpen(true);
        return;
      }
      const target: GitPushInput | null = status.upstream && status.remotes.length > 0
        ? splitUpstream(status.upstream, status.remotes.map((remote) => remote.name))
        : null;
      if (!target) {
        setResult({ kind: "fail", message: tr("没有可用的远程，无法推送。", "No remote is available to push to."), output: "" });
        return;
      }
      const outcome = await api.commitAndPush(input, target);
      if (outcome?.commit.ok) {
        clearCommitDraft(draftKey);
        setTitle("");
        setBody("");
        setAmend(false);
        setResult({
          kind: outcome.push?.ok === false ? "fail" : "ok",
          sha: outcome.commit.shortSha ?? undefined,
          message: outcome.push?.ok === false
            ? trf("提交成功，推送失败：{0}", "Committed, push failed: {0}", outcome.push.message)
            : trf("已提交并推送 {0}", "Committed and pushed {0}", outcome.commit.shortSha ?? ""),
          output: outcome.push?.message ?? "",
          retryPush: outcome.push?.ok === false,
        });
        onCommitted(outcome.commit.sha ?? "");
      } else if (outcome) {
        setResult({ kind: "fail", message: outcome.commit.message || tr("提交失败", "Commit failed"), output: outcome.commit.output });
      }
      return;
    }
    const committed = await api.commit(input);
    if (!committed) return;
    if (committed.ok) {
      clearCommitDraft(draftKey);
      setTitle("");
      setBody("");
      setAmend(false);
      setResult({
        kind: "ok",
        sha: committed.shortSha ?? undefined,
        message: committed.amendedSha
          ? trf("已修正提交 {0}", "Amended {0}", committed.shortSha ?? "")
          : trf("已提交 {0}", "Committed {0}", committed.shortSha ?? ""),
        output: committed.output,
      });
      onCommitted(committed.sha ?? "");
    } else {
      // Hook 改变文件或索引后失败,保留草稿并刷新真实状态。
      setResult({ kind: "fail", message: committed.message || tr("提交失败", "Commit failed"), output: committed.output });
    }
  };

  const saveIdentity = async () => {
    const apiWindow = window.vela;
    if (!apiWindow) return;
    setIdentityError(null);
    try {
      await apiWindow.setGitIdentity(identityName.trim(), identityEmail.trim());
      setIdentityOpen(false);
    } catch (caught) {
      setIdentityError(caught instanceof Error ? caught.message : tr("保存失败", "Could not save"));
    }
  };

  const disabled = blocked !== null || api.busy !== null || ai.state.running;

  return (
    <div className="vc-composer">
      <div className="vc-composer-meta">
        <SparkIcon size={13} />
        <b>{tr("提交已暂存改动", "Commit staged changes")}</b>
        <span>{trf("{0} 个文件", "{0} files", stagedRows.length)}</span>
        <span className="vc-stats"><b className="vc-plus">+{stats.added}</b> <b className="vc-minus">−{stats.deleted}</b></span>
        <span className="vc-composer-author">
          {status.identity.configured
            ? `${status.identity.name} <${status.identity.email}>`
            : (
              <button type="button" className="vc-link" onClick={() => setIdentityOpen((value) => !value)}>
                {tr("配置作者身份", "Set author identity")}
              </button>
            )}
        </span>
      </div>

      {identityOpen ? (
        <div className="vc-identity-form">
          <input
            className="vc-input"
            placeholder={tr("姓名", "Name")}
            aria-label={tr("Git 作者姓名", "Git author name")}
            value={identityName}
            onChange={(event) => setIdentityName(event.target.value)}
          />
          <input
            className="vc-input"
            placeholder={tr("邮箱", "Email")}
            aria-label={tr("Git 作者邮箱", "Git author email")}
            value={identityEmail}
            onChange={(event) => setIdentityEmail(event.target.value)}
          />
          <button type="button" className="vc-btn vc-btn-primary" onClick={() => void saveIdentity()}>
            {tr("保存到本仓库", "Save for this repository")}
          </button>
          <span className="vc-hint">{tr("只写入仓库级配置，不修改全局 Git 配置。", "Writes repository config only; global Git config is untouched.")}</span>
          {identityError ? <span className="vc-ai-error">{identityError}</span> : null}
        </div>
      ) : null}

      <div className="vc-composer-entry">
        <div className="vc-composer-fields">
          <input
            className="vc-input vc-commit-title"
            aria-label={tr("Commit 标题", "Commit title")}
            placeholder={tr("标题（必填）", "Title (required)")}
            value={title}
            disabled={status.detached || Boolean(status.operation)}
            onChange={(event) => setTitle(event.target.value)}
          />
          <textarea
            className="vc-input vc-commit-body"
            aria-label={tr("Commit 描述", "Commit body")}
            placeholder={tr("描述（可选）", "Description (optional)")}
            value={body}
            disabled={status.detached || Boolean(status.operation)}
            onChange={(event) => setBody(event.target.value)}
          />
        </div>
        <AiAssist
          state={ai.state}
          disabled={stagedRows.length === 0 || status.detached || Boolean(status.operation)}
          hint={trf("依据已暂存的 {0} 个文件 · 结果可编辑", "Based on {0} staged files · editable", stagedRows.length)}
          hasText={Boolean(title.trim() || body.trim())}
          onGenerate={(action, instruction) => void onGenerate(action, instruction)}
          onApply={(generated) => {
            setTitle(generated.title);
            setBody(generated.body);
            ai.dismissResult();
          }}
          onDismiss={ai.dismissResult}
          onCancel={ai.cancel}
        />
      </div>

      <div className="vc-composer-style">
        <label>
          <input type="checkbox" checked={aiStyle === "conventional"} onChange={(event) => setAiStyle(event.target.checked ? "conventional" : "plain")} />
          {tr("使用 Conventional Commits 标题", "Conventional Commits title")}
        </label>
        <label>
          <input
            type="checkbox"
            checked={amend}
            disabled={!head || status.detached || Boolean(status.operation)}
            onChange={(event) => setAmend(event.target.checked)}
          />
          {tr("修正最近提交（Amend）", "Amend the last commit")}
        </label>
        {canUndo ? (
          <button type="button" className="vc-link" onClick={() => { setUndoOpen((value) => !value); setUndoResult(null); }}>
            {tr("撤销最近提交…", "Undo last commit…")}
          </button>
        ) : null}
      </div>

      {amend ? (
        <div className="vc-amend-note" role="status">
          {amendTarget ? (
            <>
              <span>{tr("将修正 ", "Amending ")}<code>{amendTarget.shortSha}</code> {amendTarget.subject}</span>
              {amendTarget.pushed === true || (status.upstream !== null && status.ahead === 0) ? (
                <b className="vc-warn-text">
                  {tr("该提交已推送到远程；修正后需要另行同步（不会自动强推）。", "This commit is already pushed; syncing afterwards is a separate step (no force-push is performed).")}
                </b>
              ) : (
                <span className="vc-hint">{tr("该提交尚未推送，修正后可直接推送。", "Not pushed yet; you can push after amending.")}</span>
              )}
            </>
          ) : (
            <span className="vc-hint">{tr("正在读取最近提交…", "Reading the last commit…")}</span>
          )}
        </div>
      ) : null}

      {undoOpen ? (
        <div className="vc-undo-panel">
          <div className="vc-stage-all-head">
            <b>{tr("撤销最近一次未推送的提交", "Undo the last unpushed commit")}</b>
            <span>{tr("提交内容不会丢失，按所选位置保留。", "Nothing is lost; changes are kept in the selected place.")}</span>
          </div>
          <label className="vc-radio">
            <input type="radio" name="vc-undo-mode" checked={undoMode === "keep-index"} onChange={() => setUndoMode("keep-index")} />
            {tr("保留在索引（已暂存）", "Keep in the index (staged)")}
          </label>
          <label className="vc-radio">
            <input type="radio" name="vc-undo-mode" checked={undoMode === "keep-worktree"} onChange={() => setUndoMode("keep-worktree")} />
            {tr("保留在工作区（未暂存）", "Keep in the working tree (unstaged)")}
          </label>
          {undoResult ? <div className="vc-error-banner" role="alert"><AlertIcon size={12} />{undoResult}</div> : null}
          <div className="vc-dialog-actions">
            <button type="button" className="vc-btn vc-btn-ghost" onClick={() => setUndoOpen(false)}>{tr("取消", "Cancel")}</button>
            <button type="button" className="vc-btn vc-btn-danger" disabled={api.busy !== null} onClick={() => void runUndo()}>
              {tr("撤销该提交", "Undo commit")}
            </button>
          </div>
        </div>
      ) : null}

      {blocked ? <div className="vc-composer-blocked" role="status">{blocked}</div> : null}

      <div className="vc-composer-actions">
        <button
          type="button"
          className="vc-btn vc-btn-ghost"
          disabled={amend || unstagedRows.length === 0 || status.detached || Boolean(status.operation) || api.busy !== null}
          title={amend ? tr("Amend 模式下不创建新提交", "Amend does not create a new commit") : undefined}
          onClick={() => setStageAllOpen((value) => !value)}
        >
          {tr("全部暂存并提交…", "Stage all and commit…")}
        </button>
        <button
          type="button"
          className="vc-btn"
          disabled={disabled || !title.trim() || (!amend && stagedRows.length === 0)}
          onClick={() => void runCommit(true)}
        >
          {amend ? tr("修正并推送", "Amend and push") : tr("提交并推送", "Commit and push")}
        </button>
        <button
          type="button"
          className="vc-btn vc-btn-primary"
          disabled={disabled || !title.trim() || (!amend && stagedRows.length === 0)}
          onClick={() => void runCommit(false)}
        >
          {api.busy === "commit"
            ? tr("提交中…", "Committing…")
            : amend
              ? tr("修正最近提交", "Amend last commit")
              : tr("提交已暂存改动", "Commit staged changes")}
        </button>
      </div>

      {stageAllOpen ? (
        <div className="vc-stage-all">
          <div className="vc-stage-all-head">
            <b>{tr("将暂存并提交以下文件", "Files to stage and commit")}</b>
            <span>{tr("忽略文件不会被包含", "Ignored files are excluded")}</span>
          </div>
          <ul className="vc-stage-all-list">
            {unstagedRows.map((row) => (
              <li key={row.key}><code>{row.file.path}</code></li>
            ))}
            {stagedRows.map((row) => (
              <li key={row.key}><code>{row.file.path}</code> <span className="vc-hint">{tr("已暂存", "staged")}</span></li>
            ))}
          </ul>
          <div className="vc-stage-all-actions">
            <button type="button" className="vc-btn vc-btn-ghost" onClick={() => setStageAllOpen(false)}>{tr("取消", "Cancel")}</button>
            <button
              type="button"
              className="vc-btn vc-btn-primary"
              disabled={!title.trim() || api.busy !== null}
              onClick={() => {
                setStageAllOpen(false);
                void (async () => {
                  const committed = await api.commit({
                    title: title.trim(),
                    body,
                    stagePaths: unstagedRows.map((row) => row.file.path),
                  });
                  if (!committed) return;
                  if (committed.ok) {
                    clearCommitDraft(draftKey);
                    setTitle("");
                    setBody("");
                    setResult({ kind: "ok", sha: committed.shortSha ?? undefined, message: trf("已提交 {0}", "Committed {0}", committed.shortSha ?? ""), output: committed.output });
                    onCommitted(committed.sha ?? "");
                  } else {
                    setResult({ kind: "fail", message: committed.message, output: committed.output });
                  }
                })();
              }}
            >
              {tr("暂存并提交", "Stage and commit")}
            </button>
          </div>
        </div>
      ) : null}

      {result ? (
        <div className={`vc-commit-result ${result.kind}`} role="status">
          <span>{result.message}</span>
          {result.kind === "ok" ? (
            <>
              <button type="button" className="vc-link" onClick={onOpenHistory}>{tr("查看历史", "View history")}</button>
              {status.ahead > 0 ? <button type="button" className="vc-link" onClick={() => setPushOpen(true)}>{tr("继续 Push", "Push now")}</button> : null}
            </>
          ) : null}
          {result.retryPush ? (
            <button
              type="button"
              className="vc-link"
              onClick={() => {
                // 只重试 Push,不重新 Commit。
                const target = status.upstream ? splitUpstream(status.upstream, status.remotes.map((remote) => remote.name)) : null;
                if (target) void api.push(target);
                else setPushOpen(true);
              }}
            >
              {tr("只重试 Push", "Retry push only")}
            </button>
          ) : null}
          {result.output && result.kind === "fail" ? (
            <button type="button" className="vc-link" onClick={() => setShowOutput((value) => !value)}>
              {showOutput ? tr("收起输出", "Hide output") : tr("查看输出", "Show output")}
            </button>
          ) : null}
          {showOutput && result.output ? <pre className="vc-command-output">{result.output}</pre> : null}
        </div>
      ) : null}

      <PushDialog
        open={pushOpen}
        remotes={status.remotes.map((remote) => remote.name)}
        defaultBranch={branch ?? ""}
        title={tr("推送并创建提交", "Push after commit")}
        confirmLabel={tr("提交并推送", "Commit and push")}
        onClose={() => setPushOpen(false)}
        onConfirm={(target) => {
          setPushOpen(false);
          void (async () => {
            const input = { title: title.trim(), body, stagePaths: null };
            const outcome = await api.commitAndPush(input, target);
            if (outcome?.commit.ok) {
              clearCommitDraft(draftKey);
              setTitle("");
              setBody("");
              setResult({
                kind: outcome.push?.ok === false ? "fail" : "ok",
                sha: outcome.commit.shortSha ?? undefined,
                message: outcome.push?.ok === false
                  ? trf("提交成功，推送失败：{0}", "Committed, push failed: {0}", outcome.push.message)
                  : trf("已提交并推送 {0}", "Committed and pushed {0}", outcome.commit.shortSha ?? ""),
                output: outcome.push?.message ?? "",
                retryPush: outcome.push?.ok === false,
              });
              onCommitted(outcome.commit.sha ?? "");
            } else if (outcome) {
              setResult({ kind: "fail", message: outcome.commit.message, output: outcome.commit.output });
            }
          })();
        }}
      />
    </div>
  );
}

/** upstream 形如 origin/main;远程名可能本身含斜杠,按已知远程前缀匹配。 */
export function splitUpstream(upstream: string, remotes: string[]): GitPushInput | null {
  const remote = remotes
    .filter((name) => upstream.startsWith(`${name}/`))
    .sort((a, b) => b.length - a.length)[0];
  if (!remote) return null;
  return { remote, branch: upstream.slice(remote.length + 1), setUpstream: false };
}
