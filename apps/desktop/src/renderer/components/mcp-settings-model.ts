import type { McpOAuthConfig } from "@vela/shared";

/** Renderer-only parsing; importing a configuration never executes it. */
export type McpExposure = "deferred" | "direct" | "hidden";
export interface McpFormConfig {
  type: "stdio" | "http" | "streamable-http";
  [key: string]: unknown;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  oauth?: McpOAuthConfig;
  enabled: boolean;
  exposure: McpExposure;
}

export class McpFormError extends Error {
  constructor(
    public readonly field: string,
    public readonly reason:
      | "json"
      | "object"
      | "strings"
      | "required"
      | "transport"
      | "url"
      | "exposure"
      | "boolean"
      | "empty"
      | "port",
  ) {
    super(`${field}: ${reason}`);
  }
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new McpFormError(field, "object");
  return value as Record<string, unknown>;
}

export function parseMcpJson(text: string, field: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new McpFormError(field, "json");
  }
}

export function parseMcpStringMap(
  text: string,
  field: string,
): Record<string, string> {
  const value = record(parseMcpJson(text.trim() || "{}", field), field);
  if (Object.values(value).some((entry) => typeof entry !== "string"))
    throw new McpFormError(field, "strings");
  return value as Record<string, string>;
}

export function parseMcpArgs(text: string): string[] {
  const value = parseMcpJson(text.trim() || "[]", "args");
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))
    throw new McpFormError("args", "strings");
  return value;
}

export function validateMcpConfig(value: unknown): McpFormConfig {
  const config = record(value, "config");
  const transport =
    config.transport ??
    config.type ??
    (config.url !== undefined ? "http" : "stdio");
  if (
    transport !== "stdio" &&
    transport !== "http" &&
    transport !== "streamable-http"
  )
    throw new McpFormError("transport", "transport");
  if (
    config.exposure !== undefined &&
    !["deferred", "direct", "hidden"].includes(String(config.exposure))
  )
    throw new McpFormError("exposure", "exposure");
  for (const key of ["enabled"]) {
    if (config[key] !== undefined && typeof config[key] !== "boolean")
      throw new McpFormError(key, "boolean");
  }
  const { transport: _transport, ...preserved } = config;
  const common = {
    ...preserved,
    enabled: config.enabled !== false,
    exposure: (config.exposure ?? "deferred") as McpExposure,
  };
  if (transport === "stdio") {
    if (typeof config.command !== "string" || !config.command.trim())
      throw new McpFormError("command", "required");
    if (config.cwd !== undefined && typeof config.cwd !== "string")
      throw new McpFormError("cwd", "strings");
    return {
      ...common,
      type: "stdio",
      command: config.command.trim(),
      args: parseMcpArgs(JSON.stringify(config.args ?? [])),
      ...(config.env !== undefined
        ? { env: parseMcpStringMap(JSON.stringify(config.env), "env") }
        : {}),
      ...(config.cwd ? { cwd: config.cwd as string } : {}),
    };
  }
  if (typeof config.url !== "string" || !config.url.trim())
    throw new McpFormError("url", "required");
  let url: URL;
  try {
    url = new URL(config.url);
  } catch {
    throw new McpFormError("url", "url");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new McpFormError("url", "url");
  if (config.oauth !== undefined) {
    const oauth = record(config.oauth, "oauth");
    for (const key of [
      "clientId",
      "clientSecret",
      "callbackUrl",
      "scope",
      "clientName",
      "authServerMetadataUrl",
    ]) {
      if (oauth[key] !== undefined && typeof oauth[key] !== "string")
        throw new McpFormError("oauth", "strings");
    }
    if (
      oauth.callbackPort !== undefined &&
      (typeof oauth.callbackPort !== "number" ||
        !Number.isInteger(oauth.callbackPort) ||
        oauth.callbackPort < 1 ||
        oauth.callbackPort > 65535)
    )
      throw new McpFormError("oauth", "port");
  }
  return {
    ...common,
    type: transport as "http" | "streamable-http",
    url: config.url.trim(),
    ...(config.oauth !== undefined
      ? { oauth: config.oauth as McpOAuthConfig }
      : {}),
    ...(config.headers !== undefined
      ? {
          headers: parseMcpStringMap(JSON.stringify(config.headers), "headers"),
        }
      : {}),
  };
}

export function parseMcpImport(
  text: string,
): { name: string; config: McpFormConfig }[] {
  const root = record(parseMcpJson(text, "import"), "import");
  const servers = record(root.mcpServers ?? root, "import");
  if (Object.keys(servers).length === 0)
    throw new McpFormError("import", "empty");
  return Object.entries(servers).map(([name, config]) => {
    if (!/^[A-Za-z0-9_-]+$/.test(name))
      throw new McpFormError("name", "required");
    return { name, config: validateMcpConfig(config) };
  });
}

/** Empty credential editors mean preserve; an explicit {} means clear. */
export function credentialUpdate(
  text: string,
  field: "env" | "headers",
): Record<string, string> | undefined {
  return text.trim() ? parseMcpStringMap(text, field) : undefined;
}

/** Masked values belong to their original scope and cannot be copied into an override. */
export function prepareMcpOverride(
  config: Record<string, unknown>,
  secretFields: string[],
): Record<string, unknown> {
  const next = structuredClone(config);
  for (const pointer of secretFields) {
    const parts = pointer
      .replace(/^\//, "")
      .split("/")
      .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
    let parent: unknown = next;
    for (const part of parts.slice(0, -1)) {
      if (
        !parent ||
        typeof parent !== "object" ||
        !Object.hasOwn(parent, part)
      ) {
        parent = null;
        break;
      }
      parent = (parent as Record<string, unknown>)[part];
    }
    if (parent && typeof parent === "object") {
      const key = parts.at(-1)!;
      if (Array.isArray(parent)) parent[Number(key)] = "";
      else delete (parent as Record<string, unknown>)[key];
    }
  }
  return next;
}
