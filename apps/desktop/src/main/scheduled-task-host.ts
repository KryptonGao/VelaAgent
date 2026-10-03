import { BrowserWindow, ipcMain, powerMonitor } from "electron";
import { ScheduledTasksIpc } from "@vela/shared";
import { ScheduledTaskScheduler } from "./scheduled-task-service";

export class ScheduledTaskHost {
  private unsubscribe: (() => void) | null = null;
  constructor(private readonly scheduler: ScheduledTaskScheduler) {}
  private readonly onSuspend = () => this.scheduler.suspend();
  private readonly onResume = () => this.scheduler.resume();
  register(): void {
    const scheduler = this.scheduler;
    ipcMain.handle(ScheduledTasksIpc.list, () => scheduler.list());
    ipcMain.handle(ScheduledTasksIpc.create, (_event, input) => scheduler.create(input));
    ipcMain.handle(ScheduledTasksIpc.update, (_event, id, patch) => scheduler.update(id, patch));
    ipcMain.handle(ScheduledTasksIpc.delete, (_event, id) => scheduler.delete(id));
    ipcMain.handle(ScheduledTasksIpc.runNow, (_event, id) => scheduler.runNow(id));
    this.unsubscribe = scheduler.subscribe(state => {
      for (const window of BrowserWindow.getAllWindows()) if (!window.webContents.isDestroyed()) window.webContents.send(ScheduledTasksIpc.state, state);
    });
    powerMonitor.on("suspend", this.onSuspend);
    powerMonitor.on("resume", this.onResume);
  }
  dispose(): void {
    this.scheduler.stop(); this.unsubscribe?.();
    powerMonitor.removeListener("suspend", this.onSuspend);
    powerMonitor.removeListener("resume", this.onResume);
    for (const channel of [ScheduledTasksIpc.list, ScheduledTasksIpc.create, ScheduledTasksIpc.update, ScheduledTasksIpc.delete, ScheduledTasksIpc.runNow]) ipcMain.removeHandler(channel);
  }
}
