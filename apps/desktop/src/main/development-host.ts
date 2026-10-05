import type { AgentRuntime } from "@vela/agent";
import { IpcChannel } from "@vela/shared";
import { ipcMain } from "electron";
import { homedir } from "node:os";
import { join } from "node:path";
import { syncProductionConversations } from "./production-conversation-sync";

export function registerDevelopmentIpc(
  runtime: Pick<AgentRuntime, "importConversations">,
  options: { isPackaged: boolean; home: string; productionHome?: string },
): void {
  ipcMain.on(IpcChannel.appIsDevelopment, event => { event.returnValue = !options.isPackaged; });
  ipcMain.handle(IpcChannel.appSyncProductionConversations, () => {
    if (options.isPackaged) throw new Error("仅开发版支持同步正式版会话");
    return syncProductionConversations(runtime, options.productionHome ?? join(homedir(), ".vela"), options.home);
  });
}
