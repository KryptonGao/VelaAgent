import type { AgentRuntime } from "@vela/agent";
import { IpcChannel, createLogger, type AppLocale, type CheckpointTimeline, type ConversationExportOptions, type ConversationExportResult, type TraceSnapshot } from "@vela/shared";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildConversationExport, conversationExportFileName, parseExportOptions } from "./conversation-export";

const log = createLogger("conversation-export");
/** Failure text is fetched node by node; a runaway loop of failing calls must not turn an export into hundreds of reads. */
const failureDetailLimit = 50;

export class ConversationExportHost {
  constructor(private readonly runtime: AgentRuntime, private readonly locale: () => AppLocale) {}

  register(): void {
    ipcMain.handle(IpcChannel.sessionExport, (event, rawId: unknown, rawOptions: unknown) => {
      if (typeof rawId !== "string" || !/^[0-9a-f-]{8,64}$/i.test(rawId)) throw new Error("对话不正确");
      return this.export(BrowserWindow.fromWebContents(event.sender), rawId, parseExportOptions(rawOptions));
    });
  }

  dispose(): void {
    ipcMain.removeHandler(IpcChannel.sessionExport);
  }

  /** Resolves null when the save dialog is cancelled. */
  async export(win: BrowserWindow | null, id: string, options: ConversationExportOptions): Promise<ConversationExportResult | null> {
    const conversation = this.runtime.listConversations().find(item => item.id === id);
    if (!conversation) throw new Error("对话不存在或已结束");
    const dialogOptions = {
      defaultPath: join(app.getPath("documents"), conversationExportFileName(conversation.title, options.format)),
      filters: options.format === "markdown" ? [{ name: "Markdown", extensions: ["md"] }] : [{ name: "HTML", extensions: ["html"] }],
    };
    const selection = win ? await dialog.showSaveDialog(win, dialogOptions) : await dialog.showSaveDialog(dialogOptions);
    if (selection.canceled || !selection.filePath) return null;

    // Read after the dialog so a reply that finished while it was open is included.
    const messages = this.runtime.getMessages(id);
    if (messages.length === 0) throw new Error("这个对话还没有消息");
    let trace: TraceSnapshot | null = null;
    const failureDetails = new Map<string, string>();
    if (options.includeTrace) {
      try {
        trace = this.runtime.getTrace(id);
        for (const node of trace.nodes.filter(item => item.status === "Failed" || item.status === "Interrupted").slice(0, failureDetailLimit)) {
          const content = this.runtime.getTraceDetails(id, node.id)?.content;
          if (content) failureDetails.set(node.id, content);
        }
      } catch (error) {
        log.warn("trace unavailable for export", { error: (error as Error).message });
      }
    }
    // Checkpoints only add the list of files each turn touched; a workspace without them still exports.
    let checkpoints: CheckpointTimeline | null = null;
    try { checkpoints = await this.runtime.getCheckpoints(id); }
    catch (error) { log.warn("checkpoints unavailable for export", { error: (error as Error).message }); }

    log.info("exporting conversation", { format: options.format, includeTrace: options.includeTrace, includeDiffs: options.includeDiffs });
    const document = buildConversationExport({
      conversation,
      messages,
      trace,
      failureDetails,
      checkpoints,
      locale: this.locale(),
      appVersion: app.getVersion(),
    }, options);
    await writeFile(selection.filePath, document, "utf8");
    shell.showItemInFolder(selection.filePath);
    return { path: selection.filePath };
  }
}
