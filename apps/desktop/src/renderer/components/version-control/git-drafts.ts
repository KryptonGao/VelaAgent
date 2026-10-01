import { uiStorage } from "../../ui-storage";

export interface CommitDraft {
  title: string;
  body: string;
  savedAt: number;
}

export interface PrDraft {
  title: string;
  body: string;
  base: string;
  draftFlag: boolean;
  savedAt: number;
}

function storageKey(prefix: string, workspace: string | null, branch: string | null, head: string | null): string {
  return `vela.vc.${prefix}:${workspace ?? ""}|${branch ?? ""}|${head ?? ""}`;
}

/** Detached HEAD 按提交定位草稿;同工作树同分支的多个聊天共享同一份草稿。 */
export function commitDraftKey(workspace: string | null, branch: string | null, head: string | null): string {
  return storageKey("commitDraft", workspace, branch, head);
}

export function prDraftKey(workspace: string | null, branch: string | null, base: string | null): string {
  return storageKey("prDraft", workspace, branch, base);
}

function readJson<T>(key: string): T | null {
  try {
    const raw = uiStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown | null): void {
  try {
    if (value === null) uiStorage.removeItem(key);
    else uiStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 存储不可用时草稿只在当前会话内有效。
  }
}

export function readCommitDraft(key: string): CommitDraft | null {
  const draft = readJson<CommitDraft>(key);
  if (!draft || typeof draft.title !== "string" || typeof draft.body !== "string") return null;
  return draft;
}

export function writeCommitDraft(key: string, draft: Omit<CommitDraft, "savedAt">): void {
  writeJson(key, { ...draft, savedAt: Date.now() } satisfies CommitDraft);
}

export function clearCommitDraft(key: string): void {
  writeJson(key, null);
}

export function readPrDraft(key: string): PrDraft | null {
  const draft = readJson<PrDraft>(key);
  if (!draft || typeof draft.title !== "string" || typeof draft.body !== "string") return null;
  return draft;
}

export function writePrDraft(key: string, draft: Omit<PrDraft, "savedAt">): void {
  writeJson(key, { ...draft, savedAt: Date.now() } satisfies PrDraft);
}

export function clearPrDraft(key: string): void {
  writeJson(key, null);
}
