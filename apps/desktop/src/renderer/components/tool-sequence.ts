import type { ToolTrace } from "@vela/shared";
import type { ToolDisplay } from "../hooks/usePreferences";
import type { UiMessage } from "../hooks/useSession";

/** 可折叠的工具种类,与 tool-compact 的 toolCompactKind 保持一致。 */
const foldableToolNames = new Set(["bash", "read", "edit", "write"]);

/** 同一段里连续工具达到该数量才折叠成一组。 */
export const RUN_MIN = 3;

/** 卡片模式至少 RUN_MIN 个才折叠;紧凑模式超过 1 个就折叠成摘要。 */
export function shouldFoldRun(length: number, display: ToolDisplay): boolean {
  return display === "compact" ? length > 1 : length >= RUN_MIN;
}

/** 按界面顺序拍平后的回合内容,用于跨 Assistant 消息做位置分组。 */
export type ProcessItem =
  | { kind: "thinking"; id: string; messageId: string; text: string }
  | { kind: "text"; id: string; messageId: string; text: string }
  | { kind: "tool"; id: string; messageId: string; tool: ToolTrace };

/** 渲染节点:单个内容,或一段被折叠的工具。 */
export type ProcessNode =
  | { type: "thinking"; id: string; messageId: string; text: string }
  | { type: "text"; id: string; messageId: string; text: string }
  | { type: "tool"; id: string; messageId: string; tool: ToolTrace }
  | { type: "run"; id: string; messageId: string; tools: ToolTrace[] };

/** 把一轮里的助理消息按界面顺序拍平:思考、工具、正文。 */
export function buildTurnItems(
  messages: UiMessage[],
  options: { includeText?: (message: UiMessage) => boolean } = {},
): ProcessItem[] {
  const items: ProcessItem[] = [];
  for (const message of messages) {
    if (message.thinking) items.push({ kind: "thinking", id: message.id, messageId: message.id, text: message.thinking });
    for (const tool of message.tools) {
      items.push({ kind: "tool", id: tool.id, messageId: message.id, tool });
    }
    if (message.text && (options.includeText?.(message) ?? true)) {
      items.push({ kind: "text", id: `${message.id}:text`, messageId: message.id, text: message.text });
    }
  }
  return items;
}

/**
 * 位置关系分组:相邻的可折叠工具合成一段,中间不看消息边界。
 * 思考、可见正文和交互卡片等不可折叠工具都会打断分组,阈值沿用卡片/紧凑规则。
 */
export function groupProcessItems(items: ProcessItem[], display: ToolDisplay): ProcessNode[] {
  const nodes: ProcessNode[] = [];
  let run: Extract<ProcessItem, { kind: "tool" }>[] = [];

  const flush = () => {
    if (run.length === 0) return;
    const tools = run.map((item) => item.tool);
    if (shouldFoldRun(tools.length, display)) {
      nodes.push({ type: "run", id: run[0]!.id, messageId: run[0]!.messageId, tools });
    } else {
      for (const item of run) {
        nodes.push({ type: "tool", id: item.id, messageId: item.messageId, tool: item.tool });
      }
    }
    run = [];
  };

  for (const item of items) {
    if (item.kind === "tool" && foldableToolNames.has(item.tool.name)) {
      run.push(item);
      continue;
    }
    flush();
    if (item.kind === "tool") nodes.push({ type: "tool", id: item.id, messageId: item.messageId, tool: item.tool });
    else nodes.push({ type: item.kind, id: item.id, messageId: item.messageId, text: item.text });
  }
  flush();
  return nodes;
}
