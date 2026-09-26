import { randomBytes } from "node:crypto";
import { chmod, copyFile, mkdir, readdir, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  ExternalSkillCandidate,
  ExternalSkillScan,
  ExternalSkillScope,
  ExternalSkillSource,
  ExternalSkillState,
  SkillMigrationEntry,
  SkillMigrationResult,
  SkillMigrationSkip,
  SkillMigrationSkipReason,
} from "@vela/shared";

export interface SkillMigrationOptions {
  home: string;
  cwd: string;
  skillsDir: string;
  /** Codex 配置目录，默认 ~/.codex。对应 CODEX_HOME。 */
  codexHome?: string | null;
  /** Claude Code 配置目录，默认 ~/.claude。对应 CLAUDE_CONFIG_DIR。 */
  claudeHome?: string | null;
}

interface SourceRoot {
  source: ExternalSkillSource;
  scope: ExternalSkillScope;
  root: string;
}

const skippedDirectoryNames = new Set(["node_modules", ".git"]);

export async function scanExternalSkills(options: SkillMigrationOptions): Promise<ExternalSkillScan> {
  const roots = sourceRoots(options);
  const trust = await trustRoots(options, roots);
  const loaded = await existingRealPaths(loadedRoots(options));
  const velaRoot = await tryRealpath(options.skillsDir);
  const skills: ExternalSkillCandidate[] = [];
  const sources = [];

  for (const source of roots) {
    const present = (await tryStat(source.root))?.isDirectory() ?? false;
    sources.push({ source: source.source, scope: source.scope, root: source.root, present });
    if (!present) continue;
    const files: string[] = [];
    await findSkillFiles(source.root, files);
    for (const file of files) {
      const candidate = await describeSkill(file, source, options.skillsDir, trust, loaded, velaRoot);
      if (candidate) skills.push(candidate);
    }
  }

  skills.sort((left, right) => {
    if (left.source !== right.source) return left.source === "codex" ? -1 : 1;
    if (left.scope !== right.scope) return left.scope === "user" ? -1 : 1;
    return left.name.localeCompare(right.name, "zh") || left.directoryName.localeCompare(right.directoryName, "zh");
  });

  return { skills, sources };
}

export async function migrateExternalSkills(
  options: SkillMigrationOptions,
  ids: readonly string[],
): Promise<SkillMigrationResult> {
  const scan = await scanExternalSkills(options);
  const byId = new Map(scan.skills.map((skill) => [skill.id, skill]));
  const copied: SkillMigrationEntry[] = [];
  const replaced: SkillMigrationEntry[] = [];
  const skipped: SkillMigrationSkip[] = [];
  const usedNames = new Set<string>();

  for (const id of ids) {
    const skill = byId.get(id);
    if (!skill) {
      skipped.push({ id, name: id, reason: "not-found", message: null });
      continue;
    }
    if (!skill.selectable) {
      skipped.push({ id, name: skill.name, reason: "already-local", message: null });
      continue;
    }
    if (usedNames.has(skill.directoryName)) {
      skipped.push({ id, name: skill.name, reason: "duplicate", message: null });
      continue;
    }
    usedNames.add(skill.directoryName);
    try {
      const outcome = await importSkill(skill, options);
      const entry = { id: skill.id, name: skill.name, destination: outcome.destination };
      if (outcome.replaced) replaced.push(entry);
      else copied.push(entry);
    } catch (error) {
      const reason: SkillMigrationSkipReason = error instanceof SkillImportError ? error.reason : "failed";
      const message = reason === "failed" && error instanceof Error ? error.message : null;
      skipped.push({ id: skill.id, name: skill.name, reason, message });
    }
  }

  return { copied, replaced, skipped };
}

async function importSkill(
  skill: ExternalSkillCandidate,
  options: SkillMigrationOptions,
): Promise<{ destination: string; replaced: boolean }> {
  const source = sourceRoots(options).find((root) => root.source === skill.source && root.scope === skill.scope);
  const skillDir = dirname(skill.location);
  if (!source || !isUnder(resolve(skillDir), resolve(source.root))) throw new SkillImportError("unsafe");

  const realDir = await tryRealpath(skillDir);
  const trust = await trustRoots(options, sourceRoots(options));
  if (!realDir || !trust.some((root) => isUnder(realDir, root))) throw new SkillImportError("unsafe");

  const destination = destinationFor(options.skillsDir, skill.directoryName);
  const velaRoot = await tryRealpath(options.skillsDir);
  if (velaRoot && isUnder(realDir, velaRoot)) throw new SkillImportError("already-local");

  let replaced = false;
  if (await tryStat(destination)) {
    const destReal = await tryRealpath(destination);
    if (destReal && (destReal === realDir || isUnder(realDir, destReal))) throw new SkillImportError("already-local");
    replaced = true;
  }

  await mkdir(options.skillsDir, { recursive: true });
  const token = randomBytes(6).toString("hex");
  const staging = join(options.skillsDir, `.migrating-${token}`);
  try {
    await copyTree(realDir, staging, realDir, new Set());
    if (replaced) {
      const backup = join(options.skillsDir, `.replacing-${token}`);
      await rename(destination, backup);
      try {
        await rename(staging, destination);
      } catch (error) {
        await rename(backup, destination).catch(() => undefined);
        throw error;
      }
      await rm(backup, { recursive: true, force: true });
    } else {
      await rename(staging, destination);
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }

  return { destination, replaced };
}

function sourceRoots(options: SkillMigrationOptions): SourceRoot[] {
  const codexBase = options.codexHome?.trim() || join(options.home, ".codex");
  const claudeBase = options.claudeHome?.trim() || join(options.home, ".claude");
  const roots: SourceRoot[] = [
    { source: "codex", scope: "user", root: join(codexBase, "skills") },
    { source: "claude", scope: "user", root: join(claudeBase, "skills") },
  ];
  if (options.cwd.trim()) {
    roots.push(
      { source: "codex", scope: "project", root: join(options.cwd, ".codex", "skills") },
      { source: "claude", scope: "project", root: join(options.cwd, ".claude", "skills") },
    );
  }
  return roots;
}

function loadedRoots(options: SkillMigrationOptions): string[] {
  return [
    options.skillsDir,
    join(options.home, ".agents", "skills"),
    ...(options.cwd.trim()
      ? [join(options.cwd, ".agents", "skills"), join(options.cwd, ".pi", "skills")]
      : []),
  ];
}

async function trustRoots(options: SkillMigrationOptions, roots: SourceRoot[]): Promise<string[]> {
  const trusted: string[] = [];
  trusted.push((await tryRealpath(options.home)) ?? resolve(options.home));
  if (options.cwd.trim() && resolve(options.cwd) !== resolve("/")) {
    trusted.push((await tryRealpath(options.cwd)) ?? resolve(options.cwd));
  }
  for (const source of roots) {
    const real = await tryRealpath(source.root);
    if (real) trusted.push(real);
  }
  return trusted;
}

async function describeSkill(
  file: string,
  source: SourceRoot,
  skillsDir: string,
  trust: string[],
  loaded: string[],
  velaRoot: string | null,
): Promise<ExternalSkillCandidate | null> {
  const skillDir = dirname(file);
  const relativeDir = toPosixRelative(source.root, skillDir);
  if (!isSafeRelative(relativeDir)) return null;
  const realDir = await tryRealpath(skillDir);
  if (!realDir || !trust.some((root) => isUnder(realDir, root))) return null;

  let raw = "";
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return null;
  }
  const frontmatter = parseFrontmatter(raw);
  const directoryName = basename(skillDir);
  if (!isSafeDirectoryName(directoryName)) return null;
  const name = frontmatter.name?.trim() || directoryName;
  const description = (frontmatter.description ?? "").replace(/\s+/g, " ").trim().slice(0, 1024);
  const destination = join(skillsDir, directoryName);
  const destinationExists = (await tryStat(destination)) !== null;
  const insideVela = velaRoot !== null && isUnder(realDir, velaRoot);
  const alreadyLoaded = loaded.some((root) => isUnder(realDir, root));

  let state: ExternalSkillState = "new";
  let selectable = true;
  if (insideVela) {
    state = "loaded";
    selectable = false;
  } else if (destinationExists) {
    state = "present";
  } else if (alreadyLoaded) {
    state = "loaded";
  }

  return {
    id: `${source.source}:${source.scope}:${relativeDir}`,
    name,
    description,
    source: source.source,
    scope: source.scope,
    directoryName,
    location: file,
    state,
    selectable,
  };
}

async function findSkillFiles(dir: string, found: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  if (entries.some((entry) => entry.name === "SKILL.md") && (await isFile(join(dir, "SKILL.md")))) {
    found.push(join(dir, "SKILL.md"));
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || skippedDirectoryNames.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (await isDirectory(full)) await findSkillFiles(full, found);
  }
}

async function copyTree(source: string, destination: string, skillRealDir: string, seen: Set<string>): Promise<void> {
  const realSource = await tryRealpath(source);
  if (!realSource || !isUnder(realSource, skillRealDir) || seen.has(realSource)) return;
  seen.add(realSource);
  await mkdir(destination, { recursive: true });
  const entries = await readdir(realSource, { withFileTypes: true });
  for (const entry of entries) {
    if (skippedDirectoryNames.has(entry.name) || entry.name === ".DS_Store") continue;
    const from = join(realSource, entry.name);
    const to = join(destination, entry.name);
    if (entry.isSymbolicLink()) {
      const targetReal = await tryRealpath(from);
      const targetStat = targetReal ? await tryStat(from) : null;
      if (!targetReal || !targetStat || !isUnder(targetReal, skillRealDir)) continue;
      if (targetStat.isDirectory()) await copyTree(targetReal, to, skillRealDir, seen);
      else if (targetStat.isFile()) await copyFileMode(targetReal, to);
      continue;
    }
    if (entry.isDirectory()) await copyTree(from, to, skillRealDir, seen);
    else if (entry.isFile()) await copyFileMode(from, to);
  }
}

async function copyFileMode(from: string, to: string): Promise<void> {
  const info = await stat(from);
  await copyFile(from, to);
  await chmod(to, info.mode & 0o777);
}

function destinationFor(skillsDir: string, directoryName: string): string {
  if (!isSafeDirectoryName(directoryName)) throw new SkillImportError("unsafe");
  const destination = resolve(skillsDir, directoryName);
  if (!isUnder(destination, resolve(skillsDir))) throw new SkillImportError("unsafe");
  return destination;
}

function parseFrontmatter(raw: string): { name: string | null; description: string | null } {
  const text = raw.replace(/^\uFEFF/, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match?.[1]) return { name: null, description: null };
  const lines = match[1].split(/\r?\n/);
  let name: string | null = null;
  let description: string | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const field = /^(name|description):\s*(.*)$/.exec(lines[index] ?? "");
    if (!field?.[1]) continue;
    const rest = field[2] ?? "";
    let value = unquote(rest.trim());
    if (rest.trim() === "" || rest.trim() === ">" || rest.trim() === ">-" || rest.trim() === "|" || rest.trim() === "|-") {
      const block: string[] = [];
      while (index + 1 < lines.length) {
        const next = lines[index + 1] ?? "";
        if (next !== "" && !/^\s/.test(next)) break;
        block.push(next.trim());
        index += 1;
      }
      value = (rest.trim().startsWith("|") ? block.join("\n") : block.join(" ")).replace(/\s+/g, " ").trim();
    }
    if (field[1] === "name") name = value;
    else description = value;
  }
  return { name, description };
}

function unquote(value: string): string {
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
    const body = value.slice(1, -1);
    return quote === "'" ? body.replace(/''/g, "'") : body.replace(/\\(["\\])/g, "$1");
  }
  return value;
}

function toPosixRelative(root: string, dir: string): string {
  const rel = relative(root, dir);
  if (!rel || rel === "." || isAbsolute(rel) || rel.split(sep).includes("..")) return "";
  return rel.split(sep).join("/");
}

function isSafeRelative(relativeDir: string): boolean {
  if (!relativeDir || relativeDir.includes("\\") || relativeDir.includes("\0")) return false;
  return relativeDir.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function isSafeDirectoryName(name: string): boolean {
  return name !== "" && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\\") && !name.includes("\0") && !name.startsWith(".");
}

function isUnder(target: string, root: string): boolean {
  if (target === root) return true;
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return target.startsWith(prefix);
}

async function existingRealPaths(paths: string[]): Promise<string[]> {
  const found: string[] = [];
  for (const path of paths) {
    const real = await tryRealpath(path);
    if (real) found.push(real);
  }
  return found;
}

async function tryRealpath(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

async function tryStat(path: string): Promise<Awaited<ReturnType<typeof stat>> | null> {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

async function isFile(path: string): Promise<boolean> {
  return (await tryStat(path))?.isFile() ?? false;
}

async function isDirectory(path: string): Promise<boolean> {
  return (await tryStat(path))?.isDirectory() ?? false;
}

class SkillImportError extends Error {
  readonly reason: Extract<SkillMigrationSkipReason, "unsafe" | "already-local">;

  constructor(reason: Extract<SkillMigrationSkipReason, "unsafe" | "already-local">) {
    super(reason);
    this.reason = reason;
  }
}
