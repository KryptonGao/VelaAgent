import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseUnifiedDiff } from "../src/renderer/components/diff-rows.ts";

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
