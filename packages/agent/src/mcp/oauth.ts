import type { McpController } from "@earendil-works/pi-coding-agent";
import { PluginCredentialStore, MemoryCredentialStore, type CredentialStore } from "./credentials";

/** OAuth 2.0/PKCE orchestration over Pi's existing discovery/DCR/loopback implementation. */
export class OAuthMCPManager {
  readonly credentials: PluginCredentialStore;
  private readonly logins = new Map<string, { server: string; controller: McpController; work: Promise<void> }>();
  constructor(options: { agentDir: string; credentialStore?: CredentialStore; isPlugin: (name: string) => boolean; openUrl?: (url: string) => void }) {
    this.credentials = new PluginCredentialStore(options.credentialStore ?? new MemoryCredentialStore(), options.isPlugin, options.agentDir);
    this.openUrl = options.openUrl;
  }
  private readonly openUrl?: (url: string) => void;
  login(controller: McpController, server: string, serverUrl: string, signal?: AbortSignal): Promise<void> {
    const key = JSON.stringify([server, serverUrl]);
    const pending = this.logins.get(key);
    if (pending) return pending.work;
    // signInMcpServer can itself use a refresh grant. Share the same lock as transport refreshes.
    const deadline = signal ? AbortSignal.any([signal, AbortSignal.timeout(300_000)]) : AbortSignal.timeout(300_000);
    const work = this.credentials.forServer(server, serverUrl).withRefreshLock(() => controller.login(server, {
      onUrl: this.openUrl, signal: deadline,
    }));
    this.logins.set(key, { server, controller, work });
    void work.finally(() => { if (this.logins.get(key)?.work === work) this.logins.delete(key); }).catch(() => undefined);
    return work;
  }
  cancel(server: string): void { for (const pending of this.logins.values()) if (pending.server === server) pending.controller.cancelLogin(server); }
  async dispose(): Promise<void> {
    for (const pending of this.logins.values()) pending.controller.cancelLogin(pending.server);
    await Promise.allSettled([...this.logins.values()].map(pending => pending.work));
  }
}
