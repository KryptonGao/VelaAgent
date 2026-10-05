import assert from "node:assert/strict";
import { describe, it } from "node:test";

// ui-storage 在模块加载时读取 window.vela.uiStorage；测试用内存实现替代。
const store = new Map<string, string>();
(globalThis as unknown as { window: unknown }).window = {
  vela: {
    uiStorage: {
      getItem: (key: string) => (store.has(key) ? store.get(key) : undefined),
      setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); },
    },
  },
};
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
};

const {
  clearMemoryDraft,
  memoryBytes,
  memoryCatalogEntryLabel,
  memoryCatalogEntryStatus,
  memoryDraftKey,
  memoryErrorText,
  memoryOverLimit,
  memoryParentDirectory,
  memoryUnexpectedError,
  readMemoryDraft,
  writeMemoryDraft,
} = await import("../src/renderer/components/memory-settings-model.ts");
const { settingsCopy } = await import("../src/renderer/components/settings-copy.ts");
const { memoryFileMaxBytes } = await import("@vela/shared");
type MemoryCatalogEntry = import("@vela/shared").MemoryCatalogEntry;

const zh = settingsCopy("zh-CN").memory;
const en = settingsCopy("en").memory;

function entry(overrides: Partial<MemoryCatalogEntry>): MemoryCatalogEntry {
  return {
    scope: "project",
    workspace: "/project",
    name: "project",
    path: "/project/.vela/MEMORY.md",
    exists: false,
    status: "missing",
    bytes: 0,
    revision: null,
    error: null,
    message: null,
    ...overrides,
  };
}

describe("记忆设置模型", () => {
  it("按 UTF-8 字节判断上限", () => {
    assert.equal(memoryBytes("你好"), 6);
    assert.equal(memoryOverLimit("x".repeat(memoryFileMaxBytes)), false);
    assert.equal(memoryOverLimit("x".repeat(memoryFileMaxBytes + 1)), true);
    assert.equal(memoryOverLimit("你".repeat(memoryFileMaxBytes / 3 + 1)), true);
  });

  it("推导文件所在目录", () => {
    assert.equal(memoryParentDirectory("/a/b/c.md"), "/a/b");
    assert.equal(memoryParentDirectory("C:\\Users\\me\\MEMORY.md"), "C:\\Users\\me");
    assert.equal(memoryParentDirectory("MEMORY.md"), "MEMORY.md");
  });

  it("中英文都给出条目名称、状态与错误文案", () => {
    assert.equal(memoryCatalogEntryLabel(entry({ scope: "global", workspace: null }), zh), "全局记忆");
    assert.equal(memoryCatalogEntryLabel(entry({}), en), "project");
    assert.equal(memoryCatalogEntryStatus(entry({ status: "missing" }), zh), zh.statusMissing);
    assert.equal(memoryCatalogEntryStatus(entry({ status: "loaded", bytes: 12 }), en), en.statusLoaded(12));
    assert.equal(memoryCatalogEntryStatus(entry({ status: "failed" }), zh), zh.statusFailed);
    assert.equal(memoryErrorText({ code: "conflict", message: "raw", path: null }, zh), zh.errors.conflict);
    assert.equal(memoryErrorText({ code: "busy", message: "raw", path: null }, en), en.errors.busy);
    assert.deepEqual(Object.keys(zh.errors).sort(), Object.keys(en.errors).sort());
    assert.equal(Object.keys(zh.errors).length, 10);
  });

  it("草稿按目标存取，损坏的草稿会被忽略", () => {
    const key = memoryDraftKey("project", "/project");
    assert.equal(key, "vela.memory.draft:project:/project");
    writeMemoryDraft(key, "draft\n", "sha256:abc");
    assert.deepEqual(
      { content: readMemoryDraft(key)?.content, baseRevision: readMemoryDraft(key)?.baseRevision },
      { content: "draft\n", baseRevision: "sha256:abc" },
    );
    clearMemoryDraft(key);
    assert.equal(readMemoryDraft(key), null);

    store.set(memoryDraftKey("global", null), "{not json");
    assert.equal(readMemoryDraft(memoryDraftKey("global", null)), null);
    store.set(memoryDraftKey("global", null), JSON.stringify({ content: 3, baseRevision: "x" }));
    assert.equal(readMemoryDraft(memoryDraftKey("global", null)), null);
  });

  it("兜底错误保留可读消息", () => {
    assert.equal(memoryUnexpectedError(new Error("boom"), zh), "boom");
    assert.equal(memoryUnexpectedError(null, en), en.errors["io-error"]);
  });
});
