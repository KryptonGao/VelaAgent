import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const probeTimeoutMs = 5_000;

/**
 * macOS 的 GUI 进程由 launchd 启动,PATH 只有 /usr/bin:/bin:/usr/sbin:/sbin,
 * Homebrew 装的 gh、pnpm、node 等一律找不到,表现为「明明装了却报未安装」。
 * 这里向登录 shell 要一次它的 PATH 合并回当前进程,之后 spawn 按名字查
 * 命令就能命中。结果缓存,重复调用只会探测一次。
 */
let pending: Promise<string | null> | null = null;

export function ensureLoginShellPath(): Promise<string | null> {
  pending ??= probeLoginShellPath().catch(() => null);
  return pending;
}

async function probeLoginShellPath(): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  const parsed = parseShellPath(await runLoginShell(resolveShell()));
  if (!parsed || parsed === process.env.PATH) return null;
  process.env.PATH = mergePath(parsed, process.env.PATH);
  return process.env.PATH;
}

/**
 * 登录 shell 的 stdout 可能混有 .zshrc 的输出(提示、插件日志),
 * 取最后一行同时含 "/" 和 ":" 的,那才是 PATH。
 */
export function parseShellPath(stdout: string): string | null {
  const lines = stdout.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim() ?? "";
    if (line.includes("/") && line.includes(":")) return line;
  }
  return null;
}

/** 登录 shell 的项排在前(优先命中用户自己的版本),进程原有项补齐在后,去重。 */
export function mergePath(loginPath: string, currentPath: string | undefined): string {
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const entry of [...loginPath.split(":"), ...(currentPath ?? "").split(":")]) {
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    entries.push(entry);
  }
  return entries.join(":");
}

/** SHELL 只认真正支持 -ilc 的 zsh/bash,其余(如 fish)退回系统 zsh。 */
function resolveShell(): string {
  const shell = process.env.SHELL?.trim();
  if (shell && existsSync(shell) && /(?:^|\/)(zsh|bash)$/.test(shell)) return shell;
  return "/bin/zsh";
}

function runLoginShell(shell: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(shell, ["-ilc", 'printf "%s" "$PATH"'], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    let settled = false;
    const finish = (value: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish("");
    }, probeTimeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", () => finish(""));
    child.on("close", () => finish(stdout));
  });
}
