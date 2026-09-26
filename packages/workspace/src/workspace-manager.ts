import { stat, readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { WorkspaceRecent, WorkspaceState } from "@vela/shared";

const maxRecents = 10;

interface WorkspaceStore {
  current: string | null;
  recents: WorkspaceRecent[];
}

export class WorkspaceManager {
  private state: WorkspaceState = { current: null, recents: [] };
  private readonly listeners = new Set<(state: WorkspaceState) => void>();

  constructor(private readonly storePath: string) {}

  async init(initialPath?: string | null): Promise<WorkspaceState> {
    const stored = await this.readStore();
    const recents = stored.recents
      .filter((recent) => typeof recent?.path === "string" && recent.path.length > 0)
      .slice(0, maxRecents);
    const candidate = initialPath ?? stored.current;
    let current: string | null = null;
    if (candidate && (await isDirectory(candidate))) {
      current = candidate;
      touchRecent(recents, candidate);
    }
    this.state = { current, recents };
    await this.persist();
    return this.state;
  }

  getState(): WorkspaceState {
    return {
      current: this.state.current,
      recents: this.state.recents.map((recent) => ({ ...recent })),
    };
  }

  subscribe(listener: (state: WorkspaceState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async select(path: string): Promise<WorkspaceState> {
    const normalized = normalizePath(path);
    if (!normalized) throw new Error("工作区路径不正确");
    if (!(await isDirectory(normalized))) throw new Error("目录不存在或不可访问");
    this.state.current = normalized;
    touchRecent(this.state.recents, normalized);
    await this.persist();
    this.notify();
    return this.getState();
  }

  async close(): Promise<WorkspaceState> {
    this.state.current = null;
    await this.persist();
    this.notify();
    return this.getState();
  }

  async removeRecent(path: string): Promise<WorkspaceState> {
    const normalized = normalizePath(path);
    this.state.recents = this.state.recents.filter((recent) => recent.path !== normalized);
    await this.persist();
    this.notify();
    return this.getState();
  }

  private notify(): void {
    const snapshot = this.getState();
    for (const listener of this.listeners) listener(snapshot);
  }

  private async readStore(): Promise<WorkspaceStore> {
    try {
      const raw = JSON.parse(await readFile(this.storePath, "utf8")) as Partial<WorkspaceStore>;
      return {
        current: typeof raw.current === "string" ? raw.current : null,
        recents: Array.isArray(raw.recents) ? raw.recents : [],
      };
    } catch {
      return { current: null, recents: [] };
    }
  }

  private async persist(): Promise<void> {
    const payload: WorkspaceStore = {
      current: this.state.current,
      recents: this.state.recents.slice(0, maxRecents),
    };
    await mkdir(dirname(this.storePath), { recursive: true });
    await writeFile(this.storePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }
}

function normalizePath(path: string): string | null {
  const trimmed = path.trim();
  if (!trimmed || trimmed.length > 1024) return null;
  return trimmed.replace(/\/+$/, "") || "/";
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function touchRecent(recents: WorkspaceRecent[], path: string): void {
  const next = recents.filter((recent) => recent.path !== path);
  next.unshift({ path, name: path.split("/").filter(Boolean).pop() ?? path, lastUsedAt: Date.now() });
  recents.length = 0;
  recents.push(...next.slice(0, maxRecents));
}
