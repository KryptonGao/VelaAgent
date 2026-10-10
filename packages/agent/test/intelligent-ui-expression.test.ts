import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  collectRefs,
  evaluateExpression,
  formatNumber,
  parseExpression,
  roundTo,
  sortDerived,
  type UiEvalEnv,
  type UiEvalResult,
  type UiExpression,
} from "@vela/shared";

const env = (values: Record<string, number | string | boolean | null>): UiEvalEnv =>
  new Map(Object.entries(values).map(([key, value]) => [key, { ok: true, value } as UiEvalResult]));

function run(expression: unknown, values: Record<string, number | string | boolean | null> = {}): UiEvalResult {
  const parsed = parseExpression(expression);
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.reason);
  return evaluateExpression(parsed.expression, env(values));
}

describe("Intelligent UI expressions", () => {
  it("computes the bill split example", () => {
    const expression = { op: "round", args: [{ op: "divide", args: [{ ref: "amount" }, { ref: "people" }] }, 2] };
    assert.deepEqual(run(expression, { amount: 240, people: 5 }), { ok: true, value: 48 });
    assert.deepEqual(run(expression, { amount: 100, people: 3 }), { ok: true, value: 33.33 });
  });

  it("reports division by zero and non-finite results instead of Infinity", () => {
    assert.deepEqual(run({ op: "divide", args: [1, { ref: "n" }] }, { n: 0 }), { ok: false, error: "division_by_zero" });
    assert.deepEqual(run({ op: "multiply", args: [1e308, 10] }), { ok: false, error: "not_finite" });
    assert.deepEqual(run({ op: "add", args: [1e308, 1e308] }), { ok: false, error: "not_finite" });
  });

  it("rounds half away from zero without binary float drift", () => {
    assert.deepEqual(roundTo(1.005, 2), { ok: true, value: 1.01 });
    assert.deepEqual(roundTo(-1.005, 2), { ok: true, value: -1.01 });
    assert.deepEqual(roundTo(2.5, 0), { ok: true, value: 3 });
    assert.deepEqual(roundTo(-0.0001, 2), { ok: true, value: 0 });
    assert.deepEqual(roundTo(1234.5678, 1, "floor"), { ok: true, value: 1234.5 });
    assert.deepEqual(roundTo(-1234.5678, 1, "floor"), { ok: true, value: -1234.6 });
    assert.deepEqual(roundTo(-1234.5678, 1, "ceil"), { ok: true, value: -1234.5 });
    assert.deepEqual(roundTo(1234.5611, 1, "ceil"), { ok: true, value: 1234.6 });
    assert.deepEqual(roundTo(1e-7, 2), { ok: true, value: 0 });
    assert.deepEqual(roundTo(1e21, 2), { ok: true, value: 1e21 });
    assert.deepEqual(run({ op: "round", args: [1.5, 11] }), { ok: false, error: "bad_arguments" });
  });

  it("evaluates if lazily so guarded divisions stay valid", () => {
    const guarded = { op: "if", args: [
      { op: "compare", args: [{ ref: "n" }, "gt", 0] },
      { op: "divide", args: [10, { ref: "n" }] },
      null,
    ] };
    assert.deepEqual(run(guarded, { n: 0 }), { ok: true, value: null });
    assert.deepEqual(run(guarded, { n: 4 }), { ok: true, value: 2.5 });
    assert.deepEqual(run({ op: "if", args: [1, 2, 3] }), { ok: false, error: "type_mismatch" });
  });

  it("supports comparison, logic, min/max, concat and format", () => {
    assert.deepEqual(run({ op: "compare", args: ["b", "gt", "a"] }), { ok: true, value: true });
    assert.deepEqual(run({ op: "compare", args: [1, "eq", "1"] }), { ok: true, value: false });
    assert.deepEqual(run({ op: "compare", args: [1, "lt", "1"] }), { ok: false, error: "type_mismatch" });
    assert.deepEqual(run({ op: "compare", args: [1, "bogus", 2] }), { ok: false, error: "bad_arguments" });
    assert.deepEqual(run({ op: "and", args: [true, { op: "not", args: [false] }] }), { ok: true, value: true });
    assert.deepEqual(run({ op: "or", args: [true, { ref: "missing" }] }), { ok: true, value: true });
    assert.deepEqual(run({ op: "min", args: [3, 1, 2] }), { ok: true, value: 1 });
    assert.deepEqual(run({ op: "max", args: [3, 1, 2] }), { ok: true, value: 3 });
    assert.deepEqual(run({ op: "concat", args: ["共 ", { ref: "n" }, " 人", null] }, { n: 5 }), { ok: true, value: "共 5 人" });
    assert.deepEqual(run({ op: "format", args: [1234567.891, 2] }), { ok: true, value: "1,234,567.89" });
    assert.deepEqual(run({ op: "format", args: [0.1234, 1, "percent"] }), { ok: true, value: "12.3%" });
    assert.deepEqual(run({ op: "format", args: [1234.5, 0, "fixed"] }), { ok: true, value: "1235" });
    assert.deepEqual(formatNumber(-0.001, 2, "number"), { ok: true, value: "0.00" });
  });

  it("propagates unknown references and invalid inputs", () => {
    assert.deepEqual(run({ ref: "ghost" }), { ok: false, error: "unknown_ref" });
    const invalid: UiEvalEnv = new Map([["people", { ok: false, error: "invalid_input" } as UiEvalResult]]);
    const parsed = parseExpression({ op: "divide", args: [1, { ref: "people" }] });
    assert.ok(parsed.ok);
    assert.deepEqual(evaluateExpression(parsed.expression, invalid), { ok: false, error: "invalid_input" });
  });

  it("rejects malformed, oversized and hostile expressions", () => {
    const reasons = (value: unknown) => { const parsed = parseExpression(value); return parsed.ok ? null : parsed.reason; };
    assert.ok(reasons({ op: "eval", args: ["1+1"] }));
    assert.ok(reasons({ op: "add", args: [1] }));
    assert.ok(reasons({ op: "add", args: [1, 2], extra: true }));
    assert.ok(reasons({ ref: "a", op: "add" }));
    assert.ok(reasons({ ref: "__proto__" }));
    assert.ok(reasons({ ref: "has space" }));
    assert.ok(reasons(JSON.parse('{"op":"add","args":[1,{"__proto__":{"x":1}}]}')));
    assert.ok(reasons({ op: "add", args: [1, undefined] }));
    assert.ok(reasons(() => 1));
    assert.ok(reasons("x".repeat(501)));
    let deep: unknown = 1;
    for (let index = 0; index < 20; index += 1) deep = { op: "abs", args: [deep] };
    assert.match(reasons(deep) ?? "", /deep/);
    const wide = { op: "add", args: Array.from({ length: 16 }, () => ({ op: "add", args: [1, 2, 3, 4, 5] })) };
    assert.match(reasons(wide) ?? "", /large/);
  });

  it("collects references", () => {
    const parsed = parseExpression({ op: "if", args: [{ ref: "a" }, { op: "add", args: [{ ref: "b" }, 1] }, { ref: "a" }] });
    assert.ok(parsed.ok);
    assert.deepEqual([...collectRefs(parsed.expression)].sort(), ["a", "b"]);
  });

  it("sorts derived values topologically and detects cycles", () => {
    const expr = (name: string): UiExpression => ({ ref: name });
    const sorted = sortDerived(new Set(["s"]), [
      { name: "c", expression: { op: "add", args: [expr("b"), expr("a")] } },
      { name: "b", expression: expr("a") },
      { name: "a", expression: expr("s") },
    ]);
    assert.deepEqual(sorted, { ok: true, order: ["a", "b", "c"] });
    const cyclic = sortDerived(new Set(), [
      { name: "a", expression: expr("b") },
      { name: "b", expression: expr("a") },
    ]);
    assert.equal(cyclic.ok, false);
    assert.equal(!cyclic.ok && cyclic.reason, "cyclic_reference");
    const selfLoop = sortDerived(new Set(), [{ name: "a", expression: expr("a") }]);
    assert.equal(!selfLoop.ok && selfLoop.reason, "cyclic_reference");
    const unknown = sortDerived(new Set(), [{ name: "a", expression: expr("nope") }]);
    assert.equal(!unknown.ok && unknown.reason, "bad_reference");
  });

  it("does not expose host objects through ref lookup", () => {
    // Map-based env: inherited property names are just unknown references.
    assert.deepEqual(run({ ref: "toString" }), { ok: false, error: "unknown_ref" });
  });
});
