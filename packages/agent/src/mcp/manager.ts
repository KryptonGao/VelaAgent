import type { McpConnectionStatus, McpCatalog, PluginStatusEvent, PluginSnapshot } from "@vela/shared";
import { PluginRegistry } from "./plugin-registry";

interface PluginPort {
  activate(id: string, cwd: string, signal: AbortSignal): Promise<void>;
  deactivate(id: string, cwd: string): Promise<void>;
}

/** Lifecycle only. Connections and tool execution remain owned by the existing MCP runtime. */
export class PluginMCPManager {
  private readonly operations = new Map<string, { kind: "connect" | "disconnect"; signal: AbortController; work: Promise<void> }>();
  private readonly states = new Map<string, PluginStatusEvent>();
  private readonly listeners = new Set<(event: PluginStatusEvent) => void>();
  constructor(readonly registry: PluginRegistry, private readonly port: PluginPort) {}
  subscribe(listener: (event: PluginStatusEvent) => void): () => void {
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  }
  private set(id: string, status: McpConnectionStatus, error?: string): void {
    const event = { id, status, ...(error ? { error } : {}) };
    this.states.set(id, event);
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* Observers cannot interrupt connection or credential cleanup. */ }
    }
  }
  snapshots(catalog: McpCatalog): PluginSnapshot[] {
    return this.registry.list().map(plugin => {
      const serverName = this.registry.serverName(plugin.id);
      const server = catalog.servers.find(item => item.name === serverName);
      const state = this.states.get(plugin.id);
      const enabled = this.registry.isEnabled(plugin.id);
      const liveConnected = enabled && server?.connectionStatus === "connected";
      const status = state?.status === "connecting" ? "connecting" : state?.status === "error" && !liveConnected ? "error"
        : !enabled ? "disconnected" : server?.connectionStatus ?? "disconnected";
      return { ...plugin, serverName, status, toolCount: status === "connected" ? server?.tools.length ?? 0 : 0,
        ...(status === "error" ? { error: "Connection failed. Try connecting again." } : {}) };
    });
  }
  connect(id: string, cwd: string): Promise<void> {
    this.registry.get(id);
    const pending = this.operations.get(id);
    if (pending) return pending.kind === "connect" ? pending.work : pending.work.then(() => this.connect(id, cwd));
    const signal = new AbortController();
    const work = Promise.resolve().then(async () => {
      this.set(id, "connecting");
      try {
        await this.port.activate(id, cwd, signal.signal);
        if (!signal.signal.aborted) this.set(id, "connected");
      } catch {
        if (!signal.signal.aborted) this.set(id, "error", "Connection failed. Try connecting again.");
      }
    }).finally(() => { if (this.operations.get(id)?.work === work) this.operations.delete(id); });
    this.operations.set(id, { kind: "connect", signal, work });
    return work;
  }
  disconnect(id: string, cwd: string): Promise<void> {
    this.registry.get(id);
    const pending = this.operations.get(id);
    if (pending?.kind === "disconnect") return pending.work;
    pending?.signal.abort();
    const signal = new AbortController();
    const work = Promise.resolve().then(async () => {
      if (pending) await pending.work;
      try { await this.port.deactivate(id, cwd); this.set(id, "disconnected"); }
      catch { this.set(id, "error", "Disconnect failed. Try again."); throw new Error("Disconnect failed. Try again."); }
    }).finally(() => { if (this.operations.get(id)?.work === work) this.operations.delete(id); });
    this.operations.set(id, { kind: "disconnect", signal, work });
    return work;
  }
  async dispose(): Promise<void> {
    for (const operation of this.operations.values()) operation.signal.abort();
    await Promise.allSettled([...this.operations.values()].map(operation => operation.work));
    this.listeners.clear();
  }
}
