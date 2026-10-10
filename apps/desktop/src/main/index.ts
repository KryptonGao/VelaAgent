import { AgentRuntime } from "@vela/agent";
import {
  ExecutionEnvironmentManager,
  GitOperationLog,
  GitService,
  PullRequestService,
  SandboxPermissionManager,
  sandboxApprovalTimeoutMs,
  WorkspaceFileService,
  WorkspaceManager,
  createSandboxedToolDefinitions,
  createWorktree, removeWorktree,
} from "@vela/workspace";
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, powerMonitor, session, shell, Tray, webContents } from "electron";
import type { BrowserWindowConstructorOptions } from "electron";
import { createLogger, IpcChannel, isAgentBusy, isAppLocale, localizeZh, type ResidentSettings } from "@vela/shared";
import { existsSync, readFileSync, statSync, watch as fsWatch, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ConversationExportHost } from "./conversation-export-host";
import { getApplicationLocale, setApplicationLocale, setDiagnosticsMenuActions, setUpdateMenuAction } from "./menu";
import { LogService } from "./log-service";
import { installCrashHandlers, LogHost, systemInfo } from "./log-host";
import { createUpdateService, UpdateHost } from "./update-host";
import { registerOpenTargetIpc } from "./open-targets";
import { ProjectHost } from "./project-host";
import { SessionHost } from "./session-host";
import { ScheduledTaskScheduler } from "./scheduled-task-service";
import { TaskRecipeService } from "./task-recipe-service";
import { TaskRecipeHost } from "./task-recipe-host";
import { executeScheduledRecipe } from './task-recipe-schedule';
import { ScheduledTaskHost } from "./scheduled-task-host";
import { AgentInboxService } from "./agent-inbox-service";
import { AgentInboxAdapter } from "./agent-inbox-adapter";
import { AgentInboxHost } from "./agent-inbox-host";
import { AgentInboxNotifier } from "./agent-inbox-notifier";
import { ResidentAgentSupervisor } from "./resident-agent-supervisor";
import { ResidentAgentHost } from "./resident-agent-host";
import { ProactiveRuleService } from "./proactive-rules";
import { ResidentTray, type TrayAction } from "./resident-tray";
import { McpHost } from "./mcp-host";
import { MemoryHost } from "./memory-host";
import { SecureCredentialStore } from "./plugin-credentials";
import { ensureLoginShellPath } from "./shell-path";
import { PrInboxHost } from "./pr-inbox-host";
import { PrReviewResponseService } from "./pr-review-response-service";
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
import trayIconPath from "../../resources/tray-template.png?asset";

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
let agentInboxAdapter: AgentInboxAdapter | null = null;
let agentInboxHost: AgentInboxHost | null = null;
let agentInboxNotifier: AgentInboxNotifier | null = null;
let residentSupervisor: ResidentAgentSupervisor | null = null;
let residentHost: ResidentAgentHost | null = null;
let proactiveRules: ProactiveRuleService | null = null;
let residentTray: ResidentTray | null = null;
const activeNotifications = new Set<Notification>();
/** 登录项启动且用户选择了后台待命：不弹出主窗口。 */
let startHidden = false;
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
let conversationExportHost: ConversationExportHost | null = null;
let updateHost: UpdateHost | null = null;

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
    if (!startHidden || process.env.VELA_CAPTURE) win.show();
    startHidden = false;
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

/** 显示主窗口；没有窗口时重新创建（关闭窗口后应用仍在后台运行）。 */
function showMainWindow(): BrowserWindow {
  const existing = BrowserWindow.getAllWindows().find(window => !window.isDestroyed());
  if (!existing) return createWindow();
  if (existing.isMinimized()) existing.restore();
  existing.show();
  existing.focus();
  return existing;
}

function applyLoginItem(settings: ResidentSettings): void {
  // 开发版和未打包的应用不注册登录项，避免把 Electron 开发二进制写进系统。
  if (!app.isPackaged || process.platform !== "darwin") return;
  try { app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin }); }
  catch (error) { log.error("login item update failed", error); }
}

/** 已登记工作区里的 Git 目录；工作树里 .git 是指向真实目录的文件。 */
function resolveGitDir(workspace: string): string | null {
  const dotGit = join(workspace, ".git");
  try {
    if (statSync(dotGit).isDirectory()) return dotGit;
    const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
    const target = match ? resolve(workspace, match[1]!.trim()) : null;
    return target && existsSync(target) ? target : null;
  } catch { return null; }
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
  updateHost = new UpdateHost(createUpdateService(home));
  updateHost.register();
  setUpdateMenuAction(() => { void updateHost?.checkFromMenu().catch(error => log.error("update check from menu failed", error)); });
  // 开发版只提供手动检查，不在后台联网，也不会替换 Electron 开发二进制。
  if (app.isPackaged) updateHost.service.start();
  const runtime = new AgentRuntime({
    // 常驻 Agent 的工具只读取 Supervisor 的真实记录；Supervisor 在运行时之后创建，所以这里延迟取用。
    resident: {
      conversationId: () => residentSupervisor?.getResidentConversationId() ?? null,
      host: {
        workspaces: () => residentSupervisor?.workspaces() ?? [],
        tasks: () => residentSupervisor?.tasks() ?? [],
        inbox: filter => residentSupervisor?.inbox(filter) ?? [],
        delegate: input => residentSupervisor ? residentSupervisor.delegate(input) : Promise.resolve({ ok: false as const, reason: "常驻 Agent 尚未就绪" }),
      },
    },
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
    workspaces: registeredWorkspaces, runningWorkspaces: () => runtime.listConversations().filter(c => c.status === "streaming" || runtime.getAgents(c.id).some(a => a.kind !== "root" && isAgentBusy(a.status))).map(c => c.cwd),
  });
  prInboxHost?.setResponses(new PrReviewResponseService({
    inbox: prInboxHost.service, home, workspaces: registeredWorkspaces,
    startConversation: async (cwd, title, prompt) => {
      const snapshot = await runtime.createConversation(cwd, { hasWorkspace: true });
      const id = snapshot.id;
      if (!id) throw new Error(snapshot.error ?? "无法创建对话");
      await runtime.renameConversation(id, title);
      // The turn can run for minutes; the caller only needs the conversation to exist.
      void runtime.prompt(id, prompt).catch(error => log.error("pr review response prompt failed", error));
      return id;
    },
  }));
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

  // Agent Inbox 与常驻 Agent 运行在 main process，窗口隐藏或关闭时仍然接收审批、问题和任务结果。
  try {
    const inbox = new AgentInboxService(join(home, "agent-inbox.json"), {
      approve: (id, allowed) => sandbox.reply(id, allowed),
      answer: (id, answer) => runtime.replyQuestion(id, answer),
    });
    inbox.init();

    const supervisor = new ResidentAgentSupervisor({
      file: join(home, "resident-agent.json"),
      residentDir: join(home, "resident"),
      runtime,
      inbox: {
        pendingWaits: () => inbox.pendingWaits(),
        pendingCount: () => inbox.pendingCount(),
        recent: filter => inbox.summaries(filter),
        subscribe: listener => inbox.subscribe(() => listener()),
      },
      approvals: { request: input => sandbox.request(input) },
      power: {
        isOnBattery: () => powerMonitor.isOnBatteryPower(),
        subscribe: listener => {
          const suspend = () => listener("suspend");
          const resume = () => listener("resume");
          const battery = () => listener("battery");
          const ac = () => listener("ac");
          powerMonitor.on("suspend", suspend);
          powerMonitor.on("resume", resume);
          powerMonitor.on("on-battery", battery);
          powerMonitor.on("on-ac", ac);
          return () => {
            powerMonitor.removeListener("suspend", suspend);
            powerMonitor.removeListener("resume", resume);
            powerMonitor.removeListener("on-battery", battery);
            powerMonitor.removeListener("on-ac", ac);
          };
        },
      },
      workspaces: registeredWorkspaces,
      sandboxMode: () => sandbox.getMode(),
    });
    supervisor.init();
    residentSupervisor = supervisor;
    startHidden = process.platform === "darwin" && supervisor.getSettings().launchAtLogin && app.getLoginItemSettings().wasOpenedAtLogin;
    applyLoginItem(supervisor.getSettings());

    const rules = new ProactiveRuleService({
      file: join(home, "proactive-rules.json"),
      host: {
        settings: () => supervisor.getSettings(),
        flags: () => supervisor.getRuntimeFlags(),
        globalRunsToday: () => supervisor.proactiveRunsToday(),
        ruleRunning: ruleId => supervisor.hasActiveRuleTask(ruleId),
        startTask: spec => supervisor.startTask(spec),
        workspaces: registeredWorkspaces,
        gitDir: resolveGitDir,
        watch: (path, options, listener) => fsWatch(path, { recursive: options.recursive, persistent: false }, (_event, filename) => listener(filename === null ? null : String(filename))),
      },
    });
    rules.init();
    proactiveRules = rules;
    // 新的失败事项可以触发订阅了「失败时分析」的规则。
    const seenInboxItems = new Set(inbox.list({}).items.map(item => item.id));
    inbox.subscribe(change => {
      for (const item of change.upserts) {
        if (seenInboxItems.has(item.id)) continue;
        seenInboxItems.add(item.id);
        rules.onInboxItem({ id: item.id, type: item.type, origin: item.origin, title: item.title, summary: item.summary, ...(item.workspaceId ? { workspaceId: item.workspaceId } : {}) });
      }
    });

    agentInboxAdapter = new AgentInboxAdapter({
      service: inbox, runtime, sandbox, scheduler, approvalTimeoutMs: sandboxApprovalTimeoutMs,
      tasks: {
        classify: conversationId => {
          if (supervisor.isResidentConversation(conversationId)) return { isResident: true, origin: "resident" };
          const task = supervisor.taskForConversation(conversationId);
          if (!task) return null;
          return {
            isResident: false,
            origin: task.source === "rule" ? "proactive" : "resident",
            taskId: task.id,
            title: task.title,
            suggestion: task.source === "rule",
            timedOut: task.timedOut,
            ...(task.reason ? { reason: task.reason } : {}),
          };
        },
      },
    });
    agentInboxAdapter.start();
    agentInboxHost = new AgentInboxHost(inbox, runtime);
    agentInboxHost.register();
    residentHost = new ResidentAgentHost(supervisor, rules);
    residentHost.register();

    // 系统通知：点击后回到对应事项。
    agentInboxNotifier = new AgentInboxNotifier({
      settings: () => supervisor.getSettings(),
      locale: getApplicationLocale,
      appFocused: () => BrowserWindow.getAllWindows().some(window => !window.isDestroyed() && window.isFocused() && window.isVisible()),
      show: note => {
        if (!Notification.isSupported()) return;
        const notification = new Notification({ title: note.title, body: note.body });
        activeNotifications.add(notification);
        const release = () => { activeNotifications.delete(notification); };
        notification.once("close", release);
        notification.once("failed", release);
        notification.once("click", () => {
          release();
          showMainWindow();
          agentInboxHost?.navigate(note.itemId ? { view: "item", itemId: note.itemId } : { view: "inbox" });
        });
        notification.show();
      },
    });
    agentInboxNotifier.seed(inbox.list({}).items);
    inbox.subscribe(change => agentInboxNotifier?.onChange(change));

    // 菜单栏入口：状态、待处理数量、暂停与恢复。
    const tray = new ResidentTray({
      locale: getApplicationLocale,
      create: () => {
        const icon = nativeImage.createFromPath(trayIconPath).resize({ width: 16, height: 16 });
        icon.setTemplateImage(true);
        const handle = new Tray(icon);
        return {
          setToolTip: text => handle.setToolTip(text),
          setTitle: text => { if (process.platform === "darwin") handle.setTitle(text); },
          setMenu: items => handle.setContextMenu(Menu.buildFromTemplate(items)),
          onClick: listener => { handle.on("click", listener); },
          destroy: () => handle.destroy(),
        };
      },
      onAction: (action: TrayAction) => {
        if (action === "quit") { app.quit(); return; }
        if (action === "toggle-pause") { if (supervisor.getSettings().paused) supervisor.resume(); else supervisor.pause(); return; }
        showMainWindow();
        agentInboxHost?.navigate(action === "open-resident" ? { view: "resident" } : { view: "inbox" });
      },
    });
    residentTray = tray;
    supervisor.subscribe(status => tray.update(status, supervisor.getSettings().showMenuBarIcon));
    tray.update(supervisor.getStatus(), supervisor.getSettings().showMenuBarIcon);
    supervisor.subscribeSettings(settings => {
      applyLoginItem(settings);
      rules.sync();
      tray.update(supervisor.getStatus(), settings.showMenuBarIcon);
    });
  } catch (error) { log.error("agent inbox failed to start", error); }

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
    hiddenConversation: id => residentSupervisor?.isResidentConversation(id) ?? false,
  });
  host.register();
  conversationExportHost = new ConversationExportHost(runtime, getApplicationLocale, key => uiStorage.getItem(key) ?? null);
  conversationExportHost.register();
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
  // macOS 上关闭窗口后应用继续在后台运行，除非用户在设置里选择了关闭窗口即退出。
  if (process.platform !== "darwin" || residentSupervisor?.getSettings().quitWhenWindowsClosed) app.quit();
});

// 已下载的更新随退出安装；用户点「立即重启」时安装脚本会在装完后重新打开应用。
app.on("will-quit", () => updateHost?.service.onWillQuit());

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
  conversationExportHost?.dispose();
  conversationExportHost = null;
  updateHost?.dispose();
  try { taskRecipes?.stop(); } catch (error) { log.error("recipe shutdown write failed", error); }
  taskRecipeHost?.dispose(); taskRecipeHost = null;
  scheduledTaskHost?.dispose();
  scheduledTaskHost = null;
  // 先于 runtime 释放：运行时关闭时会取消所有等待点，那不是用户的决策。
  residentTray?.dispose(); residentTray = null;
  agentInboxNotifier?.dispose(); agentInboxNotifier = null;
  proactiveRules?.dispose(); proactiveRules = null;
  residentSupervisor?.dispose();
  residentHost?.dispose(); residentHost = null;
  agentInboxAdapter?.stop(); agentInboxAdapter = null;
  agentInboxHost?.dispose(); agentInboxHost = null;
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
