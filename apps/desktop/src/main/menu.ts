import { app, BrowserWindow, Menu, shell, type MenuItemConstructorOptions } from "electron";
import { IpcChannel, localizeZh, type AppLocale, type MenuAction } from "@vela/shared";
import desktopPackage from "../../package.json";

const repoUrl = "https://github.com/KryptonGao/VelaHarness";
let activeLocale: AppLocale = "zh-CN";
let diagnostics: DiagnosticsMenuActions | null = null;
let checkForUpdates: (() => void) | null = null;

export interface DiagnosticsMenuActions {
  exportLogs(): void;
  openLogsFolder(): void;
}

function text(chinese: string, english: string): string {
  return localizeZh(activeLocale, chinese, english);
}

export function getApplicationLocale(): AppLocale {
  return activeLocale;
}

export function setApplicationLocale(locale: AppLocale): void {
  activeLocale = locale;
  installApplicationMenu();
  app.setAboutPanelOptions({
    applicationName: "Vela",
    applicationVersion: desktopPackage.shortVersion ?? app.getVersion(),
    credits: text("在你选定的代码仓库中工作的桌面 AI 编程助手。", "A desktop AI coding assistant that works in the code repository you choose."),
  });
}

/** 帮助菜单里的日志入口直接在主进程执行,不经渲染层。 */
export function setDiagnosticsMenuActions(actions: DiagnosticsMenuActions): void {
  diagnostics = actions;
  installApplicationMenu();
}

/** 「检查更新…」由主进程直接处理并用系统对话框反馈。 */
export function setUpdateMenuAction(action: () => void): void {
  checkForUpdates = action;
  installApplicationMenu();
}

function sendMenuAction(action: MenuAction): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  win?.webContents.send(IpcChannel.appMenuAction, action);
}

/**
 * 自建应用菜单:顶部应用菜单带程序名,操作走标准 role,业务动作经 IPC 发给渲染层。
 * macOS 上首个菜单的标题由系统按应用名强制显示,这里仍给出 label 保证其他平台正确。
 */
export function installApplicationMenu(): void {
  const name = app.name;
  const isMac = process.platform === "darwin";

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: name,
            submenu: [
              { role: "about", label: text(`关于 ${name}`, `About ${name}`) },
              ...(checkForUpdates ? [{ label: text("检查更新…", "Check for Updates…"), click: () => checkForUpdates?.() } satisfies MenuItemConstructorOptions] : []),
              { type: "separator" },
              { role: "services", label: text("服务", "Services") },
              { type: "separator" },
              { role: "hide", label: text(`隐藏 ${name}`, `Hide ${name}`) },
              { role: "hideOthers", label: text("隐藏其他", "Hide Others") },
              { role: "unhide", label: text("全部显示", "Show All") },
              { type: "separator" },
              { role: "quit", label: text(`退出 ${name}`, `Quit ${name}`) },
            ],
          } satisfies MenuItemConstructorOptions,
        ]
      : []),
    {
      label: text("文件", "File"),
      submenu: [
        { label: text("新建会话", "New Chat"), accelerator: "CmdOrCtrl+N", click: () => sendMenuAction("new-chat") },
        { label: text("设置…", "Settings…"), accelerator: "CmdOrCtrl+,", click: () => sendMenuAction("toggle-settings") },
        { type: "separator" },
        { role: "close", label: text("关闭窗口", "Close Window") },
      ],
    },
    {
      label: text("编辑", "Edit"),
      submenu: [
        { role: "undo", label: text("撤销", "Undo") },
        { role: "redo", label: text("重做", "Redo") },
        { type: "separator" },
        { role: "cut", label: text("剪切", "Cut") },
        { role: "copy", label: text("拷贝", "Copy") },
        { role: "paste", label: text("粘贴", "Paste") },
        { role: "selectAll", label: text("全选", "Select All") },
      ],
    },
    {
      label: text("显示", "View"),
      submenu: [
        { role: "reload", label: text("重新加载", "Reload") },
        { role: "forceReload", label: text("强制重新加载", "Force Reload") },
        { role: "toggleDevTools", label: text("开发者工具", "Developer Tools") },
        { type: "separator" },
        { role: "resetZoom", label: text("实际大小", "Actual Size") },
        { role: "zoomIn", label: text("放大", "Zoom In") },
        { role: "zoomOut", label: text("缩小", "Zoom Out") },
        { type: "separator" },
        { role: "togglefullscreen", label: text("进入全屏", "Toggle Full Screen") },
      ],
    },
    { role: "windowMenu", label: text("窗口", "Window") },
    {
      label: text("帮助", "Help"),
      submenu: [
        ...(isMac
          ? []
          : [{ role: "about", label: text(`关于 ${name}`, `About ${name}`) } satisfies MenuItemConstructorOptions]),
        ...(checkForUpdates && !isMac
          ? [{ label: text("检查更新…", "Check for Updates…"), click: () => checkForUpdates?.() } satisfies MenuItemConstructorOptions]
          : []),
        {
          label: text("项目主页", "Project Website"),
          click: () => void shell.openExternal(repoUrl),
        },
        ...(diagnostics
          ? [
              { type: "separator" },
              { label: text("导出诊断日志…", "Export Diagnostic Logs…"), click: () => diagnostics?.exportLogs() },
              { label: text("打开日志文件夹", "Open Logs Folder"), click: () => diagnostics?.openLogsFolder() },
            ] satisfies MenuItemConstructorOptions[]
          : []),
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
