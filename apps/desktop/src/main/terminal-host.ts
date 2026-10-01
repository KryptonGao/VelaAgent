import { IpcChannel, type TerminalCreateOptions, type TerminalEvent, type TerminalSessionInfo } from "@vela/shared";
import { ipcMain, type WebContents } from "electron";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { spawn, type IPty } from "node-pty";

const maxIdLength = 128;
const maxInputLength = 64 * 1024;
const minDimension = 2;
const maxDimension = 1000;

interface TerminalSession {
  pty: IPty;
  owner: number;
  info: TerminalSessionInfo;
}

/**
 * 集成终端的主进程宿主:用 node-pty 为每个标签页起一个交互式 shell,
 * 把输出经 terminal:event 推给渲染层,并在窗口销毁时回收所有 PTY。
 */
export class TerminalHost {
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly watchedWebContents = new Set<number>();
  private readonly cwdProvider: () => string | null;

  constructor(cwdProvider: () => string | null) {
    this.cwdProvider = cwdProvider;
  }

  register(): void {
    ipcMain.handle(IpcChannel.terminalCreate, (event, raw: unknown) => {
      return this.create(event.sender, parseCreateOptions(raw));
    });
    ipcMain.on(IpcChannel.terminalWrite, (_event, rawId: unknown, rawData: unknown) => {
      const data = typeof rawData === "string" ? rawData.slice(0, maxInputLength) : "";
      if (!data) return;
      const session = this.safeSession(rawId);
      if (!session) return;
      try {
        session.pty.write(data);
      } catch {
        // PTY 刚好退出时丢弃这轮按键。
      }
    });
    ipcMain.on(IpcChannel.terminalResize, (_event, rawId: unknown, rawCols: unknown, rawRows: unknown) => {
      const session = this.safeSession(rawId);
      if (!session) return;
      try {
        session.pty.resize(clampDimension(rawCols), clampDimension(rawRows));
      } catch {
        // PTY 已退出时忽略尺寸变化。
      }
    });
    ipcMain.on(IpcChannel.terminalClose, (event, rawId: unknown) => {
      const session = this.safeSession(rawId);
      if (!session || session.owner !== event.sender.id) return;
      this.kill(session.info.id);
    });
  }

  dispose(): void {
    for (const id of [...this.sessions.keys()]) this.kill(id);
  }

  private create(webContents: WebContents, options: TerminalCreateOptions): TerminalSessionInfo {
    const existing = this.sessions.get(options.id);
    // 同一窗口重建标签(StrictMode 二次挂载/页面刷新)时旧会话已不可用,
    // 杀掉重建;不同窗口不允许接管别人的终端。
    if (existing && existing.owner !== webContents.id) throw new Error("终端会话已被占用");
    if (existing) this.kill(options.id);

    const shell = resolveShell();
    const cwd = this.cwdProvider() ?? process.env.HOME ?? process.cwd();
    const pty = spawn(shell.path, shell.args, {
      name: "xterm-256color",
      cols: options.cols,
      rows: options.rows,
      cwd,
      env: terminalEnv(),
    });

    const session: TerminalSession = {
      pty,
      owner: webContents.id,
      info: { id: options.id, shell: shell.path, cwd },
    };
    this.sessions.set(options.id, session);

    const send = (event: TerminalEvent): void => {
      if (webContents.isDestroyed()) return;
      webContents.send(IpcChannel.terminalEvent, event);
    };
    pty.onData((data) => send({ type: "output", id: options.id, data }));
    pty.onExit(({ exitCode, signal }) => {
      if (this.sessions.get(options.id) === session) this.sessions.delete(options.id);
      send({ type: "exit", id: options.id, exitCode, signal: signal ?? 0 });
    });
    // 窗口关闭/刷新时连带回收它名下的终端,避免残留 shell 进程。
    if (!this.watchedWebContents.has(webContents.id)) {
      this.watchedWebContents.add(webContents.id);
      webContents.once("destroyed", () => {
        this.watchedWebContents.delete(webContents.id);
        for (const candidate of [...this.sessions.values()]) {
          if (candidate.owner === webContents.id) this.kill(candidate.info.id);
        }
      });
    }
    return session.info;
  }

  private session(id: string): TerminalSession | null {
    return this.sessions.get(id) ?? null;
  }

  /** 事件通道的 id 来自渲染层,不合法时静默忽略,不抛回主进程。 */
  private safeSession(rawId: unknown): TerminalSession | null {
    try {
      return this.session(parseId(rawId));
    } catch {
      return null;
    }
  }

  private kill(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    try {
      session.pty.kill();
    } catch {
      // 进程已经退出。
    }
  }
}

interface ResolvedShell {
  path: string;
  args: string[];
}

/** 优先用登录 shell(与用户终端一致的 PATH/别名),缺失时退回各平台默认 shell。 */
function resolveShell(): ResolvedShell {
  if (process.platform === "win32") {
    const command = process.env.COMSPEC?.trim() || "powershell.exe";
    return { path: command, args: [] };
  }
  const candidates = [process.env.SHELL, "/bin/zsh", "/bin/bash", "/bin/sh"];
  for (const candidate of candidates) {
    if (candidate && isAbsolute(candidate) && existsSync(candidate)) {
      return { path: candidate, args: ["-l"] };
    }
  }
  return { path: "/bin/sh", args: ["-l"] };
}

function terminalEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  env.TERM = "xterm-256color";
  env.COLORTERM = env.COLORTERM ?? "truecolor";
  env.LANG = env.LANG ?? "en_US.UTF-8";
  // 让 shell/工具链知道自己在 Vela 的终端里运行。
  env.TERM_PROGRAM = "Vela";
  return env;
}

function parseCreateOptions(value: unknown): TerminalCreateOptions {
  if (typeof value !== "object" || value === null) throw new Error("终端参数不正确");
  const record = value as Record<string, unknown>;
  return {
    id: parseId(record.id),
    cols: clampDimension(record.cols),
    rows: clampDimension(record.rows),
  };
}

function parseId(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > maxIdLength || !/^[\w:.-]+$/.test(value)) {
    throw new Error("终端标识不正确");
  }
  return value;
}

function clampDimension(value: unknown): number {
  const numeric = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 80;
  return Math.min(maxDimension, Math.max(minDimension, numeric));
}
