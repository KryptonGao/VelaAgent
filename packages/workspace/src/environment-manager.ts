import { mkdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type {
  ExecutionEnvironment,
  ExecutionEnvironmentKind,
  SelectableEnvironmentKind,
} from "@vela/shared";
import { gitMutate, gitQuery } from "./git-run";

const kindLabels: Record<ExecutionEnvironmentKind, string> = {
  local: "本地",
  sandbox: "沙箱",
  remote: "远程",
  worktree: "工作树",
};

/**
 * Agent 的执行环境。本地与工作树(同一仓库的独立 git worktree)已实现,
 * 沙箱 / 远程仍是占位。激活环境由当前工作区路径推导:工作区是受管的
 * git worktree 时即为工作树环境,无需单独维护激活状态。
 */
export class ExecutionEnvironmentManager {
  private workspacePath: string | null = null;
  /** worktree 路径 → 创建它时的工作区(仓库)路径。 */
  private readonly worktrees = new Map<string, string>();
  private currentWorktree: string | null = null;

  constructor(
    private readonly fallbackCwd: string,
    private readonly worktreeRoot: string,
  ) {}

  /** 工作区变化时同步;识别受管或遗留的 worktree 路径。 */
  async setWorkspace(path: string | null): Promise<void> {
    this.workspacePath = path;
    this.currentWorktree = null;
    if (!path) return;
    if (this.worktrees.has(path)) {
      this.currentWorktree = path;
      return;
    }
    if (await isLinkedWorktree(path)) {
      this.currentWorktree = path;
      // 上次运行创建的 worktree:找回它的工作区,便于切回本地。
      const base = await resolveMainWorktree(path);
      if (base) this.worktrees.set(path, base);
    }
  }

  getActive(): ExecutionEnvironment {
    if (this.currentWorktree && this.workspacePath === this.currentWorktree) {
      return { kind: "worktree", label: kindLabels.worktree, path: this.currentWorktree, available: true };
    }
    return {
      kind: "local",
      label: kindLabels.local,
      path: this.workspacePath ?? this.fallbackCwd,
      available: true,
    };
  }

  async list(): Promise<ExecutionEnvironment[]> {
    const active = this.getActive();
    const localPath = active.kind === "worktree" ? this.worktrees.get(active.path) ?? "" : active.path;
    return [
      { kind: "local", label: kindLabels.local, path: localPath, available: true },
      { kind: "worktree", label: kindLabels.worktree, path: this.currentWorktree ?? "", available: true },
      { kind: "sandbox", label: kindLabels.sandbox, path: "", available: false },
      { kind: "remote", label: kindLabels.remote, path: "", available: false },
    ];
  }

  /** 切换到指定环境应使用的工作区路径(必要时创建 worktree)。 */
  async resolve(kind: SelectableEnvironmentKind): Promise<string> {
    if (kind === "local") {
      const inWorktree = this.currentWorktree && this.workspacePath === this.currentWorktree;
      if (inWorktree) {
        const base = this.currentWorktree ? this.worktrees.get(this.currentWorktree) : null;
        if (!base) throw new Error("无法定位原工作区目录");
        return base;
      }
      return this.workspacePath ?? this.fallbackCwd;
    }

    const workspace = this.workspacePath;
    if (!workspace) throw new Error("先选择一个工作区");
    if (this.currentWorktree && this.workspacePath === this.currentWorktree) {
      return this.currentWorktree;
    }
    for (const [worktree, base] of this.worktrees) {
      if (base !== workspace) continue;
      if (await isDirectory(worktree)) return worktree;
      this.worktrees.delete(worktree);
    }
    return this.createWorktree(workspace);
  }

  /** 为当前仓库创建独立 git worktree(新分支),返回其路径。 */
  private async createWorktree(workspace: string): Promise<string> {
    await mkdir(this.worktreeRoot, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    const path = join(this.worktreeRoot, `${basename(workspace)}-wt-${stamp}`);
    await gitMutate(workspace, ["worktree", "add", "-b", `vela/wt-${stamp}`, path]);
    this.worktrees.set(path, workspace);
    this.currentWorktree = path;
    return path;
  }
}

/** linked worktree 的 .git 是指向主仓库 gitdir 的文件,普通仓库是目录。 */
async function isLinkedWorktree(path: string): Promise<boolean> {
  const gitPath = join(path, ".git");
  try {
    const info = await stat(gitPath);
    if (!info.isFile()) return false;
    const content = await readFile(gitPath, "utf8");
    return content.trimStart().startsWith("gitdir:");
  } catch {
    return false;
  }
}

/** 从 worktree 内执行 `git worktree list --porcelain`,取第一段(主工作树)路径。 */
async function resolveMainWorktree(worktree: string): Promise<string | null> {
  try {
    const stdout = await gitQuery(worktree, ["worktree", "list", "--porcelain"]);
    const line = stdout.split("\n").find((entry) => entry.startsWith("worktree "));
    return line ? line.slice("worktree ".length).trim() || null : null;
  } catch {
    return null;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
