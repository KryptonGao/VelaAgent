import type { SandboxExecutionContext } from "@vela/shared";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createLocalBashOperations,
  createWriteToolDefinition,
  defineTool,
  generateDiffString,
  type BashOperations,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { isPathInside } from "./git-service";
import type { SandboxPermissionManager } from "./sandbox-permission-manager";

export interface SandboxToolFactoryInput extends SandboxExecutionContext {
  /** Agent 会话 cwd(Pi 需要它来构造内置工具) */
  cwd: string;
  /** 工作区边界;null 时退化为会话 cwd */
  workspace: string | null;
  permission: SandboxPermissionManager;
}

/**
 * 包装 Pi 内置 bash/edit/write 工具:名称与内置一致,经 customTools
 * 注入后同名覆盖。每次工具调用只过一次权限门:bash 在 exec 前,
 * 文件写入在读取/写入任何内容前。ask 模式逐条审批、工作区内文件
 * 改动放行;smart 模式由模型判断;full 模式直接放行。
 */
export function createSandboxedToolDefinitions(input: SandboxToolFactoryInput): ToolDefinition[] {
  const boundary = input.workspace ?? input.cwd;

  const bashOperations: BashOperations = {
    exec: async (command, cwd, options) => {
      const allowed = await input.permission.request({ sandboxMode: input.sandboxMode, conversationId: input.conversationId, kind: "bash", command, cwd, workspace: boundary, signal: options.signal });
      if (!allowed) throw new Error(`用户拒绝了命令执行:${command}`);
      return createLocalBashOperations().exec(command, cwd, options);
    },
  };

  const guardFileWrite = async (kind: "edit" | "write", path: string, signal?: AbortSignal): Promise<void> => {
    const allowed = await input.permission.request({
      sandboxMode: input.sandboxMode,
      conversationId: input.conversationId,
      kind,
      path,
      workspace: boundary,
      insideWorkspace: isPathInside(path, boundary),
      signal,
    });
    if (!allowed) throw new Error(`用户拒绝了文件修改:${path}`);
  };

  // defineTool 保留参数推断,同时让具体类型满足 customTools 的宽接口。
  return [
    defineTool(createBashToolDefinition(input.cwd, { operations: bashOperations })),
    defineTool(
      withPermissionGuard(
        defineTool(createEditToolDefinition(input.cwd)),
        "edit",
        input.cwd,
        guardFileWrite,
      ),
    ),
    defineTool(
      withPermissionGuard(
        withWriteDiff(input.cwd, defineTool(createWriteToolDefinition(input.cwd))),
        "write",
        input.cwd,
        guardFileWrite,
      ),
    ),
  ];
}

/**
 * 在工具真正改动文件前过一次权限门。放在 execute 最外层,保证一次
 * 调用只判断/审批一次,且 mkdir、读取旧内容等副作用不会抢先发生。
 */
function withPermissionGuard(
  tool: ToolDefinition,
  kind: "edit" | "write",
  cwd: string,
  guard: (kind: "edit" | "write", path: string, signal?: AbortSignal) => Promise<void>,
): ToolDefinition {
  return {
    ...tool,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const path = stringParam(params, "path");
      if (!path) throw new Error("缺少文件路径");
      await guard(kind, resolveToolPath(path, ctx.cwd || cwd), signal);
      return tool.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  };
}

const maxWriteDiffChars = 100_000;

/**
 * write 工具本身只回报「写成功了」。这里在写入前读旧内容，
 * 成功后把展示用 diff 放进 details，界面才能画出增删。
 */
function withWriteDiff(cwd: string, tool: ToolDefinition): ToolDefinition {
  return {
    ...tool,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const path = stringParam(params, "path");
      const content = stringParam(params, "content") ?? "";
      const previous = path ? await readPreviousFile(resolveToolPath(path, ctx.cwd || cwd)) : { text: "" };
      const result = await tool.execute(toolCallId, params, signal, onUpdate, ctx);
      let diff = "";
      try {
        diff = generateDiffString(normalizeNewlines(previous.text), normalizeNewlines(content)).diff;
      } catch {
        diff = "";
      }
      const clipped = diff.length > maxWriteDiffChars ? `${diff.slice(0, maxWriteDiffChars)}\n… 内容过长，已截断` : diff;
      const details = previous.note ? { diff: clipped, note: previous.note } : { diff: clipped };
      return { ...result, details };
    },
  };
}

async function readPreviousFile(absolute: string): Promise<{ text: string; note?: string }> {
  try {
    const info = await stat(absolute);
    if (!info.isFile()) return { text: "" };
    if (info.size > 1_000_000) return { text: "", note: "原文件较大，只展示本次写入的内容" };
    return { text: await readFile(absolute, "utf8") };
  } catch {
    return { text: "" };
  }
}

function resolveToolPath(filePath: string, cwd: string): string {
  const expanded = filePath === "~" || filePath.startsWith("~/") ? `${homedir()}${filePath.slice(1)}` : filePath;
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

function normalizeNewlines(text: string): string {
  return text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function stringParam(params: unknown, key: string): string | undefined {
  if (!params || typeof params !== "object") return undefined;
  const value = (params as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}
