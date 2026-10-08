import type { AgentRuntime } from "@vela/agent";
import { IpcChannel } from "@vela/shared";
import { app, BrowserWindow, ipcMain } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import { homedir, release } from "node:os";
import { join } from "node:path";
import { readDevToolsInfo, restartMainProcess } from "./dev-tools";
import { syncProductionConversations } from "./production-conversation-sync";
import { listProductionSyncBatches, previewProductionSync, rollbackProductionSync, runProductionSync } from "./production-sync";

export function registerDevelopmentIpc(
  runtime: Pick<AgentRuntime, "importConversations" | "removeConversations" | "flushPersistence">,
  options: { isPackaged: boolean; home: string; productionHome?: string },
): void {
  // 正式版资料目录默认是 ~/.vela；正式版用 VELA_USER_DATA 改过位置时，用 VELA_PRODUCTION_HOME 指向它。
  const productionHome = () => options.productionHome ?? (process.env.VELA_PRODUCTION_HOME?.trim() || join(homedir(), ".vela"));
  const development = <Args extends unknown[], Result>(handler: (event: IpcMainInvokeEvent, ...args: Args) => Result) =>
    (event: IpcMainInvokeEvent, ...args: Args): Result => {
      if (options.isPackaged) throw new Error("仅开发版支持开发工具");
      return handler(event, ...args);
    };
  // 只有应用自己的窗口可以操作 DevTools；浏览器标签页里的页面不行。
  const windowOf = (event: IpcMainInvokeEvent) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isDestroyed() || event.senderFrame !== event.sender.mainFrame) throw new Error("只能从应用窗口使用开发工具");
    return window;
  };

  ipcMain.on(IpcChannel.appIsDevelopment, event => { event.returnValue = !options.isPackaged; });
  ipcMain.handle(IpcChannel.appSyncProductionConversations, () => {
    if (options.isPackaged) throw new Error("仅开发版支持同步正式版会话");
    return syncProductionConversations(runtime, productionHome(), options.home);
  });
  ipcMain.handle(IpcChannel.appSyncPreview, (_event, categories: unknown) => {
    if (options.isPackaged) throw new Error("仅开发版支持同步正式版资料");
    return previewProductionSync(runtime, categories as unknown[], productionHome(), options.home);
  });
  ipcMain.handle(IpcChannel.appSyncRun, (_event, categories: unknown) => {
    if (options.isPackaged) throw new Error("仅开发版支持同步正式版资料");
    return runProductionSync(runtime, categories as unknown[], productionHome(), options.home);
  });
  ipcMain.handle(IpcChannel.appSyncBatches, () => {
    if (options.isPackaged) throw new Error("仅开发版支持同步正式版资料");
    return listProductionSyncBatches(options.home);
  });
  ipcMain.handle(IpcChannel.appSyncRollback, (_event, batch: unknown) => {
    if (options.isPackaged) throw new Error("仅开发版支持同步正式版资料");
    if (typeof batch !== "string") throw new Error("同步批次不存在");
    return rollbackProductionSync(runtime, batch, options.home);
  });

  ipcMain.handle(IpcChannel.appDevInfo, development(() => readDevToolsInfo({
    name: app.getName(),
    version: app.getVersion(),
    appPath: app.getAppPath(),
    home: options.home,
    versions: process.versions,
    platform: process.platform,
    arch: process.arch,
    osRelease: release(),
  })));
  ipcMain.handle(IpcChannel.appDevOpenDevTools, development(event => {
    const window = windowOf(event);
    window.webContents.openDevTools({ mode: "detach" });
    window.webContents.devToolsWebContents?.focus();
  }));
  ipcMain.handle(IpcChannel.appDevReloadWindow, development(event => { windowOf(event).webContents.reload(); }));
  ipcMain.handle(IpcChannel.appDevRestartMain, development(event => {
    windowOf(event);
    return restartMainProcess({
      rendererUrl: process.env.ELECTRON_RENDERER_URL,
      appPath: app.getAppPath(),
      flush: () => runtime.flushPersistence(),
      relaunch: () => { app.relaunch(); app.quit(); },
    });
  }));
}
