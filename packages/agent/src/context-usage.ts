import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  getCurrentSystemMessage,
  getCurrentTools,
  getSystemMessageText,
  toToolDeclaration,
  type Tool,
} from "@earendil-works/pi-ai";
import { estimateTokens, type AgentSession } from "@earendil-works/pi-coding-agent";
import {
  contextCategories,
  type ContextCategory,
  type ContextSegments,
  type ContextUsage,
} from "@vela/shared";

const SECTION_NAME = /^[a-z][a-z0-9_-]*$/;
const RULE_SECTIONS = new Set(["rules", "project_context", "addendum"]);

export function emptyContextSegments(): ContextSegments {
  return { system: 0, tools: 0, rules: 0, skills: 0, conversation: 0 };
}

/**
 * 按系统提示里的顶层标签拆段。
 * Pi 把 tools / rules / skills 等包在独立标签里，正文里的带属性标签不会被当成一段。
 */
export function splitSystemPrompt(prompt: string): Record<string, string> {
  const lines = prompt.split("\n");
  const sections: Record<string, string> = {};
  const preamble: string[] = [];
  let seenSection = false;
  let index = 0;

  while (index < lines.length) {
    const name = openingTag(lines[index]);
    if (!name) {
      if (!(seenSection && lines[index].trim() === "")) preamble.push(lines[index]);
      index += 1;
      continue;
    }

    const body: string[] = [];
    let depth = 1;
    let cursor = index + 1;
    let closed = false;
    while (cursor < lines.length) {
      if (lines[cursor] === `<${name}>`) depth += 1;
      if (lines[cursor] === `</${name}>`) {
        depth -= 1;
        if (depth === 0) {
          closed = true;
          cursor += 1;
          break;
        }
      }
      body.push(lines[cursor]);
      cursor += 1;
    }

    if (!closed) {
      preamble.push(lines[index]);
      index += 1;
      continue;
    }

    seenSection = true;
    sections[name] = `<${name}>\n${body.join("\n")}\n</${name}>`;
    index = cursor;
  }

  const leading = preamble.join("\n").trim();
  if (leading) sections.preamble = leading;
  return sections;
}

/** 从当前会话估算上下文分段。没有会话时调用方填零。 */
export function measureSessionContext(session: AgentSession): Pick<ContextUsage, "tokens" | "contextWindow" | "percent" | "segments"> {
  const messages = session.agent.state.messages;
  const prompt = currentPromptText(session, messages);
  const chars = charsByCategory(splitSystemPrompt(prompt));
  chars.tools += toolDeclarationChars(currentTools(session, messages));

  const segments = emptyContextSegments();
  segments.system = charsToTokens(chars.system);
  segments.tools = charsToTokens(chars.tools);
  segments.rules = charsToTokens(chars.rules);
  segments.skills = charsToTokens(chars.skills);
  segments.conversation = conversationTokens(messages, session.agent.state.streamingMessage);

  const reported = session.getContextUsage();
  const contextWindow = positiveCount(reported?.contextWindow) ?? positiveCount(session.model?.contextWindow);
  const scaled = reported?.tokens != null ? scaleSegments(segments, reported.tokens) : null;
  const resolved = scaled ?? segments;
  const tokens = sumSegments(resolved);
  const percent = contextWindow ? (tokens / contextWindow) * 100 : null;
  return { tokens, contextWindow, percent, segments: resolved };
}

function currentPromptText(session: AgentSession, messages: AgentMessage[]): string {
  const current = getCurrentSystemMessage(messages);
  const rendered = current ? getSystemMessageText(current).trim() : "";
  return rendered.length > 0 ? rendered : session.systemPrompt;
}

function currentTools(session: AgentSession, messages: AgentMessage[]): Tool[] {
  const recorded = getCurrentTools(messages);
  return recorded.length > 0 ? recorded : session.agent.state.tools;
}

function charsByCategory(sections: Record<string, string>): Record<Exclude<ContextCategory, "conversation">, number> {
  const grouped: Record<Exclude<ContextCategory, "conversation">, string[]> = {
    system: [],
    tools: [],
    rules: [],
    skills: [],
  };
  for (const [name, text] of Object.entries(sections)) {
    if (name === "tools") grouped.tools.push(text);
    else if (RULE_SECTIONS.has(name)) grouped.rules.push(text);
    else if (name === "skills") grouped.skills.push(text);
    else grouped.system.push(text);
  }
  return {
    system: grouped.system.join("\n\n").length,
    tools: grouped.tools.join("\n\n").length,
    rules: grouped.rules.join("\n\n").length,
    skills: grouped.skills.join("\n\n").length,
  };
}

function toolDeclarationChars(tools: Tool[]): number {
  if (tools.length === 0) return 0;
  try {
    return JSON.stringify(tools.map((tool) => toToolDeclaration(tool))).length;
  } catch {
    return tools.reduce((sum, tool) => sum + tool.name.length + tool.description.length, 0);
  }
}

function conversationTokens(messages: AgentMessage[], streaming: AgentMessage | undefined): number {
  let tokens = 0;
  for (const message of messages) {
    if (message.role === "system") continue;
    tokens += estimateTokens(message);
  }
  if (streaming && streaming.role !== "system" && !messages.includes(streaming)) {
    tokens += estimateTokens(streaming);
  }
  return tokens;
}

/**
 * 模型回报的总量比按字符估算更准。两者差距太大时（例如提示词还没写入会话），保留估算值。
 */
function scaleSegments(segments: ContextSegments, target: number): ContextSegments | null {
  const estimated = sumSegments(segments);
  if (estimated <= 0 || target <= 0) return null;
  const factor = target / estimated;
  if (factor < 0.25 || factor > 4) return null;

  const scaled = emptyContextSegments();
  const fractions: { id: ContextCategory; fraction: number }[] = [];
  let assigned = 0;
  for (const id of contextCategories) {
    const raw = segments[id] * factor;
    const base = Math.floor(raw);
    scaled[id] = base;
    assigned += base;
    fractions.push({ id, fraction: raw - base });
  }
  let remain = target - assigned;
  fractions.sort((left, right) => right.fraction - left.fraction);
  for (const item of fractions) {
    if (remain <= 0) break;
    scaled[item.id] += 1;
    remain -= 1;
  }
  return scaled;
}

function sumSegments(segments: ContextSegments): number {
  return contextCategories.reduce((sum, id) => sum + segments[id], 0);
}

function charsToTokens(chars: number): number {
  return chars > 0 ? Math.ceil(chars / 4) : 0;
}

function positiveCount(value: number | null | undefined): number | null {
  return value != null && value > 0 ? value : null;
}

function openingTag(line: string): string | null {
  if (!line.startsWith("<") || !line.endsWith(">") || line.startsWith("</")) return null;
  const name = line.slice(1, -1);
  return SECTION_NAME.test(name) ? name : null;
}
