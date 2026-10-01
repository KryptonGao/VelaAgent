import type {
  GitReleaseCommitRef,
  GitReleaseCreateInput,
  GitReleaseCreateResult,
  GitReleaseInfo,
  GitReleaseListResult,
  GitReleaseNotesScope,
  GitReleasePullRef,
  GitTagCreateInput,
  GitTagCreateResult,
  GitTagInfo,
  GitTagListResult,
} from "@vela/shared";
import { classifyGhFailure, ghFailureMessage, runGh } from "./gh-run";
import { parseGithubSlug } from "./github-url";
import { assertSafeName, gitQuery, runGit } from "./git-run";
import { resolveCommit } from "./git-state";

/** Tag 与 Release (RL-01) 以及发布说明的版本区间数据 (AI-12)。 */

const fieldSeparator = "\x1f";
const maxTagCount = 500;
const maxReleaseScopeDiffLength = 400_000;
const maxReleaseCommits = 300;
const remoteProbeTimeoutMs = 8_000;

const tagRefFormat = [
  "%(refname:short)",
  "%(objectname)",
  "%(objecttype)",
  "%(*objectname)",
  "%(creatordate:unix)",
  "%(taggername)",
  "%(subject)",
  "%(*subject)",
].join("\t");

/** 标签名校验:git ref 规则 + 参数注入防护。 */
export async function assertValidTagName(cwd: string, name: string): Promise<string> {
  const safe = assertSafeName(name.trim(), "标签名");
  const result = await runGit(cwd, ["check-ref-format", `refs/tags/${safe}`]);
  if (result.code !== 0) throw new Error("标签名不正确");
  return safe;
}

/** RL-01:列出标签及其推送状态(推送状态读取失败时为未知 null)。 */
export async function listTags(cwd: string): Promise<GitTagListResult> {
  const stdout = await gitQuery(cwd, [
    "for-each-ref",
    "--sort=-creatordate",
    `--format=${tagRefFormat}`,
    "refs/tags",
  ]);
  const rows = stdout.split("\n").filter((line) => line.trim().length > 0);
  const truncated = rows.length > maxTagCount;
  const remote = await pickRemote(cwd);
  const pushed = await remoteTagShas(cwd, remote);
  const tags = rows.slice(0, maxTagCount).map((line) => toTagInfo(line, pushed));
  return {
    ok: true,
    message: tags.length > 0 ? `共 ${rows.length} 个标签` : "当前仓库还没有标签",
    tags,
    total: rows.length,
    truncated,
  };
}

/** RL-01:创建轻量/附注标签,可选显式推送到指定远程。 */
export async function createTag(cwd: string, input: GitTagCreateInput): Promise<GitTagCreateResult> {
  const name = await assertValidTagName(cwd, input.name);
  const rawTarget = input.target?.trim() ?? "";
  const target = rawTarget
    ? await resolveCommit(cwd, assertSafeName(rawTarget, "目标提交"))
    : await resolveCommit(cwd, "HEAD");
  if (!target) return tagFailure("找不到标签目标提交");
  const exists = await runGit(cwd, ["show-ref", "--verify", "--quiet", `refs/tags/${name}`]);
  if (exists.code === 0) return tagFailure(`标签 ${name} 已经存在`);

  const message = input.message?.trim() ?? "";
  const args = ["tag"];
  if (message) args.push("-a", name, "--file", "-", target);
  else args.push(name, target);
  const created = await runGit(cwd, args, 60_000, message ? `${message}\n` : undefined);
  if (created.code !== 0) {
    return tagFailure(firstLine(created.stderr) ?? firstLine(created.stdout) ?? "创建标签失败");
  }

  let pushed = false;
  let pushMessage = "";
  if (input.push) {
    const remote = input.remote?.trim() || (await pickRemote(cwd));
    if (!remote) {
      pushMessage = "；本地标签已创建，但没有可用的远程，未推送";
    } else {
      const push = await runGit(cwd, ["push", remote, `refs/tags/${name}`], 60_000);
      pushed = push.code === 0;
      pushMessage = pushed
        ? `，并已推送到 ${remote}`
        : `；推送失败：${firstLine(push.stderr) ?? "未知原因"}`;
    }
  }
  const tag = (await listTags(cwd)).tags.find((entry) => entry.name === name) ?? null;
  return {
    ok: true,
    message: `${message ? "已创建附注标签" : "已创建轻量标签"} ${name} → ${target.slice(0, 7)}${pushMessage}`,
    tag,
    pushed,
    output: [created.stdout, created.stderr].filter(Boolean).join("\n"),
  };
}

/** RL-01:删除标签;本地与远程删除分开处理。 */
export async function deleteTag(
  cwd: string,
  name: string,
  remote?: string | null,
): Promise<GitTagCreateResult> {
  const safe = await assertValidTagName(cwd, name);
  const local = await runGit(cwd, ["tag", "-d", safe], 30_000);
  if (local.code !== 0) {
    return tagFailure(firstLine(local.stderr) ?? "删除本地标签失败");
  }
  let message = `已删除本地标签 ${safe}`;
  const target = remote?.trim() ?? "";
  if (target) {
    assertSafeName(target, "远程名");
    const push = await runGit(cwd, ["push", target, `:refs/tags/${safe}`], 60_000);
    message = push.code === 0
      ? `${message}，并已删除远程 ${target} 上的同名标签`
      : `${message}；删除远程标签失败：${firstLine(push.stderr) ?? "未知原因"}`;
  }
  return { ok: true, message, tag: null, pushed: false, output: local.stdout };
}

/** RL-01:读取 GitHub Release 与尚无 Release 的本地标签。 */
export async function listReleases(cwd: string): Promise<GitReleaseListResult> {
  const slug = await resolveSlug(cwd);
  const tags = (await listTags(cwd).catch(() => null))?.tags ?? [];
  if (!slug) {
    return {
      ok: false,
      message: "当前仓库没有可识别的 GitHub 远程，无法读取 Release",
      ghAvailable: true,
      releases: [],
      tagsWithoutRelease: tags.map((tag) => tag.name),
    };
  }
  const result = await runGh(cwd, ["api", `repos/${slug}/releases?per_page=100`], 30_000);
  if (!result.ok) {
    const kind = classifyGhFailure(result);
    return {
      ok: false,
      message: ghFailureMessage(kind, result),
      ghAvailable: kind !== "no-gh",
      releases: [],
      tagsWithoutRelease: tags.map((tag) => tag.name),
    };
  }
  const releases = parseReleases(result.stdout);
  const released = new Set(releases.map((release) => release.tagName));
  return {
    ok: true,
    message: releases.length > 0 ? `共 ${releases.length} 条发布记录` : "还没有发布记录",
    ghAvailable: true,
    releases,
    tagsWithoutRelease: tags.map((tag) => tag.name).filter((name) => !released.has(name)),
  };
}

/** RL-01:创建 Release;指向选定的提交或已有标签。 */
export async function createRelease(
  cwd: string,
  input: GitReleaseCreateInput,
): Promise<GitReleaseCreateResult> {
  const tagName = input.tagName.trim();
  if (!tagName) return { ok: false, message: "请填写标签或版本号", release: null };
  const existingTag = await runGit(cwd, ["show-ref", "--verify", "--quiet", `refs/tags/${tagName}`]);
  const tagExists = existingTag.code === 0;
  if (!tagExists) {
    await assertValidTagName(cwd, tagName);
  }
  const target = input.target?.trim() ?? "";
  const args = ["release", "create", tagName, "--notes-file", "-"];
  const title = input.name?.trim() ?? "";
  if (title) args.push("--title", title);
  if (!tagExists && target) {
    const sha = await resolveCommit(cwd, assertSafeName(target, "目标提交"));
    if (!sha) return { ok: false, message: "找不到发布目标提交", release: null };
    args.push("--target", sha);
  }
  if (input.draft) args.push("--draft");
  if (input.prerelease) args.push("--prerelease");

  const result = await runGh(cwd, args, 60_000, input.body ?? "");
  if (!result.ok) {
    const kind = classifyGhFailure(result);
    return { ok: false, message: ghFailureMessage(kind, result), release: null };
  }
  const list = await listReleases(cwd).catch(() => null);
  const release = list?.releases.find((entry) => entry.tagName === tagName) ?? null;
  return {
    ok: true,
    message: release
      ? `已创建 ${input.draft ? "草稿 " : ""}发布 ${tagName}`
      : `已创建发布 ${tagName}，请刷新查看发布记录`,
    release,
  };
}

/** AI-12:按指定版本区间收集可核对的发布说明依据。 */
export async function getReleaseNotesScope(
  cwd: string,
  baseTagInput: string | null,
  targetTagInput: string,
): Promise<GitReleaseNotesScope> {
  const targetTag = targetTagInput.trim();
  const baseTag = baseTagInput?.trim() || null;
  const headSha = (await resolveCommit(cwd, targetTag)) ?? (await resolveCommit(cwd, "HEAD"));
  const baseSha = baseTag ? await resolveCommit(cwd, baseTag) : null;
  const range = baseSha && headSha ? `${baseSha}..${headSha}` : (headSha ?? "HEAD");

  const empty = (error: string | null): GitReleaseNotesScope => ({
    baseTag,
    targetTag,
    baseSha,
    headSha,
    commits: [],
    commitCount: 0,
    pullRequests: [],
    contributors: [],
    fileCount: 0,
    addedLines: 0,
    deletedLines: 0,
    diff: "",
    diffTruncated: false,
    previousNotes: null,
    manualNotes: null,
    error,
  });

  if (!headSha) return empty("找不到发布目标提交");
  if (baseTag && !baseSha) {
    return empty(`找不到版本区间起点 ${baseTag}，请选择正确的上一版本`);
  }

  const logArgs = [
    "log",
    `--max-count=${maxReleaseCommits}`,
    `--format=%H${fieldSeparator}%h${fieldSeparator}%s${fieldSeparator}%an${fieldSeparator}%at${fieldSeparator}%P`,
    range,
  ];
  const commits = await gitQuery(cwd, logArgs)
    .then((stdout) => stdout.split("\n").filter((line) => line.trim()).map(toReleaseCommit))
    .catch(() => [] as GitReleaseCommitRef[]);
  const rangeShas = new Set(commits.map((commit) => commit.sha));

  const numstatArgs = baseSha && headSha ? ["diff", "--numstat", "-z", baseSha, headSha] : null;
  const stats = numstatArgs
    ? await gitQuery(cwd, numstatArgs)
        .then((stdout) => parseTotals(stdout))
        .catch(() => ({ files: 0, added: 0, deleted: 0 }))
    : { files: 0, added: 0, deleted: 0 };
  const rawDiff = baseSha && headSha
    ? await gitQuery(cwd, ["diff", baseSha, headSha]).catch(() => "")
    : "";
  const truncated = truncateTextPrefix(rawDiff, maxReleaseScopeDiffLength);

  const pullRequests = await listRangePulls(cwd, rangeShas);
  const previousNotes = baseTag ? await releaseNotes(cwd, baseTag) : null;
  const contributors = [...new Set(commits.map((commit) => commit.authorName).filter(Boolean))];

  return {
    baseTag,
    targetTag,
    baseSha,
    headSha,
    commits,
    commitCount: commits.length,
    pullRequests,
    contributors,
    fileCount: stats.files,
    addedLines: stats.added,
    deletedLines: stats.deleted,
    diff: truncated.text,
    diffTruncated: truncated.truncated,
    previousNotes,
    manualNotes: null,
    error: null,
  };
}

// ---------- 内部工具 ----------

function tagFailure(message: string): GitTagCreateResult {
  return { ok: false, message, tag: null, pushed: false, output: "" };
}

function toTagInfo(line: string, pushed: Map<string, string[]> | null): GitTagInfo {
  const [name = "", objectSha = "", objectType = "", derefSha = "", createdAt = "", tagger = "", subject = "", targetSubject = ""] =
    line.split("\t");
  const sha = derefSha || objectSha;
  const seconds = Number.parseInt(createdAt, 10);
  const remotes = pushed?.get(objectSha) ?? [];
  return {
    name,
    sha,
    shortSha: sha.slice(0, 7),
    annotated: objectType === "tag",
    taggerName: tagger || null,
    at: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null,
    subject: subject || null,
    message: objectType === "tag" ? subject || null : null,
    targetSubject: targetSubject || subject || null,
    pushed: pushed === null ? null : remotes.length > 0,
    remotes,
  };
}

/** 远程标签 SHA 列表;读取失败返回 null(表示推送状态未知)。 */
async function remoteTagShas(cwd: string, remote: string | null): Promise<Map<string, string[]> | null> {
  if (!remote) return null;
  const result = await runGit(cwd, ["ls-remote", "--tags", remote], remoteProbeTimeoutMs);
  if (result.code !== 0) return null;
  const map = new Map<string, string[]>();
  for (const line of result.stdout.split("\n")) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (!sha || !ref || ref.endsWith("^{}")) continue;
    const list = map.get(sha) ?? [];
    list.push(remote);
    map.set(sha, list);
  }
  return map;
}

async function pickRemote(cwd: string): Promise<string | null> {
  const names = await gitQuery(cwd, ["remote"])
    .then((stdout) => stdout.split("\n").map((line) => line.trim()).filter(Boolean))
    .catch(() => [] as string[]);
  if (names.length === 0) return null;
  if (names.includes("origin")) return "origin";
  for (const name of names) {
    const url = await gitQuery(cwd, ["remote", "get-url", name]).catch(() => "");
    if (parseGithubSlug(url.trim())) return name;
  }
  return names[0]!;
}

async function resolveSlug(cwd: string): Promise<string | null> {
  const remote = await pickRemote(cwd);
  if (!remote) return null;
  const url = await gitQuery(cwd, ["remote", "get-url", remote]).catch(() => "");
  return parseGithubSlug(url.trim());
}

function parseReleases(stdout: string): GitReleaseInfo[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const releases = parsed
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    .map((entry) => ({
      tagName: text(entry, "tag_name") ?? "",
      name: text(entry, "name"),
      url: text(entry, "html_url") ?? "",
      draft: entry.draft === true,
      prerelease: entry.prerelease === true,
      isLatest: false,
      createdAt: timestamp(entry, "created_at"),
      publishedAt: timestamp(entry, "published_at"),
      body: text(entry, "body") ?? "",
      author: isRecord(entry.author) ? text(entry.author, "login") : null,
    }))
    .filter((entry) => entry.tagName.length > 0);
  const latest = releases
    .filter((entry) => !entry.draft && !entry.prerelease && entry.publishedAt !== null)
    .sort((left, right) => (right.publishedAt ?? 0) - (left.publishedAt ?? 0))[0];
  if (latest) latest.isLatest = true;
  return releases;
}

async function releaseNotes(cwd: string, tag: string): Promise<string | null> {
  const result = await runGh(cwd, ["release", "view", tag, "--json", "body"], 20_000);
  if (!result.ok) return null;
  try {
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    return text(parsed, "body");
  } catch {
    return null;
  }
}

/** 区间内合并的 PR:用合并提交是否落在区间内判断,而不是按时间猜测。 */
async function listRangePulls(
  cwd: string,
  rangeShas: Set<string>,
): Promise<GitReleasePullRef[]> {
  if (rangeShas.size === 0) return [];
  const result = await runGh(
    cwd,
    ["pr", "list", "--state", "merged", "--limit", "100", "--json", "number,title,url,author,mergedAt,mergeCommit"],
    30_000,
  );
  if (!result.ok) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const pulls: GitReleasePullRef[] = [];
  for (const entry of parsed) {
    if (!isRecord(entry)) continue;
    const mergeCommit = isRecord(entry.mergeCommit) ? text(entry.mergeCommit, "oid") : null;
    if (!mergeCommit || !rangeShas.has(mergeCommit)) continue;
    const number = entry.number;
    if (typeof number !== "number") continue;
    pulls.push({
      number,
      title: text(entry, "title") ?? "",
      author: isRecord(entry.author) ? text(entry.author, "login") : null,
      url: text(entry, "url") ?? "",
      mergedAt: timestamp(entry, "mergedAt"),
    });
  }
  return pulls.sort((left, right) => left.number - right.number);
}

function toReleaseCommit(line: string): GitReleaseCommitRef {
  const [sha = "", shortSha = "", subject = "", authorName = "", authorAt = "", parents = ""] =
    line.split(fieldSeparator);
  const seconds = Number.parseInt(authorAt, 10);
  return {
    sha,
    shortSha: shortSha || sha.slice(0, 7),
    subject,
    authorName,
    authorAt: Number.isFinite(seconds) ? seconds * 1000 : 0,
    merge: parents.split(" ").filter(Boolean).length > 1,
  };
}

function parseTotals(stdout: string): { files: number; added: number; deleted: number } {
  let files = 0;
  let added = 0;
  let deleted = 0;
  for (const record of stdout.split("\0")) {
    if (!record) continue;
    const tabs = record.split("\t");
    if (tabs.length < 3) continue;
    files += 1;
    added += tabs[0] === "-" ? 0 : Number(tabs[0]) || 0;
    deleted += tabs[1] === "-" ? 0 : Number(tabs[1]) || 0;
  }
  return { files, added, deleted };
}

function truncateTextPrefix(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  const buffer = Buffer.from(text, "utf8").subarray(0, limit);
  return { text: buffer.toString("utf8"), truncated: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function text(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function timestamp(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  if (typeof value !== "string" || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function firstLine(text: string): string | null {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return null;
}
