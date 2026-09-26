import { open, readdir, readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  WorkspaceFileContent,
  WorkspaceFileList,
  WorkspaceSearchMatch,
  WorkspaceSearchResult,
} from "@vela/shared";
import { runGit } from "./git-run";
import { isPathInside } from "./git-service";

/** 文本单次读取上限,超出部分截断并在 truncated 标记。 */
const maxTextBytes = 1024 * 1024;
/** 图片预览上限,超出按 too-large 处理。 */
const maxImageBytes = 10 * 1024 * 1024;
/** 本地内容搜索时单个文件读取的头部字节数。 */
const maxScanBytes = 512 * 1024;
const maxListEntries = 20_000;
const maxSearchMatches = 200;
const maxLocalSearchFiles = 2000;
const maxWalkDepth = 32;
const maxPathLength = 1024;
/** 单条搜索结果文本截断长度。 */
const maxMatchTextLength = 240;

const imageMimeByExt: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
};

/** 本地内容搜索时直接跳过的二进制类扩展名。 */
const skipScanExtensions = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".svg", ".icns",
  ".zip", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar",
  ".pdf", ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".wasm", ".node", ".dylib", ".so", ".dll", ".exe", ".bin", ".class", ".jar",
  ".mp3", ".mp4", ".mov", ".avi", ".webm", ".wav", ".flac",
  ".ds_store", ".lockb", ".pdb", ".obj", ".o", ".a", ".lib",
]);

const skipDirNames = new Set([".git", "node_modules"]);

export interface WorkspaceRoots {
  /** 规范基准根:仓库根 ?? 工作区 ?? 兜底目录,决定文件列表/搜索范围与相对路径表示。 */
  baseRoot: string;
  /** 相对路径的解析候选根,按优先级排序(工作区在前,仓库根在后)。 */
  preferRoots: string[];
}

export interface ResolvedWorkspacePath {
  absolutePath: string;
  /** 相对 baseRoot、以 / 分隔;baseRoot 之外的目标为绝对路径 */
  path: string;
}

/** baseRoot 之内的目标用相对路径表示,之外(允许,供侧栏预览)用绝对路径表示。 */
function toResolved(baseRoot: string, absolutePath: string): ResolvedWorkspacePath {
  return isPathInside(absolutePath, baseRoot)
    ? { absolutePath, path: toPosixPath(relative(baseRoot, absolutePath)) }
    : { absolutePath, path: toPosixPath(absolutePath) };
}

/**
 * 侧栏文件预览的工作区文件访问:文件内容读取、文件列表、代码内容搜索。
 * 读取支持任意本地文件(绝对路径,含工作区外);文件列表与搜索只覆盖 baseRoot。
 */
export class WorkspaceFileService {
  async read(roots: WorkspaceRoots, rawPath: string): Promise<WorkspaceFileContent> {
    const target = await this.resolvePath(roots, rawPath);
    const info = await stat(target.absolutePath).catch(() => null);
    if (!info) {
      return { ...emptyContent(target), kind: "missing" };
    }
    if (!info.isFile()) throw new Error("不是普通文件");

    const ext = extname(target.absolutePath).toLowerCase();
    const mimeType = imageMimeByExt[ext];
    if (mimeType) {
      if (info.size > maxImageBytes) {
        return { ...emptyContent(target), kind: "too-large", size: info.size };
      }
      const data = await readFile(target.absolutePath);
      return {
        path: target.path,
        absolutePath: target.absolutePath,
        kind: "image",
        content: `data:${mimeType};base64,${data.toString("base64")}`,
        size: info.size,
        truncated: false,
      };
    }

    // 只读头部字节,既限制内存又能判断是否还有后续内容。
    const length = Math.min(info.size, maxTextBytes);
    const handle = await open(target.absolutePath, "r");
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, 0);
      const slice = buffer.subarray(0, bytesRead);
      if (slice.subarray(0, 8192).includes(0)) {
        return { ...emptyContent(target), kind: "binary", size: info.size };
      }
      return {
        path: target.path,
        absolutePath: target.absolutePath,
        kind: "text",
        content: slice.toString("utf8"),
        size: info.size,
        truncated: info.size > bytesRead,
      };
    } finally {
      await handle.close();
    }
  }

  async listFiles(roots: WorkspaceRoots): Promise<WorkspaceFileList> {
    const files: string[] = [];
    let truncated = false;
    try {
      // cached + others(未忽略的未跟踪文件),与 git status 的可见范围一致。
      const output = await gitListFiles(roots.baseRoot);
      for (const entry of output.split("\0")) {
        if (!entry) continue;
        if (files.length >= maxListEntries) {
          truncated = true;
          break;
        }
        files.push(entry);
      }
    } catch {
      // 不是 git 仓库(或 git 不可用):退化为有界的本地遍历。
      const state = { truncated: false };
      await walkFiles(roots.baseRoot, roots.baseRoot, 0, files, state);
      truncated = state.truncated;
    }
    files.sort((a, b) => a.localeCompare(b));
    return { root: roots.baseRoot, files, truncated };
  }

  async search(roots: WorkspaceRoots, rawQuery: string): Promise<WorkspaceSearchResult> {
    const query = typeof rawQuery === "string" ? rawQuery.trim() : "";
    if (!query || query.length > 200 || query.includes("\0")) {
      throw new Error("搜索词不正确");
    }
    const result = await runGit(
      roots.baseRoot,
      // --untracked 让没有提交过的新仓库也能搜到文件(与 ls-files -co 的可见范围一致)。
      ["--no-optional-locks", "grep", "--untracked", "-n", "-I", "-i", "--fixed-strings", "-e", query, "--"],
      20_000,
    );
    if (result.code === 0) {
      const parsed = parseGrepOutput(result.stdout, maxSearchMatches);
      return { query, matches: parsed.matches, truncated: parsed.truncated };
    }
    if (result.code === 1) {
      // git grep 用退出码 1 表示没有匹配。
      return { query, matches: [], truncated: false };
    }
    // 非 git 仓库或其他 git 错误:退化为本地文本扫描。
    return this.searchLocally(roots, query);
  }

  /**
   * 把任意(相对/绝对)路径解析为规范目标;非法路径抛错。
   * 绝对路径不限制在工作区内(侧栏预览支持任意本地文件);
   * 相对路径按候选根解析并拒绝 `..` 穿越。
   */
  async resolvePath(roots: WorkspaceRoots, rawPath: string): Promise<ResolvedWorkspacePath> {
    const trimmed = typeof rawPath === "string" ? rawPath.trim() : "";
    if (!trimmed || trimmed.length > maxPathLength || trimmed.includes("\0")) {
      throw new Error("文件路径不正确");
    }
    const baseRoot = resolve(roots.baseRoot);
    if (isAbsolute(trimmed)) {
      return toResolved(baseRoot, resolve(trimmed));
    }
    if (trimmed.split(/[\\/]/).includes("..")) throw new Error("文件路径不正确");

    for (const root of roots.preferRoots) {
      const candidate = resolve(root, trimmed);
      if (await pathExists(candidate)) {
        return toResolved(baseRoot, candidate);
      }
    }
    // 找不到时按第一个候选根给出规范位置,交由调用方决定(missing)。
    return toResolved(baseRoot, resolve(roots.preferRoots[0] ?? baseRoot, trimmed));
  }

  private async searchLocally(roots: WorkspaceRoots, query: string): Promise<WorkspaceSearchResult> {
    const list = await this.listFiles(roots);
    const matches: WorkspaceSearchMatch[] = [];
    const needle = query.toLowerCase();
    let truncated = list.truncated;
    const scanLimit = Math.min(list.files.length, maxLocalSearchFiles);
    for (let fileIndex = 0; fileIndex < scanLimit; fileIndex += 1) {
      if (matches.length >= maxSearchMatches) {
        truncated = true;
        break;
      }
      const path = list.files[fileIndex];
      const ext = extname(path).toLowerCase();
      if (skipScanExtensions.has(ext)) continue;
      const text = await readHeadText(join(roots.baseRoot, path));
      if (!text) continue;
      const lower = text.toLowerCase();
      let from = 0;
      while (matches.length < maxSearchMatches) {
        const index = lower.indexOf(needle, from);
        if (index < 0) break;
        const before = text.lastIndexOf("\n", index) + 1;
        let end = text.indexOf("\n", index);
        if (end < 0) end = text.length;
        matches.push({
          path,
          line: text.slice(0, index).split("\n").length,
          text: text.slice(before, end).trim().slice(0, maxMatchTextLength),
        });
        from = end + 1;
      }
      if (matches.length >= maxSearchMatches) truncated = true;
    }
    return { query, matches, truncated };
  }
}

function emptyContent(target: ResolvedWorkspacePath): Omit<WorkspaceFileContent, "kind"> {
  return {
    path: target.path,
    absolutePath: target.absolutePath,
    content: null,
    size: 0,
    truncated: false,
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function gitListFiles(cwd: string): Promise<string> {
  const result = await runGit(
    cwd,
    ["--no-optional-locks", "ls-files", "-z", "-co", "--exclude-standard"],
    20_000,
  );
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || "git ls-files 失败");
  }
  return result.stdout;
}

async function walkFiles(
  root: string,
  dir: string,
  depth: number,
  files: string[],
  state: { truncated: boolean },
): Promise<void> {
  if (depth > maxWalkDepth || state.truncated) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (files.length >= maxListEntries) {
      state.truncated = true;
      return;
    }
    if (entry.name === ".DS_Store" || skipDirNames.has(entry.name)) continue;
    if (entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(root, full, depth + 1, files, state);
      continue;
    }
    if (entry.isFile()) {
      files.push(toPosixPath(relative(root, full)));
    }
  }
}

function parseGrepOutput(
  output: string,
  limit: number,
): { matches: WorkspaceSearchMatch[]; truncated: boolean } {
  const matches: WorkspaceSearchMatch[] = [];
  let truncated = false;
  for (const raw of output.split("\n")) {
    if (!raw) continue;
    if (matches.length >= limit) {
      truncated = true;
      break;
    }
    const first = raw.indexOf(":");
    const second = raw.indexOf(":", first + 1);
    if (first <= 0 || second < 0) continue;
    const line = Number(raw.slice(first + 1, second));
    if (!Number.isInteger(line) || line <= 0) continue;
    matches.push({
      path: raw.slice(0, first),
      line,
      text: raw.slice(second + 1).slice(0, maxMatchTextLength),
    });
  }
  return { matches, truncated };
}

async function readHeadText(path: string): Promise<string | null> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size === 0) return null;
    const length = Math.min(info.size, maxScanBytes);
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, 0);
      const slice = buffer.subarray(0, bytesRead);
      if (slice.includes(0)) return null;
      return slice.toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

function toPosixPath(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}
