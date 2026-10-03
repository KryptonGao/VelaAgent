import type { AgentRuntime } from "@vela/agent";
import type {
  McpCatalogInput, McpServerInput, McpServerTarget, McpEnabledInput,
  McpProjectTrustInput, McpToolReadOnlyInput,
  PluginTarget,
} from "@vela/shared";
import { isMcpApprovalHash } from "@vela/shared";
import { BrowserWindow, ipcMain } from "electron";
import { isAbsolute, resolve } from "node:path";

type McpOperation = "catalog" | "save" | "remove" | "enabled" | "reconnect" | "login" | "cancel-login" | "logout" | "trust" | "readonly" | "plugins" | "plugin-connect" | "plugin-disconnect";
const commonFields = ["cwd", "conversationId"];
const targetFields = [...commonFields, "scope", "name"];
const operationFields: Record<McpOperation, readonly string[]> = {
  catalog: commonFields,
  save: [...targetFields, "config"],
  remove: targetFields,
  enabled: [...targetFields, "enabled"],
  reconnect: targetFields,
  login: targetFields,
  "cancel-login": targetFields,
  logout: targetFields,
  trust: [...commonFields, "trusted", "digest"],
  readonly: [...commonFields, "server", "tool", "readOnly", "configDigest", "toolDigest"],
  plugins: commonFields,
  "plugin-connect": [...commonFields, "id"],
  "plugin-disconnect": [...commonFields, "id"],
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** IPC carries data, never accessors, custom serialization, cyclic objects, or non-JSON config. */
function assertJsonRequest(value: unknown): void {
  const ancestors = new Set<object>();
  let entries = 0;
  const visit = (item: unknown, depth: number): void => {
    if (++entries > 200_000 || depth > 100) throw new Error("MCP configuration is too large");
    if (item === null || typeof item === "string" || typeof item === "boolean" || typeof item === "number" && Number.isFinite(item)) return;
    if (!Array.isArray(item) && !record(item) || typeof item !== "object" || item === null || ancestors.has(item)) throw new Error("Invalid MCP request data");
    if (Object.getOwnPropertySymbols(item).length) throw new Error("Invalid MCP request data");
    ancestors.add(item);
    for (const [key, property] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
      if (Array.isArray(item) && key === "length") continue;
      if (!Object.hasOwn(property, "value")) throw new Error("Invalid MCP request data");
      // Optional request fields may be undefined before Electron's structured clone.
      if (depth === 0 && property.value === undefined) continue;
      visit(property.value, depth + 1);
    }
    ancestors.delete(item);
  };
  visit(value, 0);
}

/** Renderer input never determines an arbitrary config-file or credential path. */
export function parseMcpRequest(raw: unknown, knownCwds: readonly string[], operation?: McpOperation): Record<string, unknown> & { cwd: string } {
  if (!record(raw)) throw new Error("Invalid MCP request");
  assertJsonRequest(raw);
  const input = raw as Record<string, unknown>;
  const allowedFields = operation
    ? Object.hasOwn(operationFields, operation) ? operationFields[operation] : undefined
    : [...new Set(Object.values(operationFields).flat())];
  if (!allowedFields || Object.keys(input).some(key => !allowedFields.includes(key))) throw new Error("Invalid MCP request fields");
  if (typeof input.cwd !== "string" || input.cwd.includes("\0") || !isAbsolute(input.cwd)
    || !knownCwds.some(cwd => typeof cwd === "string" && isAbsolute(cwd) && resolve(cwd) === resolve(input.cwd as string))) {
    throw new Error("MCP workspace is unavailable");
  }
  if (input.conversationId !== undefined && input.conversationId !== null
    && (typeof input.conversationId !== "string" || !input.conversationId.trim() || input.conversationId !== input.conversationId.trim())) {
    throw new Error("Invalid MCP conversation");
  }
  for (const field of ["name", "server"]) if (input[field] !== undefined && (typeof input[field] !== "string" || !/^[a-zA-Z0-9_-]+$/.test(input[field]))) {
    throw new Error("Invalid MCP server name");
  }
  if (input.tool !== undefined && (typeof input.tool !== "string" || !input.tool.trim() || input.tool !== input.tool.trim() || input.tool.length > 512 || /[\x00-\x1f\x7f]/.test(input.tool))) throw new Error("Invalid MCP tool name");
  if (input.scope !== undefined && input.scope !== "global" && input.scope !== "project") throw new Error("Invalid MCP scope");
  for (const field of ["enabled", "trusted", "readOnly"]) if (input[field] !== undefined && typeof input[field] !== "boolean") throw new Error("Invalid MCP boolean decision");
  for (const field of ["digest", "configDigest", "toolDigest"]) if (input[field] !== undefined && !isMcpApprovalHash(input[field])) throw new Error("Invalid MCP approval digest");
  if (input.config !== undefined && !record(input.config)) throw new Error("Invalid MCP server configuration");
  if (operation && ["save", "remove", "enabled", "reconnect", "login", "cancel-login", "logout"].includes(operation) && (input.name === undefined || input.scope === undefined)) throw new Error("MCP server target is required");
  if (operation === "save" && input.config === undefined) throw new Error("MCP server configuration is required");
  if (operation?.startsWith("plugin-") && (typeof input.id !== "string" || !/^[a-z][a-z0-9_]*$/.test(input.id))) throw new Error("Invalid plugin id");
  if (operation === "enabled" && typeof input.enabled !== "boolean") throw new Error("MCP enabled decision is required");
  if (operation === "trust" && (typeof input.trusted !== "boolean" || input.trusted && !isMcpApprovalHash(input.digest))) throw new Error("MCP trust decision and reviewed digest are required");
  if (operation === "readonly" && (input.server === undefined || input.tool === undefined || typeof input.readOnly !== "boolean" || !isMcpApprovalHash(input.configDigest) || !isMcpApprovalHash(input.toolDigest))) throw new Error("MCP read-only decision and reviewed digests are required");
  if (Buffer.byteLength(JSON.stringify(input), "utf8") > 200_000) throw new Error("MCP configuration is too large");
  return { ...input, cwd: resolve(input.cwd) };
}

export class McpHost {
  private unsubscribe: (() => void) | null = null;
  private unsubscribePlugins: (() => void) | null = null;
  private readonly channels: string[] = [];
  constructor(private readonly runtime: AgentRuntime, private readonly cwd: () => string) {}

  register(): void {
    if (this.channels.length) return;
    const handle = (channel: string, action: (input: Record<string, unknown> & { cwd: string }) => unknown) => {
      this.channels.push(channel);
      ipcMain.handle(channel, async (event, raw: unknown) => {
        if (channel === "mcp:plugins" || channel.startsWith("mcp:plugin-")) {
          if (!BrowserWindow.fromWebContents(event.sender) || event.senderFrame !== event.sender.mainFrame) throw new Error("Integration request is unavailable");
        }
        const conversations = this.runtime.listConversations();
        const input = parseMcpRequest(raw, [this.cwd(), ...conversations.map(item => item.cwd)], channel.slice(4) as McpOperation);
        if (input.conversationId) {
          const conversation = conversations.find(item => item.id === input.conversationId);
          if (!conversation || resolve(conversation.cwd) !== input.cwd) throw new Error("MCP conversation does not belong to this workspace");
        }
        try { return await action(input); }
        catch { throw new Error("MCP operation failed. Refresh the settings and retry."); }
      });
    };
    handle("mcp:catalog", input => this.runtime.getMcpCatalog(input as McpCatalogInput));
    handle("mcp:plugins", input => this.runtime.getPlugins(input as McpCatalogInput));
    handle("mcp:plugin-connect", input => this.runtime.connectPlugin(input as unknown as PluginTarget));
    handle("mcp:plugin-disconnect", input => this.runtime.disconnectPlugin(input as unknown as PluginTarget));
    handle("mcp:save", input => this.runtime.saveMcpServer(input as unknown as McpServerInput));
    handle("mcp:remove", input => this.runtime.removeMcpServer(input as unknown as McpServerTarget));
    handle("mcp:enabled", input => this.runtime.setMcpEnabled(input as unknown as McpEnabledInput));
    handle("mcp:reconnect", input => this.runtime.reconnectMcpServer(input as unknown as McpServerTarget));
    handle("mcp:login", input => this.runtime.loginMcpServer(input as unknown as McpServerTarget));
    handle("mcp:cancel-login", input => this.runtime.cancelMcpLogin(input as unknown as McpServerTarget));
    handle("mcp:logout", input => this.runtime.logoutMcpServer(input as unknown as McpServerTarget));
    handle("mcp:trust", input => this.runtime.setMcpProjectTrust(input as unknown as McpProjectTrustInput));
    handle("mcp:readonly", input => this.runtime.setMcpToolReadOnly(input as unknown as McpToolReadOnlyInput));
    this.unsubscribe = this.runtime.subscribeMcp(event => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send("mcp:status", event);
      }
    });
    this.unsubscribePlugins = this.runtime.subscribePlugins(event => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send("plugins:status", event);
      }
    });
  }

  dispose(): void {
    this.unsubscribePlugins?.(); this.unsubscribePlugins = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const channel of this.channels.splice(0)) ipcMain.removeHandler(channel);
  }
}
