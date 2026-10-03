/** Standalone MCP contracts. This module deliberately has no Pi or Node dependencies. */
export type McpScope = "global" | "project";
export type McpExposure = "deferred" | "direct" | "hidden";
export type McpConfigValue = null | boolean | number | string | McpConfigValue[] | { [key: string]: McpConfigValue };

export interface McpOAuthConfig {
  clientId?: string;
  clientSecret?: string;
  callbackPort?: number;
  callbackUrl?: string;
  scope?: string;
  clientName?: string;
  authServerMetadataUrl?: string;
}

export interface McpServerConfigBase {
  exposure?: McpExposure | "codemode" | "codemode-deferred";
  toolExposure?: Record<string, McpExposure | "codemode" | "codemode-deferred">;
  enabled?: boolean;
  description?: string;
  timeout?: number;
  /** Preserve vendor-specific JSON fields when editing an existing configuration. */
  [key: string]: unknown;
}

export interface McpStdioServerConfig extends McpServerConfigBase {
  type?: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpHttpServerConfig extends McpServerConfigBase {
  type?: "http" | "streamable-http";
  url: string;
  headers?: Record<string, string>;
  oauth?: McpOAuthConfig;
  auth?: { provider: string };
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;
export type McpServerStatus = "configured" | "disabled" | "untrusted" | "shadowed" | "invalid" | "disconnected" | "connecting" | "connected" | "error";
export type McpConnectionStatus = "disconnected" | "connecting" | "connected" | "error";
export type McpAuthStatus = "none" | "required" | "authenticating" | "authenticated" | "error";

/** Credential fields are masked; never pass runtime configs through a renderer bridge. */
export interface McpServerSnapshot {
  pluginId?: string;
  name: string;
  scope: McpScope;
  enabled: boolean;
  effective: boolean;
  trusted: boolean;
  status: McpServerStatus;
  config: Record<string, unknown>;
  configDigest: string | null;
  secretFields: string[];
  connectionStatus: McpConnectionStatus;
  authStatus: McpAuthStatus;
  tools: McpToolSnapshot[];
  resourceCount?: number;
  resourceTemplateCount?: number;
  error?: string;
}

export interface McpProjectTrustReview {
  name: string;
  config: Record<string, unknown>;
  secretFields: string[];
}

export interface McpCatalog {
  cwd: string;
  conversationId: string | null;
  servers: McpServerSnapshot[];
  errors: string[];
  projectTrust: {
    path: string;
    digest: string;
    trusted: boolean;
    servers: { name: string; command?: string; url?: string }[];
    review: McpProjectTrustReview[];
  };
  pendingApply: boolean;
}

export interface McpCatalogInput {
  cwd: string;
  conversationId?: string | null;
}

export interface McpConfigTargetInput extends McpCatalogInput {
  scope: McpScope;
  name: string;
}

export interface McpSaveInput extends McpConfigTargetInput {
  /** A complete entry. Masked values from list() preserve the current value at that path. */
  config: McpServerConfig | Record<string, unknown>;
}

export interface McpSetEnabledInput extends McpConfigTargetInput {
  enabled: boolean;
}

export interface McpSetTrustInput extends McpCatalogInput {
  trusted: boolean;
  /** Required when granting trust: the exact project content the user reviewed. */
  digest?: string;
}

/** Raw, unredacted metadata from the connected server, supplied only by the main process. */
export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema: unknown;
  annotations?: Record<string, unknown>;
}

/**
 * A confirmed read-only grant as persisted in the MCP policy file. The digests bind it to the
 * effective server configuration and raw tool definition; either change expires the grant.
 */
export interface McpReadOnlyGrant {
  cwd: string;
  serverName: string;
  toolName: string;
  configDigest: string;
  toolDigest: string;
}

export interface McpToolSnapshot {
  server: string;
  name: string;
  configDigest: string;
  toolDigest: string;
  readOnly: boolean;
  description?: string;
  parameters?: unknown;
  registeredName?: string;
  inputSchema?: unknown;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  exposure?: McpExposure;
}

export interface McpSetReadOnlyInput extends McpCatalogInput {
  server: string;
  tool: string;
  configDigest: string;
  toolDigest: string;
  readOnly: boolean;
}

export interface McpAuthInput extends McpCatalogInput {
  server: string;
  configDigest: string;
}

export interface McpAuthState {
  serverName: string;
  status: McpAuthStatus;
  /** Safe, fixed diagnostic text; never raw OAuth/HTTP errors. */
  error?: string;
}

export interface McpApprovalRequest {
  id: string;
  cwd: string;
  serverName: string;
  toolName: string;
  configDigest: string;
  toolDigest: string;
}

export interface McpApprovalReply extends McpApprovalRequest {
  allowed: boolean;
}

export interface McpConfigChanges {
  changed: boolean;
  configChanged: boolean;
  policyChanged: boolean;
  catalog: McpCatalog;
}

export interface McpStatusEvent {
  cwd: string;
  conversationId: string | null;
  catalog: McpCatalog;
}

// Input aliases shared by main, runtime, and renderer.
export type McpServerInput = McpSaveInput;
export type McpServerTarget = McpConfigTargetInput;
export type McpEnabledInput = McpSetEnabledInput;
export type McpProjectTrustInput = McpSetTrustInput;
export type McpToolReadOnlyInput = McpSetReadOnlyInput;
export type McpToolInfo = McpToolSnapshot;

/** IPC-facing methods. Runtime owns connections, authentication, and status events. */
export interface McpApi {
  getMcpCatalog(input: McpCatalogInput): Promise<McpCatalog>;
  saveMcpServer(input: McpServerInput): Promise<McpCatalog>;
  removeMcpServer(input: McpServerTarget): Promise<McpCatalog>;
  setMcpEnabled(input: McpEnabledInput): Promise<McpCatalog>;
  reconnectMcpServer(input: McpServerTarget): Promise<McpCatalog>;
  loginMcpServer(input: McpServerTarget): Promise<McpCatalog>;
  cancelMcpLogin(input: McpServerTarget): Promise<McpCatalog>;
  logoutMcpServer(input: McpServerTarget): Promise<McpCatalog>;
  setMcpProjectTrust(input: McpProjectTrustInput): Promise<McpCatalog>;
  setMcpToolReadOnly(input: McpToolReadOnlyInput): Promise<McpCatalog>;
  onMcpStatus(listener: (event: McpStatusEvent) => void): () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isMcpApprovalHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

export function isMcpApprovalRequest(value: unknown): value is McpApprovalRequest {
  return isRecord(value)
    && ["id", "cwd", "serverName", "toolName"].every(key => typeof value[key] === "string" && value[key].length > 0)
    && isMcpApprovalHash(value.configDigest) && isMcpApprovalHash(value.toolDigest);
}

export function isMcpApprovalReply(value: unknown): value is McpApprovalReply {
  return isMcpApprovalRequest(value) && typeof (value as unknown as Record<string, unknown>).allowed === "boolean";
}

/** Validate the wire payload and bind it to the currently pending approval. */
export function matchesMcpApproval(value: unknown, pending: McpApprovalRequest): value is McpApprovalReply {
  return isMcpApprovalReply(value) && isMcpApprovalRequest(pending)
    && value.id === pending.id && value.cwd === pending.cwd
    && value.serverName === pending.serverName && value.toolName === pending.toolName
    && value.configDigest === pending.configDigest && value.toolDigest === pending.toolDigest;
}
