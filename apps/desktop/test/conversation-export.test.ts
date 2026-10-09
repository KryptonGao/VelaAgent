import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CheckpointTimeline, TraceNode, TraceRequest, TraceSnapshot, TranscriptMessage } from "@vela/shared";
import { buildConversationExport, conversationExportFileName, exportTimestamp, parseExportOptions, type ConversationExportInput } from "../src/main/conversation-export.ts";

const secret = "sk-synthetic-export-secret";
const diff = "-  1 const retries = 1;\n+  1 const retries = 3;\n   2 export {};";

const messages: TranscriptMessage[] = [
  { id: "u1", role: "user", text: "Fix the flaky upload </script><b>", thinking: "", tools: [], timestamp: Date.UTC(2026, 9, 9, 8, 0, 0),
    images: [{ type: "image", data: "AAAA", mimeType: "image/png" }] },
  { id: "a1", role: "assistant", text: "I will raise the retry count.\n\n```ts\nconst x = 1;\n```", thinking: "private reasoning", timestamp: Date.UTC(2026, 9, 9, 8, 0, 5),
    tools: [
      { id: "t1", name: "read", status: "done", activity: { path: "/Users/someone/repo/src/upload.ts", body: "FILE CONTENTS MUST NOT APPEAR" } },
      { id: "t2", name: "edit", status: "done", activity: { path: "/Users/someone/repo/src/upload.ts", diff } },
      { id: "t3", name: "bash", status: "error", activity: { command: "pnpm test\nsecond line", body: `FAIL upload.test.ts\nAuthorization: Bearer ${secret}\n\`\`\`fenced output\`\`\`` } },
    ] },
  { id: "u2", role: "user", text: "Try again", thinking: "", tools: [], timestamp: null },
  { id: "a2", role: "assistant", text: "Done.", thinking: "", tools: [{ id: "t4", name: "write", status: "done", activity: { path: "src/new.ts", diff: "+  1 export const a = 1;" } }], timestamp: null },
];

const node = (sequence: number, patch: Partial<TraceNode>): TraceNode => ({
  id: `n${sequence}`, sequence, kind: "tool-call", turn: 1, step: 1, requestId: "r1", toolCallId: null, toolName: null, status: "Completed",
  summary: "", startedAt: null, completedAt: null, executionStartedAt: null, durationMs: 1500, version: 1, historical: false, ...patch,
});
const request: TraceRequest = {
  id: "r1", number: 1, turn: 1, model: "claude-sonnet-5-5", status: "Completed", contextId: "c1", startedAt: null, completedAt: null,
  durationMs: 12_300, firstTokenMs: 420, generationMs: 11_000, usage: { input: 1200, output: 340, cacheRead: 900, cacheWrite: 0, totalTokens: 1540 },
};
const trace: TraceSnapshot = {
  version: 1, warning: null, summaries: [], requests: [request],
  nodes: [
    node(1, { kind: "user", summary: "Fix the flaky upload" }),
    node(2, { kind: "tool-call", toolName: "bash", summary: "pnpm test | grep fail", durationMs: 61_000 }),
    node(3, { kind: "tool-result", toolName: "bash", status: "Failed", summary: "FAIL upload.test.ts" }),
    node(4, { kind: "state", summary: "settled" }),
  ],
};
const checkpoints: CheckpointTimeline = {
  conversationId: "c", start: null,
  turns: [
    { turnIndex: 0, text: "Fix", timestamp: null, changedFiles: ["src/upload.ts", "package-lock.json"], restore: null },
    { turnIndex: 1, text: "Try again", timestamp: null, changedFiles: null, restore: null },
  ],
};

const base: ConversationExportInput = {
  conversation: { id: "conv-1", title: "Flaky upload: postmortem?", cwd: "/Users/someone/repo", createdAt: Date.UTC(2026, 9, 9, 7, 59, 0), updatedAt: Date.UTC(2026, 9, 9, 8, 5, 0) },
  messages, trace, checkpoints, locale: "en", appVersion: "1.0.7", exportedAt: new Date(Date.UTC(2026, 9, 9, 9, 0, 0)), homeDir: "/Users/someone",
  failureDetails: new Map([["n3", `full failure text with token=${secret}`]]),
};
const all = { format: "markdown", includeTrace: true, includeThinking: false, includeDiffs: true } as const;

describe("conversation export (markdown)", () => {
  const md = buildConversationExport(base, all);

  it("starts with the title, metadata and an overview of the work", () => {
    assert.match(md, /^# Flaky upload: postmortem\?/);
    assert.match(md, /\| Exported \| 2026-10-09 09:00:00Z \|/);
    assert.match(md, /\| Workspace \| ~\/repo \|/);
    assert.match(md, /\| Turns \| 2 \|/);
    assert.match(md, /\| Tool calls \| 4 \|/);
    assert.match(md, /\| Failed tool calls \| 1 \|/);
    assert.match(md, /\| Files changed \| 2 \|/);
    assert.match(md, /\| Lines added \/ removed \| \+2 \/ −1 \|/);
    assert.match(md, /\| Total tokens \| 1,540 \|/);
  });

  it("lists failures from tool calls and trace nodes with the full failure text", () => {
    const failures = md.slice(md.indexOf("## Failures"), md.indexOf("## File changes"));
    assert.match(failures, /Turn 1 · bash · pnpm test/);
    assert.match(failures, /<summary>Turn 1 · tool-result · bash · Failed<\/summary>/);
    assert.match(failures, /full failure text/);
  });

  it("includes each edit as a diff, with per-file totals", () => {
    assert.match(md, /```diff\n-  1 const retries = 1;\n\+  1 const retries = 3;/);
    assert.match(md, /\| src\/upload\.ts \| 1 \| 1 \| 1 \|/);
    assert.match(md, /\| src\/new\.ts \| 1 \| 0 \| 1 \|/);
    assert.match(md, /`src\/upload\.ts` \(\+1 −1\)/);
  });

  it("adds the trace tables and the checkpoint file list", () => {
    assert.match(md, /## Trace/);
    assert.match(md, /\| 1 \| 1 \| claude-sonnet-5-5 \| Completed \| 12s \| 420ms \| 1200 \| 340 \| 900 \|/);
    assert.match(md, /pnpm test \\\| grep fail/); // pipes inside table cells are escaped
    assert.match(md, /\| 2 \| 1 \| tool-call \| bash \| Completed \| 1m 01s \|/);
    assert.doesNotMatch(md, /settled/); // completed state nodes are noise
    assert.match(md, /Files changed in this turn \(checkpoint\)\*\*\n\n- src\/upload\.ts\n- package-lock\.json/);
  });

  it("keeps file contents, thinking and image data out", () => {
    assert.doesNotMatch(md, /FILE CONTENTS MUST NOT APPEAR/);
    assert.doesNotMatch(md, /private reasoning/);
    assert.doesNotMatch(md, /AAAA/);
    assert.match(md, /\[1 image\(s\) omitted\]/);
  });

  it("redacts secrets and the home directory everywhere", () => {
    assert.equal(md.includes(secret), false);
    assert.equal(md.includes("/Users/someone"), false);
    assert.match(md, /Bearer ••••••••/);
  });

  it("masks NAME=value secrets and known token shapes but not ordinary settings", () => {
    const env = { ...messages[1]!, tools: [{ id: "env", name: "bash", status: "done" as const, activity: { command: "env", body: `OPENAI_API_KEY=sk-live-abcdefghijklmnop\nGITHUB_TOKEN: "ghp_abcdefghijklmnopqrstuvwxyz"\nmax_tokens: 4096\nnote ghp_abcdefghijklmnopqrstuvwxyz0123` } }] };
    const out = buildConversationExport({ ...base, messages: [messages[0]!, env] }, all);
    assert.match(out, /OPENAI_API_KEY=••••••••/);
    assert.match(out, /GITHUB_TOKEN: ••••••••/);
    assert.match(out, /max_tokens: 4096/);
    assert.doesNotMatch(out, /sk-live|ghp_/);
  });

  it("fences output that itself contains a code fence with a longer fence", () => {
    assert.match(md, /````\nFAIL upload\.test\.ts/);
  });

  it("honours the options", () => {
    const plain = buildConversationExport(base, { ...all, includeTrace: false, includeDiffs: false, includeThinking: true });
    assert.doesNotMatch(plain, /## Trace/);
    assert.doesNotMatch(plain, /```diff/);
    assert.match(plain, /private reasoning/);
    assert.match(plain, /\| Files changed \| 2 \|/); // totals stay: they come from the conversation, not the option
    const noTrace = buildConversationExport({ ...base, trace: null }, all);
    assert.doesNotMatch(noTrace, /Total tokens|## Trace/);
  });

  it("exports a chat with no tools, trace or checkpoints", () => {
    const small = buildConversationExport({ ...base, messages: messages.slice(0, 1), trace: null, checkpoints: null }, all);
    assert.match(small, /## Conversation/);
    assert.doesNotMatch(small, /## Failures|## File changes|## Trace/);
  });
});

describe("conversation export (html)", () => {
  const html = buildConversationExport(base, { ...all, format: "html" });

  it("is a single self-contained page without scripts", () => {
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /<title>Flaky upload: postmortem\?<\/title>/);
    assert.doesNotMatch(html, /<script|<link|src=|https?:\/\//i);
    assert.match(html, /prefers-color-scheme:dark/);
  });

  it("escapes message text instead of injecting it", () => {
    assert.match(html, /Fix the flaky upload &lt;\/script&gt;&lt;b&gt;/);
    assert.equal(html.includes("</script><b>"), false);
  });

  it("colours diff lines and keeps fenced code as code", () => {
    assert.match(html, /<span class="del">-  1 const retries = 1;<\/span>/);
    assert.match(html, /<span class="add">\+  1 const retries = 3;<\/span>/);
    assert.doesNotMatch(html, /<\/span>\s+<span class="(add|del|ctx)"/); // block spans, no blank lines between them
    assert.match(html, /<pre><code>const x = 1;<\/code><\/pre>/);
  });

  it("collapses tool output and trace details and still redacts", () => {
    assert.match(html, /<details><summary>✗ bash · pnpm test<\/summary>/);
    assert.equal(html.includes(secret), false);
    assert.equal(html.includes("/Users/someone"), false);
  });
});

describe("conversation export details", () => {
  it("renders labels in the requested locale and falls back to English", () => {
    const ja = buildConversationExport({ ...base, locale: "ja" }, all);
    assert.match(ja, /## 概要/);
    assert.match(ja, /## 失敗と中断/);
    const zh = buildConversationExport({ ...base, locale: "zh-CN" }, all);
    assert.match(zh, /## 失败与中断/);
    assert.match(zh, /### 第 1 轮/);
  });

  it("limits very long tool output and timelines", () => {
    const long = { ...messages[1]!, tools: [{ id: "b", name: "bash", status: "done" as const, activity: { command: "yes", body: "x".repeat(10_000) } }] };
    assert.match(buildConversationExport({ ...base, messages: [messages[0]!, long] }, all), /output truncated, 6000 characters omitted/);
    const many = { ...trace, nodes: Array.from({ length: 1200 }, (_, index) => node(index + 1, { summary: `step ${index}` })) };
    const md = buildConversationExport({ ...base, trace: many }, all);
    assert.match(md, /Timeline truncated to the first 1000 entries/);
    assert.match(md, /step 999 \|/);
    assert.doesNotMatch(md, /step 1000 \|/);
  });

  it("formats timestamps in UTC and builds safe file names", () => {
    assert.equal(exportTimestamp(Date.UTC(2026, 0, 2, 3, 4, 5)), "2026-01-02 03:04:05Z");
    assert.equal(exportTimestamp(null), "–");
    const day = new Date(Date.UTC(2026, 9, 9, 1));
    assert.equal(conversationExportFileName('a/b: "c"?', "markdown", day), "a b c-20261009.md");
    assert.equal(conversationExportFileName("   ", "html", day), "chat-20261009.html");
  });

  it("validates export options from the renderer", () => {
    assert.deepEqual(parseExportOptions({ format: "html", includeTrace: true, includeDiffs: "yes" }), { format: "html", includeTrace: true, includeThinking: false, includeDiffs: false });
    assert.throws(() => parseExportOptions({ format: "pdf" }), /导出格式不正确/);
    assert.throws(() => parseExportOptions(null), /导出格式不正确/);
  });
});
