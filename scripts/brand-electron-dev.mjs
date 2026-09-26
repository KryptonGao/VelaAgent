#!/usr/bin/env node
// 开发模式下,菜单栏和 Dock 上的应用名来自 node_modules 里 Electron 二进制自己的
// Info.plist(改 app.setName 无效)。这里做四件事,让 dev 环境显示 Vela:
//   1. 把 Info.plist 的 CFBundleName / CFBundleDisplayName 改成 Vela(菜单栏标题);
//   2. 把 bundle 目录改名为 Vela.app:LaunchServices 的显示名按 bundle 路径缓存,
//      沿用 Electron.app 路径时 Dock 悬停提示会一直显示旧名字,换路径才会重新注册;
//   3. 同步改写 electron 包的 path.txt,保证 require('electron') 指向新路径;
//   4. 对 bundle 做 ad-hoc 重签(Apple Silicon 上改了 Info.plist 不重签会被内核拒绝),
//      并让 lsregister 立即索引新路径。
// 只影响 node_modules,重装依赖后 postinstall 会重新执行;任一步失败整体回滚,保证能启动。
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const APP_NAME = "Vela";
const ORIGINAL_NAME = "Electron";
const OLD_BUNDLE = "Electron.app";
const NEW_BUNDLE = "Vela.app";
const EXEC_SUFFIX = "Contents/MacOS/Electron";

if (process.platform !== "darwin") {
  process.exit(0);
}

const lsregister =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

function resolveElectronDir() {
  try {
    return dirname(createRequire(import.meta.url).resolve("electron/package.json"));
  } catch {
    const fromCwd = join(process.cwd(), "node_modules", "electron");
    return existsSync(fromCwd) ? fromCwd : null;
  }
}

function readPlistName(plist, key) {
  return execFileSync("plutil", ["-extract", key, "raw", plist], { encoding: "utf8" }).trim();
}

function writePlistName(plist, key, value) {
  execFileSync("plutil", ["-replace", key, "-string", value, plist]);
}

function main() {
  const electronDir = resolveElectronDir();
  if (!electronDir) {
    console.warn("[vela] 未找到 electron 包,跳过应用名修改");
    return;
  }
  const dist = join(electronDir, "dist");
  const oldApp = join(dist, OLD_BUNDLE);
  const newApp = join(dist, NEW_BUNDLE);
  let appDir = existsSync(newApp) ? newApp : existsSync(oldApp) ? oldApp : null;
  if (!appDir) {
    console.warn("[vela] 未找到 Electron.app,跳过应用名修改");
    return;
  }
  const plist = join(appDir, "Contents", "Info.plist");

  let previous;
  try {
    previous = { CFBundleName: readPlistName(plist, "CFBundleName") };
    try {
      previous.CFBundleDisplayName = readPlistName(plist, "CFBundleDisplayName");
    } catch {
      previous.CFBundleDisplayName = ORIGINAL_NAME;
    }
  } catch {
    console.warn(`[vela] 无法读取 ${plist},跳过应用名修改`);
    return;
  }

  let changed = false;
  let renamed = false;
  if (previous.CFBundleName !== APP_NAME) {
    writePlistName(plist, "CFBundleName", APP_NAME);
    writePlistName(plist, "CFBundleDisplayName", APP_NAME);
    changed = true;
  }
  if (appDir === oldApp) {
    renameSync(oldApp, newApp);
    appDir = newApp;
    renamed = true;
    changed = true;
  }
  const pathTxt = join(electronDir, "path.txt");
  const execRel = `${NEW_BUNDLE}/${EXEC_SUFFIX}`;
  const currentExecRel = existsSync(pathTxt) ? readFileSync(pathTxt, "utf8") : "";
  if (currentExecRel !== execRel) {
    writeFileSync(pathTxt, execRel);
    changed = true;
  }
  if (!changed) {
    return; // 已经是 Vela,幂等退出。
  }

  try {
    execFileSync("codesign", ["--force", "--deep", "--sign", "-", appDir], { stdio: "pipe" });
    try {
      execFileSync(lsregister, ["-u", oldApp], { stdio: "pipe" });
    } catch {
      // 旧路径的注册不存在时忽略。
    }
    execFileSync(lsregister, ["-f", appDir], { stdio: "pipe" });
    console.log(`[vela] Electron 开发二进制已更名为 ${NEW_BUNDLE}(应用名 ${APP_NAME})`);
  } catch (error) {
    // 回滚到原始状态,保证 Electron 仍能启动。
    writePlistName(plist, "CFBundleName", previous.CFBundleName);
    writePlistName(plist, "CFBundleDisplayName", previous.CFBundleDisplayName);
    if (renamed) renameSync(newApp, oldApp);
    writeFileSync(pathTxt, `${OLD_BUNDLE}/${EXEC_SUFFIX}`);
    console.warn(`[vela] 应用名修改失败,已回滚: ${error?.message ?? error}`);
  }
}

main();
