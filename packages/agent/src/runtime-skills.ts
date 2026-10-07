import type { ExternalSkillScan, SkillCatalog, SkillMigrationResult } from "@vela/shared";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadSkillCatalog } from "./skill-catalog";
import {
  deleteSkill as deleteSkillFiles,
  readDisabledSkills,
  setSkillEnabled as storeSkillEnabled,
} from "./skill-management";
import { migrateExternalSkills, scanExternalSkills as scanExternalSkillSources } from "./skill-migration";

/**
 * Skill 的启用状态与目录操作。所有对话共用一份停用列表和修订号；
 * 会话记下自己加载时的修订号，不一致时在下次发言前重新加载。
 */
export class SkillLibrary {
  /** 被停用的 Skill 名称；启动会话时据此过滤，null 表示还没读取。 */
  private disabled: Set<string> | null = null;
  /** 每次停用、启用或删除 Skill 时递增，用于让已打开的会话在下次发言前刷新 Skill。 */
  private currentRevision = 0;

  constructor(private readonly agentDir: string) {}

  get revision(): number {
    return this.currentRevision;
  }

  /** 用户 Skill 目录。与会话启动时 Pi 扫描的 `<agentDir>/skills` 相同。 */
  directory(): string {
    return join(this.agentDir, "skills");
  }

  /** 按当前工作区扫描用户 Skill、项目 Skill 和 ~/.agents/skills。 */
  list(cwd: string): Promise<SkillCatalog> {
    return loadSkillCatalog({ cwd, agentDir: this.agentDir });
  }

  async setEnabled(cwd: string, name: string, enabled: boolean): Promise<SkillCatalog> {
    await storeSkillEnabled(this.agentDir, name, enabled);
    await this.changed();
    return this.list(cwd);
  }

  /** 删除 Vela 用户 Skill 目录里的 Skill。 */
  async delete(cwd: string, name: string, location: string): Promise<SkillCatalog> {
    await deleteSkillFiles({ agentDir: this.agentDir, name, location });
    await this.changed();
    return this.list(cwd);
  }

  /** 列出 Codex 与 Claude Code 中可复制到 Vela 的 Skill。 */
  scanExternal(cwd: string): Promise<ExternalSkillScan> {
    return scanExternalSkillSources(this.migrationOptions(cwd));
  }

  /** 把选中的外部 Skill 复制到用户 Skill 目录。 */
  migrate(cwd: string, ids: readonly string[]): Promise<SkillMigrationResult> {
    return migrateExternalSkills(this.migrationOptions(cwd), ids);
  }

  /** 启动会话前读取一次停用列表；之后由变更操作刷新。 */
  async load(): Promise<void> {
    this.disabled ??= await readDisabledSkills(this.agentDir);
  }

  /** 从资源里去掉被停用的 Skill，让模型和 /skill:名称 都看不到。 */
  withoutDisabled<T extends { skills: Array<{ name: string }> }>(base: T): T {
    const disabled = this.disabled;
    if (!disabled || disabled.size === 0) return base;
    return { ...base, skills: base.skills.filter((skill) => !disabled.has(skill.name)) };
  }

  private async changed(): Promise<void> {
    this.disabled = await readDisabledSkills(this.agentDir);
    this.currentRevision += 1;
  }

  private migrationOptions(cwd: string) {
    return {
      home: homedir(),
      cwd,
      skillsDir: this.directory(),
      codexHome: process.env.CODEX_HOME,
      claudeHome: process.env.CLAUDE_CONFIG_DIR,
    };
  }
}
