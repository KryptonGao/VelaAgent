import { DefaultResourceLoader, SettingsManager, type Skill } from "@earendil-works/pi-coding-agent";
import type { SkillCatalog, SkillDiagnostic, SkillOrigin, SkillSummary } from "@vela/shared";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { readDisabledSkills } from "./skill-management";

export async function loadSkillCatalog(options: { cwd: string; agentDir: string }): Promise<SkillCatalog> {
  const skillsDir = join(options.agentDir, "skills");
  const loader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager: SettingsManager.inMemory(),
    noExtensions: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  const loaded = loader.getSkills();
  const disabled = await readDisabledSkills(options.agentDir);
  return {
    skillsDir,
    skills: loaded.skills.map((skill) => summarize(skill, disabled, skillsDir)),
    diagnostics: loaded.diagnostics.map(summarizeDiagnostic),
  };
}

function summarize(skill: Skill, disabled: Set<string>, skillsDir: string): SkillSummary {
  return {
    name: skill.name,
    description: skill.description,
    location: skill.filePath,
    origin: originOf(skill),
    disableModelInvocation: skill.disableModelInvocation,
    enabled: !disabled.has(skill.name),
    canDelete: canDelete(skill.filePath, skillsDir),
  };
}

function originOf(skill: Skill): SkillOrigin {
  const agentsRoot = join(homedir(), ".agents", "skills");
  if (isUnder(skill.filePath, agentsRoot) || isUnder(skill.baseDir, agentsRoot)) return "agents";
  if (skill.sourceInfo.scope === "project") return "project";
  return "user";
}

/** 只有 Vela 用户 Skill 目录里的 markdown 允许在这里删除。 */
function canDelete(filePath: string, skillsDir: string): boolean {
  const file = resolve(filePath);
  return file.endsWith(".md") && isUnder(file, resolve(skillsDir));
}

function summarizeDiagnostic(diagnostic: {
  type: "warning" | "error" | "collision";
  message: string;
  path?: string;
}): SkillDiagnostic {
  return {
    type: diagnostic.type,
    message: diagnostic.message,
    path: diagnostic.path ?? null,
  };
}

function isUnder(target: string, root: string): boolean {
  if (target === root) return true;
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return target.startsWith(prefix);
}
