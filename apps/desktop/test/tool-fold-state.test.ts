import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFoldStore, foldRowId, foldSequenceId, toolFoldStorageKey, type FoldStorage } from "../src/renderer/components/tool-fold-state.ts";
import { createUiStorage } from "../src/renderer/ui-storage.ts";

function storageFixture() {
  const records = new Map<string, string | null>();
  let writes = 0;
  const storage: FoldStorage = {
    getItem: key => records.get(key),
    setItem: (key, value) => { writes++; records.set(key, value); },
    removeItem: key => { records.set(key, null); },
  };
  return { storage, records, get writes() { return writes; } };
}

describe("tool fold state", () => {
  it("persists explicit values independently for a sequence and its first row", () => {
    const fixture = storageFixture();
    const store = createFoldStore({ sessionId: "a", storage: fixture.storage });
    assert.equal(store.isExpanded(foldRowId("untouched"), true), true);
    store.setExpanded(foldSequenceId("call"), true);
    store.setExpanded(foldRowId("call"), false);
    store.flush();
    const restarted = createFoldStore({ sessionId: "a", storage: fixture.storage });
    assert.equal(restarted.peekExpanded(foldSequenceId("call")), true);
    assert.equal(restarted.peekExpanded(foldRowId("call"), true), false);
    const saved = JSON.parse(fixture.records.get(toolFoldStorageKey("a"))!);
    assert.deepEqual(saved.sequences, { call: true });
    assert.deepEqual(saved.rows, { call: false });
  });

  it("debounces rapid clicks for 200ms and flushes only the last state", context => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const fixture = storageFixture();
    const store = createFoldStore({ sessionId: "a", storage: fixture.storage });
    store.setExpanded(foldRowId("call"), true);
    context.mock.timers.tick(100);
    store.setExpanded(foldRowId("call"), false);
    context.mock.timers.tick(199);
    assert.equal(fixture.writes, 0);
    context.mock.timers.tick(1);
    assert.equal(fixture.writes, 1);
    assert.equal(JSON.parse(fixture.records.get(toolFoldStorageKey("a"))!).rows.call, false);
  });

  it("flushes on teardown without a duplicate delayed write", context => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const fixture = storageFixture();
    const store = createFoldStore({ sessionId: "a", storage: fixture.storage });
    store.setExpanded(foldRowId("call"), true);
    store.flush();
    context.mock.timers.tick(500);
    assert.equal(fixture.writes, 1);
  });

  it("isolates sessions including reused tool IDs", () => {
    const fixture = storageFixture();
    const a = createFoldStore({ sessionId: "a", storage: fixture.storage });
    const b = createFoldStore({ sessionId: "b", storage: fixture.storage });
    a.setExpanded(foldRowId("call"), true);
    a.flush();
    assert.equal(b.peekExpanded(foldRowId("call")), false);
    b.setExpanded(foldRowId("call"), false);
    b.flush();
    assert.equal(createFoldStore({ sessionId: "a", storage: fixture.storage }).peekExpanded(foldRowId("call")), true);
  });

  it("uses defaults for undefined, explicit deletion and malformed JSON or schema", () => {
    for (const saved of [undefined, null, "{broken", "null", "[]", '{"rows":{},"sequences":[]}',
      '{"rows":{"call":true,"bad":"true"},"sequences":{}}']) {
      const fixture = storageFixture();
      if (saved !== undefined) fixture.records.set(toolFoldStorageKey("a"), saved);
      const store = createFoldStore({ sessionId: "a", storage: fixture.storage });
      assert.equal(store.peekExpanded(foldRowId("call")), false);
      assert.equal(store.peekExpanded(foldRowId("call"), true), true);
      store.flush();
      assert.equal(fixture.writes, 0);
    }
  });

  it("evicts least recently visited entries across both namespaces, retaining visible memory state", () => {
    const fixture = storageFixture();
    const store = createFoldStore({ sessionId: "a", storage: fixture.storage });
    for (let i = 0; i < 500; i++) store.setExpanded(i % 2 ? foldSequenceId(`${i}`) : foldRowId(`${i}`), true);
    store.isExpanded(foldRowId("0"));
    store.setExpanded(foldRowId("500"), true);
    store.flush();
    const saved = JSON.parse(fixture.records.get(toolFoldStorageKey("a"))!);
    assert.equal(Object.keys(saved.rows).length + Object.keys(saved.sequences).length, 500);
    assert.equal(saved.rows["0"], true);
    assert.equal(saved.sequences["1"], undefined);
    assert.equal(store.peekExpanded(foldSequenceId("1")), true);
    assert.equal(createFoldStore({ sessionId: "a", storage: fixture.storage }).peekExpanded(foldSequenceId("1")), false);
  });

  it("retains access order after restart", () => {
    const fixture = storageFixture();
    const first = createFoldStore({ sessionId: "a", storage: fixture.storage });
    for (let i = 0; i < 500; i++) first.setExpanded(foldRowId(`${i}`), true);
    first.isExpanded(foldRowId("0"));
    first.flush();
    const restarted = createFoldStore({ sessionId: "a", storage: fixture.storage });
    restarted.setExpanded(foldRowId("500"), true);
    restarted.flush();
    const saved = JSON.parse(fixture.records.get(toolFoldStorageKey("a"))!);
    assert.equal(saved.rows["0"], true);
    assert.equal(saved.rows["1"], undefined);
  });

  it("falls back to memory on storage failure and warns once", () => {
    const unavailable = () => { throw new Error("Unavailable"); };
    const store = createFoldStore({ sessionId: "a", storage: { getItem: unavailable, setItem: unavailable, removeItem: unavailable } });
    const warnings: unknown[] = [];
    const original = console.warn;
    console.warn = value => { warnings.push(value); };
    try {
      store.setExpanded(foldRowId("call"), true);
      store.flush();
      assert.equal(store.peekExpanded(foldRowId("call")), true);
      store.setExpanded(foldRowId("call"), false);
      store.flush();
      assert.equal(store.peekExpanded(foldRowId("call"), true), false);
      store.resetSession();
    } finally { console.warn = original; }
    assert.equal(warnings.length, 1);
  });

  it("skips persistence for missing IDs and anonymous sessions", () => {
    const fixture = storageFixture();
    const store = createFoldStore({ sessionId: null, storage: fixture.storage });
    store.setExpanded(foldRowId("call"), true);
    store.setExpanded(foldRowId(""), true);
    store.flush();
    assert.equal(store.peekExpanded(foldRowId("call")), true);
    assert.equal(fixture.records.size, 0);
    assert.equal(foldSequenceId(undefined), null);
  });

  it("reset removes saved state and cancels pending writes without affecting another session", context => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const fixture = storageFixture();
    const store = createFoldStore({ sessionId: "a", storage: fixture.storage });
    const other = createFoldStore({ sessionId: "b", storage: fixture.storage });
    other.setExpanded(foldRowId("call"), true);
    other.flush();
    store.setExpanded(foldRowId("call"), true);
    store.resetSession();
    context.mock.timers.tick(500);
    assert.equal(fixture.records.get(toolFoldStorageKey("a")), null);
    assert.equal(store.peekExpanded(foldRowId("call")), false);
    assert.equal(other.peekExpanded(foldRowId("call")), true);
  });

  it("respects uiStorage tombstones without reimporting legacy fold state", () => {
    const fixture = storageFixture();
    const legacy = { getItem: () => '{"rows":{"call":true},"sequences":{}}' } as Storage;
    const storage = createUiStorage(fixture.storage, () => legacy);
    const migrated = createFoldStore({ sessionId: "a", storage });
    assert.equal(migrated.peekExpanded(foldRowId("call")), true);
    migrated.resetSession();
    assert.equal(createFoldStore({ sessionId: "a", storage }).peekExpanded(foldRowId("call")), false);
  });
});
