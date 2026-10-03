import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { BuiltInPlugin } from "@vela/shared";
import type { McpServerEntry } from "@earendil-works/pi-coding-agent";

export const builtInPlugins: readonly BuiltInPlugin[] = [{
  id: "notion", name: "Notion", description: "Search, read and edit your Notion workspace",
  icon: "notion", mcpUrl: "https://mcp.notion.com/mcp", transport: "streamable-http", authType: "oauth2",
  toolPolicy: { approval: "existing-mcp-policy", access: "read-write" },
}];

/** Built-ins are virtual, preconfigured MCP entries; user mcp.json stays user-owned. */
export class PluginRegistry {
  private readonly plugins = new Map<string, BuiltInPlugin>();
  constructor(private readonly statePath: string, definitions: readonly BuiltInPlugin[] = builtInPlugins) {
    for (const plugin of definitions) this.register(plugin);
  }
  register(plugin: BuiltInPlugin): void {
    const url = new URL(plugin.mcpUrl);
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if (!/^[a-z][a-z0-9_]*$/.test(plugin.id) || this.plugins.has(plugin.id)
      || (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) || url.username || url.password
      || plugin.transport !== "streamable-http" || !["oauth2", "none"].includes(plugin.authType)
      || plugin.oauth && Object.hasOwn(plugin.oauth, "clientSecret")) throw new Error("Invalid built-in plugin definition");
    this.plugins.set(plugin.id, structuredClone(plugin));
  }
  list(): BuiltInPlugin[] { return [...this.plugins.values()].map(plugin => structuredClone(plugin)); }
  get(id: string): BuiltInPlugin {
    const plugin = this.plugins.get(id);
    if (!plugin) throw new Error("Unknown built-in plugin");
    return structuredClone(plugin);
  }
  serverName(id: string): string { this.get(id); return `builtin_${id}`; }
  ownsServer(name: string): boolean { return this.list().some(plugin => this.serverName(plugin.id) === name); }
  private enabledIds(): string[] {
    if (!existsSync(this.statePath)) return [];
    try {
      const value: unknown = JSON.parse(readFileSync(this.statePath, "utf8"));
      if (!Array.isArray(value) || value.some(id => typeof id !== "string")) throw new Error();
      return value;
    } catch { throw new Error("Cannot read integration settings"); }
  }
  isEnabled(id: string): boolean { this.get(id); return this.enabledIds().includes(id); }
  setEnabled(id: string, enabled: boolean): void {
    this.get(id);
    const ids = new Set(this.enabledIds());
    if (enabled) ids.add(id); else ids.delete(id);
    mkdirSync(dirname(this.statePath), { recursive: true });
    const temporary = `${this.statePath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify([...ids].sort()) + "\n", { mode: 0o600, flag: "wx" });
      renameSync(temporary, this.statePath);
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
  entries(): McpServerEntry[] {
    const enabled = new Set(this.enabledIds());
    return this.list().map(plugin => ({
      name: this.serverName(plugin.id), scope: "global", source: `builtin:${plugin.id}`,
      // Pi's `http` transport is Streamable HTTP (the public plugin type is explicit).
      config: { type: "http", url: plugin.mcpUrl, description: plugin.description,
        enabled: enabled.has(plugin.id), exposure: "deferred",
        ...(plugin.authType === "oauth2" ? { oauth: { clientName: "Vela Agent", ...plugin.oauth } } : {}) },
    }));
  }
  /** Reserve the namespace even when a plugin is disabled or a project is untrusted. */
  merge(userEntries: McpServerEntry[]): McpServerEntry[] {
    return [...userEntries.filter(entry => !entry.name.replace(/-/g, "_").startsWith("builtin_")), ...this.entries()];
  }
  fingerprint(): string { return JSON.stringify(this.entries()); }
}
