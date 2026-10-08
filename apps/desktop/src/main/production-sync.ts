import type { AgentRuntime } from "@vela/agent";
import {
  productionSyncCategories,
  type ProductionSyncBatch,
  type ProductionSyncCategory,
  type ProductionSyncCategoryResult,
  type ProductionSyncPreview,
  type ProductionSyncResult,
  type ProductionSyncRollbackResult,
} from "@vela/shared";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { syncProductionConversations } from "./production-conversation-sync";

type SyncRuntime = Pick<AgentRuntime, "importConversations" | "removeConversations">;

/** 批次记录：每一步改动都带着撤销所需的原值。 */
type Op =
  | { type: "conversations"; batch: string; ids: string[]; reverted?: boolean }
  | { type: "json"; file: string; path: string[]; had: boolean; before?: unknown; after: unknown; reverted?: boolean }
  | { type: "path"; file: string; reverted?: boolean };

interface Manifest {
  version: 1;
  batch: string;
  createdAt: number;
  status: "applying" | "applied";
  categories: ProductionSyncCategoryResult[];
  ops: Op[];
}

interface Entry {
  /** 相对资料目录的 JSON 文件。 */
  file: string;
  path: string[];
  value: unknown;
  /** replace：值不同就覆盖；missing：目标已有同名项目时保持原样。 */
  mode: "replace" | "missing";
}

interface Plan {
  imported: number;
  existing: number;
  unavailable: number;
  /** 脱敏时被清空密钥、需要重新填写的提供方或服务器。 */
  credentials: Set<string>;
  apply(context: ApplyContext): Promise<number>;
}

interface ApplyContext {
  source: string;
  destination: string;
  batch: string;
  runtime: SyncRuntime;
  stage: string;
  record(op: Op): Promise<void>;
}

/** 需要重启开发版才会生效的文件：对应服务在启动时读取并缓存。 */
const restartFiles = new Set(["vela-settings.json", "selection.json"]);
const settingsKeys: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["vela-settings.json", ["sandboxMode"]],
  ["selection.json", ["thinkingLevel", "newConversationSelection", "instructions"]],
];
const modelSelectionKeys = ["provider", "modelId", "lastUsed"] as const;
const safeHeaders = new Set(["content-type", "accept", "user-agent"]);
const maxSkillFiles = 5000;
const maxSkillBytes = 200 * 1024 * 1024;
const idPattern = /^[\w-]+$/;

const inside = (root: string, file: string) => {
  const path = relative(root, file);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const syncRoot = (home: string) => join(home, "production-sync");
const manifestPath = (home: string, batch: string) => join(syncRoot(home), batch, "manifest.json");
const fileOf = (home: string, relativeFile: string) => join(home, ...relativeFile.split("/"));

class UnsafeSource extends Error {}

let queue: Promise<unknown> = Promise.resolve();
/** 预览、同步和撤销共用资料目录，必须一次只做一件事。 */
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

async function resolveHomes(sourceHome: string, destinationHome: string): Promise<{ source: string; destination: string }> {
  await mkdir(destinationHome, { recursive: true });
  let source: string;
  try { source = await realpath(sourceHome); }
  catch (error) {
    if (missing(error)) throw new Error("没有找到正式版资料目录，请先运行一次正式版");
    throw error;
  }
  if (source === await realpath(destinationHome)) throw new Error("开发版正在使用正式版资料目录，无需同步");
  return { source, destination: resolve(destinationHome) };
}

/** 读取正式版里的普通文件；符号链接和特殊文件一律不跟随。 */
async function readSourceFile(source: string, name: string): Promise<Buffer | null> {
  const file = join(source, name);
  let stat;
  try { stat = await lstat(file); }
  catch (error) { if (missing(error)) return null; throw error; }
  if (!stat.isFile()) throw new UnsafeSource(`${name} 不是普通文件`);
  return readFile(file);
}

async function readSourceObject(source: string, name: string): Promise<Record<string, unknown> | null> {
  const bytes = await readSourceFile(source, name);
  if (!bytes) return null;
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); }
  catch { throw new UnsafeSource(`${name} 格式不正确`); }
  if (!isRecord(value)) throw new UnsafeSource(`${name} 格式不正确`);
  return value;
}

async function readDestinationObject(destination: string, name: string): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(await readFile(join(destination, name), "utf8"));
    if (!isRecord(value)) throw new SyntaxError(`${name} 格式不正确`);
    return value;
  } catch (error) {
    if (missing(error)) return {};
    throw error;
  }
}

function getPath(value: unknown, path: readonly string[]): { exists: boolean; value?: unknown } {
  let current = value;
  for (const key of path) {
    if (!isRecord(current) || !Object.hasOwn(current, key)) return { exists: false };
    current = current[key];
  }
  return { exists: true, value: current };
}

function setPath(root: Record<string, unknown>, path: readonly string[], value: unknown): void {
  let current = root;
  for (const key of path.slice(0, -1)) {
    const next = current[key];
    if (isRecord(next)) current = next;
    else { const created: Record<string, unknown> = {}; current[key] = created; current = created; }
  }
  current[path.at(-1)!] = value;
}

function deletePath(root: Record<string, unknown>, path: readonly string[]): void {
  const parent = getPath(root, path.slice(0, -1));
  if (parent.exists && isRecord(parent.value)) delete parent.value[path.at(-1)!];
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

const isEmpty = (value: unknown) => value === "" || (Array.isArray(value) && value.length === 0);

/** 对照目标文件把条目分成「将写入」和「已有」。 */
async function classify(destination: string, entries: readonly Entry[]): Promise<{ pending: Entry[]; existing: number; unavailable: number }> {
  const pending: Entry[] = [];
  let existing = 0, unavailable = 0;
  const documents = new Map<string, Record<string, unknown> | null>();
  for (const entry of entries) {
    if (!documents.has(entry.file)) {
      documents.set(entry.file, await readDestinationObject(destination, entry.file).catch(() => null));
    }
    const document = documents.get(entry.file);
    if (!document) { unavailable++; continue; }
    const current = getPath(document, entry.path);
    if (!current.exists) {
      if (isEmpty(entry.value)) existing++;
      else pending.push(entry);
    } else if (entry.mode === "missing" || isDeepStrictEqual(current.value, entry.value)) existing++;
    else pending.push(entry);
  }
  return { pending, existing, unavailable };
}

async function applyEntries(context: ApplyContext, entries: readonly Entry[]): Promise<number> {
  const { pending } = await classify(context.destination, entries);
  let applied = 0;
  for (const file of new Set(pending.map(entry => entry.file))) {
    const document = await readDestinationObject(context.destination, file);
    const ops: Op[] = [];
    for (const entry of pending.filter(item => item.file === file)) {
      const current = getPath(document, entry.path);
      if (current.exists && (entry.mode === "missing" || isDeepStrictEqual(current.value, entry.value))) continue;
      ops.push({ type: "json", file, path: entry.path, had: current.exists, ...(current.exists ? { before: structuredClone(current.value) } : {}), after: structuredClone(entry.value) });
      setPath(document, entry.path, structuredClone(entry.value));
    }
    if (!ops.length) continue;
    await writeJson(join(context.destination, file), document);
    for (const op of ops) await context.record(op);
    applied += ops.length;
  }
  return applied;
}

function entryPlan(destination: string, entries: Entry[], extra: Partial<Pick<Plan, "unavailable" | "credentials">> = {}): Promise<Plan> {
  return classify(destination, entries).then(result => ({
    imported: result.pending.length,
    existing: result.existing,
    unavailable: result.unavailable + (extra.unavailable ?? 0),
    credentials: extra.credentials ?? new Set(),
    apply: context => applyEntries(context, entries),
  }));
}

const referenceValue = (value: string) => value.startsWith("!") || /\$\{?[A-Za-z_]/.test(value) || /^[A-Z][A-Z0-9_]{2,}$/.test(value);

/** 清空 env / headers 里的字面值；环境变量引用和命令引用保留。返回是否清空过。 */
function scrubSecrets(value: unknown, mark: () => void, secret = false, key = ""): unknown {
  if (typeof value === "string") {
    if (!secret || value === "" || referenceValue(value) || /^(true|false|\d+)$/.test(value) || safeHeaders.has(key.toLowerCase())) return value;
    mark();
    return "";
  }
  if (Array.isArray(value)) return value.map(item => scrubSecrets(item, mark, secret));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([name, item]) => [
    name,
    scrubSecrets(item, mark, secret || name === "env" || name === "headers"
      || /(?:authorization|cookie|password|passwd|secret|token|api[_-]?key|access[_-]?key|credential)/i.test(name), name),
  ]));
}

/** 提供方只带结构：删除密钥字段，保留 baseUrl、api、模型列表。 */
function sanitizeProvider(raw: Record<string, unknown>): { value: Record<string, unknown>; stripped: boolean } {
  let stripped = false;
  const mark = () => { stripped = true; };
  const copy: Record<string, unknown> = { ...raw };
  if (typeof copy.apiKey === "string" && copy.apiKey && !referenceValue(copy.apiKey)) { delete copy.apiKey; stripped = true; }
  return { value: scrubSecrets(copy, mark) as Record<string, unknown>, stripped };
}

function sanitizeMcpServer(raw: Record<string, unknown>): { value: Record<string, unknown>; stripped: boolean } {
  let stripped = false;
  const value = scrubSecrets(raw, () => { stripped = true; }) as Record<string, unknown>;
  // 缺少密钥的服务器先停用，避免启动后反复报错；填写密钥后再启用。
  return { value: stripped ? { ...value, enabled: false } : value, stripped };
}

interface TreeScan { directories: string[]; files: string[] }

async function scanTree(root: string): Promise<TreeScan> {
  const scan: TreeScan = { directories: [], files: [] };
  let bytes = 0;
  async function visit(directory: string): Promise<void> {
    for (const name of await readdir(join(root, directory))) {
      if (name === ".DS_Store") continue;
      const path = directory ? join(directory, name) : name;
      const stat = await lstat(join(root, path));
      if (stat.isDirectory()) { scan.directories.push(path); await visit(path); }
      else if (stat.isFile()) {
        bytes += stat.size;
        if (scan.files.push(path) > maxSkillFiles || bytes > maxSkillBytes) throw new UnsafeSource("Skill 文件过多或过大");
      } else throw new UnsafeSource("Skill 包含符号链接或特殊文件");
    }
  }
  await visit("");
  return scan;
}

async function planSettings(source: string, destination: string): Promise<Plan> {
  const entries: Entry[] = [];
  let unavailable = 0;
  for (const [file, keys] of settingsKeys) {
    try {
      const document = await readSourceObject(source, file);
      for (const key of keys) if (document && document[key] !== undefined) entries.push({ file, path: [key], value: document[key], mode: "replace" });
    } catch (error) { if (!(error instanceof UnsafeSource)) throw error; unavailable++; }
  }
  return entryPlan(destination, entries, { unavailable });
}

async function planModels(source: string, destination: string): Promise<Plan> {
  const entries: Entry[] = [];
  const stripped = new Set<string>();
  let unavailable = 0;
  try {
    const selection = await readSourceObject(source, "selection.json");
    for (const key of modelSelectionKeys) if (selection && selection[key] !== undefined) entries.push({ file: "selection.json", path: [key], value: selection[key], mode: "replace" });
  } catch (error) { if (!(error instanceof UnsafeSource)) throw error; unavailable++; }
  try {
    const providers = (await readSourceObject(source, "models.json"))?.providers;
    if (isRecord(providers)) {
      for (const [id, raw] of Object.entries(providers)) {
        if (!isRecord(raw) || id === "__proto__") { unavailable++; continue; }
        const { value, stripped: hadSecrets } = sanitizeProvider(raw);
        entries.push({ file: "models.json", path: ["providers", id], value, mode: "missing" });
        if (hadSecrets) stripped.add(id);
      }
    }
  } catch (error) { if (!(error instanceof UnsafeSource)) throw error; unavailable++; }
  const plan = await entryPlan(destination, entries, { unavailable });
  const importing = new Set((await classify(destination, entries)).pending.flatMap(entry => entry.file === "models.json" ? [entry.path[1]!] : []));
  // 账号凭据（API 密钥、OAuth 令牌）永远不复制；只提示哪些提供方需要在开发版重新登录。
  const credentials = new Set([...stripped].filter(id => importing.has(id)));
  try {
    const sourceAuth = await readSourceObject(source, "auth.json");
    const destinationAuth = await readDestinationObject(destination, "auth.json").catch(() => ({}));
    for (const id of Object.keys(sourceAuth ?? {})) if (!Object.hasOwn(destinationAuth, id)) credentials.add(id);
  } catch (error) { if (!(error instanceof UnsafeSource)) throw error; }
  plan.credentials = credentials;
  return plan;
}

async function planMcp(source: string, destination: string): Promise<Plan> {
  const entries: Entry[] = [];
  const stripped = new Set<string>();
  let unavailable = 0;
  try {
    const servers = (await readSourceObject(source, "mcp.json"))?.mcpServers;
    if (isRecord(servers)) {
      for (const [name, raw] of Object.entries(servers)) {
        if (!isRecord(raw) || name === "__proto__") { unavailable++; continue; }
        const { value, stripped: hadSecrets } = sanitizeMcpServer(raw);
        entries.push({ file: "mcp.json", path: ["mcpServers", name], value, mode: "missing" });
        if (hadSecrets) stripped.add(name);
      }
    }
  } catch (error) { if (!(error instanceof UnsafeSource)) throw error; unavailable++; }
  const plan = await entryPlan(destination, entries, { unavailable });
  const importing = new Set((await classify(destination, entries)).pending.map(entry => entry.path[1]!));
  plan.credentials = new Set([...stripped].filter(name => importing.has(name)));
  return plan;
}

async function planMemory(source: string, destination: string): Promise<Plan> {
  const empty = (unavailable = 0): Plan => ({ imported: 0, existing: 0, unavailable, credentials: new Set(), apply: async () => 0 });
  let bytes: Buffer | null;
  try { bytes = await readSourceFile(source, "MEMORY.md"); }
  catch (error) { if (error instanceof UnsafeSource) return empty(1); throw error; }
  if (!bytes) return empty();
  try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return empty(1); }
  const target = join(destination, "MEMORY.md");
  try { await lstat(target); return { ...empty(), existing: 1 }; }
  catch (error) { if (!missing(error)) throw error; }
  return {
    imported: 1, existing: 0, unavailable: 0, credentials: new Set(),
    async apply(context) {
      try { await writeFile(target, bytes, { mode: 0o600, flag: "wx" }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return 0; throw error; }
      await context.record({ type: "path", file: "MEMORY.md" });
      return 1;
    },
  };
}

async function planSkills(source: string, destination: string): Promise<Plan> {
  const root = join(source, "skills");
  let names: string[];
  try { names = (await readdir(root, { withFileTypes: true })).filter(item => !item.name.startsWith(".") && (item.isDirectory() || item.isSymbolicLink())).map(item => item.name); }
  catch (error) { if (missing(error)) names = []; else throw error; }
  const importing: Array<{ name: string; scan: TreeScan }> = [];
  let existing = 0, unavailable = 0;
  for (const name of names.sort()) {
    try { await lstat(join(destination, "skills", name)); existing++; continue; }
    catch (error) { if (!missing(error)) throw error; }
    try {
      if (!(await lstat(join(root, name))).isDirectory()) throw new UnsafeSource("Skill 不是目录");
      importing.push({ name, scan: await scanTree(join(root, name)) });
    } catch (error) { if (!(error instanceof UnsafeSource) && !missing(error)) throw error; unavailable++; }
  }
  return {
    imported: importing.length, existing, unavailable, credentials: new Set(),
    async apply(context) {
      let applied = 0;
      const copied: string[] = [];
      for (const { name, scan } of importing) {
        const staged = join(context.stage, "skills", name);
        await rm(staged, { recursive: true, force: true });
        await mkdir(staged, { recursive: true, mode: 0o700 });
        for (const directory of scan.directories) await mkdir(join(staged, directory), { recursive: true, mode: 0o700 });
        for (const file of scan.files) await copyFile(join(root, name, file), join(staged, file), constants.COPYFILE_EXCL);
        const target = join(context.destination, "skills", name);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        try { await lstat(target); await rm(staged, { recursive: true, force: true }); continue; }
        catch (error) { if (!missing(error)) throw error; }
        await rename(staged, target);
        await context.record({ type: "path", file: `skills/${name}` });
        copied.push(name);
        applied++;
      }
      // 在正式版里停用的 Skill，导入后保持停用；开发版自己的停用列表不动。
      try {
        const disabled = (await readSourceObject(context.source, "skill-preferences.json"))?.disabled;
        const carried = Array.isArray(disabled) ? disabled.filter((name): name is string => typeof name === "string" && copied.includes(name)) : [];
        if (carried.length) {
          const current = (await readDestinationObject(context.destination, "skill-preferences.json")).disabled;
          const merged = [...new Set([...(Array.isArray(current) ? current : []), ...carried])];
          await applyEntries(context, [{ file: "skill-preferences.json", path: ["disabled"], value: merged, mode: "replace" }]);
        }
      } catch (error) { if (!(error instanceof UnsafeSource)) throw error; }
      return applied;
    },
  };
}

async function planConversations(runtime: SyncRuntime, source: string, destination: string): Promise<Plan> {
  const counts = await syncProductionConversations(runtime, source, destination, { dryRun: true });
  return {
    imported: counts.imported, existing: counts.existing, unavailable: counts.unavailable, credentials: new Set(),
    async apply(context) {
      let ids: string[] = [];
      const result = await syncProductionConversations(context.runtime, context.source, context.destination, {
        batch: context.batch,
        onImported: imported => { ids = imported; },
      });
      if (ids.length) await context.record({ type: "conversations", batch: context.batch, ids });
      return result.imported;
    },
  };
}

async function plan(category: ProductionSyncCategory, runtime: SyncRuntime, source: string, destination: string): Promise<Plan> {
  switch (category) {
    case "settings": return planSettings(source, destination);
    case "models": return planModels(source, destination);
    case "skills": return planSkills(source, destination);
    case "mcp": return planMcp(source, destination);
    case "memory": return planMemory(source, destination);
    case "conversations": return planConversations(runtime, source, destination);
  }
}

function normalizeCategories(categories: readonly unknown[]): ProductionSyncCategory[] {
  if (!Array.isArray(categories)) throw new Error("同步范围不正确");
  const requested = new Set(categories);
  for (const value of requested) if (!productionSyncCategories.includes(value as ProductionSyncCategory)) throw new Error("同步范围不正确");
  const selected = productionSyncCategories.filter(category => requested.has(category));
  if (!selected.length) throw new Error("请至少选择一项同步范围");
  return selected;
}

const summarize = (category: ProductionSyncCategory, plan: Plan): ProductionSyncCategoryResult =>
  ({ category, imported: plan.imported, existing: plan.existing, unavailable: plan.unavailable });

/** 同步前的预览：只读取，不写入任何文件。某一项失败时标注原因，其余照常显示。 */
export function previewProductionSync(
  runtime: SyncRuntime,
  categories: readonly unknown[],
  sourceHome: string,
  destinationHome: string,
): Promise<ProductionSyncPreview> {
  return serialized(async () => {
    const selected = normalizeCategories(categories);
    const { source, destination } = await resolveHomes(sourceHome, destinationHome);
    const results: ProductionSyncCategoryResult[] = [];
    const credentials = new Set<string>();
    for (const category of selected) {
      try {
        const current = await plan(category, runtime, source, destination);
        results.push(summarize(category, current));
        for (const id of current.credentials) credentials.add(`${category}:${id}`);
      } catch (error) {
        results.push({ category, imported: 0, existing: 0, unavailable: 0, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { categories: results, total: results.reduce((sum, item) => sum + item.imported, 0), needsCredentials: credentials.size };
  });
}

async function saveManifest(home: string, manifest: Manifest): Promise<void> {
  await writeJson(manifestPath(home, manifest.batch), manifest);
}

async function readManifest(home: string, batch: string): Promise<Manifest> {
  if (!idPattern.test(batch)) throw new Error("同步批次不存在");
  try {
    const value: unknown = JSON.parse(await readFile(manifestPath(home, batch), "utf8"));
    if (!isRecord(value) || value.version !== 1 || value.batch !== batch || !Array.isArray(value.ops)) throw new Error("损坏");
    return value as unknown as Manifest;
  } catch (error) {
    if (missing(error)) throw new Error("同步批次不存在");
    throw new Error("同步批次记录已损坏，无法撤销");
  }
}

/** 逆序撤销已记录的改动；每撤销一步就持久化，失败后可以重试。 */
async function undo(
  runtime: SyncRuntime,
  home: string,
  manifest: Manifest,
): Promise<{ reverted: number; kept: number; restartRequired: boolean }> {
  let reverted = 0, kept = 0, restartRequired = false;
  // 会话最容易被拒绝（正在使用或运行中），先处理，被拒绝时其他改动都还没动。
  const ordered = [...manifest.ops].reverse().sort((a, b) => Number(b.type === "conversations") - Number(a.type === "conversations"));
  for (const op of ordered) {
    if (op.reverted) continue;
    if (op.type === "conversations") {
      if (!idPattern.test(op.batch) || op.ids.some(id => typeof id !== "string" || !idPattern.test(id))) throw new Error("同步批次记录已损坏，无法撤销");
      await runtime.removeConversations(op.ids);
      await rm(join(home, "sessions", "production-sync", op.batch), { recursive: true, force: true });
      for (const id of op.ids) {
        await rm(join(home, "traces", `${id}.jsonl`), { force: true });
        await rm(join(home, "checkpoints", id), { recursive: true, force: true });
      }
      reverted += op.ids.length;
    } else if (op.type === "path") {
      const target = fileOf(home, op.file);
      if (!inside(home, target)) throw new Error("同步批次记录已损坏，无法撤销");
      await rm(target, { recursive: true, force: true });
      reverted++;
    } else {
      const target = fileOf(home, op.file);
      if (!inside(home, target)) throw new Error("同步批次记录已损坏，无法撤销");
      const document = await readDestinationObject(home, op.file);
      const current = getPath(document, op.path);
      if (current.exists && isDeepStrictEqual(current.value, op.after)) {
        if (op.had) setPath(document, op.path, structuredClone(op.before));
        else deletePath(document, op.path);
        await writeJson(target, document);
        reverted++;
        if (restartFiles.has(op.file)) restartRequired = true;
      } else kept++;
    }
    op.reverted = true;
    await saveManifest(home, manifest);
  }
  return { reverted, kept, restartRequired };
}

/** 按所选范围从正式版同步一批内容；任何一步失败都会撤销本批已经写入的部分。 */
export function runProductionSync(
  runtime: SyncRuntime,
  categories: readonly unknown[],
  sourceHome: string,
  destinationHome: string,
): Promise<ProductionSyncResult> {
  return serialized(async () => {
    const selected = normalizeCategories(categories);
    const { source, destination } = await resolveHomes(sourceHome, destinationHome);
    const plans = new Map<ProductionSyncCategory, Plan>();
    for (const category of selected) plans.set(category, await plan(category, runtime, source, destination));
    const credentials = new Set([...plans].flatMap(([category, item]) => [...item.credentials].map(id => `${category}:${id}`)));
    const batch = randomUUID();
    const manifest: Manifest = { version: 1, batch, createdAt: Date.now(), status: "applying", categories: [], ops: [] };
    const context: ApplyContext = {
      source, destination, batch, runtime,
      stage: join(syncRoot(destination), batch, "stage"),
      async record(op) { manifest.ops.push(op); await saveManifest(destination, manifest); },
    };
    const results: ProductionSyncCategoryResult[] = [];
    try {
      await saveManifest(destination, manifest);
      for (const [category, current] of plans) {
        const imported = await current.apply(context);
        results.push({ category, imported, existing: current.existing, unavailable: current.unavailable });
      }
    } catch (error) {
      try {
        await undo(runtime, destination, manifest);
        await rm(join(syncRoot(destination), batch), { recursive: true, force: true });
      } catch (undoError) {
        throw new Error(`同步失败，且自动撤销未完成，请在同步记录里撤销批次 ${batch}：${undoError instanceof Error ? undoError.message : String(undoError)}`, { cause: error });
      }
      throw error;
    }
    const total = results.reduce((sum, item) => sum + item.imported, 0);
    const restartRequired = manifest.ops.some(op => op.type === "json" && restartFiles.has(op.file));
    await rm(join(syncRoot(destination), batch, "stage"), { recursive: true, force: true });
    if (!manifest.ops.length) {
      await rm(join(syncRoot(destination), batch), { recursive: true, force: true });
      return { categories: results, total, needsCredentials: 0, batch: null, restartRequired: false };
    }
    manifest.status = "applied";
    manifest.categories = results;
    await saveManifest(destination, manifest);
    return { categories: results, total, needsCredentials: credentials.size, batch, restartRequired };
  });
}

/** 列出可以撤销的同步批次，最新的在前。 */
export function listProductionSyncBatches(destinationHome: string): Promise<ProductionSyncBatch[]> {
  return serialized(async () => {
    let names: string[];
    try { names = await readdir(syncRoot(destinationHome)); }
    catch (error) { if (missing(error)) return []; throw error; }
    const batches: ProductionSyncBatch[] = [];
    for (const name of names) {
      if (!idPattern.test(name)) continue;
      const manifest = await readManifest(destinationHome, name).catch(() => null);
      if (!manifest) continue;
      batches.push({
        id: manifest.batch,
        createdAt: manifest.createdAt,
        status: manifest.status,
        categories: manifest.categories,
        total: manifest.categories.reduce((sum, item) => sum + item.imported, 0),
      });
    }
    return batches.sort((a, b) => b.createdAt - a.createdAt);
  });
}

/** 撤销整个批次：删除导入的会话、Skill、记忆，并把设置和配置还原；同步之后又改过的项目保持现状。 */
export function rollbackProductionSync(
  runtime: SyncRuntime,
  batch: string,
  destinationHome: string,
): Promise<ProductionSyncRollbackResult> {
  return serialized(async () => {
    const destination = resolve(destinationHome);
    const manifest = await readManifest(destination, batch);
    const result = await undo(runtime, destination, manifest);
    await rm(join(syncRoot(destination), batch), { recursive: true, force: true });
    return { batch, ...result };
  });
}
