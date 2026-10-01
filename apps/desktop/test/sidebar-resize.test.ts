import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clampSidebarWidth,
  defaultSidebarWidths,
  parseSidebarWidths,
  resolveSidebarWidths,
  sidebarWidthLimits,
  sidebarWidthRange,
  widthFromPointer,
  widthFromPointerDelta,
} from "../src/renderer/sidebar-resize.ts";

describe("clampSidebarWidth", () => {
  it("keeps the dragged width inside the target range", () => {
    assert.equal(clampSidebarWidth("left", 120, 1440), sidebarWidthRange.left.min);
    assert.equal(clampSidebarWidth("left", 900, 1440), sidebarWidthRange.left.max);
    assert.equal(clampSidebarWidth("left", 312, 1440), 312);
  });

  it("caps the right panel so the conversation keeps its room", () => {
    // 960 是窗口最小宽度:左栏 250 加对话区 360 之后只剩 350 给右栏。
    assert.equal(clampSidebarWidth("right", 760, 960, 250), 350);
    assert.equal(clampSidebarWidth("right", 760, 1440, 250), sidebarWidthRange.right.max);
  });

  it("caps the workbench so the conversation and ContextPanel keep their room", () => {
    assert.equal(clampSidebarWidth("workbench", 1100, 1440, 250 + 340), 430);
    assert.equal(clampSidebarWidth("workbench", 1100, 960, 250 + 340), 346);
  });

  it("lets the narrow overlay shrink below its normal minimum when needed", () => {
    assert.equal(clampSidebarWidth("workbench", 320, 900, 250 + 340), 286);
    assert.deepEqual(sidebarWidthLimits("workbench", 900, 250 + 340), { min: 286, max: 286 });
  });

  it("keeps the wide layout's conversation reserve when less than 320px is available", () => {
    assert.equal(clampSidebarWidth("workbench", 320, 1101, 250 + 340), 91);
  });

  it("never squeezes below the minimum even on a narrow viewport", () => {
    assert.equal(clampSidebarWidth("right", 400, 480, 250), sidebarWidthRange.right.min);
  });
});

describe("widthFromPointer", () => {
  it("measures the left sidebar from the window edge and the right one from the other edge", () => {
    assert.equal(widthFromPointer("left", 320, 1280), 320);
    assert.equal(widthFromPointer("right", 900, 1280), 380);
  });

  it("resizes the workbench from its left edge", () => {
    assert.equal(widthFromPointerDelta(640, 500, 450), 690);
    assert.equal(widthFromPointerDelta(640, 500, 550), 590);
  });
});

describe("parseSidebarWidths", () => {
  it("falls back to the defaults when nothing usable is stored", () => {
    assert.deepEqual(parseSidebarWidths(null), defaultSidebarWidths);
    assert.deepEqual(parseSidebarWidths("{"), defaultSidebarWidths);
    assert.deepEqual(parseSidebarWidths('["left"]'), defaultSidebarWidths);
    assert.deepEqual(parseSidebarWidths('{"left":"wide"}'), defaultSidebarWidths);
  });

  it("migrates the legacy preview width and ignores separate agent and plan widths", () => {
    assert.deepEqual(parseSidebarWidths('{"left":300,"right":null,"preview":720,"agent":510,"plan":880}'), {
      left: 300,
      right: defaultSidebarWidths.right,
      workbench: 720,
    });
  });

  it("prefers the unified workbench width over the legacy preview width", () => {
    assert.equal(parseSidebarWidths('{"workbench":810,"preview":720}').workbench, 810);
    assert.equal(parseSidebarWidths('{"workbench":"wide","preview":720}').workbench, 720);
    assert.equal(parseSidebarWidths('{"agent":510,"plan":880}').workbench, 640);
  });
});

describe("resolveSidebarWidths", () => {
  it("re-clamps stored widths against the current viewport", () => {
    const resolved = resolveSidebarWidths({ left: 900, right: 900, workbench: 2000 }, 960);
    assert.equal(resolved.left, sidebarWidthRange.left.max);
    // 窗口被挤窄到放不下对话区时保底取最小宽度,而不是继续压缩。
    assert.equal(resolved.right, sidebarWidthRange.right.min);
    assert.equal(resolved.workbench, 960 - resolved.left - resolved.right - 24);
  });
});

describe("floating information workbench widths", () => {
  it("returns the former sidebar width to the workbench", () => {
    assert.equal(resolveSidebarWidths(defaultSidebarWidths, 1440, false).workbench, 640);
    assert.equal(resolveSidebarWidths(defaultSidebarWidths, 1440, true).workbench, 430);
  });
  it("keeps drag and keyboard limits aligned with the narrow docked layout", () => {
    assert.equal(clampSidebarWidth("workbench", 640, 960, 250, true), 350);
    assert.equal(clampSidebarWidth("workbench", 640, 960, 0, true), 600);
    assert.deepEqual(sidebarWidthLimits("workbench", 960, 250, true), { min: 320, max: 350 });
    assert.equal(clampSidebarWidth("workbench", 640, 1440, 250, true), 640);
  });
});
