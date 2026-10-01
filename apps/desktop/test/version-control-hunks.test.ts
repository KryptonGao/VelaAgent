import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildHunkPatch, hunkLabel, parseRenderPatch } from "../src/renderer/components/version-control/diff-hunks.ts";

const twoHunkDiff = [
  "diff --git a/multi.txt b/multi.txt",
  "index 1111111..2222222 100644",
  "--- a/multi.txt",
  "+++ b/multi.txt",
  "@@ -1,5 +1,5 @@",
  " line 1",
  "-line 2",
  "+line 2 changed",
  " line 3",
  "@@ -25,5 +25,5 @@",
  " line 27",
  "-line 28",
  "+line 28 changed",
  " line 29",
  "",
].join("\n");

describe("parseRenderPatch", () => {
  it("拆出文件头与代码块", () => {
    const patch = parseRenderPatch(twoHunkDiff);
    assert.equal(patch.header.length, 4);
    assert.equal(patch.hunks.length, 2);
    assert.equal(patch.hunks[0]?.index, 0);
    assert.equal(patch.hunks[1]?.header, "@@ -25,5 +25,5 @@");
    assert.deepEqual(patch.hunks[0]?.lines, [" line 1", "-line 2", "+line 2 changed", " line 3"]);
  });

  it("没有代码块时只返回文件头", () => {
    const patch = parseRenderPatch("diff --git a/a b/a\nBinary files a/a and b/a differ\n");
    assert.equal(patch.hunks.length, 0);
    assert.equal(patch.header.length, 2);
  });
});

describe("buildHunkPatch", () => {
  it("只包含选中的代码块并保留文件头与结尾换行", () => {
    const patch = parseRenderPatch(twoHunkDiff);
    const text = buildHunkPatch(patch, [1]);
    assert.match(text, /^diff --git a\/multi\.txt b\/multi\.txt\n/);
    assert.match(text, /@@ -25,5 \+25,5 @@/);
    assert.doesNotMatch(text, /line 2 changed/);
    assert.ok(text.endsWith("line 29\n"));
  });

  it("按序号顺序拼接多个代码块,越界序号被忽略", () => {
    const patch = parseRenderPatch(twoHunkDiff);
    const text = buildHunkPatch(patch, [0, 5, 1]);
    const first = text.indexOf("@@ -1,5 +1,5 @@");
    const second = text.indexOf("@@ -25,5 +25,5 @@");
    assert.ok(first >= 0 && second > first);
  });

  it("未选择任何代码块时只保留文件头,不产生可应用的补丁", () => {
    const patch = parseRenderPatch(twoHunkDiff);
    const text = buildHunkPatch(patch, []);
    assert.doesNotMatch(text, /@@/);
  });
});

describe("hunkLabel", () => {
  it("从 hunk 头提取新侧起始行与行数", () => {
    const patch = parseRenderPatch(twoHunkDiff);
    assert.equal(hunkLabel(patch.hunks[0]!), "+1,5");
    assert.equal(hunkLabel(patch.hunks[1]!), "+25,5");
  });

  it("单行 hunk 省略行数时按 1 处理", () => {
    const patch = parseRenderPatch(["@@ -1 +1 @@", "-a", "+b", ""].join("\n"));
    assert.equal(hunkLabel(patch.hunks[0]!), "+1,1");
  });
});
