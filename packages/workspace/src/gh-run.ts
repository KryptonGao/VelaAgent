import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface GhResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  killed: boolean;
  spawnError: string | null;
}

/** GH CLI 失败的归类,避免把认证或网络问题报告成「没有数据」。 */
export type GhFailureKind = "no-gh" | "unauthenticated" | "permission" | "offline" | "failed";

/**
 * 运行 gh 命令;stdin 用于 `--body-file -` 等正文输入。
 * 所有 GitHub 能力都经 GH CLI,不引入额外 SDK。
 */
export function runGh(
  cwd: string | null,
  args: string[],
  timeoutMs: number,
  stdin?: string,
): Promise<GhResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let killed = false;
    let spawnError: string | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      resolve({ ok, stdout, stderr, timedOut, killed, spawnError });
    };

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn("gh", args, {
        cwd: cwd ?? undefined,
        // 非交互执行,避免 gh 在隐藏会话里自行选择推送或 fork。
        env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" },
      });
    } catch (error) {
      resolve({
        ok: false,
        stdout: "",
        stderr: "",
        timedOut: false,
        killed: false,
        spawnError: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    timer = setTimeout(() => {
      timedOut = true;
      killed = true;
      child.kill("SIGKILL");
      finish(false);
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.stdin.on("error", () => {
      // 进程提前退出时忽略 EPIPE
    });
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();

    child.on("error", (error) => {
      spawnError = error instanceof Error ? error.message : String(error);
      finish(false);
    });
    child.on("close", (code, signal) => {
      if (signal !== null) killed = true;
      finish((code ?? -1) === 0);
    });
  });
}

export function classifyGhFailure(result: GhResult): GhFailureKind {
  if (result.spawnError || /ENOENT/.test(result.stderr)) return "no-gh";
  const text = `${result.stdout}\n${result.stderr}`;
  if (result.timedOut || /could not resolve host|network|connection (refused|reset)|timeout/i.test(text)) {
    return "offline";
  }
  if (/gh auth login|not logged in|authentication|bad credentials|401/i.test(text)) return "unauthenticated";
  if (/permission|forbidden|403|must be a collaborator|write access/i.test(text)) return "permission";
  return "failed";
}

export function ghFailureMessage(kind: GhFailureKind, result: GhResult): string {
  const detail = firstLine(result.stderr) ?? firstLine(result.stdout);
  switch (kind) {
    case "no-gh":
      return "未找到 GitHub CLI（gh），请安装并登录后重试";
    case "unauthenticated":
      return `GitHub CLI 未登录或凭据无效${detail ? `：${detail}` : ""}`;
    case "permission":
      return `没有访问该仓库的权限${detail ? `：${detail}` : ""}`;
    case "offline":
      return `无法连接 GitHub${detail ? `：${detail}` : ""}`;
    default:
      return detail ?? "GitHub 操作失败";
  }
}

function firstLine(text: string): string | null {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return null;
}
