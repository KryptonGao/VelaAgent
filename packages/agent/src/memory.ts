import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, rm, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import {
  memoryAbsentRevision,
  memoryFileMaxBytes,
  memoryScopes,
  type MemoryDocument,
  type MemoryErrorCode,
  type MemoryScope,
  type MemorySourceLoad,
  type MemoryTarget,
} from "@vela/shared";

/** 项目记忆固定存放在工作区的这个目录；首次保存时才创建。 */
export const memoryDirectoryName = ".vela";
export const memoryFileName = "MEMORY.md";
/** 同目录独占锁的扩展名；跨 Vela 进程协调写入。 */
export const memoryLockSuffix = ".lock";

const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** 记忆存储错误。code 供调用方区分冲突、忙碌和文件问题，path 便于定位。 */
export class MemoryError extends Error {
  readonly code: MemoryErrorCode;
  readonly path: string | null;

  constructor(code: MemoryErrorCode, message: string, path: string | null = null) {
    super(message);
    this.name = "MemoryError";
    this.code = code;
    this.path = path;
  }
}

export interface MemoryServiceOptions {
  /** Vela 资料目录（profile）；全局记忆固定为 <agentDir>/MEMORY.md。 */
  agentDir: string;
}

/** 解析后的目标：root 是工作区或资料目录的真实路径，path 是记忆文件。 */
interface ResolvedTarget {
  scope: MemoryScope;
  workspace: string | null;
  root: string;
  path: string;
}

interface MemoryState {
  exists: boolean;
  revision: string;
  bytes: Buffer;
}

interface MemoryLock {
  release: () => Promise<void>;
}

/** 内容指纹；对 UTF-8 字节做 sha256。 */
export function memoryRevision(content: string): string {
  return hashBytes(Buffer.from(content, "utf8"));
}

/**
 * 记忆文件存储。路径只有两种：<agentDir>/MEMORY.md 和 <workspace>/.vela/MEMORY.md；
 * 不接受任意文件路径，写入按规范化路径串行并配合同目录独占锁和原子替换。
 */
export class MemoryService {
  private readonly agentDir: string;

  constructor(options: MemoryServiceOptions) {
    const agentDir = options?.agentDir;
    if (typeof agentDir !== "string" || !agentDir.trim()) {
      throw new MemoryError("invalid-target", "记忆服务缺少 Vela 资料目录");
    }
    this.agentDir = resolve(agentDir);
  }

  /** 读取记忆全文与 revision；文件缺失时 exists 为 false，且不创建任何目录或文件。 */
  async read(target: MemoryTarget): Promise<MemoryDocument> {
    try {
      const resolved = await this.resolveTarget(target);
      await this.ensureDirectory(resolved, false);
      const state = await readMemoryState(resolved.path);
      if (!state.exists) {
        return {
          scope: resolved.scope,
          workspace: resolved.workspace,
          path: resolved.path,
          exists: false,
          content: "",
          revision: memoryAbsentRevision,
        };
      }
      return {
        scope: resolved.scope,
        workspace: resolved.workspace,
        path: resolved.path,
        exists: true,
        content: decodeUtf8(state.bytes, resolved.path),
        revision: state.revision,
      };
    } catch (error) {
      throw toMemoryError(error, "读取记忆失败", null);
    }
  }

  /** 读取加载状态；失败以状态返回而不是抛出，供上下文加载逐个来源处理。 */
  async load(target: MemoryTarget): Promise<MemorySourceLoad> {
    const scope: MemoryScope = target?.scope === "project" ? "project" : "global";
    const workspace = scope === "project" && typeof target?.workspace === "string" ? target.workspace : null;
    try {
      const document = await this.read(target);
      return {
        scope: document.scope,
        workspace: document.workspace,
        path: document.path,
        status: document.exists ? "loaded" : "missing",
        content: document.content,
        revision: document.revision,
        bytes: Buffer.byteLength(document.content, "utf8"),
        error: null,
        message: null,
      };
    } catch (error) {
      const failure = toMemoryError(error, "读取记忆失败", null);
      return {
        scope,
        workspace,
        path: failure.path,
        status: "failed",
        content: "",
        revision: null,
        bytes: 0,
        error: failure.code,
        message: failure.message,
      };
    }
  }

  /**
   * 保存完整文档；content 为空表示清空，但保留文件。
   * expectedRevision 来自读取，版本不一致时拒绝写入并保留原内容。
   */
  async save(target: MemoryTarget, content: string, expectedRevision: string, assertAllowed?: () => void): Promise<MemoryDocument> {
    assertAllowed?.();
    if (typeof content !== "string") throw new MemoryError("invalid-content", "记忆内容必须是文本");
    requireExpectedRevision(expectedRevision);
    const bytes = Buffer.from(content, "utf8");
    if (bytes.byteLength > memoryFileMaxBytes) {
      throw new MemoryError("content-too-large", `记忆文件最多 ${memoryFileMaxBytes / 1024} KiB，已保留原内容`);
    }
    try {
      const resolved = await this.resolveTarget(target);
      return await withWriteQueue(resolved.path, async () => {
        assertAllowed?.();
        await this.ensureDirectory(resolved, true);
        const lock = await acquireMemoryLock(resolved.path);
        try {
          const current = await readMemoryState(resolved.path);
          if (current.revision !== expectedRevision) throw conflictError(resolved.path, expectedRevision, current.revision);
          await replaceFileAtomically(resolved.path, bytes, assertAllowed);
          await syncDirectory(dirname(resolved.path));
          return {
            scope: resolved.scope,
            workspace: resolved.workspace,
            path: resolved.path,
            exists: true,
            content,
            revision: hashBytes(bytes),
          };
        } finally {
          await lock.release();
        }
      });
    } catch (error) {
      throw toMemoryError(error, "保存记忆失败", null);
    }
  }

  /** 删除记忆文件；同样要版本检查、文件和目录检查以及独占锁。 */
  async remove(target: MemoryTarget, expectedRevision: string): Promise<void> {
    requireExpectedRevision(expectedRevision);
    try {
      const resolved = await this.resolveTarget(target);
      await withWriteQueue(resolved.path, async () => {
        const directoryExists = await this.ensureDirectory(resolved, false);
        if (!directoryExists) {
          if (expectedRevision !== memoryAbsentRevision) throw conflictError(resolved.path, expectedRevision, memoryAbsentRevision);
          return;
        }
        const lock = await acquireMemoryLock(resolved.path);
        try {
          const current = await readMemoryState(resolved.path);
          if (current.revision !== expectedRevision) throw conflictError(resolved.path, expectedRevision, current.revision);
          if (!current.exists) return;
          try {
            await unlink(resolved.path);
          } catch (error) {
            throw ioError(error, resolved.path, "删除记忆文件失败");
          }
          await syncDirectory(dirname(resolved.path));
        } finally {
          await lock.release();
        }
      });
    } catch (error) {
      throw toMemoryError(error, "删除记忆失败", null);
    }
  }

  /** 解析目标身份。项目目标必须是已存在的绝对工作区目录。 */
  private async resolveTarget(target: MemoryTarget): Promise<ResolvedTarget> {
    if (!target || typeof target !== "object" || !memoryScopes.includes(target.scope)) {
      throw new MemoryError("invalid-target", "记忆作用域不正确");
    }
    if (target.scope === "global") {
      if (target.workspace !== null && target.workspace !== undefined) {
        throw new MemoryError("invalid-target", "全局记忆不接受工作区路径");
      }
      const root = await this.resolveGlobalRoot();
      return { scope: "global", workspace: null, root, path: join(root, memoryFileName) };
    }
    const workspace = target.workspace;
    if (typeof workspace !== "string" || !workspace.trim() || !isAbsolute(workspace)) {
      throw new MemoryError("invalid-target", "项目记忆需要会话工作区的绝对路径");
    }
    const requested = resolve(workspace);
    if (requested === parse(requested).root) {
      throw new MemoryError("invalid-target", "项目记忆不接受文件系统根目录", requested);
    }
    const root = await realpath(requested).catch(() => null);
    if (!root) throw new MemoryError("unavailable", "项目目录不存在或无法访问", requested);
    const info = await stat(root).catch(() => null);
    if (!info?.isDirectory()) throw new MemoryError("unavailable", "项目目录不可用", root);
    return { scope: "project", workspace: root, root, path: join(root, memoryDirectoryName, memoryFileName) };
  }

  /** 资料目录是受信任位置，可以解析符号链接；但它必须是目录。 */
  private async resolveGlobalRoot(): Promise<string> {
    const info = await lstatOrNull(this.agentDir);
    if (!info) return this.agentDir;
    if (!info.isSymbolicLink()) {
      if (!info.isDirectory()) throw new MemoryError("unavailable", "Vela 资料目录不是目录", this.agentDir);
      return this.agentDir;
    }
    const real = await realpath(this.agentDir).catch(() => null);
    if (!real) throw new MemoryError("unavailable", "Vela 资料目录无法访问", this.agentDir);
    const resolved = await stat(real).catch(() => null);
    if (!resolved?.isDirectory()) throw new MemoryError("unavailable", "Vela 资料目录无法访问", this.agentDir);
    return real;
  }

  /**
   * 检查记忆目录；create 为 true 时在首次保存时创建。
   * 拒绝符号链接和逃出工作区的真实路径，创建后重新校验。
   */
  private async ensureDirectory(resolved: ResolvedTarget, create: boolean): Promise<boolean> {
    if (resolved.scope === "global") {
      const info = await lstatOrNull(resolved.root);
      if (!info) {
        if (!create) return false;
        await makeDirectory(resolved.root);
        return true;
      }
      if (!info.isDirectory()) throw new MemoryError("unavailable", "Vela 资料目录不是目录", resolved.root);
      return true;
    }
    const dir = dirname(resolved.path);
    const info = await lstatOrNull(dir);
    if (info) {
      if (info.isSymbolicLink()) throw new MemoryError("unsafe-path", "项目记忆目录不能是符号链接", dir);
      if (!info.isDirectory()) throw new MemoryError("unsafe-path", "项目记忆目录不是目录", dir);
      const real = await realpath(dir).catch(() => null);
      if (!real || !isUnder(real, resolved.root)) {
        throw new MemoryError("unsafe-path", "项目记忆目录超出工作区范围", dir);
      }
      return true;
    }
    if (!create) return false;
    await makeDirectory(dir);
    const created = await lstatOrNull(dir);
    if (!created || created.isSymbolicLink() || !created.isDirectory()) {
      throw new MemoryError("unsafe-path", "无法创建项目记忆目录", dir);
    }
    const real = await realpath(dir).catch(() => null);
    if (!real || !isUnder(real, resolved.root)) {
      throw new MemoryError("unsafe-path", "项目记忆目录超出工作区范围", dir);
    }
    return true;
  }
}

function requireExpectedRevision(expectedRevision: string): void {
  if (typeof expectedRevision !== "string" || !expectedRevision) {
    throw new MemoryError("invalid-content", "写入记忆需要读取时的版本指纹");
  }
}

async function makeDirectory(dir: string): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
  } catch (error) {
    throw ioError(error, dir, "无法创建记忆目录");
  }
}

/** 读取当前文件状态；不解码正文，只用于版本比对，所以超限文件也能给出明确错误。 */
async function readMemoryState(path: string): Promise<MemoryState> {
  const info = await lstatOrNull(path);
  if (!info) return { exists: false, revision: memoryAbsentRevision, bytes: Buffer.alloc(0) };
  if (info.isSymbolicLink()) throw new MemoryError("unsafe-path", "记忆文件不能是符号链接", path);
  if (!info.isFile()) throw new MemoryError("not-a-file", "记忆路径不是普通文件", path);
  if (info.size > memoryFileMaxBytes) {
    throw new MemoryError("content-too-large", `记忆文件超过 ${memoryFileMaxBytes} 字节上限，请先用外部编辑器缩减`, path);
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    throw ioError(error, path, "读取记忆文件失败");
  }
  return { exists: true, revision: hashBytes(bytes), bytes };
}

function decodeUtf8(bytes: Uint8Array, path: string): string {
  try {
    return utf8Decoder.decode(bytes);
  } catch {
    throw new MemoryError("invalid-encoding", "记忆文件不是有效的 UTF-8 文本，已跳过加载", path);
  }
}

/**
 * 同目录独占锁：open(wx) 创建成功才算拿到锁，记录 pid 和随机 token。
 * 释放时只删除自己创建的锁；残留锁只报告路径，不自动抢锁。
 */
async function acquireMemoryLock(path: string): Promise<MemoryLock> {
  const lockPath = `${path}${memoryLockSuffix}`;
  const token = randomUUID();
  let handle;
  try {
    handle = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (isErrnoCode(error, "EEXIST")) {
      const holder = await describeLockHolder(lockPath);
      throw new MemoryError(
        "busy",
        `记忆正在被另一个进程写入${holder}；若上次写入已中断，请确认后手动移除 ${lockPath}`,
        lockPath,
      );
    }
    throw ioError(error, lockPath, "无法获取记忆写入锁");
  }
  try {
    await handle.writeFile(JSON.stringify({ version: 1, pid: process.pid, token, startedAt: new Date().toISOString() }));
    await handle.sync();
    await handle.close();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(lockPath, { force: true }).catch(() => undefined);
    throw ioError(error, lockPath, "无法写入记忆写入锁");
  }
  return {
    release: async () => {
      try {
        const text = await readFile(lockPath, "utf8");
        if (!text.includes(token)) return;
        await rm(lockPath, { force: true });
        await syncDirectory(dirname(path));
      } catch {
        // 锁已被外部清理时不再阻塞调用方；异常残留锁由下次写入报告。
      }
    },
  };
}

async function describeLockHolder(lockPath: string): Promise<string> {
  const text = await readFile(lockPath, "utf8").catch(() => null);
  if (!text) return "";
  try {
    const data = JSON.parse(text) as { pid?: unknown; startedAt?: unknown };
    if (typeof data.pid === "number" && Number.isSafeInteger(data.pid)) {
      const since = typeof data.startedAt === "string" ? `，开始于 ${data.startedAt}` : "";
      return `（进程 ${data.pid}${since}）`;
    }
  } catch {
    // 残留锁内容损坏时只提示路径。
  }
  return "";
}

/** 同目录临时文件写入并刷新后原子替换；失败清理临时文件，不动原文件。 */
async function replaceFileAtomically(path: string, bytes: Buffer, assertAllowed?: () => void): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o644);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    assertAllowed?.();
    await rename(temporary, path);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw ioError(error, path, "写入记忆文件失败");
  }
}

/** 尽力刷新目录项，失败不影响已经完成的原子替换。 */
async function syncDirectory(dir: string): Promise<void> {
  try {
    const handle = await open(dir, "r");
    await handle.sync().catch(() => undefined);
    await handle.close().catch(() => undefined);
  } catch {
    // 目录刷新是持久化增强，不属于写入成功条件。
  }
}

async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return null;
    throw error;
  }
}

function hashBytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function isUnder(target: string, root: string): boolean {
  if (target === root) return true;
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return target.startsWith(prefix);
}

function isErrnoCode(error: unknown, code: string): boolean {
  return !!error && typeof error === "object" && (error as NodeJS.ErrnoException).code === code;
}

function ioError(error: unknown, path: string | null, action: string): MemoryError {
  if (error instanceof MemoryError) return error;
  const detail = error instanceof Error ? error.message : String(error);
  return new MemoryError("io-error", `${action}：${detail}`, path);
}

function toMemoryError(error: unknown, action: string, path: string | null): MemoryError {
  return error instanceof MemoryError ? error : ioError(error, path, action);
}

function conflictError(path: string, expected: string, current: string): MemoryError {
  return new MemoryError(
    "conflict",
    `记忆已被其他会话或外部编辑更新（当前版本 ${current}，期望版本 ${expected}）；请重新读取后再保存`,
    path,
  );
}

/** 进程内按规范化路径串行；跨进程由同目录独占锁协调。 */
const writeQueues = new Map<string, Promise<void>>();

async function withWriteQueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(key) ?? Promise.resolve();
  let release = (): void => undefined;
  const gate = new Promise<void>((settle) => {
    release = settle;
  });
  const tail = previous.catch(() => undefined).then(() => gate);
  writeQueues.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
    if (writeQueues.get(key) === tail) writeQueues.delete(key);
  }
}
