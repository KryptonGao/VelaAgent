import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createPersistedSession } from "../src/session-persistence.ts";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "vela-session-persist-"));
}

describe("createPersistedSession：新对话立即落盘", () => {
  it("新建的空会话在磁盘上有文件,重启后能用同一个 id 打开", async () => {
    const dir = await tempDir();
    const manager = createPersistedSession("/tmp/workspace", dir);
    const file = manager.getSessionFile();
    assert.ok(file);
    assert.ok(existsSync(file));

    const header = JSON.parse(readFileSync(file, "utf8").trim()) as { type: string; id: string; cwd: string };
    assert.equal(header.type, "session");
    assert.equal(header.id, manager.getSessionId());
    assert.equal(header.cwd, "/tmp/workspace");

    // 模拟重启:按文件重新打开,id 与文件路径保持一致。
    const reopened = SessionManager.open(file, dir, "/tmp/workspace");
    assert.equal(reopened.getSessionId(), manager.getSessionId());
    assert.equal(reopened.getSessionFile(), file);
    assert.deepEqual(reopened.getEntries(), []);
  });

  it("会话已落盘,没有 assistant 回复时用户消息也会写入文件", async () => {
    const dir = await tempDir();
    const manager = createPersistedSession("/tmp/workspace", dir);
    const file = manager.getSessionFile();
    assert.ok(file);

    manager.appendMessage({ role: "user", content: "强制关闭前发送的消息" } as never);
    assert.match(readFileSync(file, "utf8"), /强制关闭前发送的消息/);

    const reopened = SessionManager.open(file, dir, "/tmp/workspace");
    const messages = reopened.buildSessionProjection().messages;
    assert.equal(messages.length, 1);
  });

  it("会话目录不存在时也能落盘", async () => {
    const dir = join(await tempDir(), "nested", "sessions");
    const manager = createPersistedSession("/tmp/workspace", dir);
    const file = manager.getSessionFile();
    assert.ok(file);
    assert.ok(existsSync(file));
  });
});
