import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, readlink, rename, rm, symlink, writeFile, chmod } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
const omitted = new Set([".git", "node_modules", ".pnpm-store", ".venv", "venv", "__pycache__", ".next", "dist", "out", "build", "target"]);
const same = (a: FileState | undefined, b: FileState | undefined) =>
  a?.hash === b?.hash && a?.mode === b?.mode && a?.link === b?.link;
const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
};

/** Persisted before/after file states. Git's index and existing dirty work are never reset. */
export class TurnCheckpoints<T> {
  constructor(private readonly directory: string, private readonly cwd: string, private readonly excluded: string) {}

  private file(id: string) { return join(this.directory, `${id}.json`); }
  private async save(point: TurnCheckpoint<T>) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temp = `${this.file(point.id)}.tmp`;
    await writeFile(temp, JSON.stringify(point), { mode: 0o600 });
    await rename(temp, this.file(point.id));
  }
  async list(): Promise<TurnCheckpoint<T>[]> {
    let names: string[];
    try { names = await readdir(this.directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    return Promise.all(names.filter(name => name.endsWith(".json")).map(async name =>
      JSON.parse(await readFile(join(this.directory, name), "utf8")) as TurnCheckpoint<T>));
  }
  async begin(leaf: string | null, metadata: T): Promise<TurnCheckpoint<T>> {
    const point = { id: randomUUID(), leaf, userEntryId: null, before: await this.capture(), after: null, metadata };
    await this.save(point);
    return point;
  }
  async finish(point: TurnCheckpoint<T>, userEntryId: string | null) {
    point.userEntryId = userEntryId;
    point.after = await this.capture();
    await this.save(point);
  }
  async remove(points: TurnCheckpoint<T>[]) {
    for (const point of points) await rm(this.file(point.id), { force: true });
  }

  private async paths(): Promise<string[]> {
    let paths: string[];
    try {
      const tracked = await exec("git", ["-C", this.cwd, "ls-files", "-z", "--cached", "--", "."], { maxBuffer: 64 * 1024 * 1024 });
      const pathspecs = [".", ...[...omitted].map(name => `:(exclude,glob)**/${name}/**`)];
      const ordinary = await exec("git", ["-C", this.cwd, "ls-files", "-z", "--others", "--exclude-standard", "--", ...pathspecs], { maxBuffer: 64 * 1024 * 1024 });
      const ignored = await exec("git", ["-C", this.cwd, "ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--", ...pathspecs], { maxBuffer: 64 * 1024 * 1024 });
      const ignoredPaths = ignored.stdout.split("\0").filter(path => path && !path.split(/[\/]/).some(part => omitted.has(part)));
      paths = [...new Set([...tracked.stdout.split("\0"), ...ordinary.stdout.split("\0"), ...ignoredPaths].filter(Boolean))];
    } catch (error) {
      // Only a non-repository workspace uses the directory walk; Git failures must surface.
      if (!(error as { stderr?: string }).stderr?.includes("not a git repository") && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      paths = [];
      const walk = async (dir: string) => {
        for (const item of await readdir(join(this.cwd, dir), { withFileTypes: true })) {
          if (omitted.has(item.name)) continue;
          const path = join(dir, item.name);
          if (inside(this.excluded, resolve(this.cwd, path))) continue;
          if (item.isDirectory()) await walk(path);
          else if (item.isFile() || item.isSymbolicLink()) paths.push(path);
        }
      };
      await walk("");
    }
    return paths.filter(path => inside(this.cwd, resolve(this.cwd, path)) && !path.split(/[\\/]/).includes(".git") && !inside(this.excluded, resolve(this.cwd, path)));
  }
  private async safePath(path: string) {
    const absolute = resolve(this.cwd, path);
    if (!inside(this.cwd, absolute) || path.split(/[\\/]/).includes(".git")) throw new Error("检查点路径超出工作区");
    let parent = dirname(absolute);
    while (parent !== this.cwd && inside(this.cwd, parent)) {
      try { if ((await lstat(parent)).isSymbolicLink()) throw new Error(`文件目录已变为符号链接，无法回退：${path}`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      parent = dirname(parent);
    }
    return absolute;
  }
  private async read(path: string, capturing = false): Promise<FileState | undefined> {
    const absolute = await this.safePath(path);
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
    const bytes = await readFile(absolute);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const blob = join(this.directory, "blobs", hash);
    await mkdir(dirname(blob), { recursive: true, mode: 0o700 });
    await writeFile(blob, bytes, { flag: "wx", mode: 0o600 }).catch(error => { if (error.code !== "EEXIST") throw error; });
    return { hash, mode: stat.mode & 0o777 };
  }
  private async capture(): Promise<Files> {
    const files: Files = Object.create(null);
    for (const path of await this.paths()) {
      const state = await this.read(path, true);
      if (state) files[path] = state;
    }
    return files;
  }

  /** Preflight every affected file and every blob before writing anything. Preserve unrelated edits. */
  async restore(points: TurnCheckpoint<T>[]) {
    const original = new Map<string, FileState | undefined>();
    const desired = new Map<string, FileState | undefined>();
    for (const point of [...points].reverse()) {
      if (point.unavailableReason) throw new Error(point.unavailableReason);
      if (!point.after) throw new Error("这轮消息的文件检查点未完成，无法安全回退");
      for (const path of new Set([...Object.keys(point.before), ...Object.keys(point.after)])) {
        if (same(point.before[path], point.after[path])) continue;
        const current = desired.has(path) ? desired.get(path) : await this.read(path);
        if (!same(current, point.after[path])) throw new Error(`文件在这轮之后又被修改，请先处理冲突再重新发送：${path}`);
        if (!original.has(path)) original.set(path, current);
        desired.set(path, point.before[path]);
      }
    }
    const buffers = new Map<string, Buffer>();
    for (const state of [...desired.values(), ...original.values()]) {
      if (!state || state.link !== undefined || buffers.has(state.hash)) continue;
      if (!/^[a-f0-9]{64}$/.test(state.hash)) throw new Error("文件检查点损坏");
      const bytes = await readFile(join(this.directory, "blobs", state.hash));
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
