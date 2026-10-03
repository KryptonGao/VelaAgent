import { toolResultIsError } from "./tool-activity";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  defineTool,
  type AgentSession,
  type AgentSessionEvent,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AgentInfo, AgentStatus, SubagentKind } from "@vela/shared";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { normalizeStoredAgents, type StoredAgent } from "./agent-history";
import {
  clipText,
  followupTaskToolName,
  formatAgentReport,
  lastAssistantText,
  rememberStep,
  sendMessageToolName,
  spawnAgentToolName,
  stepSummary,
  subagentOutputCap,
} from "./subagent";

/** 子代理最多嵌套几层：/root 之外还能再挂 3 层。 */
export const maxAgentDepth = 3;

/** 一个对话里同时存在的子代理上限。 */
export const maxAgentsPerTree = 16;

/** 同一时刻允许并发运行的子代理回合计。 */
export const maxConcurrentAgents = 4;

const mutatingToolNames = new Set(["bash", "edit", "write", "browser_repl"]);

/** 子代理继承父上下文的策略：不继承、全量、或最近 N 轮。 */
export type ContextFork = "none" | "all" | number;

export interface AgentSessionRequest {
  agentId: string;
  /** 恢复子会话时沿用已有消息，不再 fork 父上下文。 */
  sessionFile?: string | null;
  parentId: string;
  parentPath: string;
  parentSession: AgentSession;
  kind: SubagentKind;
  name: string;
  path: string;
  forkMessages: AgentMessage[];
  /** 控制面为这个子代理生成的 agent 树工具；运行时并入沙箱工具后注册。 */
  customTools: ToolDefinition[];
}

/** 发给 root 对话会话的消息：子代理结论，或子代理主动发的消息。 */
export interface AgentRootMessage {
  kind: "result" | "message";
  agentId: string;
  path: string;
  agentKind: SubagentKind;
  status?: Exclude<AgentStatus, "idle" | "running">;
  text: string;
}

export interface AgentControlHost {
  /** 用父会话的模型、权限和指令创建一个独立 Pi 会话。 */
  createChildSession(input: AgentSessionRequest): Promise<AgentSession>;
  disposeChildSession?(session: AgentSession): Promise<void>;
  toolMutates?(session: AgentSession, toolName: string): boolean;
  /** 把子代理结论或消息投递给 root 会话；由运行时决定唤醒还是排队。 */
  deliverToRoot(input: { conversationId: string; message: AgentRootMessage }): void;
  /** 子代理会话的原始事件；运行时翻译成界面事件，供右侧 Agent Pane 实时渲染。 */
  onAgentEvent(input: { conversationId: string; agentId: string; event: AgentSessionEvent }): void;
}

export interface AgentControlOptions {
  conversationId: string;
  host: AgentControlHost;
  onChange?: (agents: AgentInfo[]) => void;
  restoredAgents?: StoredAgent[];
}

interface AgentTaskOutcome {
  status: Exclude<AgentStatus, "idle" | "running">;
  text: string;
  error: string | null;
}

interface AgentTask {
  text: string;
  /** 入队时的中断代际；abortAll 之后旧任务直接作废。 */
  generation: number;
  /**
   * 结果被当场消费时返回 true（followup_task 的调用方拿到了结论），
   * 这时不再把同一结论重复投递给父代理。
   */
  consume: ((outcome: AgentTaskOutcome) => boolean) | null;
}

interface ManagedAgent {
  info: AgentInfo;
  session: AgentSession | null;
  /** 会话创建中/已创建的 Promise；子代理可以在父会话就绪前入队等待。 */
  sessionPromise: Promise<AgentSession> | null;
  unsubscribe: (() => void) | null;
  queue: AgentTask[];
  processing: boolean;
  running: boolean;
  aborted: boolean;
  disposed: boolean;
  /** abortAll 递增；旧代际的排队任务不再执行。 */
  generation: number;
  fork: ContextFork;
  sessionFile: string | null;
}

/**
 * 一个对话的 agent 树控制面：统一登记 root 与所有子代理，管父子关系、路径、
 * 状态、并发限制和消息投递。每个子代理是一个独立 Pi AgentSession，会话本身
 * 只负责跑回合，不知道自己在树里的位置。
 */
export class AgentControl {
  private readonly agents = new Map<string, ManagedAgent>();
  private readonly semaphore = new Semaphore(maxConcurrentAgents);
  private spawnSequence = 0;

  constructor(private readonly options: AgentControlOptions) {
    for (const stored of normalizeStoredAgents(options.restoredAgents)) {
      const { sessionFile, ...info } = stored;
      this.agents.set(info.id, {
        info, sessionFile, session: null, sessionPromise: null, unsubscribe: null,
        queue: [], processing: false, running: false, aborted: false,
        disposed: false, generation: 0, fork: "none",
      });
    }
  }

  /** 登记对话主会话为树根；root 的回合由运行时驱动，控制面只维护它的节点。 */
  registerRoot(session: AgentSession): AgentInfo {
    const now = Date.now();
    const info: AgentInfo = {
      id: this.options.conversationId,
      parentId: null,
      path: "/root",
      name: "root",
      kind: "root",
      status: "idle",
      depth: 0,
      task: "",
      steps: [],
      mutated: false,
      finalText: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.agents.set(info.id, {
      info,
      session,
      sessionPromise: Promise.resolve(session),
      unsubscribe: null,
      queue: [],
      processing: false,
      running: false,
      aborted: false,
      disposed: false,
      generation: 0,
      fork: "none",
      sessionFile: null,
    });
    this.emit();
    return cloneAgent(info);
  }

  /** 当前整棵树的快照；界面增量更新和测试都用它。 */
  list(): AgentInfo[] {
    return this.snapshot();
  }

  storedAgents(): StoredAgent[] {
    return [...this.agents.values()].filter((agent) => agent.info.kind !== "root")
      .map((agent) => ({ ...cloneAgent(agent.info), sessionFile: agent.sessionFile }));
  }

  /** 按 agentId 取会话，用于读取该子代理自己的消息历史。root 也可取。 */
  getSession(agentId: string): AgentSession | null {
    return this.agents.get(agentId)?.session ?? null;
  }

  /** root 的回合状态由运行时同步过来，界面上的 agent 树据此保持一致。 */
  setRootStatus(status: AgentStatus): void {
    const root = this.agents.get(this.options.conversationId);
    if (!root || root.info.kind !== "root" || root.info.status === status) return;
    root.info.status = status;
    root.info.updatedAt = Date.now();
    this.emit();
  }

  /** 为某个 agent 生成绑定调用方的 agent 树工具；子代理用同一组工具继续分派。 */
  createAgentTools(callerId: string): ToolDefinition[] {
    const spawnAgent = defineTool({
      name: spawnAgentToolName,
      label: "派生子代理",
      description:
        "启动一个常驻子代理，立即返回 agent id 和路径，不等待结果。agent 为 explore（只读）或 general（可改文件）。name 用作路径最后一段（如 backend）；fork 决定继承多少父上下文：none（默认）、all 或最近 N 轮。子代理完成后结论会自动回到你这里，需要等结果时用 followup_task。",
      promptSnippet: "启动常驻子代理（explore 只读 / general 可改文件），立即返回 agent id",
      parameters: Type.Object({
        agent: Type.Union([Type.Literal("explore"), Type.Literal("general")], {
          description: "explore 只读查阅，general 可以改文件和运行命令",
        }),
        task: Type.String({ description: "交给子代理的任务，包含目标、范围和完成标准" }),
        name: Type.Optional(
          Type.String({ description: "路径最后一段的短名称，如 backend、database；省略时自动生成" }),
        ),
        fork: Type.Optional(
          Type.Union([Type.Literal("none"), Type.Literal("all"), Type.Number()], {
            description: "继承父上下文：none 不继承（默认），all 全量，数字表示最近 N 轮",
          }),
        ),
      }),
      execute: async (_toolCallId, params) => {
        const info = this.spawn(callerId, {
          kind: params.agent,
          task: params.task,
          name: params.name,
          fork: params.fork,
        });
        return {
          content: [{ type: "text", text: spawnText(info, params.fork ?? "none") }],
          details: {
            agentId: info.id,
            path: info.path,
            kind: info.kind,
            status: info.status,
          },
        };
      },
    });

    const sendMessage = defineTool({
      name: sendMessageToolName,
      label: "发消息给子代理",
      description:
        "给 agent 树里的某个代理发一条消息，不阻塞。agent_id 可以是 spawn_agent 返回的 id，也可以是路径（如 /root/backend）。消息会在对方当前回合结束后处理；它产生的结论仍会回到你这里。",
      promptSnippet: "给已有子代理发消息，不等待结果",
      parameters: Type.Object({
        agent_id: Type.String({ description: "目标 agent 的 id 或路径，如 /root/backend" }),
        message: Type.String({ description: "要发给对方的消息或补充要求" }),
      }),
      execute: async (_toolCallId, params) => {
        const info = this.send(callerId, params.agent_id, params.message);
        return {
          content: [
            {
              type: "text",
              text: `已把消息发给 ${info.path}；它会在当前回合结束后处理，结论仍会回到你这里。`,
            },
          ],
          details: { agentId: info.id, path: info.path, kind: info.kind, status: info.status },
        };
      },
    });

    const followupTask = defineTool({
      name: followupTaskToolName,
      label: "追加任务并等待",
      description:
        "给子代理追加任务并等它完成后返回最终结论。需要子代理结果才能继续时用它；只是补充要求、不等结果就用 send_message。只能发给子代理，不能发给主代理。",
      promptSnippet: "追加任务给子代理并等它完成，返回最终结论",
      parameters: Type.Object({
        agent_id: Type.String({ description: "目标子代理的 id 或路径，如 /root/backend" }),
        task: Type.String({ description: "追加的任务，包含目标和完成标准" }),
      }),
      execute: async (_toolCallId, params, signal) => {
        const result = await this.followup(callerId, params.agent_id, params.task, signal);
        return {
          content: [{ type: "text", text: result.text }],
          details: {
            agentId: result.agent.id,
            path: result.agent.path,
            kind: result.agent.kind,
            status: result.status,
            steps: result.agent.steps,
            mutated: result.agent.mutated,
            finalText: result.agent.finalText ?? "",
          },
        };
      },
    });

    return [spawnAgent, sendMessage, followupTask];
  }

  /** 创建一个子代理节点并立刻返回；会话创建和首个任务在后台完成。 */
  spawn(
    callerId: string,
    input: { kind: SubagentKind; task: string; name?: string; fork?: ContextFork },
  ): AgentInfo {
    const caller = this.requireAgent(callerId);
    const kind = input.kind;
    if (caller.info.kind === "explore" && kind !== "explore") {
      throw new Error("查阅子代理只能创建 explore 子代理。");
    }
    const depth = caller.info.depth + 1;
    if (depth > maxAgentDepth) {
      throw new Error(`子代理最多嵌套 ${maxAgentDepth} 层，不能再往下创建。`);
    }
    if (this.childCount() >= maxAgentsPerTree) {
      throw new Error(`一个对话最多同时存在 ${maxAgentsPerTree} 个子代理，请先停止或等一部分结束。`);
    }
    const task = input.task.trim();
    if (!task) throw new Error("任务不能为空。");
    const name = this.uniqueName(caller, kind, input.name);
    const path = `${caller.info.path}/${name}`;
    const now = Date.now();
    const info: AgentInfo = {
      id: randomUUID(),
      parentId: caller.info.id,
      path,
      name,
      kind,
      status: "idle",
      depth,
      task: oneLine(task, 160),
      steps: [],
      mutated: false,
      finalText: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    const agent: ManagedAgent = {
      info,
      session: null,
      sessionPromise: null,
      unsubscribe: null,
      queue: [],
      processing: false,
      running: false,
      aborted: false,
      disposed: false,
      generation: 0,
      fork: input.fork ?? "none",
      sessionFile: null,
    };
    this.agents.set(info.id, agent);
    this.emit();
    this.enqueue(agent, { text: task, generation: agent.generation, consume: null });
    return cloneAgent(info);
  }

  /** 给目标代理投递消息，立即返回；目标是 root 时交给运行时决定唤醒方式。 */
  send(callerId: string, targetRef: string, message: string): AgentInfo {
    const caller = this.requireAgent(callerId);
    const target = this.requireTarget(caller, targetRef);
    const text = message.trim();
    if (!text) throw new Error("消息不能为空。");
    if (target.info.kind === "root") {
      this.options.host.deliverToRoot({
        conversationId: this.options.conversationId,
        message: {
          kind: "message",
          agentId: caller.info.id,
          path: caller.info.path,
          agentKind: caller.info.kind as SubagentKind,
          text,
        },
      });
      return cloneAgent(target.info);
    }
    this.enqueue(target, { text, generation: target.generation, consume: null });
    return cloneAgent(target.info);
  }

  /** 追加任务并等待目标代理完成该回合，返回格式化的最终结论。 */
  async followup(
    callerId: string,
    targetRef: string,
    task: string,
    signal: AbortSignal | undefined,
  ): Promise<AgentTaskOutcome & { agent: AgentInfo }> {
    const caller = this.requireAgent(callerId);
    const target = this.requireTarget(caller, targetRef);
    if (target.info.kind === "root") {
      throw new Error("followup_task 不能等待主代理；给主代理发消息请用 send_message。");
    }
    const text = task.trim();
    if (!text) throw new Error("任务不能为空。");
    if (target.disposed) throw new Error("这个子代理已经结束。");
    let abandoned = false;
    const outcome = await new Promise<AgentTaskOutcome>((resolve) => {
      let settled = false;
      const finish = (value: AgentTaskOutcome): boolean => {
        if (settled) return false;
        settled = true;
        resolve(value);
        return true;
      };
      if (signal) {
        const onAbort = (): void => {
          abandoned = true;
          finish(stoppedOutcome());
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
      this.enqueue(target, {
        text,
        generation: target.generation,
        consume: (value) => (abandoned ? false : finish(value)),
      });
    });
    return { ...outcome, agent: cloneAgent(target.info) };
  }

  /** 停止子代理树上所有子代理；root 的停止由运行时处理。 */
  abortAll(): void {
    for (const agent of this.agents.values()) {
      if (agent.info.kind === "root" || agent.disposed) continue;
      agent.aborted = true;
      agent.generation += 1;
      if (agent.running) void agent.session?.abort();
      else agent.info.status = "aborted";
      while (agent.queue.length > 0) {
        const task = agent.queue.shift();
        task?.consume?.({ status: "aborted", text: "", error: null });
      }
    }
    this.emit();
  }

  /** 释放整棵树：销毁子会话并了结还在排队的等待者。root 会话由运行时负责。 */
  dispose(): Promise<void> {
    const closing: Promise<void>[] = [];
    for (const agent of this.agents.values()) {
      if (agent.info.kind === "root") continue;
      agent.disposed = true;
      agent.unsubscribe?.();
      agent.unsubscribe = null;
      if (agent.session) {
        if (this.options.host.disposeChildSession) closing.push(this.options.host.disposeChildSession(agent.session));
        else agent.session.dispose();
      }
      if (!agent.session && agent.sessionPromise) closing.push(agent.sessionPromise.then(() => undefined, () => undefined));
      agent.session = null;
      while (agent.queue.length > 0) {
        const task = agent.queue.shift();
        task?.consume?.({ status: "aborted", text: "", error: null });
      }
    }
    this.agents.clear();
    this.spawnSequence = 0;
    return Promise.allSettled(closing).then(() => undefined);
  }

  private requireAgent(agentId: string): ManagedAgent {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error("agent 不存在或已结束。");
    return agent;
  }

  /** 目标可以按 id、路径（/root/backend）或唯一名字寻址；explore 只能碰 explore。 */
  private requireTarget(caller: ManagedAgent, ref: string): ManagedAgent {
    const target = this.resolve(ref);
    if (!target) throw new Error(`找不到子代理 ${ref}。可以用 id 或路径（如 /root/backend）。`);
    if (target.info.id === caller.info.id) throw new Error("不能给自己发消息。");
    if (caller.info.kind === "explore" && target.info.kind !== "explore") {
      throw new Error("查阅子代理只能和 explore 子代理通信。");
    }
    return target;
  }

  private resolve(ref: string): ManagedAgent | null {
    const text = ref.trim();
    if (!text) return null;
    const direct = this.agents.get(text);
    if (direct) return direct;
    const values = [...this.agents.values()];
    const byPath = values.find((agent) => agent.info.path === text);
    if (byPath) return byPath;
    const byName = values.filter((agent) => agent.info.name === text);
    return byName.length === 1 ? byName[0] ?? null : null;
  }

  private childCount(): number {
    let count = 0;
    for (const agent of this.agents.values()) {
      if (agent.info.kind !== "root") count += 1;
    }
    return count;
  }

  private uniqueName(parent: ManagedAgent, kind: SubagentKind, raw: string | undefined): string {
    const base = slug(raw) || `${kind}-${(this.spawnSequence += 1)}`;
    const taken = new Set(
      [...this.agents.values()]
        .filter((agent) => agent.info.parentId === parent.info.id)
        .map((agent) => agent.info.name),
    );
    if (!taken.has(base)) return base;
    for (let index = 2; ; index += 1) {
      const candidate = `${base}-${index}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  private enqueue(agent: ManagedAgent, task: AgentTask): void {
    if (agent.disposed) {
      task.consume?.({ status: "aborted", text: "", error: null });
      return;
    }
    agent.queue.push(task);
    void this.processQueue(agent);
  }

  /** 每个 agent 一个串行 worker：队列里的任务依次跑，跑之前先抢全局并发槽位。 */
  private async processQueue(agent: ManagedAgent): Promise<void> {
    if (agent.processing || agent.disposed) return;
    agent.processing = true;
    try {
      let session: AgentSession;
      try {
        session = await this.ensureSession(agent);
      } catch (error) {
        this.failAgent(agent, error);
        return;
      }
      while (agent.queue.length > 0 && !agent.disposed) {
        const task = agent.queue.shift();
        if (!task) break;
        await this.semaphore.acquire();
        try {
          if (agent.disposed || task.generation !== agent.generation) {
            task.consume?.({ status: "aborted", text: "", error: null });
            continue;
          }
          const outcome = await this.runTask(agent, task, session);
          const consumed = task.consume?.(outcome) ?? false;
          // 被用户中止的回合没有有效结论，不再回投父代理。
          if (!consumed && outcome.status !== "aborted") this.deliverToParent(agent, outcome);
        } finally {
          this.semaphore.release();
        }
      }
    } finally {
      agent.processing = false;
      if (agent.queue.length > 0 && !agent.disposed && agent.session) void this.processQueue(agent);
    }
  }

  private async ensureSession(agent: ManagedAgent): Promise<AgentSession> {
    if (agent.session) return agent.session;
    agent.sessionPromise ??= this.createChildSessionFor(agent);
    return agent.sessionPromise;
  }

  /** 创建子会话前先等父会话就绪，支持子代理再派子代理时晚于父代理启动。 */
  private async createChildSessionFor(agent: ManagedAgent): Promise<AgentSession> {
    const parent = agent.info.parentId ? this.agents.get(agent.info.parentId) ?? null : null;
    if (!parent) throw new Error("父代理不存在，无法创建子代理。");
    const parentSession = await this.ensureSession(parent);
    if (agent.disposed) throw new Error("子代理已结束。");
    const session = await this.options.host.createChildSession({
      agentId: agent.info.id,
      parentId: parent.info.id,
      parentPath: parent.info.path,
      parentSession,
      kind: agent.info.kind as SubagentKind,
      name: agent.info.name,
      path: agent.info.path,
      forkMessages: selectForkMessages(parentSession.messages, agent.fork),
      customTools: this.createAgentTools(agent.info.id),
      sessionFile: agent.sessionFile,
    });
    if (agent.disposed) {
      if (this.options.host.disposeChildSession) await this.options.host.disposeChildSession(session);
      else session.dispose();
      throw new Error("子代理已结束。");
    }
    agent.session = session;
    agent.sessionFile = session.sessionManager?.getSessionFile() ?? null;
    agent.unsubscribe = session.subscribe((event) => this.handleSessionEvent(agent, event));
    this.emit();
    return session;
  }

  private handleSessionEvent(agent: ManagedAgent, event: AgentSessionEvent): void {
    this.options.host.onAgentEvent({
      conversationId: this.options.conversationId,
      agentId: agent.info.id,
      event,
    });
    if (event.type === "tool_execution_start") {
      rememberStep(agent.info.steps, {
        id: event.toolCallId,
        name: event.toolName,
        summary: stepSummary(event.toolName, event.args),
        status: "running",
      });
      agent.info.updatedAt = Date.now();
      this.emit();
      return;
    }
    if (event.type === "tool_execution_end") {
      const current = agent.info.steps.find((item) => item.id === event.toolCallId);
      rememberStep(agent.info.steps, {
        id: event.toolCallId,
        name: event.toolName,
        summary: current?.summary ?? event.toolName,
        status: toolResultIsError(event.toolName, event.result, event.isError) ? "error" : "done",
      });
      if (mutatingToolNames.has(event.toolName) || (agent.session && this.options.host.toolMutates?.(agent.session, event.toolName))) agent.info.mutated = true;
      agent.info.updatedAt = Date.now();
      this.emit();
    }
  }

  private async runTask(
    agent: ManagedAgent,
    task: AgentTask,
    session: AgentSession,
  ): Promise<AgentTaskOutcome> {
    agent.running = true;
    agent.aborted = false;
    agent.info.status = "running";
    agent.info.task = oneLine(task.text, 160);
    agent.info.error = null;
    agent.info.finalText = null;
    agent.info.updatedAt = Date.now();
    this.emit();

    let failure = "";
    try {
      await session.prompt(task.text, { expandPromptTemplates: false });
    } catch (error) {
      if (!agent.aborted) {
        failure = error instanceof Error ? error.message : "子代理执行失败";
      }
    }
    const text = lastAssistantText(session.messages);
    const sessionError =
      !failure && !agent.aborted
        ? session.agent.state.errorMessage?.trim() ?? ""
        : "";
    const errorText = failure || sessionError;
    const status: AgentTaskOutcome["status"] = agent.aborted
      ? "aborted"
      : errorText
        ? "failed"
        : "completed";

    agent.running = false;
    agent.info.status = status;
    agent.info.error = status === "failed" ? errorText || "子代理执行失败" : null;
    agent.info.finalText = text ? clipText(text, subagentOutputCap).text : null;
    agent.info.updatedAt = Date.now();
    this.emit();

    const report = formatAgentReport({
      agent: agent.info.kind,
      path: agent.info.path,
      text,
      failure: errorText,
      stopped: agent.aborted,
    });
    return { status, text: report.text, error: errorText || null };
  }

  /** 会话创建失败：整条队列一起失败，等结果的调用方和父代理都收到原因。 */
  private failAgent(agent: ManagedAgent, error: unknown): void {
    const message = error instanceof Error ? error.message : "子代理启动失败";
    agent.info.status = "failed";
    agent.info.error = message;
    agent.info.updatedAt = Date.now();
    this.emit();
    while (agent.queue.length > 0) {
      const task = agent.queue.shift();
      task?.consume?.({ status: "failed", text: "", error: message });
    }
    this.deliverToParent(agent, { status: "failed", text: message, error: message });
  }

  /** 子代理回合结束后投递结论：root 走宿主唤醒，其他代理排进对方的队列。 */
  private deliverToParent(agent: ManagedAgent, outcome: AgentTaskOutcome): void {
    if (agent.info.kind === "root") return;
    const parent = agent.info.parentId ? this.agents.get(agent.info.parentId) ?? null : null;
    if (!parent) return;
    if (parent.info.kind === "root") {
      this.options.host.deliverToRoot({
        conversationId: this.options.conversationId,
        message: {
          kind: "result",
          agentId: agent.info.id,
          path: agent.info.path,
          agentKind: agent.info.kind as SubagentKind,
          status: outcome.status,
          text: outcome.text,
        },
      });
      return;
    }
    const label = outcome.status === "completed" ? "已完成" : outcome.status === "aborted" ? "已停止" : "失败";
    this.enqueue(parent, {
      text: `[子代理 ${agent.info.path} ${label}]\n\n${outcome.text}`,
      generation: parent.generation,
      consume: null,
    });
  }

  private emit(): void {
    this.options.onChange?.(this.snapshot());
  }

  private snapshot(): AgentInfo[] {
    return [...this.agents.values()].map((agent) => cloneAgent(agent.info));
  }
}

/** 简单的 FIFO 并发信号量；release 直接把槽位交给下一个等待者。 */
class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(limit: number) {
    this.available = limit;
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.available += 1;
  }
}

const forkableRoles = new Set(["user", "assistant", "toolResult", "custom", "bashExecution"]);

/**
 * 从父代理当前上下文里挑选 fork 给子代理的消息。
 * none 不继承；all 全量；数字表示最近 N 轮（用户消息为一轮边界）。
 * 末尾未配对的工具调用会被丢掉，避免子会话带着半个回合去请求模型。
 */
export function selectForkMessages(
  messages: readonly AgentMessage[],
  fork: ContextFork,
): AgentMessage[] {
  if (fork === "none") return [];
  const forkable = messages.filter((message) => forkableRoles.has(message.role));
  const sliced = typeof fork === "number" ? sliceLastTurns(forkable, fork) : forkable;
  return trimUnresolvedTail(sliced);
}

function sliceLastTurns(messages: AgentMessage[], turns: number): AgentMessage[] {
  const count = Math.floor(turns);
  if (!Number.isFinite(count) || count <= 0) return [];
  let remaining = count;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role !== "user") continue;
    remaining -= 1;
    if (remaining <= 0) return messages.slice(index);
  }
  return [...messages];
}

/** 从尾部去掉带未完成 toolCall 的 assistant 消息。 */
function trimUnresolvedTail(messages: AgentMessage[]): AgentMessage[] {
  const result = [...messages];
  while (result.length > 0) {
    const last = result[result.length - 1];
    if (!last || last.role !== "assistant") break;
    const calls = last.content
      .filter((part) => part.type === "toolCall")
      .map((part) => part.id);
    if (calls.length === 0) break;
    const resolved = new Set(
      result.filter((message) => message.role === "toolResult").map((message) => message.toolCallId),
    );
    if (calls.every((id) => resolved.has(id))) break;
    result.pop();
  }
  return result;
}

function stoppedOutcome(): AgentTaskOutcome {
  return { status: "aborted", text: "子代理已停止。", error: null };
}

function spawnText(info: AgentInfo, fork: ContextFork): string {
  return [
    `已启动子代理 ${info.path}（${info.kind}，fork=${String(fork)}）。`,
    "它在后台独立执行，完成后结论会自动投递给你；需要等结果时用 followup_task，补充要求用 send_message。",
  ].join("\n");
}

function cloneAgent(info: AgentInfo): AgentInfo {
  return { ...info, steps: info.steps.map((step) => ({ ...step })) };
}

function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return clipText(line, max).text;
}

function slug(raw: string | undefined): string {
  if (!raw) return "";
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
}
