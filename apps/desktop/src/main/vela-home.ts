import { existsSync, mkdirSync } from "node:fs";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

const agentFiles = ["auth.json", "models.json", "selection.json"] as const;

/** 安装版使用 ~/.vela，源码开发版使用 ~/.vela-dev。 */
export function resolveVelaHome(isPackaged = true): string {
  const override = process.env.VELA_USER_DATA?.trim();
  if (override) return resolve(override);
  return join(homedir(), isPackaged ? ".vela" : ".vela-dev");
}

interface ProfileApp {
  isPackaged: boolean;
  setName(name: string): void;
  getPath(name: "appData"): string;
  setPath(name: "userData" | "sessionData", path: string): void;
}

/** 必须在申请单实例锁和 ready 事件之前隔离 Electron 的锁、缓存和浏览器资料。 */
export function configureVelaProfile(app: ProfileApp): string {
  app.setName(app.isPackaged ? "Vela" : "Vela Dev");
  const home = resolveVelaHome(app.isPackaged);
  const override = process.env.VELA_USER_DATA?.trim();
  if (override || !app.isPackaged) {
    // 显式指定默认资料目录时也必须复用默认锁，不能给同一任务队列开第二把锁。
    const userData = home === join(homedir(), ".vela")
      ? join(app.getPath("appData"), "Vela")
      : home === join(homedir(), ".vela-dev")
        ? join(app.getPath("appData"), "Vela Dev")
        : join(home, "electron-data");
    mkdirSync(userData, { recursive: true });
    app.setPath("userData", userData);
    app.setPath("sessionData", userData);
  }
  return home;
}

/**
 * 准备资料目录。未设置 VELA_USER_DATA 时，若新目录还没有对话索引，
 * 从 Electron userData 复制一次对话、账号、工作区和权限设置。旧目录保留。
 */
export async function prepareVelaHome(home: string, legacyUserData: string): Promise<void> {
  if (!process.env.VELA_USER_DATA?.trim()) {
    await migrateLegacyHome(home, legacyUserData);
  }
  await mkdir(join(home, "skills"), { recursive: true });
  await mkdir(join(home, "sessions"), { recursive: true });
  await mkdir(join(home, "worktrees"), { recursive: true });
}

async function migrateLegacyHome(home: string, legacyUserData: string): Promise<void> {
  const legacyAgent = join(legacyUserData, "agent");
  const legacyIndex = join(legacyAgent, "conversations.json");
  const nextIndex = join(home, "conversations.json");
  if (resolve(home) === resolve(legacyUserData) || resolve(home) === resolve(legacyAgent)) return;
  if (existsSync(nextIndex) || !existsSync(legacyIndex)) return;

  await copyMissing(join(legacyAgent, "sessions"), join(home, "sessions"));
  await copyMissing(join(legacyAgent, "skills"), join(home, "skills"));
  for (const name of agentFiles) {
    await copyMissing(join(legacyAgent, name), join(home, name));
  }
  await copyMissing(join(legacyUserData, "workspaces.json"), join(home, "workspaces.json"));
  await copyMissing(join(legacyUserData, "vela-settings.json"), join(home, "vela-settings.json"));

  const raw = await readFile(legacyIndex, "utf8");
  const rewritten = rewriteSessionFiles(raw, join(legacyAgent, "sessions"), join(home, "sessions"));
  await writeFile(nextIndex, rewritten.endsWith("\n") ? rewritten : `${rewritten}\n`, "utf8");
  console.log(`[vela] migrated data to ${home}`);
}

async function copyMissing(from: string, to: string): Promise<void> {
  if (!existsSync(from) || existsSync(to)) return;
  await cp(from, to, { recursive: true });
}

/** 把对话索引里的会话文件路径从旧 sessions 目录改到新目录。 */
function rewriteSessionFiles(raw: string, oldDir: string, newDir: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
  if (!parsed || typeof parsed !== "object") return raw;
  const conversations = (parsed as { conversations?: unknown }).conversations;
  if (!Array.isArray(conversations)) return raw;
  for (const entry of conversations) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as { sessionFile?: unknown };
    if (typeof record.sessionFile !== "string") continue;
    record.sessionFile = relocate(record.sessionFile, oldDir, newDir);
  }
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

function relocate(file: string, oldDir: string, newDir: string): string {
  const prefix = oldDir.endsWith(sep) ? oldDir : `${oldDir}${sep}`;
  if (file === oldDir) return newDir;
  if (file.startsWith(prefix)) return `${newDir}${sep}${file.slice(prefix.length)}`;
  return file;
}
