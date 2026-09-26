import { spawn } from "node:child_process";

export interface GitRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * 运行 git 命令。只读命令统一加 --no-optional-locks,避免 status 触发
 * .git/index 写入后又被文件监听捕获造成刷新循环。
 */
export async function runGit(cwd: string, args: string[], timeoutMs = 15_000): Promise<GitRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error("git 命令超时"));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error("git 命令启动失败"));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** 运行只读 git 查询命令,非零退出抛错(带 stderr)。 */
export async function gitQuery(cwd: string, args: string[], timeoutMs?: number): Promise<string> {
  const result = await runGit(cwd, ["--no-optional-locks", ...args], timeoutMs);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `git ${args[0]} 失败`);
  }
  return result.stdout;
}

/** 运行会改变仓库状态的 git 命令(不加 --no-optional-locks),非零退出抛错。 */
export async function gitMutate(cwd: string, args: string[], timeoutMs?: number): Promise<string> {
  const result = await runGit(cwd, args, timeoutMs);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `git ${args[0]} 失败`);
  }
  return result.stdout;
}

/** 校验分支/引用名,阻断参数注入(拒绝 "-" 开头、空白、控制字符),并用 git 自身的规则兜底。 */
export async function assertValidRefName(cwd: string, name: string): Promise<void> {
  if (!name || name.startsWith("-") || /\s/.test(name) || name.length > 200) {
    throw new Error("分支名不正确");
  }
  const result = await runGit(cwd, ["check-ref-format", "--branch", name]);
  if (result.code !== 0) {
    throw new Error("分支名不正确");
  }
}
