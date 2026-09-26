import { readFile, watch, type FSWatcher } from "node:fs";
import { basename, isAbsolute, relative } from "node:path";
import type {
  BranchSummary,
  GitFileChange,
  GitFileStatus,
  GitStatusSnapshot,
} from "@vela/shared";
import { gitMutate, gitQuery, assertValidRefName, runGit } from "./git-run";

const refreshDebounceMs = 600;
const maxUntrackedSampleBytes = 2 * 1024 * 1024;

type StatusListener = (snapshot: GitStatusSnapshot | null) => void;

/**
 * 基于 git CLI 的工作树状态服务。所有命令以工作区为 cwd 运行,
 * git 自行向上查找仓库根,因此工作区可以是仓库的子目录。
 */
export class GitService {
  private workspacePath: string | null = null;
  private snapshot: GitStatusSnapshot | null = null;
  private readonly listeners = new Set<StatusListener>();
  private readonly watchers: FSWatcher[] = [];
  private refreshTimer: NodeJS.Timeout | null = null;
  private refreshSeq = 0;

  subscribe(listener: StatusListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): GitStatusSnapshot | null {
    return this.snapshot;
  }

  getWorkspace(): string | null {
    return this.workspacePath;
  }

  /** 绑定工作区(null 解绑),立即刷新并启动文件监听。 */
  async attach(workspacePath: string | null): Promise<GitStatusSnapshot | null> {
    this.stopWatching();
    this.workspacePath = workspacePath;
    const snapshot = await this.refresh();
    this.startWatching();
    return snapshot;
  }

  async refresh(): Promise<GitStatusSnapshot | null> {
    const seq = ++this.refreshSeq;
    const next = this.workspacePath ? await collectStatus(this.workspacePath) : null;
    if (seq !== this.refreshSeq) return this.snapshot;
    this.snapshot = next;
    for (const listener of this.listeners) listener(next);
    return next;
  }

  async listBranches(): Promise<BranchSummary[]> {
    if (!this.workspacePath) return [];
    const local = await gitQuery(this.workspacePath, [
      "branch",
      "--format=%(refname:short)\t%(HEAD)",
    ]).catch(() => "");
    const remote = await gitQuery(this.workspacePath, [
      "branch",
      "-r",
      "--format=%(refname:short)\t%(HEAD)",
    ]).catch(() => "");
    const branches: BranchSummary[] = [];
    for (const line of local.split("\n")) {
      const [name, head] = line.split("\t");
      if (!name) continue;
      branches.push({ name, current: head === "*", remote: false });
    }
    for (const line of remote.split("\n")) {
      const [name, head] = line.split("\t");
      if (!name || name.endsWith("/HEAD")) continue;
      branches.push({ name, current: head === "*", remote: true });
    }
    return branches;
  }

  async switchBranch(name: string): Promise<GitStatusSnapshot | null> {
    return this.mutateAndRefresh(async (cwd) => {
      await assertValidRefName(cwd, name);
      await gitMutate(cwd, ["switch", name]);
    });
  }

  async createBranch(name: string): Promise<GitStatusSnapshot | null> {
    return this.mutateAndRefresh(async (cwd) => {
      await assertValidRefName(cwd, name);
      await gitMutate(cwd, ["switch", "--create", name]);
    });
  }

  async fileDiff(path: string, staged: boolean): Promise<string> {
    if (!this.workspacePath) return "";
    // 未跟踪文件不在 HEAD 中,用 --no-index 生成「全部新增」的差异。
    const untracked = this.snapshot?.files.some(
      (file) => file.path === path && file.status === "untracked",
    );
    if (untracked) {
      const result = await runGit(this.workspacePath, [
        "--no-optional-locks",
        "diff",
        "--no-color",
        "--no-index",
        "--",
        "/dev/null",
        path,
      ]);
      return result.stdout;
    }
    const args = ["--no-optional-locks", "diff", "--no-color", path];
    if (staged) args.splice(2, 0, "--cached");
    const result = await runGit(this.workspacePath, args);
    return result.stdout;
  }

  async stage(paths: string[]): Promise<GitStatusSnapshot | null> {
    return this.mutateAndRefresh(async (cwd) => {
      await gitMutate(cwd, ["add", "--", ...paths]);
    });
  }

  async unstage(paths: string[]): Promise<GitStatusSnapshot | null> {
    return this.mutateAndRefresh(async (cwd) => {
      const result = await runGit(cwd, ["reset", "-q", "HEAD", "--", ...paths]);
      if (result.code !== 0) {
        // 初始提交(HEAD 尚不存在)时回退为直接移出暂存区。
        await gitMutate(cwd, ["rm", "--cached", "-q", "--", ...paths]);
      }
    });
  }

  async discard(paths: string[]): Promise<GitStatusSnapshot | null> {
    return this.mutateAndRefresh(async (cwd) => {
      const snapshot = this.snapshot;
      const untracked = paths.filter((path) =>
        snapshot?.files.some((file) => file.path === path && file.status === "untracked"),
      );
      const tracked = paths.filter((path) => !untracked.includes(path));
      if (tracked.length > 0) {
        // checkout HEAD 同时还原暂存区与工作区(含已暂存的新文件会报错,单独处理)。
        const result = await runGit(cwd, ["checkout", "-q", "HEAD", "--", ...tracked]);
        if (result.code !== 0) {
          await gitMutate(cwd, ["rm", "-qf", "--", ...tracked]);
        }
      }
      if (untracked.length > 0) {
        await gitMutate(cwd, ["clean", "-qf", "--", ...untracked]);
      }
    });
  }

  private async mutateAndRefresh(
    task: (cwd: string) => Promise<void>,
  ): Promise<GitStatusSnapshot | null> {
    if (!this.workspacePath) throw new Error("未选择工作区");
    await task(this.workspacePath);
    return this.refresh();
  }

  private startWatching(): void {
    if (!this.workspacePath) return;
    try {
      const watcher = watch(this.workspacePath, { recursive: true }, (_event, file) => {
        this.scheduleRefresh(file);
      });
      watcher.on("error", () => this.stopWatching());
      this.watchers.push(watcher);
    } catch {
      // 平台不支持递归监听时退化为仅靠 agent 工具事件触发刷新。
    }
  }

  private stopWatching(): void {
    for (const watcher of this.watchers) {
      try {
        watcher.close();
      } catch {
        // watcher 可能已关闭
      }
    }
    this.watchers.length = 0;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private scheduleRefresh(file: string | Buffer | null): void {
    const changed = typeof file === "string" ? file : "";
    if (isNoise(changed)) return;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh().catch(() => undefined);
    }, refreshDebounceMs);
  }
}

function isNoise(relativeFile: string): boolean {
  if (!relativeFile) return false;
  const segments = relativeFile.split("/");
  return segments.some(
    (segment) => segment === "node_modules" || (segment === ".git" && segments.indexOf(segment) !== segments.length - 1 && segments.length - 1 - segments.indexOf(segment) > 1),
  );
}

export async function collectStatus(cwd: string): Promise<GitStatusSnapshot | null> {
  const root = await resolveRepoRoot(cwd);
  if (!root) return null;

  const empty: GitStatusSnapshot = {
    repo: { root, name: basename(root), remoteUrl: await resolveRemoteUrl(cwd) },
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    detached: false,
    files: [],
    addedLines: 0,
    deletedLines: 0,
  };

  let porcelain: string;
  try {
    porcelain = await gitQuery(cwd, ["status", "--porcelain=v2", "--branch"]);
  } catch {
    return empty;
  }

  const snapshot: GitStatusSnapshot = { ...empty, files: [] };
  const untracked: string[] = [];
  const renameSources = new Map<string, string>();

  for (const line of porcelain.split("\n")) {
    if (line.startsWith("# branch.head ")) {
      const head = line.slice("# branch.head ".length).trim();
      snapshot.detached = head === "(detached)";
      snapshot.branch = snapshot.detached ? null : head;
    } else if (line.startsWith("# branch.upstream ")) {
      snapshot.upstream = line.slice("# branch.upstream ".length).trim();
    } else if (line.startsWith("# branch.ab ")) {
      const match = /\+(\d+)\s+-(\d+)/.exec(line);
      if (match) {
        snapshot.ahead = Number(match[1]);
        snapshot.behind = Number(match[2]);
      }
    } else if (line.startsWith("2 ")) {
      const entry = parseEntry(line, 2);
      if (entry && entry.oldPath) {
        renameSources.set(entry.path, entry.oldPath);
      }
      if (entry) snapshot.files.push(entry);
    } else if (line.startsWith("1 ")) {
      const entry = parseEntry(line, 1);
      if (entry) snapshot.files.push(entry);
    } else if (line.startsWith("? ")) {
      const path = unquote(line.slice(2));
      if (path) untracked.push(path);
    }
  }

  if (untracked.length > 0) {
    const counts = await countUntrackedLines(cwd, untracked);
    for (const path of untracked) {
      snapshot.files.push({
        path,
        oldPath: null,
        status: "untracked",
        staged: false,
        addedLines: counts.get(path) ?? 0,
        deletedLines: 0,
      });
    }
  }

  const numstat = await collectNumstat(cwd, renameSources);
  for (const file of snapshot.files) {
    const stat = numstat.get(file.path);
    if (stat) {
      file.addedLines = stat.added;
      file.deletedLines = stat.deleted;
    }
  }
  snapshot.addedLines = snapshot.files.reduce((sum, file) => sum + file.addedLines, 0);
  snapshot.deletedLines = snapshot.files.reduce((sum, file) => sum + file.deletedLines, 0);
  return snapshot;
}

async function resolveRepoRoot(cwd: string): Promise<string | null> {
  try {
    const result = await runGit(cwd, ["--no-optional-locks", "rev-parse", "--show-toplevel"]);
    if (result.code !== 0) return null;
    const root = result.stdout.trim();
    return root || null;
  } catch {
    return null;
  }
}

async function resolveRemoteUrl(cwd: string): Promise<string | null> {
  try {
    const result = await runGit(cwd, ["--no-optional-locks", "config", "--get", "remote.origin.url"]);
    if (result.code !== 0) return null;
    const url = result.stdout.trim();
    return url || null;
  } catch {
    return null;
  }
}

function parseEntry(line: string, kind: 1 | 2): GitFileChange | null {
  const parts = line.split(" ");
  const xy = parts[1];
  if (xy.length !== 2) return null;
  const indexCode = xy[0];
  const worktreeCode = xy[1];
  // XY 之后剩余字段:<sub> <mH> <mI> <mW> <hH> <hI> [X<score>] <path>[\t<origPath>]
  const tail = line.slice(line.indexOf(xy) + 3);
  let path: string;
  let oldPath: string | null = null;
  if (kind === 2) {
    const tab = tail.indexOf("\t");
    if (tab < 0) return null;
    const head = tail.slice(0, tab);
    const lastSpace = head.lastIndexOf(" ");
    if (lastSpace < 0) return null;
    path = unquote(head.slice(lastSpace + 1));
    oldPath = unquote(tail.slice(tab + 1));
  } else {
    // <sub> <mH> <mI> <mW> <hH> <hI> <path>
    const columns = tail.split(" ");
    path = unquote(columns.slice(6).join(" "));
  }
  if (!path) return null;

  const hasIndex = indexCode !== "." && indexCode !== "?";
  const hasWorktree = worktreeCode !== "." && worktreeCode !== "?";
  const codes = `${indexCode}${worktreeCode}`;
  let status: GitFileStatus = "modified";
  if (codes.includes("A")) status = "added";
  else if (codes.includes("D")) status = "deleted";
  else if (codes.includes("R") || codes.includes("C")) status = "renamed";
  // 未暂存部分与暂存部分并存时按未暂存处理,便于一键 stage 剩余改动。
  const staged = hasIndex && !hasWorktree;

  return { path, oldPath: status === "renamed" ? oldPath : null, status, staged, addedLines: 0, deletedLines: 0 };
}

function unquote(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  return value;
}

async function collectNumstat(
  cwd: string,
  renameSources: Map<string, string>,
): Promise<Map<string, { added: number; deleted: number }>> {
  const result = new Map<string, { added: number; deleted: number }>();
  try {
    const stdout = await gitQuery(cwd, ["diff", "HEAD", "--numstat", "-z"]);
    for (const record of stdout.split("\0")) {
      if (!record.trim()) continue;
      const tabs = record.split("\t");
      if (tabs.length < 3) continue;
      const added = tabs[0] === "-" ? 0 : Number(tabs[0]) || 0;
      const deleted = tabs[1] === "-" ? 0 : Number(tabs[1]) || 0;
      const oldPath = tabs[2];
      const newPath = tabs.length > 3 ? tabs[3] : tabs[2];
      if (oldPath !== newPath) renameSources.set(newPath, oldPath);
      result.set(newPath, { added, deleted });
    }
  } catch {
    // 空仓库没有 HEAD,行数统计为 0 即可。
  }
  return result;
}

async function countUntrackedLines(cwd: string, paths: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  await Promise.all(
    paths.map(async (path) => {
      try {
        const response = await new Promise<{ bytes: number; lines: number }>((resolve, reject) => {
          readFile(`${cwd}/${path}`, (error, buffer) => {
            if (error) {
              reject(error);
              return;
            }
            resolve({ bytes: buffer.byteLength, lines: countLines(buffer) });
          });
        });
        counts.set(path, response.bytes > maxUntrackedSampleBytes ? 0 : response.lines);
      } catch {
        counts.set(path, 0);
      }
    }),
  );
  return counts;
}

function countLines(buffer: Buffer): number {
  let lines = 0;
  for (const byte of buffer) {
    if (byte === 0x0a) lines += 1;
  }
  if (buffer.length > 0 && buffer[buffer.length - 1] !== 0x0a) lines += 1;
  return lines;
}

export function isPathInside(target: string, boundary: string): boolean {
  const rel = relative(boundary, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
