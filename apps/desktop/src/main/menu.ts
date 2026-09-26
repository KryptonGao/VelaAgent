import { app, BrowserWindow, Menu, shell, type MenuItemConstructorOptions } from "electron";
import { IpcChannel, type MenuAction } from "@vela/shared";

const repoUrl = "https://github.com/KryptonGao/VelaAgent";

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
              { role: "about", label: `关于 ${name}` },
              { type: "separator" },
              { role: "services", label: "服务" },
              { type: "separator" },
              { role: "hide", label: `隐藏 ${name}` },
              { role: "hideOthers", label: "隐藏其他" },
              { role: "unhide", label: "全部显示" },
              { type: "separator" },
              { role: "quit", label: `退出 ${name}` },
            ],
          } satisfies MenuItemConstructorOptions,
        ]
      : []),
    {
      label: "文件",
      submenu: [
        { label: "新建会话", accelerator: "CmdOrCtrl+N", click: () => sendMenuAction("new-chat") },
        { label: "设置…", accelerator: "CmdOrCtrl+,", click: () => sendMenuAction("toggle-settings") },
        { type: "separator" },
        { role: "close", label: "关闭窗口" },
      ],
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo", label: "撤销" },
        { role: "redo", label: "重做" },
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "拷贝" },
        { role: "paste", label: "粘贴" },
        { role: "selectAll", label: "全选" },
      ],
    },
    {
      label: "显示",
      submenu: [
        { role: "reload", label: "重新加载" },
        { role: "forceReload", label: "强制重新加载" },
        { role: "toggleDevTools", label: "开发者工具" },
        { type: "separator" },
        { role: "resetZoom", label: "实际大小" },
        { role: "zoomIn", label: "放大" },
        { role: "zoomOut", label: "缩小" },
        { type: "separator" },
        { role: "togglefullscreen", label: "进入全屏" },
      ],
    },
    { role: "windowMenu", label: "窗口" },
    {
      label: "帮助",
      submenu: [
        ...(isMac
          ? []
          : [{ role: "about", label: `关于 ${name}` } satisfies MenuItemConstructorOptions]),
        {
          label: "项目主页",
          click: () => void shell.openExternal(repoUrl),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
