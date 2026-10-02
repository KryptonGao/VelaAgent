import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TraceNode } from "@vela/shared";
import { formatDuration, indexToolDurations, readToolDuration, readTurnDuration } from "../src/renderer/components/tool-duration.ts";

describe("tool durations", () => {
  it("formats boundaries without rounding seconds into the next unit", () => {
    for (const [ms, expected] of [[0, "0ms"], [999, "999ms"], [1000, "1.0s"], [1234, "1.2s"], [12400, "12.4s"],
      [59999, "59.9s"], [60000, "1m0s"], [80000, "1m20s"], [100000, "1m40s"], [-1, "0ms"]] as const) {
      assert.equal(formatDuration(ms), expected);
    }
  });

  it("prefers recorded duration, including zero, then execution timestamps", () => {
    assert.equal(readToolDuration({ durationMs: 0, startedAt: 100, completedAt: 900 }), 0);
    assert.equal(readToolDuration({ durationMs: 2300, startedAt: 100, completedAt: 900 }), 2300);
    assert.equal(readToolDuration({ startedAt: 100, completedAt: 920 }), 820);
    assert.equal(readToolDuration({ startedAt: 100, executionStartedAt: 800, completedAt: 900 }), 100);
    assert.equal(readToolDuration({ status: "error", startedAt: 100, completedAt: 150 }), 50);
  });

  it("hides missing, invalid, reversed and unfinished metrics", () => {
    for (const source of [{}, { startedAt: 0 }, { completedAt: 0 }, { durationMs: -1 }, { durationMs: NaN },
      { durationMs: Infinity }, { startedAt: -10, completedAt: 0 }, { startedAt: 2, completedAt: 1 },
      { status: "running", durationMs: 300 }, { status: "Running", startedAt: 0, completedAt: 100 }]) {
      assert.equal(readToolDuration(source), null);
    }
  });

  it("aggregates only complete metrics and ignores process prose", () => {
    assert.equal(readTurnDuration([{ durationMs: 820 }, { durationMs: 2300 }]), 3120);
    assert.equal(readTurnDuration([{ durationMs: 0 }]), 0);
    assert.equal(readTurnDuration([]), null);
    assert.equal(readTurnDuration([{ durationMs: 820 }, {}]), null);
    assert.equal(readTurnDuration([{ durationMs: 820 }, { status: "running" }]), null);
    assert.equal(readTurnDuration([
      { kind: "thinking", id: "t", messageId: "m", text: "Working" },
      { kind: "tool", id: "call", messageId: "m", tool: { id: "call", name: "bash", status: "done", activity: {} } },
    ]), null);
  });

  it("joins call summaries by ID using the newest version, never result nodes", () => {
    const node = (parts: Partial<TraceNode>): TraceNode => ({
      id: "node", sequence: 0, kind: "tool-call", turn: 1, step: 1, requestId: null,
      toolCallId: "call", toolName: "bash", status: "Completed", summary: "", startedAt: 0,
      executionStartedAt: 100, completedAt: 200, durationMs: 100, version: 1, historical: false, ...parts,
    });
    const indexed = indexToolDurations([
      node({ version: 3, durationMs: 2300 }), node({ version: 2, durationMs: 100 }),
      node({ kind: "tool-result", version: 4, durationMs: 0 }), node({ toolCallId: null }),
      node({ toolCallId: "old", historical: true, startedAt: null, executionStartedAt: null, completedAt: null, durationMs: null }),
    ]);
    assert.equal(indexed.size, 2);
    assert.equal(readToolDuration(indexed.get("call")!), 2300);
    assert.equal(readTurnDuration([indexed.get("call")!]), 2300);
    assert.equal(readToolDuration(indexed.get("old")!), null);
  });
});
