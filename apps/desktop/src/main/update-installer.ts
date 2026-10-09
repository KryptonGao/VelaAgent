import { spawn } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname } from "node:path";

export interface InstallPlan {
  /** 已校验的新版 .app（暂存目录里）。 */
  stagedApp: string;
  /** 当前正在运行的 .app，会被替换。 */
  target: string;
  /** 安装成功后整体删除的暂存目录。 */
  workDir: string;
  logFile: string;
  /** 用户点了「立即重启」：装完后重新打开；否则只是在退出时顺带安装。 */
  relaunch: boolean;
}

/**
 * 在 Vela 退出后替换 .app。先复制到同目录的 `.vela-new`，再用两次 mv（同卷上是原子重命名）换位，
 * 这样复制期间被中断（注销、关机）时旧版本仍然完整；任何一步失败都会还原。
 * 参数顺序：pid、目标、暂存应用、暂存目录、是否重启、日志。
 */
export const installScript = `
PID="$1"; TARGET="$2"; STAGED="$3"; WORK="$4"; RELAUNCH="$5"; LOG="$6"
mkdir -p "$(dirname "$LOG")"
exec >>"$LOG" 2>&1
echo "[$(date '+%F %T')] update: waiting for Vela ($PID) to exit"
tries=0
while kill -0 "$PID" 2>/dev/null; do
  tries=$((tries + 1))
  if [ "$tries" -gt 300 ]; then echo "update: Vela did not exit in 60s, giving up"; exit 1; fi
  sleep 0.2
done
NEW="$TARGET.vela-new"; OLD="$TARGET.vela-old"
rm -rf "$NEW" "$OLD"
if ! ditto "$STAGED" "$NEW"; then
  echo "update: copy failed, keeping the current version"
  rm -rf "$NEW"
elif ! mv "$TARGET" "$OLD"; then
  echo "update: cannot move the current version aside, keeping it"
  rm -rf "$NEW"
elif ! mv "$NEW" "$TARGET"; then
  echo "update: swap failed, restoring the previous version"
  mv "$OLD" "$TARGET"
else
  rm -rf "$OLD" "$WORK"
  echo "update: installed"
fi
if [ "$RELAUNCH" = "1" ]; then open "$TARGET"; fi
`;

export function installerArguments(plan: InstallPlan, pid: number): string[] {
  return ["-c", installScript, "vela-update", String(pid), plan.target, plan.stagedApp, plan.workDir, plan.relaunch ? "1" : "0", plan.logFile];
}

/** 脱离当前进程运行安装脚本；Vela 退出后它继续工作。 */
export function spawnInstaller(plan: InstallPlan, pid = process.pid): void {
  const child = spawn("/bin/sh", installerArguments(plan, pid), { detached: true, stdio: "ignore" });
  child.on("error", () => undefined);
  child.unref();
}

/** 从可执行文件路径推出 .app 包；开发版、DMG 里运行（只读）、被 App Translocation 的都不能替换。 */
export function bundlePathFromExecutable(executable: string): string | null {
  const match = /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(executable);
  if (!match) return null;
  const bundle = match[1];
  if (bundle.startsWith("/Volumes/") || bundle.includes("/AppTranslocation/")) return null;
  return bundle;
}

/** 可以自动替换时返回 .app 的真实路径：包本身及其所在目录都要对当前用户可写。 */
export async function resolveInstallTarget(executable: string, packaged: boolean, platform = process.platform): Promise<string | null> {
  if (!packaged || platform !== "darwin") return null;
  const bundle = bundlePathFromExecutable(executable);
  if (!bundle) return null;
  try {
    const real = await realpath(bundle);
    await access(real, constants.W_OK);
    await access(dirname(real), constants.W_OK);
    return real;
  } catch {
    return null;
  }
}
