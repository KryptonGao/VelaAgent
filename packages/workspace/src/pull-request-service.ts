import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, join, relative, sep } from "node:path";
import type {
  GitRemoteTarget,
  GitStatusSnapshot,
  PrAccessState,
  PrCheckDetail,
  PrCheckState,
  PrChecksSummary,
  PrCloseInput,
  PrCloseResult,
  PrCommentInput,
  PrCompareScope,
  PrCreateInput,
  PrCreateResult,
  PrEditOptions,
  PrForkInfo,
  PrIssueLinkInput,
  PrMergeInput,
  PrMergeMethod,
  PrMergePreview,
  PrMergeResult,
  PrRepoRef,
  PrReviewComment,
  PrReviewEvent,
  PrReviewInput,
  PrReviewMutationResult,
  PrReviewState,
  PrReviewSummary,
  PrReviewThread,
  PrReviewThreadsResult,
  PrScopeCommit,
  PrState,
  PrSummary,
  PrTemplateInfo,
  PrThreadResolveInput,
  PrThreadResolveResult,
  PrUpdateInput,
  PrUpdateResult,
  PullRequestInfo,
} from "@vela/shared";
import { runGh, type GhResult } from "./gh-run";
import { gitQuery, runGit } from "./git-run";
import { githubSlug, parseGithubSlug } from "./github-url";
import { matchRemotePrefix } from "./git-remote";

const cacheTtlMs = 30_000;
const ghProbeTtlMs = 30_000;
const templateSizeLimit = 100 * 1024;
const recentPrWindowMs = 5 * 60_000;
const maxBodyLength = 100_000;
/** getScope 返回的 diff 上限(供 PR 文案 AI 使用);截断保证 UTF-8 安全。 */
const maxScopeDiffLength = 400_000;

/**
 * gh pr list/view 统一使用的字段;顺序固定便于排查。
 * baseRepository 不在 gh 支持的 JSON 字段里(只有 headRepository),请求它会让
 * 整条命令以 unknown field 失败,因此这里只保留 gh 实际支持的字段。
 */
const prJsonFields = [
  "number",
  "title",
  "url",
  "state",
  "isDraft",
  "baseRefName",
  "headRefName",
  "headRepository",
  "reviewDecision",
  "statusCheckRollup",
  "reviews",
  "reviewRequests",
  "labels",
  "assignees",
  "closingIssuesReferences",
  "updatedAt",
  "author",
  "additions",
  "deletions",
  "changedFiles",
  "body",
].join(",");

/** 追加 headRefOid:记录预期 head、判断审阅是否过期都需要(PR-06/PR-07)。 */
const prJsonFieldsWithHead = `${prJsonFields},headRefOid`;

const prJsonFieldsWithCreatedAt = `${prJsonFieldsWithHead},createdAt`;

/** PR-07:合并前核对必须读取的 PR 字段。 */
const mergePreviewPrFields = [
  "number",
  "url",
  "state",
  "isDraft",
  "baseRefName",
  "headRefName",
  "headRefOid",
  "mergeable",
  "mergeStateStatus",
  "reviewDecision",
  "reviews",
  "statusCheckRollup",
].join(",");

/**
 * PR-07:仓库允许的合并方式与提交标题风格。
 * 注意:gh repo view 目前并不支持提交标题字段,首次读取失败后会退回
 * mergeRepoFieldsFallback(其中 viewerDefaultMergeMethod 是仓库默认方式)。
 */
const mergeRepoFields = [
  "mergeCommitAllowed",
  "squashMergeAllowed",
  "rebaseMergeAllowed",
  "squashMergeCommitTitle",
  "mergeCommitTitle",
].join(",");

/** gh repo view 实际可用的合并相关字段。 */
const mergeRepoFieldsFallback = [
  "mergeCommitAllowed",
  "squashMergeAllowed",
  "rebaseMergeAllowed",
  "viewerDefaultMergeMethod",
].join(",");

/** PR-07:这些 mergeStateStatus 表示 GitHub 当前规则不允许合并。 */
const blockingMergeStates = new Set(["BLOCKED", "BEHIND", "DIRTY", "DRAFT", "UNSTABLE", "UNKNOWN"]);

/**
 * PR-06:一次取回线程、评论与审阅结论。
 * 线程 id 等标识一律走 GraphQL 变量,不拼进查询字符串。
 * 线程本身没有 originalCommit 字段,代码版本取自首条评论。
 */
const reviewThreadsQuery = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      headRefOid
      reviewDecision
      reviewRequests(first: 50) {
        nodes {
          requestedReviewer {
            ... on User {
              login
            }
          }
        }
      }
      reviews(first: 100) {
        nodes {
          author {
            login
          }
          state
          body
          submittedAt
          url
          commit {
            oid
          }
        }
      }
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          viewerCanResolve
          viewerCanUnresolve
          resolvedBy {
            login
          }
          comments(first: 100) {
            nodes {
              id
              author {
                login
              }
              body
              createdAt
              url
              diffHunk
              outdated
              path
              line
              originalCommit {
                oid
              }
              commit {
                oid
              }
              replyTo {
                id
              }
              pullRequestReview {
                state
              }
            }
          }
        }
      }
    }
  }
}`;

/** PR-06:解决线程;threadId 只作为变量传入。 */
const resolveThreadMutation = `mutation($id: ID!) {
  resolveReviewThread(input: { threadId: $id }) {
    thread {
      id
      isResolved
    }
  }
}`;

/** PR-06:重新打开线程;threadId 只作为变量传入。 */
const unresolveThreadMutation = `mutation($id: ID!) {
  unresolveReviewThread(input: { threadId: $id }) {
    thread {
      id
      isResolved
    }
  }
}`;

type GhFailureKind = "unauthenticated" | "permission" | "offline" | "failed";

type GhProbeState = "ok" | "no-gh" | "unauthenticated" | "permission" | "offline" | "failed";

interface GhProbe {
  state: GhProbeState;
  reason: string | null;
  checkedAt: number;
}

interface PrContext {
  repo: PrRepoRef | null;
  defaultBase: string;
  baseOptions: string[];
  headRemote: string | null;
  fork: PrForkInfo | null;
}

/** PR-07:合并核对用的原始 gh 数据;repo 为 null 表示仓库设置未能读取。 */
interface MergeFacts {
  pr: Record<string, unknown> | null;
  repo: Record<string, unknown> | null;
  error: string | null;
}

/**
 * 通过 gh CLI 读取当前分支的 Pull Request;gh 不可用时降级为
 * 打开 GitHub 网页(创建 PR 跳转 compare 页)。
 *
 * 状态拆分:no-gh / unauthenticated / permission / offline / failed / no-pr / ok,
 * 避免把认证或网络失败误报成「暂无 PR」。
 */
export class PullRequestService {
  private probe: GhProbe | null = null;
  /** 最近一次成功结果;key = 工作区路径 + 分支,TTL 30s。 */
  private cache: { key: string; info: PullRequestInfo } | null = null;
  private cwdProvider: (() => string | null) | null = null;
  /**
   * 最近一次观察到的各 PR head SHA(PR-06/PR-07):用于判断审阅是否过期、
   * previousHeadSha,以及合并预览里的预期 head。
   */
  private readonly headShas = new Map<number, string>();
  /** 已确认可用的 gh repo view 合并字段集(PR-07);null 表示尚未探测。 */
  private repoMergeFields: string | null = null;

  constructor(
    private readonly getSnapshot: () => GitStatusSnapshot | null,
    private readonly openExternal: (url: string) => void,
  ) {}

  /** 由组装方注入工作区路径,避免与 GitService 相互依赖。 */
  setCwdProvider(provider: () => string | null): void {
    this.cwdProvider = provider;
  }

  /** 命中 TTL 缓存;TTL 内直接返回上次成功结果。 */
  async getForCurrentBranch(): Promise<PullRequestInfo> {
    return this.query(false);
  }

  /** 详情刷新:始终绕过 TTL 缓存;刷新失败时回退到缓存并标记 stale。 */
  async getDetail(): Promise<PullRequestInfo> {
    return this.query(true);
  }

  /** shared 接口命名,等价于 getDetail。 */
  async getPullRequestDetail(): Promise<PullRequestInfo> {
    return this.getDetail();
  }

  async openPr(url: string): Promise<void> {
    if (!/^https:\/\/github\.com\//.test(url)) throw new Error("Pull Request 链接不正确");
    this.openExternal(url);
  }

  /** 打开 compare 页创建 PR;读取默认分支失败时退回 main。 */
  async createPr(): Promise<void> {
    const snapshot = this.getSnapshot();
    const slug = snapshot?.repo ? parseGithubSlug(snapshot.repo.remoteUrl) : null;
    const branch = snapshot?.branch;
    if (!slug || !branch) throw new Error("需要 GitHub 远程仓库和当前分支");
    const base = await this.defaultBranch();
    this.openExternal(
      `https://github.com/${slug}/compare/${base}...${encodeURIComponent(branch)}?expand=1`,
    );
  }

  /** 识别 PR 模板:固定路径按优先级,再补充 .github/PULL_REQUEST_TEMPLATE/ 下的 Markdown。 */
  async listTemplates(): Promise<PrTemplateInfo[]> {
    const snapshot = this.getSnapshot();
    const cwd = this.cwdProvider?.() ?? snapshot?.repo?.root ?? null;
    if (!cwd) return [];

    // 工作区可能是仓库子目录,模板始终相对仓库根解析。
    let root = cwd;
    const topLevel = await gitTry(cwd, ["rev-parse", "--show-toplevel"]);
    if (topLevel) root = topLevel;

    const results: PrTemplateInfo[] = [];
    const seen = new Set<string>();
    const addFile = async (absolutePath: string): Promise<void> => {
      try {
        const fileStat = await stat(absolutePath);
        if (!fileStat.isFile() || fileStat.size > templateSizeLimit) return;
        const real = await realpath(absolutePath).catch(() => absolutePath);
        const dedupeKey = process.platform === "win32" ? real.toLowerCase() : real;
        if (seen.has(dedupeKey)) return;
        const body = await readFile(absolutePath, "utf8");
        if (Buffer.byteLength(body, "utf8") > templateSizeLimit) return;
        seen.add(dedupeKey);
        results.push({
          path: toPosix(relative(root, absolutePath)),
          name: basename(absolutePath, extname(absolutePath)),
          body,
        });
      } catch {
        // 跳过不可读文件
      }
    };

    const fixedPaths = [
      ".github/PULL_REQUEST_TEMPLATE.md",
      ".github/pull_request_template.md",
      "docs/PULL_REQUEST_TEMPLATE.md",
      "PULL_REQUEST_TEMPLATE.md",
    ];
    for (const rel of fixedPaths) {
      await addFile(join(root, ...rel.split("/")));
    }
    const templateDir = join(root, ".github", "PULL_REQUEST_TEMPLATE");
    for (const file of await walkMarkdownFiles(templateDir)) {
      await addFile(file);
    }
    return results;
  }

  /** shared 接口命名,等价于 listTemplates。 */
  async listPrTemplates(): Promise<PrTemplateInfo[]> {
    return this.listTemplates();
  }

  /**
   * 计算 PR 比较范围(GitHub 语义):merge-base..head 的提交与文件统计,
   * 不使用工作区未提交 Diff。
   */
  async getScope(baseInput: string, headInput?: string | null): Promise<PrCompareScope> {
    const base = baseInput.trim();
    const snapshot = this.getSnapshot();
    const cwd = this.cwdProvider?.() ?? snapshot?.repo?.root ?? null;
    const head = (headInput ?? snapshot?.branch ?? "").trim();

    if (!snapshot?.repo) return scopeError(base, head, "当前工作区不是 Git 仓库");
    if (!cwd) return scopeError(base, head, "无法确定工作区路径");
    if (!isValidRefInput(base)) return scopeError(base, head, "base 分支名不正确");
    if (!isValidRefInput(head)) {
      return scopeError(
        base,
        head,
        headInput ? "head 分支名不正确" : "当前处于 detached HEAD,无法确定 head 分支",
      );
    }

    const repo = snapshot.repo;
    const headRemote = resolveHeadRemote(snapshot);
    const headExists = await gitTry(cwd, ["rev-parse", "--verify", "--quiet", `${head}^{commit}`]);
    if (!headExists) return scopeError(base, head, `head 分支 ${head} 不存在`);

    // base 解析优先远程跟踪分支,其次本地分支,最后按原样交给 git。
    const candidates: string[] = [];
    if (headRemote) candidates.push(`refs/remotes/${headRemote}/${base}`);
    candidates.push(`refs/heads/${base}`);
    candidates.push(base);
    let baseRef: string | null = null;
    for (const candidate of candidates) {
      const resolved = await gitTry(cwd, [
        "rev-parse",
        "--verify",
        "--quiet",
        `${candidate}^{commit}`,
      ]);
      if (resolved) {
        baseRef = candidate;
        break;
      }
    }
    if (!baseRef) return scopeError(base, head, `无法解析 base 分支 ${base}`);

    const mergeBase = await gitTry(cwd, ["merge-base", baseRef, head]);
    if (!mergeBase) {
      return scopeError(base, head, `无法找到 ${base} 与 ${head} 的共同祖先`);
    }

    const logOutput =
      (await gitTry(cwd, [
        "log",
        "--reverse",
        "--format=%H%x1f%s%x1f%an",
        `${mergeBase}..${head}`,
      ])) ?? "";
    const commits: PrScopeCommit[] = [];
    for (const line of logOutput.split("\n")) {
      if (!line) continue;
      const parts = line.split("\x1f");
      const sha = parts[0];
      if (!sha) continue;
      commits.push({ sha, subject: parts[1] ?? "", authorName: parts[2] ?? "" });
    }

    const numstat = (await gitTry(cwd, ["diff", "--numstat", mergeBase, head])) ?? "";
    let fileCount = 0;
    let addedLines = 0;
    let deletedLines = 0;
    for (const line of numstat.split("\n")) {
      if (!line) continue;
      const parts = line.split("\t");
      if (parts.length !== 3) continue;
      fileCount += 1;
      addedLines += parseNumstat(parts[0]);
      deletedLines += parseNumstat(parts[1]);
    }

    // headPushed:优先与 upstream 比较,其次与 headRemote 上的同名分支比较。
    const localSha = await gitTry(cwd, ["rev-parse", head]);
    let remoteRef: string | null = null;
    let headPushed = false;
    if (snapshot.upstream) {
      const upstreamSha = await gitTry(cwd, ["rev-parse", snapshot.upstream]);
      if (localSha && upstreamSha) {
        headPushed = localSha === upstreamSha;
        remoteRef = snapshot.upstream;
      }
    } else if (headRemote) {
      const candidate = `refs/remotes/${headRemote}/${head}`;
      const remoteSha = await gitTry(cwd, ["rev-parse", "--verify", "--quiet", candidate]);
      if (localSha && remoteSha) {
        headPushed = localSha === remoteSha;
        remoteRef = candidate;
      }
    }

    let unpushedCount = commits.length;
    if (remoteRef) {
      const counted = await gitTry(cwd, ["rev-list", `${remoteRef}..${head}`, "--count"]);
      if (counted !== null && /^\d+$/.test(counted)) unpushedCount = Number.parseInt(counted, 10);
    }

    // 完整 diff 供 AI 文案使用;超限截断并标记,截断点保证 UTF-8 合法。
    const rawDiff = (await gitTry(cwd, ["diff", "--no-color", "-M", mergeBase, head])) ?? "";
    const truncatedDiff = truncateTextPrefix(rawDiff, maxScopeDiffLength);
    const pushTarget: GitRemoteTarget | null = headRemote
      ? { remote: headRemote, branch: head }
      : null;
    const baseRemoteUrl = findBaseRemoteUrl(snapshot, headRemote);
    const headRemoteUrl = findRemoteFetchUrl(snapshot, headRemote);
    return {
      base,
      head,
      baseRepo: parseGithubSlug(baseRemoteUrl) ?? parseGithubSlug(repo.remoteUrl),
      headRepo: parseGithubSlug(headRemoteUrl) ?? parseGithubSlug(repo.remoteUrl),
      commits,
      fileCount,
      addedLines,
      deletedLines,
      headPushed,
      unpushedCount,
      pushTarget,
      empty: commits.length === 0,
      diff: truncatedDiff.text,
      diffTruncated: truncatedDiff.truncated,
      error: null,
    } as PrCompareScope;
  }

  /** shared 接口命名,等价于 getScope。 */
  async getPrScope(base: string, head?: string | null): Promise<PrCompareScope> {
    return this.getScope(base, head);
  }

  /**
   * 通过 gh 原生创建 PR:先查同分支开放 PR 避免重复;正文经 stdin 传入,
   * 显式指定 repo/base/head/title,绝不使用 --fill。
   */
  async create(input: PrCreateInput): Promise<PrCreateResult> {
    const snapshot = this.getSnapshot();
    const cwd = this.cwdProvider?.() ?? snapshot?.repo?.root ?? null;
    if (!cwd) return createFailure("无法确定工作区路径");

    const base = input.base.trim();
    const head = input.head.trim();
    const baseRepo = input.baseRepo.trim();
    const headRepo = input.headRepo.trim();
    if (!baseRepo || !base || !head) return createFailure("创建 PR 需要 base/head 与目标仓库");
    if (!input.title.trim()) return createFailure("PR 标题不能为空");

    const existing = await this.findOpenPr(cwd, head);
    if (existing) {
      return {
        ok: true,
        step: "create",
        pushed: false,
        pr: existing,
        url: existing.url,
        number: existing.number,
        message: "已存在同分支的开放 PR",
        unconfirmed: false,
      };
    }

    // fork 场景用 <owner>:<branch>;同仓库直接使用分支名。
    const sameRepo = baseRepo.toLowerCase() === headRepo.toLowerCase();
    const headOwner = headRepo.split("/")[0] ?? "";
    const headArg = !sameRepo && headOwner ? `${headOwner}:${head}` : head;
    const args = [
      "pr",
      "create",
      "--repo",
      baseRepo,
      "--base",
      base,
      "--head",
      headArg,
      "--title",
      input.title,
      "--body-file",
      "-",
    ];
    if (input.draft) args.push("--draft");

    const result = await runGh(cwd, args, 60_000, input.body);
    if (result.ok) {
      const url = extractPrUrl(result.stdout);
      const pr = url ? await this.fetchPrByUrl(cwd, url) : null;
      return {
        ok: true,
        step: "create",
        pushed: false,
        pr,
        url: url ?? pr?.url ?? null,
        number: pr?.number ?? numberFromUrl(url),
        message: "Pull Request 已创建",
        unconfirmed: false,
      };
    }

    // 超时或进程被杀时结果不明:先查询远端确认,避免重复创建。
    const unconfirmed = result.timedOut || result.killed;
    if (unconfirmed) {
      const recovered = await this.findRecentPr(cwd, head);
      if (recovered) {
        return {
          ok: true,
          step: "create",
          pushed: false,
          pr: recovered,
          url: recovered.url,
          number: recovered.number,
          message: "创建结果不明确,已查询确认 Pull Request 已创建",
          unconfirmed: false,
        };
      }
    }
    return {
      ok: false,
      step: "create",
      pushed: false,
      pr: null,
      url: null,
      number: null,
      message: describeCreateFailure(result),
      unconfirmed,
    };
  }

  /** shared 接口命名,等价于 create。 */
  async createPullRequestNative(input: PrCreateInput): Promise<PrCreateResult> {
    return this.create(input);
  }

  // ---------- PR 信息维护 (PR-04/PR-05) ----------

  /** 只更新指定编号的 PR;AI 候选内容由界面确认后才传入。 */
  async update(input: PrUpdateInput): Promise<PrUpdateResult> {
    const number = input.number;
    if (!Number.isInteger(number) || number <= 0) return updateFailure("PR 编号不正确");
    const cwd = this.cwdProvider?.() ?? this.getSnapshot()?.repo?.root ?? null;
    if (!cwd) return updateFailure("无法确定工作区路径");

    const title = input.title?.trim() ?? null;
    if (title !== null && !title) return updateFailure("PR 标题不能为空");
    if (title !== null && title.length > 300) return updateFailure("PR 标题过长");
    const body = input.body ?? null;
    if (body !== null && body.length > maxBodyLength) return updateFailure("PR 描述过长");

    const args = ["pr", "edit", String(number)];
    const changes: string[] = [];
    if (title !== null) {
      args.push("--title", title);
      changes.push("标题");
    }
    if (body !== null) {
      args.push("--body-file", "-");
      changes.push("描述");
    }
    const addReviewers = cleanNames(input.addReviewers);
    const removeReviewers = cleanNames(input.removeReviewers);
    const addLabels = cleanNames(input.addLabels);
    const removeLabels = cleanNames(input.removeLabels);
    if (addReviewers.length > 0) {
      args.push("--add-reviewer", addReviewers.join(","));
      changes.push(`审阅者 +${addReviewers.join(", ")}`);
    }
    if (removeReviewers.length > 0) {
      args.push("--remove-reviewer", removeReviewers.join(","));
      changes.push(`审阅者 -${removeReviewers.join(", ")}`);
    }
    if (addLabels.length > 0) {
      args.push("--add-label", addLabels.join(","));
      changes.push(`标签 +${addLabels.join(", ")}`);
    }
    if (removeLabels.length > 0) {
      args.push("--remove-label", removeLabels.join(","));
      changes.push(`标签 -${removeLabels.join(", ")}`);
    }
    if (changes.length === 0) return updateFailure("没有需要更新的内容");

    const result = await runGh(cwd, args, 60_000, body ?? "");
    if (!result.ok) {
      return updateFailure(describeUpdateFailure(result));
    }
    const pr = await this.fetchPrByNumber(cwd, number);
    return {
      ok: true,
      message: `已更新 PR #${number}：${changes.join("、")}`,
      pr,
      changes,
    };
  }

  async markReady(number: number): Promise<PrUpdateResult> {
    if (!Number.isInteger(number) || number <= 0) return updateFailure("PR 编号不正确");
    const cwd = this.cwdProvider?.() ?? this.getSnapshot()?.repo?.root ?? null;
    if (!cwd) return updateFailure("无法确定工作区路径");
    const result = await runGh(cwd, ["pr", "ready", String(number)], 60_000);
    if (!result.ok) return updateFailure(describeUpdateFailure(result));
    return {
      ok: true,
      message: `PR #${number} 已标记为 Ready for review`,
      pr: await this.fetchPrByNumber(cwd, number),
      changes: ["Draft → Ready"],
    };
  }

  /** 按 reference/close 语义把 Issue 写入描述;close 会在合并后自动关闭。 */
  async linkIssues(input: PrIssueLinkInput): Promise<PrUpdateResult> {
    const issues = [...new Set(input.issues.filter((issue) => Number.isInteger(issue) && issue > 0))];
    if (issues.length === 0) return updateFailure("请提供要关联的 Issue 编号");
    if (issues.length > 50) return updateFailure("一次最多关联 50 个 Issue");
    const cwd = this.cwdProvider?.() ?? this.getSnapshot()?.repo?.root ?? null;
    if (!cwd) return updateFailure("无法确定工作区路径");

    const view = await runGh(cwd, ["pr", "view", String(input.number), "--json", "body"], 30_000);
    if (!view.ok) return updateFailure(describeUpdateFailure(view));
    const record = parseJsonObject(view.stdout);
    const currentBody = (record ? readText(record, "body") : null) ?? "";
    const keyword = input.mode === "close" ? "Closes" : "Refs";
    const additions = issues
      .filter((issue) => !new RegExp(`(^|\\n)\\s*(close[sd]?|fix(e[sd])?|resolve[sd]?|refs?|references?)\\s+#${issue}\\b`, "i").test(currentBody))
      .map((issue) => `${keyword} #${issue}`);
    if (additions.length === 0) {
      return {
        ok: true,
        message: "所选 Issue 已经在描述中关联，无需重复添加",
        pr: await this.fetchPrByNumber(cwd, input.number),
        changes: [],
      };
    }
    const nextBody = [currentBody.trimEnd(), additions.join("\n")].filter(Boolean).join("\n\n");
    const result = await runGh(
      cwd,
      ["pr", "edit", String(input.number), "--body-file", "-"],
      60_000,
      nextBody,
    );
    if (!result.ok) return updateFailure(describeUpdateFailure(result));
    return {
      ok: true,
      message:
        input.mode === "close"
          ? `已关联 ${additions.length} 个 Issue，合并后会由 GitHub 自动关闭`
          : `已关联 ${additions.length} 个 Issue（仅引用，不会自动关闭）`,
      pr: await this.fetchPrByNumber(cwd, input.number),
      changes: additions,
    };
  }

  /** 仓库可用的标签与协作者;读取失败时返回空列表,界面允许手动输入。 */
  async getEditOptions(): Promise<PrEditOptions> {
    const cwd = this.cwdProvider?.() ?? this.getSnapshot()?.repo?.root ?? null;
    if (!cwd) return { labels: [], reviewers: [], assignees: [] };
    const slug = await this.resolveRepoSlug(cwd);
    const [labels, collaborators] = await Promise.all([
      runGh(cwd, ["label", "list", "--json", "name", "--limit", "200"], 20_000),
      slug
        ? runGh(cwd, ["api", "--paginate", `repos/${slug}/collaborators`], 30_000)
        : Promise.resolve<GhResult>({ ok: false, stdout: "", stderr: "", timedOut: false, killed: false, spawnError: null }),
    ]);
    const labelNames = parseJsonArray(labels.stdout)
      .filter(isRecord)
      .map((entry) => readText(entry, "name"))
      .filter((name): name is string => Boolean(name));
    const logins = parseJsonArray(collaborators.stdout)
      .map((entry) => (isRecord(entry) ? readText(entry, "login") : null))
      .filter((login): login is string => Boolean(login))
      .sort((a, b) => a.localeCompare(b));
    return { labels: labelNames, reviewers: logins, assignees: logins };
  }

  // ---------- PR 评论、审阅线程与合并关闭 (PR-06/PR-07) ----------

  /** PR-06:读取评论与审阅线程,并标注审阅对应代码版本是否过期。 */
  async getReviewThreads(number?: number | null): Promise<PrReviewThreadsResult> {
    const resolved = await this.resolveNumber(number);
    if (resolved.number === null) {
      return reviewThreadsFailure(resolved.error ?? "无法确定 PR 编号", null);
    }
    const current = resolved.number;

    const cwd = this.cwdProvider?.() ?? this.getSnapshot()?.repo?.root ?? null;
    if (!cwd) return reviewThreadsFailure("无法确定工作区路径", null);
    // previousHeadSha 取本次查询前的记录,再在查询后刷新为最新 head。
    const previousHeadSha = this.lastHeadSha(current);

    const slug = await this.resolveRepoSlug(cwd);
    const owner = slug?.split("/")[0] ?? "";
    const name = slug?.split("/")[1] ?? "";
    if (!owner || !name) return reviewThreadsFailure("无法确定 GitHub 仓库(owner/repo)", previousHeadSha);

    const result = await runGh(
      cwd,
      [
        "api",
        "graphql",
        "-f",
        `query=${reviewThreadsQuery}`,
        "-f",
        `owner=${owner}`,
        "-f",
        `name=${name}`,
        "-F",
        `number=${current}`,
      ],
      30_000,
    );
    if (!result.ok) {
      return reviewThreadsFailure(ghFailureReason(classifyGhFailure(result), result), previousHeadSha);
    }

    const payload = parseJsonObject(result.stdout);
    const pr = readGraphqlPullRequest(payload);
    if (!pr) {
      return reviewThreadsFailure(readGraphqlError(payload) ?? "读取 PR 评论与审阅线程失败", previousHeadSha);
    }

    const headSha = readText(pr, "headRefOid");
    if (headSha) this.rememberHead(current, headSha);
    const reviews = readReviewNodes(pr.reviews, headSha);
    const threads = readNodes(pr.reviewThreads)
      .map(toReviewThread)
      .filter((thread): thread is PrReviewThread => thread !== null);
    const unresolved = threads.filter((thread) => !thread.resolved).length;
    return {
      ok: true,
      message: `PR #${current} 有 ${threads.length} 个审阅线程(${unresolved} 个未解决)、${reviews.length} 条审阅结论`,
      threads,
      reviews,
      reviewDecision: readText(pr, "reviewDecision"),
      pendingReviewers: readPendingReviewers(pr.reviewRequests),
      headSha,
      previousHeadSha,
    };
  }

  /** PR-06:在 PR 会话里发表评论;正文经 stdin 传入,不拼接 shell 字符串。 */
  async comment(input: PrCommentInput): Promise<PrReviewMutationResult> {
    const number = input.number;
    if (!Number.isInteger(number) || number <= 0) return reviewMutationFailure("PR 编号不正确");
    const body = readInputText(input.body);
    if (!body) return reviewMutationFailure("评论内容不能为空");
    if (body.length > maxBodyLength) return reviewMutationFailure("评论内容过长");
    const cwd = this.cwdProvider?.() ?? this.getSnapshot()?.repo?.root ?? null;
    if (!cwd) return reviewMutationFailure("无法确定工作区路径");

    const result = await runGh(cwd, ["pr", "comment", String(number), "--body-file", "-"], 60_000, body);
    if (!result.ok) return reviewMutationFailure(describePrActionFailure(result, "发表评论"));
    return this.refreshAfterMutation(`已在 PR #${number} 发表评论`, number, null);
  }

  /** PR-06:提交审阅结论;指定版本时先核对 head,避免把结论记到别的版本上。 */
  async review(input: PrReviewInput): Promise<PrReviewMutationResult> {
    const number = input.number;
    if (!Number.isInteger(number) || number <= 0) return reviewMutationFailure("PR 编号不正确");
    const event = input.event;
    if (event !== "approve" && event !== "request-changes" && event !== "comment") {
      return reviewMutationFailure("审阅结论不正确");
    }
    const body = readInputText(input.body);
    if (body.length > maxBodyLength) return reviewMutationFailure("审阅内容过长");
    const cwd = this.cwdProvider?.() ?? this.getSnapshot()?.repo?.root ?? null;
    if (!cwd) return reviewMutationFailure("无法确定工作区路径");

    const targetSha = readInputText(input.commitSha);
    if (targetSha) {
      if (!isValidShaInput(targetSha)) return reviewMutationFailure("审阅的提交版本号不正确");
      const currentHead = (await this.fetchHeadSha(cwd, number)) ?? this.lastHeadSha(number);
      if (currentHead && currentHead !== targetSha) {
        return reviewMutationFailure(
          `PR 已有新提交(当前 head ${shortSha(currentHead)}),请基于最新版本重新审阅`,
        );
      }
    }

    const args = ["pr", "review", String(number), reviewEventFlag(event)];
    if (body) args.push("--body-file", "-");
    const result = await runGh(cwd, args, 60_000, body);
    if (!result.ok) return reviewMutationFailure(describePrActionFailure(result, "提交审阅"));

    const fresh = await this.getReviewThreads(number);
    if (!fresh.ok) {
      return {
        ok: true,
        message: `已提交审阅，但审阅结果刷新失败: ${fresh.message}`,
        review: null,
        threads: null,
        reviews: null,
        reviewDecision: null,
      };
    }
    const submitted = pickSubmittedReview(fresh.reviews, event, targetSha || fresh.headSha);
    return {
      ok: true,
      message: reviewMessage(event, number, submitted),
      review: submitted,
      threads: fresh.threads,
      reviews: fresh.reviews,
      reviewDecision: fresh.reviewDecision,
    };
  }

  /** PR-06:解决或重新打开一个审阅线程;threadId 作为 GraphQL 变量传入。 */
  async resolveThread(input: PrThreadResolveInput): Promise<PrThreadResolveResult> {
    const requested = input.resolved === true;
    const rawId = typeof input.threadId === "string" ? input.threadId : "";
    if (!isValidThreadId(rawId)) {
      return { ok: false, message: "审阅线程标识不正确", threadId: rawId, resolved: requested };
    }
    const threadId = rawId.trim();
    const cwd = this.cwdProvider?.() ?? this.getSnapshot()?.repo?.root ?? null;
    if (!cwd) return { ok: false, message: "无法确定工作区路径", threadId, resolved: requested };

    const field = requested ? "resolveReviewThread" : "unresolveReviewThread";
    const result = await runGh(
      cwd,
      ["api", "graphql", "-f", `query=${requested ? resolveThreadMutation : unresolveThreadMutation}`, "-f", `id=${threadId}`],
      30_000,
    );
    if (!result.ok) {
      return { ok: false, message: describePrActionFailure(result, "更新审阅线程"), threadId, resolved: requested };
    }
    const payload = parseJsonObject(result.stdout);
    const thread = readGraphqlMutationThread(payload, field);
    if (!thread) {
      return {
        ok: false,
        message: readGraphqlError(payload) ?? "更新审阅线程失败",
        threadId,
        resolved: requested,
      };
    }
    const resolved = thread.isResolved === undefined ? requested : thread.isResolved === true;
    return {
      ok: true,
      message: resolved ? "审阅线程已标记为已解决" : "审阅线程已重新打开",
      threadId: readText(thread, "id") ?? threadId,
      resolved,
    };
  }

  /** PR-07:合并前核对 GitHub 当前规则与预期 head;检查全绿不等于可合并。 */
  async getMergePreview(number?: number | null): Promise<PrMergePreview> {
    const resolved = await this.resolveNumber(number);
    if (resolved.number === null) return mergePreviewFailure(0, resolved.error ?? "无法确定 PR 编号");
    const current = resolved.number;

    const cwd = this.cwdProvider?.() ?? this.getSnapshot()?.repo?.root ?? null;
    if (!cwd) return mergePreviewFailure(current, "无法确定工作区路径");
    const facts = await this.readMergeFacts(cwd, current);
    if (!facts.pr) return mergePreviewFailure(current, facts.error ?? "读取 PR 合并信息失败");

    const pr = facts.pr;
    const headSha = readText(pr, "headRefOid");
    const remembered = this.lastHeadSha(current);
    const firstObservation = remembered === null;
    const expectedHeadSha = remembered ?? headSha;
    // 读到新的 head 就刷新记录;下次预览即以本次 head 为预期。
    if (headSha) this.rememberHead(current, headSha);
    const headMatches = Boolean(expectedHeadSha && headSha && expectedHeadSha === headSha);

    const state = readPrState(pr);
    const isDraft = pr.isDraft === true || state === "draft";
    const mergeable = mapMergeable(readText(pr, "mergeable"));
    const mergeStateStatus = readText(pr, "mergeStateStatus")?.toUpperCase() ?? null;
    const reviewDecision = readText(pr, "reviewDecision");
    const reviews = readReviewNodes(pr.reviews, headSha);
    const checks = summarizeChecks(pr.statusCheckRollup);
    const counts = countChecks(pr.statusCheckRollup);
    const allowedMethods = readAllowedMergeMethods(facts.repo);
    const defaultMethod = pickDefaultMergeMethod(facts.repo, allowedMethods);

    const blockers: string[] = [];
    if ((readText(pr, "state") ?? "").toUpperCase() !== "OPEN") {
      blockers.push(`PR 当前状态为 ${readText(pr, "state") ?? "未知"}，不是开放状态`);
    }
    if (isDraft) blockers.push("PR 仍是 Draft，需要先标记为 Ready for review");
    if (mergeable === "conflicting") blockers.push("存在合并冲突（GitHub 返回 CONFLICTING）");
    if (mergeable === "unknown") blockers.push("GitHub 尚未给出可合并状态（mergeable=UNKNOWN）");
    if (mergeStateStatus && blockingMergeStates.has(mergeStateStatus)) {
      blockers.push(`合并状态为 ${mergeStateStatus}，GitHub 当前规则不允许合并`);
    }
    if (reviewDecision === "REVIEW_REQUIRED") blockers.push("仍需要审阅批准（REVIEW_REQUIRED）");
    if (reviewDecision === "CHANGES_REQUESTED") blockers.push("有审阅者要求修改（CHANGES_REQUESTED）");
    if (checks === "failing") blockers.push(`存在未通过的检查（${counts.failing} 项失败，可能包含必需检查）`);
    if (checks === "pending") blockers.push(`仍有检查未完成（${counts.pending} 项等待，可能包含必需检查）`);
    if (facts.repo === null) blockers.push("无法读取仓库允许的合并方式");
    else if (allowedMethods.length === 0) blockers.push("仓库未允许任何合并方式");
    if (!expectedHeadSha) blockers.push("尚未记录预期 head，无法核对");
    else if (!headMatches) {
      blockers.push(`head 已变化：当前 ${shortSha(headSha)}，预期 ${shortSha(expectedHeadSha)}`);
    }

    const canMerge = blockers.length === 0;
    const note = firstObservation && headSha ? `首次核对，已记录当前 head ${shortSha(headSha)}；` : "";
    const summary = canMerge ? "按 GitHub 当前规则核对通过，可以合并" : `暂不能合并：${blockers.join("；")}`;
    return {
      ok: true,
      message: `PR #${current}：${note}${summary}`,
      number: current,
      url: readText(pr, "url"),
      state,
      isDraft,
      baseRefName: readText(pr, "baseRefName"),
      headRefName: readText(pr, "headRefName"),
      headSha,
      expectedHeadSha,
      headMatches,
      mergeable,
      mergeStateStatus,
      allowedMethods,
      defaultMethod,
      reviewDecision,
      approvals: countCurrentApprovals(reviews, headSha),
      reviews,
      checks,
      blockers,
      canMerge,
      rulesNote:
        "合并可行性来自 GitHub 当前的合并规则与当前 head 核对；检查全绿只说明检查通过，不代表可以合并，合并时会再次以预期 head 校验。",
    };
  }

  /** PR-07:按核对过的 head 合并;head 或规则变化时拒绝,不凭旧状态合并。 */
  async merge(input: PrMergeInput): Promise<PrMergeResult> {
    const number = input.number;
    if (!Number.isInteger(number) || number <= 0) return mergeFailure("PR 编号不正确", false, null);
    if (!isMergeMethod(input.method)) return mergeFailure("合并方式不正确", false, null);
    const method = input.method;
    const expectedHeadSha = readInputText(input.expectedHeadSha);
    if (!isValidShaInput(expectedHeadSha)) {
      return mergeFailure("合并前必须先核对 head，expectedHeadSha 不能为空", true, null);
    }
    const subject = readInputText(input.subject);
    if (subject.length > 300) return mergeFailure("合并提交标题过长", false, null);
    const body = readInputText(input.body);
    if (body.length > maxBodyLength) return mergeFailure("合并提交正文过长", false, null);
    const cwd = this.cwdProvider?.() ?? this.getSnapshot()?.repo?.root ?? null;
    if (!cwd) return mergeFailure("无法确定工作区路径", false, null);

    const facts = await this.readMergeFacts(cwd, number);
    if (!facts.pr) return mergeFailure(facts.error ?? "读取 PR 状态失败", false, null);
    const factsState = (readText(facts.pr, "state") ?? "").toUpperCase();
    if (factsState !== "OPEN") {
      return mergeFailure(
        `PR 当前状态为 ${factsState || "未知"}，不能合并`,
        true,
        await this.fetchPrByNumber(cwd, number),
      );
    }
    if (facts.pr.isDraft === true) {
      return mergeFailure(
        "PR 仍是 Draft，需要先标记为 Ready for review",
        true,
        await this.fetchPrByNumber(cwd, number),
      );
    }
    const headSha = readText(facts.pr, "headRefOid");
    if (headSha) this.rememberHead(number, headSha);
    if (headSha && headSha !== expectedHeadSha) {
      return mergeFailure(
        `PR 已有新提交（当前 head ${shortSha(headSha)}，预期 ${shortSha(expectedHeadSha)}），请重新核对后再合并`,
        true,
        await this.fetchPrByNumber(cwd, number),
      );
    }
    // 仓库明确列出了允许的方式时才据此拒绝;读取失败交给 GitHub 规则判定。
    if (hasMergeMethodFlags(facts.repo) && !readAllowedMergeMethods(facts.repo).includes(method)) {
      return mergeFailure(
        `仓库不允许使用 ${method} 方式合并`,
        true,
        await this.fetchPrByNumber(cwd, number),
      );
    }

    const args = ["pr", "merge", String(number), mergeMethodFlag(method), "--match-head-commit", expectedHeadSha];
    if (input.deleteBranch === true) args.push("--delete-branch");
    // rebase 会重建提交,不传自定义标题与正文。
    const supportsMessage = method !== "rebase";
    if (supportsMessage && subject) args.push("--subject", subject);
    if (supportsMessage && body) args.push("--body-file", "-");

    const result = await runGh(cwd, args, 120_000, supportsMessage && body ? body : undefined);
    if (!result.ok) {
      const text = combineGhOutput(result);
      const blockedByRules = classifyGhFailure(result) === "failed" && isMergeBlockedText(text);
      const line = firstLine(text);
      const message = blockedByRules
        ? `合并被 GitHub 拒绝（head 或规则已变化）: ${line || "请重新核对后再合并"}`
        : describePrActionFailure(result, "合并");
      return mergeFailure(message, blockedByRules, await this.fetchPrByNumber(cwd, number));
    }

    // 合并后状态已变化,缓存必须失效,下次读取重新走 gh。
    this.cache = null;
    const notes = [`PR #${number} 已合并（方式：${method}）`];
    if (input.deleteBranch === true) notes.push("已按请求删除对应分支");
    if (!supportsMessage && (subject || body)) {
      notes.push("rebase 合并会重建提交，自定义标题与正文未提交");
    }
    return { ok: true, message: notes.join("；"), merged: true, blocked: false, pr: await this.fetchPrByNumber(cwd, number) };
  }

  /** PR-07:关闭 PR;只按请求删除分支,不额外触碰本地分支。 */
  async close(input: PrCloseInput): Promise<PrCloseResult> {
    const number = input.number;
    if (!Number.isInteger(number) || number <= 0) return closeFailure("PR 编号不正确", null);
    const comment = readInputText(input.comment);
    if (comment.length > maxBodyLength) return closeFailure("关闭说明过长", null);
    const cwd = this.cwdProvider?.() ?? this.getSnapshot()?.repo?.root ?? null;
    if (!cwd) return closeFailure("无法确定工作区路径", null);

    const args = ["pr", "close", String(number)];
    if (comment) args.push("--comment", comment);
    if (input.deleteBranch === true) args.push("--delete-branch");
    const result = await runGh(cwd, args, 60_000);
    if (!result.ok) {
      return closeFailure(describePrActionFailure(result, "关闭"), await this.fetchPrByNumber(cwd, number));
    }
    this.cache = null;
    return {
      ok: true,
      message: input.deleteBranch === true ? `PR #${number} 已关闭，并已请求删除对应分支` : `PR #${number} 已关闭`,
      pr: await this.fetchPrByNumber(cwd, number),
    };
  }

  /**
   * 未指定编号时取当前分支的开放 PR;error 非空表示没有可用 PR。
   * query(true) 会绕过缓存,避免用旧编号去评论或合并。
   */
  private async resolveNumber(
    number: number | null | undefined,
  ): Promise<{ number: number | null; error: string | null }> {
    if (number !== null && number !== undefined) {
      if (!Number.isInteger(number) || number <= 0) return { number: null, error: "PR 编号不正确" };
      return { number, error: null };
    }
    const info = await this.query(true);
    const current = info.pr?.number ?? null;
    if (current === null || !Number.isInteger(current) || current <= 0) {
      return { number: null, error: info.reason ?? "当前分支没有开放的 Pull Request" };
    }
    return { number: current, error: null };
  }

  /** PR-06:变更成功后重新读取线程与审阅;刷新失败时保留变更已完成的结论。 */
  private async refreshAfterMutation(
    message: string,
    number: number,
    review: PrReviewSummary | null,
  ): Promise<PrReviewMutationResult> {
    const fresh = await this.getReviewThreads(number);
    if (!fresh.ok) {
      return {
        ok: true,
        message: `${message}，但线程与审阅刷新失败: ${fresh.message}`,
        review,
        threads: null,
        reviews: null,
        reviewDecision: null,
      };
    }
    return {
      ok: true,
      message,
      review,
      threads: fresh.threads,
      reviews: fresh.reviews,
      reviewDecision: fresh.reviewDecision,
    };
  }

  /** PR-07:并行读取 PR 状态与仓库合并设置;仓库读取失败不覆盖 PR 结果。 */
  private async readMergeFacts(cwd: string, number: number): Promise<MergeFacts> {
    const [prResult, repo] = await Promise.all([
      runGh(cwd, ["pr", "view", String(number), "--json", mergePreviewPrFields], 30_000),
      this.readRepoMergeSettings(cwd),
    ]);
    if (!prResult.ok) {
      return { pr: null, repo, error: ghFailureReason(classifyGhFailure(prResult), prResult) };
    }
    const pr = parseJsonObject(prResult.stdout);
    if (!pr) return { pr: null, repo, error: "读取 PR 合并信息失败: gh 返回内容无法解析" };
    return { pr, repo, error: null };
  }

  /**
   * PR-07:读取仓库的合并设置。
   * gh repo view 不支持提交标题字段,首次探测后记住可用字段集,避免每次多打一次。
   */
  private async readRepoMergeSettings(cwd: string): Promise<Record<string, unknown> | null> {
    const candidates = this.repoMergeFields
      ? [this.repoMergeFields]
      : [mergeRepoFields, mergeRepoFieldsFallback];
    let last: Record<string, unknown> | null = null;
    for (const fields of candidates) {
      const result = await runGh(cwd, ["repo", "view", "--json", fields], 15_000);
      const record = parseJsonObject(result.stdout);
      if (record) last = record;
      if (result.ok && record && hasMergeMethodFlags(record)) {
        this.repoMergeFields = fields;
        return record;
      }
    }
    return last;
  }

  /** 读取 PR 当前 head(顺带刷新预期 head 记录);失败返回 null。 */
  private async fetchHeadSha(cwd: string, number: number): Promise<string | null> {
    const result = await runGh(cwd, ["pr", "view", String(number), "--json", "headRefOid"], 20_000);
    if (!result.ok) return null;
    const record = parseJsonObject(result.stdout);
    const sha = record ? readText(record, "headRefOid") : null;
    if (sha) this.rememberHead(number, sha);
    return sha;
  }

  /** 记录某个 PR 最近一次观察到的 head;空值不写入。 */
  private rememberHead(number: number, sha: string | null): void {
    if (!sha) return;
    this.headShas.set(number, sha);
  }

  /**
   * gh 不返回 baseRepository(请求该字段会让命令失败),缺失时用本地远程
   * 推导的目标仓库补齐,避免界面与 AI 输入拿不到 base 仓库。
   */
  private fillBaseRepo(pr: PrSummary | null): PrSummary | null {
    if (!pr || pr.baseRepo) return pr;
    const snapshot = this.getSnapshot();
    if (!snapshot?.repo) return pr;
    const slug = githubSlug(findRemoteFetchUrl(snapshot, resolveHeadRemote(snapshot)));
    return slug ? { ...pr, baseRepo: slug } : pr;
  }

  /** 从 gh 列表/详情返回的原始记录中批量记录 head。 */
  private rememberHeads(records: Record<string, unknown>[]): void {
    for (const record of records) {
      const recordNumber = readNumber(record, "number");
      if (recordNumber === null) continue;
      this.rememberHead(recordNumber, readText(record, "headRefOid"));
    }
  }

  /** 记录中的预期 head;从未观察过时为 null。 */
  private lastHeadSha(number: number): string | null {
    return this.headShas.get(number) ?? null;
  }

  private async fetchPrByNumber(cwd: string, number: number): Promise<PrSummary | null> {
    const result = await runGh(
      cwd,
      ["pr", "view", String(number), "--json", prJsonFieldsWithHead],
      30_000,
    );
    if (!result.ok) return null;
    const record = parseJsonObject(result.stdout);
    if (!record) return null;
    this.rememberHead(number, readText(record, "headRefOid"));
    return this.fillBaseRepo(toSummary(record));
  }

  private async resolveRepoSlug(cwd: string): Promise<string | null> {
    const view = await runGh(cwd, ["repo", "view", "--json", "nameWithOwner"], 15_000);
    if (view.ok) {
      const record = parseJsonObject(view.stdout);
      const name = record ? readText(record, "nameWithOwner") : null;
      if (name) return name;
    }
    const snapshot = this.getSnapshot();
    return githubSlug(snapshot?.repo?.remoteUrl ?? null);
  }

  /** 命中 TTL 缓存或强制刷新;失败时保留上次成功结果并标记 stale。 */
  private async query(force: boolean): Promise<PullRequestInfo> {
    const snapshot = this.getSnapshot();
    const cwd = this.cwdProvider?.() ?? snapshot?.repo?.root ?? null;
    const branch = snapshot?.branch ?? null;
    const key = `${cwd ?? ""}::${branch ?? ""}`;
    const cached = this.cache;

    if (
      !force &&
      cached &&
      cached.key === key &&
      isSuccessState(cached.info.status) &&
      Date.now() - cached.info.checkedAt < cacheTtlMs
    ) {
      return cached.info;
    }

    const fresh = await this.fetch(snapshot, cwd);
    if (isSuccessState(fresh.status)) {
      this.cache = { key, info: fresh };
      return fresh;
    }
    if (cached && cached.key === key && isSuccessState(cached.info.status)) {
      return { ...cached.info, stale: true, reason: fresh.reason ?? cached.info.reason };
    }
    return fresh;
  }

  private async fetch(
    snapshot: GitStatusSnapshot | null,
    cwd: string | null,
  ): Promise<PullRequestInfo> {
    const probe = await this.probeGh();
    const ghAvailable = probe.state !== "no-gh";
    const empty = (status: PrAccessState, reason: string | null): PullRequestInfo => ({
      status,
      ghAvailable,
      reason,
      stale: false,
      checkedAt: Date.now(),
      pr: null,
      otherBranchPrs: [],
      checks: [],
      repo: null,
      defaultBase: null,
      baseOptions: [],
      headRemote: null,
      fork: null,
    });

    if (probe.state === "no-gh") return empty("no-gh", probe.reason);
    if (!snapshot?.repo) return empty("no-pr", "当前工作区不是 Git 仓库");
    if (!cwd) return empty("no-pr", "无法确定工作区路径");
    if (!snapshot.branch || snapshot.detached) {
      return empty("no-pr", "当前处于 detached HEAD,无法查询分支 PR");
    }
    const branch = snapshot.branch;

    const headRemote = resolveHeadRemote(snapshot);
    const remoteUrl = findRemoteFetchUrl(snapshot, headRemote);
    const slug = githubSlug(remoteUrl);
    if (!slug) return empty("no-pr", "当前仓库没有 GitHub 远程");

    let defaultBase = (await resolveRemoteHead(cwd, headRemote)) ?? "main";
    let repoRef = slugToRepoRef(slug);

    // gh 存在但不可用时仍返回本地可推导的 repo/base 信息。
    if (probe.state !== "ok") {
      const context = await buildPrContext(cwd, headRemote, defaultBase, repoRef, snapshot);
      return { ...empty(probe.state, probe.reason), ...context };
    }

    const view = await runGh(
      cwd,
      ["repo", "view", "--json", "nameWithOwner,defaultBranchRef"],
      15_000,
    );
    if (view.ok) {
      const record = parseJsonObject(view.stdout);
      const nameWithOwner = record ? readText(record, "nameWithOwner") : null;
      const viewRef = nameWithOwner ? slugToRepoRef(nameWithOwner) : null;
      if (viewRef) repoRef = viewRef;
      const defaultRef = record ? record.defaultBranchRef : null;
      const defaultName = isRecord(defaultRef) ? readText(defaultRef, "name") : null;
      if (defaultName) defaultBase = defaultName;
    } else {
      const kind = classifyGhFailure(view);
      if (kind !== "failed") {
        const context = await buildPrContext(cwd, headRemote, defaultBase, repoRef, snapshot);
        return { ...empty(kind, ghFailureReason(kind, view)), ...context };
      }
    }

    const list = await runGh(
      cwd,
      [
        "pr",
        "list",
        "--head",
        branch,
        "--state",
        "all",
        "--json",
        prJsonFieldsWithHead,
        "--limit",
        "20",
      ],
      20_000,
    );
    if (!list.ok) {
      const kind = classifyGhFailure(list);
      const context = await buildPrContext(cwd, headRemote, defaultBase, repoRef, snapshot);
      return { ...empty(kind, ghFailureReason(kind, list)), ...context };
    }

    // 列表里的 headRefOid 一并记下,供审阅过期判断与合并前核对使用。
    this.rememberHeads(parseJsonArray(list.stdout).filter(isRecord));
    const prs = parsePrList(list.stdout);
    const open = prs
      .filter((pr) => pr.state === "open" || pr.state === "draft")
      .sort(byUpdatedDesc);
    const others = prs
      .filter((pr) => pr.state === "closed" || pr.state === "merged")
      .sort(byUpdatedDesc);
    const pr = open[0] ?? null;
    const checks = pr ? await this.fetchChecks(cwd, pr.number) : [];
    const context = await buildPrContext(cwd, headRemote, defaultBase, repoRef, snapshot);
    return {
      status: prs.length > 0 ? "ok" : "no-pr",
      ghAvailable: true,
      reason: prs.length > 0 ? null : "当前分支暂无 Pull Request",
      stale: false,
      checkedAt: Date.now(),
      pr: this.fillBaseRepo(pr),
      otherBranchPrs: others,
      checks,
      ...context,
    };
  }

  /** gh 检查明细;gh pr checks 在存在失败检查时也会输出 JSON,统一容错。 */
  private async fetchChecks(cwd: string, number: number): Promise<PrCheckDetail[]> {
    const result = await runGh(
      cwd,
      [
        "pr",
        "checks",
        String(number),
        "--json",
        "name,state,bucket,link,description,workflow",
      ],
      30_000,
    );
    return parseJsonArray(result.stdout)
      .filter(isRecord)
      .map((record) => ({
        name: readText(record, "name") ?? "",
        workflow: readText(record, "workflow"),
        state: mapCheckState(readText(record, "bucket"), readText(record, "state")),
        link: readText(record, "link"),
        description: readText(record, "description"),
      }));
  }

  private async findOpenPr(cwd: string, head: string): Promise<PrSummary | null> {
    const result = await runGh(
      cwd,
      ["pr", "list", "--head", head, "--state", "open", "--json", prJsonFieldsWithHead, "--limit", "10"],
      20_000,
    );
    if (!result.ok) return null;
    this.rememberHeads(parseJsonArray(result.stdout).filter(isRecord));
    return parsePrList(result.stdout)[0] ?? null;
  }

  private async fetchPrByUrl(cwd: string, url: string): Promise<PrSummary | null> {
    const result = await runGh(cwd, ["pr", "view", url, "--json", prJsonFieldsWithHead], 20_000);
    if (!result.ok) return null;
    const record = parseJsonObject(result.stdout);
    if (!record) return null;
    const number = readNumber(record, "number");
    if (number !== null) this.rememberHead(number, readText(record, "headRefOid"));
    return this.fillBaseRepo(toSummary(record));
  }

  /** 结果不明时的兜底查询:只认最近几分钟内创建的 PR。 */
  private async findRecentPr(cwd: string, head: string): Promise<PrSummary | null> {
    const result = await runGh(
      cwd,
      [
        "pr",
        "list",
        "--head",
        head,
        "--state",
        "all",
        "--json",
        prJsonFieldsWithCreatedAt,
        "--limit",
        "10",
      ],
      20_000,
    );
    if (!result.ok) return null;
    for (const record of parseJsonArray(result.stdout)) {
      if (!isRecord(record)) continue;
      const createdAt = readTimestamp(record, "createdAt");
      if (createdAt === null || Date.now() - createdAt > recentPrWindowMs) continue;
      const pr = toSummary(record);
      if (pr) {
        this.rememberHead(pr.number, readText(record, "headRefOid"));
        return pr;
      }
    }
    return null;
  }

  private async defaultBranch(): Promise<string> {
    const cwd = this.cwdProvider?.() ?? null;
    if (!cwd) return "main";
    const result = await runGit(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).catch(
      () => null,
    );
    const name = result?.stdout.trim().split("/").pop();
    return name || "main";
  }

  /** 探测 gh 可用性与登录状态;结果缓存 30s。 */
  private async probeGh(): Promise<GhProbe> {
    if (this.probe && Date.now() - this.probe.checkedAt < ghProbeTtlMs) return this.probe;
    const checkedAt = Date.now();

    const version = await runGh(null, ["--version"], 5_000);
    if (!version.ok) {
      this.probe = {
        state: "no-gh",
        reason: "未安装 GitHub CLI(gh),PR 功能降级为网页操作",
        checkedAt,
      };
      return this.probe;
    }

    const auth = await runGh(null, ["auth", "status"], 10_000);
    if (auth.ok) {
      this.probe = { state: "ok", reason: null, checkedAt };
      return this.probe;
    }
    const text = combineGhOutput(auth);
    if (isOfflineText(text)) {
      this.probe = { state: "offline", reason: "网络异常,无法连接 GitHub", checkedAt };
      return this.probe;
    }
    if (isAuthText(text)) {
      this.probe = {
        state: "unauthenticated",
        reason: "gh 未登录或登录已失效,请运行 gh auth login",
        checkedAt,
      };
      return this.probe;
    }
    const line = firstLine(text);
    this.probe = {
      state: "failed",
      reason: line ? `gh 状态检查失败: ${line}` : "gh 状态检查失败",
      checkedAt,
    };
    return this.probe;
  }
}

async function buildPrContext(
  cwd: string,
  headRemote: string | null,
  defaultBase: string,
  repo: PrRepoRef | null,
  snapshot: GitStatusSnapshot | null,
): Promise<PrContext> {
  return {
    repo,
    defaultBase,
    baseOptions: await listBaseOptions(cwd, defaultBase),
    headRemote,
    fork: buildForkInfo(snapshot, headRemote, repo?.baseRepo ?? null),
  };
}

/**
 * 识别 fork 工作流中的三种角色:PR 目标(base)远程、推送/来源(head)远程,
 * 以及它们各自对应的 owner/repo。来源与目标不同即为 fork。
 */
function buildForkInfo(
  snapshot: GitStatusSnapshot | null,
  headRemote: string | null,
  baseRepo: string | null,
): PrForkInfo | null {
  if (!snapshot) return null;
  const remotes = snapshot.remotes ?? [];
  if (remotes.length === 0) return null;
  const names = remotes.map((remote) => remote.name);
  const upstreamRemote = matchRemotePrefix(snapshot.upstream ?? "", names);
  // 目标仓库优先 upstream 远程,其次是当前分支的推送远程。
  const baseRemote = upstreamRemote ?? headRemote ?? names[0] ?? null;
  const baseRemoteUrl = remotes.find((remote) => remote.name === baseRemote)?.fetchUrl ?? null;
  const headRemoteUrl = remotes.find((remote) => remote.name === headRemote)?.fetchUrl ?? null;
  const resolvedBase = baseRepo ?? githubSlug(baseRemoteUrl) ?? githubSlug(snapshot.repo?.remoteUrl ?? null);
  const resolvedHead = githubSlug(headRemoteUrl) ?? resolvedBase;
  return {
    baseRemote,
    baseRepo: resolvedBase,
    headRemote,
    headRepo: resolvedHead,
    isFork: Boolean(resolvedBase && resolvedHead && resolvedBase.toLowerCase() !== resolvedHead.toLowerCase()),
    remotes: remotes.map((remote) => ({
      remote: remote.name,
      repo: githubSlug(remote.fetchUrl || remote.pushUrl),
      url: remote.fetchUrl || remote.pushUrl,
    })),
  };
}

/** baseOptions = 默认 base + 本地/远程分支短名,去重且默认分支在首位。 */
async function listBaseOptions(cwd: string, defaultBase: string): Promise<string[]> {
  const [locals, remotes] = await Promise.all([
    runGit(cwd, ["branch", "--format=%(refname:short)"]).catch(() => null),
    runGit(cwd, ["branch", "-r", "--format=%(refname:short)"]).catch(() => null),
  ]);
  const names: string[] = [];
  const seen = new Set<string>();
  const push = (value: string): void => {
    const name = value.trim();
    if (!name || seen.has(name)) return;
    seen.add(name);
    names.push(name);
  };
  for (const line of (locals?.stdout ?? "").split("\n")) {
    const name = line.trim();
    if (!name || name.startsWith("(")) continue;
    push(name);
  }
  for (const line of (remotes?.stdout ?? "").split("\n")) {
    const name = line.trim();
    // 过滤 refs/remotes/<remote>/HEAD;短名可能退化为远程名(无 "/")。
    if (!name || name.endsWith("/HEAD") || !name.includes("/")) continue;
    push(name);
  }
  return [defaultBase, ...names.filter((name) => name !== defaultBase)];
}

/** 当前分支对应的推送远程:upstream > origin > 第一个远程。 */
function resolveHeadRemote(snapshot: GitStatusSnapshot): string | null {
  const names = (snapshot.remotes ?? []).map((remote) => remote.name);
  const upstreamRemote = snapshot.upstream?.split("/")[0] ?? null;
  if (upstreamRemote && names.includes(upstreamRemote)) return upstreamRemote;
  if (names.includes("origin")) return "origin";
  return names[0] ?? null;
}

function findRemoteFetchUrl(snapshot: GitStatusSnapshot, name: string | null): string | null {
  const remotes = snapshot.remotes ?? [];
  const preferred = name ? remotes.find((remote) => remote.name === name) : undefined;
  if (preferred) return preferred.fetchUrl;
  const origin = remotes.find((remote) => remote.name === "origin");
  if (origin) return origin.fetchUrl;
  return remotes[0]?.fetchUrl ?? snapshot.repo?.remoteUrl ?? null;
}

/** base 远程:upstream(基仓库)> origin > headRemote > 第一个远程。 */
function findBaseRemoteUrl(snapshot: GitStatusSnapshot, headRemote: string | null): string | null {
  const remotes = snapshot.remotes ?? [];
  for (const name of ["upstream", "origin", headRemote ?? ""]) {
    if (!name) continue;
    const match = remotes.find((remote) => remote.name === name);
    if (match) return match.fetchUrl;
  }
  return remotes[0]?.fetchUrl ?? snapshot.repo?.remoteUrl ?? null;
}

async function resolveRemoteHead(cwd: string, remote: string | null): Promise<string | null> {
  if (!remote) return null;
  const ref = await gitTry(cwd, ["symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`]);
  if (!ref) return null;
  const prefix = `${remote}/`;
  return ref.startsWith(prefix) ? ref.slice(prefix.length) : ref;
}

async function gitTry(cwd: string, args: string[], timeoutMs?: number): Promise<string | null> {
  try {
    return (await gitQuery(cwd, args, timeoutMs)).trim();
  } catch {
    return null;
  }
}

function scopeError(base: string, head: string, error: string): PrCompareScope {
  return {
    base,
    head,
    baseRepo: null,
    headRepo: null,
    commits: [],
    fileCount: 0,
    addedLines: 0,
    deletedLines: 0,
    headPushed: false,
    unpushedCount: 0,
    pushTarget: null,
    empty: true,
    diff: "",
    diffTruncated: false,
    error,
  } as PrCompareScope;
}

/** 按字符上限截断文本;若切点落在代理对中间则回退一位,保证 UTF-8 合法。 */
function truncateTextPrefix(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  const code = text.charCodeAt(limit - 1);
  const end = code >= 0xd800 && code <= 0xdbff ? limit - 1 : limit;
  return { text: text.slice(0, end), truncated: true };
}

function createFailure(message: string): PrCreateResult {
  return {
    ok: false,
    step: "create",
    pushed: false,
    pr: null,
    url: null,
    number: null,
    message,
    unconfirmed: false,
  };
}

function updateFailure(message: string): PrUpdateResult {
  return { ok: false, message, pr: null, changes: [] };
}

/** PR-06:读取线程失败时返回空集合,调用方据 ok 判断。 */
function reviewThreadsFailure(message: string, previousHeadSha: string | null): PrReviewThreadsResult {
  return {
    ok: false,
    message,
    threads: [],
    reviews: [],
    reviewDecision: null,
    pendingReviewers: [],
    headSha: null,
    previousHeadSha,
  };
}

/** PR-06:评论/审阅失败时不返回任何线程与结论。 */
function reviewMutationFailure(message: string): PrReviewMutationResult {
  return { ok: false, message, review: null, threads: null, reviews: null, reviewDecision: null };
}

/** PR-07:合并预览失败时保留编号,其余按未知处理。 */
function mergePreviewFailure(number: number, message: string): PrMergePreview {
  return {
    ok: false,
    message,
    number,
    url: null,
    state: null,
    isDraft: false,
    baseRefName: null,
    headRefName: null,
    headSha: null,
    expectedHeadSha: null,
    headMatches: false,
    mergeable: "unknown",
    mergeStateStatus: null,
    allowedMethods: [],
    defaultMethod: null,
    reviewDecision: null,
    approvals: 0,
    reviews: [],
    checks: "none",
    blockers: [],
    canMerge: false,
    rulesNote: null,
  };
}

/** PR-07:合并失败时区分「规则/head 阻止」与一般失败。 */
function mergeFailure(message: string, blocked: boolean, pr: PrSummary | null): PrMergeResult {
  return { ok: false, message, merged: false, blocked, pr };
}

/** PR-07:关闭失败时保留可读到的 PR 摘要。 */
function closeFailure(message: string, pr: PrSummary | null): PrCloseResult {
  return { ok: false, message, pr };
}

/** 清洗 Reviewer/标签名:去空、去重、拒绝选项注入。 */
function cleanNames(values: string[] | undefined): string[] {
  if (!values) return [];
  const cleaned = values
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && value.length <= 200 && !value.startsWith("-"));
  return [...new Set(cleaned)];
}

function describeUpdateFailure(result: GhResult): string {
  if (result.timedOut || result.killed) return "更新 Pull Request 超时或进程被终止，结果未确认";
  if (result.spawnError) return `无法启动 gh: ${result.spawnError}`;
  const text = combineGhOutput(result);
  const line = firstLine(text);
  if (isAuthText(text)) return "gh 未登录或登录已失效，请运行 gh auth login 后重试";
  if (isPermissionText(text)) return line ? `没有更新 Pull Request 的权限: ${line}` : "没有更新 Pull Request 的权限";
  if (isOfflineText(text)) return "网络异常，无法连接 GitHub";
  return line ? `更新 Pull Request 失败: ${line}` : "更新 Pull Request 失败";
}

/** 校验用户输入的 ref:拒绝 "-" 开头、空白、控制字符与超长名称。 */
function isValidRefInput(name: string): boolean {
  if (!name || name.length > 200 || name.startsWith("-")) return false;
  // 空白与控制字符会破坏 git 语义。
  return !/[\s\u0000-\u001f\u007f]/.test(name);
}

function parseNumstat(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function byUpdatedDesc(a: PrSummary, b: PrSummary): number {
  return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
}

function isSuccessState(status: PrAccessState): boolean {
  return status === "ok" || status === "no-pr";
}

function parsePrList(stdout: string): PrSummary[] {
  return parseJsonArray(stdout)
    .map(toSummary)
    .filter((pr): pr is PrSummary => pr !== null);
}

function toSummary(value: unknown): PrSummary | null {
  if (!isRecord(value)) return null;
  const number = readNumber(value, "number");
  if (number === null) return null;

  const isDraft = value.isDraft === true;
  const state = readPrState(value);

  // 审阅计数只认每位作者的最新状态(按 submittedAt 排序)。
  const reviews = Array.isArray(value.reviews) ? value.reviews.filter(isRecord) : [];
  const ordered = reviews
    .map((review, index) => ({ review, index, at: readTimestamp(review, "submittedAt") ?? 0 }))
    .sort((a, b) => (a.at === b.at ? a.index - b.index : a.at - b.at));
  const latest = new Map<string, string>();
  for (const item of ordered) {
    const login = readLogin(item.review.author);
    const reviewState = readText(item.review, "state")?.toUpperCase();
    if (login && reviewState) latest.set(login, reviewState);
  }
  let approvals = 0;
  for (const reviewState of latest.values()) {
    if (reviewState === "APPROVED") approvals += 1;
  }

  return {
    number,
    title: readText(value, "title") ?? "",
    url: readText(value, "url") ?? "",
    state,
    isDraft,
    reviewDecision: readText(value, "reviewDecision"),
    approvals,
    checks: summarizeChecks(value.statusCheckRollup),
    baseRefName: readText(value, "baseRefName") ?? "",
    headRefName: readText(value, "headRefName") ?? "",
    baseRepo: readRepositoryName(value.baseRepository),
    headRepo: readRepositoryName(value.headRepository),
    author: readLogin(value.author),
    labels: readNames(value.labels),
    reviewers: readReviewerNames(value.reviewRequests),
    assignees: readLogins(value.assignees),
    closingIssues: readIssueNumbers(value.closingIssuesReferences),
    updatedAt: readTimestamp(value, "updatedAt"),
    additions: readNumber(value, "additions") ?? 0,
    deletions: readNumber(value, "deletions") ?? 0,
    changedFiles: readNumber(value, "changedFiles") ?? 0,
    body: readText(value, "body") ?? "",
  };
}

/** gh 的仓库字段形如 { nameWithOwner: "owner/repo" }。 */
function readRepositoryName(value: unknown): string | null {
  return isRecord(value) ? readText(value, "nameWithOwner") : null;
}

function readNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const entry of value) {
    const name = isRecord(entry) ? readText(entry, "name") : null;
    if (name) names.push(name);
  }
  return names;
}

/** reviewRequests 同时包含用户与团队;团队用 team 前缀标注。 */
function readReviewerNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const login = readText(entry, "login") ?? readText(entry, "slug") ?? readText(entry, "name");
    if (!login) continue;
    names.push(readText(entry, "slug") && !readText(entry, "login") ? `team:${login}` : login);
  }
  return names;
}

function readLogins(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (isRecord(entry) ? readText(entry, "login") : null))
    .filter((login): login is string => Boolean(login));
}

function readIssueNumbers(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (isRecord(entry) ? readNumber(entry, "number") : null))
    .filter((issue): issue is number => issue !== null);
}

/** GraphQL 连接里的 nodes;缺失或非法时返回空数组。 */
function readNodes(value: unknown): Record<string, unknown>[] {
  if (!isRecord(value)) return [];
  const nodes = value.nodes;
  return Array.isArray(nodes) ? nodes.filter(isRecord) : [];
}

/** gh api graphql 响应 → data.repository.pullRequest;缺失时返回 null。 */
function readGraphqlPullRequest(payload: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!payload || !isRecord(payload.data)) return null;
  const repository = payload.data.repository;
  if (!isRecord(repository)) return null;
  return isRecord(repository.pullRequest) ? repository.pullRequest : null;
}

/** 线程变更响应 → 指定 mutation 下的 thread 节点;缺失时返回 null。 */
function readGraphqlMutationThread(
  payload: Record<string, unknown> | null,
  field: string,
): Record<string, unknown> | null {
  if (!payload || !isRecord(payload.data)) return null;
  const mutation = payload.data[field];
  if (!isRecord(mutation)) return null;
  return isRecord(mutation.thread) ? mutation.thread : null;
}

/** GraphQL 顶层 errors 的首条信息;用于给出可读失败原因。 */
function readGraphqlError(payload: Record<string, unknown> | null): string | null {
  const errors = payload?.errors;
  if (!Array.isArray(errors)) return null;
  for (const entry of errors) {
    if (!isRecord(entry)) continue;
    const message = readText(entry, "message");
    if (message) return `GitHub 返回错误: ${message}`;
  }
  return null;
}

/** GitHub 审阅状态文本 → shared 的 PrReviewState。 */
function reviewStateFromGh(value: string | null): PrReviewState {
  const state = (value ?? "").toUpperCase();
  if (state === "APPROVED") return "approved";
  if (state === "CHANGES_REQUESTED") return "changes_requested";
  if (state === "COMMENTED") return "commented";
  if (state === "DISMISSED") return "dismissed";
  if (state === "PENDING") return "pending";
  return "unknown";
}

/**
 * PR-06:审阅是否针对当前代码版本;commit 缺失时不能当作当前审阅,
 * 避免过期批准被计入(需求 9.3)。
 */
function isReviewOutdated(commitSha: string | null, headSha: string | null): boolean {
  if (!headSha) return false;
  if (!commitSha) return true;
  return commitSha !== headSha;
}

/** gh 的 reviews 数组单项 → PrReviewSummary;与当前 head 不一致即为过期。 */
export function toReviewSummary(value: unknown, headSha: string | null): PrReviewSummary | null {
  if (!isRecord(value)) return null;
  const rawState = readText(value, "state");
  const commitSha = readCommitOid(value.commit) ?? readCommitOid(value.originalCommit);
  return {
    author: readLogin(value.author),
    state: reviewStateFromGh(rawState),
    rawState,
    body: readText(value, "body") ?? "",
    submittedAt: readTimestamp(value, "submittedAt"),
    url: readText(value, "url"),
    commitSha,
    outdated: isReviewOutdated(commitSha, headSha),
  };
}

/** PR-06/PR-07:审阅列表映射,过滤掉无法解析的项。 */
function readReviewNodes(value: unknown, headSha: string | null): PrReviewSummary[] {
  return readNodes(value)
    .map((node) => toReviewSummary(node, headSha))
    .filter((review): review is PrReviewSummary => review !== null);
}

/** 评论/审阅里的 commit 节点 → oid。 */
function readCommitOid(value: unknown): string | null {
  return isRecord(value) ? readText(value, "oid") : null;
}

/**
 * PR-06:审阅线程映射;comments 按查询顺序平铺,同时用 replyTo 还原
 * 一级回复关系(缺少 replyTo 时把首条之后的评论视为回复)。
 */
export function toReviewThread(value: unknown): PrReviewThread | null {
  if (!isRecord(value)) return null;
  const id = readText(value, "id");
  if (!id) return null;

  const records = readNodes(value.comments);
  const comments = records.map(toReviewComment);
  const byId = new Map<string, PrReviewComment>();
  for (const comment of comments) {
    if (comment.id && !byId.has(comment.id)) byId.set(comment.id, comment);
  }
  const hasReplyInfo = records.some((record) => readCommentParentId(record) !== null);
  records.forEach((record, index) => {
    const comment = comments[index];
    if (!comment) return;
    const parentId = readCommentParentId(record);
    if (hasReplyInfo) {
      if (!parentId) return;
      const parent = byId.get(parentId);
      if (parent && parent !== comment) parent.replies.push(comment);
      return;
    }
    const root = comments[0];
    if (index > 0 && root && root !== comment) root.replies.push(comment);
  });

  return {
    id,
    path: readText(value, "path"),
    line: readNumber(value, "line"),
    // 真实 schema 的线程没有 originalCommit,退回首条评论的代码版本。
    commitSha: readCommitOid(value.originalCommit) ?? comments[0]?.commitSha ?? null,
    outdated: value.isOutdated === true,
    resolved: value.isResolved === true,
    resolvable: readThreadResolvable(value),
    resolvedBy: readLogin(value.resolvedBy),
    comments,
  };
}

/**
 * 线程是否可解决:优先 GitHub 的 isResolvable,其次看当前用户能否
 * 解决/重新打开;都缺失时按可解决处理,避免界面丢失操作入口。
 */
function readThreadResolvable(value: Record<string, unknown>): boolean {
  if (typeof value.isResolvable === "boolean") return value.isResolvable;
  if (value.viewerCanResolve === true || value.viewerCanUnresolve === true) return true;
  if (value.viewerCanResolve === false && value.viewerCanUnresolve === false) return false;
  return true;
}

/** 评论节点的 replyTo.id;没有回复关系时为 null。 */
function readCommentParentId(record: Record<string, unknown>): string | null {
  return isRecord(record.replyTo) ? readText(record.replyTo, "id") : null;
}

/** PR-06:评论节点 → PrReviewComment;代码版本以 originalCommit 为准。 */
export function toReviewComment(value: unknown): PrReviewComment {
  const record = isRecord(value) ? value : {};
  const reviewState = isRecord(record.pullRequestReview)
    ? readText(record.pullRequestReview, "state")
    : null;
  return {
    id: readText(record, "id") ?? "",
    author: readLogin(record.author),
    body: readText(record, "body") ?? "",
    createdAt: readTimestamp(record, "createdAt"),
    url: readText(record, "url"),
    path: readText(record, "path"),
    line: readNumber(record, "line"),
    commitSha: readCommitOid(record.originalCommit) ?? readCommitOid(record.commit),
    outdated: record.outdated === true,
    diffHunk: readText(record, "diffHunk"),
    isReview: reviewState !== null,
    state: reviewState ? reviewStateFromGh(reviewState) : null,
    replies: [],
  };
}

/** 尚未提交结论的审阅请求;团队请求没有 User 登录名,直接跳过。 */
function readPendingReviewers(value: unknown): string[] {
  const logins = readNodes(value)
    .map((node) => readLogin(node.requestedReviewer))
    .filter((login): login is string => Boolean(login));
  return [...new Set(logins)];
}

/** 每位作者只保留最新一条审阅,避免旧结论盖过后续结论。 */
function latestReviewsByAuthor(reviews: PrReviewSummary[]): PrReviewSummary[] {
  const ordered = reviews
    .map((review, index) => ({ review, index, at: review.submittedAt ?? 0 }))
    .sort((a, b) => (a.at === b.at ? a.index - b.index : a.at - b.at));
  const latest = new Map<string, PrReviewSummary>();
  const anonymous: PrReviewSummary[] = [];
  for (const item of ordered) {
    const author = item.review.author;
    if (!author) anonymous.push(item.review);
    else latest.set(author, item.review);
  }
  return [...latest.values(), ...anonymous];
}

/** PR-07:只统计当前版本上、未被新审阅取代的批准。 */
function countCurrentApprovals(reviews: PrReviewSummary[], headSha: string | null): number {
  let count = 0;
  for (const review of latestReviewsByAuthor(reviews)) {
    if (review.state !== "approved" || review.outdated) continue;
    if (headSha !== null && review.commitSha !== headSha) continue;
    count += 1;
  }
  return count;
}

/** PR-06:从刷新后的审阅里挑出刚提交的那条(状态与版本匹配,取最近一条)。 */
function pickSubmittedReview(
  reviews: PrReviewSummary[],
  event: PrReviewEvent,
  targetSha: string | null,
): PrReviewSummary | null {
  const state: PrReviewState =
    event === "approve" ? "approved" : event === "request-changes" ? "changes_requested" : "commented";
  const candidates = reviews.filter((review) => review.state === state);
  const exact = targetSha ? candidates.filter((review) => review.commitSha === targetSha) : [];
  const pool = exact.length > 0 ? exact : candidates;
  const ordered = pool
    .slice()
    .sort((a, b) => (b.submittedAt ?? 0) - (a.submittedAt ?? 0));
  return ordered[0] ?? null;
}

/** PR-07:gh 的 mergeable → 预览取值;计算中与缺失都归为 unknown。 */
function mapMergeable(value: string | null): "mergeable" | "conflicting" | "unknown" {
  const state = (value ?? "").toUpperCase();
  if (state === "MERGEABLE") return "mergeable";
  if (state === "CONFLICTING") return "conflicting";
  return "unknown";
}

/** PR-07:仓库 JSON → 允许的合并方式,顺序固定为 merge/squash/rebase。 */
function readAllowedMergeMethods(repo: Record<string, unknown> | null): PrMergeMethod[] {
  if (!repo) return [];
  const methods: PrMergeMethod[] = [];
  if (repo.mergeCommitAllowed === true) methods.push("merge");
  if (repo.squashMergeAllowed === true) methods.push("squash");
  if (repo.rebaseMergeAllowed === true) methods.push("rebase");
  return methods;
}

/** 仓库 JSON 是否明确给出了合并方式开关;缺失时不能据此拒绝。 */
function hasMergeMethodFlags(repo: Record<string, unknown> | null): boolean {
  if (!repo) return false;
  return ["mergeCommitAllowed", "squashMergeAllowed", "rebaseMergeAllowed"].some(
    (key) => typeof repo[key] === "boolean",
  );
}

/**
 * PR-07:默认合并方式。优先 gh 给出的仓库默认方式(viewerDefaultMergeMethod);
 * 只允许一种时即为其首选;再次是按已配置提交标题风格推断,最后回退首个允许的方式。
 */
function pickDefaultMergeMethod(
  repo: Record<string, unknown> | null,
  allowed: PrMergeMethod[],
): PrMergeMethod | null {
  if (allowed.length === 0) return null;
  const preferred = (readText(repo ?? {}, "viewerDefaultMergeMethod") ?? "").toLowerCase();
  if (isMergeMethod(preferred) && allowed.includes(preferred)) return preferred;
  if (allowed.length === 1) return allowed[0] ?? null;
  if (allowed.includes("squash") && repo && readText(repo, "squashMergeCommitTitle")) return "squash";
  if (allowed.includes("merge") && repo && readText(repo, "mergeCommitTitle")) return "merge";
  return allowed[0] ?? null;
}

/** gh 合并方式开关。 */
function mergeMethodFlag(method: PrMergeMethod): string {
  if (method === "squash") return "--squash";
  if (method === "rebase") return "--rebase";
  return "--merge";
}

function isMergeMethod(value: unknown): value is PrMergeMethod {
  return value === "merge" || value === "squash" || value === "rebase";
}

/** gh pr review 的结论开关。 */
function reviewEventFlag(event: PrReviewEvent): string {
  if (event === "approve") return "--approve";
  if (event === "request-changes") return "--request-changes";
  return "--comment";
}

/** PR-06:审阅提交后的结果说明;结论对应旧版本时明确标注。 */
function reviewMessage(event: PrReviewEvent, number: number, review: PrReviewSummary | null): string {
  const label =
    event === "approve" ? "已批准" : event === "request-changes" ? "已请求修改" : "已提交评论审阅";
  const suffix = review?.outdated ? "（该结论对应的是旧版本）" : "";
  return `PR #${number} ${label}${suffix}`;
}

/** gh 合并失败的文本里,哪些属于「head 或规则不允许」而非网络/权限问题。 */
function isMergeBlockedText(text: string): boolean {
  return /not mergeable|not allowed|head branch was modified|head commit|expected head|merge commit cannot be cleanly created|base branch policy|protected branch|branch protection|required status check|required review|review required|changes requested|approving review|still a draft|draft pull request|merge conflict|conflicts? must be resolved/i.test(
    text,
  );
}

/** 展示用短 SHA;未知时返回「未知」。 */
function shortSha(sha: string | null): string {
  if (!sha) return "未知";
  return sha.length > 7 ? sha.slice(0, 7) : sha;
}

/** SHA 输入校验:非空、有限长度、无空白与控制字符;是否匹配交给 GitHub。 */
function isValidShaInput(value: string): boolean {
  const sha = value.trim();
  return sha.length > 0 && sha.length <= 100 && !/[\s\u0000-\u001f\u007f]/.test(sha);
}

/** 线程 node id:不透明字符串,只校验非空、长度与空白,绝不拼进查询。 */
function isValidThreadId(value: string): boolean {
  const id = value.trim();
  return id.length > 0 && id.length <= 200 && !/[\s\u0000-\u001f\u007f]/.test(id);
}

/** 评论/审阅/合并/关闭共用的失败文案;错误分类沿用 gh 文本判断。 */
function describePrActionFailure(result: GhResult, action: string): string {
  if (result.timedOut || result.killed) return `${action}超时或进程被终止，结果未确认`;
  if (result.spawnError) return `无法启动 gh: ${result.spawnError}`;
  const text = combineGhOutput(result);
  const line = firstLine(text);
  if (isAuthText(text)) return "gh 未登录或登录已失效，请运行 gh auth login 后重试";
  if (isPermissionText(text)) return line ? `没有${action}的权限: ${line}` : `没有${action}的权限`;
  if (isOfflineText(text)) return "网络异常，无法连接 GitHub";
  return line ? `${action}失败: ${line}` : `${action}失败`;
}

/** 读取来自 IPC 的可选文本输入;非字符串按未提供处理,避免 trim 抛错。 */
function readInputText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function summarizeChecks(value: unknown): PrChecksSummary {
  if (!Array.isArray(value)) return "none";
  const checks = value.filter(isRecord);
  if (checks.length === 0) return "none";
  let failing = false;
  let pending = false;
  for (const check of checks) {
    const state = classifyCheckRollup(check);
    if (state === "failing") failing = true;
    else if (state === "pending") pending = true;
    // SKIPPED/NEUTRAL 既不算失败也不算等待。
  }
  if (failing) return "failing";
  if (pending) return "pending";
  return "passing";
}

/** statusCheckRollup 单项 → 失败/等待/通过;SKIPPED、NEUTRAL 归入通过侧。 */
function classifyCheckRollup(check: Record<string, unknown>): "failing" | "pending" | "passing" {
  const state = (
    readText(check, "conclusion") ??
    readText(check, "state") ??
    readText(check, "status") ??
    ""
  ).toUpperCase();
  if (
    ["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "ERROR", "STARTUP_FAILURE"].includes(
      state,
    )
  ) {
    return "failing";
  }
  if (["", "PENDING", "IN_PROGRESS", "QUEUED", "EXPECTED", "WAITING", "REQUESTED"].includes(state)) {
    return "pending";
  }
  return "passing";
}

/** PR-07:统计失败与等待的检查数量,便于在阻止条件里说明原因。 */
function countChecks(value: unknown): { failing: number; pending: number } {
  let failing = 0;
  let pending = 0;
  if (!Array.isArray(value)) return { failing, pending };
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const state = classifyCheckRollup(entry);
    if (state === "failing") failing += 1;
    else if (state === "pending") pending += 1;
  }
  return { failing, pending };
}

/** gh 的 state/isDraft → PrState;MERGED/CLOSED 优先于 draft。 */
export function readPrState(value: Record<string, unknown>): PrState {
  const rawState = (readText(value, "state") ?? "OPEN").toUpperCase();
  if (rawState === "MERGED") return "merged";
  if (rawState === "CLOSED") return "closed";
  return value.isDraft === true ? "draft" : "open";
}

/** gh 的 bucket/state → 检查单项状态;取消与跳过单独区分。 */
export function mapCheckState(bucket: string | null, state: string | null): PrCheckState {
  const b = (bucket ?? "").toLowerCase();
  const s = (state ?? "").toLowerCase();
  if (b === "pass" || s === "success" || s === "passing" || s === "pass") return "passing";
  if (b === "cancel" || s === "cancelled" || s === "canceled" || s === "cancel") return "cancelled";
  if (
    b === "fail" ||
    s === "failure" ||
    s === "error" ||
    s === "action_required" ||
    s === "timed_out" ||
    s === "timeout" ||
    s === "startup_failure" ||
    s === "fail"
  ) {
    return "failing";
  }
  if (b === "skipping" || b === "skip" || s === "skipped" || s === "neutral" || s === "skipping") {
    return "skipped";
  }
  if (
    b === "pending" ||
    s === "pending" ||
    s === "queued" ||
    s === "expected" ||
    s === "in_progress" ||
    s === "waiting" ||
    s === "requested"
  ) {
    return "pending";
  }
  return "unknown";
}

function combineGhOutput(result: GhResult): string {
  return `${result.stdout}\n${result.stderr}`.trim();
}

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ""
  );
}

function classifyGhFailure(result: GhResult): GhFailureKind {
  if (result.timedOut || result.killed) return "offline";
  const text = combineGhOutput(result);
  if (isAuthText(text)) return "unauthenticated";
  if (isPermissionText(text)) return "permission";
  if (isOfflineText(text)) return "offline";
  return "failed";
}

function ghFailureReason(kind: GhFailureKind, result: GhResult): string {
  if (kind === "unauthenticated") return "gh 未登录或登录已失效,请运行 gh auth login";
  if (kind === "permission") return "没有访问 GitHub 仓库的权限";
  if (kind === "offline") {
    return result.timedOut || result.killed ? "请求 GitHub 超时,请检查网络" : "网络异常,无法连接 GitHub";
  }
  const line = firstLine(combineGhOutput(result));
  return line ? `读取 Pull Request 失败: ${line}` : "读取 Pull Request 失败";
}

function describeCreateFailure(result: GhResult): string {
  if (result.timedOut || result.killed) return "创建 Pull Request 超时或进程被终止,结果尚未确认";
  if (result.spawnError) return `无法启动 gh: ${result.spawnError}`;
  const text = combineGhOutput(result);
  const line = firstLine(text);
  if (isAuthText(text)) return "gh 未登录或登录已失效,请运行 gh auth login 后重试";
  if (isPermissionText(text)) {
    return line ? `没有创建 Pull Request 的权限: ${line}` : "没有创建 Pull Request 的权限";
  }
  if (isOfflineText(text)) return "网络异常,无法连接 GitHub";
  if (isValidationText(text)) {
    return line ? `创建 Pull Request 校验未通过: ${line}` : "创建 Pull Request 校验未通过";
  }
  return line ? `创建 Pull Request 失败: ${line}` : "创建 Pull Request 失败";
}

function isAuthText(text: string): boolean {
  return /not logged|logged out|auth login|not authenticated|authentication (failed|required)|bad credentials|http 401|invalid token|token.*(invalid|expired)|no oauth token|missing.*token|gh_token|to get started with github cli/i.test(
    text,
  );
}

function isPermissionText(text: string): boolean {
  return /403|forbidden|permission|not accessible|must have (push|admin|write) access|resource not accessible|insufficient|denied/i.test(
    text,
  );
}

function isOfflineText(text: string): boolean {
  return /dial tcp|no such host|network|connection refused|i\/o timeout|tls handshake|could not resolve host|temporary failure in name resolution|proxyconnect|network is unreachable/i.test(
    text,
  );
}

function isValidationText(text: string): boolean {
  return /validation|invalid|not found|already exists|already been created|could not resolve|no commits between|head branch|base branch/i.test(
    text,
  );
}

function extractPrUrl(stdout: string): string | null {
  const match = /https?:\/\/[^\s"'<>]+\/pull\/\d+/.exec(stdout);
  return match ? match[0] : null;
}

function numberFromUrl(url: string | null): number | null {
  if (!url) return null;
  const match = /\/pull\/(\d+)/.exec(url);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseJsonObject(stdout: string): Record<string, unknown> | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseJsonArray(stdout: string): unknown[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readText(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readTimestamp(record: Record<string, unknown>, key: string): number | null {
  const text = readText(record, key);
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : parsed;
}

function readLogin(value: unknown): string | null {
  return isRecord(value) ? readText(value, "login") : null;
}

function slugToRepoRef(slug: string): PrRepoRef | null {
  const parts = slug.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { owner: parts[0], name: parts[1], host: "github.com", baseRepo: slug };
}

function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

/** 递归收集模板目录下 .md/.markdown 文件,按路径排序保证稳定。 */
async function walkMarkdownFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkMarkdownFiles(full)));
    } else if (entry.isFile() && /\.(md|markdown)$/i.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

export { parseGithubSlug } from "./github-url";
