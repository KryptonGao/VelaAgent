import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ConversationSummary } from "@vela/shared";
import { groupActiveConversations, searchActiveConversations, workspaceName } from "../src/renderer/components/conversation-search.ts";

const conversations: ConversationSummary[] = [
  { id: "old", title: "修复登录", cwd: "/projects/Vela", updatedAt: 1, archivedAt: null, status: "ready" },
  { id: "archived", title: "修复登录", cwd: "/projects/Vela", updatedAt: 9, archivedAt: 5, status: "ready" },
  { id: "other", title: "Release notes", cwd: "C:\\projects\\DESKTOP", updatedAt: 4, archivedAt: null, status: "streaming" },
  { id: "recent", title: "侧边栏搜索", cwd: "/projects/Vela", updatedAt: 5, archivedAt: null, status: "ready" },
  { id: "empty", title: "", cwd: "/other/Untitled", updatedAt: 2, archivedAt: null, status: "ready" },
];

describe("sidebar conversation search", () => {
  it("orders dialog results globally by recency and filters titles and workspace paths", () => {
    const original = structuredClone(conversations);
    assert.deepEqual(searchActiveConversations(conversations, "", "新对话").map(item => item.id), ["recent", "other", "empty", "old"]);
    assert.deepEqual(searchActiveConversations(conversations, "DESKTOP release", "新对话").map(item => item.id), ["other"]);
    assert.deepEqual(searchActiveConversations(conversations, "登录", "新对话").map(item => item.id), ["old"]);
    assert.deepEqual(conversations, original);
  });
  it("keeps workspace and conversation recency, excludes archived chats, and does not mutate input", () => {
    const original = structuredClone(conversations);
    const groups = groupActiveConversations(conversations, "   ", "新对话");
    assert.deepEqual(groups.map(group => group.name), ["Vela", "DESKTOP", "Untitled"]);
    assert.deepEqual(groups[0]!.conversations.map(item => item.id), ["recent", "old"]);
    assert.deepEqual(conversations, original);
  });
  it("finds Chinese titles and case-insensitive workspace names or full paths", () => {
    assert.deepEqual(groupActiveConversations(conversations, "  登录  ", "新对话")[0]!.conversations.map(item => item.id), ["old"]);
    assert.equal(groupActiveConversations(conversations, "desktop", "New chat")[0]!.conversations[0]!.id, "other");
    assert.equal(groupActiveConversations(conversations, "C:\\projects\\", "New chat")[0]!.conversations[0]!.id, "other");
  });
  it("matches multiple keywords across title and workspace and reports no matches", () => {
    assert.deepEqual(groupActiveConversations(conversations, "vela 登录", "新对话")[0]!.conversations.map(item => item.id), ["old"]);
    assert.deepEqual(groupActiveConversations(conversations, "missing", "新对话"), []);
    assert.equal(groupActiveConversations(conversations, "新对话", "新对话")[0]!.conversations[0]!.id, "empty");
  });
  it("reflects a rename or archive immediately", () => {
    const changed = conversations.map(item => item.id === "old" ? { ...item, title: "支付问题" } : item);
    assert.deepEqual(groupActiveConversations(changed, "登录", "新对话"), []);
    assert.equal(groupActiveConversations(changed, "支付", "新对话")[0]!.conversations[0]!.id, "old");
    assert.deepEqual(groupActiveConversations(changed.map(item => ({ ...item, archivedAt: 10 })), "支付", "新对话"), []);
  });
  it("extracts workspace labels on Windows and POSIX, including trailing separators", () => {
    assert.equal(workspaceName("/projects/Vela/"), "Vela");
    assert.equal(workspaceName("C:\\projects\\Vela\\"), "Vela");
    assert.equal(workspaceName("/"), "/");
  });
});
