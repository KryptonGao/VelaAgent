import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { trackEnteredMessages } from "../src/renderer/components/message-motion.ts";

describe("trackEnteredMessages", () => {
  it("seeds messages that arrive with the conversation and does not animate them", () => {
    const tracked = trackEnteredMessages(null, "chat-a", ["m1", "m2", "m3"]);
    assert.equal(tracked.primed, true);
    assert.equal(tracked.enter.size, 0);
  });

  it("treats a later history restore as already seen", () => {
    const empty = trackEnteredMessages(null, "chat-a", []);
    const restored = trackEnteredMessages(empty, "chat-a", ["m1", "m2", "m3", "m4"]);
    assert.equal(restored.enter.size, 0);
    assert.equal(restored.primed, true);
  });

  it("animates the user and assistant pair from a send", () => {
    const empty = trackEnteredMessages(null, "chat-a", []);
    const sent = trackEnteredMessages(empty, "chat-a", ["user", "assistant"]);
    assert.deepEqual([...sent.enter], ["user", "assistant"]);
  });

  it("animates only messages that appear after the conversation is primed", () => {
    const primed = trackEnteredMessages(null, "chat-a", ["m1", "m2"]);
    const next = trackEnteredMessages(primed, "chat-a", ["m1", "m2", "m3"]);
    assert.deepEqual([...next.enter], ["m3"]);
    const again = trackEnteredMessages(next, "chat-a", ["m1", "m2", "m3"]);
    assert.equal(again, next);
  });

  it("drops enter marks when the conversation changes", () => {
    const first = trackEnteredMessages(trackEnteredMessages(null, "chat-a", []), "chat-a", ["user"]);
    const second = trackEnteredMessages(first, "chat-b", ["old"]);
    assert.equal(second.enter.size, 0);
    assert.equal(second.ids.has("old"), true);
  });
});
