import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionProjection } from "@earendil-works/pi-coding-agent";
import type { ProposedPlanItem, TranscriptMessage, TranscriptTool } from "@vela/shared";
import { randomUUID } from "node:crypto";
import { userMessageText } from "./context-usage";
import { isPlanExecutionPrompt, extractProposedPlans, normalizePlanMarkdown, sortPlans } from "./plan";
import { activityFromCall, activityFromExecution, toolResultIsError } from "./tool-activity";
import type { TurnTiming } from "./turn-timing";

/** 一条界面消息,以及它在 Pi 会话文件里的来源条目和时间。 */
export interface TranscriptSource {
  message: AgentMessage;
  /** 持久化会话里拥有这条消息的条目 id;仅内存消息为 null。 */
  entryId: string | null;
  /** 条目写入时间(毫秒);取不到时为 null。 */
  timestamp: number | null;
}

/** 界面会渲染的消息:跳过系统代发的计划执行提示和空消息,工具结果不单独成条。 */
export function isVisibleTranscriptMessage(message: AgentMessage): boolean {
  if (message.role === "user") {
    const text = userMessageText(message);
    const hasImage = typeof message.content !== "string" && message.content.some((part) => part.type === "image");
    return Boolean(text.trim() || hasImage) && !isPlanExecutionPrompt(text);
  }
  if (message.role === "assistant") {
    return message.content.some((part) => {
      if (part.type === "text") return part.text.length > 0;
      if (part.type === "thinking") return part.thinking.length > 0;
      return part.type === "toolCall";
    });
  }
  return false;
}

/** 主对话:按会话投影展开条目,为每条模型可见消息保留来源条目和时间戳。 */
export function transcriptSourcesFromProjection(projection: SessionProjection): TranscriptSource[] {
  const sources: TranscriptSource[] = [];
  for (const entry of projection.entries) {
    const time = Date.parse(entry.sourceEntry.timestamp);
    const timestamp = Number.isFinite(time) ? time : null;
    for (const message of entry.messages) {
      sources.push({ message, entryId: entry.sourceEntry.id, timestamp });
    }
  }
  return sources;
}

/** 把投影重建成界面消息;时间戳随消息带给「回复时间」。plans 用来把 <proposed_plan> 对应回 revision id。 */
export function transcriptFromProjection(
  projection: SessionProjection,
  plans: readonly ProposedPlanItem[] = [],
  timings: ReadonlyMap<string, TurnTiming> = new Map(),
): TranscriptMessage[] {
  return transcriptFromSources(transcriptSourcesFromProjection(projection), plans, timings);
}

/** 实时会话消息按消息顺序重建；磁盘历史使用 transcriptFromProjection。 */
export function transcriptFromMessages(messages: AgentMessage[]): TranscriptMessage[] {
  return transcriptFromSources(messages.map((message) => ({ message, entryId: null, timestamp: null })), []);
}

/** 分支会话开始时沿用来源历史的计数,避免上下文面板显示成新对话。 */
export function countTranscriptActivity(sources: TranscriptSource[]): { messageCount: number; toolCallCount: number } {
  let messageCount = 0;
  let toolCallCount = 0;
  for (const source of sources) {
    if (source.message.role === "user") {
      messageCount += 1;
      continue;
    }
    if (source.message.role === "assistant") {
      for (const part of source.message.content) {
        if (part.type === "toolCall") toolCallCount += 1;
      }
    }
  }
  return { messageCount, toolCallCount };
}

/**
 * 找到第 turnIndex 轮（从 0 数起的可见用户消息）最后一条可见 assistant 回复对应的会话条目 id,供分支会话使用。
 * 用轮次而不是消息下标定位,空 assistant 块和失败消息不会把分支点算错。
 * 分支点落在该消息之后,因此把紧随其后的工具结果一并纳入,避免模型看到没有结果的工具调用。
 */
export function branchLeafForTurn(sources: TranscriptSource[], turnIndex: number): string | null {
  let turn = -1;
  let target = -1;
  for (let position = 0; position < sources.length; position += 1) {
    const source = sources[position];
    if (!source || !isVisibleTranscriptMessage(source.message)) continue;
    if (source.message.role === "user") {
      turn += 1;
      if (turn > turnIndex) break;
      continue;
    }
    if (turn === turnIndex && source.message.role === "assistant" && source.entryId) target = position;
  }
  if (target < 0) return null;
  let leaf = sources[target]?.entryId ?? null;
  if (!leaf) return null;
  for (let next = target + 1; next < sources.length; next += 1) {
    const candidate = sources[next];
    if (!candidate || candidate.message.role !== "toolResult") break;
    leaf = candidate.entryId ?? leaf;
  }
  return leaf;
}

function transcriptFromSources(sources: TranscriptSource[], plans: readonly ProposedPlanItem[], timings: ReadonlyMap<string, TurnTiming> = new Map()): TranscriptMessage[] {
  const result: TranscriptMessage[] = [];
  const argsByCall = new Map<string, unknown>();
  // plan 正文已从 assistant 文本里剥离，这里按 markdown 内容把它对应回 revision id。
  const planQueue = sortPlans(plans);
  const claimedPlans = new Set<string>();
  const claimPlanId = (markdown: string): string | null => {
    const normalized = normalizePlanMarkdown(markdown);
    const exact = planQueue.find(
      (plan) => !claimedPlans.has(plan.id) && normalizePlanMarkdown(plan.markdown) === normalized,
    );
    const plan = exact ?? planQueue.find((item) => !claimedPlans.has(item.id)) ?? null;
    if (!plan) return null;
    claimedPlans.add(plan.id);
    return plan.id;
  };
  for (const source of sources) {
    const message = source.message;
    if (message.role === "user") {
      const parts = typeof message.content === "string"
        ? [{ type: "text" as const, text: message.content }]
        : message.content;
      const text = userMessageText(message);
      const images = parts
        .filter((part) => part.type === "image")
        .map((part) => ({ type: "image" as const, data: part.data, mimeType: part.mimeType }));
      if ((!text.trim() && images.length === 0) || isPlanExecutionPrompt(text)) continue;
      result.push({ id: randomUUID(), role: "user", text, images, thinking: "", tools: [], timestamp: source.timestamp });
      continue;
    }

    if (message.role === "assistant") {
      let text = "";
      let thinking = "";
      const tools: TranscriptTool[] = [];
      for (const part of message.content) {
        if (part.type === "text") text += part.text;
        else if (part.type === "thinking") thinking += part.thinking;
        else if (part.type === "toolCall") {
          argsByCall.set(part.id, part.arguments);
          tools.push({
            id: part.id,
            name: part.name,
            status: "done",
            activity: activityFromCall(part.name, part.arguments),
          });
        }
      }
      // <proposed_plan> 已作为 ProposedPlanItem 持久化，不再在正文里重复展示。
      const extracted = extractProposedPlans(text);
      text = extracted.text;
      const planIds = extracted.plans
        .map(claimPlanId)
        .filter((id): id is string => Boolean(id));
      if (!text && !thinking && tools.length === 0 && planIds.length === 0) continue;
      const timing = source.entryId ? timings.get(source.entryId) : undefined;
      result.push({
        id: randomUUID(),
        role: "assistant",
        text,
        thinking,
        tools,
        ...(planIds.length > 0 ? { planIds } : {}),
        timestamp: source.timestamp,
        ...(timing ? { turnStartedAt: timing.startedAt, turnCompletedAt: timing.completedAt } : {}),
      });
      continue;
    }

    if (message.role === "toolResult") {
      for (const entry of result) {
        const tool = entry.tools.find((item) => item.id === message.toolCallId);
        if (!tool) continue;
        tool.status = toolResultIsError(message.toolName || tool.name, message, message.isError) ? "error" : "done";
        tool.activity = activityFromExecution(
          message.toolName || tool.name,
          argsByCall.get(message.toolCallId),
          message,
          toolResultIsError(message.toolName || tool.name, message, message.isError),
        );
      }
    }
  }
  return result;
}
