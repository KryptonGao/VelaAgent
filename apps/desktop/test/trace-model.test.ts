import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TraceNode, TraceRequest } from "@vela/shared";
import {
  emptyTrace,
  mergeTrace,
  traceTimeline,
  traceMetrics,
  slowestTraceNode,
  traceCodePages,
} from "../src/renderer/components/trace/trace-model.ts";
const node = (
  id: string,
  sequence: number,
  extra: Partial<TraceNode> = {},
): TraceNode => ({
  id,
  sequence,
  kind: "assistant",
  turn: 1,
  step: 1,
  requestId: "r1",
  toolCallId: null,
  toolName: null,
  status: "Completed",
  summary: id,
  startedAt: 1000 + sequence * 100,
  completedAt: 1200 + sequence * 100,
  executionStartedAt: null,
  durationMs: 200,
  version: sequence,
  historical: false,
  ...extra,
});
const request = (
  id = "r1",
  extra: Partial<TraceRequest> = {},
): TraceRequest => ({
  id,
  number: 1,
  turn: 1,
  model: "test",
  status: "Completed",
  contextId: "c1",
  startedAt: 1000,
  completedAt: 2024,
  durationMs: 1024,
  firstTokenMs: 500,
  generationMs: 524,
  usage: {
    input: 10,
    output: 151,
    cacheRead: 970,
    cacheWrite: 0,
    totalTokens: 1131,
  },
  ...extra,
});
describe("trace renderer model", () => {
  it("uses equal event slots in recorded order regardless of timing or overlaps", () => {
    const events = [
      node("tool", 4, {
        kind: "tool-call", startedAt: 1100,
        executionStartedAt: 1100, completedAt: 901100,
      }),
      node("system", 0, { kind: "system", requestId: null }),
      node("user", 1, {
        kind: "user", requestId: null, startedAt: 1000, completedAt: 1000,
      }),
      node("thinking", 2, {
        kind: "thinking", historical: true, startedAt: null, completedAt: null,
      }),
      node("text", 3, { startedAt: 1000, completedAt: 901100 }),
      node("result", 5, { kind: "tool-result" }),
    ];
    const order = events.map((n) => n.id);
    const t = traceTimeline(events, [], "sequence", 1000000);
    assert.deepEqual(t.bars.map((b) => b.node.id), [
      "system", "user", "thinking", "text", "tool", "result",
    ]);
    assert.equal(new Set(t.bars.map((b) => b.width)).size, 1);
    assert.ok(t.bars[0]!.width > 10);
    assert.deepEqual(t.bars.map((b) => b.lane), [0, 0, 1, 1, 2, 2]);
    assert.deepEqual(t.rows, [1, 1, 1]);
    assert.ok(t.bars.every((b) => b.row === 0));
    assert.ok(t.bars.every((b, i) => i === 0 ||
      t.bars[i - 1]!.x + t.bars[i - 1]!.width < b.x));
    assert.deepEqual(events.map((n) => n.id), order);
    assert.deepEqual(
      traceTimeline(events, [], "sequence", 2000000).bars.map((b) => [b.x, b.width]),
      t.bars.map((b) => [b.x, b.width]),
    );
  });
  it("places a tool-only request before its tools in equal mode even without timing", () => {
    const call = node("r1-block-0", 1, {
      kind: "tool-call", historical: true,
      startedAt: null, completedAt: null, durationMs: null,
    });
    const result = node("result", 2, { kind: "tool-result", toolCallId: "t1" });
    const t = traceTimeline([call, result], [request("r1", {
      startedAt: null, completedAt: null, durationMs: null,
    })], "sequence", 3000);
    assert.deepEqual(t.bars.map((b) => b.node.id), ["r1-model", "r1-block-0", "result"]);
    assert.equal(t.bars[0]?.sourceNodeId, "r1-block-0");
    assert.equal(t.bars[0]?.node.durationMs, null);
    assert.equal(new Set(t.bars.map((b) => b.width)).size, 1);
  });
  it("keeps equal-mode positions stable when live timing updates and events append", () => {
    const events = [node("user", 0, { kind: "user", requestId: null }),
      node("r1-block-0", 1, { kind: "thinking", status: "Running", completedAt: null })];
    const initial = traceTimeline(events, [request()], "sequence", 2000);
    const updated = traceTimeline([
      ...events.map((n) => ({ ...n, completedAt: 10000, status: "Completed" as const })),
      node("tool", 2, { kind: "tool-call", executionStartedAt: 10000 }),
    ], [request()], "sequence", 10000);
    assert.deepEqual(updated.bars.slice(0, 2).map((b) => [b.node.id, b.x, b.width]),
      initial.bars.map((b) => [b.node.id, b.x, b.width]));
    assert.equal(updated.bars[2]?.width, initial.bars[0]?.width);
  });
  it("merges a late snapshot with live updates without reverting nodes or request usage", () => {
    const live = mergeTrace(emptyTrace, {
      version: 10,
      nodes: [node("a", 1, { version: 10, summary: "new" })],
      requests: [request("r1", { durationMs: 999 })],
      warning: null,
    });
    const merged = mergeTrace(live, {
      version: 2,
      nodes: [node("a", 1, { version: 2 }), node("b", 2)],
      requests: [request(), request("r2", { number: 2 })],
      warning: null,
    });
    assert.equal(merged.nodes[0]?.summary, "new");
    assert.equal(merged.requests[0]?.durationMs, 999);
    assert.equal(merged.requests.length, 2);
    assert.equal(merged.nodes.length, 2);
    assert.equal(
      mergeTrace(merged, { ...merged, version: 10 }).nodes.length,
      2,
    );
  });
  it("uses actual timing in duration mode and separates overlapping tools", () => {
    const nodes = [
      node("a", 1, {
        kind: "tool-call",
        executionStartedAt: 1200,
        completedAt: 2200,
      }),
      node("b", 2, {
        kind: "tool-call",
        executionStartedAt: 1300,
        completedAt: 1800,
      }),
      node("user", 0, { kind: "user", startedAt: 1000, completedAt: 1000 }),
    ];
    const t = traceTimeline(nodes, [request()], "duration", 3000);
    assert.equal(t.bars[0]?.width, 2 * t.bars[1]!.width);
    assert.notEqual(t.bars[0]?.row, t.bars[1]?.row);
    assert.equal(t.bars[2]?.width, 10);
  });
  it("draws tool-only model requests using request timing independently of execution", () => {
    const nodes = [
      node("r1-block-0", 1, {
        kind: "tool-call",
        startedAt: 8275,
        executionStartedAt: 9049,
        completedAt: 9058,
        durationMs: 9,
      }),
      node("r1-block-1", 2, {
        kind: "tool-call",
        startedAt: 8584,
        executionStartedAt: 9050,
        completedAt: 9083,
        durationMs: 33,
      }),
    ];
    const r = request("r1", {
      startedAt: 5306,
      completedAt: 9047,
      durationMs: 3741,
    });
    for (const mode of ["duration", "turn", "request"] as const) {
      const t = traceTimeline(nodes, [r], mode, 10000);
      const model = t.bars.find((b) => b.lane === 1)!;
      const tool = t.bars.find((b) => b.node.id === "r1-block-0")!;
      assert.ok(model, mode);
      assert.equal(t.bars.filter((b) => b.lane === 1).length, 1, mode);
      assert.equal(model.node.startedAt, 5306, mode);
      assert.equal(model.node.completedAt, 9047, mode);
      assert.equal(model.node.durationMs, 3741, mode);
      assert.equal(model.node.status, "Completed", mode);
      assert.equal(model.sourceNodeId, "r1-block-0", mode);
      assert.notEqual(model.node.id, tool.node.id, mode);
      assert.ok(model.node.completedAt! < tool.node.executionStartedAt!, mode);
      // Minimum-width markers near the right edge may shift left by up to 10px.
      assert.ok(model.x + model.width <= tool.x + 10, mode);
      assert.equal(tool.width, 10, mode);
      assert.equal(slowestTraceNode(t.bars.map((b) => b.node), [r]), model.node.id);
    }
  });
  it("shows streaming tool arguments as model activity until execution starts", () => {
    const call = node("r1-block-0", 1, {
      kind: "tool-call",
      status: "Running",
      startedAt: 3000,
      completedAt: null,
      executionStartedAt: null,
      durationMs: null,
    });
    const r = request("r1", {
      status: "Running",
      completedAt: null,
      durationMs: null,
    });
    const t = traceTimeline([call], [r], "duration", 4000);
    assert.equal(t.bars.length, 1);
    assert.equal(t.bars[0]?.lane, 1);
    assert.equal(t.bars[0]?.node.status, "Running");
    assert.equal(t.start, 1000);
    assert.equal(t.duration, 3000);
    assert.equal(t.bars[0]?.width, t.width);
    const later = traceTimeline([call], [r], "duration", 5000);
    assert.equal(later.duration, 4000);
    const finished = traceTimeline([
      { ...call, executionStartedAt: 5002 },
    ], [{ ...r, status: "Completed", completedAt: 5000, durationMs: 4000 }], "duration", 6000);
    assert.equal(finished.bars.filter((b) => b.lane === 1).length, 1);
    assert.equal(finished.bars.filter((b) => b.lane === 2).length, 1);
    assert.equal(finished.bars.find((b) => b.lane === 1)?.node.completedAt, 5000);
  });
  it("ends a tool-first model span when a text block takes over", () => {
    const t = traceTimeline([
      node("r1-block-0", 1, {
        kind: "tool-call",
        executionStartedAt: 5000,
        completedAt: 5020,
      }),
      node("r1-block-1", 2, {
        startedAt: 3000,
        completedAt: 4000,
      }),
    ], [request("r1", { completedAt: 4000, durationMs: 3000 })], "duration", 6000);
    const span = t.bars.find((b) => b.sourceNodeId)!;
    const text = t.bars.find((b) => b.node.id === "r1-block-1")!;
    assert.equal(span.node.completedAt, 3000);
    assert.equal(span.x + span.width, text.x);
  });
  it("does not invent model request durations when historical timing is missing", () => {
    const t = traceTimeline([
      node("old-call", 1, {
        kind: "tool-call",
        historical: true,
        completedAt: null,
        durationMs: null,
      }),
    ], [request("r1", { startedAt: null, completedAt: 2000, durationMs: null })], "duration", 3000);
    assert.equal(t.bars.length, 1);
    assert.equal(t.bars[0]?.lane, 2);
    assert.equal(t.bars[0]?.width, 10);
  });
  it("packs supplementary requests chronologically between existing model events", () => {
    const t = traceTimeline([
      node("r1-block-0", 1, { startedAt: 1000, completedAt: 2000 }),
      node("r2-block-0", 2, {
        kind: "tool-call", requestId: "r2",
        startedAt: 3000, executionStartedAt: 4000, completedAt: 4030,
      }),
      node("r3-block-0", 3, {
        requestId: "r3", startedAt: 5000, completedAt: 6000,
      }),
    ], [
      request("r1", { completedAt: 2000 }),
      request("r2", { number: 2, startedAt: 2100, completedAt: 3900 }),
      request("r3", { number: 3, startedAt: 4500, completedAt: 6000 }),
    ], "duration", 7000);
    assert.equal(t.bars.find((b) => b.sourceNodeId)?.row, 0);
    assert.equal(t.rows[1], 1);
  });
  it("includes first-token wait in group bounds without overflowing the next request", () => {
    const nodes = [
      node("r1-block-0", 1, {
        kind: "thinking", startedAt: 4224, completedAt: 5271,
      }),
      node("r2-block-0", 2, {
        kind: "tool-call", requestId: "r2", startedAt: 8275,
        executionStartedAt: 9049, completedAt: 9058,
      }),
    ];
    const requests = [
      request("r1", { completedAt: 5271 }),
      request("r2", { number: 2, startedAt: 5306, completedAt: 9047 }),
    ];
    for (const mode of ["duration", "turn", "request"] as const) {
      const t = traceTimeline(nodes, requests, mode, 10000);
      const first = t.bars.find((b) => b.node.id === "r1-block-0")!;
      const second = t.bars.find((b) => b.sourceNodeId)!;
      assert.ok(first.x + first.width < second.x, mode);
      assert.equal(second.row, 0, mode);
      if (mode === "request") assert.ok(first.x + first.width < t.width / 2);
    }
  });
  it("keeps model/tool gaps instead of drawing simultaneous activity in every scale", () => {
    const nodes = [
      node("model-1", 1, {
        kind: "thinking",
        startedAt: 1000,
        completedAt: 2000,
      }),
      node("tool-1", 2, {
        kind: "tool-call",
        startedAt: 1900,
        executionStartedAt: 2100,
        completedAt: 2131,
        durationMs: 31,
      }),
      node("result-1", 3, {
        kind: "tool-result",
        startedAt: 2131,
        completedAt: 2131,
        durationMs: 0,
      }),
      node("model-2", 4, { startedAt: 3000, completedAt: 4000 }),
      node("tool-2", 5, {
        kind: "tool-call",
        executionStartedAt: 4100,
        completedAt: 4184,
        durationMs: 84,
      }),
      node("model-3", 6, { startedAt: 5000, completedAt: 6000 }),
    ];
    for (const mode of ["duration", "turn", "request"] as const) {
      const t = traceTimeline(nodes, [request()], mode, 7000);
      const [model1, tool1, result1, model2, tool2, model3] = t.bars;
      assert.ok(model1!.x + model1!.width < tool1!.x, mode);
      assert.ok(tool1!.x + tool1!.width < model2!.x, mode);
      assert.ok(model2!.x + model2!.width < tool2!.x, mode);
      assert.ok(tool2!.x + tool2!.width < model3!.x, mode);
      assert.equal(result1!.width, 10, mode);
      assert.equal(model1!.width, model2!.width, mode);
    }
  });
  it("shows historical events with unknown durations as markers without inventing intervals", () => {
    const nodes = ["a", "b", "c"].map((id, i) =>
      node(id, i + 1, {
        kind: "thinking" as const,
        startedAt: 1000 + i * 1000,
        completedAt: null,
        durationMs: null,
        historical: true,
      }),
    );
    for (const mode of ["duration", "turn", "request"] as const) {
      const t = traceTimeline(nodes, [], mode, 4000);
      assert.ok(t.bars.every((b) => b.width === 10), mode);
      assert.ok(t.bars[0]!.x + t.bars[0]!.width < t.bars[1]!.x, mode);
      assert.ok(t.bars[1]!.x + t.bars[1]!.width < t.bars[2]!.x, mode);
    }
  });
  it("changes timeline scale without reordering the event list", () => {
    const nodes = [
      node("a", 1),
      node("b", 2, {
        turn: 2,
        requestId: "r2",
        startedAt: 100000,
        completedAt: 100200,
      }),
    ];
    const requests = [request(), request("r2", { number: 2, turn: 2 })];
    for (const mode of ["duration", "turn", "request"] as const) {
      const timeline = traceTimeline(nodes, requests, mode, 100200);
      assert.deepEqual(
        timeline.bars.map((b) => b.node.id),
        ["a", "b"],
      );
      assert.ok(
        timeline.bars.every((b) => Number.isFinite(b.x) && b.width >= 6),
      );
    }
  });
  it("scales every timeline mode proportionally with the zoom factor", () => {
    const nodes = [
      node("a", 1),
      node("tool", 2, {
        kind: "tool-call",
        executionStartedAt: 1200,
        completedAt: 1500,
        durationMs: 300,
      }),
      node("b", 3, {
        requestId: "r2",
        turn: 2,
        startedAt: 3000,
        completedAt: 3400,
      }),
    ];
    const requests = [
      request(),
      request("r2", { number: 2, turn: 2, startedAt: 2900, completedAt: 3400 }),
    ];
    for (const mode of ["sequence", "duration", "turn", "request"] as const) {
      const base = traceTimeline(nodes, requests, mode, 4000);
      const zoomed = traceTimeline(nodes, requests, mode, 4000, 2);
      assert.equal(zoomed.width, base.width * 2, mode);
      assert.deepEqual(
        zoomed.bars.map((b) => [b.node.id, b.x, b.width, b.row]),
        base.bars.map((b) => [b.node.id, b.x * 2, b.width * 2, b.row]),
        mode,
      );
    }
    const fallback = traceTimeline(nodes, requests, "duration", 4000);
    assert.equal(
      traceTimeline(nodes, requests, "duration", 4000, 0).width,
      fallback.width,
    );
  });
  it("aggregates request-level metrics and locates the slowest measured step", () => {
    const requests = [
      request(),
      request("r2", {
        number: 2,
        usage: null,
        generationMs: null,
        durationMs: 3000,
      }),
    ];
    const stats = traceMetrics(requests);
    assert.equal(stats.tokens, 1131);
    assert.equal(stats.cache, 970 / 980);
    assert.equal(stats.speed, (151 / 524) * 1000);
    assert.equal(
      slowestTraceNode(
        [
          node("a", 1),
          node("b", 2, { requestId: "r2" }),
          node("tool", 3, { kind: "tool-call", durationMs: 4000 }),
        ],
        requests,
      ),
      "tool",
    );
    assert.equal(traceMetrics([]).tokens, null);
  });
  it("handles 10,000 events, missing timestamps and running intervals", () => {
    const nodes = Array.from({ length: 10000 }, (_, i) =>
      node(`n${i}`, i, {
        status: i === 9999 ? "Running" : "Completed",
        completedAt: i === 9999 ? null : 1200 + i * 100,
      }),
    );
    const t = traceTimeline(nodes, [request()], "duration", 1200000);
    assert.equal(t.bars.length, 10000);
    assert.ok(
      t.bars.every((b) => Number.isFinite(b.x) && Number.isFinite(b.width)),
    );
    const unknown = traceTimeline(
      [
        node("old", 1, {
          startedAt: null,
          completedAt: null,
          historical: true,
        }),
      ],
      [],
      "request",
      1000,
    );
    assert.equal(unknown.bars[0]?.width, 10);
  });
});

describe("trace code segmentation", () => {
  it("bounds long single lines and preserves complete content including Unicode", () => {
    const content = "a".repeat(39999) + "🚲" + "b".repeat(90000);
    const pages = traceCodePages(content);
    assert.equal(pages.map((page) => page.text).join(""), content);
    assert.ok(pages.every((page) => page.text.length <= 40000));
    assert.ok(pages.every((page) => !page.text.endsWith("\ud83d")));
  });
  it("bounds multiline output and retains all line separators", () => {
    const content = "output line\n".repeat(50000);
    const pages = traceCodePages(content);
    assert.equal(pages.length, 250);
    assert.equal(pages.map((page) => page.text).join(""), content);
    assert.deepEqual(traceCodePages(""), [
      { text: "", firstLine: 1, lastLine: 1 },
    ]);
  });
});

it("replaces abandoned nodes and requests when a rewind reset arrives", () => {
  const previous = mergeTrace(emptyTrace, { version: 2, nodes: [node("old", 1), node("abandoned", 2)], requests: [request("r1"), request("r2")], warning: null });
  const rewound = mergeTrace(previous, { version: 3, reset: true, nodes: [node("old", 1)], requests: [request("r1")], warning: null });
  assert.deepEqual(rewound.nodes.map(item => item.id), ["old"]);
  assert.deepEqual(rewound.requests.map(item => item.id), ["r1"]);
  assert.equal(rewound.version, 3);
  assert.deepEqual(mergeTrace(rewound, previous), rewound);
});
