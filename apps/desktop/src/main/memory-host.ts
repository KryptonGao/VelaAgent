/**
 * 记忆管理 IPC：设置页通过它列出、读取、保存和删除记忆文件。
 *
 * renderer 只提交作用域和已登记工作区路径；主进程校验请求形状、项目登记、
 * 内容字节数和 revision，并复用 AgentRuntime 持有的 MemoryService 做真实读写。
 * 项目访问不接受任意路径，Agent 工具也只能访问所属会话的项目。
 */
import { MemoryError, memoryDirectoryName, memoryFileName, type AgentRuntime } from "@vela/agent";
import {
  IpcChannel,
  memoryFileMaxBytes,
  type MemoryCatalog,
  type MemoryCatalogEntry,
  type MemoryDocument,
  type MemoryFailure,
  type MemoryProject,
  type MemoryResult,
  type MemoryScope,
  type MemoryTarget,
} from "@vela/shared";
import { BrowserWindow, ipcMain } from "electron";
import { realpath } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";

export type MemoryOperation = "list" | "read" | "save" | "remove" | "set-enabled";

const operationFields: Record<MemoryOperation, readonly string[]> = {
  "set-enabled": ["enabled"],
  list: ["conversationId"],
  read: ["scope", "workspace"],
  save: ["scope", "workspace", "content", "expectedRevision"],
  remove: ["scope", "workspace", "expectedRevision"],
};

interface MemoryRequest {
  enabled?: boolean;
  conversationId?: string | null;
  scope?: MemoryScope;
  workspace?: string | null;
  content?: string;
  expectedRevision?: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** 校验 IPC 请求形状；不做工作区登记判断，登记状态由 MemoryHost 异步确认。 */
export function parseMemoryRequest(raw: unknown, operation: MemoryOperation): MemoryRequest {
  if (!record(raw)) throw new MemoryError("invalid-target", "记忆请求格式不正确");
  const allowed = operationFields[operation];
  if (Object.keys(raw).some((key) => !allowed.includes(key))) {
    throw new MemoryError("invalid-target", "记忆请求包含不支持的字段");
  }
  const input: MemoryRequest = {};
  if (operation === "set-enabled") {
    if (typeof raw.enabled !== "boolean") throw new MemoryError("invalid-content", "记忆开关必须是布尔值");
    return { enabled: raw.enabled };
  }
  if (raw.conversationId !== undefined && raw.conversationId !== null) {
    if (typeof raw.conversationId !== "string" || !raw.conversationId.trim() || raw.conversationId.length > 200) {
      throw new MemoryError("invalid-target", "记忆请求的会话标识不正确");
    }
    input.conversationId = raw.conversationId;
  }
  if (raw.scope !== undefined) {
    if (raw.scope !== "global" && raw.scope !== "project") {
      throw new MemoryError("invalid-target", "记忆作用域不正确");
    }
    input.scope = raw.scope;
  }
  if (raw.workspace !== undefined && raw.workspace !== null) {
    if (typeof raw.workspace !== "string" || !isAbsolute(raw.workspace) || raw.workspace.includes("\0") || raw.workspace.length > 4096) {
      throw new MemoryError("invalid-target", "记忆工作区路径不正确");
    }
    input.workspace = resolve(raw.workspace);
  }
  if (raw.content !== undefined) {
    if (typeof raw.content !== "string") throw new MemoryError("invalid-content", "记忆内容必须是文本");
    input.content = raw.content;
  }
  if (raw.expectedRevision !== undefined) {
    if (typeof raw.expectedRevision !== "string" || !raw.expectedRevision || raw.expectedRevision.length > 256) {
      throw new MemoryError("invalid-content", "记忆版本指纹不正确");
    }
    input.expectedRevision = raw.expectedRevision;
  }
  if (operation !== "list") {
    if (input.scope === undefined) throw new MemoryError("invalid-target", "记忆操作需要作用域");
    if (input.scope === "project" && input.workspace === undefined) {
      throw new MemoryError("invalid-target", "项目记忆需要工作区路径");
    }
    if (input.scope === "global" && input.workspace !== undefined) {
      throw new MemoryError("invalid-target", "全局记忆不接受工作区路径");
    }
  }
  if (operation === "save" || operation === "remove") {
    if (input.expectedRevision === undefined) throw new MemoryError("invalid-content", "写入或删除记忆需要版本指纹");
    if (operation === "save") {
      if (input.content === undefined) throw new MemoryError("invalid-content", "保存记忆需要完整内容");
      if (Buffer.byteLength(input.content, "utf8") > memoryFileMaxBytes) {
        throw new MemoryError("content-too-large", `记忆文件最多 ${memoryFileMaxBytes / 1024} KiB，请先精简`);
      }
    }
  }
  return input;
}

export interface MemoryHostOptions {
  /** 已登记工作区绝对路径；列表与项目访问都以它为准，不扫描磁盘。 */
  workspaces: () => readonly string[];
}

export class MemoryHost {
  private readonly channels: string[] = [];

  constructor(
    private readonly runtime: AgentRuntime,
    private readonly options: MemoryHostOptions,
  ) {}

  register(): void {
    if (this.channels.length) return;
    const handle = (
      channel: string,
      operation: MemoryOperation,
      action: (input: MemoryRequest) => Promise<MemoryResult<unknown>>,
    ) => {
      this.channels.push(channel);
      ipcMain.handle(channel, async (event, raw: unknown) => {
        if (!BrowserWindow.fromWebContents(event.sender) || event.senderFrame !== event.sender.mainFrame) {
          throw new Error("记忆请求不可用");
        }
        try {
          return await action(parseMemoryRequest(raw, operation));
        } catch (error) {
          return failureResult(error);
        }
      });
    };
    handle(IpcChannel.memoryList, "list", (input) => this.list(input));
    handle(IpcChannel.memorySetEnabled, "set-enabled", async (input) => ({
      ok: true, value: this.runtime.setMemoryEnabled(input.enabled!),
    }));
    handle(IpcChannel.memoryRead, "read", (input) => this.read(input));
    handle(IpcChannel.memorySave, "save", (input) => this.save(input));
    handle(IpcChannel.memoryRemove, "remove", (input) => this.remove(input));
  }

  dispose(): void {
    for (const channel of this.channels.splice(0)) ipcMain.removeHandler(channel);
  }

  private async list(input: MemoryRequest): Promise<MemoryResult<MemoryCatalog>> {
    const global = await this.entryFor({ scope: "global", workspace: null });
    const projects: MemoryCatalogEntry[] = [];
    const workspaces: MemoryProject[] = [];
    for (const path of this.registeredPaths()) {
      const entry = await this.entryFor({ scope: "project", workspace: path });
      projects.push(entry);
      workspaces.push({
        workspace: entry.workspace ?? path,
        name: entry.name,
        available: entry.error !== "unavailable",
      });
    }
    return {
      ok: true,
      value: {
        enabled: this.runtime.getMemorySettings().enabled,
        global,
        projects,
        workspaces,
        currentProject: this.conversationProject(input.conversationId ?? null),
      },
    };
  }

  private async read(input: MemoryRequest): Promise<MemoryResult<MemoryDocument>> {
    const target = await this.resolveTarget(input);
    return { ok: true, value: await this.runtime.memory.read(target) };
  }

  private async save(input: MemoryRequest): Promise<MemoryResult<MemoryDocument>> {
    const target = await this.resolveTarget(input);
    if (typeof input.content !== "string") throw new MemoryError("invalid-content", "保存记忆需要完整内容");
    const document = await this.runtime.memory.save(target, input.content, input.expectedRevision!);
    return { ok: true, value: document };
  }

  private async remove(input: MemoryRequest): Promise<MemoryResult<null>> {
    const target = await this.resolveTarget(input);
    await this.runtime.memory.remove(target, input.expectedRevision!);
    return { ok: true, value: null };
  }

  /** 列表项只读元数据；单项读取失败不阻塞其他来源。 */
  private async entryFor(target: MemoryTarget): Promise<MemoryCatalogEntry> {
    const load = await this.runtime.memory.load(target);
    const workspace = target.scope === "project" && typeof target.workspace === "string"
      ? load.workspace ?? resolve(target.workspace)
      : null;
    const path = target.scope === "global"
      ? load.path ?? ""
      : workspace ? join(workspace, memoryDirectoryName, memoryFileName) : load.path ?? "";
    return {
      scope: target.scope,
      workspace,
      name: workspace ? basename(workspace) : "",
      path,
      exists: load.status === "loaded",
      status: load.status,
      bytes: load.bytes,
      revision: load.revision,
      error: load.error,
      message: load.message,
    };
  }

  /** 项目目标必须是已登记工作区；路径相等或真实路径相同都接受。 */
  private async resolveTarget(input: MemoryRequest): Promise<MemoryTarget> {
    if (input.scope === "global") {
      if (input.workspace !== undefined && input.workspace !== null) {
        throw new MemoryError("invalid-target", "全局记忆不接受工作区路径");
      }
      return { scope: "global", workspace: null };
    }
    if (typeof input.workspace !== "string" || !input.workspace.trim()) {
      throw new MemoryError("invalid-target", "项目记忆需要工作区路径");
    }
    const workspace = await this.registeredWorkspace(input.workspace);
    if (!workspace) throw new MemoryError("invalid-target", "这个工作区没有登记，无法访问项目记忆", input.workspace);
    return { scope: "project", workspace };
  }

  private async registeredWorkspace(requested: string): Promise<string | null> {
    const registered = this.registeredPaths();
    const resolved = resolve(requested);
    if (registered.includes(resolved)) return resolved;
    const real = await realpath(resolved).catch(() => null);
    if (!real) return null;
    for (const candidate of registered) {
      if ((await realpath(candidate).catch(() => null)) === real) return real;
    }
    return null;
  }

  private registeredPaths(): string[] {
    return [...new Set(
      this.options.workspaces()
        .filter((path): path is string => typeof path === "string" && isAbsolute(path))
        .map((path) => resolve(path)),
    )];
  }

  /** 当前会话的实际项目；无工作区或找不到会话时为空。 */
  private conversationProject(conversationId: string | null): string | null {
    const id = conversationId ?? this.runtime.activeConversationId;
    if (!id) return null;
    const conversation = this.runtime.listConversations().find((entry) => entry.id === id);
    if (!conversation || conversation.hasWorkspace === false) return null;
    return resolve(conversation.cwd);
  }
}

function failureResult(error: unknown): MemoryResult<never> {
  return { ok: false, error: toFailure(error) };
}

function toFailure(error: unknown): MemoryFailure {
  if (error instanceof MemoryError) return { code: error.code, message: error.message, path: error.path };
  const message = error instanceof Error && error.message ? error.message : "记忆操作失败，请重试。";
  return { code: "io-error", message, path: null };
}
