import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ToolTrace } from "@vela/shared";
import {
  compactSummaryParts,
  diffStat,
  parseDisplayDiff,
  splitPath,
  toolCompactKind,
  totalDiffStat,
} from "../src/renderer/components/tool-compact.ts";

function tool(name: string, activity: ToolTrace["activity"] = {}, status: ToolTrace["status"] = "done"): ToolTrace {
  return { id: `${name}-${Math.random().toString(36).slice(2, 8)}`, name, status, activity };
}

describe("toolCompactKind", () => {
  it("识别四种可折叠工具,其余返回 null", () => {
    assert.equal(toolCompactKind("bash"), "bash");
    assert.equal(toolCompactKind("read"), "read");
    assert.equal(toolCompactKind("edit"), "edit");
    assert.equal(toolCompactKind("write"), "write");
    assert.equal(toolCompactKind("task"), null);
    assert.equal(toolCompactKind("ask_user_question"), null);
    assert.equal(toolCompactKind("submit_plan"), null);
  });
});

describe("compactSummaryParts", () => {
  it("按首次出现的种类聚合计数", () => {
    const parts = compactSummaryParts([
      tool("edit"),
      tool("read"),
      tool("edit"),
      tool("bash"),
      tool("write"),
    ]);
    assert.deepEqual(parts, [
      { kind: "edit", count: 2 },
      { kind: "read", count: 1 },
      { kind: "bash", count: 1 },
      { kind: "write", count: 1 },
    ]);
  });

  it("忽略计划、提问等不可折叠工具", () => {
    const parts = compactSummaryParts([tool("submit_plan"), tool("read"), tool("ask_user_question")]);
    assert.deepEqual(parts, [{ kind: "read", count: 1 }]);
  });

  it("空列表返回空摘要", () => {
    assert.deepEqual(compactSummaryParts([]), []);
  });
});

describe("diffStat", () => {
  it("统计增删行数,忽略文件头", () => {
    assert.deepEqual(diffStat("+ 1 new\n- 2 old\n+ 3 more\n+++ header"), { added: 2, removed: 1 });
  });

  it("没有增删或无 diff 时返回 null", () => {
    assert.equal(diffStat("  1 ctx"), null);
    assert.equal(diffStat(undefined), null);
  });
});

describe("parseDisplayDiff", () => {
  it("记录两侧行索引,并拼出供高亮的旧/新文本", () => {
    const parsed = parseDisplayDiff(["+ 1 a", "- 2 b", " 3 c", " 4 d"].join("\n"));
    assert.deepEqual(parsed.rows.map((row) => row.kind), ["add", "del", "ctx", "ctx"]);
    assert.deepEqual(parsed.oldLines, ["b", "c", "d"]);
    assert.deepEqual(parsed.newLines, ["a", "c", "d"]);
    assert.deepEqual(parsed.rows[0], { kind: "add", gutter: "1", text: "a", oldIndex: -1, newIndex: 0 });
    assert.deepEqual(parsed.rows[1], { kind: "del", gutter: "2", text: "b", oldIndex: 0, newIndex: -1 });
    assert.deepEqual(parsed.rows[2], { kind: "ctx", gutter: "3", text: "c", oldIndex: 1, newIndex: 1 });
  });

  it("省略的上下文记为 gap,不占两侧内容", () => {
    const parsed = parseDisplayDiff(["+ 1 a", "...", "+ 9 b"].join("\n"));
    assert.deepEqual(parsed.rows.map((row) => row.kind), ["add", "gap", "add"]);
    assert.equal(parsed.rows[1]?.text, "…");
    assert.deepEqual(parsed.newLines, ["a", "b"]);
  });

  it("兼容没有行号前缀的裸行与空 diff", () => {
    const parsed = parseDisplayDiff(["+plain", "-old", " ctx"].join("\n"));
    assert.deepEqual(parsed.rows.map((row) => row.kind), ["add", "del", "ctx"]);
    assert.deepEqual(parsed.oldLines, ["old", "ctx"]);
    assert.deepEqual(parsed.newLines, ["plain", "ctx"]);
    assert.deepEqual(parseDisplayDiff(""), { rows: [], oldLines: [], newLines: [] });
  });
});

describe("totalDiffStat", () => {
  it("跨工具汇总增删,全空时返回 null", () => {
    const tools = [
      tool("edit", { diff: "+ 1 a\n- 2 b" }),
      tool("write", { diff: "+ 3 c" }),
      tool("read", { body: "text" }),
    ];
    assert.deepEqual(totalDiffStat(tools), { added: 2, removed: 1 });
    assert.equal(totalDiffStat([tool("read"), tool("bash", { command: "ls" })]), null);
  });
});

describe("splitPath", () => {
  it("拆出文件名和目录", () => {
    assert.deepEqual(splitPath("apps/renderer/App.tsx"), { name: "App.tsx", dir: "apps/renderer" });
    assert.deepEqual(splitPath("App.tsx"), { name: "App.tsx", dir: "" });
  });

  it("容忍 Windows 反斜杠路径", () => {
    assert.deepEqual(splitPath("apps\\renderer\\App.tsx"), { name: "App.tsx", dir: "apps/renderer" });
  });
});
