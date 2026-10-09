import { join } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, net, shell } from "electron";
import { localizeTemplate, localizeZh, UpdatesIpc, type UpdateState } from "@vela/shared";
import { getApplicationLocale } from "./menu";
import { extractZip, readBundleInfo } from "./update-bundle";
import { resolveInstallTarget, spawnInstaller } from "./update-installer";
import { UpdateService } from "./update-service";
import { updatePublicKeys } from "./update-public-keys";

const owner = "KryptonGao";
const repo = "VelaHarness";
const bundleId = "com.vela.desktop";

export function createUpdateService(home: string): UpdateService {
  return new UpdateService({
    currentVersion: app.getVersion(),
    owner,
    repo,
    bundleId,
    arch: process.arch,
    publicKeys: updatePublicKeys,
    stagingDir: join(home, "updates", "staging"),
    settingsFile: join(home, "updates.json"),
    logFile: join(home, "updates", "installer.log"),
    fetch: ((input, init) => net.fetch(input as string, init as RequestInit)) as typeof fetch,
    installTarget: () => resolveInstallTarget(app.getPath("exe"), app.isPackaged),
    extract: extractZip,
    readBundleInfo,
    spawnInstaller: plan => spawnInstaller(plan),
    quit: () => app.quit(),
  });
}

export class UpdateHost {
  private unsubscribe: (() => void) | null = null;

  constructor(readonly service: UpdateService) {}

  register(): void {
    ipcMain.handle(UpdatesIpc.getState, () => this.service.getState());
    ipcMain.handle(UpdatesIpc.check, () => this.service.check());
    ipcMain.handle(UpdatesIpc.download, () => this.service.download());
    ipcMain.handle(UpdatesIpc.restart, () => this.service.restart());
    ipcMain.handle(UpdatesIpc.setAutoUpdate, (_event, enabled: unknown) => this.service.setAutoUpdate(enabled === true));
    ipcMain.handle(UpdatesIpc.openReleasePage, () => this.openReleasePage());
    this.unsubscribe = this.service.subscribe(state => this.broadcast(state));
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const channel of Object.values(UpdatesIpc)) ipcMain.removeHandler(channel);
    this.service.dispose();
  }

  /** 应用菜单「检查更新…」：用系统对话框反馈结果，下载和重启提示仍走窗口内的通知。 */
  async checkFromMenu(): Promise<void> {
    const locale = getApplicationLocale();
    const text = (zh: string, en: string) => localizeZh(locale, zh, en);
    const state = await this.service.check();
    const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
    const show = (options: Electron.MessageBoxOptions) => parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
    if (state.status === "up-to-date" || state.status === "idle") {
      await show({ type: "info", message: text("已是最新版本", "You're up to date"),
        detail: localizeTemplate(locale, "Vela {0} 是目前最新的版本。", "Vela {0} is the latest version.", state.currentVersion), buttons: [text("好", "OK")] });
    } else if (state.status === "ready") {
      const { response } = await show({ type: "info", message: localizeTemplate(locale, "Vela {0} 已下载", "Vela {0} has been downloaded", state.version),
        detail: text("重启 Vela 即可完成更新。", "Restart Vela to finish updating."), buttons: [text("立即重启", "Restart now"), text("稍后", "Later")], defaultId: 0, cancelId: 1 });
      if (response === 0) this.service.restart();
    } else if (state.status === "error") {
      await show({ type: "error", message: text("检查更新失败", "Couldn't check for updates"), detail: state.error?.message ?? "", buttons: [text("好", "OK")] });
    } else if (state.autoUpdate && state.installable) {
      await show({ type: "info", message: localizeTemplate(locale, "发现新版本 Vela {0}", "Vela {0} is available", state.version),
        detail: text("正在后台下载，完成后会提示你重启。", "It's downloading in the background. You'll be asked to restart when it's ready."), buttons: [text("好", "OK")] });
    } else {
      const { response } = await show({ type: "info", message: localizeTemplate(locale, "发现新版本 Vela {0}", "Vela {0} is available", state.version),
        detail: state.installable ? text("可以在「设置 → 关于与更新」中下载。", "You can download it in Settings → About & updates.")
          : text("这份安装无法自动更新，请到发布页下载。", "This installation can't update itself. Download the new version from the release page."),
        buttons: [text("前往发布页", "Open release page"), text("稍后", "Later")], defaultId: 0, cancelId: 1 });
      if (response === 0) await this.openReleasePage();
    }
  }

  private async openReleasePage(): Promise<void> {
    const url = this.service.getState().releaseUrl ?? `https://github.com/${owner}/${repo}/releases/latest`;
    if (url.startsWith(`https://github.com/${owner}/${repo}/`)) await shell.openExternal(url);
  }

  private broadcast(state: UpdateState): void {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(UpdatesIpc.state, state);
    }
  }
}
