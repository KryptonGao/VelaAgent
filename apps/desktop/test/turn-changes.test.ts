import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ToolTrace } from "@vela/shared";
import type { UiMessage } from "../src/renderer/hooks/useSession.ts";
import { changesByFinalMessage, summarizeTurnChanges } from "../src/renderer/components/turn-changes.ts";

function tool(id: string, path: string, diff: string, status: ToolTrace["status"] = "done"): ToolTrace {
  return { id, name: "edit", status, activity: { path, diff } };
}

function message(id: string, role: UiMessage["role"], tools: ToolTrace[] = []): UiMessage {
  return { id, role, text: "", thinking: "", tools };
}

describe("turn change summary", () => {
  it("counts displayed edits by file and ignores failed calls", () => {
    const changes = summarizeTurnChanges([
      tool("one", "/repo/src/a.ts", "-1 old\n+1 new\n 2 kept"),
      tool("two", "src/a.ts", "+2 next"),
      tool("failed", "src/b.ts", "+1 ignored", "error"),
      { id: "bash", name: "bash", status: "done", activity: { path: "src/c.ts", diff: "+1 ignored" } },
    ], "/repo");
    assert.deepEqual(changes, {
      files: [{ path: "src/a.ts", added: 2, removed: 1, diffs: ["-1 old\n+1 new\n 2 kept", "+2 next"] }],
      added: 2,
      removed: 1,
    });
  });

  it("places one card after the final assistant message of each completed turn", () => {
    const messages = [
      message("user-1", "user"),
      message("step-1", "assistant", [tool("edit-1", "a.ts", "+1 first")]),
      message("reply-1", "assistant", [tool("edit-2", "b.ts", "-1 old\n+1 new")]),
      message("user-2", "user"),
      message("reply-2", "assistant", [tool("edit-3", "c.ts", "+1 next")]),
    ];
    const streaming = changesByFinalMessage(messages, true, null);
    assert.deepEqual([...streaming.keys()], ["reply-1"]);
    assert.deepEqual(streaming.get("reply-1")?.files.map((file) => file.path), ["a.ts", "b.ts"]);
    assert.deepEqual([...changesByFinalMessage(messages, false, null).keys()], ["reply-1", "reply-2"]);
  });
});
