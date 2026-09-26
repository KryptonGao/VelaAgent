import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  isToolCallEventType,
  SessionManager,
  SettingsManager,
  type AgentToolResult,
  type ExtensionFactory,
  type ModelRuntime,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { SubagentKind, ToolStep } from "@vela/shared";
import { Type } from "typebox";
import { isPlanSafeCommand } from "./plan-command";

export const subagentToolName = "task";

export const subagentTurnLimit = 12;

export const subagentOutputCap = 12_000;

export const subagentStepCap = 40;

const explorePrompt = `你是只读查阅子代理。只能阅读文件和运行查阅命令，不能修改文件。
用户消息是要调查的任务。查完后用简洁结论回复：找到了什么、相关文件路径、关键事实。不要贴整文件。
你看不到父对话，也不要向用户提问。`;

const generalPrompt = `你是执行子代理。可以读取、编辑和运行命令，权限与当前会话相同。
用户消息是要完成的任务。做完后用简洁结论回复：做了什么、改了哪些文件、还有什么没完成。
你看不到父对话，也不要向用户提问。`;

const emptyNote = "子代理没有留下文字结论。";

const stoppedNote = "子代理已停止。";

const turnLimitNote = "已达到子代理回合上限，结论可能不完整。";

const clipNote = "结论过长，已截断。";

const mutatingToolNames = new Set(["bash", "edit", "write"]);

interface SubagentDefinition {
  prompt: string;
  tools: string[];
}

const definitions: Record<SubagentKind, SubagentDefinition> = {
  explore: { prompt: explorePrompt, tools: ["read", "bash"] },
  general: { prompt: generalPrompt, tools: ["read", "bash", "edit", "write"] },
};

export interface SubagentProgress {
  agent: SubagentKind;
  steps: ToolStep[];
  mutated: boolean;
}

export interface SubagentResult {
  agent: SubagentKind;
  text: string;
  steps: ToolStep[];
  mutated: boolean;
  truncated: boolean;
}

export interface SubagentRequest {
  agent: SubagentKind;
  task: string;
  signal: AbortSignal | undefined;
  onProgress: (progress: SubagentProgress) => void;
}

export interface SubagentHost {
  run(request: SubagentRequest): Promise<SubagentResult>;
}

export interface SubagentDetails {
  agent: SubagentKind;
  steps: ToolStep[];
  mutated: boolean;
  truncated: boolean;
}

export interface RunBuiltinSubagentInput {
  agent: SubagentKind;
  task: string;
  cwd: string;
  agentDir: string;
  model: Model<Api>;
  thinkingLevel: ThinkingLevel;
  modelRuntime: ModelRuntime;
  instructions: string;
  tools: ToolDefinition[];
  signal: AbortSignal | undefined;
  onProgress: (progress: SubagentProgress) => void;
}

/** 查阅子代理的 bash 只放行 Plan 模式同一套只读命令。 */
export function exploreCommandAllowed(command: string): boolean {
  return isPlanSafeCommand(command);
}

export function createExploreGuardExtension(): ExtensionFactory {
  return (pi) => {
    pi.on("tool_call", async (event) => {
      if (isToolCallEventType("edit", event) || isToolCallEventType("write", event)) {
        return { block: true, reason: "查阅子代理不能修改文件。" };
      }
      if (isToolCallEventType("bash", event) && !exploreCommandAllowed(event.input.command)) {
        return {
          block: true,
          reason: `查阅子代理只允许只读命令。\n命令: ${event.input.command}`,
        };
      }
    });
  };
}

export function createSubagentTool(host: SubagentHost): ToolDefinition {
  return defineTool({
    name: subagentToolName,
    label: "子代理",
    description:
      "把一块工作交给独立上下文的子代理，并等待它完成。explore 只读，适合大范围查阅代码。general 可以读取、编辑和运行命令，权限与当前会话相同。不要用它做单文件读写。子代理看不到当前对话。任务要写清目标、范围和完成标准。",
    promptSnippet: "把查阅或实现交给子代理（explore 只读，general 可改文件）",
    executionMode: "sequential",
    parameters: Type.Object({
      agent: Type.Union([Type.Literal("explore"), Type.Literal("general")], {
        description: "explore 只读查阅，general 可以改文件和运行命令",
      }),
      task: Type.String({ description: "交给子代理的任务，包含目标、范围和完成标准" }),
    }),
    execute: async (_toolCallId, params, signal, onUpdate) => {
      const result = await host.run({
        agent: params.agent,
        task: params.task,
        signal,
        onProgress: (progress) => {
          onUpdate?.({
            content: [{ type: "text", text: progress.steps.at(-1)?.summary ?? "子代理进行中" }],
            details: {
              agent: progress.agent,
              steps: progress.steps,
              mutated: progress.mutated,
              truncated: false,
            },
          });
        },
      });
      return toolResult(result);
    },
  });
}

/**
 * 在内存里跑一个子会话。不写对话列表，也不带 Skill、Plan 或 Goal 工具。
 * 父代理的停止信号和回合上限都会中止这个会话。
 */
export async function runBuiltinSubagent(input: RunBuiltinSubagentInput): Promise<SubagentResult> {
  const task = input.task.trim();
  if (!task) throw new Error("任务不能为空");
  const definition = definitions[input.agent];
  if (input.signal?.aborted) return stoppedResult(input.agent);

  const settingsManager = SettingsManager.inMemory();
  const instructions = input.instructions.trim();
  const resourceLoader = new DefaultResourceLoader({
    cwd: input.cwd,
    agentDir: input.agentDir,
    settingsManager,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noExtensions: true,
    extensionFactories: input.agent === "explore"
      ? [{ name: "vela-explore", hidden: true, factory: createExploreGuardExtension() }]
      : [],
    appendSystemPromptOverride: (base) => [
      ...base,
      ...(instructions ? [instructions] : []),
      definition.prompt,
    ],
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd: input.cwd,
    agentDir: input.agentDir,
    model: input.model,
    thinkingLevel: input.thinkingLevel,
    modelRuntime: input.modelRuntime,
    sessionManager: SessionManager.inMemory(input.cwd),
    settingsManager,
    resourceLoader,
    tools: definition.tools,
    customTools: childTools(input.agent, input.tools),
  });

  if (input.signal?.aborted) {
    session.dispose();
    return stoppedResult(input.agent);
  }

  const steps: ToolStep[] = [];
  let mutated = false;
  let turns = 0;
  let turnLimited = false;
  let stopped = false;
  const publish = (): void => {
    input.onProgress({
      agent: input.agent,
      steps: steps.map((step) => ({ ...step })),
      mutated,
    });
  };
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "turn_end") {
      turns += 1;
      if (turns >= subagentTurnLimit && !turnLimited) {
        turnLimited = true;
        void session.abort();
      }
      return;
    }
    if (event.type === "tool_execution_start") {
      rememberStep(steps, {
        id: event.toolCallId,
        name: event.toolName,
        summary: stepSummary(event.toolName, event.args),
        status: "running",
      });
      publish();
      return;
    }
    if (event.type === "tool_execution_end") {
      const current = steps.find((item) => item.id === event.toolCallId);
      rememberStep(steps, {
        id: event.toolCallId,
        name: event.toolName,
        summary: current?.summary || event.toolName,
        status: event.isError ? "error" : "done",
      });
      if (input.agent === "general" && mutatingToolNames.has(event.toolName)) mutated = true;
      publish();
    }
  });
  const onAbort = (): void => {
    stopped = true;
    void session.abort();
  };
  input.signal?.addEventListener("abort", onAbort, { once: true });

  let failure = "";
  let text = "";
  try {
    await session.prompt(task, { expandPromptTemplates: false });
  } catch (error) {
    if (!turnLimited && !stopped && !input.signal?.aborted) {
      failure = error instanceof Error ? error.message : "子代理执行失败";
    }
  } finally {
    unsubscribe();
    input.signal?.removeEventListener("abort", onAbort);
    text = lastAssistantText(session.messages);
    if (!failure && !turnLimited && !stopped && !input.signal?.aborted) {
      failure = session.agent.state.errorMessage?.trim() ?? "";
    }
    session.dispose();
  }

  if (input.signal?.aborted) stopped = true;
  const report = formatSubagentReport({
    agent: input.agent,
    text,
    failure,
    turnLimited,
    stopped,
  });
  return {
    agent: input.agent,
    text: report.text,
    steps: steps.map((step) => ({ ...step })),
    mutated,
    truncated: report.truncated,
  };
}

export function formatSubagentReport(input: {
  agent: SubagentKind;
  text: string;
  failure: string;
  turnLimited: boolean;
  stopped: boolean;
}): { text: string; truncated: boolean } {
  const clipped = clipText(input.text.trim(), subagentOutputCap);
  const parts = [`[${input.agent}]`];
  if (clipped.text) parts.push(clipped.text);
  else if (!input.stopped && !input.failure) parts.push(emptyNote);
  if (input.failure && !input.stopped && !input.turnLimited) parts.push(`子代理没有完成：${input.failure}`);
  if (input.stopped) parts.push(stoppedNote);
  if (input.turnLimited) parts.push(turnLimitNote);
  if (clipped.truncated) parts.push(clipNote);
  return { text: parts.join("\n\n"), truncated: clipped.truncated || input.turnLimited };
}

function toolResult(result: SubagentResult): AgentToolResult<SubagentDetails> {
  return {
    content: [{ type: "text", text: result.text }],
    details: {
      agent: result.agent,
      steps: result.steps,
      mutated: result.mutated,
      truncated: result.truncated,
    },
  };
}

function stoppedResult(agent: SubagentKind): SubagentResult {
  return {
    agent,
    text: formatSubagentReport({ agent, text: "", failure: "", turnLimited: false, stopped: true }).text,
    steps: [],
    mutated: false,
    truncated: false,
  };
}

function childTools(agent: SubagentKind, tools: ToolDefinition[]): ToolDefinition[] {
  if (agent === "general") return tools;
  return tools.filter((tool) => tool.name === "bash" || tool.name === "read");
}

function rememberStep(steps: ToolStep[], step: ToolStep): void {
  const index = steps.findIndex((item) => item.id === step.id);
  if (index >= 0) {
    const current = steps[index];
    steps[index] = step.summary ? step : { ...step, summary: current?.summary ?? step.summary };
  } else {
    steps.push(step);
  }
  if (steps.length > subagentStepCap) steps.splice(0, steps.length - subagentStepCap);
}

function stepSummary(toolName: string, args: unknown): string {
  const command = readString(args, "command");
  const path = readString(args, "path") ?? readString(args, "file_path");
  const summary = command ?? path ?? toolName;
  return clipText(summary.replace(/\s+/g, " ").trim(), 180).text || toolName;
}

function lastAssistantText(messages: AgentMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "assistant" || !Array.isArray(message.content)) continue;
    const text = message.content
      .map((part) => (part.type === "text" ? part.text : ""))
      .filter((part) => part.trim().length > 0)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}

function readString(source: unknown, key: string): string | undefined {
  if (!source || typeof source !== "object") return undefined;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function clipText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: `${text.slice(0, max)}…`, truncated: true };
}
