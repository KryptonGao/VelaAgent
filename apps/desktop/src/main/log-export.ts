import { redactSensitive } from "@vela/shared";
import { strToU8, zipSync, type Zippable } from "fflate";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export interface DiagnosticsBundleOptions {
  home: string;
  /** Log files to include, already flushed. */
  logFiles: readonly string[];
  systemInfo: Record<string, unknown>;
  includeTrace: boolean;
  /** Trace directory is `<agentDir>/traces`. */
  agentDir: string;
  conversationId: string | null;
  /** Already-redacted MCP catalog (the same snapshot the renderer receives). */
  mcpCatalog?: () => Promise<unknown>;
  homeDir?: string;
  now?: Date;
}

interface ManifestItem {
  path: string;
  ok: boolean;
  error?: string;
}

/** Settings files copied (structure only, after redaction) into settings-summary.json. Credential stores are never read. */
const settingsFiles = ["vela-settings.json", "memory-settings.json", "scheduled-tasks.json", "logging-settings.json", "workspaces.json"] as const;

/** ZIP with logs, system info, git operations, a redacted settings summary and optionally the active conversation trace. */
export async function buildDiagnosticsBundle(options: DiagnosticsBundleOptions): Promise<Uint8Array> {
  const home = options.homeDir ?? homedir();
  const scrub = (text: string): string => {
    const redacted = redactSensitive(text) as string;
    return home.length > 1 ? redacted.split(home).join("~") : redacted;
  };
  const json = (value: unknown): Uint8Array => strToU8(scrub(`${JSON.stringify(value, null, 2)}\n`));
  const files: Zippable = {};
  const manifest: ManifestItem[] = [];
  const add = async (path: string, load: () => Promise<Uint8Array | null>): Promise<void> => {
    try {
      const data = await load();
      if (data) { files[path] = data; manifest.push({ path, ok: true }); }
      else manifest.push({ path, ok: false, error: "not found" });
    } catch (error) {
      manifest.push({ path, ok: false, error: scrub((error as Error).message ?? String(error)) });
    }
  };

  for (const file of options.logFiles) {
    await add(`logs/${basename(file)}`, async () => strToU8(scrub(await readFile(file, "utf8"))));
  }
  await add("system-info.json", async () => json(options.systemInfo));
  await add("git-operations.json", async () => {
    const text = await readOptional(join(options.home, "git-operations.json"));
    return text === null ? null : json(redactSensitive(JSON.parse(text)));
  });
  await add("settings-summary.json", async () => {
    const summary: Record<string, unknown> = {};
    for (const name of settingsFiles) {
      const text = await readOptional(join(options.home, name));
      if (text === null) continue;
      try { summary[name] = redactSensitive(JSON.parse(text)); } catch { summary[name] = "[unparseable]"; }
    }
    if (options.mcpCatalog) {
      try { summary.mcp = redactSensitive(await options.mcpCatalog()); } catch (error) { summary.mcp = { error: (error as Error).message }; }
    }
    return json(summary);
  });
  if (options.includeTrace) {
    if (!options.conversationId) manifest.push({ path: "trace/", ok: false, error: "no active conversation" });
    else {
      const id = options.conversationId;
      await add(`trace/${basename(id)}.jsonl`, async () => {
        const text = await readOptional(join(options.agentDir, "traces", `${basename(id)}.jsonl`));
        if (text === null) return null;
        const lines = text.split("\n").filter(Boolean).map(line => {
          try { return JSON.stringify(redactSensitive(JSON.parse(line))); } catch { return redactSensitive(line) as string; }
        });
        return strToU8(scrub(`${lines.join("\n")}\n`));
      });
    }
  }
  files["manifest.json"] = json({
    format: 1,
    exportedAt: (options.now ?? new Date()).toISOString(),
    includeTrace: options.includeTrace,
    items: manifest,
  });
  return zipSync(files, { level: 6 });
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function diagnosticsFileName(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `vela-diagnostics-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.zip`;
}
