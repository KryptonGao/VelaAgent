import { SessionManager } from "@earendil-works/pi-coding-agent";
import { existsSync, writeFileSync, openSync, fsyncSync, closeSync } from "node:fs";

/**
 * 新建一个立即落盘的持久会话。
 *
 * Pi 1.0 会在首条 user 或 assistant 消息时创建 JSONL 文件,但空会话
 * 仍然没有文件。Vela 在用户创建对话时就登记持久状态,因此仍需立即
 * 写入 header,避免未发送消息的对话在重启时被当成已清理会话丢掉。
 *
 * 这里在创建后立刻写入只有 header 的会话文件,再用 open() 重新打开:
 * 空对话当次就有文件可恢复,manager 进入已落盘状态,用户消息也会即时追加,
 * 而不是依赖 Pi 的首条消息触发创建。
 */
export function createPersistedSession(cwd: string, sessionDir: string, reservedId?: string): SessionManager {
  const manager = SessionManager.create(cwd, sessionDir, reservedId ? { id: reservedId } : undefined);
  const file = manager.getSessionFile();
  const header = manager.getHeader();
  if (!file || !header) return manager;
  try {
    writeFileSync(file, `${JSON.stringify(header)}\n`, { flag: "wx" });
  } catch {
    // 并发创建或磁盘不可写:文件已存在就按已有内容打开,否则退回 Pi 的懒创建。
    if (reservedId) throw new Error("无法持久化配方对话");
    if (!existsSync(file)) return manager;
  }
  if (reservedId) {
    const descriptor = openSync(file, "r");
    try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
  }
  return SessionManager.open(file, sessionDir, cwd);
}
