import type { SandboxExecutionContext } from "@vela/shared";
import {
  createMcpExtension, createToolSearchExtension,
  type AgentSession, type ExtensionFactory, type McpController,
  type McpServerEntry, type McpToolSnapshot as PiToolSnapshot, type McpExtensionOptions,
} from "@earendil-works/pi-coding-agent";
type PiTool = Parameters<NonNullable<McpExtensionOptions["allowTool"]>>[1];
import type { McpCatalog, McpToolDefinition, SandboxMcpContext } from "@vela/shared";
import { McpConfigService, hashMcpTool } from "./mcp-config";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mcpConfiguredSecrets, redactMcpDisplay } from "./mcp-redaction";
import type { OAuthMCPManager } from "./mcp/oauth";

const resourceTools = new Set(["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]);
export function isMcpTool(name: string): boolean { return name.startsWith("mcp__") || resourceTools.has(name) || name === "tool_search"; }
export interface McpPermission {
  request(input: SandboxExecutionContext & { kind: "mcp"; cwd: string; workspace: string; mcp: SandboxMcpContext; signal?: AbortSignal }): Promise<boolean>;
}
interface Options {
  agentDir: string;
  cwd: string;
  conversationId: string | null;
  config: McpConfigService;
  readOnly: () => boolean;
  nativeTools: () => string[];
  permission?: McpPermission;
  openUrl?: (url: string) => void;
  oauth?: OAuthMCPManager;
  onChange: () => void;
}

/** One bridge per Pi session. Raw configs and definitions never leave the main process. */
export class McpSessionBridge {
  controller: McpController | null = null;
  session: AgentSession | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly approvals = new Map<string, AbortController>();
  private readonly rawTools = new Map<string, { entry: McpServerEntry; tool: PiTool }>();
  private closing = false;
  private refreshing = false;
  private readonly knownSecrets = new Set<string>();
  private readonly loadedEntries = new Map<string, McpServerEntry>();
  private readonly identities = new Map<string, { server: string; tool: string }>();
  constructor(readonly options: Options) {}

  factories(): ExtensionFactory[] {
    return [createMcpExtension({
      agentDir: this.options.agentDir,
      credentials: this.options.oauth?.credentials,
      loadConfig: () => {
        const config = this.options.config.loadConfigSync(this.options.cwd);
        this.loadedEntries.clear();
        for (const entry of config.servers) this.loadedEntries.set(entry.name, entry);
        this.secrets();
        return config;
      },
      allowServer: entry => this.entryAllowed(entry),
      allowTool: (entry, tool) => {
        this.rawTools.set(`${entry.name}\0${tool.name}`, { entry, tool });
        return this.entryAllowed(entry) && (!this.options.readOnly() || this.options.config.isReadOnlySync(this.options.cwd, entry.name, rawDefinition(tool)));
      },
      openUrl: this.options.openUrl,
      onController: controller => {
        this.unsubscribe?.();
        this.controller = controller;
        this.unsubscribe = controller.subscribe(snapshot => {
          for (const server of snapshot) for (const tool of server.tools) {
            this.identities.set(tool.registeredName, { server: server.name, tool: tool.name });
          }
          this.options.onChange();
        });
      },
    }), createToolSearchExtension(), this.guard()];
  }

  attach(session: AgentSession): void {
    this.session = session;
    // Pi's discovery extension uses this public host callback. Keep the original
    // Vela loadout boundary while permitting tools discovered by this controller.
    const allTools = session.getAllTools.bind(session);
    session.getAllTools = () => {
      const native = new Set(this.options.nativeTools());
      const mcp = new Set(this.controller?.getSnapshot().flatMap(server => server.tools.map(tool => tool.registeredName)) ?? []);
      return allTools().filter(tool => native.has(tool.name) || resourceTools.has(tool.name) || tool.name === "tool_search" || mcp.has(tool.name));
    };
  }

  private entryAllowed(entry: McpServerEntry): boolean {
    if (this.closing) return false;
    const current = this.options.config.loadConfigSync(this.options.cwd).servers.find(item => item.name === entry.name);
    return Boolean(current && current.config.enabled !== false && current.source === entry.source && JSON.stringify(current.config) === JSON.stringify(entry.config));
  }

  private guard(): ExtensionFactory {
    return pi => {
      pi.on("tool_call", async (event, ctx) => {
        if (!isMcpTool(event.toolName)) {
          if (!this.options.nativeTools().includes(event.toolName)) return { block: true, reason: "This tool is not part of the Vela session loadout." };
          return;
        }
        if (this.closing) return { block: true, reason: "MCP session has closed." };
        if (event.toolName === "tool_search" || resourceTools.has(event.toolName)) {
          if (resourceTools.has(event.toolName)) {
            const server = (event.input as { server?: unknown }).server;
            if (typeof server === "string" && !this.controller?.getSnapshot().some(item => item.name === server && !item.suspended && item.state === "connected")) {
              return { block: true, reason: "MCP server is unavailable." };
            }
          }
          return;
        }
        const info = this.findTool(event.toolName);
        if (!info || !this.entryAllowed(info.entry)) return { block: true, reason: "MCP configuration changed or access was revoked." };
        const readOnly = this.options.config.isReadOnlySync(this.options.cwd, info.entry.name, rawDefinition(info.tool));
        if (this.options.readOnly() && !readOnly) return { block: true, reason: "Plan/explore requires an explicitly confirmed read-only MCP tool." };
        if (readOnly) return;
        const approval = new AbortController();
        this.approvals.set(event.toolCallId, approval);
        const signal = ctx.signal ? AbortSignal.any([ctx.signal, approval.signal]) : approval.signal;
        try {
          const secrets = this.secrets();
          const allowed = await this.options.permission?.request({ kind: "mcp", cwd: this.options.cwd, workspace: this.options.cwd,
            mcp: { server: info.entry.name, tool: info.tool.name, description: String(redactMcpDisplay(info.tool.description ?? "", secrets)), parameters: redactMcpDisplay(event.input, secrets) }, signal });
          if (!allowed || signal.aborted || !this.entryAllowed(info.entry)) return { block: true, reason: "MCP execution permission denied or revoked." };
        } finally { this.approvals.delete(event.toolCallId); }
      });
    };
  }

  private findTool(registeredName: string): { entry: McpServerEntry; tool: PiTool } | undefined {
    const server = this.controller?.getSnapshot().find(item => item.tools.some(tool => tool.registeredName === registeredName));
    const tool = server?.tools.find(item => item.registeredName === registeredName);
    return server && tool ? this.rawTools.get(`${server.name}\0${tool.name}`) : undefined;
  }

  rawTool(server: string, tool: string): McpToolDefinition | undefined {
    const info = this.rawTools.get(`${server}\0${tool}`);
    return info && this.entryAllowed(info.entry) ? rawDefinition(info.tool) : undefined;
  }

  isMutation(name: string): boolean {
    if (!name.startsWith("mcp__")) return false;
    const info = this.findTool(name);
    return !info || !this.options.config.isReadOnlySync(this.options.cwd, info.entry.name, rawDefinition(info.tool));
  }

  decorateActivity(name: string, activity: import("@vela/shared").ToolActivity): import("@vela/shared").ToolActivity {
    if (!isMcpTool(name)) return activity;
    const identity = this.identities.get(name);
    return { ...this.redact(activity),
      ...(identity ? { mcp: identity } : {}),
      ...(name.startsWith("mcp__") ? { mutated: this.isMutation(name) } : {}) };
  }

  private secrets(): string[] {
    try {
      const secure = this.options.oauth?.credentials.secrets();
      if (secure) for (const secret of mcpConfiguredSecrets([JSON.parse(secure)])) this.knownSecrets.add(secret);
    } catch { /* A locked OS store must not put storage errors in renderer diagnostics. */ }
    for (const secret of this.options.config.configuredSecrets(this.options.cwd)) this.knownSecrets.add(secret);
    for (const secret of mcpConfiguredSecrets(this.options.config.loadConfigSync(this.options.cwd).servers.map(item => item.config))) this.knownSecrets.add(secret);
    try {
      for (const secret of mcpConfiguredSecrets([JSON.parse(readFileSync(join(this.options.agentDir, "mcp-auth.json"), "utf8"))])) this.knownSecrets.add(secret);
    } catch { /* Credentials may not exist yet. */ }
    return [...this.knownSecrets];
  }

  redact<T>(value: T): T {
    const decorate = (item: unknown): unknown => {
      if (Array.isArray(item)) return item.map(decorate);
      if (!item || typeof item !== "object") return item;
      const record = item as Record<string, unknown>;
      const identity = typeof record.toolName === "string" ? this.identities.get(record.toolName) : undefined;
      return { ...Object.fromEntries(Object.entries(record).map(([key, child]) => [key, decorate(child)])), ...(identity ? { mcp: identity } : {}) };
    };
    return decorate(redactMcpDisplay(value, this.secrets())) as T;
  }

  catalog(): McpCatalog {
    const catalog = this.options.config.listSync(this.options.cwd);
    const connections = this.controller?.getSnapshot() ?? [];
    const secrets = this.secrets();
    catalog.conversationId = this.options.conversationId;
    catalog.cwd = this.options.cwd;
    for (const server of catalog.servers) {
      if (!server.effective) continue;
      const live = connections.find(item => item.name === server.name);
      const entry = this.loadedEntries.get(server.name);
      if (!live || !entry || !this.entryAllowed(entry)) continue;
      server.connectionStatus = live.suspended ? "disconnected" : live.state === "connected" ? "connected" : live.state === "connecting" ? "connecting" : live.state === "failed" ? "error" : "disconnected";
      server.authStatus = live.loginPending ? "authenticating" : live.state === "needs-auth" ? "required" : live.oauth && live.state === "failed" ? "error" : live.authenticated ? "authenticated" : "none";
      if (live.error) server.error = String(redactMcpDisplay(live.error, secrets));
      server.tools = live.tools.map(tool => this.toolInfo(server.name, server.configDigest!, tool));
      Object.assign(server, { resourceCount: live.resources, resourceTemplateCount: live.resourceTemplates });
    }
    return catalog;
  }

  private toolInfo(server: string, configDigest: string, tool: PiToolSnapshot) {
    const raw = this.rawTool(server, tool.name) ?? rawDefinition(tool);
    return { ...redactMcpDisplay(tool, this.secrets()) as typeof tool,
      server, configDigest, exposure: tool.exposure === "codemode" ? "deferred" as const : tool.exposure, toolDigest: hashMcpTool(raw),
      readOnly: this.options.config.isReadOnlySync(this.options.cwd, server, raw) };
  }

  refresh(): void {
    if (this.refreshing || this.closing) return;
    this.refreshing = true;
    try { this.controller?.refreshTools(); } finally { this.refreshing = false; }
  }

  async revokeChanged(cancelAll = false): Promise<void> {
    for (const approval of this.approvals.values()) approval.abort();
    this.refresh();
    const loaded = this.options.config.loadConfigSync(this.options.cwd).servers;
    const revocations = this.controller?.getSnapshot().filter(server => {
      const previous = this.loadedEntries.get(server.name);
      return cancelAll || !loaded.some(item => item.name === server.name && item.config.enabled !== false) || (previous && !this.entryAllowed(previous));
    }) ?? [];
    await Promise.all(revocations.map(server => this.controller?.suspend(server.name)));
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const approval of this.approvals.values()) approval.abort();
    this.unsubscribe?.(); this.unsubscribe = null;
    await this.controller?.close();
  }
}

function rawDefinition(tool: { name: string; description?: string; inputSchema: unknown; annotations?: unknown }): McpToolDefinition {
  return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations as Record<string, unknown> | undefined };
}
