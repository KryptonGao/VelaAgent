import assert from "node:assert/strict";
import { it } from "node:test";
import { formatMcpResponse, mcpResultUrl, presentMcpResult } from "../src/renderer/components/mcp-tool-result.ts";

it("promotes titled search results and keeps non-string metadata out of the view", () => {
  assert.deepEqual(presentMcpResult(JSON.stringify({ results: [{ title: "训练计划", url: "https://app.notion.com/plan", highlight: "继续原计划", id: 12, timestamp: null }] })), {
    kind: "search", results: [{ title: "训练计划", url: "https://app.notion.com/plan", highlight: "继续原计划" }],
  });
  assert.deepEqual(presentMcpResult('{"results":[]}'), { kind: "search", results: [] });
  assert.deepEqual(presentMcpResult('[{"title":"页面"}]'), { kind: "search", results: [{ title: "页面" }] });
});

it("does not discard malformed or mixed result entries", () => {
  for (const value of [{ results: [{ title: "Good" }, null] }, { results: [{ title: "" }] }, { results: ["text"] }, { count: 4 }, null, [1, 2]]) {
    assert.deepEqual(presentMcpResult(JSON.stringify(value)), { kind: "json", value });
  }
});

it("keeps partial JSON, markdown and plain responses intact", () => {
  for (const text of ['{"results":[', "# Result\nDone", "… 内容过长，已截断", ""]) {
    assert.deepEqual(presentMcpResult(text), { kind: "text", text });
    assert.equal(formatMcpResponse(text), text);
  }
});

it("formats JSON, including fenced responses, without dropping fields", () => {
  const body = '```json\n{"results":[{"title":"页面","verification":{"state":"unverified"}}],"cursor":"next"}\n```';
  assert.equal(presentMcpResult(body).kind, "search");
  assert.deepEqual(JSON.parse(formatMcpResponse(body)), { results: [{ title: "页面", verification: { state: "unverified" } }], cursor: "next" });
  assert.ok(formatMcpResponse(body).includes('\n  "results"'));
});

it("only allows absolute HTTP and HTTPS result links", () => {
  for (const value of [undefined, "", "/relative", "javascript:alert(1)", "file:///tmp/data", "data:text/html,test"]) assert.equal(mcpResultUrl(value), null);
  assert.equal(mcpResultUrl("https://app.notion.com/page")?.hostname, "app.notion.com");
  assert.equal(mcpResultUrl("http://localhost:8080/page")?.protocol, "http:");
});
