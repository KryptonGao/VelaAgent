import { McpOAuthCredentialStore, FileAuthStorageBackend } from "@earendil-works/pi-coding-agent";

/** Main-process abstraction, structurally compatible with Pi's storage injection point. */
export type CredentialStore = NonNullable<ConstructorParameters<typeof McpOAuthCredentialStore>[0]>;

/** Volatile fallback for non-desktop hosts. Desktop injects OS-encrypted storage. */
export class MemoryCredentialStore implements CredentialStore {
  private value: string | undefined;
  private chain: Promise<unknown> = Promise.resolve();
  withLock<T>(fn: (current: string | undefined) => { result: T; next?: string }): T {
    const outcome = fn(this.value);
    if (outcome.next !== undefined) this.value = outcome.next;
    return outcome.result;
  }
  withLockAsync<T>(fn: (current: string | undefined) => Promise<{ result: T; next?: string }>): Promise<T> {
    const work = this.chain.then(async () => {
      const outcome = await fn(this.value);
      if (outcome.next !== undefined) this.value = outcome.next;
      return outcome.result;
    });
    this.chain = work.catch(() => undefined);
    return work;
  }
}

/** One shared store per runtime. Rotation locks span every management/chat MCP connection. */
export class PluginCredentialStore extends McpOAuthCredentialStore {
  private readonly secure: McpOAuthCredentialStore;
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly generations = new Map<string, number>();
  constructor(private readonly secureBackend: CredentialStore, private readonly isPlugin: (name: string) => boolean, agentDir: string) {
    super(new FileAuthStorageBackend(`${agentDir}/mcp-auth.json`), agentDir);
    this.secure = new McpOAuthCredentialStore(secureBackend, agentDir);
  }
  override forServer(name: string, url: string): ReturnType<McpOAuthCredentialStore["forServer"]> {
    const store = this.isPlugin(name) ? this.secure.forServer(name, url) : super.forServer(name, url);
    const key = JSON.stringify([name, url]);
    const generation = this.generations.get(key) ?? 0;
    return { ...store,
      save: state => {
        if (generation !== (this.generations.get(key) ?? 0)) throw new Error("MCP credentials were revoked");
        return store.save(state);
      },
      withRefreshLock: fn => {
        const work = (this.locks.get(key) ?? Promise.resolve()).catch(() => undefined).then(() => store.withRefreshLock(fn));
        this.locks.set(key, work);
        void work.finally(() => { if (this.locks.get(key) === work) this.locks.delete(key); }).catch(() => undefined);
        return work;
      },
    };
  }
  override tokens(name: string, url: string) {
    if (!this.isPlugin(name)) return super.tokens(name, url);
    // Pi uses this only for authenticated-presence snapshots. A locked keychain must not
    // prevent status/error rendering; actual provider load/save still fail closed.
    try { return this.secure.tokens(name, url); } catch { return undefined; }
  }
  override remove(name: string, url: string): boolean {
    const key = JSON.stringify([name, url]);
    if (this.isPlugin(name)) this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
    return this.isPlugin(name) ? this.secure.remove(name, url) : super.remove(name, url);
  }
  /** Never expose this method through IPC; redact tokens echoed by a remote server. */
  secrets(): string | undefined { return this.secureBackend.withLock(current => ({ result: current })); }
}
