import type { McpCatalogInput, McpConnectionStatus, McpOAuthConfig } from "./mcp";

/** Public configuration only. OAuth client secrets belong in the main-process store. */
export interface BuiltInPlugin {
  id: string;
  name: string;
  description: string;
  icon: string;
  mcpUrl: string;
  transport: "streamable-http";
  authType: "oauth2" | "none";
  oauth?: Omit<McpOAuthConfig, "clientSecret">;
  /** Extension point; server hints are never an implicit read-only grant. */
  toolPolicy?: { approval: "existing-mcp-policy"; access: "read-write" | "read-only" };
}

export interface PluginSnapshot extends BuiltInPlugin {
  serverName: string;
  status: McpConnectionStatus;
  toolCount: number;
  error?: string;
}
export interface PluginCatalog {
  cwd: string;
  plugins: PluginSnapshot[];
  pendingApply: boolean;
}
export interface PluginTarget extends McpCatalogInput { id: string }
export interface PluginStatusEvent { id: string; status: McpConnectionStatus; error?: string }
export interface PluginApi {
  getPlugins(input: McpCatalogInput): Promise<PluginCatalog>;
  connectPlugin(input: PluginTarget): Promise<PluginCatalog>;
  disconnectPlugin(input: PluginTarget): Promise<PluginCatalog>;
  onPluginStatus(listener: (event: PluginStatusEvent) => void): () => void;
}
