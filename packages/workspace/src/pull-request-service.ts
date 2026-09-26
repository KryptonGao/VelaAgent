import { spawn } from "node:child_process";
import type { PrChecksSummary, PrState, PrSummary, PullRequestInfo } from "@vela/shared";
import type { GitStatusSnapshot } from "@vela/shared";
import { runGit } from "./git-run";

interface GhPrJson {
  number: number;
  title: string;
  url: string;
  state: string;
  isDraft: boolean;
  reviewDecision: string | null;
  baseRefName: string;
  headRefName: string;
  statusCheckRollup: Array<{
    status?: string | null;
    conclusion?: string | null;
    state?: string | null;
  } | null>;
  reviews: Array<{ state: string; author: { login: string } | null } | null>;
}

const ghFields = [
  "number",
  "title",
  "url",
  "state",
  "isDraft",
  "reviewDecision",
  "baseRefName",
  "headRefName",
  "statusCheckRollup",
  "reviews",
].join(",");

const cacheTtlMs = 30_000;

/**
 * 通过 gh CLI 读取当前分支的 Pull Request;gh 不可用时降级为
 * 打开 GitHub 网页(创建 PR 跳转 compare 页)。
 */
export class PullRequestService {
  private ghCheck: { ok: boolean; reason: string | null } | null = null;
  private ghCheckedAt = 0;
  private lastResult: PullRequestInfo | null = null;
  private cwdProvider: (() => string | null) | null = null;

  constructor(
    private readonly getSnapshot: () => GitStatusSnapshot | null,
    private readonly openExternal: (url: string) => void,
  ) {}

  /** 由组装方注入工作区路径,避免与 GitService 相互依赖。 */
  setCwdProvider(provider: () => string | null): void {
    this.cwdProvider = provider;
  }

  async getForCurrentBranch(): Promise<PullRequestInfo> {
    const snapshot = this.getSnapshot();
    if (!snapshot?.repo || !snapshot.branch) {
      return { ghAvailable: false, reason: null, pr: null };
    }

    const ghReady = await this.checkGh();
    if (!ghReady.ok) {
      return { ghAvailable: false, reason: ghReady.reason, pr: null };
    }

    const cwd = this.cwdProvider?.() ?? null;
    if (!cwd) return { ghAvailable: true, reason: null, pr: null };

    try {
      const result = await runGh(cwd, ["pr", "view", "--json", ghFields], 20_000);
      // 当前分支没有 PR 时 gh 以非零退出,视为「暂无 PR」而非错误。
      const pr = result.ok ? toSummary(JSON.parse(result.stdout.trim()) as GhPrJson) : null;
      this.lastResult = { ghAvailable: true, reason: null, pr };
      return this.lastResult;
    } catch {
      return { ghAvailable: true, reason: "读取 Pull Request 失败", pr: null };
    }
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

  private async defaultBranch(): Promise<string> {
    const cwd = this.cwdProvider?.() ?? null;
    if (!cwd) return "main";
    const result = await runGit(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).catch(
      () => null,
    );
    const name = result?.stdout.trim().split("/").pop();
    return name || "main";
  }

  private async checkGh(): Promise<{ ok: boolean; reason: string | null }> {
    if (this.ghCheck && Date.now() - this.ghCheckedAt < cacheTtlMs) return this.ghCheck;
    this.ghCheckedAt = Date.now();

    const version = await runGh(null, ["--version"], 5_000);
    if (!version.ok) {
      this.ghCheck = { ok: false, reason: "未安装 GitHub CLI(gh),PR 功能降级为网页操作" };
      return this.ghCheck;
    }
    const auth = await runGh(null, ["auth", "status"], 10_000);
    if (!auth.ok) {
      this.ghCheck = { ok: false, reason: "gh 未登录,请在终端运行 gh auth login" };
      return this.ghCheck;
    }
    this.ghCheck = { ok: true, reason: null };
    return this.ghCheck;
  }
}

function runGh(
  cwd: string | null,
  args: string[],
  timeoutMs: number,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("gh", args, { cwd: cwd ?? undefined });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, stdout, stderr });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(false);
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", () => finish(false));
    child.on("close", (code) => finish((code ?? -1) === 0));
  });
}

function toSummary(pr: GhPrJson): PrSummary {
  const state: PrState = pr.isDraft
    ? "draft"
    : pr.state === "MERGED"
      ? "merged"
      : pr.state === "CLOSED"
        ? "closed"
        : "open";
  const approvals = new Set(
    (pr.reviews ?? [])
      .filter(
        (review): review is NonNullable<typeof review> =>
          review !== null && review.state === "APPROVED",
      )
      .map((review) => review.author?.login ?? "")
      .filter(Boolean),
  ).size;
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    state,
    reviewDecision: pr.reviewDecision,
    approvals,
    checks: summarizeChecks(pr.statusCheckRollup ?? []),
    baseRefName: pr.baseRefName,
    headRefName: pr.headRefName,
  };
}

function summarizeChecks(rollup: NonNullable<GhPrJson["statusCheckRollup"]>): PrChecksSummary {
  const checks = rollup.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
  if (checks.length === 0) return "none";
  let failing = false;
  let pending = false;
  for (const check of checks) {
    const state = (check.conclusion ?? check.state ?? "").toUpperCase();
    if (["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "ERROR"].includes(state)) {
      failing = true;
    } else if (["PENDING", "IN_PROGRESS", "QUEUED", "EXPECTED", "STALE", ""].includes(state)) {
      pending = true;
    }
  }
  if (failing) return "failing";
  if (pending) return "pending";
  return "passing";
}

/** git@github.com:owner/repo.git 或 https://github.com/owner/repo.git → owner/repo */
export function parseGithubSlug(remoteUrl: string | null): string | null {
  if (!remoteUrl) return null;
  const trimmed = remoteUrl.trim();
  const ssh = /^git@[^:]+:([^/]+\/[^/]+?)(?:\.git)?$/i.exec(trimmed);
  if (ssh) return ssh[1];
  const https = /^https?:\/\/[^/]+\/([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(trimmed);
  if (https) return https[1];
  return null;
}
