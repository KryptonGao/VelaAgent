import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ConversationSummary } from "@vela/shared";
import { activityReason, groupActivityConversations, isSidebarView } from "../src/renderer/components/conversation-activity.ts";

const now = new Date(2026, 9, 2, 12).getTime();
const timestamp = (day: number, hour = 12) => new Date(2026, 9, day, hour).getTime();
function conversation(id: string, updatedAt: number, overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return { id, title: id, cwd: `/projects/${id}`, createdAt: updatedAt, updatedAt, archivedAt: null, status: "ready", ...overrides };
}

describe("sidebar activity", () => {
  it("keeps unsent chats out of activity groups until the first message is sent", () => {
    const draft = conversation("draft", now, { messageCount: 0, status: "starting" });
    const options = { priorityConversations: { draft: true }, waitingConversationIds: ["draft"] };
    assert.deepEqual(groupActivityConversations([draft], options, now), []);
    assert.deepEqual(groupActivityConversations([{ ...draft, status: "ready" }], {}, now), []);
    const sent = { ...draft, messageCount: 1, status: "streaming" as const };
    assert.deepEqual(groupActivityConversations([sent], {}, now).map(group => [group.id, group.conversations.map(item => item.id)]),
      [["priority", ["draft"]]]);
    assert.equal(groupActivityConversations([{ ...sent, status: "ready" }], {}, now)[0]?.id, "today");
  });

  it("prioritizes waiting, errors, marked chats and running chats across workspaces", () => {
    const conversations = [
      conversation("recent", now),
      conversation("running", timestamp(1), { status: "streaming" }),
      conversation("marked", timestamp(1)),
      conversation("error", timestamp(1), { status: "error" }),
      conversation("waiting", timestamp(1), { status: "streaming" }),
      conversation("starting", timestamp(1, 13), { status: "starting" }),
    ];
    const original = structuredClone(conversations);
    const groups = groupActivityConversations(conversations, { priorityConversations: { marked: true }, waitingConversationIds: ["waiting"] }, now);
    assert.deepEqual(groups.map(group => group.id), ["priority", "today"]);
    assert.deepEqual(groups[0]!.conversations.map(item => item.id), ["waiting", "error", "marked", "starting", "running"]);
    assert.deepEqual(conversations, original);
  });

  it("groups regular chats at local calendar boundaries and sorts each group by recency", () => {
    const groups = groupActivityConversations([
      conversation("earlier", timestamp(0, 23)),
      conversation("today-midnight", timestamp(2, 0)),
      conversation("yesterday-midnight", timestamp(1, 0)),
      conversation("today-newest", now),
      conversation("yesterday-newest", timestamp(1, 23)),
    ], {}, now);
    assert.deepEqual(groups.map(group => [group.id, group.conversations.map(item => item.id)]), [
      ["today", ["today-newest", "today-midnight"]],
      ["yesterday", ["yesterday-newest", "yesterday-midnight"]],
      ["earlier", ["earlier"]],
    ]);
    const nextDay = groupActivityConversations([conversation("chat", now)], {}, timestamp(3, 0));
    assert.equal(nextDay[0]!.id, "yesterday");
  });

  it("keeps tied timestamps deterministic without making the selected chat jump to the top", () => {
    const groups = groupActivityConversations([conversation("b", now), conversation("a", now)], {}, now);
    assert.deepEqual(groups[0]!.conversations.map(item => item.id), ["a", "b"]);
  });

  it("excludes archived chats even when marked or waiting and omits empty groups", () => {
    const archived = conversation("archived", now, { status: "error", archivedAt: now });
    assert.deepEqual(groupActivityConversations([archived], { priorityConversations: { archived: true }, waitingConversationIds: ["archived"] }, now), []);
    assert.deepEqual(groupActivityConversations([], {}, now), []);
  });

  it("updates priority when a question resolves, a run completes, or a mark is removed", () => {
    const running = conversation("chat", now, { status: "streaming" });
    assert.equal(activityReason(running, { waitingConversationIds: ["chat"] }), "waiting");
    assert.equal(activityReason(running, {}), "streaming");
    const completed = { ...running, status: "ready" as const, turnCompletedAt: now };
    assert.equal(groupActivityConversations([completed], {}, now)[0]!.id, "today");
    assert.equal(groupActivityConversations([completed], { priorityConversations: { chat: true } }, now)[0]!.id, "priority");
    assert.equal(groupActivityConversations([completed], { priorityConversations: { chat: false } }, now)[0]!.id, "today");
    assert.equal(activityReason({ ...completed, status: "error" }, { priorityConversations: { chat: true } }), "error");
  });

  it("accepts only supported stored sidebar views", () => {
    assert.equal(isSidebarView("activity"), true);
    assert.equal(isSidebarView("workspaces"), true);
    for (const value of [null, {}, [], true, "priority", ""]) assert.equal(isSidebarView(value), false);
  });
});
