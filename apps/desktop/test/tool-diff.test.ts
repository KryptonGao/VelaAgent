import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseToolDiff } from "../src/renderer/components/tool-diff.ts";
import { splitDiffRows } from "../src/renderer/components/diff-rows.ts";

describe("saved tool diffs", () => {
  it("separates file line numbers from highlight indices and aligns unequal replacements", () => {
    const parsed = parseToolDiff(" 20 keep\n-21 old\n+21 new\n+22 extra\n 22 tail");
    assert.deepEqual(parsed.oldLines, ["keep", "old", "tail"]);
    assert.deepEqual(parsed.newLines, ["keep", "new", "extra", "tail"]);
    const split = splitDiffRows(parsed.rows);
    assert.equal(split[1].left?.oldLineNumber, 21);
    assert.equal(split[1].right?.newLineNumber, 21);
    assert.equal(split[1].left?.oldIndex, 1);
    assert.equal(split[2].left, null);
    assert.equal(split[2].right?.text, "extra");
    assert.equal(split[3].left?.oldLineNumber, 22);
    assert.equal(split[3].right?.newLineNumber, 23);
  });

  it("retains positive and negative offsets across omitted unchanged regions", () => {
    const parsed = parseToolDiff("    ...\n 10 start\n-11 one\n-12 two\n+11 replacement\n 13 tail\n    ...\n 50 far\n+50 inserted\n+51 second\n 51 end");
    const contexts = parsed.rows.filter(row => row.kind === "ctx");
    assert.deepEqual(contexts.map(row => [row.oldLineNumber, row.newLineNumber]), [[10, 10], [13, 12], [50, 49], [51, 52]]);
    assert.equal(parsed.rows.filter(row => row.omitted).length, 2);
    assert.ok(!parsed.oldText.includes("..."));
  });

  it("renders pure additions, deletions, blank lines and leading spaces faithfully", () => {
    const added = parseToolDiff("+ 1   indented\n+ 2 \n+ 3 +literal\n");
    assert.deepEqual(added.oldLines, []);
    assert.deepEqual(added.newLines, ["  indented", "", "+literal"]);
    assert.ok(splitDiffRows(added.rows).every(row => row.left === null));
    const deleted = parseToolDiff("-8 old\n-9 ");
    assert.deepEqual(deleted.oldLines, ["old", ""]);
    assert.deepEqual(deleted.newLines, []);
    assert.ok(splitDiffRows(deleted.rows).every(row => row.right === null));
  });

  it("keeps truncated and unknown records as notes without inventing context numbers", () => {
    const parsed = parseToolDiff("-1 old\n+1 new\n… 内容过长，已截断\n 4 known\n+5 shown");
    assert.equal(parsed.rows[2].kind, "note");
    assert.equal(parsed.rows[2].text, "… 内容过长，已截断");
    assert.equal(parsed.rows[3].oldLineNumber, 4);
    assert.equal(parsed.rows[3].newLineNumber, undefined);
    assert.equal(parsed.rows[4].newLineNumber, 5);
    assert.equal(parseToolDiff("+incomplete").rows[0].text, "+incomplete");
  });

  it("handles CRLF, empty records and literal ellipses in code", () => {
    assert.deepEqual(parseToolDiff("").rows, []);
    const parsed = parseToolDiff(" 1 ...\r\n-2 a\r\n+2 b\r\n");
    assert.equal(parsed.rows[0].omitted, undefined);
    assert.equal(parsed.rows[0].text, "...");
    assert.equal(parsed.newText, "...\nb");
  });

  it("starts every saved edit with its own numbering offset", () => {
    const first = parseToolDiff("-4 old\n+4 new\n+5 inserted\n 5 tail");
    const second = parseToolDiff(" 6 tail\n-7 next\n+7 final");
    assert.equal(first.rows.at(-1)?.newLineNumber, 6);
    assert.equal(second.rows[0].newLineNumber, 6);
  });
});
