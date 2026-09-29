import {
  defineTool,
  isToolCallEventType,
  type AgentToolResult,
  type ExtensionFactory,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  type ConversationPlan,
  type GoalStatus,
  type InteractionMode,
} from "@vela/shared";
import { Type } from "typebox";
import { isPlanSafeCommand } from "./plan-command";
import { agentToolNames } from "./subagent";
import type { GoalValidationDraft } from "./goal-validation";

export const goalContinuePrompt =
  "继续执行当前目标。若已经完成，先调用 record_goal_validation 记录检查，再调用 update_goal 将状态设为 complete。若还没完成，直接做下一步，不要重复已经做过的事。";

export const goalTurnLimit = 20;

export const goalTurnLimitNote = "已达到本轮自动执行上限，可以继续；完成前仍需提交交付验证。";

const planPrompt = `你正处于 Plan 模式，只能查阅代码，不能修改文件或执行会改动系统的命令。

先阅读相关代码，弄清现状和可选做法。需要时用只读命令补充信息。
准备好之后调用 submit_plan。计划是给用户扫一眼的概括：标题一句话，概述两三句，只说做法和原因，步骤最多 8 步，每步一句要做的事。
细节留在对话里。路径、参数、代码和样式数值都不要写进计划，同一件事也不要在概述和步骤里各写一遍。
不要在计划里假装已经改过文件，回复里也不要再贴一份长计划。
提交计划后，紧接着调用 ask_user_question 并把 kind 设为 plan_confirm，问用户是否执行。用户确认执行后，只回复一句话就结束：系统会自动开始执行计划，在那之前不要修改文件。
如果信息不够，先调用 ask_user_question 提问，不要猜测关键决定。`;

const goalPrompt = `你正处于 Goal 模式。目标已经记录在对话里，你要持续做到完成。

可以读取、编辑和运行命令。每推进一段就调用 update_goal：还在做就保持 active，并写一句进展；真正做完再设为 complete。
完成前必须先调用 record_goal_validation。按风险级别检查 diff、定向测试、构建、类型检查和回归；未运行的类别要说明原因。只引用本目标中实际完成的 bash 工具调用 id，不能编造命令结果。
检查命令之后如果还运行了其他 bash 命令，也要归类为「other」记录，或在它之后重跑检查；运行时会把未记录的后续命令视为可能修改工作区。
中高风险改动必须检查 diff 并运行定向测试；高风险改动还必须运行更广范围的回归。失败后修复并重跑，或记录失败调用及其确实与本次改动无关的依据。验证后如果又运行 bash、edit、write 或 spawn_agent 起 general 子代理，必须重新验证。
最终回复列出跑过的检查及结果、跳过的检查及原因，以及带已知问题完成时仍失败的项目。
不要把目标标成 complete，除非要求的结果已经达成。你不能暂停目标，暂停由用户决定。
如果这一轮还没完成，做下一步能做的事，不要停下来等用户说继续。`;

const agentPlanPrompt =
  "当前有一份待执行的计划。完成某个步骤后调用 complete_step，传入该步骤的 id。执行中遇到需要用户拍板的决定，可以用 ask_user_question 提问。";

const agentTreePrompt = `需要大范围查阅或把一块独立工作派出去时，用 spawn_agent 启动常驻子代理：agent 为 explore（只读）或 general（可改文件），立即返回 agent id 和路径，不等待结果。
name 是路径最后一段（如 backend）；fork 决定子代理继承多少当前上下文：none 不继承（默认），all 全量，数字表示最近 N 轮。
子代理完成后结论会自动回到你这里；需要结果才能继续时用 followup_task 等它完成，只是补充要求就用 send_message。
可以并行派多个子代理，但注意它们会并发修改工作区；简单的单文件读写不要派子代理。任务要写清楚目标、范围和完成标准，不要把子代理的过程原样复述给用户。`;

const workTools = ["read", "bash", "edit", "write", ...agentToolNames];

export function toolNamesFor(mode: InteractionMode, hasPlan: boolean): string[] {
  if (mode === "plan") return ["read", "bash", "submit_plan", "ask_user_question"];
  if (mode === "goal") return [...workTools, "record_goal_validation", "update_goal"];
  return hasPlan ? [...workTools, "complete_step", "ask_user_question"] : [...workTools, "ask_user_question"];
}

export function modeSystemPrompt(mode: InteractionMode, hasPlan: boolean): string {
  if (mode === "plan") return planPrompt;
  if (mode === "goal") return `${goalPrompt}\n\n${agentTreePrompt}`;
  return hasPlan ? `${agentPlanPrompt}\n\n${agentTreePrompt}` : agentTreePrompt;
}

const planExecutionHeader = "请按下面的计划实现。完成某个步骤后调用 complete_step，传入该步骤的 id。";

export function planExecutionPrompt(plan: ConversationPlan): string {
  const steps = plan.steps
    .map((step, index) => `${index + 1}. [${step.id}] ${step.text}${step.done ? "（已完成）" : ""}`)
    .join("\n");
  return [
    planExecutionHeader,
    "",
    `# ${plan.title}`,
    "",
    plan.overview,
    "",
    "步骤:",
    steps,
  ].join("\n");
}

/** 计划执行提示由系统代发，消息列表里不作为用户消息展示。 */
export function isPlanExecutionPrompt(text: string): boolean {
  return text.startsWith(planExecutionHeader);
}

export interface ModeState {
  mode: InteractionMode;
  hasPlan: boolean;
}

export function createModeExtension(read: () => ModeState): ExtensionFactory {
  return (pi) => {
    pi.on("before_agent_start", async (event) => {
      const state = read();
      const extra = modeSystemPrompt(state.mode, state.hasPlan);
      if (!extra) return;
      const current = event.systemPromptOptions.appendSystemPrompt.trim();
      event.systemPromptOptions.appendSystemPrompt = current ? `${current}\n\n${extra}` : extra;
    });

    pi.on("tool_call", async (event) => {
      if (read().mode !== "plan") return;
      if (isToolCallEventType("edit", event) || isToolCallEventType("write", event)) {
        return { block: true, reason: "Plan 模式不能修改文件。先提交计划，等用户确认后再执行。" };
      }
      if (isToolCallEventType("bash", event) && !isPlanSafeCommand(event.input.command)) {
        return {
          block: true,
          reason: `Plan 模式只允许查阅命令。\n命令: ${event.input.command}`,
        };
      }
    });
  };
}

export interface PlanDraft {
  title: string;
  overview: string;
  steps: string[];
}

/** 计划是扫一眼的概括，超长说明在提交时退回，让模型改写成短句。 */
export const planTitleMax = 36;
export const planOverviewMax = 160;
export const planStepMax = 64;
export const planStepCountMax = 8;

export type PlanDraftResult = { ok: true; plan: PlanDraft } | { ok: false; text: string };

export function acceptPlanDraft(draft: PlanDraft): PlanDraftResult {
  const title = clipLine(draft.title, planTitleMax);
  const overview = singleLine(draft.overview);
  const steps = draft.steps.map(singleLine).filter((step) => step.length > 0);
  if (!title || !overview || steps.length === 0) {
    return { ok: false, text: "计划需要标题、概述，以及至少一步。" };
  }
  const problems: string[] = [];
  if (overview.length > planOverviewMax) {
    problems.push(`概述请压到 ${planOverviewMax} 字以内，只留做法和原因`);
  }
  if (steps.length > planStepCountMax) {
    problems.push(`步骤请合并到 ${planStepCountMax} 步以内`);
  }
  if (steps.some((step) => step.length > planStepMax)) {
    problems.push(`每步请写成一句，不超过 ${planStepMax} 字`);
  }
  if (problems.length > 0) {
    return { ok: false, text: `计划要写成概括，不是规格说明。${problems.join("；")}。请缩短后重新提交。` };
  }
  return { ok: true, plan: { title, overview, steps } };
}

function singleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clipLine(text: string, max: number): string {
  const line = singleLine(text);
  if (line.length <= max) return line;
  return `${line.slice(0, Math.max(0, max - 1))}…`;
}

export type ToolOutcome = { ok: true; text: string } | { ok: false; text: string };

/**
 * createModeTools 提供的全部自定义工具名。
 * Pi 的 createAgentSession 把 tools 参数当作注册表白名单(内置与自定义都过滤),
 * 这些名字必须并入 tools,否则工具进不了注册表,setActiveToolsByName 会静默忽略。
 */
export const modeToolNames = ["submit_plan", "complete_step", "update_goal", "record_goal_validation", "ask_user_question"];

export interface AskUserInput {
  toolCallId: string;
  question: string;
  options: { label: string; description?: string }[];
  /** plan_confirm 表示提交计划后的执行确认,选项由系统固定提供。 */
  kind: "plan_confirm" | null;
  /** 用户点停止时立刻了结提问,不悬挂到用户回答。 */
  signal: AbortSignal | undefined;
}

/** plan_confirm 提问的系统固定选项,UI 与答案识别都依赖这些文案。 */
export const planConfirmOptions: { label: string; description: string }[] = [
  { label: "执行计划", description: "确认后系统自动切回 Agent 模式开始执行" },
  { label: "需要调整", description: "选择后可以补充要调整的地方" },
  { label: "暂不执行", description: "保留计划,稍后再决定" },
];

export const planConfirmExecuteLabel = planConfirmOptions[0].label;

export interface ModeToolHost {
  submitPlan(draft: PlanDraft): ToolOutcome;
  completeStep(id: string): ToolOutcome;
  updateGoal(status: Extract<GoalStatus, "active" | "complete">, note: string | null): ToolOutcome;
  recordGoalValidation(draft: GoalValidationDraft): ToolOutcome;
  askUser(input: AskUserInput): Promise<AskUserOutcome>;
}

/** askUser 的结果。answer 随工具 details 透出,供界面在已回答的卡片上展示。 */
export type AskUserOutcome =
  | { ok: true; text: string; answer: string | null }
  | { ok: false; text: string };

export function createModeTools(host: ModeToolHost): ToolDefinition[] {
  const submitPlan = defineTool({
    name: "submit_plan",
    label: "提交计划",
    description:
      "提交一份给用户扫一眼的实现概括。概述只写两三句做法和原因，每步一句要做的事。不要写路径、参数、代码或样式细节。",
    promptSnippet: "提交概括性计划（短标题、两三句概述、每步一句）",
    parameters: Type.Object({
      title: Type.String({ description: "一句话标题，不超过 36 个字" }),
      overview: Type.String({
        description: "概括，不超过 160 个字。只写两三句做法和原因，不写实现细节",
      }),
      steps: Type.Array(Type.String({ description: "一句要做的事，不超过 64 个字" }), {
        description: "按顺序执行的步骤，1 到 8 步",
        minItems: 1,
        maxItems: 8,
      }),
    }),
    execute: async (_toolCallId, params) => outcome(host.submitPlan(params)),
  });

  const completeStep = defineTool({
    name: "complete_step",
    label: "完成步骤",
    description: "把计划中的一个步骤标成已完成。id 来自执行计划时给出的步骤 id。",
    promptSnippet: "把计划步骤标成已完成",
    parameters: Type.Object({
      id: Type.String({ description: "步骤 id" }),
    }),
    execute: async (_toolCallId, params) => outcome(host.completeStep(params.id)),
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
      kind: Type.Optional(
        Type.Literal("plan_confirm", {
          description: "提交计划后确认是否执行时固定传 plan_confirm，选项由系统提供，不要再传 options",
        }),
      ),
    }),
    execute: async (toolCallId, params, signal) => {
      const result = await host.askUser({
        toolCallId,
        question: params.question,
        options: params.options ?? [],
        kind: params.kind ?? null,
        signal,
      });
      if (!result.ok) throw new Error(result.text);
      return {
        content: [{ type: "text", text: result.text }],
        details: { answer: result.answer },
      };
    },
  });

  return [submitPlan, completeStep, updateGoal, recordGoalValidation, askUserQuestion];
}

function outcome(result: ToolOutcome): AgentToolResult<undefined> {
  if (!result.ok) throw new Error(result.text);
  return {
    content: [{ type: "text", text: result.text }],
    details: undefined,
  };
}
