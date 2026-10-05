import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

/** Profile 内持久化的 Agent 记忆总开关；不读写任何记忆正文。 */
export class MemorySettings {
  enabled = true;
  private readonly path: string;

  constructor(private readonly agentDir: string) {
    this.path = join(agentDir, "memory-settings.json");
    try {
      const value = JSON.parse(readFileSync(this.path, "utf8"));
      // 损坏或无效的已有设置不应意外重新启用记忆。
      this.enabled = value?.enabled === true;
    } catch (error) {
      this.enabled = (error as NodeJS.ErrnoException).code === "ENOENT";
    }
  }

  setEnabled(enabled: boolean): void {
    if (typeof enabled !== "boolean") throw new Error("记忆开关必须是布尔值");
    mkdirSync(this.agentDir, { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify({ enabled })}\n`, { mode: 0o600, flag: "wx" });
      renameSync(temporary, this.path);
      this.enabled = enabled;
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}
