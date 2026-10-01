import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMessageStore, emptyMessages, messageScope } from "../src/renderer/hooks/message-store.ts";
import { applyAgentStreamEvent, type AgentMessageBuckets, type UiMessage } from "../src/renderer/hooks/useSession.ts";

function setup() {
  let queued: (() => void) | null = null;
  let schedules = 0;
  const store = createMessageStore(callback => {
    schedules += 1;
    queued = callback;
    return () => { queued = null; };
  });
  return { store, tick: () => queued?.(), schedules: () => schedules };
}
const reply = (text: string): UiMessage[] => [{ id: "m", role: "assistant", text, thinking: "", tools: [] }];

describe("scoped message publication", () => {
  it("isolates main, sibling agent and background-conversation subscribers", () => {
    const { store, tick } = setup();
    const scopes = [messageScope("c"), messageScope("c", "a"), messageScope("c", "b"), messageScope("other", "a")];
    const counts = scopes.map(() => 0);
    scopes.forEach((scope, index) => store.subscribe(scope, () => { counts[index] += 1; }));
    const main = store.getSnapshot(scopes[0]!);
    store.publish(scopes[1]!, reply("agent output"));
    tick();
    assert.deepEqual(counts, [0, 1, 0, 0]);
    assert.equal(store.getSnapshot(scopes[0]!), main);
  });

  it("publishes 100 deltas once, preserving order and tool completion", () => {
    const { store, tick, schedules } = setup();
    const scope = messageScope("c", "a");
    let notified = 0;
    store.subscribe(scope, () => { notified += 1; });
    let buckets: AgentMessageBuckets = {};
    const events = [
      { type: "assistant_start" as const },
      ...Array.from({ length: 100 }, (_, index) => ({ type: "text_delta" as const, delta: `${index},` })),
      { type: "tool_start" as const, toolCallId: "t", toolName: "read", activity: { path: "file.ts" } },
      { type: "tool_end" as const, toolCallId: "t", toolName: "read", isError: false, activity: { body: "complete" } },
    ];
    for (const event of events) {
      buckets = applyAgentStreamEvent(buckets, "c", "a", event);
      store.publish(scope, buckets.c!.a!);
    }
    assert.equal(store.getSnapshot(scope), emptyMessages);
    assert.equal(schedules(), 1);
    tick();
    assert.equal(notified, 1);
    assert.equal(store.getSnapshot(scope)[0]?.text, Array.from({ length: 100 }, (_, index) => `${index},`).join(""));
    assert.equal(store.getSnapshot(scope)[0]?.tools[0]?.status, "done");
    assert.equal(store.getSnapshot(scope)[0]?.tools[0]?.activity.body, "complete");
  });

  it("commits all streams before notifying and does not notify for identical data", () => {
    const { store, tick } = setup();
    const a = messageScope("c");
    const b = messageScope("c", "a");
    const messages = reply("done");
    let notified = 0;
    store.subscribe(a, () => { notified += 1; assert.equal(store.getSnapshot(b), messages); });
    store.publish(a, messages);
    store.publish(b, messages);
    tick();
    store.publish(a, messages);
    tick();
    assert.equal(notified, 1);
  });

  it("retains hidden output without listeners, supports rewind and remount", () => {
    const { store, tick } = setup();
    const scope = messageScope("c", "a");
    let notified = 0;
    const unsubscribe = store.subscribe(scope, () => { notified += 1; });
    unsubscribe();
    store.publish(scope, reply("hidden final output"));
    tick();
    assert.equal(notified, 0);
    assert.equal(store.getSnapshot(scope)[0]?.text, "hidden final output");
    store.subscribe(scope, () => { notified += 1; });
    store.publish(scope, emptyMessages);
    store.flush();
    assert.equal(store.getSnapshot(scope), emptyMessages);
    assert.equal(notified, 1);
    store.publish(scope, reply("after rewind"));
    tick();
    assert.equal(notified, 2);
  });
});
