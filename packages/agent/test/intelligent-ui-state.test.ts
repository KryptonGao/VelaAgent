import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildUiEnv,
  composeUiSubmission,
  formatUiNumber,
  initialUiValues,
  isUiNodeVisible,
  parseUiMessage,
  parseAction,
  resolveUiValue,
  restoreUiValues,
  safeExternalUrl,
  summarizeUiArtifact,
  uiComponentTypes,
  validateNodeProps,
  validateStateValue,
  type UiArtifact,
  type UiSegment,
} from "@vela/shared";
import { billSplit, fenced } from "./fixtures/intelligent-ui.ts";

const now = () => 0;

function artifactOf(lines: string[]): UiArtifact {
  const segment = parseUiMessage(fenced(lines), { now }).find((item): item is Extract<UiSegment, { type: "ui" }> => item.type === "ui");
  assert.ok(segment);
  return segment.artifact;
}

describe("Intelligent UI local state", () => {
  it("computes the bill split and recomputes when people change", () => {
    const artifact = artifactOf(billSplit);
    const values = initialUiValues(artifact);
    assert.deepEqual(values, { amount: 240, people: 5 });
    const total = artifact.nodes.find(node => node.id === "total")!;
    assert.deepEqual(resolveUiValue(total.props.value, buildUiEnv(artifact, values)), { ok: true, value: 48 });
    assert.deepEqual(resolveUiValue(total.props.value, buildUiEnv(artifact, { ...values, people: 8 })), { ok: true, value: 30 });
  });

  it("turns invalid input into a readable error instead of Infinity or a crash", () => {
    const artifact = artifactOf(billSplit);
    const total = artifact.nodes.find(node => node.id === "total")!;
    const compute = (people: number | null) => resolveUiValue(total.props.value, buildUiEnv(artifact, { amount: 240, people }));
    assert.deepEqual(compute(0), { ok: false, error: "invalid_input" });
    assert.deepEqual(compute(null), { ok: false, error: "invalid_input" });
    assert.deepEqual(compute(Number.NaN), { ok: false, error: "invalid_input" });
    assert.deepEqual(compute(Number.POSITIVE_INFINITY), { ok: false, error: "invalid_input" });
    // Without a declared minimum the same input reaches the evaluator and reports a division error.
    const open = artifactOf(billSplit.map(line => line.replace(',"min":1', "")));
    const openTotal = open.nodes.find(node => node.id === "total")!;
    assert.deepEqual(resolveUiValue(openTotal.props.value, buildUiEnv(open, { amount: 240, people: 0 })), { ok: false, error: "division_by_zero" });
  });

  it("validates each state kind", () => {
    const artifact = artifactOf([
      '{"op":"begin","id":"v","version":1}',
      '{"op":"state","name":"n","kind":"number","initial":2,"min":1,"max":4}',
      '{"op":"state","name":"s","kind":"string","initial":"a","options":["a","b"]}',
      '{"op":"state","name":"t","kind":"string","initial":"","maxLength":3}',
      '{"op":"state","name":"b","kind":"boolean","initial":false}',
      '{"op":"node","id":"root","type":"column","props":{}}',
      '{"op":"commit"}',
    ]);
    const [n, s, t, b] = artifact.stateDefinitions;
    assert.equal(validateStateValue(n, 2), null);
    assert.equal(validateStateValue(n, 0), "below_min");
    assert.equal(validateStateValue(n, 5), "above_max");
    assert.equal(validateStateValue(n, null), "required");
    assert.equal(validateStateValue(n, "2"), "not_a_number");
    assert.equal(validateStateValue(s, "b"), null);
    assert.equal(validateStateValue(s, "c"), "not_an_option");
    assert.equal(validateStateValue(t, "abcd"), "too_long");
    assert.equal(validateStateValue(b, true), null);
    assert.equal(validateStateValue(b, "true"), "wrong_type");
  });

  it("restores saved snapshots defensively and keeps cleared number fields", () => {
    const artifact = artifactOf([
      '{"op":"begin","id":"r","version":1}',
      '{"op":"state","name":"n","kind":"number","initial":2}',
      '{"op":"state","name":"s","kind":"string","initial":"a","options":["a","b"]}',
      '{"op":"state","name":"b","kind":"boolean","initial":false}',
      '{"op":"node","id":"root","type":"column","props":{}}',
      '{"op":"commit"}',
    ]);
    assert.deepEqual(restoreUiValues(artifact, { n: 7, s: "b", b: true }), { n: 7, s: "b", b: true });
    assert.deepEqual(restoreUiValues(artifact, { n: null }), { n: null, s: "a", b: false });
    assert.deepEqual(restoreUiValues(artifact, { n: "x", s: "gone", b: 1, extra: 1, __proto__: { n: 9 } }), { n: 2, s: "a", b: false });
    assert.deepEqual(restoreUiValues(artifact, null), { n: 2, s: "a", b: false });
    assert.deepEqual(restoreUiValues(artifact, [1, 2]), { n: 2, s: "a", b: false });
    assert.deepEqual(restoreUiValues(artifact, { n: Number.POSITIVE_INFINITY }), { n: 2, s: "a", b: false });
  });

  it("evaluates derived values in dependency order and shows pending refs while receiving", () => {
    const artifact = artifactOf([
      '{"op":"begin","id":"d","version":1}',
      '{"op":"state","name":"price","kind":"number","initial":10}',
      '{"op":"derive","name":"total","expr":{"op":"add","args":[{"ref":"tax"},{"ref":"price"}]}}',
      '{"op":"derive","name":"tax","expr":{"op":"multiply","args":[{"ref":"price"},0.1]}}',
      '{"op":"node","id":"root","type":"column","props":{}}',
      '{"op":"commit"}',
    ]);
    assert.deepEqual(artifact.derivedOrder, ["tax", "total"]);
    const env = buildUiEnv(artifact, initialUiValues(artifact));
    assert.deepEqual(env.get("total"), { ok: true, value: 11 });
    const receiving = parseUiMessage(fenced([
      '{"op":"begin","id":"d2","version":1}',
      '{"op":"derive","name":"total","expr":{"ref":"later"}}',
    ]).replace(/\n```$/, "\n"), { now, final: false }).find(item => item.type === "ui") as Extract<UiSegment, { type: "ui" }>;
    assert.deepEqual(buildUiEnv(receiving.artifact, {}).get("total"), { ok: false, error: "pending_ref" });
  });

  it("shows nodes by show-condition and hides them on evaluation errors", () => {
    const artifact = artifactOf([
      '{"op":"begin","id":"tabs","version":1}',
      '{"op":"state","name":"tab","kind":"string","initial":"sss","options":["sss","sas"]}',
      '{"op":"node","id":"root","type":"column","props":{}}',
      '{"op":"node","id":"tabs","parent":"root","type":"tabs","props":{"bind":"tab","label":"判定","options":[{"value":"sss","label":"SSS"},{"value":"sas","label":"SAS"}]}}',
      '{"op":"node","id":"p1","parent":"tabs","type":"text","props":{"text":"三边","show":{"op":"compare","args":[{"ref":"tab"},"eq","sss"]}}}',
      '{"op":"node","id":"p2","parent":"tabs","type":"text","props":{"text":"两边夹角","show":{"op":"compare","args":[{"ref":"tab"},"eq","sas"]}}}',
      '{"op":"node","id":"p3","parent":"tabs","type":"text","props":{"text":"坏条件","show":{"op":"divide","args":[1,0]}}}',
      '{"op":"commit"}',
    ]);
    const visible = (tab: string) => {
      const env = buildUiEnv(artifact, { tab });
      return artifact.nodes.filter(node => isUiNodeVisible(node, env)).map(node => node.id);
    };
    assert.deepEqual(visible("sss"), ["root", "tabs", "p1"]);
    assert.deepEqual(visible("sas"), ["root", "tabs", "p2"]);
  });

  it("composes the exact text sent to the agent, with labels and option names", () => {
    const artifact = artifactOf([
      '{"op":"begin","id":"s","version":1,"title":"出行"}',
      '{"op":"state","name":"people","kind":"number","initial":2}',
      '{"op":"state","name":"plan","kind":"string","initial":"eco","options":["eco","pro"]}',
      '{"op":"state","name":"insured","kind":"boolean","initial":true}',
      '{"op":"node","id":"root","type":"column","props":{}}',
      '{"op":"node","id":"n","parent":"root","type":"number_input","props":{"label":"人数","bind":"people"}}',
      '{"op":"node","id":"p","parent":"root","type":"select","props":{"label":"方案","bind":"plan","options":[{"value":"eco","label":"经济"},{"value":"pro","label":"专业"}]}}',
      '{"op":"node","id":"c","parent":"root","type":"checkbox","props":{"label":"含保险","bind":"insured"}}',
      '{"op":"commit"}',
    ]);
    const values = { people: 4, plan: "pro", insured: false };
    const text = composeUiSubmission(artifact, { type: "submit_to_agent", text: "按这些参数继续" }, values);
    assert.match(text, /^按这些参数继续\n\nCurrent parameters \[出行\]:/);
    assert.match(text, /- 人数 \(people\): 4/);
    assert.match(text, /- 方案 \(plan\): 专业 \(pro\)/);
    assert.match(text, /- 含保险 \(insured\): no/);
    const only = composeUiSubmission(artifact, { type: "submit_to_agent", text: "继续", include: ["people", "ghost"] }, values);
    assert.equal(only.includes("方案"), false);
    assert.equal(only.includes("ghost"), false);
    const bare = composeUiSubmission(artifact, { type: "submit_to_agent", text: "继续", include: [] }, values);
    assert.equal(bare, "继续");
  });

  it("summarises the current parameters and results as text for export", () => {
    const artifact = artifactOf(billSplit);
    const text = summarizeUiArtifact(artifact, { amount: 240, people: 8 });
    assert.match(text, /\*\*账单平摊\*\*/);
    assert.match(text, /总额: 240 元/);
    assert.match(text, /人数: 8/);
    assert.match(text, /每人金额: 30.00 元/);
    const failing = summarizeUiArtifact(artifact, { amount: 240, people: 0 });
    assert.match(failing, /每人金额: \(unavailable\)/);
    assert.equal(summarizeUiArtifact({ ...artifact, status: "invalid" }), "");
    assert.match(summarizeUiArtifact({ ...artifact, status: "incomplete" }), /\(incomplete\)/);
  });

  it("formats numbers for display", () => {
    assert.equal(formatUiNumber(48, 2), "48.00");
    assert.equal(formatUiNumber(1234567.5), "1,234,567.5");
    assert.equal(formatUiNumber(0.1 + 0.2), "0.3");
    assert.equal(formatUiNumber(-3), "-3");
    assert.equal(formatUiNumber(1e21), "1,000,000,000,000,000,000,000");
  });
});

describe("Intelligent UI component registry", () => {
  const ok = (type: string, props: unknown) => {
    const result = validateNodeProps(type, props);
    assert.ok(result.ok, result.ok ? "" : `${type}: ${result.reason}`);
    return result.value;
  };
  const bad = (type: string, props: unknown) => {
    const result = validateNodeProps(type, props);
    assert.equal(result.ok, false, `${type} should reject ${JSON.stringify(props)}`);
  };

  it("accepts a valid example for every whitelisted component", () => {
    const samples: Record<string, unknown> = {
      text: { text: "hi", tone: "muted" },
      heading: { text: "h", level: 3 },
      caption: { text: "c" },
      code: { code: "ls", language: "sh" },
      column: { gap: "lg" },
      row: {},
      grid: { columns: 3 },
      divider: {},
      card: { title: "t" },
      table: { columns: [{ key: "a", label: "A", sortable: true }], rows: [{ a: 1, detail: "d" }] },
      stat: { label: "l", value: 3 },
      progress: { label: "p", value: 30 },
      list: { items: ["a", { text: "b", detail: "c" }] },
      tabs: { bind: "x", label: "t", options: ["a", "b"] },
      segmented: { bind: "x", label: "t", options: ["a", "b"] },
      select: { bind: "x", label: "t", options: ["a", "b"] },
      radio: { bind: "x", label: "t", options: ["a", "b"] },
      input: { bind: "x", label: "t" },
      number_input: { bind: "x", label: "t" },
      slider: { bind: "x", label: "t" },
      checkbox: { bind: "x", label: "t" },
      button: { label: "go", action: { type: "toggle", name: "x" } },
      collapsible: { title: "t" },
      loading: {},
      empty: { title: "nothing" },
      error: { title: "oops" },
    };
    assert.deepEqual(Object.keys(samples).sort(), [...uiComponentTypes].sort());
    for (const [type, props] of Object.entries(samples)) ok(type, props);
  });

  it("drops unknown fields instead of carrying them into the renderer", () => {
    const { props } = ok("text", { text: "hi", onClick: "alert(1)", style: "x", dangerouslySetInnerHTML: { __html: "<b>" } });
    assert.deepEqual(props, { text: "hi", tone: "default" });
    const table = ok("table", { columns: [{ key: "a", label: "A", href: "javascript:1" }], rows: [{ a: 1, hidden: "x" }] }).props as { rows: Array<{ cells: Record<string, unknown> }>; columns: Array<Record<string, unknown>> };
    assert.deepEqual(Object.keys(table.rows[0].cells), ["a"]);
    assert.equal("href" in table.columns[0], false);
  });

  it("rejects type mismatches, ranges and oversize values", () => {
    bad("text", {});
    bad("text", { text: 1 });
    bad("text", { text: "x".repeat(8_001) });
    bad("heading", { text: "h", level: 9 });
    bad("grid", { columns: 0 });
    bad("grid", { columns: 1.5 });
    bad("column", { gap: "huge" });
    bad("stat", { label: "x" });
    bad("stat", { label: "x", value: { op: "eval", args: [] } });
    bad("stat", { label: "x", value: 1, status: "fine" });
    bad("progress", { label: "p", value: 1, max: 0 });
    bad("tabs", { bind: "x", label: "t", options: [] });
    bad("tabs", { bind: "x", label: "t", options: ["a", "a"] });
    bad("tabs", { bind: "__proto__", label: "t", options: ["a"] });
    bad("select", { bind: "x", label: "t", options: Array.from({ length: 101 }, (_, i) => `o${i}`) });
    bad("table", { columns: [], rows: [] });
    bad("table", { columns: [{ key: "a" }, { key: "a" }], rows: [] });
    bad("table", { columns: [{ key: "a" }], rows: [{ a: { nested: true } }] });
    bad("table", { columns: [{ key: "a" }], rows: [], filter: { bind: "x", column: "missing" } });
    bad("list", { items: [1] });
    bad("input", { label: "x" });
    bad("button", { label: "x" });
    bad("button", { label: "x", action: { type: "eval", code: "1" } });
    bad("code", { code: "x".repeat(8_001) });
    bad("text", { text: "x", children: [] });
    bad("iframe", { src: "https://x" });
    bad("script", {});
    bad("text", "not an object");
  });

  it("restricts actions to the registered, bounded set", () => {
    const refs = { refs: new Set<string>() };
    assert.deepEqual(parseAction({ type: "set_state", name: "a", value: 1 }, refs), { type: "set_state", name: "a", value: 1 });
    assert.deepEqual(parseAction({ type: "toggle", name: "a" }, refs), { type: "toggle", name: "a" });
    assert.deepEqual(parseAction({ type: "open_external", url: "https://example.com/a" }, refs), { type: "open_external", url: "https://example.com/a" });
    assert.deepEqual([...refs.refs], ["a"]);
    const throws = (value: unknown) => assert.throws(() => parseAction(value, { refs: new Set() }));
    throws({ type: "open_external", url: "javascript:alert(1)" });
    throws({ type: "open_external", url: "file:///etc/passwd" });
    throws({ type: "open_external", url: "data:text/html,<script>1</script>" });
    throws({ type: "open_external", url: " JaVaScRiPt:alert(1)" });
    throws({ type: "set_state", name: "a", value: { x: 1 } });
    throws({ type: "set_state", name: "a", value: Number.POSITIVE_INFINITY });
    throws({ type: "set_state", name: "a b", value: 1 });
    throws({ type: "request_tool", tool: "bash" });
    throws({ type: "submit_to_agent", text: "" });
    throws({ type: "submit_to_agent", text: "x".repeat(2_001) });
    throws({ type: "submit_to_agent", text: "go", include: ["__proto__"] });
    throws({ type: "run", command: "rm -rf /" });
    throws("toggle");
    throws(null);
  });

  it("allows only safe external protocols", () => {
    assert.equal(safeExternalUrl("https://example.com"), "https://example.com");
    assert.equal(safeExternalUrl("mailto:a@b.co"), "mailto:a@b.co");
    for (const url of ["javascript:alert(1)", "file:///x", "data:text/html,1", "vbscript:x", "ftp://x", "//evil.example", "/relative", "", "https://x\u0000y", 42, null]) {
      assert.equal(safeExternalUrl(url), null, String(url));
    }
  });

  it("flags source notes as model-provided and rejects unsafe source links", () => {
    const value = ok("stat", { label: "x", value: 1, source: { label: "Vendor docs", url: "https://example.com" } });
    assert.deepEqual(value.props.source, { label: "Vendor docs", url: "https://example.com" });
    bad("stat", { label: "x", value: 1, source: { label: "x", url: "javascript:1" } });
    assert.deepEqual(ok("stat", { label: "x", value: 1, source: "Internal wiki" }).props.source, { label: "Internal wiki" });
  });

  it("reports references and bindings for commit-time checks", () => {
    const value = ok("slider", { bind: "n", label: "x", show: { op: "compare", args: [{ ref: "mode" }, "eq", "a"] } });
    assert.deepEqual([...value.refs].sort(), ["mode", "n"]);
    assert.deepEqual(value.bindings, [{ name: "n", kind: "number" }]);
    assert.ok(value.show);
  });
});
