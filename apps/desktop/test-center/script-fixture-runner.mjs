import { spawn } from "node:child_process";

/** Run one trusted registry script, including its Electron children, as a UI task. */
export async function runScriptFixture({ nodePath, script, cwd, timeoutMs, successText, signal, onOutput = () => {} }) {
  const startedAt = Date.now();
  if (signal?.aborted) return { status: "failed", durationMs: 0, error: { message: "检查已取消" } };
  let child;
  let timer;
  let forceKill;
  let abort;
  let failure;
  let output = "";
  const grouped = process.platform !== "win32";
  const killOwned = (kind) => {
    if (!child?.pid) return;
    try { grouped ? process.kill(-child.pid, kind) : child.kill(kind); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  };
  try {
    const env = { ...process.env, VELA_TEST_CENTER: "1" };
    delete env.ELECTRON_RUN_AS_NODE;
    child = spawn(nodePath, [script], { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: grouped });
    const exitCode = await new Promise((resolve) => {
      const stop = (message) => {
        if (failure) return;
        failure = message; killOwned("SIGTERM");
        forceKill = setTimeout(() => killOwned("SIGKILL"), 300);
      };
      abort = () => stop("检查已取消");
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      timer = setTimeout(() => stop(`检查超时(${timeoutMs}ms)`), timeoutMs);
      for (const stream of ["stdout", "stderr"]) {
        child[stream].setEncoding("utf8");
        child[stream].on("data", (chunk) => {
          output = (output + chunk).slice(-64 * 1024); onOutput(stream, chunk);
        });
      }
      child.once("error", (error) => { failure = `无法启动检查: ${error.message}`; });
      child.once("close", (code) => resolve(code));
    });
    if (!failure && exitCode !== 0) failure = `检查进程退出(exit code ${exitCode ?? "signal"})`;
    if (!failure && successText && !output.includes(successText)) failure = "检查进程未报告完整通过结果";
    return { status: failure ? "failed" : "passed", durationMs: Date.now() - startedAt,
      error: failure ? { message: `${failure}\n${output.trim().slice(-4000)}`.trim() } : null };
  } catch (error) {
    return { status: "failed", durationMs: Date.now() - startedAt, error: { message: String(error?.stack ?? error) } };
  } finally {
    clearTimeout(timer); clearTimeout(forceKill); signal?.removeEventListener("abort", abort);
    // The leader may exit before its helpers; clean up only this fixture's group.
    if (child?.pid) {
      killOwned("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 300));
      killOwned("SIGKILL");
    }
  }
}
