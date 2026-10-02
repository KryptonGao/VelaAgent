import { AgentRuntime } from "@vela/agent";
import {
  ExecutionEnvironmentManager,
  GitOperationLog,
  GitService,
  PullRequestService,
  SandboxPermissionManager,
  WorkspaceFileService,
  WorkspaceManager,
  createSandboxedToolDefinitions,
} from "@vela/workspace";
import { app, BrowserWindow, ipcMain, nativeImage, nativeTheme, session, shell } from "electron";
import type { BrowserWindowConstructorOptions } from "electron";
import { IpcChannel } from "@vela/shared";
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setApplicationLocale } from "./menu";
import { registerOpenTargetIpc } from "./open-targets";
import { ProjectHost } from "./project-host";
import { SessionHost } from "./session-host";
import { ensureLoginShellPath } from "./shell-path";
import { TerminalHost } from "./terminal-host";
import { prepareVelaHome, resolveVelaHome } from "./vela-home";
import { UiStorage } from "./ui-storage";
import { registerUiBrowserSecurity } from "./browser-security";
import { UI_BROWSER_PARTITION } from "../browser-policy";
import appIconPath from "../../resources/icon.png?asset";

app.setName("Vela");

// 与 Electron 启动并行解析登录 shell 的 PATH,避免 GUI 进程只拿到 launchd
// 的最小 PATH 而找不到 Homebrew 里的 gh、pnpm、node。start() 里再 await。
const loginShellPathReady = ensureLoginShellPath();

const rootDir = dirname(fileURLToPath(import.meta.url));
const preloadPath = join(rootDir, "../preload/index.js");

let host: SessionHost | null = null;
let project: ProjectHost | null = null;
let terminals: TerminalHost | null = null;

/*
 * macOS 上由系统 vibrancy 提供毛玻璃,窗口底色必须是透明的,
 * 否则侧栏的 backdrop-filter 背后只有自己页面的纯色,透不出桌面。
 * 其他平台没有 vibrancy,保留主题底色避免启动和缩放时闪白。
 */
const windowChrome: BrowserWindowConstructorOptions =
  process.platform === "darwin"
    ? { vibrancy: "sidebar", visualEffectState: "active", backgroundColor: "#00000000" }
    : { backgroundColor: nativeTheme.shouldUseDarkColors ? "#16181d" : "#ffffff" };

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: "Vela",
    // Windows/Linux 的窗口图标;macOS 用 Dock 图标,见 whenReady。
    icon: appIconPath,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 18 },
    ...windowChrome,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      webviewTag: true,
    },
  });

  registerUiBrowserSecurity(win.webContents);

  win.once("ready-to-show", () => {
    win.show();
    // 测试钩子:VELA_CAPTURE=<路径> 时渲染稳定后截图退出。
    const capturePath = process.env.VELA_CAPTURE;
    if (capturePath) {
      const captureView = process.env.VELA_CAPTURE_VIEW;
      if (captureView) {
        const [view, page] = captureView.split(":");
        const tab = view === "trace" ? 1 : view === "version-control" ? 2 : 0;
        const subTab = page === "history" ? 1 : page === "pr" ? 2 : page === "changes" ? 0 : -1;
        setTimeout(() => {
          void win.webContents
            .executeJavaScript(`document.querySelectorAll('.conversation-view-tabs button')[${tab}]?.click()`)
            .then(() => {
              if (subTab < 0) return;
              setTimeout(() => {
                void win.webContents
                  .executeJavaScript(`(() => { const buttons = document.querySelectorAll('.vc-subtabs button'); buttons[${subTab}]?.click(); return buttons.length; })()`)
                  .then((count) => {
                    if (process.env.VELA_DEBUG) console.log(`[vela] capture sub-tab ${subTab}, buttons=${String(count)}`);
                  })
                  .catch(() => undefined);
              }, 400);
            })
            .catch(() => undefined);
        }, 2500);
      }
      setTimeout(() => {
        void win.webContents.capturePage().then((image) => {
          writeFileSync(capturePath, image.toPNG());
          app.quit();
        });
      }, 5000);
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  win.webContents.on("did-fail-load", (_event, code, description) => {
    console.error(`[vela] renderer failed to load: ${code} ${description}`);
  });

  win.webContents.on("will-navigate", (event, url) => {
    const devUrl = process.env.ELECTRON_RENDERER_URL;
    if (devUrl && url.startsWith(devUrl)) return;
    if (url.startsWith("file:")) return;
    event.preventDefault();
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(join(rootDir, "../renderer/index.html"));
  }

  return win;
}

async function start(): Promise<void> {
  await loginShellPathReady;
  const browserSession = session.fromPartition(UI_BROWSER_PARTITION);
  browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  browserSession.setPermissionCheckHandler(() => false);
  const fallbackCwd = resolve(app.getAppPath(), "../..");
  const home = resolveVelaHome();
  await prepareVelaHome(home, app.getPath("userData"));

  const uiStorage = new UiStorage(join(home, "ui-state.json"));
  ipcMain.on(IpcChannel.appUiStorageGet, (event, key: unknown) => {
    try {
      event.returnValue = { value: uiStorage.getItem(key) };
    } catch (error) {
      console.error("[vela] UI storage read failed", error);
      event.returnValue = { error: String(error) };
    }
  });
  ipcMain.on(IpcChannel.appUiStorageSet, (event, key: unknown, value: unknown) => {
    try {
      uiStorage.setItem(key, value);
      event.returnValue = {};
    } catch (error) {
      console.error("[vela] UI storage write failed", error);
      event.returnValue = { error: String(error) };
    }
  });

  const workspaceManager = new WorkspaceManager(join(home, "workspaces.json"));
  const envManager = new ExecutionEnvironmentManager(fallbackCwd, join(home, "worktrees"));
  const git = new GitService({ worktreeRoot: join(home, "worktrees") });
  const operations = new GitOperationLog(join(home, "git-operations.json"));
  await operations.init();
  const files = new WorkspaceFileService();
  const pr = new PullRequestService(
    () => git.getSnapshot(),
    (url) => void shell.openExternal(url).catch(() => undefined),
  );
  pr.setCwdProvider(() => workspaceManager.getState().current);
  const sandbox = new SandboxPermissionManager(join(home, "vela-settings.json"));
  await sandbox.init();

  const runtime = new AgentRuntime({
    cwd: fallbackCwd,
    agentDir: home,
    toolFactory: (cwd) =>
      createSandboxedToolDefinitions({
        cwd,
        workspace: workspaceManager.getState().current,
        permission: sandbox,
      }),
    // 激活会话变化时让工作区跟随,保证输入区与仓库卡片显示的目录即会话目录。
    onActiveCwd: (cwd) => void project?.syncConversationWorkspace(cwd),
  });
  // 「帮我批准」模式下由当前对话选择的模型判断操作风险。
  sandbox.setRiskEvaluator((input) => runtime.evaluateSandboxRisk(input));

  project = new ProjectHost({
    workspaceManager,
    git,
    files,
    pr,
    sandbox,
    env: envManager,
    runtime,
    operations,
    fallbackCwd,
  });
  project.register();
  host = new SessionHost(runtime, {
    onAgentMutation: () => project?.notifyAgentMutation(),
    currentCwd: () => workspaceManager.getState().current ?? fallbackCwd,
  });
  host.register();
  terminals = new TerminalHost(() => workspaceManager.getState().current ?? fallbackCwd);
  terminals.register();
  registerOpenTargetIpc();
  createWindow();

  // 初始工作区:显式环境变量 > 上次使用的工作区 > 无。
  const workspace = await workspaceManager.init(process.env.VELA_CWD?.trim() || null);
  await envManager.setWorkspace(workspace.current);
  await git.attach(workspace.current);
  const snapshot = await runtime.switchWorkspace(workspace.current ?? fallbackCwd);
  const detail = snapshot.error ?? snapshot.model ?? "未选择模型";
  console.log(`[vela] session ${snapshot.status}: ${detail} (${workspace.current ?? fallbackCwd})`);
}

app.whenReady().then(() => {
  // dev 模式下 Dock 显示的是 Electron 二进制自带的图标,手动指到项目图标;打包后由 bundle 提供。
  if (process.platform === "darwin" && app.dock && !app.isPackaged) {
    app.dock.setIcon(nativeImage.createFromPath(appIconPath));
  }
  ipcMain.on(IpcChannel.appSetLocale, (_event, locale: unknown) => {
    if (locale === "en" || locale === "zh-CN") setApplicationLocale(locale);
  });
  setApplicationLocale("zh-CN");

  void start();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  host?.dispose();
  host = null;
  project?.dispose();
  project = null;
  terminals?.dispose();
  terminals = null;
});
