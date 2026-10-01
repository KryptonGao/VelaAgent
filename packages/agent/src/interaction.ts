import {
  defineTool,
  type AgentToolResult,
  type ExtensionFactory,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  type GoalStatus,
  type InteractionMode,
} from "@vela/shared";
import { Type } from "typebox";
import { isPlanSafeCommand } from "./plan-command";
import { executionPlanItemMax, type ExecutionPlanUpdateItem } from "./plan";
import { agentToolNames } from "./subagent";
import type { GoalValidationDraft } from "./goal-validation";

export const goalContinuePrompt =
  "继续执行当前目标。若已经完成，先调用 record_goal_validation 记录检查，再调用 update_goal 将状态设为 complete。若还没完成，直接做下一步，不要重复已经做过的事。";

export const goalTurnLimit = 20;

export const goalTurnLimitNote = "已达到本轮自动执行上限，可以继续；完成前仍需提交交付验证。";

const planPrompt = `你正处于 Plan 模式，只能查阅代码，不能修改文件或执行会改动系统的命令。

先理解用户目标，主动探索代码库，把实现所需的事实查清楚：相关模块、数据流、接口、持久化、测试和现存问题。
能从仓库、配置、文档或源码里查到的信息必须自己查，不要把仓库里能查到的答案抛给用户。
只有产品偏好、无法从代码推断的行为选择、tradeoff、缺失需求，以及必须由用户决定的兼容策略，才用 ask_user_question 提问。

当方案已经 decision-complete、另一个实现 agent 拿到后不需要再做主要架构决策时，在回复的最后输出完整方案：
<proposed_plan>
# <方案标题>

## Goal

...
</proposed_plan>

第一行用一句话写清方案标题，界面会把它作为 Plan Document 和聊天预览的标题。

方案用 Markdown 写，按需包含 Goal、Current Architecture、Proposed Architecture、Data Model Changes、Runtime Changes、UI Changes、Persistence / Migration、Error Handling / Edge Cases、Testing、Implementation Steps 等章节。
写明具体文件或模块、interface / class / function、数据流、状态生命周期、API 或 IPC 变化、持久化与迁移策略、UI 行为、测试策略、兼容性和边界情况；不要写没有落点的步骤清单，也不要只给 diff。
如果用户对已有方案提出修改，重新输出修订后的完整方案作为新 revision，不要原地改写旧版本。
输出方案后不要用 ask_user_question 要求确认执行，也不要修改文件；界面会在方案生成后让用户决定批准、继续修改或换新上下文执行。`;

const goalPrompt = `你正处于 Goal 模式。目标已经记录在对话里，你要持续做到完成。

可以读取、编辑和运行命令。每推进一段就调用 update_goal：还在做就保持 active，并写一句进展；真正做完再设为 complete。
完成前必须先调用 record_goal_validation。按风险级别检查 diff、定向测试、构建、类型检查和回归；未运行的类别要说明原因。只引用本目标中实际完成的 bash 工具调用 id，不能编造命令结果。
检查命令之后如果还运行了其他 bash 命令，也要归类为「other」记录，或在它之后重跑检查；运行时会把未记录的后续命令视为可能修改工作区。
中高风险改动必须检查 diff 并运行定向测试；高风险改动还必须运行更广范围的回归。失败后修复并重跑，或记录失败调用及其确实与本次改动无关的依据。验证后如果又运行 bash、edit、write 或 spawn_agent 起 general 子代理，必须重新验证。
最终回复列出跑过的检查及结果、跳过的检查及原因，以及带已知问题完成时仍失败的项目。
不要把目标标成 complete，除非要求的结果已经达成。你不能暂停目标，暂停由用户决定。
如果这一轮还没完成，做下一步能做的事，不要停下来等用户说继续。`;

const agentPlanPrompt =
  "当前有一份已批准的执行方案。开始前先把实际实现拆成可推进的条目并用 update_plan 提交，执行过程中随时用 update_plan 更新：最多一项 in_progress，完成后标 completed，可以根据实际实现新增、调整或合并条目。执行清单只记录进度，不要用它改写已批准的方案；需要改变设计时停下来向用户说明，并建议回到 Plan 模式。执行中遇到需要用户拍板的决定可以用 ask_user_question 提问。";

const agentTreePrompt = `需要大范围查阅或把一块独立工作派出去时，用 spawn_agent 启动常驻子代理：agent 为 explore（只读）或 general（可改文件），立即返回 agent id 和路径，不等待结果。
name 是路径最后一段（如 backend）；fork 决定子代理继承多少当前上下文：none 不继承（默认），all 全量，数字表示最近 N 轮。
子代理完成后结论会自动回到你这里；需要结果才能继续时用 followup_task 等它完成，只是补充要求就用 send_message。
可以并行派多个子代理，但注意它们会并发修改工作区；简单的单文件读写不要派子代理。任务要写清楚目标、范围和完成标准，不要把子代理的过程原样复述给用户。`;

const workTools = ["read", "bash", "edit", "write", ...agentToolNames];

export function toolNamesFor(mode: InteractionMode, hasExecutionPlan: boolean): string[] {
  if (mode === "plan") return ["read", "bash", "ask_user_question"];
  if (mode === "goal") return [...workTools, "record_goal_validation", "update_goal"];
  return hasExecutionPlan
    ? [...workTools, "update_plan", "ask_user_question"]
    : [...workTools, "ask_user_question"];
}

export function modeSystemPrompt(mode: InteractionMode, hasExecutionPlan: boolean): string {
  if (mode === "plan") return planPrompt;
  if (mode === "goal") return `${goalPrompt}\n\n${agentTreePrompt}`;
  return hasExecutionPlan ? `${agentPlanPrompt}\n\n${agentTreePrompt}` : agentTreePrompt;
}

// ---------- Tool policy ----------

/**
 * 区分「工具是否提供给模型」和「Runtime 最终是否允许执行」。
 * availableTools 决定注册后激活哪些工具；authorizeCall 是执行前的最后一道闸。
 */
export interface ToolPolicyCall {
  mode: InteractionMode;
  toolName: string;
  input: unknown;
}

export type ToolAuthorizationResult =
  | { allowed: true }
  | { allowed: false; reason: string };

export interface ToolPolicy {
  availableTools(mode: InteractionMode, hasExecutionPlan: boolean): string[];
  authorizeCall(call: ToolPolicyCall): ToolAuthorizationResult;
}

const planAllowedTools = new Set(["read", "bash", "ask_user_question"]);
const planDeniedTools = new Set(["edit", "write", "apply_patch"]);

export class DefaultToolPolicy implements ToolPolicy {
  availableTools(mode: InteractionMode, hasExecutionPlan: boolean): string[] {
    return toolNamesFor(mode, hasExecutionPlan);
  }

  authorizeCall(call: ToolPolicyCall): ToolAuthorizationResult {
    if (call.mode !== "plan") return { allowed: true };
    if (!planAllowedTools.has(call.toolName)) {
      if (planDeniedTools.has(call.toolName)) {
        return { allowed: false, reason: "Plan 模式不能修改文件。先提交计划，等用户批准后再执行。" };
      }
      return { allowed: false, reason: `Plan 模式不允许调用 ${call.toolName}。` };
    }
    if (call.toolName === "bash") {
      const command = bashCommandOf(call.input);
      if (!command) return { allowed: false, reason: "Plan 模式只能运行查阅类命令。" };
      if (!isPlanSafeCommand(command)) {
        return { allowed: false, reason: `Plan 模式只允许查阅命令。\n命令: ${command}` };
      }
    }
    return { allowed: true };
  }
}

export const defaultToolPolicy = new DefaultToolPolicy();

function bashCommandOf(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const command = (input as { command?: unknown }).command;
  return typeof command === "string" && command.trim() ? command : null;
}

export interface ModeState {
  mode: InteractionMode;
  hasExecutionPlan: boolean;
}

export function createModeExtension(
  read: () => ModeState,
  policy: ToolPolicy = defaultToolPolicy,
): ExtensionFactory {
  return (pi) => {
    pi.on("before_agent_start", async (event) => {
      const state = read();
      const extra = modeSystemPrompt(state.mode, state.hasExecutionPlan);
      if (!extra) return;
      const current = event.systemPromptOptions.appendSystemPrompt.trim();
      event.systemPromptOptions.appendSystemPrompt = current ? `${current}\n\n${extra}` : extra;
    });

    pi.on("tool_call", async (event) => {
      const result = policy.authorizeCall({
        mode: read().mode,
        toolName: event.toolName,
        input: event.input,
      });
      if (result.allowed) return;
      return { block: true, reason: result.reason };
    });
  };
}

export type ToolOutcome = { ok: true; text: string } | { ok: false; text: string };

/**
 * createModeTools 提供的全部自定义工具名。
 * Pi 的 createAgentSession 把 tools 参数当作注册表白名单(内置与自定义都过滤),
 * 这些名字必须并入 tools,否则工具进不了注册表,setActiveToolsByName 会静默忽略。
 */
export const modeToolNames = ["update_plan", "update_goal", "record_goal_validation", "ask_user_question"];

export interface AskUserInput {
  toolCallId: string;
  question: string;
  options: { label: string; description?: string }[];
  /** 用户点停止时立刻了结提问,不悬挂到用户回答。 */
  signal: AbortSignal | undefined;
}

export interface ModeToolHost {
  updateExecutionPlan(items: ExecutionPlanUpdateItem[]): ToolOutcome;
  updateGoal(status: Extract<GoalStatus, "active" | "complete">, note: string | null): ToolOutcome;
  recordGoalValidation(draft: GoalValidationDraft): ToolOutcome;
  askUser(input: AskUserInput): Promise<AskUserOutcome>;
}

/** askUser 的结果。answer 随工具 details 透出,供界面在已回答的卡片上展示。 */
export type AskUserOutcome =
  | { ok: true; text: string; answer: string | null }
  | { ok: false; text: string };

export function createModeTools(host: ModeToolHost): ToolDefinition[] {
  const updatePlan = defineTool({
    name: "update_plan",
    label: "更新执行清单",
    description:
      "更新当前执行清单。按实际实现提交完整清单：最多一项 in_progress，完成项标 completed，可以新增、调整或合并条目。只记录进度，不要用它改写已批准的方案。",
    promptSnippet: "更新执行清单（step + status 列表）",
    executionMode: "sequential",
    parameters: Type.Object({
      plan: Type.Array(
        Type.Object({
          step: Type.String({ description: "一条执行项" }),
          status: Type.Union([
            Type.Literal("pending"),
            Type.Literal("in_progress"),
            Type.Literal("completed"),
          ]),
        }),
        { description: "按执行顺序排列的完整清单", minItems: 1, maxItems: executionPlanItemMax },
      ),
    }),
    execute: async (_toolCallId, params) =>
      outcome(host.updateExecutionPlan(params.plan as ExecutionPlanUpdateItem[])),
  });

  const updateGoal = defineTool({
    name: "update_goal",
    label: "更新目标",
    description: "更新当前目标。还在做就保持 active，并写一句进展；真正做完再设为 complete。不能用来暂停。",
    promptSnippet: "更新目标状态为 active 或 complete",
    executionMode: "sequential",
    parameters: Type.Object({
      status: Type.Union([Type.Literal("active"), Type.Literal("complete")]),
      note: Type.Optional(Type.String({ description: "一句进展说明" })),
    }),
    execute: async (_toolCallId, params) => outcome(host.updateGoal(params.status, params.note ?? null)),
  });

  const category = Type.Union([
    Type.Literal("diff"),
    Type.Literal("test"),
    Type.Literal("build"),
    Type.Literal("typecheck"),
    Type.Literal("regression"),
    Type.Literal("other"),
  ]);
  const recordGoalValidation = defineTool({
    name: "record_goal_validation",
    label: "记录验证",
    description:
      "提交当前 Goal 的交付验证。检查结果必须引用本目标中已完成的 bash 工具调用 id；运行时从实际结果读取命令、状态和输出。检查之后其他 bash 命令也需归类为 other 或在其后重跑检查。每类未运行的检查都要写原因。",
    promptSnippet: "记录 Goal 的检查命令、实际结果和跳过原因",
    executionMode: "sequential",
    parameters: Type.Object({
      risk: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
      checks: Type.Array(
        Type.Object({
          category,
          toolCallId: Type.String({ description: "已完成的 bash 工具调用 id" }),
        }),
        { description: "实际运行的检查及其工具调用 id" },
      ),
      skipped: Type.Array(
        Type.Object({
          category,
          reason: Type.String({ description: "未运行原因；中高风险 diff/test、高风险 regression 不可跳过" }),
        }),
        { description: "明确记录未运行的检查类别与原因" },
      ),
      knownIssues: Type.Array(
        Type.Object({
          toolCallId: Type.String({ description: "失败的 bash 工具调用 id" }),
          reason: Type.String({ description: "说明失败与本次改动无关的证据" }),
        }),
        { description: "允许带问题完成的失败检查；只填最新且仍失败的检查" },
      ),
    }),
    execute: async (_toolCallId, params) => outcome(host.recordGoalValidation(params as GoalValidationDraft)),
  });

  const askUserQuestion = defineTool({
    name: "ask_user_question",
    label: "提问",
    description:
      "就关键决定向用户提问并等待回答。可给 2-4 个选项让用户点选，用户也可以自由输入或跳过。不要用它问无关紧要的事。",
    promptSnippet: "向用户提问（问题+可选项），等待回答后继续",
    parameters: Type.Object({
      question: Type.String({ description: "要问用户的问题，一句话说清楚" }),
      options: Type.Optional(
        Type.Array(
          Type.Object({
            label: Type.String({ description: "选项文本，简短" }),
            description: Type.Optional(Type.String({ description: "选项的补充说明" })),
          }),
          { description: "2-4 个可选项；不传则用户自由输入回答", minItems: 2, maxItems: 4 },
        ),
      ),
    }),
    execute: async (toolCallId, params, signal) => {
      const result = await host.askUser({
        toolCallId,
        question: params.question,
        options: params.options ?? [],
        signal,
      });
      if (!result.ok) throw new Error(result.text);
      return {
        content: [{ type: "text", text: result.text }],
        details: { answer: result.answer },
      };
    },
  });

  return [updatePlan, updateGoal, recordGoalValidation, askUserQuestion];
}

function outcome(result: ToolOutcome): AgentToolResult<undefined> {
  if (!result.ok) throw new Error(result.text);
  return {
    content: [{ type: "text", text: result.text }],
    details: undefined,
  };
}
