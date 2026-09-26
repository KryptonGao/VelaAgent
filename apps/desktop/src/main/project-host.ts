import { readFile, stat } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";
import { AgentRuntime } from "@vela/agent";
import {
  IpcChannel,
  type AttachmentPickKind,
  type FileAttachmentPayload,
  type GitEvent,
  type SandboxApprovalEvent,
  type SandboxMode,
  type SelectableEnvironmentKind,
  type WorkspaceEvent,
  type WorkspaceState,
} from "@vela/shared";
import {
  ExecutionEnvironmentManager,
  GitService,
  PullRequestService,
  SandboxPermissionManager,
  WorkspaceFileService,
  WorkspaceManager,
  type WorkspaceRoots,
} from "@vela/workspace";
import { BrowserWindow, dialog, ipcMain, shell } from "electron";

const agentMutationDebounceMs = 800;
const maxAttachmentCount = 20;
const maxImageBytes = 10 * 1024 * 1024;
const imageMimeByExt: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export interface ProjectHostOptions {
  workspaceManager: WorkspaceManager;
  git: GitService;
  files: WorkspaceFileService;
  pr: PullRequestService;
  sandbox: SandboxPermissionManager;
  env: ExecutionEnvironmentManager;
  runtime: AgentRuntime;
  fallbackCwd: string;
}

/**
 * 装配 Workspace / Git / PR / Sandbox 服务并注册它们的 IPC。
 * 工作区变化时统一编排:重挂 git → 刷新环境 → 重建 Agent 会话 → 推送事件。
 */
export class ProjectHost {
  private switchChain: Promise<void> = Promise.resolve();
  private mutationTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: ProjectHostOptions) {
    this.options.git.subscribe(() => {
      this.broadcast(IpcChannel.gitEvent, { type: "status-changed" } satisfies GitEvent);
    });
    this.options.sandbox.subscribe((event) => {
      this.broadcast(IpcChannel.sandboxApprovalEvent, event satisfies SandboxApprovalEvent);
    });
    this.options.workspaceManager.subscribe((workspace) => {
      this.switchChain = this.switchChain.then(() => this.onWorkspaceChanged(workspace));
    });
  }

  register(): void {
    ipcMain.handle(IpcChannel.workspaceOpenDialog, async (event) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      const dialogOptions = {
        title: "选择工作区文件夹",
        buttonLabel: "选择",
        properties: ["openDirectory", "createDirectory"] as ("openDirectory" | "createDirectory")[],
      };
      const result = win
        ? await dialog.showOpenDialog(win, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);
      if (result.canceled || result.filePaths.length === 0) {
        return this.options.workspaceManager.getState();
      }
      return this.options.workspaceManager.select(result.filePaths[0]);
    });
    ipcMain.handle(IpcChannel.workspaceGetState, () => this.options.workspaceManager.getState());
    ipcMain.handle(IpcChannel.workspaceSelect, (_event, raw: unknown) => {
      return this.options.workspaceManager.select(parsePath(raw, "工作区路径"));
    });
    ipcMain.handle(IpcChannel.workspaceClose, () => this.options.workspaceManager.close());
    ipcMain.handle(IpcChannel.workspaceRemoveRecent, (_event, raw: unknown) => {
      return this.options.workspaceManager.removeRecent(parsePath(raw, "工作区路径"));
    });
    ipcMain.handle(IpcChannel.envGet, () => this.options.env.getActive());
    ipcMain.handle(IpcChannel.envList, () => this.options.env.list());
    ipcMain.handle(IpcChannel.envSet, async (_event, raw: unknown) => {
      const kind = parseEnvironmentKind(raw);
      const target = await this.options.env.resolve(kind);
      await this.options.workspaceManager.select(target);
      return this.options.env.getActive();
    });

    ipcMain.handle(IpcChannel.gitGetStatus, () => this.options.git.getSnapshot());
    ipcMain.handle(IpcChannel.gitListBranches, () => this.options.git.listBranches());
    ipcMain.handle(IpcChannel.gitSwitchBranch, async (_event, raw: unknown) => {
      return this.options.git.switchBranch(parseBranchName(raw));
    });
    ipcMain.handle(IpcChannel.gitCreateBranch, async (_event, raw: unknown) => {
      return this.options.git.createBranch(parseBranchName(raw));
    });
    ipcMain.handle(IpcChannel.gitFileDiff, async (_event, rawPath: unknown, rawStaged: unknown) => {
      return this.options.git.fileDiff(parseRelativePath(rawPath), rawStaged === true);
    });
    ipcMain.handle(IpcChannel.gitStage, (_event, raw: unknown) => {
      return this.options.git.stage(parsePathList(raw));
    });
    ipcMain.handle(IpcChannel.gitUnstage, (_event, raw: unknown) => {
      return this.options.git.unstage(parsePathList(raw));
    });
    ipcMain.handle(IpcChannel.gitDiscard, (_event, raw: unknown) => {
      return this.options.git.discard(parsePathList(raw));
    });
    ipcMain.handle(IpcChannel.gitOpenFile, async (_event, raw: unknown) => {
      // 只调用系统默认程序打开,不向渲染进程返回任何文件内容,
      // 因此不限制在仓库/工作区边界内(预览面板对工作区外文件也提供此操作)。
      const absolutePath = parseAbsolutePath(raw);
      const message = await shell.openPath(absolutePath);
      if (message) throw new Error(message);
    });

    ipcMain.handle(IpcChannel.workspaceFileRead, async (_event, rawPath: unknown) => {
      return this.options.files.read(this.workspaceRoots(), parseFlexiblePath(rawPath));
    });
    ipcMain.handle(IpcChannel.workspaceFileList, () => {
      return this.options.files.listFiles(this.workspaceRoots());
    });
    ipcMain.handle(IpcChannel.workspaceSearch, async (_event, rawQuery: unknown) => {
      return this.options.files.search(this.workspaceRoots(), parsePath(rawQuery, "搜索词"));
    });

    ipcMain.handle(IpcChannel.prGet, () => this.options.pr.getForCurrentBranch());
    ipcMain.handle(IpcChannel.prOpen, (_event, raw: unknown) => {
      return this.options.pr.openPr(parseUrl(raw));
    });
    ipcMain.handle(IpcChannel.prCreate, () => this.options.pr.createPr());

    ipcMain.handle(IpcChannel.sandboxGetMode, () => this.options.sandbox.getMode());
    ipcMain.handle(IpcChannel.sandboxSetMode, (_event, raw: unknown) => {
      return this.options.sandbox.setMode(parseSandboxMode(raw));
    });
    ipcMain.handle(IpcChannel.sandboxApprovalReply, (_event, rawId: unknown, rawAllowed: unknown) => {
      if (typeof rawAllowed !== "boolean") throw new Error("审批回复不正确");
      this.options.sandbox.reply(parseId(rawId, "审批请求"), rawAllowed);
    });

    ipcMain.handle(IpcChannel.appPickAttachments, async (event, rawKind: unknown) => {
      const kind: AttachmentPickKind = rawKind === "image" ? "image" : "file";
      const win = BrowserWindow.fromWebContents(event.sender);
      const options = {
        title: kind === "image" ? "选择图片" : "选择文件",
        properties: ["openFile", "multiSelections"] as ("openFile" | "multiSelections")[],
        ...(kind === "image"
          ? { filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }] }
          : {}),
      };
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options);
      if (result.canceled || result.filePaths.length === 0) return [];
      return this.hydrateAttachments(result.filePaths);
    });
    ipcMain.handle(IpcChannel.appHydrateAttachments, (_event, raw: unknown) => {
      if (!Array.isArray(raw)) throw new Error("附件路径不正确");
      const paths = raw.map((entry) => parseAbsolutePath(entry));
      if (paths.length > maxAttachmentCount) throw new Error("附件过多");
      return this.hydrateAttachments(paths);
    });
  }

  /** SessionHost 在 agent 的 bash/edit/write 工具结束后调用,防抖刷新 git 状态。 */
  notifyAgentMutation(): void {
    if (this.mutationTimer) clearTimeout(this.mutationTimer);
    this.mutationTimer = setTimeout(() => {
      this.mutationTimer = null;
      void this.options.git.refresh().catch(() => undefined);
    }, agentMutationDebounceMs);
  }

  /**
   * 让工作区选择跟随激活会话,保证输入区的工作区/环境/仓库卡片
   * 与会话目录(Context 面板)一致。会话目录不存在时保持原工作区。
   */
  async syncConversationWorkspace(cwd: string): Promise<void> {
    if (!cwd || cwd === this.options.workspaceManager.getState().current) return;
    if (!(await isDirectory(cwd))) return;
    try {
      await this.options.workspaceManager.select(cwd);
    } catch {
      // 目录不可访问等原因导致选择失败时,保持原工作区。
    }
  }

  dispose(): void {
    if (this.mutationTimer) {
      clearTimeout(this.mutationTimer);
      this.mutationTimer = null;
    }
  }

  /** 把文件路径转成附件:图片读取为 base64(限大小),其余仅带路径由 agent 自行读取。 */
  private async hydrateAttachments(paths: string[]): Promise<FileAttachmentPayload[]> {
    const results: FileAttachmentPayload[] = [];
    for (const path of paths.slice(0, maxAttachmentCount)) {
      const name = basename(path);
      const mimeType = imageMimeByExt[extname(path).toLowerCase()];
      if (mimeType) {
        try {
          const info = await stat(path);
          if (info.isFile() && info.size > 0 && info.size <= maxImageBytes) {
            const data = (await readFile(path)).toString("base64");
            results.push({
              path,
              name,
              kind: "image",
              image: { type: "image", data, mimeType },
            });
            continue;
          }
        } catch {
          // 读取失败时退化为普通文件附件。
        }
      }
      results.push({ path, name, kind: "file", image: null });
    }
    return results;
  }

  private async onWorkspaceChanged(workspace: WorkspaceState): Promise<void> {
    if (process.env.VELA_DEBUG) console.log(`[vela] onWorkspaceChanged -> ${workspace.current}`);
    await this.options.env.setWorkspace(workspace.current);
    const environment = this.options.env.getActive();
    this.broadcast(IpcChannel.workspaceEvent, {
      type: "changed",
      workspace,
      environment,
    } satisfies WorkspaceEvent);
    await this.options.git.attach(workspace.current);
    await this.options.runtime.switchWorkspace(workspace.current ?? this.options.fallbackCwd);
  }

  /** 文件预览的路径边界与解析根:仓库根优先,相对路径先按工作区解析。 */
  private workspaceRoots(): WorkspaceRoots {
    const repoRoot = this.options.git.getSnapshot()?.repo?.root ?? null;
    const workspaceRoot = this.options.workspaceManager.getState().current;
    const baseRoot = repoRoot ?? workspaceRoot ?? this.options.fallbackCwd;
    const preferRoots = [...new Set([workspaceRoot, repoRoot, baseRoot].filter((root): root is string => Boolean(root)))];
    return { baseRoot, preferRoots };
  }

  private broadcast(channel: string, payload: unknown): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
      win.webContents.send(channel, payload);
    }
  }
}

function parsePath(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 1024) {
    throw new Error(`${label}不正确`);
  }
  return value.trim();
}

function parseId(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f-]{8,64}$/i.test(value)) {
    throw new Error(`${label}不正确`);
  }
  return value;
}

function parseBranchName(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().startsWith("-") || value.trim().length > 200) {
    throw new Error("分支名不正确");
  }
  return value.trim();
}

function parseRelativePath(value: unknown): string {
  const path = parsePath(value, "文件路径");
  if (isAbsolute(path) || path.split("/").includes("..")) throw new Error("文件路径不正确");
  return path;
}

function parseAbsolutePath(value: unknown): string {
  const path = parsePath(value, "文件路径");
  if (!isAbsolute(path)) throw new Error("需要绝对路径");
  return path;
}

/** 文件预览允许相对或绝对路径,真正的边界校验在 WorkspaceFileService 里做。 */
function parseFlexiblePath(value: unknown): string {
  const path = parsePath(value, "文件路径");
  if (path.includes("\0")) throw new Error("文件路径不正确");
  return path;
}

function parsePathList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 500) {
    throw new Error("文件列表不正确");
  }
  return value.map((entry) => parseRelativePath(entry));
}

function parseUrl(value: unknown): string {
  const url = parsePath(value, "链接");
  if (!/^https:\/\/github\.com\//.test(url)) throw new Error("链接不正确");
  return url;
}

function parseSandboxMode(value: unknown): SandboxMode {
  if (value === "ask" || value === "full") return value;
  throw new Error("权限模式不正确");
}

function parseEnvironmentKind(value: unknown): SelectableEnvironmentKind {
  if (value === "local" || value === "worktree") return value;
  throw new Error("不支持这个执行环境");
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
