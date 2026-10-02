import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { thinkingEdges } from "../src/renderer/components/thinking-edges.ts";

describe("thinking edge visibility", () => {
  it("clears both edges when the content fits, including overscroll", () => {
    for (const position of [-10, 0, 10]) {
      assert.deepEqual(thinkingEdges(position, 100, 280), { top: 0, bottom: 0 });
    }
  });

  it("reveals continuously for fractional scroll positions instead of switching at 2px", () => {
    const positions = [0, 0.5, 1, 2, 2.1, 6, 12, 18, 24];
    const strengths = positions.map((position) => thinkingEdges(position, 1000, 280).top);
    assert.equal(strengths[0], 0);
    assert.equal(strengths.at(-1), 1);
    assert.equal(thinkingEdges(12, 1000, 280).top, 0.5);
    assert.ok(thinkingEdges(2.1, 1000, 280).top < 0.03);
    assert.ok(strengths.every((value, index) => index === 0 || value > strengths[index - 1]!));
  });

  it("mirrors the edges and clamps rubber-band overscroll", () => {
    assert.deepEqual(thinkingEdges(-5, 1000, 280), { top: 0, bottom: 1 });
    assert.deepEqual(thinkingEdges(725, 1000, 280), { top: 1, bottom: 0 });
    assert.deepEqual(thinkingEdges(708, 1000, 280), { top: 1, bottom: 0.5 });
    assert.deepEqual(thinkingEdges(300, 1000, 280), { top: 1, bottom: 1 });
  });

  it("keeps barely overflowing content readable", () => {
    const edges = thinkingEdges(1, 282, 280);
    assert.equal(edges.top, edges.bottom);
    assert.ok(edges.top > 0 && edges.top < 0.01);
  });
});
