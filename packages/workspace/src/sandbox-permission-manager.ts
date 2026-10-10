import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  SandboxExecutionContext,
  SandboxApprovalEvent,
  SandboxApprovalKind,
  SandboxMcpContext,
  SandboxMode,
  SandboxRiskEvaluator,
  SandboxRiskInput,
  SandboxRiskVerdict,
} from "@vela/shared";

/** 无人回复时自动拒绝的等待时间；Agent Inbox 据此区分「拒绝」与「超时」。 */
export const sandboxApprovalTimeoutMs = 5 * 60_000;
const approvalTimeoutMs = sandboxApprovalTimeoutMs;
/** 判定结论缓存上限,避免长时间会话里无限增长。 */
const verdictCacheLimit = 200;

interface SandboxSettings {
  sandboxMode: SandboxMode;
}

type ApprovalListener = (event: SandboxApprovalEvent) => void;

/**
 * Agent 操作的权限门。三种模式:
 * - ask(默认):bash、browser_repl 和 MCP 逐条审批,工作区外文件写入也要审批;
 * - smart:交给当前对话模型判断,只有风险操作或判断失败时请求批准;
 * - full:在授权范围内直接放行。
 */
export class SandboxPermissionManager {
  private mode: SandboxMode = "ask";
  private riskEvaluator: SandboxRiskEvaluator | null = null;
  private readonly pending = new Map<string, (allowed: boolean) => void>();
  private readonly listeners = new Set<ApprovalListener>();
  /** 判定结论缓存:同一条命令、同一个文件不重复调用模型。 */
  private readonly verdicts = new Map<string, SandboxRiskVerdict>();
  /** 同一操作的判定进行中时复用同一个 Promise。 */
  private readonly evaluations = new Map<string, Promise<SandboxRiskVerdict>>();
  private readonly settingsPath: string;

  constructor(settingsPath: string) {
    this.settingsPath = settingsPath;
  }

  async init(): Promise<SandboxMode> {
    try {
      const raw = JSON.parse(await readFile(this.settingsPath, "utf8")) as Partial<SandboxSettings>;
      if (isSandboxMode(raw.sandboxMode)) this.mode = raw.sandboxMode;
    } catch {
      // 首次启动没有设置文件,保持默认 ask。
    }
    return this.mode;
  }

  getMode(): SandboxMode {
    return this.mode;
  }

  /** 注入模型判定。切换后清空旧结论,避免沿用上一个模型的判断。 */
  setRiskEvaluator(evaluator: SandboxRiskEvaluator): void {
    this.riskEvaluator = evaluator;
    this.verdicts.clear();
    this.evaluations.clear();
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

  /**
   * 请求批准。full 直接放行;ask 下 bash、browser_repl 和 MCP 逐条审批,
   * 工作区内的文件改动放行;
   * smart 下先交给模型判断,只有风险或判断失败才推送审批请求。
   */
  async request(input: SandboxExecutionContext & {
    kind: SandboxApprovalKind;
    command?: string | null;
    path?: string | null;
    cwd?: string | null;
    workspace?: string | null;
    insideWorkspace?: boolean;
    mcp?: SandboxMcpContext;
    signal?: AbortSignal;
  }): Promise<boolean> {
    if (input.signal?.aborted) return false;
    const mode = input.sandboxMode ?? this.mode;
    if (mode === "full") return true;
    // 常驻 Agent 创建后台任务不是文件或命令操作，模型无法判断其风险：smart 模式下也交给用户。
    const alwaysAsk = input.kind === "delegate";
    if (!alwaysAsk && mode === "ask" && input.kind !== "bash" && input.kind !== "browser_repl" && input.kind !== "mcp" && input.insideWorkspace === true) return true;
    if (!alwaysAsk && mode === "smart" && this.riskEvaluator) {
      const verdict = await withApprovalAbort(this.evaluateRisk(input), input.signal);
      if (input.signal?.aborted) return false;
      if (verdict === "safe") return true;
    }
    const id = randomUUID();
    const request = {
      id,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      kind: input.kind,
      command: input.command ?? null,
      path: input.path ?? null,
      cwd: input.cwd ?? null,
      ...(input.mcp ? { mcp: input.mcp } : {}),
      createdAt: Date.now(),
    };
    return new Promise<boolean>((resolve) => {
      const finish = (allowed: boolean): void => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", abort);
        this.emit({ type: "resolved", id, allowed });
        resolve(allowed);
      };
      const abort = (): void => finish(false);
      const timer = setTimeout(() => finish(false), approvalTimeoutMs);
      this.pending.set(id, finish);
      input.signal?.addEventListener("abort", abort, { once: true });
      this.emit({ type: "request", request });
    });
  }

  /** 返回 false 表示该请求已不在等待(已回复、超时、被中断或应用重启)。 */
  reply(id: string, allowed: boolean): boolean {
    const finish = this.pending.get(id);
    if (!finish) return false;
    finish(allowed);
    return true;
  }

  private async evaluateRisk(input: SandboxExecutionContext & {
    kind: SandboxApprovalKind;
    command?: string | null;
    path?: string | null;
    cwd?: string | null;
    workspace?: string | null;
    insideWorkspace?: boolean;
    mcp?: SandboxMcpContext;
    signal?: AbortSignal;
  }): Promise<SandboxRiskVerdict> {
    const evaluator = this.riskEvaluator;
    if (!evaluator) return "unknown";
    // REPL state and external MCP state can change between identical calls.
    // Do not cache verdicts or share in-flight evaluations for these operations.
    if (input.kind === "browser_repl" || input.kind === "mcp") {
      try {
        return await evaluator({
          conversationId: input.conversationId,
          kind: input.kind,
          command: input.command ?? null,
          path: null,
          cwd: input.cwd ?? null,
          workspace: input.workspace ?? null,
          insideWorkspace: false,
          ...(input.mcp ? { mcp: input.mcp } : {}),
          signal: input.signal,
        });
      } catch {
        return "unknown";
      }
    }
    const key = `${input.conversationId ?? ""}\0${riskCacheKey(input)}`;
    const cached = this.verdicts.get(key);
    if (cached) return cached;
    const running = this.evaluations.get(key);
    if (running) return running;
    const risk: SandboxRiskInput = {
      conversationId: input.conversationId,
      kind: input.kind,
      command: input.command ?? null,
      path: input.path ?? null,
      cwd: input.cwd ?? null,
      workspace: input.workspace ?? null,
      insideWorkspace: input.insideWorkspace === true,
    };
    const evaluation = (async (): Promise<SandboxRiskVerdict> => {
      let verdict: SandboxRiskVerdict = "unknown";
      try {
        verdict = await evaluator(risk);
      } catch {
        verdict = "unknown";
      }
      this.rememberVerdict(key, verdict);
      return verdict;
    })();
    this.evaluations.set(key, evaluation);
    void evaluation.finally(() => {
      if (this.evaluations.get(key) === evaluation) this.evaluations.delete(key);
    });
    return evaluation;
  }

  private rememberVerdict(key: string, verdict: SandboxRiskVerdict): void {
    // 判断失败不缓存,下次重新交给模型;成功结论按 FIFO 淘汰旧条目。
    if (verdict === "unknown") return;
    if (this.verdicts.size >= verdictCacheLimit) {
      const oldest = this.verdicts.keys().next().value;
      if (oldest !== undefined) this.verdicts.delete(oldest);
    }
    this.verdicts.set(key, verdict);
  }

  private emit(event: SandboxApprovalEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

/** bash 按命令文本缓存,文件操作按路径与是否越界缓存,edit 和 write 共享同一结论。 */
function riskCacheKey(input: {
  kind: SandboxApprovalKind;
  command?: string | null;
  path?: string | null;
  cwd?: string | null;
  insideWorkspace?: boolean;
}): string {
  if (input.kind === "bash" || input.kind === "browser_repl") return `${input.kind}\0${input.command ?? ""}\0${input.cwd ?? ""}`;
  return `file\0${input.insideWorkspace === true ? "in" : "out"}\0${input.path ?? ""}`;
}

function isSandboxMode(value: unknown): value is SandboxMode {
  return value === "ask" || value === "smart" || value === "full";
}


/** Stop should not wait for a slow model risk evaluation before cancelling the tool. */
async function withApprovalAbort(evaluation: Promise<SandboxRiskVerdict>, signal?: AbortSignal): Promise<SandboxRiskVerdict> {
  if (!signal) return evaluation;
  if (signal.aborted) return "unknown";
  return new Promise((resolve, reject) => {
    const abort = (): void => { signal.removeEventListener("abort", abort); resolve("unknown"); };
    signal.addEventListener("abort", abort, { once: true });
    evaluation.then(verdict => {
      signal.removeEventListener("abort", abort);
      resolve(verdict);
    }, error => {
      signal.removeEventListener("abort", abort);
      reject(error);
    });
  });
}
