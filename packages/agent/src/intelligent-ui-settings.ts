import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { defaultUiPreference, isUiPreference, type UiPreference } from "@vela/shared";

/** Profile 内持久化的 Intelligent UI 偏好；只保存模式，不保存任何交互数据。 */
export class IntelligentUiSettings {
  preference: UiPreference = defaultUiPreference;
  private readonly path: string;

  constructor(private readonly agentDir: string) {
    this.path = join(agentDir, "intelligent-ui-settings.json");
    try {
      const value = JSON.parse(readFileSync(this.path, "utf8"));
      // 损坏或未知的值回到默认，而不是静默打开更激进的模式。
      if (isUiPreference(value?.preference)) this.preference = value.preference;
    } catch {
      // 没有设置文件时沿用默认值。
    }
  }

  setPreference(preference: UiPreference): void {
    if (!isUiPreference(preference)) throw new Error("Intelligent UI 偏好无效");
    mkdirSync(this.agentDir, { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify({ preference })}\n`, { mode: 0o600, flag: "wx" });
      renameSync(temporary, this.path);
      this.preference = preference;
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}
