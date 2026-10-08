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
  createWorktree, removeWorktree,
} from "@vela/workspace";
import { app, BrowserWindow, dialog, ipcMain, nativeImage, nativeTheme, session, shell, webContents } from "electron";
import type { BrowserWindowConstructorOptions } from "electron";
import { createLogger, IpcChannel, isAppLocale, localizeZh } from "@vela/shared";
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getApplicationLocale, setApplicationLocale, setDiagnosticsMenuActions } from "./menu";
import { LogService } from "./log-service";
import { installCrashHandlers, LogHost, systemInfo } from "./log-host";
import { registerOpenTargetIpc } from "./open-targets";
import { ProjectHost } from "./project-host";
import { SessionHost } from "./session-host";
import { ScheduledTaskScheduler } from "./scheduled-task-service";
import { TaskRecipeService } from "./task-recipe-service";
import { TaskRecipeHost } from "./task-recipe-host";
import { executeScheduledRecipe } from './task-recipe-schedule';
import { ScheduledTaskHost } from "./scheduled-task-host";
import { McpHost } from "./mcp-host";
import { MemoryHost } from "./memory-host";
import { SecureCredentialStore } from "./plugin-credentials";
import { ensureLoginShellPath } from "./shell-path";
import { PrInboxHost } from "./pr-inbox-host";
import { TerminalHost } from "./terminal-host";
import { configureVelaProfile, prepareVelaHome } from "./vela-home";
import { registerDevelopmentIpc } from "./development-host";
import { UiStorage } from "./ui-storage";
import { registerUiBrowserSecurity } from "./browser-security";
import { configureBrowserPlatformAuthenticator, readWebAuthnAccessGroup, registerBrowserWebAuthn } from "./browser-webauthn";
import { BrowserHost } from "./browser-host";
import { BrowserCdp } from "./browser-cdp";
import { BrowserReplManager } from "./browser-repl";
import { BrowserIpc, type BrowserUiCommand } from "../../../../packages/shared/src/browser";
import { UI_BROWSER_PARTITION } from "../browser-policy";
import appIconPath from "../../resources/icon.png?asset";

const home = configureVelaProfile(app);
// 日志最先就绪:之后的启动失败、崩溃都能落盘到 <home>/logs。
const logService = new LogService({ home, console: !app.isPackaged || !!process.env.VELA_DEBUG, debug: !!process.env.VELA_DEBUG });
installCrashHandlers(logService);
const log = createLogger("main");
// Only one Main Process per profile may claim its persisted task queue.
// electron-vite 重启 main process 时，旧进程还在退出并持有锁。请求失败后 Electron 不再发出 ready，
// 所以开发服务器托管下推迟到 ready 之后再请求，并等旧进程释放。
const managedByDevServer = !app.isPackaged && !!process.env.ELECTRON_RENDERER_URL;
let primaryInstance = managedByDevServer ? false : app.requestSingleInstanceLock();
if (!primaryInstance && !managedByDevServer) app.quit();
app.on("second-instance", () => {
  const window = BrowserWindow.getAllWindows()[0];
  if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); }
});

// 与 Electron 启动并行解析登录 shell 的 PATH,避免 GUI 进程只拿到 launchd
// 的最小 PATH 而找不到 Homebrew 里的 gh、pnpm、node。start() 里再 await。
const loginShellPathReady = primaryInstance || managedByDevServer ? ensureLoginShellPath() : Promise.resolve(null);

const rootDir = dirname(fileURLToPath(import.meta.url));
const preloadPath = join(rootDir, "../preload/index.js");

let mcpHost: McpHost | null = null;
let memoryHost: MemoryHost | null = null;
let scheduledTaskHost: ScheduledTaskHost | null = null;
let taskScheduler: ScheduledTaskScheduler | null = null;
let taskRecipeHost: TaskRecipeHost | null = null;
let taskRecipes: TaskRecipeService | null = null;
let host: SessionHost | null = null;
let browserHost: BrowserHost | null = null;
let browserRepl: BrowserReplManager | null = null;
let project: ProjectHost | null = null;
let terminals: TerminalHost | null = null;
let prInboxHost: PrInboxHost | null = null;
let logHost: LogHost | null = null;

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

  browserHost?.registerWindow(win.id, win.webContents);
  registerUiBrowserSecurity(win.webContents, (guest) => browserHost?.registerGuest(win.id, guest),
    (options) => new BrowserWindow({ ...options, parent: win }));
  win.once("closed", () => { browserRepl?.closeWindow(win.id); browserHost?.closeWindow(win.id); });

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
                    log.debug(`capture sub-tab ${subTab}, buttons=${String(count)}`);
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
    log.error(`renderer failed to load: ${code} ${description}`);
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
  const platformAuthenticator = configureBrowserPlatformAuthenticator(app, process.platform, readWebAuthnAccessGroup());
  if (process.platform === "darwin" && !platformAuthenticator) {
    log.info("Touch ID passkeys require a signed and provisioned build with the Vela WebAuthn keychain entitlement.");
  }
  const disposeWebAuthn = registerBrowserWebAuthn(browserSession, {
    contentsFromFrame: (frame) => webContents.fromFrame(frame),
    parentForContents: (contents) => BrowserWindow.fromWebContents(contents.hostWebContents ?? contents),
    showMessageBox: (parent, options) => dialog.showMessageBox(parent, options),
  });
  app.once("will-quit", disposeWebAuthn);
  const fallbackCwd = resolve(app.getAppPath(), "../..");
  await prepareVelaHome(home, app.getPath("userData"));

  const uiStorage = new UiStorage(join(home, "ui-state.json"));
  ipcMain.on(IpcChannel.appUiStorageGet, (event, key: unknown) => {
    try {
      event.returnValue = { value: uiStorage.getItem(key) };
    } catch (error) {
      log.error("UI storage read failed", error);
      event.returnValue = { error: String(error) };
    }
  });
  ipcMain.on(IpcChannel.appUiStorageSet, (event, key: unknown, value: unknown) => {
    try {
      uiStorage.setItem(key, value);
      event.returnValue = {};
    } catch (error) {
      log.error("UI storage write failed", error);
      event.returnValue = { error: String(error) };
    }
  });

  const workspaceManager = new WorkspaceManager(join(home, "workspaces.json"));
  // 先恢复工作区记录，供旧会话迁移工作区归属时使用。
  const workspace = await workspaceManager.init(process.env.VELA_CWD?.trim() || null);
  const envManager = new ExecutionEnvironmentManager(fallbackCwd, join(home, "worktrees"));
  const git = new GitService({ worktreeRoot: join(home, "worktrees") });
  const operations = new GitOperationLog(join(home, "git-operations.json"));
  await operations.init();
  const files = new WorkspaceFileService();
  prInboxHost = new PrInboxHost();
  prInboxHost.register();
  const pr = new PullRequestService(
    () => git.getSnapshot(),
    (url) => void shell.openExternal(url).catch(() => undefined),
  );
  pr.setCwdProvider(() => workspaceManager.getState().current);
  const sandbox = new SandboxPermissionManager(join(home, "vela-settings.json"));
  await sandbox.init();

  browserHost = new BrowserHost((guest) => new BrowserCdp(guest), browserSession);
  browserRepl = new BrowserReplManager(browserHost, join(rootDir, "browser-repl-worker.mjs"));
  browserHost.subscribe((windowId, state) => {
    const window = BrowserWindow.fromId(windowId);
    if (window && !window.webContents.isDestroyed()) window.webContents.send(BrowserIpc.state, state);
  });
  ipcMain.handle(BrowserIpc.command, (event, command: BrowserUiCommand) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || !browserHost) throw new Error("Browser window is unavailable");
    return browserHost.command(window.id, event.sender, event.senderFrame === event.sender.mainFrame, command);
  });

  const scheduler = new ScheduledTaskScheduler(join(home, "scheduled-tasks.json"),
    (task, onCreated, run) => task.recipeBinding ? executeScheduledRecipe(recipes, task, onCreated, run) : runtime.runScheduledTask(task.workspace, task.prompt, onCreated, task));
  scheduler.init();
  taskScheduler = scheduler;
  logHost = new LogHost(logService, {
    home,
    agentDir: home,
    activeConversationId: () => runtime.activeConversationId,
    mcpCatalog: () => runtime.getMcpCatalog({ cwd: runtime.getSnapshot().cwd, conversationId: runtime.activeConversationId }),
    locale: getApplicationLocale,
  });
  logHost.register();
  const runtime = new AgentRuntime({
    scheduledTasks: scheduler,
    pluginCredentialStore: new SecureCredentialStore(join(home, "integrations-auth.enc.json")),
    browserRepl,
    mcpOpenUrl: (url) => { void shell.openExternal(url).catch(() => undefined); },
    mcpPermission: { request: (input) => sandbox.request({ ...input, workspace: input.cwd }) },
    browserReplPermission: { request: (input) => sandbox.request({ ...input, workspace: input.cwd }) },
    memoryPermission: { request: (input) => sandbox.request({ ...input, workspace: input.workspace ?? input.cwd }) },
    cwd: fallbackCwd,
    isWorkspaceCwd: (cwd) => cwd !== fallbackCwd || workspaceManager.getState().recents.some(recent => recent.path === cwd),
    agentDir: home,
    toolFactory: (cwd, context) =>
      createSandboxedToolDefinitions({
        cwd,
        workspace: cwd,
        permission: sandbox,
        ...context,
      }),
    onRecipeStop: id => taskRecipes?.stopConversation(id),
    // 激活会话变化时让工作区跟随,保证输入区与仓库卡片显示的目录即会话目录。
    onActiveCwd: (cwd, hasWorkspace) => void project?.syncConversationWorkspace(cwd, hasWorkspace),
  });
  // 已登记工作区：当前选择、最近使用和已有会话的工作目录，供配方与记忆管理共用。
  const registeredWorkspaces = () => [...new Set([
    workspaceManager.getState().current,
    ...workspaceManager.getState().recents.map(r => r.path),
    ...runtime.listConversations().filter(c => c.hasWorkspace !== false).map(c => c.cwd),
  ].filter((path): path is string => typeof path === "string" && path.length > 0))];
  const recipes = new TaskRecipeService(join(home, "task-recipes.json"), {
    resolveExecution: draft => runtime.resolveRecipeExecution(draft, draft.sandboxModeOverride ?? sandbox.getMode()),
    create: run => runtime.createRecipeConversation(run), submit: (run, stage) => runtime.submitRecipe(run, stage),
    beginWorkflow: run => runtime.beginRecipeWorkflow(run), finishWorkflow: run => runtime.finishRecipeWorkflow(run),
    skills: workspace => runtime.listSkills(workspace),
    worktreePath: branch => join(home, 'worktrees', branch.replace('/', '-')),
    createWorktree: async run => {
      const worktree = run.worktree!;
      const result = await createWorktree(worktree.sourceWorkspace, { branch: worktree.branch, newBranch: true, startPoint: worktree.startSha, path: worktree.path }, join(home, 'worktrees'));
      if (!result.ok || result.path !== worktree.path) throw new Error(result.message || 'worktree 创建失败');
    },
    removeWorktree: async run => {
      const result = await removeWorktree(run.worktree!.sourceWorkspace, { path: run.worktree!.path, force: false }, null);
      if (!result.ok) throw new Error(result.message);
    },
    trustedSnapshot: recipe => scheduler.list().tasks.some(task => JSON.stringify(task.recipeBinding?.recipeSnapshot) === JSON.stringify(recipe)),
    workspaces: registeredWorkspaces, runningWorkspaces: () => runtime.listConversations().filter(c => c.status === "streaming" || runtime.getAgents(c.id).some(a => a.kind !== "root" && a.status === "running")).map(c => c.cwd),
  });
  recipes.init(); taskRecipes = recipes;
  if (!recipes.list().error) {
    try { await runtime.reconcileRecipeConversations(recipes.list().runs); }
    catch (error) { log.error("recipe conversation reconciliation failed", error); }
  }
  runtime.subscribeQuestions(event => {
    if (event.type === "request") recipes.waiting(event.request.conversationId, event.request.id, true);
    else {
      // The service owns the ID→conversation map; a resolved ID need not select a chat.
      recipes.waiting("", event.id, false);
    }
  });
  sandbox.subscribe(event => {
    if (event.type === "request" && event.request.conversationId) recipes.waiting(event.request.conversationId, event.request.id, true);
    else if (event.type === "resolved") recipes.waiting("", event.id, false);
  });
  taskRecipeHost = new TaskRecipeHost(recipes, registeredWorkspaces, runtime); taskRecipeHost.register();
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
    currentWorkspace: () => workspaceManager.getState().current,
    onAgentMutation: () => project?.notifyAgentMutation(),
    currentCwd: () => workspaceManager.getState().current ?? fallbackCwd,
  });
  host.register();
  registerDevelopmentIpc(runtime, { isPackaged: app.isPackaged, home });
  scheduledTaskHost = new ScheduledTaskHost(scheduler);
  scheduledTaskHost.register();
  mcpHost = new McpHost(runtime, () => workspaceManager.getState().current ?? fallbackCwd);
  mcpHost.register();
  memoryHost = new MemoryHost(runtime, { workspaces: registeredWorkspaces });
  memoryHost.register();
  terminals = new TerminalHost(() => workspaceManager.getState().current ?? fallbackCwd);
  terminals.register();
  registerOpenTargetIpc();
  createWindow();

  // 初始工作区:显式环境变量 > 上次使用的工作区 > 无。
  await envManager.setWorkspace(workspace.current);
  await git.attach(workspace.current);
  const snapshot = await runtime.switchWorkspace(workspace.current ?? fallbackCwd, workspace.current !== null);
  scheduler.start();
  const detail = snapshot.error ?? snapshot.model ?? "未选择模型";
  log.info(`session ${snapshot.status}: ${detail}`, { cwd: workspace.current ?? fallbackCwd });
}

app.whenReady().then(async () => {
  for (let attempt = 0; managedByDevServer && !primaryInstance && attempt < 24; attempt++) {
    primaryInstance = app.requestSingleInstanceLock();
    if (!primaryInstance) await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!primaryInstance) {
    if (managedByDevServer) app.quit();
    return;
  }
  // dev 模式下 Dock 显示的是 Electron 二进制自带的图标,手动指到项目图标;打包后由 bundle 提供。
  if (process.platform === "darwin" && app.dock && !app.isPackaged) {
    app.dock.setIcon(nativeImage.createFromPath(appIconPath));
  }
  ipcMain.on(IpcChannel.appSetLocale, (_event, locale: unknown) => {
    if (isAppLocale(locale)) setApplicationLocale(locale);
  });
  setApplicationLocale("zh-CN");

  log.info("app started", systemInfo());
  setDiagnosticsMenuActions({
    exportLogs: () => {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
      void logHost?.exportBundle(win, { includeTrace: false }).catch(error => {
        log.error("diagnostics export failed", error);
        dialog.showErrorBox(localizeZh(getApplicationLocale(), "导出失败", "Export failed"), String((error as Error)?.message ?? error));
      });
    },
    openLogsFolder: () => { void logHost?.openFolder().catch(error => log.error("open logs folder failed", error)); },
  });

  start().catch(error => log.error("startup failed", error));

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

let shutdownComplete = false;
let shutdownStarted = false;
app.on("before-quit", (event) => {
  if (shutdownComplete) return;
  event.preventDefault();
  if (shutdownStarted) return;
  shutdownStarted = true;
  log.info("app quitting");
  prInboxHost?.dispose();
  logHost?.dispose();
  logHost = null;
  try { taskRecipes?.stop(); } catch (error) { log.error("recipe shutdown write failed", error); }
  taskRecipeHost?.dispose(); taskRecipeHost = null;
  scheduledTaskHost?.dispose();
  scheduledTaskHost = null;
  mcpHost?.dispose();
  mcpHost = null;
  memoryHost?.dispose();
  memoryHost = null;
  const closing = host?.dispose();
  browserRepl?.dispose();
  browserRepl = null;
  browserHost?.dispose();
  browserHost = null;
  host = null;
  project?.dispose();
  project = null;
  terminals?.dispose();
  terminals = null;
  void Promise.allSettled([Promise.resolve(closing), taskScheduler?.drain(), taskRecipes?.drain()]).finally(() => {
    logService.dispose(); shutdownComplete = true; app.quit();
    // 开发服务器托管时 app.quit() 会卡在收尾；资源此时已全部释放，兜底强制退出，
    // 否则 electron-vite 重启 main process 时旧进程一直占着单实例锁。
    if (process.env.ELECTRON_RENDERER_URL) setTimeout(() => app.exit(0), 1500).unref();
  });
});
