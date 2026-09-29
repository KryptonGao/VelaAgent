import { spawn, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { IpcChannel, type OpenTarget, type OpenTargetKind } from "@vela/shared";
import { app, ipcMain, shell } from "electron";

/** 一条安装形态:显示名 + .app 目录名,可附加系统目录里的绝对路径。 */
interface MacAppVariant {
  name: string;
  bundle: string;
  /** 优先于通用应用目录的位置,如系统内置的访达与终端。 */
  systemPaths?: string[];
}

interface MacAppCandidate {
  id: string;
  kind: OpenTargetKind;
  /** 依次尝试,取第一个存在的安装形态。 */
  variants: MacAppVariant[];
}

/**
 * macOS 上可用来打开工作区目录的 App 清单。
 * 顺序即下拉菜单顺序:先文件管理器,再编辑器与 IDE,最后终端。
 */
const macCandidates: MacAppCandidate[] = [
  {
    id: "finder",
    kind: "file-manager",
    variants: [
      {
        name: "Finder",
        bundle: "Finder.app",
        systemPaths: ["/System/Library/CoreServices/Finder.app"],
      },
    ],
  },
  {
    id: "vscode",
    kind: "editor",
    variants: [{ name: "Visual Studio Code", bundle: "Visual Studio Code.app" }],
  },
  {
    id: "cursor",
    kind: "editor",
    variants: [{ name: "Cursor", bundle: "Cursor.app" }],
  },
  {
    id: "windsurf",
    kind: "editor",
    variants: [{ name: "Windsurf", bundle: "Windsurf.app" }],
  },
  {
    id: "zed",
    kind: "editor",
    variants: [{ name: "Zed", bundle: "Zed.app" }],
  },
  {
    id: "vscodium",
    kind: "editor",
    variants: [{ name: "VSCodium", bundle: "VSCodium.app" }],
  },
  {
    id: "sublime",
    kind: "editor",
    variants: [{ name: "Sublime Text", bundle: "Sublime Text.app" }],
  },
  {
    id: "nova",
    kind: "editor",
    variants: [{ name: "Nova", bundle: "Nova.app" }],
  },
  {
    id: "intellij",
    kind: "editor",
    variants: [
      { name: "IntelliJ IDEA", bundle: "IntelliJ IDEA.app" },
      { name: "IntelliJ IDEA CE", bundle: "IntelliJ IDEA CE.app" },
    ],
  },
  {
    id: "webstorm",
    kind: "editor",
    variants: [{ name: "WebStorm", bundle: "WebStorm.app" }],
  },
  {
    id: "pycharm",
    kind: "editor",
    variants: [
      { name: "PyCharm", bundle: "PyCharm.app" },
      { name: "PyCharm CE", bundle: "PyCharm CE.app" },
    ],
  },
  {
    id: "phpstorm",
    kind: "editor",
    variants: [{ name: "PhpStorm", bundle: "PhpStorm.app" }],
  },
  {
    id: "goland",
    kind: "editor",
    variants: [{ name: "GoLand", bundle: "GoLand.app" }],
  },
  {
    id: "clion",
    kind: "editor",
    variants: [{ name: "CLion", bundle: "CLion.app" }],
  },
  {
    id: "rubymine",
    kind: "editor",
    variants: [{ name: "RubyMine", bundle: "RubyMine.app" }],
  },
  {
    id: "rider",
    kind: "editor",
    variants: [{ name: "Rider", bundle: "Rider.app" }],
  },
  {
    id: "datagrip",
    kind: "editor",
    variants: [{ name: "DataGrip", bundle: "DataGrip.app" }],
  },
  {
    id: "rustrover",
    kind: "editor",
    variants: [{ name: "RustRover", bundle: "RustRover.app" }],
  },
  {
    id: "dataspell",
    kind: "editor",
    variants: [{ name: "DataSpell", bundle: "DataSpell.app" }],
  },
  {
    id: "aqua",
    kind: "editor",
    variants: [{ name: "Aqua", bundle: "Aqua.app" }],
  },
  {
    id: "android-studio",
    kind: "editor",
    variants: [{ name: "Android Studio", bundle: "Android Studio.app" }],
  },
  {
    id: "fleet",
    kind: "editor",
    variants: [{ name: "Fleet", bundle: "Fleet.app" }],
  },
  {
    id: "terminal",
    kind: "terminal",
    variants: [
      {
        name: "Terminal",
        bundle: "Terminal.app",
        systemPaths: ["/System/Applications/Utilities/Terminal.app", "/Applications/Utilities/Terminal.app"],
      },
    ],
  },
  {
    id: "iterm",
    kind: "terminal",
    variants: [{ name: "iTerm", bundle: "iTerm.app" }],
  },
  {
    id: "ghostty",
    kind: "terminal",
    variants: [{ name: "Ghostty", bundle: "Ghostty.app" }],
  },
  {
    id: "warp",
    kind: "terminal",
    variants: [{ name: "Warp", bundle: "Warp.app" }],
  },
  {
    id: "wezterm",
    kind: "terminal",
    variants: [{ name: "WezTerm", bundle: "WezTerm.app" }],
  },
  {
    id: "kitty",
    kind: "terminal",
    variants: [{ name: "kitty", bundle: "kitty.app" }],
  },
  {
    id: "alacritty",
    kind: "terminal",
    variants: [{ name: "Alacritty", bundle: "Alacritty.app" }],
  },
  {
    id: "hyper",
    kind: "terminal",
    variants: [{ name: "Hyper", bundle: "Hyper.app" }],
  },
];

interface DetectedTarget {
  id: string;
  name: string;
  kind: OpenTargetKind;
  /** .app 的绝对路径,用于取图标和启动。 */
  appPath: string;
}

const applicationDirs = ["/Applications", join(homedir(), "Applications")];

function findInstalledApp(variant: MacAppVariant): string | null {
  const candidates = [
    ...(variant.systemPaths ?? []),
    ...applicationDirs.map((dir) => join(dir, variant.bundle)),
  ];
  return candidates.find((path) => existsSync(path)) ?? null;
}

function detectMacTargets(): DetectedTarget[] {
  const targets: DetectedTarget[] = [];
  for (const candidate of macCandidates) {
    for (const variant of candidate.variants) {
      const appPath = findInstalledApp(variant);
      if (!appPath) continue;
      targets.push({ id: candidate.id, name: variant.name, kind: candidate.kind, appPath });
      break;
    }
  }
  return targets;
}

// 检测结果和图标在一次运行内不变:App 装完需要重启 Vela 才会出现在菜单里。
let detectedCache: DetectedTarget[] | null = null;
const iconCache = new Map<string, string | null>();

function detectedTargets(): DetectedTarget[] {
  if (!detectedCache) {
    detectedCache = process.platform === "darwin" ? detectMacTargets() : [];
  }
  return detectedCache;
}

const runFile = promisify(execFile);

/** 从 Info.plist 声明或 Resources 目录里找出 bundle 自己的 .icns。 */
async function findBundleIcon(appPath: string): Promise<string | null> {
  const resources = join(appPath, "Contents", "Resources");
  const declared = await declaredIconFile(join(appPath, "Contents", "Info.plist"));
  if (declared && existsSync(join(resources, declared))) return join(resources, declared);
  const entries = await readdir(resources).catch(() => [] as string[]);
  const icons = entries.filter((name) => name.toLowerCase().endsWith(".icns"));
  if (icons.length === 0) return null;
  const bundleName = basename(appPath, ".app").toLowerCase().replace(/[^a-z0-9]/g, "");
  const preferred = icons.find((name) => {
    const stem = name.slice(0, -".icns".length).toLowerCase().replace(/[^a-z0-9]/g, "");
    return stem.length > 0 && (bundleName.includes(stem) || stem.includes(bundleName));
  });
  return join(resources, preferred ?? icons[0]);
}

async function declaredIconFile(plistPath: string): Promise<string | null> {
  try {
    const { stdout } = await runFile("plutil", ["-convert", "json", "-o", "-", plistPath]);
    const parsed = JSON.parse(stdout) as { CFBundleIconFile?: unknown };
    const value = parsed.CFBundleIconFile;
    if (typeof value !== "string" || !value) return null;
    return value.endsWith(".icns") ? value : `${value}.icns`;
  } catch {
    return null;
  }
}

/**
 * Electron 的 app.getFileIcon 在 macOS 上对所有 .app 都返回通用图标,
 * 所以优先用 sips 把 bundle 内的 .icns 转成 PNG,取不到再退回通用图标。
 */
async function loadIcon(appPath: string): Promise<string | null> {
  const cached = iconCache.get(appPath);
  if (cached !== undefined) return cached;
  const icon = (await iconFromBundle(appPath)) ?? (await genericIcon(appPath));
  iconCache.set(appPath, icon);
  return icon;
}

async function iconFromBundle(appPath: string): Promise<string | null> {
  const source = await findBundleIcon(appPath);
  if (!source) return null;
  const target = join(app.getPath("temp"), `vela-icon-${process.pid}-${Math.random().toString(36).slice(2)}.png`);
  try {
    await runFile("sips", ["-s", "format", "png", "-Z", "64", source, "--out", target]);
    const data = await readFile(target, "base64");
    return data ? `data:image/png;base64,${data}` : null;
  } catch {
    return null;
  } finally {
    await rm(target, { force: true }).catch(() => undefined);
  }
}

async function genericIcon(appPath: string): Promise<string | null> {
  try {
    const image = await app.getFileIcon(appPath, { size: "small" });
    return image.isEmpty() ? null : image.toDataURL();
  } catch {
    return null;
  }
}

/** macOS 之外返回空列表,渲染层据此隐藏入口。 */
export async function listOpenTargets(): Promise<OpenTarget[]> {
  return Promise.all(
    detectedTargets().map(async (target) => ({
      id: target.id,
      name: target.name,
      kind: target.kind,
      icon: await loadIcon(target.appPath),
    })),
  );
}

function launchApp(appPath: string, name: string, dir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("open", ["-a", appPath, dir], { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`无法用 ${name} 打开这个目录`));
    });
  });
}

export async function openInTarget(targetId: string, dir: string): Promise<void> {
  if (!isAbsolute(dir)) throw new Error("目录路径不正确");
  const info = await stat(dir).catch(() => null);
  if (!info?.isDirectory()) throw new Error("目录不存在");
  const target = detectedTargets().find((entry) => entry.id === targetId);
  if (!target) throw new Error("本机找不到这个 App");
  if (target.kind === "file-manager") {
    const message = await shell.openPath(dir);
    if (message) throw new Error(message);
    return;
  }
  await launchApp(target.appPath, target.name, dir);
}

export function registerOpenTargetIpc(): void {
  ipcMain.handle(IpcChannel.appListOpenTargets, () => listOpenTargets());
  ipcMain.handle(IpcChannel.appOpenInTarget, async (_event, rawId: unknown, rawDir: unknown) => {
    if (typeof rawId !== "string" || !rawId) throw new Error("打开方式不正确");
    if (typeof rawDir !== "string") throw new Error("目录路径不正确");
    await openInTarget(rawId, rawDir);
  });
}
