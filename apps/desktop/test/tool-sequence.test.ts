import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ToolTrace } from "@vela/shared";
import type { UiMessage } from "../src/renderer/hooks/useSession.ts";
import {
  buildTurnItems,
  groupProcessItems,
  shouldFoldRun,
  type ProcessNode,
} from "../src/renderer/components/tool-sequence.ts";

function tool(name: string, id: string): ToolTrace {
  return { id, name, status: "done", activity: {} };
}

function message(id: string, parts: Partial<UiMessage> = {}): UiMessage {
  return { id, role: "assistant", text: "", thinking: "", tools: [], ...parts };
}

function runToolIds(node: ProcessNode): string[] {
  return node.type === "run" ? node.tools.map((item) => item.id) : [];
}

describe("shouldFoldRun", () => {
  it("卡片模式达到 RUN_MIN 才折叠,紧凑模式超过 1 个就折叠", () => {
    assert.equal(shouldFoldRun(2, "card"), false);
    assert.equal(shouldFoldRun(3, "card"), true);
    assert.equal(shouldFoldRun(1, "compact"), false);
    assert.equal(shouldFoldRun(2, "compact"), true);
  });
});

describe("buildTurnItems", () => {
  it("按界面顺序拍平思考、工具和正文", () => {
    const items = buildTurnItems([
      message("m1", { thinking: "先想", tools: [tool("bash", "b1")], text: "说得对" }),
    ]);
    assert.deepEqual(
      items.map((item) => item.kind),
      ["thinking", "tool", "text"],
    );
    assert.deepEqual(
      buildTurnItems([message("m2", { tools: [tool("read", "r1"), tool("edit", "e1")] })]).map((item) =>
        item.kind === "tool" ? item.tool.id : item.id,
      ),
      ["r1", "e1"],
    );
  });

  it("includeText 返回 false 的正文不进入序列", () => {
    const messages = [
      message("m1", { text: "过程说明", tools: [tool("bash", "b1")] }),
      message("m2", { text: "最终回复" }),
    ];
    const items = buildTurnItems(messages, { includeText: (item) => item.id !== "m2" });
    assert.deepEqual(
      items.map((item) => item.kind),
      ["tool", "text"],
    );
  });
});

describe("groupProcessItems", () => {
  it("跨 Assistant 消息合并相邻工具,不受消息边界打断", () => {
    const items = buildTurnItems([
      message("m1", { tools: [tool("bash", "b1"), tool("read", "r1")] }),
      message("m2", { tools: [tool("edit", "e1")] }),
    ]);
    const nodes = groupProcessItems(items, "card");
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0]!.type, "run");
    assert.deepEqual(runToolIds(nodes[0]!), ["b1", "r1", "e1"]);
  });

  it("紧凑模式两个相邻工具就合并,卡片模式保持逐个展示", () => {
    const items = buildTurnItems([
      message("m1", { tools: [tool("bash", "b1")] }),
      message("m2", { tools: [tool("read", "r1")] }),
    ]);
    const compact = groupProcessItems(items, "compact");
    assert.deepEqual(compact.map((node) => node.type), ["run"]);
    assert.deepEqual(runToolIds(compact[0]!), ["b1", "r1"]);

    const card = groupProcessItems(items, "card");
    assert.deepEqual(card.map((node) => node.type), ["tool", "tool"]);
    assert.deepEqual(
      card.map((node) => (node.type === "tool" ? node.tool.id : node.id)),
      ["b1", "r1"],
    );
  });

  it("思考打断分组,前后工具各自成组", () => {
    const items = buildTurnItems([
      message("m1", { tools: [tool("bash", "b1"), tool("read", "r1"), tool("edit", "e1")] }),
      message("m2", { thinking: "换一步", tools: [tool("bash", "b2"), tool("read", "r2")] }),
      message("m3", { tools: [tool("edit", "e2"), tool("write", "w2")] }),
    ]);
    const nodes = groupProcessItems(items, "card");
    assert.deepEqual(nodes.map((node) => node.type), ["run", "thinking", "run"]);
    assert.deepEqual(runToolIds(nodes[0]!), ["b1", "r1", "e1"]);
    assert.deepEqual(runToolIds(nodes[2]!), ["b2", "r2", "e2", "w2"]);
  });

  it("可见正文打断分组", () => {
    const items = buildTurnItems([
      message("m1", { tools: [tool("bash", "b1"), tool("read", "r1")] }),
      message("m2", { text: "中间说明" }),
      message("m3", { tools: [tool("edit", "e1"), tool("write", "w1")] }),
    ]);
    const nodes = groupProcessItems(items, "compact");
    assert.deepEqual(nodes.map((node) => node.type), ["run", "text", "run"]);
  });

  it("交互卡片等不可折叠工具打断分组", () => {
    const items = buildTurnItems([
      message("m1", { tools: [tool("bash", "b1"), tool("read", "r1")] }),
      message("m2", { tools: [tool("submit_plan", "p1")] }),
      message("m3", { tools: [tool("edit", "e1"), tool("write", "w1")] }),
    ]);
    const nodes = groupProcessItems(items, "compact");
    assert.deepEqual(nodes.map((node) => node.type), ["run", "tool", "run"]);
    assert.equal(nodes[1]!.type === "tool" && nodes[1]!.tool.id, "p1");
  });
});
