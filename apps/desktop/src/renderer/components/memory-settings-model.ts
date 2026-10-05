/**
 * 记忆设置页的纯逻辑：草稿存储、字节数、结果与错误文案。
 * 组件负责展示与调用 IPC；这里保持无 React 依赖，便于定向测试。
 */
import {
  memoryFileMaxBytes,
  type MemoryCatalogEntry,
  type MemoryErrorCode,
  type MemoryFailure,
  type MemoryScope,
} from "@vela/shared";
import { uiStorage } from "../ui-storage";
import type { SettingsCopy } from "./settings-copy";

type MemoryCopy = SettingsCopy["memory"];

/** 未保存草稿按目标保存；baseRevision 记录草稿基于的文件版本，冲突检查仍走服务。 */
export interface MemoryDraft {
  content: string;
  baseRevision: string;
  savedAt: number;
}

export function memoryDraftKey(scope: MemoryScope, workspace: string | null): string {
  return `vela.memory.draft:${scope}:${workspace ?? ""}`;
}

function readJson(key: string): MemoryDraft | null {
  try {
    const raw = uiStorage.getItem(key);
    if (!raw) return null;
    const draft = JSON.parse(raw) as MemoryDraft;
    if (typeof draft?.content !== "string" || typeof draft.baseRevision !== "string") return null;
    return draft;
  } catch {
    return null;
  }
}

export function readMemoryDraft(key: string): MemoryDraft | null {
  return readJson(key);
}

export function writeMemoryDraft(key: string, content: string, baseRevision: string): void {
  try {
    uiStorage.setItem(key, JSON.stringify({ content, baseRevision, savedAt: Date.now() } satisfies MemoryDraft));
  } catch {
    // 存储不可用时草稿只在当前会话内保留。
  }
}

export function clearMemoryDraft(key: string): void {
  try {
    uiStorage.removeItem(key);
  } catch {
    // 同上。
  }
}

/** 记忆文件的 UTF-8 字节数，与服务端的上限判断一致。 */
export function memoryBytes(content: string): number {
  return new TextEncoder().encode(content).byteLength;
}

export function memoryOverLimit(content: string): boolean {
  return memoryBytes(content) > memoryFileMaxBytes;
}

/** 文件所在目录；用于在文件管理器中定位，不引入 Node path。 */
export function memoryParentDirectory(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index > 0 ? path.slice(0, index) : path;
}

export function memoryCatalogEntryLabel(entry: MemoryCatalogEntry, copy: MemoryCopy): string {
  return entry.scope === "global" ? copy.global : entry.name;
}

export function memoryCatalogEntryStatus(entry: MemoryCatalogEntry, copy: MemoryCopy): string {
  if (entry.status === "loaded") return copy.statusLoaded(entry.bytes);
  if (entry.status === "missing") return copy.statusMissing;
  return copy.statusFailed;
}

/** 把错误码映射到可操作文案；没有专门文案时退回服务端消息。 */
export function memoryErrorText(failure: MemoryFailure, copy: MemoryCopy): string {
  const code = failure.code as MemoryErrorCode;
  return copy.errors[code] ?? failure.message ?? copy.errors["io-error"];
}

/** 兜底处理被 IPC 包装的异常。 */
export function memoryUnexpectedError(error: unknown, copy: MemoryCopy): string {
  return error instanceof Error && error.message ? error.message : copy.errors["io-error"];
}
