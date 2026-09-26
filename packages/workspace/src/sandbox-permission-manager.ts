import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  SandboxApprovalEvent,
  SandboxApprovalKind,
  SandboxMode,
} from "@vela/shared";

const approvalTimeoutMs = 5 * 60_000;

interface SandboxSettings {
  sandboxMode: SandboxMode;
}

type ApprovalListener = (event: SandboxApprovalEvent) => void;

/**
 * Agent 在工作区边界之外操作的权限门。两种模式:
 * - ask(默认):bash 每条命令、工作区外文件写入都要用户批准;
 * - full:在授权范围内直接放行。
 */
export class SandboxPermissionManager {
  private mode: SandboxMode = "ask";
  private readonly pending = new Map<string, (allowed: boolean) => void>();
  private readonly listeners = new Set<ApprovalListener>();

  constructor(private readonly settingsPath: string) {}

  async init(): Promise<SandboxMode> {
    try {
      const raw = JSON.parse(await readFile(this.settingsPath, "utf8")) as Partial<SandboxSettings>;
      if (raw.sandboxMode === "ask" || raw.sandboxMode === "full") this.mode = raw.sandboxMode;
    } catch {
      // 首次启动没有设置文件,保持默认 ask。
    }
    return this.mode;
  }

  getMode(): SandboxMode {
    return this.mode;
  }

  subscribe(listener: ApprovalListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async setMode(mode: SandboxMode): Promise<SandboxMode> {
    this.mode = mode;
    await mkdir(dirname(this.settingsPath), { recursive: true });
    await writeFile(this.settingsPath, `${JSON.stringify({ sandboxMode: mode } satisfies SandboxSettings, null, 2)}\n`, "utf8");
    return this.mode;
  }

  /** 请求批准。full 模式直接放行;ask 模式推送审批请求并等待用户答复。 */
  async request(input: {
    kind: SandboxApprovalKind;
    command?: string | null;
    path?: string | null;
    cwd?: string | null;
  }): Promise<boolean> {
    if (this.mode === "full") return true;
    const id = randomUUID();
    const request = {
      id,
      kind: input.kind,
      command: input.command ?? null,
      path: input.path ?? null,
      cwd: input.cwd ?? null,
      createdAt: Date.now(),
    };
    return new Promise<boolean>((resolve) => {
      const finish = (allowed: boolean): void => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        this.emit({ type: "resolved", id, allowed });
        resolve(allowed);
      };
      const timer = setTimeout(() => finish(false), approvalTimeoutMs);
      this.pending.set(id, finish);
      this.emit({ type: "request", request });
    });
  }

  reply(id: string, allowed: boolean): void {
    this.pending.get(id)?.(allowed);
  }

  private emit(event: SandboxApprovalEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
