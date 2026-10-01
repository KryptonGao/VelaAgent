import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppLocale, ConversationGoal, GitStatusSnapshot, PrCheckDetail, PrCompareScope, PrEditOptions, PrIssueLinkMode, PrState, PrSummary, PullRequestInfo } from "@vela/shared";
import { tr } from "../../locale";
import type { VersionControlApi } from "../../hooks/useVersionControl";
import { Markdown } from "../Markdown";
import { AlertIcon, BranchIcon, CheckIcon, CloudIcon, ExternalIcon, GithubIcon, PencilIcon, PrIcon, RefreshIcon, SendIcon } from "../icons";
import { AiAssist } from "./AiAssist";
import { PrMergePanel } from "./PrMergePanel";
import { PrReviewPanel } from "./PrReviewPanel";
import { buildPrSnapshot, prSnapshotKey, useAiText, verificationNotesFromGoal } from "./ai-text";
import { clearPrDraft, prDraftKey, readPrDraft, writePrDraft } from "./git-drafts";
import { formatRelativeTime } from "./time-format";

const prStateLabels: Record<PrState, [string, string]> = {
  open: ["开放", "Open"],
  draft: ["草稿", "Draft"],
  closed: ["已关闭", "Closed"],
  merged: ["已合并", "Merged"],
};

function prStateLabel(state: PrState): string {
  const labels = prStateLabels[state];
  return tr(labels[0], labels[1]);
}

const checkStateLabels: Record<PrCheckDetail["state"], [string, string]> = {
  passing: ["通过", "Passed"],
  failing: ["失败", "Failed"],
  pending: ["等待", "Pending"],
  skipped: ["跳过", "Skipped"],
  cancelled: ["取消", "Cancelled"],
  unknown: ["未知", "Unknown"],
};

/** Pull Request 页:无 PR 时创建,有 PR 时展示详情、检查与审阅摘要。 */
export function PullRequestPage({
  api,
  status,
  goal,
  locale,
  workspace,
  onOpenConversation,
}: {
  api: VersionControlApi;
  status: GitStatusSnapshot;
  goal: ConversationGoal | null;
  locale: AppLocale;
  workspace: string | null;
  onOpenConversation(): void;
}) {
  const pr = api.pr;
  const repoSlug = pr?.repo?.baseRepo ?? null;
  const branch = status.branch;
  const [base, setBase] = useState("");
  const [baseRepo, setBaseRepo] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [scope, setScope] = useState<PrCompareScope | null>(null);
  const [scopeLoading, setScopeLoading] = useState(false);
  const [templatePath, setTemplatePath] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const [createResult, setCreateResult] = useState<string | null>(null);
  const [recentTitles, setRecentTitles] = useState<string[]>([]);
  const [aiStyle, setAiStyle] = useState<"plain" | "conventional">("plain");
  const ai = useAiText();
  const baseInitialized = useRef(false);
  const draftLoadedKey = useRef<string | null>(null);

  const headRepo = pr?.fork?.headRepo ?? repoSlug ?? "";
  const pushTarget = pr?.fork?.remotes.find((remote) => remote.remote === pr.fork?.headRemote) ?? null;
  const baseRepoOptions = useMemo(() => {
    const options = (pr?.fork?.remotes ?? [])
      .map((remote) => remote.repo)
      .filter((repo): repo is string => Boolean(repo));
    const fallback = pr?.fork?.baseRepo ?? repoSlug;
    if (fallback) options.push(fallback);
    return [...new Set(options)];
  }, [pr?.fork, repoSlug]);

  // base 仓库与 base 分支默认值;识别失败时保持为空,要求用户显式选择。
  useEffect(() => {
    if (baseInitialized.current || !pr) return;
    const nextRepo = pr.fork?.baseRepo ?? pr.repo?.baseRepo ?? null;
    if (nextRepo) setBaseRepo(nextRepo);
    const nextBase = pr.defaultBase ?? pr.baseOptions[0] ?? "main";
    if (nextBase) setBase(nextBase);
    if (nextRepo && nextBase) baseInitialized.current = true;
  }, [pr]);

  useEffect(() => {
    if (pr?.pr) api.loadTemplates();
  }, [pr?.pr, api.loadTemplates]);

  const loadScope = api.loadScope;

  const draftKey = useMemo(() => prDraftKey(workspace, branch, base || null), [workspace, branch, base]);
  useEffect(() => {
    if (!base) return;
    if (draftLoadedKey.current === draftKey) return;
    draftLoadedKey.current = draftKey;
    const draft = readPrDraft(draftKey);
    setTitle(draft?.title ?? "");
    setBody(draft?.body ?? "");
    setCreateResult(null);
  }, [draftKey, base]);

  useEffect(() => {
    if (!base || draftLoadedKey.current !== draftKey) return;
    const timer = window.setTimeout(() => {
      if (title.trim() || body.trim()) writePrDraft(draftKey, { title, body, base, draftFlag: false });
      else clearPrDraft(draftKey);
    }, 400);
    return () => window.clearTimeout(timer);
  }, [draftKey, base, title, body]);

  // 范围随 base/head 变化重新核对;创建前也会再次核对。
  useEffect(() => {
    if (!base || !branch || pr?.pr) {
      setScope(null);
      return;
    }
    let active = true;
    setScopeLoading(true);
    void loadScope(base).then((next) => {
      if (active) {
        setScope(next);
        setScopeLoading(false);
      }
    });
    return () => {
      active = false;
    };
  }, [base, branch, pr?.pr, loadScope]);

  useEffect(() => {
    if (!status.repo) return;
    void window.vela?.getCommitGraph({ scope: "current", skip: 0, limit: 8 })
      .then((slice) => setRecentTitles(slice.commits.map((commit) => commit.subject)))
      .catch(() => setRecentTitles([]));
  }, [status.repo, branch]);

  const template = useMemo(
    () => api.templates.find((entry) => entry.path === templatePath) ?? null,
    [api.templates, templatePath],
  );

  const currentKey = prSnapshotKey(workspace, branch, base || null, api.graph?.commits[0]?.sha ?? null);
  const markStale = ai.markStale;
  useEffect(() => {
    if (ai.state.result) markStale(ai.state.result.snapshotKey !== currentKey);
  }, [currentKey, ai.state.result, markStale]);

  // 切换 base/head/工作区后,旧目标的生成结果不得填入新表单。
  const targetKey = `${workspace ?? ""}|${branch ?? ""}|${base}|${api.graph?.commits[0]?.sha ?? ""}`;
  const lastTargetRef = useRef(targetKey);
  const dismissResult = ai.dismissResult;
  useEffect(() => {
    if (lastTargetRef.current === targetKey) return;
    lastTargetRef.current = targetKey;
    dismissResult();
  }, [targetKey, dismissResult]);

  const applyTemplate = useCallback(
    (path: string | null) => {
      setTemplatePath(path);
      const selected = api.templates.find((entry) => entry.path === path);
      if (selected && !body.trim()) setBody(selected.body);
    },
    [api.templates, body],
  );

  const onGenerate = useCallback(
    async (action: "generate" | "polish" | "adjust" | "regenerate", instruction?: string | null) => {
      if (!scope || !branch) return;
      const capturedTitle = title;
      const capturedBody = body;
      const snapshot = buildPrSnapshot({
        workspace,
        repoRoot: status.repo?.root ?? null,
        branch,
        head: api.graph?.commits[0]?.sha ?? null,
        base,
        scope,
        template: template?.body ?? null,
        recentCommitTitles: recentTitles,
        taskGoal: goal?.objective ?? null,
        userNote: null,
        verificationNotes: verificationNotesFromGoal(goal),
        locale,
        style: aiStyle,
      });
      const generated = await ai.generate({
        kind: "pr",
        action,
        snapshot,
        title: capturedTitle,
        body: capturedBody,
        instruction: instruction ?? null,
      });
      if (!generated) return;
      if (title === capturedTitle && body === capturedBody) {
        setTitle(generated.title);
        setBody(generated.body);
        ai.dismissResult();
      }
    },
    [scope, branch, workspace, status.repo?.root, base, template, recentTitles, goal, locale, aiStyle, title, body, ai, api.graph?.commits],
  );

  const create = async (pushFirst: boolean, draft: boolean) => {
    if (!branch || !scope || scope.empty || !title.trim()) return;
    setCreateResult(null);
    const result = await api.createPr({
      baseRepo: baseRepo || repoSlug || "",
      base,
      headRepo: headRepo || baseRepo || repoSlug || "",
      head: branch,
      title: title.trim(),
      body,
      draft,
      pushFirst,
      templatePath,
    });
    if (!result) return;
    if (result.ok) {
      clearPrDraft(draftKey);
      setCreateResult(result.message);
    } else if (result.unconfirmed) {
      setCreateResult(tr("结果待确认：请刷新查询，确认未创建后再重试。", "Result unconfirmed: refresh to check before retrying."));
    } else {
      setCreateResult(result.message);
    }
  };

  if (pr?.pr) {
    return <PrDetail
      api={api}
      pr={pr}
      status={status}
      locale={locale}
      onOpenConversation={onOpenConversation}
    />;
  }

  return (
    <div className="vc-pr">
      <header className="vc-pr-head">
        <h1>{tr("创建 Pull Request", "Create a pull request")}</h1>
        <p className="vc-pr-sub">{tr("确认目标分支与提交范围后，填写标题和描述创建。", "Confirm the target branch and commit range, then fill in the title and description.")}</p>
      </header>

      <div className="vc-pr-grid">
      <div className="vc-pr-form">
        {pr && pr.status !== "no-pr" && pr.status !== "ok" ? (
          <PrAccessNotice pr={pr} onRefresh={api.refreshPr} onOpenConversation={onOpenConversation} />
        ) : null}

        {pr && pr.otherBranchPrs.length > 0 ? (
          <div className="vc-pr-others-inline">
            <span>{tr("同分支已有已关闭或已合并的 PR，不会作为当前 PR 更新：", "This branch already has closed or merged PRs; they are not treated as the current PR:")}</span>
            {pr.otherBranchPrs.map((other) => (
              <button key={other.number} type="button" className="vc-link" onClick={() => void window.vela?.openPullRequest(other.url)}>
                #{other.number} · {prStateLabel(other.state)}
              </button>
            ))}
          </div>
        ) : null}

        <section className="vc-compare" aria-label={tr("分支方向", "Branch direction")}>
          <div className="vc-compare-side">
            <span className="vc-eyebrow">{tr("目标 · base", "Base")}</span>
            <div className="vc-compare-line">
              {baseRepoOptions.length > 1 ? (
                <select className="vc-select" aria-label={tr("目标仓库", "Base repository")} value={baseRepo} onChange={(event) => setBaseRepo(event.target.value)}>
                  {baseRepoOptions.map((option) => <option key={option} value={option}>{option}</option>)}
                </select>
              ) : (
                <span className="vc-repo-value" title={baseRepo || undefined}>{baseRepo || tr("未识别目标仓库", "Base repository unknown")}</span>
              )}
            </div>
            <div className="vc-compare-line">
              <BranchIcon size={11} />
              {pr?.baseOptions && pr.baseOptions.length > 0 ? (
                <select className="vc-select" aria-label={tr("目标分支 base", "Base branch")} value={base} onChange={(event) => setBase(event.target.value)}>
                  {pr.baseOptions.map((option) => <option key={option} value={option}>{option}</option>)}
                </select>
              ) : (
                <input
                  className="vc-select"
                  aria-label={tr("目标分支", "Base branch")}
                  placeholder={tr("输入目标分支", "Base branch")}
                  value={base}
                  onChange={(event) => setBase(event.target.value)}
                />
              )}
            </div>
          </div>
          <div className="vc-compare-swap" aria-hidden="true"><span>←</span></div>
          <div className="vc-compare-side">
            <span className="vc-eyebrow">{tr("来源 · head", "Head")}</span>
            <div className="vc-compare-line">
              <span className="vc-repo-value" title={headRepo || undefined}>{headRepo || tr("未识别来源仓库", "Head repository unknown")}</span>
            </div>
            <div className="vc-compare-line">
              <BranchIcon size={11} />
              <span className="vc-branch-value" title={branch ?? undefined}>{branch ?? "—"}</span>
            </div>
          </div>
        </section>
        {pushTarget ? (
          <p className="vc-compare-note">
            <CloudIcon size={11} />
            {tr(`推送只发生在 ${pushTarget.remote}（${pushTarget.repo ?? "非 GitHub"}）`, `Pushes only go to ${pushTarget.remote} (${pushTarget.repo ?? "not GitHub"})`)}
          </p>
        ) : null}

        {pr?.fork?.isFork ? (
          <div className="vc-pr-fork-note" role="status">
            <span className="vc-badge vc-badge-pending">{tr("Fork 工作流", "Fork workflow")}</span>
            <span>
              {tr(
                `来源是你 fork 的 ${headRepo}，目标是 ${baseRepo}；推送只发生在 ${pushTarget?.remote ?? "来源远程"}。`,
                `Head is your fork ${headRepo}, base is ${baseRepo}; pushes only go to ${pushTarget?.remote ?? "the head remote"}.`,
              )}
            </span>
          </div>
        ) : null}

        <label className="vc-field-label" htmlFor="vc-pr-title">{tr("标题", "Title")} <small>{tr("必填", "required")}</small></label>
        <input
          id="vc-pr-title"
          className="vc-input vc-pr-title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder={tr("Pull Request 标题", "Pull request title")}
        />

        <label className="vc-field-label" htmlFor="vc-pr-body">{tr("描述", "Description")} <small>{tr("Markdown · 可编辑", "Markdown · editable")}</small></label>
        <div className="vc-description-wrap">
          <div className="vc-md-bar">
            <span className="vc-hint">{template ? tr(`模板：${template.name}`, `Template: ${template.name}`) : ""}</span>
            <button type="button" className="vc-btn vc-btn-ghost" aria-pressed={preview} onClick={() => setPreview((value) => !value)}>
              {preview ? tr("编辑", "Edit") : tr("预览", "Preview")}
            </button>
          </div>
          {preview ? (
            <div className="vc-description-preview">
              {body.trim() ? <Markdown text={body} /> : <span className="vc-hint">{tr("暂无内容", "Nothing to preview")}</span>}
            </div>
          ) : (
            <textarea
              id="vc-pr-body"
              className="vc-input vc-description"
              value={body}
              onChange={(event) => setBody(event.target.value)}
              placeholder={tr("描述这个 PR 的改动、验证与注意事项", "Describe the change, validation and notes")}
            />
          )}
        </div>

        <div className="vc-pr-toolbar">
          {api.templates.length > 0 ? (
            <label className="vc-template-select">
              <span>{tr("模板", "Template")}</span>
              <select
                className="vc-select"
                value={templatePath ?? ""}
                onChange={(event) => applyTemplate(event.target.value || null)}
              >
                <option value="">{tr("不使用模板", "No template")}</option>
                {api.templates.map((entry) => <option key={entry.path} value={entry.path}>{entry.name}</option>)}
              </select>
            </label>
          ) : null}
          <label className="vc-draft-toggle" title={tr("只影响 AI 生成的标题风格", "Affects AI-generated titles only")}>
            <input type="checkbox" checked={aiStyle === "conventional"} onChange={(event) => setAiStyle(event.target.checked ? "conventional" : "plain")} />
            {tr("AI 标题用 Conventional Commits", "Conventional Commits for AI titles")}
          </label>
          <AiAssist
            compact
            state={ai.state}
            disabled={!scope || scope.empty}
            hint={scope && !scope.empty ? tr(`依据 ${branch} → ${base} 的 ${scope.commits.length} 个提交`, `${scope.commits.length} commits from ${branch} to ${base}`) : tr("没有可比对的提交", "No commits to compare")}
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

        {createResult ? <div className="vc-commit-result" role="status">{createResult}</div> : null}

        <div className="vc-pr-actions">
          <span className="vc-pr-foot-note">
            {!baseRepo
              ? tr("识别不到目标仓库；请先选择仓库或配置远程。", "Base repository unknown; pick a repository or configure a remote first.")
              : !scope || scope.empty
                ? tr("没有可提交的差异，无法创建 PR。", "No commits to create a pull request from.")
                : !title.trim()
                  ? tr("填写标题后即可创建。", "Add a title to create the pull request.")
                  : scope.unpushedCount > 0
                    ? tr(`创建时会先把 ${scope.unpushedCount} 个未推送提交推送到 ${scope.pushTarget?.remote ?? "远程"}再创建。`, `${scope.unpushedCount} unpushed commits will be pushed to ${scope.pushTarget?.remote ?? "the remote"} first.`)
                    : tr("创建前会再次核对 base、head 与提交范围。", "Base, head and the commit range are re-checked before creation.")}
          </span>
          <button
            type="button"
            className="vc-btn"
            disabled={!scope || scope.empty || !baseRepo || api.busy !== null}
            onClick={() => void create(scope ? scope.unpushedCount > 0 : false, true)}
          >
            {scope && scope.unpushedCount > 0 ? tr("推送并创建草稿 PR", "Push and create draft PR") : tr("创建草稿 PR", "Create draft PR")}
          </button>
          <button
            type="button"
            className="vc-btn vc-btn-primary"
            disabled={!scope || scope.empty || !baseRepo || api.busy !== null || !title.trim()}
            onClick={() => void create(scope ? scope.unpushedCount > 0 : false, false)}
          >
            {scope && scope.unpushedCount > 0 ? tr("推送并创建 PR", "Push and create PR") : tr("创建 Pull Request", "Create pull request")}
          </button>
        </div>
      </div>

      <aside className="vc-pr-scope" aria-label={tr("变更范围", "Change range")}>
        <div className="vc-scope-head">
          <b>{tr("变更范围", "Change range")}</b>
          <button type="button" className="vc-link" disabled={scopeLoading || !base} onClick={() => base && void api.loadScope(base).then(setScope)}>
            <RefreshIcon size={11} /> {tr("重新核对", "Re-check")}
          </button>
        </div>
        {scopeLoading ? <div className="vc-state">{tr("正在核对范围…", "Checking the range…")}</div> : null}
        {!scopeLoading && scope?.error ? <div className="vc-scope-message error" role="alert"><AlertIcon size={12} /><span>{scope.error}</span></div> : null}
        {!scopeLoading && scope && !scope.error ? (
          <>
            {scope.empty ? (
              <div className="vc-scope-message warn" role="status">
                <AlertIcon size={12} />
                <span>
                  <b>{tr("没有可创建的提交", "Nothing to create")}</b>
                  {tr(`当前分支与 ${base || "base"} 没有差异；先提交并推送改动后再回来。`, `No difference between this branch and ${base || "base"}; commit and push first.`)}
                </span>
              </div>
            ) : null}
            <div className="vc-scope-metrics">
              <div><b>{scope.commits.length}</b><small>{tr("提交", "Commits")}</small></div>
              <div><b>{scope.fileCount}</b><small>{tr("文件", "Files")}</small></div>
              <div>
                <b><span className="vc-plus">+{scope.addedLines}</span><span className="vc-minus">−{scope.deletedLines}</span></b>
                <small>{tr("行变化", "Lines")}</small>
              </div>
            </div>
            {scope.commits.length > 0 ? (
              <div className="vc-scope-block">
                <div className="vc-scope-label">
                  <span>{tr("提交", "Commits")}</span>
                  <em>{tr(`${branch ?? "head"} → ${base || "base"}`, `${branch ?? "head"} → ${base || "base"}`)}</em>
                </div>
                <div className="vc-scope-commits">
                  {scope.commits.slice(0, 30).map((commit) => (
                    <div key={commit.sha} className="vc-scope-commit">
                      <span className="vc-scope-dot" aria-hidden="true" />
                      <span className="vc-scope-msg" title={commit.subject}>{commit.subject}</span>
                      <code className="vc-sha">{commit.sha.slice(0, 7)}</code>
                    </div>
                  ))}
                  {scope.commits.length > 30 ? <div className="vc-hint">{tr(`还有 ${scope.commits.length - 30} 个提交`, `${scope.commits.length - 30} more commits`)}</div> : null}
                </div>
              </div>
            ) : null}
            <div className="vc-scope-block">
              <div className="vc-scope-label">
                <span>{tr("推送目标", "Push target")}</span>
                <em>{scope.pushTarget ? scope.pushTarget.remote : tr("无远程", "No remote")}</em>
              </div>
              <div className="vc-scope-commit">
                <CloudIcon size={12} />
                <span className="vc-scope-msg">
                  {scope.pushTarget ? `${scope.pushTarget.remote} / ${scope.pushTarget.branch}` : tr("没有可用远程", "No remote available")}
                </span>
                <span className={`vc-badge ${scope.headPushed ? "vc-badge-ok" : "vc-badge-pending"}`}>
                  {scope.headPushed ? tr("已发布", "Published") : tr("未推送", "Not pushed")}
                </span>
              </div>
            </div>
            <p className="vc-hint vc-scope-note">{tr("创建前会再次核对 base、head 与提交范围；预览不会连接 GitHub。", "Base, head and the commit range are re-checked before creation; previewing does not contact GitHub.")}</p>
          </>
        ) : null}
      </aside>
      </div>
    </div>
  );
}

/**
 * PR 信息维护(PR-04/PR-05):标题/描述编辑、Reviewer、标签与 Issue 关联。
 * 所有修改先停留在表单里,点击更新才写入 GitHub;AI 结果是候选,不会自动发布。
 */
function PrEditPanel({
  api,
  summary,
  locale,
}: {
  api: VersionControlApi;
  summary: PrSummary;
  locale: AppLocale;
}) {
  const [title, setTitle] = useState(summary.title);
  const [body, setBody] = useState(summary.body);
  const [preview, setPreview] = useState(false);
  const [options, setOptions] = useState<PrEditOptions | null>(null);
  const [reviewers, setReviewers] = useState<string[]>([]);
  const [labels, setLabels] = useState<string[]>([]);
  const [reviewerInput, setReviewerInput] = useState("");
  const [labelInput, setLabelInput] = useState("");
  const [issueInput, setIssueInput] = useState("");
  const [issueMode, setIssueMode] = useState<PrIssueLinkMode>("reference");
  const [scope, setScope] = useState<PrCompareScope | null>(null);
  const [aiStyle, setAiStyle] = useState<"plain" | "conventional">("plain");
  const [candidate, setCandidate] = useState<string | null>(null);
  const ai = useAiText();

  // 编辑标题/描述后重新同步表单(仅当 PR 内容真的变化)。
  useEffect(() => {
    setTitle(summary.title);
    setBody(summary.body);
  }, [summary.number, summary.title, summary.body]);

  useEffect(() => {
    let active = true;
    void api.loadPrEditOptions().then((next) => {
      if (active && next) setOptions(next);
    });
    // AI 文案需要真实范围;读取失败时禁用润色并说明原因。
    void api.loadScope(summary.baseRefName, summary.headRefName).then((next) => {
      if (active) setScope(next);
    });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summary.number]);

  const currentKey = prSnapshotKey(summary.baseRepo ?? null, summary.headRefName, summary.baseRefName, summary.updatedAt ? String(summary.updatedAt) : null);
  const markStale = ai.markStale;
  useEffect(() => {
    if (ai.state.result) markStale(ai.state.result.snapshotKey !== currentKey);
  }, [currentKey, ai.state.result, markStale]);

  const onGenerate = useCallback(
    async (action: "generate" | "polish" | "adjust" | "regenerate", instruction?: string | null) => {
      const capturedTitle = title;
      const capturedBody = body;
      const snapshot = buildPrSnapshot({
        workspace: summary.baseRepo,
        repoRoot: summary.baseRepo,
        branch: summary.headRefName,
        head: null,
        base: summary.baseRefName,
        scope: scope ?? {
          base: summary.baseRefName,
          head: summary.headRefName,
          baseRepo: summary.baseRepo,
          headRepo: summary.headRepo,
          commits: [],
          fileCount: summary.changedFiles,
          addedLines: summary.additions,
          deletedLines: summary.deletions,
          headPushed: true,
          unpushedCount: 0,
          pushTarget: null,
          empty: summary.changedFiles === 0,
          diff: "",
          diffTruncated: false,
          error: null,
        },
        template: null,
        recentCommitTitles: [],
        taskGoal: null,
        userNote: null,
        verificationNotes: null,
        locale,
        style: aiStyle,
      });
      const generated = await ai.generate({
        kind: "pr",
        action,
        snapshot,
        title: capturedTitle,
        body: capturedBody,
        instruction: instruction ?? null,
      });
      if (!generated) return;
      // 用户已改动输入时保留为候选,不覆盖手写内容。
      if (title === capturedTitle && body === capturedBody) {
        setTitle(generated.title);
        setBody(generated.body);
        ai.dismissResult();
      } else {
        setCandidate(`${generated.title}\n\n${generated.body}`);
      }
    },
    [title, body, summary, scope, locale, aiStyle, ai],
  );

  const addName = (value: string, list: string[], setList: (next: string[]) => void, clear: () => void) => {
    const name = value.trim();
    if (!name) return;
    if (!list.includes(name)) setList([...list, name]);
    clear();
  };

  const submit = async () => {
    await api.updatePr({
      number: summary.number,
      title: title.trim(),
      body,
      addReviewers: reviewers,
      removeReviewers: summary.reviewers.filter((reviewer) => !reviewers.includes(reviewer)),
      addLabels: labels,
      removeLabels: summary.labels.filter((label) => !labels.includes(label)),
    });
  };

  const linkIssues = async () => {
    const issues = issueInput
      .split(/[,\s#]+/)
      .map((value) => Number.parseInt(value, 10))
      .filter((value) => Number.isInteger(value) && value > 0);
    if (issues.length === 0) return;
    const result = await api.linkPrIssues({ number: summary.number, issues, mode: issueMode });
    if (result?.ok) setIssueInput("");
  };

  return (
    <section className="vc-pr-edit" aria-label={tr("编辑 Pull Request", "Edit pull request")}>
      <div className="vc-field-label" id="vc-pr-edit-title">{tr("标题", "Title")}</div>
      <input
        className="vc-input vc-pr-title"
        aria-labelledby="vc-pr-edit-title"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
      />
      <div className="vc-md-bar">
        <span className="vc-hint">{tr("修改会先停留在表单，点击更新才写入 GitHub。", "Edits stay local until you click Update.")}</span>
        <label className="vc-draft-toggle">
          <input type="checkbox" checked={aiStyle === "conventional"} onChange={(event) => setAiStyle(event.target.checked ? "conventional" : "plain")} />
          {tr("Conventional Commits 标题", "Conventional Commits title")}
        </label>
        <button type="button" className="vc-btn vc-btn-ghost" aria-pressed={preview} onClick={() => setPreview((value) => !value)}>
          {preview ? tr("编辑", "Edit") : tr("预览", "Preview")}
        </button>
      </div>
      {preview ? (
        <div className="vc-description-preview">{body.trim() ? <Markdown text={body} /> : <span className="vc-hint">{tr("暂无内容", "Nothing to preview")}</span>}</div>
      ) : (
        <textarea className="vc-input vc-description" aria-label={tr("PR 描述", "PR description")} value={body} onChange={(event) => setBody(event.target.value)} />
      )}

      <AiAssist
        state={ai.state}
        disabled={!scope}
        hint={
          scope
            ? tr(`依据 ${summary.headRefName} → ${summary.baseRefName} 的 ${scope.commits.length} 个提交 · 结果可编辑`, `Based on ${scope.commits.length} commits from ${summary.headRefName} to ${summary.baseRefName} · editable`)
            : tr("正在读取变更范围…", "Loading the change range…")
        }
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
      {candidate ? (
        <div className="vc-ai-candidate" role="status">
          <b>{tr("已保留为候选（未覆盖你的输入）", "Kept as a candidate (your text is unchanged)")}</b>
          <pre className="vc-command-output">{candidate}</pre>
          <div className="vc-dialog-actions">
            <button type="button" className="vc-btn vc-btn-ghost" onClick={() => setCandidate(null)}>{tr("忽略", "Dismiss")}</button>
            <button
              type="button"
              className="vc-btn"
              onClick={() => {
                const [nextTitle, ...rest] = candidate.split("\n\n");
                setTitle(nextTitle ?? title);
                setBody(rest.join("\n\n"));
                setCandidate(null);
              }}
            >
              {tr("采用候选项", "Use candidate")}
            </button>
          </div>
        </div>
      ) : null}

      <div className="vc-pr-edit-grid">
        <div className="vc-pr-edit-block">
          <div className="vc-field-label">{tr("审阅者", "Reviewers")}</div>
          <div className="vc-chip-list">
            {summary.reviewers.map((reviewer) => (
              <span key={reviewer} className="vc-chip-tag">
                {reviewer}
                {!reviewers.includes(reviewer) ? <span className="vc-chip-note">{tr("将移除", "will remove")}</span> : null}
              </span>
            ))}
            {reviewers.filter((reviewer) => !summary.reviewers.includes(reviewer)).map((reviewer) => (
              <span key={reviewer} className="vc-chip-tag pending">
                {reviewer} <button type="button" className="vc-link" onClick={() => setReviewers(reviewers.filter((entry) => entry !== reviewer))}>×</button>
              </span>
            ))}
          </div>
          <div className="vc-inline-form">
            <input
              className="vc-input"
              list="vc-pr-reviewers"
              placeholder={tr("添加审阅者", "Add reviewer")}
              aria-label={tr("添加审阅者", "Add reviewer")}
              value={reviewerInput}
              onChange={(event) => setReviewerInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") addName(reviewerInput, reviewers, setReviewers, () => setReviewerInput(""));
              }}
            />
            <datalist id="vc-pr-reviewers">
              {(options?.reviewers ?? []).map((name) => <option key={name} value={name} />)}
            </datalist>
            <button type="button" className="vc-btn vc-btn-ghost" onClick={() => addName(reviewerInput, reviewers, setReviewers, () => setReviewerInput(""))}>
              {tr("添加", "Add")}
            </button>
            <button type="button" className="vc-link" onClick={() => setReviewers([])}>{tr("撤销全部变更", "Reset")}</button>
          </div>
        </div>

        <div className="vc-pr-edit-block">
          <div className="vc-field-label">{tr("标签", "Labels")}</div>
          <div className="vc-chip-list">
            {summary.labels.map((label) => (
              <span key={label} className="vc-chip-tag">
                {label}
                {!labels.includes(label) ? <span className="vc-chip-note">{tr("将移除", "will remove")}</span> : null}
              </span>
            ))}
            {labels.filter((label) => !summary.labels.includes(label)).map((label) => (
              <span key={label} className="vc-chip-tag pending">
                {label} <button type="button" className="vc-link" onClick={() => setLabels(labels.filter((entry) => entry !== label))}>×</button>
              </span>
            ))}
          </div>
          <div className="vc-inline-form">
            <input
              className="vc-input"
              list="vc-pr-labels"
              placeholder={tr("添加标签", "Add label")}
              aria-label={tr("添加标签", "Add label")}
              value={labelInput}
              onChange={(event) => setLabelInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") addName(labelInput, labels, setLabels, () => setLabelInput(""));
              }}
            />
            <datalist id="vc-pr-labels">
              {(options?.labels ?? []).map((name) => <option key={name} value={name} />)}
            </datalist>
            <button type="button" className="vc-btn vc-btn-ghost" onClick={() => addName(labelInput, labels, setLabels, () => setLabelInput(""))}>
              {tr("添加", "Add")}
            </button>
            <button type="button" className="vc-link" onClick={() => setLabels([])}>{tr("撤销全部变更", "Reset")}</button>
          </div>
        </div>
      </div>

      <div className="vc-pr-edit-block">
        <div className="vc-field-label">{tr("关联 Issue", "Linked issues")}</div>
        <div className="vc-inline-form">
          <input
            className="vc-input"
            placeholder={tr("Issue 编号，如 12, 34", "Issue numbers, e.g. 12, 34")}
            aria-label={tr("Issue 编号", "Issue numbers")}
            value={issueInput}
            onChange={(event) => setIssueInput(event.target.value)}
          />
          <label className="vc-radio">
            <input type="radio" name="vc-issue-mode" checked={issueMode === "reference"} onChange={() => setIssueMode("reference")} />
            {tr("仅引用", "Reference only")}
          </label>
          <label className="vc-radio">
            <input type="radio" name="vc-issue-mode" checked={issueMode === "close"} onChange={() => setIssueMode("close")} />
            {tr("合并后自动关闭", "Close on merge")}
          </label>
          <button type="button" className="vc-btn vc-btn-ghost" disabled={api.busy !== null} onClick={() => void linkIssues()}>
            {tr("关联", "Link")}
          </button>
        </div>
        <p className="vc-hint">
          {tr(
            "「仅引用」只建立关联；「合并后自动关闭」会写入 Closes，由 GitHub 在合并时关闭对应 Issue。",
            "Reference only links the issue; Close on merge writes Closes so GitHub closes it when the PR merges.",
          )}
        </p>
      </div>

      <div className="vc-dialog-actions">
        <button type="button" className="vc-btn vc-btn-primary" disabled={api.busy !== null || !title.trim()} onClick={() => void submit()}>
          <CheckIcon size={12} /> {tr("更新远程 PR", "Update on GitHub")}
        </button>
        <button
          type="button"
          className="vc-btn vc-btn-ghost"
          onClick={() => {
            setTitle(summary.title);
            setBody(summary.body);
            setReviewers([]);
            setLabels([]);
          }}
        >
          {tr("还原修改", "Reset changes")}
        </button>
        <span className="vc-hint">{tr("更新前请核对目标编号，只影响这个 PR。", "Only this pull request is updated.")}</span>
      </div>
    </section>
  );
}

function PrAccessNotice({
  pr,
  onRefresh,
  onOpenConversation,
}: {
  pr: PullRequestInfo;
  onRefresh(): void;
  onOpenConversation(): void;
}) {
  const messages: Record<string, [string, string]> = {
    "no-gh": [
      "未安装 GitHub CLI（gh），PR 功能降级为网页操作。安装后可在这里创建 PR。",
      "GitHub CLI (gh) is not installed; pull requests fall back to the web. Install it to create PRs here.",
    ],
    unauthenticated: [
      "gh 未登录。请在终端运行 gh auth login，本地 Git 功能不受影响。",
      "gh is not signed in. Run gh auth login in a terminal; local Git still works.",
    ],
    permission: [
      "当前账号没有访问这个仓库的权限。",
      "The current account cannot access this repository.",
    ],
    offline: [
      "当前无法连接 GitHub。恢复网络后刷新。",
      "GitHub is unreachable. Refresh once the network is back.",
    ],
    failed: [
      "读取 Pull Request 失败。",
      "Could not read pull requests.",
    ],
  };
  const [chinese, english] = messages[pr.status] ?? messages.failed!;
  return (
    <div className={`vc-pr-notice${pr.stale ? " stale" : ""}`} role="status">
      <AlertIcon size={13} />
      <span>{tr(chinese, english)}{pr.reason ? ` · ${pr.reason}` : ""}</span>
      <button type="button" className="vc-link" onClick={onRefresh}>{tr("刷新", "Refresh")}</button>
      <button type="button" className="vc-link" onClick={onOpenConversation}>{tr("返回对话", "Back to chat")}</button>
    </div>
  );
}

function PrDetail({
  api,
  pr,
  status,
  locale,
  onOpenConversation,
}: {
  api: VersionControlApi;
  pr: PullRequestInfo;
  status: GitStatusSnapshot;
  locale: AppLocale;
  onOpenConversation(): void;
}) {
  const summary = pr.pr!;
  const [editing, setEditing] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  return (
    <div className="vc-pr-detail">
      <header className="vc-pr-detail-head">
        <div className="vc-overline"><PrIcon size={12} /> #{summary.number} · {prStateLabel(summary.state)}</div>
        <h1>{summary.title}</h1>
        <div className="vc-pr-detail-meta">
          <span>{summary.baseRepo ?? summary.baseRefName} ← {summary.headRepo ?? summary.headRefName}</span>
          <span>{tr("分支", "Branches")} <b>{summary.baseRefName} ← {summary.headRefName}</b></span>
          <span>{tr("作者", "Author")} <b>{summary.author ?? "—"}</b></span>
          {summary.updatedAt ? <span>{tr("更新于", "Updated")} {formatRelativeTime(summary.updatedAt, locale)}</span> : null}
          <span className="vc-stats"><b className="vc-plus">+{summary.additions}</b> <b className="vc-minus">−{summary.deletions}</b> · {tr(`${summary.changedFiles} 个文件`, `${summary.changedFiles} files`)}</span>
        </div>
        <div className="vc-pr-detail-actions">
          <button type="button" className="vc-btn vc-btn-primary" onClick={() => void window.vela?.openPullRequest(summary.url)}>
            <GithubIcon size={12} /> {tr("在 GitHub 打开", "Open on GitHub")}
          </button>
          <button type="button" className={`vc-btn${editing ? " active" : ""}`} aria-pressed={editing} onClick={() => setEditing((value) => !value)}>
            <PencilIcon size={12} /> {editing ? tr("收起编辑", "Hide editor") : tr("编辑", "Edit")}
          </button>
          {summary.isDraft ? (
            <button
              type="button"
              className="vc-btn"
              disabled={api.busy !== null}
              onClick={() => void api.markPrReady(summary.number)}
            >
              <CheckIcon size={12} /> {tr("转为 Ready for review", "Mark ready for review")}
            </button>
          ) : null}
          <div className="vc-pr-panel-anchor">
            <button
              type="button"
              className={`vc-btn${reviewOpen ? " active" : ""}`}
              aria-expanded={reviewOpen}
              onClick={() => {
                setReviewOpen((value) => !value);
                setMergeOpen(false);
              }}
            >
              <SendIcon size={12} /> {tr("评论与审阅", "Comments & reviews")}
            </button>
            <PrReviewPanel open={reviewOpen} onClose={() => setReviewOpen(false)} api={api} pr={summary} locale={locale} />
          </div>
          <div className="vc-pr-panel-anchor">
            <button
              type="button"
              className={`vc-btn${mergeOpen ? " active" : ""}`}
              aria-expanded={mergeOpen}
              onClick={() => {
                setMergeOpen((value) => !value);
                setReviewOpen(false);
              }}
            >
              <CheckIcon size={12} /> {tr("合并 / 关闭", "Merge / close")}
            </button>
            {mergeOpen ? (
              <PrMergePanel
                open
                onClose={() => setMergeOpen(false)}
                api={api}
                pr={summary}
                locale={locale}
                onChanged={() => {
                  api.refreshPr();
                }}
              />
            ) : null}
          </div>
          <button type="button" className="vc-btn" disabled={api.prLoading} onClick={api.refreshPr}>
            <RefreshIcon size={12} /> {api.prLoading ? tr("刷新中…", "Refreshing…") : tr("刷新", "Refresh")}
          </button>
          <button type="button" className="vc-btn vc-btn-ghost" onClick={onOpenConversation}>{tr("返回对话", "Back to chat")}</button>
          {pr.stale ? <span className="vc-badge vc-badge-pending">{tr("数据可能已过期", "Data may be stale")}</span> : null}
        </div>
      </header>

      {editing ? <PrEditPanel api={api} summary={summary} locale={locale} /> : null}

      <section className="vc-pr-review">
        <div className="vc-review-item">
          <span>{tr("审阅结论", "Review decision")}</span>
          <b>{summary.reviewDecision ?? tr("无", "None")}</b>
        </div>
        <div className="vc-review-item">
          <span>{tr("当前批准", "Approvals")}</span>
          <b>{summary.approvals}</b>
        </div>
        <div className="vc-review-item">
          <span>{tr("检查", "Checks")}</span>
          <b>{summary.checks}</b>
        </div>
        <div className="vc-review-item">
          <span>{tr("审阅者", "Reviewers")}</span>
          <b>{summary.reviewers.length > 0 ? summary.reviewers.join(", ") : tr("未指定", "None")}</b>
        </div>
        <div className="vc-review-item">
          <span>{tr("标签", "Labels")}</span>
          <b>{summary.labels.length > 0 ? summary.labels.join(", ") : tr("无", "None")}</b>
        </div>
        <div className="vc-review-item">
          <span>{tr("合并后自动关闭", "Closes on merge")}</span>
          <b>{summary.closingIssues.length > 0 ? summary.closingIssues.map((issue) => `#${issue}`).join(", ") : tr("无", "None")}</b>
        </div>
      </section>

      {pr.checks.length > 0 ? (
        <section className="vc-pr-checks">
          <h3>{tr("检查明细", "Checks")}</h3>
          {pr.checks.map((check, index) => (
            <div key={`${check.name}:${index}`} className={`vc-check-row vc-check-${check.state}`}>
              <span className="vc-check-state">{tr(checkStateLabels[check.state][0], checkStateLabels[check.state][1])}</span>
              <span className="vc-check-name" title={check.description ?? check.name}>{check.name}</span>
              {check.workflow ? <span className="vc-hint">{check.workflow}</span> : null}
              {check.link ? (
                <button type="button" className="vc-icon-btn" title={tr("查看详情", "View details")} aria-label={`${tr("查看详情", "View details")} ${check.name}`} onClick={() => void window.vela?.openPullRequest(check.link!)}>
                  <ExternalIcon size={11} />
                </button>
              ) : null}
            </div>
          ))}
        </section>
      ) : (
        <section className="vc-pr-checks"><div className="vc-state">{tr("没有检查", "No checks")}</div></section>
      )}

      <section className="vc-pr-body-section">
        {summary.body.trim() ? <Markdown text={summary.body} /> : <div className="vc-state">{tr("没有描述", "No description")}</div>}
      </section>

      {pr.otherBranchPrs.length > 0 ? (
        <section className="vc-pr-others">
          <h3>{tr("同分支的其他 PR", "Other pull requests on this branch")}</h3>
          {pr.otherBranchPrs.map((other) => (
            <div key={other.number} className="vc-check-row">
              <span className={`vc-badge ${other.state === "merged" ? "vc-badge-ok" : "vc-badge-muted"}`}>{prStateLabel(other.state)}</span>
              <span className="vc-check-name">#{other.number} {other.title}</span>
              <button type="button" className="vc-icon-btn" title={tr("打开", "Open")} aria-label={tr("打开", "Open")} onClick={() => void window.vela?.openPullRequest(other.url)}>
                <ExternalIcon size={11} />
              </button>
            </div>
          ))}
        </section>
      ) : null}

      <footer className="vc-pr-detail-foot">
        <span>{tr("当前分支", "Current branch")} <code>{status.branch ?? "—"}</code></span>
        <span>{pr.checkedAt ? tr(`查询于 ${formatRelativeTime(pr.checkedAt, locale)}`, `Checked ${formatRelativeTime(pr.checkedAt, locale)}`) : ""}</span>
      </footer>
    </div>
  );
}

export type { PrSummary };
