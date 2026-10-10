import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { tokenizeInline } from "../src/renderer/components/intelligent-ui/inline-text.ts";
import { formatCell, nextSort, visibleRowIndexes, type TableColumn, type TableRow } from "../src/renderer/components/intelligent-ui/table-model.ts";
import {
  createUiStateStore,
  stableUiMessageId,
  uiMessageOrdinal,
  uiSourceFingerprint,
  type UiStateStorage,
} from "../src/renderer/components/intelligent-ui/ui-state-store.ts";

function memoryStorage(): UiStateStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value); },
    removeItem: key => { data.delete(key); },
  };
}

describe("Intelligent UI inline text", () => {
  it("tokenizes the Markdown subset without producing markup", () => {
    assert.deepEqual(tokenizeInline("a **b** *c* `d` [e](https://x.test/p?q=1) f"), [
      { type: "text", text: "a " }, { type: "bold", text: "b" }, { type: "text", text: " " },
      { type: "italic", text: "c" }, { type: "text", text: " " }, { type: "code", text: "d" }, { type: "text", text: " " },
      { type: "link", text: "e", href: "https://x.test/p?q=1" }, { type: "text", text: " f" },
    ]);
  });

  it("keeps raw HTML and unsafe links as inert text", () => {
    const html = tokenizeInline('<img src=x onerror="1"><script>1</script>');
    assert.deepEqual(html, [{ type: "text", text: '<img src=x onerror="1"><script>1</script>' }]);
    for (const href of ["javascript:alert(1)", "data:text/html,1", "file:///etc/passwd", "vbscript:x"]) {
      const tokens = tokenizeInline(`[go](${href})`);
      assert.equal(tokens.some(token => token.type === "link"), false, href);
    }
    assert.equal(tokenizeInline("2 * 3 * 4").some(token => token.type === "italic"), false);
  });
});

describe("Intelligent UI table model", () => {
  const columns: TableColumn[] = [
    { key: "name", label: "Name", align: "left", sortable: true },
    { key: "price", label: "Price", align: "right", sortable: true, prefix: "$", digits: 2 },
    { key: "tier", label: "Tier", align: "left", sortable: false },
  ];
  const row = (name: string, price: number | null, tier: string): TableRow => ({ cells: { name, price, tier }, detail: null });
  const rows = [row("beta", 15, "fast"), row("Alpha", null, "cheap"), row("gamma 10", 1.5, "cheap"), row("gamma 2", 0.5, "fast")];
  const base = { sort: null, search: "", filter: null };

  it("sorts numerically and naturally with empty values last in both directions", () => {
    assert.deepEqual(visibleRowIndexes(rows, columns, { ...base, sort: { column: "price", direction: "asc" } }), [3, 2, 0, 1]);
    assert.deepEqual(visibleRowIndexes(rows, columns, { ...base, sort: { column: "price", direction: "desc" } }), [0, 2, 3, 1]);
    assert.deepEqual(visibleRowIndexes(rows, columns, { ...base, sort: { column: "name", direction: "asc" } }), [1, 0, 3, 2]);
  });

  it("filters by the bound state and searches every column", () => {
    const filter = (value: string | null) => ({ column: "tier", value, allValue: "all" });
    assert.deepEqual(visibleRowIndexes(rows, columns, { ...base, filter: filter("cheap") }), [1, 2]);
    assert.deepEqual(visibleRowIndexes(rows, columns, { ...base, filter: filter("all") }), [0, 1, 2, 3]);
    assert.deepEqual(visibleRowIndexes(rows, columns, { ...base, filter: filter(null) }), [0, 1, 2, 3]);
    assert.deepEqual(visibleRowIndexes(rows, columns, { ...base, search: " GAMMA " }), [2, 3]);
    assert.deepEqual(visibleRowIndexes(rows, columns, { sort: { column: "price", direction: "asc" }, search: "gamma", filter: filter("cheap") }), [2]);
    assert.deepEqual(visibleRowIndexes(rows, columns, { ...base, search: "zzz" }), []);
  });

  it("cycles sort asc → desc → off and formats cells", () => {
    assert.deepEqual(nextSort(null, "a"), { column: "a", direction: "asc" });
    assert.deepEqual(nextSort({ column: "a", direction: "asc" }, "a"), { column: "a", direction: "desc" });
    assert.equal(nextSort({ column: "a", direction: "desc" }, "a"), null);
    assert.deepEqual(nextSort({ column: "a", direction: "desc" }, "b"), { column: "b", direction: "asc" });
    const labels = { yes: "是", no: "否" };
    assert.equal(formatCell(15, columns[1], labels), "$15.00");
    assert.equal(formatCell(null, columns[1], labels), "—");
    assert.equal(formatCell(true, columns[2], labels), "是");
    assert.equal(formatCell(120, { ...columns[1], prefix: undefined, digits: undefined, unit: "t/s" }, labels), "120 t/s");
  });
});

describe("Intelligent UI state store", () => {
  const scope = { conversationId: "c1", messageId: "u0", artifactId: "split" };
  const print = uiSourceFingerprint("split", '{"op":"begin"}');

  it("round-trips a snapshot and rejects a different definition", () => {
    const store = createUiStateStore(memoryStorage());
    store.save(scope, print, { people: 8, flag: true });
    assert.deepEqual(store.load(scope, print), { people: 8, flag: true });
    assert.equal(store.load(scope, uiSourceFingerprint("split", "rewritten")), null);
    assert.equal(store.load({ ...scope, messageId: "u1" }, print), null);
    assert.equal(store.load({ ...scope, conversationId: "c2" }, print), null);
  });

  it("survives corrupt, wrong-version and hostile stored data", () => {
    const storage = memoryStorage();
    const store = createUiStateStore(storage);
    const key = "vela.ui.state.c1.u0.split";
    for (const raw of ["{nope", "[]", "null", '{"v":99,"hash":"x","values":{}}', `{"v":1,"hash":"${print}","values":[1]}`, `{"v":1,"hash":"${print}"}`]) {
      storage.setItem(key, raw);
      assert.equal(store.load(scope, print), null, raw);
    }
    storage.setItem(key, `{"v":1,"hash":"${print}","values":{"__proto__":{"x":1},"constructor":2,"ok":1}}`);
    assert.deepEqual(store.load(scope, print), { ok: 1 });
    const throwing: UiStateStorage = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } };
    const blocked = createUiStateStore(throwing);
    assert.equal(blocked.load(scope, print), null);
    assert.doesNotThrow(() => blocked.save(scope, print, { a: 1 }));
    assert.doesNotThrow(() => blocked.removeConversation("c1"));
  });

  it("refuses oversized snapshots instead of filling storage", () => {
    const storage = memoryStorage();
    const store = createUiStateStore(storage);
    store.save(scope, print, { text: "x".repeat(20_000) });
    assert.equal(storage.data.size, 0);
  });

  it("prunes positions that no longer exist after rewind or edit", () => {
    const storage = memoryStorage();
    const store = createUiStateStore(storage);
    for (const ordinal of [0, 1, 2]) store.save({ ...scope, messageId: stableUiMessageId(ordinal) }, print, { n: ordinal });
    store.pruneConversation("c1", 1);
    assert.deepEqual(store.load({ ...scope, messageId: "u0" }, print), { n: 0 });
    assert.equal(store.load({ ...scope, messageId: "u1" }, print), null);
    assert.equal(store.load({ ...scope, messageId: "u2" }, print), null);
    assert.equal([...storage.data.keys()].filter(key => key.startsWith("vela.ui.state.c1.")).length, 1);
    store.pruneConversation("c1", 0);
    assert.equal(storage.data.size, 0, "index entry is dropped with the last snapshot");
  });

  it("copies snapshots on branch without sharing them", () => {
    const store = createUiStateStore(memoryStorage());
    store.save(scope, print, { n: 1 });
    store.copyConversation("c1", "c2");
    assert.deepEqual(store.load({ ...scope, conversationId: "c2" }, print), { n: 1 });
    store.save({ ...scope, conversationId: "c2" }, print, { n: 99 });
    assert.deepEqual(store.load(scope, print), { n: 1 }, "original is untouched");
    store.copyConversation("c1", "c1");
    store.copyConversation("missing", "c3");
    assert.equal(store.load({ ...scope, conversationId: "c3" }, print), null);
  });

  it("removes a conversation's snapshots entirely", () => {
    const storage = memoryStorage();
    const store = createUiStateStore(storage);
    store.save(scope, print, { n: 1 });
    store.save({ ...scope, conversationId: "other" }, print, { n: 2 });
    store.removeConversation("c1");
    assert.equal(store.load(scope, print), null);
    assert.deepEqual(store.load({ ...scope, conversationId: "other" }, print), { n: 2 });
    assert.equal([...storage.data.keys()].some(key => key.includes(".c1")), false);
  });

  it("caps the per-conversation index", () => {
    const storage = memoryStorage();
    const store = createUiStateStore(storage);
    for (let ordinal = 0; ordinal < 410; ordinal += 1) store.save({ ...scope, messageId: stableUiMessageId(ordinal) }, print, { n: ordinal });
    const index = JSON.parse(storage.data.get("vela.ui.index.c1")!) as string[];
    assert.equal(index.length, 400);
    assert.equal(store.load({ ...scope, messageId: "u0" }, print), null);
    assert.deepEqual(store.load({ ...scope, messageId: "u409" }, print), { n: 409 });
  });

  it("maps stable message ids", () => {
    assert.equal(stableUiMessageId(3), "u3");
    assert.equal(uiMessageOrdinal("u3"), 3);
    assert.equal(uiMessageOrdinal("x3"), -1);
    assert.equal(uiMessageOrdinal("u"), -1);
  });
});
