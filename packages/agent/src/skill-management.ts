import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

/** 停用列表的文件名；只记录 Skill 名称，不改动 Skill 本身。 */
const preferencesFileName = "skill-preferences.json";
const maxSkillNameLength = 200;

function preferencesPath(agentDir: string): string {
  return join(agentDir, preferencesFileName);
}

/** 读取被停用的 Skill 名称。文件缺失或损坏时当作没有停用。 */
export async function readDisabledSkills(agentDir: string): Promise<Set<string>> {
  const raw = await readFile(preferencesPath(agentDir), "utf8").catch(() => null);
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return new Set();
    const disabled = (parsed as { disabled?: unknown }).disabled;
    if (!Array.isArray(disabled)) return new Set();
    const names = disabled.flatMap((item) => {
      if (typeof item !== "string") return [];
      const name = item.trim();
      return name && name.length <= maxSkillNameLength ? [name] : [];
    });
    return new Set(names);
  } catch {
    return new Set();
  }
}

export async function writeDisabledSkills(agentDir: string, names: Iterable<string>): Promise<void> {
  const path = preferencesPath(agentDir);
  await mkdir(dirname(path), { recursive: true });
  const disabled = [...new Set([...names].map((name) => name.trim()).filter(Boolean))].sort((left, right) =>
    left.localeCompare(right, "zh"),
  );
  const payload = `${JSON.stringify({ disabled }, null, 2)}\n`;
  const staging = `${path}.tmp`;
  await writeFile(staging, payload, { mode: 0o600 });
  await rename(staging, path);
}

/** 启用或停用一个 Skill。停用后不会加载，模型和 /skill:名称 都无法使用。 */
export async function setSkillEnabled(agentDir: string, name: string, enabled: boolean): Promise<void> {
  const disabled = await readDisabledSkills(agentDir);
  if (enabled) disabled.delete(name);
  else disabled.add(name);
  await writeDisabledSkills(agentDir, disabled);
}

/** 删除 Vela 用户 Skill 目录里的 Skill，并把它从停用列表里清掉。 */
export async function deleteSkill(options: { agentDir: string; name: string; location: string }): Promise<void> {
  const file = resolve(options.location);
  const skillsDir = resolve(join(options.agentDir, "skills"));
  // 只允许删 Vela 自己的 Skill：路径必须在 skills 目录内，且是 Skill 的 markdown 文件。
  if (!file.endsWith(".md") || !isUnder(file, skillsDir)) {
    throw new Error("只能删除 Vela Skill 目录里的 Skill");
  }
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) throw new Error("找不到这个 Skill");
  const skillDir = dirname(file);
  // 直接放在 skills 根目录的 .md 是一个独立 Skill，只删文件；否则整个 Skill 目录一起删。
  if (skillDir === skillsDir) await rm(file);
  else await rm(skillDir, { recursive: true });
  // 文件已经删了,清理停用记录失败不影响结果。
  await setSkillEnabled(options.agentDir, options.name, true).catch(() => undefined);
}

function isUnder(target: string, root: string): boolean {
  if (target === root) return true;
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return target.startsWith(prefix);
}
