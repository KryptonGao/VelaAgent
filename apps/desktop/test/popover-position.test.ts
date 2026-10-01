import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { positionContextPopover, positionRepoPopover } from "../src/renderer/components/popover-position.ts";

const viewport = { width: 960, height: 720 };
const size = { width: 320, height: 280 };
describe("context popover positioning", () => {
  it("opens above and aligns with the ring near the composer", () => {
    assert.deepEqual(positionContextPopover({ left: 620, right: 670, top: 650, bottom: 674 }, size, viewport),
      { left: 350, top: 360, side: "above", originX: 295 });
  });
  it("flips below when the ring is near the top edge", () => {
    const result = positionContextPopover({ left: 620, right: 670, top: 20, bottom: 44 }, size, viewport);
    assert.equal(result.side, "below");
    assert.equal(result.top, 54);
  });
  it("clamps to both horizontal window edges", () => {
    assert.equal(positionContextPopover({ left: 0, right: 40, top: 650, bottom: 674 }, size, viewport).left, 12);
    assert.equal(positionContextPopover({ left: 950, right: 980, top: 650, bottom: 674 }, size, viewport).left, 628);
  });
  it("keeps a viewport-sized card within the margins when neither direction fits", () => {
    const result = positionContextPopover({ left: 90, right: 130, top: 100, bottom: 124 },
      { width: 216, height: 216 }, { width: 240, height: 240 });
    assert.equal(result.left, 12);
    assert.equal(result.top, 12);
    assert.equal(result.side, "below");
  });
});

describe("repository popover positioning", () => {
  it("opens below the branch without inheriting the card's height limit", () => {
    assert.deepEqual(positionRepoPopover({ left: 620, right: 900, top: 140, bottom: 168 }, size, viewport),
      { left: 580, top: 176, maxHeight: 380, side: "below" });
  });
  it("flips above a trigger near the window bottom", () => {
    assert.deepEqual(positionRepoPopover({ left: 620, right: 900, top: 650, bottom: 678 }, size, viewport),
      { left: 580, top: 362, maxHeight: 380, side: "above" });
  });
  it("caps a tall branch list on the roomier side of a short window", () => {
    const result = positionRepoPopover({ left: 180, right: 300, top: 80, bottom: 108 },
      { width: 300, height: 380 }, { width: 360, height: 320 });
    assert.deepEqual(result, { left: 12, top: 116, maxHeight: 192, side: "below" });
  });
  it("keeps a menu within the right window edge", () => {
    const result = positionRepoPopover({ left: 950, right: 970, top: 140, bottom: 168 }, size, viewport);
    assert.equal(result.left, 628);
    assert.ok(result.left + size.width <= viewport.width - 12);
  });
});
