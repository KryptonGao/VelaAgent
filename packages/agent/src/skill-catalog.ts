import { DefaultResourceLoader, SettingsManager, type Skill } from "@earendil-works/pi-coding-agent";
import type { SkillCatalog, SkillDiagnostic, SkillOrigin, SkillSummary } from "@vela/shared";
import { homedir } from "node:os";
import { join, sep } from "node:path";

export async function loadSkillCatalog(options: { cwd: string; agentDir: string }): Promise<SkillCatalog> {
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
  return {
    skillsDir: join(options.agentDir, "skills"),
    skills: loaded.skills.map(summarize),
    diagnostics: loaded.diagnostics.map(summarizeDiagnostic),
  };
}

function summarize(skill: Skill): SkillSummary {
  return {
    name: skill.name,
    description: skill.description,
    location: skill.filePath,
    origin: originOf(skill),
    disableModelInvocation: skill.disableModelInvocation,
  };
}

function originOf(skill: Skill): SkillOrigin {
  const agentsRoot = join(homedir(), ".agents", "skills");
  if (isUnder(skill.filePath, agentsRoot) || isUnder(skill.baseDir, agentsRoot)) return "agents";
  if (skill.sourceInfo.scope === "project") return "project";
  return "user";
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
