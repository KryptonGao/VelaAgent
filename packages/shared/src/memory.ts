/**
 * 记忆的共享契约：作用域、目标身份、revision、错误码与加载状态。
 * 文件是唯一内容来源；这里只定义类型，读写由 @vela/agent 的 MemoryService 负责。
 */

/** 全局记忆跨项目复用；项目记忆绑定会话自己的工作区。 */
export const memoryScopes = ["global", "project"] as const;

export type MemoryScope = (typeof memoryScopes)[number];

/** 单个记忆文件的 UTF-8 字节上限；超限不截断，跳过加载并保留现场。 */
export const memoryFileMaxBytes = 16 * 1024;

/** 目标文件不存在时的版本指纹；必须与空文件的指纹不同。 */
export const memoryAbsentRevision = "absent";

/** 内容指纹。它标识一次读取看到的版本，用于保存和删除时的冲突检查。 */
export type MemoryRevision = string;

/** 记忆目标身份。项目目标必须给出会话工作区的绝对路径，不接受任意文件路径。 */
export interface MemoryTarget {
  scope: MemoryScope;
  /** 项目记忆为工作区绝对路径；全局记忆为 null。 */
  workspace: string | null;
}

export interface MemoryDocument {
  scope: MemoryScope;
  /** 项目记忆为工作区真实路径；全局记忆为 null。 */
  workspace: string | null;
  path: string;
  exists: boolean;
  content: string;
  revision: MemoryRevision;
}

export const memoryErrorCodes = [
  "invalid-target",
  "invalid-content",
  "content-too-large",
  "invalid-encoding",
  "unsafe-path",
  "not-a-file",
  "unavailable",
  "conflict",
  "busy",
  "io-error",
] as const;

export type MemoryErrorCode = (typeof memoryErrorCodes)[number];

/** 一次执行中每个来源的加载状态。 */
export type MemoryLoadStatus = "loaded" | "missing" | "failed";

/** 单个来源的加载结果；加载失败不抛出，由调用方决定如何提示。 */
export interface MemorySourceLoad {
  scope: MemoryScope;
  workspace: string | null;
  path: string | null;
  status: MemoryLoadStatus;
  content: string;
  revision: MemoryRevision | null;
  bytes: number;
  error: MemoryErrorCode | null;
  message: string | null;
}

/**
 * 加载状态的可见子集：不含正文，可以安全地进入界面状态、事件和日志。
 * 正文只存在于当次请求的提示词里，不会复制到持久化状态。
 */
export interface MemoryLoadReport {
  scope: MemoryScope;
  workspace: string | null;
  path: string | null;
  status: MemoryLoadStatus;
  bytes: number;
  error: MemoryErrorCode | null;
  message: string | null;
}

export function memoryLoadReport(load: MemorySourceLoad): MemoryLoadReport {
  return {
    scope: load.scope,
    workspace: load.workspace,
    path: load.path,
    status: load.status,
    bytes: load.bytes,
    error: load.error,
    message: load.message,
  };
}

// ---------- 设置页管理入口 ----------

/** 记忆管理入口的目标；项目目标用已登记的工作区路径标识，主进程负责校验。 */
export interface MemoryTargetInput {
  scope: MemoryScope;
  /** 项目记忆的工作区绝对路径；全局记忆为 null 或缺省。 */
  workspace?: string | null;
}

export interface MemoryListInput {
  /** 当前会话；主进程用它推导默认项目，不直接信任 renderer 传来的工作区身份。 */
  conversationId?: string | null;
}

export interface MemorySaveInput extends MemoryTargetInput {
  content: string;
  /** 读取时拿到的 revision；冲突时保留原文件并返回 conflict。 */
  expectedRevision: MemoryRevision;
}

export interface MemoryRemoveInput extends MemoryTargetInput {
  expectedRevision: MemoryRevision;
}

/** 已登记的工作区；available 为 false 表示目录已失效，仍保留在列表里。 */
export interface MemoryProject {
  workspace: string;
  name: string;
  available: boolean;
}

/** “全部记忆”列表里的一项；只含元数据，选中后再读取正文。 */
export interface MemoryCatalogEntry {
  scope: MemoryScope;
  workspace: string | null;
  /** 项目名（工作区目录名）；全局记忆为空字符串。 */
  name: string;
  path: string;
  exists: boolean;
  status: MemoryLoadStatus;
  bytes: number;
  revision: MemoryRevision | null;
  error: MemoryErrorCode | null;
  message: string | null;
}

export interface MemoryCatalog {
  /** Agent 记忆总开关；不影响设置页管理或删除文件。 */
  enabled: boolean;
  global: MemoryCatalogEntry;
  projects: MemoryCatalogEntry[];
  /** 已登记的工作区，供“项目记忆”选择器使用。 */
  workspaces: MemoryProject[];
  /** 当前会话的实际项目；无项目时为空。 */
  currentProject: string | null;
}

/** 可预期的记忆操作失败；IPC 用结果返回，不作为异常抛出。 */
export interface MemoryFailure {
  code: MemoryErrorCode;
  message: string;
  path: string | null;
}

export type MemoryResult<T> = { ok: true; value: T } | { ok: false; error: MemoryFailure };

/** 设置页记忆管理接口；正文由 read 单独返回，列表只含元数据。 */
export interface MemoryApi {
  setEnabled(input: { enabled: boolean }): Promise<MemoryResult<{ enabled: boolean }>>;
  list(input?: MemoryListInput): Promise<MemoryResult<MemoryCatalog>>;
  read(input: MemoryTargetInput): Promise<MemoryResult<MemoryDocument>>;
  save(input: MemorySaveInput): Promise<MemoryResult<MemoryDocument>>;
  remove(input: MemoryRemoveInput): Promise<MemoryResult<null>>;
}
