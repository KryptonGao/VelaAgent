import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AiTextAction,
  AiTextSnapshot,
  AppLocale,
  GitReleaseNotesScope,
  GitStatusSnapshot,
} from "@vela/shared";
import { tr } from "../../locale";
import type { VersionControlApi } from "../../hooks/useVersionControl";
import { AlertIcon, CopyIcon, RefreshIcon, SparkIcon, TagIcon, TrashIcon } from "../icons";
import { AiAssist } from "./AiAssist";
import { useAiText } from "./ai-text";
import { formatDateOnly, formatRelativeTime } from "./time-format";

type PanelTab = "tags" | "releases" | "notes";

/** 发布说明正文的折叠预览长度。 */
const releasePreviewLength = 400;
/** 区间 PR 列表一次最多展示的条数。 */
const releasePullPreviewCount = 8;

/** 只按 v主.次.修订 递增 patch;不符合该形式时不猜版本号。 */
function suggestNextTag(base: string | null): string {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec((base ?? "").trim());
  if (!match) return "";
  const major = match[1] ?? "";
  const minor = match[2] ?? "";
  const patch = Number.parseInt(match[3] ?? "", 10);
  if (!Number.isFinite(patch)) return "";
  return `v${major}.${minor}.${patch + 1}`;
}

/**
 * 标签与发布(RL-01)以及按版本区间生成发布说明(AI-12)。
 * 创建标签/发布都指向明确目标;AI 生成只是候选,不会创建标签或发布。
 */
export function TagReleasePanel({
  open,
  onClose,
  api,
  status,
  defaultBase,
  onChanged,
  locale,
}: {
  open: boolean;
  onClose(): void;
  api: VersionControlApi;
  status: GitStatusSnapshot;
  defaultBase: string | null;
  onChanged(): void;
  locale: AppLocale;
}) {
  const [tab, setTab] = useState<PanelTab>("tags");

  // ---- 标签 ----
  const [tagName, setTagName] = useState("");
  const [tagTarget, setTagTarget] = useState("");
  const [tagMessage, setTagMessage] = useState("");
  const [pushTag, setPushTag] = useState(false);
  const [tagRemote, setTagRemote] = useState("");
  const [tagResult, setTagResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [confirmTag, setConfirmTag] = useState<string | null>(null);

  // ---- 发布 ----
  const [releaseTagName, setReleaseTagName] = useState("");
  const [releaseName, setReleaseName] = useState("");
  const [releaseBody, setReleaseBody] = useState("");
  const [releaseTarget, setReleaseTarget] = useState("");
  const [releaseDraft, setReleaseDraft] = useState(false);
  const [releasePrerelease, setReleasePrerelease] = useState(false);
  const [releaseResult, setReleaseResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [expandedReleases, setExpandedReleases] = useState<string[]>([]);

  // ---- 发布说明 ----
  const [baseTagChoice, setBaseTagChoice] = useState<string | null>(null);
  const [targetTag, setTargetTag] = useState("");
  const [manualNotes, setManualNotes] = useState("");
  const [scope, setScope] = useState<GitReleaseNotesScope | null>(null);
  const [scopeLoading, setScopeLoading] = useState(false);
  const [scopeFailed, setScopeFailed] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftBody, setDraftBody] = useState("");
  const [copyNotice, setCopyNotice] = useState<string | null>(null);

  const ai = useAiText();
  const aiClear = ai.clear;
  const aiMarkStale = ai.markStale;
  const headPrefilled = useRef(false);
  /** 生成候选时使用的区间对象;区间重新读取后据此提示依据可能已变化。 */
  const generatedScope = useRef<GitReleaseNotesScope | null>(null);
  /** 打开瞬间的默认上一版本;避免打开期间 props 变化清空正在编辑的内容。 */
  const defaultBaseRef = useRef(defaultBase);
  defaultBaseRef.current = defaultBase;

  // 当前 HEAD 短 SHA:只有提交图确实是当前分支范围时才能当作 HEAD。
  const headSha = api.graphScope === "current" ? (api.graph?.commits[0]?.sha ?? null) : null;

  // 推送远程默认值:跟踪分支所在远程 → origin → 第一个远程。
  const defaultRemote = useMemo(() => {
    const names = status.remotes.map((remote) => remote.name);
    if (names.length === 0) return "";
    const upstreamRemote = status.upstream ? (status.upstream.split("/")[0] ?? "") : "";
    if (upstreamRemote && names.includes(upstreamRemote)) return upstreamRemote;
    if (names.includes("origin")) return "origin";
    return names[0] ?? "";
  }, [status.remotes, status.upstream]);

  const selectedRemote =
    tagRemote && status.remotes.some((remote) => remote.name === tagRemote) ? tagRemote : defaultRemote;

  // 快照契约:release 的 workspace 与 userNote 固定为 null,人工说明通过 manualNotes 传递。
  const workspacePath: string | null = null;
  const userNote: string | null = null;

  // 建议的上一版本:仅当它确实是本地标签时作为默认选中项。
  const suggestedBase = useMemo(
    () => (defaultBase && api.tags.some((tag) => tag.name === defaultBase) ? defaultBase : ""),
    [defaultBase, api.tags],
  );
  const baseTagValue = baseTagChoice ?? suggestedBase;
  const suggestedTarget = useMemo(() => suggestNextTag(defaultBase), [defaultBase]);

  const releaseTagExists = api.tags.some((tag) => tag.name === releaseTagName.trim());

  // 打开面板时重置本地状态;关闭期间保留的输入不应带到下一次打开。
  useEffect(() => {
    if (!open) return;
    setTab("tags");
    setTagName("");
    setTagTarget("");
    setTagMessage("");
    setPushTag(false);
    setTagRemote("");
    setTagResult(null);
    setConfirmTag(null);
    setReleaseTagName("");
    setReleaseName("");
    setReleaseBody("");
    setReleaseTarget("");
    setReleaseDraft(false);
    setReleasePrerelease(false);
    setReleaseResult(null);
    setExpandedReleases([]);
    setBaseTagChoice(null);
    setTargetTag(suggestNextTag(defaultBaseRef.current));
    setManualNotes("");
    setScope(null);
    setScopeLoading(false);
    setScopeFailed(false);
    setDraftTitle("");
    setDraftBody("");
    setCopyNotice(null);
    generatedScope.current = null;
    aiClear();
  }, [open, aiClear]);

  // 打开与切换页签时读取对应数据(标签也供发布说明的上一版本选择使用)。
  useEffect(() => {
    if (!open) return;
    if (tab === "tags" || tab === "notes") api.refreshTags();
  }, [open, tab, api.refreshTags]);

  useEffect(() => {
    if (!open) return;
    if (tab === "releases") api.refreshReleases();
  }, [open, tab, api.refreshReleases]);

  // HEAD 短 SHA 就绪后填入目标提交;已经填写过就不再覆盖。
  useEffect(() => {
    if (!open) {
      headPrefilled.current = false;
      return;
    }
    if (headPrefilled.current || !headSha) return;
    headPrefilled.current = true;
    setTagTarget((current) => (current.trim() ? current : headSha.slice(0, 7)));
  }, [open, headSha]);

  // 区间重新读取后,旧候选的依据可能已经不同,提示核对后再采用。
  useEffect(() => {
    if (!ai.state.result) return;
    if (!generatedScope.current || generatedScope.current === scope) return;
    aiMarkStale(true);
  }, [scope, ai.state.result, aiMarkStale]);

  const submitTag = async () => {
    const name = tagName.trim();
    if (!name) return;
    setTagResult(null);
    const result = await api.createTag({
      name,
      target: tagTarget.trim() || null,
      message: tagMessage.trim() || null,
      push: pushTag,
      remote: pushTag ? selectedRemote || null : null,
    });
    if (!result) return;
    setTagResult({ ok: result.ok, message: result.message });
    if (result.ok) {
      setTagName("");
      setTagMessage("");
    }
    // 可能部分成功(例如本地已创建但推送失败),统一刷新真实状态。
    onChanged();
  };

  const removeTag = async (name: string, remote: string | null) => {
    setConfirmTag(null);
    const result = await api.deleteTag(name, remote);
    if (result) setTagResult({ ok: result.ok, message: result.message });
    api.refreshTags();
    onChanged();
  };

  const submitRelease = async () => {
    const tag = releaseTagName.trim();
    if (!tag) return;
    setReleaseResult(null);
    const result = await api.createRelease({
      tagName: tag,
      name: releaseName.trim() || null,
      body: releaseBody,
      draft: releaseDraft,
      prerelease: releasePrerelease,
      target: releaseTarget.trim() || null,
    });
    if (!result) return;
    setReleaseResult({ ok: result.ok, message: result.message });
    if (result.ok) {
      setReleaseTagName("");
      setReleaseName("");
      setReleaseBody("");
      setReleaseTarget("");
      setReleaseDraft(false);
      setReleasePrerelease(false);
      api.refreshTags();
      api.refreshReleases();
      onChanged();
    }
  };

  const loadScope = async () => {
    const target = targetTag.trim();
    if (!target) return;
    setScopeLoading(true);
    setScopeFailed(false);
    const next = await api.loadReleaseScope(baseTagValue || null, target).catch(() => null);
    setScopeLoading(false);
    setScope(next);
    setScopeFailed(next === null);
  };

  const generate = async (action: AiTextAction, instruction?: string | null) => {
    if (!scope || scope.error) return;
    const snapshot: AiTextSnapshot = {
      kind: "release",
      key: ["release", workspacePath ?? "", scope.baseTag ?? "", scope.targetTag, scope.headSha ?? "", String(scope.commitCount), userNote ?? ""].join("|"),
      workspace: workspacePath,
      repoRoot: status.repo?.root ?? null,
      branch: status.branch ?? null,
      head: scope.headSha ?? null,
      base: scope.baseSha ?? null,
      stagedPaths: [],
      plannedPaths: [],
      diff: scope.diff,
      diffTruncated: scope.diffTruncated,
      fileCount: scope.fileCount,
      addedLines: scope.addedLines,
      deletedLines: scope.deletedLines,
      commits: scope.commits.map((commit) => ({ sha: commit.sha, subject: commit.subject })),
      recentCommitTitles: [],
      template: null,
      taskGoal: null,
      userNote,
      verificationNotes: null,
      releaseTag: scope.targetTag,
      baseTag: scope.baseTag,
      pullRequests: scope.pullRequests.map((pull) => ({ number: pull.number, title: pull.title, author: pull.author, url: pull.url })),
      previousNotes: scope.previousNotes,
      manualNotes: manualNotes.trim() || null,
      locale,
      style: "plain",
    };
    generatedScope.current = scope;
    await ai.generate({
      kind: "release",
      action,
      snapshot,
      title: draftTitle,
      body: draftBody,
      instruction: instruction ?? null,
    });
  };

  const copyDraft = () => {
    const text = [draftTitle.trim(), draftBody.trim()].filter(Boolean).join("\n\n");
    if (!text) return;
    const failed = tr("复制失败，请手动选择文本。", "Copy failed; select the text manually.");
    try {
      void navigator.clipboard.writeText(text).then(
        () => setCopyNotice(tr("已复制发布说明。", "Release notes copied.")),
        () => setCopyNotice(failed),
      );
    } catch {
      setCopyNotice(failed);
    }
  };

  /** 采用候选:只写入草稿,不创建发布,也不创建标签。 */
  const applyCandidate = (result: { title: string; body: string }) => {
    setDraftTitle(result.title);
    setDraftBody(result.body);
    setCopyNotice(null);
    ai.dismissResult();
  };

  const fillReleaseForm = () => {
    setReleaseName(draftTitle);
    setReleaseBody(draftBody);
    // 标签名留空时按本次版本填入,不覆盖已有输入。
    setReleaseTagName((current) => (current.trim() ? current : targetTag.trim()));
    setTab("releases");
  };

  if (!open) return null;

  const tabs: { id: PanelTab; label: string }[] = [
    { id: "tags", label: tr("标签", "Tags") },
    { id: "releases", label: tr("发布", "Releases") },
    { id: "notes", label: tr("发布说明", "Release notes") },
  ];

  return (
    <div className="vc-popover vc-p2-tagrelease" role="dialog" aria-label={tr("标签与发布", "Tags and releases")}>
      <div className="vc-ops-head">
        <b><TagIcon size={12} /> {tr("标签与发布", "Tags and releases")}</b>
        <button
          type="button"
          className="vc-icon-btn"
          title={tr("刷新", "Refresh")}
          aria-label={tab === "releases" ? tr("刷新发布记录", "Refresh releases") : tr("刷新标签", "Refresh tags")}
          onClick={tab === "releases" ? api.refreshReleases : api.refreshTags}
        >
          <RefreshIcon size={12} />
        </button>
        <button type="button" className="vc-link" onClick={onClose}>{tr("关闭", "Close")}</button>
      </div>

      <div className="vc-p2-tabs">
        {tabs.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={`vc-chip${tab === entry.id ? " active" : ""}`}
            aria-pressed={tab === entry.id}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {tab === "tags" ? (
        <div className="vc-p2-body">
          <div className="vc-p2-section">
            <div className="vc-p2-label"><TagIcon size={11} /> {tr("创建标签", "Create a tag")}</div>
            <input
              className="vc-input"
              placeholder="v1.0.0"
              aria-label={tr("标签名", "Tag name")}
              value={tagName}
              onChange={(event) => setTagName(event.target.value)}
            />
            <input
              className="vc-input"
              placeholder={tr("目标提交", "Target commit")}
              aria-label={tr("目标提交", "Target commit")}
              value={tagTarget}
              onChange={(event) => setTagTarget(event.target.value)}
            />
            <p className="vc-hint">
              {tr("留空表示使用当前 HEAD；也可以填写分支、标签或提交 SHA。", "Empty means the current HEAD; a branch, tag or commit SHA also works.")}
            </p>
            <textarea
              className="vc-input vc-p2-textarea"
              placeholder={tr("说明", "Message")}
              aria-label={tr("标签说明", "Tag message")}
              value={tagMessage}
              onChange={(event) => setTagMessage(event.target.value)}
            />
            <p className="vc-hint">
              {tr("填写说明会创建附注标签，留空则创建轻量标签。", "A message creates an annotated tag; empty creates a lightweight tag.")}
            </p>
            <label className="vc-p2-check">
              <input
                type="checkbox"
                checked={pushTag}
                disabled={status.remotes.length === 0}
                onChange={(event) => setPushTag(event.target.checked)}
              />
              {tr("创建后推送", "Push after creating")}
            </label>
            <select
              className="vc-select"
              aria-label={tr("推送远程", "Push remote")}
              value={selectedRemote}
              disabled={!pushTag || status.remotes.length === 0}
              onChange={(event) => setTagRemote(event.target.value)}
            >
              {status.remotes.map((remote) => <option key={remote.name} value={remote.name}>{remote.name}</option>)}
            </select>
            {status.remotes.length === 0 ? (
              <p className="vc-hint">{tr("当前仓库没有配置远程，只能创建本地标签。", "No remote is configured; only a local tag can be created.")}</p>
            ) : null}
            <div className="vc-p2-foot">
              <button
                type="button"
                className="vc-btn vc-btn-primary"
                disabled={api.busy !== null || !tagName.trim() || (pushTag && !selectedRemote)}
                onClick={() => void submitTag()}
              >
                {tr("创建标签", "Create tag")}
              </button>
            </div>
            {tagResult ? (
              <div className={tagResult.ok ? "vc-p2-note" : "vc-p2-error"} role={tagResult.ok ? "status" : "alert"}>
                {tagResult.message}
              </div>
            ) : null}
          </div>

          {api.tagsLoading && api.tags.length === 0 ? (
            <div className="vc-state" role="status">
              <span className="vc-spinner" aria-hidden="true" />
              {tr("正在读取标签…", "Loading tags…")}
            </div>
          ) : null}
          {api.tagsError ? (
            <div className="vc-state vc-state-error" role="alert"><AlertIcon size={12} />{api.tagsError}</div>
          ) : null}
          {!api.tagsLoading && !api.tagsError && api.tags.length === 0 ? (
            <div className="vc-state">{tr("当前仓库还没有标签", "No tags yet")}</div>
          ) : null}

          <div className="vc-p2-tag-list">
            {api.tags.map((tag) => {
              const pushLabel = tag.pushed === null
                ? tr("推送状态未知", "Push state unknown")
                : tag.pushed
                  ? tr(`已推送到 ${tag.remotes.join("、")}`, `Pushed to ${tag.remotes.join(", ")}`)
                  : tr("未推送", "Not pushed");
              const pushClass = tag.pushed === null
                ? "vc-badge vc-badge-muted"
                : tag.pushed
                  ? "vc-badge"
                  : "vc-badge vc-badge-pending";
              return (
                <div key={tag.name} className="vc-p2-tag">
                  <div className="vc-p2-tag-head">
                    <b className="vc-p2-tag-name">{tag.name}</b>
                    <code className="vc-sha">{tag.shortSha}</code>
                    <span className={tag.annotated ? "vc-badge" : "vc-badge vc-badge-muted"}>
                      {tag.annotated ? tr("附注", "Annotated") : tr("轻量", "Lightweight")}
                    </span>
                    <span className={pushClass}>{pushLabel}</span>
                    {confirmTag === tag.name ? null : (
                      <button
                        type="button"
                        className="vc-icon-btn vc-danger"
                        title={tr("删除标签", "Delete tag")}
                        aria-label={`${tr("删除标签", "Delete tag")} ${tag.name}`}
                        onClick={() => setConfirmTag(tag.name)}
                      >
                        <TrashIcon size={11} />
                      </button>
                    )}
                  </div>
                  <div className="vc-p2-meta">
                    {tag.taggerName ? <span>{tr("打标签者", "Tagger")} <b>{tag.taggerName}</b></span> : null}
                    {tag.at !== null ? <span>{formatRelativeTime(tag.at, locale)}</span> : null}
                    {tag.subject ? <span title={tag.subject}>{tag.subject}</span> : null}
                  </div>
                  {confirmTag === tag.name ? (
                    <div className="vc-p2-tag-actions" role="group" aria-label={tr("删除标签确认", "Confirm tag deletion")}>
                      <span className="vc-p2-meta">{tr("删除后无法恢复。", "Deleting cannot be undone.")}</span>
                      <button
                        type="button"
                        className="vc-btn vc-btn-ghost"
                        disabled={api.busy !== null}
                        onClick={() => void removeTag(tag.name, null)}
                      >
                        {tr("只删除本地", "Delete local only")}
                      </button>
                      {status.remotes.length > 0 ? (
                        <button
                          type="button"
                          className="vc-btn vc-btn-ghost"
                          disabled={api.busy !== null}
                          onClick={() => void removeTag(tag.name, selectedRemote || null)}
                        >
                          {tr(`同时删除远程 ${selectedRemote}`, `Also delete on ${selectedRemote}`)}
                        </button>
                      ) : null}
                      <button type="button" className="vc-btn vc-btn-ghost" onClick={() => setConfirmTag(null)}>
                        {tr("取消", "Cancel")}
                      </button>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {tab === "releases" ? (
        <div className="vc-p2-body">
          {api.releasesLoading && !api.releases ? (
            <div className="vc-state" role="status">
              <span className="vc-spinner" aria-hidden="true" />
              {tr("正在读取发布记录…", "Loading releases…")}
            </div>
          ) : null}
          {api.releases && !api.releases.ok ? (
            <>
              <div className="vc-state" role="status">{api.releases.message}</div>
              {!api.releases.ghAvailable ? (
                <div className="vc-p2-note">
                  {tr(
                    "本地 Git 功能不受影响，配置并登录 GitHub CLI 后可查看发布记录。",
                    "Local Git is unaffected; configure and sign in to the GitHub CLI to view releases.",
                  )}
                </div>
              ) : null}
            </>
          ) : null}
          {api.releases?.ok && api.releases.releases.length === 0 ? (
            <div className="vc-state">{tr("还没有发布记录", "No releases yet")}</div>
          ) : null}

          <div className="vc-p2-release-list">
            {(api.releases?.releases ?? []).map((release) => {
              const expanded = expandedReleases.includes(release.tagName);
              const body = release.body ?? "";
              const preview = body.length > releasePreviewLength ? `${body.slice(0, releasePreviewLength)}…` : body;
              const published = release.publishedAt !== null
                ? tr(`发布于 ${formatRelativeTime(release.publishedAt, locale)}`, `Published ${formatRelativeTime(release.publishedAt, locale)}`)
                : release.createdAt !== null
                  ? tr(`创建于 ${formatRelativeTime(release.createdAt, locale)}`, `Created ${formatRelativeTime(release.createdAt, locale)}`)
                  : tr("发布时间未知", "Publish time unknown");
              return (
                <div key={release.tagName} className="vc-p2-release">
                  <div className="vc-p2-release-head">
                    <b className="vc-p2-release-name">{release.tagName}</b>
                    {release.name ? <span>{release.name}</span> : null}
                    {release.draft ? <span className="vc-badge vc-badge-pending">{tr("草稿", "Draft")}</span> : null}
                    {release.prerelease ? <span className="vc-badge vc-badge-muted">{tr("预发布", "Pre-release")}</span> : null}
                    {release.isLatest ? <span className="vc-badge">{tr("最新", "Latest")}</span> : null}
                    <a className="vc-link" href={release.url} target="_blank" rel="noreferrer">{tr("打开", "Open")}</a>
                  </div>
                  <div className="vc-p2-meta">
                    <span>{published}</span>
                    <span>{tr("作者", "Author")} <b>{release.author ?? tr("未知", "Unknown")}</b></span>
                  </div>
                  {body.trim() ? (
                    <>
                      <pre className="vc-p2-release-body">{expanded ? body : preview}</pre>
                      {body.length > releasePreviewLength ? (
                        <button
                          type="button"
                          className="vc-link"
                          onClick={() =>
                            setExpandedReleases((current) =>
                              current.includes(release.tagName)
                                ? current.filter((name) => name !== release.tagName)
                                : [...current, release.tagName],
                            )
                          }
                        >
                          {expanded ? tr("收起", "Collapse") : tr("展开", "Expand")}
                        </button>
                      ) : null}
                    </>
                  ) : null}
                </div>
              );
            })}
          </div>

          {(api.releases?.tagsWithoutRelease.length ?? 0) > 0 ? (
            <div className="vc-p2-section">
              <div className="vc-p2-label">{tr("尚无 Release 的本地标签", "Local tags without a release")}</div>
              <div className="vc-p2-tag-actions">
                {(api.releases?.tagsWithoutRelease ?? []).map((name) => (
                  <button key={name} type="button" className="vc-chip" onClick={() => setReleaseTagName(name)}>
                    {name}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <div className="vc-p2-section">
            <div className="vc-p2-label">{tr("创建发布", "Create a release")}</div>
            <input
              className="vc-input"
              list="vc-p2-release-tags"
              placeholder={tr("标签或版本，如 v1.0.0", "Tag or version, e.g. v1.0.0")}
              aria-label={tr("标签或版本", "Tag or version")}
              value={releaseTagName}
              onChange={(event) => setReleaseTagName(event.target.value)}
            />
            <datalist id="vc-p2-release-tags">
              {api.tags.map((tag) => <option key={tag.name} value={tag.name} />)}
            </datalist>
            <input
              className="vc-input"
              placeholder={tr("名称（可选）", "Name (optional)")}
              aria-label={tr("发布名称", "Release name")}
              value={releaseName}
              onChange={(event) => setReleaseName(event.target.value)}
            />
            <textarea
              className="vc-input vc-p2-textarea"
              placeholder={tr("说明", "Release notes")}
              aria-label={tr("发布说明", "Release notes")}
              value={releaseBody}
              onChange={(event) => setReleaseBody(event.target.value)}
            />
            <input
              className="vc-input"
              placeholder={tr("目标提交", "Target commit")}
              aria-label={tr("发布目标提交", "Release target commit")}
              value={releaseTarget}
              disabled={releaseTagExists}
              onChange={(event) => setReleaseTarget(event.target.value)}
            />
            <p className="vc-hint">
              {releaseTagExists
                ? tr("标签已存在，发布会指向该标签已有的提交。", "The tag already exists; the release uses the commit that tag points to.")
                : tr("标签不存在时按目标提交创建，留空表示使用当前 HEAD。", "If the tag does not exist it is created at the target commit; empty means the current HEAD.")}
            </p>
            <div className="vc-p2-tag-actions">
              <label className="vc-p2-check">
                <input type="checkbox" checked={releaseDraft} onChange={(event) => setReleaseDraft(event.target.checked)} />
                {tr("草稿", "Draft")}
              </label>
              <label className="vc-p2-check">
                <input type="checkbox" checked={releasePrerelease} onChange={(event) => setReleasePrerelease(event.target.checked)} />
                {tr("预发布", "Pre-release")}
              </label>
            </div>
            <div className="vc-p2-foot">
              <button
                type="button"
                className="vc-btn vc-btn-primary"
                disabled={api.busy !== null || !releaseTagName.trim()}
                onClick={() => void submitRelease()}
              >
                {tr("创建发布", "Create release")}
              </button>
            </div>
            <p className="vc-hint">
              {tr(
                "创建发布会写入 GitHub；标签不存在时按目标提交新建标签。",
                "Creating a release writes to GitHub; a missing tag is created at the target commit.",
              )}
            </p>
            {releaseResult ? (
              <div className={releaseResult.ok ? "vc-p2-note" : "vc-p2-error"} role={releaseResult.ok ? "status" : "alert"}>
                {releaseResult.message}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {tab === "notes" ? (
        <div className="vc-p2-body">
          <div className="vc-p2-section">
            <div className="vc-p2-label">{tr("版本区间", "Version range")}</div>
            <select
              className="vc-select"
              aria-label={tr("上一版本", "Previous version")}
              value={baseTagValue}
              onChange={(event) => setBaseTagChoice(event.target.value)}
            >
              <option value="">{tr("首次发布（不使用上一版本）", "First release (no previous version)")}</option>
              {api.tags.map((tag) => (
                <option key={tag.name} value={tag.name}>
                  {tag.at !== null ? `${tag.name} · ${formatDateOnly(tag.at, locale)}` : tag.name}
                </option>
              ))}
            </select>
            {defaultBase && !suggestedBase && !api.tagsLoading ? (
              <div className="vc-p2-note">
                {tr(
                  `建议的上一版本 ${defaultBase} 不在本地标签中，请手动确认区间起点。`,
                  `The suggested previous version ${defaultBase} is not among the local tags; confirm the range start manually.`,
                )}
              </div>
            ) : null}
            <input
              className="vc-input"
              placeholder={tr("本次版本，如 v1.1.0", "This version, e.g. v1.1.0")}
              aria-label={tr("本次版本", "This version")}
              value={targetTag}
              onChange={(event) => setTargetTag(event.target.value)}
            />
            {suggestedTarget && suggestedTarget === targetTag ? (
              <p className="vc-hint">
                {tr(
                  `本次版本按上一版本 ${suggestedTarget} 递增 patch 得出，请按实际发布核对。`,
                  `The version ${suggestedTarget} bumps the patch of the previous version; verify it against the actual release.`,
                )}
              </p>
            ) : null}
            <textarea
              className="vc-input vc-p2-textarea"
              placeholder={tr("人工说明（可选）", "Manual notes (optional)")}
              aria-label={tr("人工说明", "Manual notes")}
              value={manualNotes}
              onChange={(event) => setManualNotes(event.target.value)}
            />
            <p className="vc-hint">
              {tr("你的补充说明，会原样保留其来源。", "Your supplementary notes; their source is kept as-is.")}
            </p>
            <div className="vc-p2-foot">
              <button
                type="button"
                className="vc-btn"
                disabled={scopeLoading || !targetTag.trim()}
                onClick={() => void loadScope()}
              >
                {scopeLoading ? tr("读取中…", "Loading…") : tr("读取版本区间", "Load version range")}
              </button>
            </div>
            {scopeFailed ? (
              <div className="vc-p2-error" role="alert">
                {tr("没有读到版本区间数据，请重试。", "No version range data was returned. Try again.")}
              </div>
            ) : null}
          </div>

          {scope ? (
            <div className="vc-p2-section">
              <div className="vc-p2-label">{tr("区间数据", "Range data")}</div>
              <div className="vc-p2-meta">
                <span>
                  {tr("区间", "Range")}{" "}
                  <b>{scope.baseTag ?? tr("首次发布", "First release")} → {scope.targetTag}</b>
                </span>
                {scope.headSha ? (
                  <span>{tr("目标提交", "Target commit")} <b><code className="vc-sha">{scope.headSha.slice(0, 7)}</code></b></span>
                ) : null}
                <span>{tr("提交", "Commits")} <b>{scope.commitCount}</b></span>
                <span>{tr("PR", "Pull requests")} <b>{scope.pullRequests.length}</b></span>
                <span>{tr("文件", "Files")} <b>{scope.fileCount}</b></span>
                <span>
                  {tr("行变化", "Lines")}{" "}
                  <b><span className="vc-plus">+{scope.addedLines}</span> <span className="vc-minus">−{scope.deletedLines}</span></b>
                </span>
                {scope.contributors.length > 0 ? (
                  <span>
                    {tr("贡献者", "Contributors")}{" "}
                    <b>{scope.contributors.join(locale === "en" ? ", " : "、")}</b>
                  </span>
                ) : null}
              </div>
              {scope.pullRequests.length > 0 ? (
                <div className="vc-p2-tag-actions">
                  {scope.pullRequests.slice(0, releasePullPreviewCount).map((pull) => (
                    <a key={pull.number} className="vc-link" href={pull.url} target="_blank" rel="noreferrer">
                      #{pull.number} {pull.title}
                    </a>
                  ))}
                  {scope.pullRequests.length > releasePullPreviewCount ? (
                    <span className="vc-hint">
                      {tr(
                        `还有 ${scope.pullRequests.length - releasePullPreviewCount} 个 PR`,
                        `${scope.pullRequests.length - releasePullPreviewCount} more pull requests`,
                      )}
                    </span>
                  ) : null}
                </div>
              ) : null}
              {scope.error ? <div className="vc-p2-error" role="alert">{scope.error}</div> : null}
              {scope.diffTruncated ? (
                <div className="vc-p2-warn">
                  {tr("差异过大，已截断（生成依据会明确标注）", "The diff is large and was truncated (the basis will say so).")}
                </div>
              ) : null}
              {scope.baseTag && scope.baseSha === null && !scope.error ? (
                <div className="vc-p2-warn">
                  {tr("没有找到上一版本对应的提交，请核对区间起点。", "No commit was found for the previous version; check the range start.")}
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="vc-p2-section">
            <div className="vc-p2-label"><SparkIcon size={11} /> {tr("生成发布说明", "Generate release notes")}</div>
            <div className="vc-p2-note">
              {tr(
                "生成不会创建标签或发布；结果是候选，采用后仍需在「发布」页签手动创建。",
                "Generation never creates tags or releases; the result is a candidate, and the release is still created manually on the Releases tab.",
              )}
            </div>
            <div className="vc-p2-foot">
              <button
                type="button"
                className="vc-btn vc-btn-ai"
                disabled={!scope || Boolean(scope.error) || ai.state.running}
                onClick={() => void generate("generate", null)}
              >
                <SparkIcon size={12} />
                {ai.state.running ? tr("正在生成…", "Generating…") : tr("生成发布说明", "Generate release notes")}
              </button>
            </div>
            <AiAssist
              state={ai.state}
              disabled={!scope || Boolean(scope.error)}
              hint={
                scope && !scope.error
                  ? tr(
                    `依据 ${scope.baseTag ?? tr("首次发布", "the first release")} → ${scope.targetTag} 的 ${scope.commitCount} 个提交 · 结果可编辑`,
                    `Based on ${scope.commitCount} commits from ${scope.baseTag ?? "the first release"} to ${scope.targetTag} · editable`,
                  )
                  : tr("先读取版本区间", "Load the version range first")
              }
              hasText={Boolean(draftTitle.trim() || draftBody.trim())}
              onGenerate={(action, instruction) => void generate(action, instruction)}
              onApply={(generated) => applyCandidate(generated)}
              onDismiss={ai.dismissResult}
              onCancel={ai.cancel}
            />
            {ai.state.stale ? (
              <div className="vc-p2-warn">{tr("依据已过期，采用前请核对", "The basis changed; review before applying.")}</div>
            ) : null}
          </div>

          <div className="vc-p2-section">
            <div className="vc-p2-label">{tr("发布说明草稿", "Release notes draft")}</div>
            <input
              className="vc-input"
              placeholder={tr("版本或标题", "Version or title")}
              aria-label={tr("发布说明标题", "Release notes title")}
              value={draftTitle}
              onChange={(event) => setDraftTitle(event.target.value)}
            />
            <textarea
              className="vc-input vc-p2-textarea"
              aria-label={tr("发布说明正文", "Release notes body")}
              value={draftBody}
              onChange={(event) => setDraftBody(event.target.value)}
            />
            <div className="vc-p2-foot">
              <button
                type="button"
                className="vc-btn vc-btn-ghost"
                disabled={!draftTitle.trim() && !draftBody.trim()}
                onClick={copyDraft}
              >
                <CopyIcon size={12} /> {tr("复制", "Copy")}
              </button>
              <button
                type="button"
                className="vc-btn"
                disabled={!draftTitle.trim() && !draftBody.trim()}
                onClick={fillReleaseForm}
              >
                {tr("填入发布表单", "Fill the release form")}
              </button>
            </div>
            <p className="vc-hint">
              {tr(
                "人工修改会保留；创建发布仍需在「发布」页签点击创建发布。",
                "Manual edits are kept; creating the release still requires clicking Create release on the Releases tab.",
              )}
            </p>
            {copyNotice ? <div className="vc-p2-note" role="status">{copyNotice}</div> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
