import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { UiStorage } from "../src/main/ui-storage.ts";
import { createUiStorage } from "../src/renderer/ui-storage.ts";
import { parseStoredSummaries, serializeStoredSummaries, thinkingDigest, thinkingSummaryKey } from "../src/renderer/thinking-summary.ts";
import { readThinkingSummaries, thinkingSummariesStorageKey } from "../src/renderer/thinking-summary-storage.ts";

function withStore(run: (file: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), "vela-ui-storage-"));
  try { run(join(directory, "ui-state.json")); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

function bridge(store: UiStorage) {
  return {
    getItem: (key: string) => store.getItem(key),
    setItem: (key: string, value: string) => store.setItem(key, value),
    removeItem: (key: string) => store.setItem(key, null),
  };
}

function browserStorage(values: Record<string, string> = {}): Storage {
  const records = new Map(Object.entries(values));
  return {
    get length() { return records.size; },
    getItem: (key) => records.get(key) ?? null,
    setItem: (key, value) => { records.set(key, value); },
    removeItem: (key) => { records.delete(key); },
    clear: () => { records.clear(); },
    key: (index) => [...records.keys()][index] ?? null,
  };
}

describe("durable UI storage", () => {
  it("recovers v1 summaries after upgrading to v2 and keeps newer summaries across restarts", () => withStore((file) => {
    const store = new UiStorage(file);
    const oldKey = thinkingSummaryKey("history", "zh-CN", thinkingDigest("old thinking"));
    const sharedKey = thinkingSummaryKey("history", "zh-CN", thinkingDigest("shared thinking"));
    const newKey = thinkingSummaryKey("new-chat", "en", thinkingDigest("new thinking"));
    const v1 = JSON.stringify({ [oldKey]: "历史总结", [sharedKey]: "旧版总结" });
    const v2 = JSON.stringify({ [sharedKey]: "新版总结", [newKey]: "New summary" });
    store.setItem("vela.thinkingSummaries.v1", v1);
    store.setItem("vela.thinkingSummaries.v2", v2);
    const storage = createUiStorage(bridge(store), () => browserStorage());
    const recovered = readThinkingSummaries(storage);
    assert.deepEqual(recovered, parseStoredSummaries(JSON.stringify({
      [oldKey]: "历史总结", [sharedKey]: "新版总结", [newKey]: "New summary",
    })));
    assert.equal(store.getItem(thinkingSummariesStorageKey), serializeStoredSummaries(recovered));
    assert.equal(store.getItem("vela.thinkingSummaries.v1"), v1);
    assert.equal(store.getItem("vela.thinkingSummaries.v2"), v2);
    const restarted = createUiStorage(bridge(new UiStorage(file)), () => browserStorage());
    assert.deepEqual(readThinkingSummaries(restarted), recovered);
  }));

  it("imports summaries from the legacy browser store and tolerates malformed version data", () => withStore((file) => {
    const key = thinkingSummaryKey("history", "en", thinkingDigest("thinking"));
    const legacy = browserStorage({
      "vela.thinkingSummaries.v1": "malformed",
      "vela.thinkingSummaries.v2": JSON.stringify({ [key]: "Saved summary", invalid: 42 }),
    });
    const storage = createUiStorage(bridge(new UiStorage(file)), () => legacy);
    assert.deepEqual(readThinkingSummaries(storage), { [key]: { status: "done", text: "Saved summary" } });
    assert.deepEqual(readThinkingSummaries(createUiStorage(bridge(new UiStorage(file)), () => browserStorage())), {
      [key]: { status: "done", text: "Saved summary" },
    });
  }));

  it("uses the stable store after migration without reimporting removed or pruned summaries", () => withStore((file) => {
    const store = new UiStorage(file);
    store.setItem("vela.thinkingSummaries.v1", JSON.stringify({ old: "Old summary" }));
    store.setItem(thinkingSummariesStorageKey, "{}");
    assert.deepEqual(readThinkingSummaries(createUiStorage(bridge(store), () => browserStorage())), {});
  }));

  it("shows legacy summaries even if migration cannot be saved, then retries on the next read", () => {
    const storage = browserStorage({ "vela.thinkingSummaries.v1": JSON.stringify({ old: "Saved summary" }) });
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (message: string) => { errors.push(message); };
    try {
      assert.deepEqual(readThinkingSummaries({
        getItem: storage.getItem,
        setItem: () => { throw new Error("Disk full"); },
      }), { old: { status: "done", text: "Saved summary" } });
    } finally { console.error = originalError; }
    assert.equal(errors.length, 1);
    assert.equal(storage.getItem(thinkingSummariesStorageKey), null);
    assert.deepEqual(readThinkingSummaries(storage), { old: { status: "done", text: "Saved summary" } });
    assert.notEqual(storage.getItem(thinkingSummariesStorageKey), null);
  });

  it("restores summaries, automatic generation, and display style after restart on a different origin", () => withStore((file) => {
    const first = createUiStorage(bridge(new UiStorage(file)), () => browserStorage());
    const key = thinkingSummaryKey("chat-a", "zh-CN", thinkingDigest("检查持久化"));
    first.setItem("vela.thinkingSummary", "true");
    first.setItem("vela.thinkingSummaryStyle", "prose");
    const model = JSON.stringify({ provider: "custom-provider", id: "org/summary-model" });
    first.setItem("vela.thinkingSummaryModel", model);
    first.setItem("vela.thinkingSummaries.v2", serializeStoredSummaries({ [key]: { status: "done", text: "检查并修复保存逻辑。" } }));
    const restarted = createUiStorage(bridge(new UiStorage(file)), () => browserStorage({
      "vela.thinkingSummary": "false", "vela.thinkingSummaryStyle": "inline",
    }));
    assert.equal(restarted.getItem("vela.thinkingSummary"), "true");
    assert.equal(restarted.getItem("vela.thinkingSummaryStyle"), "prose");
    assert.equal(restarted.getItem("vela.thinkingSummaryModel"), model);
    assert.deepEqual(parseStoredSummaries(restarted.getItem("vela.thinkingSummaries.v2"))[key], {
      status: "done", text: "检查并修复保存逻辑。",
    });
    assert.equal(readdirSync(join(file, "..")).some((name) => name.endsWith(".tmp")), false);
  }));

  it("migrates existing browser settings and summaries without replacing saved values", () => withStore((file) => {
    const key = thinkingSummaryKey("history", "en", thinkingDigest("existing thinking"));
    const summary = serializeStoredSummaries({ [key]: { status: "done", text: "Existing summary" } });
    const store = new UiStorage(file);
    const migrated = createUiStorage(bridge(store), () => browserStorage({
      "vela.thinkingSummary": "true", "vela.thinkingSummaryStyle": "headline", "vela.thinkingSummaries.v2": summary,
    }));
    assert.equal(migrated.getItem("vela.thinkingSummary"), "true");
    assert.equal(migrated.getItem("vela.thinkingSummaryStyle"), "headline");
    assert.equal(migrated.getItem("vela.thinkingSummaries.v2"), summary);
    store.setItem("vela.thinkingSummary", "false");
    assert.equal(migrated.getItem("vela.thinkingSummary"), "false");
    assert.equal(new UiStorage(file).getItem("vela.thinkingSummaries.v2"), summary);
  }));

  it("keeps explicit removals from importing stale browser values after restart", () => withStore((file) => {
    const legacy = browserStorage({ "vela.onboarding.step": "4" });
    const storage = createUiStorage(bridge(new UiStorage(file)), () => legacy);
    assert.equal(storage.getItem("vela.onboarding.step"), "4");
    storage.removeItem("vela.onboarding.step");
    const restarted = createUiStorage(bridge(new UiStorage(file)), () => legacy);
    assert.equal(restarted.getItem("vela.onboarding.step"), null);
  }));

  it("works when localStorage is unavailable", () => withStore((file) => {
    const storage = createUiStorage(bridge(new UiStorage(file)), () => { throw new Error("Storage denied"); });
    assert.equal(storage.getItem("vela.thinkingSummary"), null);
    storage.setItem("vela.thinkingSummary", "true");
    assert.equal(storage.getItem("vela.thinkingSummary"), "true");
  }));

  it("preserves sequential updates made by another store instance", () => withStore((file) => {
    const first = new UiStorage(file);
    const second = new UiStorage(file);
    first.setItem("vela.thinkingSummary", "true");
    second.setItem("vela.thinkingSummaryStyle", "headline");
    first.setItem("vela.locale", "en");
    assert.equal(second.getItem("vela.thinkingSummary"), "true");
    assert.equal(first.getItem("vela.thinkingSummaryStyle"), "headline");
    assert.equal(second.getItem("vela.locale"), "en");
  }));

  it("rejects invalid IPC payloads and leaves the saved file intact", () => withStore((file) => {
    const store = new UiStorage(file);
    store.setItem("vela.thinkingSummaryStyle", "prose");
    const original = readFileSync(file, "utf8");
    assert.throws(() => store.setItem("other.key", "value"));
    assert.throws(() => store.setItem("vela.thinkingSummary", { value: true }));
    assert.throws(() => store.getItem(null));
    assert.throws(() => store.setItem("vela.tooLarge", "x".repeat(16 * 1024 * 1024)));
    assert.equal(readFileSync(file, "utf8"), original);
  }));

  it("reports malformed data without overwriting it with defaults", () => withStore((file) => {
    writeFileSync(file, "malformed");
    const store = new UiStorage(file);
    assert.throws(() => store.getItem("vela.thinkingSummary"));
    assert.throws(() => store.setItem("vela.thinkingSummary", "false"));
    assert.equal(readFileSync(file, "utf8"), "malformed");
  }));

  it("continues to support browser previews without the desktop bridge", () => {
    const legacy = browserStorage();
    const storage = createUiStorage(undefined, () => legacy);
    storage.setItem("vela.thinkingSummary", "true");
    assert.equal(storage.getItem("vela.thinkingSummary"), "true");
    storage.removeItem("vela.thinkingSummary");
    assert.equal(storage.getItem("vela.thinkingSummary"), null);
  });
});
