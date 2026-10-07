import type { InteractionMode, RecipeStageSubmission, SubagentKind } from "@vela/shared";
import { defaultToolNames } from "@vela/tools";
import { browserToolNames } from "./browser-use";
import { defaultToolPolicy, modeToolNames, type ToolAuthorizationResult, type ToolPolicyCall } from "./interaction";
import { isMcpTool } from "./mcp-session";
import { memoryDisabledInstructions, memoryReadToolName, memoryToolNames, memoryUpdateToolName } from "./memory-tools";
import { recipeStageSubagentDenial } from "./recipe-stage";
import { scheduledTaskToolNames } from "./scheduled-task-tools";
import { agentToolNames, agentToolNamesFor } from "./subagent";

/** 决定工具组合所需的对话状态。 */
export interface ToolLoadoutConversation {
  snapshot: { mode: InteractionMode; executionPlan: unknown };
  recipeExecution?: unknown;
  scheduledTaskConversation?: boolean;
  recipeStageSideEffect?: RecipeStageSubmission["sideEffect"];
}

export interface ToolLoadoutOptions {
  scheduledTasks: boolean;
  browser: boolean;
  memoryEnabled: () => boolean;
}

const memoryUpdateDenial = "当前模式或执行环境不允许写入长期记忆（Plan、子代理、定时任务和配方执行只能读取）";

const isAgentTool = (name: string) => (agentToolNames as readonly string[]).includes(name);
const isMemoryTool = (name: string) => (memoryToolNames as readonly string[]).includes(name);

/**
 * 原生工具（不含 MCP）的注册、激活与执行授权。
 * 工具始终注册，模式、配方阶段和记忆开关只影响激活哪些以及执行前是否放行。
 */
export class ToolLoadout {
  constructor(private readonly options: ToolLoadoutOptions) {}

  /** 根会话注册的全部原生工具；defaultTools 只选择激活组合，不限制注册表。 */
  registered(): string[] {
    return [
      ...defaultToolNames,
      ...modeToolNames,
      ...agentToolNames,
      ...memoryToolNames,
      ...(this.options.scheduledTasks ? scheduledTaskToolNames : []),
      ...(this.options.browser ? browserToolNames : []),
    ];
  }

  /** 模式决定的原生工具；传入对话时附带它可用的记忆工具。 */
  native(mode: InteractionMode, plan: boolean, entry?: ToolLoadoutConversation): string[] {
    const scheduled = this.options.scheduledTasks ? (mode === "plan" ? ["list_scheduled_tasks"] : scheduledTaskToolNames) : [];
    const tools = [...defaultToolPolicy.availableTools(mode, plan), ...scheduled];
    if (entry) tools.push(...this.memory(entry));
    return tools;
  }

  /** 对话自身的原生工具加浏览器工具，不考虑配方阶段。 */
  private conversation(entry: ToolLoadoutConversation): string[] {
    const tools = this.native(entry.snapshot.mode, entry.snapshot.executionPlan !== null, entry);
    if (this.options.browser && entry.snapshot.mode !== "plan") tools.push(...browserToolNames);
    return tools;
  }

  /**
   * 根会话当前应激活的原生工具：配方阶段不提供子任务和浏览器，只读阶段只留查阅工具。
   * MCP 桥也用它做激活计算和执行前的原生工具闸门，两边必须一致。
   */
  active(entry: ToolLoadoutConversation): string[] {
    if (entry.recipeStageSideEffect === "read_only") return this.readOnlyStage(entry);
    if (entry.recipeStageSideEffect) {
      return this.native(entry.snapshot.mode, entry.snapshot.executionPlan !== null, entry).filter(name => !isAgentTool(name));
    }
    return this.conversation(entry);
  }

  readOnlyStage(entry: ToolLoadoutConversation): string[] {
    return ["read", "bash", "ask_user_question", ...this.memory(entry)];
  }

  /** 子代理的原生工具：按类型取 agent 工具，记忆只读，浏览器只给 general。 */
  child(kind: SubagentKind): string[] {
    return [
      ...agentToolNamesFor(kind),
      ...(this.options.memoryEnabled() ? [memoryReadToolName] : []),
      ...(this.options.browser && kind === "general" ? browserToolNames : []),
    ];
  }

  /**
   * 按权限矩阵决定激活哪些记忆工具：主代理的 Agent / Goal 模式读写都提供，
   * Plan、子代理、定时任务和配方执行只提供 memory_read。
   */
  memory(entry: ToolLoadoutConversation): string[] {
    if (!this.options.memoryEnabled()) return [];
    return this.canUpdateMemory(entry) ? [...memoryToolNames] : [memoryReadToolName];
  }

  /** 只有主代理在非 Plan 且非后台执行的环境里可以写入长期记忆。 */
  canUpdateMemory(entry: ToolLoadoutConversation): boolean {
    if (!this.options.memoryEnabled()) return false;
    return !(entry.snapshot.mode === "plan" || entry.recipeExecution || entry.scheduledTaskConversation);
  }

  /** 根会话执行工具前的最后一道闸。 */
  authorize(call: ToolPolicyCall, entry: ToolLoadoutConversation): ToolAuthorizationResult {
    if (isMemoryTool(call.toolName) && !this.options.memoryEnabled()) return { allowed: false, reason: memoryDisabledInstructions };
    if (entry.recipeStageSideEffect && isAgentTool(call.toolName)) return { allowed: false, reason: recipeStageSubagentDenial };
    if (call.toolName === memoryUpdateToolName && !this.canUpdateMemory(entry)) return { allowed: false, reason: memoryUpdateDenial };
    if (entry.recipeStageSideEffect === "read_only") return defaultToolPolicy.authorizeCall({ ...call, mode: "plan" });
    if (isMcpTool(call.toolName)) return { allowed: true };
    if (this.options.scheduledTasks && call.toolName === "list_scheduled_tasks") return { allowed: true };
    return defaultToolPolicy.authorizeCall(call);
  }
}
