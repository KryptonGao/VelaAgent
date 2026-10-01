import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CLICK_SLOP,
  arrowIntent,
  clampOffset,
  doubleClickScale,
  fitScale,
  glideTarget,
  isSettled,
  nextIndex,
  panByKey,
  panLimits,
  releaseVelocity,
  rubberband,
  rubberbandOffset,
  scaleTolerance,
  shouldRecenter,
  springStep,
  thumbTransform,
  wheelZoomFactor,
  zoomAround,
  zoomBounds,
} from "../src/renderer/components/image-viewer.ts";

// 1600x900 的窗口,和实际应用里常见的尺寸接近。
const viewport = { width: 1600, height: 900 };
const screenshot = { width: 2400, height: 1600 };
const icon = { width: 64, height: 64 };

describe("image viewer fit", () => {
  it("contains the image inside the padded viewport", () => {
    // 可用高度 900-56=844,844/1600 更小,所以按高度适配。
    assert.equal(fitScale(screenshot, viewport), 844 / 1600);
  });
  it("never upscales small images", () => {
    assert.equal(fitScale(icon, viewport), 1);
  });
  it("keeps the zoom ceiling relative to the fit, but allows natural size", () => {
    const bounds = zoomBounds(screenshot, viewport);
    assert.equal(bounds.max, bounds.min * 8);
    const small = zoomBounds(icon, viewport);
    assert.deepEqual(small, { min: 1, max: 8 });
  });
});

describe("image viewer panning", () => {
  it("lets a zoomed-in image travel until its edges meet the viewport", () => {
    const limits = panLimits(screenshot, 1, viewport);
    assert.deepEqual(limits, { x: (2400 - 1600) / 2, y: (1600 - 900) / 2 });
  });
  it("gives a smaller-than-viewport image room to move inside the viewport", () => {
    assert.deepEqual(panLimits(icon, 2, viewport), { x: (1600 - 128) / 2, y: (900 - 128) / 2 });
  });
  it("clamps offsets to the limits", () => {
    assert.deepEqual(clampOffset({ x: 900, y: -900 }, { x: 400, y: 350 }), { x: 400, y: -350 });
  });
  it("dampens overshoot progressively with the rubber band", () => {
    const small = rubberband(100, 800);
    const large = rubberband(400, 800);
    assert.ok(small < 100);
    assert.ok(large < 400);
    // 越界越远,跟手的比例越小。
    assert.ok(large / 400 < small / 100);
    assert.equal(rubberband(-100, 800), -small);
  });
  it("only rubber-bands the axes that are out of bounds", () => {
    const dragged = rubberbandOffset({ x: 500, y: 10 }, { x: 100, y: 200 }, viewport);
    assert.ok(dragged.x > 100 && dragged.x < 500);
    assert.equal(dragged.y, 10);
  });
  it("steps the offset with the arrow keys", () => {
    assert.deepEqual(panByKey({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 300, y: 300 }), { x: 48, y: 0 });
    assert.deepEqual(panByKey({ x: 290, y: 0 }, { x: 1, y: 0 }, { x: 300, y: 300 }), { x: 300, y: 0 });
  });
});

describe("image viewer zooming", () => {
  it("keeps the pixel under the anchor in place", () => {
    const before = { scale: 0.5, x: 0, y: 0 };
    const anchor = { x: 200, y: -100 };
    const after = zoomAround(before, 1, anchor);
    // 屏幕位置 = 平移 + 比例 * 图内坐标,缩放前后应当相等。
    const imagePoint = { x: (anchor.x - before.x) / before.scale, y: (anchor.y - before.y) / before.scale };
    assert.equal(after.x + after.scale * imagePoint.x, anchor.x);
    assert.equal(after.y + after.scale * imagePoint.y, anchor.y);
  });
  it("scales around the viewport center when the anchor is centered", () => {
    assert.deepEqual(zoomAround({ scale: 0.5, x: 40, y: -20 }, 1, { x: 0, y: 0 }), { scale: 1, x: 80, y: -40 });
  });
  it("normalizes wheel deltas by deltaMode", () => {
    const pixels = wheelZoomFactor(100, 0, 900);
    assert.equal(pixels, wheelZoomFactor(100 / 16, 1, 900));
    assert.equal(pixels, wheelZoomFactor(100 / 900, 2, 900));
    assert.ok(pixels < 1);
    assert.equal(wheelZoomFactor(-100, 0, 900) > 1, true);
  });
  it("clamps a single wheel event so one notch cannot jump", () => {
    assert.equal(wheelZoomFactor(10000, 0, 900), 0.5);
    assert.equal(wheelZoomFactor(-10000, 0, 900), 2);
  });
  it("toggles between fit and a 2.5x detail view on double click", () => {
    const bounds = { min: 0.2, max: 1.6 };
    assert.equal(doubleClickScale(0.2, bounds), 0.5);
    assert.equal(doubleClickScale(0.9, bounds), 0.2);
    // 上限不够 2.5 倍时停在上限。
    assert.equal(doubleClickScale(0.2, { min: 0.2, max: 0.4 }), 0.4);
  });
  it("re-centers once the zoom is back at the fit scale", () => {
    assert.equal(shouldRecenter(0.5, 0.5), true);
    assert.equal(shouldRecenter(0.5004, 0.5), true);
    assert.equal(shouldRecenter(0.51, 0.5), false);
  });
  it("only turns arrow keys into navigation while the image fits", () => {
    const bounds = { min: 0.2, max: 1.6 };
    assert.equal(arrowIntent(0.2, bounds), "navigate");
    assert.equal(arrowIntent(0.21, bounds), "navigate");
    assert.equal(arrowIntent(0.5, bounds), "pan");
  });
});

describe("image viewer momentum", () => {
  it("projects the resting position from the release velocity and clamps it", () => {
    assert.ok(Math.abs(glideTarget({ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 5000, y: 5000 }).x - 499) < 0.01);
    assert.deepEqual(glideTarget({ x: 0, y: 0 }, { x: 100000, y: 0 }, { x: 400, y: 400 }).x, 400);
    assert.deepEqual(glideTarget({ x: 10, y: 10 }, { x: 0, y: 0 }, { x: 400, y: 400 }), { x: 10, y: 10 });
  });
  it("averages only the tail of the drag trail", () => {
    const samples = [
      { t: 0, x: 0, y: 0 },
      { t: 200, x: 500, y: 0 },
      { t: 300, x: 20, y: 0 },
      { t: 340, x: 20, y: 0 },
      { t: 400, x: 80, y: 0 },
    ];
    // 90ms 窗口里只剩最后两帧(20 → 80),更早的拖动不该拉低速度。
    const velocity = releaseVelocity(samples);
    assert.ok(Math.abs(velocity.x - 1000) < 0.01);
    assert.equal(velocity.y, 0);
  });
  it("falls back to the last frame when the trail is sparse", () => {
    const samples = [
      { t: 0, x: 0, y: 0 },
      { t: 200, x: 20, y: 0 },
      { t: 300, x: 60, y: 40 },
      { t: 400, x: 100, y: 40 },
    ];
    assert.deepEqual(releaseVelocity(samples), { x: 400, y: 0 });
    assert.deepEqual(releaseVelocity([]), { x: 0, y: 0 });
    assert.deepEqual(releaseVelocity([{ t: 0, x: 5, y: 5 }]), { x: 0, y: 0 });
  });
});

describe("image viewer spring", () => {
  it("settles on the target without overshooting", () => {
    let state = { value: 0, velocity: 0 };
    let peak = 0;
    for (let index = 0; index < 120; index += 1) {
      state = springStep(state, 1, 1 / 60);
      peak = Math.max(peak, state.value);
    }
    assert.ok(Math.abs(state.value - 1) < 0.001);
    assert.ok(peak <= 1.0001);
  });
  it("is frame-rate independent", () => {
    const once = springStep({ value: 0, velocity: 0 }, 1, 1 / 30);
    const twice = springStep(springStep({ value: 0, velocity: 0 }, 1, 1 / 60), 1, 1 / 60);
    assert.ok(Math.abs(once.value - twice.value) < 0.005);
  });
  it("carries the release velocity into the animation", () => {
    const thrown = springStep({ value: 0, velocity: 3000 }, 400, 1 / 60);
    const still = springStep({ value: 0, velocity: 0 }, 400, 1 / 60);
    assert.ok(thrown.value > still.value);
  });
  it("stops once it is close enough", () => {
    assert.equal(isSettled({ value: 0.5, velocity: 0 }, 0.5, 0.25), true);
    assert.equal(isSettled({ value: 0.5, velocity: 30 }, 0.5, 0.25), false);
    assert.equal(scaleTolerance(0.15), 0.0004);
    assert.ok(scaleTolerance(6) > 0.0004);
  });
});

describe("image viewer entry", () => {
  it("starts from the thumbnail's rectangle and ends where contain puts the image", () => {
    const origin = { left: 900, top: 600, width: 140, height: 140 };
    const from = thumbTransform(origin, screenshot, viewport);
    // cover 口径:缩略图里被裁掉的部分也算进起始比例。
    assert.equal(from.scale, 140 / 1600);
    assert.equal(from.x, 900 + 70 - 800);
    assert.equal(from.y, 600 + 70 - 450);
  });
  it("wraps image navigation in both directions", () => {
    assert.equal(nextIndex(2, 1, 3), 0);
    assert.equal(nextIndex(0, -1, 3), 2);
    assert.equal(nextIndex(1, 1, 1), 0);
    assert.equal(nextIndex(0, 1, 0), 0);
  });
  it("keeps the click threshold small enough to stay a click", () => {
    assert.ok(CLICK_SLOP <= 6);
  });
});
