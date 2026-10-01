import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { UiMessage } from "../src/renderer/hooks/useSession.ts";
import {
  ThinkingCompletionTracker,
  parseStoredSummaries,
  serializeStoredSummaries,
  storedSummaryLimit,
  thinkingDigest,
  thinkingSummaryKey,
  thinkingSummaryLayout,
  type ThinkingSummaryState,
} from "../src/renderer/thinking-summary.ts";

const thought = (id = "thought-a", patch: Partial<UiMessage> = {}): UiMessage => ({
  id, role: "assistant", text: "", thinking: "inspect the runtime", tools: [], ...patch,
});

describe("automatic thinking completion", () => {
  it("waits for text, a tool, a new assistant step, or the end of the turn", () => {
    for (const { finish, streaming } of [
      { finish: [thought("thought-a", { text: "reply" })], streaming: true },
      { finish: [thought("thought-a", { tools: [{ id: "tool-a", name: "read", status: "running", activity: {} }] })], streaming: true },
      { finish: [thought(), thought("thought-b", { thinking: "next step" })], streaming: true },
      { finish: [thought()], streaming: false },
    ]) {
      const tracker = new ThinkingCompletionTracker();
      assert.deepEqual(tracker.observe("chat-a", [thought()], true, true), []);
      assert.deepEqual(tracker.observe("chat-a", [thought("thought-a", { thinking: "more thinking" })], true, true), []);
      const completed = tracker.observe("chat-a", finish, streaming, true);
      assert.deepEqual(completed.map((message) => message.id), ["thought-a"]);
      assert.deepEqual(tracker.observe("chat-a", finish, streaming, true), []);
    }
  });

  it("does not backfill restored history, including a transcript arriving after an empty render", () => {
    const tracker = new ThinkingCompletionTracker();
    tracker.observe("chat-a", [], false, true);
    assert.deepEqual(tracker.observe("chat-a", [thought(), thought("history-b", { text: "old reply" })], false, true), []);
    assert.deepEqual(tracker.observe("chat-a", [thought(), thought("history-b", { text: "old reply" })], false, true), []);
  });

  it("does not generate while disabled or retroactively when the setting is enabled", () => {
    const tracker = new ThinkingCompletionTracker();
    tracker.observe("chat-a", [thought()], true, false);
    assert.deepEqual(tracker.observe("chat-a", [thought()], false, false), []);
    assert.deepEqual(tracker.observe("chat-a", [thought()], false, true), []);
    assert.deepEqual(tracker.observe("chat-a", [thought()], false, false), []);
    assert.deepEqual(tracker.observe("chat-a", [thought()], false, true), []);
  });

  it("handles a new completed step coalesced into one render", () => {
    const tracker = new ThinkingCompletionTracker();
    tracker.observe("chat-a", [], false, true);
    const message = thought("fast", { turnStartedAt: 1, text: "done" });
    assert.deepEqual(tracker.observe("chat-a", [message], false, true), [message]);
    assert.deepEqual(tracker.observe("chat-a", [message], false, true), []);
  });

  it("handles the first reply finishing before a precreated placeholder ever appears active", () => {
    const tracker = new ThinkingCompletionTracker();
    tracker.observe("chat-a", [thought("placeholder", { thinking: "" })], false, true);
    const finished = thought("placeholder", { turnStartedAt: 1, text: "done" });
    assert.deepEqual(tracker.observe("chat-a", [finished], false, true), [finished]);
    assert.deepEqual(tracker.observe("chat-a", [finished], false, true), []);
  });

  it("isolates conversations and recognizes background completion when returning", () => {
    const tracker = new ThinkingCompletionTracker();
    tracker.observe("chat-a", [thought()], true, true);
    assert.deepEqual(tracker.observe("chat-b", [thought()], false, true), []);
    assert.deepEqual(tracker.observe("chat-a", [thought()], false, true).map((message) => message.id), ["thought-a"]);
  });
});

describe("persisted thinking summaries", () => {
  const passage = "inspect the runtime";

  it("keys a summary by conversation, locale, and the thinking content hash", () => {
    const digest = thinkingDigest(passage);
    assert.equal(thinkingDigest(passage), digest);
    assert.notEqual(thinkingDigest(`${passage}!`), digest);
    const key = thinkingSummaryKey("chat-a", "zh-CN", digest);
    assert.notEqual(thinkingSummaryKey("chat-a", "en", digest), key);
    assert.notEqual(thinkingSummaryKey("chat-b", "zh-CN", digest), key);
  });

  it("restores finished summaries after a reload and ignores pending or failed ones", () => {
    const key = thinkingSummaryKey("chat-a", "zh-CN", thinkingDigest(passage));
    const raw = serializeStoredSummaries({
      [key]: { status: "done", text: "先检查运行时与模型选择。" },
      pending: { status: "pending" },
      failed: { status: "error", error: "无法生成思考总结" },
    });
    assert.deepEqual(parseStoredSummaries(raw), { [key]: { status: "done", text: "先检查运行时与模型选择。" } });
    assert.deepEqual(parseStoredSummaries(null), {});
    assert.deepEqual(parseStoredSummaries("not json"), {});
    assert.deepEqual(parseStoredSummaries('{"empty": "   ", "bad": 1}'), {});
  });

  it(`drops the oldest summaries only after ${storedSummaryLimit} records`, () => {
    const records: Record<string, ThinkingSummaryState> = {};
    for (let index = 0; index < storedSummaryLimit + 5; index += 1) {
      records[`key-${index}`] = { status: "done", text: `summary ${index}` };
    }
    const restored = parseStoredSummaries(serializeStoredSummaries(records));
    assert.equal(Object.keys(restored).length, storedSummaryLimit);
    assert.equal(restored["key-0"], undefined);
    assert.deepEqual(restored[`key-${storedSummaryLimit + 4}`], {
      status: "done",
      text: `summary ${storedSummaryLimit + 4}`,
    });
  });
});

describe("thinking summary display styles", () => {
  const done = { status: "done", text: "先检查运行时。" } as const satisfies ThinkingSummaryState;

  it("keeps the default trigger until a summary actually finishes", () => {
    assert.equal(thinkingSummaryLayout("inline", done, false), "default");
    assert.equal(thinkingSummaryLayout("headline", undefined, false), "default");
    assert.equal(thinkingSummaryLayout("headline", { status: "pending" }, false), "default");
    assert.equal(thinkingSummaryLayout("headline", { status: "error", error: "失败" }, false), "default");
    assert.equal(thinkingSummaryLayout("prose", { status: "pending" }, false), "default");
  });

  it("turns a finished summary into a heading or reply-style block only in the matching style", () => {
    assert.equal(thinkingSummaryLayout("headline", done, false), "headline");
    // 展开后标题让位给完整总结面板,换回默认的“思考”触发条。
    assert.equal(thinkingSummaryLayout("headline", done, true), "default");
    assert.equal(thinkingSummaryLayout("prose", done, false), "prose");
    // 正文样式展开思考时总结仍然可见,末端的图标负责收起。
    assert.equal(thinkingSummaryLayout("prose", done, true), "prose");
  });
});
