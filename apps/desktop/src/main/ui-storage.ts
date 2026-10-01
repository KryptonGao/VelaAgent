import { readFileSync, renameSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Renderer preferences and summaries live beside conversations, independent of page origin. */
export class UiStorage {
  constructor(private readonly file: string) {}

  private read(): Record<string, string | null> {
    let raw: string;
    try {
      raw = readFileSync(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid UI storage");
    const entries = Object.entries(parsed);
    if (entries.some(([key, value]) => !key.startsWith("vela.") || (value !== null && typeof value !== "string"))) {
      throw new Error("Invalid UI storage entry");
    }
    return Object.fromEntries(entries);
  }

  getItem(key: unknown): string | null | undefined {
    this.validateKey(key);
    return this.read()[key];
  }

  setItem(key: unknown, value: unknown): void {
    this.validateKey(key);
    if (value !== null && typeof value !== "string") throw new Error("Invalid UI storage value");
    const records = { ...this.read(), [key]: value };
    const raw = JSON.stringify(records);
    if (Buffer.byteLength(raw, "utf8") > 16 * 1024 * 1024) throw new Error("UI storage quota exceeded");
    mkdirSync(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, raw, { encoding: "utf8", mode: 0o600 });
      renameSync(temporary, this.file);
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  private validateKey(key: unknown): asserts key is string {
    if (typeof key !== "string" || !key.startsWith("vela.") || key.length > 200) {
      throw new Error("Invalid UI storage key");
    }
  }
}
