import { BrowserWindow, ipcMain } from "electron";
import {
  ResidentIpc,
  agentInboxIdPattern,
  residentLimits,
  type ProactiveRulesState,
  type ResidentStatus,
  type ResidentSubmitInput,
} from "@vela/shared";
import { assertMainFrame } from "./agent-inbox-host";
import type { ProactiveRuleService } from "./proactive-rules";
import type { ResidentAgentSupervisor } from "./resident-agent-supervisor";

const channels = [
  ResidentIpc.status, ResidentIpc.submit, ResidentIpc.pause, ResidentIpc.resume, ResidentIpc.getSettings, ResidentIpc.updateSettings,
  ResidentIpc.cancelTask, ResidentIpc.messages, ResidentIpc.rulesList, ResidentIpc.rulesSave, ResidentIpc.rulesRemove,
];

/**
 * 常驻 Agent 与主动规则的 IPC 入口。每个处理函数先确认调用方是应用窗口的主框架，
 * 再把参数当作 unknown 逐项校验；任务 id、规则 id 只用来在主进程已有的记录里查找，不当作授权。
 */
export class ResidentAgentHost {
  private readonly offs: Array<() => void> = [];

  constructor(private readonly supervisor: ResidentAgentSupervisor, private readonly rules: ProactiveRuleService) {}

  register(): void {
    const { supervisor, rules } = this;
    ipcMain.handle(ResidentIpc.status, event => { assertMainFrame(event); return supervisor.getStatus(); });
    ipcMain.handle(ResidentIpc.submit, (event, raw: unknown) => { assertMainFrame(event); return supervisor.submit(parseSubmit(raw)); });
    ipcMain.handle(ResidentIpc.pause, event => { assertMainFrame(event); supervisor.pause(); return supervisor.getStatus(); });
    ipcMain.handle(ResidentIpc.resume, event => { assertMainFrame(event); supervisor.resume(); return supervisor.getStatus(); });
    ipcMain.handle(ResidentIpc.getSettings, event => { assertMainFrame(event); return supervisor.getSettings(); });
    ipcMain.handle(ResidentIpc.updateSettings, (event, raw: unknown) => {
      assertMainFrame(event);
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("参数不正确");
      return supervisor.updateSettings(raw);
    });
    ipcMain.handle(ResidentIpc.cancelTask, async (event, raw: unknown) => {
      assertMainFrame(event);
      await supervisor.cancelTask(parseId(raw));
      return supervisor.getStatus();
    });
    ipcMain.handle(ResidentIpc.messages, event => { assertMainFrame(event); return supervisor.getMessages(); });
    ipcMain.handle(ResidentIpc.rulesList, event => { assertMainFrame(event); return rules.list(); });
    ipcMain.handle(ResidentIpc.rulesSave, (event, raw: unknown, rawId: unknown) => {
      assertMainFrame(event);
      if (rawId !== undefined && rawId !== null) return rules.save(raw, parseId(rawId));
      return rules.save(raw);
    });
    ipcMain.handle(ResidentIpc.rulesRemove, (event, raw: unknown) => { assertMainFrame(event); return rules.remove(parseId(raw)); });
    this.offs.push(
      supervisor.subscribe((status: ResidentStatus) => broadcast(ResidentIpc.statusChange, status)),
      rules.subscribe((state: ProactiveRulesState) => broadcast(ResidentIpc.rulesChange, state)),
    );
  }

  dispose(): void {
    for (const off of this.offs.splice(0)) off();
    for (const channel of channels) ipcMain.removeHandler(channel);
  }
}

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
    window.webContents.send(channel, payload);
  }
}

function parseId(raw: unknown): string {
  if (typeof raw !== "string" || !agentInboxIdPattern.test(raw)) throw new Error("标识不正确");
  return raw;
}

function parseSubmit(raw: unknown): ResidentSubmitInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("参数不正确");
  const input = raw as Record<string, unknown>;
  if (typeof input.text !== "string" || input.text.length > residentLimits.maxPrompt) throw new Error("内容不正确");
  if (input.workspace !== undefined && (typeof input.workspace !== "string" || input.workspace.length > 1000)) throw new Error("工作区不正确");
  return { text: input.text, ...(input.workspace === undefined ? {} : { workspace: input.workspace }) };
}
