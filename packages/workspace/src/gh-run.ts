import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface GhResult {
  ok: boolean;
  exitCode?: number | null;
  cancelled?: boolean;
  outputTruncated?: boolean;
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
export interface GhRunOptions {
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  maxOutputBytes?: number;
}

// Shared by workspace PR operations and the global inbox.
let activeReads = 0;
const readQueue: Array<() => void> = [];
async function acquire(signal?: AbortSignal): Promise<() => void> {
  if (signal?.aborted) throw new Error('cancelled');
  if (activeReads >= 4) await new Promise<void>((resolve, reject) => {
    const resume = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const abort = () => {
      const index = readQueue.indexOf(resume);
      if (index >= 0) readQueue.splice(index, 1);
      reject(new Error('cancelled'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    readQueue.push(resume);
  });
  // A queued waiter inherits the released slot.
  else activeReads++;
  return () => { const next = readQueue.shift(); if (next) next(); else activeReads--; };
}

export async function runGh(
  cwd: string | null, args: string[], timeoutMs: number, stdin?: string,
  options: GhRunOptions = {},
): Promise<GhResult> {
  const empty: GhResult = { ok: false, stdout: '', stderr: '', timedOut: false,
    killed: false, spawnError: null, exitCode: null, cancelled: false, outputTruncated: false };
  let release: () => void;
  try { release = await acquire(options.signal); }
  catch { return { ...empty, cancelled: true }; }
  try {
    return await new Promise<GhResult>((resolve) => {
      const result = { ...empty };
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let child: ChildProcessWithoutNullStreams;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        result.ok = result.exitCode === 0 && !result.timedOut && !result.cancelled && !result.spawnError;
        resolve(result);
      };
      const abort = () => { result.cancelled = true; result.killed = true; if (child) child.kill('SIGKILL'); else finish(); };
      if (options.signal?.aborted) { result.cancelled = true; finish(); return; }
      try {
        child = spawn('gh', args, {
          cwd: cwd ?? undefined, shell: false,
          env: { ...process.env, ...options.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1',
            GH_PAGER: 'cat', PAGER: 'cat', NO_COLOR: '1' },
        });
      } catch (error) { result.spawnError = String(error); finish(); return; }
      options.signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => { result.timedOut = true; result.killed = true; child.kill('SIGKILL'); }, timeoutMs);
      const limit = options.maxOutputBytes ?? 16 * 1024 * 1024;
      let bytes = 0;
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      const append = (field: 'stdout' | 'stderr', chunk: string) => {
        const size = Buffer.byteLength(chunk);
        if (bytes + size > limit) {
          // Never split a UTF-8 sequence at the cap.
          let prefix = ''; let length = 0;
          for (const char of chunk) { const n = Buffer.byteLength(char); if (length + n > limit - bytes) break; prefix += char; length += n; }
          result[field] += prefix; bytes = limit; result.outputTruncated = true;
        } else { result[field] += chunk; bytes += size; }
      };
      child.stdout.on('data', (chunk: string) => append('stdout', chunk));
      child.stderr.on('data', (chunk: string) => append('stderr', chunk));
      child.stdin.on('error', () => {});
      child.stdin.end(stdin);
      child.on('error', error => { result.spawnError = error.message; finish(); });
      child.on('close', (code, signal) => { result.exitCode = code; if (signal) result.killed = true; finish(); });
    });
  } finally { release(); }
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
