import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseUiMessage, serializeUiStateSnapshot, uiSourceFingerprint, uiStateStorageKey, type TranscriptMessage } from "@vela/shared";
import { buildConversationExport, type ConversationExportInput } from "../src/main/conversation-export.ts";
import { UiExportNumbering } from "../src/main/intelligent-ui-export.ts";
import { billSplit, fenced } from "../../../packages/agent/test/fixtures/intelligent-ui.ts";

const message = (id: string, role: "user" | "assistant", text: string): TranscriptMessage =>
  ({ id, role, text, thinking: "", tools: [], timestamp: null });

const uiText = `先算一下：\n\n${fenced(billSplit)}\n\n以上。`;

function input(messages: TranscriptMessage[], readUiState?: ConversationExportInput["readUiState"]): ConversationExportInput {
  return {
    conversation: { id: "conv-1", title: "Split", cwd: "/work", createdAt: 0, updatedAt: 0 },
    messages, trace: null, checkpoints: null, locale: "en", appVersion: "1.0.9", readUiState,
    exportedAt: new Date(Date.UTC(2026, 9, 10)), homeDir: "/home/x",
  };
}

const markdown = { format: "markdown", includeTrace: false, includeThinking: false, includeDiffs: false } as const;
const html = { ...markdown, format: "html" } as const;

describe("Intelligent UI export", () => {
  const messages = [message("m1", "user", "split 240 by 5"), message("m2", "assistant", uiText)];

  it("writes the vela-ui block as static text with initial values", () => {
    const md = buildConversationExport(input(messages), markdown);
    assert.doesNotMatch(md, /vela-ui/);
    assert.doesNotMatch(md, /"op"/);
    assert.match(md, /先算一下/);
    assert.match(md, /以上。/);
    assert.match(md, /Interactive UI \(static text\)/);
    assert.match(md, /总额: 240 元/);
    assert.match(md, /每人金额: 48.00 元/);
  });

  it("uses the user's saved inputs when the fingerprint matches", () => {
    const [, ui] = parseUiMessage(uiText);
    assert.equal(ui.type, "ui");
    if (ui.type !== "ui") return;
    const fingerprint = uiSourceFingerprint(ui.artifact.artifactId, ui.raw);
    const key = uiStateStorageKey({ conversationId: "conv-1", messageId: "u0", artifactId: ui.artifact.artifactId });
    const stored = new Map([[key, serializeUiStateSnapshot(fingerprint, { amount: 300, people: 4 })]]);
    const md = buildConversationExport(input(messages, k => stored.get(k) ?? null), markdown);
    assert.match(md, /总额: 300 元/);
    assert.match(md, /每人金额: 75.00 元/);
  });

  it("ignores saved state whose fingerprint no longer matches", () => {
    const [, ui] = parseUiMessage(uiText);
    if (ui.type !== "ui") throw new Error("expected ui");
    const key = uiStateStorageKey({ conversationId: "conv-1", messageId: "u0", artifactId: ui.artifact.artifactId });
    const stale = serializeUiStateSnapshot("00000000", { amount: 999 });
    const md = buildConversationExport(input(messages, k => (k === key ? stale : null)), markdown);
    assert.match(md, /总额: 240 元/);
    assert.doesNotMatch(md, /999/);
  });

  it("survives a throwing state reader", () => {
    const md = buildConversationExport(input(messages, () => { throw new Error("disk"); }), markdown);
    assert.match(md, /总额: 240 元/);
  });

  it("numbers only messages that may contain UI, like the renderer", () => {
    const numbering = new UiExportNumbering();
    assert.equal(numbering.next("plain"), null);
    assert.equal(numbering.next(uiText), "u0");
    assert.equal(numbering.next("no ui here"), null);
    assert.equal(numbering.next(uiText), "u1");
  });

  it("leaves messages without UI untouched", () => {
    const md = buildConversationExport(input([message("a", "assistant", "Hello **world**")]), markdown);
    assert.match(md, /Hello \*\*world\*\*/);
    assert.doesNotMatch(md, /Interactive UI/);
  });

  it("replaces an invalid block with a placeholder instead of leaking its source", () => {
    const bad = "```vela-ui\n{\"op\":\"begin\",\"id\":\"x\",\"version\":1}\n{\"op\":\"node\",\"id\":\"r\",\"type\":\"script\",\"props\":{\"html\":\"<script>alert(1)</script>\"}}\n{\"op\":\"commit\"}\n```";
    const md = buildConversationExport(input([message("a", "assistant", bad)]), markdown);
    assert.doesNotMatch(md, /<script>/);
    assert.doesNotMatch(md, /"op"/);
  });

  it("renders in HTML export without raw JSON or active content", () => {
    const out = buildConversationExport(input(messages), html);
    assert.doesNotMatch(out, /vela-ui/);
    assert.match(out, /每人金额/);
    assert.doesNotMatch(out, /"op"/);
  });
});
