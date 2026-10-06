import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseUnifiedDiff, splitDiffRows } from "../src/renderer/components/diff-rows.ts";

describe("parseUnifiedDiff", () => {
  it("区分元信息、hunk、上下文、增删行并记录两侧行索引", () => {
    const parsed = parseUnifiedDiff(
      [
        "diff --git a/tracked.txt b/tracked.txt",
        "index 422c2b7..7be73ce 100644",
        "--- a/tracked.txt",
        "+++ b/tracked.txt",
        "@@ -1,2 +1,3 @@",
        " a",
        "-b",
        "+B",
        "+c",
        "",
      ].join("\n"),
    );

    assert.deepEqual(
      parsed.rows.map((row) => row.kind),
      ["meta", "meta", "meta", "meta", "hunk", "ctx", "del", "add", "add"],
    );
    assert.deepEqual(parsed.oldLines, ["a", "b"]);
    assert.deepEqual(parsed.newLines, ["a", "B", "c"]);
    assert.equal(parsed.oldText, "a\nb");
    assert.equal(parsed.newText, "a\nB\nc");
    assert.equal(parsed.rows[5]?.sign, " ");
    assert.equal(parsed.rows[6]?.sign, "-");
    assert.equal(parsed.rows[7]?.sign, "+");
    assert.equal(parsed.rows[7]?.newIndex, 1);
    assert.equal(parsed.rows[7]?.oldIndex, -1);
  });

  it("新文件全部为新增行,空行也算一行", () => {
    const parsed = parseUnifiedDiff(
      [
        "diff --git a/new.md b/new.md",
        "new file mode 100644",
        "index 0000000..e97c684",
        "--- /dev/null",
        "+++ b/new.md",
        "@@ -0,0 +1,4 @@",
        "+x",
        "+y",
        "+",
        "+z",
        "",
      ].join("\n"),
    );

    assert.equal(parsed.oldLines.length, 0);
    assert.deepEqual(parsed.newLines, ["x", "y", "", "z"]);
    assert.equal(parsed.rows[8]?.text, "");
  });

  it("删除文件只产生旧侧行", () => {
    const parsed = parseUnifiedDiff(
      ["--- a/gone.txt", "+++ /dev/null", "@@ -1,2 +0,0 @@", "-a", "-b", ""].join("\n"),
    );
    assert.deepEqual(parsed.oldLines, ["a", "b"]);
    assert.equal(parsed.newLines.length, 0);
    assert.equal(parsed.rows.filter((row) => row.kind === "del").length, 2);
  });

  it("`\\ No newline at end of file` 记为提示行且不计入两侧内容", () => {
    const parsed = parseUnifiedDiff(
      ["@@ -1 +1 @@", "-a", "+b", "\\ No newline at end of file", ""].join("\n"),
    );
    assert.equal(parsed.rows[3]?.kind, "note");
    assert.deepEqual(parsed.oldLines, ["a"]);
    assert.deepEqual(parsed.newLines, ["b"]);
  });

  it("空差异不产生行", () => {
    const parsed = parseUnifiedDiff("");
    assert.deepEqual(parsed.rows, []);
    assert.equal(parsed.oldText, "");
    assert.equal(parsed.newText, "");
  });
});

describe("splitDiffRows", () => {
  it("删除与新增按顺序配对,多余的行各占一侧", () => {
    const parsed = parseUnifiedDiff(
      ["@@ -1,3 +1,4 @@", " keep", "-old1", "-old2", "+new1", "+new2", "+new3", " tail", ""].join("\n"),
    );
    const rows = splitDiffRows(parsed.rows);
    const pairs = rows.filter((row) => !row.full && row.left?.kind !== "ctx");
    assert.equal(pairs.length, 3);
    assert.equal(pairs[0]?.left?.text, "old1");
    assert.equal(pairs[0]?.right?.text, "new1");
    assert.equal(pairs[1]?.left?.text, "old2");
    assert.equal(pairs[1]?.right?.text, "new2");
    assert.equal(pairs[2]?.left, null, "新增多于删除时左侧为空");
    assert.equal(pairs[2]?.right?.text, "new3");
  });

  it("上下文行两侧内容一致,hunk 头跨两列显示", () => {
    const parsed = parseUnifiedDiff(["@@ -1 +1 @@", "-a", "+b", " same", ""].join("\n"));
    const rows = splitDiffRows(parsed.rows);
    assert.equal(rows[0]?.full?.kind, "hunk");
    const context = rows.find((row) => row.left?.kind === "ctx");
    assert.equal(context?.left, context?.right);
    assert.equal(context?.left?.text, "same");
  });
});


describe("remote PR hunk coordinates", () => {
  it("keeps original line numbers across hunk gaps and headers inside changed text", () => {
    const diff = "--- a/file.ts\n+++ b/file.ts\n@@ -12,2 +20,2 @@\n--- old code\n+++ new code\n same\n@@ -100 +110 @@\n-old\n+new\n";
    const rows = parseUnifiedDiff(diff).rows;
    assert.deepEqual(rows.filter(r => r.kind === 'del').map(r => [r.text, r.oldLineNumber]), [['-- old code', 12], ['old', 100]]);
    assert.deepEqual(rows.filter(r => r.kind === 'add').map(r => [r.text, r.newLineNumber]), [['++ new code', 20], ['new', 110]]);
    const ctx = rows.find(r => r.kind === 'ctx'); assert.equal(ctx.oldLineNumber, 13); assert.equal(ctx.newLineNumber, 21);
    const split = splitDiffRows(rows); assert.equal(split.find(r => r.left?.kind === 'del').right.newLineNumber, 20);
  });
});
