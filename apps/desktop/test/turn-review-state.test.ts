import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TurnReviewRequest } from "../src/renderer/components/turn-changes.ts";
import { closeTurnReview, openTurnReview, turnReviewScope } from "../src/renderer/turn-review-state.ts";

function request(turnId: string): TurnReviewRequest {
  return { turnId, changes: { added: 2, removed: 1, files: [{ path: "a.ts", added: 2, removed: 1, diffs: ["-1 old\n+1 new", "+2 more"] }] } };
}

describe("turn review snapshots", () => {
  it("freezes records and cumulative statistics against subsequent edits", () => {
    const source = request("one");
    const scope = turnReviewScope("/repo", "chat");
    const state = openTurnReview({}, scope, source);
    source.changes.files[0].diffs[0] = "+1 future";
    source.changes.files[0].path = "different.ts";
    source.changes.added = 99;
    source.changes.files.push({ path: "later.ts", added: 4, removed: 0, diffs: [] });
    assert.deepEqual(state[scope], request("one"));
  });

  it("reuses a scope for different turns and preserves the snapshot on repeat clicks", () => {
    const scope = turnReviewScope("", "non-git-chat");
    const first = openTurnReview({}, scope, request("one"));
    assert.equal(openTurnReview(first, scope, request("one")), first);
    const next = openTurnReview(first, scope, request("two"));
    assert.equal(Object.keys(next).length, 1);
    assert.equal(next[scope].turnId, "two");
    assert.equal(first[scope].turnId, "one");
  });

  it("isolates chats and workspaces, including delimiters in their identifiers", () => {
    const a = turnReviewScope("/a", "chat");
    const b = turnReviewScope("/a", "another");
    const c = turnReviewScope("/b", "chat");
    let state = openTurnReview({}, a, request("one"));
    state = openTurnReview(state, b, request("two"));
    state = openTurnReview(state, c, request("three"));
    assert.deepEqual([state[a].turnId, state[b].turnId, state[c].turnId], ["one", "two", "three"]);
    assert.notEqual(turnReviewScope("a:b", "c"), turnReviewScope("a", "b:c"));
    const closed = closeTurnReview(state, b);
    assert.equal(closed[b], undefined);
    assert.equal(closed[a], state[a]);
    assert.equal(closed[c], state[c]);
    assert.equal(openTurnReview(closed, b, request("reopened"))[b].turnId, "reopened");
  });
});
