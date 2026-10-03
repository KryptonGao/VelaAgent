import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync,
  renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import * as pi from "@earendil-works/pi-coding-agent";
import type { PluginRegistry } from "./mcp/plugin-registry";
import type { LoadedMcpConfig, McpServerConfig as PiMcpServerConfig } from "@earendil-works/pi-coding-agent";
import { isMcpApprovalHash } from "../../shared/src/mcp";
import type {
  McpConfigChanges, McpCatalog, McpConfigTargetInput, McpReadOnlyGrant, McpSaveInput, McpServerSnapshot,
  McpSetEnabledInput, McpSetReadOnlyInput, McpSetTrustInput, McpToolDefinition,
} from "../../shared/src/mcp";

/** An exact sentinel, rather than a real credential or a partly visible credential. */
export const MCP_REDACTED = "••••••••";

/** The signatures of the patched Pi root exports; tests may inject the same Pi implementations. */
export interface McpConfigHelpers {
  validateMcpServerConfig(name: string, raw: unknown): PiMcpServerConfig | string;
  loadMcpConfig(options: { agentDir: string; cwd: string; projectTrusted: boolean }): LoadedMcpConfig;
}

export interface McpConfigServiceOptions {
  agentDir: string;
  plugins?: PluginRegistry;
  helpers?: McpConfigHelpers;
}

interface Document {
  path: string;
  text: string | null;
  value: Record<string, unknown>;
  error?: string;
}

interface State {
  cwd: string;
  global: Document;
  project: Document;
  policy: Document;
  projectHash: string;
  trusted: boolean;
  loaded: LoadedMcpConfig;
  snapshot: McpCatalog;
}

type ReadOnlyGrant = McpReadOnlyGrant;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** toolExposure wildcard precedence depends on insertion order; include that order in the hash. */
function canonical(value: unknown, ordered = false): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(item => canonical(item)).join(",")}]`;
  if (record(value)) {
    const keys = ordered ? Object.keys(value) : Object.keys(value).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonical(value[key], key === "toolExposure")}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Hash the raw description and schema, never a redacted/display-transformed tool. */
export function hashMcpTool(tool: McpToolDefinition): string {
  return hash(canonical({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations }));
}

function canonicalCwd(cwd: string): string {
  try {
    return realpathSync(resolve(cwd));
  } catch {
    throw new Error("MCP workspace is unavailable.");
  }
}

function readDocument(path: string, kind: "config" | "policy"): Document {
  let text: string | null = null;
  try {
    text = readFileSync(path, "utf8");
    const value: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
    if (!record(value) || (kind === "config" && value.mcpServers !== undefined && !record(value.mcpServers))) {
      return { path, text, value: {}, error: "Invalid MCP configuration document." };
    }
    if (kind === "policy" && ((value.trustedProjects !== undefined && !record(value.trustedProjects))
      || (value.readOnly !== undefined && !Array.isArray(value.readOnly)))) {
      return { path, text, value: {}, error: "Invalid MCP policy document." };
    }
    return { path, text, value };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, text: null, value: {} };
    // JSON parsers and filesystem/SDK errors can quote credential-bearing source text.
    return { path, text, value: {}, error: kind === "config" ? "Cannot read MCP configuration." : "Cannot read MCP policy." };
  }
}

function servers(document: Document): Record<string, unknown> {
  return record(document.value.mcpServers) ? document.value.mcpServers : {};
}

function normalize(config: PiMcpServerConfig): PiMcpServerConfig {
  const exposure = (value: string | undefined) => value === undefined || value === "codemode" || value === "codemode-deferred" ? "deferred" : value;
  return {
    ...structuredClone(config),
    exposure: exposure(config.exposure) as PiMcpServerConfig["exposure"],
    ...(config.toolExposure ? {
      toolExposure: Object.fromEntries(Object.entries(config.toolExposure).map(([name, value]) => [name, exposure(value)])),
    } : {}),
  } as PiMcpServerConfig;
}

const SECRET_KEY = /(?:token|password|passwd|secret|api[-_]?key|authorization|credential|signature|auth|session|cookie|^key$)/i;
const SECRET_FLAG = /^--?(?:[\w-]*(?:token|password|passwd|secret|api[-_]?key|authorization|credential|cookie)[\w-]*|auth|p)(?:=|$)/i;

function secretField(key: string): boolean {
  // These Pi fields contain public provider/client metadata as well as individual secret fields.
  return !["auth", "oauth", "authServerMetadataUrl"].includes(key) && SECRET_KEY.test(key);
}

function urlSecrets(text: string): string[] {
  const result: string[] = [];
  try {
    const url = new URL(text);
    for (const value of [url.username, url.password, url.hash.slice(1)]) {
      if (value) {
        result.push(value);
        try { result.push(decodeURIComponent(value)); } catch { /* Keep encoded value. */ }
      }
    }
    for (const [key, value] of url.searchParams) {
      if (SECRET_KEY.test(key) && value) result.push(value, encodeURIComponent(value), new URLSearchParams({ v: value }).toString().slice(2));
    }
  } catch { /* It may be an executable or a description rather than a URL. */ }
  return result;
}

/** MAIN ONLY: literals to scrub from connection diagnostics, tools and repeated config text. */
export function configuredSecrets(config: unknown): string[] {
  const secrets = new Set<string>();
  const add = (value: unknown) => { if (typeof value === "string" && value && value !== MCP_REDACTED) secrets.add(value); };
  function visit(value: unknown, path: string[] = []): void {
    if (typeof value === "string") {
      if (path[0] === "toolExposure") return;
      if (path.some(part => part === "env" || part === "headers" || secretField(part)) || path.at(-1) === "auth") add(value);
      if (path.includes("headers")) {
        const credential = /^(?:Bearer|Basic|Token)\s+(.+)$/i.exec(value);
        if (credential) add(credential[1]);
      }
      if (path[0] === "args" || path[0] === "command") {
        const header = /^(?:Authorization|Cookie|X-Api-Key):\s*(.+)$/i.exec(value);
        if (header) {
          add(header[1]);
          const credential = /^(?:Bearer|Basic|Token)\s+(.+)$/i.exec(header[1]);
          if (credential) add(credential[1]);
        }
      }
      for (const secret of urlSecrets(value)) add(secret);
      for (const match of value.matchAll(/(?:--(?:[\w-]*(?:token|password|secret|api-key|authorization|credential)[\w-]*))[=\s]+(?:"([^"]*)"|'([^']*)'|([^\s]+))/gi)) add(match[1] ?? match[2] ?? match[3]);
      for (const match of value.matchAll(/\b[\w]*(?:TOKEN|PASSWORD|SECRET|API_KEY)[\w]*=(?:"([^"]*)"|'([^']*)'|([^\s]+))/g)) add(match[1] ?? match[2] ?? match[3]);
      return;
    }
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) {
        const entry = value[index];
        if (path[0] === "args" && typeof entry === "string" && SECRET_FLAG.test(entry)) {
          const equals = entry.indexOf("=");
          add(equals >= 0 ? entry.slice(equals + 1) : value[index + 1]);
        }
        visit(entry, [...path, String(index)]);
      }
    } else if (record(value)) {
      for (const [key, item] of Object.entries(value)) visit(item, [...path, key]);
    }
  }
  visit(config);
  return [...secrets].sort((left, right) => right.length - left.length);
}

export function redactMcpText(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const secret of [...secrets].filter(value => value && value !== MCP_REDACTED).sort((a, b) => b.length - a.length)) {
    result = result.split(secret).join(MCP_REDACTED);
  }
  return result;
}

function redactConfig(value: unknown, secrets: readonly string[], fields: string[], path: string[] = []): unknown {
  if (path[0] === "toolExposure" && path.length === 2 && ["deferred", "direct", "hidden"].includes(String(value))) return value;
  const sensitive = path.some((part, index) => (part === "env" || part === "headers") && index < path.length - 1)
    || path.some(part => secretField(part)) || path.at(-1) === "auth" && typeof value === "string";
  if (sensitive) {
    fields.push(`/${path.map(part => redactMcpText(part, secrets).replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`);
    return MCP_REDACTED;
  }
  if (typeof value === "string") {
    const masked = redactMcpText(value, secrets);
    if (masked !== value) fields.push(`/${path.map(part => redactMcpText(part, secrets).replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`);
    return masked;
  }
  if (Array.isArray(value)) return value.map((item, index) => redactConfig(item, secrets, fields, [...path, String(index)]));
  if (record(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [redactMcpText(key, secrets), redactConfig(item, secrets, fields, [...path, key])]));
  return value;
}

function restoreMasks(value: unknown, previous: unknown, secrets: readonly string[], path: string[] = []): unknown {
  if (value === MCP_REDACTED) {
    if (previous === undefined) throw new Error("Masked MCP values require an existing value.");
    return structuredClone(previous);
  }
  if (typeof value === "string" && value.includes(MCP_REDACTED)) {
    if (typeof previous !== "string") throw new Error("Masked MCP values require an existing value.");
    const display = redactConfig(previous, secrets, [], path) as string;
    if (display === value) return previous;
    // Bind each placeholder to the exact hidden substring at the same existing field. This permits
    // editing an endpoint/argv prefix while preserving its masked credentials.
    const pieces = display.split(MCP_REDACTED);
    if (pieces.length === 1 || value.split(MCP_REDACTED).length !== pieces.length) throw new Error("Stale masked field.");
    const pattern = pieces.map(piece => piece.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("([\\s\\S]*?)");
    const match = new RegExp(`^${pattern}$`).exec(previous);
    if (!match) throw new Error("Stale masked field.");
    let index = 1;
    return value.replaceAll(MCP_REDACTED, () => match[index++]!);
  }
  if (Array.isArray(value)) return value.map((item, index) => restoreMasks(item, Array.isArray(previous) ? previous[index] : undefined, secrets, [...path, String(index)]));
  if (record(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    let restoredKey = key;
    if (key.includes(MCP_REDACTED)) {
      const candidates = record(previous) ? Object.keys(previous).filter(oldKey => redactMcpText(oldKey, secrets) === key) : [];
      if (candidates.length !== 1) throw new Error("Stale masked key.");
      restoredKey = candidates[0]!;
    }
    return [restoredKey, restoreMasks(item, record(previous) ? previous[restoredKey] : undefined, secrets, [...path, restoredKey])];
  }));
  return value;
}

function assertTarget(input: McpConfigTargetInput): void {
  if ((input.scope !== "global" && input.scope !== "project") || !/^[A-Za-z0-9_-]+$/.test(input.name)) {
    throw new Error("Invalid MCP configuration target.");
  }
}

/** Atomic replacement, fresh content check, private permissions, and no leftover secret temp file. */
function writeDocument(document: Document): void {
  if (document.error) throw new Error(document.error);
  let temporary: string | undefined;
  let descriptor: number | undefined;
  try {
    mkdirSync(dirname(document.path), { recursive: true });
    temporary = join(dirname(document.path), `.mcp-${randomUUID()}.tmp`);
    descriptor = openSync(temporary, "wx", 0o600);
    const indent = document.text && /^([\t ]+)\S/m.exec(document.text)?.[1] || "  ";
    writeFileSync(descriptor, `${JSON.stringify(document.value, null, indent)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    const current = existsSync(document.path) ? readFileSync(document.path, "utf8") : null;
    if (current !== document.text) throw new Error("MCP configuration changed during editing; refresh and retry.");
    renameSync(temporary, document.path);
    temporary = undefined;
  } catch {
    throw new Error("Cannot save MCP document; refresh and retry.");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (temporary !== undefined) {
      try { unlinkSync(temporary); } catch { /* A failed cleanup must not expose a filesystem error. */ }
    }
  }
}

function isGrant(value: unknown): value is ReadOnlyGrant {
  return record(value) && typeof value.cwd === "string" && typeof value.serverName === "string"
    && typeof value.toolName === "string" && isMcpApprovalHash(value.configDigest) && isMcpApprovalHash(value.toolDigest);
}

/**
 * Main-process service. All mutations read the current document before an atomic replacement.
 * UI/IPC consumers may use snapshots; loadConfig() intentionally returns usable configured secrets
 * and must remain in main. The service never starts a server or resolves ${ENV}/!command values.
 */
export class McpConfigService {
  private readonly plugins?: PluginRegistry;
  private readonly agentDir: string;
  private readonly helpers: McpConfigHelpers;
  private readonly fingerprints = new Map<string, { config: string; policy: string }>();

  constructor(options: McpConfigServiceOptions) {
    this.plugins = options.plugins;
    this.agentDir = resolve(options.agentDir);
    const exported = pi as unknown as Partial<McpConfigHelpers>;
    const helpers = options.helpers ?? exported;
    this.helpers = helpers as McpConfigHelpers;
  }

  async init(cwd: string): Promise<McpCatalog> {
    const state = this.read(cwd);
    this.fingerprints.set(state.cwd, this.fingerprint(state));
    return state.snapshot;
  }

  listSync(cwd: string, conversationId: string | null = null): McpCatalog {
    return { ...this.read(cwd).snapshot, conversationId };
  }

  async list(cwd: string, conversationId: string | null = null): Promise<McpCatalog> {
    return this.listSync(cwd, conversationId);
  }

  /** MAIN ONLY: credentials remain unredacted for Pi. Untrusted project entries are excluded. */
  loadConfigSync(cwd: string): LoadedMcpConfig {
    return this.read(cwd).loaded;
  }

  async loadConfig(cwd: string): Promise<LoadedMcpConfig> {
    return this.loadConfigSync(cwd);
  }

  async save(input: McpSaveInput): Promise<McpCatalog> {
    assertTarget(input);
    if (this.plugins && input.name.replace(/-/g, "_").startsWith("builtin_")) throw new Error("Manage built-in plugins from Integrations.");
    const state = this.read(input.cwd);
    const document = input.scope === "global" ? state.global : state.project;
    if (document.error) throw new Error(document.error);
    if (!record(input.config)) throw new Error("Invalid MCP server configuration.");
    let restored: unknown;
    try {
      restored = restoreMasks(input.config, servers(document)[input.name], this.secrets(state));
      // Reject cycles, undefined, BigInt, functions and non-JSON data at the service boundary.
      if (canonical(restored) !== canonical(JSON.parse(JSON.stringify(restored)))) throw new Error();
    } catch {
      throw new Error("Invalid or stale masked MCP configuration.");
    }
    const config = this.validate(input.name, restored, input.scope);
    if (!config) throw new Error("Invalid MCP server configuration (Pi validation failed).");
    for (const other of Object.keys(servers(document))) {
      if (other !== input.name && other.replace(/-/g, "_") === input.name.replace(/-/g, "_")) {
        throw new Error("MCP server namespace conflicts with an existing server.");
      }
    }
    // The loader also rejects namespace clashes across the two scopes.
    const otherDocument = input.scope === "global" ? state.project : state.global;
    for (const other of Object.keys(servers(otherDocument))) {
      if (other !== input.name && other.replace(/-/g, "_") === input.name.replace(/-/g, "_")) {
        throw new Error("MCP server namespace conflicts with an existing server.");
      }
    }
    document.value.mcpServers = { ...servers(document), [input.name]: config };
    writeDocument(document);
    return this.commit(state, "conversationId" in input ? input.conversationId ?? null : null);
  }

  async remove(input: McpConfigTargetInput): Promise<McpCatalog> {
    assertTarget(input);
    if (this.plugins?.ownsServer(input.name)) throw new Error("Manage built-in plugins from Integrations.");
    const state = this.read(input.cwd);
    const document = input.scope === "global" ? state.global : state.project;
    if (document.error) throw new Error(document.error);
    const entries = { ...servers(document) };
    if (Object.hasOwn(entries, input.name)) {
      delete entries[input.name];
      document.value.mcpServers = entries;
      writeDocument(document);
    }
    return this.commit(state, "conversationId" in input ? input.conversationId ?? null : null);
  }

  async setEnabled(input: McpSetEnabledInput): Promise<McpCatalog> {
    assertTarget(input);
    if (typeof input.enabled !== "boolean") throw new Error("Invalid MCP enabled state.");
    const state = this.read(input.cwd);
    const document = input.scope === "global" ? state.global : state.project;
    if (document.error) throw new Error(document.error);
    const current = servers(document)[input.name];
    if (!record(current)) throw new Error("MCP server does not exist.");
    return this.save({ ...input, config: { ...current, enabled: input.enabled } });
  }

  async setTrust(input: McpSetTrustInput): Promise<McpCatalog> {
    if (typeof input.trusted !== "boolean") throw new Error("Invalid MCP trust decision.");
    const state = this.read(input.cwd);
    if (state.policy.error) throw new Error(state.policy.error);
    if (input.trusted && (state.project.error || !isMcpApprovalHash(input.digest) || input.digest !== state.projectHash)) {
      throw new Error("MCP project configuration changed; review it before granting trust.");
    }
    const trusted = { ...(record(state.policy.value.trustedProjects) ? state.policy.value.trustedProjects : {}) };
    if (input.trusted) trusted[state.cwd] = state.projectHash;
    else delete trusted[state.cwd];
    state.policy.value.trustedProjects = trusted;
    // Revoking trust also revokes project tool grants, so re-trusting cannot revive them.
    if (!input.trusted && Array.isArray(state.policy.value.readOnly)) {
      state.policy.value.readOnly = state.policy.value.readOnly.filter(item => !isGrant(item) || item.cwd !== state.cwd);
    }
    writeDocument(state.policy);
    return this.commit(state, "conversationId" in input ? input.conversationId ?? null : null);
  }

  /** rawTool comes from main's current connection, never from the renderer approval payload. */
  async setReadOnly(input: McpSetReadOnlyInput, rawTool: McpToolDefinition): Promise<McpCatalog> {
    const state = this.read(input.cwd);
    if (state.policy.error) throw new Error(state.policy.error);
    if (typeof input.readOnly !== "boolean" || !isMcpApprovalHash(input.configDigest) || !isMcpApprovalHash(input.toolDigest)) {
      throw new Error("Invalid MCP read-only approval.");
    }
    const server = state.snapshot.servers.find(item => item.effective && item.name === input.server);
    if (input.readOnly && (!server || !server.enabled || !server.trusted || server.configDigest !== input.configDigest
      || rawTool.name !== input.tool || hashMcpTool(rawTool) !== input.toolDigest)) {
      throw new Error("MCP server or tool changed; review it before granting read-only access.");
    }
    const grants = Array.isArray(state.policy.value.readOnly) ? state.policy.value.readOnly : [];
    const remaining = grants.filter(item => !isGrant(item) || item.cwd !== state.cwd
      || item.serverName !== input.server || item.toolName !== input.tool);
    if (input.readOnly) remaining.push({ cwd: state.cwd, serverName: input.server, toolName: input.tool, configDigest: input.configDigest, toolDigest: input.toolDigest });
    state.policy.value.readOnly = remaining;
    writeDocument(state.policy);
    return this.commit(state, "conversationId" in input ? input.conversationId ?? null : null);
  }

  /** Re-read policy/config on every authorization; polling is not a security boundary. */
  isReadOnlySync(cwd: string, serverName: string, rawTool: McpToolDefinition): boolean {
    const state = this.read(cwd);
    const server = state.snapshot.servers.find(item => item.effective && item.name === serverName);
    if (state.policy.error || !server || !server.enabled || !server.trusted || !Array.isArray(state.policy.value.readOnly)) return false;
    const toolDigest = hashMcpTool(rawTool);
    return state.policy.value.readOnly.some(item => isGrant(item) && item.cwd === state.cwd
      && item.serverName === serverName && item.toolName === rawTool.name
      && item.configDigest === server.configDigest && item.toolDigest === toolDigest);
  }

  async isReadOnly(cwd: string, serverName: string, rawTool: McpToolDefinition): Promise<boolean> {
    return this.isReadOnlySync(cwd, serverName, rawTool);
  }

  /** Call from the owning runtime's poll/idle loop; bytes, not mtime, determine changes. */
  checkChanges(cwd: string): McpConfigChanges {
    const state = this.read(cwd);
    const current = this.fingerprint(state);
    const previous = this.fingerprints.get(state.cwd);
    const configChanged = !previous || previous.config !== current.config;
    const policyChanged = !previous || previous.policy !== current.policy;
    this.fingerprints.set(state.cwd, current);
    return { changed: configChanged || policyChanged, configChanged, policyChanged, catalog: state.snapshot };
  }

  private validate(name: string, raw: unknown, scope: string): PiMcpServerConfig | undefined {
    try {
      const config = this.helpers.validateMcpServerConfig(name, raw);
      if (typeof config === "string" || (scope === "project" && "url" in config && config.auth)) return undefined;
      return normalize(config);
    } catch {
      return undefined;
    }
  }

  private read(cwd: string): State {
    const canonicalPath = canonicalCwd(cwd);
    const global = readDocument(join(this.agentDir, "mcp.json"), "config");
    const project = readDocument(join(canonicalPath, ".pi", "mcp.json"), "config");
    const policy = readDocument(join(this.agentDir, "mcp-policy.json"), "policy");
    const projectHash = hash(project.text === null ? "missing" : `content:${project.text}`);
    let trusted = !policy.error && !project.error && record(policy.value.trustedProjects)
      && policy.value.trustedProjects[canonicalPath] === projectHash;
    let loaded: LoadedMcpConfig;
    try {
      const result = this.helpers.loadMcpConfig({ agentDir: this.agentDir, cwd: canonicalPath, projectTrusted: trusted });
      loaded = {
        servers: result.servers.map(server => ({ ...server, config: normalize(server.config) })),
        autoEnableCodemode: false,
        errors: result.errors.length ? ["Pi rejected one or more MCP configuration entries."] : [],
      };
    } catch {
      loaded = { servers: [], autoEnableCodemode: false, errors: ["Cannot load MCP configuration."] };
    }
    // Pi reads the files again. Never authorize its result if the reviewed files/policy changed
    // between our initial read and Pi's read (including an edit by another process).
    if ([global, project, policy].some(document => {
      const latest = readDocument(document.path, document === policy ? "policy" : "config");
      return latest.text !== document.text || latest.error !== document.error;
    })) {
      trusted = false;
      loaded = { servers: [], autoEnableCodemode: false, errors: ["MCP configuration changed while loading; retry."] };
    }
    if (this.plugins) loaded.servers = this.plugins.merge(loaded.servers);
    const secretValues = [...new Set([...Object.values(servers(global)), ...Object.values(servers(project))].flatMap(configuredSecrets))];
    const summaries: McpServerSnapshot[] = [];
    for (const [scope, document] of [["global", global], ["project", project]] as const) {
      for (const [name, raw] of Object.entries(servers(document))) {
        const config = this.validate(name, raw, scope);
        const effectiveEntry = loaded.servers.find(item => item.name === name && item.scope === scope
          && !(this.plugins && name.replace(/-/g, "_").startsWith("builtin_")));
        const effective = effectiveEntry !== undefined;
        const enabled = config?.enabled !== false;
        const entryTrusted = scope === "global" || trusted;
        const configDigest = config ? hash(canonical({ cwd: canonicalPath, scope, name, config })) : null;
        const secretFields: string[] = [];
        const displayConfig = record(config ?? raw) ? redactConfig(config ?? raw, secretValues, secretFields) as Record<string, unknown> : {};
        summaries.push({
          name: /^[A-Za-z0-9_-]+$/.test(name) ? name : "[invalid name]",
          scope, enabled, effective, trusted: entryTrusted,
          status: !config ? "invalid" : !entryTrusted ? "untrusted" : !effective ? "shadowed" : !enabled ? "disabled" : "configured",
          config: displayConfig,
          configDigest,
          secretFields, connectionStatus: "disconnected", authStatus: "none", tools: [],
          ...(!config ? { error: "Invalid MCP server configuration (Pi validation failed)." } : {}),
        });
      }
    }
    for (const plugin of this.plugins?.list() ?? []) {
      const entry = loaded.servers.find(server => server.name === this.plugins!.serverName(plugin.id))!;
      summaries.push({ name: entry.name, pluginId: plugin.id, scope: "global", enabled: entry.config.enabled !== false,
        effective: true, trusted: true, status: entry.config.enabled !== false ? "configured" : "disabled",
        config: { ...structuredClone(entry.config) },
        configDigest: hash(canonical({ cwd: canonicalPath, scope: "global", name: entry.name, config: entry.config })),
        secretFields: [], connectionStatus: "disconnected", authStatus: "none", tools: [] });
    }
    const errors = [...[global, project, policy].flatMap(document => document.error ? [document.error] : []), ...loaded.errors];
    const review = summaries.filter(server => server.scope === "project").map(server => ({ name: server.name, config: server.config, secretFields: server.secretFields }));
    const snapshot: McpCatalog = {
      cwd: canonicalPath, conversationId: null, servers: summaries, errors, pendingApply: false,
      projectTrust: {
        path: project.path, digest: projectHash, trusted,
        servers: review.map(server => ({ name: server.name, ...(typeof server.config.command === "string" ? { command: server.config.command } : {}), ...(typeof server.config.url === "string" ? { url: server.config.url } : {}) })),
        review,
      },
    };
    return { cwd: canonicalPath, global, project, policy, projectHash, trusted, loaded, snapshot };
  }

  /** MAIN ONLY: use to redact connection errors and tool metadata before IPC. */
  configuredSecrets(cwd: string): string[] {
    return this.secrets(this.read(cwd));
  }

  /** Safe values for IPC, including configured literals repeated in tool metadata/errors. */
  redactForDisplay(cwd: string, value: unknown): unknown {
    return redactConfig(value, this.configuredSecrets(cwd), []);
  }

  /**
   * After an owned write, re-read and record the new fingerprint. Otherwise the runtime's
   * external-change poll would treat this service's own mutation as an outside edit and
   * re-apply it as a revocation, suspending healthy connections and aborting in-flight calls.
   */
  private commit(state: State, conversationId: string | null): McpCatalog {
    const latest = this.read(state.cwd);
    this.fingerprints.set(latest.cwd, this.fingerprint(latest));
    return { ...latest.snapshot, conversationId };
  }

  private secrets(state: State): string[] {
    return [...new Set([...Object.values(servers(state.global)), ...Object.values(servers(state.project))].flatMap(configuredSecrets))];
  }

  private fingerprint(state: State): { config: string; policy: string } {
    return {
      config: hash(canonical([state.cwd, state.global.text, state.global.error, state.project.text, state.project.error, this.plugins?.fingerprint()])),
      policy: hash(canonical([state.policy.text, state.policy.error])),
    };
  }
}
