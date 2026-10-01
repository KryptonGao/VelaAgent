import { SessionManager } from "@earendil-works/pi-coding-agent";
import { existsSync, writeFileSync } from "node:fs";

/**
 * 新建一个立即落盘的持久会话。
 *
 * Pi 的 SessionManager 要等到首条 assistant 消息写入时才创建 JSONL 文件,
 * 还没有收到回复的新对话因此始终没有文件;应用被强制关闭后重启时,
 * 这类对话会被当成已被清理的会话丢掉。
 *
 * 这里在创建后立刻写入只有 header 的会话文件,再用 open() 重新打开:
 * 空对话当次就有文件可恢复,manager 进入已落盘状态,用户消息也会即时追加,
 * 而不是等到第一条回复完成才和新对话一起补写。
 */
export function createPersistedSession(cwd: string, sessionDir: string): SessionManager {
  const manager = SessionManager.create(cwd, sessionDir);
  const file = manager.getSessionFile();
  const header = manager.getHeader();
  if (!file || !header) return manager;
  try {
    writeFileSync(file, `${JSON.stringify(header)}\n`, { flag: "wx" });
  } catch {
    // 并发创建或磁盘不可写:文件已存在就按已有内容打开,否则退回 Pi 的懒创建。
    if (!existsSync(file)) return manager;
  }
  return SessionManager.open(file, sessionDir, cwd);
}
