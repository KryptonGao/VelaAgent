import { AgentRuntime } from "@vela/agent";
import {
  ExecutionEnvironmentManager,
  GitService,
  PullRequestService,
  SandboxPermissionManager,
  WorkspaceFileService,
  WorkspaceManager,
  createSandboxedToolDefinitions,
} from "@vela/workspace";
import { app, BrowserWindow, nativeTheme, shell } from "electron";
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectHost } from "./project-host";
import { SessionHost } from "./session-host";
import { prepareVelaHome, resolveVelaHome } from "./vela-home";

app.setName("Vela");

const rootDir = dirname(fileURLToPath(import.meta.url));
const preloadPath = join(rootDir, "../preload/index.js");

let host: SessionHost | null = null;
let project: ProjectHost | null = null;

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: "Vela",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 18 },
    // 与渲染层默认主题的底色一致,深色系统下启动和缩放时不闪白。
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#16181d" : "#ffffff",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
    },
  });

  win.once("ready-to-show", () => {
    win.show();
    // 测试钩子:VELA_CAPTURE=<路径> 时渲染稳定后截图退出。
    const capturePath = process.env.VELA_CAPTURE;
    if (capturePath) {
      setTimeout(() => {
        void win.webContents.capturePage().then((image) => {
          writeFileSync(capturePath, image.toPNG());
          app.quit();
        });
      }, 3500);
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
  const fallbackCwd = resolve(app.getAppPath(), "../..");
  const home = resolveVelaHome();
  await prepareVelaHome(home, app.getPath("userData"));

  const workspaceManager = new WorkspaceManager(join(home, "workspaces.json"));
  const envManager = new ExecutionEnvironmentManager(fallbackCwd, join(home, "worktrees"));
  const git = new GitService();
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

  project = new ProjectHost({
    workspaceManager,
    git,
    files,
    pr,
    sandbox,
    env: envManager,
    runtime,
    fallbackCwd,
  });
  project.register();
  host = new SessionHost(runtime, {
    onAgentMutation: () => project?.notifyAgentMutation(),
    currentCwd: () => workspaceManager.getState().current ?? fallbackCwd,
  });
  host.register();
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
});
