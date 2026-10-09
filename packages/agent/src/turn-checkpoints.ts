import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import { access, copyFile, link, lstat, mkdir, readFile, readdir, readlink, rename, rm, symlink, writeFile, chmod } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);
type FileState = { hash: string; mode: number; link?: string };
type Files = Record<string, FileState>;
export interface TurnCheckpoint<T> {
  id: string;
  leaf: string | null;
  userEntryId: string | null;
  before: Files;
  after: Files | null;
  metadata: T;
  unavailableReason?: string;
}
const omitted = new Set([".git", "node_modules", ".pnpm-store", ".venv", "venv", "__pycache__", ".next", "dist", "out", "build", "target",
  ".cache", ".turbo", ".parcel-cache", ".nuxt", ".svelte-kit", ".output", ".gradle", ".mypy_cache", ".pytest_cache", ".ruff_cache", ".tox", "coverage"]);
/** Git-ignored files are tracked so a rewind can undo edits to them, but logs, scratch files and big artifacts are not worth a blob. */
const ignoredNoise = /(^|\/)\.DS_Store$|\.(log|tmp|swp|swo)$|~$/i;
const ignoredLimit = 5 * 1024 * 1024;
/** Files up to this size are read whole; bigger ones are streamed so a capture never holds them in memory. */
const wholeFileLimit = 8 * 1024 * 1024;
/** A cached hash is only trusted when the file was already this old at read time, so a same-tick rewrite cannot hide. */
const racyWindow = 2000;
const hashPattern = /^[a-f0-9]{64}$/;
/** [size, mtimeMs, ctimeMs, ino, hash] of the last read; a matching stat means the file is unchanged and need not be read again. */
type StatEntry = [number, number, number, number, string];
interface CaptureContext { cache: Map<string, StatEntry>; next: Record<string, StatEntry>; known: Set<string>; parents: Set<string> }
interface Candidate { path: string; ignored: boolean }

// Captures and restores share the blob store; cleanup needs it to itself so it never deletes a blob a capture is about to reference.
let exclusive: Promise<void> | null = null;
let active = 0;
const idle: Array<() => void> = [];
export async function sharedAccess<R>(work: () => Promise<R>): Promise<R> {
  while (exclusive) await exclusive;
  active += 1;
  try { return await work(); }
  finally { active -= 1; if (active === 0) for (const wake of idle.splice(0)) wake(); }
}
export async function exclusiveAccess<R>(work: () => Promise<R>): Promise<R> {
  while (exclusive) await exclusive;
  let release!: () => void;
  exclusive = new Promise<void>(resolve => { release = resolve; });
  try {
    while (active > 0) await new Promise<void>(wake => idle.push(wake));
    return await work();
  } finally { exclusive = null; release(); }
}
/** Blobs shared by every conversation live here; a conversation's own `blobs/<hash>` is a hard link to the same file. */
export const sharedDirectory = (root: string) => join(root, ".shared");
const mapLimit = async <I, R>(items: I[], limit: number, work: (item: I) => Promise<R>): Promise<R[]> => {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let index = next++; index < items.length; index = next++) results[index] = await work(items[index]!);
  }));
  return results;
};
/** Hashes of every file blob a point's tables mention. */
export const pointHashes = (point: Pick<TurnCheckpoint<unknown>, "before" | "after">) => {
  const hashes = new Set<string>();
  for (const table of [point.before, point.after]) {
    for (const state of Object.values(table ?? {})) if (state.link === undefined && hashPattern.test(state.hash)) hashes.add(state.hash);
  }
  return hashes;
};
const same = (a: FileState | undefined, b: FileState | undefined) =>
  a?.hash === b?.hash && a?.mode === b?.mode && a?.link === b?.link;
/** Paths a finished turn changed; an unfinished point reports none. */
export const changedPaths = (point: Pick<TurnCheckpoint<unknown>, "before" | "after">) => {
  if (!point.after) return [];
  return [...new Set([...Object.keys(point.before), ...Object.keys(point.after)])].filter(path => !same(point.before[path], point.after![path])).sort();
};
const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
};

/** Persisted before/after file states. Git's index and existing dirty work are never reset. */
export class TurnCheckpoints<T> {
  private readonly shared: string;
  /** `shared` holds the content-addressed blob pool and the stat cache; conversations that share it store each file version once. */
  constructor(private readonly directory: string, private readonly cwd: string, private readonly excluded: string, shared?: string) {
    this.shared = shared ?? join(directory, ".shared");
  }

  private file(id: string) { return join(this.directory, `${id}.json`); }
  private blob(hash: string) { return join(this.directory, "blobs", hash); }
  private pooled(hash: string) { return join(this.shared, "blobs", hash); }
  private async save(point: TurnCheckpoint<T>) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temp = `${this.file(point.id)}.tmp`;
    await writeFile(temp, JSON.stringify(point), { mode: 0o600 });
    await rename(temp, this.file(point.id));
  }
  async list(): Promise<TurnCheckpoint<T>[]> {
    return sharedAccess(() => this.readAll());
  }
  private async readAll(): Promise<TurnCheckpoint<T>[]> {
    let names: string[];
    try { names = await readdir(this.directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const points = await Promise.all(names.filter(name => name.endsWith(".json")).map(async name => {
      try { return JSON.parse(await readFile(join(this.directory, name), "utf8")) as TurnCheckpoint<T>; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    }));
    return points.filter((point): point is TurnCheckpoint<T> => point !== null);
  }
  async begin(leaf: string | null, metadata: T): Promise<TurnCheckpoint<T>> {
    return sharedAccess(async () => {
      const point = { id: randomUUID(), leaf, userEntryId: null, before: await this.capture(), after: null, metadata };
      await this.save(point);
      return point;
    });
  }
  async finish(point: TurnCheckpoint<T>, userEntryId: string | null) {
    await sharedAccess(async () => {
      point.userEntryId = userEntryId;
      point.after = await this.capture();
      await this.save(point);
    });
  }
  async remove(points: TurnCheckpoint<T>[]) {
    await exclusiveAccess(async () => {
      for (const point of points) await rm(this.file(point.id), { force: true });
      await this.release();
    });
  }
  /** Keep this conversation's newest `keep` points; older ones can no longer be rewound to. Returns how many were removed. */
  async prune(keep: number): Promise<number> {
    let names: string[];
    try { names = (await readdir(this.directory)).filter(name => name.endsWith(".json")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0; throw error; }
    if (names.length <= Math.max(1, keep)) return 0;
    return exclusiveAccess(async () => {
      const dated = await Promise.all((await this.readAll()).map(async point => ({ point, time: (await lstat(this.file(point.id)).catch(() => null))?.mtimeMs ?? 0 })));
      // A point still being captured has no `after`; it is not safe to drop until the turn ends.
      const old = dated.sort((a, b) => a.time - b.time).slice(0, Math.max(0, dated.length - Math.max(1, keep))).filter(({ point }) => point.after);
      for (const { point } of old) await rm(this.file(point.id), { force: true });
      await this.release();
      return old.length;
    });
  }
  /** Drop this conversation's blob links that no remaining point needs, and the pooled file once nobody else links it. */
  private async release() {
    const needed = new Set<string>();
    for (const point of await this.readAll()) for (const hash of pointHashes(point)) needed.add(hash);
    let names: string[];
    try { names = await readdir(join(this.directory, "blobs")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    for (const name of names) {
      if (needed.has(name) || !hashPattern.test(name)) continue;
      await rm(this.blob(name), { force: true });
      const pooled = await lstat(this.pooled(name)).catch(() => null);
      if (pooled && pooled.nlink <= 1) await rm(this.pooled(name), { force: true });
    }
  }
  /** Copy points and the blobs their changed files need into another store, e.g. a forked chat. */
  async copyTo(target: TurnCheckpoints<T>, points: TurnCheckpoint<T>[], metadata: (value: T) => T) {
    await sharedAccess(async () => {
      for (const point of points) {
        for (const path of changedPaths(point)) {
          for (const state of [point.before[path], point.after?.[path]]) {
            if (!state || state.link !== undefined || !hashPattern.test(state.hash)) continue;
            const from = this.blob(state.hash), to = target.blob(state.hash);
            await mkdir(dirname(to), { recursive: true, mode: 0o700 });
            // Blobs are content-addressed and never rewritten, so a hard link is a safe copy.
            await link(from, to).catch(async error => {
              if (error.code === "EEXIST") return;
              if (error.code === "ENOENT") throw new Error("文件检查点损坏");
              await copyFile(from, to);
            });
          }
        }
        await target.save({ ...structuredClone(point), metadata: metadata(structuredClone(point.metadata)) });
      }
    });
  }

  private async paths(): Promise<Candidate[]> {
    const found = new Map<string, boolean>();
    try {
      const tracked = await exec("git", ["-C", this.cwd, "ls-files", "-z", "--cached", "--", "."], { maxBuffer: 64 * 1024 * 1024 });
      const pathspecs = [".", ...[...omitted].map(name => `:(exclude,glob)**/${name}/**`)];
      const ordinary = await exec("git", ["-C", this.cwd, "ls-files", "-z", "--others", "--exclude-standard", "--", ...pathspecs], { maxBuffer: 64 * 1024 * 1024 });
      const ignored = await exec("git", ["-C", this.cwd, "ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--", ...pathspecs], { maxBuffer: 64 * 1024 * 1024 });
      for (const path of ignored.stdout.split("\0")) {
        if (path && !path.split(/[\/]/).some(part => omitted.has(part)) && !ignoredNoise.test(path)) found.set(path, true);
      }
      for (const path of [...tracked.stdout.split("\0"), ...ordinary.stdout.split("\0")]) if (path) found.set(path, false);
    } catch (error) {
      // Only a non-repository workspace uses the directory walk; Git failures must surface.
      if (!(error as { stderr?: string }).stderr?.includes("not a git repository") && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      found.clear();
      const walk = async (dir: string) => {
        for (const item of await readdir(join(this.cwd, dir), { withFileTypes: true })) {
          if (omitted.has(item.name)) continue;
          const path = join(dir, item.name);
          if (inside(this.excluded, resolve(this.cwd, path))) continue;
          if (item.isDirectory()) await walk(path);
          else if (item.isFile() || item.isSymbolicLink()) found.set(path, false);
        }
      };
      await walk("");
    }
    return [...found].map(([path, ignored]) => ({ path, ignored }))
      .filter(({ path }) => inside(this.cwd, resolve(this.cwd, path)) && !path.split(/[\\/]/).includes(".git") && !inside(this.excluded, resolve(this.cwd, path)));
  }
  private async safePath(path: string, parents?: Set<string>) {
    const absolute = resolve(this.cwd, path);
    if (!inside(this.cwd, absolute) || path.split(/[\\/]/).includes(".git")) throw new Error("检查点路径超出工作区");
    let parent = dirname(absolute);
    const checked: string[] = [];
    while (parent !== this.cwd && inside(this.cwd, parent) && !parents?.has(parent)) {
      try { if ((await lstat(parent)).isSymbolicLink()) throw new Error(`文件目录已变为符号链接，无法回退：${path}`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      checked.push(parent);
      parent = dirname(parent);
    }
    for (const dir of checked) parents?.add(dir);
    return absolute;
  }
  /** Hash a file without holding it in memory. With `pooled`, the same pass writes the blob into the pool. */
  private async stream(absolute: string, pooled: boolean): Promise<string> {
    const hash = createHash("sha256");
    const temp = join(this.shared, "blobs", `${randomUUID()}.tmp`);
    if (pooled) await mkdir(dirname(temp), { recursive: true, mode: 0o700 });
    const tap = async function* (source: AsyncIterable<Buffer>) { for await (const chunk of source) { hash.update(chunk); yield chunk; } };
    try {
      if (pooled) await pipeline(createReadStream(absolute), tap, createWriteStream(temp, { mode: 0o600 }));
      else await pipeline(createReadStream(absolute), tap, async (source: AsyncIterable<Buffer>) => { for await (const _chunk of source) { /* hashing only */ } });
      const digest = hash.digest("hex");
      if (pooled) {
        if (await access(this.pooled(digest)).then(() => true, () => false)) await rm(temp, { force: true });
        else await rename(temp, this.pooled(digest));
      }
      return digest;
    } catch (error) { await rm(temp, { force: true }); throw error; }
  }
  /** Put the file's bytes in the pool unless they are already there. */
  private async pool(hash: string, bytes: Buffer) {
    if (await access(this.pooled(hash)).then(() => true, () => false)) return;
    await mkdir(dirname(this.pooled(hash)), { recursive: true, mode: 0o700 });
    const temp = join(this.shared, "blobs", `${randomUUID()}.tmp`);
    await writeFile(temp, bytes, { mode: 0o600 });
    await rename(temp, this.pooled(hash));
  }
  /** Give this conversation a link to a pooled blob. False when the pool does not have it. */
  private async attach(hash: string): Promise<boolean> {
    await mkdir(dirname(this.blob(hash)), { recursive: true, mode: 0o700 });
    try { await link(this.pooled(hash), this.blob(hash)); return true; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") return true;
      if (code === "ENOENT") return false;
      try { await copyFile(this.pooled(hash), this.blob(hash), constants.COPYFILE_EXCL); return true; }
      catch (copyError) {
        const copyCode = (copyError as NodeJS.ErrnoException).code;
        if (copyCode === "EEXIST") return true;
        if (copyCode === "ENOENT") return false;
        throw copyError;
      }
    }
  }
  private async read(path: string, capturing = false, store = true, context?: CaptureContext, ignored = false): Promise<FileState | undefined> {
    const absolute = await this.safePath(path, context?.parents);
    let stat;
    try { stat = await lstat(absolute); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    if (stat.isSymbolicLink()) {
      const link = await readlink(absolute);
      return { hash: createHash("sha256").update(link).digest("hex"), mode: 0, link };
    }
    if (!stat.isFile()) {
      if (capturing && stat.isDirectory()) return undefined; // Git submodule entries are directories.
      throw new Error(`检查点文件已变为目录，无法回退：${path}`);
    }
    if (ignored && stat.size > ignoredLimit) return undefined;
    const mode = stat.mode & 0o777;
    if (!store) {
      if (stat.size > wholeFileLimit) return { hash: await this.stream(absolute, false), mode };
      return { hash: createHash("sha256").update(await readFile(absolute)).digest("hex"), mode };
    }
    const hit = context?.cache.get(path);
    if (context && hit && hit[0] === stat.size && hit[1] === stat.mtimeMs && hit[2] === stat.ctimeMs && hit[3] === stat.ino &&
      (context.known.has(hit[4]) || await this.attach(hit[4]))) {
      context.known.add(hit[4]);
      context.next[path] = hit;
      return { hash: hit[4], mode };
    }
    const started = Date.now();
    let hash: string;
    if (stat.size > wholeFileLimit) {
      hash = await this.stream(absolute, true);
    } else {
      const bytes = await readFile(absolute);
      hash = createHash("sha256").update(bytes).digest("hex");
      await this.pool(hash, bytes);
    }
    if (!context?.known.has(hash) && !(await this.attach(hash))) throw new Error("文件检查点损坏");
    if (context) {
      context.known.add(hash);
      if (started - stat.mtimeMs > racyWindow) {
        // Cache only when the file did not change while it was being read.
        const again = await lstat(absolute).catch(() => null);
        if (again && again.size === stat.size && again.mtimeMs === stat.mtimeMs && again.ctimeMs === stat.ctimeMs && again.ino === stat.ino) {
          context.next[path] = [stat.size, stat.mtimeMs, stat.ctimeMs, stat.ino, hash];
        }
      }
    }
    return { hash, mode };
  }
  private statCache() { return join(this.shared, "stat", `${createHash("sha1").update(this.cwd).digest("hex")}.json`); }
  private async capture(): Promise<Files> {
    let cache = new Map<string, StatEntry>();
    try {
      const saved = JSON.parse(await readFile(this.statCache(), "utf8")) as { version?: number; files?: Record<string, StatEntry> };
      if (saved.version === 1 && saved.files) cache = new Map(Object.entries(saved.files));
    } catch { /* A missing or damaged cache only costs a full read. */ }
    let known: Set<string>;
    try { known = new Set(await readdir(join(this.directory, "blobs"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; known = new Set(); }
    const context: CaptureContext = { cache, next: {}, known, parents: new Set() };
    const candidates = await this.paths();
    const states = await mapLimit(candidates, 16, ({ path, ignored }) => this.read(path, true, true, context, ignored));
    const files: Files = Object.create(null);
    candidates.forEach(({ path }, index) => { const state = states[index]; if (state) files[path] = state; });
    const entries = Object.entries(context.next);
    if (entries.length !== cache.size || entries.some(([path, entry]) => cache.get(path) !== entry)) {
      try {
        await mkdir(dirname(this.statCache()), { recursive: true, mode: 0o700 });
        const temp = `${this.statCache()}.${randomUUID()}.tmp`;
        await writeFile(temp, JSON.stringify({ version: 1, files: context.next }), { mode: 0o600 });
        await rename(temp, this.statCache());
      } catch { /* The cache is advisory. */ }
    }
    return files;
  }

  /** Validate one point against the state the later points will leave behind. */
  private async stage(point: TurnCheckpoint<T>, desired: Map<string, FileState | undefined>, original: Map<string, FileState | undefined>, store: boolean) {
    if (point.unavailableReason) throw new Error(point.unavailableReason);
    if (!point.after) throw new Error("这轮消息的文件检查点未完成，无法安全回退");
    for (const path of changedPaths(point)) {
      const current = desired.has(path) ? desired.get(path) : await this.read(path, false, store);
      if (!same(current, point.after[path])) throw new Error(`文件在这轮之后又被修改，请先处理冲突再重新发送：${path}`);
      if (!original.has(path)) original.set(path, current);
      desired.set(path, point.before[path]);
    }
  }

  /**
   * Dry run of restore for every suffix of `points` (oldest first) without writing anything.
   * Entry i is the reason restoring points[i..] would fail, or null when it is safe.
   */
  async check(points: TurnCheckpoint<T>[]): Promise<(string | null)[]> {
    return sharedAccess(() => this.checkPoints(points));
  }
  private async checkPoints(points: TurnCheckpoint<T>[]): Promise<(string | null)[]> {
    const desired = new Map<string, FileState | undefined>();
    const original = new Map<string, FileState | undefined>();
    const result: (string | null)[] = [];
    let failure: string | null = null;
    for (let index = points.length - 1; index >= 0; index -= 1) {
      if (failure === null) {
        try { await this.stage(points[index]!, desired, original, false); }
        catch (error) { failure = error instanceof Error ? error.message : String(error); }
      }
      result[index] = failure;
    }
    return result;
  }

  /** Preflight every affected file and every blob before writing anything. Preserve unrelated edits. */
  async restore(points: TurnCheckpoint<T>[]) {
    await sharedAccess(() => this.restorePoints(points));
  }
  private async restorePoints(points: TurnCheckpoint<T>[]) {
    const original = new Map<string, FileState | undefined>();
    const desired = new Map<string, FileState | undefined>();
    for (const point of [...points].reverse()) await this.stage(point, desired, original, true);
    const buffers = new Map<string, Buffer>();
    for (const state of [...desired.values(), ...original.values()]) {
      if (!state || state.link !== undefined || buffers.has(state.hash)) continue;
      if (!hashPattern.test(state.hash)) throw new Error("文件检查点损坏");
      const bytes = await readFile(this.blob(state.hash));
      if (createHash("sha256").update(bytes).digest("hex") !== state.hash) throw new Error("文件检查点损坏");
      buffers.set(state.hash, bytes);
    }
    const apply = async (states: Map<string, FileState | undefined>) => {
      // Deletions first support file renames and file/directory shape changes.
      for (const [path] of states) await rm(await this.safePath(path), { force: true });
      for (const [path, state] of states) {
        if (!state) continue;
        const absolute = await this.safePath(path);
        await mkdir(dirname(absolute), { recursive: true });
        if (state.link !== undefined) await symlink(state.link, absolute);
        else { await writeFile(absolute, buffers.get(state.hash)!); await chmod(absolute, state.mode); }
      }
    };
    try { await apply(desired); }
    catch (error) { await apply(original); throw error; }
  }
}
