import type { DevToolsInfo } from "@vela/shared";
import { execFile } from "node:child_process";
import { stat, utimes } from "node:fs/promises";
import { join } from "node:path";

export interface DevToolsInfoSource {
  name: string;
  version: string;
  /** 源码仓库根目录，用来读取 git 信息。 */
  appPath: string;
  home: string;
  versions: Record<string, string | undefined>;
  platform: string;
  arch: string;
  osRelease: string;
}

function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise(resolve => {
    execFile("git", args, { cwd, timeout: 3000, windowsHide: true }, (error, stdout) => resolve(error ? null : stdout.trim()));
  });
}

/** 开发版诊断信息；git 不可用时 commit 为 null，不影响其他字段。 */
export async function readDevToolsInfo(source: DevToolsInfoSource): Promise<DevToolsInfo> {
  const [commit, branch, status] = await Promise.all([
    git(source.appPath, ["rev-parse", "HEAD"]),
    git(source.appPath, ["rev-parse", "--abbrev-ref", "HEAD"]),
    git(source.appPath, ["status", "--porcelain", "--untracked-files=no"]),
  ]);
  return {
    name: source.name,
    version: source.version,
    commit: commit || null,
    branch: branch || null,
    dirty: status === null ? null : status.length > 0,
    electron: source.versions.electron ?? "unknown",
    chrome: source.versions.chrome ?? "unknown",
    node: source.versions.node ?? "unknown",
    v8: source.versions.v8 ?? "unknown",
    platform: source.platform,
    arch: source.arch,
    osRelease: source.osRelease,
    home: source.home,
  };
}

export interface RestartDeps {
  /** electron-vite 开发服务器地址；设置时 main 进程由它托管。 */
  rendererUrl: string | undefined;
  appPath: string;
  flush(): void;
  relaunch(): void;
  /** 等待托管方重启的时间。 */
  timeoutMs?: number;
}

/**
 * 重启 main process。
 * electron-vite 托管时子进程退出会连带结束开发服务器，所以不能 relaunch，
 * 而是改动 main 入口的修改时间，让 `--watch` 的重新构建替我们重启；
 * 直接用 `electron .` 启动时才使用 app.relaunch()。
 */
export async function restartMainProcess(deps: RestartDeps): Promise<void> {
  deps.flush();
  if (!deps.rendererUrl) { deps.relaunch(); return; }
  const entry = join(deps.appPath, "src", "main", "index.ts");
  try { await stat(entry); }
  catch { throw new Error("找不到 main 入口源码，无法触发重启，请在终端重新运行 pnpm dev"); }
  const now = new Date();
  await utimes(entry, now, now);
  // 重启成功时本进程会被终止，走不到下面。
  await new Promise(resolve => setTimeout(resolve, deps.timeoutMs ?? 6000));
  throw new Error("没有检测到 electron-vite 的 --watch 重启，请在终端重新运行 pnpm dev");
}
