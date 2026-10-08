import type { AgentRuntime } from "@vela/agent";
import type { ConversationSyncResult } from "@vela/shared";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const inside = (root: string, file: string) => {
  const path = relative(root, file);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

export interface ConversationSyncOptions {
  /** 批次目录名；同步后的历史文件放在 sessions/production-sync/<batch>。 */
  batch?: string;
  /** 只校验并统计将导入的会话，不复制 trace / 检查点，也不写入目标。 */
  dryRun?: boolean;
  /** 导入完成后报告新增的会话 ID，供批次记录使用。 */
  onImported?: (ids: string[]) => void;
}

/** 从正式版读取一次历史快照，目标索引由 Runtime 合并；源资料始终只读。 */
export async function syncProductionConversations(
  runtime: Pick<AgentRuntime, "importConversations">,
  sourceHome: string,
  destinationHome: string,
  options: ConversationSyncOptions = {},
): Promise<ConversationSyncResult> {
  await mkdir(destinationHome, { recursive: true });
  let source: string;
  try { source = await realpath(sourceHome); }
  catch (error) { if (missing(error)) throw new Error("没有找到正式版会话，请先在正式版创建会话"); throw error; }
  const destination = resolve(destinationHome);
  if (source === await realpath(destination)) throw new Error("开发版正在使用正式版资料目录，无需同步");
  const batch = options.batch ?? randomUUID();
  const dryRun = options.dryRun === true;
  let planned = 0;
  const importedIds: string[] = [];
  const stage = join(destination, `.conversation-sync-${batch}`);
  const sessionRoot = join(destination, "sessions", "production-sync", batch);
  const published: string[] = [];
  const result: ConversationSyncResult = { imported: 0, existing: 0, unavailable: 0 };

  async function safeFile(file: string): Promise<string> {
    const absolute = resolve(file);
    if (!inside(source, await realpath(absolute)) || !(await lstat(absolute)).isFile()) {
      throw new Error("会话文件不在正式版资料目录中");
    }
    return absolute;
  }

  function rewritePaths(value: unknown, paths: Map<string, string>): unknown {
    if (Array.isArray(value)) return value.map(item => rewritePaths(item, paths));
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
      if ((key === "sessionFile" || key === "parentSession") && typeof item === "string") {
        const next = paths.get(resolve(item));
        if (key === "parentSession" && !next) return [];
        return [[key, next ?? null]];
      }
      return [[key, rewritePaths(item, paths)]];
    }));
  }

  async function copyTree(from: string, to: string, paths: Map<string, string>): Promise<void> {
    if (!inside(source, await realpath(from))) throw new Error("历史文件超出正式版资料目录");
    const stat = await lstat(from);
    if (stat.isDirectory()) {
      await mkdir(to, { recursive: true, mode: 0o700 });
      for (const name of await readdir(from)) await copyTree(join(from, name), join(to, name), paths);
    } else if (stat.isFile()) {
      await mkdir(dirname(to), { recursive: true, mode: 0o700 });
      if (from.endsWith(".json")) {
        const data = rewritePaths(JSON.parse(await readFile(from, "utf8")), paths);
        await writeFile(to, `${JSON.stringify(data)}\n`, { mode: 0o600, flag: "wx" });
      } else await copyFile(from, to, constants.COPYFILE_EXCL);
    } else throw new Error("历史文件包含符号链接或不可读取的文件");
  }

  try {
    result.imported = await runtime.importConversations(async knownIds => {
      let raw: string;
      try { raw = await readFile(join(source, "conversations.json"), "utf8"); }
      catch (error) { if (missing(error)) throw new Error("没有找到正式版会话，请先在正式版创建会话"); throw error; }
      let index: { version?: number; conversations?: unknown };
      try { index = JSON.parse(raw); }
      catch { throw new Error("正式版会话索引损坏，请在正式版确认会话可以正常读取后重试"); }
      if (!index || ![1, 2].includes(index.version ?? 1) || !Array.isArray(index.conversations)) {
        throw new Error("正式版会话索引格式不受支持");
      }
      await mkdir(join(stage, "sessions"), { recursive: true, mode: 0o700 });
      const entries: unknown[] = [];
      const seen = new Set(knownIds);
      const moves: Array<[string, string]> = [];
      for (const value of index.conversations) {
        const entry = value && typeof value === "object" ? value as Record<string, unknown> : null;
        if (!entry || typeof entry.id !== "string" || !/^[\w-]+$/.test(entry.id) || typeof entry.cwd !== "string" || typeof entry.sessionFile !== "string") {
          result.unavailable++; continue;
        }
        if (seen.has(entry.id)) { result.existing++; continue; }
        const id = entry.id;
        const folder = join(stage, "sessions", id);
        const ancillary = join(stage, "ancillary", id);
        const paths = new Map<string, string>();
        const files: Array<{ from: string; staged: string; lines: unknown[] }> = [];
        try {
          const agents = Array.isArray(entry.agents) ? entry.agents : [];
          const sessionFiles = [entry.sessionFile, ...agents.flatMap(agent =>
            agent && typeof agent.sessionFile === "string" ? [agent.sessionFile] : [])];
          for (const file of new Set(sessionFiles)) {
            const from = await safeFile(file);
            const name = `${files.length}.jsonl`;
            const contents = await readFile(from, "utf8");
            const lines = contents.split("\n").filter(Boolean);
            const parsed: unknown[] = [];
            for (let i = 0; i < lines.length; i++) {
              try { parsed.push(JSON.parse(lines[i]!)); }
              catch (error) {
                // 正式版可能正在追加末行，复制最后一个完整记录为止。
                if (i !== lines.length - 1 || contents.endsWith("\n")) throw error;
              }
            }
            const header = parsed[0] as { type?: string; id?: string } | undefined;
            if (header?.type !== "session" || (files.length === 0 && header.id !== id)) throw new Error("会话文件损坏");
            paths.set(from, join(sessionRoot, id, name));
            files.push({ from, staged: join(folder, name), lines: parsed });
          }
          await mkdir(folder, { recursive: true, mode: 0o700 });
          for (const file of files) {
            await writeFile(file.staged, file.lines.map(line => JSON.stringify(rewritePaths(line, paths))).join("\n") + "\n", { mode: 0o600 });
            SessionManager.open(file.staged, dirname(file.staged), entry.cwd).buildSessionProjection();
          }
          const entryMoves: Array<[string, string]> = [];
          for (const [from, to] of dryRun ? [] : [
            [join(source, "traces", `${id}.jsonl`), join(destination, "traces", `${id}.jsonl`)],
            [join(source, "checkpoints", id), join(destination, "checkpoints", id)],
          ]) {
            try { await lstat(from!); } catch (error) { if (missing(error)) continue; throw error; }
            const staged = join(ancillary, relative(destination, to!));
            await copyTree(from!, staged, paths);
            entryMoves.push([staged, to!]);
          }
          const copied = rewritePaths(entry, paths) as Record<string, unknown>;
          delete copied.recipeRunId;
          delete copied.recipeExecution;
          entries.push(copied);
          moves.push(...entryMoves);
          seen.add(id);
        } catch (error) {
          if (!missing(error) && !(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code) throw error;
          result.unavailable++;
          await rm(folder, { recursive: true, force: true });
          await rm(ancillary, { recursive: true, force: true });
        }
      }
      planned = entries.length;
      if (!entries.length || dryRun) return [];
      moves.unshift([join(stage, "sessions"), sessionRoot]);
      for (const [, to] of moves) {
        try { await lstat(to); throw new Error("目标已有同名历史文件，请检查开发版资料目录后重试"); }
        catch (error) { if (!missing(error)) throw error; }
      }
      for (const [from, to] of moves) {
        await mkdir(dirname(to), { recursive: true, mode: 0o700 });
        await rename(from, to);
        published.push(to);
      }
      importedIds.push(...entries.map(entry => (entry as { id: string }).id));
      return entries;
    }).then(count => {
      if (dryRun) return planned;
      options.onImported?.(importedIds);
      return count;
    });
    return result;
  } catch (error) {
    for (const path of published.reverse()) await rm(path, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
