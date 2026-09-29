import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clampSidebarWidth,
  defaultSidebarWidths,
  parseSidebarWidths,
  resolveSidebarWidths,
  sidebarWidthRange,
  widthFromPointer,
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

  it("never squeezes below the minimum even on a narrow viewport", () => {
    assert.equal(clampSidebarWidth("right", 400, 480, 250), sidebarWidthRange.right.min);
  });
});

describe("widthFromPointer", () => {
  it("measures the left sidebar from the window edge and the right one from the other edge", () => {
    assert.equal(widthFromPointer("left", 320, 1280), 320);
    assert.equal(widthFromPointer("right", 900, 1280), 380);
    assert.equal(widthFromPointer("preview", 900, 1280), 380);
  });
});

describe("parseSidebarWidths", () => {
  it("falls back to the defaults when nothing usable is stored", () => {
    assert.deepEqual(parseSidebarWidths(null), defaultSidebarWidths);
    assert.deepEqual(parseSidebarWidths("{"), defaultSidebarWidths);
    assert.deepEqual(parseSidebarWidths('["left"]'), defaultSidebarWidths);
    assert.deepEqual(parseSidebarWidths('{"left":"wide"}'), defaultSidebarWidths);
  });

  it("keeps the valid targets and replaces the broken ones", () => {
    assert.deepEqual(parseSidebarWidths('{"left":300,"right":null,"preview":720}'), {
      left: 300,
      right: defaultSidebarWidths.right,
      preview: 720,
      agent: defaultSidebarWidths.agent,
    });
  });
});

describe("resolveSidebarWidths", () => {
  it("re-clamps stored widths against the current viewport", () => {
    const resolved = resolveSidebarWidths({ left: 900, right: 900, preview: 1200, agent: 2000 }, 960);
    assert.equal(resolved.left, sidebarWidthRange.left.max);
    // 窗口被挤窄到放不下对话区时保底取最小宽度,而不是继续压缩。
    assert.equal(resolved.right, sidebarWidthRange.right.min);
    assert.equal(resolved.preview, 960 - resolved.left - 24);
    assert.equal(resolved.agent, sidebarWidthRange.agent.min);
  });
});
