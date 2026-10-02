import type { ToolTrace } from "@vela/shared";
import type { UiMessage } from "../hooks/useSession";

export interface TurnFileChange {
  path: string;
  added: number;
  removed: number;
  diffs: string[];
}

export interface TurnChanges {
  files: TurnFileChange[];
  added: number;
  removed: number;
}

export interface TurnReviewRequest {
  /** 本轮最后一条 assistant 消息的 ID。 */
  turnId: string;
  changes: TurnChanges;
}

function displayPath(path: string, workspaceRoot: string | null): string {
  const normalized = path.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  const root = workspaceRoot?.replaceAll("\\", "/").replace(/\/+$/, "");
  return root && normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : normalized;
}

function diffLines(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (/^\+(?!\+\+)\s*\d+ /.test(line)) added += 1;
    else if (/^-(?!--)\s*\d+ /.test(line)) removed += 1;
  }
  return { added, removed };
}

export function summarizeTurnChanges(tools: ToolTrace[], workspaceRoot: string | null): TurnChanges | null {
  const files = new Map<string, TurnFileChange>();
  for (const tool of tools) {
    if (tool.status !== "done" || (tool.name !== "edit" && tool.name !== "write")) continue;
    const path = tool.activity?.path && displayPath(tool.activity.path, workspaceRoot);
    if (!path) continue;
    const file = files.get(path) ?? { path, added: 0, removed: 0, diffs: [] };
    const diff = tool.activity?.diff;
    if (diff) {
      const stat = diffLines(diff);
      file.added += stat.added;
      file.removed += stat.removed;
      file.diffs.push(diff);
    }
    files.set(path, file);
  }
  if (files.size === 0) return null;
  const values = [...files.values()];
  return {
    files: values,
    added: values.reduce((sum, file) => sum + file.added, 0),
    removed: values.reduce((sum, file) => sum + file.removed, 0),
  };
}

/** 一轮可能有多条 assistant 消息；卡片只挂在该轮最后一条回复之后。 */
export function changesByFinalMessage(
  messages: UiMessage[],
  streaming: boolean,
  workspaceRoot: string | null,
): Map<string, TurnChanges> {
  const cards = new Map<string, TurnChanges>();
  let tools: ToolTrace[] = [];
  let lastAssistant: UiMessage | null = null;
  const finishTurn = () => {
    if (lastAssistant) {
      const changes = summarizeTurnChanges(tools, workspaceRoot);
      if (changes) cards.set(lastAssistant.id, changes);
    }
    tools = [];
    lastAssistant = null;
  };
  for (const message of messages) {
    if (message.role === "user") finishTurn();
    else {
      lastAssistant = message;
      tools.push(...message.tools);
    }
  }
  if (!streaming) finishTurn();
  return cards;
}
