import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  graphLaneColors,
  laneColor,
  layoutCommitGraph,
  type GraphCommitInput,
  type GraphEdge,
  type GraphLayout,
} from "../src/renderer/components/version-control/graph-layout.ts";

function commit(sha: string, parents: string[], extra: Partial<GraphCommitInput> = {}): GraphCommitInput {
  return { sha, parents, ...extra };
}

function rowOf(layout: GraphLayout, sha: string) {
  const row = layout.rows.find((item) => item.sha === sha);
  assert.ok(row, `缺少提交 ${sha} 的行`);
  return row;
}

function edgeBetween(layout: GraphLayout, fromSha: string, toSha: string): GraphEdge {
  const found = layout.edges.find((item) => item.fromSha === fromSha && item.toSha === toSha);
  assert.ok(found, `缺少边 ${fromSha} -> ${toSha}`);
  return found;
}

describe("layoutCommitGraph", () => {
  it("线性历史只占一条轨道,边全部 straight,顺序保持", () => {
    const layout = layoutCommitGraph([
      commit("E", ["D"]),
      commit("D", ["C"]),
      commit("C", ["B"]),
      commit("B", ["A"]),
      commit("A", []),
    ]);

    assert.deepEqual(
      layout.rows.map((row) => row.sha),
      ["E", "D", "C", "B", "A"],
    );
    assert.deepEqual(
      layout.rows.map((row) => row.lane),
      [0, 0, 0, 0, 0],
    );
    assert.deepEqual(
      layout.rows.map((row) => row.kind),
      ["normal", "normal", "normal", "normal", "normal"],
    );
    assert.equal(layout.laneCount, 1);
    assert.equal(layout.edges.length, 4);
    for (const edge of layout.edges) {
      assert.equal(edge.kind, "straight");
      assert.equal(edge.fromLane, 0);
      assert.equal(edge.toLane, 0);
      assert.equal(edge.offscreen, false);
    }
    assert.deepEqual(layout.laneSegments, [{ fromRow: 0, toRow: 4, lane: 0 }]);
  });

  it("分叉再合并:合并提交沿用第一父提交轨道,侧分支边标为 merge,汇合后回到主轨道", () => {
    // E - D - B - A 与 D - C - A,D 是 B(第一父)和 C 的合并提交。
    const layout = layoutCommitGraph([
      commit("E", ["D"]),
      commit("D", ["B", "C"]),
      commit("B", ["A"]),
      commit("C", ["A"]),
      commit("A", []),
    ]);

    assert.equal(rowOf(layout, "D").lane, rowOf(layout, "B").lane);
    assert.equal(rowOf(layout, "C").lane, 1);
    assert.equal(rowOf(layout, "A").lane, 0);
    assert.ok(layout.laneCount <= 3);
    assert.equal(layout.laneCount, 2);

    const mergeEdge = edgeBetween(layout, "D", "C");
    assert.equal(mergeEdge.kind, "merge");
    assert.equal(mergeEdge.fromLane, 0);
    assert.equal(mergeEdge.toLane, 1);
    assert.equal(mergeEdge.offscreen, false);

    const firstParentEdge = edgeBetween(layout, "D", "B");
    assert.equal(firstParentEdge.kind, "straight");
    assert.equal(firstParentEdge.fromLane, 0);
    assert.equal(firstParentEdge.toLane, 0);

    // C 的第一父提交 A 已被 0 号轨道等待,放置时只保留最左轨道,C -> A 记为 fork。
    const joinEdge = edgeBetween(layout, "C", "A");
    assert.equal(joinEdge.kind, "fork");
    assert.equal(joinEdge.fromLane, 1);
    assert.equal(joinEdge.toLane, 0);
    assert.equal(edgeBetween(layout, "B", "A").kind, "straight");

    assert.deepEqual(layout.laneSegments, [
      { fromRow: 0, toRow: 4, lane: 0 },
      { fromRow: 1, toRow: 4, lane: 1 },
    ]);
  });

  it("两个互不相关的根合并时不崩溃,并落在不同轨道", () => {
    for (const order of [
      ["M", "A", "X"],
      ["M", "X", "A"],
    ]) {
      const bySha: Record<string, GraphCommitInput> = {
        M: commit("M", ["A", "X"]),
        A: commit("A", []),
        X: commit("X", []),
      };
      const layout = layoutCommitGraph(order.map((sha) => bySha[sha]));

      assert.notEqual(rowOf(layout, "A").lane, rowOf(layout, "X").lane);
      assert.equal(rowOf(layout, "A").lane, 0);
      assert.equal(rowOf(layout, "X").lane, 1);
      assert.equal(rowOf(layout, "M").lane, 0);
      assert.equal(layout.laneCount, 2);

      const mergeEdge = edgeBetween(layout, "M", "X");
      assert.equal(mergeEdge.kind, "merge");
      assert.equal(mergeEdge.fromLane, 0);
      assert.equal(mergeEdge.toLane, 1);
      assert.equal(mergeEdge.offscreen, false);
      assert.equal(edgeBetween(layout, "M", "A").kind, "straight");
    }
  });

  it("分页:父提交未加载时产生离屏边、pending 行,竖线延伸到图底", () => {
    const layout = layoutCommitGraph([
      commit("H2", ["H1"]),
      commit("H1", ["P1"], { pendingParent: true }),
    ]);

    assert.deepEqual(
      layout.rows.map((row) => row.kind),
      ["normal", "pending"],
    );
    assert.equal(layout.laneCount, 1);

    const pendingEdge = edgeBetween(layout, "H1", "?P1");
    assert.equal(pendingEdge.offscreen, true);
    assert.equal(pendingEdge.fromLane, 0);
    assert.equal(pendingEdge.toLane, 0);
    assert.equal(pendingEdge.kind, "straight");

    assert.deepEqual(layout.laneSegments, [{ fromRow: 0, toRow: 2, lane: 0 }]);
  });

  it("分页:侧分支父提交未加载时沿自己的轨道延伸到图底", () => {
    const layout = layoutCommitGraph([
      commit("M", ["S", "B2"]),
      commit("S", ["P"], { pendingParent: true }),
    ]);

    assert.deepEqual(
      layout.rows.map((row) => row.kind),
      ["normal", "pending"],
    );
    assert.equal(layout.laneCount, 2);

    const branchEdge = edgeBetween(layout, "M", "?B2");
    assert.equal(branchEdge.offscreen, true);
    assert.equal(branchEdge.kind, "merge");
    assert.equal(branchEdge.fromLane, 0);
    assert.equal(branchEdge.toLane, 1);

    const mainEdge = edgeBetween(layout, "S", "?P");
    assert.equal(mainEdge.offscreen, true);
    assert.equal(mainEdge.kind, "straight");
    assert.equal(mainEdge.fromLane, 0);
    assert.equal(mainEdge.toLane, 0);

    assert.deepEqual(layout.laneSegments, [
      { fromRow: 0, toRow: 2, lane: 0 },
      { fromRow: 0, toRow: 2, lane: 1 },
    ]);
  });

  it("浅克隆边界:boundary 行画虚线边界边,不做离屏延续", () => {
    const layout = layoutCommitGraph([
      commit("H", ["B"]),
      commit("B", ["deadbeef"], { boundary: true }),
    ]);

    assert.deepEqual(
      layout.rows.map((row) => row.kind),
      ["normal", "boundary"],
    );
    assert.equal(rowOf(layout, "B").lane, 0);

    const boundaryEdges = layout.edges.filter((edge) => edge.fromSha === "B");
    assert.equal(boundaryEdges.length, 1);
    const boundaryEdge = boundaryEdges[0];
    assert.equal(boundaryEdge.toSha, "?deadbeef");
    assert.equal(boundaryEdge.offscreen, false);
    assert.equal(boundaryEdge.fromLane, 0);
    assert.equal(boundaryEdge.toLane, 0);

    // 边界边终点不在图表内,但不应产生 offscreen 延续或延伸到图底的竖线。
    assert.equal(
      layout.edges.some((edge) => edge.offscreen),
      false,
    );
    assert.deepEqual(layout.laneSegments, [{ fromRow: 0, toRow: 1, lane: 0 }]);
  });

  it("轨道复用:侧分支合并后释放的轨道立即被后续侧分支复用,laneCount 保持有界", () => {
    const layout = layoutCommitGraph([
      commit("M3", ["M2", "f2b"]),
      commit("f2b", ["f2a"]),
      commit("f2a", ["M2"]),
      commit("M2", ["M1", "f1b"]),
      commit("f1b", ["f1a"]),
      commit("f1a", ["M1"]),
      commit("M1", ["R"]),
      commit("R", []),
    ]);

    // 8 个提交里只有两条并发轨道;1 号轨道先被 feature2 使用,合并后又被 feature1 复用。
    assert.equal(layout.laneCount, 2);
    assert.deepEqual(
      layout.rows.filter((row) => row.lane === 1).map((row) => row.sha),
      ["f2b", "f2a", "f1b", "f1a"],
    );
    assert.equal(rowOf(layout, "M2").lane, 0);
    assert.equal(rowOf(layout, "M1").lane, 0);
    for (const row of layout.rows) assert.ok(row.lane < 2);
  });

  it("maxLanes 达到上限后折回最左轨道,不在宽度之外分配轨道", () => {
    const layout = layoutCommitGraph(
      [commit("M", ["A", "B", "C"]), commit("A", []), commit("B", []), commit("C", [])],
      { maxLanes: 2 },
    );

    assert.equal(layout.laneCount, 2);
    for (const row of layout.rows) assert.ok(row.lane < 2);
    for (const edge of layout.edges) {
      assert.ok(edge.fromLane < 2);
      assert.ok(edge.toLane < 2);
    }
  });

  it("空输入返回空图表,laneCount 至少为 1", () => {
    const layout = layoutCommitGraph([]);
    assert.deepEqual(layout.rows, []);
    assert.deepEqual(layout.edges, []);
    assert.deepEqual(layout.laneSegments, []);
    assert.equal(layout.laneCount, 1);
  });
});

describe("laneColor", () => {
  it("调色板至少 8 色、颜色去重、按长度循环且结果稳定", () => {
    assert.ok(graphLaneColors.length >= 8);
    assert.equal(new Set(graphLaneColors).size, graphLaneColors.length);

    for (let lane = 0; lane < graphLaneColors.length * 2 + 3; lane++) {
      assert.equal(laneColor(lane), graphLaneColors[lane % graphLaneColors.length]);
      assert.equal(laneColor(lane), laneColor(lane));
    }
    assert.equal(laneColor(graphLaneColors.length), laneColor(0));
  });
});
