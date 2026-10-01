import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isBoolean, isBooleanRecord, readStoredState } from "../src/renderer/hooks/useStoredState.ts";
import { toUiMessage } from "../src/renderer/hooks/useSession.ts";
import { ThinkingCompletionTracker } from "../src/renderer/thinking-summary.ts";

describe("restored renderer state", () => {
  it("preserves host timing through transcript conversion without triggering a summary request", () => {
    const restored = toUiMessage({ id: "history", role: "assistant", text: "done", thinking: "inspect persistence",
      tools: [], timestamp: 3000, turnStartedAt: 1000, turnCompletedAt: 3000 });
    assert.equal(restored.turnStartedAt, 1000);
    assert.equal(restored.turnCompletedAt, 3000);
    const tracker = new ThinkingCompletionTracker();
    tracker.observe("chat", [], false, true);
    assert.deepEqual(tracker.observe("chat", [restored], false, true), []);
  });

  it("restores collapsed panels and workspace groups, while rejecting invalid saved values", () => {
    const values = new Map([
      ["vela.leftCollapsed", "true"], ["vela.rightCollapsed", "false"],
      ["vela.collapsedWorkspaces", JSON.stringify({ "/workspace/a": true, "/workspace/b": false })],
    ]);
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: () => {}, removeItem: () => {} };
    assert.equal(readStoredState("vela.leftCollapsed", false, isBoolean, storage), true);
    assert.equal(readStoredState("vela.rightCollapsed", true, isBoolean, storage), false);
    assert.deepEqual(readStoredState("vela.collapsedWorkspaces", {}, isBooleanRecord, storage), {
      "/workspace/a": true, "/workspace/b": false,
    });
    for (const invalid of ["bad json", '"true"', "null", "[]", '{"/workspace":"true"}']) {
      values.set("vela.collapsedWorkspaces", invalid);
      assert.deepEqual(readStoredState("vela.collapsedWorkspaces", {}, isBooleanRecord, storage), {});
    }
  });
});
